import SwiftUI
import XCTest
@testable import ConchDesign
#if canImport(AppKit)
import AppKit
#endif

/// The conversation's reading type, measured rather than judged by eye (`ConchReading`, 2026-09-28).
///
/// Before these: prose ran the Mac column's whole 664 pt, a median 95 characters a line at 15 pt; a list sat as far from
/// the paragraph before it as its items sat from each other; a heading after a list, a code block or a table had 10.5 pt
/// above it and 18 below; inline code was set at the body's size in SF Mono; the transcript's "+3" was the brand cyan at
/// 1.94:1; and in the panel a paragraph break inside a turn (a whole blank line of 17 pt, 27 pt) was wider than the 14
/// between two turns.
final class ReadingMeasureTests: XCTestCase {
    /// Ordinary agent prose, three paragraphs of it.
    static let prose = [
        "The transcript sets every reply in one column that runs as wide as the window allows, so a paragraph of ordinary prose wraps at about ninety characters. The eye has to travel a long way back to find the start of the next line, and on a large display it often lands on the wrong one. The tool steps between replies make it worse, because each one claims the same space as a sentence you actually need to read.",
        "Mostly not: the panel already holds its words to a 620 pt column, and its wash keeps every level of text at 4.5:1 over anything. One choice is yours, though. The newest reply is set large on purpose, and the older turns step back to seventy percent of its ink so the eye lands on what is new before it reads what came before.",
        "I swapped the two stacked shadows for one soft one at 20% and eased the corner radius from 16 to 22. It sits lighter now, and the edge still reads against the peach. There are 10 px between the avatar and the name now, and the name dropped to 14 px grey so the heading leads. At 390 px the card runs edge to edge with 20 px of padding and the Join button stays full width.",
    ]

    #if canImport(AppKit)
    /// The median characters in a full line (every line but each paragraph's last) of `prose` in SF at `size`, `width` wide.
    static func medianLine(size: CGFloat, width: CGFloat) -> Int {
        var counts: [Int] = []
        for paragraph in prose {
            let storage = NSTextStorage(string: paragraph, attributes: [.font: NSFont.systemFont(ofSize: size)])
            let layout = NSLayoutManager()
            let container = NSTextContainer(size: NSSize(width: width, height: .greatestFiniteMagnitude))
            container.lineFragmentPadding = 0
            layout.addTextContainer(container)
            storage.addLayoutManager(layout)
            layout.ensureLayout(for: container)
            var lines: [Int] = []
            var glyph = 0
            while glyph < layout.numberOfGlyphs {
                var range = NSRange()
                layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: &range)
                lines.append(layout.characterRange(forGlyphRange: range, actualGlyphRange: nil).length)
                glyph = NSMaxRange(range)
            }
            counts += lines.dropLast()
        }
        return counts.sorted()[counts.count / 2]
    }

    /// 60 to 75 characters at every size a reply is set: the nested agent's 12.5, the Mac's 15, the phone's 17.
    func testTheMeasureHoldsSixtyToSeventyFiveCharactersAtEverySize() {
        for size: CGFloat in [12.5, ConchType.readingBodySize, 17] {
            let median = Self.medianLine(size: size, width: ConchReading.measure(size))
            print("measure at \(size) pt: \(ConchReading.measure(size)) pt, median \(median) characters")
            XCTAssertGreaterThanOrEqual(median, 64, "at \(size) pt")
            XCTAssertLessThanOrEqual(median, 75, "at \(size) pt")
        }
        // The Mac's column without it: 700 less the stack's padding either side.
        XCTAssertGreaterThan(Self.medianLine(size: 15, width: 700 - 36), 85, "the column alone is too long a line")
    }
    #endif

    /// Prose stops at the measure however wide the view; a code block takes the whole width.
    @MainActor
    func testProseStopsAtTheMeasureAndCodeTakesTheColumn() {
        let paragraph = Self.prose.joined(separator: " ")
        let wide = MarkdownRender.height(paragraph, width: 700)
        XCTAssertEqual(wide, MarkdownRender.height(paragraph, width: ConchReading.measure(15)), accuracy: 0.5,
                       "wider than the measure changes nothing")
        XCTAssertGreaterThan(wide, MarkdownRender.height(paragraph, width: ConchReading.measure(15) + 150) - 0.5)
        let uncapped = MarkdownRender.textHeight(paragraph, width: 700)
        XCTAssertGreaterThan(wide, uncapped + 40, "the capped paragraph runs to more, shorter lines")
        // A reply of several pieces, the usual shape: its paragraphs and its items stop at the measure too, not only a
        // reply that is one text.
        let mixed = paragraph + "\n\n- " + paragraph
        XCTAssertEqual(MarkdownRender.height(mixed, width: 700), MarkdownRender.height(mixed, width: ConchReading.measure(15)),
                       accuracy: 0.5, "a paragraph and an item beside other pieces keep the measure")

        // 76 characters: one line of SF Mono at 13 pt in the column, two at the measure.
        let code = "```\nlet measure = ConchReading.measure(size) // the longest line prose runs to, pt\n```"
        XCTAssertLessThan(MarkdownRender.height(code, width: 700), MarkdownRender.height(code, width: ConchReading.measure(15)),
                          "a code line wraps later in the whole column than it would at the measure")
    }

    /// Inline code a size down in SF Mono, in a paragraph and in a heading alike.
    func testInlineCodeIsASizeDown() {
        let styled = MarkdownView.styled("Set `ConchPalette.textFaint` here", font: .system(size: 15), size: 15)
        let code = styled.runs.first { $0.inlinePresentationIntent?.contains(.code) == true }
        XCTAssertEqual(code?.font, .system(size: 15 * ConchReading.codeScale, design: .monospaced))
        XCTAssertEqual(styled.runs.first?.font, .system(size: 15), "the words around it keep the body")
        XCTAssertEqual(ConchReading.codeScale * 15, 13, accuracy: 0.1, "13 pt at 15, as Xcode sets code")
    }
}

