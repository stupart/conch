import SwiftUI
import XCTest
@testable import ConchDesign

/// The Terminal tab of a session conch hosts in its own tmux: what the strip offers, what the work half shows, how the
/// client attaches, which keys it sends itself, and where the New session sheet starts.
final class EmbeddedTerminalTests: XCTestCase {
    private let hosted = ConchHostedTerminal(
        tmux: "/Applications/conch.app/Contents/Helpers/tmux",
        socket: "/private/tmp/tmux-501/conch",
        session: "claude-conch-7k2f",
        pane: "%3"
    )

    // MARK: The strip

    func testAHostedSessionsTerminalIsATabNotTheButton() {
        let strip = ConchTerminalStrip(hasTerminal: true, mirrorOn: false, hosted: true)
        XCTAssertTrue(strip.showsEmbedded)
        XCTAssertFalse(strip.showsButton, "the button brings a Terminal window forward; a hosted session is the tab")
        XCTAssertEqual(strip.places, 1)
    }

    func testEverySessionConchDoesNotHostKeepsTheButton() {
        let strip = ConchTerminalStrip(hasTerminal: true, mirrorOn: false)
        XCTAssertTrue(strip.showsButton)
        XCTAssertFalse(strip.showsEmbedded)
        XCTAssertEqual(strip.places, 1)
        XCTAssertEqual(strip.press(option: false), .reveal)
    }

    func testTheMirrorStillFollowsTheDebugSettingForAHostedSession() {
        XCTAssertEqual(ConchTerminalStrip(hasTerminal: true, mirrorOn: true, hosted: true).places, 2)
        XCTAssertFalse(ConchTerminalStrip(hasTerminal: true, mirrorOn: false, hosted: true).showsMirror)
    }

    // MARK: The work half

    func testAHostedSessionAlwaysHasSomethingForTheWorkHalf() {
        let strip = ConchTerminalStrip(hasTerminal: true, mirrorOn: false, hosted: true)
        XCTAssertTrue(strip.hasWorkPane(hasFolder: false, hasDeliverable: false))
        XCTAssertFalse(ConchTerminalStrip(hasTerminal: true, mirrorOn: false).hasWorkPane(hasFolder: false, hasDeliverable: false),
                       "the Terminal button is not something to show there")
    }

    func testAHostedSessionWithNothingElseOpensOnItsTerminal() {
        let strip = ConchTerminalStrip(hasTerminal: true, mirrorOn: false, hosted: true)
        XCTAssertEqual(strip.workPane(chosen: .deliverable, hasFolder: false, hasDeliverable: false), .embeddedTerminal)
    }

    func testTheTerminalTabIsHonouredOnlyWhileTheSessionIsHosted() {
        let hostedStrip = ConchTerminalStrip(hasTerminal: true, mirrorOn: false, hosted: true)
        XCTAssertEqual(hostedStrip.workPane(chosen: .embeddedTerminal, hasFolder: true, hasDeliverable: true), .embeddedTerminal)
        let plain = ConchTerminalStrip(hasTerminal: true, mirrorOn: false)
        XCTAssertEqual(plain.workPane(chosen: .embeddedTerminal, hasFolder: true, hasDeliverable: true), .deliverable)
        XCTAssertEqual(plain.workPane(chosen: .embeddedTerminal, hasFolder: true, hasDeliverable: false), .files)
        XCTAssertEqual(plain.workPane(chosen: .embeddedTerminal, hasFolder: false, hasDeliverable: false), .deliverable)
    }

    func testFilesAndShellStillWinWhenPickedAndTheDeliverableBeforeTheTerminalWhenNot() {
        let strip = ConchTerminalStrip(hasTerminal: true, mirrorOn: false, hosted: true)
        XCTAssertEqual(strip.workPane(chosen: .files, hasFolder: true, hasDeliverable: true), .files)
        XCTAssertEqual(strip.workPane(chosen: .shell, hasFolder: true, hasDeliverable: true), .shell)
        XCTAssertEqual(strip.workPane(chosen: .files, hasFolder: false, hasDeliverable: true), .deliverable)
        XCTAssertEqual(strip.workPane(chosen: .deliverable, hasFolder: true, hasDeliverable: false), .files)
        XCTAssertEqual(strip.workPane(chosen: .terminal, hasFolder: false, hasDeliverable: false), .embeddedTerminal,
                       "the mirror, off, falls back to the session itself")
    }

