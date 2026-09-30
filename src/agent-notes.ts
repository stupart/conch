import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { conchHome } from "./home.ts";

/**
 * One note for a session's agent, held until its next prompt and said once, as context on that
 * prompt (Claude Code's UserPromptSubmit hook, `userPromptContext`).
 *
 * The one note so far: a `conch:review` link the Stop hook refused. A session without conch's
 * tools publishes with that line, and nothing in a Stop hook's answer reaches the agent, so a
 * refused link was invisible to the one party that could fix it. The Stop hook writes the note
 * and the next UserPromptSubmit takes it. Both are short-lived hook processes, so it lives on
 * disk: one file per session under conch's config folder, 0600, replaced atomically.
 */
function notesFolder(folder?: string): string {
  return folder ?? join(process.env.CONCH_CONFIG_DIR ?? join(conchHome(), ".config", "conch"), "agent-notes");
}

/** A note nobody prompted for in this long is stale: its session has moved on or gone. */
const NOTE_TTL_MS = 24 * 60 * 60 * 1000;

function notePath(sessionId: string, folder?: string): string {
  // Hashed: a session id is the agent's, and never gets to name a path.
  return join(notesFolder(folder), `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.json`);
}

/** Hold `text` for the session's next prompt, replacing any note it already had. */
export function saveAgentNote(sessionId: string, text: string, folder?: string, now = Date.now()): void {
  if (!sessionId || !text) return;
  try {
    const dir = notesFolder(folder);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Notes whose session never prompted again, so the folder holds only live ones.
    for (const name of readdirSync(dir)) {
      try {
        if (now - statSync(join(dir, name)).mtimeMs > NOTE_TTL_MS) unlinkSync(join(dir, name));
      } catch {}
    }
    const path = notePath(sessionId, folder);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ text, at: now }) + "\n", { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // Best-effort, like the hook trace: a note must never break the hook that leaves it.
  }
}

/** Drop the session's note, if it has one: the thing it was about has been put right. */
export function clearAgentNote(sessionId: string, folder?: string): void {
  if (!sessionId) return;
  try {
    unlinkSync(notePath(sessionId, folder));
  } catch {}
}

/** The session's note, once: it is removed as it is read. Null when there is none, or it is stale. */
export function takeAgentNote(sessionId: string, folder?: string, now = Date.now()): string | null {
  if (!sessionId) return null;
  const path = notePath(sessionId, folder);
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(path, "utf8"));
    unlinkSync(path);
  } catch {
    return null;
  }
  const { text, at } = (saved ?? {}) as { text?: unknown; at?: unknown };
  if (typeof text !== "string" || !text || typeof at !== "number" || now - at > NOTE_TTL_MS) return null;
  return text;
}

/**
 * What a UserPromptSubmit hook prints to give the agent `text` with the prompt: Claude Code adds
 * a hook's `additionalContext` to the context of the turn that prompt starts.
 */
export function userPromptContext(text: string): string {
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `conch: ${text}` } })}\n`;
}
