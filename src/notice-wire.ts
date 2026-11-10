import { connect } from "node:net";
import { NOTICE_BODY_MAX_CHARS } from "./agent-instructions.ts";
import { ControlFrameReader, encodeControlFrame } from "./control-framing.ts";

/**
 * A notice's words and requests, as they cross the daemon's socket (notify-user.ts sends them). Kept apart so the MCP
 * server, the control server and the phone bridge needn't load APNs, the Keychain or the device list to read one.
 */

export const NOTICE_TITLE_MAX = 80;
/** A leaf's own, so the tool's description says the same number (agent-instructions.ts must stay a leaf). */
export const NOTICE_BODY_MAX = NOTICE_BODY_MAX_CHARS;
/** An agent's notices per session per hour. A ping is for what can't wait; more than this is chatter. */
export const NOTICES_PER_HOUR = 4;
/** The same words from the same session inside this window are a repeat, and aren't sent again. */
export const DUPLICATE_WINDOW_MS = 60 * 60_000;
/** How long a notice waits on the sessions file for the Mac app, and how long the app has to say it showed it. */
export const MAC_NOTICE_KEEP_MS = 5 * 60_000;
export const MAC_NOTICE_ANSWER_MS = 4_000;
/** How long Apple holds a notice for a phone that's off or out of reach before dropping it. */
export const PUSH_EXPIRY_S = 6 * 60 * 60;

/** Where a tap goes that isn't a session: `providers` is Settings › Providers. */
export type NoticeTarget = "providers";

export interface Notice {
  id: string;
  title: string;
  body: string;
  sessionId?: string;
  link?: string;
  target?: NoticeTarget;
  /** Epoch ms. */
  at: number;
  source: "agent" | "conch";
}

export interface DeviceOutcome {
  device: string;
  outcome: "pushed" | "alerts-off" | "gone" | "failed";
  error?: string;
}

export interface PhoneOutcome {
  outcome: "pushed" | "not-set-up" | "no-phone" | "failed" | "skipped";
  detail: string;
  devices?: DeviceOutcome[];
}

export interface MacOutcome {
  outcome: "shown" | "asking" | "notifications-off" | "app-not-running" | "unconfirmed" | "failed" | "skipped";
  detail: string;
}

export interface NotifyResult {
  kind: "notify-result";
  outcome: "sent" | "duplicate" | "rate-limited" | "not-sent";
  notice?: string;
  phone?: PhoneOutcome;
  mac?: MacOutcome;
  /** One sentence for the agent to tell the user, from the outcomes and nothing else. */
  said: string;
}

// MARK: - Requests

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
const SESSION_ID = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const NOTICE_ID = /^[0-9a-f-]{36}$/;

/** The words of a notice, as sent: runs of whitespace one space, ends trimmed. Line breaks are a banner's to make. */
export const noticeText = (value: string): string => value.replace(/\s+/g, " ").trim();

/** A link a notice carries: http(s) only, and never one with a name or password in it. Undefined when it's fine. */
export function noticeLinkError(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return "link must be an http(s) URL of at most 2048 characters";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "link must be an http(s) URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "link must be an http(s) URL";
  if (url.username || url.password) return "link must not carry a user name or password";
}

export type NoticeRequest =
  /** Settings › Phone app: what's set up, set or replace the key, take it out, send a test. The Mac app's alone. */
  | { kind: "push-setup"; action: "status" | "remove" | "test" }
  | { kind: "push-setup"; action: "set"; keyId: string; teamId: string; key: string }
  /** An agent's `conch_notify`, from its MCP server: `from` is the session it is (or "unverified"), which the limit is kept by. */
  | { kind: "notify-user"; title: string; body: string; sessionId?: string; link?: string; from: string }
  /** The Mac app's word on a notice it was given on the sessions file. */
  | { kind: "notice-answer"; id: string; outcome: "shown" | "asking" | "off" | "failed"; error?: string };

export const NOTICE_REQUEST_KINDS = ["push-setup", "notify-user", "notice-answer"] as const;

/**
 * A notice request, checked: null for any other kind, an error for one of these that won't do. Every one is the Mac's
 * (phone-bridge.ts `MAC_APP_ONLY_DECODERS`): a phone sets up no key, sends no notice to itself, and answers for no Mac.
 * No error repeats a key.
 */
