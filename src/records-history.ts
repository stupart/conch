import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import {
  HISTORY_DEFAULT_LIMIT, HISTORY_PAYLOAD_MAX_BYTES, HISTORY_CURSOR_MAX_BYTES, HISTORY_ID_MAX_BYTES,
  historyBytes, historyError, parseHistoryItemRequest, parseHistoryPageRequest, validateHistoryResponse,
  type HistoryCoverage, type HistoryError, type HistoryItem, type HistoryItemRequest,
  type HistoryItemSummary, type HistoryPage, type HistoryPageRequest,
} from "./history.ts";

type Session = { id: string; provider: "claude" | "codex"; owner_device_id: string; history_epoch: number; change_sequence: number };
type Scope = { owner: string; session: string; epoch: string; branch: string | null; ancestry: string | null };
type PageCursor = Scope & { kind: "page"; fence: number; at: number; order: string; item: string };
type BodyCursor = Scope & { kind: "body"; item: string; revision: number; offset: number };
type Cursor = PageCursor | BodyCursor;
type Branch = { fingerprint: string | null; nativeIds: string[] };
const MAX_ANCESTORS = 2048;
const PREVIEW_CHARACTERS = 240;
const BODY_READ_BYTES = 24 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
// Keep every supported field. In particular, a compaction can contain both a
// visible summary and metadata; choosing content_json alone would lose the summary.
const BODY = `(CASE WHEN i.text IS NOT NULL AND i.content_json IS NOT NULL
  THEN '{"text":'||json_quote(i.text)||',"content":'||i.content_json||'}'
  WHEN i.content_json IS NOT NULL THEN i.content_json ELSE COALESCE(i.text,'') END)`;
const ID_COLUMNS = ["id", "turn_id", "native_id", "parent_id", "order_key"];
// A tool row on screen is keyed by its CALL id; the item's native id is the message the
// call was written in. A truncated id would match nothing, so an unusable one is omitted.
const TOOL_ID = `CASE WHEN length(CAST(t.native_id AS BLOB))<=160 THEN t.native_id END`;
const META = `${ID_COLUMNS.map((name) => `CASE WHEN length(CAST(i.${name} AS BLOB))<=${HISTORY_ID_MAX_BYTES} THEN i.${name} END AS ${name}`).join(",")},
  (${ID_COLUMNS.map((name) => `length(CAST(i.${name} AS BLOB))>${HISTORY_ID_MAX_BYTES}`).join(" OR ")}) AS oversized_metadata,
  i.kind,i.role,i.at,i.revision,
  substr(COALESCE(i.text,i.content_json,''),1,${PREVIEW_CHARACTERS}) AS preview,
  length(CAST(${BODY} AS BLOB)) AS body_bytes,
  COALESCE((SELECT substr(name,1,160) FROM tool_calls t WHERE t.session_id=i.session_id AND t.call_item_id=i.id LIMIT 1),
    (SELECT substr(name,1,160) FROM tool_calls t WHERE t.session_id=i.session_id AND t.result_item_id=i.id LIMIT 1)) AS tool_name,
  COALESCE((SELECT ${TOOL_ID} FROM tool_calls t WHERE t.session_id=i.session_id AND t.call_item_id=i.id LIMIT 1),
    (SELECT ${TOOL_ID} FROM tool_calls t WHERE t.session_id=i.session_id AND t.result_item_id=i.id LIMIT 1)) AS tool_id`;

/** SQLite-only projection. Production callers reach this through records-worker. */
export class RecordsHistory {
  private readonly key: Buffer;
  constructor(private readonly db: Database) {
    const row = db.query("SELECT value FROM history_metadata WHERE key='cursor-key'").get() as { value: Uint8Array } | null;
    if (!row || row.value.length !== 32) throw new Error("invalid history cursor key");
    this.key = Buffer.from(row.value);
  }

