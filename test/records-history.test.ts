import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordStore } from "../src/records-store.ts";
import type { RecordSession } from "../src/records-types.ts";
import { historyBytes, validateHistoryResponse, type HistoryItem, type HistoryPage } from "../src/history.ts";
import { RECORD_MIGRATIONS } from "../src/records-schema.ts";

const opened: RecordStore[] = [];
const directories: string[] = [];
const owner = "fixture-device";
const session: RecordSession = { id: "canonical", nativeId: "native", ownerDeviceId: owner, provider: "claude" };
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function open(dir = mkdtempSync(join(tmpdir(), "conch-history-"))): RecordStore {
  if (!directories.includes(dir)) directories.push(dir);
  const store = new RecordStore({ configDir: dir }); opened.push(store); return store;
}
function ingest(store: RecordStore, entries: unknown[], target = session, sourceId = target.id) {
  const bytes = Buffer.from(entries.map((entry) => JSON.stringify(entry) + "\n").join(""));
  const previous = store.source(sourceId);
  const from = previous?.offset ?? 0;
  return store.ingest({ session: target, source: {
    id: sourceId, path: `/fixture/${sourceId}.jsonl`, device: "1", inode: sourceId,
    modifiedMs: (previous?.modifiedMs ?? 0) + 1, size: bytes.length, from,
    bytes: bytes.subarray(from), prefix: bytes.subarray(0, 256), checkpoint: bytes.subarray(Math.max(0, from - 256), from),
    expected: previous ? { generation: previous.generation, offset: previous.offset } : null,
  } });
}
const user = (uuid: string, text: string, at = 1000, parentUuid: string | null = null) => ({
  type: "user", uuid, parentUuid, timestamp: new Date(at).toISOString(), message: { role: "user", content: text },
});
function page(store: RecordStore, request: Parameters<RecordStore["historyPage"]>[0] = { session: session.id }): HistoryPage {
  const result = store.historyPage(request, owner);
  expect(result.kind).toBe("history-page");
  if (result.kind !== "history-page") throw Error(JSON.stringify(result));
  expect(validateHistoryResponse(result).ok).toBeTrue();
  return result;
}
function item(store: RecordStore, id: string, bodyCursor?: string): HistoryItem {
  const result = store.historyItem({ session: session.id, item: id, ...(bodyCursor ? { bodyCursor } : {}) }, owner);
  expect(result.kind).toBe("history-item");
  if (result.kind !== "history-item") throw Error(JSON.stringify(result));
  expect(validateHistoryResponse(result).ok).toBeTrue();
  expect(historyBytes(result)).toBeLessThanOrEqual(28 * 1024);
  // Independent transport ceiling catches regressions even if the payload constant changes.
  expect(Buffer.byteLength(JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(result) }] } }), "utf8"))
    .toBeLessThanOrEqual(64 * 1024);
  return result;
}

test("history orders timestamps across sources and keeps the reader's membership and anchor during appends/backfill", () => {
  const store = open();
  ingest(store, [user("first", "first", 1000), user("fourth", "fourth", 4000)], session, "z-source");
  ingest(store, [user("second", "second", 2000), user("third", "third", 3000)], session, "a-source");
  const latest = page(store, { session: session.id, limit: 2 });
  expect(latest.items.map((entry) => entry.preview)).toEqual(["third", "fourth"]);
  expect(latest.previousCursor).toBeTruthy();
  ingest(store, [user("backfill", "newly indexed older item", 500), user("fifth", "fifth", 5000)], session, "m-source");
  const earlier = page(store, { session: session.id, before: latest.previousCursor!, limit: 2 });
  expect(earlier.items.map((entry) => entry.preview)).toEqual(["first", "second"]);
  expect(earlier.previousCursor).toBeNull();
  const fresh = page(store);
  expect(fresh.items.map((entry) => entry.preview)).toEqual(["newly indexed older item", "first", "second", "third", "fourth", "fifth"]);
  expect(fresh.changeCursor).not.toBe(latest.changeCursor);
  expect(page(store).changeCursor).toBe(fresh.changeCursor);
  expect(latest.coverage).toMatchObject({ sources: 2, branch: "all", order: "timestamp-source" });
});

