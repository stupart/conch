import AppKit
import ConchDesign
import SwiftUI

// The Mac app's session list (DashboardView.swift's SessionLedger, compiled from the app's own sources) in an offscreen
// window, driven through what preceded each freeze — a dismiss, a restore, conch's words on a closing row, agents'
// activity lines moving on every second — and measured after each: does SwiftUI stop updating the list once the change
// is over? test/sidebar-settle.test.ts compiles and reads this. One JSON line per phase on stdout.
//
// Nothing is shown and nothing comes forward: the app is `.prohibited`, the window is borderless, see-through,
// click-through and parked 20,000 points off every screen. No store, socket client or daemon host is made here: the
// list is handed its state directly, as StateStore would hand it.

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

// MARK: - Probes (sidebar-settle.test.ts patches the calls into its copy of DashboardView.swift)

enum LedgerProbe {
    nonisolated(unsafe) static var ledgerBodies = 0
    nonisolated(unsafe) static var rowBodies = 0
    nonisolated(unsafe) static var layouts = 0
    nonisolated(unsafe) static var scrolls = 0
    static func ledgerBody() { ledgerBodies += 1 }
    static func rowBody() { rowBodies += 1 }
    static func scrolled() { scrolls += 1 }

    /// Around each row: a layout that passes its row through untouched and counts every time the list measures or
    /// places it.
    struct Counting: Layout {
        func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
            LedgerProbe.layouts += 1
            return subviews.first?.sizeThatFits(proposal) ?? .zero
        }

        func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
            LedgerProbe.layouts += 1
            subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
        }
    }

    struct Measured: ViewModifier {
        func body(content: Content) -> some View { Counting { content } }
    }
}

/// The main thread's own CPU time, read from any thread: a list that never settles burns it.
nonisolated(unsafe) var mainThread = mach_thread_self()
func mainThreadCPU() -> Double {
    var info = thread_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            thread_info(mainThread, thread_flavor_t(THREAD_BASIC_INFO), $0, &count)
        }
    }
    guard result == KERN_SUCCESS else { return 0 }
    return Double(info.user_time.seconds) + Double(info.user_time.microseconds) / 1e6
        + Double(info.system_time.seconds) + Double(info.system_time.microseconds) / 1e6
}

// MARK: - The watchdog: a main thread that stops coming back to its run loop is the freeze itself.

let beatLock = NSLock()
nonisolated(unsafe) var lastBeat = CACurrentMediaTime()
nonisolated(unsafe) var currentPhase = "launch"

let beat = Timer(timeInterval: 0.05, repeats: true) { _ in
    beatLock.lock(); lastBeat = CACurrentMediaTime(); beatLock.unlock()
}
RunLoop.main.add(beat, forMode: .common)

Thread.detachNewThread {
    while true {
        usleep(100_000)
        beatLock.lock(); let stalled = CACurrentMediaTime() - lastBeat; let phase = currentPhase; beatLock.unlock()
        if stalled > 4 {
            let before = mainThreadCPU()
            usleep(1_000_000)
            emit(["name": "hang", "phase": phase, "stalledSeconds": stalled, "mainCPUPerSecond": mainThreadCPU() - before])
            exit(4)
        }
    }
}

DispatchQueue.global().asyncAfter(deadline: .now() + 150) {
    emit(["name": "timeout", "phase": currentPhase])
    exit(3)
}

// MARK: - The acme workspace, as the daemon publishes it

typealias Row = [String: Any]
let now = Date().timeIntervalSince1970 * 1000
let home = "/Users/acme"
let folders = ["\(home)/Projects/Atlas", "\(home)/Projects/Beacon", "\(home)/Projects/Comet/.worktrees/pricing", home]
let steps = ["Running the test suite", "Editing src/pricing/table.ts", "Reading 3 files", "Checking the landing hero at 1440 wide",
             "Waiting for the pre-push gate to finish", "Searching for usages of PlanCard", "Writing the release notes draft"]

