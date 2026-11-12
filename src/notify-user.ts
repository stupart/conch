import { randomUUID } from "node:crypto";
import {
  APNS_ORIGINS,
  ApnsTokenCache,
  apnsPayload,
  apnsVerdict,
  describeApnsRefusal,
  sendApns,
  type ApnsCredentials,
  type ApnsEnvironment,
  type ApnsRequest,
  type ApnsResponse,
} from "./apns.ts";
import { tokenTail, type PushDevice, type PushDevices } from "./push-devices.ts";
import type { PushKeyRecord } from "./push-key.ts";
import {
  DUPLICATE_WINDOW_MS,
  MAC_NOTICE_ANSWER_MS,
  MAC_NOTICE_KEEP_MS,
  NOTICE_BODY_MAX,
  NOTICE_TITLE_MAX,
  NOTICES_PER_HOUR,
  noticeText,
  PUSH_EXPIRY_S,
  type DeviceOutcome,
  type MacOutcome,
  type Notice,
  type NoticeRequest,
  type NoticeTarget,
  type NotifyResult,
  type PhoneOutcome,
} from "./notice-wire.ts";

export * from "./notice-wire.ts";

/**
 * Telling Tyler something wherever he is: `notifyUser` (2026-11-10, Tyler: "we should also add a way for me to let
 * sessions send me messages on my phone via conch that ping and show notification").
 *
 * One notice goes two ways at once:
 *  - to each phone that turned notifications on, through Apple (apns.ts), so it arrives with conch's iPhone app in the
 *    background or closed, and a tap opens the session it's about. Only once a push key is set up (push-key.ts).
 *  - to the Mac, through conch's Mac app, which posts it as a macOS notification and says it did (`MacNotices`). Needs
 *    no key, so conch's own alerts reach the Mac on a fresh install.
 * Agents call it through `conch_notify` (mcp.ts), which is held to a few an hour and no repeats (`NoticeLimiter`);
 * conch's own alerts (rotation-sign-in-watch.ts) call it directly. The result says where it went and why not
 * elsewhere, so an agent tells the user what happened rather than what it hoped.
 */

// MARK: - The limit

/**
 * A few an hour per session, and never the same words twice in an hour. Kept in memory: a daemon restart forgets it,
 * which costs at most one more ping.
 */
export class NoticeLimiter {
  readonly #sent = new Map<string, Array<{ at: number; words: string }>>();

  constructor(private readonly perHour = NOTICES_PER_HOUR, private readonly duplicateMs = DUPLICATE_WINDOW_MS) {}

  static words(title: string, body: string): string {
    return `${noticeText(title)}\n${noticeText(body)}`.toLowerCase();
  }

