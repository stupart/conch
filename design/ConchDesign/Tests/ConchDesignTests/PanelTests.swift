import SwiftUI
import XCTest
@testable import ConchDesign

/// The conversation panel's words on its glass, measured rather than judged by eye.
///
/// ImageRenderer can't draw Liquid Glass, so the glass is stood in by panel-lab's own (`PanelGlass.standIn`), the way the
/// audit measured it over real screens: past turns at half their ink read 2.3 to 3.0, "You" 1.7 to 3.5 and the reply's
/// placeholder 1.6 to 2.8. Worst of all where the panel's appearance didn't match the app under it. So every level is
/// held here over every screen, black to white, in both appearances.
final class PanelContrastTests: XCTestCase {
    private let schemes: [(name: String, darkness: Double)] = [("light", 0), ("dark", 1)]

    /// What could be under the panel, already blurred: every grey from black to white, and the saturated colours an app
    /// or a page might put there.
    private var backdrops: [ConchRGBA] {
        stride(from: 0, through: 255, by: 5).map { ConchRGBA(UInt32($0) << 16 | UInt32($0) << 8 | UInt32($0)) }
            + [0xFF0000, 0x00FF00, 0x0000FF, 0xFFFF00, 0x00FFFF, 0xFF00FF, 0x1B1C1F, 0xE9E6E1].map { ConchRGBA($0) }
    }

    /// Each ground words can sit on: over every backdrop, with the mesh's colour faded out (at the panel's edge) or at
    /// full strength in each of its colours.
    private func grounds(_ darkness: Double, wash: Double? = nil) -> [ConchRGBA] {
        backdrops.flatMap { backdrop in
            ([nil] + PanelGlass.mesh.map { Optional($0) }).map { PanelGlass.ground(over: backdrop, darkness: darkness, mesh: $0, wash: wash) }
        }
    }

    private func worst(_ ink: ConchRGBA, darkness: Double, wash: Double? = nil) -> Double {
        grounds(darkness, wash: wash).map { ink.contrast(on: $0) }.min() ?? 0
    }

    private func ink(_ token: ConchColorToken, _ darkness: Double, alpha: Double = 1) -> ConchRGBA {
        let colour = token.rgba(darkness: darkness)
        return ConchRGBA(colour.hex, alpha: colour.alpha * alpha)
    }

    /// Every level of the panel's text reads at 4.5:1 on its glass, whatever is under it: the newest words, a past turn at
    /// `pastOpacity`, "You" and the header's item in the secondary ink, the reply's placeholder, and a failed send's notice.
    func testEveryLevelOfTheWordsReadsOnTheGlassOverAnything() {
        for (name, darkness) in schemes {
            let levels: [(String, ConchRGBA)] = [
                ("the newest words", ink(ConchColor.overlayText, darkness)),
                ("a past turn", ink(ConchColor.overlayText, darkness, alpha: ConversationFog.pastOpacity)),
                ("You, and the header's item", ink(ConchColor.overlayTextSecondary, darkness)),
                ("the reply's placeholder", ink(ConchColor.overlayPlaceholder, darkness)),
            ]
            for (level, colour) in levels {
                let ratio = worst(colour, darkness: darkness)
                print("\(level), \(name): \(String(format: "%.2f", ratio)):1 at worst")
                XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(level) in \(name) is \(String(format: "%.2f", ratio)):1 at worst")
            }
        }
    }

    /// Without the wash the same inks fail, which is why it is there: the secondary ink and a past turn over a screen the
    /// panel's appearance doesn't match.
    func testWithoutTheWashTheyWouldNot() {
        for (name, darkness) in schemes {
            let secondary = worst(ink(ConchColor.overlayTextSecondary, darkness), darkness: darkness, wash: 0)
            XCTAssertLessThan(secondary, 4.5, "the secondary ink in \(name) with no wash")
        }
        // The lab's own values, on the lab's glass alone: the audit's numbers.
        let labSecondary = ConchRGBA(0x6E6E73), labPast = ConchRGBA(0x1D1D1F, alpha: 0.5)
        XCTAssertLessThan(worst(labSecondary, darkness: 0, wash: 0), 2.5)
        XCTAssertLessThan(worst(labPast, darkness: 0, wash: 0), 3)
    }

