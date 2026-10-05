import XCTest
@testable import ConchDesign

/// Approving a result (ReviewApproval.swift, 2026-10-05, Tyler's decision): the session bar's control, its words at
/// every width, ⌘Z's ten seconds, and when Return approves.
final class ReviewApprovalTests: XCTestCase {
    func testTheControlShowsOnlyForAnUnapprovedResultFromADaemonThatCanApprove() {
        XCTAssertEqual(ReviewApproval.control(showing: true, daemonCanApprove: true, approvedAt: nil, confirming: false), .approve)
        // Approved already (here, on the phone, in the lagoon): nothing to offer.
        XCTAssertEqual(ReviewApproval.control(showing: true, daemonCanApprove: true, approvedAt: 5, confirming: false), .hidden)
        // Just approved here: it says so for a moment, whatever the daemon has said back yet.
        XCTAssertEqual(ReviewApproval.control(showing: true, daemonCanApprove: true, approvedAt: 5, confirming: true), .approved)
        XCTAssertEqual(ReviewApproval.control(showing: true, daemonCanApprove: true, approvedAt: nil, confirming: true), .approved)
        // No result in the pane, or a daemon too old to approve: never.
        XCTAssertEqual(ReviewApproval.control(showing: false, daemonCanApprove: true, approvedAt: nil, confirming: false), .hidden)
        XCTAssertEqual(ReviewApproval.control(showing: true, daemonCanApprove: false, approvedAt: nil, confirming: false), .hidden)
        XCTAssertEqual(ReviewApproval.control(showing: true, daemonCanApprove: false, approvedAt: nil, confirming: true), .hidden)
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

    func testItsTooltipAndVoiceOverNameTheKey() {
        XCTAssertEqual(ReviewApproval.help(.approve), "Approve: mark this result done (↵)")
        XCTAssertTrue(ReviewApproval.help(.approved).contains("⌘Z"))
        XCTAssertEqual(ReviewApproval.accessibilityLabel(.approve), "Approve this result")
        XCTAssertEqual(ReviewApproval.accessibilityLabel(.approved), "Approved")
        XCTAssertTrue(ReviewApproval.announcement.contains("Command-Z"))
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
