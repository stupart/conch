import Darwin
import SwiftUI
import XCTest
@testable import ConchDesign

/// How you get into the deconstructed UI and what "ready" means: the rule every surface counts by, the green that marks
/// it, the Ready pill and the menu that open it, and the knock on a local page before it is shown.
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

    // MARK: The green

    private func composited(_ token: ConchColorToken, over ground: ConchRGBA, _ scheme: ColorScheme) -> ConchRGBA {
        let fill = token.rgba(scheme)
        func mix(_ fore: Double, _ back: Double) -> UInt32 { UInt32(((fore * fill.alpha + back * (1 - fill.alpha)) * 255).rounded()) }
        return ConchRGBA(mix(fill.red, ground.red) << 16 | mix(fill.green, ground.green) << 8 | mix(fill.blue, ground.blue))
    }

    /// A mark, so 3:1, on every ground the sidebar, the stage and the fog give it: #30B35A measured 2.41 on the light
    /// ground and 2.72 on white.
    func testReadyClearsThreeToOneOnEveryGround() {
        for scheme in schemes {
            for ground in ConchColor.grounds {
                let ratio = ConchColor.ready.rgba(scheme).contrast(on: ground.rgba(scheme))
                XCTAssertGreaterThanOrEqual(ratio, 3, "ready on \(ground.name) in \(scheme) is \(String(format: "%.2f", ratio)):1")
            }
            // The switcher draws it on its own glass over the fog; the control bar's orb on its glass over the page.
            let switcher = composited(ConchColor.overlayGlassStrong, over: ConchColor.fog.rgba(scheme), scheme)
            XCTAssertGreaterThanOrEqual(ConchColor.ready.rgba(scheme).contrast(on: switcher), 3, "ready on the switcher in \(scheme)")
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

    /// Working's dot in the menu and the switcher is filled, as the sidebar draws working; the hollow ring is the
    /// sidebar's paused sub-agent.
    func testWorkingIsAFilledDotInTheMenuAndTheSwitcher() {
        XCTAssertEqual(StatusMenu.Dot.working.symbol, "circle.fill")
        XCTAssertEqual(StatusMenu.Dot.ready.symbol, "circle.fill")
        XCTAssertEqual(StatusMenu.Dot.working.colour.name, ConchColor.active.name)
        XCTAssertEqual(StatusMenu.Dot.ready.colour.name, ConchColor.ready.name)
        XCTAssertEqual(FogSession.markSymbol(.working), "circle.fill")
        XCTAssertEqual(FogSession.markSymbol(.ready), "circle.fill")
    }

    // MARK: The Ready pill

    /// "<next session> · Ready · 1 of 3", and the tooltip opens it: never "3 sessions / Ready for you".
    @MainActor
    func testThePillNamesTheNextSessionAndWhereItIs() {
        let ready = ControlBar.Ready(label: "Prime page wireframe", position: 1, count: 3)
        XCTAssertEqual(ready.line, "Ready · 1 of 3")
        XCTAssertEqual(ready.help, "Open Prime page wireframe · 1 of 3")
        let bar = ControlBar(state: .ready, detail: "3 sessions", mode: .constant(.talk), ready: ready, onTap: {})
        XCTAssertEqual(bar.lines.title, "Prime page wireframe")
        XCTAssertEqual(bar.lines.subtitle, "Ready · 1 of 3")
        // One alone says nothing about a count; what the agent asked you to check follows the tooltip's first line.
        let one = ControlBar.Ready(label: "Arch brand page", position: 1, count: 1, inspect: "The button sits above the fold")
        XCTAssertEqual(one.line, "Ready")
        XCTAssertEqual(one.help, "Open Arch brand page\nThe button sits above the fold")
        // Speaking over it, the bar says what it is speaking about, and that something is still ready.
        let speaking = ControlBar(state: .speaking, detail: "Blueprint monorepo", mode: .constant(.talk), ready: ready, onTap: {})
        XCTAssertEqual(speaking.lines.title, "Blueprint monorepo")
        XCTAssertEqual(speaking.lines.subtitle, "Speaking · 3 ready")
    }

    /// Talk and Quiet no longer repeat the switch beside them: the second line is news, or nothing.
    @MainActor
    func testTalkAndQuietNeverRepeatTheSwitch() {
        for state in [VoiceState.talk, .quiet] {
            let quiet = ControlBar(state: state, detail: "Blueprint monorepo", mode: .constant(state == .quiet ? .quiet : .talk))
            XCTAssertEqual(quiet.lines.title, "Blueprint monorepo")
            XCTAssertNil(quiet.lines.subtitle, "\(state)")
            let news = ControlBar(state: state, detail: "Blueprint monorepo", mode: .constant(.talk), news: "2 working")
            XCTAssertEqual(news.lines.subtitle, "2 working")
        }
    }

    /// The listening ring sits in the capsule's round end with room all round; at a 36 pt orb it came within a point.
    func testTheListeningRingClearsTheCapsule() {
        XCTAssertGreaterThanOrEqual(ControlBar.ringClearance, 3)
        // Centred in the end: the orb's middle is as far from the end as from the top.
        XCTAssertEqual(PillMetrics.inset + ControlBar.orbLead + ControlBar.orbSize / 2, PillMetrics.height / 2, accuracy: 0.001)
        XCTAssertGreaterThanOrEqual(ControlBar.orbLead, 0)
    }

    /// The orb comes in out of a touch smaller; under Reduce Motion it only fades.
    func testTheOrbFadesAloneUnderReduceMotion() {
        XCTAssertEqual(ControlBar.orbEntryScale(reduceMotion: true), 1)
        XCTAssertLessThan(ControlBar.orbEntryScale(reduceMotion: false), 1)
        XCTAssertGreaterThan(ControlBar.orbEntryScale(reduceMotion: false), 0.5)
    }

    // MARK: The menu

    private func input(conversation: Bool = true, collapsed: Bool = false, ready: [StatusMenu.Session] = [], working: [StatusMenu.Session] = []) -> StatusMenu.Input {
        StatusMenu.Input(
            voice: .ready, quiet: false, exchangeActive: false, controlBar: true, conversation: conversation,
            collapsed: collapsed, replyLine: true, drawing: false, ready: ready, working: working
        )
    }

    private func items(_ rows: [StatusMenu.Row]) -> [StatusMenu.Item] {
        rows.compactMap { row -> StatusMenu.Item? in
            if case let .item(item) = row { return item }
            return nil
        }
    }

    /// Title case, the surfaces by their names with a tick, the pen by what it does; no "Show", which is the
    /// screen recording's word.
    func testTheMenuNamesEachSurfaceOnceInTitleCase() {
        let titles = items(StatusMenu.rows(input())).map(\.title)
        XCTAssertEqual(titles, ["Talk", "Quiet", "Stop Speaking", "Control Bar", "Conversation Panel", "Reply Line", "Draw on Screen", "Open conch"])
        XCTAssertFalse(titles.contains { $0.hasPrefix("Show") })
        let draw = items(StatusMenu.rows(input())).first { $0.command == .draw }
        XCTAssertEqual(draw?.key, "p")
        XCTAssertEqual(draw?.modifiers, [.control, .option, .command])
        var listening = input()
        listening.voice = .listening
        XCTAssertTrue(items(StatusMenu.rows(listening)).contains { $0.title == "Stop Listening" })
    }

    /// Folded to its handle, the panel is neither ticked nor off: a dash, and choosing it opens the panel rather than
    /// hiding one nobody could see.
    func testAFoldedPanelIsHonestInTheMenu() {
        func mark(_ on: Bool, _ collapsed: Bool) -> StatusMenu.Mark? {
            items(StatusMenu.rows(input(conversation: on, collapsed: collapsed))).first { $0.command == .conversation }?.mark
        }
        XCTAssertEqual(mark(true, false), .on)
        XCTAssertEqual(mark(true, true), .mixed)
        XCTAssertEqual(mark(false, false), .off)
        XCTAssertEqual(mark(false, true), .off)
        XCTAssertTrue(StatusMenu.conversationToggle(on: true, collapsed: true) == (true, false), "folded: open it")
        XCTAssertTrue(StatusMenu.conversationToggle(on: true, collapsed: false) == (false, false), "open: hide it")
        XCTAssertTrue(StatusMenu.conversationToggle(on: false, collapsed: true) == (true, false), "off: on, and open")
    }

    /// A ready row opens its item, as the pill does; conch's window on it is the ⌥ alternate right after it. Working
    /// rows still open conch on the session.
    func testReadyRowsOpenTheItemAndOptionOpensConch() {
        let rows = StatusMenu.rows(input(
            ready: [.init(id: "r1", label: "Prime page wireframe"), .init(id: "r2", label: "Arch")],
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
            XCTAssertEqual(list[first].title, "Prime page wireframe")
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
}
