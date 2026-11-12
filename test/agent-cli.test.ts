import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_EXIT, isCodexCommand, runAgentCli, shellIdentity } from "../src/agent-cli.ts";
import { CODEX_THREAD_ENV, sessionForShell, type ShellCaller } from "../src/caller-session.ts";
import { appServerNoTerminal } from "../src/codex-threads.ts";
import {
  createMcpToolHandlers,
  defaultMcpDependencies,
  dispatchJsonRpc,
  listedMcpTools,
  MCP_LISTED_TOOLS,
  MCP_MOVED_TOOL_NAMES,
  MCP_TOOLS,
  runMcpServer,
  type McpDependencies,
} from "../src/mcp.ts";
import { McpCallLog, readMcpCalls, type McpCallRecord } from "../src/mcp-usage.ts";
import type { BugReportRequest } from "../src/bug-report.ts";
import type { RegistrySnapshot, SessionInfo } from "../src/sessions.ts";

/**
 * `conch agent` from an agent's shell (agent-cli.ts), and the MCP that is left (mcp.ts). 2026-11-11, Tyler: "I would
 * also like to add a cli cause I think it might be better to put all our stuff in for agents to use without killing
 * context and then the mcp can be more minimal? Also tool for them to submit bugs if possible."
 */

const CONFIG = { claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock", sessionsPath: "/virtual/sessions.json" };
const alpha: SessionInfo = { sessionId: "s-alpha", name: "Alpha", cwd: "/work/alpha", status: "busy", pid: 500, backend: "claude" };
const beta: SessionInfo = { sessionId: "s-beta", name: "Beta", cwd: "/work/beta", status: "idle", pid: 600, backend: "claude" };
const snapshotOf = (infos: SessionInfo[]): RegistrySnapshot => ({ infos, liveIds: new Set(infos.map((one) => one.sessionId)), complete: true });

const published = {
  v: 1,
  ts: 1_000,
  mode: { paused: false, muted: false, holding: 0 },
  live: { state: "idle", label: "" },
  rows: [
    { id: "s-alpha", label: "Alpha", status: "working", reviews: [{ id: "r-1", artifact: "a-1", version: 1, kind: "page", summary: "The pricing page", link: "/work/alpha/pricing.html", at: 900 }] },
    { id: "s-beta", label: "Beta", status: "waiting" },
  ],
  dismissed: [],
};

function dependencies(overrides: Partial<McpDependencies> = {}): McpDependencies {
  return {
    ...defaultMcpDependencies,
    readSessionsFile: async () => JSON.stringify(published),
    registrySnapshot: async () => snapshotOf([alpha, beta]),
    findSessionByName: async (_dir, query) => [alpha, beta].find((one) => one.sessionId === query || one.name === query) ?? null,
    findTranscript: () => undefined,
    sessionLabel: (session) => session?.name ?? session?.sessionId ?? "unnamed",
    sendControlMessage: async () => ({ ok: false, reason: "daemon-down" }),
    readSessionSignIns: () => [],
    now: () => 2_000,
    parentPid: () => 999_999,
    ...overrides,
  };
}

const verifiedAs = (session: SessionInfo): (() => Promise<ShellCaller>) => async () => ({
  binding: { status: "verified", session },
  via: `process tree: this shell runs under pid ${session.pid}, the session's own process`,
  pid: session.pid,
});
const unverifiedShell = async (): Promise<ShellCaller> => ({ binding: { status: "unverified", reason: "no live session conch knows started pid 4242" } });

async function agent(argv: string[], options: { caller?: () => Promise<ShellCaller>; deps?: Partial<McpDependencies>; cwd?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const logged: McpCallRecord[] = [];
  const code = await runAgentCli({
    argv,
    config: CONFIG,
    cwd: options.cwd ?? "/work/alpha",
    dependencies: dependencies(options.deps),
    shellCaller: options.caller ?? verifiedAs(alpha),
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    log: (record) => void logged.push(record),
    now: () => 2_000,
  });
  return { code, out: out.join("\n"), err: err.join("\n"), logged };
}

describe("conch agent, from a shell", () => {
  test("whoami says which session conch takes the shell for, and how it knows", async () => {
    const mine = await agent(["whoami"]);
    expect(mine.code).toBe(0);
    expect(mine.out.split("\n")).toEqual([
      "caller: verified",
      "session: s-alpha",
      "label: Alpha",
      "backend: claude",
      "cwd: /work/alpha",
      "via: process tree: this shell runs under pid 500, the session's own process",
    ]);
    const nobody = await agent(["whoami"], { caller: unverifiedShell });
    expect(nobody.code).toBe(0);
    expect(nobody.out).toContain("caller: unverified");
    expect(nobody.out).toContain("reason: no live session conch knows started pid 4242");
  });

  test("a command on your own session runs as that session, and is refused, saying why, when conch can't tell", async () => {
    const mine = await agent(["deliverables"]);
    expect(mine.code).toBe(0);
    expect(mine.out).toContain("sessionId: s-alpha");
    expect(mine.out).toContain('- id=r-1 artifact=a-1 version=1 kind=page summary="The pricing page" link=/work/alpha/pricing.html at=900 superseded=false');
    const nobody = await agent(["deliverables"], { caller: unverifiedShell });
    expect(nobody.code).toBe(AGENT_EXIT.refused);
    expect(nobody.err).toContain("conch cannot verify which session is calling (no live session conch knows started pid 4242)");
    expect(nobody.err).toContain("The conch_run tool runs the same command with your MCP server's own proof of who you are (command: \"deliverables\")");
    expect(nobody.out).toBe("");
  });

  test("every command is logged as the tool it runs, marked via cli, under the verified session", async () => {
    const { logged } = await agent(["deliverables", "--json"]);
    expect(logged).toEqual([{ ts: 2_000, tool: "conch_deliverables", session: "s-alpha", backend: "claude", ms: expect.any(Number), outcome: "ok", via: "cli" }]);
    // A command named but called wrong is the agent's input error, under the tool's name, as a bad tool call was.
    const wrong = await agent(["capture", "https://x.dev", "--sel", ".a"]);
    expect(wrong.code).toBe(AGENT_EXIT["input-error"]);
    expect(wrong.err).toContain("unknown option --sel");
    expect(wrong.err).toContain("usage: conch agent capture <url>");
    expect(wrong.logged).toMatchObject([{ tool: "conch_capture", outcome: "input-error", via: "cli" }]);
  });

  test("a session name that matches none lists the live sessions, which the log leaves out", async () => {
    const missing = await agent(["tail", "Gamma"]);
    expect(missing.code).toBe(AGENT_EXIT["input-error"]);
    expect(missing.err).toContain('no live session matching "Gamma"; live sessions: s-alpha "Alpha", s-beta "Beta"');
    expect(missing.err).toContain("usage: conch agent tail <session>");
    expect(missing.logged[0]!.error).toBe('no live session matching "<session>"');
  });

  test("relative paths are the shell's folder's", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "conch-agent-folders-")));
    const recorded: Array<{ id: string; folders: readonly string[] }> = [];
    const result = await agent(["folders", "."], { cwd: folder, deps: { setWorkingFolders: (id, folders) => void recorded.push({ id, folders }) } });
    expect(result.code).toBe(0);
    expect(recorded).toEqual([{ id: "s-alpha", folders: [folder] }]);
  });

  test("help is printed whole, and --json prints the answer as one line of JSON", async () => {
    const help = await agent(["help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("conch agent <command> [--json]");
    const json = await agent(["whoami", "--json"]);
    expect(JSON.parse(json.out)).toMatchObject({ caller: "verified", session: "s-alpha" });
    expect(json.out).not.toContain("\n");
  });
});

