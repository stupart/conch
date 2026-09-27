import CoreGraphics
import XCTest
@testable import ConchDesign

/// Infinite scroll's arithmetic: when to read further back, how far a change above the reader
/// moves them, which rows are real views, what the reader holds, and what the top says.
///
/// Each of these fails as something a screenshot would show only while it was happening — a
/// jump as a page lands, a blank screen after a fling, a phone that holds every row it ever
/// scrolled past — so each is pinned here, where it can be tested without a window.
final class HistoryScrollTests: XCTestCase {
    private func slots(_ ids: [String], height: CGFloat = 100) -> [HistoryWindow.Slot] {
        ids.map { HistoryWindow.Slot(id: $0, estimate: height) }
    }

    /// Scroll there, and let the real rows finish growing to where they are going.
    @discardableResult
    private func scroll(_ window: inout HistoryWindow, top: CGFloat, height: CGFloat) -> Bool {
        var changed = window.scrolled(top: top, height: height)
        while window.target != nil { changed = window.reframe() || changed }
        return changed
    }

    /// An edge row of 30 then `count` rows of 100, named r0…
    private func window(_ count: Int, overscan: CGFloat = 2, cap: Int = 160) -> HistoryWindow {
        var window = HistoryWindow(overscan: overscan, cap: cap)
        window.set([HistoryWindow.Slot(id: "edge", estimate: 30)] + slots((0..<count).map { "r\($0)" }))
        return window
    }

    // MARK: - Prefetch

    func testTheNextPageIsAskedForWithAScreenAndAHalfStillToRead() {
        XCTAssertEqual(HistoryPrefetch.screens, 1.5)
        XCTAssertTrue(HistoryPrefetch.shouldLoadOlder(contentAbove: 1_049, viewport: 700), "1.5 screens is 1,050 pt")
        XCTAssertFalse(HistoryPrefetch.shouldLoadOlder(contentAbove: 1_050, viewport: 700))
        XCTAssertTrue(HistoryPrefetch.shouldLoadOlder(contentAbove: 0, viewport: 700), "at the top, certainly")
        XCTAssertFalse(HistoryPrefetch.shouldLoadOlder(contentAbove: 0, viewport: 0), "no viewport yet is no reason to read")
    }

    // MARK: - Keeping the reader's place

    func testAPageArrivingAboveMovesTheReaderByExactlyItsHeight() {
        var window = window(10)
        // The reader's viewport top is 40 pt into r3 (edge 30 + 3 rows + 40).
        window.scrolled(top: 30 + 300 + 40, height: 500)
        // Five older rows of 80 arrive above r0.
        let shift = window.set([HistoryWindow.Slot(id: "edge", estimate: 30)]
            + slots((0..<5).map { "o\($0)" }, height: 80) + slots((0..<10).map { "r\($0)" }))
        XCTAssertEqual(shift, 400, "everything that arrived above r3 is exactly 5 × 80")
        XCTAssertEqual(window.readerTop, 370 + 400, "the reader's place is kept in the new table's terms")
        XCTAssertEqual(window.top(of: window.anchor(readerTop: window.readerTop!)!), 30 + 400 + 300,
                       "and is still 40 pt into r3")
    }

    func testReadingTheVeryTopKeepsTheFirstMessageNotTheLineAboveIt() {
        var window = window(10)
        // Scrolled right to the top: the viewport begins inside the edge line.
        window.scrolled(top: 0, height: 500)
        let shift = window.set([HistoryWindow.Slot(id: "edge", estimate: 30)]
            + slots(["o0", "o1"], height: 80) + slots((0..<10).map { "r\($0)" }))
        XCTAssertEqual(shift, 160, "the edge never anchors: r0 stays under the eye and the page lands above it")
    }

    func testRowsMeasuredAboveTheReaderAreAbsorbedAndBelowAreNot() {
        var window = window(10)
        window.scrolled(top: 30 + 500 + 10, height: 400) // inside r5
        XCTAssertEqual(window.measure("r2", height: 160), 60, "r2 is above r5: its growth would push r5 down")
        XCTAssertEqual(window.readerTop, 600)
        XCTAssertEqual(window.measure("r5", height: 40), 0, "the row being read resizes in place")
        XCTAssertEqual(window.measure("r8", height: 300), 0, "below the reader changes nothing they can see")
        XCTAssertEqual(window.measure("r2", height: 160), 0, "the same height twice is not a change")
        XCTAssertEqual(window.measure("edge", height: 50), 20, "the edge above is content like any other")
    }

