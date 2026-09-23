import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordStore, type RecordIngest } from "../src/records-store.ts";
import { RECORD_PARSER_VERSION, SOURCE_PROBE_BYTES, type StoredRecordSource } from "../src/records-source.ts";
import type { RecordReceipt, RecordSession } from "../src/records-types.ts";
import { RECORD_MIGRATIONS } from "../src/records-schema.ts";

const directories: string[] = [];
const stores: RecordStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "conch-records-"));
  directories.push(path);
  return path;
}
function open(configDir = directory()): RecordStore {
  const store = new RecordStore({ configDir });
  stores.push(store);
  return store;
}
function rows(store: RecordStore, sql: string): any[] {
  const db = new Database(store.path, { readonly: true });
  try { return db.query(sql).all(); } finally { db.close(); }
}
const session: RecordSession = { id: "fixture", ownerDeviceId: "test-device", provider: "claude", nativeId: "fixture-native" };
const receipt: RecordReceipt = { id: "receipt-1", sessionId: session.id, actionId: "action-1", kind: "delivery", state: "delivered", observedAt: 1 };
const user = (uuid: string, text: string, parentUuid: string | null = null) => ({
  type: "user", uuid, parentUuid, timestamp: "2026-09-15T01:00:00Z", message: { role: "user", content: text },
});
const jsonl = (...entries: unknown[]): Buffer => Buffer.from(entries.map((entry) => JSON.stringify(entry) + "\n").join(""));

function batch(bytes: Uint8Array, previous?: StoredRecordSource, overrides: Partial<RecordIngest["source"]> = {}): RecordIngest {
  const from = overrides.from ?? previous?.offset ?? 0;
  return { session, source: {
    id: "source", path: "/fixture/transcript.jsonl", device: "1", inode: "2", modifiedMs: 1,
    size: bytes.length, from, bytes: bytes.subarray(from), prefix: bytes.subarray(0, SOURCE_PROBE_BYTES),
    expected: previous ? { generation: previous.generation, offset: previous.offset } : null,
    checkpoint: bytes.subarray(Math.max(0, from - SOURCE_PROBE_BYTES), from), ...overrides,
  } };
}

