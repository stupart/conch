import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallerBinding } from "../src/caller-session.ts";
import { createControlServer, validateSocketTurnEvent, type ControlServer } from "../src/control-server.ts";
import type { TurnEvent } from "../src/hook.ts";
import { forwardToDaemonSocket, isMacAppOnlyRequest } from "../src/phone-bridge.ts";
import {
  PEER_PAIR_POLICY,
  createPeerMessenger,
  decodePeerMessageRequest,
  fileJournal,
  memoryJournal,
  resolvePeerTarget,
  type PeerMessageReply,
  type PeerMessageSession,
  type PeerMessengerDeps,
} from "../src/peer-message-send.ts";
import { receivedPeerMessage } from "../src/peer-messages.ts";
import type { SessionInfo } from "../src/sessions.ts";

// `conch message` (2026-11-12): one session's message into another's prompt, Codex included, through the inject path.
const sessions: PeerMessageSession[] = [
  { sessionId: "s-harbor", label: "harbor", name: "harbor", cwd: "/Users/example/harbor", pid: 4242 },
  { sessionId: "s-lantern", label: "lantern", cwd: "/Users/example/lamp", pid: 5151 },
  { sessionId: "s-tide-1", label: "tidepool", cwd: "/Users/example/tide", pid: 6161 },
  { sessionId: "s-tide-2", label: "tidepool", cwd: "/Users/example/tide", pid: 6262 },
  { sessionId: "agent-a0123456789abcdef", label: "Flaky test hunt", parentSessionId: "s-harbor" },
];
const verified = (sessionId: string): CallerBinding => ({ status: "verified", session: { sessionId } as SessionInfo });

function messenger(over: Partial<PeerMessengerDeps> & { callerIs?: string; outcome?: unknown } = {}) {
  const delivered: TurnEvent[] = [];
  const logs: string[] = [];
  let clock = 1_800_000_000_000;
  let ids = 0;
  const journal = over.journal ?? memoryJournal();
  const send = createPeerMessenger({
    caller: async () => verified(over.callerIs ?? "s-harbor"),
    sessions: () => sessions,
    deliver: async (event) => { delivered.push(event); return over.outcome ?? true; },
    autoSubmit: () => true,
    journal,
    log: (line) => void logs.push(line),
    now: () => clock,
    newId: () => `0000000000${String(++ids).padStart(2, "0")}`,
    ...over,
  }).send;
  return {
    send: (request: Partial<Parameters<typeof send>[0]>) => send({ kind: "peer-message", callerPid: 999, text: "Is port 5173 free?", ...request }),
    delivered, logs, journal, tick: (ms: number) => { clock += ms; },
  };
}

const refusal = (reply: PeerMessageReply) => (reply.kind === "peer-message-refused" ? reply.code : "sent");

describe("who a message may go to", () => {
  test("a session named exactly: its id, its label, its registry name, its folder", () => {
    for (const name of ["s-lantern", "LANTERN", "lamp"]) {
      expect(resolvePeerTarget(name, sessions)).toEqual({ session: sessions[1]! });
    }
    expect(resolvePeerTarget("harbor", sessions)).toEqual({ session: sessions[0]! });
  });

  test("never one of two, and never part of a name", () => {
    expect(resolvePeerTarget("tidepool", sessions)).toMatchObject({ code: "ambiguous" });
    expect((resolvePeerTarget("tidepool", sessions) as { error: string }).error).toContain("s-tide-1 (\"tidepool\")");
    expect(resolvePeerTarget("lant", sessions)).toMatchObject({ code: "partial-name" });
    const none = resolvePeerTarget("nowhere", sessions) as { code: string; error: string };
    expect(none.code).toBe("no-such-session");
    expect(none.error).toContain("\"harbor\", \"lantern\"");
    expect(none.error).not.toContain("Flaky test hunt");
  });
});

