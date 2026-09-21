import { createHash } from "node:crypto";
import { recordToolResult, recordValue } from "./records-sanitize.ts";
import {
  emptyRecords,
  physicalRecordKey,
  recordKey,
  type NormalizedRecords,
  type RecordNormalizerContext,
  type RecordObject,
  type RecordResponse,
  type RecordToolCall,
} from "./records-types.ts";

type ObjectValue = Record<string, unknown>;
interface TurnMetadata { model?: string; provider?: string; effort?: string }
interface Mirror {
  turnId: string;
  role: "user" | "assistant";
  hash: string;
  id: string;
  nativeId?: string;
  carriers: string[];
  hasAttachments?: boolean;
}
interface Bookkeeping {
  turnId?: string;
  nativeTurnId?: string;
  provider?: string;
  contextWindow?: number;
  mirrors: Mirror[];
  turnMetadata: Record<string, TurnMetadata>;
  responseMetadata: Record<string, TurnMetadata>;
}

const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" && value.length ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const MAX_MIRRORS = 64;
const MAX_TURN_METADATA = 32;
const MAX_RESPONSE_METADATA = 64;

function bookkeeping(context: RecordNormalizerContext): Bookkeeping {
  const saved = object(context.state.codex);
  if (saved && Array.isArray(saved.mirrors) && object(saved.turnMetadata)) {
    saved.responseMetadata ??= {};
    return saved as unknown as Bookkeeping;
  }
  const state: Bookkeeping = { mirrors: [], turnMetadata: {}, responseMetadata: {} };
  context.state.codex = state as unknown as RecordObject;
  return state;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Only visible text parts. Images, encrypted reasoning, and their metadata never become text. */
function visibleText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part) => {
    const p = object(part);
    return p && ["text", "input_text", "output_text"].includes(String(p.type)) && typeof p.text === "string"
      ? [p.text] : [];
  });
  return parts.length ? parts.join("") : undefined;
}

function omittedAttachments(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    const p = object(part);
    if (!p) return [];
    if (["image", "input_image", "image_url"].includes(String(p.type))) return ["image"];
    if (["audio", "input_audio", "output_audio"].includes(String(p.type))) return ["audio"];
    if (["document", "input_file", "file"].includes(String(p.type))) return ["document"];
    return [];
  });
}

const turnKey = (context: RecordNormalizerContext, nativeId: string) => recordKey(context.sessionId, "turn", nativeId);
const itemKey = (context: RecordNormalizerContext, nativeId: string) => recordKey(context.sessionId, "item", nativeId);
const toolKey = (context: RecordNormalizerContext, nativeId: string) => recordKey(context.sessionId, "tool", nativeId);

function beginTurn(
  out: NormalizedRecords, context: RecordNormalizerContext, state: Bookkeeping,
  nativeId: string | undefined, at: number | undefined,
): string {
  const id = nativeId ? turnKey(context, nativeId) : physicalRecordKey(context, "turn");
  if (state.turnId === id) return id;
  if (state.turnId !== id) state.mirrors = [];
  state.turnId = id;
  state.nativeTurnId = nativeId;
  out.turns.push({ id, ...(nativeId ? { nativeId } : {}), boundary: nativeId ? "native" : "inferred", startedAt: at, status: "running" });
  return id;
}

function ensureTurn(out: NormalizedRecords, context: RecordNormalizerContext, state: Bookkeeping, at?: number): string {
  return state.turnId ?? beginTurn(out, context, state, undefined, at);
}

/**
 * Codex answers its own `request_user_input_async` question (a plugin
 * sign-in link, an out-of-band approval — anything the human answers on a
 * delay, maybe from a different device) by filing a fresh `role: "user"`
 * item that quotes the WHOLE question back first, verbatim: `"> " + the
 * question + "\n\n" + whichever option was picked`. The quoted half is the
 * agent's own prior words, not anything Tyler typed — recording it whole put
 * an agent's paragraph in Tyler's mouth (the "Asset Generator" session,
 * 2026-09-21: a Blueprint OAuth explanation recorded as his for one word of
 * actual reply, "Signed in to Arch"). Only the text after the blank line is
 * his; a message that turns out to be ALL quote (no answer survives the
 * split) is left alone rather than emptied. Duplicated in `conversation.ts`
 * rather than imported — this module is deliberately independent of the
 * clipped conversation renderer (see the module comment below).
 */
function stripEchoedQuestion(text: string): string {
  if (!text.startsWith("> ")) return text;
  const blankLine = text.indexOf("\n\n");
  if (blankLine === -1) return text;
  const reply = text.slice(blankLine + 2).trim();
  return reply || text;
}

