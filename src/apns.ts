import { connect, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, randomUUID, sign, type KeyObject } from "node:crypto";

/**
 * Apple Push Notification service, spoken straight from this Mac (2026-11-10, Tyler: "we should also add a way for me to
 * let sessions send me messages on my phone via conch that ping and show notification").
 *
 * The phone shows a notice with the app closed only if Apple delivers it: nothing conch runs can wake a suspended app.
 * So the daemon is its own APNs provider. HTTP/2 to api.push.apple.com (or the sandbox, for a phone running a
 * development build), token auth: an ES256 JWT signed with the `.p8` key Tyler makes in his Apple Developer account
 * (push-key.ts keeps it in the Keychain). No third-party push service, and the relay never sees a notice.
 *
 * `node:http2` and `node:crypto`, as Bun provides them, and nothing from npm (CLAUDE.md).
 */

export type ApnsEnvironment = "development" | "production";

export const APNS_ORIGINS: Readonly<Record<ApnsEnvironment, string>> = {
  production: "https://api.push.apple.com",
  development: "https://api.sandbox.push.apple.com",
};

/** A Key ID or a Team ID: Apple's ten-character identifiers. */
export const APPLE_ID = /^[A-Z0-9]{10}$/;

/** What the daemon signs with: the key, and the two ids Apple checks it against. */
export interface ApnsCredentials {
  teamId: string;
  keyId: string;
  key: KeyObject;
}

/**
 * A `.p8` as pasted or read from its file: the PEM's own lines, or just its base64. What is kept is the base64 alone,
 * one line, which is what `security -i` can be given (push-key.ts). Checked by parsing it: an EC P-256 private key, as
 * every APNs auth key is, or an error that never repeats it.
 */
