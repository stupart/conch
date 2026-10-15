import XCTest
@testable import ConchDesign

final class DeliverableLocationTests: XCTestCase {
    func testWebLinksAreCopiedAsTheyAre() {
        XCTAssertEqual(DeliverableLocation.of("https://example.com/a?b=1", cwd: "/w"), .web("https://example.com/a?b=1"))
        XCTAssertEqual(DeliverableLocation.of("http://localhost:3041/setup", cwd: nil), .web("http://localhost:3041/setup"))
        XCTAssertEqual(DeliverableLocation.of("figma://file/abc", cwd: "/w"), .web("figma://file/abc"))
    }

    func testFilesAreAbsolutePaths() {
        XCTAssertEqual(DeliverableLocation.of("/Users/alex/notes/plan.md", cwd: "/w"), .file("/Users/alex/notes/plan.md"))
        XCTAssertEqual(DeliverableLocation.of("file:///Users/alex/My%20Notes/plan.md", cwd: nil), .file("/Users/alex/My Notes/plan.md"))
        XCTAssertEqual(DeliverableLocation.of("~/notes/plan.md", cwd: nil, home: "/Users/alex"), .file("/Users/alex/notes/plan.md"))
        XCTAssertEqual(DeliverableLocation.of("docs/../README.md", cwd: "/Users/alex/repo"), .file("/Users/alex/repo/README.md"))
        XCTAssertEqual(DeliverableLocation.of("/Users/alex/repo/./out/", cwd: nil), .file("/Users/alex/repo/out"))
    }

    func testNothingToCopy() {
        XCTAssertNil(DeliverableLocation.of(nil, cwd: "/w"))
        XCTAssertNil(DeliverableLocation.of("   ", cwd: "/w"))
        XCTAssertNil(DeliverableLocation.of("relative/only.md", cwd: nil))
    }

    func testWhatIsCopied() {
        XCTAssertEqual(DeliverableLocation.file("/a/b").text, "/a/b")
        XCTAssertTrue(DeliverableLocation.file("/a/b").isFile)
        XCTAssertFalse(DeliverableLocation.web("https://x").isFile)
    }
}
