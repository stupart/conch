import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { claudeInputBoxText, type AnswerKey } from "./agent-adapter.ts";
import { claudeProjectSlug } from "./claude-title.ts";
import { conchHome } from "./home.ts";
import type { McpServerProcess, McpServerReport, ToolsStale } from "./mcp-servers.ts";
import type { SettingsDriverDeps } from "./session-settings.ts";
import type { SessionInfo } from "./sessions.ts";

/**
 * A live Claude Code session whose conch MCP server failed to start: found, and repaired by typing `/reload-plugins`.
 *
 * 2026-10-23: Homebrew upgraded bun and deleted the Cellar bun conch's plugin named. The daemon repaired the plugin's
 * files at its next start (`repairPluginPrograms`), but a session that had started while the path was broken never got
 * conch's tools, and nothing said so: `toolsStaleFor` has nothing to say about a session with no conch server at all.
 * Two live sessions were left that way. `/mcp reconnect plugin:conch:conch` doesn't help, it reuses the config the
 * session loaded at start ("Failed to reconnect to plugin:conch:conch"); `/reload-plugins` does, it reads the plugin
 * again and starts a fresh server (tried on a background session the same day: "Reloaded: 4 plugins · … · 4 plugin MCP
 * servers", and a new `conch mcp` child of the session).
 *
 * Claude Code logs each MCP server per project, in the same place whatever CLAUDE_CONFIG_DIR says:
 * `~/Library/Caches/claude-cli-nodejs/<project slug>/mcp-logs-plugin-conch-conch/<ISO time>.jsonl`. One file per
 * session process, named for its first connection and appended to by every later one (a reconnect, a reload), each line
 * carrying the session id. A failed start ends `{"error":"Connection failed (ENOENT): ENOENT: no such file or directory,
 * posix_spawn 'stdio'"}` (Claude Code names 'stdio' there, not the program it couldn't find); a good one goes on to
 * "Successfully connected" and tool calls.
 *
 * So once a minute, beside `toolsStaleFor`, the daemon looks for a live Claude session with no conch server (no report
 * naming it, no `conch mcp` child) whose own log ends in a failed connection: one folder, a few small files, their
 * tails. That session's row says so (`toolsStale`, basis `failed`), and when the plugin's program is there now and the
 * session is at rest with an empty prompt, conch types `/reload-plugins` into it, once per log file, and checks that a
 * server appeared.
 */

/** The folder Claude Code logs conch's MCP server in, under a project's cache folder. */
export const CONCH_MCP_LOG_FOLDER = "mcp-logs-plugin-conch-conch";

/** What conch types to start a session's conch server again. */
export const RELOAD_PLUGINS = "/reload-plugins";

/** How long after `/reload-plugins` a server is given to appear before the attempt counts as failed. */
export const RELOAD_VERIFY_MS = 20_000;

/**
 * How long the Mac must have been left alone before conch brings a session's Terminal window forward to type into it.
 * A tmux session takes the keys where it is; a Terminal window has to come to the front and take the keyboard
 * (`osascript-focused`), and nobody asked for this, so it waits until nobody is at the keyboard to be interrupted.
 */
export const REPAIR_AWAY_SECS = 120;

/** Claude Code's cache folder (`env-paths("claude-cli")` on macOS), the same for every CLAUDE_CONFIG_DIR. */
export function claudeCacheDir(home: string = conchHome()): string {
  return join(home, "Library", "Caches", "claude-cli-nodejs");
}

/** Where Claude Code logs conch's MCP server for sessions working in `cwd`. */
export function conchMcpLogDir(cwd: string, cacheDir: string = claudeCacheDir()): string {
  return join(cacheDir, claudeProjectSlug(cwd), CONCH_MCP_LOG_FOLDER);
}

/** A log file's name is its first connection's time, `2026-10-23T20-45-53-505Z.jsonl`; epoch ms, or undefined for another file. */
export function mcpLogFileTime(name: string): number | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.jsonl$/.exec(name);
  if (!match) return undefined;
  const at = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(at) ? at : undefined;
}

/** What the newest connection in a log came to. */
export type McpConnectionOutcome =
  | { state: "failed"; error: string; at: number }
  | { state: "connected" }
  | { state: "connecting" };

type LogEntry = { error?: unknown; debug?: unknown; timestamp?: unknown; sessionId?: unknown };

function parseLines(lines: readonly string[]): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of lines) {
    try {
      const entry: unknown = JSON.parse(line);
      if (entry && typeof entry === "object" && !Array.isArray(entry)) entries.push(entry as LogEntry);
    } catch {}
  }
  return entries;
}

/**
 * The newest connection a log's lines record, read from the end: a failed one (its `error` line, or the debug line
 * before it when that is the last), one that came up (or a tool call, which only a live connection makes), or an
 * attempt still under way. null when the lines say nothing about a connection.
 */