describe("conch bug", () => {
  const report = ["bug", "The pill never lit after a publish", "--happened", "publish said filed, no pill", "--expected", "the Ready pill", "--area", "publish"];

  test("the daemon files it and the answer gives the ticket's number; it carries the verified session", async () => {
    const sent: BugReportRequest[] = [];
    const filed = await agent(report, {
      deps: {
        fileBug: async (_socket, request) => {
          sent.push(request);
          return { ok: true, reply: { kind: "bug-filed", outcome: "opened", ticket: 48, status: "open", count: 1, sessions: 1, said: "filed as #48, a new ticket in Settings › Failures on this Mac" } };
        },
      },
    });
    expect(filed.code).toBe(0);
    expect(filed.out).toContain("ticket: 48");
    expect(filed.out).toContain("outcome: opened");
    expect(filed.out).toContain("session: s-alpha");
    expect(sent).toEqual([expect.objectContaining({
      kind: "bug-report",
      from: "s-alpha",
      report: { title: "The pill never lit after a publish", happened: "publish said filed, no pill", expected: "the Ready pill", area: "publish" },
      via: expect.stringContaining("process tree"),
      backend: "claude",
    })]);
    expect(filed.logged).toMatchObject([{ tool: "conch_bug", outcome: "ok", via: "cli" }]);
  });

  test("from a shell conch can't tie to a session it is filed under none, and says so", async () => {
    const sent: BugReportRequest[] = [];
    const filed = await agent(report, {
      caller: unverifiedShell,
      deps: { fileBug: async (_socket, request) => (sent.push(request), { ok: true, reply: { kind: "bug-filed", outcome: "counted", ticket: 48, status: "open", count: 2, sessions: 1, said: "…" } }) },
    });
    expect(filed.code).toBe(0);
    expect(sent[0]!.from).toBe("unverified");
    expect(sent[0]!.via).toBe("unverified: no live session conch knows started pid 4242");
    expect(filed.out).toContain("filed under no session");
  });

  test("its words are checked before anything is sent, and a refusal is the daemon's", async () => {
    const missing = await agent(["bug", "Something broke", "--expected", "it works"]);
    expect(missing.code).toBe(AGENT_EXIT["input-error"]);
    expect(missing.err).toContain("happened is missing: --happened says what you saw");
    const limited = await agent(report, { deps: { fileBug: async () => ({ ok: true, reply: { kind: "bug-error", refused: true, error: "refused: this session has filed 5 bugs in the last hour, the most it may." } }) } });
    expect(limited.code).toBe(AGENT_EXIT.refused);
    expect(limited.err).toContain("filed 5 bugs in the last hour");
  });

  test("a daemon older than conch bug: nothing is filed, and it says so rather than that it may have been", async () => {
    const written: unknown[] = [];
    const older = await agent(report, { deps: { fileBug: async () => ({ ok: false, reason: "older" }), recordBugOffline: (record) => void written.push(record) } });
    expect(older.code).toBe(AGENT_EXIT.failed);
    expect(older.err).toContain("conch's daemon is older than conch bug and can't file it, so nothing was filed");
    expect(written).toEqual([]);
  });

  test("the daemon down: the report goes in conch's records, for the desk to file when it starts", async () => {
    const written: unknown[] = [];
    const offline = await agent(report, {
      deps: {
        fileBug: async () => ({ ok: false, reason: "daemon-down" }),
        recordBugOffline: (record) => void written.push(record),
      },
    });
    expect(offline.code).toBe(0);
    expect(offline.out).toContain("outcome: recorded");
    expect(offline.out).toContain("no ticket number yet");
    expect(written).toEqual([expect.objectContaining({ source: "bug", operation: "publish", message: "The pill never lit after a publish", sessionId: "s-alpha" })]);
  });
});

