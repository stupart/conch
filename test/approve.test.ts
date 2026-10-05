import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchSessionControlMessage, type SessionCommandDispatchOptions } from "../src/control-server.ts";
import {
  approveReview,
  buildPanelModel,
  buildPublishedState,
  capReviews,
  dashboardRowsForModel,
  MAX_SESSION_REVIEWS,
  reviewReady,
  UNAPPROVE_WINDOW_MS,
  unapproveReview,
  type SessionReview,
} from "../src/panel.ts";
import { isMacAppOnlyRequest } from "../src/phone-bridge.ts";
import type { SessionActionsController } from "../src/session-actions-overlay.ts";
import { SessionLedger } from "../src/session-ledger.ts";
import { theaterStatusHeader } from "../src/status.ts";

/**
 * Approving a published result (2026-10-05, Tyler's decision): it is done, so it leaves the review queue on every
 * surface; it earns one piece of sea glass. Idempotent; undoable within 10 s and not after; on the record, so it
 * outlives a restart. Since later that day only a result whose agent asked can be approved, and approving tells the
 * agent (test/approve-when-asked.test.ts): these deliverables asked, unless a test says otherwise.
 */

const held = (id: string, at: number, extra: Partial<SessionReview> = {}): SessionReview => ({
  summary: `deliverable ${id}`,
  link: `https://example.test/${id}`,
  at,
  id,
  asksApproval: true,
  ...extra,
});

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function scratch<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "conch-approve-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function modelWith(reviews: SessionReview[], status: "waiting" | "working" | "needs" = "waiting") {
  return buildPanelModel({
    sessions: [{ sessionId: "s", name: "Landing page hero", backend: "claude" }],
    sessionStates: new Map([["s", { label: "Landing page hero", status, at: 10_000, review: reviews.at(-1), reviews }]]),
    pausedSessionIds: new Set(),
    live: { state: "idle", label: "", partial: "" },
    mode: { muted: false, paused: false, holding: 0 },
    activeSessionId: null,
    navSelectedId: null,
  });
}

describe("the rules: approveReview and unapproveReview", () => {
  test("approving stamps approvedAt, and viewedAt when nobody had looked; it never restamps either", () => {
    const filed = [held("a", 1_000), held("b", 2_000, { viewedAt: 3_000 })];
    const once = approveReview(filed, "a", 5_000)!;
    expect(once[0]).toMatchObject({ id: "a", approvedAt: 5_000, viewedAt: 5_000 });
    // Looked at earlier: that look stands.
    expect(approveReview(filed, "b", 5_000)![1]).toMatchObject({ id: "b", approvedAt: 5_000, viewedAt: 3_000 });
    // Idempotent: approved already, nothing changes (so nothing is saved or earned).
    expect(approveReview(once, "a", 9_000)).toBeUndefined();
    // An identity this session doesn't hold changes nothing, rather than whatever is nearest.
    expect(approveReview(filed, "nope", 5_000)).toBeUndefined();
    expect(approveReview(undefined, "a", 5_000)).toBeUndefined();
    // The input is never touched.
    expect(filed[0]!.approvedAt).toBeUndefined();
  });

  test("taking it back: within 10 s approvedAt goes and viewedAt stays; past 10 s it is refused in words", () => {
    const approved = approveReview([held("a", 1_000)], "a", 5_000)!;
    const undone = unapproveReview(approved, "a", 5_000 + UNAPPROVE_WINDOW_MS);
    expect(UNAPPROVE_WINDOW_MS).toBe(10_000);
    expect(undone.ok).toBe(true);
    if (!undone.ok) throw new Error("refused");
    expect(undone.held[0]!.approvedAt).toBeUndefined();
    expect("approvedAt" in undone.held[0]!).toBe(false);
    expect(undone.held[0]!.viewedAt).toBe(5_000);

    const late = unapproveReview(approved, "a", 5_000 + UNAPPROVE_WINDOW_MS + 1);
    expect(late).toEqual({
      ok: false,
      why: "late",
      reason: "too late to take back: it was approved 10 s ago, and an approval can only be undone within 10 s",
    });
    expect(unapproveReview(approved, "a", 65_000)).toMatchObject({ ok: false, why: "late", reason: expect.stringContaining("approved 60 s ago") });
    expect(unapproveReview([held("a", 1_000)], "a", 5_000)).toMatchObject({ ok: false, why: "not-approved" });
    expect(unapproveReview(approved, "nope", 5_000)).toMatchObject({ ok: false, why: "missing" });
  });
});