function message(
  out: NormalizedRecords, context: RecordNormalizerContext, state: Bookkeeping,
  payload: ObjectValue, role: "user" | "assistant", carrier: string, at?: number,
): void {
  if (payload.channel === "analysis" || payload.channel === "reasoning") return;
  const rawText = visibleText(payload.content) ?? visibleText(payload.message) ?? visibleText(payload.text);
  const text = role === "user" && rawText !== undefined ? stripEchoedQuestion(rawText) : rawText;
  const attachments = omittedAttachments(payload.content);
  if (text === undefined && !attachments.length) return;
  // Mirrored channels sometimes differ only by a trailing newline. The stored body remains intact.
  const hash = createHash("sha256").update(text?.trim() ?? "").digest("hex");
  const nativeId = string(payload.id) ?? string(payload.item_id);
  const savedItem = nativeId ? context.itemForNativeId?.(nativeId) : undefined;
  const savedTurnId = savedItem?.turnId ?? (nativeId ? context.turnForItem(nativeId) : undefined);
  const nativeTurnId = string(payload.turn_id);
  if (!savedTurnId && nativeTurnId && nativeTurnId !== state.nativeTurnId) beginTurn(out, context, state, nativeTurnId, at);
  let mirror = state.mirrors.find((candidate) => candidate.turnId === (savedTurnId ?? state.turnId)
    && candidate.role === role && candidate.hash === hash && !candidate.carriers.includes(carrier)
    && !(nativeId && candidate.nativeId && nativeId !== candidate.nativeId)
    // Omitted binaries cannot be compared: do not merge two images because their captions match.
    && (!(attachments.length || candidate.hasAttachments) || (nativeId && nativeId === candidate.nativeId)));
  // A repeated human prompt on the same channel starts another inferred turn; a mirror does not.
  if (!savedTurnId && (!state.turnId || (role === "user" && !state.nativeTurnId && !mirror))) {
    beginTurn(out, context, state, undefined, at);
    mirror = undefined;
  }
  const turnId = savedTurnId ?? ensureTurn(out, context, state, at);
  const knownNative = nativeId && state.mirrors.find((candidate) => candidate.turnId === turnId && candidate.nativeId === nativeId);
  const id = savedItem?.id ?? (knownNative ? knownNative.id : mirror?.id ?? (nativeId ? itemKey(context, nativeId) : physicalRecordKey(context, "message")));
  if (mirror) {
    mirror.carriers.push(carrier);
    mirror.nativeId ??= nativeId;
  }
  else {
    state.mirrors.push({ turnId, role, hash, id, nativeId, carriers: [carrier], hasAttachments: !!attachments.length });
    if (state.mirrors.length > MAX_MIRRORS) state.mirrors.splice(0, state.mirrors.length - MAX_MIRRORS);
  }
  out.items.push({
    id, turnId, nativeId, kind: "message", role, at,
    // Mirrors enrich identity/provenance. A compact event must not trim the canonical response body.
    text: mirror && carrier !== "response_message" ? undefined : text,
    ...(attachments.length ? { content: { omittedAttachments: attachments, reason: "binary_not_indexed" } } : {}),
  });
}

function usageFields(value: unknown): Partial<RecordResponse> {
  const usage = object(value) ?? {};
  return {
    inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
    cachedInputTokens: count(usage.cached_input_tokens), cacheWriteTokens: count(usage.cache_write_input_tokens),
    reasoningTokens: count(usage.reasoning_output_tokens),
  };
}

function meaningfulUsage(value: Partial<RecordResponse>): boolean {
  return Object.values(value).some((part) => typeof part === "number");
}

function filesForCall(name: string | undefined, args: unknown): RecordToolCall["files"] {
  if (!name) return undefined;
  const input = object(args);
  const path = string(input?.file_path) ?? string(input?.path);
  if (path && /(?:^|[._])(?:write|edit|apply_patch)(?:$|[._])/i.test(name)) {
    return [{ path, operation: "write", evidence: "attempted" }];
  }
  const patch = typeof args === "string" ? args : string(input?.patch);
  if (name.endsWith("apply_patch") && patch) {
    return [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)]
      .map((match) => ({ path: match[2]!, operation: match[1]!.toLowerCase(), evidence: "attempted" as const }));
  }
  return undefined;
}

