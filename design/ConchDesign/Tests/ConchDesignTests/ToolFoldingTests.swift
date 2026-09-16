import XCTest
@testable import ConchDesign

final class ToolFoldingTests: XCTestCase {
    private func item(_ id: String, _ isTool: Bool, _ at: Double? = nil)
        -> (id: String, isTool: Bool, at: Double?) { (id, isTool, at) }

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

    /// Clocks step backwards (a rebuilt transcript, a corrected timestamp); a negative
    /// duration would render as "Worked -3s".
    func testTimeGoingBackwardsYieldsNoDuration() {
        XCTAssertNil(ToolFolding.runs(for: [item("t1", true, 1_100), item("t2", true, 1_000)]).first?.seconds)
    }
}