/// The gaps between blocks, as `placed` decides them and as a `Text` then draws them.
final class ReadingRhythmTests: XCTestCase {
    private func gaps(_ markdown: String, size: CGFloat = 15) -> [CGFloat] {
        MarkdownView.placed(MarkdownDocument.blocks(markdown), size: size, lineSpacing: 4).map(\.gap)
    }

    /// A list's items sit close; the list sits a paragraph from the prose either side; a heading takes its room above
    /// whatever it follows and little below.
    func testAListIsOneBlockAndAHeadingBelongsToWhatFollows() {
        let placed = gaps("Intro.\n\n- one\n- two\n\nAfter.\n\n```\ncode\n```\n\n### Next\n\n- item")
        // intro, one, two, [after], code, [### Next], item
        let ems: [CGFloat] = [0, 1.2, 0.4, 1.2, 1.2, 1.45, 0.6]
        XCTAssertEqual(placed, ems.map { $0 * 15 })
        XCTAssertLessThan(ConchReading.itemGap, ConchReading.paragraphGap / 2)
        XCTAssertLessThan(ConchReading.headingGapBelow, ConchReading.paragraphGap)
        for level in 1...4 { XCTAssertGreaterThan(ConchReading.headingGapAbove(level: level), ConchReading.paragraphGap) }
    }

    /// What a `Text` draws for those decisions, at the Mac transcript's leading: the blank line inside one text comes to
    /// the same gap as the room between two views.
    @MainActor
    func testTheDrawnGapsAreTheTokens() {
        func gap(_ first: String, _ second: String) -> CGFloat {
            MarkdownRender.height(first + "\n\n" + second, width: 664) - MarkdownRender.height(first, width: 664)
                - MarkdownRender.height(second, width: 664)
        }
        let size = ConchType.readingBodySize
        let cases: [(String, CGFloat, CGFloat)] = [
            ("paragraph to paragraph", gap("Line one", "Line two"), ConchReading.paragraphGap),
            ("item to item", gap("- Line one", "- Line two"), ConchReading.itemGap),
            ("paragraph to list", gap("Line one", "- Line two"), ConchReading.paragraphGap),
            ("list to paragraph", gap("- Line one", "Line two"), ConchReading.paragraphGap),
            ("paragraph to heading", gap("Line one", "## Heading"), ConchReading.headingGapAbove(level: 2)),
            ("list to heading", gap("- Line one", "## Heading"), ConchReading.headingGapAbove(level: 2)),
            ("heading to paragraph", gap("## Heading", "Line two"), ConchReading.headingGapBelow),
            ("heading to list", gap("### Heading", "- Line two"), ConchReading.headingGapBelow),
        ]
        for (name, drawn, ems) in cases {
            print("\(name): \(drawn) pt, token \(ems * size)")
            XCTAssertEqual(drawn, ems * size, accuracy: 1.5, name)
        }
    }
}

/// Text in the transcript's own colours holds 4.5:1 where it is drawn.
final class ReadingContrastTests: XCTestCase {
    private let schemes: [ColorScheme] = [.light, .dark]

    /// A diff's counts and lines are text: the lab's add and delete colours hold 4.5:1 on every ground, where the brand
    /// cyan they replace measured 1.94:1 on the white stage.
    func testTheDiffColoursReadOnEveryGround() {
        for scheme in schemes {
            for token in [ConchColor.added, ConchColor.removed] {
                for ground in ConchColor.grounds {
                    let ratio = token.rgba(scheme).contrast(on: ground.rgba(scheme))
                    XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(token.name) on \(ground.name), \(scheme): \(ratio)")
                }
            }
        }
        XCTAssertLessThan(ConchRGBA(0x58C9D4).contrast(on: ConchColor.surface.light), 2, "the cyan it replaces")
    }

