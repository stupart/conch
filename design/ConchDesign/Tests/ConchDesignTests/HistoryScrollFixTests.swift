import AppKit
import CoreGraphics
import SwiftUI
import XCTest
@testable import ConchDesign

/// The review of #443's infinite scroll (28 Sep): a width change that left rows overlapping, reads
/// that failed and were asked for again in a tight loop, a released page that stayed a spinner, a
/// long reply that arrived after the session opened and was never shown whole, a streaming reply's
/// refresh that stalled, and a picture rewritten in place that kept showing the old one.
final class HistoryScrollFixTests: XCTestCase {
    // MARK: - A width change (#4)

    private func slots(_ ids: [String], estimate: CGFloat) -> [HistoryWindow.Slot] {
        [HistoryWindow.Slot(id: HistoryRegionID.edge, estimate: 20)] + ids.map { HistoryWindow.Slot(id: $0, estimate: estimate) }
    }

    /// Side by Side, a resize, a rotation: a row on screen whose height does not depend on the width
    /// reports nothing, so it must keep the height it was drawn at — not go back to an estimate
    /// nothing will ever correct, and paint over its neighbours.
    @MainActor
    func testAWidthChangeKeepsARealRowAtTheHeightItWasDrawnAt() {
        let model = HistoryRegionModel(overscan: 2, cap: 160)
        model.resized(width: 700)
        model.sync(slots(["a", "b", "c"], estimate: 196))
        model.measured("b", height: 984)
        XCTAssertEqual(model.window.height(of: "b"), 984)
        XCTAssertTrue(model.window.materialised.contains(2), "b is a real view: no viewport yet, so the end is")

        // Half as wide. The estimates move with the width, as the apps' do; b's own height does not.
        model.resized(width: 350)
        model.sync(slots(["a", "b", "c"], estimate: 392))
        XCTAssertEqual(model.window.height(of: "b"), 984, "a 984 pt row held at its estimate overlaps what follows it")
        XCTAssertEqual(model.window.top(of: 3) - model.window.top(of: 2), 984, "and c starts where b ends")
    }

    /// Rows that are not views have nothing drawn to keep: they take the new width's estimate, and
    /// are measured the moment they become views.
    @MainActor
    func testAWidthChangeReEstimatesRowsThatAreNotViewsAndTheyAreMeasuredWhenDrawn() {
        let model = HistoryRegionModel(overscan: 2, cap: 2)
        model.resized(width: 700)
        model.sync(slots(["a", "b", "c", "d"], estimate: 100))
        XCTAssertEqual(model.window.materialised, 3..<5, "the last two are views")
        model.measured("a", height: 300) // drawn before, while it was on screen
        model.measured("d", height: 150)
        model.resized(width: 350)
        model.sync(slots(["a", "b", "c", "d"], estimate: 200))
        XCTAssertEqual(model.window.height(of: "a"), 200, "off screen: the new width's estimate")
        XCTAssertEqual(model.window.height(of: "d"), 150, "on screen: the height it is drawn at")
        model.measured("a", height: 520)
        XCTAssertEqual(model.window.height(of: "a"), 520, "and drawn again, measured again")
    }

    /// A row drawn at exactly its estimate is still a row that was drawn. Not recorded, the next
    /// estimate moved it — and the row, whose height did not change, never said so again.
    @MainActor
    func testARowDrawnAtItsEstimateIsNotMovedByTheNextEstimate() {
        let model = HistoryRegionModel(overscan: 2, cap: 160)
        model.resized(width: 700)
        model.sync(slots(["a", "b"], estimate: 45))
        model.measured("b", height: 45)
        XCTAssertTrue(model.window.isMeasured("b"))
        model.sync(slots(["a", "b"], estimate: 68))
        XCTAssertEqual(model.window.height(of: "b"), 45)
        XCTAssertEqual(model.window.height(of: "a"), 68, "one never drawn follows its estimate")
    }