test("same-event content blocks retain numeric source order past selector nine", () => {
  const store = open();
  // Separately addressed blocks — calls, not paragraphs of one message — stay separate
  // items, and their order is the source's, not a string sort of their selectors.
  ingest(store, [{ type: "assistant", uuid: "many", timestamp: new Date(1000).toISOString(), message: {
    role: "assistant", content: Array.from({ length: 15 }, (_, i) => ({ type: "tool_use", id: `call-${i}`, name: `block ${i}`, input: { index: i } })),
  } }]);
  expect(page(store).items.map((entry) => entry.toolName)).toEqual(Array.from({ length: 15 }, (_, i) => `block ${i}`));
  expect(page(store).items.map((entry) => entry.toolId)).toEqual(Array.from({ length: 15 }, (_, i) => `call-${i}`));
});

test("owner authorization is indexed and refuses foreign canonical IDs before local native alias lookup", () => {
  const store = open();
  ingest(store, [user("a", "local")]);
  const foreign = { ...session, id: "foreign", nativeId: "foreign-native", ownerDeviceId: "other-device" };
  ingest(store, [user("b", "foreign secret")], foreign);
  expect(store.historyPage({ session: "foreign" }, owner)).toMatchObject({ kind: "history-error", code: "unauthorized" });
  expect(store.historyPage({ session: session.id }, "other-device")).toMatchObject({ code: "unauthorized" });
  expect(page(store, { session: "native" }).session).toBe(session.id);
  ingest(store, [user("c", "alias must not hide canonical ownership")], { ...session, id: "third", nativeId: "foreign" });
  expect(store.historyPage({ session: "foreign" }, owner)).toMatchObject({ code: "unauthorized" });
  ingest(store, [], { ...session, id: "codex-local", provider: "codex" });
  expect(store.historyPage({ session: "native" }, owner)).toMatchObject({ code: "ambiguous-session" });
  const id = page(store).items[0]!.id;
  expect(store.historyItem({ session: "third", item: id }, owner)).toMatchObject({ code: "item-not-found" });
  expect(store.historyItem({ session: "foreign", item: id }, owner)).toMatchObject({ code: "unauthorized" });
  const absentForeign = JSON.stringify(["other-device", "claude", "absent"]);
  ingest(store, [], { ...session, id: "canonical-looking-alias", nativeId: absentForeign });
  expect(store.historyPage({ session: absentForeign }, owner)).toMatchObject({ code: "unauthorized" });
});

test("page cursors are opaque, authenticated, scoped and persist across worker/store reopening", () => {
  const store = open();
  ingest(store, [user("a", "first"), user("b", "second", 2000)]);
  const before = page(store, { session: session.id, limit: 1 }).previousCursor!;
  expect(before).not.toContain(session.id);
  expect(store.historyPage({ session: session.id, before: before.slice(0, -1) + (before.endsWith("A") ? "B" : "A") }, owner))
    .toMatchObject({ code: "invalid-cursor" });
  ingest(store, [user("c", "other")], { ...session, id: "other", nativeId: "other" });
  expect(store.historyPage({ session: "other", before }, owner)).toMatchObject({ code: "invalid-cursor" });
  const reopened = open(join(store.path, "..", ".."));
  expect(page(reopened, { session: "native", before }).items.map((entry) => entry.preview)).toEqual(["first"]);
});

test("body revisions and projection epochs invalidate their cursors without clearing receipts", () => {
  const store = open();
  const entries = [user("a", "a".repeat(70_000)), user("b", "last", 2000)];
  ingest(store, entries);
  const first = page(store, { session: session.id, limit: 1 });
  const older = page(store, { session: session.id, before: first.previousCursor! });
  const id = older.items[0]!.id;
  const body = item(store, id);
  ingest(store, [...entries, user("a", "updated ".repeat(10_000))]);
  expect(store.historyItem({ session: session.id, item: id, bodyCursor: body.nextBodyCursor! }, owner))
    .toMatchObject({ code: "stale-item", revision: 2 });
  expect(page(store).changeCursor).not.toBe(first.changeCursor);
  store.appendReceipt({ id: "receipt", actionId: "action", sessionId: session.id, kind: "review", state: "published", observedAt: 1 });
  store.reindex(session.id);
  expect(store.historyPage({ session: session.id, before: first.previousCursor! }, owner)).toMatchObject({ code: "stale-cursor", epoch: "2" });
  expect(store.historyItem({ session: session.id, item: id, bodyCursor: body.nextBodyCursor! }, owner)).toMatchObject({ code: "stale-cursor" });
  expect(page(store).coverage.replayRequired).toBeTrue();
  expect(store.receipts("action")).toHaveLength(1);
});

