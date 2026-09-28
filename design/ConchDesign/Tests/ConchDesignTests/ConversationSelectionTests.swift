import CoreGraphics
import SwiftUI
import XCTest
@testable import ConchDesign

/// The conversation's selection as a model: points in rows, what each row has lit, where a point lands in a laid-out
/// text, and what Copy puts on the pasteboard — without a view, from made-up layouts.
final class ConversationSelectionTests: XCTestCase {
    // MARK: - Order and slices

    private let order = SelectionOrder(["u1", "a1", "tool", "u2", "a2"])

    private func point(_ row: String, _ segment: Int, _ offset: Int) -> SelectionPoint {
        SelectionPoint(row: row, segment: segment, offset: offset)
    }

    func testPointsCompareInReadingOrderAcrossRowsSegmentsAndOffsets() {
        XCTAssertEqual(order.precedes(point("u1", 3, 99), point("a1", 0, 0)), true, "an earlier row, whatever its offset")
        XCTAssertEqual(order.precedes(point("a1", 0, 99), point("a1", 1, 0)), true, "an earlier segment")
        XCTAssertEqual(order.precedes(point("a1", 1, 5), point("a1", 1, 4)), false)
        XCTAssertNil(order.precedes(point("gone", 0, 0), point("a1", 0, 0)), "a row not in the conversation has no place")
    }

    func testASelectionDraggedUpwardHasTheSameBoundsAsOneDraggedDown() {
        let down = ConversationSelection(anchor: .caret(point("u1", 0, 2)), focus: .caret(point("u2", 0, 4)))
        let up = ConversationSelection(anchor: .caret(point("u2", 0, 4)), focus: .caret(point("u1", 0, 2)))
        XCTAssertEqual(down.bounds(in: order)?.start, point("u1", 0, 2))
        XCTAssertEqual(up.bounds(in: order)?.start, point("u1", 0, 2))
        XCTAssertEqual(up.bounds(in: order)?.end, point("u2", 0, 4))
    }

    /// A word selection dragged back past where it started keeps the whole first word.
    func testAWordSelectionDraggedBackwardKeepsTheWholeAnchorWord() {
        let word = SelectionSpan(start: point("a1", 0, 10), end: point("a1", 0, 15))
        let earlier = SelectionSpan(start: point("a1", 0, 2), end: point("a1", 0, 6))
        let selection = ConversationSelection(anchor: word, focus: earlier, granularity: .word)
        XCTAssertEqual(selection.bounds(in: order)?.start, point("a1", 0, 2))
        XCTAssertEqual(selection.bounds(in: order)?.end, point("a1", 0, 15), "the anchor word's end, not its start")
    }

    func testEachRowIsLitFromWhereTheSelectionEntersItToWhereItLeaves() {
        let selection = ConversationSelection(anchor: .caret(point("a1", 1, 4)), focus: .caret(point("u2", 0, 3)))
        XCTAssertNil(selection.slice(for: "u1", in: order), "before it")
        XCTAssertEqual(selection.slice(for: "a1", in: order), RowSelectionSlice(from: SegmentOffset(segment: 1, offset: 4), to: nil))
        XCTAssertEqual(selection.slice(for: "tool", in: order), RowSelectionSlice(from: nil, to: nil), "wholly inside it")
        XCTAssertEqual(selection.slice(for: "u2", in: order), RowSelectionSlice(from: nil, to: SegmentOffset(segment: 0, offset: 3)))
        XCTAssertNil(selection.slice(for: "a2", in: order), "after it")
        let caret = ConversationSelection(anchor: .caret(point("a1", 0, 4)), focus: .caret(point("a1", 0, 4)))
        XCTAssertNil(caret.slice(for: "a1", in: order), "a caret lights nothing")
        XCTAssertTrue(caret.isEmpty(in: order))
    }

    func testASliceGivesEachSegmentItsPartClampedToItsLength() {
        let slice = RowSelectionSlice(from: SegmentOffset(segment: 1, offset: 4), to: SegmentOffset(segment: 3, offset: 2))
        XCTAssertNil(slice.range(ofSegment: 0, length: 10))
        XCTAssertEqual(slice.range(ofSegment: 1, length: 10), 4..<10)
        XCTAssertEqual(slice.range(ofSegment: 2, length: 7), 0..<7)
        XCTAssertEqual(slice.range(ofSegment: 3, length: 7), 0..<2)
        XCTAssertNil(slice.range(ofSegment: 4, length: 7))
        XCTAssertNil(slice.range(ofSegment: 1, length: 3), "starts past the end of a text that got shorter")
        XCTAssertTrue(slice.continues(pastSegment: 2))
        XCTAssertFalse(slice.continues(pastSegment: 3))
        let whole = RowSelectionSlice(from: nil, to: SegmentOffset(segment: Int.max, offset: Int.max))
        XCTAssertEqual(whole.range(ofSegment: 5, length: 9), 0..<9, "select all's far end takes every segment whole")
    }

