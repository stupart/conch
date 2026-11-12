import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// Settings › Resources (ResourcesPage.swift): what each session uses, green, yellow or red, the budget's words and bars,
/// the requests it sends, and the page drawn in both appearances.
///
/// `CONCH_STILL_RUNNING_RENDERS=<dir>` writes the pictures. Everything in them is invented.
@MainActor
final class ResourcesPageTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_000_000)
    private var ms: Double { now.timeIntervalSince1970 * 1_000 }
    private let minute: Double = 60_000
    private let gb: Double = 1_073_741_824

    private var fixture: PublishedResources {
        PublishedResources(
            sampledAt: ms, asking: 1,
            items: [
                ResourceItem(id: "vm-ci", kind: "vm", title: "colima ci", owner: .init(key: "s1", sessionId: "s1", label: "Build farm", live: true, how: "environment"),
                             startedAt: ms - 45 * minute, cpu: 140, memory: 12 * gb, state: "running", level: "red", levelReasons: ["12.0 GB of memory"], cpuSustained: 133),
                ResourceItem(id: "p4101", kind: "server", title: "vite :5173", owner: .init(key: "old", label: "Landing page", live: false, how: "environment", endedAt: ms - 2 * 1_440 * minute),
                             startedAt: ms - 2 * 1_440 * minute, cpu: 0, memory: 258 * 1_048_576, state: "asking", reason: "its session ended", level: "red", levelReasons: ["past its time for over a day"]),
                ResourceItem(id: "p4103", kind: "server", title: "next :3000", owner: .init(key: "s2", sessionId: "s2", label: "Docs refresh", live: true, how: "tree"),
                             startedAt: ms - 9 * minute, cpu: 60, memory: 900 * 1_048_576, state: "running", level: "yellow", levelReasons: ["60% of a core for 5 min"], lowered: "you"),
                ResourceItem(id: "sim-1a2b3c4d", kind: "simulator", title: "Test Phone simulator", startedAt: ms - 28 * 60 * minute, cpu: 1, memory: 3.1 * gb, state: "unowned", level: "yellow"),
            ],
            sessions: [
                .init(key: "s1", sessionId: "s1", label: "Build farm", live: true, cpu: 410, memory: 13 * gb, resources: 1, level: "red", reasons: ["over the agents' budget"], over: true),
                .init(key: "s2", sessionId: "s2", label: "Docs refresh", live: true, cpu: 85, memory: 1.6 * gb, resources: 1, level: "yellow", reasons: ["next :3000: 60% of a core for 5 min"], lowered: true),
                .init(key: "s3", sessionId: "s3", label: "Quiet notes", live: true, cpu: 4, memory: 300 * 1_048_576, resources: 0, level: "green"),
                .init(key: "old", label: "Landing page", live: false, cpu: 0, memory: 258 * 1_048_576, resources: 1, level: "red", reasons: ["vite :5173: past its time for over a day"]),
                .init(key: "unowned", label: "Unowned", live: false, cpu: 1, sustained: false, memory: 3.1 * gb, resources: 1, level: "yellow"),
            ],
            budget: ResourceBudget(cpuSetting: "2 cores", memorySetting: "25%", cpuText: "2 cores (25% of 8)", memoryText: "25% of 32 GB (8 GB)",
                                   autoBackground: false, cores: 8, memoryTotal: 32 * gb, cpuLimit: 200, memoryLimit: 8 * gb,
                                   cpu: 500, sustained: true, memory: 15 * gb, level: "red", over: ["s1"], reason: "agents are using 5.0 cores of 2.0 cores and 15.0 GB of 8.0 GB")
        )
    }

    func testWordsAndBars() throws {
        let budget = try XCTUnwrap(fixture.budget)
        XCTAssertEqual(ResourcesPage.cpuLine(budget), "5.0 of 2.0 cores")
        XCTAssertEqual(ResourcesPage.memoryLine(budget), "15.0 of 8.0 GB")
        XCTAssertEqual(ResourcesPage.fraction(500, of: 200), 1)
        XCTAssertEqual(ResourcesPage.fraction(50, of: 200), 0.25)
        XCTAssertEqual(ResourcesPage.overLine(fixture), "Over: Build farm. Hold or lower what they run below, or stop what they left.")
        XCTAssertEqual(ResourcesPage.sessionLine(fixture.sessions[0]), "4.1 cores · 13.0 GB · 1 left running")
        XCTAssertEqual(ResourcesPage.sessionLine(fixture.sessions[1]), "0.8 cores · 1.6 GB · 1 left running · lowered")
        XCTAssertEqual(ResourcesPage.sessionLine(fixture.sessions[4]), "0.0 cores* · 3.1 GB · 1 left running")
    }

    func testEachSessionHasItsOwnAndTheUnownedTheirs() {
        let sessions = ResourcesPage.sessions(fixture)
        XCTAssertEqual(sessions.map(\.key), ["s1", "s2", "s3", "old", "unowned"])
        XCTAssertEqual(ResourcesPage.items(for: fixture.sessions[0], in: fixture).map(\.id), ["vm-ci"])
        XCTAssertEqual(ResourcesPage.items(for: fixture.sessions[3], in: fixture).map(\.id), ["p4101"])
        XCTAssertEqual(ResourcesPage.items(for: fixture.sessions[4], in: fixture).map(\.id), ["sim-1a2b3c4d"])
        // An unowned group with nothing in it isn't listed.
        let empty = PublishedResources(sampledAt: ms, asking: 0, items: [], sessions: [.init(key: "unowned", label: "Unowned", live: false, cpu: 0, memory: 0, resources: 0, level: "green")])
        XCTAssertEqual(ResourcesPage.sessions(empty), [])
    }

    func testLevelsActionsAndRequests() throws {
        XCTAssertEqual(ResourceLevel("red"), .red)
        XCTAssertEqual(ResourceLevel(nil), .green)
        XCTAssertEqual(ResourceLevel("purple"), .green)
        XCTAssertEqual(StillRunning.moreActions(for: fixture.items[2]), [.hold, .restore])
        XCTAssertEqual(StillRunning.moreActions(for: fixture.items[0]), [], "a VM is stopped, never held")
        XCTAssertEqual(StillRunning.costLine(fixture.items[2]), "60% CPU · 900 MB · lowered")
        XCTAssertEqual(StillRunning.costLine(fixture.items[0]), "133% CPU · 12.0 GB")
        let session = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ResourceSessionRequest(sessionId: "s1", lower: true))) as? [String: String]
        XCTAssertEqual(session, ["kind": "resource-session", "sessionId": "s1", "action": "lower"])
        let budget = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ResourceBudgetRequest.cpu("14 cores"))) as? [String: AnyHashable]
        XCTAssertEqual(budget, ["kind": "set-config", "key": "agent-budget-cpu", "value": "14 cores"])
        let memory = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ResourceBudgetRequest.memory("100 GB"))) as? [String: AnyHashable]
        XCTAssertEqual(memory, ["kind": "set-config", "key": "agent-budget-memory", "value": "100 GB"])
        // Shares and amounts, never more than this Mac has.
        XCTAssertEqual(ResourcesPage.cpuChoices(cores: 18), ["25%", "50%", "75%", "90%", "100%", "2 cores", "4 cores", "8 cores", "12 cores", "14 cores", "16 cores"])
        XCTAssertEqual(ResourcesPage.memoryChoices(total: 128 * gb), ["25%", "50%", "60%", "75%", "90%", "8 GB", "16 GB", "32 GB", "64 GB", "96 GB", "100 GB", "128 GB"])
        XCTAssertEqual(ResourcesPage.memoryChoices(total: 16 * gb).last, "16 GB")
        let auto = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ResourceBudgetRequest.autoBackground(true))) as? [String: AnyHashable]
        XCTAssertEqual(auto, ["kind": "set-config", "key": "agent-auto-background", "value": true])
    }

    func testDecodesSessionsAndBudget() throws {
        let json = #"""
        {"v":1,"sampledAt":1,"asking":0,"items":[],
         "sessions":[{"key":"a","sessionId":"a","label":"x","live":true,"cpu":120,"sustained":true,"memory":1,"resources":0,"level":"yellow","reasons":["1.2 cores for 5 min"]},{"broken":true}],
         "budget":{"cpuSetting":"14 cores","memorySetting":"100 GB","cpuText":"14 cores (78% of 18)","memoryText":"100 GB (78% of 128 GB)","autoBackground":false,"cores":18,"memoryTotal":137438953472,"cpuLimit":1400,"memoryLimit":107374182400,"cpu":120,"sustained":true,"memory":1,"level":"green","over":[],"reason":"r"}}
        """#
        let resources = try JSONDecoder().decode(PublishedResources.self, from: Data(json.utf8))
        XCTAssertEqual(resources.sessions.map(\.key), ["a"])
        XCTAssertEqual(resources.budget?.cpuLimit, 1_400)
        XCTAssertEqual(resources.budget?.cpuText, "14 cores (78% of 18)")
    }

    func testTheRowLineCarriesItsLevel() {
        let line = SidebarRowText.secondLine(message: nil, blockedOn: nil, activity: nil, stillRunning: 2, stillRunningLevel: "red", startedBy: nil)
        XCTAssertEqual(line, .init(text: "2 still running", kind: .stillRunning, level: .red))
        XCTAssertEqual(SidebarRowText.secondLine(message: nil, blockedOn: nil, activity: nil, stillRunning: 2, startedBy: nil)?.level, .green)
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

    func testThePageDrawsInBothAppearances() throws {
        for dark in [false, true] {
            _ = NSApplication.shared
            NSApp.setActivationPolicy(.prohibited)
            let size = CGSize(width: 640, height: 900)
            let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            let page = ResourcesPageView(resources: fixture, now: now, decide: { _, _ in nil }, lowerSession: { _, _ in nil }, setBudget: { _ in nil })
                .padding(24)
                .frame(width: size.width, height: size.height, alignment: .topLeading)
                .background(ConchColor.ground)
                .environment(\.colorScheme, dark ? .dark : .light)
            let view = NSHostingView(rootView: page)
            window.contentView = view
            window.orderFrontRegardless()
            windows.append(window)
            for _ in 0..<20 {
                view.layoutSubtreeIfNeeded()
                RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            }
            let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: rep)
            XCTAssertEqual(rep.size.width, size.width)
            if let directory = ProcessInfo.processInfo.environment["CONCH_STILL_RUNNING_RENDERS"] {
                try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
                let url = URL(fileURLWithPath: directory).appendingPathComponent("resources-page-\(dark ? "dark" : "light").png")
                try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
            }
        }
    }
}
