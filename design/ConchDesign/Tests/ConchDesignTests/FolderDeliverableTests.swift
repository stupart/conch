import XCTest
@testable import ConchDesign

/// A folder deliverable's tree: what the agent pointed at (`focus`) opened and marked, never a path it can't show under
/// its own root; and which folder a session's Files tab shows.
final class FolderDeliverableTests: XCTestCase {
    private func entry(_ path: String, directory: Bool = false) -> ConchFileEntry {
        ConchFileEntry(path: path, name: (path as NSString).lastPathComponent, isDirectory: directory)
    }

    // MARK: focus

    func testFocusResolvesUnderTheRootInOrderAndDropsAnythingItCannotShow() {
        let focus = ConchFileFocus(
            focus: ["src/setup.ts", "test/", "src/setup.ts", "../etc/hosts", "/etc/hosts", "~/x", "a/../../b", "", "  docs/a.md  "],
            relativeTo: "/w/module/"
        )
        XCTAssertEqual(focus.root, "/w/module")
        XCTAssertEqual(focus.paths, ["/w/module/src/setup.ts", "/w/module/test", "/w/module/docs/a.md"])
        XCTAssertFalse(focus.isEmpty)
        XCTAssertTrue(ConchFileFocus(focus: ["../x"], relativeTo: "/w").isEmpty)
        // A .. part is refused even when it lands back inside, as the daemon refuses it: not a path in the folder.
        XCTAssertTrue(ConchFileFocus(focus: ["src/../README.md"], relativeTo: "/w").isEmpty)
    }

    func testTheFocusedRowAndTheFoldersOnTheWayAreToldApart() {
        let focus = ConchFileFocus(focus: ["src/app/setup.ts"], relativeTo: "/w")
        XCTAssertTrue(focus.isFocused(entry("/w/src/app/setup.ts")))
        XCTAssertFalse(focus.isFocused(entry("/w/src/app/setup.test.ts")))
        XCTAssertTrue(focus.leadsTo(entry("/w/src", directory: true)))
        XCTAssertTrue(focus.leadsTo(entry("/w/src/app", directory: true)))
        // The separator matters: /w/src/ap is not on the way to /w/src/app/setup.ts.
        XCTAssertFalse(focus.leadsTo(entry("/w/src/ap", directory: true)))
        // A file never leads anywhere, and the focused folder is focused, not on the way to itself.
        XCTAssertFalse(focus.leadsTo(entry("/w/src/app/setup.ts")))
        let folder = ConchFileFocus(focus: ["test"], relativeTo: "/w")
        XCTAssertTrue(folder.isFocused(entry("/w/test", directory: true)))
        XCTAssertFalse(folder.leadsTo(entry("/w/test", directory: true)))
    }

    func testTheTreeOpensToEveryFocusPathAndIntoAFocusedFolder() {
        let focus = ConchFileFocus(focus: ["src/app/setup.ts", "test", "README.md"], relativeTo: "/w")
        let directories: Set<String> = ["/w/src", "/w/src/app", "/w/test"]
        let open = focus.expanded(isDirectory: { directories.contains($0) })
        // The folders on the way, and the focused folder itself; never the root, whose listing is always shown.
        XCTAssertEqual(open, ["/w/src", "/w/src/app", "/w/test"])
        XCTAssertFalse(open.contains("/w"))
        // Opened, the rows the tree draws reach every focus path.
        let listings: [String: [ConchFileEntry]] = [
            "/w": [entry("/w/src", directory: true), entry("/w/test", directory: true), entry("/w/README.md")],
            "/w/src": [entry("/w/src/app", directory: true)],
            "/w/src/app": [entry("/w/src/app/setup.ts")],
            "/w/test": [entry("/w/test/a.test.ts")],
        ]
        let rows = ConchFileTree.rows(root: "/w", listings: listings, expanded: open)
        for path in focus.paths { XCTAssertTrue(rows.contains { $0.entry.path == path }, path) }
        XCTAssertEqual(rows.first { $0.entry.path == "/w/src/app/setup.ts" }?.depth, 2)
    }

