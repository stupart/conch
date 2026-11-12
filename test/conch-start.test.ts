import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONCH_START_REPLY_MS,
  createMcpToolHandlers,
  defaultMcpDependencies,
  dispatchJsonRpc,
  MCP_TOOLS,
  type McpDependencies,
  type McpToolHandlers,
} from "../src/mcp.ts";
import { applyRuntimeControlMessage, createControlServer, sessionStartLine, type ControlServer } from "../src/control-server.ts";
import { awaitForkStart, FORK_WAIT_MS } from "../src/session-fork.ts";
import { startedSessionFor, type PendingStart } from "../src/session-start-wait.ts";
import { validateControlMessage, validateControlResponse, type ControlResult, type RuntimeControlMessage } from "../src/settings.ts";
import type { ClaudeSessionSignIn } from "../src/claude-session-sign-ins.ts";
import type { SessionInfo } from "../src/sessions.ts";
import { AGENT_COMMANDS } from "../src/agent-instructions.ts";

// 2026-11-10, Tyler, choosing which account a session runs on: "one session [uses] another account to create a fable
// agent using conch for me since [this one is] out of credits". `conch_start` starts a session through the daemon, on a
// sign-in when asked, and answers once conch sees it running; the asking agent then waits on its reply.

const CONFIG = { claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock", sessionsPath: "/virtual/sessions.json" };
const SIGN_INS: ClaudeSessionSignIn[] = [
  { id: "abc-1", label: "Work Max", addedAt: 1 },
  { id: "def-2", label: "Personal", addedAt: 2 },
];
/** Anything that looks like a token at all: none is ever in conch's list, and none may come out of here. */
const TOKEN_SHAPED = /sk-ant-[A-Za-z0-9_-]{8,}/;
const FOLDER = tmpdir();

type Sent = Parameters<McpDependencies["sendControlMessage"]>[1];
type StartMessage = Extract<RuntimeControlMessage, { kind: "session-start" }>;

function fakes(reply: (message: Sent) => ControlResult, sent: Array<{ message: Sent; timeoutMs?: number }> = [], overrides: Partial<McpDependencies> = {}): McpDependencies {
  return {
    ...defaultMcpDependencies,
    async readSessionsFile() { return null; },
    async registrySnapshot() { return { infos: [], liveIds: new Set<string>(), complete: true }; },
    readSessionSignIns: () => SIGN_INS,
    async sendControlMessage(_socket, message, timeoutMs) {
      sent.push({ message, timeoutMs });
      return reply(message);
    },
    now: () => 1_000_000,
    parentPid: () => 999_999,
    ...overrides,
  };
}

const started = (extra: Record<string, unknown> = {}): ControlResult =>
  ({ ok: true, response: { kind: "session-started", backend: "claude", resumed: false, sessionId: "new-1", label: "Fable · research", ...extra } as never });

async function call(handlers: McpToolHandlers, args: unknown, name = "conch_start") {
  const response = await dispatchJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, handlers);
  const result = response?.result as { content: Array<{ text: string }>; isError?: boolean };
  const text = result.content[0]!.text;
  return { error: result.isError === true, text, json: () => JSON.parse(text) };
}

