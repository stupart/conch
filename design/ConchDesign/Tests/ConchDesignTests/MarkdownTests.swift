import SwiftUI
import XCTest
@testable import ConchDesign
#if canImport(AppKit)
import AppKit
#endif

/// The markdown renderer against the document Tyler complained about — atlas deep-review/mvps-and-backend-primitives.md
/// (2026-09-20: frontmatter, 10 headings, 54 table lines, a numbered list) and its sibling migration-plan.md (code
/// fences) — and the failure modes the old renderers' comments named.
final class MarkdownTests: XCTestCase {
    static func fixture(_ name: String) -> String {
        let url = Bundle.module.url(forResource: name, withExtension: "md", subdirectory: "Fixtures")!
        return try! String(contentsOf: url, encoding: .utf8)
    }
    static let corpus = fixture("mvps-and-backend-primitives")
    static let plan = fixture("migration-plan")

    static func tables(_ blocks: [MarkdownBlock]) -> [[[String]]] {
        blocks.compactMap { if case let .table(rows) = $0 { rows } else { nil } }
    }

    // MARK: The document

    func testTheDocumentKeepsItsShape() {
        let blocks = MarkdownDocument.blocks(Self.corpus)
        // The frontmatter is gone and the title is a title, not "type: document" as an opening sentence.
        XCTAssertEqual(blocks.first, .heading(1, "Atlas MVPs and backend primitives"))
        XCTAssertFalse(blocks.contains { if case let .paragraph(text) = $0 { text.contains("type: document") } else { false } })
        let headings = blocks.compactMap { if case let .heading(level, _) = $0 { level } else { nil } }
        XCTAssertEqual(headings, [1] + Array(repeating: 2, count: 9))
        // Five tables, 54 pipe lines less the five alignment rows, every row as wide as its header.
        let tables = Self.tables(blocks)
        XCTAssertEqual(tables.map(\.count), [7, 9, 14, 4, 15])
        for rows in tables { XCTAssertTrue(rows.allSatisfy { $0.count == rows[0].count }, "a ragged table") }
        XCTAssertEqual(tables[1][0], ["Concern", "MediaWiki / Wikipedia software", "Mastodon, as a concrete social backend", "Proposed Atlas"])
        XCTAssertEqual(tables[4][14][0], "Migration")
        // The four acceptance details, numbered.
        XCTAssertEqual(blocks.compactMap { if case let .ordered(_, ordinal, _) = $0 { ordinal } else { nil } }, [1, 2, 3, 4])
        // No block shows its source.
        for case let .paragraph(text) in blocks {
            XCTAssertFalse(text.hasPrefix("|") || text.hasPrefix("#") || text == "---", text)
        }
    }

    func testTheSiblingKeepsItsFences() {
        let blocks = MarkdownDocument.blocks(Self.plan)
        XCTAssertEqual(blocks.first, .heading(1, "Module and migration plan"))
        let code = blocks.compactMap { if case let .code(text) = $0 { text } else { nil } }
        XCTAssertEqual(code.count, 1)
        XCTAssertTrue(code[0].hasPrefix("Atlas repository (incremental target)\n  apps/web/"), "the fence's own newlines and indent stay")
        XCTAssertEqual(Self.tables(blocks).count, 2)
    }

    // MARK: Frontmatter

    func testFrontmatterIsStrippedOnlyWhenTheDocumentOpensWithAClosedFence() {
        XCTAssertEqual(MarkdownDocument.stripFrontmatter("---\ntype: document\n---\n\n# Title"), "\n# Title")
        // A rule in prose is a rule: it does not open at the top, so nothing is taken.
        let prose = "Before.\n\n---\n\nAfter."
        XCTAssertEqual(MarkdownDocument.stripFrontmatter(prose), prose)
        XCTAssertEqual(MarkdownDocument.blocks(prose), [.paragraph("Before."), .rule, .paragraph("After.")])
        // Opened and never closed: left alone rather than eating the whole reply.
        let open = "---\nnot yaml, no close"
        XCTAssertEqual(MarkdownDocument.stripFrontmatter(open), open)
        XCTAssertEqual(MarkdownDocument.stripFrontmatter("---"), "---")
    }

    // MARK: The failure modes the old renderers named

    func testAListIsItsItemsNotOnetwothree() {
        // "the block parse (`.full`) drops every newline, so a three-item list arrives as onetwothree".
        XCTAssertEqual(MarkdownDocument.blocks("- one\n- two\n- three"), [.bullet(depth: 0, "one"), .bullet(depth: 0, "two"), .bullet(depth: 0, "three")])
        XCTAssertEqual(
            MarkdownDocument.blocks("1. a\n2) b\n   - under b\n\t\t- deeper"),
            [.ordered(depth: 0, ordinal: 1, "a"), .ordered(depth: 0, ordinal: 2, "b"), .bullet(depth: 1, "under b"), .bullet(depth: 2, "deeper")]
        )
        // Consecutive prose lines are lines, as the Mac's inline parse always showed them (14 of 78 live replies).
        XCTAssertEqual(MarkdownDocument.blocks("Task name: x\nSender: y"), [.paragraph("Task name: x\nSender: y")])
        // A quote spanning lines is one quote, on one rule.
        XCTAssertEqual(MarkdownDocument.blocks("> a\n> b\n\n> c"), [.quote("a\nb"), .quote("c")])
    }

    func testATableIsRowsOfCells() {
        let blocks = MarkdownDocument.blocks("Intro\n| a | b |\n|---|:-:|\n| 1 | x \\| y |\n| only |\n\nAfter")
        XCTAssertEqual(blocks, [
            .paragraph("Intro"),
            .table([["a", "b"], ["1", "x | y"], ["only", ""]]),
            .paragraph("After"),
        ])
    }

