import AppKit
import Combine
import ConchDesign
import SwiftUI

// The Mac app's main window (ContentView, compiled from the app's own sources) offscreen, over a real StateStore reading
// a sessions file this harness writes and rewrites the way the daemon does. test/window-churn.test.ts compiles it and
// reads one JSON line per phase: how often the store published, and how often each counted view's body ran.
//
// Nothing is shown and nothing comes forward: the app is `.prohibited`, the window is borderless, see-through,
// click-through and parked 20,000 points off every screen. The store's socket and files are the test's sandbox, where
// nothing listens; the sessions are an acme workspace made up here.

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

/// Counts bodies; window-churn.test.ts patches `let _ = ChurnProbe.body("<view>")` into the views it counts.
enum ChurnProbe {
    nonisolated(unsafe) static var bodies: [String: Int] = [:]
    static func body(_ name: String) { bodies[name, default: 0] += 1 }
}

DispatchQueue.global().asyncAfter(deadline: .now() + 120) {
    emit(["name": "timeout"])
    exit(3)
}

// MARK: - The acme workspace, as the daemon publishes it

let stateFile = ProcessInfo.processInfo.environment["CONCH_STATE_FILE"]!
let now = { Int(Date().timeIntervalSince1970 * 1000) }
let home = "/Users/acme"
let folders = ["\(home)/Projects/Atlas", "\(home)/Projects/Beacon", "\(home)/Projects/Comet"]

typealias Object = [String: Any]

var rows: [Object] = {
    let names = ["Pricing table polish", "Landing hero copy", "Billing webhook retries", "Onboarding checklist",
                 "Acme brand deck", "Release notes", "Search relevance tuning", "Invoice PDF layout", "Team plan upgrade flow"]
    var rows: [Object] = names.enumerated().map { i, name in
        var row: Object = ["id": "claude-\(i)", "label": name, "status": i % 3 == 1 ? "waiting" : "working",
                           "cwd": folders[i % folders.count], "at": now() - i * 61_000, "active": true]
        if i % 3 != 1 { row["activity"] = ["text": "Reading src/file\(i).ts", "kind": "step", "at": now()] }
        return row
    }
    for j in 0..<3 {
        rows.append(["id": "agent-\(j)", "label": "Helper \(j)", "status": "working", "cwd": folders[0], "parentSessionId": "claude-0",
                     "at": now(), "activity": ["text": "Searching for usages", "kind": "step", "at": now()]])
    }
    return rows
}()

func items(_ session: String, _ count: Int) -> [Object] {
    (0..<count).map { n in
        n % 4 == 0
            ? ["id": "\(session)-u\(n)", "kind": "user", "text": "Can you check step \(n)?", "at": now() - (count - n) * 9_000, "rev": 1]
            : ["id": "\(session)-a\(n)", "kind": "assistant", "text": "Step \(n): done, and the table now **lines up** at every width.",
               "at": now() - (count - n) * 9_000, "rev": 1]
    }
}

var conversations: [String: Object] = [
    "claude-0": ["sessionId": "claude-0", "truncated": false, "items": items("claude-0", 24)],
    "agent-1": ["sessionId": "agent-1", "truncated": false, "items": items("agent-1", 12)],
    "claude-2": ["sessionId": "claude-2", "truncated": false, "items": items("claude-2", 12)],
]

func document() -> Object {
    ["v": 1, "ts": now(), "ownerDeviceId": "harness", "features": ["deliverables": 4, "viewedState": 1],
     "mode": ["paused": false, "holding": 0], "live": ["state": "idle", "label": ""], "rows": rows,
     "dismissed": [String](), "dismissedRows": [Object](), "conversations": conversations]
}

func write(_ data: Data) { try! data.write(to: URL(fileURLWithPath: stateFile), options: .atomic) }
func publish() { write(try! JSONSerialization.data(withJSONObject: document(), options: [.sortedKeys])) }

