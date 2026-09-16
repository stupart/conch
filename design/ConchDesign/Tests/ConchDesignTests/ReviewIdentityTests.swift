import XCTest
@testable import ConchDesign

/// The identity both apps and the terminal key a deliverable on.
final class ReviewIdentityTests: XCTestCase {
    /// Exactly what the Mac's `ReviewItem` and the phone's `ReviewQueue` computed before the
    /// daemon minted anything. Written out longhand on purpose: this is the shape an older
    /// daemon still has to produce, so it is pinned here rather than derived from the code.
    private func legacy(_ sessionId: String, _ filedAt: Double?) -> String {
        [sessionId, filedAt.map { String($0.bitPattern) } ?? "undated"].joined(separator: "\u{1F}")
    }

    func testThePublishedIdentityWins() {
        XCTAssertEqual(
            ReviewIdentity.key(published: "[\"s1\",1000,\"abc\"]", sessionId: "s1", filedAt: 1_000),
            "[\"s1\",1000,\"abc\"]"
        )
    }

    /// An older daemon sends nothing, and its deliverables must keep the key the apps already
    /// use — otherwise everything on screen silently becomes a different deliverable.
    func testWithoutOneItIsByteIdenticalToWhatEachSurfaceComputedBefore() {
        for filedAt: Double? in [1_000, 0, 1_763_000_000_000, nil] {
            for published: String? in [nil, ""] {
                XCTAssertEqual(
                    ReviewIdentity.key(published: published, sessionId: "s1", filedAt: filedAt),
                    legacy("s1", filedAt),
                    "published=\(String(describing: published)) filedAt=\(String(describing: filedAt))"
                )
            }
        }
    }

    func testAnUndatedDeliverableStillHasAKey() {
        XCTAssertEqual(ReviewIdentity.key(published: nil, sessionId: "s1", filedAt: nil), "s1\u{1F}undated")
    }

    /// The reason the daemon mints one at all: the old key cannot tell two deliverables apart
    /// inside a millisecond, and filing two is not rare when an agent finishes a batch.
    func testTwoDeliverablesFiledInTheSameMillisecondAreTwoDeliverables() {
        let a = ReviewIdentity.key(published: "[\"s1\",1000,\"aaa\"]", sessionId: "s1", filedAt: 1_000)
        let b = ReviewIdentity.key(published: "[\"s1\",1000,\"bbb\"]", sessionId: "s1", filedAt: 1_000)
        XCTAssertNotEqual(a, b)
        // Without the minted identity they collide, which is the bug being removed.
        XCTAssertEqual(
            ReviewIdentity.key(published: nil, sessionId: "s1", filedAt: 1_000),
            ReviewIdentity.key(published: nil, sessionId: "s1", filedAt: 1_000)
        )
    }

    func testDifferentSessionsNeverShareAKey() {
        XCTAssertNotEqual(
            ReviewIdentity.key(published: nil, sessionId: "s1", filedAt: 1_000),
            ReviewIdentity.key(published: nil, sessionId: "s2", filedAt: 1_000)
        )
    }
}
