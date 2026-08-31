/**
 * A session id is not a window.
 *
 * `claude --resume <id>` in a second terminal keeps the id, so two live windows
 * can share one. Tyler works that way: `~/arch-website` and `~/arch-swap`, both
 * on `4eb30ede`, writing one transcript on separate parentUuid branches —
 * "theyre both open and seem to have diverged with no problems".
 *
 * conch keys everything a person can address — status, held turns, pause,
 * dismissal, the row itself — by session id. So a shared id gets a key that
 * names the WINDOW instead, and those maps become per-window with no other
 * change. The plain id is kept as the agent id, for the few things that mean
 * the session itself: resuming it, or asking whether it is still alive.
 *
 * The suffix appears only while an id is shared. That is deliberate: a lone
 * session keeps the id it has always had, so labels, dismissals and every
 * stored key still match. The cost is that opening a second window on an id
 * re-keys the first one, which reads as a row replaced rather than renamed.
 */

const SEPARATOR = "#";

/** The key a window is addressed by: its session id unless that id is shared. */
export function windowKey(
  sessionId: string,
  pid: number | undefined,
  shared: boolean,
): string {
  return shared && pid ? `${sessionId}${SEPARATOR}${pid}` : sessionId;
}

/** Split a key back into the session it belongs to and the window that owns it. */
export function parseWindowKey(key: string): { sessionId: string; pid?: number } {
  const at = key.lastIndexOf(SEPARATOR);
  if (at <= 0) return { sessionId: key };
  const pid = Number(key.slice(at + 1));
  if (!Number.isInteger(pid) || pid <= 0) return { sessionId: key };
  return { sessionId: key.slice(0, at), pid };
}

/** True when this key names one window of a session that has more than one. */
export function isWindowKey(key: string): boolean {
  return parseWindowKey(key).pid !== undefined;
}

/**
 * Which of a session's windows a hook belongs to.
 *
 * Claude Code's hook payload carries `session_id` and no way to tell one window
 * from another — but a hook runs as a descendant of the window that fired it,
 * so the answer is in the process tree. Walking up from here to the first pid
 * the registry knows finds the exact window, where matching on session id alone
 * can only guess between two.
 *
 * Only called when an id really is shared: it costs a `ps`, and a session with
 * one window already has its answer.
 */
export async function windowPidFromAncestry(
  candidates: Set<number>,
  startPid: number = process.pid,
): Promise<number | undefined> {
  if (candidates.size === 0) return undefined;
  const parents = await parentTable();
  if (!parents) return undefined;
  let pid = startPid;
  // A hook sits a couple of levels below its window (bun under a shell under
  // claude). The bound is only a cycle guard — a truncated walk returns
  // undefined and the caller falls back to its own guess.
  for (let hop = 0; hop < 16 && pid > 1; hop += 1) {
    if (candidates.has(pid)) return pid;
    const parent = parents.get(pid);
    if (parent === undefined) return undefined;
    pid = parent;
  }
  return undefined;
}

async function parentTable(): Promise<Map<number, number> | null> {
  try {
    const proc = Bun.spawn(["ps", "-Ao", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    const table = new Map<number, number>();
    for (const line of text.split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid, ppid);
    }
    return table.size > 0 ? table : null;
  } catch {
    return null;
  }
}
