import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { AgentUsageError, cliWording, parseAgentCommand, renderAgentAnswer, usageErrorText } from "./agent-commands.ts";
import { sessionForShell, type ShellCaller } from "./caller-session.ts";
import { registrySnapshot, type RegistrySnapshot } from "./sessions.ts";
import {
  callOutcome,
  createMcpToolHandlers,
  defaultMcpDependencies,
  errorWithCandidates,
  mcpToolVocabulary,
  resultOutcome,
  type AgentHandlerName,
  type McpDependencies,
  type McpRuntimeConfig,
} from "./mcp.ts";
import { appendMcpCall, mcpCallRecord, type McpCallOutcome, type McpCallRecord } from "./mcp-usage.ts";

/**
 * `conch agent <command>`: conch's tools for agents, run from the agent's own shell.
 *
 * 2026-11-11, Tyler: "I would also like to add a cli cause I think it might be better to put all our stuff in for agents
 * to use without killing context and then the mcp can be more minimal?" Each command runs the MCP server's own handler
 * (mcp.ts), so it checks, refuses and answers exactly as the tool did, with three differences that are this file's:
 *
 * - **Who is calling** is the shell's process tree up to a session (caller-session.ts `sessionForShell`), where the MCP
 *   server used its own parent. A command on your own session (publish, folders, the browser) is refused, saying why,
 *   when the tree doesn't lead to exactly one live session; nothing the agent passes can name another one instead.
 * - **What it says** is a line a field (`--json` for the answer whole), in the CLI's words, and a mistake prints the
 *   command's usage.
 * - **Where it is logged**: the same `mcp-usage.jsonl` line a tool call writes, under the tool's name with `via: "cli"`,
 *   so `conch mcp-usage` and the failure tickets (failure-tickets.ts) see a command as they saw the tool.
 *
 * A shell conch's socket refuses (Codex's sandbox allows no unix socket by default) is told to run the same command
 * through the `conch_run` tool, whose server is outside the sandbox.
 */

export interface AgentCliOptions {
  argv: readonly string[];
  config: McpRuntimeConfig;
  env?: Readonly<Record<string, string | undefined>>;
  /** The shell's folder, which relative paths are resolved against. */
  cwd?: string;
  /** This process, where the walk to the calling session starts. */
  pid?: number;
  stdout?(text: string): void;
  stderr?(text: string): void;
  dependencies?: McpDependencies;
  /** Who is calling, in place of the process tree (tests). */
  shellCaller?(): Promise<ShellCaller>;
  /** Where the call's line goes; `appendMcpCall` when absent. */
  log?(record: McpCallRecord): void;
  readStdin?(): string;
  now?(): number;
}

/** The exit code for how a command ended: 0 ok, 1 conch failed, 2 the command was wrong, 3 conch refused. */
export const AGENT_EXIT: Readonly<Record<McpCallOutcome, number>> = { ok: 0, failed: 1, "input-error": 2, refused: 3 };

/**
 * Why conch's socket refused this shell, when it is a sandbox's refusal (EPERM, EACCES) rather than no daemon. Asked only
 * after a command failed for want of the daemon, so a working shell never pays for it.
 */
export function socketRefusal(socketPath: string, timeoutMs = 1_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ path: socketPath });
    const done = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    socket.on("connect", () => done(undefined));
    socket.on("error", (error: NodeJS.ErrnoException) => done(error.code === "EPERM" || error.code === "EACCES" ? error.code : undefined));
  });
}

/**
 * Every process's parent and command line, from one `ps`; null when it can't be read. The whole line, not the name: an
 * npm-installed Codex runs as `node …/codex.js`, and one missed would let a Claude above it answer for it.
 */
