import type { RecordItem } from "./records-types.ts";

export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 100;
export const HISTORY_ID_MAX_BYTES = 4096;
export const HISTORY_CURSOR_MAX_BYTES = 16 * 1024;
// MCP quotes the JSON result inside a text block. Leave room for that escaping and its envelope.
export const HISTORY_PAYLOAD_MAX_BYTES = 28 * 1024;

export interface HistoryPageRequest { session: string; branch?: string; before?: string; limit?: number }
export interface HistoryItemRequest { session: string; item: string; bodyCursor?: string }
export type HistoryRequest = ({ kind: "history-page" } & HistoryPageRequest) | ({ kind: "history-item" } & HistoryItemRequest);
export interface HistoryItemSummary {
  id: string;
  turnId?: string;
  nativeId?: string;
  parentId?: string;
  kind: RecordItem["kind"];
  role?: RecordItem["role"];
  at?: number;
  revision: number;
  orderKey: string;
  preview: string;
  bodyBytes: number;
  toolName?: string;
}
export interface HistoryCoverage {
  sources: number;
  statuses: Record<string, number>;
  replayRequired: boolean;
  malformedLines: number;
  indexedBytes: number;
  observedBytes: number;
  branch: "all" | "ancestry";
  order: "timestamp-source";
}
export interface HistoryPage {
  kind: "history-page";
  session: string;
  items: HistoryItemSummary[];
  previousCursor: string | null;
  changeCursor: string;
  coverage: HistoryCoverage;
  epoch: string;
}
export interface HistoryItem {
  kind: "history-item";
  item: string;
  content: string;
  nextBodyCursor: string | null;
  revision: number;
  encoding: "text" | "json";
}
export type HistoryErrorCode = "invalid-request" | "unauthorized" | "session-not-found" | "ambiguous-session"
  | "item-not-found" | "invalid-cursor" | "stale-cursor" | "stale-item" | "branch-unavailable"
  | "frame-too-large" | "response-too-large" | "unavailable" | "busy";
export interface HistoryError { kind: "history-error"; code: HistoryErrorCode; error: string; epoch?: string; revision?: number }
export type HistoryResponse = HistoryPage | HistoryItem | HistoryError | { kind: "history-off"; error: "history is off" };
export type HistoryParse<T> = { ok: true; value: T } | { ok: false; err: string };
export const historyOff = (): HistoryResponse => ({ kind: "history-off", error: "history is off" });
export const historyError = (code: HistoryErrorCode, error: string): HistoryError => ({ kind: "history-error", code, error });
export const historyBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const boundedString = (value: unknown, maximum: number): value is string => typeof value === "string"
  && !!value.trim() && Buffer.byteLength(value, "utf8") <= maximum;
const invalid = <T>(err: string): HistoryParse<T> => ({ ok: false, err });

export function parseHistoryPageRequest(value: unknown): HistoryParse<HistoryPageRequest> {
  if (!object(value) || Object.keys(value).some((key) => !["session", "branch", "before", "limit"].includes(key))
    || !boundedString(value.session, HISTORY_ID_MAX_BYTES)
    || (value.branch !== undefined && !boundedString(value.branch, HISTORY_ID_MAX_BYTES))
    || (value.before !== undefined && !boundedString(value.before, HISTORY_CURSOR_MAX_BYTES))
    || (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > HISTORY_MAX_LIMIT))) {
    return invalid("history.page requires a session, optional branch/cursor, and a limit from 1 to 100");
  }
  return { ok: true, value: { session: value.session,
    ...(value.branch === undefined ? {} : { branch: value.branch as string }),
    ...(value.before === undefined ? {} : { before: value.before as string }),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }) } };
}

export function parseHistoryItemRequest(value: unknown): HistoryParse<HistoryItemRequest> {
  if (!object(value) || Object.keys(value).some((key) => !["session", "item", "bodyCursor"].includes(key))
    || !boundedString(value.session, HISTORY_ID_MAX_BYTES) || !boundedString(value.item, HISTORY_ID_MAX_BYTES)
    || (value.bodyCursor !== undefined && !boundedString(value.bodyCursor, HISTORY_CURSOR_MAX_BYTES))) {
    return invalid("history.item requires a session, item ID and optional body cursor");
  }
  return { ok: true, value: { session: value.session, item: value.item,
    ...(value.bodyCursor === undefined ? {} : { bodyCursor: value.bodyCursor as string }) } };
}

