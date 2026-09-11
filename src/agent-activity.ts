import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/**
 * Files written by a live task can legitimately go quiet while a tool call is
 * in flight. Real agent transcripts contain gaps just under five minutes, so
 * keep six minutes of headroom over the original 120-second proposal while
 * still aging launch-without-completion orphans out in bounded time.
 */
export const LIVE_WINDOW_MS = 6 * 60 * 1000;

const READ_CHUNK_BYTES = 256 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const TERMINAL_TASK_STATUS = new Set(["completed", "failed", "killed"]);

interface Candidate {
  id: string;
  bytes: Buffer;
}

function freshFile(path: string, now: number, liveWindowMs: number): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && now - stat.mtimeMs <= liveWindowMs;
  } catch {
    return false;
  }
}

function freshIds(
  dir: string,
  match: (name: string) => string | undefined,
  now: number,
  liveWindowMs: number,
): Map<string, Candidate> {
  const ids = new Map<string, Candidate>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return ids;
  }
  for (const name of names) {
    const id = match(name);
    if (!id || !freshFile(join(dir, name), now, liveWindowMs)) continue;
    ids.set(id, { id, bytes: Buffer.from(id) });
  }
  return ids;
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
      let newline = combined.lastIndexOf(0x0a, end - 1);
      while (newline !== -1) {
        if (newline + 1 < end && visit(combined.subarray(newline + 1, end))) return;
        end = newline;
        newline = combined.lastIndexOf(0x0a, end - 1);
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
}

/**
 * The background *sub-agents* this session has in flight, from what Claude
 * Code writes to disk: a fresh sidechain under the session's directory, and a
 * parent transcript whose newest word on that agent is its launch — no
 * completion notification yet. AGENTS ONLY — a background Bash
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
    const agents = freshIds(
      sidechains,
      // Spawn metadata can land before the transcript. It contributes only a
      // candidate id; the parent transcript still proves launch/completion.
      (name) => name.match(/^agent-(.+?)(?:\.jsonl|\.meta\.json)$/)?.[1],
      now,
      LIVE_WINDOW_MS,
    );

    if (!agents.size) return [];

    const live: string[] = [];
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
        const taskId = content.match(/<task-id>\s*([^<]+?)\s*<\/task-id>/)?.[1];
        const status = content.match(/<status>\s*([^<]+?)\s*<\/status>/)?.[1];
        if (taskId && status && TERMINAL_TASK_STATUS.has(status)) {
          agents.delete(taskId);
        }
      } else if (entry?.type === "user" && entry?.toolUseResult && typeof entry.toolUseResult === "object") {
        const result = entry.toolUseResult;
        if (typeof result.agentId === "string" && agents.has(result.agentId)) {
          // Newest first, so a launch met here is the last word on the agent:
          // it is still out there.
          if (result.isAsync === true) live.push(result.agentId);
          // A synchronous Agent uses the same artifact naming convention but is
          // already complete when its tool_result is written.
          agents.delete(result.agentId);
        }
      }

      return !agents.size;
    });
    return live.map((agentId) => describeAgent(sidechains, agentId));
  } catch {
    return [];
  }
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