    func testReadingTheLiveTailBelowEveryRowAbsorbsEveryChangeAbove() {
        var window = window(4)
        let total = window.total
        window.scrolled(top: total + 250, height: 400)
        XCTAssertEqual(window.measure("r1", height: 20), -80)
        let shift = window.set([HistoryWindow.Slot(id: "edge", estimate: 30)] + slots(["o0"], height: 70)
            + slots((0..<4).map { "r\($0)" }))
        XCTAssertEqual(shift, 70, "the first page landing under a conversation read at its end keeps its end on screen")
    }

    func testRowsArrivingBelowTheReaderAtTheSameTimeDoNotMoveThem() {
        // A page lands above while the live window's oldest items become recorded rows below: only
        // what arrived above the row being read moves the reader.
        var window = window(10)
        window.scrolled(top: 30 + 500 + 10, height: 400) // inside r5
        let shift = window.set([HistoryWindow.Slot(id: "edge", estimate: 30)] + slots(["o0", "o1"], height: 80)
            + slots((0..<10).map { "r\($0)" }) + slots(["n0", "n1", "n2"], height: 300))
        XCTAssertEqual(shift, 160, "the 900 pt that arrived below r5 is not the reader's to absorb")
    }

    func testAFirstPageUnderAnEmptyHistoryKeepsTheLiveTailStill() {
        var window = HistoryWindow()
        window.set([HistoryWindow.Slot(id: "edge", estimate: 30)])
        window.scrolled(top: 0, height: 700) // a short conversation: everything fits
        let shift = window.set([HistoryWindow.Slot(id: "edge", estimate: 30)] + slots(["a", "b", "c"], height: 90))
        XCTAssertEqual(shift, 270, "with nothing to anchor to but furniture, what the reader sees is the live tail")
    }

    func testRowsLeavingAboveMoveTheReaderUpAndAVanishedAnchorFallsToTheNextRow() {
        var window = window(10)
        window.scrolled(top: 30 + 400 + 5, height: 300) // inside r4
        var ids = (0..<10).map { "r\($0)" }
        ids.removeFirst(2)
        XCTAssertEqual(window.set([HistoryWindow.Slot(id: "edge", estimate: 30)] + slots(ids)), -200)
        // r4 itself goes (a fold absorbing it): r5 holds the place.
        window.scrolled(top: 30 + 200 + 5, height: 300)
        ids.removeAll { $0 == "r4" }
        XCTAssertEqual(window.set([HistoryWindow.Slot(id: "edge", estimate: 30)] + slots(ids)), -100,
                       "r5 takes r4's place, 100 higher: moved up with it, r5 stays where it was on screen")
    }

    func testTheShiftIsTheMovementOfTheFirstRowStillShowing() {
        // Directly: old [a b c] at 0/100/200, reader at 150 (inside b). New [x a b c] with x 50.
        let oldIDs = ["edge", "a", "b", "c"]
        let oldTops = HistoryWindow.prefixSums([0, 100, 100, 100])
        let newIDs = ["edge", "x", "a", "b", "c"]
        let newTops = HistoryWindow.prefixSums([0, 50, 100, 100, 100])
        let index = Dictionary(uniqueKeysWithValues: newIDs.enumerated().map { ($1, $0) })
        XCTAssertEqual(HistoryWindow.shift(from: oldIDs, tops: oldTops, to: index, tops: newTops, readerTop: 150, leading: 1), 50)
        XCTAssertEqual(HistoryWindow.shift(from: oldIDs, tops: oldTops, to: index, tops: newTops, readerTop: nil, leading: 1), 50,
                       "no reader known: a conversation opens at its end, so the whole difference")
        let without = Dictionary(uniqueKeysWithValues: ["edge", "z"].enumerated().map { ($1, $0) })
        XCTAssertEqual(HistoryWindow.shift(from: oldIDs, tops: oldTops, to: without, tops: [0, 0, 10], readerTop: 150, leading: 1), 0,
                       "nothing the reader was on survives: no guess")
    }

    // MARK: - Which rows are real views