describe("conch message, sent", () => {
  test("framed with who it is from and how to answer, delivered as conch's own peer inject", async () => {
    const m = messenger();
    const reply = await m.send({ to: "lantern" });
    expect(reply).toEqual({ kind: "peer-message-sent", msgId: "000000000001", session: "s-lantern", label: "lantern" });
    expect(m.delivered).toHaveLength(1);
    const event = m.delivered[0]!;
    expect(event).toMatchObject({ type: "inject", sessionId: "s-lantern", label: "lantern", peer: true });
    expect(receivedPeerMessage(event.announce)).toEqual({
      body: "Is port 5173 free?",
      peer: { direction: "received", name: "harbor", via: "conch", session: "s-harbor", msgId: "000000000001" },
    });
    expect(m.journal.find("000000000001")).toMatchObject({ from: "s-harbor", to: "s-lantern", fromLabel: "harbor", toLabel: "lantern" });
    // Who to whom, never the words.
    expect(m.logs.join("\n")).not.toContain("5173");
  });

  test("a reply goes back to whoever sent the message it names; the sender may follow up its own", async () => {
    const m = messenger();
    await m.send({ to: "lantern" });
    const back = messenger({ callerIs: "s-lantern", journal: m.journal });
    expect(await back.send({ replyTo: "000000000001", text: "Free." })).toMatchObject({ kind: "peer-message-sent", session: "s-harbor" });
    expect(receivedPeerMessage(back.delivered[0]!.announce)?.peer).toMatchObject({ name: "lantern", replyTo: "000000000001" });
    expect(await m.send({ replyTo: "000000000001", text: "And 5174?" })).toMatchObject({ kind: "peer-message-sent", session: "s-lantern" });
  });

  test("a reply to a message between two other sessions, or one conch never delivered, is refused", async () => {
    const m = messenger();
    await m.send({ to: "lantern" });
    const third = messenger({ callerIs: "s-tide-1", journal: m.journal });
    expect(refusal(await third.send({ replyTo: "000000000001" }))).toBe("not-yours");
    const unknown = await m.send({ replyTo: "ffffffffffff" });
    expect(refusal(unknown)).toBe("unknown-message");
    expect((unknown as { error: string }).error).toContain("SendMessage");
    expect(third.delivered).toEqual([]);
  });

  test("with --wait, the target's reply cursor from before delivery comes back", async () => {
    const m = messenger({ replyCursor: async () => ({ transcriptPath: "/t/lantern.jsonl", cursor: "t1.before" }) });
    expect(await m.send({ to: "lantern", wait: true })).toMatchObject({ transcriptPath: "/t/lantern.jsonl", cursor: "t1.before" });
  });
});

describe("conch message, refused, and nothing typed", () => {
  test("a caller conch can't name, itself, a subagent, auto-submit off", async () => {
    const unverified = messenger({ caller: async () => ({ status: "unverified", reason: "no live session conch knows started pid 999" }) });
    expect(refusal(await unverified.send({ to: "lantern" }))).toBe("unverified-caller");
    const stranger = messenger({ callerIs: "s-unknown" });
    expect(refusal(await stranger.send({ to: "lantern" }))).toBe("unverified-caller");
    const m = messenger();
    expect(refusal(await m.send({ to: "harbor" }))).toBe("self");
    expect(refusal(await m.send({ to: "agent-a0123456789abcdef" }))).toBe("not-addressable");
    expect(refusal(await m.send({ to: "tidepool" }))).toBe("ambiguous");
    expect(refusal(await m.send({ to: "lant" }))).toBe("partial-name");
    const off = messenger({ autoSubmit: () => false });
    expect(refusal(await off.send({ to: "lantern" }))).toBe("auto-submit-off");
    expect([...unverified.delivered, ...stranger.delivered, ...m.delivered, ...off.delivered]).toEqual([]);
  });

  test("a dialog open, or a window it would have to raise: the inject path's reason, as a sentence", async () => {
    const waiting = messenger({ outcome: { delivered: false, reason: "session-awaiting-permission" } });
    const reply = await waiting.send({ to: "lantern" });
    expect(reply).toMatchObject({ kind: "peer-message-refused", code: "not-delivered", reason: "session-awaiting-permission" });
    expect((reply as { error: string }).error).toContain("permission prompt");
    expect(waiting.journal.find("000000000001")).toBeUndefined();
    const raise = await messenger({ outcome: { delivered: false, reason: "would-take-focus" } }).send({ to: "lantern" });
    expect((raise as { error: string }).error).toContain("SendMessage");
  });

  test("two agents going back and forth stop at the pair's limit, then wait out a cool-down", async () => {
    const m = messenger();
    for (let index = 0; index < PEER_PAIR_POLICY.limit; index += 1) {
      expect(refusal(await m.send({ to: "lantern" }))).toBe("sent");
    }
    const stopped = await m.send({ to: "lantern" });
    expect(stopped).toMatchObject({ kind: "peer-message-refused", code: "rate-limited" });
    expect((stopped as { retryAt: number }).retryAt).toBeGreaterThan(0);
    expect(m.delivered).toHaveLength(PEER_PAIR_POLICY.limit);
    // Another session is still reachable; the same one is again after the cool-down.
    const otherTarget = messenger({ journal: m.journal });
    expect(refusal(await otherTarget.send({ to: "lamp" }))).toBe("sent");
    m.tick(PEER_PAIR_POLICY.cooldownsMs[0]! + 1);
    expect(refusal(await m.send({ to: "lantern" }))).toBe("sent");
  });
});

