import XCTest
@testable import ConchDesign
#if canImport(AppKit)
import AppKit
#endif

/// An Atlas page's wiki links, as conch renders them and as a click reads them back (`AtlasLink`), and the headings a
/// `#anchor` link lands on (`MarkdownAnchor`). The case is Tyler's: "← Back to [[projects/index|Projects]]" at the foot of
/// a project page drew its brackets as text, and nothing happened when it was clicked.
final class AtlasLinkTests: XCTestCase {
    private func links(_ text: String) -> [(words: String, link: String)] {
        let parsed = MarkdownDocument.inline(text)
        return parsed.runs.compactMap { run in
            run.link.map { (String(parsed[run.range].characters), $0.absoluteString) }
        }
    }

    func testAWikiLinkIsALinkToItsPageWithItsLabelAsTheWords() {
        let found = links("← Back to [[projects/index|Projects]]")
        XCTAssertEqual(found.map(\.words), ["Projects"])
        XCTAssertEqual(found.map(\.link), ["atlas:projects/index"])
        XCTAssertEqual(String(MarkdownDocument.inline("← Back to [[projects/index|Projects]]").characters), "← Back to Projects")
    }

    func testAWikiLinkWithNoLabelReadsAsItsPathAndItsHeadingIsAnAnchor() {
        XCTAssertEqual(links("see [[projects/acme/plan]]").map(\.words), ["projects/acme/plan"])
        // Foundation escapes the `#` of an opaque URL; the click reads it back either way.
        let heading = links("see [[projects/acme/plan#Next Steps|the next steps]]")
        XCTAssertEqual(heading.map(\.words), ["the next steps"])
        XCTAssertEqual(heading.compactMap { AtlasLink.page(of: $0.link) }, [AtlasLink.Page(path: "projects/acme/plan", heading: "next-steps")])
        // Several on one line, and the prose between them kept.
        XCTAssertEqual(
            AtlasLink.linkingWikiLinks("[[a/b|B]] and [[c/d.md]], then more"),
            "[B](atlas:a/b) and [c/d.md](atlas:c/d.md), then more"
        )
    }

    func testCodeAndNonPathsStayAsWritten() {
        XCTAssertEqual(AtlasLink.linkingWikiLinks("write `[[projects/index|Projects]]` to link"), "write `[[projects/index|Projects]]` to link")
        XCTAssertEqual(AtlasLink.linkingWikiLinks("``a [[x/y]] b`` and [[x/y]]"), "``a [[x/y]] b`` and [x/y](atlas:x/y)")
        // No copy could be saved under any of these, so they are not made into links to one.
        for text in ["[[two words]]", "[[../../.ssh/id_rsa]]", "[[.hidden/page]]", "[[]]", "[[a|]]"] {
            XCTAssertEqual(AtlasLink.linkingWikiLinks(text), text, text)
        }
        // Ordinary links are left alone, whatever their kind.
        let ordinary = "[up](../other.md), [top](#status) and [site](https://example.com)"
        XCTAssertEqual(AtlasLink.linkingWikiLinks(ordinary), ordinary)
        XCTAssertEqual(links(ordinary).map(\.link), ["../other.md", "#status", "https://example.com"])
    }

    func testAClickedLinkNamesItsPageAndItsCopy() {
        let folder = URL(fileURLWithPath: "/Users/someone/Documents/conch-notes/atlas", isDirectory: true)
        let index = AtlasLink.page(of: "atlas:projects/index")
        XCTAssertEqual(index, AtlasLink.Page(path: "projects/index"))
        XCTAssertEqual(index?.copy(in: folder).path, "/Users/someone/Documents/conch-notes/atlas/projects/index.md")
        // `.md` written or not, it is one copy: atlas_show adds the extension only when the path has none.
        XCTAssertEqual(AtlasLink.page(of: "atlas:projects/index.md")?.copy(in: folder), index?.copy(in: folder))
        XCTAssertEqual(AtlasLink.page(of: "atlas:projects/acme/plan#next-steps"), AtlasLink.Page(path: "projects/acme/plan", heading: "next-steps"))
        XCTAssertEqual(AtlasLink.page(of: "atlas:projects/index.md")?.name, "projects/index")
        // Nothing else is an Atlas link, and no path can leave the folder.
        for other in ["https://example.com", "#status", "../other.md", "atlas:../../etc/passwd", "atlas:projects/.git/config", "atlas:"] {
            XCTAssertNil(AtlasLink.page(of: other), other)
        }
    }