    func testOnlyRowsWithinTheOverscanAreRealAndTheRestAreOneHeightEach() {
        var window = window(1_000)
        // Reader in the middle, viewport 500: ±2 screens is 1,000 pt each side, 25 rows in all.
        scroll(&window, top: 30 + 50_000, height: 500)
        let real = window.materialised
        XCTAssertEqual(real, 491..<516)
        XCTAssertLessThan(real.count, 30, "a thousand rows, a couple of dozen views")
        XCTAssertEqual(window.above, window.top(of: real.lowerBound))
        XCTAssertEqual(window.above + (real.map { window.heights[$0] }.reduce(0, +)) + window.below, window.total,
                       "the spacers and the real rows add up to the whole: the scroll geometry is exact")
    }

    func testScrollingASmallDistanceChangesNothingAndCrossingTheSlackRecentres() {
        var window = window(1_000)
        scroll(&window, top: 30 + 50_000, height: 500)
        let before = window.materialised
        XCTAssertFalse(scroll(&window, top: 30 + 50_000 - 400, height: 500), "inside the slack: no SwiftUI update")
        XCTAssertEqual(window.materialised, before)
        XCTAssertTrue(scroll(&window, top: 30 + 50_000 - 800, height: 500), "past half the overscan: recentre")
        XCTAssertTrue(window.materialised.contains(window.rows(from: 30 + 49_200, to: 30 + 49_700).lowerBound))
    }

    func testFarRowsAreEvictedWhenTheReaderMovesAway() {
        var window = window(1_000)
        scroll(&window, top: 30 + 90_000, height: 500)
        XCTAssertTrue(window.materialised.contains(900))
        scroll(&window, top: 30 + 10_000, height: 500)
        XCTAssertFalse(window.materialised.contains(900), "a row eighty screens away is a height again")
        XCTAssertTrue(window.materialised.contains(101))
    }

    func testTheCapBoundsRealRowsButNeverBlanksAVisibleOne() {
        // Tiny rows: 2 screens each side of a 1,000 pt viewport would be 250 rows.
        var window = HistoryWindow(overscan: 2, cap: 60)
        window.set([HistoryWindow.Slot(id: "edge", estimate: 30)] + slots((0..<2_000).map { "r\($0)" }, height: 20))
        scroll(&window, top: 20_000, height: 1_000)
        XCTAssertEqual(window.materialised.count, 60, "the cap holds")
        let visible = window.rows(from: 20_000, to: 21_000)
        XCTAssertTrue(window.materialised.lowerBound <= visible.lowerBound && window.materialised.upperBound >= visible.upperBound)

        var tall = HistoryWindow(overscan: 2, cap: 10)
        tall.set([HistoryWindow.Slot(id: "edge", estimate: 30)] + slots((0..<2_000).map { "r\($0)" }, height: 20))
        scroll(&tall, top: 20_000, height: 1_000)
        XCTAssertEqual(tall.materialised, tall.rows(from: 20_000, to: 21_000),
                       "a viewport of fifty-one rows draws all fifty-one, cap or no cap")
    }

    func testARecentreBuildsTheVisibleRowsAtOnceAndTheRestAFewATurnNearestFirst() {
        var window = window(1_000)
        scroll(&window, top: 30 + 50_000, height: 500)
        // A fling lands forty screens away: nothing real there yet.
        window.scrolled(top: 30 + 30_000, height: 500)
        let visible = window.rows(from: 30 + 30_000, to: 30 + 30_500)
        XCTAssertTrue(window.materialised.lowerBound <= visible.lowerBound && window.materialised.upperBound >= visible.upperBound,
                      "what is on screen is real in the same turn: never a blank viewport")
        XCTAssertEqual(window.materialised.count, visible.count + window.growth, "and only a few more")
        XCTAssertFalse(window.materialised.contains(500), "the rows left behind go at once")
        XCTAssertNotNil(window.target)
        var turns = 0
        var previous = window.materialised
        while window.target != nil {
            window.reframe()
            XCTAssertLessThanOrEqual(window.materialised.count - previous.count, window.growth, "a few a turn")
            XCTAssertTrue(window.materialised.lowerBound <= previous.lowerBound && window.materialised.upperBound >= previous.upperBound,
                          "growing outwards from the reader, never re-centring mid-growth")
            previous = window.materialised
            turns += 1
        }
        XCTAssertEqual(window.materialised, window.rows(from: 30 + 29_000, to: 30 + 31_500), "until the overscan is real")
        XCTAssertGreaterThan(turns, 1)
    }

