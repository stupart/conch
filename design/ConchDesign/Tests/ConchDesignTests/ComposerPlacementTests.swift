import SwiftUI
import XCTest
@testable import ConchDesign

/// One input, in one place, and the swoop that carries it between them. Tyler: "Have to make sure only one is in use or
/// active at a time — think of it like: the input box is leaving the Mac app and coming with you — we literally remove it
/// from the Mac app UI until they go back to the app and it swoops back into the UI."
final class ComposerPlacementTests: XCTestCase {
    // MARK: Where it is

    private func place(
        active: Bool = false, window: Bool = true, panel: ComposerSituation.Panel = .open,
        replyLine: Bool = true, alone: Bool = true, held: Bool = false, current: ComposerPlace = .window
    ) -> ComposerPlace {
        ComposerPlacement.place(
            ComposerSituation(appActive: active, windowShown: window, panel: panel, replyLine: replyLine, withPanelOff: alone, held: held),
            current: current
        )
    }

    /// In conch's window while conch is in front with its window there; whatever the panel is doing.
    func testInTheWindowWhileConchIsInFront() {
        for panel in [ComposerSituation.Panel.off, .collapsed, .open] {
            for replyLine in [true, false] {
                XCTAssertEqual(place(active: true, panel: panel, replyLine: replyLine), .window, "\(panel) \(replyLine)")
            }
        }
    }

    /// Leaving conch takes it with you: the panel's reply line when the panel is open; the reply line alone when it is off
    /// or folded, by default.
    func testLeavingTakesItWithYou() {
        XCTAssertEqual(place(panel: .open), .panel)
        XCTAssertEqual(place(panel: .off), .replyLine)
        XCTAssertEqual(place(panel: .collapsed), .replyLine)
    }

    /// With Panel Off turned off, leaving with nothing open leaves it in the window; with the panel open it still comes.
    func testWithPanelOffOffKeepsItHomeWhenThereIsNoPanel() {
        XCTAssertEqual(place(panel: .off, alone: false), .window)
        XCTAssertEqual(place(panel: .collapsed, alone: false), .window)
        XCTAssertEqual(place(panel: .open, alone: false), .panel)
    }

    /// The reply line off: the panel shows only the words, so the input never leaves the window.
    func testReplyLineOffNeverLeavesTheWindow() {
        for panel in [ComposerSituation.Panel.off, .collapsed, .open] {
            XCTAssertEqual(place(panel: panel, replyLine: false), .window)
            XCTAssertEqual(place(window: false, panel: panel, replyLine: false), .none)
        }
    }

    /// No window to return to (closed, minimised, hidden, another space), conch in front or not: the input stays out
    /// with Tyler.
    func testWithNoWindowItStaysInThePanel() {
        for active in [true, false] {
            XCTAssertEqual(place(active: active, window: false, panel: .open), .panel)
            XCTAssertEqual(place(active: active, window: false, panel: .off), .replyLine)
            XCTAssertEqual(place(active: active, window: false, panel: .off, alone: false), .none)
        }
    }

    /// Its file picker brings conch forward; the input stays exactly where it is while it is up.
    func testHeldStaysPut() {
        for current in ComposerPlace.allCases {
            XCTAssertEqual(place(active: true, held: true, current: current), current)
            XCTAssertEqual(place(active: false, panel: .off, held: true, current: current), current)
        }
    }

    /// Over every situation: one home, never more. In the window only when there is a window; floating only with the
    /// reply line on; in the panel only when the panel is open; nowhere only when there is nowhere.
    func testEverySituationHasOneHome() {
        let bools = [false, true]
        for active in bools { for window in bools { for replyLine in bools { for alone in bools {
            for panel in [ComposerSituation.Panel.off, .collapsed, .open] {
                let at = place(active: active, window: window, panel: panel, replyLine: replyLine, alone: alone)
                if at == .window { XCTAssertTrue(window) }
                if at.floats { XCTAssertTrue(replyLine) }
                XCTAssertFalse(at == .window && at.floats, "one place, one input")
                if at == .panel { XCTAssertEqual(panel, .open) }
                if at == .replyLine { XCTAssertNotEqual(panel, .open) }
                if at == .none { XCTAssertFalse(window) }
                if active, window { XCTAssertEqual(at, .window) }
            }
        } } } }
    }