    func testTheViewerOpensOnTheFirstFocusedFileThatIsThere() {
        let focus = ConchFileFocus(focus: ["test", "gone.ts", "src/setup.ts", "README.md"], relativeTo: "/w")
        let first = focus.firstFile(isDirectory: { $0 == "/w/test" }, exists: { $0 != "/w/gone.ts" })
        XCTAssertEqual(first, "/w/src/setup.ts")
        XCTAssertNil(ConchFileFocus(focus: ["test"], relativeTo: "/w").firstFile(isDirectory: { _ in true }, exists: { _ in true }))
    }

    // MARK: which folder the Files tab shows

    func testTheFilesTabPrefersTheFirstDeclaredFolderAndNeverShowsHome() {
        let home = "/Users/t"
        // Started in the home folder, declared a project: Files for the project. The session this was found in.
        XCTAssertEqual(ConchWorkFolder.pick(cwd: home, workDirs: ["/Users/t/Projects/Conch", "/Users/t/Projects/conch-design"], home: home), "/Users/t/Projects/Conch")
        // Started in the home folder, declared nothing: no tree of everything you own.
        XCTAssertNil(ConchWorkFolder.pick(cwd: home, workDirs: nil, home: home))
        XCTAssertNil(ConchWorkFolder.pick(cwd: "/Users/t/", workDirs: [], home: home))
        // Declared first, then started: a declared folder wins over where it started.
        XCTAssertEqual(ConchWorkFolder.pick(cwd: "/Users/t/Projects/A", workDirs: ["/Users/t/Projects/B"], home: home), "/Users/t/Projects/B")
        XCTAssertEqual(ConchWorkFolder.pick(cwd: "/Users/t/Projects/A", workDirs: nil, home: home), "/Users/t/Projects/A")
        // A declared home folder is skipped like a started one.
        XCTAssertEqual(ConchWorkFolder.pick(cwd: home, workDirs: [home, "/Users/t/Projects/X"], home: home), "/Users/t/Projects/X")
        XCTAssertNil(ConchWorkFolder.pick(cwd: nil, workDirs: nil, home: home))
        XCTAssertNil(ConchWorkFolder.pick(cwd: "  ", workDirs: [""], home: home))
    }

    // MARK: where it opens

    func testAFolderShowsInThePanelAndOpensOnlyThere() {
        let folder = URL(fileURLWithPath: "/w/module", isDirectory: true)
        XCTAssertTrue(ReviewScene.panelShowsContent(kind: .auto, deliverable: "folder", link: folder, fileExists: { _ in true }))
        // A folder that has gone since is as any gone file: not drawn in the panel.
        XCTAssertFalse(ReviewScene.panelShowsContent(kind: .auto, deliverable: "folder", link: folder, fileExists: { _ in false }))
        // Only conch draws its tree, as only conch draws marks: it opens in the panel from anywhere.
        XCTAssertTrue(ReviewScene.opensOnlyInConch(deliverable: "folder", marked: false))
        XCTAssertTrue(ReviewScene.opensOnlyInConch(deliverable: "page", marked: true))
        XCTAssertFalse(ReviewScene.opensOnlyInConch(deliverable: "page", marked: false))
        XCTAssertFalse(ReviewScene.opensOnlyInConch(deliverable: nil, marked: false))
    }

    func testTheRowSaysWhatItIsMarkedFor() {
        func said(_ entry: ConchFileEntry, focused: Bool = false, leads: Bool = false, changed: Bool = false, holds: Bool = false) -> String {
            ConchFileRowView(
                row: ConchFileRow(entry: entry, depth: 0), isSelected: false, isOpen: false, isChanged: changed,
                holdsChanges: holds, isFocused: focused, leadsToFocus: leads, font: { .system(size: $0, weight: $1) }, action: {}
            ).accessibilityLabel
        }
        XCTAssertEqual(said(entry("/w/setup.ts"), focused: true, changed: true), "setup.ts, pointed at by the agent, changed by this session")
        XCTAssertEqual(said(entry("/w/src", directory: true), leads: true, holds: true), "src, folder, holds what the agent pointed at, holds changed files")
        XCTAssertEqual(said(entry("/w/a.ts")), "a.ts")
    }
}
