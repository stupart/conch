import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { unwrapPastedContent } from "./conversation.ts";
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
 * A prompt as the agent wrote it down, reduced to the words that were sent: Claude Code (2.1.280) records
 * a paste wrapped in `<pasted_content id="…">` tags (`unwrapPastedContent`), and conch pastes every long
 * send (`TMUX_PASTE_OVER_CHARS`), so the tags come off before anything is compared.
 */
function sentWords(text: string): string {
  return normalizePrompt(unwrapPastedContent(text));
}

/** How much of a prompt's opening has to match for a recorded prompt to be these words. */
const OPENING_CHARS = 48;

/**
 * A short fingerprint of a prompt's opening, carried by the `UserPromptSubmit` hook so the daemon can
 * tell its own send from another prompt without the words crossing the socket or reaching a log.
 * The opening, not the whole: Claude Code expands a pasted block and may append attachments.
 */
export function promptDigest(text: string): string {
  return createHash("sha256").update(sentWords(text).slice(0, 64)).digest("hex").slice(0, 16);
}

export const PROMPT_DIGEST = /^[0-9a-f]{16}$/;

interface Submission { at: number; digest: string }

/** A pid a hook can name: a terminal's process. A background job with no window reports 0. */
const isProcess = (pid: number | undefined): pid is number => Number.isSafeInteger(pid) && pid! > 0;

/** One key's reports, the ten minutes before `at` and sixteen at most, with this one added. */
function keep<K>(held: Map<K, Submission[]>, key: K, submission: Submission): void {
  const recent = (held.get(key) ?? []).filter((entry) => submission.at - entry.at < 10 * 60_000);
  recent.push(submission);
  held.set(key, recent.slice(-16));
}

/**
 * Prompts a session's hook reported, newest last, for the delivery that is watching for its own: by the
 * session the hook named, and by the process it ran in.
 *
 * By process too, because a session can take the words under an id the send never addressed. A process
 * that starts a new conversation keeps its terminal and its pid while its id changes, so the hook reports
 * the words under the new id, and a send watching only the id it typed at saw nothing and called a
 * delivered message lost. On 2026-10-05 a send was reported unconfirmed and put on the clipboard while
 * its words were already in a conversation conch was not watching. Tyler: "just had a message say it
 * failed to send but it worked".
 */
export class PromptSubmissions {
  readonly #bySession = new Map<string, Submission[]>();
  readonly #byProcess = new Map<number, Submission[]>();

  note(sessionId: string, digest: string, at = Date.now(), pid?: number): void {
    if (!sessionId || !PROMPT_DIGEST.test(digest)) return;
    keep(this.#bySession, sessionId, { at, digest });
    if (isProcess(pid)) keep(this.#byProcess, pid, { at, digest });
  }

  /**
   * Whether this session's agent reported submitting these words at or after `since`; or, given the pid
   * the words were typed at, whether any session's hook in that same process did. Only these words and
   * only since the send began, so another session's prompt, or an earlier one, never confirms this one.
   */
  submitted(sessionId: string, since: number, words: string, pid?: number): boolean {
    const digest = promptDigest(words);
    const these = (entry: Submission): boolean => entry.at >= since && entry.digest === digest;
    if ((this.#bySession.get(sessionId) ?? []).some(these)) return true;
    return isProcess(pid) && (this.#byProcess.get(pid) ?? []).some(these);
  }

  /**
   * Every session whose hook reported these words at or after `since`, the latest report first. For a send
   * whose words can land in a session it never addressed: the caller decides which of them may count.
   */
  reportedBy(since: number, words: string): string[] {
    const digest = promptDigest(words);
    const latest: Array<{ sessionId: string; at: number }> = [];
    for (const [sessionId, held] of this.#bySession) {
      const at = Math.max(...held.filter((entry) => entry.at >= since && entry.digest === digest).map((entry) => entry.at));
      if (Number.isFinite(at)) latest.push({ sessionId, at });
    }
    return latest.sort((a, b) => b.at - a.at).map((entry) => entry.sessionId);
  }
}

export interface TranscriptSince {
  /** A real user prompt that opens with these words was written at or after the send began. */
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
  const opening = sentWords(words).slice(0, OPENING_CHARS);
  if (!opening) return none;
  // Only a prompt that opens with these words is this send's. Any prompt at all used to count: on
  // 2026-10-05 a 3,580-character send was recorded as its last 514 characters, and a check that took any
  // prompt would have called that delivered. Tyler: "part of my message sent somehow and i had to go to
  // the terminal and send the full one".
  const opensWithWords = (recorded: string): boolean => sentWords(recorded).startsWith(opening);
  const result = { ...none };
  for (const line of text.split("\n")) {
    if (!line.includes("\"timestamp\"")) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const at = Date.parse(entry?.timestamp ?? "");
    if (!Number.isFinite(at) || at < since - CLOCK_SLACK_MS) continue;
    if (entry.type === "user" && isRealUserPrompt(entry) && opensWithWords(promptText(entry))) result.submitted = true;
    if (entry.type === "queue-operation" && entry.operation === "enqueue" && typeof entry.content === "string"
      && opensWithWords(entry.content)) result.queued = true;
  }
  return result;
}

/** A user record's typed words: its string content, or its text blocks in order. */
function promptText(entry: any): string {
  const content = entry?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text).join("\n");
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
