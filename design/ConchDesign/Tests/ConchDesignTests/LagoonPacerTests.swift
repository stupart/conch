import XCTest
@testable import ConchDesign

/// When the lagoon is handed a snapshot (LagoonPacer.swift): after `ready`, only a newer `ts`, at most four a second with the
/// latest winning, and never while it can't be seen; and when an unseen lagoon lets its web view go.
final class LagoonPacerTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)
    private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

    private func sent(_ step: LagoonPacer<String>.Step) -> String? {
        if case let .send(value) = step { return value }
        return nil
    }

    private func wait(_ step: LagoonPacer<String>.Step) -> TimeInterval? {
        if case let .later(seconds) = step { return seconds }
        return nil
    }

    private func readyAndVisible() -> LagoonPacer<String> {
        var pacer = LagoonPacer<String>()
        _ = pacer.visible(true, now: t0)
        _ = pacer.ready(now: t0)
        return pacer
    }

    func testNothingBeforeReadyThenTheLatestAtOnce() {
        var pacer = LagoonPacer<String>()
        XCTAssertNil(sent(pacer.visible(true, now: at(0))))
        XCTAssertNil(sent(pacer.offer("a", ts: 1, now: at(0.1))), "the page would drop it")
        XCTAssertNil(sent(pacer.offer("b", ts: 2, now: at(0.2))))
        XCTAssertEqual(sent(pacer.ready(now: at(3))), "b", "ready is answered with the latest")
    }

    func testOnlyWhenTsAdvances() {
        var pacer = readyAndVisible()
        XCTAssertEqual(sent(pacer.offer("a", ts: 10, now: at(1))), "a")
        XCTAssertNil(sent(pacer.offer("a again", ts: 10, now: at(2))))
        XCTAssertNil(sent(pacer.offer("older", ts: 9, now: at(3))))
        XCTAssertEqual(sent(pacer.offer("b", ts: 11, now: at(4))), "b")
    }

    func testCoalescedToFourASecondTheLatestWinning() {
        var pacer = readyAndVisible()
        XCTAssertEqual(sent(pacer.offer("1", ts: 1, now: at(1.00))), "1")
        // Three more inside the quarter second: each is held, and replaced by the next.
        XCTAssertEqual(try XCTUnwrap(wait(pacer.offer("2", ts: 2, now: at(1.05)))), 0.20, accuracy: 1e-6)
        XCTAssertEqual(try XCTUnwrap(wait(pacer.offer("3", ts: 3, now: at(1.10)))), 0.15, accuracy: 1e-6)
        XCTAssertEqual(try XCTUnwrap(wait(pacer.offer("4", ts: 4, now: at(1.20)))), 0.05, accuracy: 1e-6)
        XCTAssertNotNil(wait(pacer.tick(now: at(1.24))), "not yet")
        XCTAssertEqual(sent(pacer.tick(now: at(1.25))), "4", "only the latest goes")
        XCTAssertNil(sent(pacer.tick(now: at(1.6))), "and once")
        // Over a busy second, never more than four.
        var count = 0
        var paced = readyAndVisible()
        for step in 0..<100 {
            let now = at(10 + Double(step) * 0.01)
            if sent(paced.offer("x\(step)", ts: Double(100 + step), now: now)) != nil { count += 1 }
            if sent(paced.tick(now: now)) != nil { count += 1 }
        }
        XCTAssertLessThanOrEqual(count, 4)
        XCTAssertGreaterThanOrEqual(count, 3)
    }

    func testNotWhileHiddenAndTheLatestOnBeingSeenAgain() {
        var pacer = readyAndVisible()
        XCTAssertEqual(sent(pacer.offer("a", ts: 1, now: at(1))), "a")
        XCTAssertNil(sent(pacer.visible(false, now: at(2))))
        XCTAssertNil(sent(pacer.offer("b", ts: 2, now: at(3))), "hidden: not drawing, not sent")
        XCTAssertNil(sent(pacer.offer("c", ts: 3, now: at(4))))
        XCTAssertNil(sent(pacer.tick(now: at(5))))
        XCTAssertEqual(sent(pacer.visible(true, now: at(6))), "c", "the latest, on being seen")
        // Seen again with nothing new: nothing to send, the page has it.
        _ = pacer.visible(false, now: at(7))
        XCTAssertNil(sent(pacer.visible(true, now: at(8))))
    }

    func testANewPageStartsFromNothing() {
        var pacer = readyAndVisible()
        XCTAssertEqual(sent(pacer.offer("a", ts: 1, now: at(1))), "a")
        pacer.pageGone()
        XCTAssertFalse(pacer.isReady)
        XCTAssertNil(sent(pacer.offer("b", ts: 2, now: at(2))), "no page to take it")
        XCTAssertEqual(sent(pacer.ready(now: at(6))), "b", "the rebuilt page gets the latest")
        // A reload of the same page (ready again) gets it too, though it had been sent.
        XCTAssertEqual(sent(pacer.ready(now: at(9))), "b")
    }

    func testVisibleMeansThePageTheWindowAndTheApp() {
        XCTAssertTrue(LagoonVisibility(pageCurrent: true, windowVisible: true, appHidden: false).visible)
        XCTAssertFalse(LagoonVisibility(pageCurrent: false, windowVisible: true, appHidden: false).visible)
        XCTAssertFalse(LagoonVisibility(pageCurrent: true, windowVisible: false, appHidden: false).visible)
        XCTAssertFalse(LagoonVisibility(pageCurrent: true, windowVisible: true, appHidden: true).visible)
    }

    func testTheWebViewGoesAfterTenMinutesUnseen() {
        XCTAssertFalse(LagoonVisibility.shouldDrop(hiddenSince: nil, now: at(10_000)))
        XCTAssertFalse(LagoonVisibility.shouldDrop(hiddenSince: at(0), now: at(599)))
        XCTAssertTrue(LagoonVisibility.shouldDrop(hiddenSince: at(0), now: at(600)))
    }
}
