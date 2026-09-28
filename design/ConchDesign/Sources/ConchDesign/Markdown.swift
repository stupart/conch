import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

// The one markdown renderer both apps read agents' documents through.
//
// Tyler, on the Mac: "please please please fix the markdown rendering of docs across all surfaces … i think it might be
// tables that are broken?" — and the bar: "make it as good as the one in apple xcode." Four renderers disagreed. The
// Mac's SwiftUI rows took an inline parse with tables pre-flattened to `**first** — rest · rest` and headings promoted to
// bold, so a 54-row document (atlas deep-review/mvps-and-backend-primitives.md, 2026-09-20) arrived as a wall of bold
// runs; the AppKit fallback rebuilt blocks by hand from Foundation's `.full` parse and tab-stopped table cells at 118 pt,
// which no cell of that document fits; the phone had a real block model in its own file, and the Mac had nothing like it.
//
// Foundation's `AttributedString(markdown:)` is a parse tree, not a layout: `.full` drops every newline (a three-item
// list arrives as "onetwothree") and a SwiftUI `Text` is one text flow, which cannot lay out a table. So the block
// structure is split here, line by line, and Foundation parses only the inline emphasis within each block. The SwiftUI
// view renders runs of prose as one `Text` and only what a text flow cannot draw as its own view (a `Layout` of wrapped
// cells for a table); the AppKit typesetter renders one attributed string with `NSTextTable`, for the two `NSTextView`
// surfaces that need a single string — the fallback dims the unspoken tail by character range, and a document pane
// wants whole-document selection.

/// One block of a document, in source order.
enum MarkdownBlock: Equatable {
    case heading(Int, String)
    case paragraph(String)
    case bullet(depth: Int, String)
    case ordered(depth: Int, ordinal: Int, String)
    case quote(String)
    case code(String)
    /// Rows, the header first; every row has the header's column count.
    case table([[String]])
    case rule
    /// `![alt](source)` alone on its line: a document's screenshot. One inside a sentence stays in its prose.
    case image(alt: String, source: String)

    /// A bullet or a numbered item: a list's items sit closer together than paragraphs (`ConchReading.itemGap`).
    var isListItem: Bool {
        switch self {
        case .bullet, .ordered: true
        default: false
        }
    }
}

