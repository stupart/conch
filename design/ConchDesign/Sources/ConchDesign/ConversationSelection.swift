import CoreGraphics
import Foundation

// Selecting across the whole conversation, as in a document.
//
// Tyler: "I would also like to drag to select areas for copying in our conversation panel — it currently only lets me
// do 1 line at a time." The conversation is many SwiftUI `Text`s — a bubble, a reply's paragraphs, each list item and
// code block and table cell — and a SwiftUI text selection cannot cross from one `Text` into the next, so every
// paragraph was an island. Older rows are also only views while they are near the screen (`HistoryRegion`).
//
// So the selection is not held by any view. It is two points in the MODEL — a row's id, which text in the row, and a
// UTF-16 offset into that text's plain characters — and everything else is derived from those: which part of each row
// is lit, and what Copy puts on the pasteboard. A row that scrolls away and is let go of is still selected, and its
// text is still copied (`ConversationSelectionController.captured`). Where the words are on screen comes from SwiftUI's
// own layout of each `Text` (`Text.LayoutKey`), turned into `SegmentGeometry` here, so a point maps to the character
// SwiftUI actually drew there rather than to a second layout that might disagree with it.

/// A place in the conversation's text: the row, which of its selectable texts, and a UTF-16 offset into it.
public struct SelectionPoint: Hashable, Sendable {
    public var row: String
    public var segment: Int
    public var offset: Int

    public init(row: String, segment: Int, offset: Int) {
        self.row = row
        self.segment = segment
        self.offset = offset
    }
}

/// The rows in the order they are read, top to bottom.
public struct SelectionOrder: Sendable {
    public let ids: [String]
    private let positions: [String: Int]

    public init(_ ids: [String]) {
        self.ids = ids
        var positions: [String: Int] = [:]
        positions.reserveCapacity(ids.count)
        for (index, id) in ids.enumerated() where positions[id] == nil { positions[id] = index }
        self.positions = positions
    }

    public func position(of row: String) -> Int? { positions[row] }

    /// `a` comes before `b`; nil when either row is not in the conversation.
    public func precedes(_ a: SelectionPoint, _ b: SelectionPoint) -> Bool? {
        guard let ra = positions[a.row], let rb = positions[b.row] else { return nil }
        return (ra, a.segment, a.offset) < (rb, b.segment, b.offset)
    }
}

/// A stretch between two points, the start not after the end: a caret (start == end), a word or a paragraph.
public struct SelectionSpan: Hashable, Sendable {
    public var start: SelectionPoint
    public var end: SelectionPoint

    public init(start: SelectionPoint, end: SelectionPoint) {
        self.start = start
        self.end = end
    }

    public static func caret(_ point: SelectionPoint) -> SelectionSpan { SelectionSpan(start: point, end: point) }
}

/// What is selected: the unit the gesture began on and the unit it is at now. A drag's units are carets; a
/// double-click's are words and a triple-click's paragraphs, so dragging after one extends a whole word or paragraph at
/// a time, as a text view does.
public struct ConversationSelection: Hashable, Sendable {
    public enum Granularity: Hashable, Sendable { case character, word, paragraph }

    public var anchor: SelectionSpan
    public var focus: SelectionSpan
    public var granularity: Granularity

    public init(anchor: SelectionSpan, focus: SelectionSpan, granularity: Granularity = .character) {
        self.anchor = anchor
        self.focus = focus
        self.granularity = granularity
    }

    /// The selection's two ends in reading order; nil when a row it names is no longer in the conversation.
    public func bounds(in order: SelectionOrder) -> (start: SelectionPoint, end: SelectionPoint)? {
        guard let startFirst = order.precedes(focus.start, anchor.start),
              let endLast = order.precedes(anchor.end, focus.end) else { return nil }
        return (startFirst ? focus.start : anchor.start, endLast ? focus.end : anchor.end)
    }

    /// Nothing between its ends: a click that did not drag.
    public func isEmpty(in order: SelectionOrder) -> Bool {
        guard let (start, end) = bounds(in: order) else { return true }
        return start == end
    }

