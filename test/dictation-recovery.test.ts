import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DICTATIONS_FILE, getLiveState, publishDictation, recentDictations, rememberDictation } from "../src/status.ts";

/**
 * 2026-10-05: a 2,555-character dictation reached no composer. The daemon numbered dictations from 1 again after every
 * restart, and the Mac app keeps the last number it applied across its own relaunches, so the first dictation after a
 * restart looked already applied and was skipped. Its words survived only by luck, in the live state.
 */
describe("a dictation is new to every app, however often the daemon restarts", () => {
  test("its id is never one an earlier daemon could have used: it is at least the clock's millisecond", () => {
    const before = Date.now();
    publishDictation("first words", "s1");
    const first = getLiveState().dictated!;
    expect(first.id).toBeGreaterThanOrEqual(before);
    publishDictation("second words", "s1");
    // Two in one millisecond still differ.
    expect(getLiveState().dictated!.id).toBeGreaterThan(first.id);
    // A restarted daemon counts from nothing, and still lands past any id this one gave out.
    expect(Math.max(0 + 1, Date.now())).toBeGreaterThanOrEqual(first.id);
  });
});

describe("the recent dictations, kept for recovery", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "conch-dictations-")), "recent-dictations.jsonl");

  test("the suite never writes the user's own file", () => {
    expect(DICTATIONS_FILE.startsWith(process.env.CONCH_TEST_ROOT ?? "/nowhere") || DICTATIONS_FILE.includes("conch-test-")).toBe(true);
  });

  test("each one is kept in full, 0600, newest last", () => {
    const path = file();
    rememberDictation({ at: 1_000, sessionId: "a", text: "x".repeat(2_555) }, path);
    rememberDictation({ at: 2_000, sessionId: "b", text: "later" }, path);
    expect(recentDictations(path, 3_000).map((one) => [one.sessionId, one.text.length])).toEqual([["a", 2_555], ["b", 5]]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("only the last twenty, within the week; a line that isn't one is skipped", () => {
    const path = file();
    const week = 7 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 25; i++) rememberDictation({ at: week + i, sessionId: `s${i}`, text: `t${i}` }, path);
    expect(recentDictations(path, week + 25).map((one) => one.sessionId)).toEqual(Array.from({ length: 20 }, (_, i) => `s${i + 5}`));
    writeFileSync(path, readFileSync(path, "utf8") + "not json\n");
    expect(recentDictations(path, week + 25)).toHaveLength(20);
    expect(recentDictations(path, 3 * week)).toEqual([]);
  });

  test("publishing one keeps a copy", () => {
    publishDictation("kept for recovery", "s-recover");
    expect(recentDictations().at(-1)).toMatchObject({ sessionId: "s-recover", text: "kept for recovery" });
  });
});
