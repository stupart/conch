import XCTest
@testable import ConchDesign

/// Still running (StillRunning.swift): what Tyler can do with each resource, how the section groups them, the session
/// row's "3 still running", and the daemon's list and replies. Everything here is invented.
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

    func testWhatTylerCanDo() {
        let items = fixture.items
        XCTAssertEqual(StillRunning.actions(for: items[0]), [.stop, .keep, .later])
        XCTAssertEqual(StillRunning.actions(for: items[3]), [.stop, .keep])
        XCTAssertEqual(StillRunning.actions(for: items[5]), [.stop])
        let stopping = ResourceItem(id: "p1", kind: "server", title: "x", startedAt: ms, state: "stopping")
        XCTAssertEqual(StillRunning.actions(for: stopping), [])
    }

    func testGroupsAskingFirstAndOpen() {
        let groups = StillRunning.groups(fixture.items)
        XCTAssertEqual(groups.map(\.id), ["asking", "running", "unowned"])
        XCTAssertEqual(groups.map(\.items.count), [3, 2, 2])
        XCTAssertEqual(groups.map(\.opensFolded), [false, true, true])
    }

    func testTheRequestAndTheReply() throws {
        let body = try JSONEncoder().encode(ResourceDecideRequest(id: "p4101", action: .later))
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(decoded, ["kind": "resource-decide", "id": "p4101", "action": "later"])
        XCTAssertNil(StillRunning.replyError(Data(#"{"kind":"resource-done","id":"p1","action":"stop","title":"x","message":"m"}"#.utf8)))
        XCTAssertEqual(StillRunning.replyError(Data(#"{"kind":"resource-error","error":"nothing running is p1"}"#.utf8)), "nothing running is p1")
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
}
