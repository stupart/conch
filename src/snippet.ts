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

export function firstSentences(text: string, count: number, maxChars: number): string {
  return splitSentences(text).slice(0, count).join(" ").slice(0, maxChars).trim();
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
    const texts = content.filter((c) => c.type === "text").map((c) => c.text ?? "");
    if (texts.length) collected.unshift(texts.join(" "));
    if (content.some((c) => c.type === "tool_use")) break; // interim text attached to tool work
  }
  return collected.join(" ");
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