describe("the ledger: persisted, counted, and the same after a restart", () => {
  test("approve earns one piece of sea glass, once; both survive a restored ledger", () => scratch((dir) => {
    const path = join(dir, "reviews.json");
    const ledger = new SessionLedger(path);
    ledger.restoreReviews();
    expect(ledger.seaGlass).toBe(0);
    const filed = [held("a", 1_000), held("b", 2_000)];
    ledger.sessionStates.set("s", { label: "Landing page hero", status: "waiting", at: 2_000, review: filed[1], reviews: filed });

    expect(ledger.approveDeliverable("s", "b", 5_000)).toEqual({ ok: true, changed: true });
    expect(ledger.seaGlass).toBe(1);
    // `review` is the newest, and it is the one approved: both say so.
    expect(ledger.sessionStates.get("s")!.review).toMatchObject({ id: "b", approvedAt: 5_000, viewedAt: 5_000 });
    expect(ledger.sessionStates.get("s")!.reviews![1]).toMatchObject({ id: "b", approvedAt: 5_000 });

    // Idempotent: approving it again earns nothing and writes nothing new.
    expect(ledger.approveDeliverable("s", "b", 6_000)).toEqual({ ok: true, changed: false });
    expect(ledger.seaGlass).toBe(1);
    expect(ledger.approveDeliverable("s", "a", 7_000)).toEqual({ ok: true, changed: true });
    expect(ledger.seaGlass).toBe(2);
    // One this session doesn't hold is refused, in words, and earns nothing.
    expect(ledger.approveDeliverable("s", "nope", 7_000)).toEqual({ ok: false, reason: '"Landing page hero" holds no deliverable with id nope' });
    expect(ledger.approveDeliverable("gone", "a", 7_000)).toEqual({ ok: false, reason: "that session holds no deliverable with id a" });
    expect(ledger.seaGlass).toBe(2);

    // On disk: the review's approvedAt in reviews.json, the lifetime count beside it.
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.s.reviews.map((one: SessionReview) => one.approvedAt)).toEqual([7_000, 5_000]);
    expect(saved.s.review.approvedAt).toBe(5_000);
    expect(ledger.seaGlassPath).toBe(join(dir, "sea-glass.json"));
    expect(JSON.parse(readFileSync(join(dir, "sea-glass.json"), "utf8"))).toEqual({ seaGlass: 2 });

    // A restart: the same approvals, the same count, and still out of the queue.
    const after = new SessionLedger(path);
    after.restoreReviews();
    expect(after.seaGlass).toBe(2);
    const restored = after.sessionStates.get("s")!;
    expect(restored.reviews!.map((one) => one.approvedAt)).toEqual([7_000, 5_000]);
    expect(restored.review!.approvedAt).toBe(5_000);
    expect(reviewReady({ status: "waiting", review: restored.review, reviews: restored.reviews })).toBe(false);
    // And it counts on from the saved count, not from zero.
    after.sessionStates.set("t", { label: "t", status: "waiting", at: 1, review: held("c", 1), reviews: [held("c", 1)] });
    expect(after.approveDeliverable("t", "c", 8_000)).toEqual({ ok: true, changed: true });
    expect(after.seaGlass).toBe(3);
  }));

  test("a ledger that approves before restoring counts on from what was saved", () => scratch((dir) => {
    const path = join(dir, "reviews.json");
    const first = new SessionLedger(path);
    first.sessionStates.set("s", { label: "s", status: "waiting", at: 1, review: held("a", 1), reviews: [held("a", 1)] });
    first.approveDeliverable("s", "a", 2_000);
    const second = new SessionLedger(path);
    second.sessionStates.set("s", { label: "s", status: "waiting", at: 1, review: held("b", 1), reviews: [held("b", 1)] });
    second.approveDeliverable("s", "b", 3_000);
    expect(second.seaGlass).toBe(2);
  }));

  test("undo within 10 s takes the piece back and keeps viewedAt; past 10 s it is refused and nothing changes", () => scratch((dir) => {
    const path = join(dir, "reviews.json");
    const ledger = new SessionLedger(path);
    ledger.restoreReviews();
    ledger.sessionStates.set("s", { label: "Hero", status: "waiting", at: 1, review: held("a", 1), reviews: [held("a", 1)] });

    expect(ledger.approveDeliverable("s", "a", 10_000)).toEqual({ ok: true, changed: true });
    expect(ledger.unapproveDeliverable("s", "a", 19_999)).toEqual({ ok: true, changed: true });
    expect(ledger.seaGlass).toBe(0);
    expect(ledger.sessionStates.get("s")!.review).toMatchObject({ id: "a", viewedAt: 10_000 });
    expect(ledger.sessionStates.get("s")!.review!.approvedAt).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "sea-glass.json"), "utf8"))).toEqual({ seaGlass: 0 });
    // Looked at, so still not ready; it is back in the deliverables, not approved.
    expect(JSON.parse(readFileSync(path, "utf8")).s.review.approvedAt).toBeUndefined();
    // A second ⌘Z: nothing to take back, harmlessly.
    expect(ledger.unapproveDeliverable("s", "a", 20_000)).toEqual({ ok: true, changed: false });
    expect(ledger.seaGlass).toBe(0);

    // Approved again, and taken back too late: refused, and the approval and its glass stand.
    expect(ledger.approveDeliverable("s", "a", 30_000)).toEqual({ ok: true, changed: true });
    const late = ledger.unapproveDeliverable("s", "a", 40_001);
    expect(late).toEqual({ ok: false, reason: "too late to take back: it was approved 10 s ago, and an approval can only be undone within 10 s" });
    expect(ledger.seaGlass).toBe(1);
    expect(ledger.sessionStates.get("s")!.review!.approvedAt).toBe(30_000);
    expect(ledger.unapproveDeliverable("s", "nope", 30_001)).toEqual({ ok: false, reason: '"Hero" holds no deliverable with id nope' });
  }));

  test("the count never goes below zero, and an unreadable count file is none", () => scratch((dir) => {
    const path = join(dir, "reviews.json");
    writeFileSync(join(dir, "sea-glass.json"), "not json");
    const ledger = new SessionLedger(path);
    ledger.restoreReviews();
    expect(ledger.seaGlass).toBe(0);
    ledger.sessionStates.set("s", { label: "s", status: "waiting", at: 1, review: held("a", 1, { approvedAt: 5_000 }), reviews: [held("a", 1, { approvedAt: 5_000 })] });
    expect(ledger.unapproveDeliverable("s", "a", 6_000)).toEqual({ ok: true, changed: true });
    expect(ledger.seaGlass).toBe(0);
  }));

  test("a ledger with nowhere to save keeps the count in memory and writes nothing", () => {
    const ledger = new SessionLedger();
    ledger.sessionStates.set("s", { label: "s", status: "waiting", at: 1, review: held("a", 1), reviews: [held("a", 1)] });
    expect(ledger.approveDeliverable("s", "a", 2_000)).toEqual({ ok: true, changed: true });
    expect(ledger.seaGlass).toBe(1);
    expect(ledger.seaGlassPath).toBeUndefined();
  });

  test("approvedAt survives the six-deliverable cap, in memory and through a restart", () => scratch((dir) => {
    const path = join(dir, "reviews.json");
    // Seven lone artifacts: the cap drops the oldest. The approved ones it keeps keep their approval.
    const seven = Array.from({ length: MAX_SESSION_REVIEWS + 1 }, (_, i) =>
      held(`r${i}`, 1_000 + i, i >= 2 ? { approvedAt: 9_000 + i, viewedAt: 9_000 + i } : {}));
    const capped = capReviews(seven);
    expect(capped).toHaveLength(MAX_SESSION_REVIEWS);
    expect(capped.map((one) => one.id)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
    expect(capped.filter((one) => one.approvedAt !== undefined).map((one) => one.id)).toEqual(["r2", "r3", "r4", "r5", "r6"]);

    // Saved over the cap (as an older daemon might have), restored under it: the approvals are still there.
    writeFileSync(path, JSON.stringify({ s: { label: "s", review: seven.at(-1), reviews: seven } }));
    const ledger = new SessionLedger(path);
    ledger.restoreReviews();
    const restored = ledger.sessionStates.get("s")!.reviews!;
    expect(restored).toHaveLength(MAX_SESSION_REVIEWS);
    expect(restored.map((one) => one.approvedAt)).toEqual([undefined, 9_002, 9_003, 9_004, 9_005, 9_006]);
    // A junk approvedAt is dropped, the review kept.
    writeFileSync(path, JSON.stringify({ s: { label: "s", review: held("x", 1, { approvedAt: "yes" as never }) } }));
    const junk = new SessionLedger(path);
    junk.restoreReviews();
    expect(junk.sessionStates.get("s")!.review).toMatchObject({ id: "x" });
    expect(junk.sessionStates.get("s")!.review!.approvedAt).toBeUndefined();
  }));

  test("sea glass outlives the session that earned it: its own file, not reviews.json", () => scratch((dir) => {
    const path = join(dir, "reviews.json");
    const ledger = new SessionLedger(path);
    ledger.restoreReviews();
    ledger.sessionStates.set("s", { label: "s", status: "waiting", at: 1, review: held("a", 1), reviews: [held("a", 1)] });
    ledger.approveDeliverable("s", "a", 2_000);
    ledger.forget("s");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
    expect(existsSync(join(dir, "sea-glass.json"))).toBe(true);
    const after = new SessionLedger(path);
    after.restoreReviews();
    expect(after.seaGlass).toBe(1);
  }));
});