enum MarkdownDocument {
    /// A document's YAML frontmatter is metadata, not prose: `type: document` on the first line of every atlas document
    /// read as its opening sentence. Stripped only when the text STARTS with the fence and the fence closes — across
    /// 256 live conversation items (2026-09-20) none begins with `---` and two carry a bare `---` mid-reply, so a rule
    /// in an agent's prose is never taken for one.
    static func stripFrontmatter(_ text: String) -> String {
        guard text.hasPrefix("---\n") || text.hasPrefix("---\r\n") else { return text }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        guard let close = lines.dropFirst().firstIndex(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines) == "---" })
        else { return text }
        return lines[(close + 1)...].joined(separator: "\n")
    }

    static func blocks(_ text: String) -> [MarkdownBlock] {
        var result: [MarkdownBlock] = []
        var paragraph: [String] = []
        var quote: [String] = []
        var code: [String] = []
        var table: [[String]] = []
        var inCode = false

        func flushParagraph() {
            // Newlines stay: 14 of 78 live replies (2026-09-20) put "Task name: …" and "Sender: …" on consecutive
            // lines and mean them as lines, which is what the inline parse always showed on the Mac.
            if !paragraph.isEmpty { result.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
        }
        func flushQuote() {
            if !quote.isEmpty { result.append(.quote(quote.joined(separator: "\n"))); quote = [] }
        }
        func flushTable() {
            guard let header = table.first else { return }
            // Rectangular, so a row with a missing cell still lines up under the header.
            result.append(.table(table.map { row in
                Array((row + Array(repeating: "", count: max(0, header.count - row.count))).prefix(header.count))
            }))
            table = []
        }
        func flushAll() { flushParagraph(); flushQuote(); flushTable() }

        for rawLine in stripFrontmatter(text).replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushAll()
                if inCode { result.append(.code(code.joined(separator: "\n"))); code = [] }
                inCode.toggle()
                continue
            }
            if inCode { code.append(line); continue }

            if trimmed.isEmpty { flushAll(); continue }

            if trimmed.hasPrefix("|") {
                flushParagraph(); flushQuote()
                let cells = Self.cells(of: trimmed)
                // The `| --- | :-: |` row is alignment, which the grid does not take; it is not a row.
                if !cells.allSatisfy({ !$0.isEmpty && $0.allSatisfy { ":-".contains($0) } }) { table.append(cells) }
                continue
            }
            flushTable()

            if trimmed.hasPrefix(">") {
                flushParagraph()
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
                continue
            }
            flushQuote()

            if let (level, text) = heading(trimmed) {
                flushParagraph()
                result.append(.heading(level, text))
            } else if isRule(trimmed) {
                flushParagraph()
                result.append(.rule)
            } else if let (depth, text) = bullet(line) {
                flushParagraph()
                result.append(.bullet(depth: depth, text))
            } else if let (depth, ordinal, text) = ordered(line) {
                flushParagraph()
                result.append(.ordered(depth: depth, ordinal: ordinal, text))
            } else if let (alt, source) = image(trimmed) {
                flushParagraph()
                result.append(.image(alt: alt, source: source))
            } else {
                paragraph.append(trimmed)
            }
        }
        if inCode, !code.isEmpty { result.append(.code(code.joined(separator: "\n"))) }
        flushAll()
        return result
    }

    /// `| a | b |` as ["a", "b"]; a `\|` inside a cell is a pipe, not a column.
    static func cells(of row: String) -> [String] {
        var inner = Substring(row.dropFirst())
        if inner.hasSuffix("|") { inner = inner.dropLast() }
        return inner.replacingOccurrences(of: "\\|", with: "\u{1}")
            .split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.replacingOccurrences(of: "\u{1}", with: "|").trimmingCharacters(in: .whitespaces) }
    }

    /// `## Title` — the space is required, so `#hashtag` stays prose.
    static func heading(_ line: String) -> (Int, String)? {
        let hashes = line.prefix { $0 == "#" }
        guard (1...6).contains(hashes.count) else { return nil }
        let rest = line.dropFirst(hashes.count)
        guard rest.first == " " else { return nil }
        let text = rest.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : (hashes.count, text)
    }

    private static let imageLine = try! NSRegularExpression(
        pattern: #"^!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)$"#
    )

    /// `![alt](source)`, `![alt](<a path with spaces>)` or `![alt](source "title")`, as the whole line.
    static func image(_ line: String) -> (String, String)? {
        let whole = NSRange(line.startIndex..., in: line)
        guard let match = imageLine.firstMatch(in: line, range: whole),
              let alt = Range(match.range(at: 1), in: line),
              let source = Range(match.range(at: 2), in: line) ?? Range(match.range(at: 3), in: line)
        else { return nil }
        return (String(line[alt]), String(line[source]))
    }

    static func isRule(_ line: String) -> Bool {
        line.count >= 3 && (line.allSatisfy { $0 == "-" } || line.allSatisfy { $0 == "*" } || line.allSatisfy { $0 == "_" })
    }

    /// Two spaces (or a tab) of indent per level, three levels deep at most.
    private static func depth(of line: String) -> Int {
        min(line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 2 : 1) } / 2, 3)
    }

    static func bullet(_ line: String) -> (Int, String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        for marker in ["- ", "* ", "+ "] where trimmed.hasPrefix(marker) {
            return (depth(of: line), String(trimmed.dropFirst(marker.count)).trimmingCharacters(in: .whitespaces))
        }
        return nil
    }

    static func ordered(_ line: String) -> (Int, Int, String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let digits = trimmed.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count < 4, let ordinal = Int(digits) else { return nil }
        let rest = trimmed.dropFirst(digits.count)
        guard rest.first == "." || rest.first == ")", rest.dropFirst().first == " " else { return nil }
        return (depth(of: line), ordinal, rest.dropFirst().trimmingCharacters(in: .whitespaces))
    }

    /// The inline emphasis within one block. Unparseable input is shown literally, so a malformed span never blanks a
    /// block.
    ///
    /// Links are underlined, permanently. They worked the whole time — Tyler tested one — but nothing said so: blue
    /// against text that is also occasionally coloured, with no underline and no hover state, so the only way to find
    /// one was to click on the off chance ("it's just a ui problem really, to show me with an underline on hover that i
    /// can click on it"). A hover underline is not honest here: SwiftUI's `Text` draws an AttributedString as one view
    /// and cannot hit-test one run inside it. Always-underlined is the same signal, before the pointer arrives.
    static func inline(_ text: String) -> AttributedString {
        var parsed = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
        for run in parsed.runs where run.link != nil { parsed[run.range].underlineStyle = .single }
        return parsed
    }

    /// Each column's share of a table's width, from what it holds, the way a web table's are. Equal columns wrap the
    /// atlas documents' 300-character third columns into rows 450 pt tall — 22,395 pt for a 155-line document at the
    /// 748 pt measure — while a column of short labels sits mostly empty. Capped at 60 characters so one long cell does
    /// not starve the rest, with 8 added so an empty column still has a width.
    static func columnWeights(_ rows: [[String]]) -> [CGFloat] {
        let weights = (0..<(rows.first?.count ?? 0)).map { column in CGFloat(min(rows.map { $0[column].count }.max() ?? 0, 60) + 8) }
        let total = weights.reduce(0, +)
        return weights.map { $0 / total }
    }

    /// Xcode's scale, roughly: a heading is a size above its body, not the same size in bold.
    static func headingScale(_ level: Int) -> CGFloat {
        switch level {
        case 1: 1.6
        case 2: 1.35
        case 3: 1.15
        default: 1
        }
    }
}

