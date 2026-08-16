import type { TurnEvent } from "./hook.ts";

const DIGEST_PROMPT = [
  "You are a voice assistant.",
  "In one spoken sentence per session, using at most 25 words per session, brief the user on what finished while they were away.",
  "Use plain words, no markdown, no preamble. Sessions:",
].join(" ");

export interface ResumeDigestAskOptions {
  timeoutMs?: number;
  maxChars?: number;
}

export type ResumeDigestAsk = (
  prompt: string,
  options?: ResumeDigestAskOptions,
) => Promise<string | null>;

export interface PreparedResumeDigest<Owner extends object> {
  readonly owner: Owner;
  readonly events: TurnEvent[];
  readonly briefing: string;
  readonly generation: number;
  accepted: boolean;
  consuming: boolean;
  invalidated: boolean;
  cancelled: boolean;
}

/**
 * Keeps a prepared digest tied to the exact resume transition that earned it.
 * A plan is restorable only after PauseController accepts the override.
 */
export class ResumeDigestEscrow<Owner extends object> {
  #plan: PreparedResumeDigest<Owner> | null = null;

  prepare(
    owner: Owner,
    events: readonly TurnEvent[],
    briefing: string,
    generation: number,
  ): PreparedResumeDigest<Owner> | null {
    if (this.#plan) return null;
    const plan: PreparedResumeDigest<Owner> = {
      owner,
      events: [...events],
      briefing,
      generation,
      accepted: false,
      consuming: false,
      invalidated: false,
      cancelled: false,
    };
    this.#plan = plan;
    return plan;
  }

  settle(owner: Owner, accepted: boolean): void {
    const plan = this.#plan;
    if (!plan || plan.owner !== owner) return;
    if (accepted) {
      plan.accepted = true;
      return;
    }
    plan.cancelled = true;
    this.#plan = null;
  }

  begin(owner: Owner): PreparedResumeDigest<Owner> | null {
    const plan = this.#plan;
    if (
      !plan
      || plan.owner !== owner
      || !plan.accepted
      || plan.cancelled
    ) {
      return null;
    }
    plan.consuming = true;
    return plan;
  }

  finish(plan: PreparedResumeDigest<Owner>): void {
    if (this.#plan === plan) this.#plan = null;
  }

  /**
   * Transfer accepted work back to away-mode ownership. A merely prepared plan
   * is never trusted: PauseController still owns or has already replayed it.
   */
  restore(): TurnEvent[] {
    const plan = this.#plan;
    if (!plan) return [];
    plan.cancelled = true;
    this.#plan = null;
    return plan.accepted ? plan.events : [];
  }

  invalidate(sessionId: string): { changed: boolean; consuming: boolean } {
    const plan = this.#plan;
    if (
      !plan
      || plan.cancelled
      || !plan.events.some((event) => event.sessionId === sessionId)
    ) {
      return { changed: false, consuming: false };
    }
    plan.invalidated = true;
    return { changed: true, consuming: plan.consuming };
  }

  events(): readonly TurnEvent[] {
    return this.#plan?.events ?? [];
  }
}

export function shouldUseResumeDigest(
  enabled: boolean,
  events: readonly TurnEvent[],
  pausedSessionIds?: ReadonlySet<string>,
): boolean {
  return enabled
    && events.length >= 2
    && !events.some((event) => pausedSessionIds?.has(event.sessionId));
}

export function fallbackResumeBriefing(events: readonly TurnEvent[]): string {
  return `${events.length} finished while you were away: ${events.map((event) => event.label).join(", ")}.`;
}

export async function composeResumeBriefing(
  events: readonly TurnEvent[],
  askClaude: ResumeDigestAsk,
): Promise<string> {
  const fallback = fallbackResumeBriefing(events);
  const facts = events
    .map((event, index) => `${index + 1}. ${event.announce}`)
    .join("\n");
  try {
    return await askClaude(
      // No timeoutMs — the injected askHaiku carries the live haiku-timeout.
      `${DIGEST_PROMPT}\n${facts}`,
      { maxChars: 400 },
    ) ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizedWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function withoutChoiceFillers(text: string): string {
  let normalized = normalizedWords(text);
  normalized = normalized
    .replace(/^(?:uh|um|okay|ok|well|please)\s+/, "")
    .replace(/^(?:let s\s+)?(?:start|go)\s+with\s+/, "")
    .replace(/^(?:i\s+(?:want|choose|pick)\s+|pick\s+|choose\s+)/, "")
    .replace(/\s+(?:first|please)$/, "");
  return normalized.trim();
}

/** Match a who-first answer only against the held event labels. */
export function findResumeDigestChoice(
  events: readonly TurnEvent[],
  heard: string,
): TurnEvent | null {
  const choice = withoutChoiceFillers(heard);
  if (!choice) return null;
  const collapsedChoice = choice.replace(/\s+/g, "");
  const matches = events
    .map((event) => {
      const label = normalizedWords(event.label);
      const collapsed = label.replace(/\s+/g, "");
      const exact = choice === label || collapsedChoice === collapsed;
      const contained = ` ${choice} `.includes(` ${label} `)
        || ` ${choice} `.includes(` ${collapsed} `);
      return {
        event,
        labelLength: collapsed.length,
        exact,
        matched: Boolean(collapsed) && (exact || contained),
      };
    })
    .filter((candidate) => candidate.matched)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.labelLength - a.labelLength);
  if (!matches.length) return null;
  if (
    matches.length > 1
    && matches[0]!.exact === matches[1]!.exact
    && matches[0]!.labelLength === matches[1]!.labelLength
  ) {
    return null;
  }
  return matches[0]!.event;
}

function wakeFor(event: TurnEvent): TurnEvent {
  return {
    type: "wake",
    sessionId: event.sessionId,
    label: event.label,
    announce: "",
    ...(event.cwd ? { cwd: event.cwd } : {}),
    ...(event.pid === undefined ? {} : { pid: event.pid }),
    ...(event.transcriptPath ? { transcriptPath: event.transcriptPath } : {}),
  };
}

export interface ResumeDigestListenResult {
  text: string;
  error?: string;
}

export interface ResumeDigestDependencies {
  speak(text: string): Promise<void>;
  listen(): Promise<ResumeDigestListenResult>;
  enqueue(event: TurnEvent): void;
  fallback(events: readonly TurnEvent[]): void | Promise<void>;
  interrupted(): boolean;
}

/**
 * Speak one prepared briefing, collect one routing-only answer, and put the
 * selected session first. Every unsuccessful branch invokes the exact replay
 * fallback; the heard choice is never exposed to a session injector.
 */
export async function runResumeDigest(
  events: readonly TurnEvent[],
  briefing: string,
  dependencies: ResumeDigestDependencies,
): Promise<boolean> {
  let fellBack = false;
  const fallback = async (): Promise<false> => {
    if (!fellBack) {
      fellBack = true;
      try {
        await dependencies.fallback(events);
      } catch {}
    }
    return false;
  };

  try {
    if (dependencies.interrupted()) return fallback();
    await dependencies.speak(`${briefing} Who first?`);
    if (dependencies.interrupted()) return fallback();
    const result = await dependencies.listen();
    if (dependencies.interrupted() || result.error || !result.text.trim()) {
      return fallback();
    }
    const selected = findResumeDigestChoice(events, result.text);
    if (!selected) return fallback();
    if (dependencies.interrupted()) return fallback();

    // The daemon treats wake as a command barrier. Queue retained state first
    // and the wake last so the selected conversation is handled first.
    for (const event of events) {
      if (event !== selected) dependencies.enqueue(event);
    }
    dependencies.enqueue(wakeFor(selected));
    return true;
  } catch {
    return fallback();
  }
}
