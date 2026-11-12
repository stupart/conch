import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  type Stats,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileVersion, sameFileVersion, type FileVersion } from "./file-version.ts";

/**
 * Files written by a live task can legitimately go quiet while a tool call is
 * in flight. Real agent transcripts contain gaps just under five minutes, so
 * keep six minutes of headroom over the original 120-second proposal while
 * still aging launch-without-completion orphans out in bounded time.
 */
export const LIVE_WINDOW_MS = 6 * 60 * 1000;

/**
 * How long an agent may be quiet while its own transcript shows it inside a tool call
 * (a build, a test run) with no result yet. Past `LIVE_WINDOW_MS` that is the only thing
 * still counting it live; this bounds an agent that died mid-call without its parent ever
 * being told.
 */
export const MID_TOOL_WINDOW_MS = 3 * 60 * 60 * 1000;

const READ_CHUNK_BYTES = 256 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const TERMINAL_TASK_STATUS = new Set(["completed", "failed", "killed", "stopped"]);

interface Candidate {
  id: string;
  bytes: Buffer;
  /**
   * Quiet past both windows, and a candidate only because it started background work of its own: live only if its
   * parent's newest word on it says it is waiting on that work.
   */
  quiet?: true;
}

/** Bounds for the caches below, which are keyed by folders and files of sessions that come and go. */
const MAX_REMEMBERED = 256;

function remember<Value>(cache: Map<string, Value>, key: string, value: Value): Value {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_REMEMBERED) cache.delete(cache.keys().next().value!);
  return value;
}

/**
 * A subagents folder's names, listed again only when the folder itself changed: an agent's files being added or
 * removed moves the folder's mtime, and nothing else changes what a listing returns. A listing taken within a second
 * of the folder changing is not trusted, so a filesystem with whole-second times cannot hide a file added in that
 * same second. Sessions keep every agent they ever started here: 419 files in one of Tyler's (2026-11-02).
 */
const listings = new Map<string, { ino: number; mtimeMs: number; listedAt: number; names: string[] }>();

function listing(dir: string): string[] | null {
  let folder: Stats;
  try {
    folder = statSync(dir);
  } catch {
    listings.delete(dir);
    return null;
  }
  const known = listings.get(dir);
  if (known && known.ino === folder.ino && known.mtimeMs === folder.mtimeMs && known.listedAt - folder.mtimeMs >= 1000) {
    return known.names;
  }
  const listedAt = Date.now();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    listings.delete(dir);
    return null;
  }
  return remember(listings, dir, { ino: folder.ino, mtimeMs: folder.mtimeMs, listedAt, names }).names;
}

/**
 * Each file's `stat`, once per scan. Both windows below ask about the same `.jsonl` files, which were stat-ed twice.
 * Never kept between scans: appending to an agent's transcript moves its mtime and not its folder's, so a quiet agent
 * woken by SendMessage would read as stale until something else changed the folder.
 */
type StatMemo = Map<string, Stats | null>;

function statOnce(stats: StatMemo, path: string): Stats | null {
  if (stats.has(path)) return stats.get(path)!;
  let stat: Stats | null = null;
  try {
    stat = statSync(path, { throwIfNoEntry: false }) ?? null;
  } catch {}
  stats.set(path, stat);
  return stat;
}

function freshFile(stat: Stats | null, now: number, liveWindowMs: number): boolean {
  return !!stat && stat.isFile() && now - stat.mtimeMs <= liveWindowMs;
}

function freshIds(
  dir: string,
  names: readonly string[],
  stats: StatMemo,
  match: (name: string) => string | undefined,
  now: number,
  liveWindowMs: number,
): Map<string, Candidate> {
  const ids = new Map<string, Candidate>();
  for (const name of names) {
    const id = match(name);
    if (!id || !freshFile(statOnce(stats, join(dir, name)), now, liveWindowMs)) continue;
    ids.set(id, { id, bytes: Buffer.from(id) });
  }
  return ids;
}