export function lastConnectionOutcome(lines: readonly string[]): McpConnectionOutcome | null {
  const entries = parseLines(lines);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const { error, debug, timestamp } = entries[index]!;
    const said = typeof error === "string" ? error : typeof debug === "string" ? debug : "";
    if (/^Connection failed\b/.test(said)) {
      const at = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
      return { state: "failed", error: said, at: Number.isFinite(at) ? at : 0 };
    }
    if (/^(?:Successfully connected|Connection established|Calling MCP tool|Tool ')/.test(said)) return { state: "connected" };
    if (/^Starting connection\b/.test(said)) return { state: "connecting" };
  }
  return null;
}

/** The last `bytes` of a file as whole lines: a line cut at the start is dropped. */
function tailLines(path: string, bytes: number): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((line) => line.trim());
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A session's conch MCP server that failed to start, as its log says. */
export interface McpConnectionFailure {
  /** The log file: one per session process, so it keys the one repair attempt. */
  file: string;
  /** Claude Code's words for it. */
  error: string;
  /** When, epoch ms. */
  at: number;
}

/**
 * Whether a session's newest conch MCP connection failed, from its own log.
 *
 * Cheap on purpose: one folder (the session's project), at most `maxFiles` files, the last `tailBytes` of each. The
 * session's own file was started with its first connection, moments after the process, so with its start known the
 * files from a minute before it are read oldest first; without it, the newest. The first whose lines carry the session's
 * id is its file.
 */
export function findConchMcpFailure(options: {
  cwd: string | undefined;
  /** Claude Code's own id for the session (`agentSessionId`), as its log lines carry it. */
  sessionId: string;
  /** When the session process started, epoch ms. */
  startedAt?: number;
  cacheDir?: string;
  maxFiles?: number;
  tailBytes?: number;
}): McpConnectionFailure | null {
  if (!options.cwd || !options.sessionId) return null;
  const dir = conchMcpLogDir(options.cwd, options.cacheDir);
  let named: Array<{ name: string; at: number }>;
  try {
    named = readdirSync(dir).flatMap((name) => {
      const at = mcpLogFileTime(name);
      return at === undefined ? [] : [{ name, at }];
    });
  } catch {
    return null;
  }
  const since = options.startedAt ? options.startedAt - 60_000 : undefined;
  const candidates = since === undefined
    ? named.sort((a, b) => b.at - a.at)
    : named.filter((file) => file.at >= since).sort((a, b) => a.at - b.at);
  for (const { name } of candidates.slice(0, options.maxFiles ?? 6)) {
    const file = join(dir, name);
    const lines = tailLines(file, options.tailBytes ?? 16_384);
    if (!parseLines(lines).some((entry) => entry.sessionId === options.sessionId)) continue;
    const outcome = lastConnectionOutcome(lines);
    return outcome?.state === "failed" ? { file, error: outcome.error, at: outcome.at } : null;
  }
  return null;
}

/**
 * Whether any conch MCP server serves one of a session's processes: a report naming it, or a `conch mcp` child of it.
 * undefined when that can't be said (no report, and the processes couldn't be listed).
 */
export function hasConchMcpServer(
  pids: readonly number[],
  reports: readonly McpServerReport[],
  processes: readonly McpServerProcess[] | null,
): boolean | undefined {
  if (reports.some((report) => pids.includes(report.sessionPid))) return true;
  if (!processes) return undefined;
  return processes.some((process) => pids.includes(process.ppid));
}

/**
 * A live session's failed conch MCP server, or null: a Claude session (Codex has no `/reload-plugins`, and its servers
 * aren't logged here) that no conch server serves, whose log ends in a failed connection. A background job's server is
 * the job's child, not its window's, so both pids count.
 */
export function conchMcpFailureFor(
  session: Pick<SessionInfo, "backend" | "pid" | "agentPid" | "cwd" | "sessionId" | "agentSessionId" | "startedAt">,
  reports: readonly McpServerReport[],
  processes: readonly McpServerProcess[] | null,
  cacheDir?: string,
): McpConnectionFailure | null {
  if (session.backend === "codex") return null;
  const pids = [session.pid, session.agentPid].filter((pid): pid is number => typeof pid === "number" && pid > 0);
  if (!pids.length || hasConchMcpServer(pids, reports, processes) !== false) return null;
  return findConchMcpFailure({
    cwd: session.cwd,
    sessionId: session.agentSessionId ?? session.sessionId,
    ...(session.startedAt ? { startedAt: session.startedAt } : {}),
    ...(cacheDir ? { cacheDir } : {}),
  });
}

/** Claude Code's error without its own preamble: "ENOENT: no such file or directory, posix_spawn 'stdio'". */
export function mcpFailureWords(error: string): string {
  const words = error.replace(/^Connection failed\b[^(]*(?:\([A-Za-z0-9_]+\))?:?\s*/, "").replace(/\s+/g, " ").trim() || error.trim();
  return words.length > 160 ? `${words.slice(0, 159)}…` : words;
}

/** What conch did about a failure, by log file: typed `/reload-plugins` at `at`, and whether a server came of it. */
export interface McpRepairAttempt {
  at: number;
  ok: boolean;
  /** Why it didn't work, when it didn't. */
  reason?: string;
}

/** The row's verdict for a session whose conch server failed: every current tool missing, why, and what fixes it. */
export function failedServerStale(failure: McpConnectionFailure, currentTools: readonly string[], attempt?: McpRepairAttempt): ToolsStale {
  const tried = attempt && !attempt.ok ? `; conch tried ${RELOAD_PLUGINS}: ${attempt.reason ?? "it didn't come back"}` : "";
  return {
    missing: [...currentTools],
    basis: "failed",
    ...(failure.at ? { failedAt: new Date(failure.at).toISOString() } : {}),
    why: `its conch MCP server failed to start (${mcpFailureWords(failure.error)})${tried}`,
    fix: `type ${RELOAD_PLUGINS} in this session, or restart it (close it and resume it), to start conch's MCP server again`,
  };
}

/**
 * Why conch won't type `/reload-plugins` into a session now, from what it knows without touching the session; null
 * when it may go on to look at its terminal. Only a failure already tried is never tried again; anything else, the
 * next look asks again.
 */
export function repairBlocker(input: {
  attempted: boolean;
  dismissed: boolean;
  runnable: { ok: true } | { ok: false; why: string };
  /** The row's status: `waiting` is at rest. */
  status: string | null | undefined;
}): string | null {
  if (input.attempted) return `conch has already typed ${RELOAD_PLUGINS} for this failure`;
  if (input.dismissed) return "the session is dismissed from conch";
  // A reload would start the same missing program and fail the same way.
  if (!input.runnable.ok) return `the plugin's server can't start yet: ${input.runnable.why}`;
  if (input.status !== "waiting") return "the session isn't at rest";
  return null;
}

/**
 * Why conch won't type into the session by the route it has: none at all, or a Terminal window it would have to bring
 * to the front while someone is using the Mac (`REPAIR_AWAY_SECS`; an unreadable idle time counts as someone there).
 */
export function routeBlocker(input: {
  route: "tmux" | "terminal" | null;
  keystrokeFallback: boolean;
  idleSeconds: number | null;
}): string | null {
  if (input.route === "tmux") return null;
  if (input.route === null) return "it has no terminal conch can type into";
  if (!input.keystrokeFallback) return "typing into Terminal windows is off (keystroke-fallback)";
  if (input.idleSeconds === null || input.idleSeconds < REPAIR_AWAY_SECS) {
    return "its Terminal window would have to come to the front while the Mac is in use";
  }
  return null;
}

/** Both agents say it while a turn runs (session-settings.ts). */
const BUSY = /esc to interrupt/i;

/** Why a Claude session's screen can't take a typed command now; null when its prompt is on screen and empty. */
export function promptBlocker(screen: string | null): string | null {
  if (screen === null) return "conch can't read the session's screen";
  if (BUSY.test(screen)) return "the session is working";
  const prompt = claudeInputBoxText(screen);
  if (prompt === null) return "its prompt isn't on screen (a dialog may be open)";
  if (prompt !== "") return "its prompt holds words the person hasn't sent";
  return null;
}

export type SlashCommandOutcome = { ok: true } | { ok: false; reason: string; typed: boolean };

/**
 * Type a slash command into a Claude session's empty prompt and submit it, the way `/model` is opened
 * (`driveSessionSettings`): the screen is read first and must show an empty prompt and no turn running; the command is
 * typed, NOT submitted, and the prompt read again; anything but exactly the command there is backspaced away and the
 * prompt left as it was. `typed` says whether anything reached the session.
 */
export async function submitSlashCommand(
  command: string,
  deps: SettingsDriverDeps,
  settleMs = 350,
): Promise<SlashCommandOutcome> {
  const blocked = promptBlocker(await deps.read());
  if (blocked) return { ok: false, reason: blocked, typed: false };
  if (!(await deps.type(command))) return { ok: false, reason: `couldn't type ${command} into the session`, typed: false };
  await deps.sleep(settleMs);
  const typed = await deps.read();
  if (typed === null || claudeInputBoxText(typed) !== command) {
    await deps.press(Array.from({ length: command.length }, (): AnswerKey => "Backspace"));
    return {
      ok: false,
      reason: typed === null
        ? "lost sight of the session's screen, so conch took back what it typed"
        : `its prompt didn't hold exactly ${command}, so conch took back what it typed`,
      typed: true,
    };
  }
  if (!(await deps.press(["Enter"]))) return { ok: false, reason: `couldn't submit ${command}`, typed: true };
  return { ok: true };
}

/** Ask `appeared` every `intervalMs` until it says yes or `timeoutMs` has gone by. */
export async function waitForServer(
  appeared: () => Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<boolean> {
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? RELOAD_VERIFY_MS);
  while (true) {
    await sleep(options.intervalMs ?? 2_000);
    if (await appeared()) return true;
    if (now() >= deadline) return false;
  }
}
