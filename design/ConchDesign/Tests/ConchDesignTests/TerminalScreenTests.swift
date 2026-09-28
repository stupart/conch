import SwiftUI
import XCTest
@testable import ConchDesign

/// The Terminal tab's screen: what a Claude Code or Codex TUI draws, parsed from tmux's own capture of it.
///
/// The fixtures are real `tmux capture-pane -p -e -N` output, taken from a throwaway tmux server: `claude --help` and
/// `codex --help` themselves, and a frame drawn with the escape sequences each TUI uses (Claude Code's 24-bit colours,
/// painted diff lines and inverted cursor cell; Codex's sixteen, dim, reverse and 256-colour grey) run through tmux so
/// the re-encoding is tmux's. No agent ran a turn for any of them.
final class TerminalScreenTests: XCTestCase {
    private func fixture(_ name: String) throws -> String {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "ansi", subdirectory: "Fixtures"))
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func style(_ build: (inout ConchTerminalCellStyle) -> Void) -> ConchTerminalCellStyle {
        var style = ConchTerminalCellStyle()
        build(&style)
        return style
    }

    /// The run whose text contains `text`, on `row`.
    private func run(_ screen: ConchTerminalScreen, row: Int, containing text: String, file: StaticString = #filePath, line: UInt = #line) -> ConchTerminalScreenRun? {
        let found = screen.lines[row].first { $0.text.contains(text) }
        XCTAssertNotNil(found, "no run with \"\(text)\" on row \(row): \(screen.lines[row].map(\.text))", file: file, line: line)
        return found
    }

    // MARK: Real captures

    func testClaudeCodesFrameKeepsItsTwentyFourBitColoursItsPaintedDiffAndItsCursorCell() throws {
        let screen = ConchTerminalScreen(capture: try fixture("terminal-claude-tui"), columns: 100, rows: 22)
        XCTAssertEqual(screen.lines.count, 22)
        let orange = ConchTerminalColor.rgb(215, 119, 87)
        let grey = ConchTerminalColor.rgb(153, 153, 153)

        XCTAssertEqual(run(screen, row: 0, containing: "╭───")?.style, style { $0.foreground = orange })
        XCTAssertEqual(run(screen, row: 1, containing: "✻")?.style, style { $0.foreground = orange })
        XCTAssertEqual(run(screen, row: 1, containing: "Claude Code")?.style, style { $0.bold = true })
        XCTAssertEqual(run(screen, row: 3, containing: "/help for help")?.style, style { $0.foreground = grey })

        // Diff lines are painted, trailing spaces and all, and the paint stops where the program stopped it.
        let removed = try XCTUnwrap(run(screen, row: 10, containing: "2641 -"))
        XCTAssertEqual(removed.style, style { $0.background = .rgb(122, 41, 54) })
        XCTAssertTrue(removed.text.hasSuffix("Text(\"Terminal\")                              "))
        XCTAssertEqual(run(screen, row: 11, containing: "2641 +")?.style, style { $0.background = .rgb(34, 92, 43) })
        XCTAssertEqual(screen.lines[11].last?.style, ConchTerminalCellStyle(), "`49m` ends the paint")

        // Claude Code hides the terminal's cursor and inverts a cell of its own.
        let prompt = screen.lines[16]
        XCTAssertEqual(prompt.first { $0.style.inverse }?.text, " ")
        XCTAssertEqual(run(screen, row: 18, containing: "auto-accept edits on")?.style, style { $0.foreground = .rgb(175, 135, 255) })
        XCTAssertEqual(run(screen, row: 18, containing: "(shift+tab to cycle)")?.style, style { $0.dim = true })

        XCTAssertFalse(screen.plainText.contains("\u{1B}"), "no escape is ever printed")
        XCTAssertTrue(screen.plainText.contains("✻ Cogitating… (12s · ↓ 1.2k tokens · esc to interrupt)"))
    }

    func testCodexsFrameKeepsTheSixteenDimReverseAndItsGrey() throws {
        let screen = ConchTerminalScreen(capture: try fixture("terminal-codex-tui"), columns: 100, rows: 22)
        XCTAssertEqual(run(screen, row: 0, containing: "╭──")?.style, style { $0.dim = true })
        XCTAssertEqual(run(screen, row: 1, containing: ">_ OpenAI Codex")?.style, style { $0.bold = true })
        XCTAssertEqual(run(screen, row: 3, containing: "/model")?.style, style { $0.foreground = .indexed(6) })
        XCTAssertEqual(run(screen, row: 9, containing: "•")?.style, style { $0.foreground = .indexed(2) })
        // `+` green then `-` red, with no reset between: a colour replaces a colour.
        XCTAssertEqual(screen.lines[10].first { $0.text == "+" }?.style, style { $0.foreground = .indexed(2) })
        XCTAssertEqual(screen.lines[10].first { $0.text == "-" }?.style, style { $0.foreground = .indexed(1) })
        XCTAssertEqual(run(screen, row: 12, containing: "•")?.style, style { $0.foreground = .indexed(5) })
        XCTAssertEqual(screen.lines[14].first { $0.style.inverse }?.text, " ")
        XCTAssertEqual(run(screen, row: 16, containing: "? for shortcuts")?.style, style { $0.foreground = .indexed(245) })
        XCTAssertEqual(run(screen, row: 16, containing: "100% context left")?.style, style { $0.dim = true })
    }

    func testClaudesHelpIsPlainTextRowForRow() throws {
        let capture = try fixture("terminal-claude-help")
        let screen = ConchTerminalScreen(capture: capture, columns: 100, rows: 34)
        XCTAssertEqual(screen.lines.count, 34)
        XCTAssertTrue(screen.lines.allSatisfy { $0.allSatisfy { $0.style == ConchTerminalCellStyle() } })
        // Nothing lost and nothing added: without escapes the capture IS the screen.
        XCTAssertEqual(screen.plainText + "\n", capture)
        XCTAssertTrue(screen.plainText.contains("Commands:"))
    }

    func testCodexsHelpKeepsItsBoldFlagsAndItsUnicode() throws {
        let screen = ConchTerminalScreen(capture: try fixture("terminal-codex-help"), columns: 100, rows: 34)
        let bold = screen.lines.flatMap { $0 }.filter { $0.style == style { $0.bold = true } }.map(\.text)
        XCTAssertTrue(bold.contains("--worktree"))
        XCTAssertTrue(bold.contains("--help"))
        XCTAssertTrue(bold.contains("on-request"))
        XCTAssertTrue(screen.plainText.contains("per\u{2011}call"), "a non-breaking hyphen survives as itself")
    }

    // MARK: SGR

    private func parsed(_ sgr: String, then text: String = "x") -> ConchTerminalCellStyle? {
        ConchTerminalScreen.parse("\u{1B}[\(sgr)m\(text)").first?.first?.style
    }

    func testExtendedColoursConsumeTheirOwnParts() {
        XCTAssertEqual(parsed("38;5;245"), style { $0.foreground = .indexed(245) })
        XCTAssertEqual(parsed("48;5;16"), style { $0.background = .indexed(16) })
        // The `2` of `38;2;…` is the colour's form, never dim; and the `1` of a colour value is never bold.
        XCTAssertEqual(parsed("38;2;1;2;3"), style { $0.foreground = .rgb(1, 2, 3) })
        XCTAssertEqual(parsed("1;38;2;215;119;87;48;2;34;92;43"), style { $0.bold = true; $0.foreground = .rgb(215, 119, 87); $0.background = .rgb(34, 92, 43) })
        // The colon forms, with and without the empty colour-space id.
        XCTAssertEqual(parsed("38:2::215:119:87"), style { $0.foreground = .rgb(215, 119, 87) })
        XCTAssertEqual(parsed("38:2:215:119:87"), style { $0.foreground = .rgb(215, 119, 87) })
        XCTAssertEqual(parsed("48:5:236"), style { $0.background = .indexed(236) })
        // An underline colour is read past, and what follows it still applies.
        XCTAssertEqual(parsed("58;2;255;0;0;1"), style { $0.bold = true })
        // Out of range is no colour at all rather than a wrong one.
        XCTAssertEqual(parsed("38;2;300;0;0"), ConchTerminalCellStyle())
        XCTAssertEqual(parsed("38;5"), ConchTerminalCellStyle())
    }

    func testAttributesComeAndGoInPairs() {
        XCTAssertEqual(parsed("1;2;3;4;7;8;9"), style { $0.bold = true; $0.dim = true; $0.italic = true; $0.underline = true; $0.inverse = true; $0.hidden = true; $0.strikethrough = true })
        XCTAssertEqual(parsed("1;2;22"), ConchTerminalCellStyle(), "22 ends bold AND dim")
        XCTAssertEqual(parsed("3;23;4;24;7;27;8;28;9;29"), ConchTerminalCellStyle())
        XCTAssertEqual(parsed("4:3"), style { $0.underline = true })
        XCTAssertEqual(parsed("4;4:0"), ConchTerminalCellStyle())
        XCTAssertEqual(parsed("31;39;41;49"), ConchTerminalCellStyle())
        XCTAssertEqual(parsed("91;101"), style { $0.foreground = .indexed(9); $0.background = .indexed(9) })
        XCTAssertEqual(parsed("1;31;0"), ConchTerminalCellStyle())
        XCTAssertEqual(parsed("1;31;"), ConchTerminalCellStyle(), "an empty code is a reset")
        XCTAssertEqual(ConchTerminalScreen.parse("\u{1B}[1;31m\u{1B}[mx").first?.first?.style, ConchTerminalCellStyle())
        XCTAssertEqual(parsed(">4;2"), ConchTerminalCellStyle(), "a private mode is not an attribute")
    }

    func testEverythingButColourIsPassedOverWithoutPrinting() {
        let hyperlinked = "a\u{1B}]8;;https://x.test\u{07}link\u{1B}]8;;\u{1B}\\b\u{1B}[2Kc\u{1B}=d\u{07}e\u{1B}P1$r\u{1B}\\f"
        XCTAssertEqual(ConchTerminalScreen(capture: hyperlinked, columns: 20, rows: 1).plainText, "alinkbcdef")
        // Style carries from row to row, as tmux writes it only where it changes.
        let carried = ConchTerminalScreen.parse("\u{1B}[31mred\nstill red\u{1B}[39m\nplain")
        XCTAssertEqual(carried[1].first?.style, style { $0.foreground = .indexed(1) })
        XCTAssertEqual(carried[2].first?.style, ConchTerminalCellStyle())
        // Runs merge while the style holds.
        XCTAssertEqual(ConchTerminalScreen.parse("ab\u{1B}[0mcd"), [[ConchTerminalScreenRun("abcd")]])
    }

    // MARK: Rows and the cursor

    func testTheScreenIsAlwaysTheTerminalsOwnHeight() {
        XCTAssertEqual(ConchTerminalScreen(capture: "one\n", columns: 10, rows: 4).lines.count, 4)
        let tall = ConchTerminalScreen(capture: "1\n2\n3\n4\n5\n", columns: 10, rows: 3)
        XCTAssertEqual(tall.plainText, "1\n2\n3")
        XCTAssertEqual(ConchTerminalScreen(capture: "", columns: 0, rows: 0).rows, 1)
    }

    func testTheCursorIsDrawnInvertedWhereItIs() {
        let red = style { $0.foreground = .indexed(1) }
        let screen = ConchTerminalScreen(capture: "\u{1B}[31mhello\u{1B}[39m world\n", columns: 20, rows: 2, cursor: (x: 1, y: 0))
        XCTAssertEqual(screen.lines[0], [
            ConchTerminalScreenRun("h", style: red),
            ConchTerminalScreenRun("e", style: style { $0.foreground = .indexed(1); $0.inverse = true }),
            ConchTerminalScreenRun("llo", style: red),
            ConchTerminalScreenRun(" world"),
        ])
        // Past the end of a row: padded out to it.
        let padded = ConchTerminalScreen(capture: "ab\n", columns: 20, rows: 1, cursor: (x: 4, y: 0))
        XCTAssertEqual(padded.lines[0], [ConchTerminalScreenRun("ab"), ConchTerminalScreenRun("  "), ConchTerminalScreenRun(" ", style: style { $0.inverse = true })])
        // On a cell already inverted, it shows by un-inverting it.
        let inverted = ConchTerminalScreen(capture: "\u{1B}[7m \u{1B}[0m", columns: 5, rows: 1, cursor: (x: 0, y: 0))
        XCTAssertEqual(inverted.lines[0], [ConchTerminalScreenRun(" ")])
        // Off the grid is no cursor.
        XCTAssertEqual(ConchTerminalScreen(capture: "ab", columns: 2, rows: 1, cursor: (x: 2, y: 0)).lines[0], [ConchTerminalScreenRun("ab")])
    }

    func testTerminalsOwnTextKeepsItsBottomRows() {
        let text = ConchTerminalScreen(plain: "old\nolder\n> hi\n\n\n", rows: 2)
        XCTAssertEqual(text.plainText, "older\n> hi")
        XCTAssertEqual(text.columns, 80)
        XCTAssertEqual(ConchTerminalScreen(plain: String(repeating: "x", count: 120)).columns, 120)
    }

    // MARK: Colour

    func testTheTwoHundredAndFiftySixAreXtermsAndTheSixteenAreTerminals() {
        let theme = ConchTerminalTheme.dark
        func hex(_ colour: ConchTerminalColor) -> UInt32 { theme.rgba(colour, foreground: true).hex }
        XCTAssertEqual(hex(.indexed(1)), 0x990000)
        XCTAssertEqual(hex(.indexed(9)), 0xE50000)
        XCTAssertEqual(hex(.indexed(16)), 0x000000)
        XCTAssertEqual(hex(.indexed(21)), 0x0000FF)
        XCTAssertEqual(hex(.indexed(196)), 0xFF0000)
        XCTAssertEqual(hex(.indexed(208)), 0xFF8700)
        XCTAssertEqual(hex(.indexed(231)), 0xFFFFFF)
        XCTAssertEqual(hex(.indexed(232)), 0x080808)
        XCTAssertEqual(hex(.indexed(245)), 0x8A8A8A)
        XCTAssertEqual(hex(.indexed(255)), 0xEEEEEE)
        XCTAssertEqual(hex(.rgb(215, 119, 87)), 0xD77757)
        XCTAssertEqual(ConchTerminalTheme.light.rgba(.default, foreground: true).hex, 0x000000)
        XCTAssertEqual(ConchTerminalTheme.light.rgba(.default, foreground: false).hex, 0xFFFFFF)
        XCTAssertEqual(ConchTerminalTheme.standard(.dark), .dark)
    }

    func testInverseDimAndHiddenAreDrawnAsATerminalDrawsThem() {
        let theme = ConchTerminalTheme.light
        XCTAssertNil(theme.resolve(ConchTerminalCellStyle()).background, "the terminal's own ground is never painted")
        let inverse = theme.resolve(style { $0.inverse = true })
        XCTAssertEqual(inverse.foreground.hex, 0xFFFFFF)
        XCTAssertEqual(inverse.background?.hex, 0x000000)
        let painted = theme.resolve(style { $0.inverse = true; $0.foreground = .indexed(1); $0.background = .indexed(4) })
        XCTAssertEqual(painted.foreground.hex, 0x0000B2)
        XCTAssertEqual(painted.background?.hex, 0x990000)
        // Dim is half way to the ground: black on white is a mid grey.
        XCTAssertEqual(theme.resolve(style { $0.dim = true }).foreground.hex, 0x808080)
        XCTAssertEqual(theme.resolve(style { $0.hidden = true; $0.background = .indexed(2) }).foreground.hex, 0x00A600)
    }

    func testTheAttributedScreenSaysExactlyWhatTheScreenSays() throws {
        let screen = ConchTerminalScreen(capture: try fixture("terminal-claude-tui"), columns: 100, rows: 22)
        let attributed = screen.attributed(theme: .dark, size: 12)
        XCTAssertEqual(String(attributed.characters), screen.plainText + " ", "the empty last row keeps its line")
        let painted = attributed.runs.filter { $0.backgroundColor != nil }.map { String(attributed[$0.range].characters) }
        XCTAssertTrue(painted.contains { $0.contains("2641 -") })
        XCTAssertTrue(painted.contains { $0.contains("2641 +") })
        XCTAssertTrue(painted.contains(" "), "the cursor cell")
    }

    func testTheTypeFitsTheColumnsIntoTheWidth() {
        XCTAssertEqual(ConchTerminalMetrics.fontSize(columns: 80, width: 2_000), 13)
        let fitted = ConchTerminalMetrics.fontSize(columns: 120, width: 700)
        XCTAssertLessThanOrEqual(CGFloat(120) * fitted * ConchTerminalMetrics.advance, 700)
        XCTAssertGreaterThan(CGFloat(120) * (fitted + 0.1) * ConchTerminalMetrics.advance, 700)
        XCTAssertEqual(ConchTerminalMetrics.fontSize(columns: 400, width: 300), 7, "past 7 pt it scrolls instead")
        XCTAssertEqual(ConchTerminalMetrics.fontSize(columns: 0, width: 300), 13)
    }
}

