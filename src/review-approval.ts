/**
 * Approve, only when the agent asks for it, and the agent told when you do.
 *
 * 2026-10-05, Tyler, after using #502: "I don't really get the point of the approve button... maybe we only show it if
 * the AI sets some sort of flag in the review that it's asking for me to approve some work?" So a published result
 * offers Approve only when its agent asked (`review_to_front`'s `approval: {label?}`, filed as `asksApproval` and
 * `approvalLabel`), and approving is no longer bookkeeping alone: once the 10 s undo window has closed, conch sends the
 * session `Approved: <label>.` as a message, through the composer's own delivery path.
 *
 * Three pieces, each used by the daemon and by the tests as they are:
 * - `checkApprovalRequest`: the one rule for the request, in `review_to_front` (mcp.ts), on the socket
 *   (control-server.ts) and again where the daemon files it (voice-loop `fileNow`).
 * - `approvedMessage`: what the agent is sent.
 * - `HeldApprovalMessages` and `reviewApprovalActions`: the message held for the undo window by the DAEMON, so closing
 *   the app inside it still sends it, and cancelled by an undo inside it.
 *
 * A restart inside the window drops the held message (the approval itself and its sea glass are on the record and
 * stay). Holding it across a restart would mean writing an outbox and re-finding the session's terminal before the
 * registry has been read at boot, for a window of 10 s; an approval that reached nobody is said in the log instead.
 */
import type { TurnEvent } from "./hook.ts";
import type { PanelSessionState, SessionReview } from "./panel.ts";
import type { ReviewApprovalOutcome, SessionActionsTarget } from "./session-actions-overlay.ts";

/** The longest an approval's label may be: a button's words ("Open the PR", "Deploy", "Merge"), not a sentence. */
export const APPROVAL_LABEL_MAX = 40;

/** How much of the summary the message carries when the agent gave no label. */
export const APPROVAL_SUMMARY_MAX = 120;

/** What an agent may ask: approval, and optionally what approving does. */
export interface ApprovalRequest {
  label?: string;
}

/** The same characters `sanitizeReviewSummary` drops (snippet.ts), so a label is one printable line like a summary. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Check an `approval` request. `exact` is the socket's and the filing's rule: the label as sent must already be
 * clean (one printable line, trimmed, 1 to 40 characters), since only `review_to_front` writes it and it cleans it
 * first. Without `exact` (`review_to_front` itself), control characters are dropped and the label trimmed before the
 * same length rule; an empty label is refused rather than taken as none, so a mistake is said, not guessed at.
 */
export function checkApprovalRequest(
  value: unknown,
  { exact = false }: { exact?: boolean } = {},
): { ok: true; approval: ApprovalRequest } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "approval must be an object: {} or {label}" };
  }
  const extra = Object.keys(value).filter((key) => key !== "label");
  if (extra.length) return { ok: false, reason: `approval takes only label, not ${extra.join(", ")}` };
  const raw = (value as { label?: unknown }).label;
  if (raw === undefined) return { ok: true, approval: {} };
  const words = `approval.label must be 1 to ${APPROVAL_LABEL_MAX} printable characters naming what approving does (e.g. "Open the PR"), or leave it out`;
  if (typeof raw !== "string") return { ok: false, reason: words };
  const label = raw.replace(CONTROL, "").trim();
  if (!label || label.length > APPROVAL_LABEL_MAX || (exact && label !== raw)) return { ok: false, reason: words };
  return { ok: true, approval: { label } };
}

/**
 * What the agent is sent when its result is approved: `Approved: <label>.`, or `Approved: <summary>.` with the summary
 * cut to 120 characters (an ellipsis where it was cut) when it gave no label. No second full stop after one it already
 * ends with.
 */
