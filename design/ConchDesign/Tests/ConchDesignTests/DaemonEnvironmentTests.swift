import XCTest
@testable import ConchDesign

final class DaemonEnvironmentTests: XCTestCase {
    func testAnAppOpenedFromInsideASessionHandsTheDaemonNoneOfThatSession() {
        let inherited = [
            "HOME": "/Users/t", "PATH": "/usr/bin",
            "CLAUDECODE": "1", "CLAUDE_CONFIG_DIR": "/Users/t/.config/conch/claude/work",
            "CLAUDE_CODE_SESSION_ID": "b10e6872", "TMUX": "/private/tmp/tmux-501/default,1,0", "TMUX_PANE": "%0",
            "CONCH_BACKGROUND_PID": "15850", "CONCH_APP_BUNDLE": "/Applications/conch.app", "CODEX_SHELL": "1",
        ]
        XCTAssertEqual(DaemonEnvironment.cleaned(inherited), ["HOME": "/Users/t", "PATH": "/usr/bin"])
    }

    func testANormalLaunchKeepsWhatThePersonSet() {
        let own = ["HOME": "/Users/t", "CLAUDE_CONFIG_DIR": "/Users/t/claude-elsewhere", "CONCH_TMUX": "/opt/tmux"]
        XCTAssertFalse(DaemonEnvironment.launchedFromAgentSession(own))
        XCTAssertEqual(DaemonEnvironment.cleaned(own), own)
    }
}
