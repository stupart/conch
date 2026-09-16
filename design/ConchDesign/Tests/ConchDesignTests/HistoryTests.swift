import XCTest
@testable import ConchDesign

/// The recorded-history reader: what it accepts, what it refuses, and what it says.
///
/// None of this needs a window, which is the point — the failures worth testing here
/// are the ones a screenshot cannot show: a page from a session the reader has left,
/// items from two index generations in one list, a body stitched from two revisions.
final class HistoryTests: XCTestCase {
    private func item(
        _ id: String,
        at: Double? = nil,
        revision: Int = 1,
        preview: String = "",
        bodyBytes: Int = 0,
        nativeId: String? = nil
    ) -> HistoryItem {
        HistoryItem(id: id, nativeId: nativeId, at: at, revision: revision, preview: preview, bodyBytes: bodyBytes)
    }

    private func page(_ ids: [String], previousCursor: String?, epoch: String = "1") -> HistoryPage {
        HistoryPage(items: ids.map { item($0) }, previousCursor: previousCursor, epoch: epoch)
    }

    // MARK: - Paging

    func testOlderMessagesArriveAboveWithoutMovingTheReader() {
        var paging = HistoryPaging()
        paging.select(session: "a")
        paging.apply(page: page(["3", "4", "5"], previousCursor: "older"), generation: paging.beginLoad())
        XCTAssertEqual(paging.items.map(\.id), ["3", "4", "5"])
        XCTAssertTrue(paging.canLoadOlder)

        // The reader is looking at item 3 when the previous page is asked for.
        let generation = paging.beginLoad(anchor: "3")
        paging.apply(page: page(["1", "2"], previousCursor: nil), generation: generation)

        XCTAssertEqual(paging.items.map(\.id), ["1", "2", "3", "4", "5"], "older items belong above, in order")
        XCTAssertEqual(paging.anchor, "3", "the view puts the reader back on this item after the prepend")
        XCTAssertTrue(paging.reachedStart)
        XCTAssertFalse(paging.canLoadOlder, "no cursor left: this is the start of the record")
    }

    func testAnswersForAReaderThatHasMovedOnAreDropped() {
        var paging = HistoryPaging()
        paging.select(session: "a")
        let inFlight = paging.beginLoad()

        // Another session is picked while that page is still crossing the socket.
        paging.select(session: "b")
        paging.apply(page: page(["1"], previousCursor: nil), generation: inFlight)

        XCTAssertEqual(paging.session, "b")
        XCTAssertTrue(paging.items.isEmpty, "one session's messages must never land in another's transcript")
    }

    func testAStaleEpochStartsAgainRatherThanMixingGenerations() {
        var paging = HistoryPaging()
        paging.select(session: "a")
        paging.apply(page: page(["3", "4"], previousCursor: "older", epoch: "1"), generation: paging.beginLoad())

        let generation = paging.beginLoad(anchor: "3")
        // The index was replayed: this page describes a different generation of the session.
        paging.apply(page: page(["1", "2"], previousCursor: nil, epoch: "2"), generation: generation)

        XCTAssertTrue(paging.items.isEmpty, "two epochs' items cannot be joined into one list")
        XCTAssertNil(paging.epoch)
        XCTAssertNil(paging.previousCursor, "cursors were bound to the epoch that went away")
        XCTAssertEqual(paging.anchor, "3", "where the reader was looking survives the restart")
        XCTAssertNotEqual(paging.generation, generation)

        // And whatever was already in flight for the old generation is refused.
        paging.apply(page: page(["9"], previousCursor: nil, epoch: "1"), generation: generation)
        XCTAssertTrue(paging.items.isEmpty)
    }

    func testAnExplicitStaleCursorAlsoStartsAgain() {
        var paging = HistoryPaging()
        paging.select(session: "a")
        paging.apply(page: page(["3"], previousCursor: "older"), generation: paging.beginLoad())

        let generation = paging.beginLoad(anchor: "3")
        paging.apply(failure: .stale, generation: generation)

        XCTAssertTrue(paging.items.isEmpty)
        XCTAssertNil(paging.previousCursor)
        XCTAssertTrue(paging.canLoadOlder, "a fresh traversal is exactly what a stale cursor asks for")
        XCTAssertEqual(paging.anchor, "3")
    }

    func testHistoryOffIsSaidPlainlyAndIsNotAnError() {
        var paging = HistoryPaging()
        paging.select(session: "a")
        paging.apply(failure: .off, generation: paging.beginLoad())

        XCTAssertEqual(paging.status, .off)
        XCTAssertFalse(paging.canLoadOlder, "nothing is being recorded; asking again would answer the same")
        XCTAssertTrue(paging.items.isEmpty)
        // The one thing a reader can do about it.
        XCTAssertTrue(HistoryNotice.off.contains("conch set records true"))
    }

