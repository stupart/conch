import { classify, classifyApproval, isSendCommand } from "./commands.ts";

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
  | "spacebar"
  | "pause"
  | "mute";

export type ExternalDictationAction = "spacebar" | "pause" | "mute";

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
    const payload = submits && this.#buffer.length
      ? this.#buffer.map((segment) => segment.text).join(" ")
      : null;
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

const SUBMIT_ACTIONS = new Set<DictationAction>(["send", "timeout", "spacebar", "pause", "mute"]);
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
