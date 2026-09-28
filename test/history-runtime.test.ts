import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordsRuntime, type RecordsRuntimeClient } from "../src/records-runtime.ts";
import { historyOff, type HistoryPage, type HistoryPageRequest, type HistoryResponse } from "../src/history.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const page: HistoryPage = {
  kind: "history-page", session: "indexed", items: [], previousCursor: null, changeCursor: "changes", epoch: "1",
  coverage: { sources: 0, statuses: {}, replayRequired: false, malformedLines: 0, indexedBytes: 0, observedBytes: 0,
    branch: "all", order: "timestamp-source" },
};
function fixture(read: (request: HistoryPageRequest, owner: string) => Promise<HistoryResponse>) {
  const root = mkdtempSync(join(tmpdir(), "conch-history-runtime-"));
  let opens = 0;
  const client: RecordsRuntimeClient = {
    async startIngestion() {}, async prioritize() {}, async appendReceipt() { return true; },
    async putPromptCursor() {},
    historyPage: read, historyItem: async () => historyOff(), async close() {}, async terminate() {},
  };
  const runtime = new RecordsRuntime({ configDir: join(root, "config"), ownerDeviceId: "local-owner",
    claudeHome: join(root, "claude"), codexHome: join(root, "codex"), open: async () => { opens++; return client; } });
  cleanup.push(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, opens: () => opens };
}

test("history off returns off without opening or resolving a worker", async () => {
  const f = fixture(async () => { throw Error("must not read"); });
  expect(await f.runtime.historyPage({ session: "historical" })).toEqual(historyOff());
  expect(await f.runtime.historyItem({ session: "historical", item: "item" })).toEqual(historyOff());
  expect(f.opens()).toBe(0);
});

test("history reads forward only validated queries with the daemon's owner identity", async () => {
  const calls: unknown[] = [];
  const f = fixture(async (request, owner) => { calls.push({ request, owner }); return page; });
  await f.runtime.setEnabled(true);
  expect(await f.runtime.historyPage({ session: "historical", limit: 100 })).toEqual(page);
  expect(calls).toEqual([{ request: { session: "historical", limit: 100 }, owner: "local-owner" }]);
  expect(await f.runtime.historyPage({ session: "historical", limit: 101 })).toMatchObject({ kind: "history-error", code: "invalid-request" });
  expect(await f.runtime.historyPage({ session: "historical", ownerDeviceId: "remote" } as HistoryPageRequest))
    .toMatchObject({ kind: "history-error", code: "invalid-request" });
  expect(calls).toHaveLength(1);
});

test("history reads have bounded backpressure while a worker is occupied", async () => {
  let release!: (response: HistoryResponse) => void;
  const pending = new Promise<HistoryResponse>((resolve) => { release = resolve; });
  let calls = 0;
  const f = fixture(async () => { calls++; return pending; });
  await f.runtime.setEnabled(true);
  const reads = Array.from({ length: 8 }, (_, index) => f.runtime.historyPage({ session: `indexed-${index}` }));
  expect(await f.runtime.historyPage({ session: "indexed" })).toMatchObject({ kind: "history-error", code: "busy" });
  expect(calls).toBe(8);
  release(page);
  expect((await Promise.all(reads)).every((response) => response.kind === "history-page")).toBe(true);
  expect((await f.runtime.historyPage({ session: "indexed" })).kind).toBe("history-page");
});

