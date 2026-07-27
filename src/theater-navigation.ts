/** Theater's active anchor and parked manual cursor are intentionally separate. */
export class TheaterNavigation {
  /** Active session in the last frame that reached the renderer. */
  activeSessionId: string | null = null;
  /** Pending manual selection for the next frame. */
  manualSelectedId: string | null = null;
  #paintedSelectedId: string | null = null;
  readonly #onChange: () => void;

  constructor(onChange: () => void) {
    this.#onChange = onChange;
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
    this.#onChange();
  }

  actionTarget(fallbackSessionId: string | null = null): string | null {
    return this.#paintedSelectedId ?? this.activeSessionId ?? fallbackSessionId;
  }

  /**
   * A control is session-scoped while a manual selection remains parked.
   * Unlike actionTarget(), this deliberately never falls back to the active or
   * last session.
   */
  manualControlTarget(): string | null {
    return this.manualSelectedId;
  }

  release(): void {
    const changed = this.manualSelectedId !== null;
    this.manualSelectedId = null;
    if (changed) this.#onChange();
  }

  dispose(): void {
    this.activeSessionId = null;
    this.manualSelectedId = null;
    this.#paintedSelectedId = null;
  }
}
