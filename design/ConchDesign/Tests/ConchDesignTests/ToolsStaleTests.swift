import XCTest
@testable import ConchDesign

/// A session whose conch tools are out of date (`rows[].toolsStale`, src/mcp-servers.ts): decoded from the daemon's row,
/// said in plain words, and when Restart may restart at once.
final class ToolsStaleTests: XCTestCase {
    private func decode(_ json: String) throws -> ToolsStale {
        try JSONDecoder().decode(ToolsStale.self, from: Data(json.utf8))
    }

    /// As the daemon publishes it today (docs/architecture.md), and from a daemon that adds fields or leaves them out.
    func testDecodesTheDaemonsVerdictLeniently() throws {
        let stale = try decode("""
        {"missing": ["conch_fork", "browser_open", "browser_read", "browser_click", "browser_type", "browser_screenshot",
                     "browser_tabs", "browser_ask", "browser_close", "atlas_show"],
         "basis": "estimated", "serverStartedAt": "2026-10-12T10:46:10.000Z",
         "why": "its conch MCP server started 2026-10-12, before a running server could take a newer conch's tools (2026-10-15)",
         "fix": "restart this session (close it and resume it) to get conch's current tools", "somethingNewer": 1}
        """)
        XCTAssertEqual(stale.missing.first, "conch_fork")
        XCTAssertEqual(stale.missing.count, 10)
        XCTAssertEqual(stale.basis, "estimated")
        XCTAssertEqual(stale.serverStartedAt, "2026-10-12T10:46:10.000Z")
        XCTAssertEqual(try decode(#"{"missing": ["atlas_show"]}"#), ToolsStale(missing: ["atlas_show"]))
        XCTAssertEqual(try decode(#"{"missing": ["atlas_show"], "why": 3}"#).why, nil, "a field in a newer shape is no field")
    }

    /// A verdict naming nothing is no verdict: the row then has no line, rather than one that says "missing nothing".
    func testAVerdictWithNothingMissingIsNone() {
        XCTAssertThrowsError(try decode(#"{"missing": []}"#))
        XCTAssertThrowsError(try decode(#"{"missing": [""]}"#))
        XCTAssertThrowsError(try decode(#"{"basis": "reported"}"#))
        XCTAssertThrowsError(try decode(#"{"missing": "browser_open"}"#))
    }

    // MARK: - Plain words

    /// The browser tools are named as one, first; then fork and Atlas pages.
    func testNamesWhatsMissingInPlainWords() {
        let today = ["conch_fork", "browser_open", "browser_read", "browser_click", "browser_type", "browser_screenshot",
                     "browser_tabs", "browser_ask", "browser_close", "atlas_show"]
        XCTAssertEqual(ToolsStaleWords.missingNames(today), ["the browser tools", "fork", "Atlas pages"])
        XCTAssertEqual(ToolsStaleWords.missing(["atlas_show", "conch_fork"]), "fork and Atlas pages")
    }

    /// A session that has the browser and lacks only newer browser tools is not "missing the browser tools".
    func testASessionWithTheBrowserIsntMissingIt() {
        XCTAssertEqual(ToolsStaleWords.missing(["conch_fork", "browser_ask", "atlas_show"]), "browser_ask, fork and Atlas pages")
        XCTAssertEqual(ToolsStaleWords.missing(["browser_ask", "browser_print"]), "2 browser tools")
    }

    /// Any other tool by its own name, in the daemon's order, once; past three names, how many more.
    func testOtherToolsByName() {
        XCTAssertEqual(ToolsStaleWords.missing(["conch_capture"]), "conch_capture")
        XCTAssertEqual(ToolsStaleWords.missing(["conch_capture", "conch_wait"]), "conch_capture and conch_wait")
        XCTAssertEqual(ToolsStaleWords.missing(["conch_wait", "browser_open", "conch_capture", "conch_wait"]),
                       "the browser tools, conch_wait and conch_capture")
        XCTAssertEqual(ToolsStaleWords.missing(["browser_open", "conch_fork", "atlas_show", "conch_capture"]),
                       "the browser tools, fork, Atlas pages and conch_capture", "four fit")
        XCTAssertEqual(ToolsStaleWords.missing(["browser_open", "conch_fork", "atlas_show", "conch_capture", "conch_wait"]),
                       "the browser tools, fork, Atlas pages and 2 more")
    }

    /// A server that never started (src/mcp-repair.ts) decodes as a failed start, not as an out-of-date one.
    func testAServerThatNeverStartedSaysSo() throws {
        let stale = try decode("""
        {"missing": ["conch_sessions", "conch_wake", "browser_open", "conch_fork", "atlas_show"], "basis": "failed",
         "failedAt": "2026-10-23T20:25:19.635Z",
         "why": "its conch MCP server failed to start (ENOENT: no such file or directory, posix_spawn 'stdio')"}
        """)
        XCTAssertTrue(stale.serverFailed)
        XCTAssertNil(stale.serverStartedAt)
        XCTAssertFalse(ToolsStale(missing: ["atlas_show"], basis: "estimated").serverFailed)
    }

    // MARK: - Restart

    /// Idle is a finished turn with nothing still running and nothing waiting on an answer: one click restarts it.
    /// Anything else asks first, since a turn in progress stops.
    func testOnlyAnIdleSessionRestartsAtOnce() {
        XCTAssertTrue(ToolsStaleRestart.isIdle(status: "waiting", waitingOnAgents: false, approvalPending: false))
        XCTAssertTrue(ToolsStaleRestart.isIdle(status: "review", waitingOnAgents: false, approvalPending: false))
        XCTAssertFalse(ToolsStaleRestart.isIdle(status: "working", waitingOnAgents: false, approvalPending: false))
        XCTAssertFalse(ToolsStaleRestart.isIdle(status: "needs", waitingOnAgents: false, approvalPending: false))
        XCTAssertFalse(ToolsStaleRestart.isIdle(status: "waiting", waitingOnAgents: true, approvalPending: false),
                       "its own turn is over, but agents it started would stop")
        XCTAssertFalse(ToolsStaleRestart.isIdle(status: "waiting", waitingOnAgents: false, approvalPending: true))
        XCTAssertFalse(ToolsStaleRestart.isIdle(status: nil, waitingOnAgents: false, approvalPending: false), "unknown is not idle")
    }

    /// "Restart idle sessions" takes the out-of-date sessions that are idle and that conch can restart, and no other.
    func testRestartIdleTakesOnlyIdleRestartableOutOfDateSessions() {
        let sessions = [
            ToolsStaleRestart.Session(id: "a", label: "Pricing page", stale: true, isIdle: true, canRestart: true),
            ToolsStaleRestart.Session(id: "b", label: "Onboarding audit", stale: true, isIdle: false, canRestart: true),
            ToolsStaleRestart.Session(id: "c", label: "Current", stale: false, isIdle: true, canRestart: true),
            ToolsStaleRestart.Session(id: "d", label: "Hosted", stale: true, isIdle: true, canRestart: false),
            ToolsStaleRestart.Session(id: "e", label: "Mood board", stale: true, isIdle: true, canRestart: true),
        ]
        let split = ToolsStaleRestart.split(sessions)
        XCTAssertEqual(split.idle.map(\.id), ["a", "e"])
        XCTAssertEqual(split.other.map(\.id), ["b", "d"])
    }
}