    /// The same, through the region itself: rows drawn by SwiftUI, a width change, and the body run
    /// again with the new width's estimates, as the conversation's is on the next snapshot.
    @MainActor
    func testThroughTheRegionAWidthChangeLeavesNoRowOverlapping() {
        let model = HistoryRegionModel(overscan: 2, cap: 160)
        func region(estimate: CGFloat) -> some View {
            ScrollView {
                HistoryRegion(
                    model: model,
                    edge: HistoryEdge(mark: .none),
                    entries: ["a", "b", "c"].map { HistoryEntry(id: $0, estimate: estimate, payload: $0) },
                    gap: 22,
                    edgeFont: .system(size: 11)
                ) { _ in
                    // A picture's row, or a fold: as tall at any width.
                    Color.gray.frame(height: 962)
                }
            }
        }
        let host = NSHostingView(rootView: AnyView(region(estimate: 196)))
        host.frame = CGRect(x: 0, y: 0, width: 700, height: 900)
        settle(host)
        XCTAssertEqual(model.window.height(of: "b"), 984, "962 and the 22 above it, as drawn")

        host.frame = CGRect(x: 0, y: 0, width: 350, height: 900)
        settle(host)
        host.rootView = AnyView(region(estimate: 392))
        settle(host)
        for id in ["a", "b", "c"] {
            XCTAssertEqual(model.window.height(of: id), 984, "\(id) is laid out at the height it is drawn at")
        }
    }

    @MainActor
    private func settle(_ host: NSView) {
        for _ in 0..<4 {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        }
    }

    // MARK: - A read that fails (#3)

