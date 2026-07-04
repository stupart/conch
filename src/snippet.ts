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
 * Last assistant text block from a Claude Code transcript (JSONL).
 * Consecutive text blocks within one message are joined.
 */
export async function lastAssistantText(transcriptPath: string): Promise<string> {
  let raw: string;
  try {
    raw = await Bun.file(transcriptPath).text();
  } catch {
    return "";
  }
  let last = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "assistant") continue;
      const texts = (entry.message?.content ?? [])
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text);
      if (texts.length) last = texts.join(" ");
    } catch {
      // partial line mid-write; skip
    }
  }
  return last;
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
  const text = await lastAssistantText(transcriptPath);
  if (!text) return "";
  return firstSentences(stripMarkdown(text), sentences, maxChars);
}
