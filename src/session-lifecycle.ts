import { homedir } from "node:os";
import { statSync } from "node:fs";
import {
  adapterFor,
  BYPASS_OPTION,
  shellQuote,
  type AgentAdapter,
  type SessionBackend,
} from "./agent-adapter.ts";
import { ensureHelpSession, helpSessionDir } from "./help-session.ts";

export type { SessionBackend };

export interface StartSessionRequest {
  backend: SessionBackend;
  resumeSessionId?: string;
  /** Claude cloud session to open as a new local copy, never a live join. */
  teleportSessionId?: string;
  cwd?: string;
  /**
   * Start without permission prompts: `--dangerously-skip-permissions` for
   * Claude Code, `--dangerously-bypass-approvals-and-sandbox` for Codex.
   *
   * Off unless asked for. conch ships to other people, and a tool that
   * silently removes every confirmation from sessions it starts is not a
   * default anyone should inherit — it has to be a thing you turned on.
   */
  bypassPermissions?: boolean;
  /**
   * Tell Codex it trusts this directory for THIS launch.
   *
   * Codex otherwise stops on a full-screen prompt before doing anything, and a
   * session held there never starts and never registers. Passed as a config
   * override rather than written to `config.toml`: the person answered a
   * question about one session, not about every future one, and conch should
   * not quietly edit their configuration to make a launch succeed.
   */
  trustFolder?: boolean;
  /**
   * Per-session choices from the agent's own `--help` (C1), keyed by the
   * adapter row's `startOptions[].name`. Refused unless every key is in the
   * table and every value fits its kind; `bypass-permissions` here overrides
   * the persisted default the sheets seed their toggle from.
   */
  options?: Record<string, string | boolean>;
}

export interface SessionLifecycleProcess {
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  /** Cancels only the short-lived automation helper, never the agent pid. */
  cancel(): void;
}

export interface SessionLifecycleDependencies {
  spawn?(argv: string[]): SessionLifecycleProcess;
  ttyForPid?(pid: number): Promise<string>;
  pidIsAlive?(pid: number): Promise<boolean>;
  which?(executable: string): string | null;
  isDirectory?(path: string): boolean;
  sleep?(ms: number): Promise<void>;
  automationTimeoutMs?: number;
  exitPollAttempts?: number;
  exitPollIntervalMs?: number;
}

/** Extra launch constraints for a cloud id passed as a CLI option's value. */
export function teleportRequestError(request: StartSessionRequest): string | undefined {
  if (request.teleportSessionId === undefined) return;
  const adapter = adapterFor(request.backend);
  if (!adapter.teleportArgs) return `${adapter.displayName} has no teleport`;
  if (request.resumeSessionId !== undefined) return "resumeSessionId and teleportSessionId are mutually exclusive";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(request.teleportSessionId.trim())) {
    return "teleport session id must contain only letters, numbers, underscores or hyphens, and start with a letter or number";
  }
  if (!request.cwd?.trim()) return "cwd is required for teleport";
  if (!request.cwd.trim().startsWith("/")) return "cwd must be an absolute path";
}

/** A free-form start value: a model alias or name, a profile name. Never a shell word. */
const START_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/;

/**
 * Refuses an `options` key the agent's table does not list, or a value not
 * shaped as its entry says, quoting the CLI's own help. Nothing reaches the
 * command line unvalidated: the daemon's validator and the direct launchers
 * (CLI, help session) all ask here.
 */
export function startOptionsError(
  request: Pick<StartSessionRequest, "backend" | "resumeSessionId"> & { options?: unknown },
): string | undefined {
  const { options } = request;
  if (options === undefined) return;
  const adapter = adapterFor(request.backend);
  if (typeof options !== "object" || options === null || Array.isArray(options)) return "options must be an object";
  for (const [name, value] of Object.entries(options as Record<string, unknown>)) {
    const entry = adapter.startOptions.find((option) => option.name === name);
    if (!entry) {
      const offered = adapter.startOptions.map((option) => option.name).join(", ");
      return `${adapter.displayName} has no start option "${name}" (it offers ${offered})`;
    }
    if (entry.kind === "bool") {
      if (typeof value !== "boolean") return `${entry.flag} is on or off — ${entry.help}`;
    } else if (typeof value !== "string") {
      return `${entry.flag} takes a value — ${entry.help}`;
    } else if (entry.kind === "enum" && !entry.choices?.includes(value)) {
      return `${entry.flag}: ${JSON.stringify(value)} is not one of ${entry.choices?.join(", ")} — ${entry.help}`;
    } else if (entry.kind === "string" && !START_VALUE.test(value)) {
      return `${entry.flag} must be letters, digits, dots, underscores, colons, brackets or hyphens, starting with a letter or number — ${entry.help}`;
    }
    if (entry.resumeOnly && !request.resumeSessionId?.trim()) return `${entry.flag} applies only to a resume — ${entry.help}`;
  }
}

