import { classify, classifyApproval, isSendCommand, splitTrailingDiscard, splitTrailingSend } from "./commands.ts";

/**
 * The ordered, side-effect-free half of a dictation session. The capture
 * controller owns recorder/worker ordering; this reducer owns the text held
 * across those ordered results and turns terminal intents into FIFO barrier
 * requests. Callers must enqueue the requested barrier without awaiting it,
 * then execute an action only after its matching barrier is reduced.
 */

export type DictationAction =
  | "send"
  | "repeat"
  | "continue"
  | "discard"
  | "timeout"
  | "spacebar";

/** Space deliberately drains captured speech; mode controls use instant abort. */
export type ExternalDictationAction = "spacebar";

export interface OrderedTranscript {
  type: "transcript";
  sequence: number;
  text: string;
  diagnosticId?: string;
}

export interface OrderedTimeout {
  type: "timeout";
  sequence: number;
  diagnosticId?: string;
}

export interface OrderedBarrier {
  type: "barrier";
  sequence: number;
  id: string;
  /** Pass through RequestBarrierEffect.requestId when the controller can. */
  requestId?: number;
  reason: string;
}

export type DictationReducerInput = OrderedTranscript | OrderedTimeout | OrderedBarrier;

export interface BufferedDictationSegment {
  sequence: number;
  text: string;
  diagnosticId?: string;
}

export interface DictationSnapshot {
  buffer: BufferedDictationSegment[];
  pendingAction: DictationAction | null;
  pendingRequestId: number | null;
  lastSequence: number | null;
}

export interface RequestBarrierEffect {
  type: "request-barrier";
  /** Reducer-local correlation token. This is not a recorder sequence. */
  requestId: number;
  action: DictationAction;
  reason: string;
}

export interface TraceReductionEffect {
  type: "trace";
  diagnosticId: string;
  intent: string;
  bufferCountAfterReduction: number;
}

export interface BarrierReachedEffect {
  type: "barrier-reached";
  barrierId: string;
  reason: string;
}

export interface DictationActionReadyEffect {
  type: "action-ready";
  action: DictationAction;
  requestId: number;
  barrierId: string;
  barrierReason: string;
  /** Exact text to inject. Null means this action closes/speaks without an injection. */
  payload: string | null;
  /** Recorder rows whose transcript text appears in payload, in text order. */
  payloadDiagnosticIds: string[];
  /**
   * Rows to annotate with finalSubmittedPayload. This includes the command or
   * timeout row that caused submission, matching the Phase-0 trace contract.
   */
  finalSubmittedDiagnosticIds: string[];
  /** Command/timeout recorder rows, independently useful when payload is null. */
  actionDiagnosticIds: string[];
  /** Rows removed by a discard, in chronological order. */
  discardedDiagnosticIds: string[];
  /** Prompt text still held after the action (repeat/continue/discard tail). */
  retainedBuffer: BufferedDictationSegment[];
  /** Whether capture should resume after the caller completes this action. */
  shouldResume: boolean;
}

export type DictationReducerEffect =
  | RequestBarrierEffect
  | TraceReductionEffect
  | BarrierReachedEffect
  | DictationActionReadyEffect;

interface DiagnosticRef {
  sequence: number;
  diagnosticId: string;
}

interface PendingAction {
  action: DictationAction;
  requestId: number;
  actionDiagnostics: DiagnosticRef[];
  discardedDiagnostics: DiagnosticRef[];
}

export interface DictationReducerOptions {
  holdSubmit: boolean;
}

export class DictationReducer {
  readonly #holdSubmit: boolean;
  #buffer: BufferedDictationSegment[] = [];
  #pending: PendingAction | null = null;
  #lastSequence: number | null = null;
  #nextRequestId = 1;

  constructor(options: DictationReducerOptions) {
    this.#holdSubmit = options.holdSubmit;
  }

  get snapshot(): DictationSnapshot {
    return {
      buffer: this.#buffer.map(copySegment),
      pendingAction: this.#pending?.action ?? null,
      pendingRequestId: this.#pending?.requestId ?? null,
      lastSequence: this.#lastSequence,
    };
  }

