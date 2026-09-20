import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The window re-rendered four times a second with nothing on screen changing.
 *
 * StateStore polls /tmp/conch-sessions.json every 250 ms and `hasSamePresentation` correctly
 * kept `state` put when the file had not changed — but the same poll stored `daemonMessage`,
 * `isLedgerFrozen`, `newerDaemonWarningVisible` and the outbox unconditionally, and
 * `@Published` fires objectWillChange on assignment whether or not the value differs. Every
 * view holding the store re-ran its body. Measured on the Release app with Instruments on
 * 2026-09-20 (Time Profiler + SwiftUI template, attached to the open dashboard, snapshot file
 * byte-for-byte static): a flat 27 ms of main thread per poll, ~100 ms/s at rest, 3.5 SwiftUI
 * transactions/s of 14–16 ms, and the profile named the setters themselves. With the stores
 * guarded the same window measured 1 ms/s.
 *
 * These read the Swift the way the other mac source tests do, with line comments stripped so
 * a description of a guard can never satisfy it.
 */
const swift = (file: string) =>
  readFileSync(new URL(`../mac-app/conch-mac/${file}`, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
const store = swift("StateStore.swift");

function at(text: string, marker: string, from = 0): number {
  const index = text.indexOf(marker, from);
  expect(index, `missing: ${marker}`).toBeGreaterThan(-1);
  return index;
}
/** The end marker is searched from the start, so a marker that also appears earlier cannot yield an empty slice. */
function section(text: string, start: string, end: string): string {
  const a = at(text, start);
  return text.slice(a, at(text, end, a + start.length));
}

describe("an unchanged poll leaves every @Published property alone", () => {
  test("the liveness presentation is stored only when it differs", () => {
    const refresh = section(store, "private func refreshLivenessPresentation(at now: Date)", "private static func isValidJSONReply(");
    expect(refresh).toContain("if daemonMessage != message { daemonMessage = message }");
    expect(refresh).toContain("if isLedgerFrozen != frozen { isLedgerFrozen = frozen }");
    // No unconditional store survives in the function — each one was a republish per poll.
    expect(refresh).not.toMatch(/\n\s*daemonMessage = /);
    expect(refresh).not.toMatch(/\n\s*isLedgerFrozen = /);
  });

  test("the newer-daemon flag is stored only when it differs", () => {
    const warning = section(store, "private func updateNewerDaemonWarning()", "private func evaluateLiveness(");
    expect(warning).toContain("if newerDaemonWarningVisible != visible { newerDaemonWarningVisible = visible }");
    expect(warning).not.toMatch(/\n\s*newerDaemonWarningVisible = /);
  });

  test("a heartbeat that finds the daemon already alive does not say so again", () => {
    const alive = section(store, "private func markAlive(at now: Date, resetsBaseline: Bool)", "private func canAttemptProbe(");
    expect(alive).toContain("if liveness != .alive { liveness = .alive }");
    expect(alive).not.toMatch(/\n\s*liveness = \.alive/);
  });

  test("the outbox is reconciled on a copy and stored only if it changed", () => {
    const reconcile = section(store, "private func reconcileOutbox(with snapshot:", "static func sameMessage(");
    expect(at(reconcile, "var reconciled = outbox")).toBeLessThan(at(reconcile, "if reconciled != outbox { outbox = reconciled }"));
    // A mutating call on the property itself fires its didSet (a UserDefaults write) and its
    // willSet (a republish) whether or not anything was removed.
    expect(reconcile).not.toContain("outbox.remove(");
    expect(reconcile).not.toContain("outbox.prune(");
  });
});
