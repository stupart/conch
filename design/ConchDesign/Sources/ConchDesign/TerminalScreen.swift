import Foundation
import SwiftUI

// The agent's own terminal, as a screen: what a Claude Code or Codex TUI is drawing right now, for the Terminal tab.
//
// NOT the Shell tab's parser (`ConchTerminalOutput`), and the difference is the input. That one reads a command's output
// off a pty as it streams, where 100% of the measured escapes were the eight colours. This reads a SNAPSHOT tmux has
// already laid out (`capture-pane -p -e -N`): one line per row, the cursor movement resolved, and only SGR left. But the
// SGR is a TUI's, not `git diff`'s: Claude Code draws in 24-bit colour (its orange is `38;2;215;119;87`), paints its diff
// lines' backgrounds, and inverts a cell for its own cursor; Codex uses the sixteen, dim, reverse and a 256-colour grey.
// All of it is kept, because the reason to look at the real terminal is parity with it.
//
// Stateless between frames: every capture is the whole screen, parsed from a reset.

/// One colour, as the program named it. What it looks like is the theme's business (`ConchTerminalTheme`).
public enum ConchTerminalColor: Hashable, Sendable {
    /// The terminal's own foreground or background.
    case `default`
    /// 0-7 the eight, 8-15 their bright forms, 16-231 the 6x6x6 cube, 232-255 the greys.
    case indexed(UInt8)
    case rgb(UInt8, UInt8, UInt8)
}

/// Everything SGR can say about a cell that shows on screen.
public struct ConchTerminalCellStyle: Hashable, Sendable {
    public var foreground: ConchTerminalColor = .default
    public var background: ConchTerminalColor = .default
    public var bold = false
    public var dim = false
    public var italic = false
    public var underline = false
    public var inverse = false
    public var hidden = false
    public var strikethrough = false

    public init() {}

    /// One `ESC[…m`, applied in order. Semicolons separate codes; a colon joins a code's own parts (`38:2::r:g:b`,
    /// `4:3`), which is how newer terminals say the same thing and how tmux may pass it through.
    mutating func apply(_ parameters: String) {
        // `ESC[>…m` and `ESC[?…m` are private modes (xterm's modifyOtherKeys), not attributes.
        if parameters.hasPrefix(">") || parameters.hasPrefix("?") || parameters.hasPrefix("<") || parameters.hasPrefix("=") { return }
        let groups = parameters.isEmpty ? [""] : parameters.split(separator: ";", omittingEmptySubsequences: false).map(String.init)
        var index = 0
        while index < groups.count {
            let group = groups[index]
            index += 1
            if group.contains(":") {
                let parts = group.split(separator: ":", omittingEmptySubsequences: false).map { Int($0) }
                switch parts.first ?? nil {
                case 38: if let colour = Self.extended(Array(parts.dropFirst())) { foreground = colour }
                case 48: if let colour = Self.extended(Array(parts.dropFirst())) { background = colour }
                // `4:0` is no underline; every other style (curly, dotted…) is drawn as the one underline there is.
                case 4: underline = (parts.count > 1 ? parts[1] : 1) != 0
                default: break
                }
                continue
            }
            let code = group.isEmpty ? 0 : (Int(group) ?? -1)
            switch code {
            case 0: self = ConchTerminalCellStyle()
            case 1: bold = true
            case 2: dim = true
            case 3: italic = true
            case 4, 21: underline = true
            case 7: inverse = true
            case 8: hidden = true
            case 9: strikethrough = true
            case 22: bold = false; dim = false
            case 23: italic = false
            case 24: underline = false
            case 27: inverse = false
            case 28: hidden = false
            case 29: strikethrough = false
            case 30...37: foreground = .indexed(UInt8(code - 30))
            case 39: foreground = .default
            case 40...47: background = .indexed(UInt8(code - 40))
            case 49: background = .default
            case 90...97: foreground = .indexed(UInt8(code - 90 + 8))
            case 100...107: background = .indexed(UInt8(code - 100 + 8))
            case 38, 48, 58:
                // `38;5;n` and `38;2;r;g;b`: the colour's own parts follow as further codes, and are consumed here, so
                // a `2` meant as green is never read as dim. 58 is the underline's colour: read past, not drawn.
                let rest = groups[index...].map { Int($0) }
                let taken = rest.first == 5 ? 2 : rest.first == 2 ? 4 : 0
                let colour = Self.extended(Array(rest.prefix(taken)))
                index += min(taken, rest.count)
                if code == 38, let colour { foreground = colour }
                if code == 48, let colour { background = colour }
            // Blink, overline, fonts and the rest have nothing to show here.
            default: break
            }
        }
    }

