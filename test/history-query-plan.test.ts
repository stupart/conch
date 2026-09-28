import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordStore } from "../src/records-store.ts";
import { RecordsHistory } from "../src/records-history.ts";
import type { RecordSession } from "../src/records-types.ts";
import type { HistoryPage } from "../src/history.ts";

/**
 * Every statement a history read runs, planned against a store shaped like a real one.
 *
 * The daemon sat at 100% CPU because two history statements read a whole session to answer
 * one row: the ancestry hop (once per ANCESTOR, 13 ms each on a 34,000-item session, 23 s a
 * page) and the page itself, which built every row's preview and body size and sorted them to
 * keep 51. Neither plan said SCAN — both were a SEARCH on items_session_created followed by a
 * temp B-tree sort — so the rule here is about what a read may cost, not one keyword:
 * items are reached by id, by native id, or walked in page order with nothing left to sort.
 *
 * The store has no sqlite_stat1, like every real one (nothing runs ANALYZE), so these are the
 * plans the live database gets.
 */

const owner = "plan-device";
const claude: RecordSession = { id: "claude-session", nativeId: "claude-native", ownerDeviceId: owner, provider: "claude" };
const codex: RecordSession = { id: "codex-session", nativeId: "codex-native", ownerDeviceId: owner, provider: "codex" };
const directories: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function ingest(store: RecordStore, target: RecordSession, entries: unknown[], sourceId = target.id) {
  const bytes = Buffer.from(entries.map((entry) => JSON.stringify(entry) + "\n").join(""));
  const previous = store.source(sourceId);
  const from = previous?.offset ?? 0;
  store.ingest({ session: target, source: {
    id: sourceId, path: `/fixture/${sourceId}.jsonl`, device: "1", inode: sourceId,
    modifiedMs: (previous?.modifiedMs ?? 0) + 1, size: bytes.length, from,
    bytes: bytes.subarray(from), prefix: bytes.subarray(0, 256), checkpoint: bytes.subarray(Math.max(0, from - 256), from),
    expected: previous ? { generation: previous.generation, offset: previous.offset } : null,
  } });
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** One conversation, `length` messages deep, each a child of the one before; tool calls on every tenth. */
function conversation(length: number, start = 0, parent: number | null = null) {
  return Array.from({ length }, (_, index) => {
    const n = start + index;
    const at = new Date(1_700_000_000_000 + n * 1000).toISOString();
    const parentUuid = index === 0 ? (parent === null ? null : uuid(parent)) : uuid(n - 1);
    return n % 2 === 0
      ? { type: "user", uuid: uuid(n), parentUuid, timestamp: at, message: { role: "user", content: `question ${n} `.repeat(20) } }
      : { type: "assistant", uuid: uuid(n), parentUuid, timestamp: at, message: { role: "assistant", content: n % 10 === 1
        ? [{ type: "text", text: `answer ${n}` }, { type: "tool_use", id: `call-${n}`, name: "Read", input: { path: `/f/${n}` } }]
        : [{ type: "text", text: `answer ${n} `.repeat(40) }] } };
  });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "conch-history-plan-"));
  directories.push(dir);
  const store = new RecordStore({ configDir: dir });
  closers.push(() => store.close());
  // A session thousands of records deep with a sibling branch off its middle, another session
  // beside it, and a Codex session: the real store's shape at a fraction of its 330,000 items.
  ingest(store, claude, [...conversation(3000), ...conversation(200, 10_000, 1500)]);
  ingest(store, { ...claude, id: "neighbour", nativeId: "neighbour-native" }, conversation(1500, 20_000));
  ingest(store, codex, Array.from({ length: 400 }, (_, n) => ({ type: "response_item", timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    payload: { type: "message", role: n % 2 ? "assistant" : "user", content: [{ type: n % 2 ? "output_text" : "input_text", text: `codex ${n}` }] } })));
  return store;
}

