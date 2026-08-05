import { open } from "node:fs/promises";

/**
 * The whole of the turn in progress, exactly as the Mac dashboard shows it.
 *
 * The phone and the Mac disagreed about what "the reply" means, and the phone
 * got the worse answer. `lastAssistantText` returns the final message of a
 * COMPLETED turn and deliberately nothing while a tool call is outstanding —
 * correct for speech, which must never announce half a turn. But the phone is
 * not speaking, it is showing, and mid-turn it fell back to the short spoken
 * announce of an EARLIER turn. Tyler, watching both screens: "the mac app is
 * steadily adding what you say to the transcript but the phone app just has
 * one random sentence idk where from."
 *
 * This mirrors `lastClaudeReply` in the Mac app: scan backward, collect every
 * assistant text block, and stop only at a genuine human turn.
 *
 * Deliberately separate from the cached TranscriptReader in snippet.ts. That
 * one feeds the speech path, and the invariant it protects — never announce a
 * half-finished turn — is one I do not want to risk for a display fix.
 */

/** Transcripts run to hundreds of megabytes; only the tail can matter here. */
const DEFAULT_TAIL_BYTES = 512 * 1024;

/**
 * Claude Code records TOOL RESULTS as `type:"user"` entries. Treating any user
 * entry as the turn boundary stops the scan at the first tool result and
 * collects nothing — which is nearly always, since a turn that used a tool is
 * the normal case. Only a genuine human turn ends the reply.
 */
function isToolResult(entry: Record<string, unknown>): boolean {
  const message = entry.message as Record<string, unknown> | undefined;
  const content = message?.content ?? entry.content;
  if (!Array.isArray(content)) return false;
  return content.every((part) =>
    typeof part === "object" && part !== null
    && (part as { type?: unknown }).type === "tool_result"
  );
}

function assistantText(entry: Record<string, unknown>): string {
  const message = entry.message as Record<string, unknown> | undefined;
  const content = message?.content ?? entry.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // A tool call does not end the reply either: the narration written before
  // calling a tool is still the agent's most recent words. Keep collecting.
  return content
    .filter((part): part is { type: string; text: string } =>
      typeof part === "object" && part !== null
      && ((part as { type?: unknown }).type === "text"
        || (part as { type?: unknown }).type === "output_text")
      && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("");
}

/**
 * Read the last `maxBytes` of a transcript and assemble the current turn.
 *
 * Returns "" when the tail holds no assistant text at all, so callers can keep
 * whatever fallback they already had rather than replacing a real answer with
 * an empty pane.
 */
export async function currentTurnText(
  transcriptPath: string,
  maxBytes = DEFAULT_TAIL_BYTES,
): Promise<string> {
  let handle;
  try {
    handle = await open(transcriptPath, "r");
  } catch {
    return "";
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = new Uint8Array(length);
    await handle.read(buffer, 0, length, size - length);
    const text = new TextDecoder().decode(buffer);

    const lines = text.split("\n");
    // A tail rarely starts on a line boundary; a half line is not JSON and
    // would parse as nothing, but dropping it makes that explicit.
    if (size > length && lines.length > 0) lines.shift();

    const collected: string[] = [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = entry.type as string | undefined;
      const role = (entry.message as { role?: string } | undefined)?.role
        ?? entry.role as string | undefined;

      if (type === "user" || role === "user") {
        if (isToolResult(entry)) continue;
        break; // a real human turn — the reply starts after this
      }
      if (type !== "assistant" && role !== "assistant") continue;
      const chunk = assistantText(entry).trim();
      if (chunk) collected.push(chunk);
    }
    // Newline joins keep an entry-boundary code fence line-anchored.
    return collected.reverse().join("\n").trim();
  } catch {
    return "";
  } finally {
    await handle.close().catch(() => {});
  }
}
