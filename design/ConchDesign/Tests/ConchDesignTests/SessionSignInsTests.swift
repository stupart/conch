import XCTest
@testable import ConchDesign

/// Sign-ins for single sessions (daemon claude-session-sign-ins.ts). The token here is made up, in the shape
/// `claude setup-token` prints one.
final class SessionSignInsTests: XCTestCase {
    private let fake = "sk-ant-oat01-" + String(repeating: "FAKE0fake1_-", count: 3)
    private let signIns = [ClaudeSessionSignIn(id: "abc-1", label: "Work Max", addedAt: 1_793_000_000_000),
                           ClaudeSessionSignIn(id: "def-2", label: "Personal", addedAt: 1_793_000_100_000)]

    func testATokenIsTakenWholeWithWhatACopyPicksUpTrimmed() {
        XCTAssertEqual(SessionSignInToken.normalized(fake), fake)
        XCTAssertEqual(SessionSignInToken.normalized("  \(fake)\n"), fake)
        // Wrapped across lines in Terminal, indent and all.
        let wrapped = "  \(fake.prefix(20))\n    \(fake.dropFirst(20))\r\n"
        XCTAssertEqual(SessionSignInToken.normalized(wrapped), fake)
        XCTAssertEqual(SessionSignInToken.normalized("sk-ant-oat02-\(String(repeating: "a", count: 20))"), "sk-ant-oat02-\(String(repeating: "a", count: 20))")
    }

    func testAnythingElseIsRefusedWithoutRepeatingIt() {
        for pasted in ["", "sk-ant-oat01-short", "\(fake) -w other", "\(fake)\nmore words", "\(fake)\"", "Bearer \(fake)",
                       "sk-ant-OAT01-\(String(repeating: "a", count: 30))", "sk-ant--\(String(repeating: "a", count: 30))",
                       "sk-ant-oat01-\(String(repeating: "a", count: 2_000))"] {
            XCTAssertNil(SessionSignInToken.normalized(pasted), pasted)
        }
        XCTAssertFalse(SessionSignInToken.problem.contains("sk-ant-oat"))
    }

    func testANameIsWhatTheDaemonTakes() {
        XCTAssertNil(SessionSignInName.problem("Work Max"))
        XCTAssertNil(SessionSignInName.problem("Tyler’s Max #2"))
        for name in ["", "   ", "Work \"Max\"", "Work\\Max", String(repeating: "x", count: 61), "line\nbreak"] {
            XCTAssertNotNil(SessionSignInName.problem(name), name)
        }
    }

    func testOfferedForClaudeInDefaultOnly() {
        XCTAssertTrue(SessionSignInChoice.offered(backend: "claude", accountId: "default", signIns: signIns))
        XCTAssertTrue(SessionSignInChoice.offered(backend: "claude", accountId: nil, signIns: signIns))
        XCTAssertFalse(SessionSignInChoice.offered(backend: "claude", accountId: "work", signIns: signIns))
        XCTAssertFalse(SessionSignInChoice.offered(backend: "codex", accountId: "default", signIns: signIns))
        XCTAssertFalse(SessionSignInChoice.offered(backend: "claude", accountId: "default", signIns: []))
    }

    func testWhatIsShownIsWhatIsSent() {
        XCTAssertEqual(SessionSignInChoice.sent(selection: "abc-1", backend: "claude", accountId: "default", signIns: signIns), "abc-1")
        XCTAssertNil(SessionSignInChoice.sent(selection: nil, backend: "claude", accountId: "default", signIns: signIns))
        XCTAssertNil(SessionSignInChoice.sent(selection: "abc-1", backend: "claude", accountId: "work", signIns: signIns))
        XCTAssertNil(SessionSignInChoice.sent(selection: "abc-1", backend: "codex", accountId: "default", signIns: signIns))
        // Removed while the sheet was open: shown, and sent, as the rotating login.
        XCTAssertNil(SessionSignInChoice.shown(selection: "gone", signIns: signIns))
        XCTAssertNil(SessionSignInChoice.sent(selection: "gone", backend: "claude", accountId: "default", signIns: signIns))
    }

    func testTheDaemonsReplyDecodes() throws {
        let json = #"{"kind":"claude-session-sign-ins","signIns":[{"id":"abc-1","label":"Work Max","addedAt":1793000000000}],"added":"abc-1"}"#
        let reply = try JSONDecoder().decode(ClaudeSessionSignInsReply.self, from: Data(json.utf8))
        XCTAssertEqual(reply.signIns, [signIns[0]])
        XCTAssertEqual(reply.added, "abc-1")
        XCTAssertNil(reply.setupOpened)
        XCTAssertEqual(reply.signIns[0].added, Date(timeIntervalSince1970: 1_793_000_000))
    }
}