// MARK: - SwiftUI

/// A document rendered in as few views as its blocks allow: headings on a type scale, lists with hanging indents,
/// quotes on a rule, code on a ground, and tables as aligned columns. Body text takes the colour it is given; `size` is
/// the body's point size, which follows the reader's text size on iOS.
///
/// As few views, because every `Text` is a responder SwiftUI hit-tests on every scroll-wheel event. A first cut drew a
/// view per block, and the transcript's main thread went from 233 to 381 ms/s while scrolling a 300-row session, the
/// growth almost all `ViewResponder.hitTest` and hover responders (Time Profiler, 2026-09-20) — a paragraph-only reply
/// had gone from one selectable `Text` to one per paragraph. So a run of headings and paragraphs is ONE `Text` again,
/// with its fonts per run and its paragraph spacing carried by a blank line set in a small font (a `Text` takes no
/// paragraph style), and only what a single text flow cannot draw — a hanging indent, a rule, a grid — is its own view.
public struct MarkdownView: View {
    /// What is drawn: a run of headings and paragraphs as one text, the rest a view each.
    enum Piece {
        case flow(AttributedString)
        case bullet(depth: Int, AttributedString)
        case ordered(depth: Int, ordinal: Int, AttributedString)
        case quote(AttributedString)
        case code(String)
        case table([[String]])
        case rule
        case image(alt: String, source: String)
    }

    /// Draws one picture from its source as written and its alt text. What a source is relative to, and how its bytes
    /// arrive, is the caller's to know: the phone reads a Mac file through the bridge.
    public typealias ImageView = (_ source: String, _ alt: String) -> AnyView

    private let text: String
    private let size: CGFloat
    private let image: ImageView?
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
    /// The leading the caller set (the Mac's transcript: `ConchType.readingLineSpacing`), which the gaps count.
    @Environment(\.lineSpacing) private var lineSpacing
    /// Inside the conversation, the row whose selection its texts join (ConversationSelection.swift): each is tagged
    /// with its place in `selectableSegments`. Nil everywhere else.
    @Environment(\.conversationSelectionRow) private var selectionRow

    public init(text: String, size: CGFloat = ConchType.readingBodySize, image: ImageView? = nil) {
        self.text = text
        self.size = size
        self.image = image
    }

    /// A piece, and the room above it: `ConchReading`'s box gap to the piece before, 0 for the first.
    struct Placed {
        let piece: Piece
        let gap: CGFloat
    }

    static func pieces(_ blocks: [MarkdownBlock], size: CGFloat, lineSpacing: CGFloat = 0, images: Bool = false) -> [Piece] {
        placed(blocks, size: size, lineSpacing: lineSpacing, images: images).map(\.piece)
    }

    /// The box gap between two blocks, in ems (`ConchReading`): a heading takes its room above whatever it follows, and
    /// gives only a little below; the items of one list sit close; everything else is a paragraph apart.
    static func gap(after previous: MarkdownBlock, before next: MarkdownBlock) -> CGFloat {
        if case let .heading(level, _) = next { return ConchReading.headingGapAbove(level: level) }
        if case .heading = previous { return ConchReading.headingGapBelow }
        if previous.isListItem, next.isListItem { return ConchReading.itemGap }
        return ConchReading.paragraphGap
    }

    /// SF's line in a SwiftUI `Text`, as a multiple of its size: what a blank line set at a size takes up.
    static let lineHeight: CGFloat = 1.27

    /// `text` with its inline emphasis, set in `font`, its code a size down in SF Mono (`ConchReading.codeScale`).
    static func styled(_ text: String, font: Font, size: CGFloat) -> AttributedString {
        var styled = MarkdownDocument.inline(text)
        styled.font = font
        for run in styled.runs where run.inlinePresentationIntent?.contains(.code) == true {
            styled[run.range].font = .system(size: size * ConchReading.codeScale, design: .monospaced)
        }
        return styled
    }

