import XCTest
@testable import ConchDesign

final class StartedSessionTests: XCTestCase {
    private typealias Row = StartedSessionWatch.Row

    private func claude(_ id: String, account: String? = "default", parent: String? = nil) -> Row {
        // As published: a top-level Claude row has no backend; its agents say "claude".
        Row(id: id, backend: parent == nil ? nil : "claude", parentSessionId: parent, accountId: account)
    }

    private func codex(_ id: String, account: String? = "default") -> Row {
        Row(id: id, backend: "codex", parentSessionId: nil, accountId: account)
    }

    /// The bug: every new Claude session was missed, because its row carries no backend.
    func testFreshClaudeSessionIsFoundThoughItsRowNamesNoBackend() {
        let watch = StartedSessionWatch(backend: "claude", accountId: "default", expectedId: nil, before: ["old"])
        XCTAssertEqual(watch.match(in: [claude("old"), claude("new")]), "new")
    }

    func testNothingNewIsNoMatch() {
        let watch = StartedSessionWatch(backend: "claude", accountId: "default", expectedId: nil, before: ["old"])
        XCTAssertNil(watch.match(in: [claude("old")]))
    }

    func testAnotherAgentsOrAnotherAccountsNewSessionIsNotTheOneStarted() {
        let watch = StartedSessionWatch(backend: "claude", accountId: "work", expectedId: nil, before: [])
        XCTAssertNil(watch.match(in: [codex("c", account: "work"), claude("other", account: "default")]))
        XCTAssertEqual(watch.match(in: [claude("other", account: "default"), claude("mine", account: "work")]), "mine")
    }

    func testASessionsAgentIsNotANewSession() {
        let watch = StartedSessionWatch(backend: "claude", accountId: nil, expectedId: nil, before: ["parent"])
        XCTAssertNil(watch.match(in: [claude("parent"), claude("agent-1", parent: "parent")]))
    }

    func testCodexStillMatchesByItsBackend() {
        let watch = StartedSessionWatch(backend: "codex", accountId: "default", expectedId: nil, before: [])
        XCTAssertEqual(watch.match(in: [claude("c"), codex("x")]), "x")
    }

    /// A resume reopens an id that may already be listed; it is found by that id, not by being new.
    func testExpectedIdIsFoundEvenThoughItWasListedBefore() {
        let watch = StartedSessionWatch(backend: "claude", accountId: "default", expectedId: "resumed", before: ["resumed"])
        XCTAssertEqual(watch.match(in: [claude("fresh"), claude("resumed")]), "resumed")
        XCTAssertNil(watch.match(in: [claude("fresh")]))
    }

    func testARowNotYetAttributedToAnAccountReadsAsTheDefault() {
        let watch = StartedSessionWatch(backend: "claude", accountId: "default", expectedId: nil, before: [])
        XCTAssertEqual(watch.match(in: [claude("new", account: nil)]), "new")
        let work = StartedSessionWatch(backend: "claude", accountId: "work", expectedId: nil, before: [])
        XCTAssertNil(work.match(in: [claude("new", account: nil)]))
    }
}
