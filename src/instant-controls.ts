import type { TurnEvent } from "./hook.ts";
import {
  PauseController,
  type PauseResumeResult,
} from "./pause-controller.ts";

export type GlobalModeControl = "pause" | "resume" | "mute" | "unmute";
export type TurnControlDisposition =
  | "session-muted"
  | "global-muted"
  | "session-paused"
  | "global-paused"
  | null;

export interface InstantControlsOptions {
  pause: PauseController;
  globalHeldTurns: Map<string, TurnEvent>;
  pausedSessionIds: Set<string>;
  mutedSessionIds: Set<string>;
  sessionHeldTurns: Map<string, TurnEvent>;
  setMuted(next: boolean): void;
  enqueue(event: TurnEvent): void;
  /** Permanently stamp already-queued turns as forgotten without hiding status. */
  forgetQueued(sessionId?: string): void;
  /** Remove muted work from the latest-turn replay index. */
  forgetLatest(sessionId?: string): void;
  /** A queued wake/recite command must not restart audio after a mode edge. */
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
      case "mute":
      case "unmute":
        if (control === "mute") {
          this.#options.pause.forgetHeld();
          this.#options.globalHeldTurns.clear();
          this.#options.sessionHeldTurns.clear();
          this.#options.forgetQueued();
          this.#options.forgetLatest();
        }
        this.#options.pause.interrupt();
        this.#options.setMuted(control === "mute");
        return null;
    }
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
      sessionHeldTurns.delete(sessionId);
      pause.interrupt({ sessionId, hold: sessionHeldTurns });
      this.#options.log(`⏸ paused "${label}" — its latest turn will replay when you press p`);
    } else {
      // An explicit wake may run through pause. Stop and hold it before taking
      // the latest-only replay snapshot.
      pause.interrupt({
        sessionId,
        hold: sessionHeldTurns,
        preserveHeld: true,
      });
      pausedSessionIds.delete(sessionId);
      const latest = sessionHeldTurns.get(sessionId);
      sessionHeldTurns.delete(sessionId);
      this.#options.log(`▶ resumed "${label}"`);
      if (latest) this.#options.enqueue(latest);
    }
    this.#options.render();
  }

  setSessionMuted(sessionId: string, next: boolean): void {
    const {
      pause,
      mutedSessionIds,
      sessionHeldTurns,
    } = this.#options;
    const label = this.#options.labelFor(sessionId);
    this.#options.cancelQueuedWakes(sessionId);

    if (next) {
      mutedSessionIds.add(sessionId);
      pause.forgetHeld(sessionId);
      this.#options.globalHeldTurns.delete(sessionId);
      sessionHeldTurns.delete(sessionId);
      this.#options.forgetQueued(sessionId);
      this.#options.forgetLatest(sessionId);
    } else {
      mutedSessionIds.delete(sessionId);
    }
    pause.interrupt({ sessionId });
    this.#options.log(next
      ? `🔇 muted "${label}" — it stays quiet and forgets finished turns`
      : `▶ unmuted "${label}"`);
    this.#options.render();
  }
}

/** Events accepted while mute is active stay forgotten after a fast unmute. */
export function shouldForgetMutedArrival(
  event: Pick<TurnEvent, "type">,
  globalMuted: boolean,
  sessionMuted: boolean,
): boolean {
  if (!globalMuted && !sessionMuted) return false;
  return event.type !== "wake"
    && event.type !== "recite"
    && event.type !== "speak"
    && event.type !== "mute"
    && event.type !== "unmute"
    && event.type !== "pause"
    && event.type !== "resume";
}

const GLOBAL_MODE_CONTROLS = new Set<TurnEvent["type"]>([
  "mute",
  "unmute",
  "pause",
  "resume",
]);

/** Stamp queued session work at a mute edge while leaving it available for UI status. */
export function markQueuedTurnsForMute(
  queue: readonly TurnEvent[],
  mark: (event: TurnEvent) => void,
  sessionId?: string,
): void {
  for (const event of queue) {
    if (sessionId !== undefined && event.sessionId !== sessionId) continue;
    if (!GLOBAL_MODE_CONTROLS.has(event.type) && event.type !== "speak") mark(event);
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
 * Apply quiet-mode semantics to a future turn at the point the daemon handles
 * it. Pause keeps only the newest event; mute deletes any held event.
 */
export function gateTurnForControls(
  event: TurnEvent,
  audible: boolean,
  options: {
    globalMuted: boolean;
    globalPaused: boolean;
    settingsOpen: boolean;
    globalHeldTurns: Map<string, TurnEvent>;
    pausedSessionIds: ReadonlySet<string>;
    mutedSessionIds: ReadonlySet<string>;
    sessionHeldTurns: Map<string, TurnEvent>;
  },
): TurnControlDisposition {
  // Explicit user commands cut through quiet modes. Settings remains a modal
  // pause: it traps input itself, and a queued command must not pierce it.
  const explicitQuietOverride = event.type === "wake" || event.type === "recite";
  if (
    audible
    && !explicitQuietOverride
    && options.mutedSessionIds.has(event.sessionId)
  ) {
    options.sessionHeldTurns.delete(event.sessionId);
    return "session-muted";
  }
  if (!explicitQuietOverride && options.globalMuted) return "global-muted";
  if (
    audible
    && !explicitQuietOverride
    && options.pausedSessionIds.has(event.sessionId)
  ) {
    options.sessionHeldTurns.set(event.sessionId, event);
    return "session-paused";
  }
  if (options.globalPaused && (!explicitQuietOverride || options.settingsOpen)) {
    options.globalHeldTurns.set(event.sessionId, event);
    return "global-paused";
  }
  return null;
}

export function muteAcknowledgement(next: boolean): string {
  return next ? "Muted." : "Back on.";
}
