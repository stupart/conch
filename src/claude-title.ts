import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
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
  let tail: string;
  try {
    tail = readTail(path);
  } catch {
    return {};
  }
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
  let tail: string;
  try {
    tail = readTail(path);
  } catch {
    return undefined;
  }
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

/** The last `CLAUDE_TAIL_BYTES` of a transcript, decoded. Throws when unreadable. */
function readTail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const length = Math.min(size, CLAUDE_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, Math.max(0, size - length));
    return new TextDecoder().decode(buffer);
  } finally {
    closeSync(fd);
  }
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
  if (!cwd || !sessionId) return undefined;
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const path = join(claudeDir, "projects", slug, `${sessionId}.jsonl`);
  return existsSync(path) ? path : undefined;
}
