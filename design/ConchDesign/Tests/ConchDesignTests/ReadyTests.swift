import Darwin
import SwiftUI
import XCTest
@testable import ConchDesign

/// How you get into the deconstructed UI and what "ready" means: the rule every surface counts by, the green that marks
/// it, the menu that opens it, and the knock on a local page before it is shown.
final class ReadyTests: XCTestCase {
    private let schemes: [ColorScheme] = [.light, .dark]

    // MARK: The rule

    /// Held AND not looked at. Looking used to change nothing: the mark stayed green and the pill kept cycling through
    /// what Tyler had already opened.
    func testReadyIsHeldNotWorkingAndNotYetLookedAt() {
        XCTAssertTrue(ReadyForYou.isReady(working: false, viewedAt: [nil]))
        XCTAssertFalse(ReadyForYou.isReady(working: false, viewedAt: [1_000]), "looked at, so no longer ready")
        // Any one held deliverable nobody has looked at keeps the session ready.
        XCTAssertTrue(ReadyForYou.isReady(working: false, viewedAt: [1_000, nil]))
        XCTAssertFalse(ReadyForYou.isReady(working: false, viewedAt: [1_000, 2_000]))
        // A session back at work isn't waiting on you, looked at or not; nothing held is nothing ready.
        XCTAssertFalse(ReadyForYou.isReady(working: true, viewedAt: [nil]))
        XCTAssertFalse(ReadyForYou.isReady(working: false, viewedAt: []))
    }

    /// Approved is done (2026-10-05, Tyler's decision): out of Ready for you whether or not anyone looked, and the rest of
    /// what is held still counts.
    func testApprovedIsDoneNotReady() {
        XCTAssertTrue(ReadyForYou.isReady(working: false, held: [(viewedAt: nil, approvedAt: nil)]))
        XCTAssertFalse(ReadyForYou.isReady(working: false, held: [(viewedAt: nil, approvedAt: 2_000)]), "approved, never looked at")
        XCTAssertFalse(ReadyForYou.isReady(working: false, held: [(viewedAt: 1_000, approvedAt: 2_000)]))
        XCTAssertTrue(ReadyForYou.isReady(working: false, held: [(viewedAt: 1_000, approvedAt: 2_000), (viewedAt: nil, approvedAt: nil)]))
        XCTAssertFalse(ReadyForYou.isReady(working: true, held: [(viewedAt: nil, approvedAt: nil)]))
        XCTAssertTrue(ReadyForYou.isWaiting(viewedAt: nil, approvedAt: nil))
        XCTAssertFalse(ReadyForYou.isWaiting(viewedAt: nil, approvedAt: 1))
        XCTAssertFalse(ReadyForYou.isWaiting(viewedAt: 1, approvedAt: nil))
        // The old reading is the new one with nothing approved.
        for viewed: [Double?] in [[nil], [1], [1, nil], []] {
            XCTAssertEqual(ReadyForYou.isReady(working: false, viewedAt: viewed),
                           ReadyForYou.isReady(working: false, held: viewed.map { (viewedAt: $0, approvedAt: nil) }))
        }
    }

    // MARK: The green

    /// A mark, so 3:1, on every ground the sidebar and the stage give it: #30B35A measured 2.41 on the light ground and
    /// 2.72 on white.
    func testReadyClearsThreeToOneOnEveryGround() {
        for scheme in schemes {
            for ground in ConchColor.grounds {
                let ratio = ConchColor.ready.rgba(scheme).contrast(on: ground.rgba(scheme))
                XCTAssertGreaterThanOrEqual(ratio, 3, "ready on \(ground.name) in \(scheme) is \(String(format: "%.2f", ratio)):1")
            }
        }
        // The light value is the one the Mac's waiting mark already carries, and the green it replaces failed.
        XCTAssertEqual(ConchColor.ready.light, ConchRGBA(0x279B4C))
        XCTAssertLessThan(ConchRGBA(0x30B35A).contrast(on: ConchColor.ground.light), 3)
        // Dark stays: it cleared 3:1 everywhere already.
        XCTAssertEqual(ConchColor.ready.dark, ConchRGBA(0x30B35A))
    }

    /// The orb's white check on its green: 2.72 before, in both schemes, 3.57 now. The disc is the light green in dark
    /// too, where the brighter dark green would put the check back at 2.72; and the disc itself still reads on every
    /// dark ground.
    func testTheReadyOrbsCheckClearsThreeToOne() {
        for scheme in schemes {
            let ratio = ConchColor.onVoice.rgba(scheme).contrast(on: VoiceOrb.readyFill)
            XCTAssertGreaterThanOrEqual(ratio, 3, "the check in \(scheme) is \(String(format: "%.2f", ratio)):1")
        }
        XCTAssertLessThan(ConchColor.onVoice.dark.contrast(on: ConchColor.ready.dark), 3, "why the disc isn't the dark value")
        for ground in ConchColor.grounds {
            XCTAssertGreaterThanOrEqual(VoiceOrb.readyFill.contrast(on: ground.dark), 3, "the disc on \(ground.name) in dark")
        }
    }