test("records migrate once, use WAL, and keep the database and sidecars owner-only", () => {
  const store = open();
  store.appendReceipt(receipt);
  expect(rows(store, "PRAGMA user_version")[0].user_version).toBe(RECORD_MIGRATIONS.length);
  expect(rows(store, "PRAGMA journal_mode")[0].journal_mode).toBe("wal");
  expect(rows(store, "SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name).sort())
    .toEqual(["sessions", "sources", "turns", "items", "item_sources", "tool_calls", "responses", "receipts", "history_metadata", "prompt_cursors"].sort());
  for (const suffix of ["", "-wal", "-shm"]) expect(statSync(store.path + suffix).mode & 0o777).toBe(0o600);
  expect(statSync(join(store.path, "..")).mode & 0o777).toBe(0o700);
  const reopened = open(join(store.path, "..", ".."));
  expect(reopened.receipts(receipt.actionId)).toEqual([receipt]);
});

test("coverage migration upgrades the foundation without changing its receipt journal", () => {
  const dir = directory();
  mkdirSync(join(dir, "records"));
  const db = new Database(join(dir, "records", "history.sqlite"));
  db.exec(RECORD_MIGRATIONS[0]!);
  db.exec("PRAGMA user_version=1");
  db.query("INSERT INTO receipts VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL)")
    .run(receipt.id, receipt.sessionId, receipt.actionId, receipt.kind, receipt.state, receipt.observedAt);
  db.close();
  const store = open(dir);
  expect(rows(store, "PRAGMA user_version")[0].user_version).toBe(RECORD_MIGRATIONS.length);
  expect(store.receipts(receipt.actionId)).toEqual([receipt]);
});

test("source registration, bounded metadata pages and recovery coverage survive reopening", () => {
  const dir = directory();
  const store = open(dir);
  const file = { id: "one", path: "/fixture/one.jsonl", device: "1", inode: "1" };
  const first = store.registerSource(session, file);
  store.registerSource(session, { ...file, id: "two", inode: "2" });
  expect(first.offset).toBe(0);
  expect(store.sourcePage({ limit: 1 }).map((entry) => entry.source.id)).toEqual(["one"]);
  expect(store.sourcePage({ after: "one", limit: 1 }).map((entry) => entry.source.id)).toEqual(["two"]);
  store.setCoverage("one", { status: "missing", error: "ENOENT", at: 12 });
  expect(open(dir).sourcePage()[0]!.coverage).toEqual({ status: "missing", error: "ENOENT", replayRequired: false, updatedAt: 12 });
  store.reindex(session.id);
  expect(store.sourcePage().every((entry) => entry.coverage.replayRequired && entry.source.offset === 0)).toBe(true);
  store.setCoverage("one", { status: "complete", at: 13 });
  expect(store.sourcePage()[0]!.coverage.replayRequired).toBe(false);
  expect(store.sourcePage()[1]!.coverage.replayRequired).toBe(true);
  expect(() => store.setCoverage("one", { status: "error", error: "must not store raw file content" })).toThrow("invalid source coverage");
});

test("unknown future schema is refused without downgrading it", () => {
  const dir = directory();
  const store = open(dir);
  const db = new Database(store.path);
  db.exec("PRAGMA user_version=100");
  db.close();
  expect(() => new RecordStore({ configDir: dir })).toThrow("unsupported record schema");
  expect(rows(store, "PRAGMA user_version")[0].user_version).toBe(100);
});

test("record storage refuses a symlink instead of changing the destination", () => {
  const dir = directory();
  const destination = directory();
  symlinkSync(destination, join(dir, "records"));
  expect(() => new RecordStore({ configDir: dir })).toThrow("real directory");
});

test("idempotent replay preserves items, revisions, response totals, and the checkpoint", () => {
  const store = open();
  const entry = { type: "assistant", uuid: "a", parentUuid: "u", requestId: "r", message: {
    role: "assistant", id: "m", model: "fixture-model", usage: { input_tokens: 11, output_tokens: 7 },
    content: [{ type: "text", text: "response" }],
  } };
  const input = batch(jsonl(user("u", "hello"), entry, entry));
  store.ingest(input);
  const counts = store.counts();
  const before = rows(store, "SELECT id,revision FROM items ORDER BY id");
  expect(counts.items).toBe(2);
  expect(counts.responses).toBe(1);
  expect(before.every((item) => item.revision === 1)).toBe(true);
  expect(rows(store, "SELECT sum(input_tokens) AS n FROM responses WHERE measurement='response'")[0].n).toBe(11);
  store.ingest(input);
  expect(store.counts()).toEqual(counts);
  expect(rows(store, "SELECT id,revision FROM items ORDER BY id")).toEqual(before);
  expect(store.source("source")?.offset).toBe(input.source.size);
  expect(store.source("source")?.generation).toBe(1);
});

test("an exception before checkpoint rolls back every normalized write", () => {
  const store = open();
  const initial = jsonl(user("u", "first"));
  store.ingest(batch(initial));
  const previous = store.source("source")!;
  const input = batch(jsonl(user("u", "first"), user("u2", "second")), previous);
  expect(() => store.ingest(input, () => { throw new Error("crash before checkpoint"); })).toThrow("crash before checkpoint");
  expect(store.source("source")).toEqual(previous);
  expect(store.counts().items).toBe(1);
  store.ingest(input);
  expect(store.counts().items).toBe(2);
});

test("a stale full-batch retry cannot erase a newer append", () => {
  const store = open();
  const old = batch(jsonl(user("u", "first")));
  store.ingest(old);
  store.ingest(batch(jsonl(user("u", "first"), user("u2", "newer")), store.source("source"), { modifiedMs: 2 }));
  const previous = store.source("source");
  expect(() => store.ingest(old)).toThrow("stale");
  expect(store.source("source")).toEqual(previous);
  expect(store.counts().items).toBe(2);
});

test("a parser upgrade rebuilds even when the file rotates at the same time", () => {
  const store = open();
  store.ingest(batch(jsonl(user("old", "old parser"))));
  const db = new Database(store.path);
  db.exec("UPDATE sources SET parser_version=0");
  db.close();
  const result = store.ingest(batch(jsonl(user("new", "new parser")), store.source("source"), { from: 0, inode: "3" }));
  expect(result.change).toBe("rewrite");
  expect(rows(store, "SELECT text FROM items").map((item) => item.text)).toEqual(["new parser"]);
});

test("the parser version is per provider: a Codex upgrade re-reads Codex's sources, not Claude's", () => {
  const store = open();
  const codexSession: RecordSession = { ...session, id: "codex-fixture", provider: "codex", nativeId: "codex-native" };
  const said = (...texts: string[]) => jsonl(...texts.map((text) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } })));
  // From byte 0 both times, so the store alone decides between append and rewrite.
  const codex = (bytes: Uint8Array, previous?: StoredRecordSource): RecordIngest => {
    const input = batch(bytes, previous, { from: 0 });
    return { session: codexSession, source: { ...input.source, id: "codex-source", path: "/fixture/rollout-x.jsonl", inode: "9" } };
  };
  store.ingest(batch(jsonl(user("u", "claude words"))));
  store.ingest(codex(said("codex words")));
  // Its acknowledgement lost, the same read retried resumes rather than reading as stale.
  expect(store.ingest(codex(said("codex words"))).change).toBe("append");
  // A re-index queues the replay at Codex's version, or it would replay twice.
  store.reindex(codexSession.id);
  expect(store.source("codex-source")?.parserVersion).toBe(RECORD_PARSER_VERSION.codex);
  store.ingest(codex(said("codex words"), store.source("codex-source")));
  expect(rows(store, "SELECT id, parser_version FROM sources ORDER BY id"))
    .toEqual([{ id: "codex-source", parser_version: RECORD_PARSER_VERSION.codex }, { id: "source", parser_version: RECORD_PARSER_VERSION.claude }]);
  // Codex's parser moved on; Claude's did not.
  const db = new Database(store.path);
  db.exec(`UPDATE sources SET parser_version=parser_version-1 WHERE id='codex-source'`);
  db.close();
  expect(store.ingest(batch(jsonl(user("u", "claude words"), user("u2", "more")), store.source("source"))).change).toBe("append");
  expect(store.ingest(codex(said("codex words", "more"), store.source("codex-source"))).change).toBe("rewrite");
});

