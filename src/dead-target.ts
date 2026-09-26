import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readProcessIdentity, type ProcessIdentity } from "./process-identity.ts";
import { attachedJobId } from "./sessions.ts";

/**
 * Is the process conch is about to type into still the session it stands for?
 *
 * A row's pid comes from the last registry read, and two things can leave it pointing at a
 * terminal the session has left:
 *
 *  - A Claude Code background job is typed into through the window attached to it, a
 *    `claude attach <jobId>` viewer (see `attachedWindow` in sessions.ts). Stopping the job
 *    does not close that window: it can stay open on a job that no longer runs, and
 *    whatever is typed there reaches no conversation. Until the next registry read, and
 *    for as long as the job's registry entry outlives it, the row still names that window.
 *    On 2026-09-26 a send to the "conch" row was typed at its attach window (pid 10231),
 *    never landed, and went to the clipboard; Tyler then stopped the job and resumed the
 *    conversation in a new terminal.
 *  - A registry entry outlives a process that did not clean up after itself, and its pid
 *    is dead, or already some other process's.
 *
 * Both are refused before a single key, with a reason the apps can put into words; the
 * words go back to the draft. Once the session is resumed its new process registers itself
 * (the SessionStart hook), the row's pid moves to it, and the same send goes there.
 *
 * Claude Code's own test for "is job X running" is the one used here, read the way its
 * daemon-less fallback reads it (2.1.280, `claude stop`/`attach`): `~/.claude/daemon/
 * roster.json` lists each live job under its short id, with the pid of its `--bg-pty-host`
 * and the pid of the session inside it (`replPid`), each beside its start time as
 * `LC_ALL=C TZ=UTC ps -o lstart=` prints it. A job is live while its roster entry is there
 * and that pid is still the process that started then. Measured on this Mac (2026-09-26):
 * job 25d17f50's entry named host 8904 and session 8936 — the `8936.json` registry entry —
 * both `Wed Sep 23 04:39:09 2026`; job f31f0d15's entry left the roster in the same second
 * Claude's daemon logged `bg settled f31f0d15 (killed)`, and its pty sockets went with it.
 *
 * Only positive evidence refuses. A roster or registry that cannot be read, a torn write, a
 * `ps` that fails: the send goes ahead exactly as it did before this check existed.
 */

/** The codes a refused send carries to the apps (ConchDesign's `ConchSendFailure`). */
export const DEAD_TARGET_REASONS = ["session-stopped", "session-ended"] as const;
export type DeadTargetReason = typeof DEAD_TARGET_REASONS[number];

export interface DeadTarget {
  /**
   * `session-stopped`: the background job behind the window is gone.
   * `session-ended`: the process the registry named has exited, or its pid is someone else's.
   */
  reason: DeadTargetReason;
  /** What was found, for the log and errors.jsonl. Never shown as the reason. */
  detail: string;
  jobId?: string;
}

/** What the check knows about the row it is about to type into. */
export interface TargetToCheck {
  pid?: number;
  /** The row's background job, when the registry said the window views one. */
  jobId?: string;
  /** The process the daemon bound to this row, when it bound one. */
  processIdentity?: ProcessIdentity;
}

export interface TargetProbes {
  /** false only when the kernel says there is no such process (ESRCH), as Claude Code's check does. */
  alive?(pid: number): boolean;
  /** The pid's command line, as `ps -o args=` prints it; null when it cannot be read. */
  commandLine?(pid: number): Promise<string | null>;
  /** The process now holding the pid; null when it cannot be read. */
  identity?(pid: number): ProcessIdentity | null;
  /** A file's text; null when there is no such file. Throws when it is there and unreadable. */
  readText?(path: string): string | null;
  /** A directory's entries; null when there is no such directory. Throws when unreadable. */
  listDir?(path: string): string[] | null;
}

export type JobLiveness =
  | { state: "live" }
  | { state: "gone"; detail: string }
  | { state: "unknown" };

const UNKNOWN: JobLiveness = { state: "unknown" };

export async function deadTarget(
  claudeDir: string,
  target: TargetToCheck,
  probes: TargetProbes = {},
): Promise<DeadTarget | null> {
  const { pid } = target;
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return null; // no route: inject refuses that itself
  const alive = probes.alive ?? pidAlive;
  if (!alive(pid)) {
    // The window of a job that is still running only closed: the job needs a window, not a
    // resume, and the route that finds no tty already says it could not reach one.
    if (!target.jobId) return { reason: "session-ended", detail: `pid ${pid} has exited` };
    const job = jobLiveness(claudeDir, target.jobId, probes);
    return job.state === "gone"
      ? { reason: "session-stopped", detail: `pid ${pid} has exited, and ${job.detail}`, jobId: target.jobId }
      : null;
  }
  // The same number, a different process: its registry entry outlived it and the pid came round again.
  const bound = target.processIdentity;
  if (bound?.pid === pid) {
    const now = (probes.identity ?? readProcessIdentity)(pid);
    if (now && now.birth !== bound.birth) {
      return { reason: "session-ended", detail: `pid ${pid} is no longer the session's process (started ${bound.birth}, now ${now.birth})` };
    }
  }
  const args = await (probes.commandLine ?? commandLineOf)(pid);
  const attached = args ? attachedJobId(args) : undefined;
  const jobId = attached ?? target.jobId;
  if (!jobId) return null;
  const job = jobLiveness(claudeDir, jobId, probes);
  if (job.state !== "gone") return null;
  const window = attached ? `\`claude attach ${jobId}\`` : `the window on job ${jobId}`;
  return { reason: "session-stopped", detail: `pid ${pid} is ${window}, and ${job.detail}`, jobId };
}

