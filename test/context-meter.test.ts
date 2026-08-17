import { describe, expect, test } from "bun:test";
import {
  CLAUDE_EXTENDED_CONTEXT_LIMIT_TOKENS,
  CLAUDE_LEGACY_CONTEXT_LIMIT_TOKENS,
  claudeContextLimit,
  contextUsageFromLines,
} from "../src/context-meter.ts";

describe("session context usage", () => {
  test("Codex uses the latest request count instead of the cumulative billable total", () => {
    const first = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 900_000 },
          last_token_usage: { total_tokens: 91_250 },
          model_context_window: 258_400,
        },
      },
    });
    const latest = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 1_200_000 },
          last_token_usage: { total_tokens: 104_500 },
          model_context_window: 258_400,
        },
      },
    });
    expect(contextUsageFromLines([first, latest, "{torn"], "codex")).toEqual({
      usedTokens: 104_500,
      limitTokens: 258_400,
    });
  });

  test("Claude derives current usage from every input/cache/output bucket", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-haiku-4-5-20251001",
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 20_144,
          cache_read_input_tokens: 17_577,
          output_tokens: 239,
        },
      },
    });
    expect(contextUsageFromLines([line], "claude")).toEqual({
      usedTokens: 37_962,
      limitTokens: CLAUDE_LEGACY_CONTEXT_LIMIT_TOKENS,
    });
  });

  test("Claude's model id selects 200k legacy and 1M extended windows", () => {
    expect(claudeContextLimit("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(claudeContextLimit("claude-sonnet-4-5-20250929")).toBe(200_000);
    for (const model of [
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5",
    ]) expect(claudeContextLimit(model)).toBe(CLAUDE_EXTENDED_CONTEXT_LIMIT_TOKENS);
  });

  test("missing and null token samples stay absent", () => {
    expect(contextUsageFromLines([], "codex")).toBeNull();
    expect(contextUsageFromLines([
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }),
    ], "codex")).toBeNull();
  });
});
