import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callOutcome,
  createMcpToolHandlers,
  defaultMcpDependencies,
  dispatchJsonRpc,
  mcpCallCaller,
  mcpToolVocabulary,
  runMcpServer,
  type McpDependencies,
  type McpToolHandlers,
} from "../src/mcp.ts";
import {
  appendMcpCall,
  argumentNames,
  backendOfClient,
  cleanCallError,
  errorGroup,
  formatMcpUsage,
  McpCallLog,
  mcpCallRecord,
  mcpUsagePath,
  parseSince,
  percentile,
  readMcpCalls,
  runMcpUsageCli,
  summariseMcpCalls,
  type McpCallObservation,
  type McpCallRecord,
} from "../src/mcp-usage.ts";
import { AmbiguousSessionError, type SessionInfo } from "../src/sessions.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "conch-mcp-usage-"));
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as McpCallRecord);

const SESSION: SessionInfo = { sessionId: "session-abc", name: "Build", cwd: "/work/build", pid: 4321, status: "idle" };
const CONFIG = { claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock", sessionsPath: "/virtual/sessions.json" };

/** Fakes for every dependency a handler can reach; the caller is verified when `parentPid` is SESSION's pid. */
function fakes(overrides: Partial<McpDependencies> = {}): McpDependencies {
  return {
    ...defaultMcpDependencies,
    async readSessionsFile() { return null; },
    async registrySnapshot() { return { infos: [SESSION], liveIds: new Set([SESSION.sessionId]), complete: true }; },
    async findSessionByName() { return null; },
    findTranscript() { return undefined; },
    sessionLabel: () => "Build",
    async sendToDaemon() { return false; },
    async sendControlMessage() { return { ok: false, reason: "daemon-down" } as never; },
    now: () => 1_000_000,
    parentPid: () => 999_999,
    ...overrides,
  };
}

/** One tools/call through the real dispatch, and what its observer heard. */
async function observed(handlers: McpToolHandlers, name: string, args: unknown, meta?: unknown) {
  const heard: McpCallObservation[] = [];
  const response = await dispatchJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } },
    handlers,
    (call) => heard.push(call),
  );
  expect(heard).toHaveLength(1);
  return { call: heard[0]!, response };
}

describe("the call log's lines", () => {
  test("one line per call: when, tool, who, how long, how it ended, and only the argument names", () => {
    const path = join(scratch(), "nested", "mcp-usage.jsonl");
    const record = mcpCallRecord(
      { ts: 123, tool: "browser_type", ms: 41.6, outcome: "failed", error: "failed: no field matches \"hunter2-password\"", arguments: { tab: "t3", target: "hunter2-password", text: "my card is 4111 1111" } },
      { session: "session-abc", backend: "claude" },
    );
    appendMcpCall(record, path);
    const [line] = lines(path);
    expect(line).toEqual({
      ts: 123, tool: "browser_type", session: "session-abc", backend: "claude", ms: 42, outcome: "failed",
      error: "failed: no field matches \"<target>\"", args: ["tab", "target", "text"],
    });
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("4111");
  });

  test("owner-only: the file 0600, a folder it makes 0700, and an existing loose file narrowed", () => {
    const dir = scratch();
    const path = join(dir, "made", "mcp-usage.jsonl");
    appendMcpCall(mcpCallRecord({ ts: 1, tool: "conch_sessions", ms: 1, outcome: "ok" }), path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "made")).mode & 0o777).toBe(0o700);
    const loose = join(dir, "loose.jsonl");
    writeFileSync(loose, "");
    chmodSync(loose, 0o644);
    appendMcpCall(mcpCallRecord({ ts: 1, tool: "conch_sessions", ms: 1, outcome: "ok" }), loose);
    expect(statSync(loose).mode & 0o077).toBe(0);
  });

  test("never throws: an unwritable path, a folder in a file's place", () => {
    const dir = scratch();
    writeFileSync(join(dir, "file"), "");
    const record = mcpCallRecord({ ts: 1, tool: "conch_sessions", ms: 1, outcome: "ok" });
    expect(() => appendMcpCall(record, "/nope/nowhere/mcp-usage.jsonl")).not.toThrow();
    expect(() => appendMcpCall(record, join(dir, "file", "mcp-usage.jsonl"))).not.toThrow();
  });

  test("rotates past the cap, keeping one old file, and the summary reads both", () => {
    const path = join(scratch(), "mcp-usage.jsonl");
    appendMcpCall({ ts: 10, tool: "browser_open", ms: 5, outcome: "ok" }, path, 1);
    writeFileSync(path, `${readFileSync(path, "utf8")}${"x".repeat(64)}\n`);
    appendMcpCall({ ts: 20, tool: "browser_read", ms: 6, outcome: "ok" }, path, 32);
    expect(lines(path)).toEqual([{ ts: 20, tool: "browser_read", ms: 6, outcome: "ok" }]);
    expect(readFileSync(`${path}.1`, "utf8")).toContain("browser_open");
    // The junk line is skipped, not a crash.
    expect(readMcpCalls(path).map((record) => record.tool)).toEqual(["browser_open", "browser_read"]);
  });

  test("the live file sits in conch's config folder, and the suite's somewhere else", () => {
    expect(mcpUsagePath({ CONCH_CONFIG_DIR: "/c/conch" })).toBe("/c/conch/mcp-usage.jsonl");
    expect(mcpUsagePath({ CONCH_MCP_USAGE_FILE: "/x/u.jsonl", CONCH_CONFIG_DIR: "/c" })).toBe("/x/u.jsonl");
    expect(mcpUsagePath()).toBe(process.env.CONCH_MCP_USAGE_FILE!);
    expect(mcpUsagePath().startsWith(process.env.CONCH_TEST_ROOT!) || mcpUsagePath().startsWith(tmpdir())).toBe(true);
  });
});

