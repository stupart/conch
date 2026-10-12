import CoreGraphics
import XCTest
@testable import ConchDesign

/// Zoom on a deliverable: the steps ⌘+ and ⌘− take, how far each kind goes, where a pinch settles, what a double-click
/// toggles between, where the view scrolls to keep the point under the pointer still, and which deliverable the keys
/// zoom.
final class ContentZoomTests: XCTestCase {
    private let picture = ContentZoom.picture
    private let page = ContentZoom.page

    private func scale(_ level: ZoomLevel?, file: StaticString = #filePath, line: UInt = #line) -> CGFloat? {
        guard case let .scale(scale) = level else { return nil }
        return scale
    }

    // MARK: Steps

    func testAFittedPictureStepsOutOfFitAndBackThroughIt() {
        // A wide screenshot fitted at 53%: in to the next step above, out to the next below, and back through Fit.
        XCTAssertEqual(picture.stepped(1, from: .rest, resting: 0.53), .scale(0.67))
        XCTAssertEqual(picture.stepped(-1, from: .rest, resting: 0.53), .scale(0.5))
        XCTAssertEqual(picture.stepped(-1, from: .scale(0.67), resting: 0.53), .rest)
        XCTAssertEqual(picture.stepped(1, from: .scale(0.5), resting: 0.53), .rest)
        // Up the ladder to 100% and on.
        var level = ZoomLevel.rest
        var seen: [CGFloat] = []
        for _ in 0..<6 {
            level = picture.stepped(1, from: level, resting: 0.53)
            seen.append(level.scale(resting: 0.53))
        }
        XCTAssertEqual(seen, [0.67, 0.75, 0.8, 0.9, 1, 1.1])
        // A step that would barely move from fitted gives way to it: from 66%, in is 75%, and back out is Fit.
        XCTAssertEqual(picture.stepped(1, from: .rest, resting: 0.66), .scale(0.75))
        XCTAssertEqual(picture.stepped(-1, from: .scale(0.75), resting: 0.66), .rest)
        XCTAssertEqual(picture.stepped(-1, from: .rest, resting: 0.66), .scale(0.5))
    }

    func testAPageStepsLikeABrowserAndStopsAtItsEnds() {
        XCTAssertEqual(page.stepped(1, from: .rest, resting: 1), .scale(1.1))
        XCTAssertEqual(page.stepped(-1, from: .rest, resting: 1), .scale(0.9))
        XCTAssertEqual(page.stepped(-1, from: .scale(1.1), resting: 1), .rest)
        // At the ends it stays where it is: Safari's 300% and 50%.
        XCTAssertEqual(page.stepped(1, from: .scale(3), resting: 1), .scale(3))
        XCTAssertEqual(page.stepped(-1, from: .scale(0.5), resting: 1), .scale(0.5))
        // A pinch left between steps goes on to the next one, not back to the one it passed.
        XCTAssertEqual(page.stepped(1, from: .scale(1.3), resting: 1), .scale(1.5))
        XCTAssertEqual(page.stepped(-1, from: .scale(1.3), resting: 1), .scale(1.25))
    }

    func testAPictureGoesFromATenthTo800PercentAndFittedIsAlwaysInReach() {
        XCTAssertEqual(picture.stepped(1, from: .scale(8), resting: 0.4), .scale(8))
        XCTAssertEqual(picture.stepped(-1, from: .scale(0.1), resting: 0.4), .scale(0.1))
        // A 20,000-point panorama fits a pane at 3%: still reachable, by ⌘0 and by stepping out.
        XCTAssertEqual(picture.range(resting: 0.03), 0.03...8)
        XCTAssertEqual(picture.stepped(-1, from: .scale(0.1), resting: 0.03), .rest)
        XCTAssertEqual(picture.clamped(0.01, resting: 0.03), 0.03)
        XCTAssertEqual(picture.clamped(20, resting: 0.5), 8)
        XCTAssertEqual(picture.clamped(.nan, resting: 0.5), 0.5)
    }

    func testResetIsAlwaysBackToWhereItOpened() {
        XCTAssertEqual(picture.level(after: .reset, from: .scale(3), resting: 0.5), .rest)
        XCTAssertEqual(page.level(after: .reset, from: .scale(0.75), resting: 1), .rest)
        XCTAssertEqual(picture.level(after: .zoomIn, from: .rest, resting: 0.5), .scale(0.67))
        XCTAssertEqual(picture.level(after: .zoomOut, from: .rest, resting: 0.5), .scale(0.33))
    }

