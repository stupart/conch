import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishedConversation, readConversationTail } from "../src/conversation.ts";
import { RecordsIndexer } from "../src/records-indexer.ts";
import { RecordStore } from "../src/records-store.ts";
import type { HistoryPage } from "../src/history.ts";

/**
 * Two windows, one transcript, one record: each window's HISTORY is its own branch.
 *
 * `claude --resume <id>` in a second terminal keeps the id, so both windows write one
 * file and the record store indexes one session (A8, #170). The live pane already
 * picks each window's branch; recorded history did not, so the page prepended above
 * that pane could carry the other window's messages — the same bug one layer down.
 *
 * Nothing here is a string pin. A real transcript is written to a temp directory, read
 * by the real reader, indexed through the real indexer into real SQLite, and paged by
 * the real history API — the composition is the thing under test, because every piece
 * of it was already green while the join between them was wrong.
 */

const SESSION = "4eb30ede-6c1e-4f5a-9d2b-1f0c2a3b4c5d";
const BRIDGE_A = "01AVNxcSSv8WYQiPjYsXYH2L";
const BRIDGE_B = "01SfEX6bfwCGXtThk1JRNmsE";
const OWNER = "test-device";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (clock: string) => `2026-09-11T${clock}:00.000Z`;

/**
 * The preamble Claude Code 2.1.266 writes before every model call: the leaf this
 * window is about to extend, then the bridge id that says which window is extending
 * it. Lifted from the real records in #170.
 */
const preamble = (leafUuid: string, bridge: string) => [
  { type: "last-prompt", leafUuid, sessionId: SESSION },
  { type: "bridge-session", sessionId: SESSION, bridgeSessionId: `cse_${bridge}`, lastSequenceNum: 0 },
];
const said = (kind: "user" | "assistant", id: number, parent: number | null, text: string, clock: string) => ({
  type: kind, uuid: uuid(id), parentUuid: parent === null ? null : uuid(parent), sessionId: SESSION,
  timestamp: at(clock), version: "2.1.266",
  message: kind === "user" ? { role: "user", content: text } : { role: "assistant", content: [{ type: "text", text }] },
});
const lines = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry) + "\n").join("");

/** A shared prefix, then A's branch and B's branch forking from it. B writes last. */
const TRANSCRIPT = lines(
  ...preamble(uuid(1), BRIDGE_A), said("user", 1, null, "shared question", "10:00"),
  ...preamble(uuid(1), BRIDGE_A), said("assistant", 2, 1, "shared answer", "10:01"),
  ...preamble(uuid(2), BRIDGE_B), said("user", 3, 2, "B asks", "10:05"),
  ...preamble(uuid(3), BRIDGE_B), said("assistant", 4, 3, "B answer", "10:06"),
  ...preamble(uuid(2), BRIDGE_A), said("user", 5, 2, "A asks", "10:07"),
  ...preamble(uuid(5), BRIDGE_A), said("assistant", 6, 5, "A answer", "10:08"),
  ...preamble(uuid(4), BRIDGE_B), said("user", 7, 4, "B asks again", "10:20"),
  ...preamble(uuid(7), BRIDGE_B), said("assistant", 8, 7, "B latest", "10:21"),
);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function shared() {
  const root = mkdtempSync(join(tmpdir(), "conch-history-branch-"));
  const claudeHome = join(root, "claude");
  const path = join(claudeHome, "projects", "project", `${SESSION}.jsonl`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, TRANSCRIPT);
  const store = new RecordStore({ configDir: join(root, "config") });
  const indexer = new RecordsIndexer(store, { ownerDeviceId: OWNER, claudeHome, codexHome: join(root, "codex"),
    pollMs: 1, reconcileMs: 1 });
  indexer.prioritize({ live: [{ provider: "claude", nativeId: SESSION, path }] });
  cleanups.push(async () => { await indexer.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });

  const index = async (items: number) => {
    for (let tick = 0; tick < 200 && store.counts().items < items; tick++) await indexer.tick();
    expect(store.counts().items).toBe(items);
  };
  /**
   * What this window is showing, and the tip its reader would carry: the newest row
   * of its own pane. The apps undecorate that id with `HistorySnapshot.nativeId`;
   * the newest row here is a message, whose id is already the provider's own.
   */
  const window = async (bridge: string) => {
    const key = `${SESSION}#${bridge === BRIDGE_A ? 39889 : 21210}`;
    const conversation = await readConversationTail(path, key, "claude", { window: { bridgeSessionId: `session_${bridge}` } });
    const published = publishedConversation(conversation);
    return { texts: published.items.map((item) => item.text), tip: published.items.at(-1)!.id, shared: published.shared };
  };
  const page = (request: { branch?: string; before?: string; limit?: number }): HistoryPage => {
    const result = store.historyPage({ session: SESSION, ...request }, OWNER);
    if (result.kind !== "history-page") throw Error(`expected a page, got ${JSON.stringify(result)}`);
    return result;
  };
  return { path, store, indexer, index, window, page };
}

