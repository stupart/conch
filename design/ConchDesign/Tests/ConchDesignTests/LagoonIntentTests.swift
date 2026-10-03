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
        XCTAssertEqual(LagoonActionFlags(defaultsValue: "focusSession, reply").on, [.focusSession, .reply])
        // Names with no action can't be switched on.
        XCTAssertEqual(LagoonActionFlags(defaultsValue: ["approve", "newSession", "ready"]).on, [])
        XCTAssertEqual(LagoonActionFlags(defaultsValue: 1).on, [])
    }

    func testThePageIsReadOnlyUntilAPhaseCNameIsOn() {
        XCTAssertTrue(LagoonActionFlags().pageReadOnly)
        XCTAssertTrue(LagoonActionFlags([.focusSession, .openReview]).pageReadOnly)
        XCTAssertFalse(LagoonActionFlags([.reply]).pageReadOnly)
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
            ["v": 1, "name": "newSession", "text": "a new one"],
        ].compactMap { accepted($0) }
    }

    func testPhaseANothingActs() {
        let recorder = Recorder()
        let messages = everyMessage
        XCTAssertEqual(messages.count, 9)
        let routed = messages.map { LagoonIntentRouter.route($0, flags: LagoonActionFlags(), sink: recorder) }
        XCTAssertEqual(routed, [.ready, .logged, .logged, .logged, .logged, .logged, .logged, .logged, .logged])
        XCTAssertEqual(recorder.calls, [], "with every flag off nothing reaches an agent, or the app")
    }

    func testWithOneFlagOnOnlyThatNameActs() {
        let expected: [LagoonIntent.Name: [String]] = [
            .focusSession: ["focus s1"],
            .openReview: ["viewed s1 r1", "open s1 r2"],
            .reply: ["reply s1 hi"],
            .answer: ["answer s1 false p1"],
            .pause: ["pause s2"],
            .approve: [],
            .newSession: [],
        ]
        for (name, calls) in expected {
            let recorder = Recorder()
            for message in everyMessage { _ = LagoonIntentRouter.route(message, flags: LagoonActionFlags([name]), sink: recorder) }
            XCTAssertEqual(recorder.calls, calls, "\(name)")
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