describe("conch_start: a new session, on the account asked for, answered once it runs", () => {
  test("starts a Claude session on a sign-in named by label, with the model and the task, and says how to wait for its answer", async () => {
    const sent: Array<{ message: Sent; timeoutMs?: number }> = [];
    const handlers = createMcpToolHandlers(CONFIG, fakes(() => started(), sent));
    const reply = await call(handlers, { signIn: "work max", model: "fable", effort: "high", prompt: "Summarise the open PRs", folder: FOLDER, label: "Fable · research" });
    expect(reply.error).toBe(false);
    expect(sent).toEqual([{
      message: {
        kind: "session-start", backend: "claude", cwd: FOLDER, claudeSignInId: "abc-1",
        options: { model: "fable", effort: "high" }, prompt: "Summarise the open PRs", label: "Fable · research", wait: true,
      },
      timeoutMs: CONCH_START_REPLY_MS,
    }]);
    expect(reply.json()).toEqual({
      outcome: "started",
      sessionId: "new-1",
      label: "Fable · research",
      backend: "claude",
      folder: FOLDER,
      account: "Work Max",
      model: "fable",
      note: expect.stringContaining("conch sees it running"),
      next: expect.stringContaining("conch agent tail new-1 --wait 30"),
    });
    expect(reply.json().next).toContain("until its status is waiting");
    // Long enough for the daemon's own launch and wait, and under Codex's 60 s tool timeout.
    expect(CONCH_START_REPLY_MS).toBeGreaterThan(FORK_WAIT_MS + 10_000);
    expect(CONCH_START_REPLY_MS).toBeLessThan(60_000);
  });

  test("with nothing named: Claude, in your own cwd, on Default's rotating login, in Terminal", async () => {
    const sent: Array<{ message: Sent; timeoutMs?: number }> = [];
    const reply = (await call(createMcpToolHandlers(CONFIG, fakes(() => started(), sent)), {})).json();
    expect(sent[0]!.message).toEqual({ kind: "session-start", backend: "claude", cwd: process.cwd(), wait: true });
    expect(reply).toMatchObject({ outcome: "started", sessionId: "new-1", account: "Default (its rotating login)", folder: process.cwd() });
    // No task given, so no wait to describe.
    expect(reply.next).toBeUndefined();
  });

  test("by id too; a relative folder is your cwd's; Codex's effort is its reasoning effort, in the background", async () => {
    const sent: Array<{ message: Sent; timeoutMs?: number }> = [];
    const handlers = createMcpToolHandlers(CONFIG, fakes(() => started(), sent));
    await call(handlers, { signIn: "def-2", folder: "src" });
    expect(sent[0]!.message).toMatchObject({ claudeSignInId: "def-2", cwd: join(process.cwd(), "src") });
    await call(handlers, { backend: "codex", model: "gpt-6-sol", effort: "xhigh", host: "background" });
    expect(sent[1]!.message).toEqual({
      kind: "session-start", backend: "codex", cwd: process.cwd(), host: "background",
      options: { model: "gpt-6-sol", "reasoning-effort": "xhigh" }, wait: true,
    });
  });

  test("a sign-in conch doesn't have is refused with the ones it has, by label and id; nothing starts", async () => {
    const sent: Array<{ message: Sent; timeoutMs?: number }> = [];
    const handlers = createMcpToolHandlers(CONFIG, fakes(() => started(), sent));
    const unknown = await call(handlers, { signIn: "Wrok" });
    expect(unknown.error).toBe(true);
    expect(unknown.text).toBe(`refused: no Claude sign-in is called "Wrok". conch has "Work Max" (abc-1), "Personal" (def-2); leave it out for Default's own, rotating login.`);
    const none = await call(createMcpToolHandlers(CONFIG, fakes(() => started(), sent, { readSessionSignIns: () => [] })), { signIn: "Work Max" });
    expect(none.text).toContain("conch has no Claude sign-ins yet: add one in the Mac app's Settings › Providers");
    const unreadable = await call(createMcpToolHandlers(CONFIG, fakes(() => started(), sent, { readSessionSignIns: () => { throw new Error("Invalid Claude sign-in in conch's list"); } })), { signIn: "Work Max" });
    expect(unreadable.text).toBe("failed: conch couldn't read its Claude sign-ins (Invalid Claude sign-in in conch's list), so nothing was started");
    // A token pasted as a sign-in is never said back.
    const pasted = await call(handlers, { signIn: `sk-ant-oat01-${"x".repeat(40)}` });
    expect(pasted.text).not.toMatch(TOKEN_SHAPED);
    expect(sent).toEqual([]);
  });

  test("its arguments are checked before anything is sent", async () => {
    const sent: Array<{ message: Sent; timeoutMs?: number }> = [];
    const handlers = createMcpToolHandlers(CONFIG, fakes(() => started(), sent));
    const refused = async (args: Record<string, unknown>) => (await call(handlers, args)).text;
    expect(await refused({ backend: "codex", signIn: "Work Max" })).toBe("refused: a sign-in is for a Claude session: Codex signs in with its own accounts");
    expect(await refused({ backend: "gemini" })).toBe("backend must be claude or codex");
    expect(await refused({ host: "tmux" })).toBe("host must be terminal or background");
    expect(await refused({ folder: join(FOLDER, "not-there-at-all") })).toBe(`refused: ${join(FOLDER, "not-there-at-all")} is not a folder that exists`);
    expect(await refused({ effort: "ultra" })).toBe("effort for Claude Code is one of low, medium, high, xhigh, max");
    expect(await refused({ model: "fable; rm -rf ~" })).toStartWith("refused: --model must be letters, digits");
    expect(await refused({ prompt: "--help" })).toBe("refused: prompt cannot start with -");
    expect(await refused({ prompt: "one\ntwo" })).toBe("refused: prompt must be one line without control characters");
    expect(await refused({ label: "x".repeat(81) })).toBe("label must be at most 80 characters");
    expect(await refused({ account: "Work Max" })).toBe(`unknown argument "account": use signIn, one of conch's Claude sign-ins by label or id`);
    expect(await refused({ cwd: "/tmp" })).toBe(`unknown argument "cwd": use folder`);
    expect(await refused({ signIn: "" })).toBe("signIn must be a non-empty string");
    expect(sent).toEqual([]);
  });

  test("the daemon's answer is the agent's: a start that didn't run is never said to have started", async () => {
    const error = (text: string): ControlResult => ({ ok: true, response: { kind: "session-error", error: text } as never });
    const died = await call(createMcpToolHandlers(CONFIG, fakes(() => error(
      "the new session's agent exited as soon as it started, in Terminal (ttys012). Its tab shows:\nconch: the Claude sign-in \"Work Max\" isn't in your Keychain any more, so this session didn't start.",
    ))), { signIn: "Work Max" });
    expect(died.error).toBe(true);
    expect(died.text).toStartWith("failed: the session didn't start: the new session's agent exited as soon as it started");
    expect(died.text).toContain("isn't in your Keychain any more");

    const down = await call(createMcpToolHandlers(CONFIG, fakes(() => ({ ok: false, reason: "daemon-down" }))), {});
    expect(down.text).toBe("failed: conch daemon is not running, so nothing was started");
    const slow = await call(createMcpToolHandlers(CONFIG, fakes(() => ({ ok: false, reason: "ack-unknown", diagnostic: "timed out" }))), {});
    expect(slow.text).toContain("check conch_sessions before starting another");

    const trust = await call(createMcpToolHandlers(CONFIG, fakes(() => ({ ok: true, response: { kind: "session-needs-trust", backend: "claude", cwd: FOLDER } as never }))), {});
    expect(trust.text).toStartWith(`refused: Claude Code doesn't trust ${FOLDER} yet, so conch started nothing there`);

    const running = (await call(createMcpToolHandlers(CONFIG, fakes(() => started({ sessionId: undefined, label: undefined, running: "Terminal (ttys012)" }))), {})).json();
    expect(running).toMatchObject({ outcome: "running", running: "Terminal (ttys012)" });
    expect(running.note).toContain("Don't start another");
    expect(running.sessionId).toBeUndefined();
  });

  test("conch_sessions lists the sign-ins it can start on, label and id only, and nothing when there are none", async () => {
    const listed = (await call(createMcpToolHandlers(CONFIG, fakes(() => started())), {}, "conch_sessions")).json();
    expect(listed.claudeSignIns).toEqual([{ label: "Work Max", id: "abc-1" }, { label: "Personal", id: "def-2" }]);
    const none = (await call(createMcpToolHandlers(CONFIG, fakes(() => started(), [], { readSessionSignIns: () => [] })), {}, "conch_sessions")).json();
    expect(none.claudeSignIns).toBeUndefined();
    const broken = (await call(createMcpToolHandlers(CONFIG, fakes(() => started(), [], { readSessionSignIns: () => { throw new Error("x"); } })), {}, "conch_sessions")).json();
    expect(broken.claudeSignIns).toBeUndefined();
    expect(broken.sessions).toEqual([]);
  });

  // 2026-11-11: `conch agent start` is how an agent starts one; the tool stays for sessions started before, saying so.
  test("its schema stays, and the command's help says how to pick the account and how to bring back the answer", () => {
    const tool = MCP_TOOLS.find((one) => one.name === "conch_start")!;
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["backend", "folder", "signIn", "model", "effort", "prompt", "host", "label"]);
    expect(tool.description).toContain("`conch agent start");
    const help = AGENT_COMMANDS.find((command) => command.name === "start")!;
    expect(help.tool).toBe("conch_start");
    expect(help.help).toContain("At the user's request");
    expect(help.help).toContain("--sign-in is one of conch's Claude sign-ins by label or id (sessions lists them)");
    expect(help.help).toContain("Default's own rotating login");
    expect(help.help).toContain("say it started only from that");
    expect(help.help).toContain("To bring back its answer, tail it with --wait");
    expect(help.usage).toContain("--sign-in ACCOUNT");
  });
});

