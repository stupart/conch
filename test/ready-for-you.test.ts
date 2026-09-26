import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPanelModel,
  buildPublishedState,
  dashboardRowsForModel,
  markReviewViewed,
  reviewReady,
  type PanelRowModel,
  type SessionReview,
} from "../src/panel.ts";
import { theaterStatusHeader } from "../src/status.ts";

/**
 * Ready for you means a deliverable is held, the session isn't working, AND nobody has looked at it yet.
 *
 * It was held-and-not-working alone, so looking changed nothing: the Mac's menu bar mark and Ready pill stayed green
 * and kept cycling through what Tyler had already opened, though the Mac had reported every view since #411. Looked-at
 * work stays held and reachable; it just stops counting.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const swift = Bun.which("swift");

const held = (id: string, at: number, viewedAt?: number): SessionReview => ({
  summary: `deliverable ${id}`,
  link: `https://example.test/${id}`,
  at,
  id,
  ...(viewedAt !== undefined ? { viewedAt } : {}),
});

function modelWith(reviews: SessionReview[], status: "waiting" | "working" | "needs" = "waiting") {
  return buildPanelModel({
    sessions: [{ sessionId: "s", name: "Prime page wireframe", backend: "claude" }],
    sessionStates: new Map([
      ["s", { label: "Prime page wireframe", status, at: 10_000, review: reviews.at(-1), reviews }],
    ]),
    pausedSessionIds: new Set(),
    live: { state: "idle", label: "", partial: "" },
    mode: { muted: false, paused: false, holding: 0 },
    activeSessionId: null,
    navSelectedId: null,
  });
}

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("ready means held, not working, and not yet looked at", () => {
  test("looking at the only deliverable clears it", () => {
    const row = (viewedAt?: number): Parameters<typeof reviewReady>[0] => ({
      status: "waiting",
      review: held("a", 1_000, viewedAt),
      reviews: [held("a", 1_000, viewedAt)],
    });
    expect(reviewReady(row())).toBe(true);
    expect(reviewReady(row(9_000))).toBe(false);
  });

  test("any held deliverable nobody has looked at keeps the session ready, not only the newest", () => {
    // The newest was looked at; an older one wasn't.
    expect(reviewReady({ status: "waiting", review: held("b", 2_000, 9_000), reviews: [held("a", 1_000), held("b", 2_000, 9_000)] })).toBe(true);
    // Every one looked at.
    expect(reviewReady({ status: "waiting", review: held("b", 2_000, 9_000), reviews: [held("a", 1_000, 8_000), held("b", 2_000, 9_000)] })).toBe(false);
  });

  test("a working session is never ready, looked at or not; a row with nothing held never is", () => {
    expect(reviewReady({ status: "working", review: held("a", 1_000), reviews: [held("a", 1_000)] })).toBe(false);
    expect(reviewReady({ status: "waiting" })).toBe(false);
    expect(reviewReady({ status: "needs", review: held("a", 1_000) })).toBe(true);
  });

  test("a row from before many-per-session reads its one review, as before", () => {
    expect(reviewReady({ status: "waiting", review: held("a", 1_000) })).toBe(true);
    expect(reviewReady({ status: "waiting", review: held("a", 1_000, 9_000) })).toBe(false);
    // An empty list is the same: the newest alone.
    expect(reviewReady({ status: "waiting", review: held("a", 1_000), reviews: [] })).toBe(true);
  });

  test("through the daemon's own model: marking every held deliverable viewed clears the row, and it stays held", () => {
    const filed = [held("a", 1_000), held("b", 2_000)];
    const before = modelWith(filed).rows[0]!;
    expect(reviewReady(before)).toBe(true);

    const oneSeen = markReviewViewed(filed, "b", 9_000)!;
    expect(reviewReady(modelWith(oneSeen).rows[0]!)).toBe(true);

    const allSeen = markReviewViewed(oneSeen, "a", 9_500)!;
    const after = modelWith(allSeen).rows[0]!;
    expect(reviewReady(after)).toBe(false);
    // Still held: the apps' Previous, Next and switcher reach it.
    expect(after.reviews?.map((one) => one.id)).toEqual(["a", "b"]);
    expect(after.review?.id).toBe("b");

    // And every app hears when it was looked at, so each applies the same rule.
    const wire = buildPublishedState("device", modelWith(allSeen), new Map(), new Set(), 10_000).rows[0]!;
    expect(wire.reviews?.map((one) => one.viewedAt)).toEqual([9_500, 9_000]);
    expect(wire.review?.viewedAt).toBe(9_000);
  });

  test("the terminal's 'to look at' count and its review glyph follow it", () => {
    const unseen = modelWith([held("a", 1_000)]);
    const seen = modelWith([held("a", 1_000, 9_000)]);
    expect(plain(theaterStatusHeader(unseen))).toContain("✓1 to look at");
    expect(plain(theaterStatusHeader(seen))).not.toContain("to look at");
    expect(plain(dashboardRowsForModel(unseen)[0]!)).toContain("needs review");
    expect(plain(dashboardRowsForModel(seen)[0]!)).not.toContain("needs review");
  });
});

/** One rule, two languages: the apps ask ConchDesign's `ReadyForYou`, the daemon `reviewReady`. Same table, same answers. */
describe("the apps' rule is the daemon's", () => {
  const cases: Array<{ status: "waiting" | "working" | "needs"; viewed: Array<number | undefined> }> = [
    { status: "waiting", viewed: [undefined] },
    { status: "waiting", viewed: [9_000] },
    { status: "waiting", viewed: [9_000, undefined] },
    { status: "waiting", viewed: [8_000, 9_000] },
    { status: "needs", viewed: [undefined, 9_000] },
    { status: "working", viewed: [undefined] },
    { status: "working", viewed: [9_000] },
  ];

  test.skipIf(!swift)("ReadyForYou.isReady answers every case as reviewReady does", () => {
    const source = read("design/ConchDesign/Sources/ConchDesign/VoiceState.swift");
    const start = source.indexOf("public enum ReadyForYou {");
    expect(start).toBeGreaterThan(-1);
    const rule = source.slice(start, source.indexOf("\n}\n", start) + 3);
    expect(rule).toContain("static func isReady(working: Bool, viewedAt: [Double?]) -> Bool {");
    const dir = mkdtempSync(join(tmpdir(), "conch-ready-"));
    const file = join(dir, "main.swift");
    const lines = cases.map(({ status, viewed }) =>
      `print(ReadyForYou.isReady(working: ${status === "working"}, viewedAt: [${viewed.map((v) => v === undefined ? "nil" : `${v}`).join(", ")}]))`);
    writeFileSync(file, [rule, ...lines].join("\n"));
    try {
      const run = Bun.spawnSync([swift!, file], { stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      const swiftAnswers = run.stdout.toString().trim().split("\n");
      const daemonAnswers = cases.map(({ status, viewed }) => {
        const reviews = viewed.map((viewedAt, index) => held(`r${index}`, 1_000 + index, viewedAt));
        return String(reviewReady({ status, review: reviews.at(-1), reviews }));
      });
      expect(swiftAnswers).toEqual(daemonAnswers);
      expect(daemonAnswers).toEqual(["true", "false", "true", "false", "true", "false", "false"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("rows from the model carry what the rule reads", () => {
    const row: PanelRowModel = modelWith([held("a", 1_000, 9_000)]).rows[0]!;
    expect(row.reviews?.[0]?.viewedAt).toBe(9_000);
  });
});