test("a read asked again while the same read is in the worker joins it instead of queueing another", async () => {
  // The worker cannot drop a read it has started, and an app that gave up after 5 s asks again.
  // A slow read used to be queued once more per retry until the worker did nothing else.
  let release!: (response: HistoryResponse) => void;
  let pending = new Promise<HistoryResponse>((resolve) => { release = resolve; });
  const calls: HistoryPageRequest[] = [];
  const f = fixture(async (request) => { calls.push(request); return pending; });
  await f.runtime.setEnabled(true);
  const tipped = { session: "indexed", branch: "tip", limit: 50 };
  const reads = Array.from({ length: 12 }, () => f.runtime.historyPage({ ...tipped }));
  const other = [f.runtime.historyPage({ ...tipped, branch: "other-tip" }), f.runtime.historyPage({ session: "indexed", limit: 50 }),
    f.runtime.historyPage({ ...tipped, session: "another" })];
  const body = [f.runtime.historyItem({ session: "indexed", item: "a" }), f.runtime.historyItem({ session: "indexed", item: "a" })];
  expect(calls).toEqual([tipped, { ...tipped, branch: "other-tip" }, { session: "indexed", limit: 50 }, { ...tipped, session: "another" }]);
  release(page);
  for (const response of await Promise.all([...reads, ...other])) expect(response).toEqual(page);
  expect(await Promise.all(body)).toEqual([historyOff(), historyOff()]);
  // Joined only while running: the next ask after the answer is a fresh read.
  pending = new Promise<HistoryResponse>((resolve) => { release = resolve; });
  const again = f.runtime.historyPage({ ...tipped });
  expect(calls).toHaveLength(5);
  release(page);
  expect(await again).toEqual(page);
});

test("a read completing after disable returns off and worker errors expose no raw details", async () => {
  let release!: (response: HistoryResponse) => void;
  const pending = new Promise<HistoryResponse>((resolve) => { release = resolve; });
  const f = fixture(async () => pending);
  await f.runtime.setEnabled(true);
  const read = f.runtime.historyPage({ session: "indexed" });
  await f.runtime.setEnabled(false);
  release(page);
  expect(await read).toEqual(historyOff());
  const failed = fixture(async () => { throw Error("PRIVATE_TRANSCRIPT_PATH"); });
  await failed.runtime.setEnabled(true);
  const response = await failed.runtime.historyPage({ session: "indexed" });
  expect(response).toMatchObject({ kind: "history-error", code: "unavailable" });
  expect(JSON.stringify(response)).not.toContain("PRIVATE");
});

test("a read the daemon's shutdown catches is unavailable, never off: a restart is not records being off", async () => {
  // A deploy, `conch restart` and the app replacing a frozen daemon all close the runtime while
  // the apps are reading. Off is the one answer they take as final — the Mac dropped every page it
  // held and never asked again — so a read in flight, or one that arrives while closing, must say
  // the daemon is going away, which every reader retries against the next one.
  let release!: (response: HistoryResponse) => void;
  const pending = new Promise<HistoryResponse>((resolve) => { release = resolve; });
  const f = fixture(async () => pending);
  await f.runtime.setEnabled(true);
  const inFlight = f.runtime.historyPage({ session: "indexed" });
  const closing = f.runtime.close();
  const arriving = f.runtime.historyPage({ session: "indexed" });
  release(page);
  await closing;
  for (const response of [await inFlight, await arriving, await f.runtime.historyItem({ session: "indexed", item: "item" })]) {
    expect(response).toMatchObject({ kind: "history-error", code: "unavailable" });
    expect(response.kind).not.toBe("history-off");
  }

  // And a worker that dies under the shutdown says the same.
  let fail!: (error: Error) => void;
  const stopped = new Promise<HistoryResponse>((_, reject) => { fail = reject; });
  const dying = fixture(async () => stopped);
  await dying.runtime.setEnabled(true);
  const read = dying.runtime.historyPage({ session: "indexed" });
  const shutdown = dying.runtime.close();
  fail(Error("worker stopped"));
  await shutdown;
  expect(await read).toMatchObject({ kind: "history-error", code: "unavailable" });
});

test("oversized worker responses cannot escape through the daemon service", async () => {
  const f = fixture(async () => ({ ...page, changeCursor: "x".repeat(70_000) }));
  await f.runtime.setEnabled(true);
  expect(await f.runtime.historyPage({ session: "indexed" })).toMatchObject({ kind: "history-error", code: "response-too-large" });
});

test("the daemon refuses a well-formed response to the wrong history operation", async () => {
  const f = fixture(async () => ({ kind: "history-item", item: "item", content: "", nextBodyCursor: null, revision: 1, encoding: "text" }));
  await f.runtime.setEnabled(true);
  expect(await f.runtime.historyPage({ session: "indexed" })).toMatchObject({ kind: "history-error", code: "unavailable" });
});