    /// Code sits on the quiet fill, a table's header and your own turn too: what is set on it (the body's ink, and the
    /// secondary ink of a list's markers) still reads there.
    func testTextReadsOnTheCodeGround() {
        for scheme in schemes {
            for ground in [ConchColor.surface, ConchColor.ground] {
                let fill = ConchColor.fill.rgba(scheme).over(ground.rgba(scheme))
                for text in [ConchColor.textPrimary, ConchColor.textSecondary] {
                    let ratio = text.rgba(scheme).contrast(on: fill)
                    XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(text.name) on fill over \(ground.name), \(scheme): \(ratio)")
                }
            }
        }
    }
}

/// The panel's turns: a message's own paragraphs closer than the next message, and its lines given room.
final class PanelRhythmTests: XCTestCase {
    /// The room a paragraph break takes inside a turn, drawn, against the gap between turns.
    @MainActor
    func testAParagraphBreakIsNarrowerThanTheGapBetweenTurns() {
        for (latest, font) in [(false, ConchType.conversationPast), (true, ConchType.conversationNow)] {
            let size = ConversationFog.size(latest: latest, fullScreen: false)
            let leading = size * (latest ? ConversationFog.newestLeading : ConversationFog.pastLeading)
            func height(_ text: String) -> CGFloat {
                let view = Text(ConversationFog.typeset(ConversationFog.inlineMarkdown(text), size: size)).font(font).lineSpacing(leading)
                return MarkdownRender.height(of: view, width: 620)
            }
            let paragraphBreak = height("One.\n\nTwo.") - 2 * height("One.")
            print("latest \(latest): a paragraph break \(paragraphBreak) pt, between turns \(ConversationFog.turnGap)")
            XCTAssertLessThan(paragraphBreak, ConversationFog.turnGap - 4)
            XCTAssertGreaterThan(paragraphBreak, leading + 4, "still a break, not a line")
        }
    }

    /// Past turns set at 1.35 to 1.5, not solid; the newest reply's large type as the reply line sets it.
    @MainActor
    func testPastTurnsHaveReadingLeading() {
        let size = ConversationFog.size(latest: false, fullScreen: false)
        func height(_ text: String) -> CGFloat {
            MarkdownRender.height(of: Text(text).font(ConchType.conversationPast).lineSpacing(size * ConversationFog.pastLeading), width: 620)
        }
        let pitch = height("One\nTwo") - height("One")
        XCTAssertGreaterThanOrEqual(pitch / size, 1.35)
        XCTAssertLessThanOrEqual(pitch / size, 1.5)
        XCTAssertEqual(ConversationFog.newestLeading * ConversationFog.replyFontSize(fullScreen: false), 2.4, accuracy: 0.01,
                       "the newest reply leads as the reply line does (`InlineReplyLine`: 0.1 of its size)")
    }

    /// Setting a turn changes attributes only: the words, and so where the reveal finds each one, are the same.
    func testTypesettingKeepsTheWords() {
        let source = ConversationFog.inlineMarkdown("First **one**.\n\n\nThen `code` and\nmore.")
        let set = ConversationFog.typeset(source, size: 17)
        XCTAssertEqual(String(set.characters), String(source.characters))
        XCTAssertEqual(ConversationFog.wordStarts(set).count, ConversationFog.wordStarts(source).count)
        let blank = set.runs.first { String(set[$0.range].characters).allSatisfy { $0 == "\n" } && set[$0.range].characters.count > 1 }
        XCTAssertEqual(blank?.font, .system(size: 17 * ConversationFog.paragraphBreak))
        let code = set.runs.first { $0.inlinePresentationIntent?.contains(.code) == true }
        XCTAssertEqual(code?.font, .system(size: 17 * ConchReading.codeScale, design: .monospaced))
    }
}

/// Heights of what the transcript draws, at a width, as SwiftUI lays them out.
@MainActor
enum MarkdownRender {
    static func height(of view: some View, width: CGFloat) -> CGFloat {
        let renderer = ImageRenderer(content: view.frame(width: width).fixedSize(horizontal: false, vertical: true))
        renderer.scale = 4
        guard let image = renderer.cgImage else { return 0 }
        return CGFloat(image.height) / 4
    }

    /// A reply as the Mac's transcript draws it: at the reading size and leading.
    static func height(_ markdown: String, width: CGFloat) -> CGFloat {
        height(of: MarkdownView(text: markdown).lineSpacing(ConchType.readingLineSpacing), width: width)
    }

    /// The same words as one plain text, with no measure.
    static func textHeight(_ text: String, width: CGFloat) -> CGFloat {
        height(of: Text(text).font(.system(size: ConchType.readingBodySize)).lineSpacing(ConchType.readingLineSpacing), width: width)
    }
}
