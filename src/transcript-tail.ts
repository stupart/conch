import { createHash } from "node:crypto";
import type { Conversation } from "./conversation.ts";

/**
 * `conch_transcript_tail` as a way to wait on a session.
 *
 * 2026-10-18 review: one Codex thread called it 33 times watching one session, 14 s to a few minutes apart, and 18 of
 * the 34 replies were `"text": ""` — the session was mid-turn, its newest entry a tool call, and an empty string said
 * nothing about whether anything had happened. So a reply carries a cursor naming the text it read; a call that passes
 * it back as `since` is told "no new text" rather than handed the same words or nothing; and `wait` holds the call until
 * there is new text or the wait runs out, so a session waiting on another doesn't poll.
 *
 * Chosen over a separate `conch_wait` tool: it is the tool agents already reach for to wait, its answer is the text they
 * were waiting for, and conch's tool list is long enough (the review's fix 9 wants it shorter).
 */

/** The longest a call may wait, in seconds. This server answers one call at a time, so a wait holds the session's other conch calls. */
export const TAIL_WAIT_MAX_S = 30;
/** How often a waiting call reads the transcript's tail again. */
export const TAIL_POLL_MS = 1_000;

/** A session's newest assistant text, as the tail reads it. */
export interface AssistantTail {
  text: string;
  /** The newest assistant item's id, which a cursor names, so the same words in a later turn are still new. */
  id?: string;
  /** True when the session wrote more since (a tool call, its own prompt): this is its text from before that. */
  midTurn: boolean;
}

/**
 * The reply a session ended its turn with (every assistant item after the last thing that isn't one, as
 * `lastAssistantReply` reads it); or, mid-turn, the newest assistant text before the tool calls it is in, marked so.
 */
export function assistantTail(conversation: Conversation): AssistantTail {
  const texts: string[] = [];
  let id: string | undefined;
  let midTurn = false;
  for (let index = conversation.order.length - 1; index >= 0; index -= 1) {
    const item = conversation.items[conversation.order[index]!];
    if (!item || item.kind === "thinking") continue;
    if (item.kind === "assistant" && item.text.trim()) {
      id ??= item.id;
      texts.unshift(item.text);
      continue;
    }
    if (texts.length) break;
    midTurn = true;
  }
  return { text: texts.join("\n").trim(), ...(id ? { id } : {}), midTurn: midTurn && texts.length > 0 };
}

/** An opaque cursor for what a tail read: the newest assistant item and its words. */
export function tailCursor(tail: Pick<AssistantTail, "text" | "id">): string {
  return `t1.${createHash("sha256").update(`${tail.id ?? ""}\0${tail.text}`).digest("hex").slice(0, 16)}`;
}

/**
 * Read until the tail's cursor is not `since`, or the wait runs out. With no `since`, a wait waits for text newer than
 * what the first read found. Returns the last read, how long it waited, and whether nothing new came of it.
 */
export async function waitForTail(
  read: () => Promise<AssistantTail>,
  options: { since?: string; waitMs: number; sleep(ms: number): Promise<void>; now(): number; everyMs?: number },
): Promise<{ tail: AssistantTail; cursor: string; waitedMs: number; unchanged: boolean }> {
  const started = options.now();
  let tail = await read();
  let cursor = tailCursor(tail);
  const baseline = options.since ?? (options.waitMs > 0 ? cursor : undefined);
  while (baseline !== undefined && cursor === baseline && options.now() - started < options.waitMs) {
    await options.sleep(Math.min(options.everyMs ?? TAIL_POLL_MS, Math.max(0, options.waitMs - (options.now() - started))));
    tail = await read();
    cursor = tailCursor(tail);
  }
  return { tail, cursor, waitedMs: options.now() - started, unchanged: baseline !== undefined && cursor === baseline };
}
