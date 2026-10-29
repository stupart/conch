import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readdir, rename, rm, stat, truncate, utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { adapterFor } from "./agent-adapter.ts";
import type { ClaudeAccount } from "./claude-accounts.ts";
import type { StartSessionRequest } from "./session-lifecycle.ts";

/**
 * One Claude profile for all of conch (2026-10-28, Tyler: "we should have one account for all of conch I thought? (at
 * least for mine)"). With rotation on, Default's sign-in already moves between every subscription, so a second profile
 * signed in to one of them only splits sessions, settings and memory in two. Retiring it (`retireClaudeAccount`) stops
 * conch launching anything in it: a start, restart, fork or resume that names it runs in Default instead, and a
 * conversation it holds is brought across first, so `claude --resume <id>` finds it there.
 *
 * Brought across, not moved: the retired folder keeps every file. A conversation keeps its id, which is what conch's
 * records key it by (device, provider, native id), so its history stays one session; the records store already takes a
 * session from more than one file. Transcripts are append-only, which makes the rule simple: copy what Default lacks,
 * extend a copy that has fallen behind, and never write over one that has gone on in Default.
 */

/** What became of one file: Default lacked it, had fallen behind, had it, was ahead, or went its own way (kept). */
export type BroughtAcross = "copied" | "extended" | "same" | "kept" | "diverged";

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 1024 * 1024;

/** Whether `path` begins with the first `length` bytes of `prefix`. */
async function startsWith(path: string, prefix: string, length: number): Promise<boolean> {
  const [whole, start] = await Promise.all([open(path, "r"), open(prefix, "r")]);
  try {
    const a = Buffer.allocUnsafe(CHUNK);
    const b = Buffer.allocUnsafe(CHUNK);
    for (let offset = 0; offset < length;) {
      const want = Math.min(CHUNK, length - offset);
      const [{ bytesRead: got }, { bytesRead: gotPrefix }] = await Promise.all([whole.read(a, 0, want, offset), start.read(b, 0, want, offset)]);
      if (got !== want || gotPrefix !== want || !a.subarray(0, want).equals(b.subarray(0, want))) return false;
      offset += want;
    }
    return true;
  } finally {
    await Promise.all([whole.close(), start.close()]);
  }
}

/**
 * A copy of `source` beside `destination`, under a name Claude and conch's records both pass over. A copy-on-write clone
 * on APFS, so a transcript of hundreds of megabytes costs no space and no time. A `.jsonl` caught mid-line by a session
 * still writing it ends at its last whole line: what follows comes across with the next extension. It keeps the
 * original's times, so Claude's resume list and conch's still order the conversation by when it was last written.
 */
async function snapshot(source: string, destination: string): Promise<string> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temp = join(dirname(destination), `.${basename(destination)}.conch-${randomUUID()}.tmp`);
  const { atime, mtime } = await stat(source);
  await copyFile(source, temp, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  await utimes(temp, atime, mtime);
  if (!destination.endsWith(".jsonl")) return temp;
  const file = await open(temp, "r");
  try {
    const { size } = await file.stat();
    const tail = Buffer.allocUnsafe(Math.min(size, CHUNK));
    for (let end = size; end > 0;) {
      const start = Math.max(0, end - tail.length);
      const { bytesRead } = await file.read(tail, 0, end - start, start);
      const newline = tail.subarray(0, bytesRead).lastIndexOf(10);
      if (newline >= 0) {
        if (start + newline + 1 < size) {
          await truncate(temp, start + newline + 1);
          await utimes(temp, atime, mtime);
        }
        break;
      }
      end = start;
    }
  } finally {
    await file.close();
  }
  return temp;
}

export interface BringOptions {
  /** Say what would happen, writing nothing. */
  dryRun?: boolean;
  /** Called with Default's copy before an extension replaces it (the migration keeps one). */
  beforeReplace?: (path: string) => Promise<void>;
}

/** Bring one append-only file across: copied when Default lacks it, extended when Default's copy has fallen behind. */
export async function bringFileAcross(source: string, destination: string, options: BringOptions = {}): Promise<BroughtAcross> {
  const from = await stat(source);
  const to = await stat(destination).catch(() => undefined);
  if (!to && options.dryRun) return "copied";
  if (!to) {
    const temp = await snapshot(source, destination);
    try {
      // `link` never replaces: a copy that appeared meanwhile is compared instead.
      await link(temp, destination);
      return "copied";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return bringFileAcross(source, destination, options);
    } finally {
      await rm(temp, { force: true });
    }
  }
  if (from.size === to.size) return await startsWith(source, destination, to.size) ? "same" : "diverged";
  if (from.size < to.size) return await startsWith(destination, source, from.size) ? "kept" : "diverged";
  if (!await startsWith(source, destination, to.size)) return "diverged";
  if (options.dryRun) return "extended";
  const temp = await snapshot(source, destination);
  try {
    // Nothing past Default's copy but half a line still being written.
    if ((await stat(temp)).size <= to.size) return "same";
    await options.beforeReplace?.(destination);
    // Replaced only as it was compared: a session that wrote to Default's copy since keeps what it wrote.
    const now = await stat(destination);
    if (now.size !== to.size || now.mtimeMs !== to.mtimeMs) return bringFileAcross(source, destination, options);
    await rename(temp, destination);
    return "extended";
  } finally {
    await rm(temp, { force: true });
  }
}