    // MARK: - Where the words are

    /// "ab cd" wrapping after "ab ", a blank line, then "ef" — laid out as SwiftUI reports it: each paragraph's glyphs
    /// counted from 0 again, and a blank line with no glyphs at all.
    private func wrapped(origin: CGPoint = CGPoint(x: 100, y: 1000)) -> SegmentGeometry {
        let text = "ab cd\n\nef"
        let lines = [
            SelectionLayoutLine(top: 0, bottom: 20, glyphs: [(0, 0, 10), (1, 10, 20), (2, 20, 25)]),
            SelectionLayoutLine(top: 28, bottom: 48, glyphs: [(3, 0, 10), (4, 10, 20)]),
            SelectionLayoutLine(top: 56, bottom: 60, glyphs: []),
            SelectionLayoutLine(top: 68, bottom: 88, glyphs: [(0, 0, 12), (1, 12, 24)]),
        ]
        return SegmentGeometry(lines: lines, text: text, origin: origin)
    }

    func testParagraphRelativeIndicesBecomeOffsetsIntoTheWholeText() {
        let geometry = wrapped()
        XCTAssertEqual(geometry.length, 9)
        XCTAssertEqual(geometry.lines.map(\.start), [0, 3, 6, 7], "the wrapped line carries on; the blank and the next paragraph start again")
        XCTAssertEqual(geometry.lines[0].end, 3, "a wrapped line ends where the next begins")
        XCTAssertEqual(geometry.lines[1].end, 5, "the paragraph's last line ends at its line break")
        XCTAssertEqual(geometry.lines[3].end, 9)
        XCTAssertEqual(geometry.bounds, CGRect(x: 100, y: 1000, width: 25, height: 88))
    }

    func testAPointMapsToTheNearestCaretOnItsLine() {
        let geometry = wrapped()
        XCTAssertEqual(geometry.caret(at: CGPoint(x: 104, y: 1010)), 0, "left half of 'a'")
        XCTAssertEqual(geometry.caret(at: CGPoint(x: 106, y: 1010)), 1, "right half of 'a'")
        XCTAssertEqual(geometry.caret(at: CGPoint(x: 300, y: 1035)), 5, "past the end of the second line: its end")
        XCTAssertEqual(geometry.caret(at: CGPoint(x: 90, y: 1080)), 7, "before the last paragraph: its start")
        XCTAssertEqual(geometry.caret(at: CGPoint(x: 110, y: 900)), 0, "above the text: its start")
        XCTAssertEqual(geometry.caret(at: CGPoint(x: 110, y: 1200)), 9, "below it: its end")
        XCTAssertEqual(geometry.caret(at: CGPoint(x: 130, y: 1051)), 5, "in the line spacing: the nearer line")
        XCTAssertEqual(geometry.character(at: CGPoint(x: 115, y: 1010)), 1, "the glyph under the point")
        XCTAssertNil(geometry.character(at: CGPoint(x: 140, y: 1010)), "past the line's end, on no glyph")
    }

    func testASelectionAcrossLinesIsLitAsOneBlockToTheTextsEdge() {
        let geometry = wrapped()
        let rects = geometry.rects(for: 1..<8, continues: false)
        XCTAssertEqual(rects.count, 4)
        XCTAssertEqual(rects[0], CGRect(x: 110, y: 1000, width: 15, height: 28), "from 'b' to the edge, down to the next line")
        XCTAssertEqual(rects[1], CGRect(x: 100, y: 1028, width: 25, height: 28), "the whole line, its break included")
        XCTAssertEqual(rects[2].minY, 1056, "the blank line between the paragraphs")
        XCTAssertEqual(rects[3], CGRect(x: 100, y: 1068, width: 12, height: 20), "'e' only: the selection stops there")
        XCTAssertEqual(geometry.rects(for: 7..<9, continues: true).last?.maxX, 125, "running on past the text: lit to its edge")
        XCTAssertEqual(geometry.rects(for: 1..<2, continues: false), [CGRect(x: 110, y: 1000, width: 10, height: 20)])
    }