describe("published: rows[].reviews[].approvedAt and a top-level seaGlass, under the names agreed with the lagoon", () => {
  test("approvedAt rides on each held review and on review; seaGlass is always there, 0 when none", () => {
    const filed = [held("a", 1_000, { viewedAt: 4_000, approvedAt: 4_000 }), held("b", 2_000)];
    const wire = buildPublishedState("device", modelWith(filed), new Map(), new Set(), 10_000, { seaGlass: 7 });
    expect(wire.seaGlass).toBe(7);
    expect(wire.rows[0]!.reviews!.map((one) => one.approvedAt)).toEqual([4_000, undefined]);
    expect("approvedAt" in wire.rows[0]!.reviews![1]!).toBe(false);
    expect(wire.rows[0]!.review!.approvedAt).toBeUndefined();
    const newestApproved = buildPublishedState("device", modelWith([held("b", 2_000, { approvedAt: 6_000, viewedAt: 6_000 })]), new Map(), new Set(), 10_000);
    expect(newestApproved.rows[0]!.review!.approvedAt).toBe(6_000);
    // Never absent: the lagoon's jar reads it as is.
    expect(newestApproved.seaGlass).toBe(0);
    expect(JSON.parse(JSON.stringify(newestApproved)).seaGlass).toBe(0);
  });
});

