import XCTest
@testable import ConchDesign

/// Which session the workspace is on, and what it remembers about each one.
///
/// None of this needs a window, which is the point: the failures worth testing here are the
/// ones a screenshot cannot show — a name matched instead of an identity, a fallback chain
/// quietly moving the reader, a page lost because they looked at something else for a moment.
@MainActor
final class WorkspaceTests: XCTestCase {
    private func workspace(_ sessions: [WorkspaceSession], voice: Bool = false) -> Workspace {
        Workspace(sessions: sessions, voiceIsActive: voice)
    }

    // MARK: - Which page of the stage

    func testASessionStartsOnTheConversation() {
        XCTAssertEqual(SessionPresentation().stage, .conversation)
        XCTAssertTrue(SessionPresentation().showsConversation)
    }

    /// Side by side shows BOTH, so anything asking "is the conversation up" gets the truth.
    /// That is the whole reason the old Bool could not grow a third case.
    func testSideBySideStillShowsTheConversation() {
        XCTAssertTrue(SessionPresentation(stage: .sideBySide).showsConversation)
        XCTAssertFalse(SessionPresentation(stage: .deliverable).showsConversation)
    }

    /// One door, so a page cannot be set two ways that could disagree.
    func testOneDoorMovesTheStage() {
        let model = WorkspaceModel()
        model.show(stage: .deliverable, for: "a")
        XCTAssertEqual(model.presentation(for: "a").stage, .deliverable)
        XCTAssertFalse(model.presentation(for: "a").showsConversation)
        model.show(stage: .conversation, for: "a")
        XCTAssertEqual(model.presentation(for: "a").stage, .conversation)
        XCTAssertTrue(model.presentation(for: "a").showsConversation)
    }

    // MARK: - Which deliverable a session is showing

    func testTheNewestIsShownUntilSomebodyPicks() {
        XCTAssertEqual(SessionPresentation.shown(in: ["a", "b", "c"], picked: nil), "c")
        XCTAssertEqual(SessionPresentation.shown(in: ["a"], picked: nil), "a")
        XCTAssertNil(SessionPresentation.shown(in: [], picked: nil))
    }

    func testAPickWinsWhileItIsStillHeld() {
        XCTAssertEqual(SessionPresentation.shown(in: ["a", "b", "c"], picked: "a"), "a")
    }

    /// The per-session cap drops the oldest, and a session can move on. Neither should leave
    /// the reader looking at an empty pane where a deliverable used to be.
    func testAPickThatFellOffTheEndIsNoPick() {
        XCTAssertEqual(SessionPresentation.shown(in: ["b", "c"], picked: "a"), "c")
        XCTAssertNil(SessionPresentation.shown(in: [], picked: "a"))
    }

    func testPickingIsRememberedPerSessionAndOnlyMovesWhenAsked() {
        let model = WorkspaceModel()
        model.select(deliverable: "a", for: "session-1")
        XCTAssertEqual(model.presentation(for: "session-1").selectedDeliverable, "a")
        // Another session is untouched: a tab picked in one is not a tab picked in all.
        XCTAssertNil(model.presentation(for: "session-2").selectedDeliverable)
        model.select(deliverable: nil, for: "session-1")
        XCTAssertNil(model.presentation(for: "session-1").selectedDeliverable)
    }

    // MARK: - Which deliverables are one artifact

    private func version(_ id: String, _ link: String?) -> DeliverableVersion {
        DeliverableVersion(id: id, link: link)
    }

    /// Measured on 2026-09-20: a session held six deliverables, every one the same link. That
    /// is one artifact with six versions, newest first, not six tabs.
    func testTheSameLinkIsOneArtifactWithItsVersionsNewestFirst() {
        let groups = DeliverableGroups.grouped([
            version("v1", "https://x/asset"), version("v2", "https://x/asset"), version("v3", "https://x/asset"),
        ])
        XCTAssertEqual(groups.map(\.id), ["https://x/asset"])
        XCTAssertEqual(groups[0].versions, ["v3", "v2", "v1"])
        XCTAssertEqual(groups[0].newest, "v3")
        XCTAssertTrue(groups[0].hasOlderVersions)
    }

