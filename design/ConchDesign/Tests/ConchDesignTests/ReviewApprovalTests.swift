import XCTest
@testable import ConchDesign

/// Approving a result (ReviewApproval.swift, 2026-10-05, Tyler's decision): the session bar's control, its words at
/// every width, ⌘Z's ten seconds, and when Return approves. Since later that day, only for a result whose agent asked
/// (Tyler, after using #502: "maybe we only show it if the AI sets some sort of flag in the review that it's asking for
/// me to approve some work?"), and in the agent's own words.
final class ReviewApprovalTests: XCTestCase {
    private func control(showing: Bool = true, daemon: Bool = true, asks: Bool = true, approvedAt: Double? = nil,
                         confirming: Bool = false) -> ReviewApproval.Control {
        ReviewApproval.control(showing: showing, daemonCanApprove: daemon, asksApproval: asks, approvedAt: approvedAt,
                               confirming: confirming)
    }

    func testTheControlShowsOnlyForAnUnapprovedResultFromADaemonThatCanApprove() {
        XCTAssertEqual(control(), .approve)
        // Approved already (here, on the phone, in the lagoon): nothing to offer.
        XCTAssertEqual(control(approvedAt: 5), .hidden)
        // Just approved here: it says so for a moment, whatever the daemon has said back yet.
        XCTAssertEqual(control(approvedAt: 5, confirming: true), .approved)
        XCTAssertEqual(control(confirming: true), .approved)
        // No result in the pane, or a daemon too old to approve: never.
        XCTAssertEqual(control(showing: false), .hidden)
        XCTAssertEqual(control(daemon: false), .hidden)
        XCTAssertEqual(control(daemon: false, confirming: true), .hidden)
    }

    /// No request, no button: the result leaves Ready for you by being looked at, as before #502.
    func testWithNoRequestThereIsNoControl() {
        XCTAssertEqual(control(asks: false), .hidden)
        XCTAssertEqual(control(asks: false, confirming: true), .hidden)
        XCTAssertEqual(control(asks: false, approvedAt: 5), .hidden)
        XCTAssertNil(ReviewApproval.label(control(asks: false), compact: false, approvalLabel: "Open the PR"))
    }

    /// "✓ <label>" in the agent's words, "✓ Approve" with none, the check alone when narrow, and "✓ Approved" after.
    func testItReadsTheAgentsLabel() {
        XCTAssertEqual(ReviewApproval.label(.approve, compact: false, approvalLabel: "Open the PR"), "✓ Open the PR")
        XCTAssertEqual(ReviewApproval.label(.approve, compact: false, approvalLabel: "Deploy"), "✓ Deploy")
        XCTAssertEqual(ReviewApproval.label(.approve, compact: true, approvalLabel: "Open the PR"), "✓")
        XCTAssertEqual(ReviewApproval.label(.approved, compact: false, approvalLabel: "Open the PR"), "✓ Approved")
        XCTAssertEqual(ReviewApproval.label(.approved, compact: true, approvalLabel: "Open the PR"), "✓")
        // None, or nothing but space: "Approve".
        XCTAssertEqual(ReviewApproval.label(.approve, compact: false, approvalLabel: nil), "✓ Approve")
        XCTAssertEqual(ReviewApproval.label(.approve, compact: false, approvalLabel: "   "), "✓ Approve")
        // Trimmed, and 1 to 40 characters or none, as the lagoon reads it: never cut, so never half of what it does.
        XCTAssertEqual(ReviewApproval.displayLabel("  Merge \n"), "Merge")
        XCTAssertEqual(ReviewApproval.labelLimit, 40)
        XCTAssertEqual(ReviewApproval.displayLabel(String(repeating: "a", count: 40)), String(repeating: "a", count: 40))
        XCTAssertEqual(ReviewApproval.displayLabel("  " + String(repeating: "a", count: 40) + " "), String(repeating: "a", count: 40))
        XCTAssertNil(ReviewApproval.displayLabel(String(repeating: "a", count: 41)))
        XCTAssertEqual(ReviewApproval.label(.approve, compact: false, approvalLabel: String(repeating: "b", count: 50)), "✓ Approve")
        // Counted as JavaScript counts: an emoji is two.
        XCTAssertNil(ReviewApproval.displayLabel(String(repeating: "🚀", count: 21)))
        XCTAssertEqual(ReviewApproval.displayLabel(String(repeating: "🚀", count: 20)), String(repeating: "🚀", count: 20))
    }