    /// The pieces, each with the gap above it. `lineSpacing` is the environment's, which a text adds under every line
    /// but its last, a blank one included, so a gap inside one text counts it.
    static func placed(_ blocks: [MarkdownBlock], size: CGFloat, lineSpacing: CGFloat = 0, images: Bool = false) -> [Placed] {
        var result: [Placed] = []
        var flow = AttributedString()
        /// The room above the flow being built, which is the room above its first block.
        var flowGap: CGFloat = 0
        func styled(_ text: String, font: Font, size: CGFloat = size) -> AttributedString {
            Self.styled(text, font: font, size: size)
        }
        /// A gap inside one text (a `Text` takes no paragraph style): a blank line set just tall enough that it and the
        /// line spacing under the line before it and under itself come to `gap`. Too little room for a line of its own,
        /// a line break.
        func add(_ text: AttributedString, gap: CGFloat) {
            if flow.characters.isEmpty {
                flowGap = gap
            } else {
                let blank = gap - 2 * lineSpacing
                if blank < 1 {
                    flow += AttributedString("\n")
                } else {
                    var line = AttributedString("\n\n")
                    line.font = .system(size: blank / lineHeight)
                    flow += line
                }
            }
            flow += text
        }
        func place(_ piece: Piece, gap: CGFloat) {
            if !flow.characters.isEmpty { result.append(Placed(piece: .flow(flow), gap: flowGap)); flow = AttributedString() }
            result.append(Placed(piece: piece, gap: gap))
        }
        var previous: MarkdownBlock?
        for block in blocks {
            let gap = previous.map { size * Self.gap(after: $0, before: block) } ?? 0
            previous = block
            switch block {
            case let .heading(level, text):
                let headingSize = size * MarkdownDocument.headingScale(level)
                add(styled(text, font: .system(size: headingSize, weight: level <= 2 ? .bold : .semibold), size: headingSize), gap: gap)
            case let .paragraph(text):
                add(styled(text, font: .system(size: size)), gap: gap)
            case let .bullet(depth, text):
                place(.bullet(depth: depth, styled(text, font: .system(size: size))), gap: gap)
            case let .ordered(depth, ordinal, text):
                place(.ordered(depth: depth, ordinal: ordinal, styled(text, font: .system(size: size))), gap: gap)
            case let .quote(text):
                place(.quote(styled(text, font: .system(size: size))), gap: gap)
            case let .code(text):
                place(.code(text), gap: gap)
            case let .table(rows):
                place(.table(rows), gap: gap)
            case .rule:
                place(.rule, gap: gap)
            case let .image(alt, source):
                // With nothing to draw it, the line reads as it always has: its alt text, in the prose.
                if images { place(.image(alt: alt, source: source), gap: gap) }
                else { add(styled("![\(alt)](\(source))", font: .system(size: size)), gap: gap) }
            }
        }
        if !flow.characters.isEmpty { result.append(Placed(piece: .flow(flow), gap: flowGap)) }
        return result
    }