    /// The part of `row` that is selected, or nil when none of it is.
    public func slice(for row: String, in order: SelectionOrder) -> RowSelectionSlice? {
        guard let (start, end) = bounds(in: order), start != end,
              let at = order.position(of: row),
              let first = order.position(of: start.row),
              let last = order.position(of: end.row),
              first <= at, at <= last else { return nil }
        return RowSelectionSlice(
            from: at == first ? SegmentOffset(segment: start.segment, offset: start.offset) : nil,
            to: at == last ? SegmentOffset(segment: end.segment, offset: end.offset) : nil
        )
    }
}

/// A place inside one row.
public struct SegmentOffset: Hashable, Sendable {
    public var segment: Int
    public var offset: Int

    public init(segment: Int, offset: Int) {
        self.segment = segment
        self.offset = offset
    }
}

/// The selected part of one row: from a place in it (nil: from before it) to a place in it (nil: on past it). Enough to
/// light the row without knowing its text, so a row that comes back into view is lit from this alone.
public struct RowSelectionSlice: Hashable, Sendable {
    public var from: SegmentOffset?
    public var to: SegmentOffset?

    public init(from: SegmentOffset?, to: SegmentOffset?) {
        self.from = from
        self.to = to
    }

    /// The part of text `segment`, `length` long, that is selected; nil when none of it is.
    public func range(ofSegment segment: Int, length: Int) -> Range<Int>? {
        let lower: Int
        if let from {
            if segment < from.segment { return nil }
            lower = segment == from.segment ? from.offset : 0
        } else {
            lower = 0
        }
        let upper: Int
        if let to {
            if segment > to.segment { return nil }
            upper = segment == to.segment ? to.offset : length
        } else {
            upper = length
        }
        let clampedLower = min(max(lower, 0), length), clampedUpper = min(max(upper, 0), length)
        return clampedLower < clampedUpper ? clampedLower..<clampedUpper : nil
    }

    /// The selection runs on past the end of `segment`: its last line is lit to the edge, as a text view lights the line
    /// break.
    public func continues(pastSegment segment: Int) -> Bool {
        guard let to else { return true }
        return to.segment > segment
    }
}

// MARK: - The text

/// One selectable text in a row: its plain characters as drawn, what kind of block it is (which decides how it is
/// joined to its neighbours when copied), and where its links are, so a press on one still opens it.
public struct SelectableSegment: Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
        case prose
        /// A list item; `marker` is the bullet or number drawn beside it.
        case listItem(marker: String, depth: Int)
        case quote
        case code
        /// A table's cell. `table` tells two tables in one row apart.
        case tableCell(table: Int, row: Int, column: Int)
    }

    public let text: String
    public let kind: Kind
    /// UTF-16 ranges.
    public let links: [Range<Int>]

    public init(text: String, kind: Kind = .prose, links: [Range<Int>] = []) {
        self.text = text
        self.kind = kind
        self.links = links
    }

    public var length: Int { text.utf16.count }

    /// `attributed`'s characters, and where its links are.
    public init(_ attributed: AttributedString, kind: Kind = .prose) {
        let text = String(attributed.characters)
        var links: [Range<Int>] = []
        if attributed.runs.contains(where: { $0.link != nil }) {
            var offset = 0
            for run in attributed.runs {
                let length = String(attributed.characters[run.range]).utf16.count
                if run.link != nil { links.append(offset..<offset + length) }
                offset += length
            }
        }
        self.init(text: text, kind: kind, links: links)
    }

    public func isLink(at offset: Int) -> Bool {
        links.contains { $0.contains(offset) }
    }

    /// The word at `offset` — what a double-click selects. A press on a space or a mark selects that run of it alone.
    public func wordRange(at offset: Int) -> Range<Int> {
        let string = text as NSString
        guard string.length > 0 else { return 0..<0 }
        let at = min(max(offset, 0), string.length - 1)
        let paragraph = string.paragraphRange(for: NSRange(location: at, length: 0))
        var found: NSRange?
        string.enumerateSubstrings(in: paragraph, options: [.byWords, .substringNotRequired]) { _, range, _, stop in
            if NSLocationInRange(at, range) {
                found = range
                stop.pointee = true
            } else if range.location > at {
                stop.pointee = true
            }
        }
        if let found { return found.location..<NSMaxRange(found) }
        // Between words: the run of the same kind of character, never across a line break.
        let composed = string.rangeOfComposedCharacterSequence(at: at)
        let character = string.substring(with: composed)
        guard character.rangeOfCharacter(from: .whitespaces) != nil else { return composed.location..<NSMaxRange(composed) }
        var lower = composed.location, upper = NSMaxRange(composed)
        while lower > 0, string.substring(with: NSRange(location: lower - 1, length: 1)).rangeOfCharacter(from: .whitespaces) != nil { lower -= 1 }
        while upper < string.length, string.substring(with: NSRange(location: upper, length: 1)).rangeOfCharacter(from: .whitespaces) != nil { upper += 1 }
        return lower..<upper
    }

    /// The paragraph at `offset`, without its line break — what a triple-click selects.
    public func paragraphRange(at offset: Int) -> Range<Int> {
        let string = text as NSString
        guard string.length > 0 else { return 0..<0 }
        let at = min(max(offset, 0), string.length)
        var start = 0, end = 0, contentsEnd = 0
        string.getParagraphStart(&start, end: &end, contentsEnd: &contentsEnd, for: NSRange(location: min(at, string.length - 1), length: 0))
        return start..<contentsEnd
    }
}

