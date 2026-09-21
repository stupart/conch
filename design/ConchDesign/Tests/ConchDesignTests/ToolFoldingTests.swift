import XCTest
@testable import ConchDesign

final class ToolFoldingTests: XCTestCase {
    /// Fixtures are written in SECONDS, because that is what the summaries read in; the helper
    /// hands the rule the wire's epoch milliseconds. Repointed when the fold was found reading
    /// raw stamps as seconds — the Mac's real runs (~1 s apart) all lost their time to the
    /// idle ceiling, and the fixtures here, written in seconds, could not see it.
    private func item(_ id: String, _ isTool: Bool, _ atSeconds: Double? = nil)
        -> (id: String, isTool: Bool, at: Double?) { (id, isTool, atSeconds.map { $0 * 1_000 }) }

    /// Stamps exactly as `/tmp/conch-sessions.json` carried them on 2026-09-21: five steps
    /// 1.06 s apart, which read "5 steps" on the Mac and would read "Worked 4s" here.
    func testTheWiresMillisecondsReadAsSeconds() {
        let wire: [(id: String, isTool: Bool, at: Double?)] = [
            ("t1", true, 1_789_973_418_092), ("t2", true, 1_789_973_419_155), ("t3", true, 1_789_973_420_222),
            ("t4", true, 1_789_973_421_287), ("t5", true, 1_789_973_422_353),
        ]
        let run = ToolFolding.runs(for: wire).first
        XCTAssertEqual(run?.seconds.map { ($0 * 1_000).rounded() }, 4_261)
        XCTAssertEqual(run?.summary, "Worked 4s · 5 steps")
        // 300 ms between two parallel calls is under a second, never "Worked 5m".
        XCTAssertEqual(ToolFolding.runs(for: [("a", true, 1_789_973_418_000), ("b", true, 1_789_973_418_300)]).first?.summary, "2 steps")
    }

    func testConsecutiveStepsFoldIntoOneRun() {
        let runs = ToolFolding.runs(for: [
            item("a", false), item("t1", true), item("t2", true), item("t3", true), item("b", false),
        ])
        XCTAssertEqual(runs.count, 1)
        XCTAssertEqual(runs.first?.itemIDs, ["t1", "t2", "t3"])
        XCTAssertEqual(runs.first?.count, 3)
        XCTAssertEqual(runs.first?.id, "t1")
    }

    /// A lone step hides one line behind another line, and charges a click to undo it.
    func testASingleStepDoesNotFold() {
        XCTAssertTrue(ToolFolding.runs(for: [item("a", false), item("t", true), item("b", false)]).isEmpty)
    }

    /// The sentences either side of a run are exactly what the run sits between.
    func testASentenceBreaksTheRun() {
        let runs = ToolFolding.runs(for: [
            item("t1", true), item("t2", true), item("said", false), item("t3", true), item("t4", true),
        ])
        XCTAssertEqual(runs.map(\.itemIDs), [["t1", "t2"], ["t3", "t4"]])
    }

    func testARunAtEitherEndIsStillARun() {
        let runs = ToolFolding.runs(for: [item("t1", true), item("t2", true)])
        XCTAssertEqual(runs.map(\.itemIDs), [["t1", "t2"]])
        XCTAssertTrue(ToolFolding.runs(for: []).isEmpty)
    }

    func testTheSpanIsFirstToLast() {
        let runs = ToolFolding.runs(for: [
            item("t1", true, 1_000), item("t2", true, 1_060), item("t3", true, 1_110),
        ])
        XCTAssertEqual(runs.first?.seconds, 110)
    }

    /// An older daemon omits `at`. An invented duration is worse than none.
    func testAMissingTimestampMeansNoDurationRatherThanZero() {
        XCTAssertNil(ToolFolding.runs(for: [item("t1", true), item("t2", true, 1_060)]).first?.seconds)
        XCTAssertNil(ToolFolding.runs(for: [item("t1", true, 1_000), item("t2", true)]).first?.seconds)
    }

    func testTheSummaryIsTheLine3SaysItIs() {
        XCTAssertEqual(ToolRun(itemIDs: ["a", "b", "c"], seconds: 110).summary, "Worked 1m 50s · 3 steps")
        XCTAssertEqual(ToolRun(itemIDs: ["a", "b"], seconds: 9).summary, "Worked 9s · 2 steps")
        XCTAssertEqual(ToolRun(itemIDs: ["a", "b"], seconds: 120).summary, "Worked 2m · 2 steps")
        XCTAssertEqual(ToolRun(itemIDs: ["a", "b"], seconds: 3_720).summary, "Worked 1h 2m · 2 steps")
    }

    /// No duration, and anything under a second, says only what is certainly true.
    func testWithoutATimeTheLineIsJustTheCount() {
        XCTAssertEqual(ToolRun(itemIDs: ["a", "b"], seconds: nil).summary, "2 steps")
        XCTAssertEqual(ToolRun(itemIDs: ["a", "b"], seconds: 0.4).summary, "2 steps")
    }

    /// The bug the shipped fold showed: two adjacent steps four hours apart, because the
    /// session sat waiting on a person, rendered as "Worked 4h 40m".
    func testAnIdleGapMeansNoDurationRatherThanAnOverclaim() {
        let idle = ToolFolding.runs(for: [
            item("t1", true, 1_000), item("t2", true, 1_000 + 4 * 3_600),
        ])
        XCTAssertEqual(idle.first?.count, 2, "the run still folds — only its duration is unsafe")
        XCTAssertNil(idle.first?.seconds)
        XCTAssertEqual(idle.first?.summary, "2 steps")
    }

    /// A slow step is still work: the ceiling is generous so a long build keeps its time.
    func testALongButPlausibleStepKeepsItsDuration() {
        let runs = ToolFolding.runs(for: [
            item("t1", true, 1_000), item("t2", true, 1_500), item("t3", true, 1_900),
        ])
        XCTAssertEqual(runs.first?.seconds, 900)
    }

    /// One unstamped step in the middle means the gaps cannot be checked at all.
    func testAHoleInTheStampsMeansNoDuration() {
        XCTAssertNil(ToolFolding.runs(for: [
            item("t1", true, 1_000), item("t2", true), item("t3", true, 1_060),
        ]).first?.seconds)
    }

    /// Clocks step backwards (a rebuilt transcript, a corrected timestamp); a negative
    /// duration would render as "Worked -3s".
    func testTimeGoingBackwardsYieldsNoDuration() {
        XCTAssertNil(ToolFolding.runs(for: [item("t1", true, 1_100), item("t2", true, 1_000)]).first?.seconds)
    }
}