describe("which session a shell is", () => {
  const table = (entries: Array<[number, number, string]>) => async () => ({
    parents: new Map(entries.map(([pid, ppid]) => [pid, ppid])),
    names: new Map(entries.map(([pid, , name]) => [pid, name])),
  });

  test("the nearest session above the shell, read cheaply when it is Claude's", async () => {
    const asked: boolean[] = [];
    const found = await shellIdentity({
      pid: 900,
      env: {},
      claudeDir: CONFIG.claudeDir,
      table: table([[900, 800, "bun"], [800, 500, "zsh"], [500, 1, "claude"]]),
      snapshot: async (skipCodex) => (asked.push(skipCodex), snapshotOf([alpha])),
    });
    expect(found).toEqual({ binding: { status: "verified", session: alpha }, via: "process tree: this shell runs under pid 500, the session's own process", pid: 500 });
    // Claude's sessions alone: the Codex probe a fresh process can't afford was never run.
    expect(asked).toEqual([true]);
  });

  test("a Codex between the shell and that Claude is read again in full, and the Codex wins", async () => {
    const codex: SessionInfo = { sessionId: "codex-1", pid: 850, backend: "codex" };
    const found = await shellIdentity({
      pid: 900,
      env: {},
      claudeDir: CONFIG.claudeDir,
      table: table([[900, 850, "bun"], [850, 500, "/opt/homebrew/bin/codex"], [500, 1, "claude"]]),
      snapshot: async (skipCodex) => snapshotOf(skipCodex ? [alpha] : [alpha, codex]),
    });
    expect(found.binding).toEqual({ status: "verified", session: codex });
  });

  test("a Codex is its executable, or node running its script; a shell that only mentions it is not", () => {
    expect(isCodexCommand("/opt/homebrew/Caskroom/codex/0.167.1/bin/codex --yolo")).toBe(true);
    expect(isCodexCommand("node /usr/local/lib/node_modules/@openai/codex/bin/codex.js")).toBe(true);
    expect(isCodexCommand("codex app-server")).toBe(true);
    expect(isCodexCommand("/bin/zsh -c eval 'conch agent tail codex-thread'")).toBe(false);
    expect(isCodexCommand("claude --resume x")).toBe(false);
  });

  test("no session above the shell (the owner's terminal) is unverified, with why", async () => {
    const found = await shellIdentity({ pid: 900, env: {}, claudeDir: CONFIG.claudeDir, table: table([[900, 1, "zsh"]]), snapshot: async () => snapshotOf([alpha]) });
    expect(found.binding).toEqual({ status: "unverified", reason: "no live session conch knows started pid 900" });
  });

  test("under a Codex app-server, CODEX_THREAD_ID names the thread, and only one that app-server hosts", async () => {
    const thread = (id: string, appServer: number): SessionInfo => ({ sessionId: id, backend: "codex", noTerminal: appServerNoTerminal(appServer) });
    const infos = [thread("t-1", 700), thread("t-2", 700), thread("t-9", 701)];
    const parents = async () => new Map([[900, 700], [700, 1]]);
    const shell = (env: Record<string, string>) => sessionForShell({ pid: 900, env, infos, claudeDir: CONFIG.claudeDir, parents });
    expect((await shell({ [CODEX_THREAD_ENV]: "t-2" })).binding).toEqual({ status: "verified", session: infos[1] });
    expect((await shell({ [CODEX_THREAD_ENV]: "t-2" })).via).toBe("CODEX_THREAD_ID, one of the threads Codex app-server pid 700 hosts");
    // A thread of another app-server is no proof, whatever the variable says.
    expect((await shell({ [CODEX_THREAD_ENV]: "t-9" })).binding).toEqual({
      status: "unverified", reason: "CODEX_THREAD_ID t-9 is not a thread the Codex app-server above this shell (pid 700) hosts",
    });
    const none = (await shell({})).binding;
    expect(none.status).toBe("unverified");
    expect(none.status === "unverified" && none.reason).toContain("this shell has no CODEX_THREAD_ID to say which");
  });
});