  private session(requested: string, owner: string): Session | HistoryError {
    if (typeof owner !== "string" || !owner.trim()) return historyError("unauthorized", "history owner is required");
    let canonical = false;
    if (requested.trimStart().startsWith("[")) {
      try {
        const identity: unknown = JSON.parse(requested);
        canonical = Array.isArray(identity) && identity.length === 3 && identity.every((part) => typeof part === "string")
          && (identity[1] === "claude" || identity[1] === "codex");
        if (canonical && (identity as string[])[0] !== owner) {
          return historyError("unauthorized", "history session is not owned by this device");
        }
      } catch { /* An arbitrary string still needs an exact indexed identity. */ }
    }
    const fields = "id,provider,owner_device_id,history_epoch,change_sequence";
    const exact = this.db.query(`SELECT ${fields} FROM sessions WHERE id=?`).get(requested) as Session | null;
    // A foreign canonical ID must not fall through to an unrelated local native alias.
    if (exact) return exact.owner_device_id === owner ? exact : historyError("unauthorized", "history session is not owned by this device");
    if (canonical) return historyError("session-not-found", "history session was not found");
    const rows = this.db.query(`SELECT ${fields} FROM sessions WHERE owner_device_id=? AND native_id=? LIMIT 2`)
      .all(owner, requested) as Session[];
    if (rows.length > 1) return historyError("ambiguous-session", "history session alias is ambiguous");
    return rows[0] ?? historyError("session-not-found", "history session was not found");
  }

  private scope(session: Session, branch: string | undefined, ancestry: string | null): Scope {
    return { owner: session.owner_device_id, session: session.id, epoch: String(session.history_epoch), branch: branch ?? null, ancestry };
  }

  private encode(value: Cursor): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return "h1." + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  private decode(token: string, scope: Scope, kind: Cursor["kind"], checkAncestry = true): Cursor | HistoryError {
    try {
      if (token.length > HISTORY_CURSOR_MAX_BYTES || !/^h1\.[A-Za-z0-9_-]+$/.test(token)) throw Error();
      const bytes = Buffer.from(token.slice(3), "base64url");
      if (bytes.length < 29 || bytes.toString("base64url") !== token.slice(3)) throw Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const cursor = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")) as Cursor;
      if (!cursor || cursor.kind !== kind || cursor.owner !== scope.owner || cursor.session !== scope.session
        || cursor.branch !== scope.branch) throw Error();
      if (cursor.epoch !== scope.epoch || (checkAncestry && cursor.ancestry !== scope.ancestry)) {
        return { ...historyError("stale-cursor", "history changed; request a fresh page"), epoch: scope.epoch };
      }
      if (cursor.kind === "page" && (!integer(cursor.fence) || !Number.isFinite(cursor.at)
        || typeof cursor.order !== "string" || typeof cursor.item !== "string")) throw Error();
      if (cursor.kind === "body" && (!integer(cursor.offset) || !integer(cursor.revision) || typeof cursor.item !== "string")) throw Error();
      return cursor;
    } catch { return historyError("invalid-cursor", "history cursor is invalid for this request"); }
  }

  /**
   * The ancestry above one item, walked by the PROVIDER's parent ids.
   *
   * The tip is a record item id because that is what a reader holds; every hop after it
   * follows `parent_native_id`, which is the id the transcript itself wrote. That is what
   * makes ancestry independent of ingestion order: a parent read after its child, out of
   * another file or a fork's copy, resolves as soon as it is indexed, where a record id
   * chosen before the parent existed could only ever dangle.
   */
  private branch(session: Session, tip?: string): Branch | HistoryError {
    if (!tip) return { fingerprint: null, nativeIds: [] };
    if (session.provider !== "claude") return historyError("branch-unavailable", "this provider has no indexed item ancestry");
    const ancestor = this.db.query("SELECT native_id,parent_native_id FROM items WHERE session_id=? AND native_id=? ORDER BY order_key,id LIMIT 1");
    const nativeIds = new Set<string>();
    const chain: Array<[string, string | null]> = [];
    let row = this.db.query("SELECT native_id,parent_native_id FROM items WHERE session_id=? AND id=?")
      .get(session.id, tip) as { native_id: string | null; parent_native_id: string | null } | null;
    while (row?.native_id) {
      if (nativeIds.has(row.native_id) || nativeIds.size >= MAX_ANCESTORS) {
        return historyError("branch-unavailable", "indexed ancestry is cyclic or exceeds its traversal limit");
      }
      nativeIds.add(row.native_id);
      chain.push([row.native_id, row.parent_native_id]);
      if (row.parent_native_id === null) break;
      row = ancestor.get(session.id, row.parent_native_id) as typeof row;
      if (!row) return historyError("branch-unavailable", "indexed ancestry is incomplete");
    }
    if (!nativeIds.size) return historyError("branch-unavailable", "indexed ancestry is incomplete");
    return { fingerprint: createHash("sha256").update(JSON.stringify(chain)).digest("base64url"), nativeIds: [...nativeIds] };
  }

