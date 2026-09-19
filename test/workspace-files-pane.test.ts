import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The session's working folder, in the work half of the stage.
 *
 * Tyler: "where are we on being able to have a terminal and see the full file tree and diffs
 * borrowing from this app: https://coteditor.com as well as a browser in the side panel".
 * This is the file tree, and it is deliberately NOT a Finder in a pane — conch knows the one
 * thing Finder cannot, which is what this session just changed.
 *
 * The shape that matters: files are a second AXIS, not a fourth page. `StageMode` answers how
 * the conversation and the work share the stage; what sits in the work half is a different
 * question. Folding them together would give the pane two sources of truth about what it is
 * drawing, and "the files, side by side" could not be expressed at all.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Line comments stripped, so prose describing a rule can never satisfy a guard.
const swift = (path: string) => source(path).replace(/^\s*\/\/.*$/gm, "");
const pane = swift("mac-app/conch-mac/DashboardView.swift");
const review = swift("mac-app/conch-mac/ReviewView.swift");
const workspace = swift("design/ConchDesign/Sources/ConchDesign/Workspace.swift");

function at(text: string, marker: string, from = 0): number {
  const index = text.indexOf(marker, from);
  expect(index, `missing: ${marker}`).toBeGreaterThan(-1);
  return index;
}
function section(text: string, start: string, end: string): string {
  const a = at(text, start);
  return text.slice(a, at(text, end, a));
}

describe("the files are a second axis, not a fourth page", () => {
  test("StageMode still has exactly its three pages", () => {
    // Sliced to WorkPane, not to SessionPresentation: the new axis is declared between them,
    // so the wider slice counted BOTH enums' cases and read 5. The stage still has three.
    const stage = section(workspace, "public enum StageMode", "public enum WorkPane");
    expect(stage.match(/case \w+/g) ?? []).toHaveLength(3);
    // The new axis lives in its own type, with exactly two contents and its own default.
    const work = section(workspace, "public enum WorkPane", "public struct SessionPresentation");
    expect(work.match(/case \w+/g) ?? []).toHaveLength(2);
    expect(workspace).toContain("public var work: WorkPane = .deliverable");
  });

  test("asking for the files leaves the stage where it was", () => {
    // Two axes, two setters. One door each, so neither can move the other by accident.
    expect(workspace).toContain("public func show(work: WorkPane, for id: String?) {");
    expect(section(workspace, "public func show(work:", "public func select(deliverable:"))
      .toContain("$0.work = work");
  });
});

describe("the work half can hold the files or a deliverable", () => {
  test("one builder serves both stages, so they cannot drift", () => {
    const content = section(pane, "private func workContent(for row: SessionRow) -> some View {", "\n    private var deliverables");
    expect(content).toContain("if workPane(for: row) == .files, let folder = workingFolder {");
    expect(content).toContain("WorkspaceFilesView(root: folder, rowID: row.id, changed: changedFiles(for: row))");
    expect(content).toContain("InlineReviewView(");
  });

  /**
   * The remembered choice is never trusted blindly. A session asked for its files and then
   * losing its folder must fall back to the deliverable rather than drawing an empty tree.
   */
  test("a choice that no longer exists falls back rather than emptying the pane", () => {
    const choose = section(pane, "private func workPane(for row: SessionRow) -> WorkPane {", "\n    private func changedFiles");
    expect(choose).toContain("if chosen == .files, workingFolder != nil { return .files }");
    expect(choose).toContain("if selectedReview != nil { return .deliverable }");
  });

  /**
   * Found by LOOKING, not by reasoning about it: a session holding six deliverables filled
   * the strip edge to edge, and the folder tab — appended after them in a plain HStack — was
   * laid out past the right of the pane where nothing could see or click it. The deliverables
   * were already clipping each other before the folder was ever added.
   *
   * So the folder leads and is pinned OUTSIDE the scroller. It is not one of the outputs
   * competing for room with however many there are; it is the place the session works in, and
   * its position must not drift as they accumulate.
   */
  test("the folder is pinned ahead of the deliverables, which scroll", () => {
    const tabs = section(pane, "private func deliverableTabs(", ".padding(.vertical, 5)");
    expect(tabs).toContain("ScrollView(.horizontal)");
    expect(at(tabs, "FilesTab(")).toBeLessThan(at(tabs, "ScrollView(.horizontal)"));
    // The scroller claims the remaining width, so the strip no longer needs a spacer to push
    // the tabs left — and a spacer here would fight it for room.
    expect(tabs).not.toContain("Spacer(minLength: 0)");
  });

  test("the working folder is a tab beside the deliverables, and selects itself", () => {
    expect(pane).toContain("private struct FilesTab: View {");
    expect(pane).toContain("action: { workspace.show(work: .files, for: row.id) }");
    // Picking a deliverable brings the work half back to it, or the tab strip would show a
    // selected deliverable while the files were still on screen.
    expect(pane).toContain("workspace.show(work: .deliverable, for: row.id)");
    // Nothing reads as the shown deliverable while the files are up.
    expect(pane).toContain("let shown = workPane(for: row) == .deliverable ? selectedReview?.id : nil");
  });
});

describe("the tree tells the truth about what changed", () => {
  /**
   * The daemon publishes one conversation at a time. Marking another session's edits on this
   * session's tree would be a confident lie about work that never happened here — the same
   * reason the transcript carries this check.
   */
  test("only this row's own changes mark this row's tree", () => {
    const changed = section(pane, "private func changedFiles(for row: SessionRow) -> ConchFileChanges {", "\n    @ViewBuilder");
    expect(changed).toContain("conversation?.sessionId == row.id ? conversation?.items ?? [] : []");
    expect(changed).toContain("changed: items.compactMap { $0.change?.path }");
    expect(changed).toContain("relativeTo: row.cwd ?? \"\"");
  });

  test("a folder holding changes is marked more quietly than a changed file", () => {
    const row = section(review, "private struct FileRowView: View {", "private var accessibilityLabel");
    // One dot, two strengths. If a folder shouted as loudly as an edited file, every folder
    // from the root down would read as edited.
    expect(row).toContain(".opacity(isChanged ? 1 : 0.35)");
    expect(row).toContain("if isChanged || holdsChanges {");
  });
});

describe("the pane stays smooth", () => {
  /**
   * The disk is not read from `body`. A listing in the render path runs again on every
   * unrelated state change — a keystroke in the composer, a snapshot from the daemon — and
   * stutters the very scroll it is drawing.
   */
  test("listings are cached and loaded off the main thread, never from body", () => {
    const files = section(review, "struct WorkspaceFilesView: View {", "private struct FileRowView: View {");
    expect(files).toContain("@State private var listings: [String: [ConchFileEntry]] = [:]");
    expect(files).toContain("guard listings[directory] == nil else { return }");
    expect(files).toContain("Task.detached(priority: .userInitiated)");
    // The flattening is pure and unit-tested in ConchDesign; the view only renders it.
    expect(files).toContain("ConchFileTree.rows(root: root, listings: listings, expanded: expanded)");
    // A body that listed the disk would have to call children(of:) directly.
    expect(files).not.toContain("ConchFileTree.children(of: root)");
  });

  /**
   * One viewer, not two. `ReviewContent` already turns ANY path into the right renderer, so
   * picking a file in the tree is the same act as opening a deliverable.
   */
  test("the file you pick is drawn by the deliverable renderer, not a second one", () => {
    expect(review).toContain("ReviewContent(link: selected, rowID: rowID, isWebLoading: $isWebLoading)");
  });
});
