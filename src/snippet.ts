/** Turn a markdown reply into something worth hearing. */

export function stripMarkdown(md: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept
    .join(" ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images -> their text
    .replace(/[`*_#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

/**
 * First N sentences, kept WHOLE under the char cap — a mid-sentence chop
 * here silently swallowed words between announcement and read-aloud
 * (observed live). Only a single over-cap monster sentence still gets cut.
 */
export function firstSentences(text: string, count: number, maxChars: number): string {
  const parts = splitSentences(text).slice(0, count);
  const out: string[] = [];
  let len = 0;
  for (const s of parts) {
    if (out.length && len + s.length + 1 > maxChars) break;
    out.push(s);
    len += s.length + 1;
  }
  let joined = out.join(" ");
  if (joined.length > maxChars) joined = joined.slice(0, maxChars);
  return joined.trim();
}

/**
 * How many leading sentences are fully contained in the announcement?
 * The reader resumes AFTER what was actually spoken — never assume.
 */
export function countCoveredSentences(announce: string, sentences: string[], max: number): number {
  let covered = 0;
  for (const s of sentences.slice(0, max)) {
    if (!announce.includes(s.trim())) break;
    covered++;
  }
  return covered;
}

/**
 * The FINAL message of the last turn, not just any trailing text block.
 *
 * A turn's transcript looks like: interim text -> tool calls -> interim
 * text -> tool calls -> final summary (possibly split across entries).
 * Naively taking "the last text seen" can surface a stale interim note
 * ("let me look into it") when the real ending says the work is done.
 * So: walk backwards, skip meta lines, and collect the trailing run of
 * assistant text — stopping at the first tool call or user entry, which
 * by construction is where the final message begins.
 */
export async function lastAssistantText(transcriptPath: string): Promise<string> {
  let raw: string;
  try {
    raw = await Bun.file(transcriptPath).text();
  } catch {
    return "";
  }
  const lines = raw.split("\n");
  const collected: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // partial line mid-write
    }
    if (entry.type === "user") break; // tool_result or the user's prompt — final message starts after this
    if (entry.type !== "assistant") continue; // meta lines (snapshots, mode, ...) interleave freely
    const content: Array<{ type: string; text?: string }> = entry.message?.content ?? [];
    // Stop BEFORE collecting an entry that also holds a tool_use: its text is
    // interim ("I'll check the tests..."), and the final message starts after
    // it. Collecting it prepended stale narration to the announcement.
    if (content.some((c) => c.type === "tool_use")) break;
    const texts = content.filter((c) => c.type === "text").map((c) => c.text ?? "");
    if (texts.length) collected.unshift(texts.join("\n"));
  }
  // Join entries with a newline, not a space: stripMarkdown detects code fences
  // by a line-start ``` — a space glued entry 2's opening fence mid-line, so the
  // fence went undetected, code was read aloud, and the real tail was dropped.
  return collected.join("\n");
}

/** Count real user PROMPT entries (typed messages, not tool_result) in a transcript. */
async function countUserPrompts(transcriptPath: string): Promise<number> {
  let text: string;
  try {
    text = await Bun.file(transcriptPath).text();
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    let e: any;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type !== "user") continue;
    // Skip Claude Code's synthetic wakeups: a finished background task/agent is
    // written as a *user* entry (origin.kind "task-notification", promptSource
    // "system", content the "<task-notification>…" string). Counting these as
    // your replies misfires userRespondedSince (mic gate) and the inject
    // confirm-retry ("sent" when nothing was sent).
    if (e.origin?.kind === "task-notification" || e.promptSource === "system") continue;
    const c = e.message?.content;
    if (typeof c === "string" && c.startsWith("<task-notification>")) continue;
    const isRealPrompt =
      typeof c === "string" ? c.trim().length > 0 : Array.isArray(c) && c.some((b: any) => b?.type === "text" && b.text?.trim());
    if (isRealPrompt) n++;
  }
  return n;
}

/** How many times you'd prompted this session when a turn fired — the "where we were" mark. */
export async function transcriptMark(transcriptPath: string): Promise<number> {
  return countUserPrompts(transcriptPath);
}

/**
 * True if you typed another prompt to this session since `mark` — i.e. you already
 * responded directly and the conversation moved on, so conch shouldn't still read
 * that turn aloud or nag you for input on it. Counting prompt ENTRIES (not lines)
 * is robust to trailing newlines and interleaved tool_result/meta entries.
 */
export async function userRespondedSince(
  transcriptPath: string | undefined,
  mark: number | undefined,
): Promise<boolean> {
  if (!transcriptPath || mark == null) return false;
  return (await countUserPrompts(transcriptPath)) > mark;
}

/**
 * Does the tail of a reply actually solicit the user? Used to suppress
 * idle_prompt announcements for sessions that are just... idle ("I'll ping
 * you when it lands, enjoy the 4th") rather than blocked on an answer.
 */
export function looksLikeAwaitingReply(text: string): boolean {
  const tail = splitSentences(text).slice(-3).join(" ");
  if (tail.includes("?")) return true;
  return /\b(let me know|tell me|your call|which (one|way|option)|should i|do you want|want me to|say the word|waiting on you|give me the go)\b/i.test(tail);
}

export async function spokenSnippet(
  transcriptPath: string,
  sentences: number,
  maxChars: number,
): Promise<string> {
  // The Stop hook can fire before the final text is flushed to the
  // transcript; a couple of short retries beat announcing a stale line.
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = await lastAssistantText(transcriptPath);
    if (text) return firstSentences(stripMarkdown(text), sentences, maxChars);
    await Bun.sleep(400);
  }
  return "";
}