/// What the Terminal tab shows, and when it reads anything at all.
final class TerminalMirrorTests: XCTestCase {
    private func location(_ json: String) throws -> ConchTerminalLocation {
        try JSONDecoder().decode(ConchTerminalLocation.self, from: Data(json.utf8))
    }

    private let tmux = #"{"kind":"terminal-screen","sessionId":"s","host":"tmux","pane":"%7","columns":20,"rows":2,"cursor":{"x":0,"y":1},"screen":"\u001b[1mhi\u001b[0m\n> \n"}"#
    private func terminal(minimized: Bool = false, selected: Bool = true, text: String? = nil) -> String {
        #"{"kind":"terminal-screen","sessionId":"s","host":"terminal","tty":"ttys012","window":4242,"minimized":\#(minimized),"selected":\#(selected)"#
            + (text.map { #","text":"\#($0)""# } ?? "") + "}"
    }

    func testATmuxPaneIsItsScreen() throws {
        let state = ConchAgentTerminalState.deciding(try location(tmux), screenRecording: .denied)
        guard case let .screen(screen) = state else { return XCTFail("\(state)") }
        XCTAssertEqual(screen.plainText, "hi\n> ")
        XCTAssertEqual(screen.lines[1].first, ConchTerminalScreenRun(">", style: { var cursor = ConchTerminalCellStyle(); cursor.inverse = true; return cursor }()), "the cursor")
        // Screen Recording is never needed for text tmux already has.
        XCTAssertEqual(ConchAgentTerminalState.wantsText(after: state, screenRecording: .granted), false)
    }

    func testATerminalWindowIsPicturedOnlyWhenItCanBe() throws {
        XCTAssertEqual(ConchAgentTerminalState.deciding(try location(terminal()), screenRecording: .granted), .window(4242))
        XCTAssertEqual(ConchAgentTerminalState.deciding(try location(terminal(minimized: true)), screenRecording: .granted), .text(nil, .minimized))
        XCTAssertEqual(ConchAgentTerminalState.deciding(try location(terminal(selected: false)), screenRecording: .granted), .text(nil, .otherTab))
        XCTAssertEqual(ConchAgentTerminalState.deciding(try location(terminal()), screenRecording: .granted, pictureFailure: "no window"),
                       .text(nil, .pictureFailed("no window")))
    }

    func testWithoutScreenRecordingItIsTheTabsTextAndTheButtonNeverABlank() throws {
        let state = ConchAgentTerminalState.deciding(try location(terminal(text: "$ claude\\n> hello")), screenRecording: .denied)
        guard case let .text(screen, why) = state else { return XCTFail("\(state)") }
        XCTAssertEqual(screen?.plainText, "$ claude\n> hello")
        XCTAssertEqual(why, .needsScreenRecording(.denied))
        XCTAssertEqual(why.action, .openSettings)
        XCTAssertTrue(why.line.contains("Screen Recording"))
        XCTAssertEqual(ConchTerminalFallback.needsScreenRecording(.needsRelaunch).action, .reopen)
        XCTAssertTrue(ConchTerminalFallback.needsScreenRecording(.needsRelaunch).line.contains("reopen conch"))
        XCTAssertEqual(ConchTerminalFallback.needsScreenRecording(.notAsked).action, .ask)
        XCTAssertEqual(ConchTerminalFallback.needsScreenRecording(.unknown("Checking…")).action, .openSettings)
        XCTAssertNil(ConchTerminalFallback.needsScreenRecording(.restricted).action)
        XCTAssertNil(ConchTerminalFallback.minimized.action)
        // Its text is asked for while it has no picture, and not once it has one.
        XCTAssertTrue(ConchAgentTerminalState.wantsText(after: .finding, screenRecording: .denied))
        XCTAssertTrue(ConchAgentTerminalState.wantsText(after: .text(nil, .otherTab), screenRecording: .granted))
        XCTAssertFalse(ConchAgentTerminalState.wantsText(after: .window(1), screenRecording: .granted))
    }

    func testNoTerminalSaysWhy() throws {
        let none = try location(#"{"kind":"terminal-screen","sessionId":"s","host":"none","reason":"a closed Codex thread"}"#)
        XCTAssertEqual(ConchAgentTerminalState.deciding(none, screenRecording: .granted), .unavailable("a closed Codex thread"))
        let torn = try location(#"{"kind":"terminal-screen","sessionId":"s","host":"tmux","pane":"%1"}"#)
        XCTAssertEqual(ConchAgentTerminalState.deciding(torn, screenRecording: .granted), .unavailable("tmux sent conch a screen it couldn't read."))
        XCTAssertThrowsError(try location(#"{"kind":"session-error","error":"x"}"#))
    }

    func testReadsAreOftenOnlyWhereAReadIsThePicture() {
        let screen = ConchAgentTerminalState.screen(ConchTerminalScreen(capture: "", columns: 1, rows: 1)).nextRead
        XCTAssertLessThan(screen, ConchAgentTerminalState.text(nil, .minimized).nextRead)
        XCTAssertLessThan(ConchAgentTerminalState.text(nil, .minimized).nextRead, ConchAgentTerminalState.window(1).nextRead)
        XCTAssertLessThan(ConchAgentTerminalState.window(1).nextRead, ConchAgentTerminalState.unavailable("").nextRead)
        XCTAssertTrue(ConchAgentTerminalState.window(1).showsPicture)
        XCTAssertFalse(ConchAgentTerminalState.text(nil, .minimized).showsPicture)
    }

    func testItIsLiveOnlyWhileItCanBeSeen() {
        XCTAssertTrue(ConchTerminalMirrorGate(tabShown: true, windowVisible: true, asleep: false).isLive)
        XCTAssertFalse(ConchTerminalMirrorGate(tabShown: false, windowVisible: true, asleep: false).isLive)
        XCTAssertFalse(ConchTerminalMirrorGate(tabShown: true, windowVisible: false, asleep: false).isLive)
        XCTAssertFalse(ConchTerminalMirrorGate(tabShown: true, windowVisible: true, asleep: true).isLive)
        XCTAssertFalse(ConchTerminalMirrorGate().isLive, "nothing reads before the tab is shown")
    }

    func testTheAgentIsNamed() {
        XCTAssertEqual(ConchTerminalAgent.name(backend: "codex"), "Codex")
        XCTAssertEqual(ConchTerminalAgent.name(backend: nil), "Claude Code")
        XCTAssertEqual(ConchTerminalAgent.name(backend: "claude"), "Claude Code")
    }

    /// The Shell tab was remembered as "terminal"; that name now means the agent's terminal.
    func testTheShellHasItsOwnNameAndTheOldOneMeansTheAgentsTerminal() throws {
        XCTAssertEqual(WorkPane.shell.rawValue, "shell")
        XCTAssertEqual(WorkPane.terminal.rawValue, "terminal")
        let remembered = try XCTUnwrap(WorkspaceMemory.decode(Data(#"{"presentations":{"a":{"stage":"sideBySide","work":"terminal","expandedToolIDs":[]}}}"#.utf8)))
        XCTAssertEqual(remembered.presentations["a"]?.work, .terminal)
    }
}