export function parseApnsKey(text: unknown): { body: string; key: KeyObject } | { error: string } {
  const refused = { error: "That isn't an APNs auth key. Choose the .p8 file Apple gave you (AuthKey_<Key ID>.p8), or paste all of it." };
  if (typeof text !== "string" || text.length > 4_096) return refused;
  const body = text
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  // A P-256 PKCS#8 key with its public half is 138 bytes (184 characters); without it, 67 (92).
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length < 80 || body.length > 400) return refused;
  try {
    const key = createPrivateKey({ key: Buffer.from(body, "base64"), format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return refused;
    return { body, key };
  } catch {
    return refused;
  }
}

const base64url = (value: Buffer | string): string => Buffer.from(value).toString("base64url");

/**
 * The provider token: `{alg: ES256, kid}.{iss: team, iat}`, signed. ES256's signature is r‖s, 64 bytes, not the DER a
 * signer gives by default (`dsaEncoding: "ieee-p1363"`).
 */
export function apnsJwt(credentials: ApnsCredentials, issuedAtSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: credentials.keyId }));
  const claims = base64url(JSON.stringify({ iss: credentials.teamId, iat: Math.floor(issuedAtSeconds) }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: credentials.key, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${base64url(signature)}`;
}

/**
 * One token, reused. Apple refuses a provider that makes a new one more than once every 20 minutes
 * (TooManyProviderTokenUpdates) and one older than an hour (ExpiredProviderToken), so a token lives 50 minutes, or until
 * the key changes or APNs says it's expired.
 */
export class ApnsTokenCache {
  static readonly LIFETIME_MS = 50 * 60_000;
  #held: { token: string; madeAt: number; keyId: string; teamId: string } | undefined;

  token(credentials: ApnsCredentials, now: number): string {
    const held = this.#held;
    if (held && held.keyId === credentials.keyId && held.teamId === credentials.teamId && now - held.madeAt < ApnsTokenCache.LIFETIME_MS) {
      return held.token;
    }
    const token = apnsJwt(credentials, now / 1000);
    this.#held = { token, madeAt: now, keyId: credentials.keyId, teamId: credentials.teamId };
    return token;
  }

  forget(): void {
    this.#held = undefined;
  }
}

export interface ApnsNotice {
  id: string;
  title: string;
  body: string;
  sessionId?: string;
  link?: string;
  /** Where a tap goes that isn't a session: `providers`, Settings › Providers. */
  target?: string;
}

/** The phone's category for a notice with a link: its notification carries an "Open link" button (`NoticeRoute`). */
export const NOTICE_LINK_CATEGORY = "conch.notice.link";

/**
 * The notification as APNs is sent it. What the phone reads back (`NoticeRoute` in ConchDesign) is under `conch`: the
 * notice's id, the session a tap opens, a link. The sound is the default one: a ping is what was asked for.
 */
export function apnsPayload(notice: ApnsNotice): Record<string, unknown> {
  return {
    aps: {
      alert: { title: notice.title, body: notice.body },
      sound: "default",
      // One session's notices stack together on the lock screen.
      "thread-id": notice.sessionId ? `session:${notice.sessionId}` : "conch",
      ...(notice.link ? { category: NOTICE_LINK_CATEGORY } : {}),
    },
    conch: {
      notice: notice.id,
      ...(notice.sessionId ? { session: notice.sessionId } : {}),
      ...(notice.link ? { link: notice.link } : {}),
      ...(notice.target ? { target: notice.target } : {}),
    },
  };
}

export interface ApnsRequest {
  origin: string;
  deviceToken: string;
  /** The app's bundle id. */
  topic: string;
  jwt: string;
  payload: unknown;
  /** Seconds since the epoch after which APNs drops it rather than deliver it late; 0 is "now or never". */
  expiration: number;
  timeoutMs?: number;
}

export interface ApnsResponse {
  status: number;
  /** APNs's own word for a refusal (`BadDeviceToken`, `Unregistered`, …). */
  reason?: string;
  apnsId?: string;
}

/** The longest a payload may be (APNs: 4 KB). */
export const APNS_PAYLOAD_MAX_BYTES = 4_096;

/**
 * One POST to `/3/device/<token>`, on a connection of its own: a few notices an hour don't need one held open, and a
 * held one is a socket the daemon has to keep healthy across sleep. Rejects when APNs couldn't be reached at all.
 */
export function sendApns(request: ApnsRequest, open: (origin: string) => ClientHttp2Session = (origin) => connect(origin)): Promise<ApnsResponse> {
  const body = Buffer.from(JSON.stringify(request.payload));
  if (body.byteLength > APNS_PAYLOAD_MAX_BYTES) return Promise.reject(new Error("the notice is larger than APNs takes"));
  return new Promise((resolve, reject) => {
    let session: ClientHttp2Session;
    try {
      session = open(request.origin);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const finish = (outcome: { response?: ApnsResponse; error?: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.close();
      if (outcome.response) resolve(outcome.response);
      else reject(outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)));
    };
    const timer = setTimeout(() => {
      finish({ error: new Error("APNs didn't answer in time") });
      session.destroy();
    }, request.timeoutMs ?? 10_000);
    session.on("error", (error) => finish({ error }));
    const stream = session.request({
      ":method": "POST",
      ":path": `/3/device/${request.deviceToken}`,
      authorization: `bearer ${request.jwt}`,
      "apns-topic": request.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.max(0, Math.floor(request.expiration))),
      "apns-id": randomUUID(),
      "content-type": "application/json",
    });
    let status = 0;
    let apnsId: string | undefined;
    let text = "";
    stream.setEncoding("utf8");
    stream.on("response", (headers) => {
      status = Number(headers[":status"]);
      const id = headers["apns-id"];
      apnsId = typeof id === "string" ? id : undefined;
    });
    stream.on("data", (chunk: string) => {
      if (text.length < 2_048) text += chunk;
    });
    stream.on("end", () => {
      let reason: string | undefined;
      try {
        const parsed = text ? JSON.parse(text) as { reason?: unknown } : {};
        if (typeof parsed.reason === "string" && /^[A-Za-z]{1,64}$/.test(parsed.reason)) reason = parsed.reason;
      } catch {}
      finish({ response: { status, ...(reason ? { reason } : {}), ...(apnsId ? { apnsId } : {}) } });
    });
    stream.on("error", (error) => finish({ error }));
    stream.end(body);
  });
}

/**
 * What one answer means for the device and the key:
 * - `sent`: Apple has it; delivery is Apple's from here.
 * - `gone`: the token is dead (410 `Unregistered`, 400 `BadDeviceToken`): the app was deleted, or it is another
 *   environment's token. The caller tries the other environment once before it forgets the device (`Notifier`).
 * - `key`: the key, Key ID or Team ID was refused (403): nothing will go until it's fixed in Settings › Phone app.
 * - `later`: APNs is busy or down (429, 5xx); nothing is retried, the result says so.
 * - `refused`: anything else, with APNs's reason (`DeviceTokenNotForTopic`: the phone's app isn't the topic's).
 */
export type ApnsVerdict = "sent" | "gone" | "key" | "later" | "refused";

export function apnsVerdict(response: ApnsResponse): ApnsVerdict {
  if (response.status === 200) return "sent";
  if (response.status === 410 || response.reason === "Unregistered" || response.reason === "BadDeviceToken") return "gone";
  if (response.status === 403 && response.reason !== "TooManyProviderTokenUpdates") return "key";
  if (response.status === 429 || response.status >= 500 || response.reason === "TooManyProviderTokenUpdates") return "later";
  return "refused";
}

/** APNs's reason in a few words a person can act on. */
export function describeApnsRefusal(response: ApnsResponse): string {
  const reason = response.reason ?? `HTTP ${response.status}`;
  switch (response.reason) {
    case "InvalidProviderToken":
      return "Apple refused the key: check the Key ID and Team ID, and that the key has Apple Push Notifications enabled (InvalidProviderToken)";
    case "ExpiredProviderToken":
      return "Apple said conch's signed token had expired; it will make a new one (ExpiredProviderToken)";
    case "MissingProviderToken":
      return "Apple got no key from conch (MissingProviderToken)";
    case "DeviceTokenNotForTopic":
      return "the phone's conch isn't the app this key's team signs (DeviceTokenNotForTopic)";
    case "TopicDisallowed":
      return "Apple won't push to this app with this key (TopicDisallowed)";
    case "BadDeviceToken":
      return "the phone's token isn't one Apple knows (BadDeviceToken)";
    case "Unregistered":
      return "the phone's conch no longer takes notifications: open it on the phone to register again (Unregistered)";
    case "TooManyRequests":
      return "Apple asked conch to slow down (TooManyRequests)";
    default:
      return response.status >= 500 ? `Apple's push service is having trouble (${reason})` : `Apple refused it (${reason})`;
  }
}
