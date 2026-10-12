import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appServerNoTerminal } from "./codex-threads.ts";
import type { SessionInfo } from "./sessions.ts";
import { processParentTable, windowKey } from "./window-key.ts";

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
  if (typeof callerPid !== "number" || !Number.isSafeInteger(callerPid) || callerPid <= 1) {
    return unverified("callerPid must be the calling process's pid");
  }
  const { infos, claudeDir } = dependencies;
  const parents = await (dependencies.parents ?? processParentTable)().catch(() => null);
  let pid = callerPid;
  for (let hop = 0; hop < CALLER_WALK_MAX && pid > 1; hop += 1) {
    const who = pid === callerPid ? `pid ${pid}` : `pid ${pid} (an ancestor of ${callerPid})`;
    if (isAppServer(pid, infos)) {
      return unverified(`${who} is a Codex app-server, which hosts many threads under one pid, so it cannot say which thread is calling`);
    }
    const bound = await sessionOfProcess(pid, infos, claudeDir, who, dependencies.read ?? readText);
    if (bound) return bound;
    const parent = parents?.get(pid);
    if (parent === undefined || parent === pid) break;
    pid = parent;
  }
  return unverified(`no live session conch knows started pid ${callerPid}`);
}
