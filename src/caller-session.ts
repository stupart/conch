import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appServerNoTerminal } from "./codex-threads.ts";
import type { SessionInfo } from "./sessions.ts";
import { processParentTableWith, windowKey } from "./window-key.ts";

/**
 * Which live session a process belongs to: the MCP server's own parent (mcp.ts `callerBinding`), and any process an
 * agent started, walked up to the agent (`sessionForCallerPid`, for the Workbench's `browser-open`, which the `open`
 * shim sends with its own pid).
 *
 * A pid one row carries is that row. A pid several rows carry, or a Codex app-server's (it hosts every thread it has
 * open under one pid, and conch withholds the pid from those rows), says only "one of these", which is no binding. A
 * background session's row carries no pid, but Claude Code names each registry file after its process, so
 * `<claudeDir>/sessions/<pid>.json` still says which session a process is.
 */

/** Whether conch could tell which session is calling, and why not when it could not. */
export type CallerBinding =
  | { status: "verified"; session: SessionInfo }
  | { status: "unverified"; reason: string };

export const unverified = (reason: string): CallerBinding => ({ status: "unverified", reason });

export type ReadText = (path: string) => Promise<string>;
const readText: ReadText = (path) => readFile(path, "utf8");

/** A Codex app-server: many threads under this one pid. */
export function isAppServer(pid: number, infos: readonly SessionInfo[]): boolean {
  return infos.some((session) => session.noTerminal === appServerNoTerminal(pid));
}

/**
 * What one process says about the session it is: verified, unverified with why (it runs several, or its registry file
 * names a session conch doesn't know), or null when it isn't a session's process at all. `who` begins the reasons.
 */
export async function sessionOfProcess(
  pid: number,
  infos: readonly SessionInfo[],
  claudeDir: string,
  who: string = `pid ${pid}`,
  read: ReadText = readText,
): Promise<CallerBinding | null> {
  const byPid = infos.filter((session) => session.pid === pid);
  if (byPid.length === 1) return { status: "verified", session: byPid[0]! };
  if (byPid.length > 1) {
    return unverified(
      `${who} runs ${byPid.length} sessions`
        + ` (${byPid.map((session) => session.sessionId).join(", ")}), so the pid cannot say which one is calling`,
    );
  }
  const own = await read(join(claudeDir, "sessions", `${pid}.json`))
    .then((raw) => JSON.parse(raw)?.sessionId)
    .catch(() => undefined);
  if (typeof own !== "string" || !own) return null;
  const window = windowKey(own, pid, true);
  const found = infos.find((session) => session.sessionId === window) ?? infos.find((session) => session.sessionId === own);
  return found ? { status: "verified", session: found } : unverified(`${who} is not a live session conch knows`);
}

export interface CallerPidDependencies {
  infos: readonly SessionInfo[];
  claudeDir: string;
  /** Every process's parent (`processParentTable`); injectable so a test hands in a fake tree. */
  parents?: () => Promise<ReadonlyMap<number, number> | null>;
  read?: ReadText;
}

/** How far up a process tree conch looks: a shell under a tool under the agent is three; the bound is a cycle guard. */
export const CALLER_WALK_MAX = 32;

/**
 * The session a process was started by: up from `callerPid`, through its parents, to the first process that is a
 * session's (`sessionOfProcess`). The nearest wins, so a Codex that Claude Code's Bash tool started is the Codex.
 * A Codex app-server on the way is a refusal, as it is for the MCP server: it can't say which of its threads asked.
 */
export async function sessionForCallerPid(callerPid: unknown, dependencies: CallerPidDependencies): Promise<CallerBinding> {
  return (await walkToSession(callerPid, dependencies)).binding;
}

/** A walk up from a process: what it found, the process it stopped at, and the Codex app-server when that is why. */
interface Walked {
  binding: CallerBinding;
  /** The process that was a session's, when one was. */
  at?: number;
  /** The Codex app-server the walk reached, which can't say which of its threads asked. */
  appServer?: number;
}

