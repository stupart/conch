import XCTest
@testable import ConchDesign

/// Tyler's own groups and order in the session list (2026-11-12, "would also love to drag and drop for organization").
///
/// The cases that matter are the ones a tidy list never shows: a group whose sessions have all closed, a session that
/// comes back with its id, a subagent or a started session going with the one above it, a drop on another folder,
/// and a group deleted out from under its sessions.
final class SidebarLayoutTests: XCTestCase {
    private let home = "/Users/t"
    private let conch = "/Users/t/Projects/conch"
    private let site = "/Users/t/Projects/site"

    private func session(_ id: String, _ cwd: String?, parent: String? = nil, startedBy: String? = nil) -> SessionGrouping.Session {
        SessionGrouping.Session(id: id, cwd: cwd, workDirs: nil, parentSessionId: parent, startedBySessionId: startedBy)
    }

    private var sessions: [SessionGrouping.Session] {
        [
            session("a", conch),
            session("b", site),
            session("c", conch),
            session("a-agent", conch, parent: "a"),
            session("d", site),
            session("c-started", "/tmp", startedBy: "c"),
        ]
    }

    private func shown(_ layout: SidebarLayout, order: [String] = []) -> [SessionFolder] {
        SessionGrouping.sidebar(sessions, home: home, order: order, layout: layout)
    }

    private var top: Set<String> { SessionGrouping.topLevel(sessions) }

    func testAnEmptyLayoutIsTheFolderListExactlyAsBefore() {
        XCTAssertEqual(shown(.empty, order: [site]), SessionGrouping.sidebar(sessions, home: home, order: [site]))
        XCTAssertEqual(shown(.empty).map(\.id), [conch, site])
    }

    func testANewGroupFromARowsMenuSitsAboveItsSectionWithTheSessionAndItsFamilyInIt() {
        let layout = SidebarLayout.empty.creatingGroup(named: " Harbor ", id: "group:d", placing: "c", shown: shown(.empty))
        let list = shown(layout)
        XCTAssertEqual(list.map(\.id), ["group:d", conch, site])
        XCTAssertEqual(list[0].name, "Harbor")
        XCTAssertTrue(list[0].isGroup)
        // The session it started goes with it, though its own folder is /tmp.
        XCTAssertEqual(list[0].sessionIDs, ["c", "c-started"])
        XCTAssertEqual(list[1].sessionIDs, ["a", "a-agent"])
        XCTAssertEqual(layout.sections, ["group:d", conch, site])
    }

    /// A running team is one kind of section beside Tyler's groups and the folders: its members stay under it, lead
    /// first, whatever group one was put in; its header takes a place in his order; and its rows offer no moves.
    func testARunningTeamIsOneSectionBesideTheGroupsAndKeepsItsMembers() {
        let team = SessionGrouping.Team(id: "t1", name: "Build + review", task: "Ship the sidebar", memberSessionIDs: ["c", "b"])
        var layout = SidebarLayout.empty.creatingGroup(named: "Harbor", id: "group:h", placing: "c", shown: shown(.empty))
        layout.sections = [SessionGrouping.teamGroupID("t1"), "group:h", conch, site]
        let list = SessionGrouping.sidebar(sessions, home: home, order: [], layout: layout, teams: [team])
        XCTAssertEqual(list.map(\.id), [SessionGrouping.teamGroupID("t1"), "group:h", conch, site])
        // The lead first, the session it started under it; the group it was placed in stays, empty, to drop into.
        XCTAssertEqual(list[0].sessionIDs, ["c", "c-started", "b"])
        XCTAssertEqual(list[0].team, SessionFolder.TeamGroup(id: "t1", name: "Build + review", task: "Ship the sidebar"))
        XCTAssertEqual(list[1].sessionIDs, [])
        XCTAssertEqual(list[3].sessionIDs, ["d"])
        XCTAssertEqual(SidebarMove.moves(for: "c", layout: layout, shown: list, topLevel: top, folder: nil), [])
        // Never dropped into: a team's id is neither a group nor a folder.
        XCTAssertFalse(layout.accepts("a", into: SessionGrouping.teamGroupID("t1"), folder: conch))
        // The team ended: the placement it was holding back applies again.
        XCTAssertEqual(SessionGrouping.sidebar(sessions, home: home, order: [], layout: layout).first(where: { $0.id == "group:h" })?.sessionIDs, ["c", "c-started"])
    }