export function decodeNoticeRequest(value: unknown): { ok: true; value: NoticeRequest } | { ok: false; error: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!(NOTICE_REQUEST_KINDS as readonly unknown[]).includes(body.kind)) return null;
  if (body.kind === "push-setup") {
    if (body.action === "status" || body.action === "remove" || body.action === "test") {
      if (body.key !== undefined) return { ok: false, error: "Only set carries a key" };
      return { ok: true, value: { kind: "push-setup", action: body.action } };
    }
    if (body.action !== "set") return { ok: false, error: "Unknown push setup action" };
    if (typeof body.keyId !== "string" || typeof body.teamId !== "string" || typeof body.key !== "string") {
      return { ok: false, error: "Setting up push takes the Key ID, the Team ID and the key" };
    }
    return { ok: true, value: { kind: "push-setup", action: "set", keyId: body.keyId, teamId: body.teamId, key: body.key } };
  }
  if (body.kind === "notice-answer") {
    if (typeof body.id !== "string" || !NOTICE_ID.test(body.id)) return { ok: false, error: "id must be a notice's id" };
    if (body.outcome !== "shown" && body.outcome !== "asking" && body.outcome !== "off" && body.outcome !== "failed") {
      return { ok: false, error: "outcome must be shown, asking, off or failed" };
    }
    const error = typeof body.error === "string" && !CONTROL.test(body.error) ? body.error.slice(0, 200) : undefined;
    return { ok: true, value: { kind: "notice-answer", id: body.id, outcome: body.outcome, ...(error ? { error } : {}) } };
  }
  const title = typeof body.title === "string" ? noticeText(body.title) : "";
  const text = typeof body.body === "string" ? noticeText(body.body) : "";
  if (!title || [...title].length > NOTICE_TITLE_MAX) return { ok: false, error: `title must be 1–${NOTICE_TITLE_MAX} characters` };
  if (!text || [...text].length > NOTICE_BODY_MAX) return { ok: false, error: `body must be 1–${NOTICE_BODY_MAX} characters` };
  if (body.sessionId !== undefined && !SESSION_ID(body.sessionId)) return { ok: false, error: "sessionId must be a session's id" };
  if (body.link !== undefined) {
    const linkError = noticeLinkError(body.link);
    if (linkError) return { ok: false, error: linkError };
  }
  if (!SESSION_ID(body.from)) return { ok: false, error: "from must name the session asking, or unverified" };
  return {
    ok: true,
    value: {
      kind: "notify-user", title, body: text, from: body.from,
      ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      ...(typeof body.link === "string" ? { link: body.link } : {}),
    },
  };
}

/** A notify request and its answer over the socket, held open for the answer (the phone and the Mac both say first). */
export function requestNotice(
  socketPath: string,
  message: NoticeRequest,
  timeoutMs = 20_000,
): Promise<{ ok: true; reply: Record<string, unknown> } | { ok: false; reason: "daemon-down" | "no-reply"; diagnostic?: string }> {
  return new Promise((resolve) => {
    let frame: Buffer;
    try {
      frame = encodeControlFrame(JSON.stringify(message));
    } catch (error) {
      resolve({ ok: false, reason: "no-reply", diagnostic: error instanceof Error ? error.message : String(error) });
      return;
    }
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    const reader = new ControlFrameReader();
    let connected = false;
    let settled = false;
    const finish = (result: Awaited<ReturnType<typeof requestNotice>>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: connected ? "no-reply" : "daemon-down", diagnostic: "timed out" }), timeoutMs);
    socket.on("connect", () => {
      connected = true;
      socket.write(frame);
    });
    socket.on("data", (data) => {
      if (settled) return;
      try {
        const line = reader.push(typeof data === "string" ? Buffer.from(data) : data);
        if (line === undefined) return;
        const reply: unknown = JSON.parse(line);
        finish(reply && typeof reply === "object" && !Array.isArray(reply)
          ? { ok: true, reply: reply as Record<string, unknown> }
          : { ok: false, reason: "no-reply", diagnostic: "the daemon's answer wasn't an object" });
      } catch (error) {
        finish({ ok: false, reason: "no-reply", diagnostic: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.on("error", (error) => finish({ ok: false, reason: connected ? "no-reply" : "daemon-down", diagnostic: error.message }));
    socket.on("close", () => finish({ ok: false, reason: connected ? "no-reply" : "daemon-down" }));
  });
}
