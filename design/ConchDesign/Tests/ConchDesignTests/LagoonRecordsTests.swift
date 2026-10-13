import XCTest
@testable import ConchDesign

/// A session's conversation for the lagoon, read where the app reads it (LagoonRecords.swift): the daemon's published
/// window, else conch's record store. Which sessions are read, what a recorded page becomes, and when one is read again.
final class LagoonRecordsTests: XCTestCase {
    private typealias Item = LagoonSnapshot.Source.Item
    private typealias Row = LagoonSnapshot.Source.Row
    private let t0 = Date(timeIntervalSince1970: 1_000)

    private func message(_ id: String, _ role: String, _ text: String, at: Double, bodyBytes: Int? = nil) -> HistoryItem {
        HistoryItem(id: "rec-\(id)", kind: "message", role: role, nativeId: id, at: at, preview: text, bodyBytes: bodyBytes ?? text.utf8.count)
    }

    // MARK: Which sessions

    func testOnlySessionsWithNoPublishedConversationAreRead() {
        let rows = [Row(id: "busy", at: 5), Row(id: "quiet", at: 3), Row(id: "empty", at: 2), Row(id: "agent", parentSessionId: "busy", at: 1)]
        let published: [String: [Item]] = ["busy": [Item(id: "m", kind: "assistant", text: "hi", at: 5)], "empty": []]
        let records = LagoonRecords()
        XCTAssertEqual(records.wanted(rows: rows, published: published, first: nil, now: t0), ["quiet", "empty", "agent"])
        // The session the window views goes first.
        XCTAssertEqual(records.wanted(rows: rows, published: published, first: "agent", now: t0), ["agent", "quiet", "empty"])
        // A session the window views that the daemon published goes nowhere.
        XCTAssertEqual(records.wanted(rows: rows, published: published, first: "busy", now: t0), ["quiet", "empty", "agent"])
    }

    func testReadOnceForItsRowAsItStandsAndAgainWhenTheRowChanges() {
        var records = LagoonRecords()
        let row = Row(id: "s", status: "waiting", at: 10, reviews: [.init(id: "r1", at: 9)])
        records.store("s", mark: LagoonRecords.mark(row), page: [message("m1", "assistant", "done", at: 9)], at: t0)
        let later = t0.addingTimeInterval(LagoonRecords.refreshAfter)
        XCTAssertEqual(records.wanted(rows: [row], published: [:], first: nil, now: later.addingTimeInterval(600)), [])
        // A new status, a new time on the row, or a new result: read again, though no sooner than 15 s after the last.
        var working = row
        working.status = "working"
        XCTAssertEqual(records.wanted(rows: [working], published: [:], first: nil, now: t0.addingTimeInterval(14)), [])
        XCTAssertEqual(records.wanted(rows: [working], published: [:], first: nil, now: later), ["s"])
        var moved = row
        moved.at = 11
        XCTAssertEqual(records.wanted(rows: [moved], published: [:], first: nil, now: later), ["s"])
        var newResult = row
        newResult.reviews.append(.init(id: "r2", at: 12))
        XCTAssertEqual(records.wanted(rows: [newResult], published: [:], first: nil, now: later), ["s"])
    }

    func testAFailedReadIsTriedAgainAfterThirtySecondsKeepingWhatItHad() {
        var records = LagoonRecords()
        let row = Row(id: "s", at: 10)
        let mark = LagoonRecords.mark(row)
        records.store("s", mark: "older", page: [message("m1", "user", "hello", at: 1)], at: t0)
        records.failed("s", mark: mark, at: t0)
        XCTAssertEqual(records.conversations["s"]?.map(\.text), ["hello"], "what was read before stays")
        XCTAssertEqual(records.wanted(rows: [row], published: [:], first: nil, now: t0.addingTimeInterval(29)), [])
        XCTAssertEqual(records.wanted(rows: [row], published: [:], first: nil, now: t0.addingTimeInterval(30)), ["s"])
    }

    func testStoringSaysWhetherWhatTheLagoonIsSentChangedAndGoneSessionsAreLetGo() {
        var records = LagoonRecords()
        XCTAssertTrue(records.store("s", mark: "a", page: [message("m1", "assistant", "one", at: 1)], at: t0))
        XCTAssertFalse(records.store("s", mark: "b", page: [message("m1", "assistant", "one", at: 1)], at: t0))
        XCTAssertFalse(records.store("t", mark: "a", page: [], at: t0), "nothing recorded is nothing sent")
        XCTAssertEqual(records.conversations.keys.sorted(), ["s"])
        records.forget(missing: ["t"])
        XCTAssertEqual(records.conversations, [:])
    }

    func testThePublishedWindowWinsAndTheRecordFillsIn() {
        let live = [Item(id: "live", kind: "assistant", text: "live", at: 2)]
        let recorded = [Item(id: "rec", kind: "assistant", text: "recorded", at: 1)]
        let merged = LagoonRecords.merged(
            published: ["a": live, "b": [], "c": []],
            recorded: ["a": recorded, "b": recorded, "d": recorded, "e": []]
        )
        XCTAssertEqual(merged["a"], live)
        XCTAssertEqual(merged["b"], recorded, "an empty window is no window")
        XCTAssertEqual(merged["c"], [], "published empty, nothing recorded: as the daemon published it")
        XCTAssertEqual(merged["d"], recorded)
        XCTAssertNil(merged["e"])
    }

    // MARK: A recorded page, as the live window's items

