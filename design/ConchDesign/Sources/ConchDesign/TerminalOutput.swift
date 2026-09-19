import Foundation

// Command output, with its colour, as a transcript you can read.
//
// Deliberately NOT a terminal emulator. Measured before it was written: across 51,854 bytes of
// real output from `git status`, `git diff`, `bun test`, `npm test`, `ls` and `swiftc` errors,
// 100.0% of the escape sequences were SGR colour — two non-colour sequences in 6,417. Alternate
// screen, cursor addressing and OSC titles appeared exactly zero times, in every capture. So
// cursor addressing buys nothing here, and this parses colour and drops the rest.
//
// What it therefore cannot do, stated plainly so nobody expects otherwise: vim, htop, or an
// interactive rebase. It is a transcript, not a terminal.
//
// It is incremental on purpose. Reads off a pty arrive in arbitrary chunks, so an escape
// sequence — or the `\r` of a `\r\n` — can be split across two of them. That is why this is a
// state machine holding partial state rather than a regex over a whole string.

/// The eight ANSI colours. Bright is a flag rather than eight more cases: the wire says 30-37
/// and 90-97, which is the same eight twice over.
public enum ConchTerminalColour: Int, Equatable, Sendable, CaseIterable {
    case black = 0, red, green, yellow, blue, magenta, cyan, white
}

public struct ConchTerminalStyle: Equatable, Sendable {
    public var colour: ConchTerminalColour?
    public var isBright = false
    public var bold = false
    public var dim = false
    public var italic = false
    public var underline = false

    public init() {}

    public var isPlain: Bool { self == ConchTerminalStyle() }

    /// One SGR parameter list, applied in order. `ESC[m` with no parameters is a reset, which is
    /// how git ends every coloured span.
    mutating func apply(_ parameters: String) {
        let codes = parameters.isEmpty
            ? [0]
            : parameters.split(separator: ";", omittingEmptySubsequences: false)
                .map { Int($0) ?? 0 }
        for code in codes {
            switch code {
            case 0: self = ConchTerminalStyle()
            case 1: bold = true
            case 2: dim = true
            case 3: italic = true
            case 4: underline = true
            case 22: bold = false; dim = false
            case 23: italic = false
            case 24: underline = false
            case 30...37: colour = ConchTerminalColour(rawValue: code - 30); isBright = false
            case 39: colour = nil; isBright = false
            case 90...97: colour = ConchTerminalColour(rawValue: code - 90); isBright = true
            // Backgrounds and 256/true colour never appeared in the measured output. Ignored
            // rather than guessed at: a wrong colour reads as a bug, a missing one as plain.
            default: break
            }
        }
    }
}

/// A stretch of text sharing one style.
public struct ConchTerminalRun: Equatable, Sendable {
    public let text: String
    public let style: ConchTerminalStyle

    public init(text: String, style: ConchTerminalStyle = ConchTerminalStyle()) {
        self.text = text
        self.style = style
    }
}

/// The scrollback: lines of styled runs, fed chunk by chunk.
public struct ConchTerminalOutput: Equatable, Sendable {
    public private(set) var lines: [[ConchTerminalRun]] = [[]]

    /// Where an escape sequence had got to when the chunk ended.
    private enum Scan: Equatable { case ground, escape, csi(String) }
    private var scan: Scan = .ground
    private var style = ConchTerminalStyle()
    /// A `\r` we have seen but not yet acted on.
    ///
    /// THE trap in this format: a pty translates every `\n` into `\r\n` (ONLCR), so all 14
    /// captures are CRLF. Treating `\r` as "overwrite the line" the moment it arrives would
    /// blank every line of every command. It only overwrites when the next character is NOT a
    /// newline — and because that next character can be in the next chunk, the decision has to
    /// be carried across the boundary rather than made by looking ahead.
    private var pendingCarriageReturn = false

    /// How wide a tab stop is. Only `git status` used tabs in the measured output, for
    /// indentation, and a literal tab renders unpredictably in a text view.
    private static let tabStop = 8

    public init() {}

    /// Fed SCALARS, not Characters.
    ///
    /// Swift groups `\r\n` into a single extended grapheme cluster, so iterating a String by
    /// Character never yields the `\r` or the `\n` — it yields one character that is neither,
    /// which fell through every case here and was dropped as a control code. Every newline in
    /// every capture vanished. A byte-oriented protocol has to be read at the level it is
    /// written at.
    public mutating func append(_ text: String) {
        for scalar in text.unicodeScalars {
            if pendingCarriageReturn {
                pendingCarriageReturn = false
                // `\r\n` is one newline. Anything else means the `\r` was a rewrite.
                if scalar == "\n" { newline(); continue }
                // ponytail: the line is cleared rather than overwritten column by column. Every
                // measured rewrite ("[10%] building..." → "[20%] building...") replaces the
                // whole line with one the same length, so the distinction never showed. Track a
                // column if a shorter rewrite ever needs to leave the old tail behind.
                lines[lines.count - 1] = []
            }
            consume(scalar)
        }
    }

    private mutating func consume(_ scalar: Unicode.Scalar) {
        switch scan {
        case .ground:
            switch scalar {
            case "\u{1B}": scan = .escape
            case "\r": pendingCarriageReturn = true
            case "\n": newline()
            case "\t": emit(String(repeating: " ", count: Self.tabStop - (columnWidth % Self.tabStop)))
            // Backspace, bell and the rest carry no meaning in a transcript.
            case let other where other.value < 0x20: break
            default: emit(String(Character(scalar)))
            }
        case .escape:
            // `ESC[` opens a CSI; `ESC=` and `ESC>` (keypad mode, from a pager) are two-character
            // sequences that are simply over. Neither prints anything.
            scan = scalar == "[" ? .csi("") : .ground
        case let .csi(parameters):
            // A CSI runs until a letter. Everything before it is parameters.
            let isLetter = (scalar.value >= 0x41 && scalar.value <= 0x5A)
                || (scalar.value >= 0x61 && scalar.value <= 0x7A)
            if isLetter {
                // `m` is the only one that matters. `K` (erase line) and `G` (cursor column)
                // appeared twice in 6,417 sequences, and `h`/`l` only from a pager we disable —
                // all swallowed, because printing their bytes is what makes output look corrupt.
                if scalar == "m" { style.apply(parameters) }
                scan = .ground
            } else {
                scan = .csi(parameters + String(Character(scalar)))
            }
        }
    }

    private var columnWidth: Int {
        lines[lines.count - 1].reduce(0) { $0 + $1.text.count }
    }

    private mutating func newline() {
        lines.append([])
    }

    /// Runs are merged while the style holds, so a line of plain text is one run rather than one
    /// per character.
    private mutating func emit(_ text: String) {
        var line = lines[lines.count - 1]
        if let last = line.last, last.style == style {
            line[line.count - 1] = ConchTerminalRun(text: last.text + text, style: style)
        } else {
            line.append(ConchTerminalRun(text: text, style: style))
        }
        lines[lines.count - 1] = line
    }

    /// The text with every style dropped — what the output SAYS, for tests and for search.
    public var plainText: String {
        lines.map { $0.map(\.text).joined() }.joined(separator: "\n")
    }

    /// Keep the scrollback bounded. A build can print tens of thousands of lines and nobody
    /// scrolls back that far; the oldest go rather than the newest.
    public mutating func trim(toLastLines limit: Int) {
        guard lines.count > limit else { return }
        lines.removeFirst(lines.count - limit)
    }
}