/// A row's selectable texts, in the order they are drawn, and who is speaking in it.
public struct SelectableRowText: Hashable, Sendable {
    public enum Speaker: Hashable, Sendable {
        case you
        /// The agent's reply: "Claude", "Codex".
        case agent(String)
        case thinking(String)
        /// A tool's output, by the tool's name.
        case output(String)
    }

    public let id: String
    public let speaker: Speaker
    public let segments: [SelectableSegment]

    public init(id: String, speaker: Speaker, segments: [SelectableSegment]) {
        self.id = id
        self.speaker = speaker
        self.segments = segments
    }
}

// MARK: - Copy

/// What Copy puts on the pasteboard: the text as it reads on screen, not its markdown.
///
/// Messages are separated by a blank line, and within a message blocks keep their shape: paragraphs a blank line apart,
/// list items a line apart with their bullet or number, a code block's lines as they are, a table's cells a tab apart.
///
/// Labels ("You:", "Claude:") only when the selection spans more than one message. On screen who said what is carried by
/// the layout — your words are the right-hand bubble — and plain text has no layout, so a pasted exchange without them
/// reads as one voice. Inside a single message there is nobody to tell apart, and a label would only be one more thing
/// to delete from a pasted paragraph or code block.
public enum SelectionCopy {
    /// `rows`, those the selection covers, in reading order.
    public static func text(rows: [SelectableRowText], start: SelectionPoint, end: SelectionPoint, order: SelectionOrder) -> String {
        guard let first = order.position(of: start.row), let last = order.position(of: end.row) else { return "" }
        struct Part { let kind: SelectableSegment.Kind; let text: String; let wholeFromStart: Bool }
        var messages: [(speaker: SelectableRowText.Speaker, parts: [Part])] = []
        for row in rows {
            guard let at = order.position(of: row.id), first <= at, at <= last else { continue }
            let slice = RowSelectionSlice(
                from: at == first ? SegmentOffset(segment: start.segment, offset: start.offset) : nil,
                to: at == last ? SegmentOffset(segment: end.segment, offset: end.offset) : nil
            )
            var parts: [Part] = []
            for (index, segment) in row.segments.enumerated() {
                guard let range = slice.range(ofSegment: index, length: segment.length) else { continue }
                let piece = (segment.text as NSString).substring(with: NSRange(location: range.lowerBound, length: range.count))
                parts.append(Part(kind: segment.kind, text: piece, wholeFromStart: range.lowerBound == 0))
            }
            if !parts.isEmpty { messages.append((row.speaker, parts)) }
        }
        let labelled = messages.count > 1
        var output: [String] = []
        var lastSpeaker: SelectableRowText.Speaker?
        for message in messages {
            var body = ""
            for (index, part) in message.parts.enumerated() {
                if index > 0 { body += separator(message.parts[index - 1].kind, part.kind) }
                if part.wholeFromStart { body += prefix(part.kind) }
                body += part.text
            }
            if labelled, message.speaker != lastSpeaker {
                let inline = message.parts.first.map { $0.kind == .prose || $0.kind == .quote } ?? true
                body = label(message.speaker) + (inline ? " " : "\n") + body
            }
            lastSpeaker = message.speaker
            output.append(body)
        }
        return output.joined(separator: "\n\n")
    }