/// Fourteen sessions in four folders, three of them with three agents each, one started by another: working rows with
/// activity lines and without, waiting rows, one blocked on a question. Three dismissed.
var rows: [Row] = {
    var rows: [Row] = []
    let names = ["Pricing table polish", "Landing hero copy and the second fold", "Billing webhook retries", "Onboarding checklist",
                 "Acme brand deck", "Release v2.3 notes", "Search relevance tuning for the docs site", "Invoice PDF layout",
                 "Team plan upgrade flow", "Status page incident write-up", "Mobile nav drawer", "Customer import CSV mapping",
                 "Dark mode tokens", "Analytics funnel dashboard"]
    for (i, name) in names.enumerated() {
        let status = ["working", "waiting", "working", "needs", "working", "waiting", "working"][i % 7]
        var row: Row = ["id": "claude-\(i)", "label": name, "status": status, "cwd": folders[i % folders.count], "at": now - Double(i) * 61_000]
        if status == "working", i % 3 != 2 { row["activity"] = ["text": steps[i % steps.count], "kind": "step", "at": now] }
        if status == "needs" { row["detail"] = "Should the annual toggle default to on?"; row["needsResponse"] = true }
        rows.append(row)
    }
    for (i, parent) in ["claude-0", "claude-4", "claude-6"].enumerated() {
        for j in 0..<3 {
            var row: Row = ["id": "agent-\(i)-\(j)", "label": "\(["Bacon", "Volta", "Ampere"][i]) helper \(j)", "status": j % 2 == 0 ? "working" : "waiting",
                            "cwd": home, "parentSessionId": parent, "at": now]
            if j % 2 == 0 { row["activity"] = ["text": steps[(i + j + 2) % steps.count], "kind": "step", "at": now] }
            rows.append(row)
        }
    }
    rows.append(["id": "codex-started", "label": "Codex review of the pricing diff", "status": "working", "cwd": folders[2], "backend": "codex",
                 "startedBySessionId": "claude-0", "activity": ["text": "Reading src/pricing/table.ts", "kind": "step", "at": now], "at": now])
    return rows
}()
var dismissed: [[String: String]] = [["id": "old-1", "label": "Old spike: GraphQL gateway"], ["id": "old-2", "label": "Logo exploration"],
                                     ["id": "old-3", "label": "Weekly digest email"]]

func id(_ row: Row) -> String { row["id"] as! String }
func label(_ row: Row) -> String { row["label"] as! String }

func publishedState(ts: Double) -> PublishedState {
    let object: [String: Any] = [
        "v": 1, "ts": ts, "ownerDeviceId": "harness", "mode": ["paused": false], "live": ["state": "idle"],
        "rows": rows, "dismissed": dismissed.map { $0["id"]! }, "dismissedRows": dismissed,
    ]
    return try! JSONDecoder().decode(PublishedState.self, from: JSONSerialization.data(withJSONObject: object))
}

/// The daemon's next snapshot after a dismiss: the row leaves the sessions for the Dismissed group.
func moveToDismissed(_ target: String) {
    guard let row = rows.first(where: { id($0) == target }) else { return }
    rows.removeAll { id($0) == target }
    dismissed.append(["id": target, "label": label(row)])
}

/// …and after a restore: back among the sessions, at `index`.
func restore(_ target: String, at index: Int) {
    guard let entry = dismissed.first(where: { $0["id"] == target }) else { return }
    dismissed.removeAll { $0["id"] == target }
    rows.insert(["id": target, "label": entry["label"]!, "status": "working", "cwd": folders[1], "at": now,
                 "activity": ["text": "Picking up where it left off", "kind": "step", "at": now]], at: min(index, rows.count))
}