  private coverage(sessionId: string, branch: boolean): HistoryCoverage {
    const rows = this.db.query(`SELECT coverage_status AS status,count(*) AS n,
      sum(committed_offset) AS indexed,sum(size) AS observed,sum(malformed_lines) AS malformed,
      max(replay_required) AS replay FROM sources WHERE session_id=? GROUP BY coverage_status`).all(sessionId) as any[];
    const coverage: HistoryCoverage = { sources: 0, statuses: {}, replayRequired: false,
      malformedLines: 0, indexedBytes: 0, observedBytes: 0, branch: branch ? "ancestry" : "all", order: "timestamp-source" };
    for (const row of rows) {
      coverage.sources += row.n; coverage.statuses[row.status] = row.n;
      coverage.replayRequired ||= row.replay === 1;
      coverage.malformedLines += row.malformed; coverage.indexedBytes += row.indexed; coverage.observedBytes += row.observed;
    }
    return coverage;
  }

  private summary(row: any): HistoryItemSummary {
    return { id: row.id, kind: row.kind, revision: row.revision, orderKey: JSON.stringify([row.at ?? 0, row.order_key, row.id]),
      preview: row.preview, bodyBytes: row.body_bytes,
      ...(row.turn_id === null ? {} : { turnId: row.turn_id }), ...(row.native_id === null ? {} : { nativeId: row.native_id }),
      ...(row.parent_id === null ? {} : { parentId: row.parent_id }), ...(row.role === null ? {} : { role: row.role }),
      ...(row.at === null ? {} : { at: row.at }), ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
      ...(row.tool_id === null || row.tool_id === undefined ? {} : { toolId: row.tool_id }) };
  }

  page(request: HistoryPageRequest, owner: string): HistoryPage | HistoryError {
    const parsed = parseHistoryPageRequest(request);
    if (!parsed.ok) return historyError("invalid-request", parsed.err);
    const session = this.session(request.session, owner);
    if ("kind" in session) return session;
    const decoded = request.before ? this.decode(request.before, this.scope(session, request.branch, null), "page", false) : undefined;
    if (decoded && "error" in decoded) return decoded;
    const cursor = decoded as PageCursor | undefined;
    const ancestry = this.branch(session, request.branch);
    if ("kind" in ancestry) return ancestry;
    const scope = this.scope(session, request.branch, ancestry.fingerprint);
    if (cursor && cursor.ancestry !== ancestry.fingerprint) return {
      ...historyError("stale-cursor", "indexed ancestry changed; request a fresh page"), epoch: scope.epoch,
    };
    const fence = cursor?.fence ?? session.change_sequence;
    const parameters: Array<string | number> = [session.id, fence];
    let where = "i.session_id=? AND i.created_sequence<=?";
    if (ancestry.nativeIds.length) {
      where += ` AND i.native_id IN (${ancestry.nativeIds.map(() => "?").join(",")})`;
      parameters.push(...ancestry.nativeIds);
    }
    if (cursor) {
      where += " AND (COALESCE(i.at,0),i.order_key,i.id)<(?,?,?)";
      parameters.push(cursor.at, cursor.order, cursor.item);
    }
    const limit = request.limit ?? HISTORY_DEFAULT_LIMIT;
    const rows = this.db.query(`SELECT ${META} FROM items i WHERE ${where}
      ORDER BY COALESCE(i.at,0) DESC,i.order_key DESC,i.id DESC LIMIT ?`).all(...parameters, limit + 1) as any[];
    const count = Math.min(limit, rows.length);
    const coverage = this.coverage(session.id, !!request.branch);
    const changeCursor = "hc1." + createHmac("sha256", this.key).update(JSON.stringify([scope, session.change_sequence, coverage])).digest("base64url");
    const base = { kind: "history-page" as const, session: session.id, changeCursor,
      coverage, epoch: scope.epoch };
    for (let length = count; length >= 0; length--) {
      if (rows.slice(0, length).some((row) => row.oversized_metadata)) continue;
      const last = rows[length - 1];
      const previousCursor = last && rows.length > length ? this.encode({ ...scope, kind: "page", fence,
        at: last.at ?? 0, order: last.order_key, item: last.id }) : null;
      const result: HistoryPage = { ...base, items: rows.slice(0, length).reverse().map((row) => this.summary(row)), previousCursor };
      if (historyBytes(result) <= HISTORY_PAYLOAD_MAX_BYTES && (length > 0 || rows.length === 0)
        && (!previousCursor || previousCursor.length <= HISTORY_CURSOR_MAX_BYTES) && validateHistoryResponse(result).ok) return result;
    }
    return historyError("response-too-large", "history item metadata exceeds the response budget");
  }

