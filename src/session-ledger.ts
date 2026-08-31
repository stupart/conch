import type { TurnEvent } from "./hook.ts";
import type { PanelSessionState } from "./panel.ts";

type OrderedTurnEvent = Pick<TurnEvent, "type" | "sessionId" | "eventAt">;

export const STATE_EVENT_TYPES: ReadonlySet<TurnEvent["type"]> = new Set([
  "working",
  "turn-end",
  "needs-you",
]);

export function eventTimestamp(eventAt: unknown): number {
  return typeof eventAt === "number" && Number.isFinite(eventAt) && eventAt > 0 ? eventAt : 0;
}

/**
 * Arrival can invert occurrence order because separate hooks do different I/O.
 * Keep the newest state event seen for each session before queued handling, and
 * use object identity to invalidate an older event already sitting in the queue.
 */
export class TurnEventOrder {
  readonly #latest = new Map<string, { at: number; event: OrderedTurnEvent }>();

  accept(event: OrderedTurnEvent): boolean {
    if (!event.sessionId || !STATE_EVENT_TYPES.has(event.type)) return true;
    const at = eventTimestamp(event.eventAt);
    const current = this.#latest.get(event.sessionId);
    if (current && current.at > at) return false;
    this.#latest.set(event.sessionId, { at, event });
    return true;
  }

  isCurrent(event: OrderedTurnEvent): boolean {
    if (!event.sessionId || !STATE_EVENT_TYPES.has(event.type)) return true;
    return this.#latest.get(event.sessionId)?.event === event;
  }

  forget(sessionId: string): void {
    this.#latest.delete(sessionId);
  }

  prune(liveIds: ReadonlySet<string>): void {
    for (const id of this.#latest.keys()) {
      if (!liveIds.has(id)) this.#latest.delete(id);
    }
  }
}

/**
 * Owns daemon state keyed by conch's addressable session/window id.
 *
 * The fields stay public so hot render paths, raw Map/Set iteration, and
 * controller hand-off keep the same shape they had before this extraction.
 */
export class SessionLedger {
  // session -> last time conch drove it. Cleanup is still the TTL in markInjected.
  readonly injectedAt = new Map<string, number>();
  // Sessions that finished while paused; latest per session.
  readonly pending = new Map<string, TurnEvent>();
  // Dashboard latch: working / waiting / needs, possibly newer than registry state.
  readonly sessionStates = new Map<string, PanelSessionState>();
  readonly eventOrder = new TurnEventOrder();
  // Per-session manual mode holds only the newest turn for replay.
  readonly pausedSessionIds = new Set<string>();
  // Sessions resumed by name out of a global pause; global edges clear this set.
  readonly resumedSessionIds = new Set<string>();
  readonly prioritizedSessionIds = new Set<string>();
  readonly dismissedSessionIds = new Set<string>();
  readonly sessionHeldTurns = new Map<string, TurnEvent>();
  readonly dismissedHeldTurns = new Map<string, TurnEvent>();
  readonly latestTurnBySession = new Map<string, TurnEvent>();

  isKnown(sessionId: string): boolean {
    return this.sessionStates.has(sessionId)
      || this.latestTurnBySession.has(sessionId)
      || this.dismissedSessionIds.has(sessionId)
      || this.pausedSessionIds.has(sessionId)
      || this.prioritizedSessionIds.has(sessionId)
      || this.sessionHeldTurns.has(sessionId)
      || this.dismissedHeldTurns.has(sessionId)
      || this.pending.has(sessionId);
  }

  forget(sessionId: string): void {
    this.sessionStates.delete(sessionId);
    this.eventOrder.forget(sessionId);
    this.pausedSessionIds.delete(sessionId);
    this.resumedSessionIds.delete(sessionId);
    this.prioritizedSessionIds.delete(sessionId);
    this.dismissedSessionIds.delete(sessionId);
    this.sessionHeldTurns.delete(sessionId);
    this.dismissedHeldTurns.delete(sessionId);
    this.latestTurnBySession.delete(sessionId);
    this.pending.delete(sessionId);
  }

  forgetGone(liveIds: ReadonlySet<string>): void {
    const trackedIds = new Set([
      ...this.sessionStates.keys(),
      ...this.pausedSessionIds,
      ...this.prioritizedSessionIds,
      ...this.dismissedSessionIds,
      ...this.sessionHeldTurns.keys(),
      ...this.dismissedHeldTurns.keys(),
      ...this.latestTurnBySession.keys(),
      ...this.pending.keys(),
    ]);
    for (const id of trackedIds) {
      if (liveIds.has(id)) continue;
      this.forget(id);
    }
    this.eventOrder.prune(liveIds);
  }
}