  /** Whether `key` may send these words now, and if not, when it may send anything. */
  check(key: string, words: string, now: number): { ok: true } | { ok: false; why: "duplicate" | "rate-limited"; retryInMs?: number } {
    const recent = (this.#sent.get(key) ?? []).filter((one) => now - one.at < Math.max(60 * 60_000, this.duplicateMs));
    if (recent.some((one) => one.words === words && now - one.at < this.duplicateMs)) return { ok: false, why: "duplicate" };
    const lastHour = recent.filter((one) => now - one.at < 60 * 60_000);
    if (lastHour.length >= this.perHour) {
      return { ok: false, why: "rate-limited", retryInMs: 60 * 60_000 - (now - lastHour[0]!.at) };
    }
    return { ok: true };
  }

  record(key: string, words: string, now: number): void {
    const recent = (this.#sent.get(key) ?? []).filter((one) => now - one.at < Math.max(60 * 60_000, this.duplicateMs));
    recent.push({ at: now, words });
    this.#sent.set(key, recent);
    if (this.#sent.size > 256) this.#sent.delete(this.#sent.keys().next().value!);
  }
}

// MARK: - The Mac

type MacAnswer = Extract<NoticeRequest, { kind: "notice-answer" }>;

/**
 * Notices for the Mac app, on the sessions file alone (daemon `writeSessionsFile`, like `captureRequests`): the phone
 * gets its own through Apple, and a second Mac has its own conch. The app posts each one once and answers
 * (`notice-answer`); `post` waits a few seconds for that answer, so the result can say the Mac showed it.
 */
export class MacNotices {
  #notices: Notice[] = [];
  readonly #waiting = new Map<string, (answer: MacAnswer | undefined) => void>();

  constructor(private readonly deps: {
    /** The sessions file again, now. */
    publish(): void;
    appRunning(): boolean;
    now(): number;
    answerMs?: number;
    keepMs?: number;
  }) {}

  /** The notices the app should still post: the last few minutes', newest last. */
  list(): Notice[] {
    const now = this.deps.now();
    this.#notices = this.#notices.filter((one) => now - one.at < (this.deps.keepMs ?? MAC_NOTICE_KEEP_MS)).slice(-20);
    return [...this.#notices];
  }

  async post(notice: Notice): Promise<MacOutcome> {
    const running = this.deps.appRunning();
    this.#notices.push(notice);
    this.deps.publish();
    if (!running) {
      return { outcome: "app-not-running", detail: "conch's Mac app isn't running, so the Mac showed nothing (it will if the app opens in the next few minutes)" };
    }
    const answer = await new Promise<MacAnswer | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(notice.id);
        resolve(undefined);
      }, this.deps.answerMs ?? MAC_NOTICE_ANSWER_MS);
      this.#waiting.set(notice.id, (said) => {
        clearTimeout(timer);
        resolve(said);
      });
    });
    if (!answer) return { outcome: "unconfirmed", detail: "conch's Mac app was given it but hasn't said it showed it" };
    // Answered: it won't be posted again, so it needn't stay on the file.
    this.#notices = this.#notices.filter((one) => one.id !== notice.id);
    this.deps.publish();
    switch (answer.outcome) {
      case "shown": return { outcome: "shown", detail: "shown on the Mac" };
      case "asking": return { outcome: "asking", detail: "the Mac is asking whether conch may show notifications; it shows this one once allowed" };
      case "off": return { outcome: "notifications-off", detail: "notifications are off for conch on the Mac (System Settings › Notifications › conch)" };
      default: return { outcome: "failed", detail: `the Mac couldn't show it${answer.error ? `: ${answer.error}` : ""}` };
    }
  }

  /** The app's answer. False for a notice nobody is waiting on (late, or answered twice). */
  answer(answer: MacAnswer): boolean {
    const waiting = this.#waiting.get(answer.id);
    if (!waiting) {
      // A late "shown" still takes it off the file.
      const before = this.#notices.length;
      this.#notices = this.#notices.filter((one) => one.id !== answer.id);
      if (this.#notices.length !== before) this.deps.publish();
      return false;
    }
    this.#waiting.delete(answer.id);
    waiting(answer);
    return true;
  }
}

/** The sessions file with the Mac's notices on it, as `withCaptureRequests` puts captures. */
export function withNotices<State extends object>(state: State, notices: readonly Notice[]): State & { notices?: Notice[] } {
  return notices.length ? { ...state, notices: [...notices] } : state;
}

// MARK: - The phone, and both

export interface PushStatus {
  kind: "push-status";
  /** The key's ids, never the key. */
  key?: PushKeyRecord;
  devices: Array<{
    device: string;
    environment: ApnsEnvironment;
    alerts: boolean;
    registeredAt: number;
    token: string;
    lastSentAt?: number;
    lastError?: string;
  }>;
  /** What last stopped a push that wasn't one phone's: the key unreadable, or refused. */
  lastError?: string;
  lastSentAt?: number;
  /** A test's result, for `push-setup` `test`. */
  test?: NotifyResult;
}

export interface NotifierDependencies {
  /** The ids of the key set up, if any (push-key.ts `readPushKeyRecord`). */
  keyRecord(): PushKeyRecord | undefined;
  /** The key itself, read from the Keychain (push-key.ts `loadPushKey`). */
  loadKey(): Promise<ApnsCredentials | { error: string } | undefined>;
  devices: PushDevices;
  mac: MacNotices;
  send?(request: ApnsRequest): Promise<ApnsResponse>;
  /** Where each environment's APNs is; Apple's own outside tests. */
  origins?: Readonly<Record<ApnsEnvironment, string>>;
  log(line: string): void;
  now(): number;
}

export class Notifier {
  readonly #deps: NotifierDependencies;
  readonly #limiter: NoticeLimiter;
  readonly #tokens = new ApnsTokenCache();
  #credentials: { for: string; value: ApnsCredentials } | undefined;
  #lastError: string | undefined;
  #lastSentAt: number | undefined;

  constructor(deps: NotifierDependencies, limiter = new NoticeLimiter()) {
    this.#deps = deps;
    this.#limiter = limiter;
  }

  /** Forget the key read from the Keychain, after it's set, replaced or removed. */
  keyChanged(): void {
    this.#credentials = undefined;
    this.#tokens.forget();
    this.#lastError = undefined;
  }