/// Every working row's activity moves on, as the daemon publishes it about once a second; some rows lose their line and
/// some gain one, so rows change height.
func tickActivity(_ tick: Int) {
    for index in rows.indices where rows[index]["status"] as? String == "working" {
        rows[index]["activity"] = (index + tick) % 4 == 0
            ? nil
            : ["text": "\(steps[(index + tick) % steps.count]) (\(tick))", "kind": "step", "at": now]
    }
}

// MARK: - The list, handed what StateStore would hand it

@MainActor
final class LedgerModel: ObservableObject {
    @Published var state: PublishedState?
    @Published var selected: String?
    @Published var rowMessages: [String: String] = [:]
    @Published var undo: SessionDismissUndo?
    private var ts = 1.0
    func publish() { ts += 1; state = publishedState(ts: ts) }
}

struct LedgerHost: View {
    @ObservedObject var model: LedgerModel
    @State private var draft = ""

    var body: some View {
        makeLedgerForSettleTest(
            state: model.state,
            selectedSessionID: model.selected,
            renameDraft: $draft,
            rowMessages: model.rowMessages,
            undoDismissal: model.undo,
            actions: DashboardActions(
                onStartSession: {}, onSelectSession: { _ in }, onDoubleClickSession: { _ in }, onBeginRename: { _ in },
                onCommitRename: { _ in }, onCancelRename: {}, onDismiss: { _ in }, onRestore: { _ in }, onUndoDismiss: {},
                onDismissNewerDaemonWarning: {}, onToggleLogs: {}, onConnectPhone: {}, onShowKeyboardShortcuts: {},
                onShowCommandPalette: {}, onTalkOrStop: {}, onPauseOrResume: {}, onToggleQuiet: { _ in }, onRecite: {},
                onMoveUp: {}, onMoveDown: {}, onReleaseSelection: {}
            )
        )
    }
}

final class OffscreenWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

// MARK: - Driving it

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

@MainActor func spin(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }

/// Makes `change`, lets the list take it in for `busy` seconds (plus a second's grace), then watches one quiet second in
/// which nothing changes. A list that settles does nothing at all in it.
@MainActor func phase(_ name: String, busy: Double = 0, _ change: () -> Void) async {
    beatLock.lock(); currentPhase = name; beatLock.unlock()
    let start = (ledger: LedgerProbe.ledgerBodies, rows: LedgerProbe.rowBodies, layouts: LedgerProbe.layouts, scrolls: LedgerProbe.scrolls)
    change()
    await spin(busy + 1)
    let quiet = (ledger: LedgerProbe.ledgerBodies, rows: LedgerProbe.rowBodies, layouts: LedgerProbe.layouts, cpu: mainThreadCPU())
    await spin(1)
    emit([
        "name": name,
        "ledgerBodies": quiet.ledger - start.ledger, "rowBodies": quiet.rows - start.rows, "layouts": quiet.layouts - start.layouts,
        "scrolls": LedgerProbe.scrolls - start.scrolls,
        "quietLedgerBodies": LedgerProbe.ledgerBodies - quiet.ledger, "quietRowBodies": LedgerProbe.rowBodies - quiet.rows,
        "quietLayouts": LedgerProbe.layouts - quiet.layouts, "quietCpuMs": Int((mainThreadCPU() - quiet.cpu) * 1000),
    ])
}

/// Activity lines moving on every `interval` seconds for `seconds`, while the phase runs.
@MainActor func ticking(_ model: LedgerModel, from first: Int, for seconds: Double, every interval: Double = 1) {
    Task { @MainActor in
        var tick = first
        var elapsed = 0.0
        while elapsed < seconds {
            tickActivity(tick); model.publish()
            tick += 1
            await spin(interval); elapsed += interval
        }
    }
}