    /// A glyph can stand for more than one UTF-16 unit — an emoji is a surrogate pair — so a line's end is its
    /// paragraph's end, never the last glyph's index plus one.
    func testALineEndingInAnEmojiEndsAfterBothHalvesOfIt() {
        let text = "hi 😀\nx"
        let lines = [
            SelectionLayoutLine(top: 0, bottom: 20, glyphs: [(0, 0, 8), (1, 8, 12), (2, 12, 16), (3, 16, 36)]),
            SelectionLayoutLine(top: 20, bottom: 40, glyphs: [(0, 0, 8)]),
        ]
        let geometry = SegmentGeometry(lines: lines, text: text, origin: .zero)
        XCTAssertEqual(geometry.lines[0].end, 5, "after the pair, not in the middle of it")
        XCTAssertEqual(geometry.lines[1].start, 6)
        XCTAssertEqual(geometry.caret(at: CGPoint(x: 40, y: 10)), 5)
    }

    /// A one-letter paragraph ends on index 0, and the next paragraph starts on index 0 again: equal, not lower, is
    /// already a new paragraph.
    func testAOneLetterParagraphIsFollowedByANewParagraphNotAWrappedLine() {
        let lines = [
            SelectionLayoutLine(top: 0, bottom: 20, glyphs: [(0, 0, 8)]),
            SelectionLayoutLine(top: 20, bottom: 40, glyphs: [(0, 0, 8), (1, 8, 16)]),
        ]
        let geometry = SegmentGeometry(lines: lines, text: "a\nbc", origin: .zero)
        XCTAssertEqual(geometry.lines.map(\.start), [0, 2])
        XCTAssertEqual(geometry.lines[0].end, 1)
        XCTAssertEqual(geometry.caret(at: CGPoint(x: 20, y: 30)), 4)
    }

    func testParagraphsAreSplitAsCoreTextSplitsThem() {
        XCTAssertEqual(SelectionParagraphs("a\nb").ranges.map(\.start), [0, 2])
        XCTAssertEqual(SelectionParagraphs("a\r\nb").ranges.map(\.start), [0, 3], "CRLF is one break")
        XCTAssertEqual(SelectionParagraphs("a\u{2028}b").ranges.count, 1, "a line separator is not a paragraph")
        XCTAssertEqual(SelectionParagraphs("a\n").ranges.map(\.start), [0, 2], "a trailing break has an empty paragraph after it")
        XCTAssertEqual(SelectionParagraphs("").ranges.count, 1)
    }

    // MARK: - Words, paragraphs, links

    func testADoubleClickSelectsTheWordAndOnASpaceTheSpaces() {
        let segment = SelectableSegment(text: "Hello brave  new world")
        XCTAssertEqual(segment.wordRange(at: 7), 6..<11)
        XCTAssertEqual(segment.wordRange(at: 11), 11..<13, "the run of spaces")
        XCTAssertEqual(segment.wordRange(at: 99), 17..<22, "past the end: the last word")
    }

    func testATripleClickSelectsTheParagraphWithoutItsBreak() {
        let segment = SelectableSegment(text: "one two\n\nthree four\nfive")
        XCTAssertEqual(segment.paragraphRange(at: 3), 0..<7)
        XCTAssertEqual(segment.paragraphRange(at: 12), 9..<19)
        XCTAssertEqual(segment.paragraphRange(at: 22), 20..<24)
    }

    func testLinksAreFoundInTheTextAsDrawn() {
        let segment = SelectableSegment(MarkdownDocument.inline("see [the docs](https://example.com) now"))
        XCTAssertEqual(segment.text, "see the docs now")
        XCTAssertEqual(segment.links, [4..<12])
        XCTAssertTrue(segment.isLink(at: 4))
        XCTAssertFalse(segment.isLink(at: 12))
    }

    // MARK: - Copy

    private var exchange: [SelectableRowText] {
        [
            SelectableRowText(id: "u1", speaker: .you, segments: [SelectableSegment(text: "Why does the build fail?")]),
            SelectableRowText(id: "a1", speaker: .agent("Claude"), segments: [
                SelectableSegment(text: "The linker can't find libfoo.\n\nTwo fixes:", kind: .prose),
                SelectableSegment(text: "pin it", kind: .listItem(marker: "•", depth: 0)),
                SelectableSegment(text: "vendor it", kind: .listItem(marker: "◦", depth: 1)),
                SelectableSegment(text: "swift build -c release\nswift test", kind: .code),
                SelectableSegment(text: "Flag", kind: .tableCell(table: 0, row: 0, column: 0)),
                SelectableSegment(text: "Meaning", kind: .tableCell(table: 0, row: 0, column: 1)),
                SelectableSegment(text: "-c", kind: .tableCell(table: 0, row: 1, column: 0)),
                SelectableSegment(text: "config", kind: .tableCell(table: 0, row: 1, column: 1)),
            ]),
            SelectableRowText(id: "u2", speaker: .you, segments: [SelectableSegment(text: "Thanks, pinning it.")]),
        ]
    }

