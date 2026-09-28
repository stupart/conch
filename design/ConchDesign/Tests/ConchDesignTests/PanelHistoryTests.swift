import CoreGraphics
import XCTest
@testable import ConchDesign

/// The conversation panel stayed blank for a session the daemon published no live window for — the main window's bug
/// (#457, Tyler 2026-09-28: "it says there's nothing even when there's an entire convo in the terminal"), left in the
/// panel. These are the panel's half of the rule: its turns come from the record above the live window, it reads further
/// back as the reader scrolls, it says why while there is nothing yet, and a page landing never moves the reader.
final class PanelHistoryTests: XCTestCase {
    private func page(_ items: [HistoryItem], previousCursor: String? = nil) -> HistoryPage {
        HistoryPage(items: items, previousCursor: previousCursor, epoch: "1")
    }

    private func reader(_ session: String, _ items: [HistoryItem], previousCursor: String? = nil) -> HistoryPaging {
        var reader = HistoryPaging(itemCap: 4_000)
        reader.select(session: session)
        reader.apply(page: page(items, previousCursor: previousCursor), generation: reader.beginLoad())
        return reader
    }

    private func message(_ id: String, _ role: String, _ preview: String, native: String? = nil, at: Double? = nil, bytes: Int = 0) -> HistoryItem {
        HistoryItem(id: id, kind: "message", role: role, nativeId: native, at: at, preview: preview, bodyBytes: bytes)
    }

    // MARK: - The turns

    func testASessionWithNoLiveWindowIsItsRecordedConversation() {
        let record = reader("atlas", [
            message("r1", "user", "Lay out the amount field"),
            HistoryItem(id: "r2", kind: "tool_call", toolName: "Edit", preview: "{\"file\":\"Amount.tsx\"}"),
            HistoryItem(id: "r3", kind: "tool_result", preview: "ok"),
            message("r4", "assistant", "Laid out."),
            HistoryItem(id: "r5", kind: "material", preview: "screenshot"),
            message("r6", "assistant", "   "),
        ])
        let turns = PanelHistory.turns(session: "atlas", reader: record, live: [], liveItems: [], liveStartsAt: nil, whole: { _ in nil })
        XCTAssertEqual(turns, [
            ConversationTurn(id: "r1", fromYou: true, text: "Lay out the amount field"),
            ConversationTurn(id: "r4", fromYou: false, text: "Laid out."),
        ], "what was said, both ways, oldest first: tools, materials and empty messages stay in the main window")
    }

    func testTheRecordStopsWhereTheLiveWindowStarts() {
        let live = [
            ConversationTurn(id: "u-3", fromYou: true, text: "And the heading?"),
            ConversationTurn(id: "a-3", fromYou: false, text: "Done."),
        ]
        // By id: the record's copy of the live window's first message is the live one's.
        let byID = reader("atlas", [
            message("r1", "user", "One", native: "u-1"),
            message("r2", "assistant", "Two", native: "a-1"),
            message("r3", "user", "And the heading?", native: "u-3"),
            message("r4", "assistant", "Done.", native: "a-3"),
        ])
        // The live window's tool row names the seam too: every item it holds counts, not only its turns.
        let turns = PanelHistory.turns(session: "atlas", reader: byID, live: live, liveItems: ["tool:call_9", "u-3", "a-3"], liveStartsAt: nil, whole: { _ in nil })
        XCTAssertEqual(turns.map(\.id), ["r1", "r2", "u-3", "a-3"], "the end of the conversation is drawn once")

        let seamAtTool = reader("atlas", [
            message("r1", "user", "One", native: "u-1"),
            HistoryItem(id: "r2", kind: "tool_call", nativeId: "call_9"),
            message("r3", "assistant", "Two", native: "a-1"),
        ])
        XCTAssertEqual(
            PanelHistory.turns(session: "atlas", reader: seamAtTool, live: live, liveItems: ["tool:call_9", "u-3", "a-3"], liveStartsAt: nil, whole: { _ in nil }).map(\.id),
            ["r1", "u-3", "a-3"]
        )

        // By time, where the provider's ids never match (Codex keys a live row by a hash of its text).
        let byTime = reader("codex", [
            message("r1", "user", "One", at: 1_000),
            message("r2", "assistant", "Two", at: 2_000),
            message("r3", "user", "And the heading?", at: 3_000),
        ])
        XCTAssertEqual(
            PanelHistory.turns(session: "codex", reader: byTime, live: live, liveItems: ["h1", "h2"], liveStartsAt: 3_000, whole: { _ in nil }).map(\.id),
            ["r1", "r2", "u-3", "a-3"]
        )
    }

