import XCTest
@testable import ConchDesign

/// Not in conch's rows (2026-11-12): the daemon sends remedy codes (src/elsewhere.ts), and each is the row's button.
final class ElsewhereTextTests: XCTestCase {
    func testTheDaemonsRemedyCodeIsTheRowsButton() {
        let swap = ElsewhereAgent(id: "claude:4927", backend: "claude", pid: 4927, host: "tmux", reason: "profile", remedy: "add-account")
        XCTAssertEqual(swap.action, .addAccount)
        let app = ElsewhereAgent(id: "codex:724", backend: "codex", pid: 2192, host: "chatgpt", reason: "app", remedy: "start-sheet")
        XCTAssertEqual(app.action, .startSheet)
        XCTAssertNil(ElsewhereText.confirmation(app, background: false))
        // Resume asks first, and only with a conversation to resume is it a button at all.
        let iterm = ElsewhereAgent(id: "claude:802", backend: "claude", pid: 802, host: "iterm", reason: "profile", remedy: "resume",
            cwd: "/Users/t/site", account: "~/.claude-work", conversationId: "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(iterm.action, .resume)
        XCTAssertNotNil(ElsewhereText.confirmation(iterm, background: true))
        let noID = ElsewhereAgent(id: "codex:9", backend: "codex", pid: 9, host: "terminal", reason: "codex-thread", remedy: "resume")
        XCTAssertNil(noID.action)
        let unknown = ElsewhereAgent(id: "claude:9", backend: "claude", pid: 9, host: "vscode", reason: "no-registry", remedy: "none")
        XCTAssertNil(unknown.action)
        XCTAssertNil(ElsewhereText.actionTitle(unknown))
    }
}
