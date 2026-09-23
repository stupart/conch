import { describe, expect, test } from "bun:test";
import { normalizeClaudeRecord } from "../src/records-claude.ts";
import { recordKey, type RecordNormalizerContext } from "../src/records-types.ts";

function harness(sessionId = "session-a") {
  const turns = new Map<string, string>();
  const items = new Map<string, { id: string; turnId?: string }>();
  const context: RecordNormalizerContext = {
    sessionId, sourceId: "claude-log", generation: 0, offset: 0, state: {},
    turnForItem: (nativeId) => turns.get(nativeId),
    itemForNativeId: (nativeId) => items.get(nativeId),
  };
  return {
    context,
    read(entry: unknown) {
      const result = normalizeClaudeRecord(entry, context);
      for (const item of result.items) {
        if (item.nativeId && item.turnId) turns.set(item.nativeId, item.turnId);
        if (item.nativeId && !items.has(item.nativeId)) items.set(item.nativeId, { id: item.id, turnId: item.turnId });
      }
      context.offset += 100;
      return result;
    },
  };
}

function human(uuid: string, text: string, parentUuid?: string | null) {
  return { type: "user", uuid, ...(parentUuid !== undefined ? { parentUuid } : {}), message: { role: "user", content: text } };
}

describe("Claude durable record normalization", () => {
  test("pasted text is stored as the words, without Claude Code's tags; a reply is stored as written", () => {
    const h = harness();
    const tagged = '\n\n<pasted_content id="6a36">\nkeep the hero\n</pasted_content id="6a36">\n';
    expect(h.read(human("u1", tagged)).items.map((item) => item.text)).toEqual(["keep the hero"]);
    const reply = { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: tagged }] } };
    expect(h.read(reply).items.map((item) => item.text)).toEqual([tagged]);
  });

  test("retains complete visible text and structured arguments/results beyond snapshot limits", () => {
    const h = harness();
    const long = "A long visible paragraph. ".repeat(500);
    const prompt = h.read(human("u1", long));
    expect(prompt.items[0]?.text).toBe(long);
    const assistant = h.read({
      type: "assistant", uuid: "a1", parentUuid: "u1",
      message: { content: [
        { type: "text", text: long },
        { type: "tool_use", id: "call1", name: "Edit", input: { file_path: "/work/main.ts", old_string: "a", new_string: long, options: [true, 4, null] } },
      ] },
    });
    expect(assistant.items[0]?.text).toBe(long);
    expect(assistant.tools[0]?.arguments).toEqual({ file_path: "/work/main.ts", old_string: "a", new_string: long, options: [true, 4, null] });
    expect(assistant.tools[0]?.files).toEqual([{ path: "/work/main.ts", operation: "edit", evidence: "attempted" }]);
    const result = h.read({
      type: "user", uuid: "r1", parentUuid: "a1",
      message: { content: [{ type: "tool_result", tool_use_id: "call1", content: [{ type: "text", text: long }, { rows: [1, 2] }] }] },
    });
    expect(result.turns).toEqual([]);
    expect(result.items[0]?.role).toBe("tool");
    expect(result.items[0]?.turnId).toBe(prompt.turns[0]?.id);
    expect(result.tools[0]?.id).toBe(assistant.tools[0]?.id);
    expect(result.tools[0]?.result).toEqual([{ type: "text", text: long }, { rows: [1, 2] }]);
    expect(result.tools[0]?.files).toBeUndefined();
  });

  test("does not merge identical messages or move a branch into the last ingested turn", () => {
    const h = harness();
    const first = h.read(human("u1", "Again", null));
    h.read({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: "Okay" } });
    const next = h.read(human("u2", "Again", "a1"));
    const sibling = h.read({ type: "assistant", uuid: "a2", parentUuid: "u1", message: { content: "Okay" } });
    expect(first.items[0]?.id).not.toBe(next.items[0]?.id);
    expect(next.turns[0]?.parentId).toBe(first.turns[0]?.id);
    expect(sibling.items[0]?.turnId).toBe(first.turns[0]?.id);
    expect(sibling.items[0]?.parentId).toBe(first.items[0]?.id);
    const unknown = h.read({ type: "assistant", uuid: "a3", parentUuid: "missing-parent", message: { content: "Elsewhere" } });
    expect(unknown.items[0]?.turnId).toBeUndefined();
    expect(unknown.items[0]?.parentId).toBe(recordKey("session-a", "item", "missing-parent"));
  });

  test("orphan tool results remain addressable without inventing a human turn or call", () => {
    const h = harness();
    const result = h.read({
      type: "user", uuid: "r1", parentUuid: "unindexed-call",
      message: { content: [{ type: "tool_result", tool_use_id: "orphan", is_error: true, content: "Failed" }] },
    });
    expect(result.turns).toEqual([]);
    expect(result.items[0]?.turnId).toBeUndefined();
    expect(result.tools[0]).toMatchObject({ nativeId: "orphan", result: "Failed", status: "error" });
    expect(result.tools[0]?.callItemId).toBeUndefined();
    expect(harness("other-session").read({
      type: "user", uuid: "r1", message: { content: [{ type: "tool_result", tool_use_id: "orphan", content: "Failed" }] },
    }).tools[0]?.id).not.toBe(result.tools[0]?.id);
  });

  test("request identity deduplicates model/usage across assistant blocks and keeps reported zeros", () => {
    const h = harness();
    const prompt = h.read(human("u1", "Test"));
    const response = (uuid: string, output: number) => h.read({
      type: "assistant", uuid, parentUuid: "u1", requestId: "request-1",
      message: { id: "message-1", model: "claude-example", stop_reason: "end_turn", content: [
        { type: "text", text: "Done" }, { type: "tool_use", id: "call1", name: "Read", input: { file_path: "/a" } },
      ], usage: { input_tokens: 0, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } },
    });
    const one = response("a1", 10);
    const two = response("a2", 30);
    expect(one.responses).toHaveLength(1);
    expect(two.responses).toHaveLength(1);
    expect(one.responses[0]?.id).toBe(two.responses[0]?.id);
    expect(two.responses[0]).toMatchObject({
      nativeId: "request-1", model: "claude-example", inputTokens: 0, outputTokens: 30,
      cachedInputTokens: 100, cacheWriteTokens: 20, measurement: "response", turnId: prompt.turns[0]?.id,
    });
    expect(two.responses[0]?.contextWindow).toBeUndefined();
    expect(two.responses[0]?.contextTokens).toBeUndefined();
    expect(two.turns[0]?.status).toBe("completed");
  });

  test("skips hidden envelopes and reasoning but preserves compaction summaries and boundaries", () => {
    const h = harness();
    h.read(human("u1", "Test"));
    expect(h.read({ type: "system", content: "BASE INSTRUCTIONS" }).items).toEqual([]);
    expect(h.read({ type: "user", isMeta: true, message: { content: "INJECTED INSTRUCTIONS" } }).items).toEqual([]);
    const result = h.read({
      type: "assistant", uuid: "a1", parentUuid: "u1", base_instructions: "PRIVATE", encrypted_content: "PRIVATE",
      message: { content: [
        { type: "thinking", thinking: "PRIVATE", signature: "PRIVATE" },
        { type: "redacted_thinking", data: "PRIVATE" },
        { type: "text", text: "Visible" },
        { type: "tool_use", id: "call", name: "Any", input: { okay: { value: 1, api_key: "PRIVATE", encrypted_content: "PRIVATE" }, signature: "PRIVATE" } },
      ] },
    });
    expect(result.items.map((item) => item.kind)).toEqual(["message", "tool_call"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(JSON.stringify(h.context.state)).not.toContain("Visible");
    const boundary = h.read({ type: "system", subtype: "compact_boundary", uuid: "c1", parentUuid: "a1", compactMetadata: { trigger: "auto", preTokens: 120000, raw: "PRIVATE" } });
    expect(boundary.items[0]).toMatchObject({ kind: "compaction", content: { trigger: "auto", preTokens: 120000 } });
    const summary = h.read({ type: "user", uuid: "c2", parentUuid: "c1", isMeta: true, isCompactSummary: true, message: { content: "Earlier work summary" } });
    expect(summary.turns).toEqual([]);
    expect(summary.items[0]).toMatchObject({ kind: "compaction", role: "system", text: "Earlier work summary" });
    expect(h.read({ type: "summary", summary: "Branch summary", leafUuid: "a1" }).items[0]?.content).toEqual({ leafNativeId: "a1" });
  });

  test("retains safe attachment metadata and structured results without inline binary", () => {
    const h = harness();
    const result = h.read({ type: "user", uuid: "u1", message: { content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "BINARY-PRIVATE" } },
      { type: "document", title: "Spec", source: { type: "url", url: "https://example.test/spec.pdf" } },
      { type: "tool_result", tool_use_id: "call", content: [{ type: "text", text: "Result" }, { type: "image", source: { type: "base64", data: "BINARY-PRIVATE" } }] },
    ] } });
    expect(JSON.stringify(result)).not.toContain("BINARY-PRIVATE");
    expect(result.items.find((item) => item.kind === "material" && JSON.stringify(item.content).includes("Spec"))).toBeDefined();
    expect(result.tools[0]?.result).toEqual([{ type: "text", text: "Result" }, { type: "image" }]);
  });

  test("physical fallback identities distinguish source generations and repeat deterministically", () => {
    const h = harness();
    const entry = { type: "user", message: { content: "Same" } };
    const first = normalizeClaudeRecord(entry, h.context);
    const repeated = normalizeClaudeRecord(entry, h.context);
    expect(first.items[0]?.id).toBe(repeated.items[0]?.id);
    h.context.generation++;
    expect(normalizeClaudeRecord(entry, h.context).items[0]?.id).not.toBe(first.items[0]?.id);
  });

  test("a metadata-only anchor retains omitted UUID ancestry across interleaved branches", () => {
    const h = harness();
    const prompt = h.read(human("u1", "Test"));
    const hidden = h.read({ type: "assistant", uuid: "hidden", parentUuid: "u1", message: { content: [{ type: "thinking", thinking: "PRIVATE" }] } });
    expect(hidden.items).toHaveLength(1);
    expect(hidden.items[0]).toMatchObject({ kind: "context", nativeId: "hidden", turnId: prompt.turns[0]?.id });
    expect(hidden.items[0]?.text).toBeUndefined();
    expect(hidden.items[0]?.content).toBeUndefined();
    h.read(human("other", "Other branch", null));
    const result = h.read({ type: "assistant", uuid: "a1", parentUuid: "hidden", message: { content: "Visible" } });
    expect(result.items[0]?.turnId).toBe(prompt.turns[0]?.id);
    expect(result.items[0]?.parentId).toBe(hidden.items[0]?.id);
    expect(JSON.stringify(hidden)).not.toContain("PRIVATE");
    expect(JSON.stringify(h.context.state)).not.toContain("PRIVATE");
  });

  test("block evolution keeps tool identities stable and never overwrites a call with text", () => {
    const h = harness();
    const prompt = h.read(human("u", "Test"));
    const call = { type: "tool_use", id: "call", name: "Read", input: { file_path: "/file" } };
    const initial = h.read({ type: "assistant", uuid: "a", parentUuid: "u", message: { content: [call] } });
    const updated = h.read({ type: "assistant", uuid: "a", parentUuid: "u", message: { content: [{ type: "text", text: "Reading" }, call] } });
    expect(updated.tools[0]?.callItemId).toBe(initial.tools[0]?.callItemId);
    expect(updated.items[0]?.id).not.toBe(initial.items[0]?.id);
    expect(updated.items[1]?.kind).toBe("tool_call");
    expect(updated.items[0]?.parentId).toBe(prompt.items[0]?.id);
    expect(updated.items[0]?.turnId).toBe(prompt.turns[0]?.id);
    const textWithOmittedBlock = (type: string) => h.read({ type: "assistant", uuid: "b", parentUuid: "u", message: { content: [{ type, thinking: "PRIVATE" }, { type: "text", text: "Visible" }] } });
    expect(textWithOmittedBlock("thinking").items[0]?.id).toBe(textWithOmittedBlock("redacted_thinking").items[0]?.id);
  });

  test("JSON-encoded tool results are sanitized at both string and MCP text-block boundaries", () => {
    const h = harness();
    const encoded = JSON.stringify({ keep: "visible", nested: { access_token: "ENCODED_SECRET" }, image: { type: "base64", data: "ENCODED_BINARY" } });
    for (const content of [encoded, [{ type: "text", text: encoded }]]) {
      const result = h.read({ type: "user", uuid: "result", message: { content: [{ type: "tool_result", tool_use_id: "call", content }] } });
      expect(JSON.stringify(result)).not.toContain("ENCODED_SECRET");
      expect(JSON.stringify(result)).not.toContain("ENCODED_BINARY");
      expect(JSON.stringify(result)).toContain("visible");
    }
    const ordinary = h.read({ type: "user", uuid: "plain", message: { content: [{ type: "tool_result", tool_use_id: "plain-call", content: [{ type: "text", text: "[not valid JSON" }] }] } });
    expect(ordinary.items[0]?.text).toBe("[not valid JSON");
  });

  test("a branch summary follows its declared leaf, not the latest unrelated prompt", () => {
    const h = harness();
    const first = h.read(human("u1", "First", null));
    h.read({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: "Done" } });
    h.read(human("u2", "Other branch", null));
    const summary = h.read({ type: "summary", summary: "First branch summary", leafUuid: "a1" });
    expect(summary.items[0]?.turnId).toBe(first.turns[0]?.id);
  });
});