    /// The session holding two distinct deliverables must be left exactly as it is today.
    func testDistinctLinksStayDistinctInTheOrderTheyWereFiled() {
        let groups = DeliverableGroups.grouped([version("a", "https://x/a"), version("b", "https://x/b")])
        XCTAssertEqual(groups.map(\.id), ["https://x/a", "https://x/b"])
        XCTAssertEqual(groups.map(\.versions), [["a"], ["b"]])
        XCTAssertFalse(groups.contains(where: \.hasOlderVersions))
    }

    /// A group sits where its NEWEST version does, so the strip's ages run in one direction.
    func testARepublishedArtifactMovesToTheNewEnd() {
        let groups = DeliverableGroups.grouped([
            version("a1", "https://x/a"), version("b1", "https://x/b"), version("a2", "https://x/a"),
        ])
        XCTAssertEqual(groups.map(\.id), ["https://x/b", "https://x/a"])
        XCTAssertEqual(groups[1].versions, ["a2", "a1"])
    }

    /// Nothing says two linkless deliverables are the same thing, so each stands alone — and a
    /// blank link is no link. Whitespace around a real link is not a different artifact.
    func testNoLinkNeverGroupsAndTrimmedLinksDo() {
        let groups = DeliverableGroups.grouped([
            version("n1", nil), version("n2", ""), version("n3", "  "),
            version("l1", "https://x/l"), version("l2", " https://x/l\n"),
        ])
        XCTAssertEqual(groups.map(\.id), ["n1", "n2", "n3", "https://x/l"])
        XCTAssertEqual(groups[3].versions, ["l2", "l1"])
    }

    /// The tab stands for the pick while it is one of its own versions; another group's pick,
    /// or one the per-session cap has dropped, leaves it on the newest.
    func testTheTabStandsForItsOwnPickElseTheNewest() {
        let group = DeliverableGroup(id: "https://x/a", versions: ["a2", "a1"])
        XCTAssertEqual(group.shown(picked: "a1"), "a1")
        XCTAssertEqual(group.shown(picked: nil), "a2")
        XCTAssertEqual(group.shown(picked: "b1"), "a2")
        XCTAssertEqual(group.shown(picked: "a0"), "a2")
    }

    // MARK: - Target resolution and its fallbacks

    func testThePickWinsOverEveryFallback() {
        let space = workspace(
            [
                WorkspaceSession(id: "reading"),
                WorkspaceSession(id: "talking", isLive: true),
                WorkspaceSession(id: "working", isActive: true),
            ],
            voice: true
        )
        XCTAssertEqual(WorkspaceFocus.viewed(in: space, pinned: "reading"), "reading")
        XCTAssertEqual(WorkspaceFocus.target(in: space, pinned: "reading"), "reading")
    }

    func testWithNoPickTheChainIsVoiceThenActiveThenReplyThenCursorThenFirst() {
        let all = [
            WorkspaceSession(id: "first"),
            WorkspaceSession(id: "cursor", isNavSelected: true),
            WorkspaceSession(id: "replied", isReplying: true),
            WorkspaceSession(id: "working", isActive: true),
            WorkspaceSession(id: "talking", isLive: true),
        ]
        XCTAssertEqual(WorkspaceFocus.viewed(in: workspace(all, voice: true), pinned: nil), "talking")
        // The voice at rest addresses nobody, so the work decides.
        XCTAssertEqual(WorkspaceFocus.viewed(in: workspace(all), pinned: nil), "working")
        XCTAssertEqual(
            WorkspaceFocus.viewed(in: workspace(Array(all.prefix(3))), pinned: nil),
            "replied"
        )
        XCTAssertEqual(
            WorkspaceFocus.viewed(in: workspace(Array(all.prefix(2))), pinned: nil),
            "cursor"
        )
        XCTAssertEqual(
            WorkspaceFocus.viewed(in: workspace(Array(all.prefix(1))), pinned: nil),
            "first"
        )
        XCTAssertNil(WorkspaceFocus.viewed(in: workspace([]), pinned: nil), "nothing to look at")
    }