    func testGrowthAlternatesSidesAndPrefersBelowFirst() {
        // Below, above, below: three rows around the visible two.
        XCTAssertEqual(HistoryWindow.grow(from: 0..<0, toward: 10..<30, visible: 18..<20, by: 3), 17..<22)
        XCTAssertEqual(HistoryWindow.grow(from: 17..<22, toward: 10..<30, visible: 18..<20, by: 3), 16..<24)
        XCTAssertEqual(HistoryWindow.grow(from: 5..<40, toward: 10..<30, visible: 18..<20, by: 3), 10..<30,
                       "shrinking to the target is immediate")
    }

    func testWithNoViewportYetTheEndIsWhatIsReal() {
        var window = HistoryWindow(overscan: 2, cap: 40)
        window.set(slots((0..<500).map { "r\($0)" }))
        XCTAssertEqual(window.materialised, 460..<500, "a conversation opens at its end")
    }

    func testAPageLandingKeepsTheSameRowsReal() {
        var window = window(100)
        scroll(&window, top: 30 + 5_000, height: 500)
        let real = window.materialised.map { window.ids[$0] }
        window.set([HistoryWindow.Slot(id: "edge", estimate: 30)] + slots((0..<50).map { "o\($0)" })
            + slots((0..<100).map { "r\($0)" }))
        XCTAssertEqual(window.materialised.map { window.ids[$0] }, real,
                       "nothing on screen is rebuilt because rows arrived out of sight")
    }

    func testAReleasedRowKeepsTheHeightItWasDrawnAt() {
        var window = window(3)
        window.measure("r1", height: 240)
        // Its page is released: no content, no estimate.
        window.set([HistoryWindow.Slot(id: "edge", estimate: 30), HistoryWindow.Slot(id: "r0", estimate: 100),
                    HistoryWindow.Slot(id: "r1", estimate: nil), HistoryWindow.Slot(id: "r2", estimate: 100)])
        XCTAssertEqual(window.height(of: "r1"), 240)
        // Read again, it arrives with an estimate, and the drawn height still wins.
        window.set([HistoryWindow.Slot(id: "edge", estimate: 30)] + slots(["r0", "r1", "r2"]))
        XCTAssertEqual(window.height(of: "r1"), 240)
    }

    // MARK: - What a reader holds

    private func item(_ id: String, at: Double? = nil) -> HistoryItem { HistoryItem(id: id, at: at, preview: id) }

    private func page(_ ids: [String], previous: String?) -> HistoryPage {
        HistoryPage(items: ids.map { item($0) }, previousCursor: previous, epoch: "e")
    }

    /// A reader holding `pages` pages of `size`, oldest first, with cursors c1…
    private func reader(pages: Int, size: Int, cap: Int?) -> HistoryPaging {
        var paging = HistoryPaging(session: "s", itemCap: cap)
        for p in 0..<pages {
            let ids = (0..<size).map { "p\(p)-\($0)" }
            paging.apply(page: page(ids, previous: "c\(p + 1)"), generation: paging.beginLoad())
        }
        return paging
    }

    func testPastTheCeilingThePagesFarthestFromTheReaderAreReleasedAndKeepTheirPlace() {
        var paging = reader(pages: 6, size: 10, cap: 30)
        XCTAssertEqual(paging.items.count, 30, "held stays under the ceiling")
        XCTAssertEqual(paging.rows.count, 60, "every row keeps its place")
        XCTAssertTrue(paging.canLoadOlder, "the ceiling no longer stops the reader: the record goes further back")
        // Reading at the newest end, the oldest pages were the farthest, so they went.
        let released = paging.pages.filter(\.isReleased).map(\.cursor)
        XCTAssertEqual(released, ["c5", "c4", "c3"])
        XCTAssertNil(paging.rows.first?.item)
        XCTAssertEqual(paging.rows.last?.item?.id, "p0-9")

        // The reader scrolls up to the oldest page: the far newer pages go, the oldest come back.
        paging.focus(on: "p5-3")
        XCTAssertEqual(paging.items.count <= 30 || paging.pages.filter { !$0.isReleased }.count <= 3, true)
        let back = paging.releasedPages(holding: ["p5-3", "p5-4"])
        XCTAssertEqual(back.count, 1)
        let reread = paging.beginReread(page: back[0])
        XCTAssertEqual(reread?.cursor, "c5", "a released page is read again with the cursor it was first read with")
        XCTAssertNil(paging.beginReread(page: back[0]), "and only once at a time")
        paging.apply(reread: page((0..<10).map { "p5-\($0)" }, previous: "c6"), page: back[0], generation: reread!.generation)
        XCTAssertEqual(paging.rows.first?.item?.id, "p5-0")
        XCTAssertLessThanOrEqual(paging.items.count, 30, "and something farther from the reader went to make room")
        XCTAssertNotNil(paging.rows.last?.item, "never the newest pages, which meet the live window")
        XCTAssertEqual(paging.previousCursor, "c6", "reading the released page again moved nothing about where the record ends")
    }