describe("the MCP that is left", () => {
  test("a session started now is listed publishing and conch_run; one a hand-off serves keeps the moved tools it had", () => {
    expect(listedMcpTools().map((tool) => tool.name)).toEqual(["review_to_front", "conch_run"]);
    expect(MCP_LISTED_TOOLS.map((tool) => tool.name)).toEqual(["review_to_front", "conch_run"]);
    // A server older than this one, which listed every tool: the session keeps them all, so a call under way still lands.
    expect(listedMcpTools({}).map((tool) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name));
    // A server that said what it listed: those, and no more.
    expect(listedMcpTools({ inherited: ["review_to_front", "conch_run"] }).map((tool) => tool.name)).toEqual(["review_to_front", "conch_run"]);
    expect(listedMcpTools({ inherited: ["browser_open", "conch_sessions"] }).map((tool) => tool.name)).toEqual(["conch_sessions", "review_to_front", "browser_open", "conch_run"]);
    // The moved tools keep their schemas, and say where they went.
    for (const name of MCP_MOVED_TOOL_NAMES) {
      const tool = MCP_TOOLS.find((one) => one.name === name)!;
      expect(tool.description).toStartWith("Moved to conch's CLI: `conch agent ");
      expect(tool.description).toContain("a restart leaves only the CLI");
    }
  });

  test("a server that still lists a moved tool says, the first time it is called, which command it is now", async () => {
    const handlers = createMcpToolHandlers(CONFIG, dependencies());
    const context = { listed: listedMcpTools({}), movedHinted: new Set<string>() };
    const call = (id: number) => dispatchJsonRpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "conch_on_screen", arguments: {} } }, handlers, undefined, context);
    const first = (await call(1))?.result as { content: Array<{ text: string }> };
    expect(first.content).toHaveLength(2);
    expect(first.content[1]!.text).toBe("conch_on_screen is `conch agent on-screen` in your shell now (`conch agent help on-screen`); this tool keeps working here until the session restarts.");
    expect(((await call(2))?.result as { content: unknown[] }).content).toHaveLength(1);
    // A session started now is told nothing: it never had the tool.
    const fresh = (await dispatchJsonRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "conch_on_screen", arguments: {} } }, handlers))?.result as { content: unknown[] };
    expect(fresh.content).toHaveLength(1);
  });

  test("tools/list is the server's own list, and a CLI-only command is never a tool", async () => {
    const lines: string[] = [];
    const input = new Blob([
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "conch_bug", arguments: {} } })}\n`,
    ]).stream();
    await runMcpServer({ handlers: createMcpToolHandlers(CONFIG, dependencies()), input, writeLine: (line) => void lines.push(line), callLog: false });
    const [list, bug] = lines.map((line) => JSON.parse(line));
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["review_to_front", "conch_run"]);
    expect(bug.error).toEqual({ code: -32602, message: 'Unknown tool "conch_bug"' });
  });

  test("conch_run runs the command with this server's verified caller, answers its text, and logs the tool it ran", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "conch-run-log-")), "mcp-usage.jsonl");
    const log = new McpCallLog({ path, caller: async () => ({ session: "s-alpha", backend: "claude" }) });
    const handlers = createMcpToolHandlers(CONFIG, dependencies({ parentPid: () => 500 }));
    const run = async (command: string) => (await dispatchJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "conch_run", arguments: { command } } }, handlers, log.observe))?.result as { content: Array<{ text: string }>; isError?: boolean };
    const whoami = await run("conch agent whoami");
    expect(whoami.isError).toBeUndefined();
    expect(whoami.content[0]!.text).toContain("via: this MCP server's parent process, which is the session");
    expect((await run("deliverables --json")).content[0]!.text).toStartWith('{"sessionId":"s-alpha"');
    const wrong = await run("capture https://x.dev --sel .a");
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0]!.text).toContain("unknown option --sel");
    expect(wrong.content[0]!.text).toContain("usage: conch agent capture");
    const missing = await run('tail "Gamma"');
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain('live sessions: s-alpha "Alpha"');
    expect((await run("help")).content[0]!.text).toContain("conch agent <command> [--json]");
    await log.flush();
    expect(readMcpCalls(path).map(({ tool, outcome, via }) => ({ tool, outcome, via }))).toEqual([
      { tool: "conch_whoami", outcome: "ok", via: "run" },
      { tool: "conch_deliverables", outcome: "ok", via: "run" },
      { tool: "conch_run", outcome: "input-error", via: undefined },
      { tool: "conch_transcript_tail", outcome: "input-error", via: "run" },
      { tool: "conch_run", outcome: "ok", via: undefined },
    ]);
  });

  test("review_to_front's answers name the other tools by the commands they are now", async () => {
    const handlers = createMcpToolHandlers(CONFIG, dependencies({ parentPid: () => 999_999 }));
    const response = await dispatchJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "review_to_front", arguments: { summary: "x", artifactKey: "k" } } }, handlers);
    const text = (response?.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain('unknown argument "artifactKey": use key');
    expect(text).not.toMatch(/\bconch_(?:sessions|deliverables|working_folders)\b/);
  });
});
