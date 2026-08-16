import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Coming back from sleep.
 *
 * The daemon is a Bun process, so it never sees NSWorkspace's wake
 * notification — only the app does, and only for its own UI. The relay socket
 * dies during sleep without a close frame arriving, so on wake the daemon sits
 * inside an exponential backoff having noticed nothing. Tyler: "i let my
 * computer sleep and turned it back on and the app is having a tough time
 * connecting".
 */
describe("waking up", () => {
  const source = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");

  test("a gap in wall-clock is treated as sleep", () => {
    expect(source).toContain("WAKE_GAP_MS");
    const detector = source.slice(source.indexOf("const WAKE_TICK_MS"));
    expect(detector.slice(0, 1400)).toContain("reconnectNow()");
  });

  // The tick has to be much shorter than the gap it detects, or a slow tick is
  // indistinguishable from a nap and the daemon re-dials on ordinary lag.
  test("the tick is well inside the gap it looks for", () => {
    const tick = Number(/WAKE_TICK_MS = ([0-9_]+)/.exec(source)![1]!.replace(/_/g, ""));
    const gap = Number(/WAKE_GAP_MS = ([0-9_]+)/.exec(source)![1]!.replace(/_/g, ""));
    expect(gap).toBeGreaterThan(tick * 3);
  });

  // An unref'd timer must never be the reason a shutting-down daemon lingers.
  test("the watch does not hold the process open", () => {
    const detector = source.slice(source.indexOf("const wakeWatch = setInterval"));
    expect(detector.slice(0, 900)).toContain("unref");
  });
});