    // MARK: The swoop

    private let windowCard = CGRect(x: 820, y: 104, width: 580, height: 80)
    private let panelCard = CGRect(x: 48, y: 72, width: 620, height: 80)
    private let dt = 1.0 / 120

    private func flight(reduceMotion: Bool = false, emerges: Bool = false) -> ComposerFlight {
        ComposerFlight(from: .window, at: .window(windowCard), to: .panel, at: .floating(panelCard), emerges: emerges, reduceMotion: reduceMotion)
    }

    /// Steps `flight` until it lands, returning every frame's cards; fails if it takes more than two seconds.
    @discardableResult
    private func run(_ flight: inout ComposerFlight, seconds: Double = 2) -> [[ComposerFlight.Card]] {
        var frames: [[ComposerFlight.Card]] = []
        var t = 0.0
        while !flight.step(dt: dt) {
            frames.append(flight.cards)
            t += dt
            if t > seconds {
                XCTFail("still flying after \(seconds) s")
                break
            }
        }
        return frames
    }

    /// It lands where it was going, as the panel's glass: its rect, its corner, its chrome. It arrives (the live input
    /// shows under it) before it lands (the hand-off is done), and then there is nothing left to draw.
    func testItLandsWhereItWasGoing() {
        var swoop = flight()
        var arrivedAt: Int?
        var index = 0
        while !swoop.step(dt: dt) {
            if swoop.arrived, arrivedAt == nil { arrivedAt = index }
            index += 1
            XCTAssertLessThan(index, 240, "lands within two seconds")
        }
        XCTAssertNotNil(arrivedAt, "arrives before it lands")
        XCTAssertEqual(swoop.current.rect, panelCard)
        XCTAssertEqual(swoop.current.radius, ConchRadius.panel)
        XCTAssertEqual(swoop.current.chrome, 1)
        XCTAssertTrue(swoop.landed)
        XCTAssertTrue(swoop.cards.isEmpty)
    }

    /// A glass the size of the composer, on the morph spring: well under a second to arrive, and the overshoot small.
    func testItArrivesQuicklyWithASmallOvershoot() {
        var swoop = flight()
        var time = 0.0
        var furthest: CGFloat = 0
        let distance = windowCard.midX - panelCard.midX
        while !swoop.arrived {
            swoop.step(dt: dt)
            time += dt
            // Past the target on the far side: overshoot.
            furthest = max(furthest, panelCard.midX - swoop.current.rect.midX)
        }
        // Interactive where it lands soon after it looks landed: well under the morph's own second.
        XCTAssertLessThan(time, 0.65)
        XCTAssertGreaterThan(time, 0.25, "a spring, not a cut")
        XCTAssertLessThan(furthest / distance, 0.05)
    }

    /// From rest, every part of it follows one curve: its middle travels in a straight line from one card to the other,
    /// never leaning toward an edge as it changes size.
    func testItTravelsFromItsMiddleInAStraightLine() {
        var swoop = flight()
        let dx = panelCard.midX - windowCard.midX, dy = panelCard.midY - windowCard.midY
        for _ in 0..<40 {
            swoop.step(dt: dt)
            let now = swoop.current.rect
            let tx = (now.midX - windowCard.midX) / dx, ty = (now.midY - windowCard.midY) / dy
            XCTAssertEqual(tx, ty, accuracy: 0.001)
            let tw = (now.width - windowCard.width) / (panelCard.width - windowCard.width)
            XCTAssertEqual(tx, tw, accuracy: 0.001)
        }
    }

