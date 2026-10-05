import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * A folder deliverable in the apps: its tree in the Mac's window and panel, the folder the Files tab shows, and the
 * phone's honest fallback. The rules are ConchDesign's and XCTested (FolderDeliverableTests); these pin the wiring.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Line comments stripped, so prose describing a rule can never satisfy a guard.
const swift = (path: string) => source(path).replace(/^\s*\/\/.*$/gm, "");
const review = swift("mac-app/conch-mac/ReviewView.swift");
const dashboard = swift("mac-app/conch-mac/DashboardView.swift");
const panels = swift("mac-app/conch-mac/FloatingPanels.swift");
const statusItem = swift("mac-app/conch-mac/StatusItem.swift");
const macModels = swift("mac-app/conch-mac/Models.swift");
const sheet = swift("mobile/conch-ios/conch-ios/DeliverableSheet.swift");
const phoneModels = swift("mobile/conch-ios/conch-ios/Models.swift");

function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  expect(a, `missing: ${start}`).toBeGreaterThan(-1);
  const b = text.indexOf(end, a + start.length);
  expect(b, `missing after ${start}: ${end}`).toBeGreaterThan(-1);
  return text.slice(a, b);
}

describe("the Mac draws a folder deliverable as the Files tab's tree", () => {
  test("a directory is a folder, unless it is a package", () => {
    const init = between(review, "init(link: String) {", "private static func localFileURL");
    expect(init).toContain("let packaged = NSWorkspace.shared.isFilePackage(atPath: localURL.path)");
    expect(init).toContain("self = packaged ? .unsupported(localURL) : .folder(localURL)");
  });

  test("the deliverable surface routes a folder to WorkspaceFilesView, with its focus and the session's changes", () => {
    const surface = between(review, "private struct ReviewSurface: View {", "private var stageControl");
    expect(surface).toContain("if let link = item.link, case let .folder(folder) = DeliverableSource(link: link) {");
    expect(surface).toMatch(/WorkspaceFilesView\(\s*root: folder\.path,\s*rowID: item\.rowID,\s*changed: changed,\s*focus: item\.focus,\s*title: folder\.lastPathComponent\s*\)/);
    // Keyed on the version, so the next one opens on its own focus.
    expect(surface).toContain(".id(item.id)");
    expect(between(review, "struct ReviewItem: Identifiable, Equatable {", "struct InlineReviewView")).toContain("focus = review.focus");
  });

  test("one tree: the rail is ConchDesign's, in the window's type, with the focus opened on first draw", () => {
    const files = between(review, "struct WorkspaceFilesView: View {", "private struct MissingDeliverableView: View {");
    expect(files).toContain("ConchFileTreeRail(");
    expect(files).toContain("focus: pointedAt,");
    expect(files).toContain("font: { ConchTypography.font(size: $0, weight: $1) },");
    // The disk is asked once, off the main thread, never from body.
    const open = between(files, "private func openFocus() {", "private func load(");
    expect(open).toContain("Task.detached(priority: .userInitiated)");
    expect(open).toContain("let open = focus.expanded(isDirectory: isDirectory)");
    expect(open).toContain("if selected == nil { selected = first }");
    expect(between(files, "private func loadRoot() {", "private func openFocus")).toContain("openFocus()");
    expect(review).not.toContain("private struct FileRowView");
  });

  test("the window and the panel hand the session's changes to a folder's tree", () => {
    expect(dashboard).toContain("changed: changedFiles(for: row)");
    expect(panels).toContain("InlineReviewView(item: item, onOpenInPlace: openWhereItLives, liveAddress: $address, changed: changed)");
    expect(panels).toContain("store.state?.row(item.rowID)?.changedFiles(in: store.state)");
  });

  test("a folder opens in the panel from anywhere, as marks do", () => {
    const open = between(statusItem, "static func open(_ row: SessionRow, from origin: OpenFrom", "static func stage(");
    expect(open).toContain("let conchOnly = ReviewScene.opensOnlyInConch(deliverable: row.review?.kind, marked: marked)");
    expect(open).toContain("panelOn: defaults.bool(forKey: showConversationKey), conchOnly: conchOnly, words: words)");
    // With the overlays off, conch's window instead of the panel (`ConchOverlays.destination`).
    expect(open).toContain("case .window:\n            openInWindow(row, store: store)");
  });

  test("the Mac reads focus off every held deliverable", () => {
    expect(macModels).toContain("case focus");
    expect(macModels).toContain("focus = (try? container.decodeIfPresent([String].self, forKey: .focus)) ?? []");
  });
});

describe("where did the Files tab go", () => {
  test("the Files tab shows the first declared folder, never the home folder itself, by ConchDesign's rule", () => {
    const folder = between(dashboard, "private var workingFolder: String? {", "private var hasWorkPane");
    expect(folder).toContain("return ConchWorkFolder.pick(cwd: row.cwd, workDirs: row.workDirs, home: NSHomeDirectory())");
    // Not the start folder alone, and not a home check of its own that could drift from the tested rule.
    expect(folder).not.toContain("workFolder");
  });
});

describe("the phone says what the folder is, and never fetches it", () => {
  test("a folder routes to its own view before any download", () => {
    const kind = between(sheet, "private var kind: Kind {", "private var pageURL: URL? {");
    const folder = kind.indexOf('if review.kind == "folder", let link = review.link { return .folder(link) }');
    expect(folder).toBeGreaterThan(-1);
    expect(folder).toBeLessThan(kind.indexOf("switch (link as NSString).pathExtension.lowercased()"));
    expect(sheet).toContain("case let .folder(link):\n            FolderDeliverableView(folder: link, focus: review.focus)");
    // The download runs only for `.local`, which a folder never is.
    expect(sheet).toContain("guard case let .local(localKind) = kind, localKind != .page, let link = review.link else { return }");
  });

  test("its name, the focus paths and Open on your Mac", () => {
    const view = between(sheet, "struct FolderDeliverableView: View {", "struct StandInView: View {");
    expect(view).toContain("Text(name)");
    expect(view).toContain("ForEach(focus, id: \\.self)");
    expect(view).toContain("Open on your Mac");
    expect(phoneModels).toContain("focus = (try? c.decodeIfPresent([String].self, forKey: .focus)) ?? []");
  });
});
