import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordStore } from "../src/records-store.ts";
import { RecordsIndexer } from "../src/records-indexer.ts";
import { recordKey } from "../src/records-types.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const message = (uuid: string, text = "Hello") => JSON.stringify({ type: "user", uuid, message: { role: "user", content: text } }) + "\n";
function fixture(overrides: Partial<ConstructorParameters<typeof RecordsIndexer>[1]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "conch-record-indexer-"));
  const claudeHome = join(root, "claude");
  const codexHome = join(root, "codex");
  const store = new RecordStore({ configDir: join(root, "config") });
  const indexer = new RecordsIndexer(store, { ownerDeviceId: "test-device", claudeHome, codexHome,
    batchBytes: 1024, batchLines: 2, maxRecordBytes: 8192, pollMs: 1, reconcileMs: 1, ...overrides });
  cleanups.push(async () => { await indexer.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const write = (nativeId: string, text: string) => {
    const path = join(claudeHome, "projects", "project", `${nativeId}.jsonl`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  return { root, claudeHome, codexHome, store, indexer, write };
}
async function until(indexer: RecordsIndexer, check: () => boolean, ticks = 200) {
  for (let tick = 0; tick < ticks && !check(); tick++) await indexer.tick();
  expect(check()).toBe(true);
}
function items(store: RecordStore) {
  const db = new Database(store.path, { readonly: true });
  try { return db.query("SELECT native_id,text FROM items ORDER BY native_id").all(); }
  finally { db.close(); }
}

test("construction is idle, selected hints beat backfill, and each tick bounds bytes and lines", async () => {
  const f = fixture();
  const old = f.write(id(1), Array.from({ length: 8 }, (_, n) => message(`old-${n}`)).join(""));
  const selected = f.write(id(2), Array.from({ length: 8 }, (_, n) => message(`selected-${n}`)).join(""));
  expect(f.store.counts().sources).toBe(0);
  f.indexer.prioritize({ selected: { provider: "claude", nativeId: id(2) }, live: [
    { provider: "claude", nativeId: id(1), path: old }, { provider: "claude", nativeId: id(2), path: selected },
  ] });
  await f.indexer.tick();
  expect(f.store.sourcePage({}).find((entry) => entry.session.nativeId === id(2))!.source.offset).toBeGreaterThan(0);
  expect(f.store.sourcePage({}).find((entry) => entry.session.nativeId === id(1))?.source.offset ?? 0).toBe(0);
  for (let tick = 0; tick < 20; tick++) {
    const before = f.indexer.status();
    await f.indexer.tick();
    const after = f.indexer.status();
    expect(after.bytesRead - before.bytesRead).toBeLessThanOrEqual(1024);
    expect(after.linesIndexed - before.linesIndexed).toBeLessThanOrEqual(2);
  }
  expect(f.store.counts().items).toBe(16);
});

test("large and partial UTF-8 lines span bounded reads without premature checkpoints", async () => {
  const f = fixture();
  const bytes = Buffer.from(message("large", "🐚".repeat(800)));
  const path = f.write(id(1), "");
  writeFileSync(path, bytes.subarray(0, bytes.length - 3));
  await until(f.indexer, () => f.indexer.status().bufferedBytes === bytes.length - 3);
  expect(f.store.counts().items).toBe(0);
  expect(f.store.sourcePage({})[0]!.source.offset).toBe(0);
  appendFileSync(path, bytes.subarray(bytes.length - 3));
  await Bun.sleep(2);
  await until(f.indexer, () => f.store.counts().items === 1);
  expect(f.store.sourcePage({})[0]!.source.offset).toBe(bytes.length);
});

test("an oversized record reports incomplete coverage without skipping bytes", async () => {
  const f = fixture({ maxRecordBytes: 2048 });
  f.write(id(1), message("huge", "x".repeat(3000)));
  await until(f.indexer, () => f.store.sourcePage({})[0]?.coverage.status === "oversized");
  expect(f.store.sourcePage({})[0]!.source.offset).toBe(0);
  expect(f.store.counts().items).toBe(0);
  expect(f.indexer.status().bufferedBytes).toBe(0);
});

test("rotation preserves the old physical source and ingests the replacement independently", async () => {
  const f = fixture();
  const path = f.write(id(1), message("old"));
  await until(f.indexer, () => f.store.counts().items === 1);
  const before = f.store.sourcePage({})[0]!.source;
  renameSync(path, path + ".1");
  writeFileSync(path, message("new"));
  await Bun.sleep(2);
  await until(f.indexer, () => f.store.counts().items === 2 && f.store.counts().sources === 2);
  await until(f.indexer, () => f.store.source(before.id)?.path === path + ".1");
  expect(f.store.source(before.id)?.inode).toBe(before.inode);
});

test("rewrite replays all session sources and preserves receipts", async () => {
  const f = fixture();
  const path = f.write(id(1), message("old-a"));
  writeFileSync(path + ".1", message("retained"));
  await until(f.indexer, () => f.store.counts().items === 2);
  const sessionId = f.store.sourcePage({})[0]!.session.id;
  f.store.appendReceipt({ id: "receipt", sessionId, actionId: "action", kind: "review", state: "published", observedAt: 1 });
  writeFileSync(path, message("new-a", "Changed content"));
  await Bun.sleep(2);
  await until(f.indexer, () => f.store.sourcePage({}).every((entry) => !entry.coverage.replayRequired)
    && f.store.counts().items === 2 && f.store.sourcePage({}).some((entry) => entry.source.generation > 1));
  expect(f.store.receipts("action")).toHaveLength(1);
});

test("a rewritten large first record invalidates immediately and completes across bounded reads", async () => {
  const f = fixture({ reconcileMs: 60_000 });
  const path = f.write(id(1), message("old"));
  await until(f.indexer, () => f.store.counts().items === 1);
  const before = f.store.sourcePage({})[0]!.source;
  const replacement = message("new", "new body ".repeat(600));
  writeFileSync(path, replacement);
  f.indexer.prioritize({ selected: { provider: "claude", nativeId: id(1) }, live: [{ provider: "claude", nativeId: id(1), path }] });
  await f.indexer.tick();
  expect(f.store.counts().items).toBe(0);
  expect(f.store.source(before.id)?.generation).toBe(before.generation + 1);
  expect(f.store.source(before.id)?.offset).toBe(0);
  for (let tick = 0; tick < 30 && f.store.counts().items === 0; tick++) {
    const read = f.indexer.status().bytesRead;
    await f.indexer.tick();
    expect(f.indexer.status().bytesRead - read).toBeLessThanOrEqual(1024);
  }
  expect(items(f.store)).toEqual([{ native_id: "new", text: "new body ".repeat(600) }]);
  expect(f.store.source(before.id)?.offset).toBe(Buffer.byteLength(replacement));
});

test("a partial rewrite clears every source projection and replays the retained file", async () => {
  const f = fixture({ reconcileMs: 60_000, pollMs: 60_000 });
  const path = f.write(id(1), message("old"));
  writeFileSync(path + ".1", message("retained"));
  await until(f.indexer, () => f.store.counts().items === 2);
  const before = f.store.sourcePage({}).find((entry) => entry.source.path === path)!;
  const replacement = message("new", "unfinished 🐚");
  writeFileSync(path, replacement.slice(0, -1));
  f.indexer.prioritize({ selected: { provider: "claude", nativeId: id(1) }, live: [{ provider: "claude", nativeId: id(1), path }] });
  await f.indexer.tick();
  expect(f.store.counts().items).toBe(0);
  expect(f.store.source(before.source.id)?.generation).toBe(before.source.generation + 1);
  expect(f.store.sourcePage({}).every((entry) => entry.coverage.replayRequired)).toBe(true);
  await until(f.indexer, () => f.store.counts().items === 1);
  expect(items(f.store)).toEqual([{ native_id: "retained", text: "Hello" }]);
  expect(f.store.source(before.source.id)?.offset).toBe(0);
  appendFileSync(path, "\n");
  f.indexer.prioritize({ selected: { provider: "claude", nativeId: id(1) }, live: [{ provider: "claude", nativeId: id(1), path }] });
  await until(f.indexer, () => f.store.counts().items === 2);
  expect(items(f.store)).toEqual([{ native_id: "new", text: "unfinished 🐚" }, { native_id: "retained", text: "Hello" }]);
  expect(f.store.sourcePage({}).every((entry) => !entry.coverage.replayRequired)).toBe(true);
});

test("rewriting a pending replacement fragment never splices the old bytes into the new record", async () => {
  const f = fixture({ reconcileMs: 60_000, pollMs: 60_000 });
  const path = f.write(id(1), message("committed"));
  await until(f.indexer, () => f.store.counts().items === 1);
  writeFileSync(path, message("discarded", "a".repeat(2400)));
  f.indexer.prioritize({ selected: { provider: "claude", nativeId: id(1) }, live: [{ provider: "claude", nativeId: id(1), path }] });
  await f.indexer.tick();
  expect(f.indexer.status().bufferedBytes).toBeGreaterThan(0);
  expect(f.store.counts().items).toBe(0);
  const replacement = message("final", "🐚".repeat(900));
  const fragment = Buffer.from(replacement).subarray(0, Buffer.byteLength(replacement) - 3);
  writeFileSync(path, fragment);
  await until(f.indexer, () => f.indexer.status().bufferedBytes === fragment.length);
  expect(f.store.counts().items).toBe(0);
  appendFileSync(path, Buffer.from(replacement).subarray(fragment.length));
  f.indexer.prioritize({ selected: { provider: "claude", nativeId: id(1) }, live: [{ provider: "claude", nativeId: id(1), path }] });
  await until(f.indexer, () => f.store.counts().items === 1);
  expect(items(f.store)).toEqual([{ native_id: "final", text: "🐚".repeat(900) }]);
  expect(f.store.sourcePage({})[0]!.source.malformedLines).toBe(0);
});

test("an oversized rewrite cannot leave the previous projection visible", async () => {
  const f = fixture({ maxRecordBytes: 2048, reconcileMs: 60_000 });
  const path = f.write(id(1), message("old"));
  await until(f.indexer, () => f.store.counts().items === 1);
  writeFileSync(path, message("huge", "x".repeat(3000)));
  f.indexer.prioritize({ selected: { provider: "claude", nativeId: id(1) }, live: [{ provider: "claude", nativeId: id(1), path }] });
  await until(f.indexer, () => f.store.sourcePage({})[0]?.coverage.status === "oversized");
  expect(f.store.counts().items).toBe(0);
  expect(f.store.sourcePage({})[0]!.coverage.replayRequired).toBe(true);
  expect(f.store.sourcePage({})[0]!.source.offset).toBe(0);
});

test("missing files remain covered and are indexed when they return", async () => {
  const f = fixture();
  const path = f.write(id(1), message("one"));
  await until(f.indexer, () => f.store.counts().items === 1);
  rmSync(path);
  await Bun.sleep(2);
  await until(f.indexer, () => f.store.sourcePage({})[0]?.coverage.status === "missing");
  expect(f.store.counts().items).toBe(1);
  f.write(id(1), message("one") + message("two"));
  await Bun.sleep(2);
  await until(f.indexer, () => f.store.counts().items === 2);
});

test("stop drains a coalesced tick and cancels automatic scheduling", async () => {
  const f = fixture();
  f.write(id(1), message("one"));
  const first = f.indexer.tick();
  expect(f.indexer.tick()).toBe(first);
  await first;
  f.indexer.start();
  await Bun.sleep(5);
  await f.indexer.stop();
  const ticks = f.indexer.status().ticks;
  await Bun.sleep(5);
  expect(f.indexer.status().ticks).toBe(ticks);
  expect(f.indexer.status().running).toBe(false);
});

test("large foreground and background records both finish without buffer displacement livelock", async () => {
  const f = fixture();
  f.write(id(1), message("background", "b".repeat(7000)));
  const selected = f.write(id(2), message("foreground", "f".repeat(7000)));
  f.indexer.prioritize({ selected: { provider: "claude", nativeId: id(2) }, live: [{ provider: "claude", nativeId: id(2), path: selected }] });
  await until(f.indexer, () => f.store.counts().items === 2);
  expect(f.indexer.status().bufferedBytes).toBe(0);
});

test("recovery refuses stored paths outside enabled roots without reading file bytes", async () => {
  const f = fixture();
  const path = join(f.root, `${id(1)}.jsonl`);
  writeFileSync(path, message("outside"));
  const stat = statSync(path);
  const session = { id: recordKey("test-device", "claude", id(1)), ownerDeviceId: "test-device", provider: "claude" as const, nativeId: id(1) };
  f.store.registerSource(session, { id: "outside", path, device: String(stat.dev), inode: String(stat.ino) });
  await until(f.indexer, () => f.store.sourcePage({})[0]?.coverage.error === "source-outside-roots");
  expect(f.indexer.status().bytesRead).toBe(0);
  expect(f.store.counts().items).toBe(0);
});

test("recovery refuses a parent directory replaced by a symlink", async () => {
  const f = fixture();
  const path = f.write(id(1), message("original"));
  await until(f.indexer, () => f.store.counts().items === 1);
  const project = join(path, "..");
  const moved = join(f.root, "moved");
  renameSync(project, moved);
  symlinkSync(moved, project);
  const before = f.indexer.status().bytesRead;
  await Bun.sleep(2);
  await until(f.indexer, () => f.store.sourcePage({})[0]?.coverage.error === "source-outside-roots");
  expect(f.indexer.status().bytesRead).toBe(before);
});

test("a Codex rollout larger than one batch is read to the end", async () => {
  // Read with Claude's parser version, every batch after the first planned a rewrite from byte 0.
  const f = fixture();
  const directory = join(f.codexHome, "sessions", "2026", "09", "16");
  mkdirSync(directory, { recursive: true });
  const said = (n: number) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `reply ${n} `.padEnd(200, "x") }] } }) + "\n";
  writeFileSync(join(directory, `rollout-2026-09-16-${id(1)}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: id(1) } }) + "\n" + Array.from({ length: 12 }, (_, n) => said(n)).join(""));
  await until(f.indexer, () => f.store.counts().items === 12);
  expect(f.store.sourcePage({})[0]!.coverage.error ?? null).toBeNull();
});

test("a line as long as Codex's compacted records (9-15 MB) is read, and so is what follows it", async () => {
  // At the old 8 MB default two of Tyler's rollouts stopped at such a line for good.
  const f = fixture({ maxRecordBytes: undefined, batchBytes: 1024 * 1024, batchLines: 256 });
  f.write(id(1), message("big", "x".repeat(12 * 1024 * 1024)) + message("after", "still read"));
  await until(f.indexer, () => f.store.counts().items === 2, 100);
  expect(f.store.sourcePage({})[0]!.coverage.status).toBe("complete");
});

test("a Codex metadata UUID mismatch is reported without attributing content to the filename", async () => {
  const f = fixture();
  const directory = join(f.codexHome, "sessions", "2026", "09", "16");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `rollout-2026-09-16-${id(1)}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: id(2) } }) + "\n");
  await until(f.indexer, () => f.store.sourcePage({})[0]?.coverage.error === "session-identity-mismatch");
  expect(f.store.sourcePage({})[0]!.source.offset).toBe(0);
  expect(f.store.counts().items).toBe(0);
});