    /// What is on it crossfades, the look it lands as coming in over the look it left: at every moment one of them is
    /// whole, so words that coincide never dim; the two are mirror images, so turning back runs the same way back; and
    /// each is alone at its end.
    func testOneLookIsAlwaysWhole() {
        for p in stride(from: CGFloat(-0.1), through: 1.1, by: 0.01) {
            XCTAssertEqual(max(ComposerFlight.leaving(p), ComposerFlight.arriving(p)), 1, accuracy: 0.0001, "\(p)")
            XCTAssertEqual(ComposerFlight.leaving(p), ComposerFlight.arriving(1 - p), accuracy: 0.0001)
        }
        XCTAssertEqual(ComposerFlight.arriving(ComposerFlight.crossfade.lowerBound), 0)
        XCTAssertEqual(ComposerFlight.leaving(ComposerFlight.crossfade.upperBound), 0)
        XCTAssertLessThan(ComposerFlight.arriving(0.4), 1, "a crossfade, not a cut")
        XCTAssertLessThan(ComposerFlight.leaving(0.6), 1)
        var swoop = flight()
        XCTAssertEqual(swoop.cards.first?.leaving, 1)
        XCTAssertEqual(swoop.cards.first?.arriving, 0)
        for frame in run(&swoop) {
            XCTAssertLessThanOrEqual(frame.count, 1, "one glass in flight")
        }
    }

    /// Cmd-Tab back mid-flight: the glass turns round from where it is, keeping its speed for a moment rather than
    /// jumping, and the crossfade runs back from exactly where it was.
    func testTurningBackMidFlightIsContinuous() {
        var swoop = flight()
        // Into the crossfade, both looks showing.
        while (swoop.cards.first?.arriving ?? 0) < 0.4 { swoop.step(dt: dt) }
        let heading = swoop.current.rect.midX
        swoop.step(dt: dt)
        let moving = swoop.current.rect.midX - heading
        let at = swoop.current
        let card = swoop.cards[0]
        XCTAssertGreaterThan(card.leaving, 0.05)
        XCTAssertGreaterThan(card.arriving, 0.05)
        swoop.retarget(to: .window, at: .window(windowCard))
        XCTAssertEqual(swoop.from, .panel)
        XCTAssertEqual(swoop.to, .window)
        // No jump: where it is, it still is.
        XCTAssertEqual(swoop.current.rect, at.rect)
        // Each look keeps its strength across the turn: the window's, which it left, is now the one it lands as.
        XCTAssertLessThan(card.arriving, 1, "turned while the panel's look was still coming in")
        let turned = swoop.cards[0]
        XCTAssertEqual(turned.arriving, card.leaving, accuracy: 0.0001)
        XCTAssertEqual(turned.leaving, card.arriving, accuracy: 0.0001)
        XCTAssertEqual(turned.opacity, card.opacity, accuracy: 0.0001)
        // It keeps going the way it was going for a moment: interrupted, not reset.
        let next = swoop.current.rect.midX
        swoop.step(dt: dt)
        XCTAssertEqual((swoop.current.rect.midX - next).sign, moving.sign)
        run(&swoop)
        XCTAssertEqual(swoop.current.rect, windowCard)
        XCTAssertEqual(swoop.current.chrome, 0)
    }

    /// Switching apps back and forth quickly bends one flight: one glass at every frame, always somewhere between the two
    /// places (give or take the spring's overshoot), and it lands on the last place asked.
    func testRapidSwitchingNeverQueues() {
        var swoop = flight()
        let bounds = windowCard.union(panelCard).insetBy(dx: -40, dy: -40)
        for flip in 0..<12 {
            for _ in 0..<6 {
                swoop.step(dt: dt)
                XCTAssertLessThanOrEqual(swoop.cards.count, 1)
                XCTAssertTrue(bounds.contains(swoop.current.rect), "\(swoop.current.rect)")
            }
            let home = flip.isMultiple(of: 2)
            swoop.retarget(to: home ? .window : .panel, at: home ? .window(windowCard) : .floating(panelCard))
        }
        // The last flip (11) was odd: back to the panel.
        XCTAssertEqual(swoop.to, .panel)
        run(&swoop)
        XCTAssertEqual(swoop.current.rect, panelCard)
    }