test("process crash before checkpoint leaves neither new items nor an advanced cursor", async () => {
  const dir = directory();
  const store = open(dir);
  const initial = jsonl(user("u", "first"));
  store.ingest(batch(initial));
  store.appendReceipt(receipt);
  const previous = store.source("source")!;
  const bytes = jsonl(user("u", "first"), user("u2", "second"));
  const input = batch(bytes, previous);
  const script = join(dir, "crash.ts");
  const plain = { ...input, source: { ...input.source, bytes: [...input.source.bytes], prefix: [...input.source.prefix], checkpoint: [...input.source.checkpoint] } };
  writeFileSync(script, `import {RecordStore} from ${JSON.stringify(new URL("../src/records-store.ts", import.meta.url).href)};
    const input=${JSON.stringify(plain)};
    for (const key of ['bytes','prefix','checkpoint']) input.source[key]=new Uint8Array(input.source[key]);
    const store=new RecordStore({configDir:${JSON.stringify(dir)}});
    store.ingest(input,()=>process.exit(71));`);
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(71);
  const recovered = open(dir);
  expect(recovered.source("source")).toEqual(previous);
  expect(recovered.counts().items).toBe(1);
  expect(recovered.receipts(receipt.actionId)).toEqual([receipt]);
  recovered.ingest(input);
  expect(recovered.counts().items).toBe(2);
});

