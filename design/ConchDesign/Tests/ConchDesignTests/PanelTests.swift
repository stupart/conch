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

/// What a deliverable on show follows.
final class PanelStateTests: XCTestCase {
    /// A deliverable on version 1 of an artifact moves to version 2 when it is published; another artifact arriving
    /// doesn't move it. The daemon's artifact decides, else the link. The panel's rule, which outlives it (2026-11-11).
    func testThePanelFollowsANewerVersionOfTheSameArtifactOnly() {
        let v1 = DeliverableVersion(id: "hero-1", link: "http://localhost:3111/prime", artifact: "prime")
        let other = DeliverableVersion(id: "icons-1", link: "https://figma.com/design/x", artifact: "icons")
        let v2 = DeliverableVersion(id: "hero-2", link: "http://localhost:3111/prime?v=2", artifact: "prime")
        XCTAssertEqual(DeliverableGroups.newest(of: "hero-1", in: [v1]), "hero-1")
        XCTAssertEqual(DeliverableGroups.newest(of: "hero-1", in: [v1, other]), "hero-1", "a different artifact doesn't move it")
        XCTAssertEqual(DeliverableGroups.newest(of: "hero-1", in: [v1, other, v2]), "hero-2")
        XCTAssertEqual(DeliverableGroups.newest(of: "icons-1", in: [v1, other, v2]), "icons-1")
        // An older daemon sends no artifact: the same link is the same thing.
        let old1 = DeliverableVersion(id: "a", link: "http://localhost:3111/prime"), old2 = DeliverableVersion(id: "b", link: "http://localhost:3111/prime")
        XCTAssertEqual(DeliverableGroups.newest(of: "a", in: [old1, old2]), "b")
        // No longer held: nothing to follow to.
        XCTAssertNil(DeliverableGroups.newest(of: "gone", in: [v1, v2]))
    }
}

/// The motion panel-lab tuned (its `DEF`), in ConchMotion's own terms. The panel went (2026-11-11); setup and the window
/// still move on these.
final class PanelMotionTests: XCTestCase {
    func testTheCrossfadeAndThePopoverAreTheLabs() {
        // crossBlur 4, crossShift 8, crossScale 0.985, on the pop spring, 24 ms apart.
        XCTAssertEqual(ConchMotion.crossBlur, 4)
        XCTAssertEqual(ConchMotion.crossShift, 8)
        XCTAssertEqual(ConchMotion.crossScale, 0.985)
        XCTAssertEqual(ConchMotion.crossStagger, 0.024)
        // #switcher: scale .94, translateY 6, blur 4; rows 40 ms in, 18 ms apart.
        XCTAssertEqual(ConchMotion.popScale, 0.94)
        XCTAssertEqual(ConchMotion.popShift, 6)
        XCTAssertEqual(ConchMotion.popBlur, 4)
        XCTAssertEqual(ConchMotion.popLead, 0.04)
        XCTAssertEqual(ConchMotion.popStagger, 0.018)
        XCTAssertEqual(ConchMotion.pop, ConchSpring(bounce: 0.34, response: 0.36))
    }

    /// Full screen's content: 120 ms after the morph lands, on 0.1 / 0.42, from scale .985 and a 3 pt blur.
    func testTheRevealAfterAMorphIsTheLabs() {
        XCTAssertEqual(ConchMotion.reveal, ConchSpring(bounce: 0.1, response: 0.42))
        XCTAssertEqual(ConchMotion.revealDelay, 0.12)
        XCTAssertEqual(ConchMotion.revealScale, 0.985)
        XCTAssertEqual(ConchMotion.revealBlur, 3)
        XCTAssertEqual(ConchMotion.morph, ConchSpring(bounce: 0.12, response: 0.46))
    }

    /// The springs the panel used to spell out by hand are named, and listed with the rest.
    func testTheHandWrittenSpringsAreTokens() {
        XCTAssertEqual(ConchMotion.liftOff, ConchSpring(bounce: 0, response: 0.2))
        XCTAssertEqual(ConchMotion.hover, ConchSpring(bounce: 0, response: 0.3))
        XCTAssertEqual(ConchMotion.sent, ConchSpring(bounce: 0.14, response: 0.42))
        let names = ConchMotion.springs.map(\.name)
        for name in ["liftOff", "hover", "sent", "reveal"] { XCTAssertTrue(names.contains(name), name) }
        // Reduce Motion drops their overshoot like any other.
        XCTAssertEqual(ConchMotion.sent.resolved(reduceMotion: true).bounce, 0)
        XCTAssertEqual(ConchMotion.reveal.resolved(reduceMotion: true).bounce, 0)
    }
}
