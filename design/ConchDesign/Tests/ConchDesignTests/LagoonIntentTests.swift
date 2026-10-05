import XCTest
@testable import ConchDesign

/// What the lagoon asks of conch (LagoonIntents.swift): every message checked, and in phase A none acted on. With a name's
/// flag on, that name and only that one reaches the app's actions, here a recorder.
@MainActor
final class LagoonIntentTests: XCTestCase {
    private let sessions: LagoonIntent.Sessions = ["s1": ["r1", "r2"], "s2": []]
    private let now = Date(timeIntervalSince1970: 1_000)

    private func check(_ body: [String: Any]) -> LagoonIntent.Check {
        LagoonIntent.validate(body, sessions: sessions)
    }

    private func accepted(_ body: [String: Any], file: StaticString = #filePath, line: UInt = #line) -> LagoonIntent.Message? {
        guard case let .accepted(message) = check(body) else {
            XCTFail("refused \(body): \(check(body))", file: file, line: line)
            return nil
        }
        return message
    }

    private func refused(_ body: Any, file: StaticString = #filePath, line: UInt = #line) {
        if case .accepted = LagoonIntent.validate(body, sessions: sessions) { XCTFail("accepted \(body)", file: file, line: line) }
    }

    // MARK: The checks

    func testEveryNameTheLagoonSends() {
        XCTAssertEqual(accepted(["v": 1, "name": "ready"])?.name, .ready)
        XCTAssertEqual(accepted(["v": 1, "name": "focusSession", "sessionId": "s1"])?.sessionId, "s1")
        XCTAssertEqual(accepted(["v": 1, "name": "openReview", "sessionId": "s1", "reviewId": "r2", "how": "viewed"])?.how, .viewed)
        XCTAssertEqual(accepted(["v": 1, "name": "openReview", "sessionId": "s1", "reviewId": "r1", "how": "open", "readOnly": true])?.readOnly, true)
        XCTAssertEqual(accepted(["v": 1, "name": "reply", "sessionId": "s2", "text": "go on"])?.text, "go on")
        let answer = accepted(["v": 1, "name": "answer", "sessionId": "s1", "choice": "Once", "approval": ["kind": "once", "id": "p1"]])
        XCTAssertEqual(answer?.allow, true)
        XCTAssertEqual(answer?.approvalId, "p1")
        XCTAssertEqual(accepted(["v": 1, "name": "answer", "sessionId": "s1", "choice": "No", "approval": ["kind": "deny", "id": "p1"]])?.allow, false)
        XCTAssertEqual(accepted(["v": 1, "name": "pause", "sessionId": "s2"])?.name, .pause)
        XCTAssertEqual(accepted(["v": 1, "name": "approve", "sessionId": "s1", "reviewId": "r1"])?.name, .approve)
        XCTAssertEqual(accepted(["v": 1, "name": "unapprove", "sessionId": "s1", "reviewId": "r2"])?.reviewId, "r2")
        XCTAssertEqual(accepted(["v": 1, "name": "newSession", "text": "build the thing"])?.text, "build the thing")
    }

    func testAnUnknownNameOrShapeIsRefused() {
        refused(["v": 1, "name": "deleteEverything", "sessionId": "s1"])
        refused(["v": 1])
        refused(["v": 2, "name": "ready"])
        refused(["v": true, "name": "ready"])
        refused(["name": "ready"])
        refused("ready")
        refused([["v": 1, "name": "ready"]])
    }

