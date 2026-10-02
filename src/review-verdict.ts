import { connect } from "node:net";
import { ControlFrameReader, encodeControlFrame } from "./control-framing.ts";
import { isDeliverableKind, type DeliverableKind } from "./deliverables.ts";
import type { TurnEvent } from "./hook.ts";
import { ACCESS_CHECK_MS, isPageAccess, type PageAccess } from "./page-access.ts";
import { isReviewSurfaces, type AudioSurface, type ReviewSurfaces } from "./surfaces.ts";

/**
 * The daemon's answer to a publication: whether it filed it, under what, and who can see it.
 *
 * `review_to_front` used to send its publication fire-and-forget (`sendToDaemon` resolves on
 * connect) and told the agent "accepted", with an id and a version it predicted. The daemon then
 * checked the link again against its own folders and could refuse it, logging the reason where
 * only the help session reads it: the agent said "it's in conch" about something that never
 * arrived. And the version it predicted read low when a filing was still queued behind speech.
 *
 * Now a publication says `awaitVerdict: true` and the daemon files it at once, off the speech
 * queue (only its announcement waits there), and answers on the same connection:
 * `review-filed` with the filing's real id, artifact, version and link, or `review-refused` with
 * the daemon's own reason, and `surfaces` (surfaces.ts). A daemon from before this answers the
 * plain `{"kind":"ack"}` every turn event gets, which the MCP server reads as "taken, unconfirmed"
 * and says so, rather than inventing a verdict.
 */

/** How long a filing alone is waited for: a publication with no page to check, and `conch_capture`'s own. */
export const REVIEW_FILING_WAIT_MS = 7_000;
/**
 * How long the daemon holds the connection for its filing before answering `review-pending`. A `url` deliverable's
 * login-wall check (page-access.ts) runs beside its filing and is bounded at `ACCESS_CHECK_MS`; this leaves the filing
 * its own wait past that. It was 8 s until the check (2026-10-03, feedback item 3).
 */
export const REVIEW_VERDICT_WAIT_MS = ACCESS_CHECK_MS + REVIEW_FILING_WAIT_MS;
/** How long `review_to_front` waits for that answer: the daemon's wait, plus the trip. It was 10 s until the check. */
export const REVIEW_VERDICT_TIMEOUT_MS = REVIEW_VERDICT_WAIT_MS + 3_000;

/** What the daemon filed, as `conch_deliverables` will list it. */
export interface FiledReview {
  id: string;
  artifact: string;
  version: number;
  kind: DeliverableKind;
  /** The link as filed: absolute, and conch's own copy when the original sat in a temp folder. */
  link?: string;
  focus?: string[];
}

export type ReviewVerdict =
  | {
    kind: "review-filed";
    filing: FiledReview;
    /** The original of `filing.link`, when the daemon filed a copy of it (deliverable-store.ts). */
    copiedFrom?: string;
    /** Why a deliverable in a temp folder was filed where it is instead of copied. */
    notCopied?: string;
    /** What conch's voice does with it; the daemon adds `mac` and `phone` to make `surfaces`. */
    audio?: AudioSurface;
    surfaces?: ReviewSurfaces;
    /**
     * A `url` deliverable's login-wall check (page-access.ts): what conch's Mac and a device without its cookies were
     * shown. Absent for any other kind, from a daemon before the check, and when the publisher doesn't wait for it.
     */
    access?: PageAccess;
    /** One sentence to act on when either look said sign-in (`accessWarning`). */
    warning?: string;
    /** The Mac's picture of the page, filed on the deliverable for the phone (`SessionReview.snapshot`): its path. */
    snapshot?: string;
  }
  | { kind: "review-refused"; reason: string; surfaces?: ReviewSurfaces };

/** The daemon's answer when its filing outlived `REVIEW_VERDICT_WAIT_MS`: taken, still being filed. */
export interface ReviewPending {
  kind: "review-pending";
}

