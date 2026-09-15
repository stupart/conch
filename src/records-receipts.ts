import { createHash, randomUUID } from "node:crypto";
import { recordKey, type RecordProvider, type RecordReceipt, type RecordSession } from "./records-types.ts";

/** Capture routing identity at admission. Labels and current UI selection are never receipt identities. */
export interface RecordObservationScope {
  sessionId: string;
  actionId: string;
  attemptId?: string;
  provider?: RecordProvider;
  nativeId?: string;
  transcriptPath?: string;
}

export interface RecordObservation extends RecordObservationScope {
  kind: RecordReceipt["kind"];
  state: RecordReceipt["state"];
  observedAt: number;
  code?: string;
  characterCount?: number;
  reviewId?: string;
}
export type RecordObserver = (event: RecordObservation) => void;

const terminal = new Set<RecordReceipt["state"]>(["delivered", "staged", "failed", "unknown", "published", "opened", "completed", "interrupted"]);
const allowedStates: Record<RecordReceipt["kind"], readonly RecordReceipt["state"][]> = {
  delivery: ["accepted", "delivered", "staged", "failed", "unknown"],
  review: ["published", "opened", "failed", "unknown"],
  speech: ["queued", "started", "completed", "interrupted", "failed", "unknown"],
};

function safeCode(value: string | undefined): string | undefined {
  return value && /^[a-z][a-z0-9-]{0,79}$/.test(value) ? value : undefined;
}

/** Pure mapping: retry the same fact, including its timestamp, to obtain the same immutable receipt. */
export function recordReceipt(session: RecordSession, event: RecordObservation): RecordReceipt {
  if (!event.actionId || !event.sessionId || !Number.isFinite(event.observedAt)
    || !allowedStates[event.kind].includes(event.state)) throw new Error("invalid record observation");
  const code = safeCode(event.code);
  const details = {
    ...(code ? { code } : {}),
    ...(event.reviewId ? { reviewId: event.reviewId } : {}),
    ...(Number.isSafeInteger(event.characterCount) && event.characterCount! >= 0 ? { characterCount: event.characterCount } : {}),
  };
  return {
    id: recordKey(session.ownerDeviceId, session.id, event.kind, event.actionId, event.attemptId ?? event.actionId, event.state),
    sessionId: session.id,
    actionId: event.actionId,
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    kind: event.kind, state: event.state, observedAt: event.observedAt,
    ...(Object.keys(details).length ? { details } : {}),
  };
}

/** Observation must never change the side effect being observed. */
export function emitRecordObservation(observer: RecordObserver | undefined, event: RecordObservation): void {
  try { observer?.(event); } catch { /* The journal is optional; the operation retains its own result. */ }
}

/** Each operation owns a small settlement guard; callers allocate it once, before asynchronous work. */
export function createRecordOperation(
  observer: RecordObserver | undefined,
  scope: Omit<RecordObservationScope, "actionId"> & { actionId?: string },
  kind: RecordReceipt["kind"],
  characterCount?: number,
  now: () => number = Date.now,
): { scope: RecordObservationScope; emit(state: RecordReceipt["state"], code?: string): void } {
  const captured = { ...scope, actionId: scope.actionId ?? randomUUID() };
  const seen = new Set<RecordReceipt["state"]>();
  let settled = false;
  return {
    scope: captured,
    emit(state, code) {
      if (settled || seen.has(state) || !captured.sessionId) return;
      if (!allowedStates[kind].includes(state)) throw new Error("invalid record operation state");
      seen.add(state);
      if (terminal.has(state)) settled = true;
      emitRecordObservation(observer, { ...captured, kind, state, observedAt: now(), code, characterCount });
    },
  };
}

/** Stable publication identity without copying summary/link text into the journal. */
export function reviewPublicationObservation(
  scope: Omit<RecordObservationScope, "actionId">,
  review: { summary: string; link?: string; at: number },
): RecordObservation {
  const digest = createHash("sha256").update(JSON.stringify([review.summary, review.link ?? null])).digest("hex");
  const reviewId = recordKey(scope.sessionId, review.at, digest);
  return { ...scope, actionId: reviewId, reviewId, kind: "review", state: "published", observedAt: review.at };
}

export interface RecordReceiptObserverOptions {
  ownerDeviceId: string;
  resolveSession(localSessionKey: string, observation?: RecordObservation): RecordSession | undefined;
  appendReceipt(receipt: RecordReceipt): Promise<unknown>;
  onError?(error: unknown): void;
  /** Active operations only, never an ever-growing deduplication history. */
  maxActiveScopes?: number;
}

/** Capture ownership once at admission; later callbacks cannot follow a reused UI/session alias. */
export function createRecordReceiptObserver(options: RecordReceiptObserverOptions): RecordObserver {
  const active = new Map<string, RecordSession>();
  const maximum = Math.max(1, options.maxActiveScopes ?? 1024);
  const report = (error: unknown) => { try { options.onError?.(error); } catch {} };
  return (event) => {
    const key = recordKey(event.kind, event.sessionId, event.actionId, event.attemptId ?? event.actionId);
    const admission = event.state === "accepted" || event.state === "queued";
    const oneShot = event.kind === "review";
    let session = active.get(key);
    if (!session && (admission || oneShot)) {
      if (!oneShot && active.size >= maximum) return report(new Error("record observation scope limit reached"));
      try { session = options.resolveSession(event.sessionId, event); }
      catch { return report(new Error("record observation session resolution failed")); }
      if (!session || session.ownerDeviceId !== options.ownerDeviceId) return;
      session = { ...session };
      if (!oneShot) active.set(key, session);
    }
    // Missing admission can mean a disabled journal, unresolved owner or an exhausted scope limit.
    // Resolving again here could attribute a late result to whichever session now occupies the UI slot.
    if (!session) return;
    if (terminal.has(event.state)) active.delete(key);
    try {
      const receipt = recordReceipt(session, event);
      void options.appendReceipt(receipt).catch(report);
    } catch (error) { report(error); }
  };
}