    /// The place it is going moved under it (the panel dragged, the window resized, a line typed): the same flight lands
    /// where it now is.
    func testItFollowsAMovingDestination() {
        var swoop = flight()
        for _ in 0..<20 { swoop.step(dt: dt) }
        let moved = panelCard.offsetBy(dx: 30, dy: 12)
        swoop.follow(.floating(moved))
        swoop.retarget(to: .panel, at: .floating(moved.offsetBy(dx: 0, dy: 8)))
        run(&swoop)
        XCTAssertEqual(swoop.current.rect, moved.offsetBy(dx: 0, dy: 8))
    }

    /// Reduce Motion: nothing travels. The input fades out where it was and in where it goes, and the two never move.
    func testReduceMotionOnlyCrossfades() {
        var swoop = flight(reduceMotion: true)
        var sawBoth = false
        // The glass itself is never between the two, even for a turn: where a retarget picks it up is where it lands.
        for _ in 0..<40 {
            swoop.step(dt: dt)
            XCTAssertEqual(swoop.current.rect, panelCard)
        }
        swoop = flight(reduceMotion: true)
        for frame in run(&swoop) {
            for card in frame {
                XCTAssertTrue(card.shape.rect == windowCard || card.shape.rect == panelCard, "\(card.shape.rect)")
                XCTAssertEqual(card.lift, 0)
            }
            if frame.count == 2 { sawBoth = true }
            let leaving = frame.first { $0.shape.rect == windowCard }?.opacity ?? 0
            let arriving = frame.first { $0.shape.rect == panelCard }?.opacity ?? 0
            XCTAssertLessThanOrEqual(leaving + arriving, 1.0001)
        }
        XCTAssertTrue(sawBoth)
        XCTAssertEqual(swoop.current.rect, panelCard)
    }

    /// Its source covered by the app that came forward: the glass fades in as it leaves rather than appearing over that
    /// app. With nowhere to land, it fades out as it goes, and has nothing to hand off to.
    func testItEmergesFromUnderAndVanishesToNowhere() {
        var swoop = flight(emerges: true)
        XCTAssertEqual(swoop.cards.first?.opacity ?? 1, 0, accuracy: 0.001)
        var opacities: [CGFloat] = []
        for _ in 0..<30 {
            swoop.step(dt: dt)
            opacities.append(swoop.cards.first?.opacity ?? 0)
        }
        XCTAssertEqual(opacities, opacities.sorted(), "only ever fades in")
        XCTAssertGreaterThan(opacities.last ?? 0, 0.9)

        let source = ComposerFlight.Shape.window(windowCard)
        var gone = ComposerFlight(from: .window, at: source, to: .none, at: source.scaled(ConchMotion.appearScale))
        XCTAssertTrue(gone.vanishes)
        var last: CGFloat = 1
        while !gone.step(dt: dt) {
            let opacity = gone.cards.first?.opacity ?? 0
            XCTAssertLessThanOrEqual(opacity, last + 0.001)
            last = opacity
        }
        XCTAssertTrue(gone.cards.isEmpty)
    }