/** A RecordsHistory over the store's file that remembers every statement it prepares. */
function watched(store: RecordStore) {
  const db = new Database(store.path);
  closers.push(() => db.close());
  const statements = new Map<string, number>();
  const spy = new Proxy(db, {
    get(target, property) {
      if (property === "query") return (sql: string) => {
        statements.set(sql, (statements.get(sql) ?? 0) + 1);
        return target.query(sql);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, statements, history: new RecordsHistory(spy as unknown as Database) };
}

/** Ancestry walks made: each prepares the hop statement once. */
const walked = (statements: Map<string, number>) => [...statements]
  .filter(([sql]) => sql.includes("INDEXED BY items_session_native")).reduce((total, [, count]) => total + count, 0);

function read(history: RecordsHistory, request: Parameters<RecordsHistory["page"]>[0]): HistoryPage {
  const result = history.page(request, owner);
  if (result.kind !== "history-page") throw new Error(JSON.stringify(result));
  return result;
}

test("no history statement reads a whole session: items by id, by native id, or in page order unsorted", () => {
  const store = fixture();
  const { db, statements, history } = watched(store);
  const newest = read(history, { session: claude.id });
  // A proven branch three thousand ancestors deep, by the provider's id and by the record id.
  const branched = read(history, { session: claude.id, branch: uuid(2999), limit: 50 });
  expect(branched.coverage.branch).toBe("ancestry");
  const tip = branched.items.at(-1)!;
  expect(tip.nativeId).toBe(uuid(2999));
  const byId = read(history, { session: claude.id, branch: tip.id, limit: 50 });
  expect(byId.items).toEqual(branched.items);
  read(history, { session: claude.id, branch: tip.id, before: byId.previousCursor!, limit: 50 });
  read(history, { session: claude.id, before: newest.previousCursor! });
  read(history, { session: claude.id, branch: "not-indexed-yet" });
  read(history, { session: "neighbour-native" });
  read(history, { session: codex.id, branch: "anything" });
  const body = history.item({ session: claude.id, item: tip.id }, owner);
  expect(body.kind).toBe("history-item");

  const reads = [...statements.keys()].filter((sql) => /\bitems\b/.test(sql));
  // The ancestor hop, the tip by record id, the page, the page after a cursor (with and without
  // an ancestry), and a body's size and bytes: a statement lost from this list is not checked.
  expect(reads.length).toBeGreaterThanOrEqual(7);
  const pointLookup = /^SEARCH (items|i) USING (COVERING )?INDEX (sqlite_autoindex_items_1 \(id=\?\)|items_session_native \(session_id=\? AND native_id=\?\))/;
  for (const sql of statements.keys()) {
    const plan = (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((row) => row.detail);
    const where = `${plan.join(" | ")}\n  for: ${sql.replace(/\s+/g, " ").slice(0, 400)}`;
    for (const step of plan) {
      expect(step.startsWith("SCAN ") && step !== "SCAN CONSTANT ROW" ? where : "").toBe("");
    }
    const items = plan.filter((step) => /^(SEARCH|SCAN) (items|i)\b/.test(step));
    if (!items.length) continue;
    const walksInPageOrder = items.every((step) => step.includes("items_session_history_order"));
    const byIdentity = items.every((step) => pointLookup.test(step));
    expect(walksInPageOrder || byIdentity ? "" : where).toBe("");
    if (walksInPageOrder) {
      // Walked in the order it is returned, so LIMIT stops the walk: a sort would need all of it.
      expect(plan.some((step) => step.includes("TEMP B-TREE")) ? where : "").toBe("");
      // An older page seeks to its cursor rather than walking down from the newest row.
      if (sql.includes("(COALESCE(i.at,0),i.order_key,i.id)<")) {
        expect(items.every((step) => step.includes("(session_id=? AND <expr><?)")) ? "" : where).toBe("");
      }
    }
  }
});

test("a remembered ancestry is never served once the session has changed under the reader", () => {
  const store = fixture();
  const { history, statements } = watched(store);
  const walks = () => walked(statements);
  const tip = uuid(2999);
  const first = read(history, { session: claude.id, branch: tip, limit: 5 });
  expect(first.coverage.branch).toBe("ancestry");
  expect(walks()).toBe(1);
  // The same question against the same state — the next page, or an app asking again after
  // its read timed out — is answered from the walk already made.
  const again = read(history, { session: claude.id, branch: tip, before: first.previousCursor!, limit: 5 });
  expect(again.coverage.branch).toBe("ancestry");
  read(history, { session: claude.id, branch: tip, limit: 5 });
  expect(walks()).toBe(1);
  // Message 2999's ancestor 2500 is re-parented under the sibling branch — a rewritten line for
  // a message already indexed, which is a revision, which advances the session.
  ingest(store, claude, [conversation(1, 2500, 10_199)[0]], "claude-rewrite");
  // The traversal's fence is its own, so only the change sequence tells the walk it is stale.
  expect(history.page({ session: claude.id, branch: tip, before: first.previousCursor!, limit: 5 }, owner))
    .toMatchObject({ kind: "history-error", code: "stale-cursor" });
  const fresh = read(history, { session: claude.id, branch: tip, limit: 5 });
  expect(fresh.coverage.branch).toBe("ancestry");
  expect(fresh.changeCursor).not.toBe(first.changeCursor);
  expect(walks()).toBe(3);
});

test("the remembered walks are bounded: a tip asked again after forty others is walked again", () => {
  const store = fixture();
  const { history, statements } = watched(store);
  read(history, { session: claude.id, branch: uuid(2999), limit: 1 });
  read(history, { session: claude.id, branch: uuid(2999), limit: 1 });
  expect(walked(statements)).toBe(1);
  for (let n = 0; n < 40; n++) read(history, { session: claude.id, branch: uuid(100 + n), limit: 1 });
  expect(walked(statements)).toBe(41);
  read(history, { session: claude.id, branch: uuid(2999), limit: 1 });
  expect(walked(statements)).toBe(42);
});
