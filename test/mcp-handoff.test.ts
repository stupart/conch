import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_INSTRUCTIONS } from "../src/agent-instructions.ts";
import { HANDOFF_FROM_ENV, HANDOFF_PARENT_ENV, handoffParentPid, type HandoffChild } from "../src/mcp-handoff.ts";
import { MCP_TOOLSET, toolsetFingerprint } from "../src/mcp-toolset.ts";
import { initializeResult, MCP_TOOLS, runMcpServer, type McpToolHandlers } from "../src/mcp.ts";

/**
 * New tools for a session already running (mcp-handoff.ts): the server hands its stdio over to a fresh server of the
 * installed conch and tells the client `notifications/tools/list_changed`, which Claude Code and Codex act on.
 */

/** A fresh server, scripted: it answers its start, and every other request with what `answer` says. */
function freshServer(tools: Array<{ name: string; description: string }>, answer: (message: Record<string, any>) => unknown = () => ({ ok: true })) {
  const written: Array<Record<string, any>> = [];
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { exit = resolve; });
  let ended = false;
  const push = (line: string) => {
    queue.push(line);
    wake?.();
  };
  const child: HandoffChild & { killed: boolean } = {
    killed: false,
    write(line) {
      const message = JSON.parse(line);
      written.push(message);
      if (message.method === "initialize") push(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } } } }));
      else if (message.method === "tools/list") push(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools } }));
      else if (Object.hasOwn(message, "id")) {
        const result = answer(message);
        if (result !== undefined) push(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      }
    },
    lines: (async function* () {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    })(),
    exited,
    kill() {
      child.killed = true;
      ended = true;
      wake?.();
      exit(0);
    },
  };
  return { child, written, die: () => child.kill() };
}

/** The client's side: lines in, lines out, the server running until the input closes. */
function client(options: { published: () => string | undefined; spawn: () => HandoffChild; checkEveryMs?: number }) {
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const input = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } });
  const out: Array<Record<string, any>> = [];
  const diagnostics: string[] = [];
  let now = 0;
  const local: Array<{ name: string }> = [];
  const handlers = Object.fromEntries(MCP_TOOLS.map(({ name }) => [name, async () => {
    local.push({ name });
    return { answeredBy: "this server" };
  }])) as unknown as McpToolHandlers;
  let spawned = 0;
  const done = runMcpServer({
    handlers,
    input,
    writeLine: (line) => { out.push(JSON.parse(line)); },
    diagnostic: (message) => diagnostics.push(message),
    handoff: {
      ownToolset: MCP_TOOLSET,
      publishedToolset: async () => options.published(),
      spawn: () => { spawned += 1; return options.spawn(); },
      now: () => (now += 1_000),
      checkEveryMs: options.checkEveryMs ?? 0,
      replyMs: 500,
    },
  });
  const send = async (message: Record<string, unknown>) => {
    feed.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
    await Bun.sleep(20);
  };
  const start = async () => {
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } } });
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  return { send, start, out, diagnostics, local, spawned: () => spawned, close: async () => { feed.close(); await done; } };
}

const newer = [...MCP_TOOLS.map(({ name, description }) => ({ name, description })), { name: "conch_next", description: "A tool from a newer conch." }];

