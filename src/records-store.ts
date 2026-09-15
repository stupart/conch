import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeClaudeRecord } from "./records-claude.ts";
import { normalizeCodexRecord } from "./records-codex.ts";
import { RECORD_MIGRATIONS } from "./records-schema.ts";
import { recordValue } from "./records-sanitize.ts";
import {
  completeRecordLines, inspectRecordSource, recordFingerprint, RECORD_PARSER_VERSION, SOURCE_PROBE_BYTES,
  type RecordSourceRead, type StoredRecordSource,
} from "./records-source.ts";
import type { NormalizedRecords, RecordReceipt, RecordSession } from "./records-types.ts";

export type { StoredRecordSource } from "./records-source.ts";
export interface RecordIngest { session: RecordSession; source: RecordSourceRead }
export interface RecordIngestResult { source: StoredRecordSource; lines: number; malformedLines: number; change: string }
export type RecordCounts = { [K in "sessions" | "sources" | "turns" | "items" | "item_sources" | "tool_calls" | "responses" | "receipts"]: number };

const TABLES = ["sessions", "sources", "turns", "items", "item_sources", "tool_calls", "responses", "receipts"] as const;
const json = (value: unknown): string | null => {
  const clean = recordValue(value);
  return clean === undefined ? null : JSON.stringify(clean);
};
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Synchronous by design: application callers use records-client, which owns this in a worker. */
export class RecordStore {
  readonly path: string;
  private readonly db: Database;