describe("what an error may say", () => {
  test("every argument value is replaced by its name, nested and trimmed ones included", () => {
    const said = cleanCallError(
      "no live session matching \"Secret Launch\" and url /work/build/draft-notes.htm is not an .html page",
      { session: "  Secret Launch ", publish: { summary: "draft-notes.htm" } },
      "/Users/someone",
    );
    expect(said).toBe("no live session matching \"<session>\" and url /work/build/<publish> is not an .html page");
  });

  test("the tools' own words stay: an enum value is the message's word, not the user's", () => {
    const vocabulary = mcpToolVocabulary();
    expect(vocabulary.has("pause")).toBe(true);
    expect(vocabulary.has("end-silence")).toBe(true);
    expect(cleanCallError("action must be pause or resume", { action: "pause" }, "/h", vocabulary)).toBe("action must be pause or resume");
    expect(cleanCallError("\"bypass-permissions\" is not a setting an agent may change", { key: "bypass-permissions", value: true }, "/h", vocabulary))
      .toBe("\"bypass-permissions\" is not a setting an agent may change");
  });

  test("token-shaped text is redacted, home is ~, whitespace collapses, and it is capped", () => {
    const said = cleanCallError(
      "failed:\n  Bearer abc.def token=s3cr3t-value sk-ant-api03-ABCDEFGHIJKLMNOP at /Users/someone/Projects/x "
        + `${"a1".repeat(30)} ${"word ".repeat(100)}`,
      undefined,
      "/Users/someone",
    );
    expect(said).toStartWith("failed: Bearer <redacted> token=<redacted> <redacted> at ~/Projects/x <redacted> word");
    expect(said.length).toBeLessThanOrEqual(300);
    expect(said).toEndWith("…");
    // A session id is an id, not a secret.
    expect(cleanCallError("you are 0f8b5a3c-1111-2222-3333-444455556666", undefined, "/h")).toContain("0f8b5a3c-1111");
  });

  test("argument names only, sorted, and only identifier characters", () => {
    expect(argumentNames({ url: 1, "a b<c>": 2, tab: 3 })).toEqual(["a_b_c_", "tab", "url"]);
    expect(argumentNames({})).toBeUndefined();
    expect(argumentNames("nope")).toBeUndefined();
  });

  test("the backend a client names itself as", () => {
    expect(backendOfClient("claude-code")).toBe("claude");
    expect(backendOfClient("codex-mcp-client")).toBe("codex");
    expect(backendOfClient("inspector")).toBeUndefined();
    expect(backendOfClient(undefined)).toBeUndefined();
  });
});