    func testTheSessionMustBeInTheCurrentState() {
        refused(["v": 1, "name": "focusSession"])
        refused(["v": 1, "name": "focusSession", "sessionId": ""])
        refused(["v": 1, "name": "focusSession", "sessionId": "gone"])
        refused(["v": 1, "name": "focusSession", "sessionId": 7])
        refused(["v": 1, "name": "reply", "sessionId": "gone", "text": "hi"])
        refused(["v": 1, "name": "pause", "sessionId": "gone"])
        // …and a review, one the session holds now.
        refused(["v": 1, "name": "openReview", "sessionId": "s1", "reviewId": "stale", "how": "open"])
        refused(["v": 1, "name": "openReview", "sessionId": "s2", "reviewId": "r1", "how": "open"])
        refused(["v": 1, "name": "openReview", "sessionId": "s1", "how": "open"])
        refused(["v": 1, "name": "openReview", "sessionId": "s1", "reviewId": "r1", "how": "delete"])
        // Approving and taking it back name a review the session holds now, like openReview: acting by default (2026-10-05)
        // didn't loosen the checks.
        for name in ["approve", "unapprove"] {
            refused(["v": 1, "name": name, "sessionId": "s1"])
            refused(["v": 1, "name": name, "sessionId": "s1", "reviewId": ""])
            refused(["v": 1, "name": name, "sessionId": "s1", "reviewId": "stale"])
            refused(["v": 1, "name": name, "sessionId": "s2", "reviewId": "r1"])
            refused(["v": 1, "name": name, "sessionId": "gone", "reviewId": "r1"])
            refused(["v": 1, "name": name, "reviewId": "r1"])
            refused(["v": 1, "name": name, "sessionId": "s1", "reviewId": 7])
        }
    }

    func testTextIsCappedAtFourThousandCharacters() {
        XCTAssertNotNil(accepted(["v": 1, "name": "reply", "sessionId": "s1", "text": String(repeating: "a", count: 4_000)]))
        refused(["v": 1, "name": "reply", "sessionId": "s1", "text": String(repeating: "a", count: 4_001)])
        refused(["v": 1, "name": "newSession", "text": String(repeating: "a", count: 4_001)])
        refused(["v": 1, "name": "reply", "sessionId": "s1", "text": "   "])
        refused(["v": 1, "name": "reply", "sessionId": "s1"])
    }

    func testAnAnswerIsOnceOrNoAndNamesItsPrompt() {
        refused(["v": 1, "name": "answer", "sessionId": "s1", "choice": "Always", "approval": ["kind": "always", "id": "p1"]])
        refused(["v": 1, "name": "answer", "sessionId": "s1", "choice": "Once", "approval": ["kind": "deny", "id": "p1"]])
        refused(["v": 1, "name": "answer", "sessionId": "s1", "choice": "Once", "approval": NSNull()])
        refused(["v": 1, "name": "answer", "sessionId": "s1", "choice": "Reply", "approval": ["kind": "once", "id": "p1"]])
    }

    func testNoMoreThanTenMessagesASecond() {
        var gate = LagoonIntent.Gate()
        let body: [String: Any] = ["v": 1, "name": "focusSession", "sessionId": "s1"]
        for i in 0..<10 {
            guard case .accepted = gate.check(body, sessions: sessions, now: now.addingTimeInterval(Double(i) * 0.05)) else {
                return XCTFail("message \(i)")
            }
        }
        XCTAssertEqual(gate.check(body, sessions: sessions, now: now.addingTimeInterval(0.6)), .rejected("more than 10 messages a second"))
        // A second after the first, there is room again.
        guard case .accepted = gate.check(body, sessions: sessions, now: now.addingTimeInterval(1.01)) else { return XCTFail("after a second") }
        // Junk counts against the rate too: a flood of it can't hide one more.
        var flooded = LagoonIntent.Gate()
        for _ in 0..<10 { _ = flooded.check(["junk": true], sessions: sessions, now: now) }
        XCTAssertEqual(flooded.check(body, sessions: sessions, now: now.addingTimeInterval(0.1)), .rejected("more than 10 messages a second"))
    }

    // MARK: The flags

    func testFlagsFromWhatEverDefaultsHolds() {
        XCTAssertEqual(LagoonActionFlags(defaultsValue: nil).on, [])
        XCTAssertEqual(LagoonActionFlags(defaultsValue: ["focusSession": true, "reply": false, "pause": NSNumber(value: true)]).on, [.focusSession, .pause])
        XCTAssertEqual(LagoonActionFlags(defaultsValue: ["openReview", "answer", "bogus"]).on, [.openReview, .answer])
        XCTAssertEqual(LagoonActionFlags(defaultsValue: "focusSession, pause").on, [.focusSession, .pause])
        // Names with no flag can't be switched on: newSession has no action, and approve, unapprove and (since
        // 2026-10-05) reply need none.
        XCTAssertEqual(LagoonActionFlags(defaultsValue: ["approve", "unapprove", "reply", "newSession", "ready"]).on, [])
        XCTAssertEqual(LagoonActionFlags(defaultsValue: "focusSession, reply").on, [.focusSession])
        XCTAssertEqual(LagoonActionFlags(defaultsValue: 1).on, [])
    }

