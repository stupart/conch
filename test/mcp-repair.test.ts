import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnswerKey } from "../src/agent-adapter.ts";
import { claudeProjectSlug } from "../src/claude-title.ts";
import {
  CONCH_MCP_LOG_FOLDER,
  conchMcpFailureFor,
  conchMcpLogDir,
  failedServerStale,
  findConchMcpFailure,
  hasConchMcpServer,
  lastConnectionOutcome,
  mcpFailureWords,
  mcpLogFileTime,
  promptBlocker,
  RELOAD_PLUGINS,
  repairBlocker,
  REPAIR_AWAY_SECS,
  routeBlocker,
  submitSlashCommand,
  waitForServer,
} from "../src/mcp-repair.ts";
import type { McpServerReport } from "../src/mcp-servers.ts";
import { MCP_TOOL_NAMES } from "../src/mcp-toolset.ts";
import { conchPluginServerRunnable } from "../src/plugin-install.ts";

/**
 * 2026-10-23: Homebrew deleted the bun conch's plugin named, and two sessions started then never had conch's tools;
 * nothing said so, because a session with no conch server at all was "nothing to say". Their own MCP logs did say so,
 * and `/reload-plugins` brought the server back. These lines are copied from those logs.
 */
const SESSION = "5e5e5e04-0004-4000-8000-000000000004";
const OTHER = "5e5e5e05-0005-4000-8000-000000000005";
const CWD = "/Users/someone";
const line = (fields: Record<string, string>, sessionId = SESSION) => JSON.stringify({ ...fields, sessionId, cwd: CWD });
const ENOENT = "Connection failed (ENOENT): ENOENT: no such file or directory, posix_spawn 'stdio'";
const failedStart = (at: string, sessionId = SESSION) => [
  line({ debug: "Starting connection with timeout of 30000ms", timestamp: at }, sessionId),
  line({ debug: "Connection failed after 15ms, 15ms of it awake (ENOENT): ENOENT: no such file or directory, posix_spawn 'stdio'", timestamp: at }, sessionId),
  line({ error: ENOENT, timestamp: at }, sessionId),
];
const goodStart = (at: string, sessionId = SESSION) => [
  line({ debug: "Starting connection with timeout of 30000ms", timestamp: at }, sessionId),
  line({ debug: "Successfully connected (transport: stdio) in 107ms", timestamp: at }, sessionId),
  line({ debug: "Connection established with capabilities: {\"hasTools\":true}", timestamp: at }, sessionId),
  line({ debug: "Channel notifications skipped: server did not declare claude/channel capability", timestamp: at }, sessionId),
];