    /// The panel's icons and a mark hold the 3:1 a graphic needs on the bare glass, with the pointer away and the button
    /// fills faded out: the icon ink, and the notice's attention glyph.
    func testTheIconsHoldThreeToOneWithTheirFillsGone() {
        for (name, darkness) in schemes {
            for (what, token) in [("an icon", ConchColor.overlayGlassIcon), ("the notice's glyph", ConchColor.attention)] {
                let ratio = worst(ink(token, darkness), darkness: darkness)
                XCTAssertGreaterThanOrEqual(ratio, 3, "\(what) in \(name) is \(String(format: "%.2f", ratio)):1 at worst")
            }
        }
    }

    /// The secondary ink is the dashboard's, so "You" and a heading read the same in the panel as in the window.
    func testTheSecondaryInkIsTheDashboards() {
        XCTAssertEqual(ConchColor.overlayTextSecondary.light, ConchColor.textSecondary.light)
        XCTAssertEqual(ConchColor.overlayTextSecondary.light.hexString, "#5C5C61")
    }

    /// The stand-in is panel-lab's `#panel .glass`, and the wash stays short of opaque: the glass still shows through.
    func testTheStandInIsTheLabsGlassAndTheWashLeavesItGlass() {
        XCTAssertEqual(PanelGlass.standIn(darkness: 0), ConchRGBA(0xFFFFFF, alpha: 0.52))
        XCTAssertEqual(PanelGlass.standIn(darkness: 1), ConchRGBA(0x1E1E22, alpha: 0.5))
        for darkness in [0.0, 1.0] {
            XCTAssertLessThanOrEqual(PanelGlass.wash.at(darkness), 0.75)
            XCTAssertGreaterThan(PanelGlass.wash.at(darkness), 0.5)
        }
        XCTAssertEqual(PanelGlass.mesh.count, 9)
    }
}

/// The glass as the panel's window morphs: panel-lab's shapes, and a straight line between them.
final class PanelGlassGeometryTests: XCTestCase {
    /// Docked: 24 pt in with the panel's 30 pt corner. Full screen: 12 pt from the screen's sides and foot and from under
    /// the menu bar, with a 26 pt corner (panel-lab's `fullRect`). It never stops being the rounded glass.
    func testDockedAndFullScreenAreTheLabs() {
        let docked = PanelGlass.Geometry.docked
        XCTAssertEqual(docked.insets, EdgeInsets(top: 24, leading: 24, bottom: 24, trailing: 24))
        XCTAssertEqual(docked.radius, 30)
        XCTAssertEqual(docked.radius, ConchRadius.panel)
        let full = PanelGlass.Geometry.fullScreen(menuBar: 33)
        XCTAssertEqual(full.insets, EdgeInsets(top: 45, leading: 12, bottom: 12, trailing: 12))
        XCTAssertEqual(full.radius, 26)
    }

    /// Collapsed, the glass is exactly the handle's circle in each corner, so it shrinks into the handle.
    func testCollapsedIsTheHandlesCircle() {
        let side = FogHandle.side
        for corner in [FogCorner.bottomLeading, .bottomTrailing, .topLeading, .topTrailing] {
            let glass = PanelGlass.Geometry.collapsed(corner: corner)
            let circle = CGRect(x: glass.insets.leading, y: glass.insets.top, width: side - glass.insets.leading - glass.insets.trailing, height: side - glass.insets.top - glass.insets.bottom)
            XCTAssertEqual(circle.width, FogHandle.circle, "\(corner)")
            XCTAssertEqual(circle.height, FogHandle.circle, "\(corner)")
            XCTAssertEqual(glass.radius, FogHandle.circle / 2)
            // FogHandle pads its circle `inset` from the corner's own two edges.
            XCTAssertEqual(corner.leading ? circle.minX : side - circle.maxX, FogHandle.inset, "\(corner)")
            XCTAssertEqual(corner.bottom ? side - circle.maxY : circle.minY, FogHandle.inset, "\(corner)")
        }
    }