    func testTheMirrorIsStillTheDebugPane() {
        let strip = ConchTerminalStrip(hasTerminal: true, mirrorOn: true)
        XCTAssertEqual(strip.workPane(chosen: .terminal, hasFolder: true, hasDeliverable: true), .terminal)
        XCTAssertEqual(strip.workPane(chosen: .deliverable, hasFolder: false, hasDeliverable: false), .terminal)
    }

    func testTheNewPaneIsRememberedUnderItsOwnName() {
        XCTAssertEqual(WorkPane.embeddedTerminal.rawValue, "embeddedTerminal")
        XCTAssertEqual(WorkPane(rawValue: "terminal"), .terminal, "the mirror keeps its raw value")
    }

    // MARK: Attaching

    func testTheClientAttachesByExactNameOverTheSocketWithoutResizingAnyoneElse() {
        XCTAssertEqual(hosted.attachArguments,
                       ["-u", "-S", "/private/tmp/tmux-501/conch", "attach-session", "-f", "ignore-size", "-t", "=claude-conch-7k2f"])
    }

    func testOnlyWhatConchMakesIsAttachedTo() {
        XCTAssertTrue(hosted.isUsable)
        let bad: [ConchHostedTerminal] = [
            .init(tmux: "tmux", socket: hosted.socket, session: hosted.session, pane: "%3"),
            .init(tmux: "/tmp/evil", socket: hosted.socket, session: hosted.session, pane: "%3"),
            .init(tmux: hosted.tmux, socket: "conch", session: hosted.session, pane: "%3"),
            .init(tmux: hosted.tmux, socket: hosted.socket, session: "a;rm -rf ~", pane: "%3"),
            .init(tmux: hosted.tmux, socket: hosted.socket, session: "a.b:c", pane: "%3"),
            .init(tmux: hosted.tmux, socket: hosted.socket, session: hosted.session, pane: "3"),
        ]
        for terminal in bad { XCTAssertFalse(terminal.isUsable, "\(terminal)") }
    }

    func testTheClientRunsTheServersOwnTmuxElseTheAppsOwn() {
        let bundled = "/Applications/conch.app/Contents/Helpers/tmux"
        XCTAssertEqual(ConchHostedTerminal.binary(published: "/opt/homebrew/bin/tmux", bundled: bundled, isExecutable: { _ in true }),
                       "/opt/homebrew/bin/tmux")
        XCTAssertEqual(ConchHostedTerminal.binary(published: "/opt/homebrew/bin/tmux", bundled: bundled, isExecutable: { $0 == bundled }),
                       bundled)
        XCTAssertEqual(ConchHostedTerminal.binary(published: "/tmp/not-tmux", bundled: bundled, isExecutable: { _ in true }), bundled)
        XCTAssertNil(ConchHostedTerminal.binary(published: "/opt/homebrew/bin/tmux", bundled: nil, isExecutable: { _ in false }))
    }

    func testTheClientSpeaksUTF8InTheTerminalSwiftTermEmulates() {
        let environment = ConchHostedTerminal.clientEnvironment(["PATH": "/usr/bin", "TMUX": "/tmp/x,1,0", "TMUX_PANE": "%1"])
        XCTAssertEqual(environment["TERM"], "xterm-256color")
        XCTAssertEqual(environment["COLORTERM"], "truecolor")
        XCTAssertEqual(environment["LANG"], "en_US.UTF-8", "a Finder-launched app has no LANG, and tmux then draws _")
        XCTAssertNil(environment["TMUX"], "a client inside tmux refuses to nest")
        XCTAssertNil(environment["TMUX_PANE"])
        XCTAssertEqual(ConchHostedTerminal.clientEnvironment(["LANG": "fr_FR.UTF-8"])["LANG"], "fr_FR.UTF-8")
    }

    func testTheRowDecodesFromTheDaemonsWords() throws {
        let json = #"{"tmux":"/opt/homebrew/bin/tmux","socket":"/private/tmp/tmux-501/conch","session":"codex-x-abcd","pane":"%12"}"#
        let decoded = try JSONDecoder().decode(ConchHostedTerminal.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.session, "codex-x-abcd")
        XCTAssertTrue(decoded.isUsable)
    }

