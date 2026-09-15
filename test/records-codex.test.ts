import { describe, expect, test } from "bun:test";
import { normalizeCodexRecord } from "../src/records-codex.ts";
import { recordToolResult } from "../src/records-sanitize.ts";
import { recordKey, type RecordNormalizerContext, type RecordObject } from "../src/records-types.ts";

function fixture(state: RecordObject = {}) {
  const seen = new Map<string, { id: string; turnId?: string }>();
  const context: RecordNormalizerContext = {
    sessionId: "device:codex:session", sourceId: "fixture-rollout", generation: 1, offset: 0,
    state, turnForItem: (nativeId) => seen.get(nativeId)?.turnId,
    itemForNativeId: (nativeId) => seen.get(nativeId),
  };
  return {
    context,
    read(type: string, payload: unknown) {
      context.offset += 100;
      const out = normalizeCodexRecord({ type, timestamp: "2026-09-15T00:00:00Z", payload }, context);
      for (const item of out.items) if (item.nativeId) seen.set(item.nativeId, { id: item.id, turnId: item.turnId });
      return out;
    },
  };
}

const responseMessage = (role: string, text: string, extra = {}) =>
  ({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }], ...extra });

describe("Codex durable records", () => {
  test("preserves full visible messages while rejecting privileged roles and hidden/binary parts", () => {
    const f = fixture();
    const text = "  Complete answer\n" + "x".repeat(8_000) + "\n";
    const out = f.read("response_item", {
      type: "message", id: "answer", role: "assistant",
      content: [{ type: "output_text", text }, { type: "reasoning", text: "private-reasoning" },
        { type: "input_image", image_url: "data:image/png;base64,private-image" }],
    });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.text).toBe(text);
    for (const role of ["developer", "system", "unknown"]) {
      expect(f.read("response_item", responseMessage(role, "private-instructions")).items).toEqual([]);
    }
    expect(f.read("response_item", { type: "reasoning", text: "private-reasoning", encrypted_content: "private-ciphertext" }).items).toEqual([]);
    expect(f.read("response_item", responseMessage("assistant", "private-analysis", { channel: "analysis" })).items).toEqual([]);
    expect(f.read("world_state", { state: { system_prompt: "private-instructions" } }).items).toEqual([]);
    expect(JSON.stringify([out, f.context.state])).not.toContain("private-");
  });

  test("mirrors enrich provenance without replacing response bodies with compact event text", () => {
    const f = fixture();
    const original = f.read("response_item", responseMessage("assistant", "  Full response\n"));
    const event = f.read("event_msg", { type: "agent_message", message: "Full response" });
    expect(original.items[0]?.text).toBe("  Full response\n");
    expect(event.items[0]?.id).toBe(original.items[0]?.id);
    expect(event.items[0]?.text).toBeUndefined();
    const other = fixture();
    other.read("event_msg", { type: "agent_message", message: "Full response" });
    const full = other.read("response_item", responseMessage("assistant", "  Full response\n", { id: "native" }));
    expect(full.items[0]?.text).toBe("  Full response\n");
    const update = other.read("response_item", responseMessage("assistant", "  Full response continued\n", { id: "native" }));
    expect(update.items[0]?.id).toBe(full.items[0]?.id);
  });

  test("image-only prompts retain explicit omitted-binary placeholders without comparing images", () => {
    const f = fixture();
    f.read("event_msg", { type: "task_started", turn_id: "turn" });
    const first = f.read("response_item", { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,secret-one" }] });
    const second = f.read("event_msg", { type: "user_message", content: [{ type: "image", data: "secret-two" }] });
    expect(first.items[0]).toMatchObject({ kind: "message", role: "user", content: { omittedAttachments: ["image"], reason: "binary_not_indexed" } });
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(JSON.stringify([first, second, f.context.state])).not.toContain("secret-");
  });

  test("pairs message mirrors across channels without erasing identical later turns", () => {
    const f = fixture();
    const ids: string[] = [];
    for (const turn of ["turn-one", "turn-two"]) {
      f.read("event_msg", { type: "task_started", turn_id: turn });
      const outputs = [
        f.read("response_item", responseMessage("user", "again")),
        f.read("event_msg", { type: "user_message", message: "again" }),
        f.read("response_item", responseMessage("assistant", "Done.\n", { id: "answer-" + turn })),
        f.read("event_msg", { type: "agent_message", message: "Done." }),
        f.read("event_msg", { type: "item_completed", item: { type: "agentMessage", id: "answer-" + turn, text: "Done." } }),
        f.read("event_msg", { type: "task_complete", turn_id: turn, last_agent_message: "Done." }),
      ];
      expect(outputs[0]!.items[0]!.id).toBe(outputs[1]!.items[0]!.id);
      expect(new Set(outputs.slice(2).flatMap((out) => out.items.map((item) => item.id))).size).toBe(1);
      ids.push(outputs[0]!.items[0]!.id, outputs[2]!.items[0]!.id);
    }
    expect(new Set(ids).size).toBe(4);
  });

  test("identical messages on the same carrier remain separate within one native turn", () => {
    const f = fixture();
    f.read("event_msg", { type: "task_started", turn_id: "turn" });
    const first = f.read("response_item", responseMessage("assistant", "Checking"));
    const second = f.read("response_item", responseMessage("assistant", "Checking"));
    const firstMirror = f.read("event_msg", { type: "agent_message", message: "Checking" });
    const secondMirror = f.read("event_msg", { type: "agent_message", message: "Checking" });
    expect(first.items[0]!.id).not.toBe(second.items[0]!.id);
    expect(firstMirror.items[0]!.id).toBe(first.items[0]!.id);
    expect(secondMirror.items[0]!.id).toBe(second.items[0]!.id);
  });

  test("different native item identities override text equality", () => {
    const f = fixture();
    f.read("event_msg", { type: "task_started", turn_id: "turn" });
    const first = f.read("response_item", responseMessage("assistant", "Same words", { id: "one" }));
    const second = f.read("event_msg", { type: "item_completed", item: { type: "agentMessage", id: "two", text: "Same words" } });
    expect(first.items[0]!.id).not.toBe(second.items[0]!.id);
  });

  test("legacy turn inference distinguishes mirrors from repeated human prompts", () => {
    const f = fixture();
    const first = f.read("event_msg", { type: "user_message", message: "continue" });
    const mirror = f.read("response_item", responseMessage("user", "continue"));
    f.read("response_item", responseMessage("assistant", "Continuing"));
    const next = f.read("event_msg", { type: "user_message", message: "continue" });
    expect(first.items[0]!.turnId).toBe(mirror.items[0]!.turnId);
    expect(next.items[0]!.turnId).not.toBe(first.items[0]!.turnId);
    expect(first.turns[0]?.boundary).toBe("inferred");
  });

  test("repeated native user items retain their original inferred turn without retargeting later work", () => {
    const f = fixture();
    const first = f.read("response_item", responseMessage("user", "continue", { id: "one" }));
    const second = f.read("response_item", responseMessage("user", "continue", { id: "two" }));
    const replay = f.read("response_item", responseMessage("user", "continue", { id: "one" }));
    expect(first.items[0]?.turnId).not.toBe(second.items[0]?.turnId);
    expect(replay.items[0]?.turnId).toBe(first.items[0]?.turnId);
    expect(replay.items[0]?.id).toBe(first.items[0]?.id);
    expect(replay.turns).toEqual([]);
    const answer = f.read("response_item", responseMessage("assistant", "Answer to second prompt"));
    expect(answer.items[0]?.turnId).toBe(second.items[0]?.turnId);
  });

  test("persisted native aliases survive mirror-cache clearing on another turn", () => {
    const f = fixture();
    const event = f.read("event_msg", { type: "user_message", message: "continue" });
    const native = f.read("response_item", responseMessage("user", "continue", { id: "native-user" }));
    expect(native.items[0]?.id).toBe(event.items[0]?.id);
    f.read("response_item", responseMessage("user", "next prompt", { id: "next-user" }));
    const replay = f.read("response_item", responseMessage("user", "continue", { id: "native-user" }));
    expect(replay.items[0]?.id).toBe(event.items[0]?.id);
    expect(replay.items[0]?.turnId).toBe(event.items[0]?.turnId);
  });

  test("native item keys survive different source offsets and generations", () => {
    const f = fixture();
    const entry = { type: "response_item", payload: responseMessage("assistant", "Answer", { id: "native-answer" }) };
    const original = normalizeCodexRecord(entry, f.context);
    f.context.offset = 9_999;
    f.context.generation = 2;
    f.context.state = {};
    const replay = normalizeCodexRecord(entry, f.context);
    expect(original.items[0]!.id).toBe(replay.items[0]!.id);
  });

  test("bounded mirror state survives restart and stores hashes rather than message bodies", () => {
    const f = fixture();
    f.read("event_msg", { type: "task_started", turn_id: "turn" });
    const original = f.read("response_item", responseMessage("assistant", "private-message-body"));
    const resumed = fixture(JSON.parse(JSON.stringify(f.context.state)));
    resumed.context.offset = f.context.offset;
    const mirror = resumed.read("event_msg", { type: "agent_message", message: "private-message-body" });
    expect(mirror.items[0]!.id).toBe(original.items[0]!.id);
    expect(JSON.stringify(resumed.context.state)).not.toContain("private-message-body");
    for (let i = 0; i < 150; i++) resumed.read("response_item", responseMessage("assistant", "private-body-" + i));
    const saved = resumed.context.state.codex as RecordObject;
    expect((saved.mirrors as unknown[]).length).toBeLessThanOrEqual(64);
    expect(JSON.stringify(saved)).not.toContain("private-body-");
  });

  test("orphan results remain joinable and tool bodies retain complete content", () => {
    const f = fixture();
    f.read("event_msg", { type: "task_started", turn_id: "turn" });
    const text = "result\n".repeat(1_000);
    const orphan = f.read("response_item", { type: "custom_tool_call_output", call_id: "call", output: text });
    expect(orphan.items[0]?.kind).toBe("tool_result");
    expect(orphan.items[0]?.content).toBe(text);
    expect(orphan.tools[0]).toMatchObject({ nativeId: "call", status: "completed", result: text });
    const patch = "*** Begin Patch\n*** Update File: src/main.ts\n@@\n-old\n+new\n*** End Patch";
    const call = f.read("response_item", { type: "custom_tool_call", call_id: "call", name: "functions.apply_patch", input: patch });
    expect(call.tools[0]?.id).toBe(orphan.tools[0]?.id);
    expect(call.tools[0]?.arguments).toBe(patch);
    expect(call.tools[0]?.files).toEqual([{ path: "src/main.ts", operation: "update", evidence: "attempted" }]);
  });

  test("late results keep the originating turn and structured outputs preserve failure", () => {
    const f = fixture();
    f.read("event_msg", { type: "task_started", turn_id: "one" });
    const call = f.read("response_item", { type: "function_call", call_id: "late", name: "tool", arguments: '{"a":1}' });
    f.read("event_msg", { type: "task_started", turn_id: "two" });
    const result = f.read("response_item", { type: "function_call_output", call_id: "late", output: { success: false, content: "failed", details: [1, 2] } });
    expect(result.items[0]!.turnId).toBe(call.items[0]!.turnId);
    expect(result.tools[0]).toMatchObject({ status: "error", result: { success: false, content: "failed", details: [1, 2] } });
  });

  test("tool payload secrets, hidden content and binary values are excluded", () => {
    const f = fixture();
    const call = f.read("response_item", { type: "function_call", call_id: "call", name: "tool", arguments: JSON.stringify({ path: "file.ts", api_key: "secret-key", nested: { encrypted_content: "secret-cipher", safe: true } }) });
    const output = f.read("response_item", { type: "function_call_output", call_id: "call", output: {
      content: [{ type: "text", text: "Result" }, { type: "image", data: "secret-base64", mimeType: "image/png" }],
      authorization: "secret-header", signature: "secret-signature",
    } });
    expect(call.tools[0]?.arguments).toEqual({ path: "file.ts", nested: { safe: true } });
    expect(JSON.stringify([call, output, f.context.state])).not.toContain("secret-");
  });

  test("any encrypted_ field is dropped, not only the ones providers use today", () => {
    const kept = recordToolResult(JSON.stringify({ ok: 1, encrypted_payload: "secret-a", nested: { Encrypted_Blob: "secret-b", safe: true } }));
    expect(kept).toEqual({ ok: 1, nested: { safe: true } });
  });

  test("JSON-encoded tool objects and arrays receive structured privacy filtering", () => {
    const f = fixture();
    const result = f.read("response_item", { type: "function_call_output", call_id: "encoded", output: JSON.stringify({
      success: false, api_key: "secret-key", nested: { encrypted_content: "secret-cipher", safe: 1 },
      content: [{ type: "image", data: "secret-binary", mimeType: "image/png" }],
    }) });
    expect(result.tools[0]).toMatchObject({ status: "error", result: { success: false, nested: { safe: 1 } } });
    expect(JSON.stringify(result)).not.toContain("secret-");
    expect(recordToolResult('[{"type":"text","text":"visible"},{"type":"reasoning","text":"hidden"}]'))
      .toEqual([{ type: "text", text: "visible" }]);
    for (const opaque of ["null", "42", "{ not JSON }", "ordinary prose"]) expect(recordToolResult(opaque)).toBe(opaque);
    const message = f.read("response_item", responseMessage("assistant", '{"api_key":"ordinary-code-example"}'));
    expect(message.items[0]?.text).toBe('{"api_key":"ordinary-code-example"}');
  });

  test("deduplicated response usage stays separate from cumulative and context measurements", () => {
    const f = fixture();
    f.read("session_meta", { id: "session", model_provider: "provider", base_instructions: "private-system" });
    f.read("turn_context", { turn_id: "turn", model: "model-one", effort: "high", cwd: "/fixture", world_state: "private-world" });
    const record = { response_id: "response-one", turn_id: "turn", usage: { input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 5, output_tokens: 20, reasoning_output_tokens: 10 }, thread_token_usage: { total_tokens: 999_999 } };
    const first = f.read("token_usage_record", record);
    const repeated = f.read("token_usage_record", record);
    expect(first.responses[0]!.id).toBe(repeated.responses[0]!.id);
    expect(first.responses[0]).toMatchObject({ model: "model-one", provider: "provider", effort: "high", measurement: "response", inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, cacheWriteTokens: 5, reasoningTokens: 10 });
    const totals = f.read("event_msg", { type: "token_count", info: {
      total_token_usage: { input_tokens: 1_000, output_tokens: 200 },
      last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, model_context_window: 250_000,
    } });
    expect(totals.responses.map((r) => r.measurement)).toEqual(["cumulative", "context"]);
    expect(totals.responses[1]).toMatchObject({ contextTokens: 120, contextWindow: 250_000 });
    expect(totals.responses[1]?.inputTokens).toBeUndefined();
    const unique = new Map([...first.responses, ...repeated.responses, ...totals.responses].map((r) => [r.id, r]));
    expect([...unique.values()].filter((r) => r.measurement === "response").reduce((sum, r) => sum + (r.inputTokens ?? 0), 0)).toBe(100);
  });

  test("models can change within a turn and unknown token fields remain absent", () => {
    const f = fixture();
    f.read("turn_context", { turn_id: "one", model: "first" });
    const first = f.read("token_usage_record", { response_id: "r1", turn_id: "one", usage: { output_tokens: 0 } });
    const update = f.read("turn_context", { turn_id: "one", model: "second" });
    const second = f.read("token_usage_record", { response_id: "r2", turn_id: "one", usage: { output_tokens: 1 } });
    f.read("turn_context", { turn_id: "two", model: "third" });
    const late = f.read("token_usage_record", { response_id: "r3", turn_id: "one", usage: { output_tokens: 2 } });
    expect(first.responses[0]?.model).toBe("first");
    expect(second.responses[0]?.model).toBe("second");
    expect(late.responses[0]?.model).toBe("second");
    expect(update.turns.every((turn) => turn.startedAt === undefined)).toBe(true);
    expect(first.responses[0]?.inputTokens).toBeUndefined();
    expect(f.read("event_msg", { type: "token_count", info: null }).responses).toEqual([]);
  });

  test("duplicate response measurements preserve their first known model across restart and model changes", () => {
    const f = fixture();
    f.read("turn_context", { turn_id: "turn", model: "first", effort: "medium" });
    const record = { response_id: "response", turn_id: "turn", usage: { output_tokens: 1 } };
    const original = f.read("token_usage_record", record);
    const resumed = fixture(JSON.parse(JSON.stringify(f.context.state)));
    resumed.context.offset = f.context.offset;
    resumed.read("turn_context", { turn_id: "turn", model: "second", effort: "high" });
    const replay = resumed.read("token_usage_record", record);
    expect(replay.responses[0]?.id).toBe(original.responses[0]?.id);
    expect(replay.responses[0]).toMatchObject({ model: "first", effort: "medium" });
    const next = resumed.read("token_usage_record", { ...record, response_id: "next" });
    expect(next.responses[0]).toMatchObject({ model: "second", effort: "high" });
  });

  test("partial turn contexts preserve model metadata and root IDs do not invent local parent edges", () => {
    const f = fixture();
    f.read("session_meta", { model_provider: "provider", context_window: 100_000 });
    f.read("turn_context", { turn_id: "child", model: "model", effort: "medium", cwd: "/first" });
    const partial = f.read("turn_context", { turn_id: "child", cwd: "/second", root_turn_id: "other-thread-turn" });
    expect(partial.turns[0]).toMatchObject({ context: { model: "model", effort: "medium", contextWindow: 100_000, rootTurnId: "other-thread-turn" } });
    expect(partial.turns[0]?.parentId).toBeUndefined();
    const usage = f.read("token_usage_record", { response_id: "response", turn_id: "child", usage: { output_tokens: 1 } });
    expect(usage.responses[0]).toMatchObject({ model: "model", effort: "medium", provider: "provider" });
  });

  test("fork and compaction boundaries survive without replaying private replacement history", () => {
    const f = fixture();
    const meta = f.read("session_meta", { cwd: "/fixture", parent_thread_id: "parent", forked_from_id: "origin", forked_from_ordinal_exclusive: 42, base_instructions: "private-base" });
    expect(meta.session).toEqual({ cwd: "/fixture", parentNativeId: "parent", forkNativeId: "origin" });
    expect(meta.items[0]?.content).toMatchObject({ forkNativeId: "origin", forkOrdinal: 42 });
    const compact = f.read("compacted", { compaction_response_id: "compact-one", message: "Visible summary", window_id: "window-two", previous_window_id: "window-one", window_number: 2, replacement_history: [{ role: "system", content: "private-replacement" }], latest_token_usage_record: { encrypted_content: "private-cipher" } });
    expect(compact.items).toHaveLength(1);
    expect(compact.items[0]).toMatchObject({ kind: "compaction", text: "Visible summary", content: { previousWindowId: "window-one", windowNumber: 2 } });
    expect(JSON.stringify([meta, compact, f.context.state])).not.toContain("private-");
  });

  test("inter-agent communication stays attributed and is not a human message", () => {
    const f = fixture();
    const result = f.read("response_item", { type: "agent_message", id: "mail", author: "/root/worker", recipient: "/root", content: [{ type: "text", text: "The check passed" }], encrypted_content: "private-cipher" });
    expect(result.items[0]).toMatchObject({ kind: "inter_agent", role: "assistant", text: "The check passed", content: { author: "/root/worker", recipient: "/root" } });
    expect(JSON.stringify(result)).not.toContain("private-cipher");
  });

  test("completion/abort identify their turns and completion-only answers remain available", () => {
    const f = fixture();
    const complete = f.read("event_msg", { type: "task_complete", turn_id: "finished", last_agent_message: "Only recorded here" });
    expect(complete.items[0]?.text).toBe("Only recorded here");
    expect(complete.turns.at(-1)).toMatchObject({ id: recordKey(f.context.sessionId, "turn", "finished"), status: "completed", boundary: "native" });
    const abort = f.read("event_msg", { type: "turn_aborted", turn_id: "aborted" });
    expect(abort.turns[0]).toMatchObject({ id: recordKey(f.context.sessionId, "turn", "aborted"), status: "interrupted" });
  });
});
