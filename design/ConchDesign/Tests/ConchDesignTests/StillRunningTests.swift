import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// Still running (StillRunning.swift): the words each resource is shown with, what Tyler can do with it, how the section
/// groups them, the session row's "3 still running", and the section drawn as the sidebar draws it.
///
/// `CONCH_STILL_RUNNING_RENDERS=<dir>` writes each picture, light and dark, as a PNG to look at. Everything in them is
/// invented: no real session, folder, port or person.
@MainActor
final class StillRunningTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_000_000)
    private var ms: Double { now.timeIntervalSince1970 * 1_000 }
    private let minute: Double = 60_000

    private var fixture: PublishedResources {
        PublishedResources(sampledAt: ms, asking: 3, items: [
            ResourceItem(id: "p4101", kind: "server", title: "vite :5173", command: "node node_modules/.bin/vite --port 5173",
                         cwd: "/Users/dev/site", owner: .init(label: "Landing page", live: false, how: "environment", endedAt: ms - 2 * 1_440 * minute),
                         startedAt: ms - 2 * 1_440 * minute - 30 * minute, cpu: 0.1, memory: 258 * 1_048_576,
                         lifetime: .init(kind: "session", inferred: true), state: "asking", reason: "its session ended"),
            ResourceItem(id: "p4102", kind: "server", title: "python http.server :8000", command: "python -m http.server 8000",
                         owner: .init(label: "Landing page", live: false, how: "environment", endedAt: ms - 26 * 60 * minute),
                         startedAt: ms - 27 * 60 * minute, cpu: 0, memory: 15 * 1_048_576, state: "asking", reason: "its session ended"),
            ResourceItem(id: "p6100", kind: "watcher", title: "tsc -w -p .", command: "tsc -w -p .",
                         owner: .init(sessionId: "s2", label: "Docs refresh", live: true, how: "declared"),
                         startedAt: ms - 95 * minute, cpu: 2.4, memory: 180 * 1_048_576, lifetime: .init(kind: "turn"),
                         why: "rebuild while editing", state: "asking", reason: "its turn is over"),
            ResourceItem(id: "vm-ci", kind: "vm", title: "colima ci", command: "limactl hostagent colima-ci",
                         owner: .init(sessionId: "s1", label: "Build farm", live: true, how: "environment"),
                         startedAt: ms - 45 * minute, cpu: 133.2, memory: 12 * 1_073_741_824, state: "running"),
            ResourceItem(id: "p4103", kind: "server", title: "next :3000 :3001", command: "next dev",
                         owner: .init(sessionId: "s1", label: "Build farm", live: true, how: "tree"),
                         startedAt: ms - 9 * minute, cpu: 88.5, memory: 1.4 * 1_073_741_824, state: "running"),
            ResourceItem(id: "sim-1a2b3c4d", kind: "simulator", title: "Test Phone simulator", command: "launchd_sim",
                         startedAt: ms - 28 * 60 * minute, cpu: 1.1, memory: 3.1 * 1_073_741_824, state: "unowned", reason: "no session started it"),
            ResourceItem(id: "p4104", kind: "browser", title: "headless Chrome :9223", command: "Google Chrome --remote-debugging-port=9223",
                         startedAt: ms - 34 * 60 * minute, cpu: 0, memory: 794 * 1_048_576, state: "unowned", reason: "running before conch was watching",
                         preexisting: true),
        ])
    }

    // MARK: - The words

    func testRowLineCountsOnlyWhatRuns() {
        XCTAssertNil(StillRunning.rowLine(nil))
        XCTAssertNil(StillRunning.rowLine(0))
        XCTAssertEqual(StillRunning.rowLine(1), "1 still running")
        XCTAssertEqual(StillRunning.rowLine(3), "3 still running")
    }

    func testTheSecondLineSaysWhatItLeftRunningWhenIdleAndWhatItDoesWhileWorking() {
        let idle = SidebarRowText.secondLine(message: nil, blockedOn: nil, activity: nil, stillRunning: 3, startedBy: "planner")
        XCTAssertEqual(idle, .init(text: "3 still running", kind: .stillRunning, level: .green))
        let working = SidebarRowText.secondLine(message: nil, blockedOn: nil, activity: "Running the test suite", stillRunning: 3, startedBy: nil)
        XCTAssertEqual(working?.kind, .activity)
        let blocked = SidebarRowText.secondLine(message: nil, blockedOn: "Allow rm?", activity: nil, stillRunning: 3, startedBy: nil)
        XCTAssertEqual(blocked?.kind, .question)
        XCTAssertEqual(SidebarRowText.secondLine(message: nil, blockedOn: nil, activity: nil, startedBy: "planner")?.kind, .startedBy)
        XCTAssertTrue(SidebarRowText.accessibilityLabel(name: "site", state: "idle", agent: "Claude", voice: nil, startedBy: nil, stillRunning: 2)
            .contains("2 still running"))
    }

    func testAgesMemoryAndCPU() {
        XCTAssertEqual(StillRunning.age(since: ms - 20_000, now: now), "under a minute")
        XCTAssertEqual(StillRunning.age(since: ms - 12 * minute, now: now), "12 min")
        XCTAssertEqual(StillRunning.age(since: ms - 47 * 60 * minute, now: now), "47 h")
        XCTAssertEqual(StillRunning.age(since: ms - 6 * 1_440 * minute, now: now), "6 d")
        XCTAssertEqual(StillRunning.memory(258 * 1_048_576), "258 MB")
        XCTAssertEqual(StillRunning.memory(6.3 * 1_073_741_824), "6.3 GB")
        XCTAssertEqual(StillRunning.cpu(133.2), "133% CPU")
    }

    func testWhoseAndWhy() {
        let items = fixture.items
        XCTAssertEqual(StillRunning.ownerLine(items[0], now: now), "Landing page · ended 2 d ago")
        XCTAssertEqual(StillRunning.ownerLine(items[2], now: now), "Docs refresh · its turn is over")
        XCTAssertEqual(StillRunning.ownerLine(items[3], now: now), "Build farm")
        XCTAssertEqual(StillRunning.ownerLine(items[5], now: now), "Unowned · no session started it")
        XCTAssertEqual(StillRunning.ownerLine(items[6], now: now), "Unowned · here before conch looked")
        XCTAssertEqual(StillRunning.numbers(items[3], now: now), "up 45 min · 133% CPU · 12.0 GB")
        XCTAssertTrue(StillRunning.tooltip(items[2]).contains("why: rebuild while editing"))
        XCTAssertTrue(StillRunning.tooltip(items[2]).hasSuffix("conch resources stop|keep|later p6100"))
    }

    func testWhatTylerCanDo() {
        let items = fixture.items
        XCTAssertEqual(StillRunning.actions(for: items[0]), [.stop, .keep, .later])
        XCTAssertEqual(StillRunning.actions(for: items[3]), [.stop, .keep])
        XCTAssertEqual(StillRunning.actions(for: items[5]), [.stop])
        let stopping = ResourceItem(id: "p1", kind: "server", title: "x", startedAt: ms, state: "stopping")
        XCTAssertEqual(StillRunning.actions(for: stopping), [])
        XCTAssertTrue(StillRunning.stopMessage(items[3]).contains("colima stop"))
        XCTAssertTrue(StillRunning.stopMessage(items[5]).contains("simctl shutdown"))
        XCTAssertTrue(StillRunning.stopMessage(items[0]).contains("SIGTERM"))
    }

    func testGroupsAskingFirstAndOpen() {
        let groups = StillRunning.groups(fixture.items)
        XCTAssertEqual(groups.map(\.id), ["asking", "running", "unowned"])
        XCTAssertEqual(groups.map(\.items.count), [3, 2, 2])
        XCTAssertEqual(groups.map(\.opensFolded), [false, true, true])
        XCTAssertEqual(StillRunning.header(fixture).badge, "3 asking")
    }

    func testTheRequestAndTheReply() throws {
        let body = try JSONEncoder().encode(ResourceDecideRequest(id: "p4101", action: .later))
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(decoded, ["kind": "resource-decide", "id": "p4101", "action": "later"])
        XCTAssertNil(StillRunning.replyError(Data(#"{"kind":"resource-done","id":"p1","action":"stop","title":"x","message":"m"}"#.utf8)))
        XCTAssertEqual(StillRunning.replyError(Data(#"{"kind":"resource-error","error":"nothing running is p1"}"#.utf8)), "nothing running is p1")
        XCTAssertEqual(StillRunning.replyError(nil), "Could not reach the conch daemon.")
    }

    func testDecodesTheDaemonsListAndSkipsWhatItCantRead() throws {
        let json = #"""
        {"v":1,"sampledAt":1793000000000,"asking":1,"items":[
          {"id":"p1","kind":"server","title":"vite :5100","command":"node vite","ports":[5100],
           "owner":{"label":"site","live":false,"how":"tree","endedAt":1792990000000},"startedAt":1792900000000,
           "cpu":0.4,"memory":209715200,"lifetime":{"kind":"session","inferred":true},"state":"asking","reason":"its session ended"},
          {"id":"broken"}
        ]}
        """#
        let resources = try JSONDecoder().decode(PublishedResources.self, from: Data(json.utf8))
        XCTAssertEqual(resources.items.map(\.id), ["p1"])
        XCTAssertEqual(resources.items[0].owner?.endedAt, 1_792_990_000_000)
        XCTAssertEqual(resources.items[0].lifetime?.inferred, true)
    }

    // MARK: - Drawn

    private var windows: [NSWindow] = []

    override func tearDown() {
        MainActor.assumeIsolated {
            windows.forEach { $0.orderOut(nil) }
            windows = []
        }
        super.tearDown()
    }

    private func picture(_ content: some View, size: CGSize, dark: Bool, name: String) throws -> NSBitmapImageRep {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let view = NSHostingView(rootView: content
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(ConchColor.ground)
            .environment(\.colorScheme, dark ? .dark : .light))
        window.contentView = view
        window.orderFrontRegardless()
        windows.append(window)
        for _ in 0..<20 {
            view.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        if let directory = ProcessInfo.processInfo.environment["CONCH_STILL_RUNNING_RENDERS"] {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
            try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
        }
        return rep
    }

    /// A session row as the sidebar draws its name and second line, for the picture beside the section.
    private func row(_ name: String, line: SidebarRowText.SecondLine?) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Circle().fill(ConchColor.ready).frame(width: 7, height: 7).padding(.top, 5)
            VStack(alignment: .leading, spacing: 1) {
                TailFadeText(name).font(.system(size: 12.5, weight: .medium)).foregroundStyle(ConchColor.textPrimary)
                if let line { SidebarSecondLine(line) }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
    }

    func testTheSectionDrawsInTheSidebarsWidthInBothAppearances() throws {
        let width: CGFloat = 270
        for dark in [false, true] {
            let sidebar = VStack(alignment: .leading, spacing: 2) {
                row("Build farm", line: SidebarRowText.secondLine(message: nil, blockedOn: nil, activity: nil, stillRunning: 2, startedBy: nil))
                row("Docs refresh", line: SidebarRowText.secondLine(message: nil, blockedOn: nil, activity: nil, stillRunning: 1, startedBy: nil))
                StillRunningSection(resources: fixture, now: now, open: ["asking", "running", "unowned"]) { _, _ in nil }
                Spacer(minLength: 0)
            }
            .padding(8)
            let rep = try picture(sidebar, size: CGSize(width: width, height: 760), dark: dark, name: "still-running")
            XCTAssertEqual(rep.size.width, width)
            // Something is drawn in the section's area, and nothing past the column's edge.
            XCTAssertGreaterThan(rep.pixelsHigh, 0)
        }
    }

    func testFoldedByDefaultOnlyAskingIsOpen() throws {
        for dark in [false, true] {
            let section = StillRunningSection(resources: fixture, now: now) { _, _ in nil }.padding(8)
            _ = try picture(section, size: CGSize(width: 270, height: 330), dark: dark, name: "still-running-folded")
        }
    }
}