  /** Consume a transcript, timeout sentinel, or drained FIFO barrier. */
  consume(input: DictationReducerInput): DictationReducerEffect[] {
    this.#assertNextSequence(input.sequence);
    switch (input.type) {
      case "transcript":
        return this.#reduceTranscript(input);
      case "timeout":
        return this.#reduceTimeout(input);
      case "barrier":
        return this.#reduceBarrier(input);
    }
  }

  /**
   * Queue a user/daemon stop without waiting for its barrier. Audio already in
   * the controller FIFO will still reduce before that barrier and join the
   * held payload.
   */
  requestExternalAction(action: ExternalDictationAction): DictationReducerEffect[] {
    if (this.#pending) return [];
    return [this.#beginAction(action, [])];
  }

  #reduceTranscript(input: OrderedTranscript): DictationReducerEffect[] {
    const text = input.text.trim();
    if (!text) return trace(input.diagnosticId, "empty-transcript", this.#buffer.length);

    // Once an action has requested its barrier, captures already ahead of that
    // barrier still belong to the ordered timeline. Prompt-like tails are real
    // content and must never be discarded. Later commands do not replace the
    // first chronological action, but their trace rows remain associated with
    // it for complete diagnostics.
    if (this.#pending) {
      const intent = this.#classify(text);
      if (intent === "prompt") {
        this.#append(input, text);
      } else {
        this.#addActionDiagnostic(input);
      }
      return trace(input.diagnosticId, intent, this.#buffer.length);
    }

    if (this.#holdSubmit && this.#buffer.length > 0 && isSendCommand(text)) {
      const diagnostics = diagnosticRefs(input);
      return [
        ...trace(input.diagnosticId, "send", this.#buffer.length),
        this.#beginAction("send", diagnostics),
      ];
    }

    // "Looks great, no response needed." — same one-breath problem as send, but
    // injecting it is worse than a stray word: the agent answers, which is the
    // exact opposite of what was asked, and it costs a turn. Drop the lot.
    if (splitTrailingDiscard(text) !== null) {
      const discarded = diagnosticRefsFromSegments(this.#buffer);
      this.#buffer = [];
      return [
        ...trace(input.diagnosticId, "discard", 0),
        this.#beginAction("discard", diagnosticRefs(input), discarded),
      ];
    }

    // "…that is. Send." — one breath, so one transcript. Keep the prompt, drop
    // the command, submit. Without this the word is injected as content and the
    // turn never goes anywhere, which is exactly what it looks like from the
    // outside: you said send, and it typed "send".
    const body = splitTrailingSend(text);
    if (body !== null && classify(body) === "prompt") {
      this.#append(input, body);
      return [
        ...trace(input.diagnosticId, "send", this.#buffer.length),
        this.#beginAction("send", diagnosticRefs(input)),
      ];
    }

    const intent = classify(text);
    if (intent === "prompt") {
      this.#append(input, text);
      const effects = trace(input.diagnosticId, "prompt", this.#buffer.length);
      // Non-hold mode still drains a hot successor before submitting, so a
      // continuation captured during this transcription joins the payload.
      if (!this.#holdSubmit) return [...effects, this.#beginAction("send", [])];
      return effects;
    }

    if (intent === "discard") {
      const discarded = diagnosticRefsFromSegments(this.#buffer);
      this.#buffer = [];
      return [
        ...trace(input.diagnosticId, "discard", 0),
        this.#beginAction("discard", diagnosticRefs(input), discarded),
      ];
    }

    return [
      ...trace(input.diagnosticId, intent, this.#buffer.length),
      this.#beginAction(intent, diagnosticRefs(input)),
    ];
  }

  #reduceTimeout(input: OrderedTimeout): DictationReducerEffect[] {
    if (this.#pending) {
      this.#addActionDiagnostic(input);
      return trace(input.diagnosticId, "timeout-after-action", this.#buffer.length);
    }
    return [
      ...trace(input.diagnosticId, this.#buffer.length ? "timeout-submit" : "timeout-close", this.#buffer.length),
      this.#beginAction("timeout", diagnosticRefs(input)),
    ];
  }

  #reduceBarrier(input: OrderedBarrier): DictationReducerEffect[] {
    if (!this.#pending) {
      return [{ type: "barrier-reached", barrierId: input.id, reason: input.reason }];
    }

    // Only the barrier requested for this action may release it. An older
    // timeout/shutdown barrier can already be ahead in the controller FIFO.
    if (input.requestId === undefined || input.requestId !== this.#pending.requestId) {
      return [{ type: "barrier-reached", barrierId: input.id, reason: input.reason }];
    }

    const pending = this.#pending;
    this.#pending = null;
    const submits = SUBMIT_ACTIONS.has(pending.action);
    const joined = submits && this.#buffer.length
      ? this.#buffer.map((segment) => segment.text).join(" ")
      : null;
    // Whisper renders near-silence as punctuation — a three-minute empty
    // window came back as "-" and was injected into a live session as if it
    // were a message. Speech that carries no letter or digit is not something
    // anyone said, and the empty-buffer path already knows what to do with
    // nothing. Guarding here rather than at deliver() because deliver
    // returning false means "you replied by hand", which this is not.
    const payload = joined && /[\p{L}\p{N}]/u.test(joined) ? joined : null;
    const payloadRefs = diagnosticRefsFromSegments(this.#buffer);
    const actionRefs = pending.actionDiagnostics;
    const retained = RETAIN_ACTIONS.has(pending.action)
      ? this.#buffer.map(copySegment)
      : [];
    const shouldResume = pending.action === "repeat"
      || pending.action === "continue"
      || (pending.action === "discard" && retained.length > 0);

    if (!RETAIN_ACTIONS.has(pending.action)) this.#buffer = [];

    return [{
      type: "action-ready",
      action: pending.action,
      requestId: pending.requestId,
      barrierId: input.id,
      barrierReason: input.reason,
      payload,
      payloadDiagnosticIds: idsInOrder(payloadRefs),
      finalSubmittedDiagnosticIds: payload
        ? idsInOrder([...payloadRefs, ...actionRefs])
        : [],
      actionDiagnosticIds: idsInOrder(actionRefs),
      discardedDiagnosticIds: idsInOrder(pending.discardedDiagnostics),
      retainedBuffer: retained,
      shouldResume,
    }];
  }

  #append(input: OrderedTranscript, text: string): void {
    this.#buffer.push({
      sequence: input.sequence,
      text,
      ...(input.diagnosticId ? { diagnosticId: input.diagnosticId } : {}),
    });
  }

  #classify(text: string): "send" | ReturnType<typeof classify> {
    if (this.#buffer.length > 0 && isSendCommand(text)) return "send";
    return classify(text);
  }

  #addActionDiagnostic(input: OrderedTranscript | OrderedTimeout): void {
    if (!this.#pending || !input.diagnosticId) return;
    this.#pending.actionDiagnostics.push({ sequence: input.sequence, diagnosticId: input.diagnosticId });
  }

  #beginAction(
    action: DictationAction,
    actionDiagnostics: DiagnosticRef[],
    discardedDiagnostics: DiagnosticRef[] = [],
  ): RequestBarrierEffect {
    const requestId = this.#nextRequestId++;
    this.#pending = { action, requestId, actionDiagnostics, discardedDiagnostics };
    return { type: "request-barrier", requestId, action, reason: `dictation-${action}` };
  }

  #assertNextSequence(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error(`dictation sequence must be a non-negative safe integer: ${sequence}`);
    }
    if (this.#lastSequence !== null && sequence <= this.#lastSequence) {
      throw new Error(`dictation input out of order: ${sequence} after ${this.#lastSequence}`);
    }
    this.#lastSequence = sequence;
  }
}

const SUBMIT_ACTIONS = new Set<DictationAction>(["send", "timeout", "spacebar"]);
const RETAIN_ACTIONS = new Set<DictationAction>(["repeat", "continue", "discard"]);

function trace(
  diagnosticId: string | undefined,
  intent: string,
  bufferCountAfterReduction: number,
): TraceReductionEffect[] {
  return diagnosticId
    ? [{ type: "trace", diagnosticId, intent, bufferCountAfterReduction }]
    : [];
}

function diagnosticRefs(input: { sequence: number; diagnosticId?: string }): DiagnosticRef[] {
  return input.diagnosticId
    ? [{ sequence: input.sequence, diagnosticId: input.diagnosticId }]
    : [];
}

function diagnosticRefsFromSegments(segments: BufferedDictationSegment[]): DiagnosticRef[] {
  return segments.flatMap((segment) => diagnosticRefs(segment));
}

function idsInOrder(refs: DiagnosticRef[]): string[] {
  const seen = new Set<string>();
  return refs
    .toSorted((a, b) => a.sequence - b.sequence)
    .flatMap(({ diagnosticId }) => {
      if (seen.has(diagnosticId)) return [];
      seen.add(diagnosticId);
      return [diagnosticId];
    });
}

function copySegment(segment: BufferedDictationSegment): BufferedDictationSegment {
  return { ...segment };
}

/**
 * Permission speech is actionable only when every non-empty ordered segment
 * is recognized and all recognized segments agree. Conflicting yes/no or any
 * free text is deliberately ambiguous and must not inject a key.
 */
export function classifyPermissionDecision(
  segments: Iterable<string>,
): "approve" | "deny" | null {
  let decision: "approve" | "deny" | null = null;
  let heard = false;
  for (const raw of segments) {
    const text = raw.trim();
    if (!text) continue;
    heard = true;
    const next = classifyApproval(text);
    if (!next || (decision && decision !== next)) return null;
    decision = next;
  }
  return heard ? decision : null;
}

/** Spoken ordinals, so "the third one" can pick option three. */
const ORDINALS = [
  "first", "second", "third", "fourth", "fifth",
  "sixth", "seventh", "eighth", "ninth", "tenth",
];

/** Spoken cardinals, for "number four". */
const CARDINALS = [
  "one", "two", "three", "four", "five",
  "six", "seven", "eight", "nine", "ten",
];

/** Words that join choices together rather than adding meaning. */
const CHOICE_JOINERS = /\b(and|or|plus|also|both|too|then)\b/gi;
/** Nouns naming the list itself, in either number. */
const CHOICE_NOUNS = /\b(options?|numbers?|choices?)\b/gi;

/**
 * Is this utterance nothing BUT a positional reference?
 *
 * "the first one" is an answer; "let's talk about it first" is not, and the
 * only difference is the words around it. Strip everything that carries no
 * choice — filler, joiners, the words naming the list, the positions
 * themselves — and if anything meaningful is left, the person was talking
 * rather than choosing.
 *
 * Three letters is the bar for "meaningful", which keeps "I'd go with the
 * third" (leaving only "'d") working while rejecting "lets discuss first"
 * (leaving "discuss").
 */
function isPositionalUtterance(said: string): boolean {
  let rest = said.toLowerCase()
    .replace(CHOICE_FILLER, " ")
    .replace(CHOICE_JOINERS, " ")
    .replace(CHOICE_NOUNS, " ")
    .replace(/\b[1-9][0-9]?\b/g, " ");
  for (const word of [...ORDINALS, ...CARDINALS]) {
    rest = rest.replace(new RegExp(`\\b${word}\\b`, "g"), " ");
  }
  return rest.split(/[^a-z0-9]+/).every((word) => word.length < 3);
}

/** Filler that carries no choice, stripped before matching. */
const CHOICE_FILLER = /\b(the|a|an|one|option|choice|number|let'?s|go|with|do|pick|choose|i|want|would|like|please|just|yeah|yes|um|uh)\b/gi;

function normalizeChoice(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Which option did you just say?
 *
 * An agent's multiple-choice question is the shape a voice loop answers best,
 * but only if saying the answer the way a person says it actually works. Nobody
 * reads a label back verbatim: they say "the second one", or "PDF", or "let's
 * do the Linear one". So this matches in descending order of certainty and
 * refuses when two options are equally plausible — a wrong pick here commits
 * the agent down a path you did not choose, which is worse than asking again.
 *
 * Returns the chosen index, or null when nothing clearly won.
 */
export function classifySpokenChoice(
  heard: string,
  options: ReadonlyArray<{ label: string }>,
): number | null {
  const selected = classifySpokenChoices(heard, options);
  if (!selected || selected.size !== 1) return null;
  return selected.values().next().value ?? null;
}

/**
 * Which options did you just say?
 *
 * A multi-select answer is deliberately represented as a set rather than as
 * one "best" index. Full labels and explicit positions can name several
 * options. The final word pass accepts only words unique to one label, so
 * saying a shared word such as "export" cannot silently select every export
 * format.
 */
export function classifySpokenChoices(
  heard: string,
  options: ReadonlyArray<{ label: string }>,
): Set<number> | null {
  const said = normalizeChoice(heard);
  if (!said || options.length === 0) return null;

  // 1. Labels said outright. Longest first, with overlapping shorter matches
  //    ignored, so "Export PDF as draft" does not also pick "Export". A short
  //    label said elsewhere in the same answer still counts.
  const byLength = options
    .map((option, index) => ({ index, label: normalizeChoice(option.label) }))
    .filter((entry) => entry.label)
    .sort((a, b) => b.label.length - a.label.length);
  const occupied: Array<{ start: number; end: number }> = [];
  const labelMatches = new Set<number>();
  for (const entry of byLength) {
    let start = said.indexOf(entry.label);
    while (start >= 0) {
      const end = start + entry.label.length;
      if (!occupied.some((range) => start < range.end && end > range.start)) {
        occupied.push({ start, end });
        labelMatches.add(entry.index);
        break;
      }
      start = said.indexOf(entry.label, start + 1);
    }
  }
  if (labelMatches.size > 0) return labelMatches;

  // 2. Positions: "the first and third", "options 2 and 4".
  //
  // Only when the utterance is ABOUT choosing. Cardinals were already guarded
  // this way — the comment below explains why "two of them look right" must not
  // pick option two — but ordinals and digits were not, so any sentence
  // containing "first" answered the question with option one. Measured against
  // a real three-option question: "actually neither, lets talk about it first"
  // selected "Use Postgres", and "give me 2 minutes" would select option two.
  // Answering on someone's behalf with an option they did not choose is far
  // worse than not recognising an answer, so this refuses when anything is left
  // over that carries meaning.
  // Skipped, not aborted, when the utterance is doing something other than
  // choosing: a distinctive word further down may still identify an option,
  // and "do the linear one" is an answer even though it is not positional.
  if (isPositionalUtterance(said)) {
    const positions = new Set<number>();
    for (const digit of said.matchAll(/\b([1-9][0-9]?)\b/g)) {
      const index = Number(digit[1]) - 1;
      if (index >= 0 && index < options.length) positions.add(index);
    }
    for (let index = 0; index < Math.min(ORDINALS.length, options.length); index++) {
      if (new RegExp(`\\b${ORDINALS[index]}\\b`).test(said)) positions.add(index);
    }
    // Cardinals count only in a positional phrase, or alone. Otherwise "two" in
    // "two of them look right" would select option two.
    const positionalPhrase = /\b(options?|numbers?|choices?)\b/.test(said);
    for (let index = 0; index < Math.min(CARDINALS.length, options.length); index++) {
      const word = CARDINALS[index]!;
      if (
        positionalPhrase && new RegExp(`\\b${word}\\b`).test(said)
        || said === word
      ) {
        positions.add(index);
      }
    }
    if (positions.size > 0) return positions;
  }

  // 3. Distinctive words. A word contributes only when exactly one option owns
  //    it; several unique words can therefore select several options safely.
  //
  // Two-letter words are never distinctive enough to carry a choice, whatever
  // the arithmetic says. "give me a second to think" selected "Ask me later",
  // because "me" happened to belong to exactly one option — a pronoun deciding
  // a question on someone's behalf. Same three-character bar as the positional
  // check above, for the same reason.
  const saidWords = new Set(
    said.replace(CHOICE_FILLER, " ").split(/\s+/).filter((word) => word.length >= 3),
  );
  if (saidWords.size === 0) return null;
  const owners = new Map<string, Set<number>>();
  options.forEach((option, index) => {
    const labelWords = new Set(normalizeChoice(option.label)
      .replace(CHOICE_FILLER, " ")
      .split(/\s+/)
      .filter(Boolean));
    for (const word of labelWords) {
      const indices = owners.get(word) ?? new Set<number>();
      indices.add(index);
      owners.set(word, indices);
    }
  });
  const distinctive = new Set<number>();
  for (const word of saidWords) {
    const indices = owners.get(word);
    if (indices?.size === 1) distinctive.add(indices.values().next().value!);
  }
  return distinctive.size > 0 ? distinctive : null;
}
