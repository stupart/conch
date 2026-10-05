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

    // MARK: conch steering the screen

    /// Tyler: "We don't need the input box to leave the ui and come back when its the app temporarily steering the ui to do
    /// a paste into a terminal." A send conch steers holds the input from the press, through Terminal coming forward, until
    /// conch is back in front; the placement rule keeps it where it is all that while.
    func testASteeredSendHoldsTheInputUntilConchIsBackInFront() {
        var steering = ComposerSteering()
        XCTAssertFalse(steering.held(at: 100))
        let send = steering.begin(at: 100)
        XCTAssertTrue(steering.held(at: 100))
        // Terminal in front, typing: conch is not the app in front, and the input still does not move.
        XCTAssertTrue(steering.held(at: 101))
        XCTAssertEqual(place(active: false, held: steering.held(at: 101), current: .window), .window)
        // Typed; conch asks for the front back and holds until it has it.
        steering.delivered(send, refocusing: true, at: 101.2)
        XCTAssertTrue(steering.held(at: 101.3))
        steering.landed()
        XCTAssertFalse(steering.held(at: 101.3))
        XCTAssertNil(steering.expiry(after: 101.3))
    }

    /// Typed with Tyler somewhere else by then: conch does not take the front, the hold lets go at once, and the next look
    /// moves the input with him.
    func testDeliveredWithoutRefocusLetsGoAtOnce() {
        var steering = ComposerSteering()
        let send = steering.begin(at: 10)
        steering.delivered(send, refocusing: false, at: 11)
        XCTAssertFalse(steering.held(at: 11))
        XCTAssertEqual(place(active: false, held: steering.held(at: 11), current: .window), .panel)
    }

    /// A send that did not go lets go; one whose answer never comes lets go at the failsafe; asked for the front back, it
    /// waits only a moment for it.
    func testEverySteeredHoldEnds() {
        var steering = ComposerSteering()
        let failed = steering.begin(at: 0)
        steering.end(failed)
        XCTAssertFalse(steering.held(at: 0))

        let silent = steering.begin(at: 0)
        XCTAssertTrue(steering.held(at: ComposerSteering.failsafe - 0.01))
        XCTAssertFalse(steering.held(at: ComposerSteering.failsafe))
        XCTAssertEqual(steering.expiry(after: 0), ComposerSteering.failsafe)
        steering.end(silent)

        let refocusing = steering.begin(at: 0)
        steering.delivered(refocusing, refocusing: true, at: 2)
        XCTAssertTrue(steering.held(at: 2 + ComposerSteering.landing - 0.01))
        XCTAssertFalse(steering.held(at: 2 + ComposerSteering.landing))
        XCTAssertEqual(steering.expiry(after: 2), 2 + ComposerSteering.landing)
    }

    /// conch back in front ends only the sends waiting for it: one still typing holds on. Tyler going elsewhere ends them all.
    func testLandingEndsOnlyTheSendsWaitingForIt() {
        var steering = ComposerSteering()
        let first = steering.begin(at: 0)
        let second = steering.begin(at: 0.5)
        XCTAssertNotEqual(first, second)
        steering.delivered(first, refocusing: true, at: 1)
        steering.landed()
        XCTAssertTrue(steering.held(at: 1), "the second is still typing")
        // A late answer for a hold already gone changes nothing.
        steering.delivered(first, refocusing: true, at: 1)
        steering.delivered(second, refocusing: false, at: 1.2)
        XCTAssertFalse(steering.held(at: 1.2))

        _ = steering.begin(at: 2)
        _ = steering.begin(at: 2)
        steering.endAll()
        XCTAssertFalse(steering.held(at: 2))
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

    /// The laptop: a 70 pt Dock along the foot and a 30 pt menu bar. A second display to its right, no Dock.
    private let laptop = ReplyLinePlacement.Screen(id: "A", frame: CGRect(x: 0, y: 0, width: 1440, height: 900), visible: CGRect(x: 0, y: 70, width: 1440, height: 800))
    private let studio = ReplyLinePlacement.Screen(id: "B", frame: CGRect(x: 1440, y: 0, width: 1920, height: 1080), visible: CGRect(x: 1440, y: 0, width: 1920, height: 1055))

    private func placed(
        spot: ReplyLineSpot? = nil, screens: [ReplyLinePlacement.Screen]? = nil, current: String? = nil, home: String? = "A",
        pointer: CGPoint? = nil, main: String? = "A", height: CGFloat = 80
    ) -> ReplyLinePlacement.Placed? {
        ReplyLinePlacement.place(measure: 580, height: height, spot: spot, screens: screens ?? [laptop, studio], current: current, home: home, pointer: pointer, main: main)
    }

    private func assertInside(_ rect: CGRect, _ visible: CGRect, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertGreaterThanOrEqual(rect.minX, visible.minX - 0.001, message, file: file, line: line)
        XCTAssertLessThanOrEqual(rect.maxX, visible.maxX + 0.001, message, file: file, line: line)
        XCTAssertGreaterThanOrEqual(rect.minY, visible.minY - 0.001, message, file: file, line: line)
        XCTAssertLessThanOrEqual(rect.maxY, visible.maxY + 0.001, message, file: file, line: line)
    }

    /// Never moved: bottom centre of its screen's visible frame, `margin` above the Dock, the window composer's width,
    /// standing on its bottom edge. Tyler: "defaults to bottom center of the screen when it's in detached mode".
    func testTheReplyLineAloneDefaultsToBottomCentre() {
        let home = placed()
        XCTAssertEqual(home?.screen, "A")
        XCTAssertEqual(home?.frame, CGRect(x: 430, y: 94, width: 580, height: 80))
        XCTAssertEqual(home?.frame.midX, laptop.visible.midX)
        XCTAssertEqual(home?.frame.minY, laptop.visible.minY + ReplyLinePlacement.margin)
        XCTAssertEqual(home?.growsDown, false)
        XCTAssertEqual(ReplyLinePlacement.margin, 24)
        // On the other display, the same: its own visible frame's foot, its middle.
        XCTAssertEqual(placed(home: "B")?.frame, CGRect(x: 2110, y: 24, width: 580, height: 80))
        // A narrow screen: narrower, still centred.
        let narrow = ReplyLinePlacement.Screen(id: "N", frame: CGRect(x: 0, y: 0, width: 500, height: 400), visible: CGRect(x: 0, y: 0, width: 500, height: 400))
        let small = placed(screens: [narrow], home: "N")
        XCTAssertEqual(small?.frame.width, 452)
        XCTAssertEqual(small?.frame.midX, 250)
        // A longer draft grows it up from where it stands, never down into the Dock.
        XCTAssertEqual(placed(height: 200)?.frame.minY, 94)
        XCTAssertEqual(ComposerDockGeometry.replyLineWidth(measure: 580, in: laptop.visible), 580)
    }

    /// Left somewhere, it is there next time, on that screen, whichever screen it is on now or the panel is on.
    func testASavedSpotIsRestored() {
        let left = CGRect(x: 200, y: 500, width: 580, height: 80)
        let spot = ReplyLinePlacement.spot(of: left, on: laptop)
        XCTAssertEqual(spot.screen, "A")
        let back = placed(spot: spot, current: "B", home: "B", pointer: CGPoint(x: 2000, y: 500), main: "B")
        XCTAssertEqual(back?.screen, "A")
        XCTAssertEqual(back?.frame.minX ?? 0, 200, accuracy: 0.0001)
        XCTAssertEqual(back?.frame.minY ?? 0, 500, accuracy: 0.0001)
        // In the top half it hangs from its top edge.
        XCTAssertEqual(back?.growsDown, true)
        // Left on the other display, it is on that one.
        let there = ReplyLinePlacement.spot(of: CGRect(x: 1600, y: 300, width: 580, height: 80), on: studio)
        XCTAssertEqual(placed(spot: there)?.frame.origin.x ?? 0, 1600, accuracy: 0.0001)
        XCTAssertEqual(placed(spot: there)?.screen, "B")
        // Remembered as JSON, it reads back the same.
        let data = try! JSONEncoder().encode(spot)
        XCTAssertEqual(try JSONDecoder().decode(ReplyLineSpot.self, from: data), spot)
    }

    /// Relative to the visible frame: a new resolution or the Dock moved keeps it where it was in the same sense. Flush
    /// against an edge stays flush, centred stays centred, and it is always wholly on screen.
    func testASavedSpotKeepsItsSenseOnANewResolutionOrDock() {
        let corner = ReplyLinePlacement.spot(of: CGRect(x: 860, y: 790, width: 580, height: 80), on: laptop)
        XCTAssertEqual(corner.across, 1)
        XCTAssertEqual(corner.up, 1)
        let centred = ReplyLinePlacement.spot(of: CGRect(x: 430, y: 400, width: 580, height: 80), on: laptop)
        XCTAssertEqual(centred.across, 0.5)
        // A bigger resolution.
        let big = ReplyLinePlacement.Screen(id: "A", frame: CGRect(x: 0, y: 0, width: 1920, height: 1200), visible: CGRect(x: 0, y: 70, width: 1920, height: 1100))
        let grown = placed(spot: corner, screens: [big])?.frame
        XCTAssertEqual(grown?.maxX, big.visible.maxX)
        XCTAssertEqual(grown?.maxY, big.visible.maxY)
        XCTAssertEqual(placed(spot: centred, screens: [big])?.frame.midX, big.visible.midX)
        // The Dock moved to the left side: still in the top trailing corner, clear of the Dock.
        let docked = ReplyLinePlacement.Screen(id: "A", frame: laptop.frame, visible: CGRect(x: 80, y: 0, width: 1360, height: 870))
        let moved = placed(spot: corner, screens: [docked])?.frame
        XCTAssertEqual(moved?.maxX, docked.visible.maxX)
        XCTAssertEqual(moved?.maxY, docked.visible.maxY)
        // A smaller one: wholly on it, whatever it was.
        let smallest = ReplyLinePlacement.Screen(id: "A", frame: CGRect(x: 0, y: 0, width: 1024, height: 640), visible: CGRect(x: 0, y: 50, width: 1024, height: 565))
        for spot in [corner, centred, ReplyLinePlacement.spot(of: CGRect(x: 0, y: 70, width: 580, height: 80), on: laptop)] {
            assertInside(placed(spot: spot, screens: [smallest])!.frame, smallest.visible, "\(spot)")
        }
    }

    /// Wholly on screen: a spot or a let-go past any edge comes back onto the visible frame, the least it takes; nothing
    /// a spot can say (past the ends, not a number) puts it off screen.
    func testItIsClampedWhollyOnScreen() {
        let visible = laptop.visible
        XCTAssertEqual(ReplyLinePlacement.clamped(CGRect(x: -100, y: -50, width: 580, height: 80), in: visible).origin, CGPoint(x: 0, y: 70))
        XCTAssertEqual(ReplyLinePlacement.clamped(CGRect(x: 1200, y: 850, width: 580, height: 80), in: visible).origin, CGPoint(x: 860, y: 790))
        XCTAssertEqual(ReplyLinePlacement.clamped(CGRect(x: 300, y: 400, width: 580, height: 80), in: visible).origin, CGPoint(x: 300, y: 400))
        // Too big for an axis: centred on it.
        XCTAssertEqual(ReplyLinePlacement.clamped(CGRect(x: 0, y: 400, width: 2000, height: 80), in: visible).midX, visible.midX)
        // Let go half off the foot of the screen, into the Dock: it settles wholly above it, and that is what is kept.
        let rest = ReplyLinePlacement.released(CGRect(x: -200, y: 10, width: 580, height: 80), screens: [laptop, studio], pointer: CGPoint(x: 40, y: 50), measure: 580)
        XCTAssertEqual(rest?.placed.frame.origin, CGPoint(x: 0, y: 70))
        XCTAssertEqual(rest?.spot?.across, 0)
        XCTAssertEqual(rest?.spot?.up, 0)
        for (across, up) in [(1.7, -3.0), (Double.nan, Double.infinity), (-0.2, 1.2)] {
            let frame = ReplyLinePlacement.frame(of: ReplyLineSpot(screen: "A", across: across, up: up), size: CGSize(width: 580, height: 80), in: visible)
            assertInside(frame, visible, "\(across) \(up)")
        }
        XCTAssertEqual(ReplyLinePlacement.frame(of: ReplyLineSpot(screen: "A", across: .nan, up: 0), size: CGSize(width: 580, height: 80), in: visible).midX, visible.midX)
    }

    /// Its screen gone (the display unplugged): bottom centre of the screen with the pointer, else the main one. The spot
    /// is not forgotten: plugged back in, it is there again.
    func testWithItsScreenGoneItGoesToThePointersScreenOrTheMainOne() {
        let spot = ReplyLineSpot(screen: "C", across: 0.1, up: 0.9)
        let pointer = placed(spot: spot, home: "A", pointer: CGPoint(x: 2000, y: 500))
        XCTAssertEqual(pointer?.screen, "B")
        XCTAssertEqual(pointer?.frame, CGRect(x: 2110, y: 24, width: 580, height: 80))
        XCTAssertEqual(placed(spot: spot, home: "B", pointer: nil, main: "A")?.screen, "A")
        XCTAssertEqual(placed(spot: spot, home: nil, pointer: CGPoint(x: -5000, y: 0), main: nil)?.screen, "A")
        XCTAssertNil(placed(spot: spot, screens: []))
        let display = ReplyLinePlacement.Screen(id: "C", frame: CGRect(x: -1920, y: 0, width: 1920, height: 1080), visible: CGRect(x: -1920, y: 0, width: 1920, height: 1055))
        XCTAssertEqual(placed(spot: spot, screens: [laptop, studio, display], pointer: CGPoint(x: 2000, y: 500))?.screen, "C")
    }

    /// While it shows, it stays on the screen it is on: conch steering Terminal forward on another display (which moves
    /// the main screen) or the pointer wandering over there never moves it (#446's steering, which holds it in place).
    /// With no spot and nowhere yet, it starts on the panel's screen.
    func testItStaysOnItsScreenWhileItShows() {
        let steady = placed(current: "A", home: "A", pointer: CGPoint(x: 2000, y: 500), main: "B")
        XCTAssertEqual(steady, placed(current: "A", home: "A", pointer: nil, main: "A"))
        XCTAssertEqual(steady?.screen, "A")
        // A spot whose screen is gone: where it went, it stays.
        let gone = ReplyLineSpot(screen: "C", across: 0.1, up: 0.9)
        XCTAssertEqual(placed(spot: gone, current: "A", pointer: CGPoint(x: 2000, y: 500), main: "B")?.screen, "A")
        // Starting out: the panel's screen over the pointer's and the main one.
        XCTAssertEqual(placed(current: nil, home: "B", pointer: CGPoint(x: 40, y: 40), main: "A")?.screen, "B")
        XCTAssertEqual(placed(current: nil, home: nil, pointer: CGPoint(x: 2000, y: 40), main: "A")?.screen, "B")
        XCTAssertEqual(placed(current: nil, home: nil, pointer: nil, main: "B")?.screen, "B")
    }

    /// Let go within `snap` of bottom centre, it goes home and nothing is remembered; further off, it stays where it came
    /// to rest and that is the spot.
    func testLetGoNearBottomCentreItSnapsHome() {
        XCTAssertEqual(ReplyLinePlacement.snap, 12)
        let home = CGRect(x: 430, y: 94, width: 580, height: 80)
        func letGo(dx: CGFloat, dy: CGFloat) -> (placed: ReplyLinePlacement.Placed, spot: ReplyLineSpot?)? {
            ReplyLinePlacement.released(home.offsetBy(dx: dx, dy: dy), screens: [laptop, studio], pointer: nil, measure: 580)
        }
        for (dx, dy) in [(0.0, 0.0), (8.0, 8.0), (12.0, 0.0), (0.0, -12.0), (-11.9, 0.0)] as [(CGFloat, CGFloat)] {
            let rest = letGo(dx: dx, dy: dy)
            XCTAssertEqual(rest?.placed.frame, home, "\(dx), \(dy)")
            XCTAssertNil(rest?.spot, "\(dx), \(dy)")
        }
        for (dx, dy) in [(12.5, 0.0), (9.0, 9.0), (0.0, 40.0), (-300.0, 200.0)] as [(CGFloat, CGFloat)] {
            let rest = letGo(dx: dx, dy: dy)
            XCTAssertEqual(rest?.placed.frame, home.offsetBy(dx: dx, dy: dy), "\(dx), \(dy)")
            XCTAssertNotNil(rest?.spot, "\(dx), \(dy)")
            // What is kept puts it exactly back where it rested.
            if let spot = rest?.spot {
                let again = ReplyLinePlacement.frame(of: spot, size: home.size, in: laptop.visible)
                XCTAssertEqual(again.minX, home.minX + dx, accuracy: 0.0001)
                XCTAssertEqual(again.minY, home.minY + dy, accuracy: 0.0001)
            }
        }
        // Home on the other display, when let go near its bottom centre.
        let over = ReplyLinePlacement.released(CGRect(x: 2115, y: 30, width: 580, height: 80), screens: [laptop, studio], pointer: nil, measure: 580)
        XCTAssertEqual(over?.placed.frame, CGRect(x: 2110, y: 24, width: 580, height: 80))
        XCTAssertEqual(over?.placed.screen, "B")
        XCTAssertNil(over?.spot)
    }

    /// Let go across displays, it belongs to the one under its middle, then the pointer's, then the one it covers most,
    /// and takes that one's width.
    func testLetGoItBelongsToTheScreenUnderIt() {
        let straddling = ReplyLinePlacement.released(CGRect(x: 1300, y: 400, width: 580, height: 80), screens: [laptop, studio], pointer: CGPoint(x: 100, y: 100), measure: 580)
        XCTAssertEqual(straddling?.placed.screen, "B")
        XCTAssertEqual(straddling?.spot?.screen, "B")
        assertInside(straddling!.placed.frame, studio.visible)
        // Its middle off every display: the pointer's.
        let off = ReplyLinePlacement.released(CGRect(x: -600, y: 400, width: 580, height: 80), screens: [laptop, studio], pointer: CGPoint(x: 1500, y: 100), measure: 580)
        XCTAssertEqual(off?.placed.screen, "B")
        // Nor the pointer: the one it covers most.
        let most = ReplyLinePlacement.released(CGRect(x: -500, y: 400, width: 580, height: 80), screens: [laptop, studio], pointer: nil, measure: 580)
        XCTAssertEqual(most?.placed.screen, "A")
        let narrow = ReplyLinePlacement.Screen(id: "N", frame: CGRect(x: 0, y: -400, width: 500, height: 400), visible: CGRect(x: 0, y: -400, width: 500, height: 400))
        let onto = ReplyLinePlacement.released(CGRect(x: 0, y: -300, width: 580, height: 80), screens: [laptop, narrow], pointer: nil, measure: 580)
        XCTAssertEqual(onto?.placed.frame.width, 452)
        assertInside(onto!.placed.frame, narrow.visible)
    }

    /// A press that barely moves is a click: nothing moves and nothing is remembered.
    func testAClickIsNotAMove() {
        XCTAssertEqual(ReplyLinePlacement.wobble, 4)
        XCTAssertFalse(ReplyLinePlacement.isMove(from: .zero, to: CGPoint(x: 3, y: 0)))
        XCTAssertFalse(ReplyLinePlacement.isMove(from: .zero, to: CGPoint(x: 4, y: 0)))
        XCTAssertFalse(ReplyLinePlacement.isMove(from: CGPoint(x: 10, y: 10), to: CGPoint(x: 12, y: 13)))
        XCTAssertTrue(ReplyLinePlacement.isMove(from: .zero, to: CGPoint(x: 4.1, y: 0)))
        XCTAssertTrue(ReplyLinePlacement.isMove(from: .zero, to: CGPoint(x: 3, y: 3)))
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
                replyLine: replyLine, replyLineAlone: alone, drawing: false, ready: [], working: [], overlays: true
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