/**
 * Is Claude Code background job `jobId` running? The daemon's roster first; the session
 * registry only where there is no roster at all.
 */
export function jobLiveness(claudeDir: string, jobId: string, probes: TargetProbes = {}): JobLiveness {
  const readText = probes.readText ?? readTextIfPresent;
  let roster: string | null;
  try { roster = readText(join(claudeDir, "daemon", "roster.json")); } catch { return UNKNOWN; }
  if (roster === null) return registryJobLiveness(claudeDir, jobId, probes);
  let workers: unknown;
  try { workers = (JSON.parse(roster) as { workers?: unknown })?.workers; } catch { return UNKNOWN; } // torn mid-write
  if (!workers || typeof workers !== "object" || Array.isArray(workers)) return UNKNOWN;
  const found = Object.entries(workers as Record<string, any>).find(([short, worker]) =>
    short === jobId || (typeof worker?.sessionId === "string" && worker.sessionId.startsWith(jobId)));
  if (!found) return { state: "gone", detail: `job ${jobId} is not in Claude Code's daemon roster` };
  const [short, worker] = found;
  if (!processLive(worker?.pid, worker?.procStart, probes)) {
    return { state: "gone", detail: `job ${short}'s pty host (pid ${worker?.pid}) is gone` };
  }
  if (worker.replPid !== undefined && !processLive(worker.replPid, worker.replProcStart, probes)) {
    return { state: "gone", detail: `job ${short}'s session process (pid ${worker.replPid}) is gone` };
  }
  return { state: "live" };
}

/**
 * With no roster, the job's own registry entry (`~/.claude/sessions/<pid>.json`, kind `bg`).
 * The `.key` files beside them are never opened.
 */
function registryJobLiveness(claudeDir: string, jobId: string, probes: TargetProbes): JobLiveness {
  const dir = join(claudeDir, "sessions");
  let names: string[] | null;
  try { names = (probes.listDir ?? listDirIfPresent)(dir); } catch { return UNKNOWN; }
  if (names === null) return UNKNOWN; // neither source exists: nothing to go on
  const readText = probes.readText ?? readTextIfPresent;
  let complete = true;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let entry: any;
    try { entry = JSON.parse(readText(join(dir, name)) ?? "null"); } catch { complete = false; continue; }
    if (entry?.kind !== "bg") continue;
    if (entry.jobId !== jobId && !(typeof entry.sessionId === "string" && entry.sessionId.startsWith(jobId))) continue;
    return processLive(entry.pid, entry.procStart, probes)
      ? { state: "live" }
      : { state: "gone", detail: `job ${jobId}'s registry entry names pid ${entry.pid}, which is gone` };
  }
  // A torn file could be the job's own: an absence counts only when every entry was read.
  return complete ? { state: "gone", detail: `job ${jobId} has no entry in Claude Code's session registry` } : UNKNOWN;
}

/** Alive, and still the process that started at `procStart`, when the start is known. */
function processLive(pid: unknown, procStart: unknown, probes: TargetProbes): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  if (!(probes.alive ?? pidAlive)(pid)) return false;
  const expected = typeof procStart === "string" ? lstartSeconds(procStart) : null;
  if (expected === null) return true;
  const now = (probes.identity ?? readProcessIdentity)(pid);
  if (!now) return true;
  return Math.abs(Math.floor(now.birthTimeMs / 1000) - expected) <= 1;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Wed Sep 23 04:39:09 2026`, the UTC `ps -o lstart=` Claude Code records, as epoch seconds. */
export function lstartSeconds(lstart: string): number | null {
  const match = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(lstart.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]!);
  if (month < 0) return null;
  return Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) / 1000;
}

/** As Claude Code decides it: only "no such process" is dead. EPERM is someone's live process. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function commandLineOf(pid: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(["ps", "-o", "args=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 2_000);
    try {
      const text = await new Response(proc.stdout).text();
      return await proc.exited === 0 && text.trim() ? text.trim() : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function readTextIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function listDirIfPresent(path: string): string[] | null {
  try {
    return readdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
