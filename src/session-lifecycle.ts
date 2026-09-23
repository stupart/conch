import { FOCUS_GUARD_LINES, focusedAction, focusSessionWindow, readTerminalTab, withUITransaction, type OsaRunner } from "./inject.ts";
import { runUICommand } from "./pasteboard.ts";
import { processMatchesProvider, readProcessIdentity, sameProcessIdentity, type ProcessIdentity, type ProcessIdentityProbe } from "./process-identity.ts";
import { conchHome } from "./home.ts";
import { statSync } from "node:fs";
import {
  adapterFor,
  BYPASS_OPTION,
  claudeInputBoxText,
  shellQuote,
  type AgentAdapter,
  type SessionBackend,
} from "./agent-adapter.ts";
import { ensureHelpSession, helpSessionDir } from "./help-session.ts";
import type { SessionInfo } from "./sessions.ts";

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
  processIdentity?: ProcessIdentityProbe;
  expectedIdentity?: ProcessIdentity;
  backend?: SessionBackend;
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
  request: Pick<StartSessionRequest, "backend" | "resumeSessionId" | "bypassPermissions"> & { options?: unknown },
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
  return conflictingOptionsError(adapter, options as Record<string, unknown>, request.bypassPermissions);
}

/**
 * The pairs the agent's own CLI refuses (`conflictsWith`).
 *
 * Codex exits 2 on `--dangerously-bypass-approvals-and-sandbox` together with
 * `--sandbox` or `--ask-for-approval`, and a launch that dies that way leaves a
 * usage dump in a Terminal window and a session that never registers — the same
 * shape as a hang. Refusing here says which two, and what to do about it,
 * before anything is launched.
 *
 * The bypass flag can also come from the persisted `bypass-permissions`
 * setting rather than this request's options, which is how the conflict reached
 * a real command line: the sheet sent a sandbox choice and the daemon added the
 * flag underneath it.
 */
function conflictingOptionsError(
  adapter: AgentAdapter,
  options: Record<string, unknown>,
  bypassDefault: boolean | undefined,
): string | undefined {
  for (const entry of adapter.startOptions) {
    if (!entry.conflictsWith) continue;
    const chosen = options[entry.name];
    const on = chosen === true
      || (entry.name === BYPASS_OPTION && chosen === undefined && bypassDefault === true);
    if (!on) continue;
    for (const name of entry.conflictsWith) {
      const other = adapter.startOptions.find((option) => option.name === name);
      if (!other || options[name] === undefined || options[name] === false) continue;
      return `${entry.flag} cannot be used with ${other.flag}: ${adapter.executable} refuses both at once,`
        + ` and ${entry.flag} already covers it. Leave ${other.name} unset, or turn ${entry.name} off.`;
    }
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
  const cwd = request.cwd?.trim() || conchHome();
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

/**
 * Flags that pick WHICH conversation to open, not how to run it. A restart
 * always resumes the row's own id, so these are dropped quietly: carrying
 * `--fork-session` over would give the conversation a new id on every restart.
 * The value says whether the flag takes one (`--resume` only sometimes does).
 */
const CONVERSATION_SELECTORS: Record<SessionBackend, Record<string, "value" | "optional" | "none">> = {
  claude: { "--resume": "optional", "-r": "optional", "--continue": "none", "-c": "none", "--session-id": "value", "--fork-session": "none" },
  codex: { "--last": "none" },
};

/**
 * How to bring a live session back after closing it: the same agent, folder
 * and conversation, plus every flag on its command line that the start table
 * knows, each validated the way a start from the sheet is. Anything else that
 * looks like a flag comes back in `notCarriedOver` rather than being replayed:
 * conch only ever puts validated values on a command line.
 *
 * `args` is the process's command line after the executable, split on
 * whitespace (`ps -o args=`). ponytail: that loses quoting, which only matters
 * for values with spaces; no start-table value can contain one.
 */
export function restartRequest(
  session: Pick<SessionInfo, "sessionId" | "agentSessionId" | "backend" | "cwd">,
  args: readonly string[],
): { request: StartSessionRequest; notCarriedOver: string[] } {
  const backend = session.backend ?? "claude";
  const adapter = adapterFor(backend);
  const resumeSessionId = session.agentSessionId ?? session.sessionId;
  // Explicitly off unless the command line had it: the persisted default must
  // not switch permissions on (or off) for a session that ran the other way.
  const options: Record<string, string | boolean> = { [BYPASS_OPTION]: false };
  const notCarriedOver: string[] = [];
  const selectors = CONVERSATION_SELECTORS[backend];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("-")) continue;
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = equals > 0 ? token.slice(0, equals) : token;
    const inline = equals > 0 ? token.slice(equals + 1) : undefined;
    const next = args[index + 1];
    const takeNext = () => (inline === undefined && next !== undefined && !next.startsWith("-") ? (index += 1, next) : undefined);
    const selector = selectors[flag];
    if (selector) {
      if (selector !== "none") takeNext();
      continue;
    }
    const entry = adapter.startOptions.find((option) => option.flag === flag);
    if (!entry) {
      notCarriedOver.push([token, takeNext()].filter(Boolean).join(" ").slice(0, 120));
      continue;
    }
    const value = entry.kind === "bool" ? true : inline ?? takeNext();
    if (value !== undefined && !startOptionsError({ backend, resumeSessionId, options: { [entry.name]: value } })) {
      options[entry.name] = value;
    } else {
      notCarriedOver.push(`${flag}${typeof value === "string" ? ` ${value}` : ""}`.slice(0, 120));
    }
  }
  return {
    request: { backend, resumeSessionId, ...(session.cwd ? { cwd: session.cwd } : {}), options },
    notCarriedOver,
  };
}

