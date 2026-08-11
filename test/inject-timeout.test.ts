import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * No AppleScript call may run without a bound.
 *
 * A modal system dialog on the Mac freezes every System Events call for as
 * long as it is on screen. Measured on Tyler's machine while a permission
 * popup was up: `focusSessionWindow` took 122,891ms and then failed anyway,
 * three sends in a row, with the daemon's whole queue stacked behind it. From
 * the phone that looked like conch silently refusing to send.
 *
 * These are source guards rather than behavioural tests because the failure is
 * "waits forever", and a test that reproduces it faithfully would too.
 */
describe("AppleScript can never hang the daemon", () => {
  const source = readFileSync(new URL("../src/inject.ts", import.meta.url), "utf8");

  test("every osascript spawn races a timeout", () => {
    const spawns = source.split("Bun.spawn([\"osascript\"").length - 1;
    const races = source.split("Promise.race").length - 1;
    expect(spawns).toBeGreaterThan(0);
    expect(races).toBeGreaterThanOrEqual(spawns);
  });

  test("the bound is seconds, not minutes", () => {
    const match = /OSA_TIMEOUT_MS = ([0-9_]+)/.exec(source);
    expect(match).not.toBeNull();
    const ms = Number(match![1]!.replace(/_/g, ""));
    expect(ms).toBeGreaterThan(1_000); // long enough for a real window raise
    expect(ms).toBeLessThan(15_000); // short enough that a person is not left waiting
  });

  test("a timed-out script is killed rather than left running", () => {
    // Otherwise a long session accumulates one blocked osascript per attempt.
    expect(source).toContain("child.kill()");
  });

  // "Not focusable" and "a dialog ate the request" mean completely different
  // things to the person holding the phone: one is a session conch cannot
  // reach, the other is a popup that will block every send until dismissed.
  test("a blocking dialog is reported as itself", () => {
    expect(source).toContain("system-dialog-blocking");
    expect(source).toContain("osaLastTimedOut");
  });
});
