import XCTest
@testable import ConchDesign

/// The working-folder tree, and the one thing it must never do: mark a file the agent did
/// not touch.
///
/// The daemon used to publish only a basename, so `shot.mjs` meant every `shot.mjs` in the
/// checkout. Marking by name would have been a confident claim about work that never
/// happened, which is why `ConchFileChanges` refuses a path it cannot resolve rather than
/// falling back to the root.
final class WorkspaceFilesTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("conch-files-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func make(_ relative: String, directory: Bool = false) throws {
        let url = root.appendingPathComponent(relative)
        if directory {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        } else {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try Data().write(to: url)
        }
    }

    // MARK: listing

    func testListsAFolderWithDirectoriesFirstAndCaseInsensitiveNames() throws {
        try make("src", directory: true)
        try make("Makefile")
        try make("main.swift")
        try make("assets", directory: true)

        let names = ConchFileTree.children(of: root.path).map(\.name)
        // Folders lead; then case-insensitive, so `Makefile` and `main.swift` are not in the
        // separate ASCII blocks a byte comparison would put them in.
        //
        // main.swift BEFORE Makefile, which looks wrong until you do the comparison: folded to
        // one case they are "main.swift" and "makefile", and they diverge at the third
        // character, where `i` precedes `k`. The capital M is not what orders these. Written
        // out because the first version of this expectation was the intuitive one, and it was
        // the test that was wrong rather than the sort.
        XCTAssertEqual(names, ["assets", "src", "main.swift", "Makefile"])
    }

    func testSkipsTheFoldersThatAreNeverTheWork() throws {
        try make("node_modules", directory: true)
        try make(".git", directory: true)
        try make("build", directory: true)
        try make("src", directory: true)

        XCTAssertEqual(ConchFileTree.children(of: root.path).map(\.name), ["src"])
    }

    /// Finder hides dotfiles; this must not. `.env` and `.gitignore` are exactly the files an
    /// agent edits, and hiding them would make the tree disagree with the change rows.
    func testKeepsDotfilesButDropsFinderNoise() throws {
        try make(".env")
        try make(".gitignore")
        try make(".DS_Store")

        XCTAssertEqual(ConchFileTree.children(of: root.path).map(\.name), [".env", ".gitignore"])
    }

    func testSkippedFoldersAreSkippedAtEveryDepth() throws {
        try make("packages/app/node_modules", directory: true)
        try make("packages/app/src", directory: true)

        let nested = ConchFileTree.children(of: root.appendingPathComponent("packages/app").path)
        XCTAssertEqual(nested.map(\.name), ["src"])
    }

    func testAnUnreadableFolderIsEmptyRatherThanAFailure() {
        XCTAssertEqual(ConchFileTree.children(of: root.appendingPathComponent("nope").path), [])
    }

    // MARK: resolving what changed

    func testResolvesAbsoluteAndRelativePathsAgainstTheSessionFolder() {
        let changes = ConchFileChanges(
            changed: ["/tmp/app/card.tsx", "src/view.swift"],
            relativeTo: "/tmp/app"
        )
        XCTAssertEqual(changes.paths, ["/tmp/app/card.tsx", "/tmp/app/src/view.swift"])
    }

    /// The bug this type exists to prevent. A bare name cannot be located, and resolving it
    /// against the root would mark a file at the top of the checkout that nobody edited.
    func testRefusesABareBasenameRatherThanGuessingAtTheRoot() {
        let changes = ConchFileChanges(changed: ["shot.mjs"], relativeTo: "/tmp/app")
        XCTAssertTrue(changes.isEmpty, "a basename must resolve to nothing, not to the root")
    }

    func testMarksTheChangedFileAndEveryFolderAboveIt() {
        let changes = ConchFileChanges(changed: ["/tmp/app/src/view.swift"], relativeTo: "/tmp/app")
        let file = ConchFileEntry(path: "/tmp/app/src/view.swift", name: "view.swift", isDirectory: false)
        let folder = ConchFileEntry(path: "/tmp/app/src", name: "src", isDirectory: true)

        XCTAssertTrue(changes.changed(file))
        XCTAssertTrue(changes.contains(folder), "the path to the work should be visible unopened")
        XCTAssertFalse(changes.changed(folder), "a folder is not itself an edited file")
    }

    /// Without the separator, `/src/app` would claim `/src/application.ts` and mark a folder
    /// that holds none of the work.
    func testAFolderDoesNotClaimASiblingThatSharesItsPrefix() {
        let changes = ConchFileChanges(changed: ["/tmp/application.ts"], relativeTo: "/tmp")
        let folder = ConchFileEntry(path: "/tmp/app", name: "app", isDirectory: true)
        XCTAssertFalse(changes.contains(folder))
    }

    func testStandardizesDotSegmentsAndTrailingSlashes() {
        XCTAssertEqual(ConchFileTree.standardized("/tmp/app/./src/"), "/tmp/app/src")
        XCTAssertEqual(ConchFileTree.standardized("/tmp/app/x/../src"), "/tmp/app/src")
        let changes = ConchFileChanges(changed: ["./src/view.swift"], relativeTo: "/tmp/app/")
        XCTAssertEqual(changes.paths, ["/tmp/app/src/view.swift"])
    }

    func testNoChangesMarksNothing() {
        let changes = ConchFileChanges(changed: [], relativeTo: "/tmp/app")
        XCTAssertTrue(changes.isEmpty)
        XCTAssertFalse(changes.changed(ConchFileEntry(path: "/tmp/app/a.ts", name: "a.ts", isDirectory: false)))
    }
}

