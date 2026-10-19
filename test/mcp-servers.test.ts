import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_TOOL_NAMES, MCP_TOOLSET } from "../src/mcp-toolset.ts";
import { createMcpToolHandlers, defaultMcpDependencies, dispatchJsonRpc, MCP_TOOLS, runMcpServer } from "../src/mcp.ts";
import {
  HANDOFF_GRACE_MS,
  isConchMcpCommand,
  mcpServersDir,
  MCP_HANDOFF_LANDED,
  MCP_TOOLS_BEFORE_REPORTS,
  parseMcpServerProcesses,
  readMcpServerReports,
  toolsStaleFor,
  withToolsStale,
  writeMcpServerReport,
  type McpServerReport,
} from "../src/mcp-servers.ts";
import { staleToolsByRow } from "../src/mcp-sessions.ts";

/**
 * 2026-10-18 review: 16 of the 21 running `conch mcp` servers started before the browser tools existed and 18 before the
 * hand-off that upgrades a running server, so those sessions could never get them, and nothing said which. Each server
 * now reports what it has, and the daemon marks a session whose server can't get the current tools.
 */
const scratch = () => mkdtempSync(join(tmpdir(), "conch-mcp-servers-"));
const NOW = Date.parse("2026-10-19T12:00:00Z");
const report = (overrides: Partial<McpServerReport> = {}): McpServerReport => ({
  v: 1, pid: 5001, sessionPid: 4321, toolset: MCP_TOOLSET, tools: [...MCP_TOOL_NAMES], handoff: true, version: "0.0.0",
  startedAt: NOW - 3_600_000, ...overrides,
});
const judge = (overrides: Partial<Parameters<typeof toolsStaleFor>[0]>) => toolsStaleFor({
  sessionPid: 4321, reports: [], processes: [], currentTools: MCP_TOOL_NAMES, currentToolset: MCP_TOOLSET, now: NOW,
  since: NOW - 60 * 60_000, ...overrides,
});

describe("each server's report", () => {
  test("written, read back while its server runs, and removed once it has gone", () => {
    const dir = scratch();
    writeMcpServerReport(report({ pid: process.pid }), dir);
    writeMcpServerReport(report({ pid: 2 ** 30 }), dir);
    writeFileSync(join(dir, "77.json"), "{ torn");
    const alive = (pid: number) => pid === process.pid || pid === 77;
    expect(readMcpServerReports(dir, alive).map((one) => one.pid)).toEqual([process.pid]);
    expect(readdirSync(dir).sort()).toEqual(["77.json", `${process.pid}.json`].sort());
  });

  test("the stdio server reports its tools and its session while it runs, with its client once it says, and removes it at the end", async () => {
    const dir = scratch();
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } });
    const done = runMcpServer({
      handlers: createMcpToolHandlers({ claudeDir: "/virtual", socketPath: "/virtual/sock" }, defaultMcpDependencies),
      input,
      writeLine: () => {},
      callLog: false,
      report: { dir, pid: 6001, sessionPid: 4321 },
    });
    const file = join(dir, "6001.json");
    const read = () => JSON.parse(readFileSync(file, "utf8")) as McpServerReport;
    expect(read()).toMatchObject({ v: 1, pid: 6001, sessionPid: 4321, toolset: MCP_TOOLSET, tools: MCP_TOOLS.map((tool) => tool.name), handoff: false });
    expect(read()).not.toHaveProperty("client");
    feed.enqueue(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claude-code" } } })}\n`));
    for (let i = 0; i < 50 && !read().client; i += 1) await Bun.sleep(5);
    expect(read().client).toBe("claude");
    feed.close();
    await done;
    expect(existsSync(file)).toBe(false);
  });

  test("only the real stdio server reports by default: a test's server, given its input, does not", async () => {
    const input = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const dir = mcpServersDir();
    const before = existsSync(dir) ? readdirSync(dir) : [];
    await runMcpServer({ handlers: {} as never, input, writeLine: () => {}, callLog: false });
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual(before);
    expect(dir).toStartWith(process.env.CONCH_CONFIG_DIR!);
  });
});

describe("the conch mcp processes", () => {
  test("installed or from a checkout, by their command line, with when they started", () => {
    expect(isConchMcpCommand("/opt/homebrew/bin/conch mcp")).toBe(true);
    expect(isConchMcpCommand("conch mcp")).toBe(true);
    expect(isConchMcpCommand("/opt/homebrew/Cellar/bun/1.4.2/bin/bun run /Users/alex/Projects/Conch/src/cli.ts mcp")).toBe(true);
    expect(isConchMcpCommand("bun run /Users/alex/conch/src/cli.ts daemon")).toBe(false);
    expect(isConchMcpCommand("node /Users/alex/plugins/atlas/dist/cli.js --profile claude-code")).toBe(false);
    const listed = parseMcpServerProcesses([
      "94816 94777 Tue Sep 22 19:14:19 2026     /opt/homebrew/Cellar/bun/1.4.2/bin/bun run /Users/alex/Projects/Conch/src/cli.ts mcp",
      " 2650  2589 Wed Oct 14 17:00:41 2026     /opt/homebrew/bin/conch mcp",
      "  719 37382 Wed Oct 14 17:00:41 2026     /Users/alex/.codex/bin/codex app-server",
      "garbage",
    ].join("\n"));
    expect(listed.map(({ pid, ppid }) => [pid, ppid])).toEqual([[94816, 94777], [2650, 2589]]);
    expect(new Date(listed[0]!.startedAt).getDate()).toBe(22);
  });
});

