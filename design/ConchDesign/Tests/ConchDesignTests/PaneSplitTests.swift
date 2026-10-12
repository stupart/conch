import CoreGraphics
import XCTest
@testable import ConchDesign

/// The deliverable pane's resizable splits: the file tree beside the file picked in it, and two versions side by side.
/// How far each side goes, where a drag lands, what a double-click puts back, and what is remembered.
final class PaneSplitTests: XCTestCase {
    private let tree = PaneSplit.fileTree
    private let compare = PaneFraction.compare

    func testTheTreeOpensAt232AndKeepsBothSidesReadable() {
        XCTAssertEqual(tree.standard, 232)
        XCTAssertEqual(tree.width(232, in: 1000), 232)
        // Never narrower than its minimum, nor wider than its maximum…
        XCTAssertEqual(tree.width(100, in: 1000), 160)
        XCTAssertEqual(tree.width(900, in: 1400), 560)
        // …nor so wide the file beside it has under 240 points (less the hairline).
        XCTAssertEqual(tree.width(500, in: 600), 359)
        XCTAssertEqual(600 - 359 - PaneSplit.hairline, 240)
        // In a pane too narrow for both, the tree keeps its minimum.
        XCTAssertEqual(tree.width(300, in: 300), 160)
    }

    func testADragMovesTheStoredWidthAndLandsOnAWholePoint() {
        XCTAssertEqual(tree.width(232, dragged: 40.4, in: 1000), 272)
        XCTAssertEqual(tree.width(232, dragged: -40.6, in: 1000), 191)
        XCTAssertEqual(tree.width(232, dragged: -500, in: 1000), 160)
        XCTAssertEqual(tree.width(232, dragged: .infinity, in: 1000), 232)
        XCTAssertEqual(tree.width(232, dragged: 10, in: .infinity), 242)
    }

    func testWhatIsRememberedComesBackAndGarbageMeansTheStandardWidth() throws {
        XCTAssertEqual(tree.restored(300), 300)
        XCTAssertEqual(tree.restored(0), 232)
        XCTAssertEqual(tree.restored(-4), 232)
        XCTAssertEqual(tree.restored(.nan), 232)
        XCTAssertEqual(tree.restored(.infinity), 232)

        // Through UserDefaults, as @AppStorage keeps it: nothing yet reads as 0, which is the standard width.
        let suite = "conch.pane-split-tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(tree.width(defaults.double(forKey: tree.key), in: 1000), 232)
        defaults.set(Double(tree.width(232, dragged: 88, in: 1000)), forKey: tree.key)
        XCTAssertEqual(tree.width(defaults.double(forKey: tree.key), in: 1000), 320)
        // The comparison's share is its own, under its own key.
        XCTAssertNotEqual(tree.key, compare.key)
        defaults.set(0.62, forKey: compare.key)
        XCTAssertEqual(compare.fraction(defaults.double(forKey: compare.key), in: 1000), 0.62, accuracy: 1e-9)
    }

    func testTwoVersionsShareTheWidthByADraggedFractionEachKeepingItsMinimum() {
        XCTAssertEqual(compare.fraction(0.5, in: 1000), 0.5)
        XCTAssertEqual(compare.fraction(0.5, dragged: 100, in: 1000), 0.6, accuracy: 1e-9)
        XCTAssertEqual(compare.fraction(0.5, dragged: -400, in: 1000), 0.2, accuracy: 1e-9)
        XCTAssertEqual(compare.fraction(0.5, dragged: 400, in: 1000), 0.8, accuracy: 1e-9)
        // Too narrow for both minimums: halved.
        XCTAssertEqual(compare.fraction(0.7, in: 300), 0.5)
        // Garbage is half.
        XCTAssertEqual(compare.restored(1.4), 0.5)
        XCTAssertEqual(compare.restored(.nan), 0.5)
        // The before's width on a whole point.
        XCTAssertEqual(compare.leadingWidth(0.5, dragged: 33.3, in: 588), 327)
    }
}
