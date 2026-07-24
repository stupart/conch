import type { TurnEvent } from "./hook.ts";
import type { DictationControllerState, DictationEvent } from "./dictation-controller.ts";

export interface PauseSession {
  abort(): void | Promise<void>;
}

export interface PauseDictationEventSession {
  readonly state: DictationControllerState;
  acknowledge(event: DictationEvent): void;
}

export interface PauseDictationDisposition {
  intercepted: boolean;
  terminal: boolean;
}

export interface PauseControllerOptions {
  initialPaused: boolean;
  pending: Map<string, TurnEvent>;
  currentTurn(): TurnEvent | null;
  /** Omit outside the daemon; when present, stale interrupted turns are not re-held. */
  currentTurnGeneration?(): number | null;
  activeSession(): PauseSession | null;
  cancelCurrentSpeech(): void;
  cancelPendingAudio(): void;
  persist(paused: boolean): void;
  render(): void;
  setModeState(paused: boolean): void;
  log(message: string): void;
  speak(text: string): Promise<void>;
  liveSessionIds(): Promise<ReadonlySet<string> | null>;
  userRespondedSince(event: TurnEvent): Promise<boolean>;
  enqueue(event: TurnEvent): void;
  onHold?(event: TurnEvent): void;
  onInterruptError?(error: unknown): void;
}

export interface SetPausedOptions {
  /** Manual controls announce; settings transitions deliberately do not. */
  announce?: boolean;
  /** Interrupt even when already paused, such as an explicit wake under settings. */
  interrupt?: boolean;
}

export interface SettingsPauseTarget {
  readonly paused: boolean;
  setPaused(next: boolean, options?: SetPausedOptions): void | Promise<void>;
}

/** One overlay-open lifetime owns one silent pause and one prior-state restore. */
export class SettingsPauseLifecycle {
  readonly #target: SettingsPauseTarget;
  readonly #onError: (error: unknown) => void;
  #priorPaused: boolean | null = null;

  constructor(target: SettingsPauseTarget, onError: (error: unknown) => void = () => {}) {
    this.#target = target;
    this.#onError = onError;
  }