test("partial UTF-8 lines never advance the committed offset or emit replacement characters", () => {
  const store = open();
  const first = jsonl(user("one", "one"));
  const complete = Buffer.concat([first, jsonl(user("two", "two 🐚 three"))]);
  const split = complete.indexOf(Buffer.from("🐚")) + 2;
  const partial = complete.subarray(0, split);
  const result = store.ingest(batch(partial));
  expect(result.source.offset).toBe(first.length);
  expect(result.malformedLines).toBe(0);
  expect(store.counts().items).toBe(1);
  store.ingest(batch(complete, store.source("source"), { modifiedMs: 2 }));
  expect(rows(store, "SELECT text FROM items ORDER BY order_key").map((row) => row.text)).toEqual(["one", "two 🐚 three"]);
  expect(store.source("source")?.offset).toBe(complete.length);
});

test("malformed complete lines record coverage errors without retaining their envelopes", () => {
  const store = open();
  const bytes = Buffer.concat([Buffer.from('{"private-fixture":invalid}\n'), jsonl(user("u", "okay"))]);
  const result = store.ingest(batch(bytes));
  expect(result.malformedLines).toBe(1);
  expect(result.source.offset).toBe(bytes.length);
  expect(store.counts().items).toBe(1);
  expect(readFileSync(store.path).includes(Buffer.from("private-fixture"))).toBe(false);
});

test("rewrite, truncation and rotation update source generations and preserve receipts", () => {
  const store = open();
  let bytes = jsonl(user("u", "first"), user("u2", "longer second"));
  store.ingest(batch(bytes));
  store.appendReceipt(receipt);
  bytes = jsonl(user("u", "other"), user("u2", "longer second"));
  let result = store.ingest(batch(bytes, store.source("source"), { from: 0, modifiedMs: 2 }));
  expect(result.change).toBe("rewrite");
  expect(result.source.generation).toBe(2);
  expect(rows(store, "SELECT text FROM items ORDER BY order_key")[0].text).toBe("other");
  bytes = jsonl(user("u3", "short"));
  result = store.ingest(batch(bytes, store.source("source"), { from: 0, modifiedMs: 3 }));
  expect(result.change).toBe("rewrite");
  expect(store.counts().items).toBe(1);
  result = store.ingest(batch(bytes, store.source("source"), { from: 0, inode: "3", modifiedMs: 4 }));
  expect(result.change).toBe("rotation");
  expect(result.source.generation).toBe(4);
  expect(store.receipts(receipt.actionId)).toEqual([receipt]);
});

test("rotation retains prior records and their original file identity", () => {
  const store = open();
  store.ingest(batch(jsonl(user("old", "old segment"))));
  const result = store.ingest(batch(jsonl(user("new", "new segment", "old")), store.source("source"), { from: 0, inode: "3" }));
  expect(result.change).toBe("rotation");
  expect(store.counts().items).toBe(2);
  expect(rows(store, "SELECT source_device,source_inode,generation FROM item_sources ORDER BY generation"))
    .toEqual([{ source_device: "1", source_inode: "2", generation: 1 }, { source_device: "1", source_inode: "3", generation: 2 }]);
});

test("checkpoint probes detect a rewrite beyond the prefix", () => {
  const store = open();
  const bytes = jsonl(user("u", "x".repeat(1_000)), user("last", "before"));
  store.ingest(batch(bytes));
  const changed = jsonl(user("u", "x".repeat(1_000)), user("last", "after!"), user("added", "next"));
  const result = store.ingest(batch(changed, store.source("source"), { from: 0 }));
  expect(result.change).toBe("rewrite");
  expect(rows(store, "SELECT text FROM items WHERE native_id='last'")[0].text).toBe("after!");
});