export function validateHistoryRequest(value: unknown): HistoryParse<HistoryRequest> {
  if (!object(value)) return invalid("invalid history request");
  const { kind, ...request } = value;
  if (kind === "history-page") {
    const parsed = parseHistoryPageRequest(request);
    return parsed.ok ? { ok: true, value: { kind, ...parsed.value } } : parsed;
  }
  if (kind === "history-item") {
    const parsed = parseHistoryItemRequest(request);
    return parsed.ok ? { ok: true, value: { kind, ...parsed.value } } : parsed;
  }
  return invalid("invalid history request kind");
}

export function validateHistoryResponse(value: unknown): HistoryParse<HistoryResponse> {
  if (!object(value)) return invalid("invalid history response");
  try { if (historyBytes(value) > HISTORY_PAYLOAD_MAX_BYTES) return invalid("history response exceeds its byte limit"); }
  catch { return invalid("invalid history response"); }
  if (value.kind === "history-off" && value.error === "history is off") return { ok: true, value: value as HistoryResponse };
  const nonnegative = (number: unknown) => Number.isSafeInteger(number) && Number(number) >= 0;
  const revision = (number: unknown) => nonnegative(number) && Number(number) > 0;
  const errors: readonly HistoryErrorCode[] = ["invalid-request", "unauthorized", "session-not-found", "ambiguous-session",
    "item-not-found", "invalid-cursor", "stale-cursor", "stale-item", "branch-unavailable", "frame-too-large",
    "response-too-large", "unavailable", "busy"];
  if (value.kind === "history-error" && errors.includes(value.code as HistoryErrorCode) && typeof value.error === "string"
    && (value.epoch === undefined || boundedString(value.epoch, 128)) && (value.revision === undefined || revision(value.revision))) {
    return { ok: true, value: value as unknown as HistoryError };
  }
  const cursor = (input: unknown) => input === null || boundedString(input, HISTORY_CURSOR_MAX_BYTES);
  if (value.kind === "history-item" && boundedString(value.item, HISTORY_ID_MAX_BYTES) && typeof value.content === "string"
    && cursor(value.nextBodyCursor) && revision(value.revision)
    && (value.encoding === "text" || value.encoding === "json")) return { ok: true, value: value as unknown as HistoryItem };
  if (value.kind === "history-page" && boundedString(value.session, HISTORY_ID_MAX_BYTES) && Array.isArray(value.items)
    && value.items.length <= HISTORY_MAX_LIMIT && cursor(value.previousCursor) && boundedString(value.changeCursor, HISTORY_CURSOR_MAX_BYTES)
    && boundedString(value.epoch, 128) && object(value.coverage)
    && [value.coverage.sources, value.coverage.malformedLines, value.coverage.indexedBytes, value.coverage.observedBytes].every(nonnegative)
    && typeof value.coverage.replayRequired === "boolean" && ["all", "ancestry"].includes(String(value.coverage.branch))
    && value.coverage.order === "timestamp-source" && object(value.coverage.statuses)
    && Object.entries(value.coverage.statuses).every(([status, count]) =>
      ["queued", "indexing", "complete", "partial", "missing", "error", "oversized"].includes(status) && nonnegative(count))
    && value.items.every((item) => object(item) && boundedString(item.id, HISTORY_ID_MAX_BYTES)
      && revision(item.revision) && typeof item.preview === "string" && typeof item.orderKey === "string" && nonnegative(item.bodyBytes)
      && ["message", "tool_call", "tool_result", "compaction", "context", "material", "inter_agent"].includes(String(item.kind))
      && (item.role === undefined || ["user", "assistant", "tool", "system"].includes(String(item.role)))
      && (item.at === undefined || (typeof item.at === "number" && Number.isFinite(item.at)))
      && [item.turnId, item.nativeId, item.parentId, item.toolName].every((field) => field === undefined || typeof field === "string"))) {
    return { ok: true, value: value as unknown as HistoryPage };
  }
  return invalid("invalid history response");
}
