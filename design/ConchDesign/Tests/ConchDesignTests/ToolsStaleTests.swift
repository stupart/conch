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

    /// The row decodes it with `try?`, so an older daemon (no field) and a broken one both leave the row as it was.
    func testARowWithoutItOrWithABrokenOneDecodes() throws {
        struct Row: Decodable {
            let id: String
            let toolsStale: ToolsStale?
            private enum CodingKeys: String, CodingKey { case id, toolsStale }
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                id = try c.decode(String.self, forKey: .id)
                toolsStale = try? c.decodeIfPresent(ToolsStale.self, forKey: .toolsStale)
            }
        }
        let rows = try JSONDecoder().decode([Row].self, from: Data("""
        [{"id": "a"}, {"id": "b", "toolsStale": {"missing": []}}, {"id": "c", "toolsStale": null},
         {"id": "d", "toolsStale": {"missing": ["browser_open"]}}]
        """.utf8))
        XCTAssertEqual(rows.map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(rows.map { $0.toolsStale?.missing }, [nil, nil, nil, ["browser_open"]])
    }

    // MARK: - Plain words

    func testNamesWhatsMissingInPlainWords() {
        let today = ["conch_fork", "browser_open", "browser_read", "browser_click", "browser_type", "browser_screenshot",
                     "browser_tabs", "browser_ask", "browser_close", "atlas_show"]
        XCTAssertEqual(ToolsStaleWords.missingNames(today), ["the browser tools", "fork", "Atlas pages"],
                       "the browser first, as the reason this exists; then fork and Atlas pages")
        XCTAssertEqual(ToolsStaleWords.missing(today), "the browser tools, fork and Atlas pages")
        XCTAssertEqual(ToolsStaleWords.line(ToolsStale(missing: today)),
                       "conch's tools are out of date · missing the browser tools, fork and Atlas pages")
        XCTAssertEqual(ToolsStaleWords.missing(["browser_open", "browser_close"]), "the browser tools")
        XCTAssertEqual(ToolsStaleWords.missing(["conch_fork"]), "fork")
        XCTAssertEqual(ToolsStaleWords.missing(["atlas_show"]), "Atlas pages")
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

    /// The tooltip carries every tool by name, the daemon's reason as a sentence, and what Restart does.
    func testTheTooltipSaysEverything() {
        let stale = ToolsStale(missing: ["conch_fork", "browser_open"],
                               why: "its conch MCP server started 2026-10-12, before a running server could take a newer conch's tools (2026-10-15)")
        let help = ToolsStaleWords.help(stale, canRestart: true)
        XCTAssertTrue(help.hasPrefix("Missing: conch_fork, browser_open.\nIts conch MCP server started 2026-10-12"), help)
        XCTAssertTrue(help.contains("(2026-10-15).\n"), help)
        XCTAssertTrue(help.hasSuffix("resumes the same conversation in a new Terminal window, with conch's current tools."), help)
        XCTAssertTrue(ToolsStaleWords.help(ToolsStale(missing: ["atlas_show"]), canRestart: false).hasSuffix("its conversation comes back with it."))
        XCTAssertEqual(ToolsStaleWords.help(ToolsStale(missing: ["atlas_show"]), canRestart: true).components(separatedBy: "\n").count, 2,
                       "no reason, no empty line")
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

    func testTheConfirmationListsThemAndSaysWhatStaysAlone() {
        let many = ToolsStaleRestart.confirmation(idle: ["Pricing page", "Mood board"], leftAlone: 2)
        XCTAssertEqual(many.title, "Restart 2 idle sessions?")
        XCTAssertTrue(many.message.hasPrefix("Pricing page\nMood board\n\nconch closes each cleanly, one at a time"), many.message)
        XCTAssertTrue(many.message.hasSuffix(" The other 2 are left alone."), many.message)
        let one = ToolsStaleRestart.confirmation(idle: ["Pricing page"], leftAlone: 0)
        XCTAssertEqual(one.title, "Restart Pricing page?")
        XCTAssertTrue(one.message.hasPrefix("conch closes it cleanly"), one.message)
        XCTAssertTrue(one.message.hasSuffix("current tools."), one.message)
        XCTAssertTrue(ToolsStaleRestart.confirmation(idle: ["A", "B"], leftAlone: 1).message.hasSuffix(" The other one is left alone."))
    }

    func testTheSettingsRow() {
        XCTAssertEqual(ToolsStaleRestart.title(sessions: 9), "conch's tools are out of date in 9 sessions")
        XCTAssertEqual(ToolsStaleRestart.title(sessions: 1), "conch's tools are out of date in 1 session")
        XCTAssertEqual(ToolsStaleRestart.detail(idle: 7, other: 2), "7 are idle. Restarting keeps each conversation.")
        XCTAssertEqual(ToolsStaleRestart.detail(idle: 1, other: 2), "1 is idle. Restarting keeps each conversation.")
        XCTAssertEqual(ToolsStaleRestart.detail(idle: 3, other: 0), "All are idle. Restarting keeps each conversation.")
        XCTAssertEqual(ToolsStaleRestart.detail(idle: 0, other: 2), "None is idle. Restarting keeps each conversation.")
        XCTAssertEqual(ToolsStaleRestart.detail(idle: 1, other: 0), "It's idle. Restarting keeps its conversation.")
        XCTAssertEqual(ToolsStaleRestart.detail(idle: 0, other: 1), "It isn't idle. Restarting keeps its conversation.")
    }
}
