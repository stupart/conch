import ConchDesign
import CoreGraphics
import XCTest

/// An agent's real input in conch's browser (ConchDesign `WorkbenchInput`): which key types which character, how fast,
/// the pointer's path, Tyler's hand first, and the window a page is told it is in.
final class WorkbenchInputTests: XCTestCase {
    /// Each character a US keyboard has is its key, Shift held for a capital or a symbol, so the page reads the `key` and
    /// `code` a person's typing gives (`H` on KeyH with Shift, `@` on Digit2 with Shift).
    func testACharacterIsTheKeyThatTypesIt() {
        XCTAssertEqual(WorkbenchInput.strokes(for: "Hi @x.io", singleLine: true), [
            .key(character: "H", unshifted: "h", keyCode: 4, shift: true),
            .key(character: "i", unshifted: "i", keyCode: 34, shift: false),
            .key(character: " ", unshifted: " ", keyCode: 49, shift: false),
            .key(character: "@", unshifted: "2", keyCode: 19, shift: true),
            .key(character: "x", unshifted: "x", keyCode: 7, shift: false),
            .key(character: ".", unshifted: ".", keyCode: 47, shift: false),
            .key(character: "i", unshifted: "i", keyCode: 34, shift: false),
            .key(character: "o", unshifted: "o", keyCode: 31, shift: false),
        ])
        XCTAssertEqual(WorkbenchInput.strokes(for: "7?", singleLine: true), [
            .key(character: "7", unshifted: "7", keyCode: 26, shift: false),
            .key(character: "?", unshifted: "/", keyCode: 44, shift: true),
        ])
    }

    /// What no key types goes in as an input method commits it; a line break is text in a text area, never Return (a chat
    /// box takes Return for send), and left out of a one-line field, which would drop it anyway.
    func testWhatNoKeyTypesIsText() {
        XCTAssertEqual(WorkbenchInput.strokes(for: "é🙂\t", singleLine: true), [.text("é"), .text("🙂"), .text("\t")])
        XCTAssertEqual(WorkbenchInput.strokes(for: "a\nb", singleLine: false), [
            .key(character: "a", unshifted: "a", keyCode: 0, shift: false), .text("\n"), .key(character: "b", unshifted: "b", keyCode: 11, shift: false),
        ])
        XCTAssertEqual(WorkbenchInput.strokes(for: "a\r\nb", singleLine: true), [
            .key(character: "a", unshifted: "a", keyCode: 0, shift: false), .key(character: "b", unshifted: "b", keyCode: 11, shift: false),
        ])
    }

    /// A long text is pressed key by key for its first `keyedMax`, and the rest goes in at once, as a paste would: the
    /// whole of it, in order, within the command's time.
    func testALongTextIsPressedThenPutInAtOnce() {
        let text = String(repeating: "ab", count: 150)
        let strokes = WorkbenchInput.budgeted(WorkbenchInput.strokes(for: text, singleLine: true))
        XCTAssertEqual(strokes.count, WorkbenchInput.keyedMax + 1)
        XCTAssertEqual(strokes.last, .text(String(text.dropFirst(WorkbenchInput.keyedMax))))
        let short = WorkbenchInput.strokes(for: "short", singleLine: true)
        XCTAssertEqual(WorkbenchInput.budgeted(short), short)
    }

    /// A typist's pace for a short text, quicker for a long one so it stays near `typingTime`, never quicker than
    /// `fastestGap`; and every gap a little uneven.
    func testThePaceIsATypistsAndStaysInsideTheCommandsTime() {
        XCTAssertEqual(WorkbenchInput.keyGap(count: 8), WorkbenchInput.slowestGap)
        XCTAssertEqual(WorkbenchInput.keyGap(count: 120), WorkbenchInput.typingTime / 120, accuracy: 0.0001)
        XCTAssertEqual(WorkbenchInput.keyGap(count: 10_000), WorkbenchInput.fastestGap)
        XCTAssertLessThanOrEqual(Double(WorkbenchInput.keyedMax) * WorkbenchInput.keyGap(count: WorkbenchInput.keyedMax) * 1.3, 4)
        XCTAssertEqual(WorkbenchInput.jittered(0.1, unit: 0), 0.07, accuracy: 0.0001)
        XCTAssertEqual(WorkbenchInput.jittered(0.1, unit: 1), 0.13, accuracy: 0.0001)
        XCTAssertEqual(WorkbenchInput.jittered(0.1, unit: 7), 0.13, accuracy: 0.0001)
    }