    func testMessagesAndToolCallsAsTheLiveWindowHasThem() {
        let page = [
            message("u1", "user", "Ship the fix", at: 1),
            HistoryItem(id: #"["[\"owner\",\"claude\",\"s\"]","tool_call","toolu_01ABC"]"#, kind: "tool_call", role: "assistant", nativeId: "a1", toolName: "Bash", at: 2,
                        preview: #"{"command":"gh pr create --draft","description":"Open the draft PR"}"#, bodyBytes: 60),
            HistoryItem(id: "rec-result", kind: "tool_result", role: "tool", toolName: "Bash", at: 3, preview: "https://example.com/pull/12"),
            HistoryItem(id: "rec-think", kind: "thinking", role: "assistant", at: 3.5, preview: "private thoughts"),
            HistoryItem(id: "rec-ctx", kind: "context", at: 3.6),
            HistoryItem(id: "rec-mat", kind: "material", role: "user", at: 3.7, preview: "/secret.png"),
            message("a2", "assistant", "Draft PR #12 is up.", at: 4),
            HistoryItem(id: "rec-sys", kind: "compaction", role: "system", at: 5, preview: "summary"),
        ]
        XCTAssertEqual(LagoonRecords.items(page), [
            Item(id: "u1", kind: "user", text: "Ship the fix", at: 1),
            Item(id: "tool:toolu_01ABC", kind: "tool", text: "Open the draft PR", at: 2),
            Item(id: "a2", kind: "assistant", text: "Draft PR #12 is up.", at: 4),
        ])
    }

    func testAMessageLongerThanItsPreviewIsMarkedCut() {
        let long = message("a", "assistant", String(repeating: "x", count: 240), at: 1, bodyBytes: 2_168)
        XCTAssertEqual(LagoonRecords.items([long]).first?.text, String(repeating: "x", count: 240) + "…")
    }

    /// What Claude Code files under your name and you never typed is not a reply: as one, it would answer a result.
    func testMachineWrittenUserTextIsNotYours() {
        for text in [
            "<task-notification>\n<task-id>b1</task-id>",
            "  <system-reminder>note</system-reminder>",
            "<local-command-stdout>ok</local-command-stdout>",
            "<command-name>/clear</command-name>",
            "[Request interrupted by user for tool use]",
            "[Image: original 2880x1640]",
        ] {
            XCTAssertTrue(LagoonRecords.isMachineWritten(text), text)
            XCTAssertEqual(LagoonRecords.items([message("m", "user", text, at: 1)]), [], text)
        }
        XCTAssertFalse(LagoonRecords.isMachineWritten("Can you check <task-notification> handling?"))
        // An agent's answer that starts like one is still its answer.
        XCTAssertEqual(LagoonRecords.items([message("m", "assistant", "[Image: …] is what you sent", at: 1)]).count, 1)
        // Pasted text loses its tags, as the live window's does.
        XCTAssertEqual(LagoonRecords.items([message("m", "user", "\n\n<pasted_content id=\"6a36\">\nthe long brief\n</pasted_content id=\"6a36\">\n", at: 1)]).first?.text,
                       "the long brief")
        XCTAssertEqual(LagoonRecords.items([message("m", "user", "   ", at: 1)]), [], "nothing said")
    }

    func testAStepSaysWhatItDidAsTheDaemonSummarisesIt() {
        func step(_ preview: String, _ tool: String = "Bash") -> String? {
            LagoonRecords.items([HistoryItem(id: "c", kind: "tool_call", role: "assistant", toolName: tool, at: 1, preview: preview, bodyBytes: 999)]).first?.text
        }
        XCTAssertEqual(step(#"{"command":"git status\ngit log","description":"See what changed"}"#), "See what changed")
        XCTAssertEqual(step(#"{"command":"git status\ngit log"}"#), "git status")
        XCTAssertEqual(step(#"{"file_path":"/Users/x/notes.md"}"#, "Read"), "/Users/x/notes.md")
        // Cut mid-JSON at 240 characters: the first key whose value is there whole.
        XCTAssertEqual(step(#"{"pattern":"needle \"quoted\"","path":"/Users/x/very/long/path/that/goes/on"#, "Grep"), #"needle "quoted""#)
        XCTAssertEqual(step(#"{"content":"a very long file body that was cut"#, "Write"), "Write")
        XCTAssertEqual(step("", "TodoWrite"), "TodoWrite")
    }
}

extension LagoonRecordsTests {
    /// A page is about twenty items, mostly steps: read back until six messages, or four pages.
    func testReadBackUntilSixMessagesOrFourPages() {
        let steps = (0..<10).map { HistoryItem(id: "c\($0)", kind: "tool_call", role: "assistant", toolName: "Bash", at: Double($0)) }
        let five = (0..<5).map { message("m\($0)", $0 % 2 == 0 ? "assistant" : "user", "said \($0)", at: Double(20 + $0)) }
        XCTAssertTrue(LagoonRecords.wantsOlder(steps, pagesRead: 1))
        XCTAssertTrue(LagoonRecords.wantsOlder(steps + five, pagesRead: 2))
        XCTAssertFalse(LagoonRecords.wantsOlder(steps + five + [message("m5", "assistant", "six", at: 30)], pagesRead: 2))
        XCTAssertFalse(LagoonRecords.wantsOlder(steps, pagesRead: 4), "four pages is enough reading")
        // A machine-written "you" isn't a message.
        XCTAssertTrue(LagoonRecords.wantsOlder(five + [message("n", "user", "<task-notification>x", at: 31)], pagesRead: 1))
    }
}