describe("the request, as the control server reads it", () => {
  test("well formed, or said what is wrong", () => {
    expect(decodePeerMessageRequest({ kind: "inject" })).toBeNull();
    expect(decodePeerMessageRequest({ kind: "peer-message", callerPid: 1, to: "x", text: "hi" })).toEqual({ error: "callerPid must be the calling process's pid" });
    expect(decodePeerMessageRequest({ kind: "peer-message", callerPid: 50, text: "hi" })).toEqual({ error: "name the session to message, or the message to reply to" });
    expect(decodePeerMessageRequest({ kind: "peer-message", callerPid: 50, to: "x", text: "   " })).toEqual({ error: "the message is empty" });
    expect(decodePeerMessageRequest({ kind: "peer-message", callerPid: 50, replyTo: "no spaces allowed", text: "hi" })).toEqual({ error: "replyTo is a message id" });
    expect(decodePeerMessageRequest({ kind: "peer-message", callerPid: 50, to: "x", text: "a".repeat(16_001) })).toMatchObject({ error: expect.stringContaining("the most is 16000") });
    expect(decodePeerMessageRequest({ kind: "peer-message", callerPid: 50, to: " x ", text: "hi", wait: true }))
      .toEqual({ kind: "peer-message", callerPid: 50, to: "x", text: "hi", wait: true });
  });

  test("a socket's inject can't claim to be one, and a phone can't send one", () => {
    expect(validateSocketTurnEvent({ type: "inject", sessionId: "s", label: "l", announce: "hi", peer: true }))
      .toEqual({ ok: false, err: "peer is set by conch message, never by a client" });
    expect(isMacAppOnlyRequest({ kind: "peer-message", callerPid: 50, to: "x", text: "hi" })).toBe(true);
  });
});

describe("over the control socket", () => {
  const roots: string[] = [];
  const servers: ControlServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function serve(peerMessages?: Parameters<typeof createControlServer>[0]["peerMessages"]) {
    const root = mkdtempSync("/tmp/conch-peer-");
    roots.push(root);
    const socketPath = join(root, "control.sock");
    const server = createControlServer({
      socketPath,
      ownerDeviceId: "this-mac",
      log: () => {},
      sessions: { resolve: (value) => value, current: () => ({ published: false }) },
      application: {
        configuration: () => ({ kind: "config-error", error: "stub" }),
        session: () => ({ kind: "session-error", error: "stub" }),
        runtime: () => ({ kind: "app-error-ack" }),
        turn: () => {},
        device: () => ({ kind: "ack" }),
      },
      ...(peerMessages ? { peerMessages } : {}),
    });
    servers.push(server);
    expect(await server.start()).toBe(true);
    return (body: unknown) => forwardToDaemonSocket(socketPath, JSON.stringify(body), 2_000).then((line) => JSON.parse(line));
  }

  test("answered with the messenger's reply once it is delivered", async () => {
    const m = messenger();
    const request = await serve({ send: (message) => createPeerMessenger({
      caller: async () => verified("s-harbor"), sessions: () => sessions, deliver: async (event) => { m.delivered.push(event); return true; },
      autoSubmit: () => true, journal: memoryJournal(), log: () => {}, newId: () => "abcdefabcdef",
    }).send(message) });
    expect(await request({ kind: "peer-message", callerPid: 999, to: "lantern", text: "hi" }))
      .toEqual({ kind: "peer-message-sent", msgId: "abcdefabcdef", session: "s-lantern", label: "lantern" });
    expect(m.delivered).toHaveLength(1);
  });

  test("a malformed request, and a conch without the messenger, say so", async () => {
    const request = await serve();
    expect(await request({ kind: "peer-message", callerPid: 999, text: "hi" })).toMatchObject({ kind: "peer-message-refused", code: "invalid" });
    expect(await request({ kind: "peer-message", callerPid: 999, to: "x", text: "hi" })).toMatchObject({ kind: "peer-message-refused", code: "unsupported" });
  });
});

describe("the journal", () => {
  test("who sent which message to whom survives a restart, and never holds the words", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-peer-journal-"));
    try {
      const path = join(dir, "peer-messages.jsonl");
      fileJournal(path).add({ msgId: "m1", from: "a", fromLabel: "A", to: "b", toLabel: "B", at: 1 });
      expect(fileJournal(path).find("m1")).toEqual({ msgId: "m1", from: "a", fromLabel: "A", to: "b", toLabel: "B", at: 1 });
      expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