function tool(
  out: NormalizedRecords, context: RecordNormalizerContext, state: Bookkeeping,
  payload: ObjectValue, result: boolean, at?: number,
): void {
  const nativeId = string(payload.call_id) ?? string(payload.id);
  if (!nativeId) return; // An unaddressable result cannot safely be joined to whichever call ran last.
  const id = toolKey(context, nativeId);
  const turnId = context.turnForItem(nativeId)
    ?? (string(payload.turn_id) ? turnKey(context, String(payload.turn_id)) : ensureTurn(out, context, state, at));
  const recordId = recordKey(context.sessionId, result ? "result" : "call", nativeId);
  if (result) {
    const value = recordToolResult(payload.output);
    const status = payload.is_error === true || object(value)?.success === false || object(value)?.isError === true ? "error" : "completed";
    out.items.push({ id: recordId, nativeId, turnId, kind: "tool_result", role: "tool", content: value, at });
    out.tools.push({ id, nativeId, resultItemId: recordId, result: value, status });
  } else {
    const name = string(payload.name);
    // Arguments may be JSON, plain source code, or a patch. Do not flatten or summarize them.
    const raw = payload.arguments ?? payload.input;
    let args: unknown = raw;
    if (typeof raw === "string") { try { args = JSON.parse(raw); } catch { /* Plain source is a valid argument. */ } }
    const value = recordValue(args);
    out.items.push({ id: recordId, nativeId, turnId, kind: "tool_call", role: "assistant", content: value, at });
    out.tools.push({ id, nativeId, callItemId: recordId, name, arguments: value, status: "running", files: filesForCall(name, args) });
  }
}

function interAgent(out: NormalizedRecords, context: RecordNormalizerContext, state: Bookkeeping, payload: ObjectValue, at?: number): void {
  const text = visibleText(payload.content) ?? visibleText(payload.text) ?? visibleText(payload.message);
  if (text === undefined) return;
  const nativeId = string(payload.id);
  out.items.push({
    id: nativeId ? itemKey(context, nativeId) : physicalRecordKey(context, "inter-agent"),
    nativeId, turnId: state.turnId, kind: "inter_agent", role: "assistant", text, at,
    content: recordValue({ author: payload.author, recipient: payload.recipient, other_recipients: payload.other_recipients }),
  });
}

