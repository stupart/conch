import { closeSync, existsSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { codexThreadLabel } from "./codex-threads.ts";

/** How much of a transcript's end to read looking for its current title. */
const CLAUDE_TAIL_BYTES = 64 * 1024;

/** The two names a Claude transcript can carry: a person's rename, and the generated one. */
export interface ClaudeTitles {
  custom?: string;
  generated?: string;
}

/**
 * The name Claude Code itself shows you, from the END of the transcript.
 *
 * conch was labelling rows with the first thing you ever said in a session, so
 * the resume list did not match `/resume` — Tyler: "The resume names i see in
 * conch are weird - they don't match what i see when i run /resume in the
 * apps".
 *
 * Claude Code writes `custom-title` when you rename a session and `ai-title`
 * for the one it generates, and rewrites both as they change — roughly two
 * thousand times each in a long transcript. So the CURRENT value is at the
 * tail, and the tail is the only affordable place to look: the transcript this
 * was traced in is 158MB, its first `custom-title` sits at line 3190, and a
 * 64KB tail read finds both records in 0.06ms.
 */
export function readClaudeTitles(path: string): ClaudeTitles {
  return readClaudeTitlesIfReadable(path) ?? {};
}

/** `readClaudeTitles`, or null when there is no transcript there: the `existsSync` a guessed path was checked with. */
export function readClaudeTitlesIfThere(path: string): ClaudeTitles | null {
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  return readClaudeTitlesIfReadable(path, stat) ?? {};
}

function readClaudeTitlesIfReadable(path: string, stat?: Stats): ClaudeTitles | null {
  let tail: KeptTail;
  try {
    tail = keptTail(path, stat);
  } catch {
    return null;
  }
  tail.titles ??= titlesIn(tail.text());
  // A copy: what a caller is handed is never the kept answer.
  return { ...tail.titles };
}

function titlesIn(tail: string): ClaudeTitles {
  const titles: ClaudeTitles = {};
  for (const line of tail.split("\n")) {
    // Cheap reject before the parse: most lines are neither, and a 64KB tail
    // of a busy transcript is a few hundred of them.
    if (!line.includes("-title")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // the first line of a tail read is usually a fragment
    }
    if (!parsed || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    // Last wins: later records are more recent renames.
    if (record.type === "custom-title" && typeof record.customTitle === "string") {
      titles.custom = clean(record.customTitle) ?? titles.custom;
    } else if (record.type === "ai-title" && typeof record.aiTitle === "string") {
      titles.generated = clean(record.aiTitle) ?? titles.generated;
    }
  }
  return titles;
}

/**
 * The session this transcript's conversation moved to, when it moved and
 * never came back.
 *
 * Backgrounding a Claude Code session (2.1.266) forks the conversation into a
 * `bg` process under a NEW id and appends `continued-in
 * {continuedInSessionId}` to the old transcript. The window it left keeps the
 * old id, and metadata keeps that file's mtime fresh, so conch showed the
 * conversation frozen at the moment it moved while the real one ran on for
 * days.
 *
 * Read the way Claude Code reads it on `--resume`: newest line first, the
 * marker counts unless a user or assistant record comes after it — then the
 * conversation carried on here after all.
 */
export function readContinuedIn(path: string): string | undefined {
  let tail: KeptTail;
  try {
    tail = keptTail(path);
  } catch {
    return undefined;
  }
  if (tail.continuedIn === undefined) tail.continuedIn = continuedInFrom(tail.text()) ?? null;
  return tail.continuedIn ?? undefined;
}

function continuedInFrom(tail: string): string | undefined {
  if (!tail.includes('"type":"continued-in"')) return undefined; // nearly every transcript
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let record: any;
    try {
      record = JSON.parse(lines[index]!);
    } catch {
      continue;
    }
    // ponytail: any reply counts as coming back, where Claude Code skips an
    // API-error one; the row then shows both until the next real turn.
    if (record?.type === "user" || record?.type === "assistant") return undefined;
    if (record?.type === "continued-in" && typeof record.continuedInSessionId === "string") {
      return record.continuedInSessionId || undefined;
    }
  }
  return undefined;
}

/**
 * Has anyone said anything in this transcript yet — one `user` or `assistant`
 * record. Unreadable counts as yes, so a read failure never hides a session.
 */
export function hasConversation(path: string): boolean {
  try {
    // ponytail: past the tail size it holds a conversation in practice; read the
    // head too if a big metadata-only transcript ever turns up.
    const stat = statSync(path);
    if (stat.size > CLAUDE_TAIL_BYTES) return true;
    const tail = keptTail(path, stat);
    tail.conversation ??= tail.text().split("\n").some((line) => {
      try {
        const type = JSON.parse(line)?.type;
        return type === "user" || type === "assistant";
      } catch {
        return false;
      }
    });
    return tail.conversation;
  } catch {
    return true;
  }
}

/**
 * The last `CLAUDE_TAIL_BYTES` of a transcript, kept between reads, with what was worked out from them.
 *
 * The registry read asks every Claude session's tail for its title and whether it moved (`readContinuedIn`), and the
 * daemon reads the registry on every render: four times a second while a session works. Each ask opened the file and
 * read 64 KB again, moved or not; `conch evals` counted 27,848 file calls a minute here in its scripted load (12
 * sessions, 3 working), 2026-11-11. Now a transcript that has not moved costs one `stat`, and one that grew is read
 * from where it ended, plus `OVERLAP_BYTES` before it that must match what was kept: a transcript rewritten in place
 * (not appended to) fails that and is read whole again, as one replaced by a rename does by its inode.
 *
 * The answers are worked out from the same 64 KB as before, so a title that has scrolled out of the tail is lost the
 * way it always was. A same-size rewrite in the same nanosecond would read as unmoved; transcripts are appended to.
 */
interface KeptTail {
  ino: number;
  size: number;
  mtimeMs: number;
  bytes: Buffer;
  text(): string;
  titles?: ClaudeTitles;
  /** null: worked out, and there is none. */
  continuedIn?: string | null;
  conversation?: boolean;
}

const OVERLAP_BYTES = 256;
/** Tails kept, the least recently read let go first: 64 KB each, so at most 8 MB. */
const KEPT_TAILS_MAX = 128;
const keptTails = new Map<string, KeptTail>();

/** For tests: forget every kept tail. */
export function forgetKeptTails(): void {
  keptTails.clear();
}

/** Throws when unreadable. */
function keptTail(path: string, given?: Stats): KeptTail {
  const stat = given ?? statSync(path);
  const known = keptTails.get(path);
  if (known && known.ino === stat.ino && known.size === stat.size && known.mtimeMs === stat.mtimeMs) {
    keptTails.delete(path);
    keptTails.set(path, known);
    return known;
  }
  const bytes = (known && known.ino === stat.ino && grown(path, known, stat.size)) || readLast(path, stat.size);
  const tail = keptTailOf(stat, bytes);
  keptTails.delete(path);
  // A short read (the file shrank under it) is answered but not kept.
  if (bytes.length === Math.min(stat.size, CLAUDE_TAIL_BYTES)) {
    keptTails.set(path, tail);
    if (keptTails.size > KEPT_TAILS_MAX) keptTails.delete(keptTails.keys().next().value!);
  }
  return tail;
}

// The decoded text is not kept: each answer is worked out once per version of the file, and a string can take twice
// the bytes.
function keptTailOf(stat: Stats, bytes: Buffer): KeptTail {
  return { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, bytes, text: () => new TextDecoder().decode(bytes) };
}

/** The bytes from `from` to `to`, fewer if the file ended first. */
function readRange(path: string, from: number, to: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.max(0, to - from));
    const count = readSync(fd, buffer, 0, buffer.length, from);
    return buffer.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}