/** Every regular file under `source` brought across to the same place under `destination`; symlinks are passed over. */
export async function bringTreeAcross(source: string, destination: string, options: BringOptions = {}, outcomes: BroughtAcross[] = []): Promise<BroughtAcross[]> {
  let entries;
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch {
    return outcomes;
  }
  for (const entry of entries) {
    if (entry.name.includes(".conch-") && entry.name.endsWith(".tmp")) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await bringTreeAcross(from, to, options, outcomes);
    else if (entry.isFile() && (await lstat(from)).isFile()) outcomes.push(await bringFileAcross(from, to, options));
  }
  return outcomes;
}

export interface ConversationBroughtAcross {
  from: ClaudeAccount;
  source: string;
  destination: string;
  transcript: BroughtAcross;
  /** Its folder (subagents, tool results), edit checkpoints and task list: files copied or extended. */
  files: number;
}

/**
 * Conversation `id` from profile `from` into profile `to`, beside where Claude keeps it (`projects/<folder>/<id>.jsonl`),
 * with what Claude keeps for it by id. Undefined when `from` doesn't have it.
 */
export async function bringConversationAcross(id: string, from: ClaudeAccount, to: ClaudeAccount, options: BringOptions = {}): Promise<ConversationBroughtAcross | undefined> {
  if (!CONVERSATION_ID.test(id)) return undefined;
  const claude = adapterFor("claude");
  const source = claude.findTranscript(id, { claudeDir: from.configDir });
  if (!source) return undefined;
  const destination = claude.findTranscript(id, { claudeDir: to.configDir })
    ?? join(to.configDir, "projects", basename(dirname(source)), `${id}.jsonl`);
  const transcript = await bringFileAcross(source, destination, options);
  const outcomes: BroughtAcross[] = [];
  for (const [a, b] of [
    [join(dirname(source), id), join(dirname(destination), id)],
    [join(from.configDir, "file-history", id), join(to.configDir, "file-history", id)],
    [join(from.configDir, "tasks", id), join(to.configDir, "tasks", id)],
  ] as const) await bringTreeAcross(a, b, options, outcomes);
  return { from, source, destination, transcript, files: outcomes.filter((outcome) => outcome === "copied" || outcome === "extended").length };
}

export interface ActiveLaunch {
  request: StartSessionRequest;
  /** What changed, for the log or the person who asked. */
  said: string[];
}

/**
 * The launch as it runs once retired profiles are taken out: in Default when it named a retired one, with a resumed
 * conversation brought across from any retired profile that holds it (a fork's too, which forks from Default's copy).
 * A handoff carries its own snapshot, and a launch in a folder that isn't one of conch's profiles is left alone.
 */
export async function launchOffRetiredProfiles(request: StartSessionRequest, accounts: readonly ClaudeAccount[]): Promise<ActiveLaunch> {
  const retired = accounts.filter((account) => account.retired);
  if (request.backend !== "claude" || !retired.length || request.claudeConfigDir !== undefined) return { request, said: [] };
  const said: string[] = [];
  const named = accounts.find((account) => account.id === request.claudeAccountId);
  let next = request;
  if (named?.retired) {
    next = { ...request, claudeAccountId: "default" };
    said.push(`"${named.label}" is retired, so this runs in Default`);
  }
  const target = accounts.find((account) => account.id === (next.claudeAccountId ?? "default"));
  const id = next.resumeSessionId?.trim();
  if (!target || target.retired || !id || next.claudeHandoff || next.claudeSourceAccountId !== undefined) return { request: next, said };
  for (const from of retired) {
    const brought = await bringConversationAcross(id, from, target);
    if (!brought) continue;
    if (brought.transcript === "copied" || brought.transcript === "extended") {
      said.push(`brought conversation ${id} across from the retired "${from.label}" profile to "${target.label}"`);
    } else if (brought.transcript === "diverged") {
      said.push(`conversation ${id} went on in both "${target.label}" and the retired "${from.label}"; resuming "${target.label}"'s, and "${from.label}"'s stays in ${from.configDir}`);
    }
  }
  return { request: next, said };
}
