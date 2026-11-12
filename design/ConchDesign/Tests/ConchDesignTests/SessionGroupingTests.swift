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

    // MARK: Reordering by drag

    private func folder(_ id: String) -> SessionFolder {
        SessionFolder(id: id, name: id, sessionIDs: [])
    }

    /// Folders the reader ordered come first in that order; the rest keep arrival order after.
    func testOrderedPutsTheChosenFoldersFirstAndTheRestAsTheyArrived() {
        let ordered = SessionGrouping.ordered(
            [folder("/a"), folder("/b"), folder("/c"), folder("/d")],
            by: ["/c", "/zzz-not-on-screen", "/a"]
        )

        XCTAssertEqual(ordered.map(\.id), ["/c", "/a", "/b", "/d"])
    }

    /// Dropping a folder onto another takes that folder's slot: down reaches the end, up
    /// reaches the top, and the folders between shift one toward the gap.
    func testDroppingOntoAFolderTakesItsSlot() {
        let visible = ["/a", "/b", "/c"]

        XCTAssertEqual(
            SessionGrouping.order([], moving: "/a", onto: "/c", visible: visible),
            ["/b", "/c", "/a"]
        )
        XCTAssertEqual(
            SessionGrouping.order([], moving: "/c", onto: "/a", visible: visible),
            ["/c", "/a", "/b"]
        )
        XCTAssertEqual(
            SessionGrouping.order([], moving: "/a", onto: "/a", visible: visible),
            visible
        )
    }

    /// A folder dragged last week keeps its slot: the stored order is never pruned to what
    /// is on screen, and newcomers join at the end in screen order before the move applies.
    func testAStoredSlotSurvivesFoldersComingAndGoing() {
        let stored = ["/old", "/a"]

        let next = SessionGrouping.order(stored, moving: "/new", onto: "/a", visible: ["/a", "", "/new"])

        XCTAssertEqual(next, ["/old", "/new", "/a"], "the unnamed folder has no header and is left out")
        XCTAssertEqual(
            SessionGrouping.ordered([folder("/new"), folder("/old"), folder("/a")], by: next).map(\.id),
            ["/old", "/new", "/a"]
        )
    }

    /// A daemon that ever sent a parent cycle would hang the list rather than draw it.
    // MARK: The Mac sidebar (`sidebar`): the rule the lagoon is sent too

    private func session(_ id: String, cwd: String?, workDirs: [String]? = nil, parent: String? = nil, startedBy: String? = nil) -> SessionGrouping.Session {
        SessionGrouping.Session(id: id, cwd: cwd, workDirs: workDirs, parentSessionId: parent, startedBySessionId: startedBy)
    }

    func testTheSidebarGroupsByTheWorkFolderElseWhereItStarted() {
        XCTAssertEqual(SessionGrouping.workFolder(cwd: "/a", workDirs: ["/b", "/c"]), "/b")
        XCTAssertEqual(SessionGrouping.workFolder(cwd: "/a", workDirs: []), "/a")
        XCTAssertEqual(SessionGrouping.workFolder(cwd: "/a", workDirs: nil), "/a")
        XCTAssertNil(SessionGrouping.workFolder(cwd: nil, workDirs: nil))
        let grouped = SessionGrouping.sidebar([
            session("a", cwd: "/Users/t", workDirs: ["/Users/t/Projects/lantern"]),
            session("b", cwd: "/Users/t/Projects/lantern"),
            session("c", cwd: "/Users/t/"),
            session("d", cwd: "/tmp/other", parent: "c"),
            session("e", cwd: "/Users/t/Projects/quay", startedBy: "a"),
            session("f", cwd: nil),
        ], home: "/Users/t", order: [])
        XCTAssertEqual(grouped.map(\.name), ["lantern", "Home", ""])
        XCTAssertEqual(grouped.map(\.sessionIDs), [["a", "b", "e"], ["c", "d"], ["f"]])
    }

    func testTheSidebarKeepsTheDraggedOrder() {
        let sessions = [session("a", cwd: "/w/one"), session("b", cwd: "/w/two"), session("c", cwd: "/w/three")]
        let stored = SessionGrouping.storedOrder("/w/three\n/w/gone\n/w/one")
        XCTAssertEqual(stored, ["/w/three", "/w/gone", "/w/one"])
        XCTAssertEqual(SessionGrouping.sidebar(sessions, home: "/Users/t", order: stored).map(\.name), ["three", "one", "two"])
        XCTAssertEqual(SessionGrouping.storedOrder(""), [])
        XCTAssertEqual(SessionGrouping.orderKey, "conch.folderOrder")
    }

    func testAParentCycleDoesNotHang() {
        let grouped = folders([
            ("a", "/Users/t/Projects/conch", "b"),
            ("b", "/Users/t/Projects/conch", "a"),
        ])

        XCTAssertEqual(grouped.count, 1)
        XCTAssertEqual(grouped.first?.sessionIDs, ["a", "b"])
    }

    // MARK: Teams (2026-11-12, Teams.swift)

    /// A team's builders each work in a worktree of their own: grouped by folder, one team scattered across as many
    /// headers as it had members. Its members leave their folders for the team's group, lead first, whatever order the
    /// rows came in; a folder left empty goes.
    func testATeamsMembersLeaveTheirFoldersForTheTeamsGroup() {
        let sessions = [
            session("other", cwd: "/w/app"),
            session("b1", cwd: "/w/app/.worktrees/one"),
            session("lead", cwd: "/w/app"),
            session("b2", cwd: "/w/app/.worktrees/two"),
            session("elsewhere", cwd: "/w/site"),
        ]
        let team = SessionGrouping.Team(id: "build-review-2", name: "Build + review", task: "Dark mode", memberSessionIDs: ["lead", "b1", "b2"])
        let grouped = SessionGrouping.sidebar(sessions, home: "/Users/t", order: [], teams: [team])
        XCTAssertEqual(grouped.map(\.id), ["/w/app", "team:build-review-2", "/w/site"])
        XCTAssertEqual(grouped.map(\.kind), [.folder, .team, .folder])
        XCTAssertEqual(grouped[0].sessionIDs, ["other"])
        XCTAssertEqual(grouped[1].sessionIDs, ["lead", "b1", "b2"], "the team's order, lead first")
        XCTAssertEqual(grouped[1].name, "Build + review")
        XCTAssertEqual(grouped[1].team, SessionFolder.TeamGroup(id: "build-review-2", name: "Build + review", task: "Dark mode"))
        XCTAssertNil(grouped[0].team)
        XCTAssertEqual(SessionGrouping.teamGroupID("x"), "team:x")
    }

    /// A team takes the slot its first session had, rather than jumping to the top, and is dragged as a folder is.
    func testATeamTakesTheSlotOfItsFirstSessionAndKeepsADraggedOne() {
        let sessions = [
            session("a", cwd: "/w/one"),
            session("m2", cwd: "/w/two"),
            session("c", cwd: "/w/three"),
            session("m1", cwd: "/w/four"),
        ]
        let team = SessionGrouping.Team(id: "t", name: "T", task: "", memberSessionIDs: ["m1", "m2"])
        XCTAssertEqual(SessionGrouping.sidebar(sessions, home: "/h", order: [], teams: [team]).map(\.id), ["/w/one", "team:t", "/w/three"])
        XCTAssertEqual(SessionGrouping.sidebar(sessions, home: "/h", order: ["team:t"], teams: [team]).map(\.id), ["team:t", "/w/one", "/w/three"])
        let moved = SessionGrouping.order([], moving: "team:t", onto: "/w/three", visible: ["/w/one", "team:t", "/w/three"])
        XCTAssertEqual(moved, ["/w/one", "/w/three", "team:t"])
    }

    /// A member's subagents and the sessions it started come with it; one started by a session outside the team stays
    /// with that session.
    func testAMembersChildrenFollowItIntoTheTeam() {
        let sessions = [
            session("lead", cwd: "/w/app"),
            session("agent", cwd: "/w/app", parent: "lead"),
            session("b1", cwd: "/w/wt"),
            session("started", cwd: "/w/elsewhere", startedBy: "b1"),
            session("solo", cwd: "/w/app"),
            session("solo-child", cwd: "/w/app", parent: "solo"),
        ]
        let team = SessionGrouping.Team(id: "t", name: "T", task: "", memberSessionIDs: ["lead", "b1"])
        let grouped = SessionGrouping.sidebar(sessions, home: "/h", order: [], teams: [team])
        XCTAssertEqual(grouped.map(\.id), ["team:t", "/w/app"])
        XCTAssertEqual(grouped[0].sessionIDs, ["lead", "agent", "b1", "started"])
        XCTAssertEqual(grouped[1].sessionIDs, ["solo", "solo-child"])
    }

    /// A team none of whose members has a row yet (all still starting), or one whose sessions have all gone, draws
    /// nothing; a member conch has no row for is skipped; a session two teams name is the first's.
    func testATeamWithNoListedMembersDrawsNothing() {
        let sessions = [session("a", cwd: "/w/one"), session("m", cwd: "/w/one")]
        let starting = SessionGrouping.Team(id: "s", name: "S", task: "", memberSessionIDs: ["gone"])
        let first = SessionGrouping.Team(id: "f", name: "F", task: "", memberSessionIDs: ["m", "not-yet"])
        let second = SessionGrouping.Team(id: "g", name: "G", task: "", memberSessionIDs: ["m"])
        let grouped = SessionGrouping.sidebar(sessions, home: "/h", order: [], teams: [starting, first, second])
        XCTAssertEqual(grouped.map(\.id), ["/w/one", "team:f"])
        XCTAssertEqual(grouped[1].sessionIDs, ["m"])
        XCTAssertEqual(SessionGrouping.sidebar(sessions, home: "/h", order: [], teams: [starting]),
                       SessionGrouping.sidebar(sessions, home: "/h", order: []), "no listed member: the folders as they were")
    }

    func testAParentCycleThroughATeamDoesNotHang() {
        let sessions = [session("a", cwd: "/w", parent: "b"), session("b", cwd: "/w", parent: "a"), session("m", cwd: "/w")]
        let team = SessionGrouping.Team(id: "t", name: "T", task: "", memberSessionIDs: ["m"])
        let grouped = SessionGrouping.sidebar(sessions, home: "/h", order: [], teams: [team])
        XCTAssertEqual(grouped.flatMap(\.sessionIDs).sorted(), ["a", "b", "m"])
    }
}
