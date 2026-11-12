import XCTest
@testable import ConchDesign

/// What Not in conch says (2026-11-12): the daemon sends codes (src/elsewhere.ts), and both apps say them alike.
final class ElsewhereTextTests: XCTestCase {
    private let swapRun = ElsewhereAgent(id: "claude:4927", backend: "claude", pid: 4927, host: "tmux", reason: "profile",
        remedy: "add-account", label: "harbor-12", cwd: "/Users/t/Projects/Harbor", account: "~/.claude-work",
        conversationId: "5f1c2a7e-3b9d-4c60-9e21-7a8b4d6c0f13")

    func testARowSaysWhatItIsWhereItRunsAndWhyItIsntARow() {
        XCTAssertEqual(ElsewhereText.title(swapRun), "harbor-12")
        XCTAssertEqual(ElsewhereText.line(swapRun), "tmux · Profile conch doesn't read")
        XCTAssertEqual(ElsewhereText.shortHostName("iterm"), "iTerm")
        XCTAssertEqual(ElsewhereText.actionTitle(swapRun), "Add")
        XCTAssertTrue(ElsewhereText.fix(swapRun).contains("~/.claude-work"))
        XCTAssertEqual(ElsewhereText.accessibilityLabel(swapRun), "harbor-12, Claude in tmux, Profile conch doesn't read")
    }

    func testTheChatGPTAppIsOneRowThatSendsYouToResume() {
        let app = ElsewhereAgent(id: "codex:724", backend: "codex", pid: 2192, host: "chatgpt", reason: "app", remedy: "start-sheet")
        XCTAssertEqual(ElsewhereText.title(app), "ChatGPT app")
        XCTAssertEqual(ElsewhereText.line(app), "Codex · conch can't type into it")
        XCTAssertEqual(app.action, .startSheet)
        XCTAssertEqual(ElsewhereText.actionTitle(app), "Resume…")
        XCTAssertNil(ElsewhereText.confirmation(app, background: false))
    }

    func testResumeAsksFirstAndSaysTheOriginalKeepsRunning() throws {
        let iterm = ElsewhereAgent(id: "claude:802", backend: "claude", pid: 802, host: "iterm", reason: "profile", remedy: "resume",
            cwd: "/Users/t/site", account: "~/.claude-work", conversationId: "11111111-1111-4111-8111-111111111111")
        let asked = try XCTUnwrap(ElsewhereText.confirmation(iterm, background: true))
        XCTAssertEqual(asked.title, "Resume “site” in conch?")
        XCTAssertTrue(asked.message.contains("a new background session in ~/.claude-work"))
        XCTAssertTrue(asked.message.contains("The original keeps running in iTerm; conch won't stop it."))
        XCTAssertEqual(asked.confirm, "Resume in conch")
    }

    func testWithNothingToPressTheFixIsSaidInstead() {
        let unknown = ElsewhereAgent(id: "claude:9", backend: "claude", pid: 9, host: "vscode", reason: "no-registry", remedy: "none")
        XCTAssertNil(unknown.action)
        XCTAssertNil(ElsewhereText.actionTitle(unknown))
        XCTAssertEqual(ElsewhereText.title(unknown), "Claude in VS Code")
        XCTAssertTrue(ElsewhereText.fix(unknown).hasPrefix("If it's waiting on Claude's first question"))
        // A resume with no conversation to resume is no button.
        let noID = ElsewhereAgent(id: "codex:9", backend: "codex", pid: 9, host: "terminal", reason: "codex-thread", remedy: "resume")
        XCTAssertNil(noID.action)
    }

    func testTheHeaderCountsAgents() {
        XCTAssertEqual(ElsewhereText.headerAccessibility(count: 1, collapsed: true), "Not in conch, 1 agent, collapsed")
        XCTAssertEqual(ElsewhereText.headerAccessibility(count: 3, collapsed: false), "Not in conch, 3 agents")
    }
}
