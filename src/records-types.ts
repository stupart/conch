/** The durable record is independent of the small conversation shown in a snapshot. */
export type RecordProvider = "claude" | "codex";
export type RecordValue = null | boolean | number | string | RecordValue[] | { [key: string]: RecordValue };
export type RecordObject = { [key: string]: RecordValue };

export interface RecordSession {
  id: string;
  ownerDeviceId: string;
  provider: RecordProvider;
  nativeId: string;
  title?: string;
  cwd?: string;
  parentNativeId?: string;
  forkNativeId?: string;
}

export interface RecordTurn {
  id: string;
  nativeId?: string;
  parentId?: string;
  boundary: "native" | "inferred";
  startedAt?: number;
  endedAt?: number;
  status?: "running" | "completed" | "interrupted" | "unknown";
  context?: RecordObject;
}

export interface RecordItem {
  id: string;
  turnId?: string;
  nativeId?: string;
  parentId?: string;
  kind: "message" | "tool_call" | "tool_result" | "compaction" | "context" | "material" | "inter_agent";
  role?: "user" | "assistant" | "tool" | "system";
  text?: string;
  content?: RecordValue;
  at?: number;
}

export interface RecordToolCall {
  id: string;
  nativeId: string;
  callItemId?: string;
  resultItemId?: string;
  name?: string;
  arguments?: RecordValue;
  result?: RecordValue;
  status?: "running" | "completed" | "error";
  files?: { path: string; operation: string; evidence: "attempted" | "reported" }[];
}

export interface RecordResponse {
  id: string;
  nativeId?: string;
  turnId?: string;
  provider?: string;
  model?: string;
  effort?: string;
  measurement: "response" | "cumulative" | "context";
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  at?: number;
}

export interface NormalizedRecords {
  session?: Partial<Pick<RecordSession, "title" | "cwd" | "parentNativeId" | "forkNativeId">>;
  turns: RecordTurn[];
  items: RecordItem[];
  tools: RecordToolCall[];
  responses: RecordResponse[];
}

export interface RecordNormalizerContext {
  sessionId: string;
  sourceId: string;
  generation: number;
  offset: number;
  /** Only parser bookkeeping belongs here, never an input envelope or message body. */
  state: RecordObject;
  turnForItem: (nativeId: string) => string | undefined;
  itemForNativeId?: (nativeId: string) => { id: string; turnId?: string } | undefined;
}

export function emptyRecords(): NormalizedRecords {
  return { turns: [], items: [], tools: [], responses: [] };
}

/** Native IDs are scoped to their session; physical fallbacks include the source generation. */
export function recordKey(...parts: (string | number)[]): string {
  return JSON.stringify(parts);
}

export function physicalRecordKey(context: RecordNormalizerContext, part: string | number): string {
  return recordKey(context.sessionId, context.sourceId, context.generation, context.offset, part);
}

export interface RecordReceipt {
  id: string;
  sessionId: string;
  actionId: string;
  attemptId?: string;
  turnId?: string;
  itemId?: string;
  kind: "delivery" | "review" | "speech";
  state: "accepted" | "delivered" | "failed" | "unknown" | "published" | "opened" | "queued" | "completed" | "interrupted";
  observedAt: number;
  /** Deliberately small allowlist: receipts do not duplicate prompts, audio, or tool arguments. */
  details?: { code?: string; reviewId?: string; surfaceRef?: string; characterCount?: number };
}