test("each window's recorded history is its own branch of the transcript they share", async () => {
  const fixture = shared();
  await fixture.index(8);

  const a = await fixture.window(BRIDGE_A);
  const b = await fixture.window(BRIDGE_B);
  // The live panes are already right, and neither is marked shared: these tips are
  // proven, not guessed.
  expect(a.texts).toEqual(["shared question", "shared answer", "A asks", "A answer"]);
  expect(b.texts).toEqual(["shared question", "shared answer", "B asks", "B answer", "B asks again", "B latest"]);
  expect([a.shared, b.shared]).toEqual([undefined, undefined]);

  // The defect: history without a branch is BOTH windows, and that is what was
  // prepended above a pane belonging to one of them.
  const both = fixture.page({});
  expect(both.items.map((item) => item.preview)).toEqual([
    "shared question", "shared answer", "B asks", "B answer", "A asks", "A answer", "B asks again", "B latest",
  ]);
  expect(both.coverage.branch).toBe("all");

  const mine = fixture.page({ branch: a.tip });
  expect(mine.items.map((item) => item.preview)).toEqual(["shared question", "shared answer", "A asks", "A answer"]);
  expect(mine.coverage.branch).toBe("ancestry");
  const theirs = fixture.page({ branch: b.tip });
  expect(theirs.items.map((item) => item.preview))
    .toEqual(["shared question", "shared answer", "B asks", "B answer", "B asks again", "B latest"]);
  // Neither window can see the other's work above its own conversation.
  expect(mine.items.map((item) => item.preview)).not.toContain("B latest");
  expect(theirs.items.map((item) => item.preview)).not.toContain("A answer");
});

test("a message arriving mid-scroll does not restart the reader or change what it is reading", async () => {
  const fixture = shared();
  await fixture.index(8);
  const a = await fixture.window(BRIDGE_A);

  // The reader is part-way back through its own branch.
  const first = fixture.page({ branch: a.tip, limit: 2 });
  expect(first.items.map((item) => item.preview)).toEqual(["A asks", "A answer"]);
  const before = first.previousCursor!;
  expect(before).toBeTruthy();

  // Both windows say something while that reader is scrolling.
  appendFileSync(fixture.path, lines(
    ...preamble(uuid(8), BRIDGE_B), said("user", 9, 8, "B interrupts", "10:30"),
    ...preamble(uuid(6), BRIDGE_A), said("user", 10, 6, "A carries on", "10:31"),
  ));
  await fixture.index(10);

  // The tip was captured once, so the ancestry is the same ancestry and the cursor
  // is still this traversal's. A restart here empties the transcript under the eye.
  const older = fixture.page({ branch: a.tip, before });
  expect(older.items.map((item) => item.preview)).toEqual(["shared question", "shared answer"]);
  expect(older.coverage.branch).toBe("ancestry");
  expect(older.epoch).toBe(first.epoch);
  // And a fresh read with the same tip still refuses the other window's new message.
  const fresh = fixture.page({ branch: a.tip });
  expect(fresh.items.map((item) => item.preview)).not.toContain("B interrupts");
});

test("a tip the record has not indexed yet reads every branch, and says that is what it did", async () => {
  const fixture = shared();
  await fixture.index(8);
  // Written, not yet read: the window's newest row exists only in the file. The record
  // always runs a little behind the pane, so this is the ordinary case, not the odd one.
  appendFileSync(fixture.path, lines(...preamble(uuid(6), BRIDGE_A), said("user", 11, 6, "A says more", "10:40")));
  const unproven = fixture.page({ branch: uuid(11), limit: 2 });

  // Not an error — the history a reader had stays readable — and not a claim that
  // this is one window's branch either.
  expect(unproven.items.map((item) => item.preview)).toEqual(["B asks again", "B latest"]);
  expect(unproven.coverage.branch).toBe("all");

  // And when the index catches up MID-SCROLL, the traversal already under way does not
  // change what it is reading. The ancestry belongs to the fence this cursor was opened
  // at, so the page after it is still a page — not a stale cursor, which is a reader
  // emptied and started again under someone who is scrolling it.
  await fixture.index(9);
  const older = fixture.page({ branch: uuid(11), before: unproven.previousCursor!, limit: 2 });
  expect(older.items.map((item) => item.preview)).toEqual(["A asks", "A answer"]);
  expect(older.coverage.branch).toBe("all");
  // A traversal started now proves the tip, and reads one window's branch.
  expect(fixture.page({ branch: uuid(11) }).coverage.branch).toBe("ancestry");
});
