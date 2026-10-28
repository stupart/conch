import XCTest
@testable import ConchDesign

/// What the window says when a runaway guard trips (RunawayGuards.swift; src/runaway.ts): one plain line, the newest
/// first, until it is over or OK'd.
final class RunawayGuardsTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!
    private let posix = Locale(identifier: "en_US_POSIX")

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
        XCTAssertEqual(trips[0].id, "whisper-server@1793232000000")
    }

    func testSaysWhatStoppedWhyAndWhenItTriesAgain() {
        let trip = RunawayGuardTrip(
            name: "whisper-server", what: "restarting the speech engine (whisper-server)", why: "failed 5 times in 10 min",
            trippedAt: 1_793_232_000_000, retryAt: 1_793_232_300_000
        )
        XCTAssertEqual(
            // Foundation's short time puts a narrow no-break space before AM.
            RunawayGuardNotice.sentence(trip, timeZone: utc, locale: posix),
            "conch stopped restarting the speech engine (whisper-server): it failed 5 times in 10 min. It tries again at 12:05\u{202F}AM."
        )
        let ceiling = RunawayGuardTrip(name: "processes", what: "starting more processes", why: "had 64 running at once", trippedAt: 1)
        XCTAssertEqual(
            RunawayGuardNotice.sentence(ceiling, more: 2, timeZone: utc, locale: posix),
            "conch stopped starting more processes: it had 64 running at once. (2 more)"
        )
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