test("coverage-only changes change the watermark and explicit rotation invalidates page and body cursors", () => {
  const store = open();
  ingest(store, [user("a", "large".repeat(20_000)), user("b", "later", 2000)]);
  const first = page(store, { session: session.id, limit: 1 });
  const id = page(store).items.find((entry) => entry.nativeId === "a")!.id;
  const body = item(store, id);
  store.setCoverage(session.id, { status: "complete" });
  const complete = page(store);
  expect(complete.changeCursor).not.toBe(first.changeCursor);
  expect(complete.coverage.statuses).toEqual({ complete: 1 });
  expect(page(store).changeCursor).toBe(complete.changeCursor);
  const previous = store.source(session.id)!;
  const bytes = Buffer.from(JSON.stringify(user("c", "rotated", 3000)) + "\n");
  const result = store.ingest({ session, source: {
    id: previous.id, path: previous.path, device: previous.device, inode: "replacement", modifiedMs: 2,
    size: bytes.length, from: 0, bytes, prefix: bytes.subarray(0, 256), checkpoint: new Uint8Array(),
    expected: { generation: previous.generation, offset: previous.offset },
  } });
  expect(result.change).toBe("rotation");
  expect(store.historyPage({ session: session.id, before: first.previousCursor! }, owner)).toMatchObject({ code: "stale-cursor", epoch: "2" });
  expect(store.historyItem({ session: session.id, item: id, bodyCursor: body.nextBodyCursor! }, owner)).toMatchObject({ code: "stale-cursor" });
  expect(page(store).items.map((entry) => entry.nativeId)).toEqual(["a", "b", "c"]);
});

test("huge escaped Unicode bodies round trip through bounded JSON frames without replacement or omitted bytes", () => {
  const store = open();
  const text = ('\u0001'.repeat(40) + '\0\n"\\🐚雪').repeat(2500);
  ingest(store, [user("huge", text)]);
  const summary = page(store).items[0]!;
  expect(summary.bodyBytes).toBe(Buffer.byteLength(text, "utf8"));
  expect(summary.preview.length).toBeLessThan(text.length);
  let cursor: string | undefined;
  let combined = "";
  let pages = 0;
  do {
    const result = item(store, summary.id, cursor);
    expect(result.encoding).toBe("text");
    combined += result.content; cursor = result.nextBodyCursor ?? undefined;
    expect(++pages).toBeLessThan(100);
  } while (cursor);
  expect(pages).toBeGreaterThan(2);
  expect(combined).toBe(text);
});

test("mixed visible text and structured content survive JSON body paging", () => {
  const store = open();
  const summary = "visible summary 🐚".repeat(8000);
  ingest(store, [{ type: "summary", uuid: "compact", summary, compactMetadata: { trigger: "auto", preTokens: 100 } }]);
  const id = page(store).items[0]!.id;
  let cursor: string | undefined;
  let body = "";
  do { const result = item(store, id, cursor); expect(result.encoding).toBe("json"); body += result.content; cursor = result.nextBodyCursor ?? undefined; } while (cursor);
  expect(JSON.parse(body)).toEqual({ text: summary, content: { trigger: "auto", preTokens: 100 } });
});

test("structured-only item bodies retain tool metadata and body cursors cannot cross items or APIs", () => {
  const store = open();
  ingest(store, [user("large", "read".repeat(20_000)), { type: "assistant", uuid: "call", message: {
    role: "assistant", content: [{ type: "tool_use", id: "tool-id", name: "Bash", input: { command: "echo fixture", access_token: "excluded credential" } }],
  } }]);
  const items = page(store).items;
  const tool = items.find((entry) => entry.kind === "tool_call")!;
  expect(tool.toolName).toBe("Bash");
  const body = item(store, tool.id);
  expect(body.encoding).toBe("json");
  expect(JSON.parse(body.content)).toEqual({ command: "echo fixture" });
  const cursor = item(store, items.find((entry) => entry.kind === "message")!.id).nextBodyCursor!;
  expect(store.historyItem({ session: session.id, item: tool.id, bodyCursor: cursor }, owner)).toMatchObject({ code: "invalid-cursor" });
  expect(store.historyPage({ session: session.id, before: cursor }, owner)).toMatchObject({ code: "invalid-cursor" });
});