  constructor(options: { configDir: string }) {
    if (!nonempty(options.configDir)) throw new Error("record store requires a config directory");
    const directory = join(resolve(options.configDir), "records");
    if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) {
      throw new Error("record directory must be a real directory");
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.path = join(directory, "history.sqlite");
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
        throw new Error("record database files must be regular files");
      }
      if (existsSync(path)) chmodSync(path, 0o600);
    }
    closeSync(openSync(this.path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
    chmodSync(this.path, 0o600);
    this.db = new Database(this.path, { strict: true });
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version > RECORD_MIGRATIONS.length) throw new Error(`unsupported record schema version ${version}`);
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      for (let index = version; index < RECORD_MIGRATIONS.length; index++) {
        this.db.transaction(() => {
          this.db.exec(RECORD_MIGRATIONS[index]!);
          this.db.exec(`PRAGMA user_version = ${index + 1}`);
        })();
      }
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(this.path + suffix)) chmodSync(this.path + suffix, 0o600);
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  source(id: string): StoredRecordSource | undefined {
    const row = this.db.query("SELECT * FROM sources WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id, sessionId: row.session_id, path: row.path, device: row.device, inode: row.inode,
      size: row.size, modifiedMs: row.modified_ms, generation: row.generation, offset: row.committed_offset,
      prefixHash: row.prefix_hash, prefixLength: row.prefix_length,
      checkpointHash: row.checkpoint_hash, checkpointLength: row.checkpoint_length,
      parserVersion: row.parser_version, state: JSON.parse(row.state_json), malformedLines: row.malformed_lines,
    };
  }

  /** The callback is a fault seam: tests kill a process after writes but before the checkpoint. */
  ingest(input: RecordIngest, beforeCheckpoint?: () => void): RecordIngestResult {
    const { session } = input;
    let read = input.source;
    const expected = read.expected;
    const validExpected = expected === null || (expected !== null && typeof expected === "object"
      && Number.isSafeInteger(expected.generation) && expected.generation >= 1
      && Number.isSafeInteger(expected.offset) && expected.offset >= 0);
    if (![session.id, session.ownerDeviceId, session.nativeId, read.id, read.path, read.device, read.inode].every(nonempty)
      || !validExpected
      || ![read.from, read.size].every((n) => Number.isSafeInteger(n) && n >= 0)
      || !Number.isFinite(read.modifiedMs) || read.from + read.bytes.length > read.size
      || read.prefix.length !== Math.min(SOURCE_PROBE_BYTES, read.size)) {
      throw new Error("invalid record source");
    }
    return this.db.transaction(() => {
      const previous = this.source(read.id);
      if (previous && previous.sessionId !== session.id) throw new Error("source belongs to another session");
      // A retried full batch already contains the old checkpoint range; do not require its caller to reconstruct it.
      if (previous && read.from <= previous.offset - previous.checkpointLength
        && read.from + read.bytes.length >= previous.offset) {
        read = { ...read, checkpoint: read.bytes.subarray(previous.offset - previous.checkpointLength - read.from, previous.offset - read.from) };
      }
      const expectedMatches = previous
        ? expected !== null && expected.generation === previous.generation && expected.offset === previous.offset
        : expected === null;
      if (!expectedMatches) {
        // A lost acknowledgement can retry the same read. It may resume only when it still
        // describes this exact snapshot and contains the bytes at our newer checkpoint.
        const olderExpected = previous && (expected === null || expected.generation < previous.generation
          || (expected.generation === previous.generation && expected.offset <= previous.offset));
        const sameSnapshot = olderExpected && previous && previous.parserVersion === RECORD_PARSER_VERSION
          && read.device === previous.device && read.inode === previous.inode
          && read.size === previous.size && read.modifiedMs === previous.modifiedMs
          && recordFingerprint(read.prefix.subarray(0, previous.prefixLength)) === previous.prefixHash
          && read.checkpoint.length === previous.checkpointLength
          && recordFingerprint(read.checkpoint) === previous.checkpointHash
          && read.from <= previous.offset && read.from + read.bytes.length >= previous.offset;
        if (!sameSnapshot) throw new Error("stale record source cursor; refresh the source before retrying");
      }
      const plan = inspectRecordSource(previous, read);
      if (read.from > plan.from || read.from + read.bytes.length < plan.from) throw new Error(`source must include byte ${plan.from}`);
      if (plan.from && read.checkpoint.length !== Math.min(SOURCE_PROBE_BYTES, plan.from)) throw new Error("source checkpoint is incomplete");
      const bytes = read.bytes.subarray(plan.from - read.from);
      const framed = completeRecordLines(bytes, plan.from);
      this.ensureSession(session);
      if (plan.change === "rewrite") this.clearProjection(session.id);
      const state = plan.change === "append" || plan.change === "rotation" ? previous!.state : {};
      const offset = plan.from + framed.consumed;
      const checkpoint = Buffer.concat([plan.from ? read.checkpoint : new Uint8Array(), bytes.subarray(0, framed.consumed)])
        .subarray(-Math.min(SOURCE_PROBE_BYTES, offset));
      const source: StoredRecordSource = {
        id: read.id, sessionId: session.id, path: read.path, device: read.device, inode: read.inode,
        size: read.size, modifiedMs: read.modifiedMs, generation: plan.generation, offset,
        prefixLength: Math.min(SOURCE_PROBE_BYTES, offset),
        prefixHash: recordFingerprint(read.prefix.subarray(0, Math.min(SOURCE_PROBE_BYTES, offset))),
        checkpointLength: checkpoint.length, checkpointHash: recordFingerprint(checkpoint),
        parserVersion: RECORD_PARSER_VERSION, state,
        malformedLines: plan.change === "append" ? previous!.malformedLines : 0,
      };
      // Provenance has a source FK, but its committed offset advances only after every item is stored.
      if (!this.source(read.id)) this.writeSource({ ...source, offset: 0, state: {} });
      let malformedLines = 0;
      for (const line of framed.lines) {
        let entry: unknown;
        try { entry = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line.bytes)); }
        catch { malformedLines++; continue; }
        const context = {
          sessionId: session.id, sourceId: read.id, generation: plan.generation, offset: line.offset, state,
          turnForItem: (nativeId: string) => (this.db.query("SELECT turn_id FROM items WHERE session_id = ? AND native_id = ? AND turn_id IS NOT NULL LIMIT 1")
            .get(session.id, nativeId) as { turn_id: string } | null)?.turn_id,
          itemForNativeId: (nativeId: string) => {
            const row = this.db.query("SELECT id,turn_id FROM items WHERE session_id=? AND native_id=? ORDER BY order_key,id LIMIT 1")
              .get(session.id, nativeId) as { id: string; turn_id: string | null } | null;
            return row ? { id: row.id, turnId: row.turn_id ?? undefined } : undefined;
          },
        };
        const normalized = session.provider === "claude" ? normalizeClaudeRecord(entry, context) : normalizeCodexRecord(entry, context);
        this.writeRecords(session, normalized, source, line.offset, line.length);
      }
      source.malformedLines += malformedLines;
      beforeCheckpoint?.();
      this.writeSource(source);
      return { source, lines: framed.lines.length, malformedLines, change: plan.change };
    })();
  }

  private ensureSession(session: RecordSession): void {
    const existing = this.db.query("SELECT owner_device_id, provider, native_id FROM sessions WHERE id = ?").get(session.id) as any;
    if (existing && (existing.owner_device_id !== session.ownerDeviceId || existing.provider !== session.provider || existing.native_id !== session.nativeId)) {
      throw new Error("session identity cannot change");
    }
    this.db.query(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=COALESCE(excluded.title,title), cwd=COALESCE(excluded.cwd,cwd),
      parent_native_id=COALESCE(excluded.parent_native_id,parent_native_id), fork_native_id=COALESCE(excluded.fork_native_id,fork_native_id)`)
      .run(session.id, session.ownerDeviceId, session.provider, session.nativeId, session.title ?? null, session.cwd ?? null, session.parentNativeId ?? null, session.forkNativeId ?? null);
  }

  private writeSource(source: StoredRecordSource): void {
    this.db.query(`INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET path=excluded.path, device=excluded.device, inode=excluded.inode, size=excluded.size,
      modified_ms=excluded.modified_ms, generation=excluded.generation, committed_offset=excluded.committed_offset,
      prefix_hash=excluded.prefix_hash, prefix_length=excluded.prefix_length, checkpoint_hash=excluded.checkpoint_hash,
      checkpoint_length=excluded.checkpoint_length, parser_version=excluded.parser_version, state_json=excluded.state_json, malformed_lines=excluded.malformed_lines`)
      .run(source.id, source.sessionId, source.path, source.device, source.inode, source.size, source.modifiedMs,
        source.generation, source.offset, source.prefixHash, source.prefixLength, source.checkpointHash, source.checkpointLength,
        source.parserVersion, json(source.state)!, source.malformedLines);
  }

  private writeRecords(session: RecordSession, records: NormalizedRecords, source: StoredRecordSource, offset: number, length: number): void {
    if (records.session) this.ensureSession({ ...session, ...records.session });
    for (const turn of records.turns) {
      this.db.query(`INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET native_id=COALESCE(excluded.native_id,native_id), parent_id=COALESCE(excluded.parent_id,parent_id),
        boundary=CASE WHEN excluded.boundary='native' THEN 'native' ELSE boundary END,
        started_at=COALESCE(excluded.started_at,started_at), ended_at=COALESCE(excluded.ended_at,ended_at),
        status=COALESCE(excluded.status,status),
        context_json=CASE WHEN excluded.context_json IS NULL THEN context_json
          ELSE json_patch(COALESCE(context_json,'{}'),excluded.context_json) END`)
        .run(turn.id, session.id, turn.nativeId ?? null, turn.parentId ?? null, turn.boundary,
          turn.startedAt ?? null, turn.endedAt ?? null, turn.status ?? null, json(turn.context));
    }
    for (const [selector, item] of records.items.entries()) {
      this.db.query(`INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET turn_id=COALESCE(excluded.turn_id,turn_id), parent_id=COALESCE(excluded.parent_id,parent_id),
        native_id=COALESCE(excluded.native_id,native_id),
        text=COALESCE(excluded.text,text), content_json=COALESCE(excluded.content_json,content_json), revision=revision+1
        WHERE (excluded.text IS NOT NULL AND items.text IS NOT excluded.text)
          OR (excluded.content_json IS NOT NULL AND items.content_json IS NOT excluded.content_json)
          OR (excluded.native_id IS NOT NULL AND items.native_id IS NOT excluded.native_id)
          OR (excluded.turn_id IS NOT NULL AND items.turn_id IS NOT excluded.turn_id)
          OR (excluded.parent_id IS NOT NULL AND items.parent_id IS NOT excluded.parent_id)`)
        .run(item.id, session.id, item.turnId ?? null, item.nativeId ?? null, item.parentId ?? null, item.kind,
          item.role ?? null, item.text ?? null, json(item.content), item.at ?? null,
          `${source.id}:${String(source.generation).padStart(8, "0")}:${String(offset).padStart(16, "0")}:${selector}`);
      // Keep the original file identity even after the cursor follows a rotated file.
      this.db.query("INSERT OR IGNORE INTO item_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(item.id, source.id, source.path, source.device, source.inode, source.generation, offset, length, selector);
    }
    for (const tool of records.tools) {
      this.db.query(`INSERT INTO tool_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET call_item_id=COALESCE(excluded.call_item_id,call_item_id),
        result_item_id=COALESCE(excluded.result_item_id,result_item_id), name=COALESCE(excluded.name,name),
        arguments_json=COALESCE(excluded.arguments_json,arguments_json), result_json=COALESCE(excluded.result_json,result_json),
        status=CASE WHEN excluded.result_item_id IS NOT NULL THEN excluded.status ELSE COALESCE(tool_calls.status,excluded.status) END,
        files_json=COALESCE(excluded.files_json,files_json)`)
        .run(tool.id, session.id, tool.nativeId, tool.callItemId ?? null, tool.resultItemId ?? null, tool.name ?? null,
          json(tool.arguments), json(tool.result), tool.status ?? null, json(tool.files));
    }
    for (const response of records.responses) {
      this.db.query(`INSERT INTO responses VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET turn_id=COALESCE(turn_id,excluded.turn_id), provider=COALESCE(provider,excluded.provider),
        model=COALESCE(model,excluded.model), effort=COALESCE(effort,excluded.effort),
        input_tokens=COALESCE(excluded.input_tokens,input_tokens), output_tokens=COALESCE(excluded.output_tokens,output_tokens),
        cached_input_tokens=COALESCE(excluded.cached_input_tokens,cached_input_tokens), cache_write_tokens=COALESCE(excluded.cache_write_tokens,cache_write_tokens),
        reasoning_tokens=COALESCE(excluded.reasoning_tokens,reasoning_tokens), context_tokens=COALESCE(excluded.context_tokens,context_tokens),
        context_window=COALESCE(excluded.context_window,context_window), at=COALESCE(excluded.at,at)`)
        .run(response.id, session.id, response.turnId ?? null, response.nativeId ?? null, response.provider ?? null,
          response.model ?? null, response.effort ?? null, response.measurement, response.inputTokens ?? null,
          response.outputTokens ?? null, response.cachedInputTokens ?? null, response.cacheWriteTokens ?? null,
          response.reasoningTokens ?? null, response.contextTokens ?? null, response.contextWindow ?? null, response.at ?? null);
    }
  }

  /** Shared turns/tools can span sources. A rewrite invalidates this session's projection, not its journal. */
  private clearProjection(sessionId: string): void {
    this.db.query("DELETE FROM items WHERE session_id = ?").run(sessionId);
    for (const table of ["tool_calls", "responses", "turns"] as const) this.db.query(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
    this.db.query(`UPDATE sources SET generation=generation+1, committed_offset=0, prefix_length=0,
      prefix_hash=?, checkpoint_length=0, checkpoint_hash=?, state_json='{}', malformed_lines=0, size=0, parser_version=?
      WHERE session_id=?`).run(recordFingerprint(new Uint8Array()), recordFingerprint(new Uint8Array()), RECORD_PARSER_VERSION, sessionId);
  }

  reindex(sessionId: string): void {
    this.db.transaction(() => this.clearProjection(sessionId))();
  }

  appendReceipt(receipt: RecordReceipt): boolean {
    const states = { delivery: ["accepted", "delivered", "failed", "unknown"], review: ["published", "opened", "failed", "unknown"], speech: ["queued", "completed", "interrupted", "failed", "unknown"] };
    if (![receipt.id, receipt.sessionId, receipt.actionId].every(nonempty) || !Number.isFinite(receipt.observedAt)
      || !states[receipt.kind]?.includes(receipt.state)) throw new Error("invalid record receipt");
    const details = receipt.details && {
      ...(receipt.details.code === undefined ? {} : { code: receipt.details.code }),
      ...(receipt.details.reviewId === undefined ? {} : { reviewId: receipt.details.reviewId }),
      ...(receipt.details.surfaceRef === undefined ? {} : { surfaceRef: receipt.details.surfaceRef }),
      ...(receipt.details.characterCount === undefined ? {} : { characterCount: receipt.details.characterCount }),
    };
    const args = [receipt.id, receipt.sessionId, receipt.actionId, receipt.attemptId ?? null, receipt.turnId ?? null,
      receipt.itemId ?? null, receipt.kind, receipt.state, receipt.observedAt, json(details)] as const;
    return this.db.transaction(() => {
      const existing = this.db.query("SELECT * FROM receipts WHERE id=?").get(receipt.id) as any;
      if (existing) {
        const prior = [existing.id, existing.session_id, existing.action_id, existing.attempt_id, existing.turn_id,
          existing.item_id, existing.kind, existing.state, existing.observed_at, existing.details_json];
        if (JSON.stringify(prior) !== JSON.stringify(args)) throw new Error("receipt identity already has different content");
        return false;
      }
      this.db.query("INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...args);
      return true;
    })();
  }

  receipts(actionId: string): RecordReceipt[] {
    return (this.db.query("SELECT * FROM receipts WHERE action_id=? ORDER BY observed_at,id").all(actionId) as any[]).map((row) => ({
      id: row.id, sessionId: row.session_id, actionId: row.action_id, kind: row.kind, state: row.state, observedAt: row.observed_at,
      ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }), ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
      ...(row.item_id === null ? {} : { itemId: row.item_id }), ...(row.details_json === null ? {} : { details: JSON.parse(row.details_json) }),
    }));
  }

  counts(): RecordCounts {
    return Object.fromEntries(TABLES.map((table) => [table, (this.db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n])) as RecordCounts;
  }

  close(): void { this.db.close(); }
}