    func testAReaderStillOnAnotherSessionAddsNothing() {
        let other = reader("dayloop", [message("r1", "user", "Dayloop's words")])
        let live = [ConversationTurn(id: "a", fromYou: false, text: "Atlas's own")]
        XCTAssertEqual(PanelHistory.turns(session: "atlas", reader: other, live: live, liveItems: ["a"], liveStartsAt: nil, whole: { _ in nil }), live,
                       "another session's messages must never show under this one's name")
        XCTAssertEqual(PanelHistory.turns(session: "atlas", reader: other, live: [], liveItems: [], liveStartsAt: nil, whole: { _ in nil }), [])
    }

    func testARecordedMessageSaysItsWholeBodyOnceReadAndIsMarkedCutUntilThen() {
        let long = message("r1", "assistant", String(repeating: "a", count: 240), bytes: 9_000)
        XCTAssertEqual(PanelHistory.turn(recorded: long, whole: nil)?.text, String(repeating: "a", count: 240) + "…")
        XCTAssertEqual(PanelHistory.turn(recorded: long, whole: "the whole reply")?.text, "the whole reply")
        let short = message("r2", "assistant", "Short and whole.", bytes: 16)
        XCTAssertEqual(PanelHistory.turn(recorded: short, whole: nil)?.text, "Short and whole.", "nothing behind it, no mark")
        // Anything but the user's role is the agent's, as the main window's stack has it.
        XCTAssertEqual(PanelHistory.turn(recorded: message("r3", "system", "Context"), whole: nil)?.fromYou, false)
        XCTAssertEqual(PanelHistory.turn(recorded: message("r4", "user", "Mine"), whole: nil)?.fromYou, true)
        XCTAssertNil(PanelHistory.turn(recorded: HistoryItem(id: "r5", kind: "inter_agent", preview: "hand-off"), whole: nil))
        // The body closure is what the turns read it from.
        let record = reader("atlas", [long])
        XCTAssertEqual(PanelHistory.turns(session: "atlas", reader: record, live: [], liveItems: [], liveStartsAt: nil, whole: { $0.id == "r1" ? "whole" : nil }).map(\.text), ["whole"])
    }

    // MARK: - What the panel draws

    func testThePanelGoesByTheMainWindowsRule() {
        var reading = HistoryPaging()
        reading.select(session: "atlas")
        func of(_ published: Int, turns: Int, _ reader: HistoryPaging, session: String = "atlas") -> PanelConversation {
            PanelConversation.of(
                source: ConversationSource.of(publishedItems: published, session: session, reader: reader),
                turns: turns, session: session, reader: reader
            )
        }
        // Not read yet, being read: reading, never "nothing".
        XCTAssertEqual(of(0, turns: 0, reading), .placeholder(.unread))
        reading.beginLoad()
        XCTAssertEqual(of(0, turns: 0, reading), .placeholder(.unread))
        // A reader still on another session is about to be pointed here.
        XCTAssertEqual(of(0, turns: 0, reading, session: "dayloop"), .placeholder(.unread))

        // The record answered with the conversation.
        let answered = reader("atlas", [message("r1", "user", "Hi")], previousCursor: "older")
        XCTAssertEqual(of(0, turns: 1, answered), .turns)
        XCTAssertEqual(of(12, turns: 5, answered), .turns)

        // The newest pages hold only tool steps and there is more: still reading.
        let tools = reader("atlas", [HistoryItem(id: "r1", kind: "tool_call")], previousCursor: "older")
        XCTAssertEqual(of(0, turns: 0, tools), .placeholder(.unread))
        // Read to the start with tool steps and nothing said: at work, no reply yet — never "nothing".
        let toolsOnly = reader("atlas", [HistoryItem(id: "r1", kind: "tool_call")])
        XCTAssertEqual(of(0, turns: 0, toolsOnly), .placeholder(.awaitingReply))

        // A read that failed says so, and keeps trying; it does not claim there is nothing.
        var failed = HistoryPaging()
        failed.select(session: "atlas")
        failed.apply(failure: .message("conch's daemon didn't answer."), generation: failed.beginLoad())
        XCTAssertEqual(of(0, turns: 0, failed), .placeholder(.unreadable))

        // Records off, or nothing recorded, and no live window: the single-reply document's content.
        var off = HistoryPaging()
        off.select(session: "atlas")
        off.apply(failure: .off, generation: off.beginLoad())
        XCTAssertEqual(of(0, turns: 0, off), .lastReply)
        let empty = reader("atlas", [])
        XCTAssertEqual(of(0, turns: 0, empty), .lastReply)
        // The source decides, as the main window's gate does: a live window of tool rows alone, records off, is the
        // conversation, with no words in it yet — not the single-reply document.
        XCTAssertEqual(of(6, turns: 0, off), .placeholder(.awaitingReply))
        XCTAssertEqual(PanelConversation.of(source: .neither, turns: 0, session: "atlas", reader: answered), .lastReply)
        // A live window with words in it, records off: its words.
        XCTAssertEqual(of(6, turns: 3, off), .turns)
    }

