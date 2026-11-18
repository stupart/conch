import XCTest
@testable import ConchDesign

/// The sentence a failed send shows, on the phone and in the Mac app.
///
/// Both apps call this, so these assertions are the contract that keeps the two surfaces
/// saying the same thing about the same failure.
final class SendFailureTests: XCTestCase {
    /// Words on the Mac's clipboard are recoverable, so the sentence says so whenever they landed there.
    func testTheClipboardIsNamedWheneverTheWordsLandedThere() {
        XCTAssertTrue(ConchSendFailure.sentence(reason: "window-not-focusable", onClipboard: true).contains("clipboard"))
        XCTAssertFalse(ConchSendFailure.sentence(reason: "window-not-focusable").contains("clipboard"))
        XCTAssertTrue(ConchSendFailure.sentence(reason: nil, onClipboard: true).contains("clipboard"))
    }

    /// A question the daemon could not answer says why in its own words, and those words are
    /// shown: read as an unknown code they were a bare "Not delivered." on Tyler's phone, twice,
    /// for an answer that was simply refused (2026-09-28).
    func testAReasonTheDaemonWroteAsASentenceIsShown() {
        XCTAssertEqual(
            ConchSendFailure.sentence(reason: "the question is no longer open."),
            "Not delivered — the question is no longer open."
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
    /// records, has a sentence.
    func testEveryReasonTheDaemonSendsHasASentence() {
        let reasons = [
            "keystroke-fallback-off", "window-not-focusable", "session-not-routable",
            "system-dialog-blocking", "automation-permission-denied", "accessibility-permission-denied", "front-window-changed",
            "automation-failed", "clipboard-changed", "clipboard-unavailable", "clipboard-unpreservable",
            "submit-failed",
            "clipboard-fallback", "delivery-failed", "transport-error", "submit-error",
            "delivery-unconfirmed", "delivery-unattributed", "delivery-interrupted",
            "session-awaiting-answer", "session-awaiting-permission", "session-stopped", "session-ended",
        ]
        for reason in reasons {
            let sentence = ConchSendFailure.sentence(reason: reason)
            XCTAssertNotEqual(sentence, "Not delivered.", "no sentence for \(reason)")
            XCTAssertTrue(sentence.hasPrefix("Not delivered — "), sentence)
            XCTAssertTrue(sentence.hasSuffix("."), sentence)
        }
    }
}
