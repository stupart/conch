import XCTest
@testable import ConchDesign

/// The sentence a failed send shows, on the phone and in the Mac app.
///
/// Both apps call this, so these assertions are the contract that keeps the two surfaces
/// saying the same thing about the same failure.
final class SendFailureTests: XCTestCase {
    func testTheBlockedMacNamesTheThingToGoAndFix() {
        XCTAssertEqual(
            ConchSendFailure.sentence(reason: "system-dialog-blocking"),
            "Not delivered — a dialog is open on your Mac and it's blocking conch. Dismiss it and send again."
        )
        XCTAssertEqual(
            ConchSendFailure.sentence(reason: "automation-permission-denied"),
            "Not delivered — macOS is blocking conch from controlling Terminal. Turn conch on under Privacy & Security → Automation."
        )
    }

    /// Words on the Mac's clipboard are recoverable, so the sentence says so — that is the
    /// difference between a lost message and a paste.
    func testTheClipboardIsNamedWheneverTheWordsLandedThere() {
        XCTAssertEqual(
            ConchSendFailure.sentence(reason: "window-not-focusable", onClipboard: true),
            "Not delivered — couldn't reach that session's window. Your words are on the Mac's clipboard."
        )
        XCTAssertEqual(
            ConchSendFailure.sentence(reason: "window-not-focusable"),
            "Not delivered — couldn't reach that session's window."
        )
        // Even with no reason to give, where the words are is still worth saying.
        XCTAssertEqual(
            ConchSendFailure.sentence(reason: nil, onClipboard: true),
            "Not delivered. Your words are on the Mac's clipboard."
        )
    }

    /// A send to a terminal the session has left is refused before a key, and says what to do.
    func testAStoppedSessionSaysToResumeIt() {
        XCTAssertEqual(
            ConchSendFailure.sentence(reason: "session-stopped"),
            "Not delivered — that session isn't running in its terminal any more: it was stopped. Resume it, and conch will pick it up."
        )
        XCTAssertEqual(
            ConchSendFailure.sentence(reason: "session-ended"),
            "Not delivered — that session isn't running in its terminal any more: its process has ended. Resume it, and conch will pick it up."
        )
    }

    /// The honesty rule: no reason, no cause. A guessed cause sends someone to fix the wrong thing.
    func testAnUnknownReasonInventsNothing() {
        for reason in [nil, "", "delivery-fell-over", "staged-not-submitted", "transport-submitted"] {
            XCTAssertEqual(ConchSendFailure.sentence(reason: reason), "Not delivered.")
            XCTAssertNil(ConchSendFailure.clause(for: reason))
        }
    }

    /// Every reason `src/inject.ts` can produce, plus the delivery-level codes the voice loop
    /// records, has a sentence. A bun test pins this list against the daemon's own source.
    func testEveryReasonTheDaemonSendsHasASentence() {
        let reasons = [
            "keystroke-fallback-off", "window-not-focusable", "session-not-routable",
            "system-dialog-blocking", "automation-permission-denied", "front-window-changed",
            "automation-failed", "clipboard-changed", "clipboard-unavailable", "clipboard-unpreservable",
            "submit-failed",
            "clipboard-fallback", "delivery-failed", "transport-error", "submit-error",
            "delivery-unconfirmed", "delivery-unattributed", "delivery-interrupted",
            "session-awaiting-answer", "session-stopped", "session-ended",
        ]
        for reason in reasons {
            let sentence = ConchSendFailure.sentence(reason: reason)
            XCTAssertNotEqual(sentence, "Not delivered.", "no sentence for \(reason)")
            XCTAssertTrue(sentence.hasPrefix("Not delivered — "), sentence)
            XCTAssertTrue(sentence.hasSuffix("."), sentence)
        }
    }
}
