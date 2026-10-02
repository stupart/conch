import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackgroundGuard,
  planRecovery,
  readServerListing,
  RECOVERY_TRIES,
  type BackgroundRecord,
  type BackgroundServer,
  type ServerReading,
} from "../src/background-recovery.ts";
import type { StartSessionRequest } from "../src/session-lifecycle.ts";
import { conchServerSessions, startBackgroundProcess } from "../src/background-sessions.ts";
import { conchTmux, paneTarget, resolveTmux } from "../src/tmux-binary.ts";
import { probeCommand } from "../src/probe.ts";

const NAME_A = "conch-1b0e4a59-962f-4823-bbff-c5024ba97a98";
const NAME_B = "conch-7d49548f-7a71-4910-a6b4-362d4306a53c";
const running = (panes: Array<[number, string]>): ServerReading => ({ state: "running", panes: new Map(panes) });
const gone: ServerReading = { state: "gone", panes: new Map() };
const unknown: ServerReading = { state: "unknown", panes: new Map() };
const request: StartSessionRequest = { backend: "claude", host: "background", resumeSessionId: "conv-a", claudeAccountId: "work", cwd: "/Users/t" };
const record = (name: string, conversationId: string, server: BackgroundServer = "conch"): BackgroundRecord => ({
  name, server, conversationId, label: conversationId, request: { ...request, resumeSessionId: conversationId }, seenAt: 0,
});
const servers = (conch: ServerReading, fallback: ServerReading = running([])) => ({ conch, default: fallback });

describe("what happens to a background session conch knew", () => {
  test("still on its server: nothing", () => {
    expect(planRecovery({ records: [record(NAME_A, "a")], servers: servers(running([[12, NAME_A]])),
      liveConversations: new Set(["a"]), attempts: new Map(), now: 0 })).toEqual({ resume: [], forget: [] });
  });

  test("gone while its server runs: it ended on purpose, and is forgotten, never brought back", () => {
    expect(planRecovery({ records: [record(NAME_A, "a")], servers: servers(running([])),
      liveConversations: new Set(), attempts: new Map(), now: 0 }))
      .toEqual({ resume: [], forget: [{ name: NAME_A, why: "ended on its own" }] });
  });

  test("its server gone: every session on it comes back", () => {
    const plan = planRecovery({ records: [record(NAME_A, "a"), record(NAME_B, "b")], servers: servers(gone),
      liveConversations: new Set(), attempts: new Map(), now: 0 });
    expect(plan.resume.map((r) => r.conversationId)).toEqual(["a", "b"]);
    expect(plan.forget).toEqual([]);
  });

  test("never while its conversation runs anywhere else: no second copy of a session", () => {
    const plan = planRecovery({ records: [record(NAME_A, "a"), record(NAME_B, "b")], servers: servers(gone),
      liveConversations: new Set(["b"]), attempts: new Map(), now: 0 });
    expect(plan.resume.map((r) => r.conversationId)).toEqual(["a"]);
    expect(plan.forget).toEqual([{ name: NAME_B, why: "it is running elsewhere" }]);
  });

  test("a server that could not be read decides nothing", () => {
    expect(planRecovery({ records: [record(NAME_A, "a")], servers: servers(unknown),
      liveConversations: new Set(), attempts: new Map(), now: 0 })).toEqual({ resume: [], forget: [] });
  });

  test("a few tries a day, then it is left alone", () => {
    const now = 10 * 60 * 60 * 1000;
    const attempts = new Map([["a", Array.from({ length: RECOVERY_TRIES }, (_, i) => now - i * 1000)]]);
    const plan = planRecovery({ records: [record(NAME_A, "a")], servers: servers(gone), liveConversations: new Set(), attempts, now });
    expect(plan.resume).toEqual([]);
    expect(plan.forget[0]?.why).toContain("already brought back");
    // A day later, the count starts over.
    expect(planRecovery({ records: [record(NAME_A, "a")], servers: servers(gone), liveConversations: new Set(), attempts,
      now: now + 25 * 60 * 60 * 1000 }).resume).toHaveLength(1);
  });

  test("the default server, where conch sets nothing: one session lost with it may have simply ended", () => {
    // tmux exits when its last session ends, so a default server holding one of conch's sessions vanishes on a
    // plain /exit. Two or more lost together is a server that was stopped (the 2026-10-02 outage: seven at once).
    expect(planRecovery({ records: [record(NAME_A, "a", "default")], servers: servers(running([]), gone),
      liveConversations: new Set(), attempts: new Map(), now: 0 }))
      .toEqual({ resume: [], forget: [{ name: NAME_A, why: "its server emptied" }] });
    expect(planRecovery({ records: [record(NAME_A, "a", "default"), record(NAME_B, "b", "default")], servers: servers(running([]), gone),
      liveConversations: new Set(), attempts: new Map(), now: 0 }).resume).toHaveLength(2);
  });
});