describe("ready and waiting leave approved work out", () => {
  test("reviewReady: approved is done, whether or not it was looked at", () => {
    expect(reviewReady({ status: "waiting", review: held("a", 1), reviews: [held("a", 1)] })).toBe(true);
    // Approved and never looked at (a record from elsewhere): still done.
    expect(reviewReady({ status: "waiting", review: held("a", 1, { approvedAt: 2 }), reviews: [held("a", 1, { approvedAt: 2 })] })).toBe(false);
    // One approved, another nobody looked at: still ready, for the other.
    expect(reviewReady({ status: "waiting", review: held("b", 2), reviews: [held("a", 1, { approvedAt: 3 }), held("b", 2)] })).toBe(true);
    // The one review of an older row shape.
    expect(reviewReady({ status: "needs", review: held("a", 1, { approvedAt: 3 }) })).toBe(false);
  });

  test("the terminal's 'to look at' count and its review glyph follow it, through the daemon's own model", () => {
    const unseen = modelWith([held("a", 1_000)]);
    const approved = modelWith(approveReview([held("a", 1_000)], "a", 9_000)!);
    expect(plain(theaterStatusHeader(unseen))).toContain("✓1 to look at");
    expect(plain(theaterStatusHeader(approved))).not.toContain("to look at");
    expect(plain(dashboardRowsForModel(unseen)[0]!)).toContain("needs review");
    expect(plain(dashboardRowsForModel(approved)[0]!)).not.toContain("needs review");
    // Still held: approved work stays reachable, it just isn't waiting.
    expect(approved.rows[0]!.reviews!.map((one) => one.id)).toEqual(["a"]);
  });
});