    func testBlockMarkersNeedTheirSpace() {
        XCTAssertEqual(MarkdownDocument.blocks("#hashtag and 2.5 things"), [.paragraph("#hashtag and 2.5 things")])
        XCTAssertEqual(MarkdownDocument.blocks("### Three"), [.heading(3, "Three")])
        XCTAssertEqual(MarkdownDocument.blocks("####### seven"), [.paragraph("####### seven")])
    }

    func testInlineEmphasisSurvivesInsideEveryBlock() {
        let cell = MarkdownDocument.inline("see [docs](https://example.com) and **this**")
        XCTAssertEqual(String(cell.characters), "see docs and this")
        XCTAssertTrue(cell.runs.contains { $0.link != nil && $0.underlineStyle == .single }, "a link is underlined")
        XCTAssertTrue(cell.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        // The fog keeps its inline parse, with the same frontmatter rule in front of it.
        XCTAssertEqual(ConversationFog.plain("---\ntype: document\n---\n## Title"), "Title")
    }

    // MARK: SwiftUI

    @MainActor
    func testTheViewRendersTheDocument() {
        let renderer = ImageRenderer(content: MarkdownView(text: Self.corpus).frame(width: 700))
        renderer.scale = 1
        let image = renderer.cgImage
        XCTAssertNotNil(image)
        // Wrapped cells and a type scale: a 155-line document with five tables stands well over a screen tall at the
        // 700 pt measure, and a renderer that dropped the tables' rows would be far shorter.
        XCTAssertGreaterThan(image?.height ?? 0, 4000)
    }

    // MARK: AppKit

    #if canImport(AppKit)
    static let base: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 16), .foregroundColor: NSColor.black, .paragraphStyle: NSParagraphStyle(),
    ]

    /// Every cell of every table is in an `NSTextTable`, and TextKit lays the cells of a row side by side on one line —
    /// which is what "aligned columns" means, and what no Mac renderer did before (the fallback tab-stopped cells at
    /// 118 pt; the stack flattened rows to "first — rest · rest").
    func testTheTypesetterLaysTablesOutAsColumns() {
        let typeset = MarkdownTypesetter.attributedString(Self.corpus, base: Self.base)
        var cells: [(NSTextTableBlock, NSRange)] = []
        typeset.enumerateAttribute(.paragraphStyle, in: NSRange(location: 0, length: typeset.length)) { value, range, _ in
            if let block = (value as? NSParagraphStyle)?.textBlocks.first as? NSTextTableBlock { cells.append((block, range)) }
        }
        let tables = Set(cells.map { ObjectIdentifier($0.0.table) })
        XCTAssertEqual(tables.count, 5)
        XCTAssertEqual(cells.count, 7 * 3 + 9 * 4 + 14 * 3 + 4 * 3 + 15 * 3, "one cell per table cell")

        // Lay it out at the transcript's 700 pt measure and read the geometry back.
        let storage = NSTextStorage(attributedString: typeset)
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: 700, height: CGFloat.greatestFiniteMagnitude))
        storage.addLayoutManager(layout)
        layout.addTextContainer(container)
        layout.ensureLayout(for: container)
        func rect(_ range: NSRange) -> CGRect {
            layout.boundingRect(forGlyphRange: layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil), in: container)
        }
        let first = cells.filter { ObjectIdentifier($0.0.table) == ObjectIdentifier(cells[0].0.table) }
        let rows = Dictionary(grouping: first, by: { $0.0.startingRow })
        XCTAssertEqual(rows.count, 7)
        for (_, row) in rows {
            let tops = Set(row.map { rect($0.1).minY.rounded() })
            XCTAssertEqual(tops.count, 1, "the cells of a row start on one line")
            let lefts = row.sorted { $0.0.startingColumn < $1.0.startingColumn }.map { rect($0.1).minX }
            XCTAssertEqual(lefts, lefts.sorted(), "columns run left to right")
            XCTAssertEqual(Set(lefts).count, 3, "three distinct columns")
        }
        // Each column's left edge is the same in every row.
        for column in 0..<3 {
            XCTAssertEqual(Set(first.filter { $0.0.startingColumn == column }.map { rect($0.1).minX.rounded() }).count, 1)
        }
        // Nothing in the string is table syntax any more.
        XCTAssertFalse(typeset.string.contains("| ---"))
        XCTAssertFalse(typeset.string.contains("type: document"))
    }

    func testTheTypesetterScalesHeadingsAndSetsCodeInMono() {
        let typeset = MarkdownTypesetter.attributedString("# One\n\n## Two\n\nBody with `code`.\n\n```\nlet x = 1\n```\n\n- item", base: Self.base)
        func font(at text: String) -> NSFont {
            let location = (typeset.string as NSString).range(of: text).location
            return typeset.attribute(.font, at: location, effectiveRange: nil) as! NSFont
        }
        XCTAssertEqual(font(at: "One").pointSize, 16 * 1.6, accuracy: 0.01)
        XCTAssertEqual(font(at: "Two").pointSize, 16 * 1.35, accuracy: 0.01)
        XCTAssertTrue(font(at: "One").fontDescriptor.symbolicTraits.contains(.bold))
        XCTAssertEqual(font(at: "Body").pointSize, 16)
        XCTAssertTrue(font(at: "code").isFixedPitch)
        XCTAssertTrue(font(at: "let x").isFixedPitch)
        // A list item hangs its wrapped lines under its own text, not under the bullet.
        let item = typeset.attribute(.paragraphStyle, at: (typeset.string as NSString).range(of: "item").location, effectiveRange: nil) as! NSParagraphStyle
        XCTAssertGreaterThan(item.headIndent, item.firstLineHeadIndent)
        XCTAssertTrue(typeset.string.contains("•\titem"))
    }
    #endif
}