    /// `5;n` or `2;r;g;b` (with an optional, empty colour-space id before r in the colon form).
    private static func extended(_ parts: [Int?]) -> ConchTerminalColor? {
        guard let kind = parts.first ?? nil else { return nil }
        func byte(_ value: Int?) -> UInt8? { value.flatMap { (0...255).contains($0) ? UInt8($0) : nil } }
        switch kind {
        case 5 where parts.count >= 2:
            return byte(parts[1]).map(ConchTerminalColor.indexed)
        case 2 where parts.count >= 4:
            let rgb = Array(parts.suffix(3))
            guard let r = byte(rgb[0]), let g = byte(rgb[1]), let b = byte(rgb[2]) else { return nil }
            return .rgb(r, g, b)
        default:
            return nil
        }
    }
}

/// A stretch of one row sharing one style.
public struct ConchTerminalScreenRun: Equatable, Sendable {
    public let text: String
    public let style: ConchTerminalCellStyle

    public init(_ text: String, style: ConchTerminalCellStyle = ConchTerminalCellStyle()) {
        self.text = text
        self.style = style
    }
}

/// A terminal screen, row by row.
public struct ConchTerminalScreen: Equatable, Sendable {
    public let columns: Int
    public let rows: Int
    /// Exactly `rows` of them: a short capture is padded with empty rows, a long one cut, so the picture keeps the
    /// terminal's own height and a prompt at the bottom stays at the bottom.
    public let lines: [[ConchTerminalScreenRun]]

    /// A `capture-pane -p -e -N` of a `columns`x`rows` pane, the cursor drawn where it is when the program shows it.
    public init(capture: String, columns: Int, rows: Int, cursor: (x: Int, y: Int)? = nil) {
        self.columns = max(columns, 1)
        self.rows = max(rows, 1)
        var parsed = Self.parse(capture)
        if parsed.count > self.rows { parsed.removeLast(parsed.count - self.rows) }
        while parsed.count < self.rows { parsed.append([]) }
        if let cursor, cursor.y >= 0, cursor.y < self.rows, cursor.x >= 0, cursor.x < self.columns {
            parsed[cursor.y] = Self.drawingCursor(in: parsed[cursor.y], at: cursor.x)
        }
        lines = parsed
    }

    /// Plain text a terminal shows with no colour at all: Terminal's own `contents of tab`, while its window can't be
    /// pictured. The last rows are kept, as a terminal keeps its bottom in view.
    public init(plain: String, columns: Int = 80, rows: Int? = nil) {
        var text = plain.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        while text.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { text.removeLast() }
        let height = max(rows ?? text.count, 1)
        if text.count > height { text.removeFirst(text.count - height) }
        self.columns = max(columns, text.map(\.count).max() ?? 0, 1)
        self.rows = height
        var parsed = text.map { $0.isEmpty ? [] : [ConchTerminalScreenRun($0)] }
        while parsed.count < height { parsed.append([]) }
        lines = parsed
    }

    /// The text with every style dropped: what the screen SAYS, for tests, search and copying.
    public var plainText: String {
        lines.map { $0.map(\.text).joined() }.joined(separator: "\n")
    }