    func testARecoverableErrorKeepsWhatIsOnScreenAndCanBeRetried() {
        var paging = HistoryPaging()
        paging.select(session: "a")
        paging.apply(page: page(["3", "4"], previousCursor: "older"), generation: paging.beginLoad())
        paging.apply(failure: .message("History is busy."), generation: paging.beginLoad(anchor: "3"))

        XCTAssertEqual(paging.status, .failed("History is busy."))
        XCTAssertEqual(paging.items.map(\.id), ["3", "4"], "a failed read is no reason to lose the transcript")
        XCTAssertTrue(paging.canLoadOlder, "and the retry is the same request again")
    }

    func testARevisedItemKeepsItsNewestRevisionWhenPagesOverlap() {
        let existing = [item("1", revision: 4, preview: "new"), item("2")]
        let arriving = [item("1", revision: 2, preview: "old"), item("0")]
        let merged = HistoryPaging.merge(older: arriving, into: existing)

        XCTAssertEqual(merged.map(\.id), ["1", "0", "2"])
        XCTAssertEqual(merged.first?.revision, 4, "the store's newer revision of an item wins over the older page's")
    }

    // MARK: - Coverage

    func testCoverageSaysHowFarBackTheRecordActuallyGoes() {
        let whole = HistoryCoverage(sources: 1, statuses: ["complete": 1], indexedBytes: 100, observedBytes: 100)
        XCTAssertNil(HistoryNotice.coverage(whole, reachedStart: true, oldest: "3 May"), "nothing to apologise for")

        let working = HistoryCoverage(sources: 1, statuses: ["indexing": 1], indexedBytes: 10, observedBytes: 100)
        XCTAssertEqual(
            HistoryNotice.coverage(working, reachedStart: false, oldest: nil),
            "Still reading this session's history — earlier messages may appear."
        )

        let partial = HistoryCoverage(sources: 2, statuses: ["complete": 1, "partial": 1], indexedBytes: 40, observedBytes: 100)
        XCTAssertEqual(
            HistoryNotice.coverage(partial, reachedStart: true, oldest: "3 May"),
            "Recorded back to 3 May — anything earlier wasn't recorded."
        )
        XCTAssertEqual(HistoryNotice.coverage(partial, reachedStart: false, oldest: nil), "Part of this session wasn't recorded.")
        XCTAssertNil(HistoryNotice.coverage(nil, reachedStart: false, oldest: nil), "nothing read yet is not a claim about coverage")
    }

    func testAReplayingSourceReadsAsWorkInProgressNotAsAGap() {
        let replaying = HistoryCoverage(sources: 1, statuses: ["complete": 1], replayRequired: true, indexedBytes: 100, observedBytes: 100)
        XCTAssertFalse(replaying.isComplete)
        XCTAssertTrue(replaying.isIndexing)
    }

    // MARK: - Bodies

    func testARevisedBodyStartsAgainRatherThanStitchingTwoRevisions() {
        var body = HistoryBody()
        body.begin()
        body.apply(chunk: "abc", revision: 1, next: "more")
        XCTAssertFalse(body.isComplete)

        // The item changed under the read: the first chunk describes a body that is gone.
        body.apply(chunk: "def", revision: 2, next: nil)
        XCTAssertEqual(body.text, "def")
        XCTAssertTrue(body.isComplete)
    }

    func testChunksOfOneRevisionConcatenateAndEndOnANullCursor() {
        var body = HistoryBody()
        body.begin()
        body.apply(chunk: "one ", revision: 3, next: "more")
        body.apply(chunk: "two", revision: 3, next: nil)
        XCTAssertEqual(body.text, "one two")
        XCTAssertTrue(body.isComplete)
    }

    func testAFailedBodyReadSaysSoAndAStaleOneThrowsAwayItsChunks() {
        var body = HistoryBody()
        body.begin()
        body.apply(chunk: "abc", revision: 1, next: "more")
        body.apply(failure: .message("That message couldn't be loaded."))
        XCTAssertEqual(body.status, .failed("That message couldn't be loaded."))
        XCTAssertEqual(body.text, "abc", "what arrived is still true")

        body.apply(failure: .stale)
        XCTAssertEqual(body.text, "", "a moved body cannot be continued from where the old one stopped")
        XCTAssertNil(body.cursor)
    }

    // MARK: - Matching live rows to recorded items

