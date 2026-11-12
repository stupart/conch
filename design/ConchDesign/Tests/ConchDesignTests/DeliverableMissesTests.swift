import XCTest
@testable import ConchDesign

/// Which deliverables the review pane couldn't show are filed as a failure (2026-11-11). Paths here are made up.
final class DeliverableMissesTests: XCTestCase {
    private let home = "/Users/someone"
    private var copy: String { "\(home)/Library/Application Support/conch/deliverables/0123abcd/v1-xyz/shot.png" }

    func testOnlyConchsOwnCopiesAreFiledWhenMissingAndEachOnce() {
        var misses = DeliverableMisses()
        XCTAssertTrue(misses.fileMissing(sessionId: "s1", path: copy, home: home))
        XCTAssertFalse(misses.fileMissing(sessionId: "s1", path: copy, home: home), "shown again: said again, not filed again")
        XCTAssertTrue(misses.fileMissing(sessionId: "s2", path: copy, home: home), "another session's is its own")
        // A file gone from a project folder (a removed worktree, say) is the pane's to say, not a failure of conch's.
        XCTAssertFalse(misses.fileMissing(sessionId: "s1", path: "\(home)/work/.worktrees/done/notes.md", home: home))
    }

    func testTheStoreItselfAndLookAlikesAreNotCopies() {
        XCTAssertFalse(DeliverableMisses.isConchCopy("\(home)/Library/Application Support/conch/deliverables", home: home))
        XCTAssertFalse(DeliverableMisses.isConchCopy("\(home)/Library/Application Support/conch/deliverables-old/a/b", home: home))
        XCTAssertFalse(DeliverableMisses.isConchCopy("\(home)/Library/Application Support/conch/deliverables/../captures/x.png", home: home))
        XCTAssertTrue(DeliverableMisses.isConchCopy(copy, home: home))
    }

    func testALoadThatFailedIsFiledWhereverItIsOnceForEachReason() {
        var misses = DeliverableMisses()
        XCTAssertTrue(misses.fileLoadFailure(sessionId: "s1", path: "\(home)/work/clip.webm", reason: "Cannot Open"))
        XCTAssertFalse(misses.fileLoadFailure(sessionId: "s1", path: "\(home)/work/clip.webm", reason: "Cannot Open"))
        XCTAssertTrue(misses.fileLoadFailure(sessionId: "s1", path: "\(home)/work/clip.webm", reason: "The file is damaged"))
    }
}