extension WorkspaceFilesTests {
    private func entry(_ path: String, _ name: String, dir: Bool = false) -> ConchFileEntry {
        ConchFileEntry(path: path, name: name, isDirectory: dir)
    }

    private var listings: [String: [ConchFileEntry]] {
        [
            "/w": [entry("/w/src", "src", dir: true), entry("/w/a.ts", "a.ts")],
            "/w/src": [entry("/w/src/deep", "deep", dir: true), entry("/w/src/b.ts", "b.ts")],
            "/w/src/deep": [entry("/w/src/deep/c.ts", "c.ts")],
        ]
    }

    func testAClosedTreeIsJustTheRootsOwnChildren() {
        let rows = ConchFileTree.rows(root: "/w", listings: listings, expanded: [])
        XCTAssertEqual(rows.map(\.entry.name), ["src", "a.ts"])
        XCTAssertEqual(rows.map(\.depth), [0, 0])
    }

    func testOpenFoldersContributeTheirChildrenInPlaceAtTheRightDepth() {
        let rows = ConchFileTree.rows(
            root: "/w", listings: listings, expanded: ["/w/src", "/w/src/deep"]
        )
        // Children sit directly under their parent, not appended after the siblings.
        XCTAssertEqual(rows.map(\.entry.name), ["src", "deep", "c.ts", "b.ts", "a.ts"])
        XCTAssertEqual(rows.map(\.depth), [0, 1, 2, 1, 0])
    }

    /// A folder opened before its listing arrives must not stall the tree; its rows appear a
    /// frame later instead.
    func testAnOpenFolderWithNoListingYetContributesNothing() {
        let rows = ConchFileTree.rows(
            root: "/w", listings: ["/w": listings["/w"]!], expanded: ["/w/src"]
        )
        XCTAssertEqual(rows.map(\.entry.name), ["src", "a.ts"])
    }

    /// Expanding a FILE is meaningless and must not recurse into a listing that shares its
    /// path by accident.
    func testAnExpandedFileIsNotWalked() {
        let rows = ConchFileTree.rows(
            root: "/w", listings: listings, expanded: ["/w/a.ts"]
        )
        XCTAssertEqual(rows.map(\.entry.name), ["src", "a.ts"])
    }

    func testTheRootIsStandardizedSoATrailingSlashStillFindsItsListing() {
        let rows = ConchFileTree.rows(root: "/w/", listings: listings, expanded: [])
        XCTAssertEqual(rows.map(\.entry.name), ["src", "a.ts"])
    }
}