    private let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)

    private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

    func testAFailedReadPausesOnThePageReadsScheduleThenWaitsForTheReader() {
        var backoff = HistoryBackoff()
        let read = HistoryRead.body("m")
        XCTAssertTrue(backoff.allows(read, at: t0))
        var now = t0
        var pauses: [TimeInterval] = []
        for _ in 0..<HistoryRetry.attempts {
            guard let until = backoff.failed(read, at: now) else { return XCTFail("spent too soon") }
            pauses.append(until.timeIntervalSince(now))
            XCTAssertFalse(backoff.allows(read, at: until.addingTimeInterval(-0.01)))
            XCTAssertEqual(backoff.nextWake(after: now), until, "the reader wakes for it on its own")
            now = until
            XCTAssertTrue(backoff.allows(read, at: now))
        }
        XCTAssertEqual(pauses, [1, 2, 4, 8, 16, 30], "the page reads' own schedule")
        XCTAssertNil(backoff.failed(read, at: now), "then its tries are spent")
        XCTAssertFalse(backoff.allows(read, at: now.addingTimeInterval(3_600)), "and it is not tried again on its own")
        XCTAssertNil(backoff.nextWake(after: now), "nothing wakes for a spent read")
        backoff.revisit(read)
        XCTAssertTrue(backoff.allows(read, at: now), "the reader scrolled back to it: one more try")
        XCTAssertNil(backoff.failed(read, at: now), "which, failing, is spent again at once")
        backoff.succeeded(read)
        XCTAssertEqual(backoff.failures(of: read), 0)
        XCTAssertTrue(backoff.allows(read, at: now))
    }

    func testARevisitLeavesARunningPauseAloneAndALiftEndsIt() {
        var backoff = HistoryBackoff()
        backoff.failed(.body("m"), at: t0)
        backoff.failed(.body("m"), at: at(1)) // paused until 3 s
        backoff.revisit(.body("m"))
        XCTAssertFalse(backoff.allows(.body("m"), at: at(2)), "scrolling past it again does not cut a pause short")
        backoff.lift(.body("m"))
        XCTAssertTrue(backoff.allows(.body("m"), at: at(2)), "someone pressing Retry does")
        XCTAssertEqual(backoff.failed(.body("m"), at: at(2)), at(6), "and its failures still count")
    }

    /// The loop the review found. A body whose read failed is neither held nor being read, so the
    /// pass made as each read ends (`defer { pumpBodies() }`) picked it again at once: with every
    /// read failing straight away — the daemon down, `busy`, the phone offline — that never ended.
    /// Run at one instant, it must end with each body asked for once.
    func testABodyWhoseReadFailsIsNotAskedForAgainUntilItsPauseEnds() {
        let rows = (0..<5).map { HistoryItem(id: "m\($0)", kind: "message", preview: "cut", bodyBytes: 9_000) }
        var backoff = HistoryBackoff()
        var reading: Set<String> = []
        var requests: [String] = []
        func pump(at now: Date) -> [String] {
            let picked = HistoryDemand.bodies(for: rows, around: 2, held: [], reading: reading, paused: backoff.pausedBodies(at: now))
            reading.formUnion(picked)
            requests += picked
            return picked
        }
        func run(at now: Date) {
            var inFlight = pump(at: now)
            while let id = inFlight.first, requests.count < 1_000 {
                inFlight.removeFirst()
                backoff.failed(.body(id), at: now) // it came back busy
                reading.remove(id)
                inFlight += pump(at: now) // and the read's end asks for more
            }
        }
        run(at: t0)
        XCTAssertEqual(requests.count, 5, "every body once, not a loop: \(requests.prefix(12))…")
        XCTAssertEqual(Set(requests).count, 5)
        XCTAssertTrue(pump(at: at(0.99)).isEmpty, "nothing before the first pause ends")
        requests = []
        run(at: at(1))
        XCTAssertEqual(requests.count, 5, "then each once more")
        XCTAssertEqual(backoff.nextWake(after: at(1)), at(3), "and the next pause is twice as long")
    }

    // MARK: - A released page that would not come back (#25)

    private func reader(pages: Int, size: Int, cap: Int?) -> HistoryPaging {
        var paging = HistoryPaging(session: "s", itemCap: cap)
        for p in 0..<pages {
            let items = (0..<size).map { HistoryItem(id: "p\(p)-\($0)", preview: "p") }
            paging.apply(page: HistoryPage(items: items, previousCursor: "c\(p + 1)", epoch: "e"), generation: paging.beginLoad())
        }
        return paging
    }

    /// Its rows stayed a spinner until the reader scrolled, because only a scroll asked for it
    /// again. A pause, then the page is on screen and due, with nobody touching anything.
    func testAReleasedPageWhoseReadFailsIsDueAgainWhenItsPauseEndsWithoutAScroll() {
        var paging = reader(pages: 5, size: 10, cap: 20)
        var backoff = HistoryBackoff()
        let released = paging.pages.first(where: \.isReleased)!.id
        let shown = Set(paging.pages.first { $0.id == released }!.ids)
        let reread = paging.beginReread(page: released)!
        paging.apply(rereadFailure: .message("conch's record store is busy."), page: released, generation: reread.generation)
        let wake = backoff.failed(.page(released), at: t0)
        XCTAssertEqual(wake, at(1))
        XCTAssertEqual(backoff.nextWake(after: t0), wake)
        func due(at now: Date) -> [Int] {
            paging.releasedPages(holding: shown).filter { backoff.allows(.page($0), at: now) }
        }
        XCTAssertEqual(due(at: at(0.5)), [], "not before its pause ends")
        XCTAssertEqual(due(at: at(1)), [released], "and then, still released and on screen, it is read again")
        XCTAssertNotNil(paging.beginReread(page: released))
    }

    // MARK: - A long reply that arrived after the session opened (#7)

    private func item(_ native: String, record: String? = nil, bytes: Int = 9_000) -> HistoryItem {
        HistoryItem(id: record ?? "rec-\(native)", kind: "message", role: "assistant", nativeId: native, preview: "p", bodyBytes: bytes)
    }

    func testAReplyNoHeldPageNamesIsLookedForAndThenReadByTheIdTheLookGave() {
        // The pages this reader holds are the session as it opened.
        let held = (0..<10).map { item("m\($0)") }
        var wanted = HistoryWanted()
        let backoff = HistoryBackoff()
        wanted.want(["m4", "late"])
        let plan = wanted.plan(held: held, reading: [], backoff: backoff, now: t0)
        XCTAssertEqual(plan.read, [HistoryWanted.Named(record: "rec-m4", native: "m4")], "a held page names it: read it")
        XCTAssertEqual(plan.find, "late", "none names the reply that came later: look for it")

        // The look: the newest page of the reply's own branch, where it is the newest item.
        XCTAssertEqual(wanted.found(in: [held[8], held[9], item("late")]), ["late"])
        let next = wanted.plan(held: held, reading: ["rec-m4"], backoff: backoff, now: t0)
        XCTAssertEqual(next.read, [HistoryWanted.Named(record: "rec-late", native: "late")],
                       "read by the record id the look gave it; the held one already being read waits")
        XCTAssertNil(next.find)
        wanted.remove("late")
        wanted.remove("m4")
        XCTAssertTrue(wanted.isEmpty, "whole, and no longer wanted")
    }

    func testALookThatFindsNothingPausesThatRowAndTheNextLookIsForAnother() {
        var wanted = HistoryWanted()
        var backoff = HistoryBackoff()
        wanted.want(["a", "b"])
        XCTAssertEqual(wanted.plan(held: [], reading: [], backoff: backoff, now: t0).find, "b", "the newest first")
        XCTAssertEqual(wanted.found(in: [item("x")]), [], "the record has not reached it yet")
        backoff.failed(.find("b"), at: t0)
        XCTAssertEqual(wanted.plan(held: [], reading: [], backoff: backoff, now: t0).find, "a")
        backoff.failed(.find("a"), at: t0)
        XCTAssertNil(wanted.plan(held: [], reading: [], backoff: backoff, now: t0).find,
                     "every look pausing: none at all, rather than the same one again")
        XCTAssertEqual(wanted.plan(held: [], reading: [], backoff: backoff, now: at(1)).find, "b", "until a pause ends")
    }

    func testARecordHoldingOnlyAPreviewOfTheReplyDoesNotNameIt() {
        var wanted = HistoryWanted()
        wanted.want(["late"])
        XCTAssertEqual(wanted.found(in: [item("late", bytes: 1)]), [])
        XCTAssertEqual(wanted.plan(held: [item("late", bytes: 1)], reading: [], backoff: HistoryBackoff(), now: t0).find, "late",
                       "a record 240 characters into a reply cut at 4,000 is behind, not it")
    }

    func testANamedRowWhoseReadFailedStaysWantedAndIsReadWhenThePauseEnds() {
        var wanted = HistoryWanted()
        var backoff = HistoryBackoff()
        wanted.want(["m1"])
        backoff.failed(.body("rec-m1"), at: t0)
        XCTAssertEqual(wanted.plan(held: [item("m1")], reading: [], backoff: backoff, now: t0),
                       HistoryWanted.Plan(read: [], find: nil), "pausing: neither read nor looked for")
        XCTAssertEqual(wanted.plan(held: [item("m1")], reading: [], backoff: backoff, now: at(1)).read,
                       [HistoryWanted.Named(record: "rec-m1", native: "m1")])
    }

    // MARK: - A streaming reply's refresh (#26)

    private let streamed = (0..<300).map { "sentence \($0)." }.joined(separator: " ")

    /// The stall: a row asked about only when it changed, whose last change came inside the
    /// refresh interval of its last read, was never read again. The answer is a time, not nothing.
    func testAReplyThatStopsInsideTheRefreshIntervalIsReadAgainWhenTheIntervalEnds() {
        let cut = "…" + String(streamed.suffix(1_000))
        let behind = String(streamed.prefix(500)) // no overlap with the snapshot's tail yet
        XCTAssertEqual(HistorySnapshot.refresh(record: behind, cut: cut, lastRead: t0, tries: 0, now: at(1)), .at(at(3)),
                       "too soon to read again — so then, not never")
        XCTAssertEqual(HistorySnapshot.refresh(record: behind, cut: cut, lastRead: t0, tries: 0, now: at(3)), .now)
        XCTAssertEqual(HistorySnapshot.refresh(record: behind, cut: cut, lastRead: nil, tries: 0, now: t0), .now)
        XCTAssertEqual(HistorySnapshot.refresh(record: streamed, cut: cut, lastRead: t0, tries: 2, now: at(1)), .whole)
    }

    func testTheSameCutStillBehindIsReadAgainLessOftenThenLeftUntilItChanges() {
        XCTAssertEqual(HistorySnapshot.refreshInterval, 3)
        XCTAssertEqual((0...6).map { HistorySnapshot.refreshPause(afterTries: $0) }, [3, 3, 3, 4, 8, 16, 30])
        XCTAssertNil(HistorySnapshot.refreshPause(afterTries: 7))
        let cut = "…" + String(streamed.suffix(1_000))
        XCTAssertEqual(HistorySnapshot.refresh(record: "x", cut: cut, lastRead: t0, tries: 7, now: at(600)), .spent)
    }
}
