import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The lagoon groups its sessions as the sidebar does (2026-10-13, agreed with the brand repo): the snapshot carries each
 * row's sidebar folder (`rows[].folder`) and the sidebar's folders in its order (`folders`). Both come from ONE rule,
 * ConchDesign's `SessionGrouping.sidebar` (SessionGroupingTests, LagoonSnapshotTests): the sidebar draws it and the
 * lagoon is sent its names. The Mac app has no test target, so these read its Swift for the wiring.
 */
const root = join(import.meta.dir, "..");
// Line comments stripped, so prose describing a rule can never satisfy a guard.
const swift = (path: string): string => readFileSync(join(root, path), "utf8").replace(/^\s*\/\/.*$/gm, "");

const dashboard = swift("mac-app/conch-mac/DashboardView.swift");
const models = swift("mac-app/conch-mac/Models.swift");
const pane = swift("mac-app/conch-mac/LagoonPane.swift");
const source = swift("mac-app/conch-mac/LagoonSource.swift");
const snapshot = swift("design/ConchDesign/Sources/ConchDesign/LagoonSnapshot.swift");

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("one rule for the sidebar's folders and the lagoon's", () => {
  test("the sidebar draws SessionGrouping.sidebar, with the order under its key", () => {
    const folders = between(dashboard, "private var sessionFolders: [SessionFolder] {", "\n    }\n");
    expect(folders).toContain("SessionGrouping.sidebar((state?.rows ?? []).map(\\.groupedAs), home: NSHomeDirectory(), order: folderOrder)");
    // No second copy of the rule left in the view: grouping, the home folder's name and the order are all sidebar()'s.
    expect(dashboard).not.toContain("SessionGrouping.folders(");
    expect(dashboard).not.toContain("SessionGrouping.ordered(");
    expect(dashboard).toContain("@AppStorage(SessionGrouping.orderKey) private var storedFolderOrder");
    expect(dashboard).toContain("get { SessionGrouping.storedOrder(storedFolderOrder) }");
  });

  test("a row is grouped by the same fields wherever it is grouped", () => {
    expect(models).toContain("var workFolder: String? { SessionGrouping.workFolder(cwd: cwd, workDirs: workDirs) }");
    expect(models).toContain("SessionGrouping.Session(id: id, cwd: cwd, workDirs: workDirs, parentSessionId: parentSessionId, startedBySessionId: startedBySessionId)");
    expect(snapshot).toContain("SessionGrouping.Session(id: id, cwd: cwd, workDirs: workDirs, parentSessionId: parentSessionId, startedBySessionId: startedBySessionId)");
  });

  test("the snapshot is built from that rule, with the sidebar's home and the dragged order", () => {
    expect(snapshot).toContain("let sidebar = SessionGrouping.sidebar(source.rows.map(\\.groupedAs), home: home, order: source.folderOrder).filter { !$0.name.isEmpty }");
    expect(snapshot).toContain("folders = sidebar.compactMap { Self.folderName($0.name) }.filter { named.insert($0).inserted }");
    expect(snapshot).toContain("for id in folder.sessionIDs where folderOf[id] == nil { folderOf[id] = Self.folderName(folder.name) }");
    expect(snapshot).toContain("try c.encodeIfPresent(folder, forKey: .folder)");
    expect(source).toContain("folderOrder: folderOrder");
    const built = between(pane, "func source(_ state: PublishedState) -> LagoonSnapshot.Source {", "\n    }\n");
    expect(built).toContain("folderOrder: SessionGrouping.storedOrder(UserDefaults.standard.string(forKey: SessionGrouping.orderKey) ?? \"\")");
    // The host's home is the one the sidebar names "Home".
    expect(pane).toContain("home: NSHomeDirectory(),");
  });

  test("a folder dragged in the sidebar reorders the lagoon's at once", () => {
    const view = between(pane, "struct LagoonPane: View {", "\nstruct LagoonWebContainer");
    expect(view).toContain("@AppStorage(SessionGrouping.orderKey) private var folderOrder = \"\"");
    expect(view).toContain(".onChange(of: folderOrder) { _, _ in");
    expect(between(view, ".onChange(of: folderOrder) { _, _ in", "\n        }")).toContain("lagoon.revise(state)");
    expect(between(pane, "func revise(_ state: PublishedState) {", "\n    }\n")).toContain("host?.revise(source(state))");
  });
});
