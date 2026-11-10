import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApnsCredentials } from "../src/apns.ts";
import {
  decodeNoticeRequest,
  describeDelivery,
  MacNotices,
  NoticeLimiter,
  NOTICES_PER_HOUR,
  Notifier,
  withNotices,
  type Notice,
} from "../src/notify-user.ts";
import { PushDevices, type PushRegistration } from "../src/push-devices.ts";
import type { PushKeyRecord } from "../src/push-key.ts";
import { mockApns } from "./apns-mock.ts";

// Telling the user something (notify-user.ts, 2026-11-10): the limit an agent is held to, the Mac's half through its
// app, the phone's through a stand-in for Apple, and the sentence the agent is given. Nothing reaches Apple.

const roots: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const server of servers.splice(0)) await server.close();
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "conch-notify-"));
  roots.push(root);
  return root;
}

const HOUR = 60 * 60_000;

describe("an agent's limit", () => {
  test(`${NOTICES_PER_HOUR} an hour per session; the hour after the oldest, another`, () => {
    const limiter = new NoticeLimiter();
    for (let index = 0; index < NOTICES_PER_HOUR; index++) {
      expect(limiter.check("s1", `words ${index}`, index * 1_000)).toEqual({ ok: true });
      limiter.record("s1", `words ${index}`, index * 1_000);
    }
    const refused = limiter.check("s1", "one more", 10_000);
    expect(refused).toEqual({ ok: false, why: "rate-limited", retryInMs: HOUR - 10_000 });
    // Another session's are its own.
    expect(limiter.check("s2", "one more", 10_000)).toEqual({ ok: true });
    expect(limiter.check("s1", "one more", HOUR + 1)).toEqual({ ok: true });
  });

  test("the same words (any case, any spacing) inside the hour are a repeat; after it, they may go again", () => {
    const limiter = new NoticeLimiter();
    const words = NoticeLimiter.words("Deploy", "It's   live.");
    limiter.record("s1", words, 0);
    expect(limiter.check("s1", NoticeLimiter.words("deploy", " it's live. "), 30 * 60_000)).toEqual({ ok: false, why: "duplicate" });
    expect(limiter.check("s1", words, HOUR + 1)).toEqual({ ok: true });
  });
});