    public var body: some View {
        let placed = MarkdownPieceCache.shared.placed(text, size: size * scale, lineSpacing: lineSpacing, images: image != nil)
        Group {
            if placed.count == 1, case let .flow(text) = placed[0].piece {
                // Most replies: one text, the one responder a reply always was.
                Text(text).conversationSelectable(row: selectionRow, segment: 0).frame(maxWidth: measure, alignment: .leading)
            } else {
                let segments = Self.firstSegments(placed.map(\.piece))
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(placed.enumerated()), id: \.offset) { index, placed in
                        render(placed.piece, segment: segments[index]).padding(.top, placed.gap)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    private var bodyFont: Font { .system(size: size * scale) }
    private var tableSize: CGFloat { size * scale * ConchReading.tableScale }
    private var tableFont: Font { .system(size: tableSize) }
    private var mono: Font { .system(size: size * scale * ConchReading.codeScale, design: .monospaced) }
    /// Prose runs no wider than this (`ConchReading.measure`); tables, code and pictures take the whole width.
    private var measure: CGFloat { ConchReading.measure(size * scale) }

    /// `segment`: the piece's first place in `selectableSegments`, which its texts are tagged with.
    @ViewBuilder
    private func render(_ piece: Piece, segment: Int) -> some View {
        switch piece {
        case let .flow(text):
            Text(text).conversationSelectable(row: selectionRow, segment: segment).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: measure, alignment: .leading)
        case let .bullet(depth, text):
            HStack(alignment: .firstTextBaseline, spacing: size * 0.5) {
                Text(["•", "◦", "▪"][min(depth, 2)]).font(bodyFont).foregroundStyle(ConchColor.textSecondary).allowsHitTesting(false)
                Text(text).conversationSelectable(row: selectionRow, segment: segment).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, size * CGFloat(1 + depth) * 1.2)
            .frame(maxWidth: measure, alignment: .leading)
        case let .ordered(depth, ordinal, text):
            HStack(alignment: .firstTextBaseline, spacing: size * 0.5) {
                Text("\(ordinal).").font(bodyFont.monospacedDigit()).foregroundStyle(ConchColor.textSecondary)
                    .frame(minWidth: size * 1.4, alignment: .trailing).allowsHitTesting(false)
                Text(text).conversationSelectable(row: selectionRow, segment: segment).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, size * CGFloat(depth) * 1.2)
            .frame(maxWidth: measure, alignment: .leading)
        case let .quote(text):
            HStack(alignment: .top, spacing: size * 0.7) {
                RoundedRectangle(cornerRadius: 1).fill(ConchColor.hairlineStrong).frame(width: 3).allowsHitTesting(false)
                Text(text).conversationSelectable(row: selectionRow, segment: segment).foregroundStyle(ConchColor.textSecondary).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: measure, alignment: .leading)
        case let .code(text):
            // Wrapped, as Xcode wraps it: a sideways scroller here is an `NSScrollView` per code block, a platform
            // view in the responder chain of every scroll event, and one that captures the wheel.
            Text(text).conversationSelectable(row: selectionRow, segment: segment).font(mono).fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, size * 0.7)
                .padding(.horizontal, size * 0.9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(ConchColor.fill, in: RoundedRectangle(cornerRadius: ConchRadius.small))
        case let .table(rows):
            table(rows, segment: segment)
        case .rule:
            Rectangle().fill(ConchColor.hairlineStrong).frame(height: 1).padding(.vertical, size * 0.3).allowsHitTesting(false)
        case let .image(alt, source):
            if let image { image(source, alt) }
        }
    }

    /// A table is columns, or it is not a table. The cells wrap inside the measure rather than scrolling sideways —
    /// the atlas documents' cells run to 300 characters, and a grid that never wraps is 3000 pt wide. Which is what a
    /// SwiftUI `Grid` does: it sizes every column to its widest cell's ideal width and the whole document with it
    /// (measured 2026-09-20: the paragraphs clipped at both edges of a 748 pt render). So the columns are laid out here,
    /// and the grid's lines are a rule per row and per column placed by the layout, not two overlays on every cell.
    private func table(_ rows: [[String]], segment: Int) -> some View {
        let columns = rows[0].count
        return MarkdownTableLayout(weights: MarkdownDocument.columnWeights(rows), rows: rows.count) {
            // The decorations first, so the cells draw over them: the header's ground, then the rules.
            Rectangle().fill(ConchColor.fill).allowsHitTesting(false)
            ForEach(0..<max(rows.count - 1, 0), id: \.self) { _ in Rectangle().fill(ConchColor.hairline).allowsHitTesting(false) }
            ForEach(0..<max(columns - 1, 0), id: \.self) { _ in Rectangle().fill(ConchColor.hairline).allowsHitTesting(false) }
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                    Text(Self.styled(cell, font: index == 0 ? tableFont.weight(.semibold) : tableFont, size: tableSize))
                        .conversationSelectable(row: selectionRow, segment: segment + index * columns + column)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, size * 0.6)
                        .padding(.vertical, size * 0.4)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: ConchRadius.small))
        .overlay(RoundedRectangle(cornerRadius: ConchRadius.small).strokeBorder(ConchColor.hairlineStrong, lineWidth: 1).allowsHitTesting(false))
    }
}

extension MarkdownView {
    /// How many selectable texts a piece draws: one for prose, an item, a quote or a code block, one per cell for a table,
    /// none for a rule or a picture.
    static func segmentCount(_ piece: Piece) -> Int {
        switch piece {
        case .flow, .bullet, .ordered, .quote, .code: 1
        case let .table(rows): rows.count * (rows.first?.count ?? 0)
        case .rule, .image: 0
        }
    }

    /// Each piece's first place among the document's selectable texts.
    static func firstSegments(_ pieces: [Piece]) -> [Int] {
        var next = 0
        return pieces.map { piece in
            defer { next += segmentCount(piece) }
            return next
        }
    }

    /// The document's selectable texts as `MarkdownView` draws and tags them, in the same order: the plain characters of
    /// each, and what kind of block it is, for the conversation's selection to map and copy
    /// (ConversationSelection.swift). `size` is the one the view is drawn at, so the parse is the one it cached.
    public static func selectableSegments(_ text: String, size: CGFloat = ConchType.readingBodySize) -> [SelectableSegment] {
        var segments: [SelectableSegment] = []
        var tables = 0
        for piece in MarkdownPieceCache.shared.pieces(text, size: size, images: false) {
            switch piece {
            case let .flow(text):
                segments.append(SelectableSegment(text, kind: .prose))
            case let .bullet(depth, text):
                segments.append(SelectableSegment(text, kind: .listItem(marker: ["•", "◦", "▪"][min(depth, 2)], depth: depth)))
            case let .ordered(depth, ordinal, text):
                segments.append(SelectableSegment(text, kind: .listItem(marker: "\(ordinal).", depth: depth)))
            case let .quote(text):
                segments.append(SelectableSegment(text, kind: .quote))
            case let .code(text):
                segments.append(SelectableSegment(text: text, kind: .code))
            case let .table(rows):
                for (r, row) in rows.enumerated() {
                    for (c, cell) in row.enumerated() {
                        segments.append(SelectableSegment(MarkdownDocument.inline(cell), kind: .tableCell(table: tables, row: r, column: c)))
                    }
                }
                tables += 1
            case .rule, .image:
                break
            }
        }
        return segments
    }
}