test("Claude ancestry includes all UUID blocks, excludes siblings and refuses missing/cyclic/Codex ancestry", () => {
  const store = open();
  ingest(store, [user("root", "root"), { type: "assistant", uuid: "answer", parentUuid: "root", message: {
    role: "assistant", content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }],
  } }, user("branch-a", "a", 2000, "answer"), user("branch-b", "b", 3000, "root")]);
  const all = page(store);
  const tip = all.items.find((entry) => entry.preview === "a")!.id;
  const branch = page(store, { session: session.id, branch: tip });
  expect(branch.items.map((entry) => entry.preview).sort()).toEqual(["a", "part one\npart two", "root"]);
  expect(branch.coverage.branch).toBe("ancestry");
  const cursor = page(store, { session: session.id, branch: tip, limit: 1 }).previousCursor!;
  expect(store.historyPage({ session: session.id, before: cursor }, owner)).toMatchObject({ code: "invalid-cursor" });
  expect(store.historyPage({ session: session.id, branch: "missing" }, owner)).toMatchObject({ code: "branch-unavailable" });
  const body = item(store, tip);
  expect(body.encoding).toBe("text");
  const db = new Database(store.path);
  db.query("UPDATE items SET parent_native_id=native_id WHERE id=?").run(tip); db.close();
  expect(store.historyPage({ session: session.id, branch: tip }, owner)).toMatchObject({ code: "branch-unavailable" });
  ingest(store, [], { ...session, id: "codex", nativeId: "codex", provider: "codex" });
  expect(store.historyPage({ session: "codex", branch: tip }, owner)).toMatchObject({ code: "branch-unavailable" });
});

test("missing parents and ancestry beyond the metadata traversal budget are refused", () => {
  const store = open();
  const entries = Array.from({ length: 2050 }, (_, i) => user(`node-${i}`, `node ${i}`, i + 1, i ? `node-${i - 1}` : null));
  ingest(store, entries);
  const tip = page(store, { session: session.id, limit: 1 }).items[0]!.id;
  expect(store.historyPage({ session: session.id, branch: tip }, owner)).toMatchObject({ code: "branch-unavailable" });
  ingest(store, [user("orphan", "orphan", 5000, "not-indexed")], session, "orphan-source");
  const orphan = page(store, { session: session.id, limit: 1 }).items[0]!.id;
  expect(store.historyPage({ session: session.id, branch: orphan }, owner)).toMatchObject({ code: "branch-unavailable" });
});

test("metadata pages honor the actual byte budget and preserve every anchor", () => {
  const store = open();
  ingest(store, Array.from({ length: 100 }, (_, i) => user(`item-${i}`, "\u0001".repeat(240), 1000 + i)));
  const ids = new Set<string>();
  let before: string | undefined;
  do {
    const result = page(store, { session: session.id, limit: 100, ...(before ? { before } : {}) });
    expect(historyBytes(result)).toBeLessThanOrEqual(28 * 1024);
    expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }] }))).toBeLessThanOrEqual(64 * 1024);
    for (const entry of result.items) { expect(ids.has(entry.id)).toBeFalse(); ids.add(entry.id); }
    before = result.previousCursor ?? undefined;
  } while (before);
  expect(ids.size).toBe(100);
});

test("oversized indexed identities fail explicitly instead of returning unusable item references", () => {
  const store = open();
  ingest(store, [user("oversized".repeat(1000), "ordinary text")]);
  expect(store.historyPage({ session: session.id }, owner)).toMatchObject({ code: "response-too-large" });
});

