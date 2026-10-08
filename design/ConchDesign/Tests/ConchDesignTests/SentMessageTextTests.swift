import XCTest
@testable import ConchDesign

final class SentMessageTextTests: XCTestCase {
    private func squash(_ text: String) -> String {
        SentMessageText.withoutImages(text).split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// 2026-10-09: a dropped screenshot sent as its path came back from Claude Code as `[Image #10]`.
    func testADroppedImagesPathAndClaudesPlaceholderBothDrop() {
        let sent = "/var/folders/hj/cg29fnq929v27cj88gsnrskr0000gn/T/conch-drop-A1ED45E8-83EF-40A2-BF8B-D91D94A274F6.png\noh geeze i found another error"
        let transcript = "[Image #10]oh geeze i found another error"
        XCTAssertEqual(squash(sent), "oh geeze i found another error")
        XCTAssertEqual(squash(transcript), squash(sent))
        // And the daemon's words, with the stand-in already gone, read the same.
        XCTAssertEqual(squash("oh geeze i found another error"), squash(sent))
    }

    func testAFileURLAndSeveralImagesCount() {
        XCTAssertEqual(squash("file:///Users/a/Shot%201.PNG and /tmp/b.jpeg look"), "and look")
        XCTAssertEqual(squash("[Image #1] [Image #2] look"), "look")
    }

    func testWordsThatOnlyLookLikePathsStay() {
        XCTAssertEqual(squash("see src/app.png.ts and /usr/bin/env"), "see src/app.png.ts and /usr/bin/env")
        XCTAssertEqual(squash("a relative docs/shot.png stays"), "a relative docs/shot.png stays")
        XCTAssertEqual(squash("no images here"), "no images here")
    }
}
