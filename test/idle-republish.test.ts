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
    // Stored through honoringDismissals (2026-10-05), so a Dismiss between the copy and the store stands; still only
    // when it changed.
    expect(at(reconcile, "var reconciled = outbox")).toBeLessThan(at(reconcile, "let stored = reconciled.honoringDismissals(of: outbox)"));
    expect(at(reconcile, "let stored = reconciled.honoringDismissals(of: outbox)")).toBeLessThan(at(reconcile, "if stored != outbox { outbox = stored }"));
    // A mutating call on the property itself fires its didSet (a UserDefaults write) and its
    // willSet (a republish) whether or not anything was removed.
    expect(reconcile).not.toContain("outbox.remove(");
    expect(reconcile).not.toContain("outbox.prune(");
  });
});

/**
 * The same rule, everywhere the poll reaches (2026-11-02, Tyler: "yea go for it", on cutting the app's CPU).
 *
 * `WorkbenchStore.accept` runs on every poll, four a second, and stored `profileNames` and mutated `actedIn` in place on
 * each. The conversation pane watches that store, so it re-ran its body and diffed everything under it four times a
 * second with nothing on screen changing: in a 15 s sample of the live app, SwiftUI transactions were 946 of the main
 * thread's 1,240 busy samples, a steady 40-65 ms a second whether the sessions file had moved or not. Offscreen, on the
 * app's own window and Tyler's sessions file, the window at rest went from 50 ms of main thread a second to 2
 * (app-cpu.test.ts has the rest).
 */
describe("the Workbench's poll leaves its @Published properties alone too", () => {
  const workbench = swift("Workbench.swift");
  const accept = section(workbench, "func accept(_ snapshot: PublishedState) {", "\n    }\n");

  test("the profiles' names and the tabs acted in are stored only when they differ", () => {
    expect(accept).toContain("if names != profileNames { profileNames = names }");
    expect(accept).not.toMatch(/\n\s*profileNames = /);
    // On a copy: `formIntersection` on the property itself republishes whether or not it removed anything.
    expect(accept).toContain("let stillActedIn = actedIn.intersection(ids)");
    expect(accept).toContain("if stillActedIn != actedIn { actedIn = stillActedIn }");
    expect(accept).not.toContain("actedIn.formIntersection(");
    // The rest of what it stores was already guarded.
    expect(accept).toContain("if listed != profiles {");
    expect(accept).toContain("if open != tabs { tabs = open }");
  });

  test("a page made for a tab already listed is said, since the pane draws a tab only once its page exists", () => {
    expect(accept).toContain("made = makePage(for: tab) != nil || made");
    expect(accept).toContain("if made { objectWillChange.send() }");
  });
});

describe("a snapshot already taken in is only revisited", () => {
  test("the reader says whether the snapshot was read just now, after reading it", () => {
    const reader = section(store, "private actor StateSnapshotReader {", "\n}\n");
    expect(at(reader, "snapshot: snapshot.value(at: url.path) { StateSnapshotFile.read(from: url) },")).toBeLessThan(at(reader, "fresh: snapshot.fresh,"));
  });

  test("a fresh snapshot is accepted; the same one again is revisited", () => {
    const poll = section(store, "pollingTask = Task { @MainActor [weak self, reader] in", "frontWindow = FrontWindowObserver");
    expect(poll).toContain("if result.fresh { accept(snapshot) } else { revisit(snapshot) }");
    expect(poll).not.toMatch(/\n\s*accept\(snapshot\)\n/);
  });

  test("a revisit does what moves with the clock or with something done here since, and nothing else", () => {
    const revisit = section(store, "private func revisit(_ snapshot: PublishedState) {", "\n    }\n");
    // The tabs' sleep is by the clock, and commands end between publishes.
    expect(revisit).toContain("WorkbenchStore.shared.accept(snapshot)");
    // A bubble's ten minutes run out by the clock: only while there is one.
    expect(revisit).toContain("if !outbox.entries.isEmpty { reconcileOutbox(with: snapshot) }");
    // An overlay a failed command put back with an older baseline completes against this same snapshot.
    expect(revisit).toContain("if !labelOverrides.isEmpty || !optimisticDismissals.isEmpty || !optimisticRestores.isEmpty {");
    expect(at(revisit, "reconcilePresentationOverlays(with: snapshot)")).toBeLessThan(at(revisit, "rebuildPresentedState()"));
    expect(revisit).toContain("if snapshot.showing == nil { screenGate.forget() }");
    expect(revisit).toContain("refreshLivenessPresentation(at: Date())");
    // What follows from the snapshot alone is not worked out again.
    for (const once of ["applyDeliveryOutcomes(", "windowPreviewer.handle(", "pageCaptures.handle(", "updateNewerDaemonWarning()", "sourceState = "]) {
      expect(revisit).not.toContain(once);
    }
  });
});

describe("the audio banners are stored only when they change", () => {
  test("each banner is compared before it is stored", () => {
    const banners = section(swift("AudioHolderStore.swift"), "private func refreshBanners() {", "\n    }\n");
    expect(banners).toContain("if controlledBy != controller { controlledBy = controller }");
    expect(banners).toContain("if silentHosts != silent { silentHosts = silent }");
    expect(banners).toContain("if takeableHosts != takeable { takeableHosts = takeable }");
    expect(banners).not.toMatch(/\n\s*(controlledBy|silentHosts|takeableHosts) = /);
  });
});