    func testThePageIsReadOnlyUntilAPhaseCNameIsOn() {
        XCTAssertTrue(LagoonActionFlags().pageReadOnly)
        XCTAssertTrue(LagoonActionFlags([.focusSession, .openReview]).pageReadOnly)
        XCTAssertFalse(LagoonActionFlags([.answer]).pageReadOnly)
        XCTAssertFalse(LagoonActionFlags([.pause]).pageReadOnly)
        // A reply is no flag's: it acts read-only or not, and asking for it changes nothing about the page.
        XCTAssertTrue(LagoonActionFlags([.reply]).pageReadOnly)
    }

    // MARK: The gating

    private final class Recorder: LagoonActionSink {
        var calls: [String] = []
        func focusSession(_ sessionId: String) { calls.append("focus \(sessionId)") }
        func markReviewViewed(sessionId: String, reviewId: String) { calls.append("viewed \(sessionId) \(reviewId)") }
        func openReview(sessionId: String, reviewId: String) { calls.append("open \(sessionId) \(reviewId)") }
        func reply(sessionId: String, text: String) { calls.append("reply \(sessionId) \(text)") }
        func answer(sessionId: String, allow: Bool, approvalId: String) { calls.append("answer \(sessionId) \(allow) \(approvalId)") }
        func pause(sessionId: String) { calls.append("pause \(sessionId)") }
        func approveReview(sessionId: String, reviewId: String) { calls.append("approve \(sessionId) \(reviewId)") }
        func unapproveReview(sessionId: String, reviewId: String) { calls.append("unapprove \(sessionId) \(reviewId)") }
    }

    private var everyMessage: [LagoonIntent.Message] {
        [
            ["v": 1, "name": "ready"],
            ["v": 1, "name": "focusSession", "sessionId": "s1"],
            ["v": 1, "name": "openReview", "sessionId": "s1", "reviewId": "r1", "how": "viewed"],
            ["v": 1, "name": "openReview", "sessionId": "s1", "reviewId": "r2", "how": "open"],
            ["v": 1, "name": "reply", "sessionId": "s1", "text": "hi"],
            ["v": 1, "name": "answer", "sessionId": "s1", "choice": "No", "approval": ["kind": "deny", "id": "p1"]],
            ["v": 1, "name": "pause", "sessionId": "s2"],
            ["v": 1, "name": "approve", "sessionId": "s1", "reviewId": "r1"],
            ["v": 1, "name": "unapprove", "sessionId": "s1", "reviewId": "r1"],
            ["v": 1, "name": "newSession", "text": "a new one"],
        ].compactMap { accepted($0) }
    }

    /// Phase A: with no flag set, nothing acts except approving a result, taking it back (2026-10-05, Tyler's decision)
    /// and replying to a session (2026-10-05, Tyler's go, replies only). Answering a permission prompt, pausing, focusing
    /// and opening stay logged behind their flags.
    func testPhaseAOnlyApproveUnapproveReplyAndViewedAct() {
        let recorder = Recorder()
        let messages = everyMessage
        XCTAssertEqual(messages.count, 10)
        let routed = messages.map { LagoonIntentRouter.route($0, flags: LagoonActionFlags(), sink: recorder) }
        // `openReview` viewed acts (marking a result looked at, as the app does on opening it); `open` stays phase B.
        XCTAssertEqual(routed, [.ready, .logged, .acted, .logged, .acted, .logged, .logged, .acted, .acted, .logged])
        XCTAssertEqual(recorder.calls, ["viewed s1 r1", "reply s1 hi", "approve s1 r1", "unapprove s1 r1"], "nothing else reaches an agent, or the app")
        XCTAssertEqual(LagoonIntent.actTokens, ["approve", "unapprove", "reply", "viewed"])
        XCTAssertEqual(LagoonIntent.byDefault, [.approve, .unapprove, .reply])
        XCTAssertEqual(LagoonIntent.byDefaultInOrder, [.approve, .unapprove, .reply])
        XCTAssertEqual(LagoonIntent.phaseC, [.answer, .pause])
        XCTAssertTrue(LagoonIntent.byDefault.isDisjoint(with: LagoonIntent.phaseB.union(LagoonIntent.phaseC)))
        // Acting by default leaves the page read-only: no phase C name is on, and `act=` says which are live.
        XCTAssertTrue(LagoonActionFlags().pageReadOnly)
    }