describe("the socket: review-approve and review-unapprove, checked like review-viewed", () => {
  const base: SessionActionsController = {
    voiceCandidates: () => [],
    effectiveVoice: () => "",
    previewVoice: () => {},
    setVoice: () => {},
    resetVoice: () => {},
    isPrioritized: () => false,
    setPrioritized: () => {},
    rename: () => {},
    dismiss: () => {},
    close: async () => {},
    restore: () => {},
  };

  /** The daemon's own wiring, around a real ledger: what the socket does is what the ledger does. */
  function withLedger(now: () => number) {
    const ledger = new SessionLedger();
    ledger.sessionStates.set("session-a", { label: "Alpha", status: "waiting", at: 1, review: held("r1", 1), reviews: [held("r1", 1)] });
    const options: SessionCommandDispatchOptions = {
      controller: {
        ...base,
        approveReview: (target, review) => ledger.approveDeliverable(target.sessionId, review, now()),
        unapproveReview: (target, review) => ledger.unapproveDeliverable(target.sessionId, review, now()),
      },
      pause: { open() {}, close() {} },
      targetForSessionId: (id) => id === "session-a" ? { sessionId: id, label: "Alpha" } : null,
    };
    const send = (command: string, review: unknown = "r1", sessionId = "session-a") =>
      dispatchSessionControlMessage({ kind: "session-command", sessionId, command, review }, options);
    return { ledger, send };
  }

  test("approve acks once with a change, then idempotently without; unapprove within 10 s, refused after", () => {
    let clock = 100_000;
    const { ledger, send } = withLedger(() => clock);
    expect(send("review-approve")).toEqual({ kind: "session-ack", sessionId: "session-a", command: "review-approve", label: "Alpha", changed: true });
    expect(send("review-approve")).toEqual({ kind: "session-ack", sessionId: "session-a", command: "review-approve", label: "Alpha", changed: false });
    expect(ledger.seaGlass).toBe(1);
    clock += 4_000;
    expect(send("review-unapprove")).toEqual({ kind: "session-ack", sessionId: "session-a", command: "review-unapprove", label: "Alpha", changed: true });
    expect(ledger.seaGlass).toBe(0);
    expect(send("review-unapprove")).toMatchObject({ kind: "session-ack", changed: false });
    expect(send("review-approve")).toMatchObject({ kind: "session-ack", changed: true });
    clock += UNAPPROVE_WINDOW_MS + 1_000;
    expect(send("review-unapprove")).toEqual({
      kind: "session-error",
      error: "not taken back: too late to take back: it was approved 11 s ago, and an approval can only be undone within 10 s",
    });
    expect(ledger.seaGlass).toBe(1);
    // Not held: refused in words, which the Mac shows.
    expect(send("review-approve", "somebody-elses")).toEqual({
      kind: "session-error",
      error: 'not approved: "Alpha" holds no deliverable with id somebody-elses',
    });
    // A session that isn't there: nothing changed, as review-viewed answers.
    expect(send("review-approve", "r1", "session-gone")).toMatchObject({ kind: "session-ack", changed: false });
  });

  test("junk is refused before anything is asked of the controller", () => {
    const asked: string[] = [];
    const options: SessionCommandDispatchOptions = {
      controller: {
        ...base,
        approveReview: (_, review) => { asked.push(review); return { ok: true, changed: true }; },
        unapproveReview: (_, review) => { asked.push(review); return { ok: true, changed: true }; },
      },
      pause: { open() {}, close() {} },
      targetForSessionId: (id) => ({ sessionId: id, label: "Alpha" }),
    };
    for (const command of ["review-approve", "review-unapprove"]) {
      for (const extra of [{}, { review: "" }, { review: 7 }, { review: "a\u0000b" }, { review: "x".repeat(513) }, { artifact: "art" }]) {
        expect(dispatchSessionControlMessage({ kind: "session-command", sessionId: "session-a", command, ...extra }, options))
          .toMatchObject({ kind: "session-error" });
      }
    }
    expect(asked).toEqual([]);
  });

  test("a controller without approving refuses rather than claiming an approval", () => {
    const options: SessionCommandDispatchOptions = {
      controller: base,
      pause: { open() {}, close() {} },
      targetForSessionId: (id) => ({ sessionId: id, label: "Alpha" }),
    };
    expect(dispatchSessionControlMessage({ kind: "session-command", sessionId: "session-a", command: "review-approve", review: "r1" }, options))
      .toEqual({ kind: "session-error", error: "not approved: approving is unavailable" });
  });

  test("the phone may send both, as it sends review-viewed: neither is the Mac app's alone", () => {
    for (const command of ["review-viewed", "review-approve", "review-unapprove"]) {
      const body = { kind: "session-command", sessionId: "session-a", command, review: "r1" };
      expect(isMacAppOnlyRequest(body)).toBe(false);
      expect(isMacAppOnlyRequest({ kind: "control-envelope", body })).toBe(false);
    }
  });
});
