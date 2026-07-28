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

export interface InstantControlOptions {
  /** Omit for an app-wide control; set for a single-session control. */
  sessionId?: string;
  /** Pause supplies a latest-per-session hold map; mute omits it and forgets. */
  hold?: Map<string, TurnEvent>;
  /** Keep an already-held newer turn instead of replacing it with an explicit wake. */
  preserveHeld?: boolean;
}

export interface PauseResumeResult {
  replayed: number;
  dropped: number;
  cancelled: boolean;
}

export interface PauseControllerOptions {
  initialPaused: boolean;
  pending: Map<string, TurnEvent>;
  currentTurn(): TurnEvent | null;
  /** Normalize an active wake to the completed turn that pause should replay. */
  holdableTurn?(current: TurnEvent): TurnEvent | null;
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

/**
 * Coordinates overlapping silent-pause owners around one prior-state snapshot.
 * Every new owner still force-interrupts, but only the last release restores.
 */
export class SilentPauseCoordinator {
  readonly #target: SettingsPauseTarget;
  readonly #onError: (error: unknown) => void;
  readonly #owners = new Set<object>();
  #priorPaused: boolean | null = null;

  constructor(target: SettingsPauseTarget, onError: (error: unknown) => void = () => {}) {
    this.#target = target;
    this.#onError = onError;
  }