describe("how a call ended", () => {
  const handlers = (overrides: Partial<McpDependencies> = {}) => createMcpToolHandlers(CONFIG, fakes(overrides));

  test("ok, with how long it took", async () => {
    const { call } = await observed(handlers(), "conch_on_screen", {});
    expect(call).toMatchObject({ tool: "conch_on_screen", outcome: "ok" });
    expect(call.error).toBeUndefined();
    expect(call.ms).toBeGreaterThanOrEqual(0);
  });

  test("input-error: an unknown argument, an unknown tool, arguments that aren't an object, a session nobody has", async () => {
    expect((await observed(handlers(), "conch_on_screen", { nope: 1 })).call).toMatchObject({ outcome: "input-error", error: "unknown argument \"nope\"" });
    expect((await observed(handlers(), "conch_spawn", {})).call).toMatchObject({ tool: "conch_spawn", outcome: "input-error", error: "unknown tool" });
    expect((await observed(handlers(), "conch_on_screen", "text")).call).toMatchObject({ outcome: "input-error" });
    expect((await observed(handlers(), "conch_wake", { session: "Nobody" })).call).toMatchObject({ outcome: "input-error" });
    expect(callOutcome(new AmbiguousSessionError("Build", [{ sessionId: "a", label: "Build" }, { sessionId: "b", label: "Build" }]))).toBe("input-error");
  });

  test("a pre-flight says every error as refused, and the log still tells a bad argument from a refusal", async () => {
    const bad = await observed(handlers(), "browser_open", { url: "ftp://nope" });
    expect(bad.call.outcome).toBe("input-error");
    expect(bad.call.error).toStartWith("refused: url must be an http(s) URL");
    // Unverified: this server's parent is no session's.
    expect((await observed(handlers(), "browser_read", {})).call).toMatchObject({ outcome: "refused" });
    expect((await observed(handlers(), "conch_deliverables", {})).call).toMatchObject({ outcome: "refused" });
    expect((await observed(handlers(), "conch_config", { key: "bypass-permissions", value: true })).call).toMatchObject({ outcome: "refused" });
  });

  test("failed: the daemon down, a broken registry read inside a pre-flight, a history reply that is an error", async () => {
    const down = await observed(handlers({ async findSessionByName() { return SESSION; } }), "conch_wake", { session: "Build" });
    expect(down.call).toMatchObject({ outcome: "failed", error: "conch daemon is not running" });
    const broken = await observed(handlers({ async registrySnapshot() { throw new Error("EIO: registry unreadable"); } }), "review_to_front", { summary: "A result" });
    expect(broken.call).toMatchObject({ outcome: "failed", error: "refused: EIO: registry unreadable" });
    const history = await observed(handlers(), "conch_history", { session: "recorded-session" });
    expect(history.call.outcome).toBe("failed");
    expect(history.call.error).toStartWith("unavailable:");
  });

  test("refused, said as a result: speech the user's manual mode drops, a wake whose audio another Mac holds", async () => {
    const paused = JSON.stringify({ mode: { paused: true }, audioControl: { holder: "studio-mac", expiresAt: null } });
    const deps = { async readSessionsFile() { return paused; }, async sendToDaemon() { return true; }, async findSessionByName() { return SESSION; } };
    const speak = await observed(handlers(deps), "conch_speak", { text: "Done." });
    expect(speak.call.outcome).toBe("refused");
    expect(speak.call.error).toStartWith("not spoken: conch is in manual mode");
    const wake = await observed(handlers(deps), "conch_wake", { session: "Build" });
    expect(wake.call.outcome).toBe("refused");
    expect(wake.call.error).toContain("yielded its audio to studio-mac");
  });

  test("an observer that throws breaks nothing", async () => {
    const response = await dispatchJsonRpc(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "conch_on_screen", arguments: {} } },
      handlers(),
      () => { throw new Error("observer broke"); },
    );
    expect(response?.id).toBe(7);
    expect(response?.error).toBeUndefined();
  });
});

describe("who called", () => {
  test("the verified session and its backend, read once a minute", async () => {
    let reads = 0;
    let now = 1_000_000;
    const caller = mcpCallCaller(() => CONFIG, fakes({
      async registrySnapshot() { reads += 1; return { infos: [SESSION], liveIds: new Set([SESSION.sessionId]), complete: true }; },
      parentPid: () => SESSION.pid!,
      now: () => now,
    }));
    expect(await caller(undefined)).toEqual({ session: "session-abc", backend: "claude" });
    expect(await caller(undefined)).toEqual({ session: "session-abc", backend: "claude" });
    expect(reads).toBe(1);
    now += 61_000;
    await caller(undefined);
    expect(reads).toBe(2);
  });

  test("a Codex thread the client names, verified or not", async () => {
    const codex: SessionInfo = { sessionId: "thread-1", backend: "codex", status: "idle" };
    const caller = mcpCallCaller(() => CONFIG, fakes({
      async registrySnapshot() { return { infos: [codex], liveIds: new Set(["thread-1"]), complete: true }; },
    }));
    const meta = (thread: string) => ({ "x-codex-turn-metadata": JSON.stringify({ thread_id: thread }) });
    expect(await caller(meta("thread-1"))).toEqual({ session: "thread-1", backend: "codex" });
    expect(await caller(meta("thread-gone"))).toEqual({ session: "thread-gone", backend: "codex" });
  });

  test("nothing, when the registry can't be read", async () => {
    const caller = mcpCallCaller(() => CONFIG, fakes({ async registrySnapshot() { throw new Error("EIO"); }, parentPid: () => 4321 }));
    expect(await caller(undefined)).toEqual({});
  });
});

