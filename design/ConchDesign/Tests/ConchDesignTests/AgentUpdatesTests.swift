import XCTest
@testable import ConchDesign

/// Settings › Providers' versions card (src/agent-updates.ts): what it decodes and sends, and when a version is behind.

@MainActor
final class AgentUpdatesTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private var row: AgentUpdateRow {
        AgentUpdateRow(
            backend: "claude", displayName: "Claude Code", channel: "homebrew-cask",
            source: "Homebrew cask claude-code@latest", installed: "2.1.309", newest: "2.1.319",
            cask: "claude-code@latest", checkedAt: now.timeIntervalSince1970 * 1000 - 12 * 60_000
        )
    }

    func testDecodesAFullRowAndToleratesAnOlderOne() throws {
        let json = """
        {"kind":"agent-updates","auto":true,"agents":[
          {"backend":"claude","displayName":"Claude Code","channel":"homebrew-cask","source":"Homebrew cask claude-code@latest",
           "installed":"2.1.309","newest":"2.1.319","cask":"claude-code@latest","checkedAt":1.0,"canUpdate":true,"updating":false,
           "olderSessions":{"count":2,"versions":["2.1.300"]},
           "failure":{"at":2.0,"phase":"update","message":"brew failed","output":"tail"}},
          {"backend":"codex"}
        ]}
        """
        let reply = try JSONDecoder().decode(AgentUpdatesReply.self, from: Data(json.utf8))
        XCTAssertTrue(reply.auto)
        XCTAssertEqual(reply.agents[0].olderSessions, AgentUpdateRow.OlderSessions(count: 2, versions: ["2.1.300"]))
        XCTAssertEqual(reply.agents[0].failure?.output, "tail")
        XCTAssertEqual(reply.agents[1].displayName, "codex")
        XCTAssertEqual(reply.agents[1].channel, "not-managed")
        XCTAssertFalse(reply.agents[1].canUpdate)
        XCTAssertEqual(reply.agents[1].olderSessions.count, 0)
    }

    func testRequestEncodesAsTheDaemonExpects() throws {
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(AgentUpdatesRequest.updateNow("codex"))) as? [String: String]
        XCTAssertEqual(body, ["kind": "agent-updates", "action": "update-now", "backend": "codex"])
    }

    /// Behind is numeric, not textual (2.1.9 is older than 2.1.10), and an unreadable version is never behind.
    func testBehindComparesVersionsNumerically() {
        XCTAssertTrue(AgentUpdates.isBehind(row))
        let current = AgentUpdateRow(backend: "codex", displayName: "Codex", source: "Homebrew cask codex", installed: "0.167.0", newest: "0.167.0", checkedAt: now.timeIntervalSince1970 * 1000)
        XCTAssertFalse(AgentUpdates.isBehind(current))
        XCTAssertTrue(AgentUpdates.isBehind(AgentUpdateRow(backend: "claude", displayName: "C", installed: "2.1.9", newest: "2.1.10")))
        XCTAssertFalse(AgentUpdates.isBehind(AgentUpdateRow(backend: "claude", displayName: "C", installed: "2.1.9", newest: "latest")))
    }
}