    /// A reply acts from a page in its read-only phase, as approve and unapprove do: the page's `act=reply` told it to send
    /// for real. The brand page sends it with no `readOnly` (conch-design 011fea3); one that says `readOnly: true` acts too.
    func testAReplyActsFromAReadOnlyPage() {
        let recorder = Recorder()
        let live = accepted(["v": 1, "name": "reply", "sessionId": "s1", "text": "ship it"])!
        XCTAssertFalse(live.readOnly)
        XCTAssertEqual(LagoonIntentRouter.route(live, flags: LagoonActionFlags(), sink: recorder), .acted)
        let flagged = accepted(["v": 1, "name": "reply", "sessionId": "s2", "text": "and this", "readOnly": true])!
        XCTAssertTrue(flagged.readOnly)
        XCTAssertEqual(LagoonIntentRouter.route(flagged, flags: LagoonActionFlags(), sink: recorder), .acted)
        XCTAssertEqual(recorder.calls, ["reply s1 ship it", "reply s2 and this"])
        // Answering a permission prompt and pausing still carry `readOnly: true` from that page, and only log.
        let answer = accepted(["v": 1, "name": "answer", "sessionId": "s1", "choice": "Once", "approval": ["kind": "once", "id": "p1"], "readOnly": true])!
        let pause = accepted(["v": 1, "name": "pause", "sessionId": "s1", "readOnly": true])!
        XCTAssertEqual(LagoonIntentRouter.route(answer, flags: LagoonActionFlags(), sink: recorder), .logged)
        XCTAssertEqual(LagoonIntentRouter.route(pause, flags: LagoonActionFlags(), sink: recorder), .logged)
        XCTAssertEqual(recorder.calls.count, 2)
        // Still checked first: no session, a session not in the state, too long, or blank, and nothing is sent.
        for refusedBody in [
            ["v": 1, "name": "reply", "text": "hi"],
            ["v": 1, "name": "reply", "sessionId": "gone", "text": "hi"],
            ["v": 1, "name": "reply", "sessionId": "s1", "text": String(repeating: "a", count: 4_001)],
            ["v": 1, "name": "reply", "sessionId": "s1", "text": "  "],
        ] as [[String: Any]] {
            refused(refusedBody)
        }
    }

    /// One flag on: that name acts, approve, unapprove, reply and viewed act as they always do, and nothing else does.
    func testWithOneFlagOnOnlyThatNameActs() {
        let always = ["viewed s1 r1", "reply s1 hi", "approve s1 r1", "unapprove s1 r1"]
        let expected: [LagoonIntent.Name: [String]] = [
            .focusSession: ["focus s1"],
            .openReview: ["open s1 r2"],
            .reply: [],
            .answer: ["answer s1 false p1"],
            .pause: ["pause s2"],
            .approve: [],
            .unapprove: [],
            .newSession: [],
        ]
        for (name, calls) in expected {
            let recorder = Recorder()
            for message in everyMessage { _ = LagoonIntentRouter.route(message, flags: LagoonActionFlags([name]), sink: recorder) }
            XCTAssertEqual(recorder.calls.filter { !always.contains($0) }, calls, "\(name)")
            XCTAssertEqual(recorder.calls.filter { always.contains($0) }, always, "\(name)")
        }
    }

    func testEveryFlagOnStillNeverActsWithoutASink() {
        let all = LagoonActionFlags(Set(LagoonIntent.Name.allCases))
        XCTAssertEqual(all.on, LagoonIntent.phaseB.union(LagoonIntent.phaseC))
        for message in everyMessage where message.name != .ready {
            XCTAssertEqual(LagoonIntentRouter.route(message, flags: all, sink: nil), .logged)
        }
    }
}
