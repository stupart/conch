import { toolsetFingerprint } from "./mcp-toolset.ts";

/**
 * New conch tools for sessions already running, without a restart.
 *
 * A Claude Code or Codex session starts conch's MCP server once, and the server's tools are whatever code it loaded
 * then: a session started before an update never saw `browser_*` or `atlas_show` until it was restarted. MCP has the
 * fix, `notifications/tools/list_changed`, which both clients act on (Claude Code 2.1.280: "Received tools/list_changed
 * notification, refreshing tools"; Codex 0.159: "MCP server tool list changed"), but a server can only announce tools
 * it has.
 *
 * So the running server hands over. Between messages, at most once a minute, it reads the toolset the daemon publishes
 * (`mcpToolset`, mcp-toolset.ts). When that differs from its own, a newer conch is installed and running: it starts a
 * fresh server of the installed code (`spawn`), initializes it with the client's own `initialize`, and asks its
 * tools. If those are its own again (the daemon is the newer one, not what is installed), the fresh one goes and nothing
 * changes. Otherwise this server becomes a pipe: every line from the client goes to the fresh server, every line back
 * goes to the client, and the client is told `notifications/tools/list_changed`, so it asks again and gets the new
 * tools. If the fresh server dies, this one answers what was waiting on it with an error, takes over again with its own
 * tools, and says the list changed back.
 *
 * Only a server with this code can hand over, so sessions started before it still need one restart.
 */

export interface HandoffChild {
  /** One line to the fresh server's stdin (the newline is added). */
  write(line: string): void;
  /** Its stdout, a line at a time. */
  lines: AsyncIterable<string>;
  /** Settles when it exits. */
  exited: Promise<unknown>;
  kill(): void;
}

export interface McpHandoffOptions {
  /** This server's toolset (`MCP_TOOLSET`). */
  ownToolset: string;
  /** The toolset the daemon publishes now; undefined when it says none or can't be read. */
  publishedToolset(): Promise<string | undefined>;
  /** A fresh server of the installed code, told who the session is (`handoffParentPid`). */
  spawn(): HandoffChild | Promise<HandoffChild>;
  /** A line to the client. */
  writeLine(line: string): void | Promise<void>;
  diagnostic(message: string): void;
  now(): number;
  /** How often the daemon's toolset is read, at most. */
  checkEveryMs?: number;
  /** How long the fresh server has to answer each step of its start. */
  replyMs?: number;
}

type JsonRpcId = string | number | null;

const LIST_CHANGED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** The ids a line asks for answers to: a request's, or each in a batch. */
function requestIds(message: unknown): JsonRpcId[] {
  const one = (value: unknown): JsonRpcId[] =>
    isRecord(value) && typeof value.method === "string" && Object.hasOwn(value, "id") ? [value.id as JsonRpcId] : [];
  return Array.isArray(message) ? message.flatMap(one) : one(message);
}

/** The ids a line answers: a response's, or each in a batch. */
function responseIds(message: unknown): JsonRpcId[] {
  const one = (value: unknown): JsonRpcId[] =>
    isRecord(value) && !Object.hasOwn(value, "method") && Object.hasOwn(value, "id") ? [value.id as JsonRpcId] : [];
  return Array.isArray(message) ? message.flatMap(one) : one(message);
}

export class McpHandoff {
  readonly #options: McpHandoffOptions;
  /** The client's `initialize` params, replayed to the fresh server. */
  #initialize: unknown;
  #initialized = false;
  #lastCheck = Number.NEGATIVE_INFINITY;
  /** A published toolset whose hand-off came to nothing: not tried again. */
  readonly #declined = new Set<string>();
  #child: HandoffChild | undefined;
  #proxying = false;
  /** Requests sent on to the fresh server and not answered yet. */
  readonly #pending = new Set<JsonRpcId>();
  /** The fresh server's start: one answer awaited at a time, by id. */
  #awaiting: { id: string; resolve(message: Record<string, unknown>): void } | undefined;
  #closed = false;

  constructor(options: McpHandoffOptions) {
    this.#options = options;
  }

  get proxying(): boolean {
    return this.#proxying;
  }

  /** A line from the client, before it is handled: the `initialize` to replay, and whether the session is under way. */
  observe(message: unknown): void {
    if (!isRecord(message)) return;
    if (message.method === "initialize") this.#initialize = message.params ?? {};
    if (message.method === "notifications/initialized") this.#initialized = true;
  }