    // MARK: Keys

    func testShiftReturnIsCSIuAndNothingElseIs() {
        XCTAssertEqual(ConchTerminalKeys.shiftReturn, [0x1B, 0x5B, 0x31, 0x33, 0x3B, 0x32, 0x75])
        XCTAssertEqual(ConchTerminalKeys.bytes(keyCode: 36, shift: true, control: false, option: false, command: false), ConchTerminalKeys.shiftReturn)
        XCTAssertEqual(ConchTerminalKeys.bytes(keyCode: 76, shift: true, control: false, option: false, command: false), ConchTerminalKeys.shiftReturn)
        XCTAssertNil(ConchTerminalKeys.bytes(keyCode: 36, shift: false, control: false, option: false, command: false), "Return sends")
        XCTAssertNil(ConchTerminalKeys.bytes(keyCode: 36, shift: true, control: true, option: false, command: false))
        XCTAssertNil(ConchTerminalKeys.bytes(keyCode: 36, shift: true, control: false, option: true, command: false))
        XCTAssertNil(ConchTerminalKeys.bytes(keyCode: 36, shift: true, control: false, option: false, command: true))
        XCTAssertNil(ConchTerminalKeys.bytes(keyCode: 53, shift: true, control: false, option: false, command: false), "Esc is the TUI's")
    }

    func testAnImageAloneOnTheClipboardIsPastedWithClaudesOwnKey() {
        XCTAssertEqual(ConchTerminalKeys.paste(hasText: true, hasImage: true), .text)
        XCTAssertEqual(ConchTerminalKeys.paste(hasText: false, hasImage: true), .image)
        XCTAssertEqual(ConchTerminalKeys.paste(hasText: false, hasImage: false), .nothing)
        XCTAssertEqual(ConchTerminalKeys.imagePaste, [0x16])
    }

    // MARK: The New session sheet

    func testTheSheetStartsInTerminalUnlessTheSettingSaysConch() {
        XCTAssertEqual(SessionStartHost.initial(runInConch: nil), .terminal, "a daemon that can't say leaves today's behaviour")
        XCTAssertEqual(SessionStartHost.initial(runInConch: false), .terminal)
        XCTAssertEqual(SessionStartHost.initial(runInConch: true), .conch)
        XCTAssertEqual(SessionStartHost.allCases, [.terminal, .conch], "In Terminal comes first")
        XCTAssertEqual(SessionStartHost.terminal.label, "In Terminal")
        XCTAssertEqual(SessionStartHost.conch.label, "In conch")
        XCTAssertEqual(SessionStartHost.conch.rawValue, "conch", "the daemon's word")
        XCTAssertEqual(SessionStartHost.terminal.rawValue, "terminal")
        XCTAssertTrue(SessionStartHost.conch.footnote(agent: "Claude").contains("Terminal tab"))
        XCTAssertTrue(SessionStartHost.terminal.footnote(agent: "Codex").contains("Terminal window"))
    }

    // MARK: Colours

    func testTheTerminalIsDrawnOnConchsOwnSurfaceInItsOwnText() {
        for scheme in [ColorScheme.light, .dark] {
            let theme = ConchEmbeddedTerminalColors.theme(scheme)
            XCTAssertEqual(theme.background, ConchColor.surface.rgba(scheme))
            XCTAssertEqual(theme.foreground, ConchColor.textPrimary.rgba(scheme))
            XCTAssertEqual(theme.ansi.count, 16)
        }
    }

    func testTheSixColoursAProgramWritesWithReadOnTheSurface() {
        // Red, green, yellow, blue, magenta, cyan: text a TUI draws in them clears 3:1 on conch's surface in both.
        for scheme in [ColorScheme.light, .dark] {
            let theme = ConchEmbeddedTerminalColors.theme(scheme)
            for index in 1...6 {
                let ratio = theme.ansi[index].contrast(on: theme.background)
                XCTAssertGreaterThanOrEqual(ratio, 3, "ansi \(index) in \(scheme): \(ratio)")
            }
        }
    }
}