describe("the recorder", () => {
  test("returns at once: who called is asked after, and the client's backend fills in for an unknown session", async () => {
    const written: McpCallRecord[] = [];
    let answer: ((caller: object) => void) | undefined;
    const log = new McpCallLog({
      caller: () => new Promise((resolve) => { answer = resolve; }),
      backendHint: () => "codex",
      append: (record) => written.push(record),
    });
    log.observe({ ts: 1, tool: "browser_tabs", ms: 3, outcome: "ok", arguments: {} });
    // Nothing on the call's own turn: not even the question of who called.
    expect(answer).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(written).toHaveLength(0);
    answer!({});
    await log.flush();
    expect(written).toEqual([{ ts: 1, tool: "browser_tabs", backend: "codex", ms: 3, outcome: "ok" }]);
  });

  test("a caller that throws still gets its line; one that never answers doesn't hold the exit", async () => {
    const written: McpCallRecord[] = [];
    const throwing = new McpCallLog({ caller: async () => { throw new Error("no"); }, append: (record) => written.push(record) });
    throwing.observe({ ts: 2, tool: "browser_read", ms: 1, outcome: "ok" });
    await throwing.flush();
    expect(written.map((record) => record.tool)).toEqual(["browser_read"]);
    const stuck = new McpCallLog({ caller: () => new Promise(() => {}), append: (record) => written.push(record) });
    stuck.observe({ ts: 3, tool: "browser_read", ms: 1, outcome: "ok" });
    const started = performance.now();
    await stuck.flush(50);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("the stdio server writes one line per call, with the backend its client named and no argument values", async () => {
    const path = join(scratch(), "mcp-usage.jsonl");
    const frames = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "codex-mcp-client", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "conch_rename", arguments: { session: "Private Project Name", label: "Another Private Name" } } },
    ];
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n"));
        controller.close();
      },
    });
    const out: string[] = [];
    await runMcpServer({
      handlers: createMcpToolHandlers(CONFIG, fakes()),
      input,
      writeLine: (line) => void out.push(line),
      callLog: new McpCallLog({ path, caller: async () => ({}), vocabulary: mcpToolVocabulary() }),
    });
    expect(out).toHaveLength(2);
    const written = lines(path);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ tool: "conch_rename", outcome: "input-error", args: ["label", "session"], error: "no live session matching \"<session>\"" });
    expect(readFileSync(path, "utf8")).not.toContain("Private");
  });

  test("by default the server logs to the configured file, naming the client's backend", async () => {
    const path = process.env.CONCH_MCP_USAGE_FILE!;
    const before = readMcpCalls(path).length;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claude-code" } } }),
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "conch_on_screen", arguments: {} } }),
        ].join("\n") + "\n"));
        controller.close();
      },
    });
    await runMcpServer({ config: CONFIG, dependencies: fakes(), input, writeLine: () => {} });
    const after = readMcpCalls(path);
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toMatchObject({ tool: "conch_on_screen", backend: "claude", outcome: "ok" });
  });
});

