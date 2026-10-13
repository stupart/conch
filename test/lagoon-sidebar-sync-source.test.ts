import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The lagoon and the sidebar, one selection (2026-10-13). Tyler: "If I'm looking at the work for one session it should
 * show I'm in that session on the main sidebar."
 *
 * - The page says `focusSession` when its panel opens on a session or moves to another (and when a crab is clicked): it
 *   acts with no flag, the sidebar selects that session, unfolds its folder and brings the row into view, and the window
 *   stays on the lagoon. The camera isn't sent back to the crab the page is already on.
 * - A session picked in the sidebar while the lagoon shows sends the camera to its crab (`conchWorld.focus`).
 *
 * The rule for what is sent back is ConchDesign's `LagoonFocus` (LagoonFocusTests); the Mac app has no test target, so
 * these read its Swift for the wiring.
 */
const root = join(import.meta.dir, "..");
// Line comments stripped, so prose describing a rule can never satisfy a guard.
const swift = (path: string): string => readFileSync(join(root, path), "utf8").replace(/^\s*\/\/.*$/gm, "");

const content = swift("mac-app/conch-mac/ContentView.swift");
const pane = swift("mac-app/conch-mac/LagoonPane.swift");
const dashboard = swift("mac-app/conch-mac/DashboardView.swift");
const intents = swift("design/ConchDesign/Sources/ConchDesign/LagoonIntents.swift");

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("the page's pick selects the session in the sidebar", () => {
  test("focusSession acts with no flag", () => {
    expect(intents).toContain("public static let byDefaultInOrder: [Name] = [.approve, .unapprove, .reply, .focusSession]");
    expect(intents).toContain("public static let phaseB: Set<Name> = [.openReview]");
  });

  test("it selects the row through LagoonFocus, and asks the sidebar to show it, without leaving the lagoon", () => {
    const focus = between(pane, "func focusSession(_ sessionId: String) {", "\n    }\n");
    expect(focus).toContain("if focus.pageFocused(sessionId, viewing: workspace.viewing) { workspace.viewing = sessionId }");
    expect(focus).toContain("NotificationCenter.default.post(name: .revealSessionInSidebar, object: sessionId)");
    // Nothing here leaves the page, or calls back into it.
    expect(focus).not.toContain("Lagoon.pageKey");
    expect(focus).not.toContain("storedPage");
    expect(focus).not.toContain("host");
  });

  test("the sidebar unfolds the row's folder and scrolls to it once the folder is drawn", () => {
    const ledger = between(dashboard, "private struct SessionLedger: View {", "\nfinal class LedgerScroller {");
    expect(ledger).toContain(".onReceive(NotificationCenter.default.publisher(for: .revealSessionInSidebar)) { note in");
    const reveal = between(ledger, "private func reveal(_ sessionID: SessionRow.ID) {", "\n    }\n");
    expect(reveal).toContain("let shownID = row.parentSessionId ?? row.id");
    expect(reveal).toContain("collapsedFolders.remove(folder.id)");
    expect(reveal).toContain("revealing = LedgerReveal(id: sessionID)");
    // The scroll goes through `keepInView`, as every other scroll of the list does (LedgerScroller).
    const scroll = between(ledger, ".onChange(of: revealing) { _, request in", "\n                        }");
    expect(scroll).toContain("keepInView(scrollTarget(for: request.id), proxy, animated: true)");
  });
});

describe("the sidebar's pick moves the camera, and only the sidebar's", () => {
  test("every change of selection goes through LagoonModel.selectionChanged", () => {
    const change = between(content, ".onChange(of: workspace.viewing) { _, id in\n            lagoon.selectionChanged", "}\n");
    expect(change).toContain("lagoon.selectionChanged(to: id, onLagoon: page == .lagoon)");
    // Not a second path that focuses on every change.
    expect(content).not.toMatch(/onChange\(of: workspace\.viewing\) \{ _, id in\s*guard page == \.lagoon, let id else \{ return \}\s*lagoon\.focus\(id\)/);
  });

  test("selectionChanged asks LagoonFocus before calling into the page", () => {
    const changed = between(pane, "func selectionChanged(to sessionId: String?, onLagoon: Bool) {", "\n    }\n");
    expect(changed).toContain("guard actions.focus.selectionChanged(to: sessionId), onLagoon, let sessionId else { return }");
    expect(changed).toContain("host?.focus(sessionId)");
  });

  test("a row picked again, already selected, still sends the camera to it", () => {
    const select = between(content, "private func selectSession(_ row: SessionRow) {", "\n    }\n");
    expect(select).toContain("if page == .lagoon, workspace.viewing == row.id { lagoon.focus(row.id) }");
  });
});
