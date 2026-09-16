import XCTest
@testable import ConchDesign

/// Grouping the session list by folder.
///
/// Every case here is one a healthy list never shows: the cases that matter are two checkouts
/// of one repo, a child whose folder differs from its parent's, and a daemon that never sends
/// a folder at all.
final class SessionGroupingTests: XCTestCase {
    private func folders(_ sessions: [(id: String, cwd: String?, parentID: String?)]) -> [SessionFolder] {
        SessionGrouping.folders(for: sessions)
    }

    func testFoldersKeepTheOrderTheRowsArrivedIn() {
        let grouped = folders([
            ("a", "/Users/t/Projects/conch", nil),
            ("b", "/Users/t/Projects/fieldnote-site", nil),
            ("c", "/Users/t/Projects/conch", nil),
        ])

        XCTAssertEqual(grouped.map(\.name), ["conch", "fieldnote-site"])
        XCTAssertEqual(grouped.first?.sessionIDs, ["a", "c"])
        XCTAssertEqual(grouped.last?.sessionIDs, ["b"])
    }

    /// Two checkouts of one repo are the case a last-component name gets wrong: both headers
    /// would read `conch` and the list would claim they are one project.
    func testTwoCheckoutsOfTheSameRepoAreToldApart() {
        let grouped = folders([
            ("a", "/Users/t/Projects/conch", nil),
            ("b", "/Users/t/work/conch", nil),
            ("c", "/Users/t/Projects/fieldnote-site", nil),
        ])

        XCTAssertEqual(grouped.map(\.name), ["Projects/conch", "work/conch", "fieldnote-site"])
    }

    /// A subagent is drawn indented under its parent. Grouping it by its own folder would tear
    /// it out from under the row it belongs to.
    func testAChildStaysWithItsParentEvenWhenItsOwnFolderDiffers() {
        let grouped = folders([
            ("parent", "/Users/t/Projects/conch", nil),
            ("child", "/Users/t/Projects/other", "parent"),
        ])

        XCTAssertEqual(grouped.count, 1)
        XCTAssertEqual(grouped.first?.name, "conch")
        XCTAssertEqual(grouped.first?.sessionIDs, ["parent", "child"])
    }

    func testAGrandchildFollowsTheWholeChainUp() {
        let grouped = folders([
            ("top", "/Users/t/Projects/conch", nil),
            ("mid", "/tmp/one", "top"),
            ("leaf", "/tmp/two", "mid"),
        ])

        XCTAssertEqual(grouped.map(\.sessionIDs), [["top", "mid", "leaf"]])
    }

    /// A parent that isn't in the list (dismissed, or another Mac's) is no parent: the row
    /// falls back to its own folder rather than disappearing into a group that isn't there.
    func testAMissingParentLeavesTheRowInItsOwnFolder() {
        let grouped = folders([
            ("orphan", "/Users/t/Projects/conch", "gone"),
        ])

        XCTAssertEqual(grouped.map(\.name), ["conch"])
    }

    /// Older daemons never send `cwd`: the whole list becomes one unnamed group, which is
    /// exactly today's flat list.
    func testADaemonThatSendsNoFolderLeavesOneUnnamedGroup() {
        let grouped = folders([("a", nil, nil), ("b", "", nil), ("c", "   ", nil)])

        XCTAssertEqual(grouped.count, 1)
        XCTAssertEqual(grouped.first?.name, "")
        XCTAssertEqual(grouped.first?.id, "")
        XCTAssertEqual(grouped.first?.sessionIDs, ["a", "b", "c"])
    }

    func testKnownAndUnknownFoldersCoexist() {
        let grouped = folders([
            ("a", "/Users/t/Projects/conch", nil),
            ("b", nil, nil),
        ])

        XCTAssertEqual(grouped.map(\.name), ["conch", ""])
    }

    func testTrailingSlashesAreTheSameFolder() {
        let grouped = folders([
            ("a", "/Users/t/Projects/conch/", nil),
            ("b", "/Users/t/Projects/conch", nil),
        ])

        XCTAssertEqual(grouped.count, 1)
        XCTAssertEqual(grouped.first?.sessionIDs, ["a", "b"])
    }

    func testTheRootFolderIsNamedForItself() {
        XCTAssertEqual(folders([("a", "/", nil)]).map(\.name), ["/"])
    }

    /// One path ending in another can't be told apart by any tail, so the full path shows.
    func testAPathThatEndsInAnotherFallsBackToTheWholePath() {
        let grouped = folders([
            ("a", "/a/b/c", nil),
            ("b", "/x/a/b/c", nil),
        ])

        XCTAssertEqual(grouped.map(\.name), ["/a/b/c", "x/a/b/c"])
    }

    /// A daemon that ever sent a parent cycle would hang the list rather than draw it.
    func testAParentCycleDoesNotHang() {
        let grouped = folders([
            ("a", "/Users/t/Projects/conch", "b"),
            ("b", "/Users/t/Projects/conch", "a"),
        ])

        XCTAssertEqual(grouped.count, 1)
        XCTAssertEqual(grouped.first?.sessionIDs, ["a", "b"])
    }
}