export function approvedMessage(review: Pick<SessionReview, "summary" | "approvalLabel">): string {
  const label = review.approvalLabel?.trim();
  const summary = review.summary.trim();
  const said = label || (summary.length > APPROVAL_SUMMARY_MAX
    ? `${summary.slice(0, APPROVAL_SUMMARY_MAX - 1).trimEnd()}…`
    : summary);
  return `Approved: ${said}${/[.!?…]$/.test(said) ? "" : "."}`;
}

/** Timers, injectable: the daemon's are the platform's, a test's are its own clock. */
export interface ApprovalTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const platformTimers: ApprovalTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface HeldApprovalDeps {
  /** How long the message is held: the undo window (`UNAPPROVE_WINDOW_MS`). */
  holdMs: number;
  /** Hand the message to the session, as a composer send (the daemon's `inject`). Called once per approval, at most. */
  deliver(sessionId: string, text: string): void;
  /** Asked when the window closes: is it still approved, at the time it was held for? An undo that missed the cancel. */
  stillApproved?(sessionId: string, review: string, approvedAt: number): boolean;
  timers?: ApprovalTimers;
  log?(line: string): void;
}

interface Held {
  sessionId: string;
  review: string;
  approvedAt: number;
  text: string;
  handle: unknown;
}

/**
 * The messages approvals are waiting to send, one per approved result, each held for the undo window and then
 * delivered, unless an undo inside the window cancelled it. In the daemon's memory alone: see the module's note on a
 * restart.
 */
export class HeldApprovalMessages {
  readonly #held = new Map<string, Held>();
  /** What was sent, by result, and when: an undo after the agent was told is refused rather than half done. */
  readonly #sent = new Map<string, number>();
  readonly #timers: ApprovalTimers;

  constructor(private readonly deps: HeldApprovalDeps) {
    this.#timers = deps.timers ?? platformTimers;
  }

  static key(sessionId: string, review: string): string {
    return `${sessionId}\u0000${review}`;
  }

  /** Hold `text` for this approval. One already held for the result is replaced, never sent twice. */
  hold(sessionId: string, review: string, approvedAt: number, text: string): void {
    const key = HeldApprovalMessages.key(sessionId, review);
    this.cancel(sessionId, review);
    this.#sent.delete(key);
    const handle = this.#timers.set(() => this.#due(key), this.deps.holdMs);
    this.#held.set(key, { sessionId, review, approvedAt, text, handle });
  }

  /** Cancel the held message (an undo inside the window). True when there was one to cancel. */
  cancel(sessionId: string, review: string): boolean {
    const key = HeldApprovalMessages.key(sessionId, review);
    const held = this.#held.get(key);
    if (!held) return false;
    this.#timers.clear(held.handle);
    this.#held.delete(key);
    return true;
  }

  isHeld(sessionId: string, review: string): boolean {
    return this.#held.has(HeldApprovalMessages.key(sessionId, review));
  }

  /** Whether this result's approval has already been sent to its agent (since this daemon started). */
  wasSent(sessionId: string, review: string): boolean {
    return this.#sent.has(HeldApprovalMessages.key(sessionId, review));
  }

  get heldCount(): number {
    return this.#held.size;
  }

  /** The window, in whole seconds, for the log. */
  get holdSeconds(): number {
    return Math.round(this.deps.holdMs / 1000);
  }