/** Table order, after the agent's own arguments. The bypass entry is rendered where its flag was verified, not here. */
function renderStartOptions(adapter: AgentAdapter, options: StartSessionRequest["options"]): string {
  if (!options) return "";
  let rendered = "";
  for (const entry of adapter.startOptions) {
    const value = options[entry.name];
    if (entry.name === BYPASS_OPTION || value === undefined || value === false) continue;
    rendered += entry.kind === "bool" ? ` ${entry.flag}` : ` ${entry.flag} ${shellQuote(String(value))}`;
  }
  return rendered;
}

/** `conch start --help`: the chosen agent's table, one option per entry, in the CLI's own words. */
export function startUsage(adapter: AgentAdapter): string {
  const lines = adapter.startOptions.map((entry) => {
    const spelling = entry.kind === "bool"
      ? `--${entry.name} | --no-${entry.name}`
      : entry.kind === "enum"
      ? `--${entry.name} <${entry.choices?.join("|")}>`
      : `--${entry.name} <value>`;
    return `  ${spelling}${entry.resumeOnly ? "  (with --resume)" : ""}\n      ${entry.help}`;
  });
  return `usage: conch start [claude|codex] [--cwd <dir>] [--resume <id> | --teleport <id>] [options]\n`
    + `${adapter.displayName} options:\n${lines.join("\n")}`;
}

/** `conch start`'s arguments, parsed against the chosen agent's table. Throws with that agent's usage. */
export function startRequestFromArgv(args: string[]): StartSessionRequest {
  const named = args[0] === "claude" || args[0] === "codex";
  const backend: SessionBackend = args[0] === "codex" ? "codex" : "claude";
  const rest = named ? args.slice(1) : args;
  const adapter = adapterFor(backend);
  const request: StartSessionRequest = { backend };
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? "";
    const fixed = arg === "--cwd" ? "cwd" : arg === "--resume" ? "resumeSessionId" : arg === "--teleport" ? "teleportSessionId" : null;
    if (fixed) {
      const value = rest[++i];
      if (value === undefined) throw new Error(`${arg} needs a value\n${startUsage(adapter)}`);
      request[fixed] = value;
      continue;
    }
    const negated = arg.startsWith("--no-");
    const entry = arg.startsWith("--")
      ? adapter.startOptions.find((option) => option.name === arg.slice(negated ? 5 : 2))
      : undefined;
    if (!entry || (negated && entry.kind !== "bool")) throw new Error(`unknown argument ${arg}\n${startUsage(adapter)}`);
    if (entry.kind === "bool") {
      options[entry.name] = !negated;
    } else {
      const value = rest[++i];
      if (value === undefined) throw new Error(`${entry.flag} needs a value — ${entry.help}`);
      options[entry.name] = value;
    }
  }
  if (Object.keys(options).length > 0) request.options = options;
  const error = teleportRequestError(request) ?? startOptionsError(request);
  if (error) throw new Error(error);
  return request;
}

/** A Terminal-started agent replaces its shell, so leaving the agent also completes the tab cleanly. */
export function terminalSessionCommand(request: StartSessionRequest): string {
  const error = teleportRequestError(request) ?? startOptionsError(request);
  if (error) throw new Error(error);
  const cwd = request.cwd?.trim() || homedir();
  const adapter = adapterFor(request.backend);
  const resume = request.resumeSessionId?.trim();
  const teleport = request.teleportSessionId?.trim();
  const args = teleport && adapter.teleportArgs
    ? adapter.teleportArgs(shellQuote(teleport))
    : resume
    ? adapter.resumeArgs(shellQuote(resume))
    : "";
  // Before the subcommand's own arguments, not after: `codex resume <id>` takes
  // the id as a positional, and a global flag trailing it reads as a second one.
  // The request's own toggle, when it carries one, beats the persisted default.
  const bypass = (request.options?.[BYPASS_OPTION] ?? request.bypassPermissions)
    ? ` ${adapter.bypassPermissionsFlag}`
    : "";
  const trust = request.trustFolder ? adapter.trustFolderArgs(cwd) : "";
  return `cd -- ${shellQuote(cwd)} && exec ${adapter.executable}${bypass}${trust}${args}`
    + renderStartOptions(adapter, request.options);
}

function defaultSpawn(argv: string[]): SessionLifecycleProcess {
  const controller = new AbortController();
  const process = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    signal: controller.signal,
  });
  return {
    exited: process.exited,
    stdout: process.stdout,
    stderr: process.stderr,
    cancel: () => controller.abort(),
  };
}

async function processText(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  return stream ? new Response(stream).text().catch(() => "") : "";
}