async function walkToSession(callerPid: unknown, dependencies: CallerPidDependencies): Promise<Walked> {
  if (typeof callerPid !== "number" || !Number.isSafeInteger(callerPid) || callerPid <= 1) {
    return { binding: unverified("callerPid must be the calling process's pid") };
  }
  const { infos, claudeDir } = dependencies;
  // A table that places the caller, which may be younger than the shared look (window-key.ts).
  const parents = await (dependencies.parents ?? (() => processParentTableWith([callerPid])))().catch(() => null);
  let pid = callerPid;
  for (let hop = 0; hop < CALLER_WALK_MAX && pid > 1; hop += 1) {
    const who = pid === callerPid ? `pid ${pid}` : `pid ${pid} (an ancestor of ${callerPid})`;
    if (isAppServer(pid, infos)) {
      return {
        binding: unverified(`${who} is a Codex app-server, which hosts many threads under one pid, so it cannot say which thread is calling`),
        appServer: pid,
      };
    }
    const bound = await sessionOfProcess(pid, infos, claudeDir, who, dependencies.read ?? readText);
    if (bound) return { binding: bound, at: pid };
    const parent = parents?.get(pid);
    if (parent === undefined || parent === pid) break;
    pid = parent;
  }
  return { binding: unverified(`no live session conch knows started pid ${callerPid}`) };
}

/** What Codex names the calling thread with in each shell command it runs (Codex 0.167: beside `CODEX_TOOL_CALL_ID`). */
export const CODEX_THREAD_ENV = "CODEX_THREAD_ID";

/** Which session a `conch agent` command was run from, and how conch knows: `via` says, for `conch agent whoami`. */
export interface ShellCaller {
  binding: CallerBinding;
  via?: string;
  /** The process the walk found the session at. */
  pid?: number;
}

/**
 * The session a command run in an agent's shell belongs to (agent-cli.ts), as sure as the MCP server's `callerBinding`.
 *
 * 2026-11-11, Tyler: "I would also like to add a cli cause I think it might be better to put all our stuff in for agents
 * to use without killing context". The MCP server knew its caller because the session spawned it; a shell command is
 * further down the same tree (claude → zsh → conch), so it walks up from its own pid, read off the process table, to the
 * first process that is a live session's (`sessionForCallerPid`), the rule the `open` shim already lives by. Its own
 * ancestry is the OS's word, not the agent's: no flag or variable the agent sets can move it under another session.
 *
 * A Codex app-server on the way hosts many threads under one pid, which the MCP server tells apart by the thread id the
 * Codex client puts on each call. A shell has no such channel, but Codex puts the calling thread in the command's own
 * environment (`CODEX_THREAD_ID`), so that names the thread, and only among the threads THAT app-server hosts: the tree
 * still bounds what it can claim. It is weaker than the MCP server's (the agent could set the variable itself), which is
 * one reason publishing stays an MCP tool. Claude Code's own `CLAUDE_CODE_SESSION_ID` is not read: the tree already says,
 * and a variable can be set by anyone.
 */
export async function sessionForShell(options: CallerPidDependencies & {
  pid: number;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<ShellCaller> {
  const walked = await walkToSession(options.pid, options);
  if (walked.binding.status === "verified") {
    return { binding: walked.binding, via: `process tree: this shell runs under pid ${walked.at}, the session's own process`, pid: walked.at };
  }
  if (walked.appServer === undefined) return { binding: walked.binding };
  const thread = options.env[CODEX_THREAD_ENV]?.trim();
  if (!thread) {
    return {
      binding: unverified(`${walked.binding.reason}, and this shell has no ${CODEX_THREAD_ENV} to say which (a Codex older than 0.167)`),
    };
  }
  const hosted = options.infos.filter((session) =>
    session.backend === "codex" && session.sessionId === thread && session.noTerminal === appServerNoTerminal(walked.appServer!));
  return hosted.length === 1
    ? { binding: { status: "verified", session: hosted[0]! }, via: `${CODEX_THREAD_ENV}, one of the threads Codex app-server pid ${walked.appServer} hosts`, pid: walked.appServer }
    : { binding: unverified(`${CODEX_THREAD_ENV} ${thread} is not a thread the Codex app-server above this shell (pid ${walked.appServer}) hosts`) };
}