final class OffscreenWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

@MainActor func spin(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }

nonisolated(unsafe) var publishes = 0

/// `times` writes of the sessions file, each made by `change`, a second apart (the store polls four times a second),
/// then a second for the window to take the last in.
@MainActor func phase(_ name: String, times: Int = 4, _ change: (Int) -> Void) async {
    let bodies = ChurnProbe.bodies
    let published = publishes
    for n in 0..<times {
        change(n)
        await spin(1)
    }
    await spin(1)
    var ran: [String: Int] = [:]
    for (view, count) in ChurnProbe.bodies where count > (bodies[view] ?? 0) { ran[view] = count - (bodies[view] ?? 0) }
    emit(["name": name, "writes": times, "publishes": publishes - published, "bodies": ran])
}

Task { @MainActor in
    publish()
    let store = StateStore()
    let remotes = RemoteMacStore()
    let audio = AudioHolderStore(local: store, remotes: remotes)
    let daemon = DaemonHost()
    let watching = store.objectWillChange.sink { _ in publishes += 1 }

    let window = OffscreenWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 1_040, height: 720),
                                 styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.alphaValue = 0
    window.ignoresMouseEvents = true
    window.hasShadow = false
    // The window's content as ConchMacApp's WindowGroup hands it over, the stores in the environment.
    window.contentView = NSHostingView(rootView: ContentView()
        .environmentObject(store)
        .environmentObject(remotes)
        .environmentObject(audio)
        .environmentObject(daemon)
        .conchPausesWhenHidden()
        .frame(width: 1_040, height: 720))
    window.orderFrontRegardless()
    window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))

    await spin(2)
    // Looking at the first session, as a click on its row does.
    NotificationCenter.default.post(name: .selectSessionFromStatusItem, object: "claude-0")
    await spin(2)
    emit(["name": "ready", "publishes": publishes, "bodies": ChurnProbe.bodies])

    // The daemon writes the file again with nothing but its clock moved, a third of its writes (2026-11-11).
    await phase("clock only") { _ in publish() }
    // The same bytes again, and the same state written another way: a write is not a change.
    let bytes = try! JSONSerialization.data(withJSONObject: document(), options: [.sortedKeys])
    await phase("same bytes") { _ in write(bytes) }
    await phase("written another way") { n in
        var reordered = document()
        reordered["rows"] = rows.map { row in Dictionary(uniqueKeysWithValues: row.map { ($0.key, $0.value) }) }
        write(try! JSONSerialization.data(withJSONObject: reordered, options: n % 2 == 0 ? [.prettyPrinted] : [.withoutEscapingSlashes]))
    }

    // Another session's activity line moving on, as the daemon publishes it about once a second.
    await phase("another session's activity") { n in
        rows[4]["activity"] = ["text": "Editing src/deck/slide\(n).ts", "kind": "step", "at": now()]
        publish()
    }
    // A subagent's conversation moving on: nothing in the sidebar says it.
    await phase("a subagent's conversation") { n in
        var conversation = conversations["agent-1"]!
        conversation["items"] = (conversation["items"] as! [Object]) + [["id": "agent-1-next\(n)", "kind": "assistant", "text": "Found \(n) more.", "at": now(), "rev": 1]]
        conversations["agent-1"] = conversation
        publish()
    }
    // The session on screen: its own line and its conversation, which the window must draw.
    await phase("the shown session") { n in
        rows[0]["activity"] = ["text": "Running test \(n)", "kind": "step", "at": now()]
        var conversation = conversations["claude-0"]!
        conversation["items"] = (conversation["items"] as! [Object]) + [["id": "claude-0-next\(n)", "kind": "assistant", "text": "Test \(n) passed.", "at": now(), "rev": 1]]
        conversations["claude-0"] = conversation
        publish()
    }

    emit(["name": "done"])
    _ = watching
    exit(0)
}

app.run()