describe("which sessions can't get the current tools", () => {
  test("a server that reports this build's toolset is current", () => {
    expect(judge({ reports: [report()] })).toBeUndefined();
  });

  test("a reporting server with an older toolset is stale once it has had its chance to hand over; a hand-off's server at once", () => {
    const older = report({ toolset: "older", tools: MCP_TOOL_NAMES.filter((name) => name !== "conch_fork") });
    expect(judge({ reports: [older], since: NOW - 60_000 })).toBeUndefined();
    expect(judge({ reports: [older], since: NOW - HANDOFF_GRACE_MS - 1 })).toMatchObject({
      missing: ["conch_fork"], basis: "reported", why: expect.stringContaining("could take a newer conch's tools but hasn't"),
    });
    expect(judge({ reports: [{ ...older, handoff: false }], since: NOW - 60_000 })).toMatchObject({
      missing: ["conch_fork"], why: expect.stringContaining("started by a hand-off"),
    });
    // After a hand-off the fresh server's report is the one that counts.
    expect(judge({ reports: [older, report({ pid: 5002, startedAt: NOW - 1_000 })], since: NOW - HANDOFF_GRACE_MS - 1 })).toBeUndefined();
  });

  test("a server too old to report, started before the hand-off, is stale with what it is missing by when it started", () => {
    const stale = judge({ processes: [{ pid: 94816, ppid: 4321, startedAt: Date.parse("2026-09-22T12:14:19Z") }], since: NOW - 60_000 });
    expect(stale).toMatchObject({ basis: "estimated", serverStartedAt: "2026-09-22T12:14:19.000Z" });
    expect(stale!.missing).toEqual(expect.arrayContaining(["browser_open", "browser_close", "atlas_show", "conch_fork"]));
    expect(stale!.missing).not.toContain("review_to_front");
    expect(stale!.why).toContain("before a running server could take a newer conch's tools");
    expect(stale!.fix).toContain("restart this session");
  });

  test("a silent server started after the hand-off gets its chance first; then it is stale too", () => {
    const later = [{ pid: 18829, ppid: 4321, startedAt: MCP_HANDOFF_LANDED + 3_600_000 }];
    expect(judge({ processes: later, since: NOW - 60_000 })).toBeUndefined();
    const stale = judge({ processes: later, since: NOW - HANDOFF_GRACE_MS - 1 });
    expect(stale?.missing).toEqual(MCP_TOOL_NAMES.filter((name) => !Object.hasOwn(MCP_TOOLS_BEFORE_REPORTS, name)));
    expect(stale?.why).toContain("hasn't taken the current tools");
  });

  test("no conch server for the session (no plugin there), or no pid, says nothing", () => {
    expect(judge({ processes: [{ pid: 1, ppid: 999, startedAt: 0 }] })).toBeUndefined();
    expect(judge({ sessionPid: undefined, processes: [{ pid: 1, ppid: 4321, startedAt: 0 }] })).toBeUndefined();
    expect(judge({ processes: null })).toBeUndefined();
  });

  test("on the sessions file's rows, and read back for conch sessions and conch_sessions", async () => {
    const stale = judge({ processes: [{ pid: 94816, ppid: 4321, startedAt: Date.parse("2026-09-22T12:14:19Z") }] })!;
    const state = withToolsStale({ v: 1, ts: NOW, rows: [{ id: "a", label: "Old" }, { id: "b", label: "New" }] }, new Map([["a", stale]]));
    expect(state.rows as unknown[]).toEqual([{ id: "a", label: "Old", toolsStale: stale }, { id: "b", label: "New" }]);
    expect(staleToolsByRow(JSON.stringify(state)).get("a")?.missing).toEqual(stale.missing);
    expect(staleToolsByRow("{ nope").size).toBe(0);
    const handlers = createMcpToolHandlers({ claudeDir: "/virtual", socketPath: "/virtual/sock" }, {
      ...defaultMcpDependencies,
      async readSessionsFile() { return JSON.stringify(state); },
      async registrySnapshot() { return null; },
      parentPid: () => 0,
      now: () => NOW,
    });
    const response = await dispatchJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "conch_sessions", arguments: {} } }, handlers);
    const listed = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]!.text);
    expect(listed.sessions.find((one: { id: string }) => one.id === "a").toolsStale.missing).toContain("conch_fork");
    expect(listed.sessions.find((one: { id: string }) => one.id === "b")).not.toHaveProperty("toolsStale");
  });

  test("the daemon publishes it on the sessions file, refreshed once a minute", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");
    expect(daemon).toContain("publishSessionsFile(withToolsStale(state, toolsStale));");
    expect(daemon).toContain("const toolsStaleTimer = setInterval(() => void refreshToolsStale().catch(() => {}), 60_000);");
  });

  test("a session conch closes or restarts loses its verdict at once, so the app's Restart doesn't come back for it", () => {
    // The verdict was about the process that just exited; the next look judges the one a restart resumes it in.
    const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");
    const close = daemon.slice(daemon.indexOf("const closeLiveSession = async"), daemon.indexOf("if (!relaunch) return;"));
    expect(close).toContain("await closeSession(session);\n");
    expect(close.indexOf("if (toolsStale.delete(sessionId)) publishedStateWriter.request();")).toBeGreaterThan(close.indexOf("await closeSession(session);"));
  });
});
