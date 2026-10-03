import XCTest
@testable import ConchDesign

final class AgentCommandsTests: XCTestCase {
    func testPrefixBeatsWordStartBeatsSubsequence() {
        let prefix = CommandMatch.score("comp", in: "/compact")
        let wordStart = CommandMatch.score("comp", in: "/auto-compact")
        let scattered = CommandMatch.score("cmp", in: "/compact")
        XCTAssertNotNil(prefix)
        XCTAssertNotNil(wordStart)
        XCTAssertNotNil(scattered)
        XCTAssertGreaterThan(prefix!, wordStart!)
        XCTAssertGreaterThan(wordStart!, scattered!)
        XCTAssertNil(CommandMatch.score("zz", in: "/compact"))
        // `/` and `$` lead nothing: "pony" finds `$ponytail`.
        XCTAssertNotNil(CommandMatch.score("pony", in: "$ponytail"))
        XCTAssertEqual(CommandMatch.score("", in: "anything"), 0)
    }

    func testTheDetailCountsOnlyWhenItLeadsWithTheQuery() {
        // A scattered subsequence matches almost any sentence; in practice the detail counts only as a prefix.
        XCTAssertNotNil(CommandMatch.rank("summ", title: "/compact", detail: "Summarise the conversation to free context"))
        XCTAssertNil(CommandMatch.rank("smr", title: "/compact", detail: "Summarise the conversation"))
    }

    func testSlashCommandsArePerAgentAndAbsentIsClaude() {
        XCTAssertTrue(AgentCommands.slash(for: nil).contains { $0.line == "/memory" })
        XCTAssertTrue(AgentCommands.slash(for: "claude").contains { $0.line == "/memory" })
        XCTAssertTrue(AgentCommands.slash(for: "codex").contains { $0.line == "/fast" })
        XCTAssertFalse(AgentCommands.slash(for: "codex").contains { $0.line == "/memory" })
        let compact = AgentCommands.slash(for: "claude").first { $0.line == "/compact" }
        XCTAssertEqual(compact?.argumentHint, "what to keep (optional)")
        XCTAssertEqual(compact?.typed(with: " auth flow "), "/compact auth flow")
        XCTAssertEqual(compact?.typed(with: ""), "/compact")
    }

    func testSkillsAreSpelledPerAgentAndOnlyUserInvocableOnes() throws {
        let inventory = try JSONDecoder().decode(AgentCapabilities.self, from: Data(Self.inventory.utf8))
        let claude = AgentCommands.skills(in: inventory, backend: nil).map(\.line)
        XCTAssertEqual(claude, ["/review-kit:audit", "/notes"])
        let codex = AgentCommands.skills(in: inventory, backend: "codex").map(\.line)
        XCTAssertEqual(codex, ["$audit", "$notes"])
        XCTAssertEqual(AgentCommands.skills(in: inventory, backend: nil).first?.argumentHint, "path")
        XCTAssertTrue(AgentCommands.skills(in: nil, backend: nil).isEmpty)
    }

    func testCapabilitiesDecodeAsTheDaemonPublishesThem() throws {
        let inventory = try JSONDecoder().decode(AgentCapabilities.self, from: Data(Self.inventory.utf8))
        XCTAssertEqual(inventory.context.backend, "claude")
        XCTAssertEqual(inventory.entities.count, 4)
        let server = try XCTUnwrap(inventory.entities.first { $0.kind == "mcp-server" })
        XCTAssertTrue(server.isToggleable)
        XCTAssertFalse(server.enabledForNextSession)
        XCTAssertTrue(server.isUnavailable)
        XCTAssertEqual(server.headline.state, "no")
        XCTAssertEqual(server.kindSummary, "stdio · figma")
    }

    private static func evidence(_ state: String) -> String {
        #"{"configured":{"state":"yes","basis":"file","detail":"in settings"},"available":{"state":"\#(state)","basis":"file","detail":""},"loaded":{"state":"unknown","basis":"none","detail":""},"observed":{"state":"unknown","basis":"none","detail":""}}"#
    }

    private static func skill(_ name: String, owner: String?, user: Bool, hint: String? = nil) -> String {
        let ownerJSON = owner.map { "\"\($0)\"" } ?? "null"
        let hintJSON = hint.map { "\"\($0)\"" } ?? "null"
        return #"{"id":"skill:\#(name)","kind":"skill","name":"\#(name)","displayName":"\#(name)","description":null,"parentId":null,"scope":"user","sources":[],"evidence":\#(evidence("yes")),"diagnostics":[],"skill":{"path":"/s","ownerPluginId":\#(ownerJSON),"enabledForNextSession":null,"visibility":"on","userInvocable":\#(user),"modelInvocable":true,"allowedTools":[],"argumentHint":\#(hintJSON),"model":null,"bytes":10}}"#
    }

    private static var inventory: String {
        let server = #"{"id":"mcp:figma","kind":"mcp-server","name":"figma","displayName":"figma","description":null,"parentId":null,"scope":"user","sources":[],"evidence":\#(evidence("no")),"diagnostics":[],"mcpServer":{"ownerPluginId":null,"transport":"stdio","command":"/usr/local/bin/figma","argsCount":0,"url":null,"credentialSources":[],"enabledForNextSession":false,"projectDecision":null,"required":null,"startupTimeoutSeconds":null,"toolTimeoutSeconds":null}}"#
        let entities = [
            skill("audit", owner: "review-kit@market", user: true, hint: "path"),
            skill("notes", owner: nil, user: true),
            skill("internal", owner: nil, user: false),
            server,
        ].joined(separator: ",")
        return #"{"context":{"backend":"claude","cwd":"/Users/t/p","projectTrust":null,"threadConfiguration":null},"entities":[\#(entities)],"diagnostics":[],"complete":true}"#
    }
}
