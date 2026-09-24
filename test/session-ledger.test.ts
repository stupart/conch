import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TurnEvent } from "../src/hook.ts";
import { MAX_REVIEWS_BYTES, SessionLedger } from "../src/session-ledger.ts";

type SessionCollection = Map<string, unknown> | Set<string>;

const KNOWN_COLLECTIONS = [
  "injectedAt",
  "pending",
  "sessionStates",
  "pausedSessionIds",
  "resumedSessionIds",
  "prioritizedSessionIds",
  "dismissedSessionIds",
  "sessionHeldTurns",
  "dismissedHeldTurns",
  "latestTurnBySession",
  "reportedMissingCodexPid",
];

const FORGET_EXEMPT_COLLECTIONS = new Set([
  "injectedAt",
]);

function event(sessionId: string, eventAt = 1_000): TurnEvent {
  return {
    type: "turn-end",
    sessionId,
    label: sessionId,
    announce: `${sessionId}: done`,
    eventAt,
  };
}

function collectionEntries(ledger: SessionLedger): Array<[string, SessionCollection]> {
  const entries = Object.entries(ledger)
    .filter((entry): entry is [string, SessionCollection] =>
      entry[1] instanceof Map || entry[1] instanceof Set
    );
  expect(entries.map(([name]) => name).sort()).toEqual([...KNOWN_COLLECTIONS].sort());
  return entries;
}

function valueFor(name: string, id: string, turn: TurnEvent): unknown {
  if (name === "injectedAt") return 123;
  if (name === "sessionStates") return { label: id, status: "waiting", at: 123 };
  return turn;
}

function seed(collection: SessionCollection, id: string, value: unknown): void {
  if (collection instanceof Map) collection.set(id, value);
  else collection.add(id);
}

describe("SessionLedger", () => {
  test("forget clears every cleanup-owned collection and event-order entry", () => {
    const ledger = new SessionLedger();
    const gone = event("gone", 2_000);
    const live = event("live", 2_000);

    for (const [name, collection] of collectionEntries(ledger)) {
      seed(collection, gone.sessionId, valueFor(name, gone.sessionId, gone));
      seed(collection, live.sessionId, valueFor(name, live.sessionId, live));
    }
    expect(ledger.eventOrder.accept(gone)).toBe(true);
    expect(ledger.eventOrder.accept(live)).toBe(true);

    ledger.forget(gone.sessionId);

    for (const [name, collection] of collectionEntries(ledger)) {
      expect(collection.has(live.sessionId)).toBe(true);
      expect(collection.has(gone.sessionId)).toBe(FORGET_EXEMPT_COLLECTIONS.has(name));
    }
    // A12: the roadmap's stated fix — the pid warning latch clears with the session.
    expect(ledger.reportedMissingCodexPid.has(gone.sessionId)).toBe(false);
    expect(ledger.eventOrder.isCurrent(gone)).toBe(false);
    expect(ledger.eventOrder.isCurrent(live)).toBe(true);
    expect(ledger.isKnown(gone.sessionId)).toBe(false);
    expect(ledger.isKnown(live.sessionId)).toBe(true);
  });

  test("forgetGone uses today's tracked-id set and then prunes event order", () => {
    const ledger = new SessionLedger();
    const gone = event("gone", 2_000);
    const live = event("live", 2_000);
    const orderOnly = event("order-only", 2_000);

    for (const [name, collection] of collectionEntries(ledger)) {
      seed(collection, live.sessionId, valueFor(name, live.sessionId, live));
      if (name !== "injectedAt") {
        seed(collection, gone.sessionId, valueFor(name, gone.sessionId, gone));
      }
    }
    ledger.injectedAt.set("injected-only", 456);
    ledger.resumedSessionIds.add("resumed-only");
    ledger.reportedMissingCodexPid.add("pid-only");
    expect(ledger.eventOrder.accept(gone)).toBe(true);
    expect(ledger.eventOrder.accept(live)).toBe(true);
    expect(ledger.eventOrder.accept(orderOnly)).toBe(true);

    ledger.forgetGone(new Set([live.sessionId]));

    for (const [name, collection] of collectionEntries(ledger)) {
      expect(collection.has(live.sessionId)).toBe(true);
      if (name !== "injectedAt") expect(collection.has(gone.sessionId)).toBe(false);
    }
    expect(ledger.injectedAt.has("injected-only")).toBe(true);
    // A11: a session living ONLY here used to be invisible to the prune, and
    // membership is checked before the pause gate — so a closed session
    // could keep speaking through manual mode. Pruned like everything else.
    expect(ledger.resumedSessionIds.has("resumed-only")).toBe(false);
    // A12: a Codex session that closed pid-less (or failed to close) lived ONLY
    // here for the daemon's lifetime, suppressing the warning on id reuse.
    expect(ledger.reportedMissingCodexPid.has("pid-only")).toBe(false);
    expect(ledger.eventOrder.isCurrent(gone)).toBe(false);
    expect(ledger.eventOrder.isCurrent(live)).toBe(true);
    expect(ledger.eventOrder.isCurrent(orderOnly)).toBe(false);
  });
});