describe("the requests", () => {
  test("an agent's notice: words tidied, a link checked, the asking session named", () => {
    expect(decodeNoticeRequest({ kind: "notify-user", title: " Deploy ", body: "It's\n live.", from: "s1", sessionId: "s1", link: "https://example.com/pr/1" }))
      .toEqual({ ok: true, value: { kind: "notify-user", title: "Deploy", body: "It's live.", from: "s1", sessionId: "s1", link: "https://example.com/pr/1" } });
    for (const bad of [
      { title: "", body: "x", from: "s1" },
      { title: "x".repeat(81), body: "x", from: "s1" },
      { title: "x", body: "x".repeat(281), from: "s1" },
      { title: "x", body: "x", from: "" },
      { title: "x", body: "x", from: "s1", link: "file:///etc/passwd" },
      { title: "x", body: "x", from: "s1", link: "javascript:alert(1)" },
      { title: "x", body: "x", from: "s1", link: "https://user:secret@example.com" },
      { title: "x", body: "x", from: "s1", sessionId: 7 },
    ]) {
      expect(decodeNoticeRequest({ kind: "notify-user", ...bad })?.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  test("push setup: status, remove and test carry no key; set carries the three parts; the Mac app's answers", () => {
    expect(decodeNoticeRequest({ kind: "push-setup", action: "status" })).toEqual({ ok: true, value: { kind: "push-setup", action: "status" } });
    expect(decodeNoticeRequest({ kind: "push-setup", action: "test", key: "x" })?.ok).toBe(false);
    expect(decodeNoticeRequest({ kind: "push-setup", action: "set", keyId: "A", teamId: "B" })?.ok).toBe(false);
    expect(decodeNoticeRequest({ kind: "push-setup", action: "wipe" })?.ok).toBe(false);
    expect(decodeNoticeRequest({ kind: "notice-answer", id: "0f3c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b", outcome: "shown" })?.ok).toBe(true);
    expect(decodeNoticeRequest({ kind: "notice-answer", id: "nope", outcome: "shown" })?.ok).toBe(false);
    // Anything else isn't a notice request at all.
    expect(decodeNoticeRequest({ kind: "setup-status" })).toBeNull();
    expect(decodeNoticeRequest("push-setup")).toBeNull();
  });
});

const notice = (overrides: Partial<Notice> = {}): Notice => ({
  id: crypto.randomUUID(), title: "Deploy", body: "It's live.", at: 0, source: "agent", ...overrides,
});

describe("the Mac's half", () => {
  test("on the sessions file until the app answers; shown is said, and it leaves the file", async () => {
    let now = 1_000;
    let published = 0;
    const mac = new MacNotices({ publish: () => { published++; }, appRunning: () => true, now: () => now, answerMs: 1_000 });
    const one = notice({ at: now });
    const posted = mac.post(one);
    expect(mac.list()).toEqual([one]);
    expect(withNotices({ v: 1 }, mac.list())).toEqual({ v: 1, notices: [one] });
    expect(mac.answer({ kind: "notice-answer", id: one.id, outcome: "shown" })).toBe(true);
    expect(await posted).toEqual({ outcome: "shown", detail: "shown on the Mac" });
    expect(mac.list()).toEqual([]);
    expect(withNotices({ v: 1 }, [])).toEqual({ v: 1 });
    expect(published).toBe(2);
    // Answered twice: the second is nobody's.
    expect(mac.answer({ kind: "notice-answer", id: one.id, outcome: "shown" })).toBe(false);
  });

  test("notifications off, asking, no answer, and no app: each said as it is", async () => {
    const mac = new MacNotices({ publish: () => {}, appRunning: () => true, now: () => 0, answerMs: 50 });
    const off = notice();
    const offPosted = mac.post(off);
    mac.answer({ kind: "notice-answer", id: off.id, outcome: "off" });
    expect((await offPosted).outcome).toBe("notifications-off");
    const asking = notice();
    const askingPosted = mac.post(asking);
    mac.answer({ kind: "notice-answer", id: asking.id, outcome: "asking" });
    expect((await askingPosted).outcome).toBe("asking");
    expect((await mac.post(notice())).outcome).toBe("unconfirmed");
    const closed = new MacNotices({ publish: () => {}, appRunning: () => false, now: () => 0 });
    expect((await closed.post(notice())).outcome).toBe("app-not-running");
    // Still on the file, for an app that opens in the next few minutes.
    expect(closed.list()).toHaveLength(1);
  });

  test("gone from the file after five minutes", () => {
    let now = 0;
    const mac = new MacNotices({ publish: () => {}, appRunning: () => false, now: () => now });
    void mac.post(notice({ at: 0 }));
    now = 5 * 60_000 - 1;
    expect(mac.list()).toHaveLength(1);
    now = 5 * 60_000;
    expect(mac.list()).toHaveLength(0);
  });
});

function credentials(): ApnsCredentials {
  return { teamId: "TEAM123456", keyId: "KEY1234567", key: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey };
}

const phone = (overrides: Partial<PushRegistration> = {}): PushRegistration => ({
  install: "11111111-2222-3333-4444-555555555555", device: "iPhone", token: "ab".repeat(32),
  environment: "production", topic: "com.example.conch.ios", alerts: true, ...overrides,
});

async function harness(options: {
  key?: "none" | "unreadable";
  phones?: PushRegistration[];
  macAnswer?: "shown" | "off" | "none";
  macRunning?: boolean;
  apple?: Parameters<typeof mockApns>[0];
  /** Apple's sandbox, when a test needs it to answer differently. */
  sandbox?: Parameters<typeof mockApns>[0];
} = {}) {
  const apple = await mockApns(options.apple ?? (() => ({ status: 200 })));
  servers.push(apple);
  const sandbox = await mockApns(options.sandbox ?? (() => ({ status: 200 })));
  servers.push(sandbox);
  const devices = new PushDevices(join(scratch(), "push-devices.json"));
  for (const one of options.phones ?? []) devices.register(one, 1);
  const lines: string[] = [];
  const record: PushKeyRecord | undefined = options.key === "none" ? undefined : { keyId: "KEY1234567", teamId: "TEAM123456", addedAt: 1 };
  let loads = 0;
  const key = credentials();
  const mac: MacNotices = new MacNotices({
    publish: () => {
      const outcome = options.macAnswer;
      if (outcome === "none") return;
      for (const one of mac.list()) queueMicrotask(() => mac.answer({ kind: "notice-answer", id: one.id, outcome: outcome ?? "shown" }));
    },
    appRunning: () => options.macRunning ?? true,
    now: () => 1_000,
    answerMs: 100,
  });
  const notifier = new Notifier({
    keyRecord: () => record,
    loadKey: async () => {
      loads++;
      return options.key === "unreadable" ? { error: "conch couldn't read the APNs key from the Keychain (security exited 51)." } : key;
    },
    devices,
    mac,
    origins: { production: apple.origin, development: sandbox.origin },
    log: (line) => lines.push(line),
    now: () => 1_800_000_000_000,
  });
  return { apple, sandbox, devices, notifier, lines, loads: () => loads };
}

describe("both at once", () => {
  test("pushed to the phone and shown on the Mac; the push is Apple's request for the device, signed with the key", async () => {
    const h = await harness({ phones: [phone()] });
    const result = await h.notifier.notify({ title: "Deploy", body: "It's live.", sessionId: "s1", source: "agent", limitKey: "s1" });
    expect(result).toMatchObject({ kind: "notify-result", outcome: "sent", phone: { outcome: "pushed" }, mac: { outcome: "shown" } });
    expect(result.said).toBe("Pushed to the phone (iPhone) and shown on the Mac.");
    expect(h.apple.seen).toHaveLength(1);
    const { headers, body } = h.apple.seen[0]!;
    expect(headers[":path"]).toBe(`/3/device/${"ab".repeat(32)}`);
    expect(headers["apns-topic"]).toBe("com.example.conch.ios");
    expect(String(headers.authorization)).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(body)).toMatchObject({ aps: { alert: { title: "Deploy", body: "It's live." } }, conch: { session: "s1", notice: result.notice } });
    expect(h.devices.list()[0]!.lastSentAt).toBe(1_800_000_000_000);
    expect(h.lines.join("\n")).toContain('notice "Deploy" (agent, s1): phone pushed · Mac shown');
    // The key is read once and kept.
    await h.notifier.notify({ title: "Deploy", body: "And the docs.", source: "agent" });
    expect(h.loads()).toBe(1);
  });

  test("no key: the Mac still shows it, and the agent is told push isn't set up and where to set it up", async () => {
    const h = await harness({ key: "none" });
    const result = await h.notifier.notify({ title: "Deploy", body: "It's live.", source: "agent", limitKey: "s1" });
    expect(result.outcome).toBe("sent");
    expect(result.phone?.outcome).toBe("not-set-up");
    expect(result.said).toBe("Shown on the Mac. Not elsewhere: phone: push isn't set up: add an APNs key in conch's Settings › Phone app, and turn on notifications in conch on the iPhone.");
    expect(h.apple.seen).toHaveLength(0);
  });

  test("a key but no phone, or a phone with notifications off: nothing goes to Apple, and the result says which", async () => {
    const none = await harness();
    expect((await none.notifier.notify({ title: "a", body: "b", source: "conch" })).phone?.outcome).toBe("no-phone");
    const off = await harness({ phones: [phone({ alerts: false })] });
    const result = await off.notifier.notify({ title: "a", body: "b", source: "conch" });
    expect(result.phone).toMatchObject({ outcome: "no-phone", detail: expect.stringContaining("notifications are off for conch on iPhone") });
    expect(off.apple.seen).toHaveLength(0);
  });

  test("an unreadable key, and nowhere it could go: not sent, said why, and not counted against the limit", async () => {
    const h = await harness({ key: "unreadable", phones: [phone()], macRunning: false });
    const first = await h.notifier.notify({ title: "a", body: "b", source: "agent", limitKey: "s1" });
    expect(first.outcome).toBe("not-sent");
    expect(first.said).toStartWith("Not delivered anywhere yet. Phone: conch couldn't read the APNs key");
    expect(h.notifier.status().lastError).toContain("couldn't read the APNs key");
    // The same words again aren't a repeat: none went anywhere.
    expect((await h.notifier.notify({ title: "a", body: "b", source: "agent", limitKey: "s1" })).outcome).toBe("not-sent");
  });

  test("a repeat and a fifth in the hour are refused before anything is sent; conch's own aren't held", async () => {
    const h = await harness({ phones: [phone()] });
    expect((await h.notifier.notify({ title: "a", body: "same", source: "agent", limitKey: "s1" })).outcome).toBe("sent");
    expect(await h.notifier.notify({ title: "a", body: "same", source: "agent", limitKey: "s1" })).toMatchObject({ outcome: "duplicate" });
    for (let index = 1; index < NOTICES_PER_HOUR; index++) await h.notifier.notify({ title: "a", body: `next ${index}`, source: "agent", limitKey: "s1" });
    const limited = await h.notifier.notify({ title: "a", body: "one too many", source: "agent", limitKey: "s1" });
    expect(limited.outcome).toBe("rate-limited");
    expect(limited.said).toContain(`has sent ${NOTICES_PER_HOUR} notices in the last hour`);
    expect(h.apple.seen).toHaveLength(NOTICES_PER_HOUR);
    expect((await h.notifier.notify({ title: "a", body: "same", source: "conch" })).outcome).toBe("sent");
  });

  test("a dead token (410) is forgotten; a key Apple refuses is said, and kept for Settings", async () => {
    const gone = await harness({ phones: [phone()], apple: () => ({ status: 410, body: { reason: "Unregistered" } }) });
    const result = await gone.notifier.notify({ title: "a", body: "b", source: "conch", mac: false });
    expect(result.phone?.devices).toEqual([{ device: "iPhone", outcome: "gone", error: expect.stringContaining("Unregistered") }]);
    expect(gone.devices.list()).toEqual([]);
    expect(gone.lines.join("\n")).toContain("push: forgot iPhone's token (…ababab)");

    const refused = await harness({ phones: [phone()], apple: () => ({ status: 403, body: { reason: "InvalidProviderToken" } }) });
    const said = await refused.notifier.notify({ title: "a", body: "b", source: "conch", mac: false });
    expect(said.outcome).toBe("not-sent");
    expect(said.phone?.detail).toContain("check the Key ID and Team ID");
    expect(refused.notifier.status().lastError).toContain("InvalidProviderToken");
    expect(refused.notifier.status().devices[0]).toMatchObject({ device: "iPhone", token: "…ababab", lastError: expect.stringContaining("InvalidProviderToken") });
  });

  test("a token of the other environment is tried there once, and kept there when Apple takes it", async () => {
    const h = await harness({ phones: [phone({ environment: "production" })], apple: () => ({ status: 400, body: { reason: "BadDeviceToken" } }) });
    const result = await h.notifier.notify({ title: "a", body: "b", source: "conch", mac: false });
    expect(result.phone?.outcome).toBe("pushed");
    expect(h.apple.seen).toHaveLength(1);
    expect(h.sandbox.seen).toHaveLength(1);
    expect(h.devices.list()[0]!.environment).toBe("development");
    expect(h.lines.join("\n")).toContain("takes development pushes, not production");
    // Refused in both: forgotten.
    const both = await harness({
      phones: [phone()],
      apple: () => ({ status: 400, body: { reason: "BadDeviceToken" } }),
      sandbox: () => ({ status: 400, body: { reason: "BadDeviceToken" } }),
    });
    expect((await both.notifier.notify({ title: "a", body: "b", source: "conch", mac: false })).phone?.devices?.[0]?.outcome).toBe("gone");
    expect(both.devices.list()).toEqual([]);
  });

  test("an expired provider token is made again and sent once more", async () => {
    let calls = 0;
    const h = await harness({ phones: [phone()], apple: () => (++calls === 1 ? { status: 403, body: { reason: "ExpiredProviderToken" } } : { status: 200 }) });
    expect((await h.notifier.notify({ title: "a", body: "b", source: "conch", mac: false })).phone?.outcome).toBe("pushed");
    expect(h.apple.seen).toHaveLength(2);
  });

  test("status: the key's ids and each phone, never a key or a whole token", async () => {
    const h = await harness({ phones: [phone()] });
    const status = h.notifier.status();
    expect(status).toEqual({
      kind: "push-status",
      key: { keyId: "KEY1234567", teamId: "TEAM123456", addedAt: 1 },
      devices: [{ device: "iPhone", environment: "production", alerts: true, registeredAt: 1, token: "…ababab" }],
    });
    expect(JSON.stringify(status)).not.toContain("ab".repeat(32));
  });
});

describe("the sentence", () => {
  test("where it went, then why not elsewhere", () => {
    expect(describeDelivery({ outcome: "pushed", detail: "pushed to iPhone" }, { outcome: "app-not-running", detail: "conch's Mac app isn't running" }))
      .toBe("Pushed to the phone (iPhone). Not elsewhere: Mac: conch's Mac app isn't running.");
    expect(describeDelivery({ outcome: "pushed", detail: "pushed to iPhone" }, { outcome: "skipped", detail: "" })).toBe("Pushed to the phone (iPhone).");
  });
});

describe("over the daemon's socket", () => {
  test("an agent's notify goes through a real control server and its answer comes back whole; a bad one is refused there", async () => {
    const { createControlServer } = await import("../src/control-server.ts");
    const { requestNotice } = await import("../src/notify-user.ts");
    // A short private path: a Unix socket's is capped near 104 bytes.
    const dir = mkdtempSync("/tmp/conch-notify-");
    roots.push(dir);
    const socketPath = join(dir, "c.sock");
    const h = await harness({ phones: [phone()] });
    const server = createControlServer({
      socketPath,
      ownerDeviceId: "this-mac",
      log: () => {},
      sessions: { resolve: (value) => value, current: () => ({ published: true, label: "a" }) },
      application: {
        configuration: () => ({ kind: "config-error", error: "stub" }),
        session: () => ({ kind: "session-error", error: "stub" }),
        runtime: () => ({ kind: "session-error", error: "stub" }),
        turn: () => {},
        device: () => ({ kind: "ack" }),
      },
      notices: async (request) => request.kind === "notify-user"
        ? h.notifier.notify({ title: request.title, body: request.body, source: "agent", limitKey: request.from, ...(request.sessionId ? { sessionId: request.sessionId } : {}) })
        : h.notifier.status(),
    });
    servers.push({ close: () => server.close() });
    expect(await server.start()).toBe(true);
    const sent = await requestNotice(socketPath, { kind: "notify-user", title: "Deploy", body: "It's live.", from: "s1", sessionId: "s1" });
    expect(sent).toMatchObject({ ok: true, reply: { kind: "notify-result", outcome: "sent", phone: { outcome: "pushed" }, mac: { outcome: "shown" } } });
    expect(h.apple.seen).toHaveLength(1);
    const refused = await requestNotice(socketPath, { kind: "notify-user", title: "x", body: "y".repeat(400), from: "s1" });
    expect(refused).toEqual({ ok: true, reply: { kind: "notice-error", error: "body must be 1–280 characters" } });
    expect(h.apple.seen).toHaveLength(1);
    expect(await requestNotice(join(dir, "nobody.sock"), { kind: "push-setup", action: "status" }, 500)).toMatchObject({ ok: false, reason: "daemon-down" });
  });
});