/**
 * The last newline before `end`, or -1 when there is none.
 *
 * `end` reaches 0 when the chunk starts with a newline, and `Buffer#lastIndexOf` reads a negative offset as counting
 * from the END (Node's semantics, which Bun follows): `lastIndexOf(0x0a, -1)` found the chunk's last newline again, so
 * the scan went round the same chunk forever, synchronously. That froze the daemon on 2026-09-28 (152% CPU, socket
 * accepting and never answering, SIGTERM ignored): a 256 KiB read boundary landed on a newline in a session whose
 * background agent was still out, and the 20 s panel refresh (`subagentSessions` → `liveBackgroundAgents`) never
 * returned.
 */
function previousNewline(buffer: Buffer, end: number): number {
  return end > 0 ? buffer.lastIndexOf(0x0a, end - 1) : -1;
}

/** Visit complete JSONL lines from newest to oldest without loading the transcript. */
export function visitLinesNewestFirst(
  path: string,
  relevant: (buffer: Buffer) => boolean,
  visit: (line: Buffer) => boolean,
): void {
  const fd = openSync(path, "r");
  try {
    let position = fstatSync(fd).size;
    const floor = Math.max(0, position - MAX_SCAN_BYTES);
    let carry = Buffer.alloc(0);
    while (position > floor) {
      const length = Math.min(READ_CHUNK_BYTES, position - floor);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const read = readSync(fd, chunk, 0, length, position);
      if (read !== length) throw new Error(`short transcript read: expected ${length}, got ${read}`);
      const combined = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      // Most transcript chunks mention none of the handful of fresh task IDs.
      // Skip their individual JSONL lines after retaining only the boundary line.
      if (!relevant(combined)) {
        const firstNewline = combined.indexOf(0x0a);
        carry = firstNewline === -1
          ? Buffer.from(combined)
          : Buffer.from(combined.subarray(0, firstNewline));
        continue;
      }
      let end = combined.length;
      let newline = previousNewline(combined, end);
      while (newline !== -1) {
        if (newline + 1 < end && visit(combined.subarray(newline + 1, end))) return;
        end = newline;
        newline = previousNewline(combined, end);
      }
      carry = Buffer.from(combined.subarray(0, end));
    }
    if (carry.length) visit(carry);
  } finally {
    closeSync(fd);
  }
}

function containsCandidate(line: Buffer, candidates: Map<string, Candidate>): boolean {
  for (const candidate of candidates.values()) {
    if (line.indexOf(candidate.bytes) !== -1) return true;
  }
  return false;
}

function messageText(entry: any): string {
  const content = entry?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "")
    .join("\n");
}

/**
 * The text of a `<task-notification>`, wherever Claude Code filed it: a user
 * message when the parent was idle, a queued-command attachment or a
 * queue-operation when it was mid-turn.
 */
export function taskNotificationText(entry: any): string {
  if (entry?.type === "user" && entry?.origin?.kind === "task-notification") {
    return messageText(entry);
  }
  if (entry?.type === "queue-operation" && typeof entry.content === "string") {
    return entry.content;
  }
  if (
    entry?.type === "attachment"
    && entry?.attachment?.type === "queued_command"
    && typeof entry.attachment.prompt === "string"
  ) {
    return entry.attachment.prompt;
  }
  return "";
}

/**
 * What a task notification says about the task it names. Claude Code 2.1.309 writes one each time a background agent
 * stops, and not every stop is an end. Its summaries, across Tyler's transcripts of the last sixty days (2026-11-12):
 *
 * - `Agent "<name>" finished` (`completed`), 6,789 of them: done.
 * - `Agent "<name>" is waiting on its own background work` (`completed`), 937: NOT done. It stopped with a build or a
 *   push of its own still running, "may resume on its own when that work completes or reports, and the same task-id
 *   notifies again if it does". Claude Code still counts it among the session's running agents.
 * - `Agent "<name>" failed: <why>` (`failed`), 457: a usage limit, a stalled stream, an API error.
 * - `Agent "<name>" was stopped by Claude` (`killed`) and `… stopped at its 200-turn limit` (`completed`).
 *
 * Every ending but the first can be undone: SendMessage to the agent resumes it (`resumedAgentOf`).
 */
