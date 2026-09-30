import { selectWindowBranch, type ConversationFormat, type WindowIdentity } from "./conversation.ts";
import { isWindowKey } from "./window-key.ts";

const limitCodes = new Set(["rate_limit", "rate_limit_error", "usage_limit_reached", "usage_limit_exceeded", "insufficient_quota"]);
const limitWords = /(?:hit|reached|exceeded)[\s\S]{0,100}\blimit\b|\b(?:usage|weekly|monthly|daily|spend|plan) limit\b|\b(?:out of|insufficient|exhausted) (?:credits|quota)\b/i;
const message = (value: unknown): string | undefined => typeof value === "string"
  ? value.replace(/\s+/g, " ").trim().slice(0, 500) || undefined : undefined;

/** The last agent outcome, not a mention of limits in chat or a tool result.
 * A successful assistant response clears it. Older errors copied into a newly
 * launched account/session do not make that new window look exhausted. */
export function sessionUsageLimitFromLines(
  lines: readonly string[],
  format: ConversationFormat,
  window?: WindowIdentity & { sessionId: string },
): string | undefined {
  if (format === "claude" && window && isWindowKey(window.sessionId)) {
    const branch = selectWindowBranch(lines, window);
    if (branch.shared) return;
    lines = branch.lines;
  }
  for (let index = lines.length - 1; index >= 0; index--) {
    let entry: any;
    try { entry = JSON.parse(lines[index]!); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    const at = Date.parse(entry.timestamp);
    if (window?.startedAt && (!Number.isFinite(at) || at < window.startedAt)) continue;
    if (format === "claude" && entry.type === "assistant") {
      const text = message(Array.isArray(entry.message?.content)
        ? entry.message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join(" ")
        : entry.message?.content);
      if (entry.isApiErrorMessage === true || typeof entry.error === "string") {
        return limitCodes.has(entry.error) || (text && limitWords.test(text))
          ? text ?? "Usage limit reached" : undefined;
      }
      // Local synthetic notices aren't a successful model response.
      if (entry.message?.model && entry.message.model !== "<synthetic>") return;
    }
    if (format === "codex") {
      const payload = entry.payload;
      if (entry.type === "event_msg" && payload?.type === "task_complete") {
        const text = message(payload.error?.message);
        return limitCodes.has(payload.error?.codex_error_info) || (text && limitWords.test(text))
          ? text ?? "Usage limit reached" : undefined;
      }
      if (entry.type === "event_msg" && payload?.type === "agent_message") return;
      if (entry.type === "response_item" && payload?.type === "message" && payload.role === "assistant") return;
    }
  }
}
