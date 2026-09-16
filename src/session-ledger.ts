import { readFileSync } from "node:fs";
import type { TurnEvent } from "./hook.ts";
import type { PanelSessionState, SessionReview } from "./panel.ts";
import { reviewIdentity } from "./records-receipts.ts";
import { writeSettingsFileAtomic } from "./settings.ts";
import { checkReviewScene } from "./snippet.ts";

/** The saved-deliverables file stops growing here: newest reviews first, older ones dropped. */
export const MAX_REVIEWS_BYTES = 256_000;

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
  constructor(
    /** Where each session's current deliverable outlives the daemon. Absent writes nothing. */
    readonly reviewsPath?: string,
  ) {}
  #savedReviews = "";
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
  // A12: the "Codex row has no pid" warning latch — one record per unresolved
  // interval. Lived in the daemon closure before, where nothing pruned it.
  readonly reportedMissingCodexPid = new Set<string>();
  // The last turn conch announced or held: what a bare wake or recite resolves
  // to. Written by the voice loop and the daemon both, so it lives here. Not
  // cleared by forget(): a wake on a closed session must still say "That
  // session is closed." rather than "Nothing to wake."
  lastTurn: TurnEvent | null = null;

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
    const hadReview = this.sessionStates.get(sessionId)?.review !== undefined;
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
    this.reportedMissingCodexPid.delete(sessionId);
    // A gone session's deliverable leaves the file with it.
    if (hadReview) this.saveReviews();
  }

  /**
   * Put back each session's deliverable from before a daemon restart with its
   * filing `at`, so both apps see the same deliverable rather than a new one.
   * Status is not restored: the latch is `at: 0`, the oldest possible truth,
   * so the first hook or registry status wins and `carriedReview` keeps the
   * review. Sessions that are gone are dropped by the first `forgetGone`.
   */
  restoreReviews(): void {
    if (!this.reviewsPath) return;
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(this.reviewsPath, "utf8"));
    } catch {
      return;
    }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
    for (const [sessionId, entry] of Object.entries(saved)) {
      const { label, review } = (entry ?? {}) as { label?: unknown; review?: { summary?: unknown; link?: unknown; scene?: unknown; at?: unknown; id?: unknown } };
      if (
        !sessionId || this.sessionStates.has(sessionId) || typeof label !== "string"
        || typeof review?.summary !== "string" || typeof review.at !== "number" || !Number.isFinite(review.at)
        || (review.link !== undefined && typeof review.link !== "string")
      ) continue;
      // A scene this conch can't read is dropped; the review is still the review.
      const scene = review.scene === undefined ? undefined : checkReviewScene(review.scene, Boolean(review.link));
      // A deliverable filed before identities existed is minted from the same recipe, so a
      // restart restores the SAME deliverable rather than introducing a second one.
      const restored = {
        summary: review.summary,
        ...(review.link ? { link: review.link as string } : {}),
        ...(scene?.ok ? { scene: scene.scene } : {}),
        at: review.at,
      };
      const id = typeof review.id === "string" && review.id ? review.id : reviewIdentity(sessionId, restored);
      // ponytail: `waiting` shows only on a row nothing gives a status (no registry status, no hook yet); persist status if that bites.
      this.sessionStates.set(sessionId, {
        label,
        status: "waiting",
        at: 0,
        review: { ...restored, id },
      });
    }
  }

  /** Rewrite the saved deliverables (atomic rename), newest first up to `MAX_REVIEWS_BYTES`. */
  saveReviews(): void {
    if (!this.reviewsPath) return;
    const newestFirst = [...this.sessionStates]
      .filter((entry): entry is [string, PanelSessionState & { review: SessionReview }] => entry[1].review !== undefined)
      .sort(([, a], [, b]) => b.review.at - a.review.at);
    const kept: Record<string, { label: string; review: SessionReview }> = {};
    let bytes = 5; // "{\n", "\n}" and the trailing newline
    for (const [sessionId, { label, review }] of newestFirst) {
      const entry = {
        label,
        review: {
          summary: review.summary,
          ...(review.link ? { link: review.link } : {}),
          ...(review.scene ? { scene: review.scene } : {}),
          at: review.at,
          id: review.id,
        },
      };
      // Its pretty-printed lines at depth one, plus the ",\n" joining it.
      bytes += Buffer.byteLength(JSON.stringify({ [sessionId]: entry }, null, 2)) - 2;
      if (bytes > MAX_REVIEWS_BYTES) break;
      kept[sessionId] = entry;
    }
    const body = JSON.stringify(kept);
    if (body === this.#savedReviews) return;
    try {
      writeSettingsFileAtomic(this.reviewsPath, kept);
      this.#savedReviews = body;
    } catch {
      // Advisory, like the sessions file: an unwritable /tmp must not break a latch.
    }
  }

  forgetGone(liveIds: ReadonlySet<string>): void {
    const trackedIds = new Set([
      ...this.sessionStates.keys(),
      ...this.pausedSessionIds,
      ...this.prioritizedSessionIds,
      ...this.dismissedSessionIds,
      // A11: this set is checked BEFORE the global pause gate, so a stale
      // entry is a closed session that can still speak through manual mode.
      ...this.resumedSessionIds,
      ...this.sessionHeldTurns.keys(),
      ...this.dismissedHeldTurns.keys(),
      ...this.latestTurnBySession.keys(),
      ...this.pending.keys(),
      // A12: `closeLiveSession` adds on a failed close, so an id can live ONLY here.
      ...this.reportedMissingCodexPid,
    ]);
    for (const id of trackedIds) {
      if (liveIds.has(id)) continue;
      this.forget(id);
    }
    this.eventOrder.prune(liveIds);
  }
}
