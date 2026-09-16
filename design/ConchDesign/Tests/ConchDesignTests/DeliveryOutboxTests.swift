import XCTest
@testable import ConchDesign

/// The outbox that makes "Sent" honest.
///
/// The defect these are written against: the Mac answers `inject-accepted` after twenty
/// seconds and closes the request, the phone cleared the draft and wrote "Sent", and a
/// failure arriving afterwards had nowhere to land. Tyler believed messages had been
/// delivered that never were. Every test here is one half of the promise that replaces it —
/// the words survive until something proves they landed, and the proof can arrive late.
final class DeliveryOutboxTests: XCTestCase {
    private func sent(_ text: String = "ship it", session: String = "s1", id: String = "op-1") -> ConchOutboxEntry {
        ConchOutboxEntry(id: id, session: session, text: text, sentAt: Date(timeIntervalSince1970: 1_000))
    }

    /// Optimistic, immediately, in the conversation — and NOT confirmed, so the words stay.
    func testASendIsVisibleAtOnceAndKeepsItsWordsUntilProven() {
        var outbox = ConchOutbox()
        outbox.begin(sent())
        XCTAssertEqual(outbox.entries.count, 1)
        XCTAssertEqual(outbox.entries[0].state, .sent)
        XCTAssertFalse(outbox.entries[0].state.clearsDraft)
        XCTAssertFalse(outbox.entries[0].state.isTerminal)
        XCTAssertEqual(outbox.unsettled(for: "s1")?.text, "ship it")
    }

    /// Acceptance is not delivery. An accepted send that fails twenty seconds later ends at
    /// "not delivered", with its words still recoverable — the exact sequence that lied.
    func testALateFailureAfterAcceptanceEndsNotDeliveredWithTheWordsRecoverable() {
        var outbox = ConchOutbox()
        outbox.begin(sent())
        XCTAssertEqual(outbox.unsettled(for: "s1")?.state, .sent)

        outbox.settle("op-1", .failed("Not delivered — a dialog is open on your Mac and it's blocking conch. Dismiss it and send again."))
        let settled = outbox.unsettled(for: "s1")
        XCTAssertEqual(settled?.state, .failed("Not delivered — a dialog is open on your Mac and it's blocking conch. Dismiss it and send again."))
        XCTAssertEqual(settled?.text, "ship it", "the text has to be recoverable — that is what a retry re-sends")
        XCTAssertFalse(settled?.state.clearsDraft ?? true)
    }

    /// The bug this state exists for: the phone's request timed out, so it never heard the
    /// answer — and the Mac had typed the message perfectly well. Classifying that as failure
    /// made it permanent, because a terminal state refuses every later outcome.
    func testAnUnheardAnswerIsResolvedByTheRealOneWhenItArrives() {
        var outbox = ConchOutbox()
        outbox.begin(sent())
        outbox.settle("op-1", .unknown("Not confirmed — the phone lost the connection before your Mac answered."))
        let waiting = outbox.unsettled(for: "s1")
        XCTAssertEqual(waiting?.state, .unknown("Not confirmed — the phone lost the connection before your Mac answered."))
        XCTAssertFalse(waiting?.state.isTerminal ?? true, "nothing was settled, so the answer can still land")
        XCTAssertFalse(waiting?.state.clearsDraft ?? true, "the words stay until something proves they arrived")

        // The daemon's receipt turns up on the state channel, seconds or a relaunch later.
        outbox.settle("op-1", .confirmed)
        XCTAssertEqual(outbox.entries.map(\.state), [.confirmed])
    }

    /// The other direction, and just as important: not hearing is not a refusal, but a refusal
    /// that arrives afterwards is still the truth.
    func testAnUnheardAnswerCanAlsoResolveToAFailure() {
        var outbox = ConchOutbox()
        outbox.begin(sent())
        outbox.settle("op-1", .unknown("Not confirmed — no answer reached this phone."))
        outbox.settle("op-1", .failed("Not delivered — a dialog is open on your Mac and it's blocking conch."))
        XCTAssertEqual(outbox.entries.map(\.state), [.failed("Not delivered — a dialog is open on your Mac and it's blocking conch.")])
    }