/// Cells in row order after `rows + columns - 1` decorations (the header ground, a rule under each row but the last, a
/// rule after each column but the last); each column `weights[c]` of the width offered, each row as tall as its tallest
/// cell.
struct MarkdownTableLayout: Layout {
    let weights: [CGFloat]
    let rows: Int
    private var columns: Int { weights.count }
    private var decorations: Int { rows + columns - 1 }

    private func cell(_ subviews: Subviews, _ r: Int, _ c: Int) -> LayoutSubview { subviews[decorations + r * columns + c] }

    private func heights(_ subviews: Subviews, widths: [CGFloat]) -> [CGFloat] {
        (0..<rows).map { r in
            (0..<columns).map { c in cell(subviews, r, c).sizeThatFits(ProposedViewSize(width: widths[c], height: nil)).height }.max() ?? 0
        }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard subviews.count == decorations + rows * columns else { return .zero }
        // Asked for an ideal size (no width), take the reading measure rather than the sum of unwrapped cells.
        let width = proposal.width ?? 600
        return CGSize(width: width, height: heights(subviews, widths: weights.map { ($0 * width).rounded(.down) }).reduce(0, +))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == decorations + rows * columns else { return }
        let widths = weights.map { ($0 * bounds.width).rounded(.down) }
        let heights = heights(subviews, widths: widths)
        var y = bounds.minY, tops: [CGFloat] = []
        for r in 0..<rows {
            var x = bounds.minX
            tops.append(y)
            for c in 0..<columns {
                cell(subviews, r, c).place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: widths[c], height: heights[r]))
                x += widths[c]
            }
            y += heights[r]
        }
        var i = 0
        subviews[i].place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: heights[0])); i += 1
        for r in 0..<(rows - 1) {
            subviews[i].place(at: CGPoint(x: bounds.minX, y: tops[r] + heights[r] - 1), proposal: ProposedViewSize(width: bounds.width, height: 1)); i += 1
        }
        var x = bounds.minX
        for c in 0..<(columns - 1) {
            x += widths[c]
            subviews[i].place(at: CGPoint(x: x - 1, y: bounds.minY), proposal: ProposedViewSize(width: 1, height: bounds.height)); i += 1
        }
    }
}

/// Parsed documents, by their text and size, so a transcript row is parsed once per revision of
/// its text rather than every time it is built.
///
/// A recorded row is only a real view near the viewport (`HistoryWindow`); scrolled away it is a
/// height, and scrolled back it is built again. Parsing is what building a reply costs — the block
/// split and a Foundation markdown parse per block, milliseconds for a long one — so a reader who
/// scrolls up and down through a session would pay for the same parse on every pass. The text IS
/// the revision: a message that changed is a different key, and one that did not is found again.
/// Bounded, and NSCache lets it go under memory pressure.
final class MarkdownPieceCache: @unchecked Sendable {
    static let shared = MarkdownPieceCache()

    private final class Key: NSObject {
        let text: String
        let size: CGFloat
        let lineSpacing: CGFloat
        let images: Bool
        private let hashed: Int

        init(_ text: String, size: CGFloat, lineSpacing: CGFloat, images: Bool) {
            self.text = text
            self.size = size
            self.lineSpacing = lineSpacing
            self.images = images
            var hasher = Hasher()
            hasher.combine(text)
            hasher.combine(size)
            hasher.combine(lineSpacing)
            hasher.combine(images)
            hashed = hasher.finalize()
        }

        override var hash: Int { hashed }
        override func isEqual(_ object: Any?) -> Bool {
            guard let other = object as? Key else { return false }
            return hashed == other.hashed && size == other.size && lineSpacing == other.lineSpacing && images == other.images
                && text == other.text
        }
    }

    private final class Entry {
        let placed: [MarkdownView.Placed]
        init(_ placed: [MarkdownView.Placed]) { self.placed = placed }
    }