function readLast(path: string, size: number): Buffer {
  return readRange(path, Math.max(0, size - CLAUDE_TAIL_BYTES), size);
}

/** The new tail of a file that grew, reading only what it grew by; null when it was not an append. */
function grown(path: string, known: KeptTail, size: number): Buffer | null {
  if (size <= known.size || size - known.size >= CLAUDE_TAIL_BYTES) return null;
  const overlap = Math.min(OVERLAP_BYTES, known.bytes.length);
  const read = readRange(path, known.size - overlap, size);
  if (read.length !== size - known.size + overlap) return null;
  if (!read.subarray(0, overlap).equals(known.bytes.subarray(known.bytes.length - overlap))) return null;
  const added = read.subarray(overlap);
  const keep = known.bytes.subarray(Math.max(0, known.bytes.length + added.length - CLAUDE_TAIL_BYTES));
  return Buffer.concat([keep, added]);
}

function clean(title: string): string | undefined {
  const trimmed = title.trim();
  if (!trimmed) return undefined;
  return codexThreadLabel({ title: trimmed.replace(/\s+/g, " ") });
}

/** A rename beats a generated title, because it is the name a person chose. */
export function readClaudeTitle(path: string): string | undefined {
  const titles = readClaudeTitles(path);
  return titles.custom ?? titles.generated;
}

/** Claude Code's name for a project folder: the cwd with every character but a letter or digit made a dash. It names
 * the folder under `projects/` and the one under its cache (`mcp-repair.ts`). */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Where a live session's transcript sits, for a session the registry describes
 * by id and cwd but never points at.
 *
 * Claude Code names the project directory after the cwd with every character
 * that is not a letter or digit replaced by a dash. Guessing that is only safe
 * because the guess is checked: an unrecognised layout returns undefined and
 * the caller keeps whatever name it already had.
 */
export function liveTranscriptPath(
  claudeDir: string,
  cwd: string | undefined,
  sessionId: string,
): string | undefined {
  const path = claudeTranscriptGuess(claudeDir, cwd, sessionId);
  return path && existsSync(path) ? path : undefined;
}

/**
 * `liveTranscriptPath`'s guess, unchecked, for a caller whose next step reads it anyway and can tell a missing file
 * from the read (`readClaudeTitlesIfThere`, `readContinuedIn`): the `existsSync` was a second file call a session a
 * registry read, 6,962 a minute in `conch evals`' scripted load (2026-11-11).
 */
export function claudeTranscriptGuess(
  claudeDir: string,
  cwd: string | undefined,
  sessionId: string,
): string | undefined {
  if (!cwd || !sessionId) return undefined;
  return join(claudeDir, "projects", claudeProjectSlug(cwd), `${sessionId}.jsonl`);
}