Task { @MainActor in
    // RemoteMacGroups reads it; the test's copy never loads a pairing or dials a Mac.
    let remotes = RemoteMacStore()
    let model = LedgerModel()
    // The sidebar's own width as Tyler dragged it, and a window short enough that the list scrolls.
    let width = 234.37109375
    let height = 520.0
    let window = OffscreenWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: width, height: height),
                                 styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.alphaValue = 0
    window.ignoresMouseEvents = true
    window.hasShadow = false
    window.contentView = NSHostingView(rootView: LedgerHost(model: model).environmentObject(remotes).frame(width: width, height: height))
    window.orderFrontRegardless()
    window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))

    await phase("initial") { model.publish() }

    // Looking at a session at the end of the list: the one animated scroll there is.
    await phase("select") { model.selected = "claude-13" }

    // Dismiss, the undo offered the moment it is clicked, before the daemon's snapshot has moved the row...
    await phase("dismiss, undo first") { model.undo = SessionDismissUndo(id: "claude-9", label: "Status page incident write-up") }
    // ...and then the snapshot that moves it into the Dismissed group, which the undo holds open.
    await phase("dismiss, row moves") { moveToDismissed("claude-9"); model.publish() }
    // Dismiss as StateStore does it: the undo and the moved row in one turn.
    await phase("dismiss") {
        moveToDismissed("claude-2")
        model.undo = SessionDismissUndo(id: "claude-2", label: "Billing webhook retries")
        model.publish()
    }
    // The undo's six seconds run out and the group folds.
    await phase("undo expires") { model.undo = nil }

    // Restore: the row leaves the Dismissed group and comes back among the sessions, once with the group open and once
    // folded, the restored session the one being looked at.
    await phase("restore") {
        restore("claude-9", at: 9)
        model.selected = "claude-9"
        model.publish()
    }
    await phase("restore, group open") {
        model.undo = SessionDismissUndo(id: "old-1", label: "Old spike: GraphQL gateway")
        restore("old-1", at: 0)
        model.undo = nil
        model.selected = "old-1"
        model.publish()
    }

    // Closing a session: conch's word on its row, then the failure, the row's second line each time.
    await phase("close, cleanly") { model.rowMessages["claude-5"] = "Closing cleanly…" }
    await phase("close, failed") { model.rowMessages["claude-5"] = "session did not exit cleanly after Ctrl-D" }

    // Agents at work: every working row's line moves on each second, rows gaining and losing their second line.
    await phase("activity", busy: 5) { ticking(model, from: 1, for: 5) }

    // A deliverable filed on a working session while the others work (the 23:13 freeze had no dismiss or restore,
    // only `filed a review` and rows moving on): its mark turns to review, its activity line goes, and the session
    // being looked at is the one that filed it.
    await phase("review filed while agents work", busy: 5) {
        ticking(model, from: 20, for: 5)
        Task { @MainActor in
            await spin(1.2)
            if let index = rows.firstIndex(where: { id($0) == "claude-4" }) {
                rows[index]["status"] = "review"
                rows[index]["activity"] = nil
                rows[index]["review"] = ["summary": "Brand deck v3: the new type scale", "link": "/Users/acme/Projects/Atlas/deck.pdf",
                                         "at": now, "id": "deck-v3", "artifact": "6465636b", "version": 3, "kind": "pdf"]
            }
            model.selected = "claude-4"
            model.publish()
        }
    }

    // All of it at once: a dismiss and a restore while the lines move on and the closing row's words change.
    await phase("dismiss and restore while agents work", busy: 6) {
        ticking(model, from: 10, for: 6)
        moveToDismissed("claude-12")
        model.undo = SessionDismissUndo(id: "claude-12", label: "Dark mode tokens")
        model.publish()
        Task { @MainActor in
            await spin(1.5)
            model.rowMessages["claude-5"] = "Closing cleanly…"
            await spin(1.5)
            restore("claude-12", at: 4)
            model.undo = nil
            model.selected = "claude-12"
            model.publish()
            await spin(1)
            model.rowMessages["claude-5"] = "session did not exit cleanly after Ctrl-D"
        }
    }

    emit(["name": "done"])
    exit(0)
}

app.run()