  item(request: HistoryItemRequest, owner: string): HistoryItem | HistoryError {
    const parsed = parseHistoryItemRequest(request);
    if (!parsed.ok) return historyError("invalid-request", parsed.err);
    const session = this.session(request.session, owner);
    if ("kind" in session) return session;
    const scope = this.scope(session, undefined, null);
    const decoded = request.bodyCursor ? this.decode(request.bodyCursor, scope, "body") : undefined;
    if (decoded && "error" in decoded) return decoded;
    const cursor = decoded as BodyCursor | undefined;
    if (cursor && cursor.item !== request.item) return historyError("invalid-cursor", "history cursor belongs to another item");
    const metadata = this.db.query(`SELECT revision,content_json IS NOT NULL AS structured,
      length(CAST(${BODY} AS BLOB)) AS bytes FROM items i WHERE i.session_id=? AND i.id=?`)
      .get(session.id, request.item) as { revision: number; structured: number; bytes: number } | null;
    if (!metadata) return historyError("item-not-found", "history item was not found");
    if (cursor && cursor.revision !== metadata.revision) return {
      ...historyError("stale-item", "history item changed; restart its body read"), revision: metadata.revision,
    };
    const offset = cursor?.offset ?? 0;
    if (offset > metadata.bytes) return historyError("invalid-cursor", "history body cursor exceeds the item");
    // Only a bounded byte slice crosses the SQLite boundary, including for huge tool output.
    const row = this.db.query(`SELECT substr(CAST(${BODY} AS BLOB),?,?) AS chunk FROM items i WHERE i.session_id=? AND i.id=?`)
      .get(offset + 1, BODY_READ_BYTES, session.id, request.item) as { chunk: Uint8Array };
    const bytes = Buffer.from(row.chunk);
    // The exact JSON byte budget includes escaped content and cursor overhead.
    let content: string | undefined;
    for (let end = bytes.length; end >= Math.max(0, bytes.length - 3); end--) {
      try { content = utf8.decode(bytes.subarray(0, end)); break; } catch { /* Trim only a partial UTF-8 code point. */ }
    }
    if (content === undefined) return historyError("unavailable", "indexed history body is not valid UTF-8");
    const points = [...content];
    let low = 0, high = points.length;
    let result: HistoryItem | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const part = points.slice(0, middle).join("");
      const next = offset + Buffer.byteLength(part, "utf8");
      const nextBodyCursor = next < metadata.bytes ? this.encode({ ...scope, kind: "body", item: request.item,
        revision: metadata.revision, offset: next }) : null;
      const candidate: HistoryItem = { kind: "history-item", item: request.item, content: part,
        nextBodyCursor, revision: metadata.revision, encoding: metadata.structured ? "json" : "text" };
      if (historyBytes(candidate) <= HISTORY_PAYLOAD_MAX_BYTES && (!nextBodyCursor || nextBodyCursor.length <= HISTORY_CURSOR_MAX_BYTES)
        && validateHistoryResponse(candidate).ok) {
        result = candidate; low = middle + 1;
      } else high = middle - 1;
    }
    if (!result || (!result.content.length && metadata.bytes > offset)) return historyError("response-too-large", "history item identity exceeds the response budget");
    return result;
  }
}