  open(): void {
    if (this.#priorPaused !== null) return;
    this.#priorPaused = this.#target.paused;
    this.#transition(true, { announce: false, interrupt: true });
  }

  close(): void {
    const priorPaused = this.#priorPaused;
    this.#priorPaused = null;
    if (priorPaused === null || this.#target.paused === priorPaused) return;
    this.#transition(priorPaused, { announce: false });
  }

  #transition(next: boolean, options: SetPausedOptions): void {
    try {
      void Promise.resolve(this.#target.setPaused(next, options)).catch(this.#onError);
    } catch (error) {
      this.#onError(error);
    }
  }
}

/**
 * Owns global away-mode transitions and their interruption generation.
 *
 * A generation token outlives a quick pause/resume pair, so the old async turn
 * cannot continue after its replay has already been queued.
 */
export class PauseController {
  readonly #pending: Map<string, TurnEvent>;
  readonly #options: PauseControllerOptions;
  #paused: boolean;
  #generation = 0;
  #resumeInFlight: { held: TurnEvent[]; cancelled: boolean } | null = null;

  constructor(options: PauseControllerOptions) {
    this.#options = options;
    this.#pending = options.pending;
    this.#paused = options.initialPaused;
  }

  get paused(): boolean {
    return this.#paused;
  }

  capture(): number {
    return this.#generation;
  }

  interrupted(capturedGeneration: number): boolean {
    return capturedGeneration !== this.#generation;
  }

  /**
   * Once interrupted, no controller output may reach the reducer. Only its
   * barrier acknowledgement crosses this gate so abort() can finish cleanup.
   */
  interceptDictationEvent(
    capturedGeneration: number,
    event: DictationEvent,
    session: PauseDictationEventSession,
    onDrop: (event: Exclude<DictationEvent, { kind: "barrier" }>) => void = () => {},
  ): PauseDictationDisposition {
    if (!this.interrupted(capturedGeneration)) {
      return { intercepted: false, terminal: false };
    }
    if (event.kind === "barrier") {
      session.acknowledge(event);
      return { intercepted: true, terminal: session.state !== "draining" };
    }
    onDrop(event);
    return {
      intercepted: true,
      terminal: session.state !== "running" && session.state !== "draining",
    };
  }

  /**
   * Synchronous drop-and-hold edge. The abort promise is intentionally not
   * awaited here: the active event loop owns and acknowledges its FIFO barrier.
   */
  beginPause(forceInterrupt = false): boolean {
    const interruptedTurn = this.#options.currentTurn();
    const turnGeneration = this.#options.currentTurnGeneration?.() ?? this.#generation;
    const turnIsCurrent = turnGeneration === this.#generation;
    this.#cancelResume();
    if (this.#paused && !forceInterrupt) return false;

    const wasPaused = this.#paused;
    this.#paused = true;
    this.#generation++;

    if (turnIsCurrent && interruptedTurn?.sessionId) {
      // A forced settings pause can interrupt an explicit wake while ordinary
      // pause already holds a newer turn-end for that session. Keep the held
      // turn in that case so resume still replays the latest turn from its start.
      if (!wasPaused || !this.#pending.has(interruptedTurn.sessionId)) {
        this.#pending.set(interruptedTurn.sessionId, interruptedTurn);
        this.#options.onHold?.(interruptedTurn);
      }
    }

    try {
      this.#options.cancelCurrentSpeech();
    } catch (error) {
      this.#options.onInterruptError?.(error);
    }
    try {
      this.#options.cancelPendingAudio();
    } catch (error) {
      this.#options.onInterruptError?.(error);
    }

    const activeSession = this.#options.activeSession();
    if (activeSession) {
      try {
        void Promise.resolve(activeSession.abort()).catch((error) => {
          this.#options.onInterruptError?.(error);
        });
      } catch (error) {
        this.#options.onInterruptError?.(error);
      }
    }

    if (!wasPaused) {
      this.#options.persist(true);
      this.#options.log("paused — holding finished sessions until you resume (p or `conch resume`)");
    }
    this.#options.render();
    this.#options.setModeState(true);
    return true;
  }

  async setPaused(next: boolean, options: SetPausedOptions = {}): Promise<void> {
    const announce = options.announce ?? true;
    if (next) {
      this.beginPause(options.interrupt ?? false);
      if (announce) await this.#options.speak("Paused. I'll hold your queue.");
      return;
    }

    this.#cancelResume();
    this.#paused = false;
    this.#options.persist(false);
    this.#options.render();

    const held = [...this.#pending.values()];
    this.#pending.clear(); // snapshot + clear synchronously, before any await
    const resume = { held, cancelled: false };
    this.#resumeInFlight = resume;
    // Drop entries that went stale while away. A registry read failure is null,
    // not an empty set, so uncertainty keeps the held turn.
    const liveIds = await this.#options.liveSessionIds();
    if (resume.cancelled) return;
    const fresh: TurnEvent[] = [];
    for (const event of held) {
      if (liveIds && !liveIds.has(event.sessionId)) continue;
      const responded = await this.#options.userRespondedSince(event);
      if (resume.cancelled) return;
      if (responded) continue;
      fresh.push(event);
    }

    if (this.#resumeInFlight === resume) this.#resumeInFlight = null;
    const dropped = held.length - fresh.length;
    this.#options.log(
      `resumed — ${fresh.length} session(s) waited while you were away`
      + (dropped ? ` (${dropped} stale, dropped)` : ""),
    );
    this.#options.setModeState(false);
    // Replay before the optional summary. This preserves the existing race:
    // a newer same-session event accepted during filtering supersedes this one.
    for (const event of fresh) this.#options.enqueue(event);

    if (announce) {
      await this.#options.speak(fresh.length
        ? `Back. ${fresh.length} session${fresh.length === 1 ? "" : "s"} finished while you were away.`
        : "Back on.");
    }
  }

  #cancelResume(): void {
    const resume = this.#resumeInFlight;
    if (!resume) return;
    resume.cancelled = true;
    this.#resumeInFlight = null;
    // A newer same-session event already held by the new pause wins.
    for (const event of resume.held) {
      if (!this.#pending.has(event.sessionId)) this.#pending.set(event.sessionId, event);
    }
    this.#options.render();
  }
}