  status(): PushStatus {
    const key = this.#deps.keyRecord();
    return {
      kind: "push-status",
      ...(key ? { key } : {}),
      devices: this.#deps.devices.list().map((one) => ({
        device: one.device, environment: one.environment, alerts: one.alerts, registeredAt: one.registeredAt, token: tokenTail(one.token),
        ...(one.lastSentAt ? { lastSentAt: one.lastSentAt } : {}), ...(one.lastError ? { lastError: one.lastError } : {}),
      })),
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
      ...(this.#lastSentAt ? { lastSentAt: this.#lastSentAt } : {}),
    };
  }

  /** Whether a phone could be pushed to now: a key, and a phone that turned notifications on. What `/push` tells the phone. */
  ready(): boolean {
    return Boolean(this.#deps.keyRecord());
  }

  /**
   * Tell the user something. `limitKey` holds an agent to `NoticeLimiter`; conch's own alerts (no key) aren't held,
   * having their own once-only rules. `mac: false` is Settings' test, which is the phone's.
   */
  async notify(input: {
    title: string;
    body: string;
    sessionId?: string;
    link?: string;
    target?: NoticeTarget;
    source: Notice["source"];
    limitKey?: string;
    mac?: boolean;
  }): Promise<NotifyResult> {
    // An agent's are checked before they get here (`decodeNoticeRequest`); conch's own are its own words, kept to size.
    const title = [...noticeText(input.title)].slice(0, NOTICE_TITLE_MAX).join("");
    const body = [...noticeText(input.body)].slice(0, NOTICE_BODY_MAX).join("");
    const now = this.#deps.now();
    const words = NoticeLimiter.words(title, body);
    if (input.limitKey !== undefined) {
      const allowed = this.#limiter.check(input.limitKey, words, now);
      if (!allowed.ok) {
        return allowed.why === "duplicate"
          ? { kind: "notify-result", outcome: "duplicate", said: "Not sent: the same words already went out within the hour, so the user has them." }
          : {
            kind: "notify-result", outcome: "rate-limited",
            said: `Not sent: this session has sent ${NOTICES_PER_HOUR} notices in the last hour, which is the most it may. The next can go in about ${Math.max(1, Math.ceil((allowed.retryInMs ?? 0) / 60_000))} min; put it in your reply instead.`,
          };
      }
    }
    const notice: Notice = {
      id: randomUUID(), title, body, at: now, source: input.source,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.link ? { link: input.link } : {}),
      ...(input.target ? { target: input.target } : {}),
    };
    const [phone, mac] = await Promise.all([
      this.#push(notice),
      input.mac === false ? Promise.resolve<MacOutcome>({ outcome: "skipped", detail: "a test of the phone" }) : this.#deps.mac.post(notice),
    ]);
    const reached = phone.outcome === "pushed" || mac.outcome === "shown" || mac.outcome === "asking" || mac.outcome === "unconfirmed";
    if (reached && input.limitKey !== undefined) this.#limiter.record(input.limitKey, words, now);
    this.#deps.log(`notice "${title}" (${input.source}${input.sessionId ? `, ${input.sessionId.slice(0, 8)}` : ""}): phone ${phone.outcome} · Mac ${mac.outcome}`);
    return { kind: "notify-result", outcome: reached ? "sent" : "not-sent", notice: notice.id, phone, mac, said: describeDelivery(phone, mac) };
  }

  async #credentialsNow(): Promise<ApnsCredentials | { error: string } | undefined> {
    const record = this.#deps.keyRecord();
    if (!record) return undefined;
    const stamp = `${record.keyId}:${record.teamId}:${record.addedAt}`;
    if (this.#credentials?.for === stamp) return this.#credentials.value;
    const loaded = await this.#deps.loadKey();
    if (loaded && !("error" in loaded)) this.#credentials = { for: stamp, value: loaded };
    return loaded;
  }

  async #push(notice: Notice): Promise<PhoneOutcome> {
    const devices = this.#deps.devices.list();
    const credentials = await this.#credentialsNow();
    if (!credentials) {
      return {
        outcome: "not-set-up",
        detail: devices.length
          ? "push isn't set up on this Mac: add an APNs key in conch's Settings › Phone app"
          : "push isn't set up: add an APNs key in conch's Settings › Phone app, and turn on notifications in conch on the iPhone",
      };
    }
    if ("error" in credentials) {
      this.#lastError = credentials.error;
      return { outcome: "failed", detail: credentials.error };
    }
    if (!devices.length) return { outcome: "no-phone", detail: "no iPhone has turned on conch's notifications yet (conch on the iPhone › Settings › Notifications)" };
    const outcomes: DeviceOutcome[] = [];
    for (const device of devices) outcomes.push(await this.#pushTo(device, notice, credentials));
    const pushed = outcomes.filter((one) => one.outcome === "pushed");
    if (pushed.length) {
      this.#lastSentAt = notice.at;
      const missed = outcomes.filter((one) => one.outcome !== "pushed");
      return {
        outcome: "pushed",
        detail: `pushed to ${names(pushed)}${missed.length ? `; not to ${missed.map(describeDevice).join("; ")}` : ""}`,
        devices: outcomes,
      };
    }
    if (outcomes.every((one) => one.outcome === "alerts-off")) {
      return { outcome: "no-phone", detail: `notifications are off for conch on ${names(outcomes)} (iPhone Settings › Notifications › conch)`, devices: outcomes };
    }
    return { outcome: "failed", detail: outcomes.map(describeDevice).join("; "), devices: outcomes };
  }

  async #pushTo(device: PushDevice, notice: Notice, credentials: ApnsCredentials): Promise<DeviceOutcome> {
    if (!device.alerts) return { device: device.device, outcome: "alerts-off" };
    const send = this.#deps.send ?? ((request: ApnsRequest) => sendApns(request));
    const origins = this.#deps.origins ?? APNS_ORIGINS;
    const attempt = (environment: ApnsEnvironment) => send({
      origin: origins[environment],
      deviceToken: device.token,
      topic: device.topic,
      jwt: this.#tokens.token(credentials, this.#deps.now()),
      payload: apnsPayload(notice),
      expiration: Math.floor(this.#deps.now() / 1000) + PUSH_EXPIRY_S,
    });
    let response: ApnsResponse;
    let environment = device.environment;
    try {
      response = await attempt(environment);
      // Apple's token is an hour's; one it says is too old is made again, once.
      if (response.reason === "ExpiredProviderToken") {
        this.#tokens.forget();
        response = await attempt(environment);
      }
      // A token is one environment's: a build signed for the other answers BadDeviceToken here. Tried there once
      // before the device is forgotten, and kept there if Apple takes it.
      if (response.reason === "BadDeviceToken") {
        const other: ApnsEnvironment = environment === "production" ? "development" : "production";
        const retried = await attempt(other);
        if (apnsVerdict(retried) !== "gone") {
          this.#deps.log(`push: ${device.device} (${tokenTail(device.token)}) takes ${other} pushes, not ${environment}`);
          response = retried;
          environment = other;
          this.#deps.devices.update(device.install, { environment: other });
        }
      }
    } catch (error) {
      const said = `couldn't reach Apple's push service: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
      this.#deps.devices.update(device.install, { error: said });
      return { device: device.device, outcome: "failed", error: said };
    }
    const verdict = apnsVerdict(response);
    if (verdict === "sent") {
      this.#lastError = undefined;
      this.#deps.devices.update(device.install, { sentAt: this.#deps.now(), error: null });
      return { device: device.device, outcome: "pushed" };
    }
    const said = describeApnsRefusal(response);
    if (verdict === "gone") {
      this.#deps.devices.forget(device.install);
      this.#deps.log(`push: forgot ${device.device}'s token (${tokenTail(device.token)}): ${said}`);
      return { device: device.device, outcome: "gone", error: said };
    }
    if (verdict === "key") this.#lastError = said;
    this.#deps.devices.update(device.install, { error: said });
    return { device: device.device, outcome: "failed", error: said };
  }
}

