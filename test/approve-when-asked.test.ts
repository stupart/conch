import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchSessionControlMessage, validateSocketTurnEvent, type SessionCommandDispatchOptions } from "../src/control-server.ts";
import { buildPanelModel, buildPublishedState, fileReview, UNAPPROVE_WINDOW_MS, type SessionReview } from "../src/panel.ts";
import {
  APPROVAL_LABEL_MAX,
  approvedInjectEvent,
  approvedMessage,
  checkApprovalRequest,
  HeldApprovalMessages,
  heldDeliverable,
  reviewApprovalActions,
  type ApprovalTimers,
} from "../src/review-approval.ts";
import type { SessionActionsController } from "../src/session-actions-overlay.ts";
import { SessionLedger } from "../src/session-ledger.ts";

/**
 * Approve only when the agent asks, and approving tells the agent (2026-10-05). Tyler, after using #502: "I don't
 * really get the point of the approve button... maybe we only show it if the AI sets some sort of flag in the review
 * that it's asking for me to approve some work?"
 *
 * - `review_to_front`'s `approval: {label?}` (test/mcp.test.ts) is filed as `asksApproval` and `approvalLabel`, and
 *   published under those names, agreed with the lagoon.
 * - Approve is refused for a result that didn't ask.
 * - Approving holds `Approved: <label>.` in the daemon for the 10 s undo window, then delivers it; an undo inside the
 *   window cancels it; a second approve sends nothing more; a restart inside the window drops it. The send itself, through
 *   the voice loop's delivery path, is test/voice-loop.test.ts's.
 */

const filed = (id: string, at: number, extra: Partial<SessionReview> = {}): SessionReview => ({
  summary: `deliverable ${id}`,
  link: `https://example.test/${id}`,
  at,
  id,
  ...extra,
});

/** A clock the held messages run on, moved by hand: no real 10 s in a test. */
class FakeClock implements ApprovalTimers {
  now = 1_000_000;
  #next = 1;
  readonly pending = new Map<number, { at: number; run: () => void }>();
  set(run: () => void, ms: number): unknown {
    const id = this.#next++;
    this.pending.set(id, { at: this.now + ms, run });
    return id;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.pending].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].run();
    }
    this.now = until;
  }
}

/** The daemon's wiring (daemon.ts), over a real ledger and held messages on a fake clock, delivering into a list. */
function daemonWith(reviews: SessionReview[], ledger = new SessionLedger()) {
  const clock = new FakeClock();
  const sent: Array<{ sessionId: string; text: string }> = [];
  const logs: string[] = [];
  if (reviews.length) {
    ledger.sessionStates.set("s", { label: "Release prep", status: "waiting", at: 1, review: reviews.at(-1), reviews });
  }
  const held = new HeldApprovalMessages({
    holdMs: UNAPPROVE_WINDOW_MS,
    timers: clock,
    deliver: (sessionId, text) => void sent.push({ sessionId, text }),
    stillApproved: (sessionId, review, approvedAt) => {
      const one = heldDeliverable(ledger.sessionStates.get(sessionId), review);
      return one === undefined || one.approvedAt === approvedAt;
    },
    log: (line) => void logs.push(line),
  });
  let changes = 0;
  const actions = reviewApprovalActions({ ledger, held, now: () => clock.now, log: (line) => void logs.push(line), changed: () => void changes++ });
  const target = { sessionId: "s", label: "Release prep" };
  return {
    clock, sent, logs, ledger, held,
    approve: (review = "pr") => actions.approve(target, review),
    unapprove: (review = "pr") => actions.unapprove(target, review),
    review: (review = "pr") => heldDeliverable(ledger.sessionStates.get("s"), review)!,
    changes: () => changes,
  };
}