  /** A line from the client, sent on to the fresh server once handed over; false while this server handles its own. */
  forward(line: string): boolean {
    if (!this.#proxying || !this.#child) return false;
    for (const id of requestIds(parse(line))) this.#pending.add(id);
    this.#child.write(line);
    return true;
  }

  /** Between messages: hand over when the daemon's tools are newer than ours and a fresh server has them. */
  async check(): Promise<void> {
    if (this.#proxying || this.#closed || !this.#initialized || this.#initialize === undefined) return;
    const now = this.#options.now();
    if (now - this.#lastCheck < (this.#options.checkEveryMs ?? 60_000)) return;
    this.#lastCheck = now;
    const published = await this.#options.publishedToolset().catch(() => undefined);
    if (!published || published === this.#options.ownToolset || this.#declined.has(published)) return;
    let child: HandoffChild;
    try {
      child = await this.#options.spawn();
    } catch (error) {
      this.#declined.add(published);
      this.#options.diagnostic(`hand-off: couldn't start a fresh server: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.#child = child;
    void this.#pump(child);
    try {
      await this.#ask(child, "conch-handoff-initialize", "initialize", this.#initialize);
      child.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
      const listed = await this.#ask(child, "conch-handoff-tools", "tools/list", {});
      const tools = isRecord(listed.result) && Array.isArray(listed.result.tools) ? listed.result.tools : [];
      const named = tools.flatMap((tool) =>
        isRecord(tool) && typeof tool.name === "string" && typeof tool.description === "string" ? [{ name: tool.name, description: tool.description }] : []);
      if (!named.length || toolsetFingerprint(named) === this.#options.ownToolset) {
        throw new Error("the installed conch has these same tools");
      }
    } catch (error) {
      this.#declined.add(published);
      this.#child = undefined;
      child.kill();
      this.#options.diagnostic(`hand-off: not handed over: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.#proxying = true;
    this.#options.diagnostic(`hand-off: a fresh server has the installed conch's tools; told the client the list changed`);
    await this.#options.writeLine(LIST_CHANGED);
    void child.exited.then(() => this.#lost(child));
  }

  /** The client has gone: the fresh server goes with it. */
  close(): void {
    this.#closed = true;
    this.#child?.kill();
  }

  /** Send the fresh server one request of its start and wait for its answer. */
  #ask(child: HandoffChild, id: string, method: string, params: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#awaiting = undefined;
        reject(new Error(`the fresh server didn't answer ${method}`));
      }, this.#options.replyMs ?? 10_000);
      this.#awaiting = {
        id,
        resolve: (message) => {
          clearTimeout(timer);
          this.#awaiting = undefined;
          if (isRecord(message.error)) reject(new Error(`the fresh server refused ${method}`));
          else resolve(message);
        },
      };
      child.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** The fresh server's lines: its start's answers to us, then everything to the client. */
  async #pump(child: HandoffChild): Promise<void> {
    try {
      for await (const line of child.lines) {
        if (!line.trim()) continue;
        const message = parse(line);
        const awaiting = this.#awaiting;
        if (awaiting && isRecord(message) && message.id === awaiting.id) {
          awaiting.resolve(message);
          continue;
        }
        if (!this.#proxying || this.#child !== child) continue;
        for (const id of responseIds(message)) this.#pending.delete(id);
        await this.#options.writeLine(line);
      }
    } catch (error) {
      this.#options.diagnostic(`hand-off: the fresh server's output failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The fresh server died: what waited on it is answered with an error, and this server's own tools are back. */
  async #lost(child: HandoffChild): Promise<void> {
    if (this.#child !== child || this.#closed) return;
    this.#child = undefined;
    this.#proxying = false;
    this.#options.diagnostic("hand-off: the fresh server exited; this server answers again, with its own tools");
    for (const id of this.#pending) {
      await this.#options.writeLine(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "conch's MCP server restarted while answering; try the call again" },
      }));
    }
    this.#pending.clear();
    await this.#options.writeLine(LIST_CHANGED);
  }
}

/** Lines of a byte stream, as a fresh server writes them. */
export async function* streamLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      yield buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) yield buffer;
}

/** The environment a fresh server is started with: which server handed over, and the session that server serves. */
export const HANDOFF_FROM_ENV = "CONCH_MCP_HANDOFF_FROM";
export const HANDOFF_PARENT_ENV = "CONCH_MCP_HANDOFF_PARENT";

/**
 * The session's pid, for a server started by a hand-off: the server that handed over names its own parent, and it is
 * believed only when that server is this one's parent and the pid it names is that server's parent, read off the process
 * table. Anything else is no hand-off, and the server's own parent is its session, as always.
 */
export function handoffParentPid(
  env: Readonly<Record<string, string | undefined>>,
  ppid: number,
  parentOf: (pid: number) => number | undefined,
): number | undefined {
  const from = Number(env[HANDOFF_FROM_ENV]);
  const parent = Number(env[HANDOFF_PARENT_ENV]);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(parent) || from <= 1 || parent <= 1 || from !== ppid) return undefined;
  return parentOf(ppid) === parent ? parent : undefined;
}

/** One process's parent, from `ps`; undefined when it can't be read. */
export function processParent(pid: number): number | undefined {
  try {
    const result = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const parent = Number(new TextDecoder().decode(result.stdout).trim());
    return Number.isSafeInteger(parent) && parent > 0 ? parent : undefined;
  } catch {
    return undefined;
  }
}
