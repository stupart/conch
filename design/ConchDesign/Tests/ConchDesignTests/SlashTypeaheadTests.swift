import XCTest
@testable import ConchDesign

/// The composer's slash typeahead (2026-11-04): when it shows, what it lists, what choosing makes of the draft, and how
/// it closes. One set of rules for the Mac's composer and the phone's.
final class SlashTypeaheadTests: XCTestCase {
    private static let claude = AgentCommands.all(for: nil, capabilities: nil)

    /// A Codex session once its skills and prompts are read: `/` for its commands and prompts, `$` for its skills.
    private static var codex: [AgentCommand] {
        AgentCommands.slash(for: "codex") + [
            AgentCommand(line: "$ponytail", detail: "Tie off loose ends"),
            AgentCommand(line: "$audit", detail: "Audit the diff", argumentHint: "path"),
            AgentCommand(line: "/prompts:draftpr", detail: "Draft a PR description", argumentHint: "FILES=<paths>"),
        ]
    }

    private func typed(_ draft: String, caret: Int? = nil, in catalog: [AgentCommand] = claude) -> SlashTypeahead {
        var typeahead = SlashTypeahead(catalog: catalog)
        typeahead.update(draft: draft, caret: caret)
        return typeahead
    }

    // MARK: When it shows

    func testItShowsForASlashAtTheStartWithTheCaretInTheFirstWord() {
        XCTAssertTrue(typed("/").isShowing)
        XCTAssertTrue(typed("/comp").isShowing)
        XCTAssertEqual(typed("/comp").word?.query, "comp")
        // The caret anywhere after the sigil and up to the word's end.
        XCTAssertTrue(typed("/comp", caret: 1).isShowing)
        XCTAssertTrue(typed("/comp keep the auth flow", caret: 5).isShowing)
        // Before the sigil is not in the word.
        XCTAssertFalse(typed("/comp", caret: 0).isShowing)
    }

    func testNeverMidSentenceNorAfterTheFirstWord() {
        XCTAssertFalse(typed("please /compact").isShowing)
        XCTAssertFalse(typed(" /compact").isShowing)
        XCTAssertFalse(typed("").isShowing)
        // The command has its words now: the caret is past the first word.
        XCTAssertFalse(typed("/compact keep the auth flow").isShowing)
        XCTAssertFalse(typed("/compact ").isShowing)
        XCTAssertFalse(typed("/compact keep", caret: 9).isShowing)
        // A path, a link: a second `/` is no command.
        XCTAssertFalse(typed("/Users/tyler/shot.png").isShowing)
        XCTAssertFalse(typed("/tmp/x what is this", caret: 4).isShowing)
    }

    func testDollarIsNothingToClaudeAndSkillsToCodex() {
        XCTAssertFalse(typed("$pony").isShowing)
        XCTAssertEqual(typed("$pony", in: Self.codex).matches.map(\.line), ["$ponytail"])
        // `$` lists only skills, `/` only commands and prompts.
        XCTAssertEqual(typed("$", in: Self.codex).matches.map(\.line), ["$ponytail", "$audit"])
        XCTAssertFalse(typed("/", in: Self.codex).matches.contains { $0.line.hasPrefix("$") })
        XCTAssertTrue(typed("/", in: Self.codex).matches.contains { $0.line == "/prompts:draftpr" })
        // A price is not a skill.
        XCTAssertFalse(typed("$5", in: Self.codex).isShowing)
    }

    func testSkillsReadAfterTheDollarWasTypedOpenItThen() {
        var typeahead = SlashTypeahead(catalog: AgentCommands.slash(for: "codex"))
        typeahead.update(draft: "$po", caret: nil)
        XCTAssertFalse(typeahead.isShowing)
        typeahead.setCatalog(Self.codex)
        XCTAssertEqual(typeahead.matches.map(\.line), ["$ponytail"])
    }

    // MARK: What it lists

    func testRankingPrefixThenWordStartThenCatalogOrder() {
        let catalog = [
            AgentCommand(line: "/review-kit:audit", detail: "Audit"),
            AgentCommand(line: "/auditor", detail: "Another"),
            AgentCommand(line: "/audit", detail: "The short one"),
        ]
        // A prefix beats a word start, and the shorter prefix the longer.
        XCTAssertEqual(typed("/audit", in: catalog).matches.map(\.line), ["/audit", "/auditor", "/review-kit:audit"])
        // Just the sigil: everything, in the catalog's order (its own commands, then skills, then the person's).
        XCTAssertEqual(typed("/").matches, Self.claude)
        // A word inside the line.
        XCTAssertEqual(typed("/kit", in: catalog).matches.map(\.line), ["/review-kit:audit"])
    }

