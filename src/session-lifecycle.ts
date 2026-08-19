import { homedir } from "node:os";
import { statSync } from "node:fs";

export type SessionBackend = "claude" | "codex";

export interface StartSessionRequest {
  backend: SessionBackend;
  resumeSessionId?: string;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A Terminal-started agent replaces its shell, so leaving the agent also completes the tab cleanly. */
export function terminalSessionCommand(request: StartSessionRequest): string {
  const cwd = request.cwd?.trim() || homedir();
  const executable = request.backend === "claude" ? "claude" : "codex";
  const resume = request.resumeSessionId?.trim();
  const args = resume
    ? request.backend === "claude"
      ? ` --resume ${shellQuote(resume)}`
      : ` resume ${shellQuote(resume)}`
    : "";
  // Before the subcommand's own arguments, not after: `codex resume <id>` takes
  // the id as a positional, and a global flag trailing it reads as a second one.
  const bypass = request.bypassPermissions ? ` ${bypassFlag(request.backend)}` : "";
  return `cd -- ${shellQuote(cwd)} && exec ${executable}${bypass}${args}`;
}

/**
 * The verified flag for each agent, spelled the way each agent spells it.
 *
 * Read from `--help` on the installed binaries rather than from memory: Codex
 * has renamed this more than once, and there is no `--yolo` alias in the
 * current build despite the name people use for it.
 */
function bypassFlag(backend: SessionBackend): string {
  return backend === "claude"
    ? "--dangerously-skip-permissions"
    : "--dangerously-bypass-approvals-and-sandbox";
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
  const spawn = dependencies.spawn ?? defaultSpawn;
  const executable = request.backend === "claude" ? "claude" : "codex";
  const which = dependencies.which ?? ((name: string) => Bun.which(name));
  if (!which(executable)) throw new Error(`${executable} is not installed or is not on PATH`);
  const cwd = request.cwd?.trim() || homedir();
  const isDirectory = dependencies.isDirectory ?? ((path: string) => statSync(path).isDirectory());
  try {
    if (!isDirectory(cwd)) throw new Error();
  } catch {
    throw new Error(`session directory does not exist: ${cwd}`);
  }
  const command = terminalSessionCommand(request);
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