    func testTheNewestTwoPagesAndTheReadersOwnAreNeverReleased() {
        var paging = reader(pages: 5, size: 10, cap: 10)
        XCTAssertTrue(paging.pages.suffix(2).allSatisfy { !$0.isReleased }, "they meet the live window")
        // The reader scrolls all the way up; the oldest page is read again under their eye.
        paging.focus(on: "p4-0")
        let oldest = paging.pages[0].id
        let reread = paging.beginReread(page: oldest)!
        paging.apply(reread: page((0..<10).map { "p4-\($0)" }, previous: nil), page: oldest, generation: reread.generation)
        XCTAssertFalse(paging.pages[0].isReleased, "the page being read is never the one let go")
        XCTAssertTrue(paging.pages.suffix(2).allSatisfy { !$0.isReleased })
        XCTAssertTrue(paging.pages[1].isReleased && paging.pages[2].isReleased, "what was between goes instead")
    }

    func testAReadAgainOfAnotherEpochStartsTheReaderAgain() {
        var paging = reader(pages: 5, size: 10, cap: 20)
        let released = paging.pages.first(where: \.isReleased)!.id
        let reread = paging.beginReread(page: released)!
        paging.apply(reread: HistoryPage(items: [item("x")], previousCursor: nil, epoch: "other"), page: released,
                     generation: reread.generation)
        XCTAssertTrue(paging.rows.isEmpty, "two epochs are never joined into one transcript")
    }

    func testAPageThatWouldNotComeBackIsAskedForAgainLater() {
        var paging = reader(pages: 5, size: 10, cap: 20)
        let released = paging.pages.first(where: \.isReleased)!.id
        let reread = paging.beginReread(page: released)!
        paging.apply(rereadFailure: .message("busy"), page: released, generation: reread.generation)
        XCTAssertEqual(paging.releasedPages(holding: Set(paging.pages.first { $0.id == released }!.ids)), [released])
    }

    func testWithoutACeilingNothingIsReleased() {
        let paging = reader(pages: 8, size: 10, cap: nil)
        XCTAssertEqual(paging.items.count, 80)
        XCTAssertFalse(paging.pages.contains(where: \.isReleased))
    }

    func testTheOldestDateOutlivesTheOldestPage() {
        var paging = HistoryPaging(session: "s", itemCap: 10)
        for p in 0..<5 {
            let items = (0..<10).map { HistoryItem(id: "p\(p)-\($0)", at: Double(1_000 - p * 10 - (10 - $0))) }
            paging.apply(page: HistoryPage(items: items, previousCursor: p == 4 ? nil : "c\(p + 1)", epoch: "e"),
                         generation: paging.beginLoad())
        }
        XCTAssertTrue(paging.pages[0].isReleased)
        XCTAssertEqual(paging.oldestAt, 950, "\"Recorded back to …\" still knows when")
    }

    func testAFailureIsKeptAndCountedUntilAReadSucceeds() {
        var paging = HistoryPaging(session: "s")
        paging.apply(failure: .message("busy"), generation: paging.beginLoad())
        paging.apply(failure: .message("busy"), generation: paging.beginLoad())
        XCTAssertEqual(paging.failures, 2)
        XCTAssertEqual(paging.lastFailure, "busy")
        XCTAssertTrue(paging.canLoadOlder, "a failed read is tried again by scrolling, not a button")
        paging.apply(page: page(["a"], previous: nil), generation: paging.beginLoad())
        XCTAssertEqual(paging.failures, 0)
        XCTAssertNil(paging.lastFailure)
    }

    // MARK: - Trying again

    func testAFailedReadIsTriedAgainAfterAPauseThatDoubles() {
        XCTAssertNil(HistoryRetry.delay(afterFailures: 0))
        XCTAssertEqual((1...6).map { HistoryRetry.delay(afterFailures: $0) }, [1, 2, 4, 8, 16, 30])
        XCTAssertNil(HistoryRetry.delay(afterFailures: 7), "then it waits for the reader to scroll to the top again")
    }