    /// Rows of styled runs, from a capture: one row per line, SGR applied, every other escape (an OSC hyperlink, a
    /// stray CSI) passed over without printing, and the style carried from row to row as tmux carries it.
    static func parse(_ capture: String) -> [[ConchTerminalScreenRun]] {
        enum Scan { case ground, escape, csi, osc, oscEscape, string }
        var rows: [[ConchTerminalScreenRun]] = [[]]
        var style = ConchTerminalCellStyle()
        var scan = Scan.ground
        var parameters = ""
        var pending = ""

        func flush() {
            guard !pending.isEmpty else { return }
            var row = rows[rows.count - 1]
            if let last = row.last, last.style == style {
                row[row.count - 1] = ConchTerminalScreenRun(last.text + pending, style: style)
            } else {
                row.append(ConchTerminalScreenRun(pending, style: style))
            }
            rows[rows.count - 1] = row
            pending = ""
        }

        // Scalars, not Characters: a `\r\n` is one Character in Swift, and an escape's bytes must be read one by one.
        for scalar in capture.unicodeScalars {
            switch scan {
            case .ground:
                switch scalar {
                case "\u{1B}":
                    flush()
                    scan = .escape
                case "\n":
                    flush()
                    rows.append([])
                case "\t":
                    pending.append(" ")
                case let control where control.value < 0x20 || control.value == 0x7F:
                    break
                default:
                    pending.unicodeScalars.append(scalar)
                }
            case .escape:
                switch scalar {
                case "[": parameters = ""; scan = .csi
                case "]": scan = .osc
                // DCS, SOS, PM and APC run to a string terminator, like an OSC.
                case "P", "X", "^", "_": scan = .string
                default: scan = .ground
                }
            case .csi:
                if (0x40...0x7E).contains(scalar.value) {
                    if scalar == "m" { style.apply(parameters) }
                    scan = .ground
                } else {
                    parameters.unicodeScalars.append(scalar)
                }
            case .osc, .string:
                if scalar == "\u{07}" { scan = .ground } else if scalar == "\u{1B}" { scan = .oscEscape }
            case .oscEscape:
                scan = scalar == "\\" ? .ground : .osc
            }
        }
        flush()
        // `capture-pane` ends its last row with a newline; that is not a row of its own.
        if rows.count > 1, rows.last?.isEmpty == true, capture.hasSuffix("\n") { rows.removeLast() }
        return rows
    }

    /// The row with the cell at `column` drawn inverted, padded out to it when the row is shorter.
    static func drawingCursor(in row: [ConchTerminalScreenRun], at column: Int) -> [ConchTerminalScreenRun] {
        var before: [ConchTerminalScreenRun] = []
        var at: ConchTerminalScreenRun?
        var after: [ConchTerminalScreenRun] = []
        var seen = 0
        for run in row {
            let characters = Array(run.text)
            if at != nil {
                after.append(run)
            } else if seen + characters.count <= column {
                before.append(run)
            } else {
                let offset = column - seen
                if offset > 0 { before.append(ConchTerminalScreenRun(String(characters[..<offset]), style: run.style)) }
                at = ConchTerminalScreenRun(String(characters[offset]), style: run.style)
                if offset + 1 < characters.count { after.append(ConchTerminalScreenRun(String(characters[(offset + 1)...]), style: run.style)) }
            }
            seen += characters.count
        }
        if at == nil {
            if column > seen { before.append(ConchTerminalScreenRun(String(repeating: " ", count: column - seen))) }
            at = ConchTerminalScreenRun(" ")
        }
        var cursor = at!.style
        cursor.inverse.toggle()
        return before + [ConchTerminalScreenRun(at!.text, style: cursor)] + after
    }
}

// MARK: - Colours

/// What each colour a program names looks like: the terminal's own palette.
///
/// Terminal's default profile, Basic: its sixteen as Terminal draws them, black on white in light and light on near-black
/// in dark, as that profile follows the Mac's appearance. conch starts sessions in Terminal with that profile, so for a
/// session conch started this is the terminal's own colouring. 24-bit colours are the program's own and drawn exactly;
/// the 256 are xterm's standard cube and greys.
public struct ConchTerminalTheme: Equatable, Sendable {
    public let foreground: ConchRGBA
    public let background: ConchRGBA
    /// 0-15.
    public let ansi: [ConchRGBA]

    public init(foreground: ConchRGBA, background: ConchRGBA, ansi: [ConchRGBA]) {
        precondition(ansi.count == 16, "a terminal has sixteen named colours")
        self.foreground = foreground
        self.background = background
        self.ansi = ansi
    }

    static let basic: [ConchRGBA] = [
        0x000000, 0x990000, 0x00A600, 0x999900, 0x0000B2, 0xB200B2, 0x00A6B2, 0xBFBFBF,
        0x666666, 0xE50000, 0x00D900, 0xE5E500, 0x0000FF, 0xE500E5, 0x00E5E5, 0xE5E5E5,
    ].map { ConchRGBA($0) }

    public static let light = ConchTerminalTheme(foreground: ConchRGBA(0x000000), background: ConchRGBA(0xFFFFFF), ansi: basic)
    public static let dark = ConchTerminalTheme(foreground: ConchRGBA(0xE5E5E5), background: ConchRGBA(0x1E1E1E), ansi: basic)

    public static func standard(_ scheme: ColorScheme) -> ConchTerminalTheme { scheme == .dark ? dark : light }

