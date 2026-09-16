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

    /// The existing door keeps working, so every reader and guard can move later, not now.
    func testTheConversationToggleStillMapsOntoTheStage() {
        let model = WorkspaceModel()
        model.show(conversation: false, for: "a")
        XCTAssertEqual(model.presentation(for: "a").stage, .deliverable)
        XCTAssertFalse(model.presentation(for: "a").showsConversation)
        model.show(conversation: true, for: "a")
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

    func testEachSessionKeepsItsOwnPageAcrossSwitches() {
        let model = WorkspaceModel()
        model.show(conversation: false, for: "a")
        model.toggleTool("tool-1", for: "a")

        model.viewing = "b"
        XCTAssertTrue(model.presentation(for: "b").showsConversation, "b has its own default")
        XCTAssertFalse(model.isToolExpanded("tool-1", for: "b"), "and its own open rows")

        model.viewing = "a"
        XCTAssertFalse(model.presentation(for: "a").showsConversation, "a is where it was left")
        XCTAssertTrue(model.isToolExpanded("tool-1", for: "a"))
    }

    /// The continuity violation the review named: a newly filed artifact used to set the pane
    /// back to the conversation, which takes someone off the deliverable they are inspecting.
    /// Nothing but an explicit choice moves this now — an arriving artifact is not a choice.
    func testANewArtifactDoesNotChangeTheChosenView() {
        let model = WorkspaceModel()
        model.show(conversation: false, for: "a")

        // Everything an arriving artifact does to this model: nothing. The session republishes,
        // the reader stays on the page they opened.
        let space = workspace([WorkspaceSession(id: "a", isActive: true)])
        XCTAssertEqual(model.viewed(in: space), "a")
        XCTAssertFalse(model.presentation(for: "a").showsConversation)

        // And the way back is the control, which does move it.
        model.show(conversation: true, for: "a")
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