    public static func label(_ speaker: SelectableRowText.Speaker) -> String {
        switch speaker {
        case .you: "You:"
        case let .agent(name): "\(name):"
        case let .thinking(name): "\(name) (thinking):"
        case let .output(name): "\(name) output:"
        }
    }

    static func separator(_ previous: SelectableSegment.Kind, _ next: SelectableSegment.Kind) -> String {
        switch (previous, next) {
        case (.listItem, .listItem):
            return "\n"
        case let (.tableCell(t1, r1, _), .tableCell(t2, r2, _)) where t1 == t2:
            return r1 == r2 ? "\t" : "\n"
        default:
            return "\n\n"
        }
    }

    static func prefix(_ kind: SelectableSegment.Kind) -> String {
        if case let .listItem(marker, depth) = kind { return String(repeating: "  ", count: depth) + marker + " " }
        return ""
    }
}

// MARK: - Where the words are

/// A caret stop on a line: before the character at `offset`, at `x`.
public struct SelectionCaret: Hashable, Sendable {
    public var offset: Int
    public var x: CGFloat

    public init(offset: Int, x: CGFloat) {
        self.offset = offset
        self.x = x
    }
}

/// One laid-out line of a text, in the stack's coordinates.
public struct SelectionLine: Hashable, Sendable {
    public var top: CGFloat
    public var bottom: CGFloat
    /// In ascending offset, the first before the line's first character and the last after its last. A line with no
    /// characters — the blank line between two paragraphs — has one.
    public var carets: [SelectionCaret]

    public init(top: CGFloat, bottom: CGFloat, carets: [SelectionCaret]) {
        self.top = top
        self.bottom = bottom
        self.carets = carets
    }

    public var start: Int { carets.first?.offset ?? 0 }
    public var end: Int { carets.last?.offset ?? 0 }
    public var minX: CGFloat { carets.map(\.x).min() ?? 0 }
    public var maxX: CGFloat { carets.map(\.x).max() ?? 0 }

    /// The caret nearest `x`.
    public func caret(at x: CGFloat) -> Int {
        var best = carets.first?.offset ?? 0, distance = CGFloat.infinity
        for caret in carets {
            let d = abs(caret.x - x)
            if d < distance { distance = d; best = caret.offset }
        }
        return best
    }

    /// The character whose glyph is under `x`, or nil past either end of the line.
    public func character(at x: CGFloat) -> Int? {
        guard carets.count > 1 else { return nil }
        for (index, caret) in carets.dropLast().enumerated() {
            let next = carets[index + 1]
            let lo = min(caret.x, next.x), hi = max(caret.x, next.x)
            if x >= lo, x < hi { return caret.offset }
        }
        return nil
    }

    /// Where the caret before `offset` stands: the nearest stop at or before it.
    public func x(of offset: Int) -> CGFloat {
        var best = carets.first?.x ?? 0
        for caret in carets where caret.offset <= offset { best = caret.x }
        return best
    }
}