test("same-size modification during a bounded read restarts from zero", () => {
  const store = open();
  const bytes = jsonl(user("a", "x".repeat(1_000)), user("b", "y".repeat(1_000)));
  const boundary = bytes.indexOf(10) + 1;
  store.ingest(batch(bytes, undefined, { bytes: bytes.subarray(0, boundary) }));
  const changed = Buffer.from(bytes);
  changed[400] = "z".charCodeAt(0);
  const result = store.ingest(batch(changed, store.source("source"), { from: 0, modifiedMs: 2 }));
  expect(result.change).toBe("rewrite");
  expect(rows(store, "SELECT text FROM items WHERE native_id='a'")[0].text).toContain("z");
});

test("Codex mirrors enrich native identity and retain the full body and partial context", () => {
  const store = open();
  const event = (type: string, payload: unknown) => ({ type, payload });
  const bytes = jsonl(
    event("turn_context", { turn_id: "t", model: "fixture-model", cwd: "/fixture" }),
    event("turn_context", { turn_id: "t", effort: "high" }),
    event("event_msg", { type: "agent_message", message: "answer" }),
    event("response_item", { type: "message", role: "assistant", id: "native", content: [{ type: "output_text", text: "answer\n" }] }),
    event("event_msg", { type: "task_complete", turn_id: "t", last_agent_message: "answer" }),
  );
  store.ingest({ ...batch(bytes), session: { ...session, provider: "codex" } });
  expect(store.counts().items).toBe(1);
  expect(rows(store, "SELECT native_id,text FROM items")[0]).toEqual({ native_id: "native", text: "answer\n" });
  expect(JSON.parse(rows(store, "SELECT context_json FROM turns")[0].context_json))
    .toEqual({ model: "fixture-model", cwd: "/fixture", effort: "high" });
  expect(store.counts().item_sources).toBe(3);
});