async function boundedExit(child: SessionLifecycleProcess, timeoutMs = 4_000): Promise<number> {
  const timeout = "timeout" as const;
  const result = await Promise.race([
    child.exited,
    Bun.sleep(timeoutMs).then(() => timeout),
  ]);
  if (result === timeout) {
    child.cancel();
    throw new Error("Terminal automation timed out");
  }
  return result;
}

/** Native Terminal prevents a launched agent from inheriting conch's tmux environment. */
export async function startTerminalSession(
  request: StartSessionRequest,
  dependencies: SessionLifecycleDependencies = {},
): Promise<void> {
  const command = terminalSessionCommand(request);
  const spawn = dependencies.spawn ?? defaultSpawn;
  const { executable } = adapterFor(request.backend);
  const which = dependencies.which ?? ((name: string) => Bun.which(name));
  if (!which(executable)) throw new Error(`${executable} is not installed or is not on PATH`);
  const cwd = request.cwd?.trim() || homedir();
  // The help session's folder is conch's to create, and this is the one door
  // every launch goes through (CLI, the app's sheet via the daemon, the TUI).
  if (cwd === helpSessionDir()) ensureHelpSession();
  const isDirectory = dependencies.isDirectory ?? ((path: string) => statSync(path).isDirectory());
  try {
    if (!isDirectory(cwd)) throw new Error();
  } catch {
    throw new Error(`session directory does not exist: ${cwd}`);
  }
  const child = spawn([
    "osascript",
    "-e", "on run argv",
    "-e", 'tell application "Terminal"',
    "-e", "activate",
    "-e", "do script (item 1 of argv)",
    "-e", "end tell",
    "-e", "end run",
    "--",
    command,
  ]);
  const stderr = processText(child.stderr);
  const code = await boundedExit(child, dependencies.automationTimeoutMs);
  if (code !== 0) {
    throw new Error((await stderr).trim() || `Terminal returned ${code}`);
  }
}

/**
 * `conch help-session`: Claude Code in conch's own folder. Launched directly
 * rather than through the daemon's socket because a daemon that is down is the
 * most likely reason someone wants help. Returns the folder it opened.
 */
export async function startHelpSession(
  request: Pick<StartSessionRequest, "bypassPermissions"> = {},
  dependencies: SessionLifecycleDependencies = {},
): Promise<string> {
  const cwd = helpSessionDir();
  await startTerminalSession({ backend: "claude", cwd, ...request }, dependencies);
  return cwd;
}

async function defaultTtyForPid(pid: number): Promise<string> {
  const child = Bun.spawn(["ps", "-o", "tty=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = processText(child.stdout);
  if (await child.exited !== 0) return "";
  return (await output).trim();
}

async function defaultPidIsAlive(pid: number): Promise<boolean> {
  const child = Bun.spawn(["ps", "-p", String(pid), "-o", "pid="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = processText(child.stdout);
  return await child.exited === 0 && Boolean((await output).trim());
}

/** Ctrl-D asks the CLI to leave through its normal EOF path; no signal is sent to the agent. */
export async function closeTerminalSession(
  pid: number,
  dependencies: SessionLifecycleDependencies = {},
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("session has no routable pid");
  const tty = await (dependencies.ttyForPid ?? defaultTtyForPid)(pid);
  if (!tty || tty === "??") throw new Error("session is not attached to a Terminal tty");

  const spawn = dependencies.spawn ?? defaultSpawn;
  const child = spawn([
    "osascript",
    "-e", "on run argv",
    "-e", 'tell application "Terminal"',
    "-e", "repeat with w in windows",
    "-e", "repeat with t in tabs of w",
    "-e", 'if (tty of t) is ("/dev/" & (item 1 of argv)) then',
    "-e", "set selected tab of w to t",
    "-e", "set index of w to 1",
    "-e", "activate",
    "-e", 'tell application "System Events" to keystroke "d" using control down',
    "-e", 'return "ok"',
    "-e", "end if",
    "-e", "end repeat",
    "-e", "end repeat",
    "-e", "end tell",
    "-e", 'return "notfound"',
    "-e", "end run",
    "--",
    tty,
  ]);
  const [code, stdout, stderr] = await Promise.all([
    boundedExit(child, dependencies.automationTimeoutMs),
    processText(child.stdout),
    processText(child.stderr),
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `Terminal returned ${code}`);
  if (stdout.trim() !== "ok") throw new Error("session Terminal tab was not found");

  const pidIsAlive = dependencies.pidIsAlive ?? defaultPidIsAlive;
  const sleep = dependencies.sleep ?? Bun.sleep;
  const attempts = dependencies.exitPollAttempts ?? 40;
  const intervalMs = dependencies.exitPollIntervalMs ?? 100;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await pidIsAlive(pid))) return;
    await sleep(intervalMs);
  }
  throw new Error("session did not exit cleanly after Ctrl-D");
}