    /// The pointer comes from where it last was, else from towards the middle of the page, along a bowed, eased path
    /// that ends on the spot exactly.
    func testThePointerTravelsToTheSpot() {
        let size = CGSize(width: 1000, height: 800)
        XCTAssertEqual(WorkbenchInput.pointerStart(towards: CGPoint(x: 900, y: 700), last: CGPoint(x: 10, y: 20), in: size), CGPoint(x: 10, y: 20))
        let start = WorkbenchInput.pointerStart(towards: CGPoint(x: 900, y: 700), last: nil, in: size)
        XCTAssertLessThan(start.x, 900)
        XCTAssertLessThan(start.y, 700)
        XCTAssertTrue(CGRect(origin: .zero, size: size).contains(start))
        // A pointer left outside the page (it was resized) starts again from the middle's way.
        XCTAssertNotEqual(WorkbenchInput.pointerStart(towards: CGPoint(x: 100, y: 100), last: CGPoint(x: 5_000, y: 10), in: size), CGPoint(x: 5_000, y: 10))

        let path = WorkbenchInput.path(from: CGPoint(x: 0, y: 0), to: CGPoint(x: 300, y: 0), steps: 10)
        XCTAssertEqual(path.count, 10)
        XCTAssertEqual(path.last, CGPoint(x: 300, y: 0))
        XCTAssertTrue(zip(path, path.dropFirst()).allSatisfy { $0.x <= $1.x }, "it never goes back")
        XCTAssertTrue(path.dropLast().contains { abs($0.y) > 1 }, "it bows a little, as a hand does")
        XCTAssertTrue(WorkbenchInput.path(from: CGPoint(x: 5, y: 5), to: CGPoint(x: 5, y: 5), steps: 8).isEmpty)
        XCTAssertEqual(WorkbenchInput.pathSteps(from: .zero, to: CGPoint(x: 10, y: 0)), 6)
        XCTAssertEqual(WorkbenchInput.pathSteps(from: .zero, to: CGPoint(x: 5_000, y: 0)), 18)
    }

    /// A spot the page measured is the view's at the page's zoom, and only inside the view.
    func testASpotIsInTheViewsPoints() {
        let size = CGSize(width: 800, height: 600)
        XCTAssertEqual(WorkbenchInput.viewPoint(css: [100, 50], scale: 1.25, in: size), CGPoint(x: 125, y: 62.5))
        XCTAssertNil(WorkbenchInput.viewPoint(css: [700, 50], scale: 1.25, in: size))
        XCTAssertNil(WorkbenchInput.viewPoint(css: [-1, 50], scale: 1, in: size))
        XCTAssertNil(WorkbenchInput.viewPoint(css: [1], scale: 1, in: size))
        XCTAssertNil(WorkbenchInput.viewPoint(css: [.nan, 1], scale: 1, in: size))
    }

    /// Tyler's hand in a page comes first: within `handQuiet` of his last touch there, an agent's input waits.
    func testTylersHandComesFirst() {
        let now = Date(timeIntervalSince1970: 1_000)
        XCTAssertFalse(WorkbenchInput.handIsIn(lastTouch: nil, now: now))
        XCTAssertTrue(WorkbenchInput.handIsIn(lastTouch: now.addingTimeInterval(-0.4), now: now))
        XCTAssertFalse(WorkbenchInput.handIsIn(lastTouch: now.addingTimeInterval(-WorkbenchInput.handQuiet), now: now))
    }

    /// 2026-11-11, measured: with nobody answering WebKit's question, a page read `outerWidth` and `outerHeight` 0, the
    /// headless tell. Shown, a page is told conch's window; parked, conch's window again, or a laptop's browser window in
    /// the middle of the screen, never the parking window off every screen; and never a window smaller than the page.
    func testAPageIsToldARealWindow() {
        let page = CGSize(width: 1280, height: 860)
        let screen = CGRect(x: 0, y: 0, width: 1728, height: 1080)
        let shown = CGRect(x: 100, y: 80, width: 1500, height: 950)
        XCTAssertEqual(WorkbenchInput.reportedWindowFrame(page: CGSize(width: 700, height: 800), hosting: shown, parked: false, dashboard: nil, screen: screen), shown)
        let dashboard = CGRect(x: 40, y: 60, width: 1440, height: 900)
        let parked = WorkbenchInput.reportedWindowFrame(page: page, hosting: CGRect(x: -30_000, y: -30_000, width: 1280, height: 860), parked: true, dashboard: dashboard, screen: screen)
        XCTAssertEqual(parked.origin, dashboard.origin)
        XCTAssertGreaterThanOrEqual(parked.width, page.width)
        XCTAssertGreaterThan(parked.height, page.height, "room for a title bar: outer is never inner")
        let alone = WorkbenchInput.reportedWindowFrame(page: page, hosting: nil, parked: true, dashboard: nil, screen: screen)
        XCTAssertTrue(screen.contains(alone))
        XCTAssertGreaterThan(alone.height, page.height)
        XCTAssertEqual(alone.midX, screen.midX, accuracy: 1)
        // A small conch window still holds the page it reports.
        let small = WorkbenchInput.reportedWindowFrame(page: page, hosting: nil, parked: true, dashboard: CGRect(x: 0, y: 0, width: 900, height: 600), screen: screen)
        XCTAssertGreaterThanOrEqual(small.width, page.width)
        XCTAssertGreaterThan(small.height, page.height)
    }
}