    /// What is on the glass is never scaled: each piece of the picture keeps its size, the field from the top leading
    /// corner, the bar's clusters from the bottom corners, so two pictures of the same draft at two widths coincide.
    func testThePictureIsPlacedNeverScaled() {
        let picture = CGSize(width: 580, height: 80), card = CGSize(width: 530, height: 92)
        let slices = ComposerFlight.slices(picture: picture, in: card)
        XCTAssertEqual(slices.count, 3)
        for slice in slices { XCTAssertEqual(slice.from.size, slice.to.size) }
        // Every point of the picture is in exactly one piece.
        XCTAssertEqual(slices.map { $0.from.width * $0.from.height }.reduce(0, +), picture.width * picture.height, accuracy: 0.001)
        XCTAssertEqual(slices[0].to.origin, .zero)
        XCTAssertEqual(slices[1].to.minX, 0)
        XCTAssertEqual(slices[1].to.maxY, card.height)
        XCTAssertEqual(slices[2].to.maxX, card.width)
        XCTAssertEqual(slices[2].to.maxY, card.height)
        // The same draft laid out at two widths: the field and the leading cluster land in the same place on the glass,
        // and so does the trailing cluster, so the crossfade between them is invisible.
        let narrow = ComposerFlight.slices(picture: CGSize(width: 504, height: 80), in: card)
        XCTAssertEqual(narrow[0].to.origin, slices[0].to.origin)
        XCTAssertEqual(narrow[1].to.origin, slices[1].to.origin)
        XCTAssertEqual(narrow[2].to, slices[2].to)
    }

    /// Appearing or leaving with nowhere to come from or go: from and to a touch small about its middle, never nothing.
    func testAppearingIsFromATouchSmallNeverNothing() {
        let shape = ComposerFlight.Shape.floating(panelCard).scaled(ConchMotion.appearScale)
        XCTAssertGreaterThanOrEqual(ConchMotion.appearScale, 0.5)
        XCTAssertLessThan(ConchMotion.appearScale, 1)
        XCTAssertEqual(shape.rect.midX, panelCard.midX, accuracy: 0.001)
        XCTAssertEqual(shape.rect.midY, panelCard.midY, accuracy: 0.001)
        XCTAssertEqual(shape.rect.width, panelCard.width * ConchMotion.appearScale, accuracy: 0.001)
    }

    /// The glass's own looks: the window's card at one end, the panel's glass at the other, and lifted mid-flight.
    func testTheGlassIsTheCardAtOneEndAndThePanelsGlassAtTheOther() {
        for dark in [false, true] {
            let scheme: ColorScheme = dark ? .dark : .light
            func components(_ token: ConchColorToken) -> SIMD4<Double> {
                let rgba = token.rgba(scheme)
                return SIMD4(rgba.red, rgba.green, rgba.blue, rgba.alpha)
            }
            let card = ComposerGlass(chrome: 0, dark: dark), glass = ComposerGlass(chrome: 1, dark: dark)
            XCTAssertEqual(card.fill, components(ConchColor.surface))
            XCTAssertEqual(card.line, components(ConchColor.hairline))
            XCTAssertEqual(glass.fill, components(ConchColor.overlayGlassStrong))
            XCTAssertEqual(glass.line, components(ConchColor.overlayLine))
            let lifted = ComposerGlass(chrome: 0.5, lift: 1, dark: dark)
            XCTAssertGreaterThan(lifted.shadowRadius, card.shadowRadius)
            XCTAssertGreaterThan(lifted.shadowOpacity, card.shadowOpacity)
        }
    }

    // MARK: Where the reply line alone sits

    /// In the panel's corner of the visible frame, in by the panel's own margin; beside the folded handle, never on it.
    func testTheReplyLineAloneSitsInThePanelsCorner() {
        let visible = CGRect(x: 0, y: 70, width: 1440, height: 800)
        let size = CGSize(width: 580, height: 80)
        let bottomLeft = ComposerDockGeometry.replyLineFrame(size: size, corner: .bottomLeading, in: visible, besideHandle: false)
        XCTAssertEqual(bottomLeft.origin, CGPoint(x: 24, y: 94))
        let beside = ComposerDockGeometry.replyLineFrame(size: size, corner: .bottomLeading, in: visible, besideHandle: true)
        XCTAssertEqual(beside.minX, 24 + FogHandle.side)
        let topRight = ComposerDockGeometry.replyLineFrame(size: size, corner: .topTrailing, in: visible, besideHandle: false)
        XCTAssertEqual(topRight.maxX, visible.maxX - 24)
        XCTAssertEqual(topRight.maxY, visible.maxY - 24)
        XCTAssertEqual(ComposerDockGeometry.replyLineWidth(measure: 580, in: visible), 580)
        XCTAssertEqual(ComposerDockGeometry.replyLineWidth(measure: 580, in: CGRect(x: 0, y: 0, width: 500, height: 400)), 452)
    }