    func testAScatteredMatchIsNotOfferedSoAnUnlistedCommandStillSends() {
        // "cmp" is a subsequence of /compact; offering it would make Return choose /compact.
        XCTAssertFalse(typed("/cmp").isShowing)
        XCTAssertFalse(typed("/rewind").isShowing)
        // Nor does a detail count: "/summ" is no command.
        XCTAssertFalse(typed("/summ").isShowing)
    }

    func testTheCatalogIsBuiltInsThenSkillsThenTheirOwnOnceEach() throws {
        let inventory = try JSONDecoder().decode(AgentCapabilities.self, from: Data(Self.inventory.utf8))
        let all = AgentCommands.all(for: nil, capabilities: inventory).map(\.line)
        XCTAssertEqual(Array(all.prefix(AgentCommands.claude.count)), AgentCommands.claude.map(\.0))
        XCTAssertEqual(Array(all.dropFirst(AgentCommands.claude.count)), ["/notes", "/ship", "/kit:audit"])
        // `/notes` is a skill and a command both: listed once, as the skill.
        XCTAssertEqual(AgentCommands.all(for: nil, capabilities: inventory).first { $0.line == "/notes" }?.detail, "Keep notes")
        // A command switched off with its plugin is left out.
        XCTAssertFalse(all.contains("/kit:off"))
        let ship = try XCTUnwrap(AgentCommands.custom(in: inventory).first { $0.line == "/ship" })
        XCTAssertEqual(ship.argumentHint, "[pr title]")
        XCTAssertEqual(ship.detail, "Ship the branch")
    }

    func testPickerCommandsStillSayInTheTerminal() {
        for line in ["/model", "/permissions", "/mcp", "/plugin", "/agents", "/hooks", "/memory"] {
            let row = typed(line).matches.first { $0.line == line }
            XCTAssertTrue(row?.detail.contains("in the terminal") == true, line)
        }
        // Said without "above": there is no palette row above it in a composer.
        XCTAssertFalse(typed("/model").matches.contains { $0.detail.contains("above") })
    }

    // MARK: Choosing

    func testACommandWithAnArgumentLeavesItsSpaceAndTheCaretAfterIt() throws {
        var typeahead = typed("/comp")
        let choice = try XCTUnwrap(typeahead.choose(in: "/comp"))
        XCTAssertEqual(choice, SlashTypeahead.Choice(draft: "/compact ", caret: 9, unchanged: false))
        XCTAssertFalse(typeahead.isShowing)
        // The hint shows after the caret while nothing follows it, and goes as soon as something does.
        XCTAssertEqual(SlashTypeahead.placeholder(for: choice.draft, caret: choice.caret, in: Self.claude), "what to keep (optional)")
        XCTAssertNil(SlashTypeahead.placeholder(for: "/compact a", caret: nil, in: Self.claude))
        XCTAssertNil(SlashTypeahead.placeholder(for: "/compact ", caret: 3, in: Self.claude))
        XCTAssertNil(SlashTypeahead.placeholder(for: "/status ", caret: nil, in: Self.claude))
        typeahead.update(draft: choice.draft, caret: choice.caret)
        XCTAssertFalse(typeahead.isShowing)
    }

    func testACommandWithoutOneFillsTheLineReadyToSendAndStaysClosed() throws {
        var typeahead = typed("/sta")
        let choice = try XCTUnwrap(typeahead.choose(in: "/sta"))
        XCTAssertEqual(choice, SlashTypeahead.Choice(draft: "/status", caret: 7, unchanged: false))
        // The line is whole: the list stays shut, so the next Return sends it.
        typeahead.update(draft: choice.draft, caret: choice.caret)
        XCTAssertFalse(typeahead.isShowing)
        // Typing on opens it again.
        typeahead.update(draft: "/statu", caret: nil)
        XCTAssertTrue(typeahead.isShowing)
    }

    func testChoosingWhatIsAlreadyTypedChangesNothingSoReturnSends() throws {
        var typeahead = typed("/status")
        XCTAssertEqual(typeahead.selection?.line, "/status")
        XCTAssertEqual(typeahead.choose(in: "/status"), SlashTypeahead.Choice(draft: "/status", caret: 7, unchanged: true))
    }

    func testWhatFollowsTheWordIsKept() {
        XCTAssertEqual(
            SlashTypeahead.fill("/comp keep auth", with: AgentCommand(line: "/compact", detail: "", argumentHint: "what")),
            SlashTypeahead.Choice(draft: "/compact keep auth", caret: 9, unchanged: false)
        )
        XCTAssertEqual(
            SlashTypeahead.fill("/sta\nmore", with: AgentCommand(line: "/status", detail: "")),
            SlashTypeahead.Choice(draft: "/status\nmore", caret: 7, unchanged: false)
        )
    }