    func testCopyingAcrossMessagesLabelsEachSpeakerAndKeepsEachBlocksShape() {
        let order = SelectionOrder(["u1", "a1", "tool", "u2"])
        let text = SelectionCopy.text(rows: exchange, start: point("u1", 0, 4), end: point("u2", 0, 6), order: order)
        XCTAssertEqual(text, """
        You: does the build fail?

        Claude: The linker can't find libfoo.

        Two fixes:

        • pin it
          ◦ vendor it

        swift build -c release
        swift test

        Flag\tMeaning
        -c\tconfig

        You: Thanks
        """)
    }

    func testCopyingInsideOneMessageHasNoLabelAndNoMarkerForAnItemEnteredPartWay() {
        let order = SelectionOrder(["u1", "a1", "u2"])
        let text = SelectionCopy.text(rows: exchange, start: point("a1", 1, 4), end: point("a1", 3, 10), order: order)
        XCTAssertEqual(text, "it\n  ◦ vendor it\n\nswift buil", "an item entered part way has no bullet; a whole one does")
    }

    func testCopyingSkipsRowsWithNothingSelectableAndConsecutiveRepliesShareOneLabel() {
        let rows = [
            SelectableRowText(id: "a1", speaker: .agent("Codex"), segments: [SelectableSegment(text: "Reading the file.")]),
            SelectableRowText(id: "t", speaker: .output("Bash"), segments: []),
            SelectableRowText(id: "a2", speaker: .agent("Codex"), segments: [SelectableSegment(text: "Found it.")]),
            SelectableRowText(id: "u", speaker: .you, segments: [SelectableSegment(text: "ok")]),
        ]
        let order = SelectionOrder(["a1", "t", "a2", "u"])
        let text = SelectionCopy.text(rows: rows, start: point("a1", 0, 0), end: point("u", 0, 2), order: order)
        XCTAssertEqual(text, "Codex: Reading the file.\n\nFound it.\n\nYou: ok")
    }

    func testALabelBeforeACodeBlockGoesOnItsOwnLine() {
        let rows = [
            SelectableRowText(id: "u", speaker: .you, segments: [SelectableSegment(text: "run it")]),
            SelectableRowText(id: "o", speaker: .output("Bash"), segments: [SelectableSegment(text: "ok 1 passes", kind: .code)]),
        ]
        let text = SelectionCopy.text(rows: rows, start: point("u", 0, 0), end: point("o", 0, 11), order: SelectionOrder(["u", "o"]))
        XCTAssertEqual(text, "You: run it\n\nBash output:\nok 1 passes")
    }

    // MARK: - The markdown renderer's texts

    func testTheRenderersSelectableTextsAreTheTextsItDrawsInTheOrderItTagsThem() {
        let document = """
        # Title

        Some **bold** prose.

        - one
          - nested
        1. first

        ```
        let x = 1
        ```

        | A | B |
        |---|---|
        | 1 | 2 |

        > quoted

        ---
        """
        let segments = MarkdownView.selectableSegments(document)
        XCTAssertEqual(segments.map(\.text), ["Title\n\nSome bold prose.", "one", "nested", "first", "let x = 1", "A", "B", "1", "2", "quoted"])
        XCTAssertEqual(segments[1].kind, .listItem(marker: "•", depth: 0))
        XCTAssertEqual(segments[2].kind, .listItem(marker: "◦", depth: 1))
        XCTAssertEqual(segments[3].kind, .listItem(marker: "1.", depth: 0))
        XCTAssertEqual(segments[4].kind, .code)
        XCTAssertEqual(segments[8].kind, .tableCell(table: 0, row: 1, column: 1))
        let pieces = MarkdownPieceCache.shared.pieces(document, size: ConchType.readingBodySize, images: false)
        XCTAssertEqual(MarkdownView.firstSegments(pieces), [0, 1, 2, 3, 4, 5, 9, 10], "each piece's tag is where its texts start")
        XCTAssertEqual(pieces.map(MarkdownView.segmentCount).reduce(0, +), segments.count)
    }
}