    /// Between two shapes the glass runs in a straight line, and overshoots with the spring past 1.
    func testItMorphsInAStraightLine() {
        let a = PanelGlass.Geometry.docked, b = PanelGlass.Geometry.fullScreen(menuBar: 33)
        XCTAssertEqual(PanelGlass.Geometry.lerp(a, b, 0), a)
        XCTAssertEqual(PanelGlass.Geometry.lerp(a, b, 1), b)
        let half = PanelGlass.Geometry.lerp(a, b, 0.5)
        XCTAssertEqual(half.radius, 28, accuracy: 1e-9)
        XCTAssertEqual(half.insets.top, 34.5, accuracy: 1e-9)
        XCTAssertEqual(half.insets.leading, 18, accuracy: 1e-9)
        XCTAssertEqual(PanelGlass.Geometry.lerp(a, b, 1.02).radius, 25.92, accuracy: 1e-9)
        // Never a negative corner, however far a spring throws it.
        XCTAssertEqual(PanelGlass.Geometry.lerp(a, PanelGlass.Geometry(insets: EdgeInsets(), radius: 0), 5).radius, 0)
    }
}

/// The panel's keys, while it has them.
final class PanelKeysTests: XCTestCase {
    private func action(_ key: UInt16, command: Bool = false, option: Bool = false, control: Bool = false, shift: Bool = false, switching: Bool = false, fullScreen: Bool = false, typing: Bool = false) -> PanelKeys.Action? {
        PanelKeys.action(key: key, command: command, option: option, control: control, shift: shift, switching: switching, fullScreen: fullScreen, typing: typing)
    }

    /// ⌘↩ full screen and back, typing or not; ⌥⌘← and ⌥⌘→ Previous and Next; ⌘. collapses.
    func testTheShortcutsWorkWhateverHasTheKeys() {
        for typing in [false, true] {
            for fullScreen in [false, true] {
                XCTAssertEqual(action(PanelKeys.Key.returnKey, command: true, fullScreen: fullScreen, typing: typing), .fullScreen)
                XCTAssertEqual(action(PanelKeys.Key.enter, command: true, fullScreen: fullScreen, typing: typing), .fullScreen)
                XCTAssertEqual(action(PanelKeys.Key.left, command: true, option: true, typing: typing), .previous)
                XCTAssertEqual(action(PanelKeys.Key.right, command: true, option: true, typing: typing), .next)
                XCTAssertEqual(action(PanelKeys.Key.period, command: true, typing: typing), .collapse)
            }
        }
        // Not their plain or near neighbours: a word left, a line's start, a new line, a period.
        XCTAssertNil(action(PanelKeys.Key.left, option: true, typing: true))
        XCTAssertNil(action(PanelKeys.Key.left, command: true, typing: true))
        XCTAssertNil(action(PanelKeys.Key.returnKey, typing: true))
        XCTAssertNil(action(PanelKeys.Key.period, typing: true))
        XCTAssertNil(action(PanelKeys.Key.returnKey, command: true, shift: true))
        XCTAssertNil(action(PanelKeys.Key.returnKey, command: true, control: true))
    }

    /// Esc: the switcher first; then the reply line's own (it leaves the field); then full screen; then the keys go back.
    func testEscLeavesOneThingAtATime() {
        XCTAssertEqual(action(PanelKeys.Key.escape, switching: true, fullScreen: true, typing: true), .closeSwitcher)
        XCTAssertNil(action(PanelKeys.Key.escape, fullScreen: true, typing: true), "the reply line leaves itself")
        XCTAssertEqual(action(PanelKeys.Key.escape, fullScreen: true), .exitFullScreen)
        XCTAssertEqual(action(PanelKeys.Key.escape), .giveBack)
        XCTAssertNil(action(PanelKeys.Key.escape, typing: true))
    }

    /// The switcher, open, takes ↑, ↓ and Return; closed, they are the reply line's.
    func testTheSwitcherTakesTheArrowsAndReturn() {
        XCTAssertEqual(action(PanelKeys.Key.up, switching: true), .move(-1))
        XCTAssertEqual(action(PanelKeys.Key.down, switching: true, typing: true), .move(1))
        XCTAssertEqual(action(PanelKeys.Key.returnKey, switching: true, typing: true), .pick)
        XCTAssertEqual(action(PanelKeys.Key.enter, switching: true), .pick)
        XCTAssertNil(action(PanelKeys.Key.up, typing: true))
        XCTAssertNil(action(PanelKeys.Key.down))
        XCTAssertNil(action(PanelKeys.Key.returnKey, typing: true))
    }

