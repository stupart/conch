import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordStore } from "../src/records-store.ts";
import { RecordsIndexer } from "../src/records-indexer.ts";

// What the records worker commits when nothing has changed: nothing. Each poll of a live source and each source on
// every reconcile committed three times, each with an fsync, 2026-11-11.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const message = (uuid: string, text = "Hello") => JSON.stringify({ type: "user", uuid, message: { role: "user", content: text } }) + "\n";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "conch-record-commits-"));
  const claudeHome = join(root, "claude");
  const store = new RecordStore({ configDir: join(root, "config") });
  const indexer = new RecordsIndexer(store, { ownerDeviceId: "test-device", claudeHome, codexHome: join(root, "codex"), pollMs: 1, reconcileMs: 1 });
  // Another connection's view: `data_version` moves when anyone else commits.
  const reader = new Database(store.path, { readonly: true });
  cleanups.push(async () => { reader.close(); await indexer.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const write = (nativeId: string, text: string) => {
    const path = join(claudeHome, "projects", "project", `${nativeId}.jsonl`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  const version = () => (reader.query("PRAGMA data_version").get() as { data_version: number }).data_version;
  return { store, indexer, write, version };
}

async function ticks(indexer: RecordsIndexer, count: number) {
  for (let tick = 0; tick < count; tick++) {
    await indexer.tick();
    await Bun.sleep(1);
  }
}

test("a source read to its end, polled and reconciled again and again, is never written again", async () => {
  const f = fixture();
  const path = f.write(id(1), message("one") + message("two"));
  f.indexer.prioritize({ live: [{ provider: "claude", nativeId: id(1), path }] });
  await ticks(f.indexer, 20);
  expect(f.store.counts().items).toBe(2);
  expect(f.store.coverage(f.store.sourcePage({})[0]!.source.id)?.status).toBe("complete");
  const settled = f.version();
  // Polls, renders (each sends the hints again) and reconciles, with nothing new on disk.
  for (let round = 0; round < 5; round++) {
    f.indexer.prioritize({ live: [{ provider: "claude", nativeId: id(1), path }] });
    await ticks(f.indexer, 10);
  }
  expect(f.version()).toBe(settled);
  // And an append is read, once.
  appendFileSync(path, message("three"));
  await ticks(f.indexer, 20);
  expect(f.store.counts().items).toBe(3);
  expect(f.version()).not.toBe(settled);
});

test("a live source that is missing is marked so once, not once a poll", async () => {
  const f = fixture();
  const path = f.write(id(2), message("one"));
  f.indexer.prioritize({ live: [{ provider: "claude", nativeId: id(2), path }] });
  await ticks(f.indexer, 10);
  rmSync(path);
  await ticks(f.indexer, 20);
  expect(f.store.sourcePage({})[0]?.coverage.status).toBe("missing");
  const marked = f.version();
  await ticks(f.indexer, 20);
  expect(f.version()).toBe(marked);
});

test("a receipt commits with an fsync and leaves the store at NORMAL", () => {
  const f = fixture();
  const synchronous = () => ((f.store as unknown as { db: Database }).db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
  expect(synchronous()).toBe(1); // NORMAL
  expect(f.store.appendReceipt({ id: "r-1", sessionId: "s", actionId: "a", kind: "delivery", state: "accepted", observedAt: 1 })).toBe(true);
  expect(synchronous()).toBe(1);
  expect(() => f.store.appendReceipt({ id: "r-1", sessionId: "s", actionId: "a", kind: "delivery", state: "failed", observedAt: 1 })).toThrow();
  expect(synchronous()).toBe(1);
});