    // MARK: Pinch

    func testAPinchScalesWhereItIsAndSettlesOnFitOr100Percent() {
        let pinched = picture.pinched(.rest, by: 0.5, resting: 0.4)
        XCTAssertEqual(scale(pinched)!, 0.6, accuracy: 0.0001)
        // Never rest mid-pinch, even back on fitted…
        XCTAssertEqual(picture.pinched(.rest, by: 0, resting: 0.4), .scale(0.4))
        // …which is where it lands when the fingers lift near it.
        XCTAssertEqual(picture.settled(.scale(0.41), resting: 0.4), .rest)
        XCTAssertEqual(picture.settled(.scale(0.98), resting: 0.4), .scale(1))
        XCTAssertEqual(picture.settled(.scale(1.03), resting: 0.4), .scale(1))
        XCTAssertEqual(picture.settled(.scale(0.8), resting: 0.4), .scale(0.8))
        XCTAssertEqual(picture.settled(.rest, resting: 0.4), .rest)
        // Clamped as it goes.
        XCTAssertEqual(picture.pinched(.scale(7), by: 1, resting: 0.4), .scale(8))
        XCTAssertEqual(page.pinched(.scale(0.6), by: -0.5, resting: 1), .scale(0.5))
    }

    // MARK: Toggle

    func testADoubleClickGoesBetweenFitAnd100PercentOr200() {
        // Bigger than the pane: fitted ↔ its own size.
        XCTAssertEqual(picture.toggled(from: .rest, resting: 0.53), .scale(1))
        // Already at its own size when fitted (a small picture, never upscaled): fitted ↔ 200%.
        XCTAssertEqual(picture.toggled(from: .rest, resting: 1), .scale(2))
        XCTAssertEqual(picture.toggled(from: .rest, resting: 0.98), .scale(2))
        // Anywhere else: back to fitted.
        XCTAssertEqual(picture.toggled(from: .scale(1), resting: 0.53), .rest)
        XCTAssertEqual(picture.toggled(from: .scale(3.5), resting: 0.53), .rest)
        // A page rests at 100%, so at rest a toggle has nowhere to go; zoomed, it goes back.
        XCTAssertNil(page.toggled(from: .rest, resting: 1))
        XCTAssertEqual(page.toggled(from: .scale(1.5), resting: 1), .rest)
        XCTAssertNil(page.level(after: .toggle, from: .rest, resting: 1))
    }

    // MARK: Readout

    func testTheControlSaysFitAtRestAndThePercentOtherwise() {
        let fitted = picture.readout(.rest, resting: 0.53)
        XCTAssertEqual(fitted.label, "Fit")
        XCTAssertTrue(fitted.isAtRest)
        XCTAssertTrue(fitted.canToggle)
        XCTAssertEqual(fitted.toggleHelp, "Zoom to 100%")
        XCTAssertEqual(fitted.spoken, "Fitted, 53%")
        XCTAssertEqual(picture.readout(.rest, resting: 1).toggleHelp, "Zoom to 200%")

        let zoomed = picture.readout(.scale(2.5), resting: 0.53)
        XCTAssertEqual(zoomed.label, "250%")
        XCTAssertFalse(zoomed.isAtRest)
        XCTAssertEqual(zoomed.toggleHelp, "Zoom to fit (⌘0)")

        // A page at rest reads 100%, and its middle does nothing there.
        let resting = page.readout(.rest, resting: 1)
        XCTAssertEqual(resting.label, "100%")
        XCTAssertFalse(resting.canToggle)
        XCTAssertEqual(page.readout(.scale(1.25), resting: 1).toggleHelp, "Back to 100% (⌘0)")

        // The ends grey out at the ends of the range.
        XCTAssertFalse(picture.readout(.scale(8), resting: 0.5).canZoomIn)
        XCTAssertTrue(picture.readout(.scale(8), resting: 0.5).canZoomOut)
        XCTAssertFalse(page.readout(.scale(0.5), resting: 1).canZoomOut)
        XCTAssertEqual(ZoomReadout.percent(0.666), "67%")
    }