    // MARK: - Reading further back

    func testThePanelReadsBackWhileItsOldestEndIsNearAndItWouldDrawWhatCame() {
        var scroll = FogScroll()
        // Nothing to show yet — the newest page all tool steps — whatever has been measured.
        XCTAssertTrue(PanelHistory.wantsOlder(turns: 0, scroll: scroll, box: 0))
        // A few turns that do not fill the box.
        scroll.layout(range: 0)
        XCTAssertTrue(PanelHistory.wantsOlder(turns: 3, scroll: scroll, box: 400))
        // Pinned at the newest with plenty above: not yet.
        scroll.layout(range: 2_000)
        XCTAssertFalse(PanelHistory.wantsOlder(turns: 40, scroll: scroll, box: 400))
        // Scrolled back to within a screen and a half of the oldest end.
        scroll.scroll(by: 1_500, momentum: false)
        XCTAssertTrue(PanelHistory.wantsOlder(turns: 40, scroll: scroll, box: 400))
        // Holding all the fog draws, more would not show: the main window is where the rest is read.
        XCTAssertFalse(PanelHistory.wantsOlder(turns: ConversationFog.turnsShown, scroll: scroll, box: 400))
        XCTAssertTrue(PanelHistory.wantsOlder(turns: ConversationFog.turnsShown - 1, scroll: scroll, box: 400))
    }

    /// Kept at the same distance from the oldest line, a page landing above put the reader on it, still at the oldest end,
    /// which asked for the page before that, and so on to the start. From the newest line, the reader stays put.
    @MainActor
    func testAPageLandingAboveLeavesTheReaderWhereTheyWereAndStopsAsking() {
        let state = FogTextState()
        let ends = FogTranscriptEnds(oldest: "r10", newest: "a-3")
        state.measured(content: 1_400, box: 400, ends: ends)
        state.scroll(by: 900, momentum: false)
        XCTAssertEqual(state.scroll.offset, 900)
        XCTAssertTrue(PanelHistory.wantsOlder(turns: 30, scroll: state.scroll, box: state.box), "100 pt from the oldest end")
        // A page of older turns lands above the oldest.
        state.measured(content: 2_600, ends: FogTranscriptEnds(oldest: "r1", newest: "a-3"))
        XCTAssertEqual(state.scroll.offset, 900, "the reader is still on the line they were reading")
        XCTAssertFalse(state.scroll.pinned)
        XCTAssertFalse(PanelHistory.wantsOlder(turns: 50, scroll: state.scroll, box: state.box), "1,300 pt of runway above now")

        // A reply growing at the newest end while scrolled away keeps the old rule: the same distance from the oldest line.
        state.measured(content: 2_700, ends: FogTranscriptEnds(oldest: "r1", newest: "a-3"))
        XCTAssertEqual(state.scroll.offset, 1_000)
        // A new turn at the newest end with the oldest let go: both ends moved, so the old rule too.
        state.measured(content: 2_800, ends: FogTranscriptEnds(oldest: "r2", newest: "a-4"))
        XCTAssertEqual(state.scroll.offset, 1_100)
        // A measure with no ends (the box, or an older caller) is the old rule.
        state.measured(content: 2_900)
        XCTAssertEqual(state.scroll.offset, 1_200)
        // Another session starts over: the first ends it measures are not a change.
        state.session()
        state.measured(content: 3_000, box: 400, ends: FogTranscriptEnds(oldest: "x", newest: "y"))
        XCTAssertEqual(state.scroll.offset, 0)
    }