    /// The keyboard's pick walks the switcher's rows and stops at either end, starting from the first.
    func testTheSelectionStopsAtEitherEnd() {
        let sessions = ["a", "b", "c"].map { FogSession(id: $0, label: $0, agent: "Claude") }
        XCTAssertEqual(FogSession.selection(after: "a", in: sessions, by: 1), "b")
        XCTAssertEqual(FogSession.selection(after: "c", in: sessions, by: 1), "c")
        XCTAssertEqual(FogSession.selection(after: "a", in: sessions, by: -1), "a")
        XCTAssertEqual(FogSession.selection(after: nil, in: sessions, by: 1), "a")
        XCTAssertEqual(FogSession.selection(after: "gone", in: sessions, by: -1), "a")
        XCTAssertNil(FogSession.selection(after: "a", in: [], by: 1))
    }

    /// A button's tooltip says what it does and its key: the panel's names, and the keys `action` reads.
    func testTheTooltipsNameTheKeys() {
        XCTAssertEqual(IconButton.help("Full screen", shortcut: PanelKeys.Shortcut.fullScreen), "Full screen (⌘↩)")
        XCTAssertEqual(IconButton.help("Previous ready item", shortcut: PanelKeys.Shortcut.previous), "Previous ready item (⌥⌘←)")
        XCTAssertEqual(IconButton.help("Next ready item", shortcut: PanelKeys.Shortcut.next), "Next ready item (⌥⌘→)")
        XCTAssertEqual(IconButton.help("Collapse conversation", shortcut: PanelKeys.Shortcut.collapse), "Collapse conversation (⌘.)")
        XCTAssertEqual(IconButton.help("Exit full screen", shortcut: PanelKeys.Shortcut.exitFullScreen), "Exit full screen (Esc)")
        XCTAssertEqual(IconButton.help("Send", shortcut: nil), "Send")
    }
}

/// What the panel says, and what it follows.
final class PanelStateTests: XCTestCase {
    /// The reply line says whom a reply goes to.
    func testThePlaceholderNamesTheSession() {
        XCTAssertEqual(ConversationFog.placeholder(for: FogSession(id: "a", label: "Arch brand page", agent: "Claude")), "Reply to Arch brand page")
        XCTAssertEqual(ConversationFog.placeholder(for: nil), "Reply")
    }

    /// VoiceOver hears a switcher row's standing, as the eye sees its mark.
    func testTheSwitcherSaysEachRowsStanding() {
        XCTAssertEqual(FogSession.Standing.ready.spoken, "Ready")
        XCTAssertEqual(FogSession.Standing.working.spoken, "Working")
        XCTAssertEqual(FogSession.Standing.other.spoken, "")
        // Working is the filled blue dot, never the hollow ring that means Paused in the sidebar.
        XCTAssertEqual(FogSession.markColor(.working).name, ConchColor.active.name)
        XCTAssertEqual(FogSession.markColor(.ready).name, ConchColor.ready.name)
    }

    /// Only the item changes: the header crosses over on it, so a new item in the same session never cuts.
    func testTheHeaderCrossesOverOnItsItemToo() {
        let session = FogSession(id: "a", label: "Arch", agent: "Claude", item: "v1: the hero")
        XCTAssertNotEqual(ConversationFog.crossKey(session), ConversationFog.crossKey(session.with(item: "v2: the hero, tightened")))
        XCTAssertNotEqual(ConversationFog.crossKey(session), ConversationFog.crossKey(session.with(item: nil)))
        XCTAssertEqual(session.with(item: nil).item, nil)
        XCTAssertEqual(session.with(item: "x").label, "Arch")
    }

    /// The panel on version 1 of an artifact moves to version 2 when it is published; another artifact arriving doesn't
    /// move it. The daemon's artifact decides, else the link.
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

/// The panel's motion is panel-lab's `DEF`, in ConchMotion's own terms.
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

    /// A past turn keeps 70% of its ink: the lab's half measured under 3:1 on the glass.
    func testAPastTurnKeepsSeventyPercent() {
        XCTAssertEqual(ConversationFog.pastOpacity, 0.7)
    }
}