const names = (devices: readonly DeviceOutcome[]): string => {
  const unique = [...new Set(devices.map((one) => one.device))];
  return unique.length === devices.length ? unique.join(" and ") : `${devices.length} phones`;
};

function describeDevice(device: DeviceOutcome): string {
  switch (device.outcome) {
    case "alerts-off": return `${device.device} (notifications are off for conch there)`;
    case "gone": return `${device.device} (${device.error ?? "its token is gone"}; conch forgot it until it registers again)`;
    default: return `${device.device} (${device.error ?? "failed"})`;
  }
}

/** One sentence from both outcomes: where it went, and why not elsewhere. */
export function describeDelivery(phone: PhoneOutcome, mac: MacOutcome): string {
  const phoneSaid = phone.outcome === "pushed" ? `Pushed to the phone (${phone.detail.replace(/^pushed to /, "")})` : null;
  const macSaid = mac.outcome === "shown" ? "shown on the Mac" : null;
  const reached = [phoneSaid, macSaid].filter(Boolean).join(" and ");
  const missed = [
    phone.outcome !== "pushed" && phone.outcome !== "skipped" ? `phone: ${phone.detail}` : null,
    mac.outcome !== "shown" && mac.outcome !== "skipped" ? `Mac: ${mac.detail}` : null,
  ].filter(Boolean).join("; ");
  if (!reached) return `Not delivered anywhere yet. ${missed ? `${missed[0]!.toUpperCase()}${missed.slice(1)}.` : ""}`.trim();
  const first = `${reached[0]!.toUpperCase()}${reached.slice(1)}.`;
  return missed ? `${first} Not elsewhere: ${missed}.` : first;
}
