import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 2026-10-16, Tyler: "whats the path to the atlas core page doc your showing me in conch right now? we should prob add a
// right click option to the tabs to like copy path or something".
test("a deliverable tab's right-click copies its path or link, reveals a file in Finder, and still removes", () => {
  const dashboard = readFileSync(join(import.meta.dir, "../mac-app/conch-mac/DashboardView.swift"), "utf8");
  const tab = dashboard.slice(dashboard.indexOf("private struct DeliverableTab: View {"), dashboard.indexOf("private struct PerspectiveOption: View {"));
  expect(tab).toContain("private var location: DeliverableLocation? { DeliverableLocation.of(current.link, cwd: cwd) }");
  expect(tab).toContain('Button(location.isFile ? "Copy Path" : "Copy Link") {');
  expect(tab).toContain("NSPasteboard.general.setString(location.text, forType: .string)");
  expect(tab).toContain('Button("Reveal in Finder") { revealInFinder(location.text) }');
  expect(tab).toContain('Button("Remove", role: .destructive, action: remove)');
  // Revealed through the app's one door for links, never NSWorkspace directly.
  expect(tab).not.toContain("activateFileViewerSelecting");
  expect(dashboard).toContain("store.openLink(path, cwd: row.cwd, rowId: row.id, reveal: true, onFailure: { _ in })");
});