export function refusedVerdict(reason: string): Extract<ReviewVerdict, { kind: "review-refused" }> {
  return { kind: "review-refused", reason };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Whether a value (off the socket, or out of the daemon's own filing) is a verdict this conch can say. */
export function isReviewVerdict(value: unknown): value is ReviewVerdict {
  if (!record(value)) return false;
  if (value.surfaces !== undefined && !isReviewSurfaces(value.surfaces)) return false;
  if (value.kind === "review-refused") return typeof value.reason === "string" && value.reason.length > 0;
  if (value.kind !== "review-filed" || !record(value.filing)) return false;
  const filing = value.filing;
  return typeof filing.id === "string" && Boolean(filing.id)
    && typeof filing.artifact === "string" && Boolean(filing.artifact)
    && Number.isSafeInteger(filing.version) && (filing.version as number) > 0
    && isDeliverableKind(filing.kind)
    && (filing.link === undefined || typeof filing.link === "string")
    && (filing.focus === undefined || (Array.isArray(filing.focus) && filing.focus.every((path) => typeof path === "string")))
    && (value.copiedFrom === undefined || typeof value.copiedFrom === "string")
    && (value.notCopied === undefined || typeof value.notCopied === "string")
    && (value.access === undefined || isPageAccess(value.access))
    && (value.warning === undefined || typeof value.warning === "string")
    && (value.snapshot === undefined || typeof value.snapshot === "string");
}

/** What `review_to_front` heard back. */
export type PublishReply =
  | { kind: "verdict"; verdict: ReviewVerdict }
  /** Taken, but nothing says whether it was filed: an older daemon, or no answer in time. */
  | { kind: "unconfirmed"; why: string }
  | { kind: "down" };

/**
 * Send one publication with `awaitVerdict` and read the daemon's answer on the same connection.
 * Like `sendControlMessage`, the request is one complete line with no client FIN, since Bun can
 * close both halves on `end()`. Never rejects.
 *
 * It says `awaitAccess` too: this sender waits long enough for a `url` deliverable's login-wall
 * check (`REVIEW_VERDICT_TIMEOUT_MS`), so the daemon holds the verdict for it. An MCP server from
 * before the check waited 10 s and doesn't say so, and is answered as soon as it is filed.
 */
export function publishForVerdict(
  socketPath: string,
  event: TurnEvent,
  timeoutMs: number = REVIEW_VERDICT_TIMEOUT_MS,
): Promise<PublishReply> {
  return new Promise((resolve) => {
    let frame: Buffer;
    try {
      frame = encodeControlFrame(JSON.stringify({ ...event, awaitVerdict: true, awaitAccess: true }));
    } catch (error) {
      resolve({ kind: "verdict", verdict: refusedVerdict(`the publication is too large to send: ${error instanceof Error ? error.message : String(error)}`) });
      return;
    }
    const sock = connect({ path: socketPath, allowHalfOpen: true });
    const reader = new ControlFrameReader();
    let connected = false;
    let settled = false;
    const finish = (reply: PublishReply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(replyTimer);
      sock.destroy();
      resolve(reply);
    };
    // Nothing listening answers a connect at once; a daemon that accepts and never speaks is "taken, unconfirmed".
    const connectTimer = setTimeout(() => finish({ kind: "down" }), 500);
    let replyTimer: ReturnType<typeof setTimeout> | undefined;
    const answered = (line: string): void => {
      let reply: unknown;
      try {
        reply = JSON.parse(line);
      } catch {
        finish({ kind: "unconfirmed", why: "the daemon's answer could not be read" });
        return;
      }
      if (isReviewVerdict(reply)) finish({ kind: "verdict", verdict: reply });
      else if (record(reply) && reply.kind === "session-error" && typeof reply.error === "string") {
        // The socket's own check refused it before anything filed it.
        finish({ kind: "verdict", verdict: refusedVerdict(reply.error) });
      } else if (record(reply) && reply.kind === "review-pending") {
        finish({ kind: "unconfirmed", why: "the daemon took it and was still filing it when the wait ran out" });
      } else {
        finish({ kind: "unconfirmed", why: "this conch daemon is older and does not say whether it filed a publication" });
      }
    };
    sock.on("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      replyTimer = setTimeout(
        () => finish({ kind: "unconfirmed", why: `the daemon took it and did not answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}` }),
        timeoutMs,
      );
      sock.write(frame);
    });
    sock.on("data", (data) => {
      if (settled) return;
      try {
        const line = reader.push(typeof data === "string" ? Buffer.from(data) : data);
        if (line !== undefined) answered(line);
      } catch {
        finish({ kind: "unconfirmed", why: "the daemon's answer could not be read" });
      }
    });
    sock.on("error", () => finish(connected ? { kind: "unconfirmed", why: "the connection to the daemon broke before it answered" } : { kind: "down" }));
    sock.on("close", () => finish(connected ? { kind: "unconfirmed", why: "the daemon closed the connection without answering" } : { kind: "down" }));
  });
}

/**
 * The daemon side: what to answer a publication that asked for its verdict, once its filing
 * settles or `waitMs` passes. Anything that is not a verdict (a practice session's own turn, an
 * event nothing filed) answers undefined, and the socket sends its usual ack.
 */
export async function verdictWithin(
  work: unknown,
  waitMs: number = REVIEW_VERDICT_WAIT_MS,
): Promise<ReviewVerdict | ReviewPending | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = Symbol("late");
  try {
    const outcome = await Promise.race([
      Promise.resolve(work).catch(() => undefined),
      new Promise<typeof late>((resolve) => {
        timer = setTimeout(() => resolve(late), waitMs);
      }),
    ]);
    if (outcome === late) return { kind: "review-pending" };
    return isReviewVerdict(outcome) ? outcome : undefined;
  } finally {
    clearTimeout(timer);
  }
}