async function processTable(): Promise<{ parents: Map<number, number>; names: Map<number, string> } | null> {
  try {
    const proc = Bun.spawn(["ps", "-Ao", "pid=,ppid=,args="], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    const parents = new Map<number, number>();
    const names = new Map<number, string>();
    for (const line of text.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      parents.set(Number(match[1]), Number(match[2]));
      names.set(Number(match[1]), match[3]!.trim());
    }
    return parents.size ? { parents, names } : null;
  } catch {
    return null;
  }
}

/** Whether a command line is a Codex: its executable, or node running Codex's script (an npm install). */
export function isCodexCommand(args: string): boolean {
  const [executable = "", script = ""] = args.trim().split(/\s+/);
  return /(?:^|\/)codex$/i.test(executable) || (/(?:^|\/)node$/i.test(executable) && /codex/i.test(script));
}

/**
 * Who this shell is, cheaply. The full registry read costs ~0.7 s in a fresh process, nearly all of it Codex's open-thread
 * probe (lsof and ps over its databases), which a long-lived MCP server pays once and a command would pay every time.
 * So Claude's sessions are read first (~65 ms): when the walk finds one with no Codex process between it and this shell,
 * that is the answer. Otherwise (a Codex ancestor, or nothing found) the whole registry is read and the walk done again,
 * so the nearest session still wins, as `sessionForCallerPid` has it.
 */
export async function shellIdentity(options: {
  pid: number;
  env: Readonly<Record<string, string | undefined>>;
  claudeDir: string;
  snapshot(skipCodex: boolean): Promise<RegistrySnapshot | null>;
  table?(): Promise<{ parents: Map<number, number>; names: Map<number, string> } | null>;
}): Promise<ShellCaller> {
  const table = await (options.table ?? processTable)().catch(() => null);
  const parents = async () => table?.parents ?? null;
  const claude = await options.snapshot(true).catch(() => null);
  const first = await sessionForShell({ pid: options.pid, env: options.env, infos: claude?.infos ?? [], claudeDir: options.claudeDir, parents });
  if (first.binding.status === "verified") {
    const at = first.pid;
    let codexBetween = false;
    for (let pid = options.pid, hop = 0; table && pid > 1 && pid !== at && hop < 32; pid = table.parents.get(pid) ?? 0, hop += 1) {
      if (isCodexCommand(table.names.get(pid) ?? "")) codexBetween = true;
    }
    if (!codexBetween) return first;
  }
  const full = await options.snapshot(false).catch(() => null);
  return sessionForShell({ pid: options.pid, env: options.env, infos: full?.infos ?? [], claudeDir: options.claudeDir, parents });
}

/** Run one `conch agent` command line; its exit code (`AGENT_EXIT`). */
export async function runAgentCli(options: AgentCliOptions): Promise<number> {
  const out = options.stdout ?? ((text: string) => void process.stdout.write(`${text}\n`));
  const err = options.stderr ?? ((text: string) => void process.stderr.write(`${text}\n`));
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const given = options.dependencies ?? defaultMcpDependencies;
  // One registry read per command, however many times its handler asks: a command is one moment.
  let snapshotOnce: Promise<RegistrySnapshot | null> | undefined;
  const dependencies: McpDependencies = {
    ...given,
    registrySnapshot: (claudeDir) => (snapshotOnce ??= given.registrySnapshot(claudeDir)),
  };
  const log = options.log ?? ((record: McpCallRecord) => appendMcpCall(record));

  let caller: Promise<ShellCaller> | undefined;
  const shellCaller = options.shellCaller ?? (() => (caller ??= shellIdentity({
    pid: options.pid ?? process.pid,
    env,
    claudeDir: options.config.claudeDir,
    // Claude's alone is the real registry's own read (`skipCodex`); the whole one is the command's, shared with its handler.
    snapshot: (skipCodex) => (skipCodex && !options.dependencies
      ? registrySnapshot(options.config.claudeDir, { skipCodex: true })
      : dependencies.registrySnapshot(options.config.claudeDir)),
  })));

  const startedAt = now();
  const started = performance.now();
  const record = async (tool: string, outcome: McpCallOutcome, argumentsValue: unknown, error?: string) => {
    const ms = performance.now() - started;
    let who: { session?: string; backend?: "claude" | "codex" } = {};
    try {
      const { binding } = await shellCaller();
      if (binding.status === "verified") who = { session: binding.session.sessionId, backend: binding.session.backend ?? "claude" };
    } catch {}
    try {
      log(mcpCallRecord(
        { ts: startedAt, tool, ms, outcome, ...(error ? { error } : {}), arguments: argumentsValue, via: "cli" },
        who,
        mcpToolVocabulary(),
      ));
    } catch {}
  };

  let invocation: ReturnType<typeof parseAgentCommand>;
  try {
    invocation = parseAgentCommand(options.argv, {
      cwd,
      readFile: (path) => readFileSync(path, "utf8"),
      readStdin: options.readStdin ?? (() => readFileSync(0, "utf8")),
    });
  } catch (error) {
    if (!(error instanceof AgentUsageError)) throw error;
    // A command named but called wrong is the agent's input error, logged as the tool's, as a bad tool call was.
    if (error.command) await record(error.command.tool, "input-error", {}, error.message);
    err(usageErrorText(error));
    return AGENT_EXIT["input-error"];
  }
  if (invocation.kind === "help") {
    out(invocation.text);
    return 0;
  }

  const handlers = createMcpToolHandlers(options.config, { ...dependencies, shellCaller });
  const handler = handlers[invocation.tool as AgentHandlerName];
  if (!handler) {
    err(`conch agent ${invocation.command.name} has no handler in this conch`);
    return AGENT_EXIT.failed;
  }
  try {
    const value = await handler(invocation.args, undefined);
    const judged = resultOutcome(value);
    await record(invocation.tool, judged.outcome, invocation.args, judged.error);
    out(renderAgentAnswer(invocation.command, value, invocation.json, now()));
    // An answer that is a refusal said as a value (speech held in manual mode, audio another Mac holds) exits as one.
    return AGENT_EXIT[judged.outcome];
  } catch (error) {
    const outcome = callOutcome(error);
    const message = error instanceof Error ? error.message : String(error);
    await record(invocation.tool, outcome, invocation.args, message);
    let said = cliWording(errorWithCandidates(error));
    if (/daemon (?:is not running|isn't (?:running|reachable))/.test(said)) {
      const refused = await socketRefusal(options.config.socketPath);
      if (refused) {
        said = `failed: conch's socket refused this shell (${refused}): this session's sandbox keeps its commands from reaching conch.`
          + ` Run the same command through the conch_run tool (command: ${JSON.stringify(options.argv.join(" "))}), or ask the user to let this session reach ${options.config.socketPath}`;
      }
    }
    // A shell conch can't place (no session above it, or a sandbox that hides the process table) has the MCP's proof
    // one call away.
    if (outcome === "refused" && /cannot verify which session is calling/.test(said)) {
      said += `. The conch_run tool runs the same command with your MCP server's own proof of who you are (command: ${JSON.stringify(options.argv.join(" "))})`;
    }
    err(outcome === "input-error" ? `${said}\nusage: conch agent ${invocation.command.usage}` : said);
    return AGENT_EXIT[outcome];
  }
}
