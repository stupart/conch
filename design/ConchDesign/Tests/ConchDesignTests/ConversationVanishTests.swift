import XCTest
@testable import ConchDesign

/// Tyler, 2026-09-28: "conversations have been disappearing from the Mac app sometimes and it says
/// there's nothing even when there's an entire convo in the terminal."
///
/// The daemon publishes a live window for a handful of sessions, so a session on screen can have
/// none; the Mac then drew a single-reply pane that said "Nothing from … yet" whether or not the
/// session had said anything. These are the app's rules for that: the record is the conversation
/// when there is no live window, a reader holding nothing keeps asking, and the empty-session
/// sentence belongs to empty sessions.
final class ConversationVanishTests: XCTestCase {
    private func page(_ ids: [String], previousCursor: String?) -> HistoryPage {
        HistoryPage(items: ids.map { HistoryItem(id: $0) }, previousCursor: previousCursor, epoch: "1")
    }

    // MARK: - Which conversation the pane draws

    func testASessionWithNoLiveWindowIsDrawnFromItsRecord() {
        var reader = HistoryPaging()
        reader.select(session: "published")
        XCTAssertEqual(ConversationSource.of(publishedItems: 30, session: "published", reader: reader), .live)

        // The daemon published nothing for this one. Its reader has not been pointed at it yet —
        // the record may hold all of it — so the pane is drawn, and that is what points it here.
        XCTAssertEqual(ConversationSource.of(publishedItems: 0, session: "unpublished", reader: reader), .recorded,
                       "a reader still on another session must not decide this one is empty")

        reader.select(session: "unpublished")
        XCTAssertEqual(ConversationSource.of(publishedItems: 0, session: "unpublished", reader: reader), .recorded)
        reader.beginLoad()
        XCTAssertEqual(ConversationSource.of(publishedItems: 0, session: "unpublished", reader: reader), .recorded)
        reader.apply(page: page(["1", "2", "3"], previousCursor: "older"), generation: reader.generation)
        XCTAssertEqual(ConversationSource.of(publishedItems: 0, session: "unpublished", reader: reader), .recorded,
                       "the record holds the conversation: it is drawn, not the empty screen")
    }

    func testAReadThatFailedIsSaidInThePaneNotHiddenBehindTheEmptyScreen() {
        var reader = HistoryPaging()
        reader.select(session: "a")
        reader.apply(failure: .message("conch's daemon didn't answer."), generation: reader.beginLoad())
        XCTAssertEqual(ConversationSource.of(publishedItems: 0, session: "a", reader: reader), .recorded,
                       "the pane says why, and keeps trying; it does not claim there is nothing")
    }

    func testOnlyARecordThatHoldsNothingOrIsOffLeavesTheEmptyScreen() {
        var empty = HistoryPaging()
        empty.select(session: "a")
        empty.apply(page: page([], previousCursor: nil), generation: empty.beginLoad())
        XCTAssertEqual(ConversationSource.of(publishedItems: 0, session: "a", reader: empty), .neither)

        var off = HistoryPaging()
        off.select(session: "a")
        off.apply(failure: .off, generation: off.beginLoad())
        XCTAssertEqual(ConversationSource.of(publishedItems: 0, session: "a", reader: off), .neither)
        // A live window is drawn whatever the record says.
        XCTAssertEqual(ConversationSource.of(publishedItems: 1, session: "a", reader: off), .live)
    }

    // MARK: - A reader holding nothing keeps asking

    func testAReaderHoldingNothingNeverStopsTrying() {
        var reader = HistoryPaging()
        reader.select(session: "a")
        XCTAssertNil(reader.retryDelay, "nothing has failed")
        var delays: [TimeInterval?] = []
        for _ in 0..<(HistoryRetry.attempts + 4) {
            reader.apply(failure: .message("conch's record store is busy."), generation: reader.beginLoad())
            delays.append(reader.retryDelay)
        }
        XCTAssertEqual(delays, [1, 2, 4, 8, 16, 30, 30, 30, 30, 30],
                       "with no rows there is nothing to scroll back to the top of, which is the only other retry")
    }

    func testAReaderHoldingRowsStillLeavesTheLastTriesToTheScroll() {
        var reader = HistoryPaging()
        reader.select(session: "a")
        reader.apply(page: page(["1", "2"], previousCursor: "older"), generation: reader.beginLoad())
        var delays: [TimeInterval?] = []
        for _ in 0..<(HistoryRetry.attempts + 1) {
            reader.apply(failure: .message("conch's record store is busy."), generation: reader.beginLoad(anchor: "1"))
            delays.append(reader.retryDelay)
        }
        XCTAssertEqual(delays, [1, 2, 4, 8, 16, 30, nil])
        XCTAssertEqual(reader.items.map(\.id), ["1", "2"], "what is on screen stays there")

        var off = HistoryPaging()
        off.select(session: "a")
        off.apply(failure: .off, generation: off.beginLoad())
        XCTAssertNil(off.retryDelay, "off is not a failure to retry")
    }

    func testTheBackoffForOtherReadsIsUnchanged() {
        XCTAssertNil(HistoryRetry.delay(afterFailures: HistoryRetry.attempts + 1))
        XCTAssertEqual(HistoryRetry.delay(afterFailures: HistoryRetry.attempts + 1, holdingNothing: true), HistoryRetry.longest)
        XCTAssertNil(HistoryRetry.delay(afterFailures: 0, holdingNothing: true))
    }

    // MARK: - What the single-reply pane says

    func testOnlyAnEmptySessionIsToldThereIsNothing() {
        let empty = ConversationPlaceholder.text(name: "morrow", transcript: .empty)
        XCTAssertEqual(empty, "Nothing from morrow yet. Send a message below to start.")
        for transcript: ConversationPlaceholder.Transcript in [.unread, .awaitingReply, .unreadable] {
            let said = ConversationPlaceholder.text(name: "morrow", transcript: transcript)
            XCTAssertFalse(said.localizedCaseInsensitiveContains("nothing"), "\(transcript) said \(said)")
            XCTAssertFalse(said.contains("to start"), "\(transcript) told a running session to start")
            XCTAssertTrue(said.contains("morrow"))
        }
    }
}