    func testASnapshotRowFindsTheRecordedItemBehindIt() {
        XCTAssertEqual(HistorySnapshot.nativeId(forSnapshotItem: "uuid-1"), "uuid-1")
        XCTAssertEqual(HistorySnapshot.nativeId(forSnapshotItem: "tool:call_7"), "call_7")
        XCTAssertEqual(HistorySnapshot.nativeId(forSnapshotItem: "uuid-1:thinking"), "uuid-1")
        XCTAssertEqual(HistorySnapshot.nativeId(forSnapshotItem: "uuid-1:material:2"), "uuid-1")
        // A Codex message is keyed by a hash of its own text; there is nothing to undecorate.
        XCTAssertEqual(HistorySnapshot.nativeId(forSnapshotItem: "assistant:1a2b3c"), "assistant:1a2b3c")
    }

    func testACutSnapshotRowIsRecognisedByItsMarkOrItsLength() {
        XCTAssertTrue(HistorySnapshot.wasCut("…the tail of a long message", cap: 4_000))
        XCTAssertTrue(HistorySnapshot.wasCut(String(repeating: "x", count: 400), cap: 400), "tool output is cut with no mark at all")
        XCTAssertFalse(HistorySnapshot.wasCut("a short reply", cap: 4_000))
    }

    func testRecordedRowsStopWhereTheLiveOnesBegin() {
        let recorded = [
            item("r1", at: 10, nativeId: "u1"),
            item("r2", at: 20, nativeId: "u2"),
            item("r3", at: 30, nativeId: "u3"),
        ]
        // The snapshot is already showing u3.
        XCTAssertEqual(
            HistorySnapshot.older(recorded, thanSnapshot: ["u3"]).map(\.id),
            ["r1", "r2"]
        )
        // Codex: no id matches, so the live window's oldest timestamp is the join instead.
        XCTAssertEqual(
            HistorySnapshot.older(recorded, thanSnapshot: ["assistant:zz"], startingAt: 20).map(\.id),
            ["r1"]
        )
    }

    // MARK: - What a phone will hold

    func testAPhoneStopsPagingOnceItHoldsAllItWill() {
        var paging = HistoryPaging(session: "a", itemCap: 4)
        paging.apply(page: page(["3", "4"], previousCursor: "older"), generation: paging.beginLoad())
        XCTAssertFalse(paging.isAtCap)
        XCTAssertTrue(paging.canLoadOlder)

        paging.apply(page: page(["1", "2"], previousCursor: "older-still"), generation: paging.beginLoad(anchor: "3"))

        XCTAssertEqual(paging.items.map(\.id), ["1", "2", "3", "4"], "nothing is dropped; the reader stops asking")
        XCTAssertTrue(paging.isAtCap)
        XCTAssertFalse(paging.canLoadOlder, "the record goes further back, but this phone is full")
        XCTAssertFalse(paging.reachedStart, "which is NOT the same as having reached the start of the session")
        // And the reader is told where the rest of it is.
        XCTAssertTrue(HistoryNotice.cap.contains("Mac"))
    }

    func testTheCeilingTravelsWithTheReaderAndIsNotInTheWayAfterARestart() {
        var paging = HistoryPaging(session: "a", itemCap: 2)
        paging.select(session: "b")
        XCTAssertEqual(paging.itemCap, 2, "a different session is still the same phone")

        paging.apply(page: page(["1", "2"], previousCursor: "older"), generation: paging.beginLoad())
        XCTAssertTrue(paging.isAtCap)

        // A stale epoch drops everything bound to it; the ceiling must not then read as full.
        paging.restart()
        XCTAssertEqual(paging.itemCap, 2)
        XCTAssertFalse(paging.isAtCap)
        XCTAssertTrue(paging.canLoadOlder)
    }

    func testTheMacKeepsReadingPastAnyCeiling() {
        var paging = HistoryPaging(session: "a")
        paging.apply(page: page(["1", "2", "3"], previousCursor: "older"), generation: paging.beginLoad())
        XCTAssertNil(paging.itemCap)
        XCTAssertFalse(paging.isAtCap, "no ceiling means no ceiling, however many pages arrive")
        XCTAssertTrue(paging.canLoadOlder)
    }

    func testTheOldestOpenedBodiesAreReleasedFirst() {
        let held = [(id: "a", bytes: 900_000), (id: "b", bytes: 900_000), (id: "c", bytes: 900_000)]
        XCTAssertEqual(HistoryBudget.release(held, keepingUnder: 2_000_000), ["a"])
        XCTAssertEqual(HistoryBudget.release(held, keepingUnder: 1_000_000), ["a", "b"])
        XCTAssertEqual(HistoryBudget.release(held, keepingUnder: 5_000_000), [], "under budget releases nothing")
        // The one being read is never released, however large: releasing it would
        // empty the row that asked for it.
        XCTAssertEqual(HistoryBudget.release([(id: "only", bytes: 9_000_000)], keepingUnder: 2_000_000), [])
    }

}