    // MARK: - What the top says

    private func edge(_ paging: HistoryPaging, whole: Bool = false, slow: Bool = false) -> HistoryEdge {
        HistoryEdge.of(paging, liveIsWhole: whole, slow: slow)
    }

    func testTheTopSaysNothingWhileMoreIsComingAndASpinnerOnlyOnceItIsSlow() {
        var paging = reader(pages: 1, size: 5, cap: nil)
        XCTAssertEqual(edge(paging), HistoryEdge(mark: .none), "more above, nothing in flight: the scroll will ask")
        paging.beginLoad()
        XCTAssertEqual(edge(paging), HistoryEdge(mark: .none), "a fast read shows nothing at all")
        XCTAssertEqual(edge(paging, slow: true), HistoryEdge(mark: .loading))
        XCTAssertEqual(HistoryEdge.slowAfter, 0.3)
    }

    func testTheTrueStartSaysSo() {
        var paging = HistoryPaging(session: "s")
        paging.apply(page: HistoryPage(items: [item("a")], previousCursor: nil, epoch: "e",
                                       coverage: HistoryCoverage(sources: 1, statuses: ["complete": 1])),
                     generation: paging.beginLoad())
        XCTAssertEqual(edge(paging), HistoryEdge(mark: .start))
        XCTAssertEqual(HistoryNotice.start, "Start of the conversation")
        XCTAssertEqual(edge(HistoryPaging(session: "t"), whole: true), HistoryEdge(mark: .start),
                       "a live window the daemon never cut is the whole conversation, whatever the record says")
    }

    func testHistoryThatIsNotThereIsSaidOncePlainly() {
        var partial = HistoryPaging(session: "s")
        partial.apply(page: HistoryPage(items: [item("a")], previousCursor: nil, epoch: "e",
                                        coverage: HistoryCoverage(sources: 1, statuses: ["complete": 1], indexedBytes: 5, observedBytes: 9)),
                      generation: partial.beginLoad())
        XCTAssertEqual(HistoryEdge.of(partial, liveIsWhole: false, slow: false, oldest: "12 Sep"),
                       HistoryEdge(mark: .none, notes: ["Recorded back to 12 Sep — anything earlier wasn't recorded."]))

        var empty = HistoryPaging(session: "s")
        empty.apply(page: HistoryPage(items: [], previousCursor: nil, epoch: "e",
                                      coverage: HistoryCoverage(sources: 1, statuses: ["complete": 1])),
                    generation: empty.beginLoad())
        XCTAssertEqual(edge(empty), HistoryEdge(mark: .none, notes: [HistoryNotice.unrecorded]))

        var indexing = HistoryPaging(session: "s")
        indexing.apply(page: HistoryPage(items: [item("a")], previousCursor: "more", epoch: "e",
                                         coverage: HistoryCoverage(sources: 1, statuses: ["indexing": 1])),
                       generation: indexing.beginLoad())
        XCTAssertEqual(edge(indexing).notes, ["Still reading this session's history — earlier messages may appear."])

        var off = HistoryPaging(session: "s")
        off.apply(failure: .off, generation: off.beginLoad())
        XCTAssertEqual(edge(off), HistoryEdge(mark: .none, notes: [HistoryNotice.off]))
    }

    func testAFailureIsSaidWhileTheReaderTriesAgain() {
        var paging = reader(pages: 1, size: 3, cap: nil)
        paging.apply(failure: .message("conch's record store is busy."), generation: paging.beginLoad())
        XCTAssertEqual(edge(paging).notes, ["conch's record store is busy."])
        paging.beginLoad()
        XCTAssertEqual(edge(paging, slow: true), HistoryEdge(mark: .loading, notes: ["conch's record store is busy."]),
                       "the reason stays up through the retry instead of blinking")
    }

    // MARK: - Estimates

    func testEstimatesGrowWithTheBodyAndKnowATextFromAToolLine() {
        let mac = HistoryEstimate.mac
        let short = mac.height(kind: "message", role: "assistant", characters: 80, width: 700)
        let long = mac.height(kind: "message", role: "assistant", characters: 8_000, width: 700)
        XCTAssertEqual(short, 23 + 22)
        XCTAssertGreaterThan(long, 20 * short)
        XCTAssertEqual(mac.height(kind: "tool_call", role: nil, characters: 9_999, width: 700), 16 + 22,
                       "a tool row is one folded line however long its output")
        XCTAssertGreaterThan(mac.height(kind: "message", role: "user", characters: 900, width: 700),
                             mac.height(kind: "message", role: "assistant", characters: 900, width: 700),
                             "your turns sit in a narrower bubble")
    }