    // MARK: The panel's room for it

    /// The room the panel keeps for the input is where its own reply line would be: at the foot of the words' column, or
    /// at its head hanging from a top corner, above a failed send's sentence; full screen on a deliverable, the capsule's
    /// place, centred at the foot. And the words stop where the room begins.
    func testThePanelsRoomIsWhereItsReplyLineWas() {
        let size = CGSize(width: 852, height: 592)
        let column = ConversationFog.textFrame(in: size, corner: .bottomLeading, insets: EdgeInsets(), fullScreen: false)
        let bottom = ConversationFog.replySlot(in: size, corner: .bottomLeading, insets: EdgeInsets(), fullScreen: false, showsContent: false, height: 80)
        XCTAssertEqual(bottom.minX, column.minX)
        XCTAssertEqual(bottom.width, column.width)
        XCTAssertEqual(bottom.maxY, column.maxY)
        let noticed = ConversationFog.replySlot(in: size, corner: .bottomLeading, insets: EdgeInsets(), fullScreen: false, showsContent: false, height: 80, notice: 22)
        XCTAssertEqual(noticed.maxY, column.maxY - 22)
        let topColumn = ConversationFog.textFrame(in: size, corner: .topTrailing, insets: EdgeInsets(), fullScreen: false)
        let top = ConversationFog.replySlot(in: size, corner: .topTrailing, insets: EdgeInsets(), fullScreen: false, showsContent: false, height: 80)
        XCTAssertEqual(top.minY, topColumn.minY)
        let full = CGSize(width: 1416, height: 860)
        let capsule = ConversationFog.replySlot(in: full, corner: .bottomLeading, insets: EdgeInsets(), fullScreen: true, showsContent: true, height: 80)
        XCTAssertEqual(capsule.midX, full.width / 2, accuracy: 0.001)
        XCTAssertEqual(capsule.width, ConversationFog.floatingReplyWidth(in: full))
        XCTAssertEqual(capsule.maxY, full.height - ConversationFog.padding)
        // Full screen on a deliverable, the deliverable ends a gap above the room.
        let content = ConversationFog.contentFrame(in: full, insets: EdgeInsets(), showsReply: true, held: 80)
        XCTAssertEqual(content.maxY, capsule.minY - FogReply.gap, accuracy: 0.001)
    }

    // MARK: The menu

    /// With Panel Off sits under Reply Line, a step in, and only means anything while the reply line is on.
    func testWithPanelOffSitsUnderReplyLine() {
        func items(replyLine: Bool, alone: Bool) -> [StatusMenu.Item] {
            StatusMenu.rows(StatusMenu.Input(
                voice: .talk, quiet: false, exchangeActive: false, controlBar: true, conversation: true, collapsed: false,
                replyLine: replyLine, replyLineAlone: alone, drawing: false, ready: [], working: []
            )).compactMap { row -> StatusMenu.Item? in
                if case let .item(item) = row { return item }
                return nil
            }
        }
        let on = items(replyLine: true, alone: true)
        let reply = on.firstIndex { $0.command == .replyLine }
        let alone = on.firstIndex { $0.command == .replyLineAlone }
        XCTAssertNotNil(reply)
        XCTAssertEqual(alone, reply.map { $0 + 1 })
        let item = on.first { $0.command == .replyLineAlone }
        XCTAssertEqual(item?.title, "With Panel Off")
        XCTAssertEqual(item?.indent, 1)
        XCTAssertEqual(item?.mark, .on)
        XCTAssertEqual(item?.enabled, true)
        XCTAssertEqual(items(replyLine: false, alone: true).first { $0.command == .replyLineAlone }?.enabled, false)
        XCTAssertEqual(items(replyLine: true, alone: false).first { $0.command == .replyLineAlone }?.mark, .off)
    }
}