  /** Let every held message go unsent (the daemon is stopping): said in the log, so an approval nobody heard is known. */
  dropAll(why: string): number {
    const dropped = [...this.#held.values()];
    for (const held of dropped) {
      this.#timers.clear(held.handle);
      this.deps.log?.(`dropped the approval message held for a deliverable of ${held.sessionId}: ${why}`);
    }
    this.#held.clear();
    return dropped.length;
  }

  #due(key: string): void {
    const held = this.#held.get(key);
    if (!held) return;
    this.#held.delete(key);
    if (this.deps.stillApproved && !this.deps.stillApproved(held.sessionId, held.review, held.approvedAt)) {
      this.deps.log?.(`did not send an approval for a deliverable of ${held.sessionId}: it is no longer approved`);
      return;
    }
    const now = Date.now();
    // Bounded: nothing older than a minute can still be undone, so nothing older needs remembering.
    for (const [sent, at] of this.#sent) if (now - at > 60_000) this.#sent.delete(sent);
    this.#sent.set(key, now);
    this.deps.deliver(held.sessionId, held.text);
  }
}

/** The held deliverable `review` of a session, or undefined. */
export function heldDeliverable(state: PanelSessionState | undefined, review: string): SessionReview | undefined {
  const held = state?.reviews ?? (state?.review ? [state.review] : []);
  return held.find((one) => one.id === review);
}

/**
 * The daemon's `approveReview` and `unapproveReview` (session-actions-overlay.ts), over its ledger and its held
 * messages: the one place the Mac's ✓, the phone and the lagoon's approve all reach.
 *
 * - Approve: refused for a result that didn't ask (the ledger says why); otherwise approved and a piece of sea glass
 *   earned at once, idempotently (#502), and the message held for the window. A second approve changes nothing and holds
 *   nothing more.
 * - Undo inside the window: approval and sea glass back, the held message cancelled, `viewedAt` kept. Refused once the
 *   agent has been told, as it is past the window.
 */
export function reviewApprovalActions(deps: {
  ledger: {
    sessionStates: ReadonlyMap<string, PanelSessionState>;
    approveDeliverable(sessionId: string, review: string, now: number): ReviewApprovalOutcome;
    unapproveDeliverable(sessionId: string, review: string, now: number): ReviewApprovalOutcome;
    readonly seaGlass: number;
  };
  held: HeldApprovalMessages;
  now(): number;
  log(line: string): void;
  /** Something changed that the apps should see. */
  changed(): void;
}): {
  approve(target: Readonly<SessionActionsTarget>, review: string): ReviewApprovalOutcome;
  unapprove(target: Readonly<SessionActionsTarget>, review: string): ReviewApprovalOutcome;
} {
  const { ledger, held, log } = deps;
  return {
    approve(target, review) {
      const outcome = ledger.approveDeliverable(target.sessionId, review, deps.now());
      if (!outcome.ok || !outcome.changed) return outcome;
      const filed = heldDeliverable(ledger.sessionStates.get(target.sessionId), review);
      if (filed?.approvedAt !== undefined) held.hold(target.sessionId, review, filed.approvedAt, approvedMessage(filed));
      log(`approved a deliverable of "${target.label}" (sea glass: ${ledger.seaGlass}); its agent is told in ${held.holdSeconds} s`);
      deps.changed();
      return outcome;
    },
    unapprove(target, review) {
      if (held.wasSent(target.sessionId, review) && !held.isHeld(target.sessionId, review)) {
        return { ok: false, reason: "too late to take back: conch has already told the agent it was approved" };
      }
      const outcome = ledger.unapproveDeliverable(target.sessionId, review, deps.now());
      if (!outcome.ok || !outcome.changed) return outcome;
      const cancelled = held.cancel(target.sessionId, review);
      log(`took back the approval of a deliverable of "${target.label}" (sea glass: ${ledger.seaGlass})${cancelled ? "; its agent won't be told" : ""}`);
      deps.changed();
      return outcome;
    },
  };
}

/**
 * The send that carries `Approved: …` to the session: the composer's own `inject`, so it takes the same road as words
 * typed in conch (voice-loop `deliver`, then `deliverToSession`, confirmed by the agent's own evidence, and back to the
 * draft if it can't land). From the person, who approved.
 */
export function approvedInjectEvent(
  session: { sessionId: string; cwd?: string; pid?: number; transcriptPath?: string },
  label: string,
  text: string,
): TurnEvent {
  return {
    type: "inject",
    sessionId: session.sessionId,
    label,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.pid !== undefined ? { pid: session.pid } : {}),
    announce: text,
    ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
    origin: "user",
  };
}