/** A process's command line after the executable, split on whitespace; null when `ps` can't say. */
export async function readProcessArgs(pid: number): Promise<string[] | null> {
  const child = Bun.spawn(["ps", "-o", "args=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const output = await processText(child.stdout);
  if (await child.exited !== 0 || !output.trim()) return null;
  return output.trim().split(/\s+/).slice(1);
}

/** A background job id as Claude Code prints it (`f31f0d15`): never a shell word, never an option. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function checkedJobId(jobId: string): string {
  if (!JOB_ID.test(jobId)) {
    throw new Error("background job id must be letters, digits, underscores or hyphens, starting with a letter or digit");
  }
  return jobId;
}

/**
 * Opens a running background job in a terminal: `claude attach <jobId>` in the
 * job's folder. Its help: "Open the background session in this terminal. ←
 * returns to agent view, Ctrl+Z drops back to your shell. The session keeps
 * running either way." No `exec`, unlike a start: exec would leave no shell
 * for Ctrl+Z to drop back to.
 */
export function attachTerminalCommand(jobId: string, cwd?: string): string {
  return `cd -- ${shellQuote(cwd?.trim() || conchHome())} && ${adapterFor("claude").executable} attach ${shellQuote(checkedJobId(jobId))}`;
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

async function boundedExit(
  child: SessionLifecycleProcess,
  timeoutMs = 4_000,
  what = "Terminal automation",
): Promise<number> {
  const timeout = "timeout" as const;
  const result = await Promise.race([
    child.exited,
    Bun.sleep(timeoutMs).then(() => timeout),
  ]);
  if (result === timeout) {
    child.cancel();
    throw new Error(`${what} timed out`);
  }
  return result;
}

/** UI work shares the injector's child-exit seal as well as its transaction queue. */
/** A helper that timed out or failed is an error here, never a silent "not found". */
function checkedTerminalResult<T extends { text: string; stderr?: string; exitCode?: number; timedOut: boolean }>(result: T): T {
  if (result.timedOut) throw new Error("Terminal automation timed out");
  if ((result.exitCode ?? 0) !== 0) throw new Error((result.stderr ?? "").trim() || `Terminal returned ${result.exitCode}`);
  return result;
}

async function runTerminalAutomation(argv: string[], dependencies: SessionLifecycleDependencies) {
  return checkedTerminalResult(await runTerminalUI(argv, dependencies));
}

async function runTerminalUI(argv: string[], dependencies: SessionLifecycleDependencies) {
  const result = await runUICommand(argv, undefined, {
    timeoutMs: dependencies.automationTimeoutMs,
    spawn: dependencies.spawn && ((args) => {
      const child = dependencies.spawn!(args);
      return {
        exited: child.exited,
        stdout: child.stdout ?? new Response("").body!,
        stderr: child.stderr ?? new Response("").body!,
        kill: () => child.cancel(),
      };
    }),
  });
  return result;
}

/** Native Terminal prevents a launched agent from inheriting conch's tmux environment. */
export async function startTerminalSession(
  request: StartSessionRequest,
  dependencies: SessionLifecycleDependencies = {},
): Promise<{ tty?: string }> {
  const command = terminalSessionCommand(request);
  const tty = await withUITransaction(() => runInTerminal(command, adapterFor(request.backend).executable, request.cwd, dependencies));
  return tty ? { tty } : {};
}

/** Claude Code's trust screen, as 2.1.280 shows it: "❯ No, exit" first and highlighted. */
const CLAUDE_TRUST_YES = "Yes, I trust this folder";

/**
 * Answer Claude Code's "trust this folder?" in the Terminal tab conch just opened, once you
 * have said yes in the app. Unlike Codex, Claude takes no such answer at launch, so it is
 * typed: Down, then Return (measured on 2.1.280; Claude records the trust itself). Only
 * while the screen shows exactly that menu with "No, exit" highlighted; anything else is
 * left to you.
 */
export async function acceptClaudeTrust(
  tty: string,
  dependencies: {
    read?: (tty: string) => Promise<string | null>;
    press?: (tty: string) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    waitMs?: number;
  } = {},
): Promise<"accepted" | "not-asked" | "failed"> {
  const read = dependencies.read ?? readTerminalTab;
  const press = dependencies.press ?? pressTrustKeys;
  const sleep = dependencies.sleep ?? Bun.sleep;
  // A login shell and a cold agent take a few seconds before the screen appears.
  for (let waited = 0; waited < (dependencies.waitMs ?? 25_000); waited += 400) {
    await sleep(400);
    const screen = await read(tty);
    if (screen === null) continue;
    if (!screen.includes(CLAUDE_TRUST_YES)) {
      // The agent's own input box: it started without asking.
      if (claudeInputBoxText(screen) !== null) return "not-asked";
      continue;
    }
    if (!/❯\s*No, exit/.test(screen) || !(await press(tty))) return "failed";
    for (let check = 0; check < 10; check += 1) {
      await sleep(300);
      const after = await read(tty);
      if (after !== null && !after.includes(CLAUDE_TRUST_YES)) return "accepted";
    }
    return "failed";
  }
  return "failed";
}

/** Down, then Return, into the tab on this tty, each behind the focus guard. */
function pressTrustKeys(tty: string): Promise<boolean> {
  return withUITransaction(async () => {
    const focused = await focusSessionWindow(tty, runOsaLines);
    if (focused.timedOut || (focused.exitCode ?? 0) !== 0 || focused.text.trim() !== "ok") return false;
    await Bun.sleep(200);
    const pressed = await focusedAction(tty, runOsaLines, [
      'tell application "System Events" to key code 125',
      "delay 0.25",
      ...FOCUS_GUARD_LINES,
      'tell application "System Events" to key code 36',
    ]);
    return !pressed.timedOut && (pressed.exitCode ?? 0) === 0 && pressed.text.trim() === "ok";
  });
}

const runOsaLines: OsaRunner = (lines, argv = []) => runUICommand(
  ["osascript", ...lines.flatMap((line) => ["-e", line]), ...(argv.length ? ["--", ...argv] : [])],
);

/**
 * "Open in Terminal" for a background job no window is attached to: a new
 * Terminal window running `attachTerminalCommand`, through the same door a
 * start or resume uses.
 */
export async function attachTerminalSession(
  jobId: string,
  cwd: string | undefined,
  dependencies: SessionLifecycleDependencies = {},
): Promise<void> {
  const command = attachTerminalCommand(jobId, cwd);
  await withUITransaction(() => runInTerminal(command, adapterFor("claude").executable, cwd, dependencies));
}

async function runInTerminal(
  command: string,
  executable: string,
  requestedCwd: string | undefined,
  dependencies: SessionLifecycleDependencies,
): Promise<string | undefined> {
  const which = dependencies.which ?? ((name: string) => Bun.which(name));
  if (!which(executable)) throw new Error(`${executable} is not installed or is not on PATH`);
  const cwd = requestedCwd?.trim() || conchHome();
  // The help session's folder is conch's to create, and this is the one door
  // every launch goes through (CLI, the app's sheet via the daemon, the TUI).
  if (cwd === helpSessionDir()) ensureHelpSession();
  const isDirectory = dependencies.isDirectory ?? ((path: string) => statSync(path).isDirectory());
  try {
    if (!isDirectory(cwd)) throw new Error();
  } catch {
    throw new Error(`session directory does not exist: ${cwd}`);
  }
  const opened = await runTerminalAutomation([
    "osascript",
    "-e", "on run argv",
    "-e", 'tell application "Terminal"',
    "-e", "activate",
    "-e", "set newTab to do script (item 1 of argv)",
    // The tab it opened, so what it asks can be read (and a trust prompt answered).
    "-e", "return tty of newTab",
    "-e", "end tell",
    "-e", "end run",
    "--",
    command,
  ], dependencies);
  const tty = /^\/dev\/(ttys?\d+)$/.exec(opened.text.trim())?.[1];
  return tty;
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

/**
 * Ctrl-D asks the CLI to leave through its normal EOF path; no signal is sent
 * to the agent. Once that pid is confirmed gone, its Terminal tab is closed
 * and conch is brought forward — see `closeSessionTabAndReturn`.
 */
export function closeTerminalSession(
  pid: number,
  dependencies: SessionLifecycleDependencies = {},
): Promise<void> {
  return withUITransaction(() => closeTerminalSessionInTransaction(pid, dependencies));
}

async function closeTerminalSessionInTransaction(
  pid: number,
  dependencies: SessionLifecycleDependencies = {},
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("session has no routable pid");
  const probe = dependencies.processIdentity ?? readProcessIdentity;
  const expected = dependencies.expectedIdentity;
  const verify = (): void => {
    if (!expected || expected.pid !== pid || expected.ttyDevice === null
      || !processMatchesProvider(expected, dependencies.backend)
      || !sameProcessIdentity(expected, probe(pid))) throw new Error("session process identity changed or is unavailable; refresh before closing");
  };
  verify();
  const tty = await (dependencies.ttyForPid ?? defaultTtyForPid)(pid);
  if (!tty || tty === "??") throw new Error("session is not attached to a Terminal tty");

  verify();
  // The injector's own primitive, for the same reason it exists there: raising a window and
  // typing into it are two moments, and the UI queue only holds conch's own actions apart. A
  // Cmd-Tab in between used to send a global Ctrl-D into whatever had come forward. The guard
  // re-reads the frontmost app and the front tab's tty inside the script that presses the key.
  const osa: OsaRunner = (lines, argv = []) => runTerminalUI(
    ["osascript", ...lines.flatMap((line) => ["-e", line]), ...(argv.length ? ["--", ...argv] : [])],
    dependencies,
  );
  const focused = checkedTerminalResult(await focusSessionWindow(tty, osa));
  if (focused.text.trim() !== "ok") throw new Error("session Terminal tab was not found");
  await (dependencies.sleep ?? Bun.sleep)(300); // let the raise settle, as injection does
  verify();
  // As many presses as this agent's exit takes (`exitKeystrokes`), in ONE script so
  // the second lands inside Claude Code's 800ms "press again" window, and each one
  // behind the front-window guard: the gap between presses is as open to a Cmd-Tab
  // as the gap after the raise.
  const press = 'tell application "System Events" to keystroke "d" using control down';
  const presses = [press];
  for (let i = 1; i < adapterFor(dependencies.backend).exitKeystrokes; i += 1) {
    presses.push("delay 0.15", ...FOCUS_GUARD_LINES, press);
  }
  const closed = checkedTerminalResult(await focusedAction(tty, osa, presses));
  if (closed.text.trim() !== "ok") {
    throw new Error(closed.text.trim() === "front-window-changed"
      ? "another window came to the front on the Mac; Ctrl-D was not sent"
      : "session Terminal tab was not found");
  }
  // Only after the pid is actually gone: a poll timeout throws above and skips
  // everything below, on purpose — if the process is still stuck, the tab (and
  // whatever it's showing) has to stay on screen for the user to look at, not
  // get closed out from under them.
  await waitForExit(pid, dependencies, "session did not exit cleanly after Ctrl-D");
  await closeSessionTabAndReturn(tty, osa);
}

/**
 * Once the pid is confirmed gone: close the one Terminal tab it was running
 * in, and hand focus back to conch. Both are direct AppleScript, not
 * keystrokes, so neither needs the front-window guard the Ctrl-D presses do.
 *
 * Closes the TAB, never the window — a window can hold tabs from other,
 * unrelated sessions, and only the one that just closed should go with it.
 * The window itself disappears only as a side effect of it being that tab's
 * last one, same as clicking the tab's own close button would do.
 *
 * "notfound" is a normal outcome, not a failure: Terminal's own "when the
 * shell exits" preference may have already closed the tab by the time we get
 * here (the agent's process was the only thing keeping it open — the `exec`
 * in `terminalSessionCommand` means there's no wrapping shell left either).
 *
 * `saving no` is Terminal's Standard Suite close, which does not by itself
 * silence the OTHER dialog Terminal can show — "this window has running
 * processes, terminate them?" — but that one is keyed to a process still
 * running in the tab, and the only process that was ever running there just
 * exited. It can still appear if someone has Terminal's own "Ask before
 * closing" preference set to Always; conch does not override a person's
 * Terminal preferences, and the automation timeout below (same one every
 * other osascript call here already carries) keeps a stuck prompt from
 * hanging conch rather than just sitting on screen.
 *
 * Activating conch is the second statement in the SAME script, after the
 * close, not a separate call before it: if closing the tab errors, the
 * script stops there and conch is never raised over whatever is stuck.
 *
 * Best-effort and swallowed: the session itself already closed by this
 * point (the pid is gone), so nothing here — a tab that outlives its
 * process, a slow Finder, conch not coming forward — is allowed to turn a
 * successful close into a reported failure.
 */
async function closeSessionTabAndReturn(tty: string, osa: OsaRunner): Promise<void> {
  const script = `
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "/dev/${tty}" then
        close t saving no
      end if
    end repeat
  end repeat
end tell
tell application "conch" to activate`;
  try {
    await osa([script]);
  } catch {}
}

async function waitForExit(
  pid: number,
  dependencies: SessionLifecycleDependencies,
  failure: string,
): Promise<void> {
  const pidIsAlive = dependencies.pidIsAlive ?? defaultPidIsAlive;
  const sleep = dependencies.sleep ?? Bun.sleep;
  const attempts = dependencies.exitPollAttempts ?? 40;
  const intervalMs = dependencies.exitPollIntervalMs ?? 100;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await pidIsAlive(pid))) return;
    if (dependencies.expectedIdentity && !sameProcessIdentity(dependencies.expectedIdentity,
      (dependencies.processIdentity ?? readProcessIdentity)(pid))) return;
    await sleep(intervalMs);
  }
  throw new Error(failure);
}

/**
 * Stops a background job: `claude stop <jobId>`, whose help says "Stop a
 * background session. Its conversation is kept; resume it later with `claude
 * attach <id>`" — the promise a clean Ctrl-D exit makes for a terminal
 * session. Ctrl-D is not used: the attached window is only a viewer, and what
 * Ctrl-D does there (leave the viewer, or reach the job) is undocumented. The
 * job's own process is then waited out, as a Ctrl-D close waits for its pid.
 */
export async function stopBackgroundSession(
  jobId: string,
  agentPid: number | undefined,
  dependencies: SessionLifecycleDependencies = {},
): Promise<void> {
  const id = checkedJobId(jobId);
  const { executable } = adapterFor("claude");
  const which = dependencies.which ?? ((name: string) => Bun.which(name));
  const resolved = which(executable);
  if (!resolved) throw new Error(`${executable} is not installed or is not on PATH`);
  const child = (dependencies.spawn ?? defaultSpawn)([resolved, "stop", id]);
  const [code, stderr] = await Promise.all([
    boundedExit(child, dependencies.automationTimeoutMs, `${executable} stop`),
    processText(child.stderr),
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `${executable} stop returned ${code}`);
  if (agentPid && agentPid > 0) {
    await waitForExit(agentPid, dependencies, "background session did not stop");
  }
}

/**
 * What closing a row does. A background job is stopped by id, whether or not a
 * window is attached — never by typing into, or ending, the window. Anything
 * else leaves its terminal through Ctrl-D.
 */
export async function closeSession(
  session: Pick<SessionInfo, "pid" | "jobId" | "agentPid" | "noTerminal" | "processIdentity" | "backend">,
  dependencies: SessionLifecycleDependencies = {},
): Promise<void> {
  if (session.jobId) return stopBackgroundSession(session.jobId, session.agentPid, dependencies);
  if (!session.pid) throw new Error(session.noTerminal ?? "session has no routable pid");
  return closeTerminalSession(session.pid, { ...dependencies, expectedIdentity: session.processIdentity, backend: session.backend });
}

/** The selected cached row is a binding, never a substitute for fresh discovery. */
export async function refreshSessionForClose(
  sessionId: string,
  expected: SessionInfo | undefined,
  refresh: () => Promise<readonly SessionInfo[] | null>,
): Promise<SessionInfo> {
  const fresh = (await refresh())?.filter((session) => session.sessionId === sessionId);
  if (!fresh || fresh.length !== 1) throw new Error("session is not live or is ambiguous");
  const session = fresh[0]!;
  if (!expected || expected.sessionId !== sessionId || expected.pid !== session.pid
    || (expected.backend ?? "claude") !== (session.backend ?? "claude")
    || expected.agentSessionId !== session.agentSessionId || expected.startedAt !== session.startedAt
    || expected.jobId !== session.jobId || expected.agentPid !== session.agentPid) {
    throw new Error("session identity changed or is unavailable; refresh before closing");
  }
  return { ...session, processIdentity: expected.processIdentity };
}