    // MARK: - Which bodies to read

    func testBodiesAreReadNearestTheReaderFirstAndOnlyForCutMessages() {
        let rows = [
            HistoryItem(id: "a", kind: "message", preview: "short", bodyBytes: 5),
            HistoryItem(id: "b", kind: "message", preview: "cut", bodyBytes: 9_000),
            HistoryItem(id: "c", kind: "tool_result", preview: "cut", bodyBytes: 9_000),
            HistoryItem(id: "d", kind: "message", preview: "cut", bodyBytes: 9_000),
            HistoryItem(id: "e", kind: "message", preview: "cut", bodyBytes: 9_000),
            HistoryItem(id: "f", kind: "message", preview: "cut", bodyBytes: 9_000),
        ]
        XCTAssertEqual(HistoryDemand.bodies(for: rows, around: 4, held: [], reading: [], limit: 3), ["e", "d", "f"])
        XCTAssertEqual(HistoryDemand.bodies(for: rows, around: 4, held: ["e"], reading: ["d"], limit: 3), ["f", "b"])
        XCTAssertEqual(HistoryDemand.bodies(for: rows, around: 0, held: [], reading: ["x", "y", "z"], limit: 3), [],
                       "three in flight is all one reader asks for at once")
    }

    func testBodiesDrawnRightNowAreNeverReleased() {
        let held = [(id: "a", bytes: 900_000), (id: "b", bytes: 900_000), (id: "c", bytes: 900_000)]
        XCTAssertEqual(HistoryBudget.release(held, keepingUnder: 1_000_000, pinned: ["a"]), ["b"])
    }

    // MARK: - A row built again

    func testARowScrolledAwayAndBackIsNotParsedAgain() {
        let cache = MarkdownPieceCache.shared
        let reply = "## A heading \(UUID())\n\nA paragraph.\n\n- one\n- two"
        let before = cache.parses
        let first = cache.pieces(reply, size: 15, images: false)
        XCTAssertEqual(cache.parses, before + 1)
        let again = cache.pieces(reply, size: 15, images: false)
        XCTAssertEqual(cache.parses, before + 1, "the same text at the same size is found, not parsed")
        XCTAssertEqual(first.count, again.count)
        _ = cache.pieces(reply + " revised", size: 15, images: false)
        XCTAssertEqual(cache.parses, before + 2, "a revision is different text, and parsed")
        _ = cache.pieces(reply, size: 17, images: false)
        XCTAssertEqual(cache.parses, before + 3, "and a different size is a different layout")
    }

    // MARK: - A cut message, whole

    func testACutMessageIsTheRecordsHeadJoinedToTheSnapshotsTail() {
        let full = (0..<300).map { "sentence \($0)." }.joined(separator: " ")
        let cut = "…" + String(full.suffix(1_000))
        // The record is behind: it ends 200 characters before the message does.
        let record = String(full.prefix(full.count - 200))
        XCTAssertEqual(HistorySnapshot.whole(record: record, cut: cut), full)
        XCTAssertEqual(HistorySnapshot.whole(record: full, cut: cut), full, "caught up: the record is the message")
        XCTAssertNil(HistorySnapshot.whole(record: String(full.prefix(500)), cut: cut),
                     "too far behind to overlap: no seam to join at, so the cut text stands")
        let ahead = full + " and one more."
        XCTAssertEqual(HistorySnapshot.whole(record: ahead, cut: cut), ahead, "the record has moved past the snapshot")
        XCTAssertEqual(HistorySnapshot.whole(record: "whole output", cut: "start\n… 90 characters cut …\nend"), "whole output",
                       "a tool result is cut in the middle, and the record replaces it outright")
    }

    func testTheJoinNeverSplitsACharacter() {
        // Multibyte throughout, and not periodic: a text that repeats exactly has no one seam.
        let full = (0..<400).map { "é\($0)日本🙂" }.joined()
        let cut = "…" + String(full.suffix(300))
        let record = String(full.prefix(full.count - 40))
        XCTAssertEqual(HistorySnapshot.whole(record: record, cut: cut), full)
    }
}