test("migration upgrades existing projections, numeric selector order and immutable receipts", () => {
  const dir = mkdtempSync(join(tmpdir(), "conch-history-migration-"));
  directories.push(dir); mkdirSync(join(dir, "records"));
  const legacy = new Database(join(dir, "records", "history.sqlite"));
  legacy.exec(RECORD_MIGRATIONS[0]!); legacy.exec(RECORD_MIGRATIONS[1]!); legacy.exec("PRAGMA user_version=2");
  legacy.query("INSERT INTO sessions VALUES (?,?,?, ?,NULL,NULL,NULL,NULL)").run(session.id, owner, "claude", session.nativeId);
  for (let i = 0; i < 15; i++) legacy.query("INSERT INTO items VALUES (?, ?,NULL,?,NULL,'message','assistant',?,NULL,1000,?,1)")
    .run(`legacy-${i}`, session.id, `native-${i}`, `block ${i}`, `source:00000001:0000000000000000:${i}`);
  legacy.query("INSERT INTO receipts VALUES ('legacy-receipt',?,'legacy-action',NULL,NULL,NULL,'review','published',1,NULL)").run(session.id);
  legacy.close();
  const store = open(dir);
  expect(page(store).items.map((entry) => entry.preview)).toEqual(Array.from({ length: 15 }, (_, i) => `block ${i}`));
  expect(store.receipts("legacy-action")).toHaveLength(1);
  const db = new Database(store.path);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: RECORD_MIGRATIONS.length });
  expect(db.query("SELECT length(value) AS length FROM history_metadata WHERE key='cursor-key'").get()).toEqual({ length: 32 });
  expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='items_session_history_order'").get()).toBeTruthy();
  db.close();
});

test("one message is one item however many blocks it arrives in, and its call is addressable by its tool id", () => {
  const store = open();
  ingest(store, [
    user("prompt", "prompt", 1000),
    { type: "assistant", uuid: "answer", parentUuid: "prompt", timestamp: new Date(2000).toISOString(), message: {
      role: "assistant", content: [
        { type: "text", text: "first part" },
        { type: "text", text: "second part" },
        { type: "tool_use", id: "call_7", name: "Bash", input: { command: "echo fixture" } },
        { type: "text", text: "third part" },
      ],
    } },
  ]);
  const items = page(store).items;
  // The provider's message is the unit a reader sees; its blocks are not four messages.
  const messages = items.filter((entry) => entry.kind === "message" && entry.nativeId === "answer");
  expect(messages).toHaveLength(1);
  expect(item(store, messages[0]!.id).content).toBe("first part\nsecond part\nthird part");
  // A tool row on screen is keyed by its call id, which is not the message's UUID.
  const tool = items.find((entry) => entry.kind === "tool_call")!;
  expect(tool.toolId).toBe("call_7");
  expect(tool.toolName).toBe("Bash");
  expect(tool.nativeId).toBe("answer");
});

test("ancestry heals when a parent is indexed after its child, and a fork keeps its own", () => {
  const store = open();
  // The child is read first, from its own file: its parent is not in the index yet.
  ingest(store, [{ type: "assistant", uuid: "child", parentUuid: "parent", timestamp: new Date(3000).toISOString(),
    message: { role: "assistant", content: "child" } }], session, "b-source");
  const tip = page(store).items.find((entry) => entry.nativeId === "child")!.id;
  expect(store.historyPage({ session: session.id, branch: tip }, owner)).toMatchObject({ code: "branch-unavailable" });
  // The parent arrives later, from another file. Nothing re-reads the child's line.
  ingest(store, [user("parent", "parent", 1000)], session, "a-source");
  expect(page(store, { session: session.id, branch: tip }).items.map((entry) => entry.preview)).toEqual(["parent", "child"]);
  // A fork is the same provider UUIDs in a different session: its ancestry is its own.
  const fork = { ...session, id: "fork", nativeId: "fork-native" };
  ingest(store, [user("parent", "parent", 1000),
    { type: "assistant", uuid: "child", parentUuid: "parent", timestamp: new Date(3000).toISOString(),
      message: { role: "assistant", content: "child" } },
    user("after-fork", "after the fork", 4000, "child")], fork, "fork-source");
  const forked = page(store, { session: "fork" });
  const forkTip = forked.items.find((entry) => entry.nativeId === "after-fork")!.id;
  expect(forked.items.map((entry) => entry.id)).not.toContain(tip);
  expect(page(store, { session: "fork", branch: forkTip }).items.map((entry) => entry.preview))
    .toEqual(["parent", "child", "after the fork"]);
});