  acquire(owner: object): void {
    if (this.#owners.has(owner)) return;
    if (!this.#owners.size) this.#priorPaused = this.#target.paused;
    this.#owners.add(owner);
    this.#transition(true, { announce: false, interrupt: true });
  }

  /** An explicit global control becomes the state restored after all owners leave. */
  recordManualState(paused: boolean): void {
    if (this.#owners.size) this.#priorPaused = paused;
  }

  release(owner: object): void {
    if (!this.#owners.delete(owner) || this.#owners.size) return;
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

/** One caller lifetime owns one silent pause and one prior-state restore. */
export class SettingsPauseLifecycle {
  readonly #coordinator: SilentPauseCoordinator;
  readonly #owner = {};

  constructor(
    target: SettingsPauseTarget | SilentPauseCoordinator,
    onError: (error: unknown) => void = () => {},
  ) {
    this.#coordinator = target instanceof SilentPauseCoordinator
      ? target
      : new SilentPauseCoordinator(target, onError);
  }

  open(): void {
    this.#coordinator.acquire(this.#owner);
  }

  close(): void {
    this.#coordinator.release(this.#owner);
  }
}

/**
 * Owns global away-mode transitions and the instant-control generation shared
 * by global and per-session pause/mute controls.
 *
 * A generation token outlives a quick pause/resume pair, so the old async turn
 * cannot continue after its replay has already been queued.
 */
export class PauseController {
  readonly #pending: Map<string, TurnEvent>;
  readonly #options: PauseControllerOptions;
  #paused: boolean;
  #generation = 0;
  #resumeInFlight: {
    held: TurnEvent[];
    cancelled: boolean;
    forgottenSessionIds: Set<string>;
  } | null = null;

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

  /** Once interrupted, only a barrier acknowledgement may cross this gate. */
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
   * The reusable synchronous control edge. App-wide controls always interrupt;
   * a scoped control interrupts only when its session owns the current exchange.
   * The abort promise is intentionally not awaited: the active event loop owns
   * and acknowledges its FIFO barrier, including an already-running Whisper job.
   */
  interrupt(options: InstantControlOptions = {}): boolean {
    const interruptedTurn = this.#options.currentTurn();
    if (options.sessionId !== undefined && interruptedTurn?.sessionId !== options.sessionId) {
      return false;
    }
    const turnGeneration = this.#options.currentTurnGeneration?.() ?? this.#generation;
    const turnIsCurrent = turnGeneration === this.#generation;
    this.#generation++;

    const heldTurn = interruptedTurn
      ? this.#options.holdableTurn
        ? this.#options.holdableTurn(interruptedTurn)
        : interruptedTurn
      : null;
    if (
      turnIsCurrent
      && interruptedTurn?.sessionId
      && heldTurn?.sessionId === interruptedTurn.sessionId
      && options.hold
    ) {
      if (!options.preserveHeld || !options.hold.has(heldTurn.sessionId)) {
        options.hold.set(heldTurn.sessionId, heldTurn);
        this.#options.onHold?.(heldTurn);
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

    return true;
  }

  /**
   * Permanently forget paused work, including a snapshot already being filtered
   * by beginResume(). Scoped mute removes only that session; global mute cancels
   * the whole replay without restoring it to the pending map.
   */
  forgetHeld(sessionId?: string): void {
    if (sessionId === undefined) {
      this.#pending.clear();
      const resume = this.#resumeInFlight;
      if (resume) {
        resume.cancelled = true;
        this.#resumeInFlight = null;
      }
      return;
    }

    this.#pending.delete(sessionId);
    this.#resumeInFlight?.forgottenSessionIds.add(sessionId);
  }

  /** Synchronous global drop-and-hold edge for away mode. */
  beginPause(forceInterrupt = false): boolean {
    this.#cancelResume();
    if (this.#paused && !forceInterrupt) return false;

    const wasPaused = this.#paused;
    this.#paused = true;
    this.interrupt({
      hold: this.#pending,
      preserveHeld: wasPaused,
    });

    if (!wasPaused) {
      this.#options.persist(true);
      this.#options.log("paused — holding finished sessions until you resume (p or `conch resume`)");
    }
    this.#options.render();
    this.#options.setModeState(true);
    return true;
  }

  /**
   * Apply resume state synchronously, then filter/requeue the held snapshot in
   * the background. Callers may await the result later for a spoken summary.
   */
  beginResume(): Promise<PauseResumeResult> {
    this.#cancelResume();
    this.#paused = false;
    this.#options.persist(false);
    this.#options.render();
    this.#options.setModeState(false);

    const held = [...this.#pending.values()];
    this.#pending.clear();
    const resume = {
      held,
      cancelled: false,
      forgottenSessionIds: new Set<string>(),
    };
    this.#resumeInFlight = resume;
    return this.#finishResume(resume);
  }

  async announcePaused(): Promise<void> {
    await this.#options.speak("Paused. I'll hold your queue.");
  }

  async announceResumed(result: PauseResumeResult): Promise<void> {
    if (result.cancelled) return;
    await this.#options.speak(result.replayed
      ? `Back. ${result.replayed} session${result.replayed === 1 ? "" : "s"} finished while you were away.`
      : "Back on.");
  }

  async setPaused(next: boolean, options: SetPausedOptions = {}): Promise<void> {
    const announce = options.announce ?? true;
    if (next) {
      this.beginPause(options.interrupt ?? false);
      if (announce) await this.announcePaused();
      return;
    }

    const result = await this.beginResume();
    if (announce) await this.announceResumed(result);
  }

  async #finishResume(
    resume: {
      held: TurnEvent[];
      cancelled: boolean;
      forgottenSessionIds: Set<string>;
    },
  ): Promise<PauseResumeResult> {
    const { held } = resume;
    // Drop entries that went stale while away. A registry read failure is null,
    // not an empty set, so uncertainty keeps the held turn.
    const liveIds = await this.#options.liveSessionIds();
    if (resume.cancelled) return { replayed: 0, dropped: 0, cancelled: true };
    const fresh: TurnEvent[] = [];
    for (const event of held) {
      if (resume.forgottenSessionIds.has(event.sessionId)) continue;
      if (liveIds && !liveIds.has(event.sessionId)) continue;
      const responded = await this.#options.userRespondedSince(event);
      if (resume.cancelled) return { replayed: 0, dropped: 0, cancelled: true };
      if (resume.forgottenSessionIds.has(event.sessionId)) continue;
      if (responded) continue;
      fresh.push(event);
    }

    if (this.#resumeInFlight === resume) this.#resumeInFlight = null;
    const replayable = fresh.filter(
      (event) => !resume.forgottenSessionIds.has(event.sessionId),
    );
    const dropped = held.length - replayable.length;
    this.#options.log(
      `resumed — ${replayable.length} session(s) waited while you were away`
      + (dropped ? ` (${dropped} stale, dropped)` : ""),
    );
    // Replay before the optional summary. This preserves the existing race:
    // a newer same-session event accepted during filtering supersedes this one.
    for (const event of replayable) this.#options.enqueue(event);
    return { replayed: replayable.length, dropped, cancelled: false };
  }

  #cancelResume(): void {
    const resume = this.#resumeInFlight;
    if (!resume) return;
    resume.cancelled = true;
    this.#resumeInFlight = null;
    // A newer same-session event already held by the new pause wins.
    for (const event of resume.held) {
      if (resume.forgottenSessionIds.has(event.sessionId)) continue;
      if (!this.#pending.has(event.sessionId)) this.#pending.set(event.sessionId, event);
    }
    this.#options.render();
  }
}