/** A neutral, durable projection; intentionally independent of the clipped conversation renderer. */
export function normalizeCodexRecord(entry: unknown, context: RecordNormalizerContext): NormalizedRecords {
  const out = emptyRecords();
  const envelope = object(entry);
  const payload = object(envelope?.payload);
  if (!envelope || !payload) return out;
  const state = bookkeeping(context);
  const at = timestamp(envelope.timestamp);

  if (envelope.type === "session_meta") {
    state.provider = string(payload.model_provider) ?? state.provider;
    state.contextWindow = count(payload.context_window) ?? state.contextWindow;
    const parent = string(payload.parent_thread_id);
    const fork = string(payload.forked_from_id);
    out.session = { cwd: string(payload.cwd), parentNativeId: parent, forkNativeId: fork };
    // Keep explicit fork boundaries; do not persist base_instructions, source envelopes, or git snapshots.
    if (parent || fork) out.items.push({
      id: recordKey(context.sessionId, "fork-metadata"), kind: "context", at,
      content: recordValue({ parentNativeId: parent, forkNativeId: fork, forkOrdinal: count(payload.forked_from_ordinal_exclusive) }),
    });
    return out;
  }

  if (envelope.type === "turn_context") {
    const nativeId = string(payload.turn_id);
    const id = nativeId ? beginTurn(out, context, state, nativeId, at) : ensureTurn(out, context, state, at);
    const effort = string(payload.effort);
    const metadata: TurnMetadata = { ...state.turnMetadata[id],
      ...(string(payload.model) ? { model: string(payload.model) } : {}),
      ...(state.provider ? { provider: state.provider } : {}),
      ...(effort ? { effort } : {}),
    };
    state.turnMetadata[id] = metadata;
    const keys = Object.keys(state.turnMetadata);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_TURN_METADATA))) delete state.turnMetadata[key];
    const root = string(payload.root_turn_id);
    out.turns.push({ id, nativeId,
      boundary: nativeId ? "native" : "inferred",
      context: recordValue({ model: metadata.model, provider: metadata.provider, effort: metadata.effort,
        cwd: string(payload.cwd), rootTurnId: root,
        contextWindow: count(payload.model_context_window) ?? count(payload.context_window) ?? state.contextWindow }) as RecordObject,
    });
    return out;
  }

  if (envelope.type === "token_usage_record") {
    const nativeId = string(payload.response_id);
    const nativeTurnId = string(payload.turn_id);
    const turnId = nativeTurnId ? turnKey(context, nativeTurnId) : state.turnId;
    const currentMetadata = turnId ? state.turnMetadata[turnId] : undefined;
    const responseKey = nativeId ? recordKey(nativeId) : undefined;
    const previousMetadata = responseKey ? state.responseMetadata[responseKey] : undefined;
    // Repeated receipts for one response must not inherit a later model change in the same turn.
    const metadata: TurnMetadata = {
      model: previousMetadata?.model ?? currentMetadata?.model,
      provider: previousMetadata?.provider ?? currentMetadata?.provider,
      effort: previousMetadata?.effort ?? currentMetadata?.effort,
    };
    if (responseKey) {
      state.responseMetadata[responseKey] = metadata;
      const keys = Object.keys(state.responseMetadata);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_RESPONSE_METADATA))) delete state.responseMetadata[key];
    }
    const fields = usageFields(payload.usage);
    if (meaningfulUsage(fields)) out.responses.push({
      id: nativeId ? recordKey(context.sessionId, "response", nativeId) : physicalRecordKey(context, "response"),
      nativeId, turnId, ...metadata, measurement: "response", ...fields, at,
    });
    return out;
  }

  if (envelope.type === "compacted") {
    const nativeId = string(payload.compaction_response_id) ?? string(payload.window_id);
    out.items.push({
      id: nativeId ? recordKey(context.sessionId, "compaction", nativeId) : physicalRecordKey(context, "compaction"),
      nativeId, turnId: state.turnId, kind: "compaction", role: "system", text: visibleText(payload.message), at,
      content: recordValue({ windowId: payload.window_id, previousWindowId: payload.previous_window_id, windowNumber: count(payload.window_number) }),
    });
    // replacement_history mirrors previous records and may contain encrypted/system content.
    return out;
  }
  if (envelope.type === "inter_agent_communication") {
    interAgent(out, context, state, payload, at);
    return out;
  }

  if (envelope.type === "response_item") {
    if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
      message(out, context, state, payload, payload.role, "response_message", at);
    } else if (payload.type === "agent_message") {
      if (payload.author !== undefined || payload.recipient !== undefined) interAgent(out, context, state, payload, at);
      else message(out, context, state, payload, "assistant", "response_agent", at);
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      tool(out, context, state, payload, false, at);
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      tool(out, context, state, payload, true, at);
    }
    return out;
  }

  if (envelope.type !== "event_msg") return out;
  const type = payload.type;
  if (type === "task_started") {
    const nativeId = string(payload.turn_id);
    const id = beginTurn(out, context, state, nativeId, at);
    const window = count(payload.model_context_window);
    if (window !== undefined) {
      state.contextWindow = window;
      out.turns.push({ id, nativeId, boundary: nativeId ? "native" : "inferred", context: { contextWindow: window } });
    }
  } else if (type === "task_complete" || type === "turn_aborted") {
    if (type === "task_complete" && typeof payload.last_agent_message === "string") {
      message(out, context, state, { text: payload.last_agent_message, turn_id: payload.turn_id }, "assistant", "task_complete", at);
    }
    const nativeId = string(payload.turn_id);
    const id = nativeId ? turnKey(context, nativeId) : ensureTurn(out, context, state, at);
    out.turns.push({ id, nativeId, boundary: nativeId ? "native" : "inferred", endedAt: at,
      status: type === "task_complete" ? "completed" : "interrupted" });
  } else if (type === "user_message" || type === "agent_message") {
    message(out, context, state, payload, type === "user_message" ? "user" : "assistant", "event_message", at);
  } else if (type === "token_count") {
    const info = object(payload.info);
    if (!info) return out;
    const turnId = state.turnId;
    const metadata = turnId ? state.turnMetadata[turnId] : undefined;
    const total = usageFields(info.total_token_usage);
    if (meaningfulUsage(total)) out.responses.push({
      id: physicalRecordKey(context, "cumulative"), turnId, ...metadata, measurement: "cumulative", ...total, at,
    });
    const contextTokens = count(object(info.last_token_usage)?.total_tokens);
    const contextWindow = count(info.model_context_window);
    if (contextTokens !== undefined || contextWindow !== undefined) out.responses.push({
      id: physicalRecordKey(context, "context"), turnId, ...metadata, measurement: "context", contextTokens, contextWindow, at,
    });
  } else if (type === "item_completed") {
    const item = object(payload.item);
    if (!item) return out;
    if (item.type === "userMessage" || item.type === "agentMessage") {
      message(out, context, state, item, item.type === "userMessage" ? "user" : "assistant", "completed_item", at);
    }
  }
  return out;
}
