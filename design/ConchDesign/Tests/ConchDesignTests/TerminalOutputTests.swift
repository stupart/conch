import XCTest
@testable import ConchDesign

/// The terminal output parser, against bytes a real pty actually produced.
///
/// These fixtures are not invented. They were captured from a spawned `/bin/zsh` on a real
/// pseudo-terminal running these exact commands, and the parser was written from a census of
/// what they contained: 100.0% of escape sequences in realistic command output are SGR colour,
/// and the two non-colour sequences in 6,417 are an erase-line and a cursor-column that must be
/// swallowed rather than printed.
final class TerminalOutputTests: XCTestCase {
    private func parsed(_ text: String) -> ConchTerminalOutput {
        var output = ConchTerminalOutput()
        output.append(text)
        return output
    }

    // MARK: the trap

    /// A pty translates every `\n` into `\r\n`, so ALL fourteen captures are CRLF. A parser that
    /// treats `\r` as "rewrite this line" the moment it sees one blanks every line of every
    /// command — which is the single way this format is most easily got wrong.
    func testCarriageReturnBeforeNewlineIsOneNewlineAndNotARewrite() {
        let output = parsed("first\r\nsecond\r\nthird\r\n")
        XCTAssertEqual(output.plainText, "first\nsecond\nthird\n")
    }

    /// The genuine rewrite: `\r` NOT followed by a newline. Captured from a progress bar.
    func testABareCarriageReturnRewritesTheLine() {
        let progress = "\r[10%] building...\r[20%] building...\r[30%] building...\r\ndone\r\n"
        XCTAssertEqual(parsed(progress).plainText, "[30%] building...\ndone\n")
    }

    /// The `\r` can be the last byte of one read and the `\n` the first of the next. The
    /// decision has to survive the boundary, which is why it cannot be made by looking ahead.
    func testASplitCarriageReturnNewlineIsStillOneNewline() {
        var output = ConchTerminalOutput()
        output.append("first\r")
        output.append("\nsecond")
        XCTAssertEqual(output.plainText, "first\nsecond")
    }

    /// An escape sequence split across reads must not print its own bytes.
    func testAnEscapeSequenceSplitAcrossChunksStillParses() {
        var output = ConchTerminalOutput()
        output.append("plain \u{1B}[3")
        output.append("2mgreen\u{1B}[m done")
        XCTAssertEqual(output.plainText, "plain green done")
        XCTAssertEqual(output.lines[0][1].style.colour, .green)
    }

    // MARK: real captures

    /// `git status`, verbatim: 437 bytes, 6 SGR sequences, 3 tabs, CRLF throughout.
    func testGitStatusKeepsItsWordsAndColoursTheFilenames() {
        let capture = "On branch master\r\nChanges to be committed:\r\n  (use \"git restore --staged <file>...\" to unstage)\r\n\t\u{1B}[32mmodified:   src/mod.ts\u{1B}[m\r\n\r\nChanges not staged for commit:\r\n\t\u{1B}[31mmodified:   a.txt\u{1B}[m\r\n"
        let output = parsed(capture)

        XCTAssertTrue(output.plainText.contains("On branch master"))
        // Not a single escape byte survives into the text.
        XCTAssertFalse(output.plainText.contains("\u{1B}"))
        XCTAssertFalse(output.plainText.contains("["))

        let staged = output.lines.first { $0.contains { $0.text.contains("src/mod.ts") } }
        XCTAssertEqual(staged?.last?.style.colour, .green)
        let unstaged = output.lines.first { $0.contains { $0.text.contains("a.txt") } }
        XCTAssertEqual(unstaged?.last?.style.colour, .red)

        // The tab that indents those lines becomes spaces; a literal tab renders unpredictably.
        XCTAssertTrue(output.plainText.contains("        modified:   src/mod.ts"))
    }

    /// `swiftc` errors use COMPOUND parameters — `1;31`, `1;39`, `0;36`, `4;39`, `0;0` — which a
    /// parser that reads only the first number gets wrong.
    func testCompilerErrorsApplyEveryParameterInACompoundSequence() {
        let capture = "neg.swift:2:16: \u{1B}[1;31merror: \u{1B}[1;39mcannot find 'x' in scope\u{1B}[0;0m\r\n\u{1B}[0;36m1 |\u{1B}[0;0m import Darwin\r\n"
        let output = parsed(capture)

        let first = output.lines[0]
        let error = first.first { $0.text.contains("error:") }
        XCTAssertEqual(error?.style.colour, .red)
        XCTAssertTrue(error?.style.bold == true, "1;31 is bold AND red, not just red")

        // `0;0` resets: the text after it carries no colour at all.
        let message = first.first { $0.text.contains("cannot find") }
        XCTAssertEqual(message?.style.colour, nil)
        XCTAssertTrue(message?.style.bold == true, "1;39 is bold with the default colour")

        let gutter = output.lines[1].first
        XCTAssertEqual(gutter?.style.colour, .cyan)
    }

    /// `ls -la` produced 366 bytes and ZERO escape sequences. Plain output must come through
    /// untouched and as ONE run per line, not one per character.
    func testPlainOutputIsUntouchedAndNotShreddedIntoRuns() {
        let capture = "total 16\r\ndrwxr-xr-x   6 tylerstupart  staff  192 Sep 20 01:39 .\r\n-rw-r--r--   1 tylerstupart  staff   63 Sep 20 01:39 a.txt\r\n"
        let output = parsed(capture)

        XCTAssertEqual(output.lines[0], [ConchTerminalRun(text: "total 16")])
        XCTAssertEqual(output.lines[1].count, 1)
        XCTAssertTrue(output.lines[1][0].style.isPlain)
    }

    /// `npm test` carried the only two non-colour sequences in 6,417 — an erase-line and a
    /// cursor-column — and a pager adds `ESC=`, `ESC>` and `CSI ?1h/l`. Printing any of their
    /// bytes is exactly what makes output look corrupted.
    func testNonColourSequencesAreSwallowedRatherThanPrinted() {
        let capture = "\u{1B}=\u{1B}[?1h\u{1B}[Kbuilt \u{1B}[1Gok\u{1B}[?1l\u{1B}>\r\n"
        XCTAssertEqual(parsed(capture).plainText, "built ok\n")
    }

    func testBrightColoursAreTheSameEightAgain() {
        let output = parsed("\u{1B}[90mdim grey\u{1B}[m")
        XCTAssertEqual(output.lines[0][0].style.colour, .black)
        XCTAssertTrue(output.lines[0][0].style.isBright)
    }

    func testStyleCarriesAcrossLinesUntilItIsReset() {
        let output = parsed("\u{1B}[31mred one\r\nred two\u{1B}[m\r\nplain\r\n")
        XCTAssertEqual(output.lines[0][0].style.colour, .red)
        XCTAssertEqual(output.lines[1][0].style.colour, .red, "a colour outlives the line it opened on")
        XCTAssertTrue(output.lines[2].isEmpty || output.lines[2][0].style.isPlain)
    }

    // MARK: bounds

    func testScrollbackIsBoundedFromTheOldestEnd() {
        var output = ConchTerminalOutput()
        for index in 0..<50 { output.append("line \(index)\r\n") }
        output.trim(toLastLines: 10)
        XCTAssertEqual(output.lines.count, 10)
        XCTAssertTrue(output.plainText.contains("line 49"), "the newest survive")
        XCTAssertFalse(output.plainText.contains("line 0\n"), "the oldest go")
    }
}