const scratch = () => mkdtempSync(join(tmpdir(), "conch-mcp-repair-"));
function logFolder(cache: string, cwd = CWD): string {
  const dir = conchMcpLogDir(cwd, cache);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const writeLog = (dir: string, name: string, lines: readonly string[]) => writeFileSync(join(dir, name), `${lines.join("\n")}\n`);

describe("where Claude Code logs conch's server", () => {
  test("the project's cache folder, named the way its projects folder is", () => {
    expect(claudeProjectSlug("/Users/someone/.config/conch/help")).toBe("-Users-someone--config-conch-help");
    expect(conchMcpLogDir("/Users/someone/.config/conch/help", "/cache"))
      .toBe(`/cache/-Users-someone--config-conch-help/${CONCH_MCP_LOG_FOLDER}`);
  });

  test("a log's name is its first connection's time", () => {
    expect(mcpLogFileTime("2026-10-23T20-45-53-505Z.jsonl")).toBe(Date.parse("2026-10-23T20:45:53.505Z"));
    expect(mcpLogFileTime("2026-10-23T20-45-53-505Z.jsonl.tmp")).toBeUndefined();
    expect(mcpLogFileTime("notes.jsonl")).toBeUndefined();
  });
});

describe("the newest connection a log records", () => {
  test("a failed start ends in its error, with Claude Code's words and time", () => {
    expect(lastConnectionOutcome(failedStart("2026-10-23T20:45:53.547Z")))
      .toEqual({ state: "failed", error: ENOENT, at: Date.parse("2026-10-23T20:45:53.547Z") });
  });

  test("a reconnect that failed again is still a failure; a reload that came up is not (the same file, appended)", () => {
    const reconnect = [...failedStart("2026-10-23T20:45:53.547Z"), ...failedStart("2026-10-24T00:15:04.678Z")];
    expect(lastConnectionOutcome(reconnect)).toMatchObject({ state: "failed", at: Date.parse("2026-10-24T00:15:04.678Z") });
    const reloaded = [
      ...reconnect,
      line({ debug: "excludeStalePluginClients: marking stale (config hash changed)", timestamp: "2026-10-24T00:16:35.949Z" }),
      ...goodStart("2026-10-24T00:16:36.062Z"),
    ];
    expect(lastConnectionOutcome(reloaded)).toEqual({ state: "connected" });
  });

  test("tool calls mean it is up; a start with no outcome yet is under way; anything else says nothing", () => {
    expect(lastConnectionOutcome([
      line({ debug: "Calling MCP tool: conch_transcript_tail", timestamp: "t" }),
      line({ error: "no live session matching \"c00b5ced\"", timestamp: "t" }),
    ])).toEqual({ state: "connected" });
    expect(lastConnectionOutcome([...failedStart("t"), line({ debug: "Starting connection with timeout of 30000ms", timestamp: "t" })]))
      .toEqual({ state: "connecting" });
    expect(lastConnectionOutcome([line({ debug: "MCP server process exited cleanly", timestamp: "t" }), "{ torn"])).toBeNull();
    expect(lastConnectionOutcome([])).toBeNull();
  });

  test("a log cut before its error line still reads as the failure its debug line names", () => {
    expect(lastConnectionOutcome(failedStart("2026-10-23T20:45:53.547Z").slice(0, 2))).toMatchObject({ state: "failed" });
  });

  test("Claude Code's preamble comes off the words a row shows", () => {
    expect(mcpFailureWords(ENOENT)).toBe("ENOENT: no such file or directory, posix_spawn 'stdio'");
    expect(mcpFailureWords("Connection failed after 15ms, 15ms of it awake (ENOENT): ENOENT: no such file"))
      .toBe("ENOENT: no such file");
    expect(mcpFailureWords("Connection failed (CONNECT_TIMEOUT): MCP server \"plugin:conch:conch\" connection timed out after 30000ms"))
      .toBe("MCP server \"plugin:conch:conch\" connection timed out after 30000ms");
    expect(mcpFailureWords("Connection failed")).toBe("Connection failed");
    expect(mcpFailureWords(`Connection failed (X): ${"a".repeat(400)}`).length).toBe(160);
  });
});

describe("a session's own log", () => {
  test("the file carrying its id, beside another session's in the same folder", () => {
    const cache = scratch();
    const dir = logFolder(cache);
    writeLog(dir, "2026-10-23T20-45-53-505Z.jsonl", failedStart("2026-10-23T20:45:53.547Z"));
    writeLog(dir, "2026-10-24T00-15-51-666Z.jsonl", goodStart("2026-10-24T00:15:51.727Z", OTHER));
    expect(findConchMcpFailure({ cwd: CWD, sessionId: SESSION, cacheDir: cache })).toEqual({
      file: join(dir, "2026-10-23T20-45-53-505Z.jsonl"), error: ENOENT, at: Date.parse("2026-10-23T20:45:53.547Z"),
    });
    expect(findConchMcpFailure({ cwd: CWD, sessionId: OTHER, cacheDir: cache })).toBeNull();
    expect(findConchMcpFailure({ cwd: CWD, sessionId: "not-here", cacheDir: cache })).toBeNull();
    expect(findConchMcpFailure({ cwd: "/nowhere", sessionId: SESSION, cacheDir: cache })).toBeNull();
    expect(findConchMcpFailure({ cwd: undefined, sessionId: SESSION, cacheDir: cache })).toBeNull();
  });

  test("with its start known, a resumed session's earlier process (the same id) is not its own", () => {
    const cache = scratch();
    const dir = logFolder(cache);
    writeLog(dir, "2026-10-20T09-00-00-000Z.jsonl", failedStart("2026-10-20T09:00:00.050Z"));
    writeLog(dir, "2026-10-23T20-45-53-505Z.jsonl", goodStart("2026-10-23T20:45:53.600Z"));
    const startedAt = Date.parse("2026-10-23T20:45:53.400Z");
    expect(findConchMcpFailure({ cwd: CWD, sessionId: SESSION, startedAt, cacheDir: cache })).toBeNull();
    // And the other way round: the earlier process came up, this one failed.
    writeLog(dir, "2026-10-20T09-00-00-000Z.jsonl", goodStart("2026-10-20T09:00:00.050Z"));
    writeLog(dir, "2026-10-23T20-45-53-505Z.jsonl", failedStart("2026-10-23T20:45:53.547Z"));
    expect(findConchMcpFailure({ cwd: CWD, sessionId: SESSION, startedAt, cacheDir: cache })?.file).toBe(join(dir, "2026-10-23T20-45-53-505Z.jsonl"));
  });

  test("only a file's tail is read, so a long-lived session's large log costs no more than a short one", () => {
    const cache = scratch();
    const dir = logFolder(cache);
    const chatter = Array.from({ length: 2_000 }, () => line({ debug: "Calling MCP tool: conch_sessions", timestamp: "t" }));
    writeLog(dir, "2026-10-23T20-45-53-505Z.jsonl", [...chatter, ...failedStart("2026-10-24T00:15:04.678Z")]);
    expect(findConchMcpFailure({ cwd: CWD, sessionId: SESSION, cacheDir: cache, tailBytes: 2_048 }))
      .toMatchObject({ at: Date.parse("2026-10-24T00:15:04.678Z") });
  });
});

describe("whether a session has a conch server", () => {
  const report = (sessionPid: number): McpServerReport => ({
    v: 1, pid: 9001, sessionPid, toolset: "x", tools: [], handoff: true, version: "0", startedAt: 0,
  });

  test("a report naming it, or a `conch mcp` child; unknown when neither can be read", () => {
    expect(hasConchMcpServer([4321], [report(4321)], null)).toBe(true);
    expect(hasConchMcpServer([4321], [], [{ pid: 9001, ppid: 4321, startedAt: 0 }])).toBe(true);
    expect(hasConchMcpServer([4321], [report(1)], [{ pid: 9001, ppid: 1, startedAt: 0 }])).toBe(false);
    expect(hasConchMcpServer([4321], [], null)).toBeUndefined();
  });

  test("only a Claude session with no server whose log failed is a failure; a background job's own pid counts", () => {
    const cache = scratch();
    writeLog(logFolder(cache), "2026-10-23T20-45-53-505Z.jsonl", failedStart("2026-10-23T20:45:53.547Z"));
    const session = { backend: "claude" as const, pid: 4321, cwd: CWD, sessionId: SESSION };
    expect(conchMcpFailureFor(session, [], [], cache)).toMatchObject({ error: ENOENT });
    // The registry's id, not a window key, is what the log carries.
    expect(conchMcpFailureFor({ ...session, sessionId: `${SESSION}#w2`, agentSessionId: SESSION }, [], [], cache)).toMatchObject({ error: ENOENT });
    expect(conchMcpFailureFor({ ...session, backend: "codex" }, [], [], cache)).toBeNull();
    expect(conchMcpFailureFor(session, [report(4321)], [], cache)).toBeNull();
    expect(conchMcpFailureFor(session, [], null, cache)).toBeNull();
    expect(conchMcpFailureFor({ ...session, pid: 0, agentPid: 777 }, [], [{ pid: 9001, ppid: 777, startedAt: 0 }], cache)).toBeNull();
    expect(conchMcpFailureFor({ ...session, pid: 0, agentPid: 777 }, [], [], cache)).toMatchObject({ error: ENOENT });
    expect(conchMcpFailureFor({ ...session, pid: 0 }, [], [], cache)).toBeNull();
  });
});

describe("what the row says", () => {
  const failure = { file: "/cache/x.jsonl", error: ENOENT, at: Date.parse("2026-10-23T20:45:53.547Z") };

  test("every current tool missing, why, and the fix: /reload-plugins, or a restart", () => {
    expect(failedServerStale(failure, MCP_TOOL_NAMES)).toEqual({
      missing: [...MCP_TOOL_NAMES],
      basis: "failed",
      failedAt: "2026-10-23T20:45:53.547Z",
      why: "its conch MCP server failed to start (ENOENT: no such file or directory, posix_spawn 'stdio')",
      fix: "type /reload-plugins in this session, or restart it (close it and resume it), to start conch's MCP server again",
    });
  });

  test("once conch's own reload didn't bring it back, it says that too", () => {
    expect(failedServerStale(failure, MCP_TOOL_NAMES, { at: 1, ok: false, reason: "no conch MCP server appeared within 20s of /reload-plugins" }).why)
      .toEndWith("(ENOENT: no such file or directory, posix_spawn 'stdio'); conch tried /reload-plugins: no conch MCP server appeared within 20s of /reload-plugins");
    expect(failedServerStale(failure, MCP_TOOL_NAMES, { at: 1, ok: true }).why).not.toContain("conch tried");
  });
});

describe("when conch types /reload-plugins", () => {
  const ready = { attempted: false, dismissed: false, runnable: { ok: true as const }, status: "waiting" };

  test("once per failure, never into a dismissed session, only once the plugin can start, only at rest", () => {
    expect(repairBlocker(ready)).toBeNull();
    expect(repairBlocker({ ...ready, attempted: true })).toContain("already typed");
    expect(repairBlocker({ ...ready, dismissed: true })).toContain("dismissed");
    expect(repairBlocker({ ...ready, runnable: { ok: false, why: "/opt/homebrew/Cellar/bun/1.4.2/bin/bun isn't there" } }))
      .toBe("the plugin's server can't start yet: /opt/homebrew/Cellar/bun/1.4.2/bin/bun isn't there");
    for (const status of ["working", "needs", null, undefined]) expect(repairBlocker({ ...ready, status })).toBe("the session isn't at rest");
  });

  test("a tmux pane takes it where it is; a Terminal window only while nobody is at the Mac", () => {
    expect(routeBlocker({ route: "tmux", keystrokeFallback: false, idleSeconds: 0 })).toBeNull();
    expect(routeBlocker({ route: null, keystrokeFallback: true, idleSeconds: 9_999 })).toContain("no terminal");
    expect(routeBlocker({ route: "terminal", keystrokeFallback: false, idleSeconds: 9_999 })).toContain("keystroke-fallback");
    expect(routeBlocker({ route: "terminal", keystrokeFallback: true, idleSeconds: REPAIR_AWAY_SECS - 1 })).toContain("in use");
    expect(routeBlocker({ route: "terminal", keystrokeFallback: true, idleSeconds: null })).toContain("in use");
    expect(routeBlocker({ route: "terminal", keystrokeFallback: true, idleSeconds: REPAIR_AWAY_SECS })).toBeNull();
  });

  const screen = (prompt: string, busy = false) => [
    "⏺ Done.", "", "─".repeat(60), `❯ ${prompt}`, "─".repeat(60), `  ⏵⏵ bypass permissions on${busy ? " · esc to interrupt" : ""}`,
  ].join("\n");

  test("only into a prompt on screen and empty, with no turn running", () => {
    expect(promptBlocker(screen(""))).toBeNull();
    expect(promptBlocker(null)).toContain("can't read");
    expect(promptBlocker(screen("", true))).toBe("the session is working");
    expect(promptBlocker(screen("half a thought"))).toContain("hasn't sent");
    expect(promptBlocker("Do you trust the files in this folder?\n❯ 1. Yes, proceed")).toContain("isn't on screen");
  });

  /** A Claude prompt that takes typed words and keys, as `driveSessionSettings`' tests drive one. */
  function simulated(start = "", options: { echo?: (prompt: string) => string } = {}) {
    let prompt = start;
    const submitted: string[] = [];
    const pressed: AnswerKey[] = [];
    return {
      submitted,
      pressed,
      get prompt() { return prompt; },
      deps: {
        read: async () => screen(options.echo ? options.echo(prompt) : prompt),
        type: async (words: string) => { prompt += words; return true; },
        press: async (keys: readonly AnswerKey[]) => {
          for (const key of keys) {
            pressed.push(key);
            if (key === "Backspace") prompt = prompt.slice(0, -1);
            if (key === "Enter") { submitted.push(prompt); prompt = ""; }
          }
          return true;
        },
        sleep: async () => {},
      },
    };
  }

  test("typed, checked, then submitted", async () => {
    const claude = simulated();
    expect(await submitSlashCommand(RELOAD_PLUGINS, claude.deps)).toEqual({ ok: true });
    expect(claude.submitted).toEqual([RELOAD_PLUGINS]);
  });

  test("a prompt holding someone's words is never typed into", async () => {
    const claude = simulated("draft reply");
    expect(await submitSlashCommand(RELOAD_PLUGINS, claude.deps)).toMatchObject({ ok: false, typed: false });
    expect(claude.prompt).toBe("draft reply");
    expect(claude.pressed).toEqual([]);
  });

  test("a prompt that doesn't show exactly the command is backspaced back to how it was, and nothing is submitted", async () => {
    // Someone typed a word in the moment between the look and the keys.
    const claude = simulated("", { echo: (prompt) => (prompt ? `x${prompt}` : prompt) });
    expect(await submitSlashCommand(RELOAD_PLUGINS, claude.deps)).toMatchObject({ ok: false, typed: true });
    expect(claude.submitted).toEqual([]);
    expect(claude.pressed).toEqual(Array.from({ length: RELOAD_PLUGINS.length }, () => "Backspace"));
    expect(claude.prompt).toBe("");
  });

  test("keys that don't go say so, and say whether anything reached the session", async () => {
    const claude = simulated();
    expect(await submitSlashCommand(RELOAD_PLUGINS, { ...claude.deps, type: async () => false }))
      .toMatchObject({ ok: false, typed: false });
    expect(await submitSlashCommand(RELOAD_PLUGINS, { ...claude.deps, press: async () => false }))
      .toMatchObject({ ok: false, typed: true });
  });

  test("then a server is waited for, a bounded while", async () => {
    let clock = 0;
    let checks = 0;
    const sleep = async (ms: number) => { clock += ms; };
    expect(await waitForServer(async () => ++checks === 3, { sleep, now: () => clock })).toBe(true);
    expect(clock).toBe(6_000);
    clock = 0;
    expect(await waitForServer(async () => false, { sleep, now: () => clock, timeoutMs: 20_000, intervalMs: 2_000 })).toBe(false);
    expect(clock).toBe(20_000);
  });
});

describe("whether the plugin's server could start now", () => {
  function account(mcp: object | null, ledger: object | null = null): { claudeDir: string; copy: string } {
    const claudeDir = scratch();
    const copy = join(claudeDir, "plugins", "cache", "conch", "conch", "0.3.0");
    mkdirSync(copy, { recursive: true });
    if (mcp) writeFileSync(join(copy, ".mcp.json"), JSON.stringify(mcp));
    writeFileSync(join(claudeDir, "plugins", "installed_plugins.json"), JSON.stringify(ledger ?? {
      version: 2, plugins: { "conch@conch": [{ scope: "user", installPath: copy }] },
    }));
    return { claudeDir, copy };
  }
  const server = (command: string, args: string[]) => ({ mcpServers: { conch: { command, args } } });

  test("the program it names, and every absolute path among its arguments", () => {
    const { claudeDir } = account(server("/opt/homebrew/bin/bun", ["run", "/src/cli.ts", "mcp"]));
    const there = new Set(["/opt/homebrew/bin/bun", "/src/cli.ts"]);
    expect(conchPluginServerRunnable(claudeDir, (path) => there.has(path))).toEqual({ ok: true });
    expect(conchPluginServerRunnable(claudeDir, (path) => path === "/src/cli.ts"))
      .toEqual({ ok: false, why: "/opt/homebrew/bin/bun isn't there" });
    expect(conchPluginServerRunnable(claudeDir, (path) => path === "/opt/homebrew/bin/bun"))
      .toEqual({ ok: false, why: "/src/cli.ts isn't there" });
  });

  test("a bare program is looked for on PATH, and the plugin's own folder stands in for ${CLAUDE_PLUGIN_ROOT}", () => {
    const { claudeDir, copy } = account(server("sh", ["${CLAUDE_PLUGIN_ROOT}/bin/conch-mcp"]));
    const launcher = join(copy, "bin", "conch-mcp");
    expect(conchPluginServerRunnable(claudeDir, (path) => path === launcher, (command) => command === "sh")).toEqual({ ok: true });
    expect(conchPluginServerRunnable(claudeDir, () => true, () => false)).toEqual({ ok: false, why: "sh isn't there" });
    expect(conchPluginServerRunnable(claudeDir, () => false, () => true)).toEqual({ ok: false, why: `${launcher} isn't there` });
  });

  test("an account without the plugin, or a copy with no server, can't", () => {
    expect(conchPluginServerRunnable(scratch())).toEqual({ ok: false, why: "conch's plugin isn't installed in this account" });
    expect(conchPluginServerRunnable(account(null, { plugins: { "other@x": [{ installPath: "/x" }] } }).claudeDir).ok).toBe(false);
    expect(conchPluginServerRunnable(account({ mcpServers: {} }).claudeDir)).toMatchObject({ ok: false, why: expect.stringContaining("names no program") });
    expect(conchPluginServerRunnable(account(null).claudeDir)).toMatchObject({ ok: false, why: expect.stringContaining("can't be read") });
  });
});