describe("conch mcp-usage", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  const day = 86_400_000;
  const records: McpCallRecord[] = [
    { ts: now - 10 * day, tool: "browser_open", ms: 9_999, outcome: "ok" },
    ...[100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((ms, index): McpCallRecord => ({
      ts: now - day + index, tool: "browser_open", session: index < 6 ? "s1" : "s2", backend: "claude", ms, outcome: "ok",
    })),
    { ts: now - day, tool: "browser_click", session: "s1", ms: 50, outcome: "failed", error: "failed: tab t7 is gone" },
    { ts: now - day, tool: "browser_click", session: "s1", ms: 60, outcome: "failed", error: "failed: tab t12 is gone" },
    { ts: now - day, tool: "browser_click", session: "s2", backend: "codex", ms: 70, outcome: "refused", error: "refused: conch cannot verify which session is calling (pid 812)" },
    { ts: now - day, tool: "review_to_front", ms: 5, outcome: "input-error", error: "summary must be a non-empty string" },
  ];

  test("per tool: calls, sessions, errors by outcome, p50/p90, the commonest errors grouped", () => {
    const summary = summariseMcpCalls(records, { since: now - 7 * day, until: now, path: "/x" });
    expect(summary.calls).toBe(14);
    expect(summary.errors).toBe(4);
    expect(summary.sessions).toBe(2);
    expect(summary.outcomes).toEqual({ ok: 10, "input-error": 1, refused: 1, failed: 2 });
    const [open, click] = summary.tools;
    expect(open).toMatchObject({ tool: "browser_open", calls: 10, sessions: 2, errors: 0, p50ms: 500, p90ms: 900 });
    expect(click).toMatchObject({ tool: "browser_click", calls: 3, errors: 2 + 1, errorRate: 1 });
    expect(click!.topErrors).toEqual([
      { outcome: "failed", error: "failed: tab N is gone", count: 2 },
      { outcome: "refused", error: "refused: conch cannot verify which session is calling (pid N)", count: 1 },
    ]);
  });

  test("one session, or every session's own line", () => {
    expect(summariseMcpCalls(records, { since: 0, session: "s2" }).calls).toBe(5);
    const bySession = summariseMcpCalls(records, { since: now - 7 * day, bySession: true }).bySession!;
    expect(bySession.map((row) => [row.session, row.calls, row.errors])).toEqual([["s1", 8, 2], ["s2", 5, 1], ["(unknown)", 1, 1]]);
    expect(bySession[1]!.tools).toEqual({ browser_open: 4, browser_click: 1 });
  });

  test("percentiles by nearest rank", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.9)).toBe(4);
  });

  test("errors grouped: ids, urls, paths, quotes and numbers collapsed", () => {
    expect(errorGroup("failed: no element matches \"Sign in\" on https://example.com/a?b=1"))
      .toBe("failed: no element matches \"…\" on <url>");
    expect(errorGroup("refused: ~/Projects/x is not a folder (session 0f8b5a3c-1111-2222-3333-444455556666)"))
      .toBe("refused: <path> is not a folder (session <id>)");
  });

  test("--since: a span or a date", () => {
    expect(parseSince("7d", now)).toBe(now - 7 * day);
    expect(parseSince("24h", now)).toBe(now - day);
    expect(parseSince("90m", now)).toBe(now - 90 * 60_000);
    expect(parseSince("2w", now)).toBe(now - 14 * day);
    expect(parseSince("2026-10-01", now)).toBe(Date.parse("2026-10-01"));
    expect(parseSince("soon", now)).toBeNull();
    expect(parseSince("7", now)).toBeNull();
  });

  test("the command: a 7-day table by default, --json, --since, and a usage error for anything else", () => {
    const path = join(scratch(), "mcp-usage.jsonl");
    for (const record of records) appendMcpCall(record, path);
    const table = runMcpUsageCli([], path, now);
    expect(table.code).toBe(0);
    expect(table.lines.join("\n")).toContain("14 calls · 2 sessions · 4 errors (input 1, refused 1, failed 2)");
    expect(table.lines.some((line) => line.startsWith("browser_open") && /\b500\s+900$/.test(line))).toBe(true);
    const json = runMcpUsageCli(["--since=30d", "--json", "--by-session"], path, now);
    const parsed = JSON.parse(json.lines.join("\n"));
    expect(parsed.calls).toBe(15);
    expect(parsed.bySession).toHaveLength(3);
    expect(JSON.parse(runMcpUsageCli(["--session", "s2", "--json"], path, now).lines[0]!).calls).toBe(5);
    expect(runMcpUsageCli(["--since", "later"], path, now).code).toBe(2);
    expect(runMcpUsageCli(["--verbose"], path, now).code).toBe(2);
    expect(runMcpUsageCli([], join(scratch(), "none.jsonl"), now).lines.at(-1)).toBe("no calls recorded in this window");
  });

  test("the table names the window and file even when it is empty", () => {
    const lines = formatMcpUsage(summariseMcpCalls([], { since: now - day, until: now, path: "/x/mcp-usage.jsonl" }));
    expect(lines[0]).toContain("/x/mcp-usage.jsonl");
  });
});