describe("handing over to a newer conch's server", () => {
  test("this build's toolset is its tools' own, and the server says its list can change", () => {
    expect(MCP_TOOLSET).toBe(toolsetFingerprint(MCP_TOOLS));
    expect(MCP_TOOLSET).toMatch(/^[0-9a-f]{16}$/);
    expect(toolsetFingerprint(newer)).not.toBe(MCP_TOOLSET);
    expect(Object.keys(AGENT_INSTRUCTIONS.tools)).toContain("atlas_show");
    expect(initializeResult({ protocolVersion: "2025-06-18" }).capabilities).toEqual({ tools: { listChanged: true } });
  });

  test("a newer toolset published: a fresh server is started with the client's initialize, and every line goes through it", async () => {
    const fresh = freshServer(newer, (message) => ({ answeredBy: "the fresh server", method: message.method }));
    const c = client({ published: () => "newer-toolset", spawn: () => fresh.child });
    await c.start();
    // The client's own initialize was answered here, then replayed to the fresh server; then the client was told.
    expect(c.out[0]).toMatchObject({ id: 1, result: { capabilities: { tools: { listChanged: true } } } });
    expect(fresh.written.map((message) => message.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(fresh.written[0]!.params).toEqual({ protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } });
    expect(c.out[1]).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    // The client asks again and gets the fresh server's tools; a call is the fresh server's to answer.
    await c.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(c.out[2]).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: newer } });
    await c.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "conch_next", arguments: {} } });
    expect(c.out[3]).toEqual({ jsonrpc: "2.0", id: 3, result: { answeredBy: "the fresh server", method: "tools/call" } });
    expect(c.local).toEqual([]);
    expect(c.spawned()).toBe(1);
    await c.close();
    expect(fresh.child.killed).toBe(true);
  });

  test("the same tools installed (the daemon is the newer one): the fresh server goes, nothing changes, and it isn't tried again", async () => {
    const fresh = freshServer(MCP_TOOLS.map(({ name, description }) => ({ name, description })));
    const c = client({ published: () => "newer-toolset", spawn: () => fresh.child });
    await c.start();
    expect(fresh.child.killed).toBe(true);
    expect(c.out.filter((message) => message.method === "notifications/tools/list_changed")).toEqual([]);
    expect(c.diagnostics.some((line) => line.includes("not handed over: the installed conch has these same tools"))).toBe(true);
    await c.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "conch_sessions", arguments: {} } });
    expect(c.local).toEqual([{ name: "conch_sessions" }]);
    await c.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "conch_sessions", arguments: {} } });
    expect(c.spawned()).toBe(1);
    await c.close();
  });

  test("this build's own toolset published, or none: never a fresh server", async () => {
    for (const published of [MCP_TOOLSET, undefined]) {
      const c = client({ published: () => published, spawn: () => { throw new Error("must not start"); } });
      await c.start();
      await c.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "conch_sessions", arguments: {} } });
      expect(c.spawned()).toBe(0);
      expect(c.local).toHaveLength(1);
      await c.close();
    }
  });

  test("not before the client has initialized, and at most once per check interval", async () => {
    let reads = 0;
    const c = client({ published: () => { reads += 1; return MCP_TOOLSET; }, spawn: () => { throw new Error("no"); }, checkEveryMs: 60_000 });
    await c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(reads).toBe(0);
    await c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    for (let id = 2; id < 6; id += 1) await c.send({ jsonrpc: "2.0", id, method: "tools/list" });
    // The clock moves a second a look: one read in the first minute.
    expect(reads).toBe(1);
    await c.close();
  });

  test("a fresh server that dies: what waited on it is answered with an error, and this server's tools are back", async () => {
    const fresh = freshServer(newer, () => undefined);
    const c = client({ published: () => "newer-toolset", spawn: () => fresh.child });
    await c.start();
    await c.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "conch_next", arguments: {} } });
    fresh.die();
    await Bun.sleep(30);
    expect(c.out.slice(-2)).toEqual([
      { jsonrpc: "2.0", id: 7, error: { code: -32603, message: "conch's MCP server restarted while answering; try the call again" } },
      { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
    ]);
    await c.send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "conch_sessions", arguments: {} } });
    expect(c.local).toEqual([{ name: "conch_sessions" }]);
    // The same tools are not handed over again: a server that dies after taking over is not restarted every check.
    await c.send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "conch_sessions", arguments: {} } });
    expect(c.spawned()).toBe(1);
    await c.close();
  });
});

describe("the session a fresh server serves", () => {
  const env = (from: number, parent: number) => ({ [HANDOFF_FROM_ENV]: String(from), [HANDOFF_PARENT_ENV]: String(parent) });

  test("the handing-over server's parent, when that server is this one's parent and the table agrees", () => {
    const table = new Map([[700, 500]]);
    expect(handoffParentPid(env(700, 500), 700, (pid) => table.get(pid))).toBe(500);
  });

  test("anything else is no hand-off: the server's own parent stands", () => {
    const table = new Map([[700, 500]]);
    expect(handoffParentPid({}, 700, (pid) => table.get(pid))).toBeUndefined();
    // Named by a process that isn't this one's parent.
    expect(handoffParentPid(env(701, 500), 700, (pid) => table.get(pid))).toBeUndefined();
    // A session that isn't the handing-over server's parent.
    expect(handoffParentPid(env(700, 999), 700, (pid) => table.get(pid))).toBeUndefined();
    expect(handoffParentPid(env(700, 1), 700, () => 1)).toBeUndefined();
    expect(handoffParentPid({ [HANDOFF_FROM_ENV]: "x", [HANDOFF_PARENT_ENV]: "500" }, 700, (pid) => table.get(pid))).toBeUndefined();
  });
});

describe("the real server, end to end", () => {
  test("it starts a real fresh server of what is installed, finds the same tools, and carries on answering itself", async () => {
    const folder = mkdtempSync(join(tmpdir(), "conch-handoff-"));
    const sessionsFile = join(folder, "sessions.json");
    writeFileSync(sessionsFile, JSON.stringify({ v: 1, rows: [], mcpToolset: "0000000000000000" }));
    const server = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "mcp"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CONCH_SESSIONS_FILE: sessionsFile },
    });
    const send = (message: Record<string, unknown>) => {
      server.stdin.write(`${JSON.stringify(message)}\n`);
      void server.stdin.flush();
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // The look happens after that line; a fresh server starts, answers, and goes.
    const deadline = Date.now() + 20_000;
    let stderr = "";
    const reader = server.stderr.getReader();
    while (!stderr.includes("not handed over") && Date.now() < deadline) {
      const { value, done } = await Promise.race([reader.read(), Bun.sleep(500).then(() => ({ value: undefined, done: false }))]);
      if (done) break;
      if (value) stderr += new TextDecoder().decode(value);
    }
    expect(stderr).toContain("hand-off: not handed over: the installed conch has these same tools");
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    server.stdin.end();
    const out = (await new Response(server.stdout).text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(out.map((message) => message.id)).toEqual([1, 2]);
    expect(out[1].result.tools.map((tool: { name: string }) => tool.name)).toContain("atlas_show");
    expect(out.some((message) => message.method === "notifications/tools/list_changed")).toBe(false);
    await server.exited;
  }, 30_000);
});