describe("on the wire", () => {
  test("a start an agent waits on carries wait, and a label only with it", () => {
    const start = (extra: Record<string, unknown>) => validateControlMessage({ kind: "session-start", backend: "claude", cwd: "/work/demo", ...extra });
    expect(start({ wait: true, label: "Fable · research", claudeSignInId: "abc-1" })).toEqual({
      ok: true, value: { kind: "session-start", backend: "claude", cwd: "/work/demo", claudeSignInId: "abc-1", wait: true, label: "Fable · research" },
    });
    expect(start({ wait: false })).toEqual({ ok: false, err: "wait must be true when present" });
    expect(start({ label: "x" })).toEqual({ ok: false, err: "label names a session conch waits to see start: send it with wait" });
    expect(start({ wait: true, label: "a\u0007b" }).ok).toBe(false);
    expect(start({ wait: true, claudeAccountId: "work", claudeSourceAccountId: "default", resumeSessionId: "11111111-2222-4333-8444-555555555555" }).ok).toBe(false);
    // A start that doesn't wait is as it was.
    expect(start({})).toEqual({ ok: true, value: { kind: "session-start", backend: "claude", cwd: "/work/demo" } });
  });

  test("the answer carries the session's label, or where it runs", () => {
    const answer = (extra: Record<string, unknown>) => validateControlResponse({ kind: "session-started", backend: "claude", resumed: false, ...extra });
    expect(answer({ sessionId: "new-1", label: "Fable · research" })).toEqual({
      ok: true, value: { kind: "session-started", backend: "claude", resumed: false, sessionId: "new-1", label: "Fable · research" },
    });
    expect(answer({ running: "Terminal (ttys012)" })).toMatchObject({ ok: true, value: { running: "Terminal (ttys012)" } });
    expect(answer({ label: 7 }).ok).toBe(false);
    expect(answer({ running: "x".repeat(5_000) }).ok).toBe(false);
  });

  test("the daemon's log line says an agent is waiting on it", () => {
    expect(sessionStartLine({ kind: "session-start", backend: "claude", claudeSignInId: "abc-1", wait: true }, "/work/demo", false))
      .toBe("session-start: claude terminal account=default sign-in=abc-1 trustFolder=no folder=demo for an agent, waiting to see it");
  });

  describe("through a real control server", () => {
    const servers: ControlServer[] = [];
    afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

    test("conch_start's request reaches the daemon's start as sent, and its answer comes back to the agent", async () => {
      const dir = mkdtempSync("/tmp/conch-start-");
      const socketPath = join(dir, "c.sock");
      const starts: StartMessage[] = [];
      const logs: string[] = [];
      const created = createControlServer({
        socketPath, ownerDeviceId: "this-mac", log: (line) => logs.push(line),
        sessions: { resolve: (value) => value, current: () => ({ published: true, label: "demo" }) },
        application: {
          configuration: () => ({ kind: "config-error", error: "stub" }),
          session: () => ({ kind: "session-error", error: "stub" }),
          runtime: (message) => applyRuntimeControlMessage(message, {
            listResumable: () => ({ sessions: [], complete: true }),
            folderTrusted: () => true,
            log: (line) => logs.push(line),
            start: async (message) => {
              starts.push(message);
              return { sessionId: "new-1", label: message.label ?? "demo" };
            },
            close: () => {},
            report: () => {},
          }),
          turn: () => {},
          device: () => ({ kind: "ack" }),
        },
      });
      servers.push(created);
      expect(await created.start()).toBe(true);
      try {
        const handlers = createMcpToolHandlers({ ...CONFIG, socketPath }, { ...fakes(() => started()), sendControlMessage: defaultMcpDependencies.sendControlMessage });
        const reply = await call(handlers, { signIn: "Personal", model: "fable", prompt: "Look into X", folder: dir, label: "Fable · X" });
        expect(reply.error).toBe(false);
        expect(reply.json()).toMatchObject({ outcome: "started", sessionId: "new-1", label: "Fable · X", account: "Personal" });
        expect(starts).toEqual([{
          kind: "session-start", backend: "claude", cwd: dir, claudeSignInId: "def-2", options: { model: "fable" },
          prompt: "Look into X", wait: true, label: "Fable · X",
        }]);
        expect(logs.join("\n")).toContain("sign-in=def-2");
        for (const text of [reply.text, ...logs]) expect(text).not.toMatch(TOKEN_SHAPED);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("knowing the session a start opened", () => {
  const session = (extra: Partial<SessionInfo>): SessionInfo => ({ sessionId: "s", backend: "claude", pid: 100, startedAt: 50_000, ...extra });
  const pending = (extra: Partial<PendingStart> = {}): PendingStart => ({ backend: "claude", at: 50_000, before: new Set(["old"]), ...extra });
  const look = (ttys: Record<number, string>, panePid?: number) => ({
    ttyOf: async (pid: number) => ttys[pid] ?? "??",
    backgroundPid: async () => panePid,
  });

  test("by the Terminal tab it opened: a session conch didn't have, of the same agent, running on that tty", async () => {
    const sessions = [
      session({ sessionId: "old", pid: 1 }),
      session({ sessionId: "other-tab", pid: 2 }),
      session({ sessionId: "codex-here", pid: 3, backend: "codex" }),
      session({ sessionId: "agent", pid: 3, parentSessionId: "x" }),
      session({ sessionId: "stale", pid: 3, startedAt: 10_000 }),
      session({ sessionId: "new", pid: 3 }),
    ];
    const ttys = { 1: "ttys012", 2: "ttys009", 3: "ttys012" };
    expect((await startedSessionFor(sessions, pending({ tty: "ttys012" }), look(ttys)))?.sessionId).toBe("new");
    expect((await startedSessionFor(sessions, pending({ tty: "/dev/ttys012" }), look(ttys)))?.sessionId).toBe("new");
    expect(await startedSessionFor(sessions.slice(0, 5), pending({ tty: "ttys012" }), look(ttys))).toBeUndefined();
    // Codex's, when it was Codex that started.
    expect((await startedSessionFor(sessions, pending({ backend: "codex", tty: "ttys012" }), look(ttys)))?.sessionId).toBe("codex-here");
  });

  test("by the background host's pane, whose process the agent is", async () => {
    const sessions = [session({ sessionId: "elsewhere", pid: 7 }), session({ sessionId: "new", pid: 8, startedAt: undefined })];
    expect((await startedSessionFor(sessions, pending({ backgroundId: "conch-x" }), look({}, 8)))?.sessionId).toBe("new");
    expect(await startedSessionFor(sessions, pending({ backgroundId: "conch-x" }), look({}, undefined))).toBeUndefined();
    // Nowhere to know it by: nothing is guessed.
    expect(await startedSessionFor(sessions, pending(), look({ 7: "ttys001", 8: "ttys001" }, 8))).toBeUndefined();
  });

  test("its wait is the fork's, said of the new session", async () => {
    let now = 0;
    await expect(awaitForkStart({
      adopted: new Promise(() => {}),
      noun: "the new session",
      state: async () => (now < 2_000 ? "running" : "gone"),
      lastWords: async () => "Invalid API key",
      look: () => {},
      where: "Terminal (ttys012)",
      sleep: async (ms) => { now += ms; },
      now: () => now,
    })).rejects.toThrow("the new session's agent exited as soon as it started, in Terminal (ttys012). Its tab shows:\nInvalid API key");
  });

  test("the daemon starts an agent's session there, and only a start that waits", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");
    expect(daemon).toContain("if (message.claudeSourceAccountId === undefined) return wait ? startLiveSession(request, label) : launchSession(request);");
    const start = daemon.slice(daemon.indexOf("const startLiveSession = async ("), daemon.indexOf("// 2026-10-05, Tyler, after using #502"));
    expect(start).toContain("before: new Set(panelSessions.keys())");
    expect(start.indexOf("before: new Set(panelSessions.keys())")).toBeLessThan(start.indexOf("await launchSession(request)"));
    expect(start).toContain("await startedSessionFor([...panelSessions.values()]");
    expect(start).toContain("await awaitForkStart({");
    expect(start).toContain('noun: "the new session"');
    expect(start).toContain("renameSessionLabel(seen.forkId, named, label)");
    expect(start).toContain("looking = false;");
  });
});