describe("saved deliverables", () => {
  const withFile = (run: (path: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "conch-ledger-reviews-"));
    try {
      run(join(dir, "reviews.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const file = (ledger: SessionLedger, id: string, at: number, summary = `${id} ready`): void => {
    ledger.sessionStates.set(id, { label: id, status: "waiting", at, review: { summary, at, id: `${id}-rev` } });
  };
  const restored = (path: string): SessionLedger => {
    const ledger = new SessionLedger(path);
    ledger.restoreReviews();
    return ledger;
  };

  test("a session the ledger forgets takes its saved deliverable with it", () => withFile((path) => {
    const ledger = new SessionLedger(path);
    file(ledger, "live", 1_000);
    file(ledger, "gone", 2_000);
    ledger.saveReviews();
    expect([...restored(path).sessionStates.keys()].sort()).toEqual(["gone", "live"]);

    ledger.forgetGone(new Set(["live"]));
    const after = restored(path);
    expect([...after.sessionStates.keys()]).toEqual(["live"]);
    // Plus the kind, artifact and version a restore derives (deliverables.test.ts pins those).
    expect(after.sessionStates.get("live")).toMatchObject({
      label: "live", status: "waiting", at: 0,
      review: { summary: "live ready", at: 1_000, id: "live-rev" },
      reviews: [{ summary: "live ready", at: 1_000, id: "live-rev" }],
    });
  }));

  test("the file is capped, keeping the newest deliverables", () => withFile((path) => {
    const ledger = new SessionLedger(path);
    const big = "x".repeat(40_000);
    for (let i = 0; i < 10; i++) file(ledger, `s${i}`, 1_000 + i, big);
    ledger.saveReviews();
    expect(statSync(path).size).toBeLessThanOrEqual(MAX_REVIEWS_BYTES);
    const kept = [...restored(path).sessionStates.keys()].sort();
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(10);
    // Whatever made the cut is newer than everything that did not.
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, i) => `s${10 - kept.length + i}`).sort());
  }));

  test("a review's scene is saved and restored with it, and one this conch can't read is dropped", () => withFile((path) => {
    const ledger = new SessionLedger(path);
    const scene = { v: 1 as const, target: { kind: "terminal" as const }, inspect: "the build log" };
    ledger.sessionStates.set("a", { label: "a", status: "waiting", at: 1_000, review: { summary: "a ready", scene, at: 1_000, id: "a-rev" } });
    ledger.saveReviews();
    expect(restored(path).sessionStates.get("a")?.review).toMatchObject({ summary: "a ready", scene, at: 1_000, id: "a-rev" });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    saved.a.review.scene = { v: 9 };
    saved.a.reviews[0].scene = { v: 9 };
    writeFileSync(path, JSON.stringify(saved));
    expect(restored(path).sessionStates.get("a")?.review).toMatchObject({ summary: "a ready", at: 1_000, id: "a-rev" });
    expect(restored(path).sessionStates.get("a")?.review?.scene).toBeUndefined();
  }));

  test("a malformed entry is skipped and a live latch is never overwritten", () => withFile((path) => {
    const ledger = new SessionLedger(path);
    file(ledger, "a", 1_000);
    file(ledger, "b", 2_000);
    ledger.saveReviews();
    const saved = JSON.parse(readFileSync(path, "utf8"));
    saved.b.review.at = "yesterday";
    saved.b.reviews[0].at = "yesterday";
    writeFileSync(path, JSON.stringify(saved));
    const fresh = new SessionLedger(path);
    fresh.sessionStates.set("a", { label: "a", status: "working", at: 5_000 });
    fresh.restoreReviews();
    expect(fresh.sessionStates.get("a")).toEqual({ label: "a", status: "working", at: 5_000 });
    expect(fresh.sessionStates.has("b")).toBe(false);
  }));

  test("every deliverable a session holds survives the restart, newest last", () => withFile((path) => {
    const ledger = new SessionLedger(path);
    const held = [
      { summary: "first", at: 1_000, id: "a-1" },
      { summary: "second", at: 2_000, id: "a-2" },
      { summary: "third", at: 3_000, id: "a-3" },
    ];
    ledger.sessionStates.set("a", { label: "a", status: "waiting", at: 3_000, review: held[2]!, reviews: held });
    ledger.saveReviews();

    const after = restored(path).sessionStates.get("a");
    expect(after?.reviews).toMatchObject(held);
    // Everything that shows ONE deliverable still gets the newest.
    expect(after?.review).toMatchObject(held[2]!);
  }));

  test("a deliverable that was looked at stays looked at across a restart", () => withFile((path) => {
    const ledger = new SessionLedger(path);
    const seen = { summary: "seen", at: 1_000, id: "s-1", viewedAt: 1_500 };
    const unseen = { summary: "unseen", at: 2_000, id: "s-2" };
    ledger.sessionStates.set("a", { label: "a", status: "waiting", at: 2_000, review: unseen, reviews: [seen, unseen] });
    ledger.saveReviews();

    const after = restored(path).sessionStates.get("a");
    // Without this the relaunch marks everything unread, which is the whole bug.
    expect(after?.reviews?.[0]?.viewedAt).toBe(1_500);
    expect(after?.reviews?.[1]?.viewedAt).toBeUndefined();
  }));

  test("a file written before a session could hold more than one restores as the single deliverable it was", () => withFile((path) => {
    writeFileSync(path, JSON.stringify({
      a: { label: "a", review: { summary: "a ready", at: 1_000, id: "a-rev" } },
    }));
    const after = restored(path).sessionStates.get("a");
    expect(after?.review).toMatchObject({ summary: "a ready", at: 1_000, id: "a-rev" });
    expect(after?.reviews).toMatchObject([{ summary: "a ready", at: 1_000, id: "a-rev" }]);
  }));

  test("a ledger that moved home reads the old file until it has written the new one", () => withFile((path) => {
    const legacy = join(dirname(path), "legacy.json");
    const before = new SessionLedger(legacy);
    file(before, "a", 1_000);
    before.saveReviews();

    const moved = new SessionLedger(path, legacy);
    moved.restoreReviews();
    expect(moved.sessionStates.get("a")?.review).toMatchObject({ summary: "a ready", at: 1_000, id: "a-rev" });

    // Once home exists it is the truth, whatever the old file still says.
    moved.saveReviews();
    file(before, "b", 2_000);
    before.saveReviews();
    const later = new SessionLedger(path, legacy);
    later.restoreReviews();
    expect([...later.sessionStates.keys()]).toEqual(["a"]);
  }));

  test("the daemon restores from conch's config dir, reading /tmp once, and the suite redirects it", () => {
    const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
    const daemon = read("src/daemon.ts");
    const constructed = daemon.indexOf("const ledger = new SessionLedger(REVIEWS_FILE, LEGACY_REVIEWS_FILE);");
    const restoredAt = daemon.indexOf("ledger.restoreReviews();");
    expect(constructed).toBeGreaterThan(-1);
    expect(restoredAt).toBeGreaterThan(constructed);
    const status = read("src/status.ts");
    expect(status).toContain(
      'join(process.env.CONCH_CONFIG_DIR ?? join(conchHome(), ".config", "conch"), "reviews.json")',
    );
    expect(status).toContain('export const LEGACY_REVIEWS_FILE = "/tmp/conch-reviews.json";');
    expect(read("test/preload.ts")).toContain('process.env.CONCH_REVIEWS_FILE = join(process.env.CONCH_LOG_FILE, "..", "reviews.json");');
    expect(process.env.CONCH_REVIEWS_FILE).not.toBe("/tmp/conch-reviews.json");
  });
});