    /// The listening mic is dark on the orange: white measured 2.06.
    func testTheListeningMicReadsOnTheOrange() {
        let orange = ConchColor.listening.light
        XCTAssertEqual(ConchColor.listening.light, ConchColor.listening.dark, "the orange is the same in both schemes")
        XCTAssertGreaterThanOrEqual(VoiceOrb.onListening.contrast(on: orange), 7)
        XCTAssertLessThan(ConchColor.onVoice.light.contrast(on: orange), 3, "white, as it was")
    }

    /// Working's dot in the menu is filled, as the sidebar draws working; the hollow ring is the sidebar's paused
    /// sub-agent.
    func testWorkingIsAFilledDotInTheMenu() {
        XCTAssertEqual(StatusMenu.Dot.working.symbol, "circle.fill")
        XCTAssertEqual(StatusMenu.Dot.ready.symbol, "circle.fill")
        XCTAssertEqual(StatusMenu.Dot.working.colour.name, ConchColor.active.name)
        XCTAssertEqual(StatusMenu.Dot.ready.colour.name, ConchColor.ready.name)
    }

    // MARK: The menu

    private func input(ready: [StatusMenu.Session] = [], working: [StatusMenu.Session] = []) -> StatusMenu.Input {
        StatusMenu.Input(voice: .ready, quiet: false, exchangeActive: false, ready: ready, working: working)
    }

    private func items(_ rows: [StatusMenu.Row]) -> [StatusMenu.Item] {
        rows.compactMap { row -> StatusMenu.Item? in
            if case let .item(item) = row { return item }
            return nil
        }
    }

    /// Title case; no "Show", which is the screen recording's word. Since the overlays went (2026-11-11) the menu has
    /// none of their items (Control Bar, Conversation Panel, Reply Line, With Panel Off, Draw on Screen), whatever is
    /// ready or working, and no two separators meet where they were.
    func testTheMenuIsTitleCaseWithNoOverlayItems() {
        let titles = items(StatusMenu.rows(input())).map(\.title)
        XCTAssertEqual(titles, ["Talk", "Quiet", "Read Replies Aloud", "Stop Speaking", "Floating Pill", "Open conch", "Settings…"])
        // The floating pill's switch (2026-11-11), ticked while it is on, which it is until turned off.
        let pill = { (input: StatusMenu.Input) in self.items(StatusMenu.rows(input)).first { $0.command == .floatingPill } }
        XCTAssertEqual(pill(input())?.mark, .on)
        var off = input()
        off.floatingPill = false
        XCTAssertEqual(pill(off)?.mark, .off)
        XCTAssertFalse(titles.contains { $0.hasPrefix("Show") })
        let ready = [StatusMenu.Session(id: "r", label: "Ready one")], working = [StatusMenu.Session(id: "w", label: "Working one")]
        for (ready, working) in [([], []), (ready, []), ([], working), (ready, working)] as [([StatusMenu.Session], [StatusMenu.Session])] {
            let rows = StatusMenu.rows(input(ready: ready, working: working))
            for (row, next) in zip(rows, rows.dropFirst()) { XCTAssertFalse(row == .separator && next == .separator, "two separators meet") }
            for title in ["Control Bar", "Conversation Panel", "Reply Line", "With Panel Off", "Draw on Screen"] {
                XCTAssertFalse(items(rows).contains { $0.title == title }, title)
            }
        }
        // Settings…, last, with the window's own ⌘, beside it: it opens the window on its Settings page.
        let settings = items(StatusMenu.rows(input())).last
        XCTAssertEqual(settings?.command, .settings)
        XCTAssertEqual(settings?.key, ",")
        XCTAssertEqual(settings?.modifiers, [.command])
        var listening = input()
        listening.voice = .listening
        XCTAssertTrue(items(StatusMenu.rows(listening)).contains { $0.title == "Stop Listening" })
    }