    private let cache: NSCache<Key, Entry> = {
        let cache = NSCache<Key, Entry>()
        // Rows, not bytes, is what a scroll revisits; the cost keeps one enormous paste from
        // holding the rest out.
        cache.countLimit = 400
        cache.totalCostLimit = 24 * 1024 * 1024
        return cache
    }()

    /// Parses since launch: what the tests and the scroll benchmark count.
    private(set) var parses = 0
    private let lock = NSLock()

    func pieces(_ text: String, size: CGFloat, lineSpacing: CGFloat = 0, images: Bool) -> [MarkdownView.Piece] {
        placed(text, size: size, lineSpacing: lineSpacing, images: images).map(\.piece)
    }

    func placed(_ text: String, size: CGFloat, lineSpacing: CGFloat, images: Bool) -> [MarkdownView.Placed] {
        let key = Key(text, size: size, lineSpacing: lineSpacing, images: images)
        if let hit = cache.object(forKey: key) { return hit.placed }
        let placed = MarkdownView.placed(MarkdownDocument.blocks(text), size: size, lineSpacing: lineSpacing, images: images)
        cache.setObject(Entry(placed), forKey: key, cost: text.utf8.count * 4)
        lock.lock()
        parses += 1
        lock.unlock()
        return placed
    }
}

// MARK: - AppKit

#if canImport(AppKit)
/// The same document as one attributed string, for an `NSTextView`: the fallback transcript and the deliverable pane.
/// `base` is the body — font, colour and paragraph style — and every block is derived from it, so a caller that dims
/// half the text by passing a different base gets the same layout in both halves.
public enum MarkdownTypesetter {
    public static func attributedString(_ text: String, base: [NSAttributedString.Key: Any]) -> NSAttributedString {
        let blocks = MarkdownDocument.blocks(text)
        guard !blocks.isEmpty else { return NSAttributedString(string: text, attributes: base) }
        let font = (base[.font] as? NSFont) ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)
        let color = (base[.foregroundColor] as? NSColor) ?? .labelColor
        let size = font.pointSize
        let output = NSMutableAttributedString()