    /// A pick that no longer names a session is not a pick. Left standing it would pin the
    /// pane to a session that has ended.
    func testAPickForASessionThatIsGoneFallsBackRatherThanSticking() {
        let space = workspace([WorkspaceSession(id: "working", isActive: true)])
        XCTAssertEqual(WorkspaceFocus.viewed(in: space, pinned: "closed"), "working")

        let model = WorkspaceModel(viewing: "closed")
        model.forget(missing: ["working"])
        XCTAssertNil(model.viewing)
        XCTAssertEqual(model.viewed(in: space), "working")
    }

    /// The bug this whole extraction is about: two sessions can carry the same name, and a
    /// name can be changed at any moment, so nothing here may resolve by one. The live row
    /// says which session the microphone is on; identity decides, position never does.
    func testTheVoiceIsResolvedByIdentityEvenWhenNamesCollide() {
        let space = workspace(
            [
                WorkspaceSession(id: "conch-1"),
                WorkspaceSession(id: "conch-2", isLive: true),
            ],
            voice: true
        )
        XCTAssertEqual(WorkspaceFocus.addressed(in: space), "conch-2")
        XCTAssertTrue(WorkspaceFocus.isAddressed("conch-2", in: space))
        XCTAssertFalse(WorkspaceFocus.isAddressed("conch-1", in: space))
    }

    /// conch speaks for sessions. A subagent's name is a task description, not an address
    /// (C4), and there is no composer on its pane to type into either.
    func testASubagentIsNeverTheVoicesSessionAndNeverAMessageTarget() {
        let space = workspace(
            [
                WorkspaceSession(id: "agent", parentID: "parent", isLive: true, isActive: true),
                WorkspaceSession(id: "parent", isReplying: true),
            ],
            voice: true
        )
        XCTAssertEqual(WorkspaceFocus.addressed(in: space), "parent")
        // Opened deliberately, it is still what you are looking at — with nowhere to type.
        XCTAssertEqual(WorkspaceFocus.viewed(in: space, pinned: "agent"), "agent")
        XCTAssertNil(WorkspaceFocus.target(in: space, pinned: "agent"))
    }

    // MARK: - The four questions may have different answers

    /// Dictating to one session while reading another is the normal case, not a glitch:
    /// transcription takes seconds, and people look elsewhere while it runs.
    func testTheVoicesSessionAndTheViewedOneAreAllowedToDiffer() {
        let space = workspace(
            [
                WorkspaceSession(id: "reading"),
                WorkspaceSession(id: "dictating", isLive: true),
            ],
            voice: true
        )
        let model = WorkspaceModel(viewing: "reading")
        XCTAssertEqual(model.viewed(in: space), "reading")
        XCTAssertEqual(model.addressed(in: space), "dictating")
        // What you type goes where you are looking; what you say goes where you said it.
        XCTAssertEqual(model.target(in: space), "reading")
    }

    // MARK: - Per-session presentation

    /// The PAGE follows you now (Tyler, 2026-09-20: "preserve the view your on when you go
    /// between conversations"), which reverses the half of this test that asserted each session
    /// kept its own. The other half stands and is the point of keeping it: open TOOL ROWS are
    /// still per session. A page is how you are reading; an opened row is a thing you opened in
    /// one particular transcript, and carrying those would litter the next one.
    func testTheOpenRowsStayPerSessionEvenThoughThePageFollows() {
        // Viewing "a" to begin with, because that is the only state the carry means anything
        // in: with nothing selected there is no view you are ON to preserve, and the carry
        // correctly refuses. The app always has a session selected before you switch.
        let model = WorkspaceModel(viewing: "a")
        model.show(stage: .deliverable, for: "a")
        model.toggleTool("tool-1", for: "a")

        model.viewing = "b"
        XCTAssertFalse(model.presentation(for: "b").showsConversation, "the page came with you")
        XCTAssertFalse(model.isToolExpanded("tool-1", for: "b"), "but its own open rows did not")

        model.viewing = "a"
        XCTAssertTrue(model.isToolExpanded("tool-1", for: "a"), "and a's rows are still a's")
    }