    func testAGroupWhoseSessionsAllClosedStaysAsAPlaceToDropInto() {
        let layout = SidebarLayout.empty.creatingGroup(named: "Later", id: "group:l", shown: shown(.empty))
        XCTAssertEqual(shown(layout).first, SessionFolder(id: "group:l", name: "Later", sessionIDs: []))
        // A placement for a session not running now is kept for when it is back.
        let placed = layout.moving("gone", into: "group:l", before: nil, shown: shown(layout), topLevel: top)
        XCTAssertEqual(placed.placements["gone"], "group:l")
        XCTAssertEqual(shown(placed).first?.sessionIDs, [])
    }

    func testDraggingWithinASectionKeepsTheRestWhereTheyAreAndFamiliesTogether() {
        let moved = SidebarLayout.empty.moving("c", into: conch, before: "a", shown: shown(.empty), topLevel: top)
        XCTAssertNil(moved.placements["c"])
        XCTAssertEqual(moved.rows[conch], ["c", "a"])
        XCTAssertEqual(shown(moved).first { $0.id == conch }?.sessionIDs, ["c", "c-started", "a", "a-agent"])
        // A session that arrives later goes after the ones he placed.
        let later = sessions + [session("e", conch)]
        XCTAssertEqual(SessionGrouping.sidebar(later, home: home, order: [], layout: moved).first { $0.id == conch }?.sessionIDs,
                       ["c", "c-started", "a", "a-agent", "e"])
    }

    func testOnlyAGroupOrTheSessionsOwnFolderAcceptsIt() {
        let layout = SidebarLayout.empty.creatingGroup(named: "Harbor", id: "group:d", shown: shown(.empty))
        let folders = SessionGrouping.homeFolders(sessions, home: home)
        XCTAssertTrue(layout.accepts("a", into: "group:d", folder: folders["a"]?.id))
        XCTAssertTrue(layout.accepts("a", into: conch, folder: folders["a"]?.id))
        XCTAssertFalse(layout.accepts("a", into: site, folder: folders["a"]?.id))
        XCTAssertFalse(layout.accepts("a", into: "group:gone", folder: folders["a"]?.id))
    }

    func testBackToItsFolderUndoesThePlacement() {
        let placed = SidebarLayout.empty.creatingGroup(named: "Harbor", id: "group:d", placing: "b", shown: shown(.empty))
        // Made from b's row, the group sits just above b's folder.
        XCTAssertEqual(shown(placed).map(\.id), [conch, "group:d", site])
        XCTAssertEqual(shown(placed).first { $0.id == "group:d" }?.sessionIDs, ["b"])
        let back = placed.moving("b", into: site, before: "d", shown: shown(placed), topLevel: top)
        XCTAssertNil(back.placements["b"])
        XCTAssertEqual(shown(back).first { $0.id == site }?.sessionIDs, ["b", "d"])
        XCTAssertEqual(back.rows["group:d"], [])
    }

    func testDeletingAGroupSendsItsSessionsHomeAndLeavesTheRest() {
        var layout = SidebarLayout.empty.creatingGroup(named: "Harbor", id: "group:d", placing: "a", shown: shown(.empty))
        layout = layout.moving("d", into: site, before: "b", shown: shown(layout), topLevel: top)
        let deleted = layout.deletingGroup("group:d")
        XCTAssertEqual(deleted.groups, [])
        XCTAssertNil(deleted.placements["a"])
        XCTAssertNil(deleted.rows["group:d"])
        XCTAssertFalse(deleted.sections.contains("group:d"))
        XCTAssertEqual(shown(deleted).first { $0.id == site }?.sessionIDs, ["d", "b"])
        XCTAssertEqual(shown(deleted).first { $0.id == conch }?.sessionIDs.first, "a")
    }

    func testNamesAreRequiredShortAndOneEach() {
        let layout = SidebarLayout.empty.creatingGroup(named: "Harbor", id: "group:d", shown: shown(.empty))
        XCTAssertNotNil(layout.nameProblem("  "))
        XCTAssertNotNil(layout.nameProblem(String(repeating: "x", count: 61)))
        XCTAssertEqual(layout.nameProblem("harbor"), "There's already a group called harbor.")
        XCTAssertNil(layout.nameProblem("Harbor", renaming: "group:d"))
        XCTAssertEqual(layout.creatingGroup(named: "HARBOR", shown: shown(layout)), layout)
        XCTAssertEqual(layout.renamingGroup("group:d", to: " Site ").group("group:d")?.name, "Site")
        XCTAssertEqual(layout.renamingGroup("group:d", to: ""), layout)
    }

