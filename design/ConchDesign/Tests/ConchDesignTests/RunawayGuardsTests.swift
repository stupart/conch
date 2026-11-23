import XCTest
@testable import ConchDesign

/// What the window shows when a runaway guard trips (RunawayGuards.swift; src/runaway.ts): the newest first, until it
/// is over or OK'd.
final class RunawayGuardsTests: XCTestCase {
    func testDecodesWhatTheDaemonPublishes() throws {
        let json = """
        [{"name":"whisper-server","what":"restarting the speech engine (whisper-server)","why":"failed 5 times in 10 min",
          "detail":"replacement after child-exit","trippedAt":1793232000000,"retryAt":1793232300000,"trips":1},
         {"name":"processes","what":"starting more processes","why":"had 64 running at once (58 osascript)",
          "trippedAt":1793232100000,"trips":1}]
        """
        let trips = try JSONDecoder().decode([RunawayGuardTrip].self, from: Data(json.utf8))
        XCTAssertEqual(trips.map(\.name), ["whisper-server", "processes"])
        XCTAssertNil(trips[1].retryAt)
    }

    func testNewestFirstAndOkayedOnesGo() {
        let older = RunawayGuardTrip(name: "kokoro", what: "a", why: "b", trippedAt: 1)
        let newer = RunawayGuardTrip(name: "whisper-server", what: "a", why: "b", trippedAt: 2)
        XCTAssertEqual(RunawayGuardNotice.showing([older, newer], dismissed: []).map(\.name), ["whisper-server", "kokoro"])
        XCTAssertEqual(RunawayGuardNotice.showing([older, newer], dismissed: [newer.id]).map(\.name), ["kokoro"])
        // Tripping again is a new trip, with its own time: said again even though the last one was OK'd.
        let again = RunawayGuardTrip(name: "whisper-server", what: "a", why: "b", trippedAt: 3)
        XCTAssertEqual(RunawayGuardNotice.showing([again], dismissed: [newer.id]).map(\.name), ["whisper-server"])
    }
}