/// One selectable text as it was laid out: its lines, in the stack's coordinates.
public struct SegmentGeometry: Hashable, Sendable {
    public var lines: [SelectionLine]
    /// Its length in UTF-16, the last caret's offset.
    public var length: Int
    /// The widest any of its lines runs, and so where a line whose break is selected is lit to.
    public var bounds: CGRect

    public init(lines: [SelectionLine], length: Int) {
        self.lines = lines
        self.length = length
        let top = lines.first?.top ?? 0, bottom = lines.last?.bottom ?? 0
        let minX = lines.map(\.minX).min() ?? 0, maxX = lines.map(\.maxX).max() ?? 0
        bounds = CGRect(x: minX, y: top, width: maxX - minX, height: bottom - top)
    }

    /// The line at `y`: the one it is on, else the nearest.
    public func lineIndex(at y: CGFloat) -> Int? {
        guard !lines.isEmpty else { return nil }
        var best = 0, distance = CGFloat.infinity
        for (index, line) in lines.enumerated() {
            let d = y < line.top ? line.top - y : (y > line.bottom ? y - line.bottom : 0)
            if d < distance { distance = d; best = index }
            if d == 0 { break }
        }
        return best
    }

    /// Where a press at `point` puts the caret. Above the text is its start and below it its end, as a text view has it
    /// for a drag past the top or bottom; beside a line, that line's nearest caret.
    public func caret(at point: CGPoint) -> Int {
        guard let first = lines.first, let last = lines.last else { return 0 }
        if point.y < first.top { return 0 }
        if point.y > last.bottom { return length }
        guard let index = lineIndex(at: point.y) else { return 0 }
        return lines[index].caret(at: point.x)
    }

    /// The character drawn under `point`, or nil when the point is off every glyph.
    public func character(at point: CGPoint) -> Int? {
        guard let index = lineIndex(at: point.y) else { return nil }
        let line = lines[index]
        guard point.y >= line.top, point.y <= line.bottom else { return nil }
        return line.character(at: point.x)
    }

    /// The rectangles that light `range`. A line the selection runs on past is lit to the text's widest edge and down to
    /// the next line's top, so a selection reads as one block rather than a stack of strips.
    public func rects(for range: Range<Int>, continues: Bool) -> [CGRect] {
        var lit: [(index: Int, minX: CGFloat, maxX: CGFloat)] = []
        for (index, line) in lines.enumerated() {
            let isLast = index == lines.count - 1
            let lineEnd = isLast ? length : max(line.end, lines[index + 1].start)
            // A blank line is lit when the selection runs through it.
            guard range.lowerBound <= lineEnd, range.upperBound > line.start || (line.start == line.end && range.upperBound > line.start) else { continue }
            if range.lowerBound == lineEnd, !(line.start == line.end && range.lowerBound == line.start) { continue }
            let x0 = range.lowerBound <= line.start ? line.x(of: line.start) : line.x(of: range.lowerBound)
            let runsOn = range.upperBound > lineEnd || (isLast && continues && range.upperBound >= length)
            var x1 = range.upperBound >= line.end ? line.x(of: line.end) : line.x(of: range.upperBound)
            if runsOn { x1 = max(x1, bounds.maxX, x0 + 4) }
            guard x1 > x0 else { continue }
            lit.append((index, x0, x1))
        }
        return lit.enumerated().map { position, entry in
            let line = lines[entry.index]
            // Down to the next lit line's top, when that line follows directly: the line spacing between them is lit too.
            var bottom = line.bottom
            if position + 1 < lit.count, lit[position + 1].index == entry.index + 1 {
                bottom = max(bottom, lines[entry.index + 1].top)
            }
            return CGRect(x: entry.minX, y: line.top, width: entry.maxX - entry.minX, height: bottom - line.top)
        }
    }
}

// MARK: - Paragraph-relative indices

/// SwiftUI numbers a laid-out character from the start of its paragraph, not of its text (measured: a text's second
/// paragraph starts at index 0 again). These are the paragraphs `text` holds, as CoreText splits them, so an index can be
/// made an offset into the whole text.
public struct SelectionParagraphs: Sendable {
    /// Each paragraph's first offset and where its content ends (before its line break).
    public let ranges: [(start: Int, end: Int)]