    func testMoveUpAndDownStepOneFamilyAtATime() {
        let down = SidebarLayout.empty.nudging("a", by: 1, shown: shown(.empty), topLevel: top)
        XCTAssertEqual(shown(down).first { $0.id == conch }?.sessionIDs, ["c", "c-started", "a", "a-agent"])
        let up = down.nudging("a", by: -1, shown: shown(down), topLevel: top)
        XCTAssertEqual(shown(up).first { $0.id == conch }?.sessionIDs, ["a", "a-agent", "c", "c-started"])
        // Already at the top: nothing changes.
        XCTAssertEqual(up.nudging("a", by: -1, shown: shown(up), topLevel: top), up)
    }

    func testSectionsMoveByTheirHeadersAndTheMacsOldFolderOrderStandsInUntilThen() {
        let layout = SidebarLayout.empty.movingSection(site, onto: conch, shown: shown(.empty, order: []), fallbackOrder: [])
        XCTAssertEqual(shown(layout).map(\.id), [site, conch])
        // A list with no order of its own yet is drawn in the Mac's (`SessionGrouping.orderKey`), and a first change
        // freezes that order rather than the arrival one.
        let grouped = SidebarLayout.empty.creatingGroup(named: "G", id: "group:g", shown: shown(.empty, order: [site]), fallbackOrder: [site])
        XCTAssertEqual(grouped.sections, ["group:g", site, conch])
    }

    func testTheMenuOffersEveryOtherGroupAWayHomeANewGroupAndRoomToMove() {
        var layout = SidebarLayout.empty.creatingGroup(named: "Harbor", id: "group:d", placing: "a", shown: shown(.empty))
        layout = layout.creatingGroup(named: "Site", id: "group:s", shown: shown(layout))
        let folders = SessionGrouping.homeFolders(sessions, home: home)
        let placed = SidebarMove.moves(for: "a", layout: layout, shown: shown(layout), topLevel: top, folder: folders["a"])
        XCTAssertEqual(placed.map(\.title), ["Site", "Back to conch", "New Group…"])
        let unplaced = SidebarMove.moves(for: "c", layout: layout, shown: shown(layout), topLevel: top, folder: folders["c"])
        XCTAssertEqual(unplaced.map(\.title), ["Harbor", "Site", "New Group…"])
        let first = SidebarMove.moves(for: "b", layout: layout, shown: shown(layout), topLevel: top, folder: folders["b"])
        XCTAssertEqual(first.map(\.kind).suffix(1), [.down])
        // A subagent moves with its session and has no menu of its own.
        XCTAssertEqual(SidebarMove.moves(for: "a-agent", layout: layout, shown: shown(layout), topLevel: top, folder: nil), [])
    }

    func testALayoutAnAppCantFullyReadStillDraws() throws {
        let json = #"{"v":1,"groups":[{"id":"group:d","name":"Harbor"}],"placements":{"a":"group:d"},"rows":7}"#
        let layout = try JSONDecoder().decode(SidebarLayout.self, from: Data(json.utf8))
        XCTAssertEqual(layout.groups.map(\.name), ["Harbor"])
        XCTAssertEqual(layout.rows, [:])
        XCTAssertEqual(layout.sections, [])
        XCTAssertEqual(shown(layout).first?.sessionIDs, ["a", "a-agent"])
    }

    func testPlacementsAreCappedKeepingTheOnesOnScreen() {
        var layout = SidebarLayout(groups: [SidebarLayout.Group(id: "group:d", name: "D")])
        for index in 0..<SidebarLayout.maxPlacements { layout.placements["old-\(index)"] = "group:d" }
        let moved = layout.moving("a", into: "group:d", before: nil, shown: shown(layout), topLevel: top)
        XCTAssertEqual(moved.placements.count, SidebarLayout.maxPlacements)
        XCTAssertEqual(moved.placements["a"], "group:d")
    }
}
