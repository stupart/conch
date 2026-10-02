import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isCodexTranscriptPath, isRealUserPrompt } from "./snippet.ts";

/**
 * What proves a message typed into an agent's terminal reached the agent.
 *
 * Typing is not delivery. `tmux send-keys` exiting 0 says the keys reached a pane, not that the
 * agent took them: a TUI still starting drops them, a burst read as a paste turns the Return into
 * a newline, and a draft someone left in the box swallows them into its own words. On 2026-10-02
 * every first message to a new background session was reported delivered on the keystrokes alone,
 * because no transcript existed yet to confirm against, and one of them sat unsent in its input
 * box while the phone said "Sent".
 *
 * So a send is confirmed only by something the agent itself wrote or said:
 *  - its transcript recorded the prompt (`type: "user"`), or queued it behind a running turn
 *    (Claude Code's `queue-operation` enqueue, with the text);
 *  - its `UserPromptSubmit` hook reported a prompt whose fingerprint is these words;
 *  - its input box was read holding the words and then empty.
 * With none of these, the answer is "not confirmed", never "delivered". This is the rule the
 * careful tmux drivers settled on (agent-deck's Confirmed / DeliveredUnconfirmed / Failed, obra's
 * claude-session-driver), and what T3 Code gets for free from the agents' own protocols.
 */

/** Whitespace collapsed and trimmed: how a prompt is compared, on both sides. */
export function normalizePrompt(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A short fingerprint of a prompt's opening, carried by the `UserPromptSubmit` hook so the daemon can
 * tell its own send from another prompt without the words crossing the socket or reaching a log.
 * The opening, not the whole: Claude Code expands a pasted block and may append attachments.
 */
export function promptDigest(text: string): string {
  return createHash("sha256").update(normalizePrompt(text).slice(0, 64)).digest("hex").slice(0, 16);
}

export const PROMPT_DIGEST = /^[0-9a-f]{16}$/;

/** Prompts a session's hook reported, newest last, for the delivery that is watching for its own. */
export class PromptSubmissions {
  readonly #bySession = new Map<string, Array<{ at: number; digest: string }>>();

  note(sessionId: string, digest: string, at = Date.now()): void {
    if (!sessionId || !PROMPT_DIGEST.test(digest)) return;
    const held = (this.#bySession.get(sessionId) ?? []).filter((entry) => at - entry.at < 10 * 60_000);
    held.push({ at, digest });
    this.#bySession.set(sessionId, held.slice(-16));
  }

  /** Whether this session's agent reported submitting these words at or after `since`. */
  submitted(sessionId: string, since: number, words: string): boolean {
    const digest = promptDigest(words);
    return (this.#bySession.get(sessionId) ?? []).some((entry) => entry.at >= since && entry.digest === digest);
  }
}

export interface TranscriptSince {
  /** A real user prompt was written at or after the send began. */
  submitted: boolean;
  /** These words were queued behind a running turn (Claude Code's `queue-operation` enqueue). */
  queued: boolean;
}

/** Records within this much before the send count as after it: the agent's clock and ours are one machine's, but a write and a read race. */
const CLOCK_SLACK_MS = 1_500;

/**
 * What a Claude transcript recorded since `since` (epoch ms), read by time rather than by count.
 *
 * For a session whose transcript did not exist when the send began: Claude Code writes a new
 * session's file only with its first prompt, so there was nothing to count against, and the file
 * that appears afterwards is judged by when its records were written. Codex rollouts are counted
 * the usual way (`promptSince`), since a rollout exists from the session's start.
 */
export async function claudeTranscriptSince(path: string | undefined, since: number, words: string): Promise<TranscriptSince> {
  const none = { submitted: false, queued: false };
  if (!path || isCodexTranscriptPath(path) || !existsSync(path)) return none;
  let text: string;
  try {
    const file = Bun.file(path);
    // A fresh session's file is small; a long one is only ever read from its tail.
    text = await file.slice(Math.max(0, file.size - 4 * 1024 * 1024)).text();
  } catch {
    return none;
  }
  const opening = normalizePrompt(words).slice(0, 48);
  const result = { ...none };
  for (const line of text.split("\n")) {
    if (!line.includes("\"timestamp\"")) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const at = Date.parse(entry?.timestamp ?? "");
    if (!Number.isFinite(at) || at < since - CLOCK_SLACK_MS) continue;
    if (entry.type === "user" && isRealUserPrompt(entry)) result.submitted = true;
    if (entry.type === "queue-operation" && entry.operation === "enqueue" && typeof entry.content === "string"
      && opening && normalizePrompt(entry.content).startsWith(opening)) result.queued = true;
  }
  return result;
}

/** The parts of a delivery's evidence the outcome is decided from, in order of strength. */
export type DeliveryEvidence =
  /** The agent wrote the prompt down, or its hook said it took these words. */
  | "submitted"
  /** The agent queued these words behind its running turn. */
  | "queued"
  /** The words left the input box after the Return; nothing has written them down yet. */
  | "box-cleared"
  /** The words are still in the input box. */
  | "in-box"
  | null;