    func testItCollapsesToTheCheckWhenThePaneIsNarrow() {
        XCTAssertEqual(ReviewApproval.label(.approve, compact: false), "✓ Approve")
        XCTAssertEqual(ReviewApproval.label(.approve, compact: true), "✓")
        XCTAssertEqual(ReviewApproval.label(.approved, compact: false), "✓ Approved")
        XCTAssertEqual(ReviewApproval.label(.approved, compact: true), "✓")
        XCTAssertNil(ReviewApproval.label(.hidden, compact: false))
        XCTAssertTrue(ReviewApproval.isCompact(headerWidth: 520))
        XCTAssertTrue(ReviewApproval.isCompact(headerWidth: ReviewApproval.compactBelow - 1))
        XCTAssertFalse(ReviewApproval.isCompact(headerWidth: ReviewApproval.compactBelow))
        XCTAssertFalse(ReviewApproval.isCompact(headerWidth: 1_200))
        // Not measured yet is not narrow: the first frame doesn't flash the check alone.
        XCTAssertFalse(ReviewApproval.isCompact(headerWidth: 0))
    }

    /// The tooltip names the key and says the agent hears of it; VoiceOver hears the label.
    func testItsTooltipAndVoiceOverNameTheKey() {
        XCTAssertEqual(ReviewApproval.help(.approve), "Approve: tells the agent to go ahead (↵)")
        XCTAssertEqual(ReviewApproval.help(.approve, approvalLabel: "Open the PR"), "Approve “Open the PR”: tells the agent to go ahead (↵)")
        XCTAssertTrue(ReviewApproval.help(.approved).contains("⌘Z"))
        XCTAssertTrue(ReviewApproval.help(.approved).contains("10 seconds"))
        XCTAssertEqual(ReviewApproval.accessibilityLabel(.approve), "Approve this result")
        XCTAssertEqual(ReviewApproval.accessibilityLabel(.approve, approvalLabel: "Open the PR"), "Approve: Open the PR")
        XCTAssertEqual(ReviewApproval.accessibilityLabel(.approved, approvalLabel: "Open the PR"), "Approved")
        XCTAssertTrue(ReviewApproval.announcement.contains("Command-Z"))
        XCTAssertTrue(ReviewApproval.announcement.contains("The agent hears in 10 seconds"))
    }

    /// ⌘Z for ten seconds, the daemon's own window, and not after.
    func testUndoIsOpenForTenSeconds() {
        let at = Date(timeIntervalSince1970: 1_000)
        let undo = ReviewApproval.Undo(sessionId: "s", reviewId: "r", at: at)
        XCTAssertEqual(ReviewApproval.undoWindow, 10)
        XCTAssertTrue(undo.isOpen(now: at))
        XCTAssertTrue(undo.isOpen(now: at.addingTimeInterval(9.9)))
        XCTAssertTrue(undo.isOpen(now: at.addingTimeInterval(10)))
        XCTAssertFalse(undo.isOpen(now: at.addingTimeInterval(10.01)))
        XCTAssertFalse(undo.isOpen(now: at.addingTimeInterval(-5)), "a clock that ran backwards past it")
        XCTAssertEqual(undo.closes, at.addingTimeInterval(10))
        // The confirmation is gone well before the window shuts.
        XCTAssertLessThan(ReviewApproval.confirmation, ReviewApproval.undoWindow)
    }

    /// Return approves only while the review pane has the keyboard: never from the composer or another text field, never
    /// inside a web page, and on the lagoon it is still the selected session's conversation.
    func testReturnApprovesOnlyFromTheReviewPane() {
        typealias Key = ReviewApproval.ReturnKey
        func key(_ focus: ReviewApproval.KeyFocus, lagoon: Bool = false, pane: Bool = true, can: Bool = true) -> Key {
            ReviewApproval.returnKey(focus: focus, onLagoon: lagoon, reviewPaneFocused: pane, canApprove: can)
        }
        XCTAssertEqual(key(.other), .approve)
        XCTAssertEqual(key(.text), .pass, "the composer's Return sends the message")
        XCTAssertEqual(key(.web), .pass, "a page's own Return: a link, a form")
        XCTAssertEqual(key(.other, pane: false), .pass, "the sidebar, or anywhere else")
        XCTAssertEqual(key(.other, can: false), .pass, "nothing to approve: approved already, or a daemon that can't")
        XCTAssertEqual(key(.other, lagoon: true), .openConversation)
        XCTAssertEqual(key(.text, lagoon: true), .pass)
        XCTAssertEqual(key(.web, lagoon: true), .pass)
    }
}
