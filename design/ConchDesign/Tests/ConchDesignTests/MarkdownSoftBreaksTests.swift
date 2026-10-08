import XCTest
@testable import ConchDesign

final class MarkdownSoftBreaksTests: XCTestCase {
    /// The README's opening, wrapped at 120 columns, read as one paragraph (2026-10-09).
    func testAWrappedParagraphIsOneParagraph() {
        let text = "conch is an agent manager. Every session you have running shows up in one\nwindow. Each one shows you its work.\n\nNext paragraph."
        XCTAssertEqual(MarkdownSoftBreaks.joined(text), "conch is an agent manager. Every session you have running shows up in one window. Each one shows you its work.\n\nNext paragraph.")
        let blocks = MarkdownDocument.blocks(MarkdownSoftBreaks.joined(text))
        XCTAssertEqual(blocks.count, 2)
    }

    func testAWrappedListItemContinuesIndentedOrLazy() {
        let text = "- **Codex accounts.** Settings lists your ChatGPT accounts next to\n  your Claude accounts.\n- Second item wraps\nlazily here.\n1. Ordered item\n   continues."
        XCTAssertEqual(MarkdownSoftBreaks.joined(text), "- **Codex accounts.** Settings lists your ChatGPT accounts next to your Claude accounts.\n- Second item wraps lazily here.\n1. Ordered item continues.")
    }

    func testHardBreaksCodeTablesQuotesAndHeadingsStay() {
        let hard = "Line one  \nline two\\\nline three"
        XCTAssertEqual(MarkdownSoftBreaks.joined(hard), "Line one  \nline two\nline three")
        let code = "Before\n```\nlet a = 1\nlet b = 2\n```\nAfter"
        XCTAssertEqual(MarkdownSoftBreaks.joined(code), code)
        let table = "| a | b |\n| - | - |\n| 1 | 2 |"
        XCTAssertEqual(MarkdownSoftBreaks.joined(table), table)
        let mixed = "# Title\nText under it\n> quoted\n> more\n---\nafter rule"
        XCTAssertEqual(MarkdownSoftBreaks.joined(mixed), mixed)
    }

    func testFrontmatterPassesThrough() {
        let text = "---\ntitle: Notes\nauthor: acme\n---\nBody wraps\nhere."
        XCTAssertEqual(MarkdownSoftBreaks.joined(text), "---\ntitle: Notes\nauthor: acme\n---\nBody wraps here.")
    }
}