    /// A confirmed delivery confirms once and stays confirmed. A duplicate answer, or a late
    /// contradicting one, cannot move it — nothing may un-confirm a message a person watched
    /// land, and nothing may quietly upgrade one that failed.
    func testATerminalOutcomeLandsExactlyOnceAndIsNeverOverwritten() {
        var outbox = ConchOutbox()
        outbox.begin(sent())
        outbox.settle("op-1", .confirmed)
        outbox.settle("op-1", .confirmed)
        outbox.settle("op-1", .failed("Not delivered."))
        XCTAssertEqual(outbox.entries.map(\.state), [.confirmed])

        var failedFirst = ConchOutbox()
        failedFirst.begin(sent(id: "op-2"))
        failedFirst.settle("op-2", .failed("Not delivered."))
        failedFirst.settle("op-2", .confirmed)
        XCTAssertEqual(failedFirst.entries.map(\.state), [.failed("Not delivered.")])
    }

    /// Kill the app mid-flight and the send is still there when it comes back, still
    /// unresolved, still able to take its outcome. Before this, a relaunch erased the only
    /// record that a message was ever in doubt.
    func testAnInFlightSendSurvivesARelaunchAndStillResolves() {
        var outbox = ConchOutbox()
        outbox.begin(sent())
        let saved = outbox.encoded()
        XCTAssertNotNil(saved)

        var relaunched = ConchOutbox.decode(saved)
        XCTAssertEqual(relaunched.entries.map(\.id), ["op-1"])
        XCTAssertEqual(relaunched.unsettled(for: "s1")?.state, .sent)
        XCTAssertEqual(relaunched.unsettled(for: "s1")?.text, "ship it")

        relaunched.settle("op-1", .confirmed)
        XCTAssertEqual(relaunched.entries.map(\.state), [.confirmed])
    }

    /// An unreadable or absent store loses the bubbles, never the launch. The words
    /// themselves live in the draft, which is stored separately.
    func testAnUnreadableStoreIsEmptyRatherThanFatal() {
        XCTAssertEqual(ConchOutbox.decode(nil).entries.count, 0)
        XCTAssertEqual(ConchOutbox.decode(Data("not json".utf8)).entries.count, 0)
    }

    /// An id this device never sent is ignored. Published outcomes are read by every client
    /// the Mac serves, so most of them belong to somebody else.
    func testAnUnknownOperationIdIsIgnored() {
        var outbox = ConchOutbox()
        outbox.begin(sent())
        outbox.settle("someone-elses-op", .confirmed)
        XCTAssertEqual(outbox.entries.map(\.state), [.sent])
    }

    /// One unsettled message per session: re-sending replaces it, because its words are
    /// still at the head of that session's draft and go out again with the retry. Other
    /// sessions are untouched, and a confirmed message is history, not a draft.
    func testBeginReplacesOnlyThisSessionsUnsettledMessage() {
        var outbox = ConchOutbox()
        outbox.begin(sent("first", session: "s1", id: "op-1"))
        outbox.begin(sent("other session", session: "s2", id: "op-2"))
        outbox.settle("op-1", .failed("Not delivered."))
        outbox.begin(sent("retry", session: "s1", id: "op-3"))
        XCTAssertEqual(outbox.entries(for: "s1").map(\.text), ["retry"])
        XCTAssertEqual(outbox.entries(for: "s2").map(\.text), ["other session"])

        outbox.settle("op-3", .confirmed)
        outbox.begin(sent("next", session: "s1", id: "op-4"))
        XCTAssertEqual(outbox.entries(for: "s1").map(\.text), ["retry", "next"],
                       "a confirmed message stays in the conversation; only an unsettled one is replaced")
    }

    /// Tidying only ever removes messages that were proven delivered. An unresolved or
    /// failed send is the person's to dismiss — sweeping it up is the original bug again.
    func testPruningRetiresConfirmedMessagesOnly() {
        var outbox = ConchOutbox()
        outbox.begin(sent("confirmed", session: "s1", id: "op-1"))
        outbox.settle("op-1", .confirmed)
        outbox.begin(sent("never resolved", session: "s2", id: "op-2"))
        outbox.begin(sent("failed", session: "s3", id: "op-3"))
        outbox.settle("op-3", .failed("Not delivered."))

        outbox.prune(confirmedBefore: Date(timeIntervalSince1970: 2_000))
        XCTAssertEqual(outbox.entries.map(\.text), ["never resolved", "failed"])
    }
}