describe("the request: checkApprovalRequest, in review_to_front, on the socket and where the daemon files it", () => {
  test("{} or {label}, the label trimmed and at most 40 characters", () => {
    expect(APPROVAL_LABEL_MAX).toBe(40);
    expect(checkApprovalRequest({})).toEqual({ ok: true, approval: {} });
    expect(checkApprovalRequest({ label: "Open the PR" })).toEqual({ ok: true, approval: { label: "Open the PR" } });
    expect(checkApprovalRequest({ label: "  Deploy \u0007" })).toEqual({ ok: true, approval: { label: "Deploy" } });
    expect(checkApprovalRequest({ label: "m".repeat(40) })).toEqual({ ok: true, approval: { label: "m".repeat(40) } });
    // 40 once trimmed: what counts is what is filed.
    expect(checkApprovalRequest({ label: ` ${"m".repeat(40)} ` })).toEqual({ ok: true, approval: { label: "m".repeat(40) } });
    for (const bad of [{ label: "m".repeat(41) }, { label: "" }, { label: "  " }, { label: 3 }, { label: null }, { why: "x" }, null, [], "Deploy", 1]) {
      expect(checkApprovalRequest(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  test("exact, for the socket and the filing: the label must arrive already clean", () => {
    expect(checkApprovalRequest({ label: "Merge" }, { exact: true }).ok).toBe(true);
    expect(checkApprovalRequest({}, { exact: true }).ok).toBe(true);
    expect(checkApprovalRequest({ label: " Merge" }, { exact: true }).ok).toBe(false);
    expect(checkApprovalRequest({ label: "Merge\n" }, { exact: true }).ok).toBe(false);
    expect(checkApprovalRequest({ label: "m".repeat(41) }, { exact: true }).ok).toBe(false);
  });

  test("the socket takes it on a publication only, and refuses one that isn't clean", () => {
    const event = (type: string, review: Record<string, unknown>) =>
      validateSocketTurnEvent({ type, sessionId: "s1", label: "alpha", announce: "ready", review: { summary: "pr", ...review } });
    expect(event("review-published", { approval: { label: "Open the PR" } })).toMatchObject({ ok: true });
    expect(event("review-published", { approval: {} })).toMatchObject({ ok: true });
    expect(event("review-published", {})).toMatchObject({ ok: true });
    expect(event("turn-end", { approval: {} })).toEqual({ ok: false, err: "review approval is only for review-published" });
    expect(event("review-published", { approval: { label: "m".repeat(41) } })).toMatchObject({ ok: false, err: expect.stringContaining("review approval.label must be 1 to 40") });
    expect(event("review-published", { approval: { label: " padded " } })).toMatchObject({ ok: false });
    expect(event("review-published", { approval: { label: "ok", colour: "red" } })).toEqual({ ok: false, err: "review approval takes only label, not colour" });
    expect(event("review-published", { approval: true })).toMatchObject({ ok: false });
  });

  test("filed as asksApproval and approvalLabel, and only when asked", () => {
    expect(fileReview("s", { summary: "pr", approval: { label: "Open the PR" } }, 5, undefined)).toMatchObject({ asksApproval: true, approvalLabel: "Open the PR" });
    const bare = fileReview("s", { summary: "pr", approval: {} }, 5, undefined);
    expect(bare.asksApproval).toBe(true);
    expect("approvalLabel" in bare).toBe(false);
    const plain = fileReview("s", { summary: "pr" }, 5, undefined);
    expect("asksApproval" in plain).toBe(false);
    expect("approvalLabel" in plain).toBe(false);
    // The request isn't part of what names the filing: the same publication, asked or not, is the same deliverable.
    expect(bare.id).toBe(plain.id);
  });
});

describe("published: rows[].reviews[].asksApproval and approvalLabel, the names agreed with the lagoon", () => {
  test("on each held review that asked, and on review; absent on the rest; approvedAt and seaGlass as #502 made them", () => {
    const reviews = [
      filed("a", 1_000),
      filed("b", 2_000, { asksApproval: true }),
      filed("c", 3_000, { asksApproval: true, approvalLabel: "Open the PR", approvedAt: 4_000, viewedAt: 4_000 }),
    ];
    const model = buildPanelModel({
      sessions: [{ sessionId: "s", name: "Release prep", backend: "claude" }],
      sessionStates: new Map([["s", { label: "Release prep", status: "waiting", at: 10_000, review: reviews.at(-1), reviews }]]),
      pausedSessionIds: new Set(),
      live: { state: "idle", label: "", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
    });
    const wire = JSON.parse(JSON.stringify(buildPublishedState("device", model, new Map(), new Set(), 10_000, { seaGlass: 2 })));
    const published = wire.rows[0].reviews as Array<Record<string, unknown>>;
    expect(published.map((one) => one.asksApproval)).toEqual([undefined, true, true]);
    expect(published.map((one) => one.approvalLabel)).toEqual([undefined, undefined, "Open the PR"]);
    expect("asksApproval" in published[0]!).toBe(false);
    expect(published[2]!.approvedAt).toBe(4_000);
    expect(wire.rows[0].review).toMatchObject({ asksApproval: true, approvalLabel: "Open the PR", approvedAt: 4_000 });
    expect(wire.seaGlass).toBe(2);
  });

  test("restored as saved: the request and its label outlive a restart; junk is dropped, never invented", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-approve-asked-"));
    try {
      const path = join(dir, "reviews.json");
      const ledger = new SessionLedger(path);
      const reviews = [filed("a", 1), filed("b", 2, { asksApproval: true }), filed("c", 3, { asksApproval: true, approvalLabel: "Deploy" })];
      ledger.sessionStates.set("s", { label: "s", status: "waiting", at: 1, review: reviews.at(-1), reviews });
      ledger.saveReviews();
      const saved = JSON.parse(readFileSync(path, "utf8")).s.reviews;
      expect(saved.map((one: SessionReview) => [one.asksApproval, one.approvalLabel])).toEqual([[undefined, undefined], [true, undefined], [true, "Deploy"]]);
      const after = new SessionLedger(path);
      after.restoreReviews();
      expect(after.sessionStates.get("s")!.reviews!.map((one) => [one.asksApproval, one.approvalLabel]))
        .toEqual([[undefined, undefined], [true, undefined], [true, "Deploy"]]);

      writeFileSync(path, JSON.stringify({ s: { label: "s", reviews: [
        filed("x", 1, { asksApproval: "yes" as never, approvalLabel: "Ship" }),
        filed("y", 2, { asksApproval: true, approvalLabel: "m".repeat(41) }),
        filed("z", 3, { approvalLabel: "No request" }),
      ] } }));
      const junk = new SessionLedger(path);
      junk.restoreReviews();
      expect(junk.sessionStates.get("s")!.reviews!.map((one) => [one.id, one.asksApproval, one.approvalLabel]))
        .toEqual([["x", undefined, undefined], ["y", true, undefined], ["z", undefined, undefined]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("approve only what asked", () => {
  test("a result that didn't ask is refused in words, earns nothing and holds nothing", () => {
    const d = daemonWith([filed("plain", 1)]);
    expect(d.approve("plain")).toEqual({ ok: false, reason: "that result didn't ask for your approval" });
    expect(d.ledger.seaGlass).toBe(0);
    expect(d.held.heldCount).toBe(0);
    expect(d.review("plain").approvedAt).toBeUndefined();
    d.clock.advance(60_000);
    expect(d.sent).toEqual([]);
  });

  test("so is the socket's review-approve, which the Mac's ✓, the phone and the lagoon all send", () => {
    const d = daemonWith([filed("plain", 1), filed("pr", 2, { asksApproval: true, approvalLabel: "Open the PR" })]);
    const base: SessionActionsController = {
      voiceCandidates: () => [], effectiveVoice: () => "", previewVoice: () => {}, setVoice: () => {}, resetVoice: () => {},
      isPrioritized: () => false, setPrioritized: () => {}, rename: () => {}, dismiss: () => {}, close: async () => {}, restore: () => {},
    };
    const options: SessionCommandDispatchOptions = {
      controller: { ...base, approveReview: (_, review) => d.approve(review), unapproveReview: (_, review) => d.unapprove(review) },
      pause: { open() {}, close() {} },
      targetForSessionId: (id) => id === "s" ? { sessionId: id, label: "Release prep" } : null,
    };
    const send = (command: string, review: string) => dispatchSessionControlMessage({ kind: "session-command", sessionId: "s", command, review }, options);
    expect(send("review-approve", "plain")).toEqual({ kind: "session-error", error: "not approved: that result didn't ask for your approval" });
    expect(send("review-approve", "pr")).toEqual({ kind: "session-ack", sessionId: "s", command: "review-approve", label: "Release prep", changed: true });
    expect(send("review-approve", "pr")).toMatchObject({ kind: "session-ack", changed: false });
    d.clock.advance(UNAPPROVE_WINDOW_MS);
    expect(d.sent).toEqual([{ sessionId: "s", text: "Approved: Open the PR." }]);
  });
});

describe("the message, held by the daemon for the undo window", () => {
  test("Approved: <label>., or the summary cut to 120 when there's no label", () => {
    expect(approvedMessage({ summary: "The PR is ready", approvalLabel: "Open the PR" })).toBe("Approved: Open the PR.");
    expect(approvedMessage({ summary: "The release notes for 2.4", approvalLabel: undefined })).toBe("Approved: The release notes for 2.4.");
    // No second full stop, and the same for a question or an exclamation.
    expect(approvedMessage({ summary: "Ready to merge.", approvalLabel: undefined })).toBe("Approved: Ready to merge.");
    expect(approvedMessage({ summary: "x", approvalLabel: "Ship it!" })).toBe("Approved: Ship it!");
    // Cut to 120, with an ellipsis where it was cut, and no full stop after it.
    const long = `${"word ".repeat(40)}end`;
    const cut = approvedMessage({ summary: long, approvalLabel: undefined });
    expect(cut.startsWith("Approved: word word")).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.slice("Approved: ".length).length).toBeLessThanOrEqual(120);
    expect(approvedMessage({ summary: "s".repeat(120), approvalLabel: undefined })).toBe(`Approved: ${"s".repeat(120)}.`);
  });

  test("sent once the 10 s are up, not before; approving earns the sea glass at once", () => {
    const d = daemonWith([filed("pr", 2, { asksApproval: true, approvalLabel: "Open the PR" })]);
    expect(d.approve()).toEqual({ ok: true, changed: true });
    expect(d.ledger.seaGlass).toBe(1);
    expect(d.review()).toMatchObject({ approvedAt: d.clock.now, viewedAt: d.clock.now });
    expect(d.held.isHeld("s", "pr")).toBe(true);
    d.clock.advance(UNAPPROVE_WINDOW_MS - 1);
    expect(d.sent).toEqual([]);
    d.clock.advance(1);
    expect(d.sent).toEqual([{ sessionId: "s", text: "Approved: Open the PR." }]);
    expect(d.held.isHeld("s", "pr")).toBe(false);
    expect(d.held.wasSent("s", "pr")).toBe(true);
    d.clock.advance(60_000);
    expect(d.sent).toHaveLength(1);
    expect(d.logs.some((line) => line.includes("its agent is told in 10 s"))).toBe(true);
  });

  test("an undo inside the window cancels it, takes the piece back and keeps viewedAt; after it, refused", () => {
    const d = daemonWith([filed("pr", 2, { asksApproval: true, approvalLabel: "Open the PR" })]);
    const approvedAt = d.clock.now;
    d.approve();
    d.clock.advance(4_000);
    expect(d.unapprove()).toEqual({ ok: true, changed: true });
    expect(d.ledger.seaGlass).toBe(0);
    expect(d.review().approvedAt).toBeUndefined();
    expect(d.review().viewedAt).toBe(approvedAt);
    expect(d.held.isHeld("s", "pr")).toBe(false);
    d.clock.advance(60_000);
    expect(d.sent).toEqual([]);
    expect(d.logs.at(-1)).toContain("its agent won't be told");
    // A second undo: nothing to take back, harmlessly.
    expect(d.unapprove()).toEqual({ ok: true, changed: false });
    expect(d.ledger.seaGlass).toBe(0);

    // Approved again: held again, and sent this time.
    d.approve();
    d.clock.advance(UNAPPROVE_WINDOW_MS);
    expect(d.sent).toEqual([{ sessionId: "s", text: "Approved: Open the PR." }]);
    // The agent has been told: an undo now is refused, even at the window's last instant, and the glass stays.
    expect(d.unapprove()).toEqual({ ok: false, reason: "too late to take back: conch has already told the agent it was approved" });
    expect(d.ledger.seaGlass).toBe(1);
    d.clock.advance(5_000);
    expect(d.unapprove()).toMatchObject({ ok: false });
  });

  test("a double approve (a double click, the Mac and the lagoon) sends it once and earns once", () => {
    const d = daemonWith([filed("pr", 2, { asksApproval: true })]);
    expect(d.approve()).toEqual({ ok: true, changed: true });
    d.clock.advance(3_000);
    expect(d.approve()).toEqual({ ok: true, changed: false });
    expect(d.held.heldCount).toBe(1);
    d.clock.advance(UNAPPROVE_WINDOW_MS);
    expect(d.sent).toEqual([{ sessionId: "s", text: "Approved: deliverable pr." }]);
    expect(d.approve()).toEqual({ ok: true, changed: false });
    d.clock.advance(UNAPPROVE_WINDOW_MS * 3);
    expect(d.sent).toHaveLength(1);
    expect(d.ledger.seaGlass).toBe(1);
  });

  test("sea glass: +1 per approval, back for an undo, never twice for one approval, and kept past the window", () => {
    const d = daemonWith([filed("a", 1, { asksApproval: true }), filed("b", 2, { asksApproval: true }), filed("c", 3)]);
    const glass = () => d.ledger.seaGlass;
    d.approve("a");
    expect(glass()).toBe(1);
    d.approve("a");
    expect(glass()).toBe(1);
    d.approve("b");
    expect(glass()).toBe(2);
    d.unapprove("b");
    expect(glass()).toBe(1);
    d.approve("c"); // didn't ask
    expect(glass()).toBe(1);
    d.approve("b");
    expect(glass()).toBe(2);
    d.clock.advance(UNAPPROVE_WINDOW_MS + 1);
    d.unapprove("a");
    d.unapprove("b");
    expect(glass()).toBe(2);
    expect(d.sent.map((one) => one.text)).toEqual(["Approved: deliverable a.", "Approved: deliverable b."]);
  });

  test("two results held at once each go to their own agent's session, once", () => {
    const d = daemonWith([filed("a", 1, { asksApproval: true, approvalLabel: "Merge" }), filed("b", 2, { asksApproval: true, approvalLabel: "Deploy" })]);
    d.approve("a");
    d.clock.advance(5_000);
    d.approve("b");
    d.clock.advance(5_000);
    expect(d.sent.map((one) => one.text)).toEqual(["Approved: Merge."]);
    d.clock.advance(5_000);
    expect(d.sent.map((one) => one.text)).toEqual(["Approved: Merge.", "Approved: Deploy."]);
  });

  test("an approval undone some other way than through the cancel isn't sent", () => {
    const d = daemonWith([filed("pr", 2, { asksApproval: true })]);
    d.approve();
    // The record no longer says approved at that time (as if undone by a path that missed the cancel).
    const state = d.ledger.sessionStates.get("s")!;
    const { approvedAt: _gone, ...rest } = state.reviews![0]!;
    d.ledger.sessionStates.set("s", { ...state, review: rest, reviews: [rest] });
    d.clock.advance(UNAPPROVE_WINDOW_MS);
    expect(d.sent).toEqual([]);
    expect(d.logs.at(-1)).toContain("no longer approved");
  });

  /**
   * The documented limit (review-approval.ts): the daemon holds it in memory, so a restart inside the window drops the
   * message. The approval and its sea glass are on the record and stay; nothing is sent later, and nothing is sent twice.
   * Closing the APP inside the window changes nothing: it never held the message.
   */
  test("a daemon restart inside the window drops the message; the approval stays, and the next daemon sends nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-approve-restart-"));
    try {
      const path = join(dir, "reviews.json");
      const first = new SessionLedger(path);
      first.restoreReviews();
      const before = daemonWith([filed("pr", 2, { asksApproval: true, approvalLabel: "Open the PR" })], first);
      before.approve();
      before.clock.advance(3_000);
      // The daemon stops (its shutdown drops what it holds, and says so).
      expect(before.held.dropAll("conch is closing")).toBe(1);
      expect(before.logs.at(-1)).toContain("dropped the approval message held for a deliverable of s: conch is closing");
      before.clock.advance(60_000);
      expect(before.sent).toEqual([]);

      const second = new SessionLedger(path);
      second.restoreReviews();
      const after = daemonWith([], second);
      after.clock.now = before.clock.now;
      expect(after.review()).toMatchObject({ asksApproval: true, approvalLabel: "Open the PR", approvedAt: expect.any(Number) });
      expect(second.seaGlass).toBe(1);
      after.clock.advance(60_000);
      expect(after.sent).toEqual([]);
      // Approving again changes nothing and sends nothing: it is approved.
      expect(after.approve()).toEqual({ ok: true, changed: false });
      after.clock.advance(60_000);
      expect(after.sent).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the send is the composer's inject, from the person, to the session's own terminal and transcript", () => {
    expect(approvedInjectEvent({ sessionId: "s", cwd: "/w", pid: 42, transcriptPath: "/t.jsonl" }, "Release prep", "Approved: Merge.")).toEqual({
      type: "inject", sessionId: "s", label: "Release prep", cwd: "/w", pid: 42, announce: "Approved: Merge.", transcriptPath: "/t.jsonl", origin: "user",
    });
    expect(approvedInjectEvent({ sessionId: "s" }, "Release prep", "Approved: Merge.")).toEqual({
      type: "inject", sessionId: "s", label: "Release prep", announce: "Approved: Merge.", origin: "user",
    });
  });
});
