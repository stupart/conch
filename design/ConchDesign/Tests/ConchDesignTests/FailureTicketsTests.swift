import XCTest
@testable import ConchDesign

/// Settings › Failures (2026-10-28, docs/failure-tickets.md): what the daemon's desk sends decodes, what the page asks
/// for encodes as the socket takes it, and the words and grouping it shows. Names here are made up.
final class FailureTicketsTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_000_000)
    private var nowMs: Double { now.timeIntervalSince1970 * 1_000 }

    private func ticket(
        _ id: String = "0123456789ab", number: Int = 12, status: FailureTicketStatus = .open, lastSeen: Double? = nil,
        count: Int = 30, sessions: Int = 9, unseen: Bool = true, fix: FailureTicketFix? = nil
    ) -> FailureTicketSummary {
        FailureTicketSummary(
            id: id, number: number, origin: "mac", operation: "open-deliverable", title: "Couldn't find <file>", status: status,
            statusAt: nowMs, firstSeen: nowMs - 86_400_000, lastSeen: lastSeen ?? nowMs - 2 * 3_600_000, count: count,
            sessionCount: sessions, unseen: unseen, fix: fix
        )
    }

    // MARK: The wire

    /// The shape src/failure-tickets.ts's `list()` sends, field for field.
    func testTheDaemonsListDecodes() throws {
        let json = """
        {"kind":"failure-tickets","tickets":[{"id":"0123456789ab","number":7,"origin":"daemon","operation":"inject",
        "title":"Account profiles must have separate directories","status":"fixing","statusAt":1793000000000,
        "firstSeen":1792990000000,"lastSeen":1792999000000,"count":2,"sessionCount":1,"unseen":false,
        "fix":{"by":"you","startedAt":1793000000000,"branch":"fix/ticket-7","backgroundId":"conch-abc",
        "pr":{"url":"https://github.com/o/r/pull/580","number":580,"state":"open"}}}],
        "autoFix":{"on":false,"today":0,"cap":3},"fix":{"available":true,"folder":"/Users/x/conch"}}
        """
        let list = try JSONDecoder().decode(FailureTicketList.self, from: Data(json.utf8))
        XCTAssertEqual(list.tickets.first?.status, .fixing)
        XCTAssertEqual(list.tickets.first?.fix?.pr?.number, 580)
        XCTAssertEqual(list.autoFix, .init(on: false, today: 0, cap: 3))
        XCTAssertEqual(list.fix, .init(available: true, folder: "/Users/x/conch"))
        XCTAssertNil(list.hidden)
    }

    func testTheRequestsAreTheSocketsShapes() throws {
        func encoded(_ request: FailureTicketsRequest) throws -> [String: AnyHashable] {
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: AnyHashable]
        }
        XCTAssertEqual(try encoded(.list), ["kind": "failure-tickets"])
        XCTAssertEqual(try encoded(.act(id: "0123456789ab", action: .markFixed)), ["kind": "failure-ticket", "id": "0123456789ab", "action": "mark-fixed"])
        XCTAssertEqual(try encoded(.act(id: "all", action: .seen)), ["kind": "failure-ticket", "id": "all", "action": "seen"])
        XCTAssertEqual(try encoded(.setAutoFix(true)), ["kind": "set-config", "key": "failure-autofix", "value": true])
    }

    // MARK: The words

    func testATitlesPlaceholdersReadAsWords() {
        XCTAssertEqual(FailureTickets.displayTitle("Couldn't find <file>"), "Couldn't find a file")
        XCTAssertEqual(FailureTickets.displayTitle("That's a file on your Mac, not a page: <path>"), "That's a file on your Mac, not a page: a path")
        XCTAssertEqual(FailureTickets.displayTitle("still running after <n> s."), "Still running after N s.")
        XCTAssertEqual(FailureTickets.displayTitle("from this window (<id>), not the conversation"), "From this window (…), not the conversation")
        XCTAssertEqual(FailureTickets.displayTitle("the target is on the page but conch couldn't bring it into view."), "The target is on the page but conch couldn't bring it into view.")
        XCTAssertEqual(FailureTickets.displayTitle("--sandbox can't be used here"), "--sandbox can't be used here")
        XCTAssertEqual(FailureTickets.displayTitle("conch's Mac app isn't running, so it can't render pages"), "conch's Mac app isn't running, so it can't render pages")
    }

    func testTheLineUnderATitleSaysWhichWhereHowOftenAndWhen() {
        XCTAssertEqual(FailureTickets.meta(ticket(), now: now), "#12 · mac · open-deliverable · 30 times in 9 sessions · 2h ago")
        XCTAssertEqual(FailureTickets.meta(ticket(lastSeen: nowMs - 10_000, count: 1, sessions: 1), now: now), "#12 · mac · open-deliverable · once · just now")
        XCTAssertEqual(FailureTickets.ago(nowMs - 5 * 60_000, now: now), "5m")
        XCTAssertEqual(FailureTickets.ago(nowMs - 3 * 86_400_000, now: now), "3d")
    }

    func testWhereAFixStandsOnTheRowsRight() {
        XCTAssertNil(FailureTickets.standing(ticket(), now: now), "open: Fix is there instead")
        XCTAssertEqual(FailureTickets.standing(ticket(status: .fixing, fix: .init(by: "you", startedAt: nowMs, branch: "fix/ticket-12")), now: now), "Fixing")
        let pr = FailureTicketPR(url: "https://github.com/o/r/pull/580", number: 580, state: "open")
        XCTAssertEqual(FailureTickets.standing(ticket(status: .fixing, fix: .init(by: "you", startedAt: nowMs, branch: "b", pr: pr)), now: now), "PR #580")
        XCTAssertEqual(FailureTickets.standing(ticket(status: .fixed, fix: .init(by: "you", startedAt: nowMs, branch: "b", pr: pr)), now: now), "Fixed · #580")
        XCTAssertEqual(FailureTickets.standing(ticket(status: .ignored), now: now), "Ignored")
        XCTAssertEqual(FailureTickets.fixLine(.init(by: "auto", startedAt: nowMs - 3 * 60_000, branch: "fix/ticket-12"), now: now),
                       "Auto-fix started a session 3m ago on fix/ticket-12 · no PR yet")
        XCTAssertEqual(FailureTickets.fixLine(.init(by: "you", startedAt: nowMs - 3 * 60_000, branch: "fix/ticket-12", pr: pr), now: now),
                       "You started a fix session 3m ago on fix/ticket-12 · PR #580 open")
    }

    func testAutoFixSaysWhatItDoesAndWhatIsLeftToday() {
        XCTAssertEqual(FailureTickets.autoFixCaption(.init(on: false, today: 0, cap: 3)),
                       "Off. When on, conch starts a fix session for a ticket as it opens: one at a time, at most 3 a day. You still review and merge every PR.")
        XCTAssertTrue(FailureTickets.autoFixCaption(.init(on: true, today: 2, cap: 3)).hasSuffix("2 of 3 used today."))
    }

    func testTicketsAreGroupedInTheOrderTheyAreDealtWithNewestFirst() {
        let groups = FailureTickets.groups([
            ticket("a", status: .ignored),
            ticket("b", status: .open, lastSeen: nowMs - 100),
            ticket("c", status: .fixed),
            ticket("d", status: .open, lastSeen: nowMs - 10),
            ticket("e", status: .fixing),
        ])
        XCTAssertEqual(groups.map(\.title), ["Open", "Being fixed", "Fixed", "Ignored"])
        XCTAssertEqual(groups.first?.tickets.map(\.id), ["d", "b"])
        XCTAssertEqual(Set(groups.map(\.symbol)).count, 4)
        XCTAssertEqual(FailureTickets.groups([]), [])
    }

    func testEvidenceIsTheRecordsStateAKeyALine() {
        let lines = FailureTickets.evidenceLines(#"{"route":"clipboard","chars":42,"steps":["typed","no echo"],"label":"A"}"#)
        XCTAssertEqual(lines, ["chars: 42", "label: A", "route: clipboard", #"steps: ["typed","no echo"]"#])
        XCTAssertEqual(FailureTickets.evidenceLines("not json"), ["not json"])
        XCTAssertEqual(FailureTickets.evidenceLines(nil), [])
        let many = "{" + (0..<12).map { #""k\#($0)":\#($0)"# }.joined(separator: ",") + "}"
        XCTAssertEqual(FailureTickets.evidenceLines(many).last, "…")
    }

    // MARK: The store

    /// Showing the page tells the daemon every ticket is seen (the gear's dot goes), but the page keeps their dots for
    /// as long as it shows: the person looking still needs to tell the new ones apart.
    @MainActor
    func testShowingThePageMarksEverythingSeenButKeepsTheNewOnesDots() async throws {
        var sent: [FailureTicketsRequest] = []
        let list = FailureTicketList(tickets: [ticket("new", unseen: true), ticket("old", unseen: false)], autoFix: .init(on: false, today: 0, cap: 3), fix: .init(available: true, folder: "/c"))
        let store = FailureTicketsStore { request in
            sent.append(request)
            if request == .list {
                return try JSONEncoder().encode(EncodableList(list))
            }
            return Data(#"{"kind":"failure-ticket-ack"}"#.utf8)
        }
        await store.load()
        XCTAssertEqual(sent, [.list, .act(id: "all", action: .seen)])
        XCTAssertEqual(store.newOnArrival, ["new"])
        await store.load()
        XCTAssertEqual(sent.count, 4, "the next list still says unseen until the daemon's answer lands, and is told again")
        XCTAssertEqual(store.newOnArrival, ["new"])
    }

    @MainActor
    func testAFixThatCantStartSaysWhyOnItsRow() async {
        let store = FailureTicketsStore { request in
            if case .act(_, .fix) = request { return Data(#"{"kind":"failure-ticket-error","error":"conch isn't running from a git checkout here."}"#.utf8) }
            throw URLError(.cannotConnectToHost)
        }
        await store.act(ticket(), .fix)
        XCTAssertEqual(store.problems["0123456789ab"], "conch isn't running from a git checkout here.")
        XCTAssertEqual(store.phase, .unreachable)
    }
}

/// `FailureTicketList` is Decodable only, as the app is; the test encodes one the way the daemon would.
private struct EncodableList: Encodable {
    let list: FailureTicketList
    init(_ list: FailureTicketList) { self.list = list }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AnyKey.self)
        try container.encode("failure-tickets", forKey: AnyKey("kind"))
        try container.encode(list.tickets.map(EncodableTicket.init), forKey: AnyKey("tickets"))
        var autoFix = container.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("autoFix"))
        try autoFix.encode(list.autoFix.on, forKey: AnyKey("on"))
        try autoFix.encode(list.autoFix.today, forKey: AnyKey("today"))
        try autoFix.encode(list.autoFix.cap, forKey: AnyKey("cap"))
        var fix = container.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("fix"))
        try fix.encode(list.fix.available, forKey: AnyKey("available"))
        try fix.encodeIfPresent(list.fix.folder, forKey: AnyKey("folder"))
    }
}

private struct EncodableTicket: Encodable {
    let ticket: FailureTicketSummary

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AnyKey.self)
        try container.encode(ticket.id, forKey: AnyKey("id"))
        try container.encode(ticket.number, forKey: AnyKey("number"))
        try container.encode(ticket.origin, forKey: AnyKey("origin"))
        try container.encode(ticket.operation, forKey: AnyKey("operation"))
        try container.encode(ticket.title, forKey: AnyKey("title"))
        try container.encode(ticket.status.rawValue, forKey: AnyKey("status"))
        try container.encode(ticket.statusAt, forKey: AnyKey("statusAt"))
        try container.encode(ticket.firstSeen, forKey: AnyKey("firstSeen"))
        try container.encode(ticket.lastSeen, forKey: AnyKey("lastSeen"))
        try container.encode(ticket.count, forKey: AnyKey("count"))
        try container.encode(ticket.sessionCount, forKey: AnyKey("sessionCount"))
        try container.encode(ticket.unseen, forKey: AnyKey("unseen"))
    }
}

private struct AnyKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}