test("a rename keeps the reader's cursor, and a real rename-and-replace advances the session epoch", async () => {
  const f = fixture({ reconcileMs: 1 });
  const path = f.write(id(1), message("first") + message("second"));
  await until(f.indexer, () => f.store.counts().items === 2);
  const sessionId = f.store.sourcePage({})[0]!.session.id;
  const read = () => {
    const result = f.store.historyPage({ session: sessionId, limit: 1 }, "test-device");
    if (result.kind !== "history-page") throw Error(JSON.stringify(result));
    return result;
  };
  const held = read();
  const source = f.store.sourcePage({})[0]!.source;

  // A rename is the same bytes under another name: nothing the reader holds became untrue.
  renameSync(path, `${path}.1`);
  await Bun.sleep(2);
  await until(f.indexer, () => f.store.source(source.id)?.path === `${path}.1`);
  expect(f.store.source(source.id)?.offset).toBe(source.offset);
  expect(read().epoch).toBe(held.epoch);
  expect(f.store.historyPage({ session: sessionId, before: held.previousCursor! }, "test-device"))
    .toMatchObject({ kind: "history-page" });

  // Rename-and-replace: the live path is a different file now, so a cursor into the old
  // one must not be able to prepend its items to the new transcript.
  writeFileSync(path, message("third", "replacement"));
  await Bun.sleep(2);
  await until(f.indexer, () => f.store.counts().items === 3);
  await until(f.indexer, () => read().epoch !== held.epoch);
  expect(f.store.historyPage({ session: sessionId, before: held.previousCursor! }, "test-device"))
    .toMatchObject({ code: "stale-cursor" });
  expect(items(f.store).map((row: any) => row.native_id).sort()).toEqual(["first", "second", "third"]);
});

test("a batch late in a long session holds the worker's loop briefly, not for a walk of the session", async () => {
  // 2026-09-25: each record's parent lookup walked every earlier item of its session, so
  // backfilling a 324 MB transcript held the record worker for up to a second per batch.
  const f = fixture({ batchBytes: 256 * 1024, batchLines: 256, maxRecordBytes: undefined });
  const lines = 20_000;
  f.write(id(1), Array.from({ length: lines }, (_, n) => JSON.stringify({
    type: n % 2 ? "assistant" : "user", uuid: `line-${n}`, ...(n ? { parentUuid: `line-${n - 1}` } : {}),
    message: { role: n % 2 ? "assistant" : "user", content: `message ${n}` },
  }) + "\n").join(""));
  let longest = 0;
  while (f.indexer.status().linesIndexed < lines && longest < 100) {
    const started = performance.now();
    await f.indexer.tick();
    longest = Math.max(longest, performance.now() - started);
  }
  expect(longest).toBeLessThan(100);
  expect(f.store.counts().items).toBe(lines);
});