export interface TaskNotice {
  taskId: string;
  status: string;
  /** `waiting`: out there still, on its own background work. `ended`: finished, failed or stopped. */
  outcome: "waiting" | "ended" | "other";
  /** Why it ended, when it did not end by finishing: "stopped: usage limit". */
  stopped?: string;
  /** Failed or killed, as opposed to finished or paused. */
  failed: boolean;
}

const WAITING_ON_OWN_WORK = /\bis waiting on its own background work\b/i;

export function parseTaskNotice(text: string): TaskNotice | null {
  const taskId = text.match(/<task-id>\s*([^<]+?)\s*<\/task-id>/)?.[1];
  if (!taskId) return null;
  const status = text.match(/<status>\s*([^<]+?)\s*<\/status>/)?.[1] ?? "";
  const summary = text.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/)?.[1] ?? "";
  const failed = /kill|fail|error/i.test(status);
  // Tyler, 2026-11-12: "conch ui shows 3 sub-agents for u but it says 2 more in the claude code ui." A waiting agent's
  // notification says `completed`, and conch took that word for the agent finishing.
  const outcome = WAITING_ON_OWN_WORK.test(summary)
    ? "waiting"
    : TERMINAL_TASK_STATUS.has(status) ? "ended" : "other";
  const stopped = outcome === "ended" ? stoppedBecause(status, summary) : undefined;
  return {
    taskId,
    status,
    outcome,
    ...(stopped ? { stopped } : {}),
    failed,
  };
}