        func paragraph(spacingBefore: CGFloat = 0) -> NSMutableParagraphStyle {
            let style = ((base[.paragraphStyle] as? NSParagraphStyle)?.mutableCopy() as? NSMutableParagraphStyle)
                ?? NSMutableParagraphStyle()
            style.paragraphSpacing = size * 0.7
            style.paragraphSpacingBefore = spacingBefore
            return style
        }
        func styled(_ font: NSFont, traits: NSFontDescriptor.SymbolicTraits, size: CGFloat? = nil) -> NSFont {
            NSFont(descriptor: font.fontDescriptor.withSymbolicTraits(traits), size: size ?? font.pointSize)
                ?? NSFont.boldSystemFont(ofSize: size ?? font.pointSize)
        }
        /// One block's text with its inline emphasis, ended by a newline that carries the paragraph style.
        func append(_ text: String, font blockFont: NSFont, style: NSParagraphStyle, color: NSColor = color, prefix: String = "") {
            let piece = NSMutableAttributedString(string: prefix, attributes: base)
            piece.append(inline(text, font: blockFont))
            piece.append(NSAttributedString(string: "\n", attributes: base))
            piece.addAttributes([.paragraphStyle: style, .foregroundColor: color], range: NSRange(location: 0, length: piece.length))
            output.append(piece)
        }
        func inline(_ text: String, font blockFont: NSFont) -> NSAttributedString {
            let piece = NSMutableAttributedString(attributedString: NSAttributedString(MarkdownDocument.inline(text)))
            let whole = NSRange(location: 0, length: piece.length)
            piece.addAttributes(base, range: whole)
            piece.addAttribute(.font, value: blockFont, range: whole)
            piece.enumerateAttribute(.inlinePresentationIntent, in: whole) { value, range, _ in
                guard let raw = value as? UInt else { return }
                let intent = InlinePresentationIntent(rawValue: raw)
                if intent.contains(.code) {
                    piece.addAttribute(.font, value: NSFont.monospacedSystemFont(ofSize: blockFont.pointSize * ConchReading.codeScale, weight: .regular), range: range)
                    return
                }
                if intent.contains(.strikethrough) {
                    piece.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: range)
                }
                var traits: NSFontDescriptor.SymbolicTraits = []
                if intent.contains(.stronglyEmphasized) { traits.insert(.bold) }
                if intent.contains(.emphasized) { traits.insert(.italic) }
                if !traits.isEmpty { piece.addAttribute(.font, value: styled(blockFont, traits: traits), range: range) }
            }
            return piece
        }
        let hairline = color.withAlphaComponent(0.12)
        let ground = color.withAlphaComponent(0.06)
        /// A block the width of the measure. Without a width TextKit lays an `NSTextBlock` out one character per line
        /// (measured 2026-09-20: a one-line quote 1,300 pt tall).
        func fullWidthBlock() -> NSTextBlock {
            let block = NSTextBlock()
            block.setValue(100, type: .percentageValueType, for: .width)
            return block
        }

        for block in blocks {
            switch block {
            case let .heading(level, text):
                let scaled = styled(font, traits: .bold, size: size * MarkdownDocument.headingScale(level))
                append(text, font: scaled, style: paragraph(spacingBefore: level <= 2 ? size * 0.6 : size * 0.3))
            case let .paragraph(text):
                append(text, font: font, style: paragraph())
            case let .bullet(depth, text), let .ordered(depth, _, text):
                let indent = size * CGFloat(1 + depth) * 1.2
                let hanging = size * 1.4
                let style = paragraph()
                style.firstLineHeadIndent = indent
                // Hanging indent, so a wrapped item lines up under its own text rather than under its marker.
                style.headIndent = indent + hanging
                style.tabStops = [NSTextTab(textAlignment: .left, location: indent + hanging)]
                style.paragraphSpacing = size * 0.25
                let marker: String
                if case let .ordered(_, ordinal, _) = block { marker = "\(ordinal)." } else { marker = ["•", "◦", "▪"][min(depth, 2)] }
                append(text, font: font, style: style, prefix: marker + "\t")
            case let .quote(text):
                // Indented on a rule; never dimmed, since the fallback dims the text the voice has not reached yet
                // and a dim quote looked unread.
                let style = paragraph()
                let block = fullWidthBlock()
                block.setBorderColor(hairline, for: .minX)
                block.setWidth(3, type: .absoluteValueType, for: .border, edge: .minX)
                block.setWidth(size * 0.8, type: .absoluteValueType, for: .padding, edge: .minX)
                style.textBlocks = [block]
                append(text, font: font, style: style)
            case let .code(text):
                let style = paragraph()
                let block = fullWidthBlock()
                block.backgroundColor = ground
                block.setWidth(size * 0.7, type: .absoluteValueType, for: .padding)
                style.textBlocks = [block]
                style.lineBreakMode = .byCharWrapping
                append(text.replacingOccurrences(of: "\n", with: "\u{2028}"), font: NSFont.monospacedSystemFont(ofSize: size * ConchReading.codeScale, weight: .regular), style: style)
            case let .table(rows):
                let table = NSTextTable()
                table.numberOfColumns = rows[0].count
                table.collapsesBorders = true
                // Left to itself TextKit gives every column the same width (see `columnWeights`).
                let weights = MarkdownDocument.columnWeights(rows)
                for (r, row) in rows.enumerated() {
                    for (c, cell) in row.enumerated() {
                        let block = NSTextTableBlock(table: table, startingRow: r, rowSpan: 1, startingColumn: c, columnSpan: 1)
                        block.setValue(weights[c] * 100, type: .percentageValueType, for: .width)
                        block.setBorderColor(hairline)
                        block.setWidth(1, type: .absoluteValueType, for: .border)
                        block.setWidth(size * 0.6, type: .absoluteValueType, for: .padding, edge: .minX)
                        block.setWidth(size * 0.6, type: .absoluteValueType, for: .padding, edge: .maxX)
                        block.setWidth(size * 0.35, type: .absoluteValueType, for: .padding, edge: .minY)
                        block.setWidth(size * 0.35, type: .absoluteValueType, for: .padding, edge: .maxY)
                        if r == 0 { block.backgroundColor = ground }
                        // A cell's paragraph spacing would grow the cell; the air under the table is the last row's margin.
                        if r == rows.count - 1 { block.setWidth(size * 0.7, type: .absoluteValueType, for: .margin, edge: .maxY) }
                        let style = paragraph()
                        style.paragraphSpacing = 0
                        style.textBlocks = [block]
                        // A cell must not be empty: TextKit gives an empty paragraph no row height.
                        append(cell.isEmpty ? "\u{00A0}" : cell, font: r == 0 ? styled(font, traits: .bold) : font, style: style)
                    }
                }
            case .rule:
                let style = paragraph()
                let block = fullWidthBlock()
                block.setBorderColor(hairline, for: .minY)
                block.setWidth(1, type: .absoluteValueType, for: .border, edge: .minY)
                style.textBlocks = [block]
                append("\u{00A0}", font: NSFont.systemFont(ofSize: 2), style: style)
            case let .image(alt, source):
                append("![\(alt)](\(source))", font: font, style: paragraph())
            }
        }
        // The last newline would draw one empty line under the document.
        if output.length > 0 { output.deleteCharacters(in: NSRange(location: output.length - 1, length: 1)) }
        return output
    }
}
#endif