    func testTheFarEndRuleKeepsTheOffsetAndStillClamps() {
        var scroll = FogScroll()
        scroll.layout(range: 1_000)
        scroll.scroll(by: 800, momentum: false)
        scroll.layout(range: 1_600, grewAtOldest: true)
        XCTAssertEqual(scroll.offset, 800)
        // Let go from the far end, past where the reader was: clamped, never unpinned or re-pinned by layout.
        scroll.layout(range: 500, grewAtOldest: true)
        XCTAssertEqual(scroll.offset, 500)
        XCTAssertFalse(scroll.pinned)
        XCTAssertTrue(FogTranscriptEnds(oldest: "b", newest: "z").movedAtOldest(from: FogTranscriptEnds(oldest: "a", newest: "z")))
        XCTAssertFalse(FogTranscriptEnds(oldest: "a", newest: "z").movedAtOldest(from: nil))
        XCTAssertFalse(FogTranscriptEnds(oldest: "b", newest: "y").movedAtOldest(from: FogTranscriptEnds(oldest: "a", newest: "z")))
        XCTAssertFalse(FogTranscriptEnds(oldest: "a", newest: "y").movedAtOldest(from: FogTranscriptEnds(oldest: "a", newest: "z")))
    }

    // MARK: - Which bodies are read whole

    func testTheBodiesReadAreTheTurnsAboutWhereTheReaderIs() {
        let ids = (0..<100).map { "t\($0)" }
        var scroll = FogScroll()
        scroll.layout(range: 9_600)
        // Pinned at the newest: the newest turns.
        let newest = PanelHistory.nearby(ids, scroll: scroll, box: 400, side: 3)
        XCTAssertEqual(newest.center, "t97", "the middle of the box, 200 pt back from the newest end")
        XCTAssertEqual(newest.ids, ["t94", "t95", "t96", "t97", "t98", "t99"])
        // Scrolled all the way back: the oldest — the middle one and newer, since a body landing above the middle would
        // move the lines under a reader who has scrolled away.
        scroll.scroll(by: 9_600, momentum: false)
        let oldest = PanelHistory.nearby(ids, scroll: scroll, box: 400, side: 3)
        XCTAssertEqual(oldest.center, "t1")
        XCTAssertEqual(oldest.ids, ["t1", "t2", "t3", "t4"])
        // Halfway.
        scroll.scroll(by: -4_800, momentum: false)
        let halfway = PanelHistory.nearby(ids, scroll: scroll, box: 400, side: 3)
        XCTAssertEqual(halfway.center, "t49")
        XCTAssertEqual(halfway.ids, ["t49", "t50", "t51", "t52"])
        // Everything fits: the middle, and all of it within reach.
        let few = PanelHistory.nearby(["a", "b", "c"], scroll: FogScroll(), box: 400)
        XCTAssertEqual(few.ids, ["a", "b", "c"])
        XCTAssertEqual(few.center, "b")
        // Bounded however long the transcript: the bodies a panel holds are the reader's ceiling, not the session's.
        XCTAssertEqual(PanelHistory.nearby(ids, scroll: FogScroll(), box: 0).ids.count, PanelHistory.bodiesAround + 1)
        XCTAssertTrue(PanelHistory.nearby([], scroll: scroll, box: 400).ids.isEmpty)
        XCTAssertNil(PanelHistory.nearby([], scroll: scroll, box: 400).center)
    }

    // MARK: - Read, not heard

    /// The record's newest reply, or the transcript's, was already there: it shows whole, where a live one comes in word by
    /// word.
    @MainActor
    func testAReplyReadFromTheRecordShowsWholeAndALiveOneComesInWordByWord() {
        let reply = "Laid out the amount field and its label, and the tests pass."
        let words = WordReveal.words(reply).count
        let read = FogTextState()
        read.update(turns: [ConversationTurn(id: "live-old", fromYou: false, text: "Earlier.")], now: 0)
        read.update(turns: [ConversationTurn(id: "r4", fromYou: false, text: reply)], now: 10, reveals: false)
        XCTAssertEqual(read.reveal.shown(at: 10), words, "all of it at once")
        XCTAssertFalse(read.reveal.isRevealing(at: 10))

        let heard = FogTextState()
        heard.update(turns: [ConversationTurn(id: "live-old", fromYou: false, text: "Earlier.")], now: 0)
        heard.update(turns: [ConversationTurn(id: "a4", fromYou: false, text: reply)], now: 10)
        XCTAssertLessThan(heard.reveal.shown(at: 10), words, "a live reply comes in as it is said")
        XCTAssertTrue(heard.reveal.isRevealing(at: 10))
        // The turns the host reads the record around are what it was handed.
        XCTAssertEqual(read.turnIDs, ["r4"])
    }
}