describe("reading a server", () => {
  test("its sessions, by pane pid; anything not conch's is left out", () => {
    const reading = readServerListing(0, `12 ${NAME_A}\n13 personal\n14 ${NAME_B}\n`, "");
    expect(reading).toEqual({ state: "running", panes: new Map([[12, NAME_A], [14, NAME_B]]) });
  });
  test("tmux's own words for no server are an answer; anything else is not", () => {
    expect(readServerListing(1, "", "no server running on /private/tmp/tmux-501/conch\n").state).toBe("gone");
    expect(readServerListing(1, "", "error connecting to /private/tmp/tmux-501/conch (No such file or directory)\n").state).toBe("gone");
    expect(readServerListing(1, "", "lost server\n").state).toBe("unknown");
    expect(readServerListing(137, "", "").state).toBe("unknown");
  });
});

describe("the guard, end to end over a fake tmux", () => {
  function guard(serversNow: () => Record<BackgroundServer, ServerReading>) {
    const file = join(mkdtempSync(join(tmpdir(), "conch-bg-guard-")), "background-sessions.json");
    const launched: StartSessionRequest[] = [];
    const logs: string[] = [];
    const make = () => new BackgroundGuard({
      file,
      relaunchFor: async (session) => ({ backend: "claude", resumeSessionId: session.agentSessionId ?? session.sessionId, claudeAccountId: "work", cwd: "/Users/t", options: { "bypass-permissions": true } }),
      launch: async (req) => { launched.push(req); },
      log: (line) => logs.push(line),
      readServers: async () => serversNow(),
      now: () => 1_000_000,
    });
    return { file, launched, logs, make };
  }

  test("seen running, its server killed, its conversation off: resumed in the background, exactly as it ran", async () => {
    let state = servers(running([[12, NAME_A], [13, NAME_B]]));
    const g = guard(() => state);
    const first = g.make();
    await first.observe([
      { sessionId: "a", label: "Cobra doc", pid: 12 },
      { sessionId: "b", label: "seashell", pid: 13 },
      { sessionId: "job", label: "a Claude Code job", pid: 14, jobId: "b10e6872" },
    ], new Set(["a", "b"]));
    expect(first.records().map((r) => r.conversationId).sort()).toEqual(["a", "b"]);
    expect(g.launched).toEqual([]);

    // The server is killed, and the daemon restarts before it next looks: the records come back from disk.
    state = servers(gone);
    const second = g.make();
    expect(second.records()).toHaveLength(2);
    await second.observe([], new Set());
    expect(g.launched).toEqual([
      { backend: "claude", host: "background", resumeSessionId: "a", claudeAccountId: "work", cwd: "/Users/t", options: { "bypass-permissions": true }, trustFolder: true },
      { backend: "claude", host: "background", resumeSessionId: "b", claudeAccountId: "work", cwd: "/Users/t", options: { "bypass-permissions": true }, trustFolder: true },
    ]);
    expect(g.logs.filter((line) => line.startsWith("brought back"))).toHaveLength(2);
    // Brought back once: the next read, before they have registered again, does not start them a second time.
    await second.observe([], new Set());
    expect(g.launched).toHaveLength(2);
    expect(JSON.parse(readFileSync(g.file, "utf8")).attempts.a).toEqual([1_000_000]);
  });

  test("a session closed on purpose is never brought back", async () => {
    let state = servers(running([[12, NAME_A]]));
    const g = guard(() => state);
    const guarded = g.make();
    await guarded.observe([{ sessionId: "a", pid: 12 }], new Set(["a"]));
    state = servers(running([]));
    await guarded.observe([], new Set());
    state = servers(gone);
    await guarded.observe([], new Set());
    expect(g.launched).toEqual([]);
  });
});