    func testACopyKnowsWhichPageItIs() {
        let folder = URL(fileURLWithPath: "/Users/someone/Documents/conch-notes/atlas", isDirectory: true)
        XCTAssertEqual(AtlasLink.path(ofCopy: folder.appendingPathComponent("projects/evals/overview.md"), in: folder), "projects/evals/overview.md")
        XCTAssertNil(AtlasLink.path(ofCopy: URL(fileURLWithPath: "/tmp/overview.md"), in: folder))
        XCTAssertNil(AtlasLink.path(ofCopy: URL(fileURLWithPath: "/Users/someone/Documents/conch-notes/atlas-old/x.md"), in: folder))
    }

    func testAnAnchorIsTheHeadingsWordsAsGitHubWritesThem() {
        XCTAssertEqual(MarkdownAnchor.slug("Headline findings"), "headline-findings")
        XCTAssertEqual(MarkdownAnchor.slug("What's next? (Q4, 2026)"), "whats-next-q4-2026")
        XCTAssertEqual(MarkdownAnchor.slug("Dev Log"), "dev-log")
        XCTAssertEqual(MarkdownAnchor.target(of: URL(string: "#dev-log")!), "dev-log")
        XCTAssertEqual(MarkdownAnchor.target(of: "#dev-log"), "dev-log")
        // A link to another document, or to a heading in another document, is not this document's anchor.
        XCTAssertNil(MarkdownAnchor.target(of: URL(string: "other.md#dev-log")!))
        XCTAssertNil(MarkdownAnchor.target(of: URL(string: "https://example.com/#dev-log")!))
        XCTAssertNil(MarkdownAnchor.target(of: URL(string: "atlas:projects/index")!))
    }

    #if canImport(AppKit)
    /// The deliverable pane's document carries each heading's anchor, numbered when the words repeat, so a link to one can
    /// be scrolled to; and its wiki links are links with their labels as the words.
    func testTheTypesetterMarksHeadingsAndLinksWikiLinks() {
        let document = """
        # Overview

        Some prose, and [[projects/index|Projects]].

        ## Notes

        ## Notes

        ## **Bold** heading
        """
        let typeset = MarkdownTypesetter.attributedString(document, base: [.font: NSFont.systemFont(ofSize: 14)])
        var anchors: [String] = []
        typeset.enumerateAttribute(MarkdownTypesetter.anchorKey, in: NSRange(location: 0, length: typeset.length)) { value, _, _ in
            if let anchor = value as? String { anchors.append(anchor) }
        }
        XCTAssertEqual(anchors, ["overview", "notes", "notes-1", "bold-heading"])
        XCTAssertFalse(typeset.string.contains("[["))
        XCTAssertTrue(typeset.string.contains("Some prose, and Projects."))
        var link: Any?
        typeset.enumerateAttribute(.link, in: NSRange(location: 0, length: typeset.length)) { value, _, _ in
            if let value { link = value }
        }
        XCTAssertEqual((link as? URL)?.absoluteString, "atlas:projects/index")
    }
    #endif
}

/// What an Atlas page carries for its editors, not its readers.
final class AtlasPageRenderingTests: XCTestCase {
    func testAnHTMLCommentIsNotProse() {
        let page = """
        # Projects

        ## Notes

        <!-- Manual notes section; preserved across any future regenerations -->
        Kept.

        <!--
        a note over
        two lines
        -->
        Also kept.
        """
        let blocks = MarkdownDocument.blocks(MarkdownSoftBreaks.joined(page))
        XCTAssertEqual(blocks, [.heading(1, "Projects"), .heading(2, "Notes"), .paragraph("Kept."), .paragraph("Also kept.")])
        // In code it is code.
        XCTAssertEqual(MarkdownDocument.blocks("```\n<!-- shown -->\n```"), [.code("<!-- shown -->")])
    }

    func testAPagesTitleIsItsFirstTopLevelHeading() {
        XCTAssertEqual(AtlasLink.title(of: "---\ntype: project\n---\n\n# AI Benchmarks and **Evals**\n\n## Status\n"), "AI Benchmarks and Evals")
        XCTAssertNil(AtlasLink.title(of: "## Only a section\n\nprose"))
    }
}