    func testACodexSkillIsAMentionThatWaitsForTheMessage() throws {
        var typeahead = typed("$pon", in: Self.codex)
        let choice = try XCTUnwrap(typeahead.choose(in: "$pon"))
        XCTAssertEqual(choice, SlashTypeahead.Choice(draft: "$ponytail ", caret: 10, unchanged: false))
        XCTAssertEqual(SlashTypeahead.placeholder(for: choice.draft, caret: nil, in: Self.codex), "your message")
        // Its own hint, where it has one.
        XCTAssertEqual(SlashTypeahead.placeholder(for: "$audit ", caret: nil, in: Self.codex), "path")
    }

    func testChoosingARowOtherThanTheHighlightedOne() throws {
        var typeahead = typed("/c")
        let clear = try XCTUnwrap(typeahead.matches.first { $0.line == "/clear" })
        XCTAssertEqual(typeahead.choose(clear, in: "/c")?.draft, "/clear")
    }

    // MARK: Keys and dismissal

    func testArrowsMoveAndStopAtTheEnds() {
        var typeahead = typed("/c")
        let count = typeahead.matches.count
        XCTAssertGreaterThan(count, 2)
        XCTAssertEqual(typeahead.selected, 0)
        typeahead.move(-1)
        XCTAssertEqual(typeahead.selected, 0)
        typeahead.move(1)
        typeahead.move(1)
        XCTAssertEqual(typeahead.selected, 2)
        typeahead.move(99)
        XCTAssertEqual(typeahead.selected, count - 1)
        // A caret moved inside the same word keeps the row; a new letter goes back to the best match.
        typeahead.update(draft: "/c", caret: 1)
        XCTAssertEqual(typeahead.selected, count - 1)
        typeahead.update(draft: "/co", caret: nil)
        XCTAssertEqual(typeahead.selected, 0)
    }

    func testEscClosesItUntilTheWordChanges() {
        var typeahead = typed("/co")
        typeahead.dismiss()
        XCTAssertFalse(typeahead.isShowing)
        XCTAssertNil(typeahead.choose(in: "/co"), "nothing to choose with it closed, so Return sends")
        typeahead.update(draft: "/co", caret: 2)
        XCTAssertFalse(typeahead.isShowing)
        typeahead.update(draft: "/com", caret: nil)
        XCTAssertTrue(typeahead.isShowing)
        // Emptied and begun again, it opens.
        typeahead.dismiss()
        typeahead.update(draft: "", caret: nil)
        typeahead.update(draft: "/com", caret: nil)
        XCTAssertTrue(typeahead.isShowing)
    }

    func testTheHighlightFollowsTheRowWhenTheSkillsArrive() {
        var typeahead = typed("/c")
        typeahead.move(1)
        let row = typeahead.selection
        typeahead.setCatalog(Self.claude + [AgentCommand(line: "/cleanup", detail: "A skill")])
        XCTAssertEqual(typeahead.selection, row)
    }

    // MARK: Fixture

    private static func evidence(_ state: String) -> String {
        #"{"configured":{"state":"yes","basis":"filesystem","detail":"on disk"},"available":{"state":"\#(state)","basis":"none","detail":""},"loaded":{"state":"unknown","basis":"none","detail":""},"observed":{"state":"unknown","basis":"none","detail":""}}"#
    }

    private static func command(_ name: String, _ invocation: String, _ description: String, hint: String? = nil, available: String = "unknown") -> String {
        let hintJSON = hint.map { "\"\($0)\"" } ?? "null"
        return #"{"id":"command:\#(name)","kind":"command","name":"\#(name)","displayName":"\#(name)","description":"\#(description)","parentId":null,"scope":"user","sources":[],"evidence":\#(evidence(available)),"diagnostics":[],"command":{"path":"/c/\#(name).md","invocation":"\#(invocation)","ownerPluginId":null,"enabledForNextSession":null,"argumentHint":\#(hintJSON),"model":null,"allowedTools":[],"bytes":10}}"#
    }

    private static var inventory: String {
        let notes = #"{"id":"skill:notes","kind":"skill","name":"notes","displayName":"notes","description":"Keep notes","parentId":null,"scope":"user","sources":[],"evidence":\#(evidence("unknown")),"diagnostics":[],"skill":{"path":"/s","ownerPluginId":null,"enabledForNextSession":null,"visibility":"on","userInvocable":true,"modelInvocable":true,"allowedTools":[],"argumentHint":null,"model":null,"bytes":10}}"#
        let entities = [
            notes,
            command("ship", "/ship", "Ship the branch", hint: "[pr title]"),
            command("notes", "/notes", "A command of the same name"),
            command("audit", "/kit:audit", "Audit the diff"),
            command("off", "/kit:off", "Its plugin is off", available: "no"),
        ].joined(separator: ",")
        return #"{"context":{"backend":"claude","cwd":"/Users/t/p","projectTrust":null,"threadConfiguration":null},"entities":[\#(entities)],"diagnostics":[],"complete":true}"#
    }
}