    /// A ready row opens its item; conch's window on it is the ⌥ alternate right after it. Working
    /// rows still open conch on the session.
    func testReadyRowsOpenTheItemAndOptionOpensConch() {
        let rows = StatusMenu.rows(input(
            ready: [.init(id: "r1", label: "About page wireframe"), .init(id: "r2", label: "Morrow")],
            working: [.init(id: "w1", label: "Parser")]
        ))
        let ready = rows.firstIndex(of: .section("Ready for you"))
        let working = rows.firstIndex(of: .section("Working"))
        XCTAssertNotNil(ready)
        XCTAssertGreaterThan(working ?? -1, ready ?? .max)
        let list = items(rows)
        let first = list.firstIndex { $0.command == .openItem(session: "r1") }
        XCTAssertNotNil(first)
        if let first {
            XCTAssertEqual(list[first].title, "About page wireframe")
            XCTAssertEqual(list[first].dot, .ready)
            XCTAssertFalse(list[first].alternate)
            let alternate = list[first + 1]
            XCTAssertEqual(alternate.command, .openSession("r1"))
            XCTAssertTrue(alternate.alternate)
            XCTAssertEqual(alternate.modifiers, [.option])
            XCTAssertEqual(alternate.key, list[first].key, "an alternate shares its item's key equivalent")
        }
        XCTAssertEqual(list.first { $0.title == "Parser" }?.command, .openSession("w1"))
        XCTAssertEqual(list.first { $0.title == "Parser" }?.dot, .working)
        // Nothing ready and nothing working: no sections at all.
        XCTAssertFalse(StatusMenu.rows(input()).contains { row in
            if case .section = row { return true }
            return false
        })
    }

    // MARK: The knock on a local page

    func testOnlyAPageOnThisMachineHasAPortToKnockOn() {
        XCTAssertEqual(LocalServer.port(of: URL(string: "http://localhost:3111/prime")!), 3111)
        XCTAssertEqual(LocalServer.port(of: URL(string: "http://127.0.0.1/")!), 80)
        XCTAssertEqual(LocalServer.port(of: URL(string: "https://localhost/")!), 443)
        XCTAssertEqual(LocalServer.port(of: URL(string: "http://[::1]:5173/")!), 5173)
        XCTAssertEqual(LocalServer.port(of: URL(string: "http://app.localhost:3000")!), 3000)
        XCTAssertEqual(LocalServer.port(of: URL(string: "http://0.0.0.0:8080")!), 8080)
        XCTAssertEqual(LocalServer.port(of: URL(string: "http://127.4.5.6:9000")!), 9000)
        XCTAssertNil(LocalServer.port(of: URL(string: "https://example.com:3111/")!))
        XCTAssertNil(LocalServer.port(of: URL(string: "http://128.0.0.1:3111/")!))
        XCTAssertNil(LocalServer.port(of: URL(fileURLWithPath: "/tmp/page.html")))
        XCTAssertEqual(LocalServer.name(of: URL(string: "http://localhost:3111/prime")!), "localhost:3111")
        XCTAssertEqual(LocalServer.name(of: URL(string: "http://[::1]:5173/")!), "[::1]:5173")
    }

    /// A real listener answers the knock; once it closes, the same port is refused. And a page that isn't local is
    /// never called down.
    func testTheKnockFindsAListenerAndNoticesItGone() async throws {
        let listener = Darwin.socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
        XCTAssertGreaterThanOrEqual(listener, 0)
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr = in_addr(s_addr: UInt32(0x7F00_0001).bigEndian)
        address.sin_port = 0
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(Darwin.listen(listener, 4), 0)
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.getsockname(listener, $0, &length) }
        }
        let port = Int(UInt16(bigEndian: address.sin_port))
        XCTAssertGreaterThan(port, 0)

        let up = await LocalServer.isListening(URL(string: "http://localhost:\(port)/")!)
        XCTAssertTrue(up, "a listener on 127.0.0.1:\(port) answers")
        let numeric = await LocalServer.isListening(URL(string: "http://127.0.0.1:\(port)/")!)
        XCTAssertTrue(numeric)
        Darwin.close(listener)
        let down = await LocalServer.isListening(URL(string: "http://localhost:\(port)/")!)
        XCTAssertFalse(down, "nothing on :\(port) once it closed")
        let remote = await LocalServer.isListening(URL(string: "https://example.com/")!)
        XCTAssertTrue(remote, "not local: nothing to say it's down")
    }

    /// A connect that fails at once, rather than after the wait, is not a listener either: on loopback a refusal comes
    /// back through the wait (`SO_ERROR`), so it takes an address nothing can be reached on to fail at the first step.
    func testAConnectThatFailsAtOnceIsNotAListener() {
        XCTAssertFalse(LocalServer.accepts(.v4(0xFFFF_FFFF), port: 9, timeout: 0.1))
    }

    /// Read replies aloud, one click from the menu bar, ticked while it's on (2026-10-09).
    func testTheMenuOffersReadRepliesAloudTickedWhileOn() {
        func mark(_ on: Bool) -> StatusMenu.Mark? {
            let input = StatusMenu.Input(voice: .ready, quiet: true, exchangeActive: false, ready: [], working: [], readAloud: on)
            for row in StatusMenu.rows(input) { if case let .item(item) = row, item.command == .readAloud { return item.mark } }
            return nil
        }
        XCTAssertEqual(mark(true), .on)
        XCTAssertEqual(mark(false), .off)
    }
}