    /// A named colour's value; `.default` is the ground's.
    public func rgba(_ colour: ConchTerminalColor, foreground isForeground: Bool) -> ConchRGBA {
        switch colour {
        case .default: return isForeground ? foreground : background
        case let .rgb(r, g, b): return ConchRGBA(UInt32(r) << 16 | UInt32(g) << 8 | UInt32(b))
        case let .indexed(index):
            if index < 16 { return ansi[Int(index)] }
            if index >= 232 {
                let level = UInt32(8 + 10 * (Int(index) - 232))
                return ConchRGBA(level << 16 | level << 8 | level)
            }
            let cube = Int(index) - 16
            func step(_ value: Int) -> UInt32 { value == 0 ? 0 : UInt32(55 + 40 * value) }
            return ConchRGBA(step(cube / 36) << 16 | step(cube / 6 % 6) << 8 | step(cube % 6))
        }
    }

    /// What a cell is drawn with: inverse swaps the two, dim is the foreground half way to the ground, hidden is the
    /// ground's own colour. A background that is the terminal's own is nil, so nothing is painted behind ordinary text.
    public func resolve(_ style: ConchTerminalCellStyle) -> (foreground: ConchRGBA, background: ConchRGBA?) {
        var fore = rgba(style.foreground, foreground: true)
        var back: ConchRGBA? = style.background == .default ? nil : rgba(style.background, foreground: false)
        if style.inverse {
            let ground = back ?? background
            back = fore
            fore = ground
        }
        let ground = back ?? background
        if style.dim { fore = ConchRGBA(fore.hex, alpha: 0.5).over(ground) }
        if style.hidden { fore = ground }
        return (fore, back)
    }
}

// MARK: - Showing it

/// How big the screen's type is, to fit its columns into the width there is: SF Mono's advance is 0.6 of its size.
public enum ConchTerminalMetrics {
    /// SF Mono's advance width as a share of its point size (1234 / 2048 units).
    public static let advance: CGFloat = 1234.0 / 2048.0
    public static let largest: CGFloat = 13
    public static let smallest: CGFloat = 7

    /// The largest size up to 13 pt at which `columns` fit in `width`; never under 7 pt, where it scrolls instead.
    public static func fontSize(columns: Int, width: CGFloat) -> CGFloat {
        guard columns > 0, width > 0 else { return largest }
        return min(largest, max(smallest, (width / (CGFloat(columns) * advance) * 10).rounded(.down) / 10))
    }
}

extension ConchTerminalScreen {
    /// The screen as one attributed string, one row per line, so it selects and copies as the terminal's text.
    public func attributed(theme: ConchTerminalTheme, size: CGFloat) -> AttributedString {
        var out = AttributedString()
        let regular = Font.system(size: size, weight: .regular, design: .monospaced)
        let bold = Font.system(size: size, weight: .bold, design: .monospaced)
        for (index, line) in lines.enumerated() {
            for run in line {
                var piece = AttributedString(run.text)
                let colours = theme.resolve(run.style)
                piece.foregroundColor = colours.foreground.color
                if let back = colours.background { piece.backgroundColor = back.color }
                var font = run.style.bold ? bold : regular
                if run.style.italic { font = font.italic() }
                piece.font = font
                if run.style.underline { piece.underlineStyle = .single }
                if run.style.strikethrough { piece.strikethroughStyle = .single }
                out += piece
            }
            // An empty last row still takes its line, so the height is the terminal's.
            if index < lines.count - 1 { out += AttributedString("\n") } else if line.isEmpty { out += AttributedString(" ") }
        }
        return out
    }
}

/// A terminal screen, drawn in its own colours in SF Mono, sized to fit its columns, selectable and copyable.
public struct ConchTerminalScreenView: View {
    let screen: ConchTerminalScreen
    @Environment(\.colorScheme) private var scheme
    @Environment(\.conchRendersStatically) private var rendersStatically

    public init(screen: ConchTerminalScreen) {
        self.screen = screen
    }

    public var body: some View {
        let theme = ConchTerminalTheme.standard(scheme)
        GeometryReader { geometry in
            let size = ConchTerminalMetrics.fontSize(columns: screen.columns, width: geometry.size.width - 24)
            let text = Text(screen.attributed(theme: theme, size: size))
                .lineSpacing(0)
                .fixedSize(horizontal: true, vertical: true)
                .textSelection(.enabled)
                .padding(12)
            Group {
                if rendersStatically {
                    text
                } else {
                    ScrollView([.horizontal, .vertical]) { text }
                        .defaultScrollAnchor(.bottomLeading)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
        }
        .background(theme.background.color)
    }
}