/**
 * End to end over real tmux: conch's own server (the suite's, `CONCH_TMUX_SOCKET` under its own `TMUX_TMPDIR`,
 * test/preload.ts), real sessions on it, the real server readings, then the server killed outright as on
 * 2026-10-02. Only the agent is a stand-in (`sleep`), and "resume" starts another one, recording what it was asked.
 */

const suiteTmux = process.env.TMUX_TMPDIR?.startsWith("/tmp/ctmux-") && process.env.CONCH_TMUX_SOCKET?.startsWith("conch-test-");
describe.skipIf(!resolveTmux().found || !suiteTmux)("a killed tmux server, for real", () => {
  const pidOf = async (pane: string) => {
    const target = paneTarget(pane)!;
    return Number((await probeCommand([...target.tmux, "display-message", "-p", "-t", target.pane, "#{pane_pid}"], [0]))?.trim());
  };

  test("its sessions come back, once each, on a server of conch's own; one that ended on purpose stays gone", async () => {
    const a = await startBackgroundProcess("exec sleep 600", "/tmp");
    const b = await startBackgroundProcess("exec sleep 600", "/tmp");
    const done = await startBackgroundProcess("exec sleep 600", "/tmp");
    const [pidA, pidB, pidDone] = [await pidOf(a.pane), await pidOf(b.pane), await pidOf(done.pane)];
    const file = join(mkdtempSync(join(tmpdir(), "conch-bg-e2e-")), "background-sessions.json");
    const launched: StartSessionRequest[] = [];
    const guard = new BackgroundGuard({
      file,
      relaunchFor: async (session) => ({ backend: "claude", resumeSessionId: session.sessionId, cwd: "/tmp" }),
      // A resume: another stand-in agent, on conch's server, as `launchSession` would start one.
      launch: async (request) => { launched.push(request); await startBackgroundProcess("exec sleep 600", "/tmp"); },
      log: () => {},
    });
    await guard.observe([
      { sessionId: "conv-a", pid: pidA }, { sessionId: "conv-b", pid: pidB }, { sessionId: "conv-done", pid: pidDone },
    ], new Set(["conv-a", "conv-b", "conv-done"]));
    expect(guard.records().map((r) => r.conversationId).sort()).toEqual(["conv-a", "conv-b", "conv-done"]);

    // One is ended on purpose, as /exit would: its server stays up (exit-empty off), and it is forgotten.
    const doneTarget = paneTarget(done.pane)!;
    await probeCommand([...doneTarget.tmux, "kill-session", "-t", done.name], [0]);
    await guard.observe([{ sessionId: "conv-a", pid: pidA }, { sessionId: "conv-b", pid: pidB }], new Set(["conv-a", "conv-b"]));
    expect(guard.records().map((r) => r.conversationId).sort()).toEqual(["conv-a", "conv-b"]);

    // Then the whole server is killed, by name: the suite's own (`-L conch-test-…`), never a real one.
    const killed = Bun.spawnSync([...conchTmux(), "kill-server"], { stdout: "ignore", stderr: "ignore" });
    expect(killed.exitCode).toBe(0);
    expect(await conchServerSessions()).toEqual(new Set());

    await guard.observe([], new Set());
    expect(launched.map((r) => [r.host, r.resumeSessionId, r.trustFolder]).sort())
      .toEqual([["background", "conv-a", true], ["background", "conv-b", true]]);
    // Running again, on a new server of conch's own.
    expect((await conchServerSessions())?.size).toBe(2);
    // Read again before they register: nothing is started twice.
    await guard.observe([], new Set());
    expect(launched).toHaveLength(2);
    Bun.spawnSync([...conchTmux(), "kill-server"], { stdout: "ignore", stderr: "ignore" });
  }, 20_000);
});