    /// The continuity violation the review named: a newly filed artifact used to set the pane
    /// back to the conversation, which takes someone off the deliverable they are inspecting.
    /// Nothing but an explicit choice moves this now — an arriving artifact is not a choice.
    func testANewArtifactDoesNotChangeTheChosenView() {
        let model = WorkspaceModel()
        model.show(stage: .deliverable, for: "a")

        // Everything an arriving artifact does to this model: nothing. The session republishes,
        // the reader stays on the page they opened.
        let space = workspace([WorkspaceSession(id: "a", isActive: true)])
        XCTAssertEqual(model.viewed(in: space), "a")
        XCTAssertFalse(model.presentation(for: "a").showsConversation)

        // And the way back is the control, which does move it.
        model.show(stage: .conversation, for: "a")
        XCTAssertTrue(model.presentation(for: "a").showsConversation)
    }

    func testAnOpenedToolRowClosesAgain() {
        let model = WorkspaceModel()
        model.toggleTool("tool-1", for: "a")
        XCTAssertTrue(model.isToolExpanded("tool-1", for: "a"))
        model.toggleTool("tool-1", for: "a")
        XCTAssertFalse(model.isToolExpanded("tool-1", for: "a"))
    }
}

extension WorkspaceTests {
    /// The work half is a SECOND axis, not a fourth page. If it were a StageMode case,
    /// `showsConversation` would have to guess at it and "the files, side by side" could not
    /// be expressed at all.
    func testTheWorkHalfDefaultsToTheDeliverableAndIsIndependentOfTheStage() {
        XCTAssertEqual(SessionPresentation().work, .deliverable)
        XCTAssertTrue(SessionPresentation(stage: .sideBySide, work: .files).showsConversation)
        XCTAssertFalse(SessionPresentation(stage: .deliverable, work: .files).showsConversation)
    }

    func testAskingForTheFilesKeepsTheStageYouWereOn() {
        let model = WorkspaceModel()
        model.show(stage: .sideBySide, for: "a")
        model.show(work: .files, for: "a")

        XCTAssertEqual(model.presentation(for: "a").work, .files)
        XCTAssertEqual(model.presentation(for: "a").stage, .sideBySide, "the axes must not move each other")
    }

    func testTheWorkHalfIsRememberedPerSession() {
        let model = WorkspaceModel()
        model.show(work: .files, for: "a")

        XCTAssertEqual(model.presentation(for: "a").work, .files)
        XCTAssertEqual(model.presentation(for: "b").work, .deliverable, "b has its own default")
    }
}

extension WorkspaceTests {
    /// The page follows you between conversations, rather than each session yanking you back
    /// to whatever it was last left on mid-comparison.
    func testThePageFollowsYouToTheNextConversation() {
        let model = WorkspaceModel(viewing: "a")
        model.show(stage: .sideBySide, for: "a")
        model.viewing = "b"

        XCTAssertEqual(model.presentation(for: "b").stage, .sideBySide)
        XCTAssertEqual(model.presentation(for: "a").stage, .sideBySide, "and the one you left is unchanged")
    }

    func testTheWorkHalfFollowsTooSoASplitKeepsShowingTheSameKindOfThing() {
        let model = WorkspaceModel(viewing: "a")
        model.show(stage: .sideBySide, for: "a")
        model.show(work: .terminal, for: "a")
        model.viewing = "b"

        XCTAssertEqual(model.presentation(for: "b").work, .terminal)
    }

    /// Storage stays per session: this seeds on ARRIVAL, it does not make one global page.
    func testClearingTheSelectionCarriesNothing() {
        let model = WorkspaceModel(viewing: "a")
        model.show(stage: .deliverable, for: "a")
        model.viewing = nil

        XCTAssertEqual(model.presentation(for: "a").stage, .deliverable)
    }

    func testReturningToTheSameSessionIsNotACarry() {
        let model = WorkspaceModel(viewing: "a")
        model.show(stage: .deliverable, for: "a")
        model.viewing = "a"

        XCTAssertEqual(model.presentation(for: "a").stage, .deliverable)
    }
}
