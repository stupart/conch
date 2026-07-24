export interface NavigationScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const defaultScheduler: NavigationScheduler = {
  set(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** Theater's active anchor and transient manual cursor are intentionally separate. */
export class TheaterNavigation {
  /** Active session in the last frame that reached the renderer. */
  activeSessionId: string | null = null;
  /** Pending manual selection for the next frame. */
  manualSelectedId: string | null = null;
  #paintedSelectedId: string | null = null;
  readonly #onChange: () => void;
  readonly #fadeMs: number;
  readonly #scheduler: NavigationScheduler;
  #fadeTimer: unknown = null;

  constructor(
    onChange: () => void,
    fadeMs = 2_500,
    scheduler: NavigationScheduler = defaultScheduler,
  ) {
    this.#onChange = onChange;
    this.#fadeMs = fadeMs;
    this.#scheduler = scheduler;
  }

  /** Manual selection in the last frame that reached the renderer. */
  get paintedSelectedId(): string | null {
    return this.#paintedSelectedId;
  }

  /** Commit exactly the navigation state used by a synchronously-painted frame. */
  commitFrame(activeSessionId: string | null, manualSelectedId: string | null): void {
    this.activeSessionId = activeSessionId;
    this.#paintedSelectedId = manualSelectedId;
  }

  /** Called during the current repaint, so it does not schedule another one. */
  reconcile(liveIds: ReadonlySet<string>): void {
    if (!this.manualSelectedId || liveIds.has(this.manualSelectedId)) return;
    this.manualSelectedId = null;
    this.#clearFade();
  }

  move(order: readonly string[], delta: -1 | 1, fallbackSessionId: string | null = null): void {
    if (!order.length) return;
    const base = this.manualSelectedId
      ?? this.#paintedSelectedId
      ?? this.activeSessionId
      ?? fallbackSessionId;
    const baseIndex = base ? order.indexOf(base) : -1;
    const current = baseIndex >= 0 ? baseIndex : (delta > 0 ? -1 : order.length);
    const next = current + delta;
    if (next < 0 || next >= order.length) {
      this.release();
      return;
    }
    this.manualSelectedId = order[next]!;
    this.#armFade();
    this.#onChange();
  }

  actionTarget(fallbackSessionId: string | null = null): string | null {
    return this.#paintedSelectedId ?? this.activeSessionId ?? fallbackSessionId;
  }

  /**
   * A control is session-scoped only while manual navigation is still live.
   * Unlike actionTarget(), this deliberately never falls back to the active or
   * last session, and a stale painted cursor stops counting as soon as it fades.
   */
  manualControlTarget(): string | null {
    return this.manualSelectedId;
  }

  release(): void {
    const changed = this.manualSelectedId !== null;
    this.manualSelectedId = null;
    this.#clearFade();
    if (changed) this.#onChange();
  }

  dispose(): void {
    this.activeSessionId = null;
    this.manualSelectedId = null;
    this.#paintedSelectedId = null;
    this.#clearFade();
  }

  #armFade(): void {
    this.#clearFade();
    this.#fadeTimer = this.#scheduler.set(() => {
      this.#fadeTimer = null;
      if (!this.manualSelectedId) return;
      this.manualSelectedId = null;
      this.#onChange();
    }, this.#fadeMs);
  }

  #clearFade(): void {
    if (this.#fadeTimer === null) return;
    this.#scheduler.clear(this.#fadeTimer);
    this.#fadeTimer = null;
  }
}
