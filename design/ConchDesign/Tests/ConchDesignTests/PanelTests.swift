import XCTest
@testable import ConchDesign

/// The panel's inks, which outlive its glass (2026-11-11).
final class PanelContrastTests: XCTestCase {
    /// The secondary ink is the dashboard's, so "You" and a heading read the same in the panel as in the window.
    func testTheSecondaryInkIsTheDashboards() {
        XCTAssertEqual(ConchColor.overlayTextSecondary.light, ConchColor.textSecondary.light)
        XCTAssertEqual(ConchColor.overlayTextSecondary.light.hexString, "#5C5C61")
    }
}

/// The motion panel-lab tuned (its `DEF`), in ConchMotion's own terms. The panel went (2026-11-11); setup and the window
/// still move on these.
final class PanelMotionTests: XCTestCase {
    func testTheCrossfadeAndThePopoverAreTheLabs() {
        // crossBlur 4, crossShift 8, on the pop spring.
        XCTAssertEqual(ConchMotion.crossBlur, 4)
        XCTAssertEqual(ConchMotion.crossShift, 8)
        // #switcher: translateY 6; rows 18 ms apart.
        XCTAssertEqual(ConchMotion.popShift, 6)
        XCTAssertEqual(ConchMotion.popStagger, 0.018)
        XCTAssertEqual(ConchMotion.pop, ConchSpring(bounce: 0.34, response: 0.36))
    }

    /// Content after a morph: 120 ms after it lands, on 0.1 / 0.42.
    func testTheRevealAfterAMorphIsTheLabs() {
        XCTAssertEqual(ConchMotion.reveal, ConchSpring(bounce: 0.1, response: 0.42))
        XCTAssertEqual(ConchMotion.revealDelay, 0.12)
        XCTAssertEqual(ConchMotion.morph, ConchSpring(bounce: 0.12, response: 0.46))
    }

    /// The springs the panel used to spell out by hand are named, and listed with the rest.
    func testTheHandWrittenSpringsAreTokens() {
        XCTAssertEqual(ConchMotion.liftOff, ConchSpring(bounce: 0, response: 0.2))
        XCTAssertEqual(ConchMotion.hover, ConchSpring(bounce: 0, response: 0.3))
        let names = ConchMotion.springs.map(\.name)
        for name in ["liftOff", "hover", "reveal"] { XCTAssertTrue(names.contains(name), name) }
        // Reduce Motion drops their overshoot like any other.
        XCTAssertEqual(ConchMotion.reveal.resolved(reduceMotion: true).bounce, 0)
    }
}