    public init(_ text: String) {
        let string = text as NSString
        var ranges: [(Int, Int)] = []
        var at = 0
        while at < string.length {
            var start = 0, end = 0, contentsEnd = 0
            string.getParagraphStart(&start, end: &end, contentsEnd: &contentsEnd, for: NSRange(location: at, length: 0))
            ranges.append((start, contentsEnd))
            guard end > at else { break }
            at = end
        }
        // A text that ends with a line break has one more, empty, paragraph after it; so does the empty text.
        if string.length == 0 || ranges.last.map({ $0.1 < string.length }) == true {
            ranges.append((string.length, string.length))
        }
        self.ranges = ranges
    }
}

/// One laid-out line as SwiftUI reports it: each glyph's paragraph-relative character index and its horizontal extent,
/// in the order drawn, and the line's vertical extent. What `SegmentGeometry` is built from.
public struct SelectionLayoutLine: Sendable {
    public var top: CGFloat
    public var bottom: CGFloat
    public var glyphs: [(index: Int, minX: CGFloat, maxX: CGFloat)]

    public init(top: CGFloat, bottom: CGFloat, glyphs: [(index: Int, minX: CGFloat, maxX: CGFloat)]) {
        self.top = top
        self.bottom = bottom
        self.glyphs = glyphs
    }
}

extension SegmentGeometry {
    /// `lines` of `text`, laid out with its origin at `origin`.
    ///
    /// A line starts a new paragraph when it holds no glyphs (a blank line), follows one that held none, or its indices
    /// start again from no higher than the last line's — a line that wraps carries on counting.
    public init(lines layout: [SelectionLayoutLine], text: String, origin: CGPoint) {
        let paragraphs = SelectionParagraphs(text).ranges
        var paragraph = 0
        var previousMax = -1
        var previousEmpty = false
        var drafts: [(top: CGFloat, bottom: CGFloat, carets: [SelectionCaret], paragraph: Int)] = []
        for (index, line) in layout.enumerated() {
            let lowest = line.glyphs.map(\.index).min()
            if index > 0, line.glyphs.isEmpty || previousEmpty || (lowest ?? 0) <= previousMax {
                paragraph = min(paragraph + 1, paragraphs.count - 1)
            }
            let base = paragraphs[paragraph].start
            let sorted = line.glyphs.sorted { $0.index < $1.index }
            var carets = sorted.map { SelectionCaret(offset: base + $0.index, x: origin.x + $0.minX) }
            if let last = sorted.last {
                carets.append(SelectionCaret(offset: base + last.index + 1, x: origin.x + last.maxX))
            } else {
                carets.append(SelectionCaret(offset: base, x: origin.x))
            }
            drafts.append((origin.y + line.top, origin.y + line.bottom, carets, paragraph))
            previousMax = line.glyphs.map(\.index).max() ?? -1
            previousEmpty = line.glyphs.isEmpty
        }
        // A line's end is where the next line of its paragraph starts, or its paragraph's end: a glyph can stand for
        // more than one character (a surrogate pair, a ligature, an accent), so "last index plus one" is only a guess.
        for index in drafts.indices where !drafts[index].carets.isEmpty && drafts[index].carets.count > 1 {
            let end: Int
            if index + 1 < drafts.count, drafts[index + 1].paragraph == drafts[index].paragraph, let next = drafts[index + 1].carets.first {
                end = next.offset
            } else {
                end = paragraphs[drafts[index].paragraph].end
            }
            let lastStop = drafts[index].carets.count - 1
            drafts[index].carets[lastStop].offset = max(end, drafts[index].carets[max(lastStop - 1, 0)].offset)
        }
        self.init(
            lines: drafts.map { SelectionLine(top: $0.top, bottom: $0.bottom, carets: $0.carets) },
            length: text.utf16.count
        )
    }
}
