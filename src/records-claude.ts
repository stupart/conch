import { recordToolResult, recordValue } from "./records-sanitize.ts";
import {
  emptyRecords,
  physicalRecordKey,
  recordKey,
  type NormalizedRecords,
  type RecordItem,
  type RecordNormalizerContext,
  type RecordObject,
  type RecordResponse,
  type RecordToolCall,
  type RecordValue,
} from "./records-types.ts";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

function visibleText(value: RecordValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part) => {
    const block = object(part);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  });
  return parts.length ? parts.join("\n") : undefined;
}

function claudeToolResult(value: unknown): RecordValue | undefined {
  if (!Array.isArray(value)) return recordToolResult(value);
  // MCP replies may wrap JSON output in a text block rather than the result string itself.
  return value.map((part) => {
    const block = object(part);
    if (block?.type === "text" && typeof block.text === "string") {
      const decoded = recordToolResult(block.text);
      if (typeof decoded !== "string") return decoded;
    }
    return recordToolResult(part);
  }).filter((part): part is RecordValue => part !== undefined);
}

function attemptedFiles(name: string | undefined, input: unknown): RecordToolCall["files"] {
  const args = object(input);
  if (!name || !args) return undefined;
  const operations: Record<string, string> = { Read: "read", Write: "write", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit" };
  const operation = Object.hasOwn(operations, name) ? operations[name] : undefined;
  const path = string(args.file_path) ?? string(args.notebook_path);
  return operation && path ? [{ path, operation, evidence: "attempted" }] : undefined;
}

function responseFor(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  context: RecordNormalizerContext,
  turnId: string | undefined,
  at: number | undefined,
): RecordResponse | undefined {
  const model = string(message.model) ?? string(entry.model);
  const usage = object(message.usage);
  if (!model && !usage) return undefined;
  const nativeId = string(entry.requestId) ?? string(message.id);
  return {
    id: nativeId ? recordKey(context.sessionId, "response", nativeId) : physicalRecordKey(context, "response"),
    nativeId,
    turnId,
    provider: "anthropic",
    model,
    effort: string(message.effort) ?? string(entry.effort),
    measurement: "response",
    inputTokens: count(usage?.input_tokens),
    outputTokens: count(usage?.output_tokens),
    cachedInputTokens: count(usage?.cache_read_input_tokens),
    cacheWriteTokens: count(usage?.cache_creation_input_tokens),
    reasoningTokens: count(usage?.reasoning_tokens),
    contextTokens: count(usage?.context_tokens),
    contextWindow: count(message.context_window) ?? count(entry.contextWindow),
    at,
  };
}

/** Normalize one complete JSONL record; never retain the source envelope in parser state. */
export function normalizeClaudeRecord(value: unknown, context: RecordNormalizerContext): NormalizedRecords {
  const out = emptyRecords();
  const entry = object(value);
  if (!entry) return out;

  if (entry.type === "custom-title") {
    const title = string(entry.customTitle) ?? string(entry.title);
    if (title) out.session = { title };
    return out;
  }

  const message = object(entry.message) ?? {};
  const compact = entry.type === "summary" || entry.isCompactSummary === true
    || (entry.type === "system" && entry.subtype === "compact_boundary");
  // Omitted bodies may still provide a UUID needed to follow a later visible branch.
  const omitted = !compact && ((entry.type !== "user" && entry.type !== "assistant")
    || entry.isMeta === true || message.role === "system" || message.role === "developer");

  const nativeId = string(entry.uuid);
  const parentNativeId = string(entry.parentUuid);
  const at = timestamp(entry.timestamp);
  const rootId = nativeId ? recordKey(context.sessionId, "item", nativeId) : physicalRecordKey(context, "item");
  const parentItem = parentNativeId ? context.itemForNativeId?.(parentNativeId) : undefined;
  const parentId = parentNativeId ? parentItem?.id ?? recordKey(context.sessionId, "item", parentNativeId) : undefined;
  const currentTurn = string(context.state.claudeCurrentTurnId);
  const previousNativeId = string(context.state.claudeLastNativeId);
  // An explicit, unknown parent must not borrow a different branch's most recent turn.
  const summaryLeaf = entry.type === "summary" ? string(entry.leafUuid) : undefined;
  const priorTurn = summaryLeaf ? context.turnForItem(summaryLeaf) : parentNativeId
    ? context.turnForItem(parentNativeId) ?? (parentNativeId === previousNativeId ? currentTurn : undefined)
    : !Object.hasOwn(entry, "parentUuid") ? currentTurn : undefined;
  const nativeTurnId = string(entry.turnId) ?? string(entry.turn_id);
  let turnId = nativeTurnId ? recordKey(context.sessionId, "turn", nativeTurnId) : priorTurn;
  const rawParts = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : Array.isArray(message.content) ? message.content : [];
  const parts = rawParts.map(object).filter((part): part is Record<string, unknown> => part !== undefined);

  const append = (id: string, item: Omit<RecordItem, "id" | "nativeId" | "parentId" | "at">): RecordItem => {
    const stored: RecordItem = {
      id,
      nativeId, parentId, at, ...item,
    };
    out.items.push(stored);
    return stored;
  };

  const cwd = string(entry.cwd);
  if (cwd && !omitted) out.session = { cwd };

  if (omitted) {
    // No body, tool arguments, usage, or instruction envelope is copied from these records.
  } else if (compact) {
    const content = recordValue(message.content);
    const metadata = object(entry.compactMetadata);
    const compactContent: RecordObject = {};
    if (typeof metadata?.trigger === "string") compactContent.trigger = metadata.trigger;
    const preTokens = count(metadata?.preTokens);
    if (preTokens !== undefined) compactContent.preTokens = preTokens;
    const leaf = string(entry.leafUuid);
    if (leaf) compactContent.leafNativeId = leaf;
    append(recordKey(rootId, "compaction"), {
      kind: "compaction", role: "system", turnId,
      text: string(entry.summary) ?? visibleText(content),
      content: compactContent,
    });
  } else {
    const humanInput = entry.type === "user" && parts.some((part) =>
      (part.type === "text" && typeof part.text === "string")
      || part.type === "image" || part.type === "document");
    if (humanInput || nativeTurnId) {
      turnId = nativeTurnId ? recordKey(context.sessionId, "turn", nativeTurnId)
        : nativeId ? recordKey(context.sessionId, "turn", nativeId) : physicalRecordKey(context, "turn");
      const turnContext: RecordObject = {};
      if (cwd) turnContext.cwd = cwd;
      const permissionMode = string(entry.permissionMode);
      if (permissionMode) turnContext.permissionMode = permissionMode;
      out.turns.push({
        id: turnId, nativeId: nativeTurnId ?? nativeId,
        parentId: priorTurn !== turnId ? priorTurn : undefined,
        boundary: nativeTurnId ? "native" : "inferred",
        startedAt: humanInput ? at : undefined,
        status: humanInput ? "running" : undefined,
        context: Object.keys(turnContext).length ? turnContext : undefined,
      });
    }

    for (const [blockIndex, rawPart] of rawParts.entries()) {
      const part = object(rawPart);
      if (!part) continue;
      if (part.type === "text" && typeof part.text === "string") {
        const text = recordValue(part.text);
        if (typeof text === "string") append(recordKey(rootId, "text", blockIndex), {
          kind: "message", role: entry.type === "user" ? "user" : "assistant", turnId, text,
        });
      } else if (part.type === "tool_use" && entry.type === "assistant") {
        const callNativeId = string(part.id) ?? physicalRecordKey(context, `call:${blockIndex}`);
        const name = string(part.name);
        const args = recordValue(part.input);
        const item = append(recordKey(context.sessionId, "tool_call", callNativeId), {
          kind: "tool_call", role: "assistant", turnId, content: args,
        });
        out.tools.push({
          id: recordKey(context.sessionId, "tool", callNativeId), nativeId: callNativeId,
          callItemId: item.id, name, arguments: args, status: "running", files: attemptedFiles(name, args),
        });
      } else if (part.type === "tool_result") {
        const callNativeId = string(part.tool_use_id) ?? physicalRecordKey(context, `result:${blockIndex}`);
        const result = claudeToolResult(part.content);
        const item = append(recordKey(context.sessionId, "tool_result", callNativeId), {
          kind: "tool_result", role: "tool", turnId: priorTurn ?? turnId,
          text: visibleText(result), content: result,
        });
        out.tools.push({
          id: recordKey(context.sessionId, "tool", callNativeId), nativeId: callNativeId,
          resultItemId: item.id, result, status: part.is_error === true ? "error" : "completed",
        });
      } else if (part.type === "image" || part.type === "document") {
        const content = recordValue(part);
        if (content !== undefined) append(recordKey(rootId, part.type, blockIndex), {
          kind: "material", role: entry.type === "user" ? "user" : "assistant", turnId, content,
        });
      }
    }

    if (entry.type === "assistant") {
      const response = responseFor(entry, message, context, turnId, at);
      if (response) out.responses.push(response);
      if (turnId && (message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence")) {
        out.turns.push({
          id: turnId, boundary: nativeTurnId ? "native" : "inferred",
          endedAt: at, status: "completed",
        });
      }
    }
  }

  if (out.items.length === 0 && nativeId && turnId) {
    append(rootId, { kind: "context", turnId });
  }

  if (nativeId) context.state.claudeLastNativeId = nativeId;
  else delete context.state.claudeLastNativeId;
  if (turnId) context.state.claudeCurrentTurnId = turnId;
  else delete context.state.claudeCurrentTurnId;
  return out;
}
