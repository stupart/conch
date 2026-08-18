import type { TurnEvent } from "./hook.ts";
import {
  PauseController,
  type PauseResumeResult,
} from "./pause-controller.ts";

export type GlobalModeControl = "pause" | "resume";
export type LegacyModeControl = "mute" | "unmute";
export type InstantAudioCommand = TurnEvent & { type: "wake" | "recite" };
export type TurnControlDisposition =
  | "session-dismissed"
  | "session-paused"
  | "global-paused"
  | null;

/** Migrate a mode verb read from legacy persisted data; public inputs reject it. */
export function normalizeLegacyModeControl(
  type: TurnEvent["type"] | LegacyModeControl,
): TurnEvent["type"] {
  if (type === "mute") return "pause";
  if (type === "unmute") return "resume";
  return type;
}

export interface InstantControlsOptions {
  pause: PauseController;
  globalHeldTurns: Map<string, TurnEvent>;
  pausedSessionIds: Set<string>;
  /**
   * Sessions exempted from a GLOBAL pause because they were resumed by name.
   * Cleared whenever the global pause itself changes — a fresh pause means
   * everything is paused, and a global resume makes exemptions meaningless.
   */
  resumedSessionIds: Set<string>;
  sessionHeldTurns: Map<string, TurnEvent>;
  enqueue(event: TurnEvent): void;
  /** Mark this exact event as the protected replacement in the daemon queue. */
  markInstantQueued(event: InstantAudioCommand): void;
  /** A queued wake/recite command must not restart audio after an instant edge. */
  cancelQueuedWakes(sessionId?: string): void;
  labelFor(sessionId: string): string;
  log(message: string): void;
  render(): void;
}

/**
 * Applies mode state at the synchronous edge. The daemon may queue speech or
 * await replay filtering afterward, but capture/speech cancellation never waits.
 */
export class InstantControls {
  readonly #options: InstantControlsOptions;

  constructor(options: InstantControlsOptions) {
    this.#options = options;
  }

  applyGlobal(control: GlobalModeControl): Promise<PauseResumeResult> | null {
    this.#options.cancelQueuedWakes();
    switch (control) {
      case "pause":
        this.#options.pause.beginPause(true);
        return null;
      case "resume":
        this.#options.pause.interrupt({
          hold: this.#options.globalHeldTurns,
          preserveHeld: true,
        });
        return this.#options.pause.beginResume();
    }
  }

  /**
   * Newest explicit dashboard takeover wins synchronously; the replacement
   * still enters the daemon's serialized queue after the old barrier cleanup.
   */
  enqueueInstant(event: InstantAudioCommand): void {
    this.#options.cancelQueuedWakes();
    this.#options.pause.interrupt();
    this.#options.markInstantQueued(event);
    this.#options.enqueue(event);
  }

  setSessionPaused(sessionId: string, next: boolean): void {
    const {
      pause,
      pausedSessionIds,
      sessionHeldTurns,
    } = this.#options;
    const label = this.#options.labelFor(sessionId);
    this.#options.cancelQueuedWakes(sessionId);

    if (next) {
      pausedSessionIds.add(sessionId);
      this.#options.resumedSessionIds?.delete(sessionId);
      sessionHeldTurns.delete(sessionId);
      pause.interrupt({ sessionId, hold: sessionHeldTurns });
      this.#options.log(`⏸ manual for "${label}" — its latest turn will replay when you press p`);
    } else {
      // An explicit wake may run through pause. Stop and hold it before taking
      // the latest-only replay snapshot.
      pause.interrupt({
        sessionId,
        hold: sessionHeldTurns,
        preserveHeld: true,
      });
      pausedSessionIds.delete(sessionId);
      // Resuming one session out of a GLOBAL pause exempts it from that pause.
      // Otherwise the command reported success and changed nothing, because the
      // global gate runs first.
      if (pause.paused) {
        this.#options.resumedSessionIds?.add(sessionId);
        this.#options.log(`▶ auto for "${label}" — the rest stay manual`);
      } else {
        this.#options.log(`▶ auto for "${label}"`);
      }
      const latest = sessionHeldTurns.get(sessionId);
      sessionHeldTurns.delete(sessionId);
      if (latest) this.#options.enqueue(latest);
    }
    this.#options.render();
  }

}

/** Explicit audio commands requested before a mode edge cannot restart afterward. */
export function markQueuedWakesForControl(
  queue: readonly TurnEvent[],
  mark: (event: TurnEvent) => void,
  sessionId?: string,
): void {
  for (const event of queue) {
    if (event.type !== "wake" && event.type !== "recite") continue;
    if (
      sessionId === undefined
      || event.sessionId === sessionId
      // Unnamed commands resolve against mutable lastTurn only when handled, so a
      // scoped edge must conservatively cancel every older unnamed command.
      || !event.sessionId
    ) {
      mark(event);
    }
  }
}

/**
 * Apply non-destructive quiet semantics when the daemon handles a future turn.
 * Both manual mode and dismissal retain the newest event for replay.
 */
export function gateTurnForControls(
  event: TurnEvent,
  audible: boolean,
  options: {
    globalPaused: boolean;
    settingsOpen: boolean;
    globalHeldTurns: Map<string, TurnEvent>;
    pausedSessionIds: ReadonlySet<string>;
    sessionHeldTurns: Map<string, TurnEvent>;
    dismissedSessionIds?: ReadonlySet<string>;
    dismissedHeldTurns?: Map<string, TurnEvent>;
    /**
     * Sessions resumed BY NAME while conch is paused globally.
     *
     * Without this a global pause is absolute: the gate below checks it before
     * it ever consults per-session state, so "resume just this one" had nowhere
     * to take effect. Tyler: "i should be able to resume one if i want and the
     * rest stay paused."
     */
    resumedSessionIds?: ReadonlySet<string>;
  },
): TurnControlDisposition {
  // Explicit user commands cut through quiet modes. Settings remains a modal
  // pause: it traps input itself, and a queued command must not pierce it.
  const explicitQuietOverride = event.type === "wake" || event.type === "recite";
  if (audible && options.dismissedSessionIds?.has(event.sessionId)) {
    if (!explicitQuietOverride) options.dismissedHeldTurns?.set(event.sessionId, event);
    return "session-dismissed";
  }
  if (
    audible
    && !explicitQuietOverride
    && options.pausedSessionIds.has(event.sessionId)
  ) {
    options.sessionHeldTurns.set(event.sessionId, event);
    return "session-paused";
  }
  // Checked BEFORE the global gate, which is the whole point: a session
  // resumed by name speaks while everything else stays held.
  if (options.resumedSessionIds?.has(event.sessionId)) return null;
  if (options.globalPaused && (!explicitQuietOverride || options.settingsOpen)) {
    options.globalHeldTurns.set(event.sessionId, event);
    return "global-paused";
  }
  return null;
}