test("Codex response replay retains model attribution and does not add usage twice", () => {
  const store = open();
  const event = (type: string, payload: unknown) => ({ type, payload });
  const bytes = jsonl(
    event("turn_context", { turn_id: "t", model: "first-model" }),
    event("token_usage_record", { turn_id: "t", response_id: "r", usage: { input_tokens: 11, output_tokens: 7 } }),
    event("turn_context", { turn_id: "t", model: "second-model" }),
    event("token_usage_record", { turn_id: "t", response_id: "r", usage: { input_tokens: 11, output_tokens: 8 } }),
    event("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 11, output_tokens: 8 }, last_token_usage: { total_tokens: 19 } } }),
  );
  store.ingest({ ...batch(bytes), session: { ...session, provider: "codex" } });
  expect(rows(store, "SELECT model,input_tokens,output_tokens FROM responses WHERE measurement='response'"))
    .toEqual([{ model: "first-model", input_tokens: 11, output_tokens: 8 }]);
  expect(rows(store, "SELECT sum(input_tokens) AS n FROM responses WHERE measurement='response'")[0].n).toBe(11);
});

test("rename with the same file identity preserves the generation and items", () => {
  const store = open();
  const bytes = jsonl(user("u", "unchanged"));
  store.ingest(batch(bytes));
  const result = store.ingest(batch(bytes, store.source("source"), { path: "/fixture/renamed.jsonl" }));
  expect(result.change).toBe("append");
  expect(result.source.generation).toBe(1);
  expect(store.counts().items).toBe(1);
});

test("receipts survive a re-index and cannot be changed by retry or SQL", () => {
  const store = open();
  const bytes = jsonl(user("u", "original"));
  store.ingest(batch(bytes));
  expect(store.appendReceipt(receipt)).toBe(true);
  expect(store.appendReceipt(receipt)).toBe(false);
  expect(() => store.appendReceipt({ ...receipt, state: "failed" })).toThrow("different content");
  store.reindex(session.id);
  expect(store.counts().items).toBe(0);
  expect(store.source("source")?.offset).toBe(0);
  expect(store.receipts(receipt.actionId)).toEqual([receipt]);
  store.ingest(batch(bytes, store.source("source")));
  expect(store.counts().items).toBe(1);
  expect(store.receipts(receipt.actionId)).toEqual([receipt]);
  const db = new Database(store.path);
  try {
    expect(() => db.exec("DELETE FROM receipts")).toThrow("immutable");
    expect(() => db.exec("UPDATE receipts SET state='failed'")).toThrow("immutable");
  } finally { db.close(); }
});

test("a source rewrite invalidates shared derived records but only the affected session", () => {
  const store = open();
  const bytes = jsonl(user("u", "branch"));
  store.ingest(batch(bytes));
  store.ingest(batch(jsonl(user("u2", "other branch")), undefined, { id: "branch", path: "/fixture/branch.jsonl", inode: "3" }));
  store.ingest({ ...batch(bytes, undefined, { id: "unrelated" }), session: { ...session, id: "other", nativeId: "other" } });
  store.reindex(session.id);
  expect(store.source("branch")?.offset).toBe(0);
  expect(store.source("unrelated")?.offset).toBe(bytes.length);
  expect(store.counts().items).toBe(1);
});

test("orphan tool result is joined when its call arrives later without regressing status", () => {
  const store = open();
  const result = { type: "user", uuid: "result", message: { content: [{ type: "tool_result", tool_use_id: "call", content: "full result" }] } };
  store.ingest(batch(jsonl(result)));
  expect(rows(store, "SELECT call_item_id,status FROM tool_calls")[0]).toEqual({ call_item_id: null, status: "completed" });
  const call = { type: "assistant", uuid: "call-message", message: { content: [{ type: "tool_use", id: "call", name: "Read", input: { file_path: "/fixture/file" } }] } };
  store.ingest(batch(jsonl(result, call), store.source("source")));
  const tool = rows(store, "SELECT * FROM tool_calls")[0];
  expect(tool.call_item_id).not.toBeNull();
  expect(tool.result_item_id).not.toBeNull();
  expect(tool.status).toBe("completed");
  expect(tool.result_json).toBe('"full result"');
});

test("reasoning and raw envelopes are excluded from database, WAL, and parser state", () => {
  const store = open();
  const bytes = jsonl(user("u", "visible"), {
    type: "assistant", uuid: "a", parentUuid: "u", hiddenEnvelope: "RAW_ENVELOPE_FIXTURE", message: {
      content: [
        { type: "thinking", thinking: "PRIVATE_REASONING_FIXTURE", signature: "SIGNATURE_FIXTURE" },
        { type: "text", text: "visible answer" },
        { type: "tool_use", id: "t", name: "fixture", input: { nested: { encrypted_content: "CIPHERTEXT_FIXTURE", api_key: "KEY_FIXTURE", keep: true } } },
      ],
    },
  });
  store.ingest(batch(bytes));
  const stored = Buffer.concat([readFileSync(store.path), readFileSync(store.path + "-wal")]).toString();
  for (const omitted of ["RAW_ENVELOPE_FIXTURE", "PRIVATE_REASONING_FIXTURE", "SIGNATURE_FIXTURE", "CIPHERTEXT_FIXTURE", "KEY_FIXTURE"]) {
    expect(stored).not.toContain(omitted);
  }
  expect(rows(store, "SELECT arguments_json FROM tool_calls")[0].arguments_json).toBe('{"nested":{"keep":true}}');
  expect(store.counts().items).toBe(3);
});

test("long bodies remain whole instead of inheriting snapshot character caps", () => {
  const store = open();
  const body = "whole ".repeat(2_000);
  store.ingest(batch(jsonl(user("u", body))));
  expect(rows(store, "SELECT text FROM items")[0].text).toBe(body);
});
