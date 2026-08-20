import type { ConversationFormat } from "./conversation.ts";

export interface SessionContextUsage {
  usedTokens: number;
  limitTokens: number;
}

export const CLAUDE_LEGACY_CONTEXT_LIMIT_TOKENS = 200_000;
export const CLAUDE_EXTENDED_CONTEXT_LIMIT_TOKENS = 1_000_000;

/** Newer Sonnet/Opus generations publish the model id but not their 1M limit. */
export function claudeContextLimit(model: unknown): number {
  if (typeof model !== "string") return CLAUDE_LEGACY_CONTEXT_LIMIT_TOKENS;
  const normalized = model.toLowerCase();
  const version = /claude-(sonnet|opus|fable)-(\d+)(?:[-.](\d+))?/.exec(normalized);
  if (!version) return CLAUDE_LEGACY_CONTEXT_LIMIT_TOKENS;
  const family = version[1];
  const major = Number(version[2]);
  const minor = Number(version[3] ?? 0);
  if (family === "fable" && major >= 5) return CLAUDE_EXTENDED_CONTEXT_LIMIT_TOKENS;
  if (
    (family === "sonnet" || family === "opus")
    && (major > 4 || (major === 4 && minor >= 6))
  ) return CLAUDE_EXTENDED_CONTEXT_LIMIT_TOKENS;
  return CLAUDE_LEGACY_CONTEXT_LIMIT_TOKENS;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function codexContext(entry: any): SessionContextUsage | null {
  if (entry?.type !== "event_msg" || entry.payload?.type !== "token_count") return null;
  const info = entry.payload.info;
  const usedTokens = tokenCount(info?.last_token_usage?.total_tokens);
  const limitTokens = tokenCount(info?.model_context_window);
  if (usedTokens === null || limitTokens === null || limitTokens === 0) return null;
  return { usedTokens, limitTokens };
}

function claudeContext(entry: any): SessionContextUsage | null {
  if (entry?.type !== "assistant") return null;
  const usage = entry.message?.usage;
  if (!usage || typeof usage !== "object") return null;
  const fields = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
    usage.output_tokens,
  ];
  const counts = fields.map(tokenCount);
  if (counts.every((value) => value === null)) return null;
  return {
    usedTokens: counts.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    limitTokens: claudeContextLimit(entry.message?.model),
  };
}

/** Newest valid sample wins because both agents reset current usage after compaction. */
export function contextUsageFromLines(
  lines: readonly string[],
  format: ConversationFormat,
): SessionContextUsage | null {
  const extract = format === "codex" ? codexContext : claudeContext;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const usage = extract(JSON.parse(line));
      if (usage) return usage;
    } catch {
      // A live transcript's final line can be torn while the agent appends it.
    }
  }
  return null;
}

/** Tail-only for the same reason as conversation reads: Codex rollouts can be hundreds of MB. */
export async function readSessionContextUsage(
  path: string,
  format: ConversationFormat,
  tailBytes = 1024 * 1024,
): Promise<SessionContextUsage | null> {
  const file = Bun.file(path);
  let size: number;
  try {
    size = file.size;
  } catch {
    return null;
  }
  if (!size) return null;
  const start = Math.max(0, size - tailBytes);
  let text: string;
  try {
    text = await file.slice(start).text();
  } catch {
    return null;
  }
  const lines = text.split("\n");
  if (start > 0) lines.shift();
  return contextUsageFromLines(lines, format);
}
