import XCTest
@testable import ConchDesign

final class SessionLocationTests: XCTestCase {
    func testDesktopAndTerminalUseDifferentDestinations() {
        XCTAssertEqual(SessionLocation.resolve(backend: "codex", messageRoute: "codex-app", revealable: false,
                                                noTerminal: "App hosted", parentSessionId: nil), .codexApp)
        for backend in ["claude", "codex"] {
            XCTAssertEqual(SessionLocation.resolve(backend: backend, messageRoute: nil, revealable: true,
                                                    noTerminal: nil, parentSessionId: nil), .terminal)
        }
        XCTAssertNotEqual(SessionLocation.terminal.symbol, SessionLocation.codexApp.symbol)
    }

    func testNoMisleadingShortcutForUnknownHostsOrSubagents() {
        XCTAssertNil(SessionLocation.resolve(backend: "codex", messageRoute: nil, revealable: false,
                                             noTerminal: "Headless", parentSessionId: nil))
        XCTAssertNil(SessionLocation.resolve(backend: "claude", messageRoute: "codex-app", revealable: false,
                                             noTerminal: "Unknown app", parentSessionId: nil))
        XCTAssertNil(SessionLocation.resolve(backend: "claude", messageRoute: nil, revealable: true,
                                             noTerminal: "Closed", parentSessionId: nil))
        XCTAssertNil(SessionLocation.resolve(backend: "codex", messageRoute: "codex-app", revealable: true,
                                             noTerminal: nil, parentSessionId: "parent"))
    }

    func testTerminalWinsWhenBothLocationsAreAvailable() {
        XCTAssertEqual(SessionLocation.resolve(backend: "codex", messageRoute: "codex-app", revealable: true,
                                                noTerminal: nil, parentSessionId: nil), .terminal)
    }
}