/** "stopped: usage limit", from a summary that says why; nothing for an agent that finished. */
function stoppedBecause(status: string, summary: string): string | undefined {
  const failure = summary.match(/\bfailed:\s*([\s\S]*)$/i)?.[1]?.trim();
  if (failure !== undefined || /fail|error/i.test(status)) {
    const why = failure ?? "";
    if (/hit your [\w ]*limit|out of (extra )?usage|usage limit|rate_limit/i.test(why)) return "stopped: usage limit";
    if (/\bstalled\b/i.test(why)) return "stopped: stalled";
    if (/\bAPI Error\b/i.test(why)) return "stopped: API error";
    if (/\bnot started\b/i.test(why)) return "stopped: never started";
    const first = why.replace(/^Agent terminated early due to (an )?/i, "").split(/[.(·\n]/)[0]?.trim();
    return first ? `stopped: ${first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first}` : "stopped: failed";
  }
  if (/\bturn limit\b|-turn limit\b/i.test(summary)) return "stopped: turn limit";
  if (/kill/i.test(status) || /\bwas stopped\b/i.test(summary)) return "stopped";
  return undefined;
}

/**
 * The agent a SendMessage result says it resumed: `toolUseResult.resumedAgentId` (Claude Code 2.1.309, beside
 * `revivedAgentId` and a "Resuming agent <id>" message), or the same JSON as the tool result's text.
 */
export function resumedAgentOf(toolUseResult: unknown, resultText = ""): string | undefined {
  const result = toolUseResult as { resumedAgentId?: unknown; revivedAgentId?: unknown } | null | undefined;
  if (result && typeof result === "object") {
    const id = typeof result.resumedAgentId === "string" ? result.resumedAgentId
      : typeof result.revivedAgentId === "string" ? result.revivedAgentId : undefined;
    if (id) return id;
  }
  if (!resultText.includes("resumedAgentId")) return undefined;
  try {
    const parsed = JSON.parse(resultText);
    return typeof parsed?.resumedAgentId === "string" && parsed.resumedAgentId ? parsed.resumedAgentId : undefined;
  } catch {
    return undefined;
  }
}

/** Row id for a subagent: the agent id under a prefix no session id carries. */
export const SUBAGENT_ROW_PREFIX = "agent-";

export function subagentRowId(agentId: string): string {
  return `${SUBAGENT_ROW_PREFIX}${agentId}`;
}

/**
 * Where Claude Code writes a subagent's own transcript: beside the parent's,
 * under `<sessionId>/subagents/agent-<id>.jsonl`, with `.meta.json` next to it
 * carrying the agent type and description.
 */
export function sidechainTranscriptPath(parentTranscriptPath: string, agentId: string): string {
  const sessionId = basename(parentTranscriptPath, extname(parentTranscriptPath));
  return join(dirname(parentTranscriptPath), sessionId, "subagents", `agent-${agentId}.jsonl`);
}

export interface LiveAgent {
  agentId: string;
  /** The sidechain transcript — the same JSONL shape as the parent's. */
  transcriptPath: string;
  description?: string;
  agentType?: string;
  /** When it was spawned (its meta file's mtime), epoch-ms. */
  startedAt?: number;
  /**
   * When it stopped to wait on background work of its own (a push, a gate), epoch-ms: Claude Code's "is waiting on
   * its own background work". Absent while it runs.
   */
  waitingSince?: number;
}

/**
 * The background *sub-agents* this session has in flight, from what Claude
 * Code writes to disk: a fresh sidechain under the session's directory, and a
 * parent transcript whose newest word on that agent is its launch, a
 * SendMessage result naming it in `resumedAgentId`, or a notification that it
 * is waiting on its own background work — nothing since that ends it
 * (`parseTaskNotice`). AGENTS ONLY — a background Bash
 * (`run_in_background`) is deliberately ignored: it is often a persistent
 * process (dev server, watcher, tail) that never writes a completion, so
 * counting it would keep the session silent forever. A background agent
 * re-wakes the session when it finishes; a background Bash just runs off to
 * the side, so the turn is genuinely done.
 *
 * A subagent has no registry entry and no pid of its own — it runs inside the
 * parent's process — so this is the only way to know one exists. The reverse
 * scan is bounded to fresh candidates and a 32 MiB tail, so old transcript
 * launches cannot resurrect stale work while live agents may still span nearby
 * user turns.
 *
 * ponytail: a synchronous Agent call (no `isAsync`) is not listed while it
 * runs — its tool_result only lands at completion, so the parent transcript
 * has nothing yet that names the agent. Add the meta file's `toolUseId` as a
 * second candidate if that ever matters.
 */
export function liveBackgroundAgents(transcriptPath: string): LiveAgent[] {
  try {
    const now = Date.now();
    const sessionId = basename(transcriptPath, extname(transcriptPath));
    const projectDir = dirname(transcriptPath);
    const sidechains = join(projectDir, sessionId, "subagents");
    const names = listing(sidechains) ?? [];
    const stats: StatMemo = new Map();
    const agents = freshIds(
      sidechains,
      names,
      stats,
      // Spawn metadata can land before the transcript. It contributes only a
      // candidate id; the parent transcript still proves launch/completion.
      (name) => name.match(/^agent-(.+?)(?:\.jsonl|\.meta\.json)$/)?.[1],
      now,
      LIVE_WINDOW_MS,
    );
    // Quiet past the window but inside a tool call of its own: a build or a test run
    // writes nothing until it returns, and the session read "done" (and dropped "waiting
    // on its agents") in the middle of it.
    //
    // Or stopped with background work of its own running, which writes nothing until that work reports: Claude Code
    // still lists it, and it vanished from conch six minutes in (Tyler, 2026-11-12: "conch ui shows 3 sub-agents for
    // u but it says 2 more in the claude code ui"). Only its parent's notification can say it is waiting, so it is a
    // candidate that only that notification keeps.
    for (const [id, candidate] of freshIds(
      sidechains,
      names,
      stats,
      (name) => name.match(/^agent-(.+?)\.jsonl$/)?.[1],
      now,
      MID_TOOL_WINDOW_MS,
    )) {
      if (agents.has(id)) continue;
      const path = join(sidechains, `agent-${id}.jsonl`);
      const tail = agentTailOf(path, statOnce(stats, path));
      if (tail.insideToolCall) agents.set(id, candidate);
      else if (tail.startedOwnWork) agents.set(id, { ...candidate, quiet: true });
    }

    if (!agents.size) return [];
    const quiet = new Set([...agents.values()].filter((candidate) => candidate.quiet).map((candidate) => candidate.id));
    return launchedAgents(transcriptPath, agents).flatMap(({ agentId, waitingSince }) => {
      // Its own transcript moved after it said it was waiting: that work reported and woke it, and it is running.
      const moved = waitingSince !== undefined
        && (statOnce(stats, join(sidechains, `agent-${agentId}.jsonl`))?.mtimeMs ?? 0) > waitingSince + WOKEN_SLACK_MS;
      const waiting = waitingSince !== undefined && !moved;
      if (quiet.has(agentId) && !waiting) return [];
      return [{ ...describeAgent(sidechains, agentId), ...(waiting ? { waitingSince } : {}) }];
    });
  } catch {
    return [];
  }
}

/**
 * How long after its waiting notification an agent's transcript may still move without having been woken: Claude Code
 * writes the agent's last words a few milliseconds BEFORE the notification (3 ms on 2026-11-12), and a filesystem
 * may keep whole seconds.
 */
const WOKEN_SLACK_MS = 2_000;

/** An agent still out, as its parent's newest word on it says: running, or waiting on its own work since then. */
interface Launched {
  agentId: string;
  waitingSince?: number;
}

/**
 * The last scan of each parent transcript: which of its candidates it still launches. The answer depends only on
 * the transcript and the candidates, so a parent that has not moved, asked about the same agents, is not read again.
 */
const scans = new Map<string, { version: FileVersion; ids: string; live: Launched[] }>();

/** Which candidates the parent transcript's newest word still has in flight, newest first. Consumes `agents`. */
function launchedAgents(transcriptPath: string, agents: Map<string, Candidate>): Launched[] {
  const version = fileVersion(transcriptPath);
  const ids = [...agents.keys()].sort().join("\u0000");
  const known = scans.get(transcriptPath);
  if (known && known.ids === ids && sameFileVersion(known.version, version)) return known.live.map((agent) => ({ ...agent }));
  const live = scanLaunches(transcriptPath, agents);
  // Taken before the scan: a transcript that moves during it reads as moved next time.
  if (version) remember(scans, transcriptPath, { version, ids, live: live.map((agent) => ({ ...agent })) });
  return live;
}

function entryTime(entry: any): number | undefined {
  const at = Date.parse(entry?.timestamp ?? "");
  return Number.isFinite(at) ? at : undefined;
}

function scanLaunches(transcriptPath: string, agents: Map<string, Candidate>): Launched[] {
  const live: Launched[] = [];
  // The newest notification about each agent, held until the next older word on it decides what it means. Claude
  // Code files one notification up to three times, and the copy it queued while the session was busy can land AFTER a
  // SendMessage that resumed the agent, though it was written before (2026-11-12: a waiting notice queued at 03:15:59,
  // the resume at 03:16:02, the queued copy filed after it). Read newest first, that stale copy would end an agent
  // that is running again.
  const held = new Map<string, { notice: TaskNotice; at?: number }>();
  const settle = (agentId: string): void => {
    const newest = held.get(agentId);
    held.delete(agentId);
    agents.delete(agentId);
    if (newest?.notice.outcome === "waiting") live.push({ agentId, waitingSince: newest.at ?? 0 });
  };
  visitLinesNewestFirst(transcriptPath, (buffer) => containsCandidate(buffer, agents), (line) => {
    if (!containsCandidate(line, agents)) return false;
    let entry: any;
    try {
      entry = JSON.parse(line.toString("utf8"));
    } catch {
      return false; // tolerate a partial final line while Claude is writing
    }

    const content = taskNotificationText(entry);
    if (content) {
      const notice = parseTaskNotice(content);
      if (notice && agents.has(notice.taskId)) {
        // An older notification than the one held: the held one is the newest word.
        if (held.has(notice.taskId)) settle(notice.taskId);
        else if (notice.outcome !== "other") held.set(notice.taskId, { notice, at: entryTime(entry) });
      }
    } else if (entry?.type === "user" && entry?.toolUseResult && typeof entry.toolUseResult === "object") {
      const result = entry.toolUseResult;
      const resumed = resumedAgentOf(result);
      if (resumed && agents.has(resumed)) {
        // SendMessage to a stopped agent resumes it in the background; its
        // next notification says what became of it. A notification held from
        // after this line but written before it is the stale copy above.
        const newer = held.get(resumed);
        const at = entryTime(entry);
        if (newer && !(newer.at !== undefined && at !== undefined && at > newer.at)) settle(resumed);
        else {
          held.delete(resumed);
          live.push({ agentId: resumed });
          agents.delete(resumed);
        }
      } else if (typeof result.agentId === "string" && agents.has(result.agentId)) {
        if (held.has(result.agentId)) settle(result.agentId);
        else {
          // Newest first, so a launch met here is the last word on the agent:
          // it is still out there.
          if (result.isAsync === true) live.push({ agentId: result.agentId });
          // A synchronous Agent uses the same artifact naming convention but is
          // already complete when its tool_result is written.
          agents.delete(result.agentId);
        }
      }
    }

    return !agents.size;
  });
  // A notification with nothing older in reach is still the newest word.
  for (const agentId of [...held.keys()]) settle(agentId);
  return live;
}

/** What an agent's own transcript ends in. */
interface AgentTail {
  /** A tool_use with no tool_result after it: a build or a test run that writes nothing until it returns. */
  insideToolCall: boolean;
  /** Among its last entries, a tool call it sent to the background (`run_in_background`): a push, a gate, a watch. */
  startedOwnWork: boolean;
}

/** How far back from its end an agent's transcript is searched for background work it started. */
const OWN_WORK_ENTRIES = 200;

/** `agentTail` per agent transcript, kept until the file moves: one `stat` (already taken) instead of a read. */
const agentTails = new Map<string, { version: FileVersion; tail: AgentTail }>();

function agentTailOf(path: string, stat: Stats | null): AgentTail {
  const version = stat ? { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs } : null;
  const known = agentTails.get(path);
  if (known && sameFileVersion(known.version, version)) return known.tail;
  const tail = agentTail(path);
  if (version) remember(agentTails, path, { version, tail });
  return tail;
}

/** Does this transcript end inside a tool call (a tool_use with no tool_result after it), and did it start background work lately? */
function agentTail(transcriptPath: string): AgentTail {
  let inside = false;
  let decided = false;
  let ownWork = false;
  let entries = 0;
  visitLinesNewestFirst(transcriptPath, () => true, (line) => {
    let entry: any;
    try {
      entry = JSON.parse(line.toString("utf8"));
    } catch {
      return false;
    }
    entries += 1;
    const parts = Array.isArray(entry?.message?.content) ? entry.message.content : [];
    if (!decided) {
      if (entry?.type === "user" && parts.some((part: any) => part?.type === "tool_result")) decided = true;
      else if (entry?.type === "assistant" && parts.some((part: any) => part?.type === "tool_use")) inside = decided = true;
      else if (entry?.type === "assistant" || entry?.type === "user") decided = true;
    }
    if (entry?.type === "assistant" && parts.some((part: any) => part?.type === "tool_use" && part.input?.run_in_background === true)) {
      ownWork = true;
    }
    // Inside a tool call settles it; otherwise look back for work it left running.
    return (decided && (inside || ownWork)) || entries >= OWN_WORK_ENTRIES;
  });
  return { insideToolCall: inside, startedOwnWork: ownWork };
}

function describeAgent(sidechains: string, agentId: string): LiveAgent {
  const agent: LiveAgent = {
    agentId,
    transcriptPath: join(sidechains, `agent-${agentId}.jsonl`),
  };
  const metaPath = join(sidechains, `agent-${agentId}.meta.json`);
  try {
    agent.startedAt = statSync(metaPath).mtimeMs;
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    if (typeof meta?.description === "string" && meta.description) agent.description = meta.description;
    if (typeof meta?.agentType === "string" && meta.agentType) agent.agentType = meta.agentType;
  } catch {
    // No meta file, or a torn one: the id alone is still a real agent.
  }
  return agent;
}

/** True when this session has a background sub-agent still in flight. */
export function sessionHasLiveBackgroundWork(transcriptPath: string): boolean {
  return liveBackgroundAgents(transcriptPath).length > 0;
}