    // MARK: Anchor

    func testZoomingKeepsThePointUnderThePointerWhereItWas() {
        // A 400 x 300 picture in an 18 point margin, shown whole in a 436 x 336 view, doubled about its middle.
        let before = CGRect(x: 18, y: 18, width: 400, height: 300)
        let after = CGRect(x: 18, y: 18, width: 800, height: 600)
        let origin = ZoomAnchor.origin(
            keeping: CGPoint(x: 218, y: 168), visibleOrigin: .zero, from: before, to: after,
            document: CGSize(width: 836, height: 636), visible: CGSize(width: 436, height: 336)
        )
        XCTAssertEqual(origin, CGPoint(x: 200, y: 150))
        // The middle of the picture is now 418, 318 in the document, and on screen still at 218, 168.
        XCTAssertEqual(after.minX + 0.5 * after.width - origin.x, 218)
        XCTAssertEqual(after.minY + 0.5 * after.height - origin.y, 168)
    }

    func testAPointNearAnEdgeScrollsOnlyAsFarAsThereIsDocument() {
        let before = CGRect(x: 18, y: 18, width: 400, height: 300)
        let after = CGRect(x: 18, y: 18, width: 800, height: 600)
        // About the picture's top left corner: the document's own corner stays put.
        XCTAssertEqual(ZoomAnchor.origin(
            keeping: CGPoint(x: 18, y: 18), visibleOrigin: .zero, from: before, to: after,
            document: CGSize(width: 836, height: 636), visible: CGSize(width: 436, height: 336)
        ), .zero)
        // About its bottom right: scrolled to the end, never past it.
        XCTAssertEqual(ZoomAnchor.origin(
            keeping: CGPoint(x: 436, y: 336), visibleOrigin: .zero, from: before, to: after,
            document: CGSize(width: 836, height: 636), visible: CGSize(width: 436, height: 336)
        ), CGPoint(x: 400, y: 300))
        // Zoomed back out, smaller than the view: nowhere to scroll.
        XCTAssertEqual(ZoomAnchor.origin(
            keeping: CGPoint(x: 500, y: 400), visibleOrigin: CGPoint(x: 300, y: 250), from: after, to: before,
            document: CGSize(width: 436, height: 336), visible: CGSize(width: 436, height: 336)
        ), .zero)
    }

    // MARK: Aim

    func testTheKeysZoomTheDeliverableUnderThePointerElseTheOneLastTouchedElseTheBiggest() {
        let left = CGRect(x: 0, y: 0, width: 300, height: 400)
        let right = CGRect(x: 312, y: 0, width: 400, height: 400)
        let earlier = Date(timeIntervalSince1970: 100)
        let later = Date(timeIntervalSince1970: 200)
        XCTAssertEqual(ZoomAim.pick([(left, later), (right, nil)], pointer: CGPoint(x: 400, y: 200)), 1)
        XCTAssertEqual(ZoomAim.pick([(left, later), (right, earlier)], pointer: CGPoint(x: 900, y: 900)), 0)
        XCTAssertEqual(ZoomAim.pick([(left, nil), (right, nil)], pointer: CGPoint(x: 900, y: 900)), 1)
        XCTAssertNil(ZoomAim.pick([], pointer: .zero))
    }

    func testTheZoomKeys() {
        func action(_ characters: String?, keyCode: UInt16 = 0, command: Bool = true, control: Bool = false, option: Bool = false) -> ZoomAction? {
            ZoomAim.action(characters: characters, keyCode: keyCode, command: command, control: control, option: option)
        }
        XCTAssertEqual(action("="), .zoomIn)
        XCTAssertEqual(action("+"), .zoomIn) // ⌘⇧= on a US keyboard, and its own key on others
        XCTAssertEqual(action("-"), .zoomOut)
        XCTAssertEqual(action("0"), .reset)
        XCTAssertEqual(action(nil, keyCode: 69), .zoomIn)
        XCTAssertEqual(action(nil, keyCode: 78), .zoomOut)
        XCTAssertEqual(action(nil, keyCode: 82), .reset)
        XCTAssertNil(action("=", command: false))
        XCTAssertNil(action("=", option: true))
        XCTAssertNil(action("0", control: true))
        XCTAssertNil(action("k"))
    }
}
