// The infinite-scroll benchmark: a synthetic long conversation laid out offscreen, scrolled to its
// top and back twice, measured.
//
//   swift run -c release conch-scroll-bench [after|before|eager-whole] [items] [--json out.json]
//                                           [--no-selection] [--select-all]
//
// `before` is the stack as it was: every recorded row a real view in one eager VStack, drawn from
// its 240-character preview, the page before asked for within a screen of the top, a prepend
// absorbed by measuring the document's growth. `eager-whole` is that stack drawing every message
// whole, which is what reading long messages whole would cost without windowing. `after` is
// `HistoryRegion`: the production region, model, window and scroll driver, over a fake record store
// that pages the synthetic session fifty items at a time with a delay.
//
// The rows are the harness's own, drawn with the shared MarkdownView the apps use for replies; the
// apps' rows add controls around the same text. The window sits offscreen and never takes focus.
//
// `after` carries the conversation's selection as the Mac's does (ConversationSelection.swift): every
// text row reports its layout and has a highlight, and the surface lies over the column.
// `--no-selection` leaves it out, for the numbers without it; `--select-all` scrolls with the whole
// conversation selected, so every row that comes into view is lit.
import AppKit
import ConchDesign
import SwiftUI

// MARK: - The session

struct Synthetic {
    let items: [HistoryItem]
    let bodies: [String: String]
    /// The live tail: the daemon's forty newest, drawn in full in every mode.
    let live: [LiveRow]

    struct LiveRow: Identifiable {
        let id: String
        let kind: String
        let text: String
        let image: String?
    }

    static func make(count: Int, images: [String]) -> Synthetic {
        let fixtures = ["mvps-and-backend-primitives", "migration-plan"].compactMap { name -> String? in
            let url = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("Tests/ConchDesignTests/Fixtures/\(name).md")
            return try? String(contentsOf: url, encoding: .utf8)
        }
        var rng = SplitMix(seed: 7)
        let words = "the record store pages backwards only and every cursor it hands out stays good for the life of its epoch so a page released to stay under the ceiling is one request away from coming back reply tool build test render scroll anchor height viewport session transcript".split(separator: " ").map(String.init)
        func prose(_ characters: Int, index: Int) -> String {
            var out = "Reply \(index). "
            while out.count < characters {
                let n = 8 + Int(rng.next() % 14)
                out += (0..<n).map { _ in words[Int(rng.next() % UInt64(words.count))] }.joined(separator: " ")
                out += rng.next() % 5 == 0 ? ".\n\n" : ". "
                if rng.next() % 17 == 0 { out += "- \(words[Int(rng.next() % 20)]) one\n- two \(index)\n- three\n\n" }
                if rng.next() % 23 == 0 { out += "```\nlet page = \(index)\nprint(page)\n```\n\n" }
            }
            return out
        }
        var items: [HistoryItem] = []
        var bodies: [String: String] = [:]
        let start = 1_700_000_000_000.0
        for i in 0..<count {
            let id = String(format: "item-%05d", i)
            let at = start + Double(i) * 4_000
            let body: String
            let kind: String
            var role: String? = nil
            switch i % 12 {
            case 0:
                kind = "message"; role = "user"
                body = prose(40 + Int(rng.next() % 500), index: i)
            case 1, 5, 9:
                kind = "message"; role = "assistant"
                if i % 97 == 1, !fixtures.isEmpty {
                    body = fixtures[i % fixtures.count] // a long document: tables, headings, code
                } else if i % 40 == 5 {
                    body = prose(8_000 + Int(rng.next() % 12_000), index: i) // long
                } else {
                    body = prose(200 + Int(rng.next() % 1_800), index: i)
                }
            default:
                kind = i % 2 == 0 ? "tool_call" : "tool_result"
                body = "bun test test/records-history.test.ts --timeout \(i)\n" + String(repeating: "ok \(i) passes\n", count: 1 + Int(rng.next() % 30))
            }
            bodies[id] = body
            items.append(HistoryItem(
                id: id, kind: kind, role: role, nativeId: id, toolName: kind.hasPrefix("tool") ? "Bash" : nil,
                at: at, revision: 1, preview: String(body.prefix(240)), bodyBytes: body.utf8.count
            ))
        }
        var live: [LiveRow] = []
        for i in 0..<40 {
            let image = i % 15 == 7 && !images.isEmpty ? images[i % images.count] : nil
            live.append(LiveRow(id: "live-\(i)", kind: image != nil ? "image" : (i % 3 == 0 ? "user" : "assistant"),
                                text: prose(100 + Int(rng.next() % 900), index: count + i), image: image))
        }
        return Synthetic(items: items, bodies: bodies, live: live)
    }
}

struct SplitMix {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// Large pictures on disk, as a screenshot a session read would be.
func writeImages(to directory: URL) -> [String] {
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return (0..<3).map { index in
        let path = directory.appendingPathComponent("shot-\(index).png").path
        if !FileManager.default.fileExists(atPath: path) {
            let size = NSSize(width: 2880, height: 1800)
            let image = NSImage(size: size)
            image.lockFocus()
            NSColor(calibratedHue: CGFloat(index) / 3, saturation: 0.4, brightness: 0.8, alpha: 1).setFill()
            NSRect(origin: .zero, size: size).fill()
            for stripe in 0..<60 {
                NSColor(calibratedWhite: CGFloat(stripe % 7) / 7, alpha: 0.4).setFill()
                NSRect(x: CGFloat(stripe) * 48, y: 0, width: 24, height: size.height).fill()
            }
            image.unlockFocus()
            if let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
               let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: path))
            }
        }
        return path
    }
}

// MARK: - A record store that pages the session

@MainActor
final class FakeRecord: ObservableObject {
    @Published var paging: HistoryPaging
    @Published var bodies: [String: String] = [:]
    let region = HistoryRegionModel(overscan: 2, cap: 160)
    let session: Synthetic
    let latency: TimeInterval
    let pageSize = 50
    private var reading: Set<String> = []
    private var bodyOrder: [String] = []
    private var shown: Set<String> = []
    private var wanted: [HistoryItem] = []
    private(set) var pagesServed = 0
    private(set) var bodiesServed = 0
    var bodiesInFlight: Bool { !reading.isEmpty }
    var onLanded: ((String) -> Void)?

    init(session: Synthetic, itemCap: Int?, latency: TimeInterval) {
        self.session = session
        self.latency = latency
        paging = HistoryPaging(session: "bench", itemCap: itemCap)
        region.onNearTop = { [weak self] in self?.loadOlder() }
        region.onShown = { [weak self] ids, center in self?.show(ids, center: center) }
    }

    var loading: Bool { paging.status == .loading }

    /// `before` is an offset into the session: items older than it, newest `pageSize` of them.
    func loadOlder() {
        guard paging.canLoadOlder else { return }
        let generation = paging.beginLoad()
        let before = paging.previousCursor.flatMap(Int.init) ?? session.items.count
        let page = serve(before: before)
        DispatchQueue.main.asyncAfter(deadline: .now() + latency) {
            self.onLanded?("page")
            self.paging.apply(page: page, generation: generation)
        }
    }

    private func serve(before: Int) -> HistoryPage {
        pagesServed += 1
        let from = max(0, before - pageSize)
        return HistoryPage(
            items: Array(session.items[from..<before]),
            previousCursor: from == 0 ? nil : String(from),
            epoch: "bench",
            coverage: HistoryCoverage(sources: 1, statuses: ["complete": 1])
        )
    }

    private func show(_ ids: [String], center: String?) {
        paging.focus(on: center)
        shown = Set(ids)
        for page in paging.releasedPages(holding: shown) {
            guard let reread = paging.beginReread(page: page), let before = Int(reread.cursor) else { continue }
            let served = serve(before: before)
            DispatchQueue.main.asyncAfter(deadline: .now() + latency) {
                self.onLanded?("reread")
                self.paging.apply(reread: served, page: page, generation: reread.generation)
            }
        }
        let byID = Dictionary(paging.items.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        wanted = ids.compactMap { byID[$0] }
        pumpBodies(center: wanted.firstIndex { $0.id == center } ?? wanted.count / 2)
    }

    private func pumpBodies(center: Int) {
        for id in HistoryDemand.bodies(for: wanted, around: center, held: Set(bodies.keys), reading: reading) {
            reading.insert(id)
            let text = session.bodies[id] ?? ""
            bodiesServed += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + latency / 2) {
                self.onLanded?("body")
                self.reading.remove(id)
                self.bodies[id] = text
                self.bodyOrder.removeAll { $0 == id }
                self.bodyOrder.append(id)
                let held = self.bodyOrder.map { (id: $0, bytes: self.bodies[$0]?.utf8.count ?? 0) }
                for released in HistoryBudget.release(held, keepingUnder: HistoryBudget.macBodyBytes, pinned: self.shown) {
                    self.bodies[released] = nil
                    self.bodyOrder.removeAll { $0 == released }
                }
                self.pumpBodies(center: center)
            }
        }
    }

    var heldBodyBytes: Int { bodies.values.reduce(0) { $0 + $1.utf8.count } }
}

// MARK: - Rows

struct RowModel: Identifiable {
    let id: String
    let kind: String
    let role: String?
    let text: String
    let image: String?
}

/// Where each row is on screen, for the anchor measurement: a zero-size AppKit view per row.
@MainActor
final class Markers {
    static let shared = Markers()
    var enabled = false
    var views: [String: WeakView] = [:]
    final class WeakView { weak var view: NSView?; init(_ view: NSView) { self.view = view } }
}

struct Marker: NSViewRepresentable {
    let id: String
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        Markers.shared.views[id] = .init(view)
        return view
    }
    func updateNSView(_ view: NSView, context: Context) { Markers.shared.views[id] = .init(view) }
}

struct BenchRow: View {
    let row: RowModel
    let decodeAtDisplaySize: Bool
    var selection: ConversationSelectionController? = nil

    var body: some View {
        selectable
            .background(alignment: .topLeading) {
                if Markers.shared.enabled { Marker(id: row.id).frame(width: 0, height: 0) }
            }
            .background(alignment: .bottomLeading) {
                if Markers.shared.enabled { Marker(id: row.id + "#end").frame(width: 0, height: 0) }
            }
    }

    /// A text row joins the conversation's selection, as the Mac's messages do.
    @ViewBuilder
    private var selectable: some View {
        if let selection, BenchSelection.isText(row) {
            content.conversationSelectionRow(row.id, in: selection)
        } else {
            content
        }
    }

    @ViewBuilder
    private var content: some View {
        switch row.kind {
        case "tool_call", "tool_result":
            HStack(spacing: 8) {
                Image(systemName: "terminal").font(.system(size: 9.5)).frame(width: 12)
                Text("Bash").font(.system(size: 11, weight: .medium, design: .monospaced))
                Text(row.text.prefix(120)).font(.system(size: 11, design: .monospaced)).lineLimit(1).truncationMode(.middle)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case "image":
            BenchImage(path: row.image ?? "", decodeAtDisplaySize: decodeAtDisplaySize)
        default:
            if row.role == "user" || row.kind == "user" {
                HStack {
                    Spacer(minLength: 48)
                    Text(row.text).conversationSelectable(row: selection == nil ? nil : row.id, segment: 0)
                        .font(ConchType.readingBody).lineSpacing(ConchType.readingLineSpacing)
                        .textSelection(.enabled)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(ConchColor.fill, in: RoundedRectangle(cornerRadius: ConchRadius.large))
                }
            } else {
                MarkdownView(text: row.text).lineSpacing(ConchType.readingLineSpacing)
                    .foregroundStyle(ConchColor.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

/// The Mac's MaterialRow as it was (`NSImage(contentsOfFile:)`, decoded whole) or at display size.
struct BenchImage: View {
    let path: String
    let decodeAtDisplaySize: Bool
    @State private var thumbnail: NSImage?

    var body: some View {
        Group {
            if decodeAtDisplaySize {
                if let thumbnail { Image(nsImage: thumbnail).resizable().scaledToFit() }
                else { Color.clear }
            } else if let whole = NSImage(contentsOfFile: path) {
                Image(nsImage: whole).resizable().scaledToFit()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: 320, alignment: .leading)
        .frame(height: 320)
        .task(id: path) {
            guard decodeAtDisplaySize else { return }
            thumbnail = await Task.detached { ConchImage.thumbnail(atPath: path, maxPixelSize: 1_400).map { NSImage(cgImage: $0, size: .zero) } }.value
        }
    }
}

// MARK: - The two stacks

/// The selection's reading of the synthetic session, as the Mac's `selectionSource` reads a real one.
@MainActor
enum BenchSelection {
    static var enabled = true

    static func isText(_ row: RowModel) -> Bool {
        row.kind != "tool_call" && row.kind != "tool_result" && row.kind != "image"
    }

    static func source(_ record: FakeRecord) -> ConversationSelectionController.Source {
        .init(
            rowIDs: { record.paging.rows.map(\.id) + record.session.live.map(\.id) },
            rowTexts: { ids in
                let wanted = Set(ids)
                var texts: [String: SelectableRowText] = [:]
                var rows = record.paging.items.filter { wanted.contains($0.id) }.map {
                    RowModel(id: $0.id, kind: $0.kind, role: $0.role, text: record.bodies[$0.id] ?? $0.preview, image: nil)
                }
                rows += record.session.live.filter { wanted.contains($0.id) }.map {
                    RowModel(id: $0.id, kind: $0.kind, role: nil, text: $0.text, image: $0.image)
                }
                for row in rows where isText(row) {
                    let user = row.role == "user" || row.kind == "user"
                    texts[row.id] = SelectableRowText(
                        id: row.id,
                        speaker: user ? .you : .agent("Claude"),
                        segments: user ? [SelectableSegment(text: row.text)] : MarkdownView.selectableSegments(row.text)
                    )
                }
                return texts
            }
        )
    }
}

struct AfterStack: View {
    @ObservedObject var record: FakeRecord
    let selection: ConversationSelectionController?

    var body: some View {
        let _ = selection?.source = BenchSelection.source(record)
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HistoryRegion(
                    model: record.region,
                    edge: HistoryEdge.of(record.paging, liveIsWhole: false, slow: true),
                    entries: entries,
                    gap: 22,
                    edgeFont: .system(size: 11)
                ) { row in
                    BenchRow(row: row, decodeAtDisplaySize: true, selection: selection)
                }
                ForEach(record.session.live) { live in
                    BenchRow(row: RowModel(id: live.id, kind: live.kind, role: nil, text: live.text, image: live.image), decodeAtDisplaySize: true, selection: selection)
                }
                Color.clear.frame(height: 14).id("bottom")
            }
            .padding(.horizontal, 18)
            .padding(.top, 14)
            .frame(maxWidth: 700, alignment: .leading)
            .modifier(SelectionSurface(selection: selection))
            .frame(maxWidth: .infinity)
        }
    }

    private struct SelectionSurface: ViewModifier {
        let selection: ConversationSelectionController?
        func body(content: Content) -> some View {
            if let selection { content.conversationSelectionSurface(selection) } else { content }
        }
    }

    private var entries: [HistoryEntry<RowModel>] {
        let width = record.region.width > 0 ? record.region.width : 664
        return record.paging.rows.map { row in
            guard let item = row.item else { return HistoryEntry(id: row.id, estimate: 0, payload: nil) }
            let whole = record.bodies[item.id]
            let text = whole ?? (item.hasFullBody ? item.preview + "…" : item.preview)
            return HistoryEntry(
                id: item.id,
                estimate: HistoryEstimate.mac.height(kind: item.kind, role: item.role, characters: item.bodyBytes, width: width),
                payload: RowModel(id: item.id, kind: item.kind, role: item.role, text: text, image: nil)
            )
        }
    }
}

/// The stack as it was, for the `before` numbers.
struct BeforeStack: View {
    @ObservedObject var record: FakeRecord
    let whole: Bool
    let anchor: GrowthAnchor

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text(record.loading ? "Loading earlier messages…" : " ").font(.system(size: 11)).frame(maxWidth: .infinity)
                ForEach(record.paging.items) { item in
                    BenchRow(row: RowModel(id: item.id, kind: item.kind, role: item.role,
                                           text: whole ? (record.session.bodies[item.id] ?? item.preview) : item.preview,
                                           image: nil), decodeAtDisplaySize: false)
                }
                ForEach(record.session.live) { live in
                    BenchRow(row: RowModel(id: live.id, kind: live.kind, role: nil, text: live.text, image: live.image), decodeAtDisplaySize: false)
                }
                Color.clear.frame(height: 14).id("bottom")
            }
            .padding(.horizontal, 18)
            .padding(.top, 14)
            .frame(maxWidth: 700, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .onChange(of: record.paging.items.count) { _, _ in anchor.expectPrepend() }
    }
}

/// `ConversationScrollAnchor` as it was: a prepend absorbed by the document's whole growth.
@MainActor
final class GrowthAnchor {
    weak var scrollView: NSScrollView?
    private var last: CGFloat = 0
    private var pending = false
    func watch(_ scrollView: NSScrollView) {
        self.scrollView = scrollView
        guard let document = scrollView.documentView else { return }
        last = document.bounds.height
        document.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: document, queue: nil) { [weak self] _ in
            MainActor.assumeIsolated { self?.resized() }
        }
    }
    func expectPrepend() { pending = true }
    private func resized() {
        guard let scrollView, let document = scrollView.documentView else { return }
        let grown = document.bounds.height - last
        last = document.bounds.height
        guard pending else { return }
        pending = false
        guard grown > 0 else { return }
        let clip = scrollView.contentView
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: clip.bounds.origin.y + grown))
        scrollView.reflectScrolledClipView(clip)
    }
}

// MARK: - Measuring

func footprint() -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    return result == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1
}

func findScrollView(in view: NSView) -> NSScrollView? {
    if let scroll = view as? NSScrollView { return scroll }
    for sub in view.subviews { if let found = findScrollView(in: sub) { return found } }
    return nil
}

func percentile(_ values: [Double], _ p: Double) -> Double {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    return sorted[min(sorted.count - 1, Int((Double(sorted.count - 1) * p).rounded()))]
}

// MARK: - Run

/// The benchmark, run inside NSApplication's own event loop.
///
/// A 60 Hz timer is the trackpad: a quarter of a screen a tick, which is about what a fast flick
/// moves in a frame, and it holds still while anything is in flight so that what lands, lands
/// under a still reader. Everything is measured where a display would see it — after the loop's
/// own Core Animation commit — and a turn's work is the time from the loop waking to that commit.
/// An earlier version drove the loop by hand and forced a commit after every source it handled;
/// that committed states no app ever shows, between a block and SwiftUI's own update.
@MainActor
final class Bench {
    enum Phase: Equatable { case opening, up(Int), down(Int), done }

    let mode: String
    let count: Int
    let session: Synthetic
    let record: FakeRecord
    let anchor = GrowthAnchor()
    let jsonPath: String?
    let selection: ConversationSelectionController?
    let selectAll: Bool
    var window: NSWindow!
    var scrollView: NSScrollView!
    var clip: NSClipView { scrollView.contentView }
    var phase: Phase = .opening
    var ticks = 0
    var stillAtEnd = 0
    var baseline: Double = 0
    var memory: [(String, Double)] = []
    var clock: CFTimeInterval = 0
    var measuring = false
    var turnStart: CFTimeInterval = 0
    var turns: [Double] = []
    var steps = 0
    var tracked: (id: String, y: CGFloat)?
    var drift: [Double] = []
    var jumps = 0
    var lost = 0
    var blank = 0
    var scrolledSinceSample = true
    var landings = 0
    var maxViews = 0
    var maxHeld = 0
    var observers: [CFRunLoopObserver] = []
    var trace: [String] = []
    /// What happened in the turn being timed, and how many slow turns each combination made.
    var tags: Set<String> = []
    var slowBy: [String: Int] = [:]
    var lastReal: Range<Int> = 0..<0
    var timer: Timer?

    init(mode: String, count: Int, session: Synthetic, jsonPath: String?, selection: Bool, selectAll: Bool) {
        self.mode = mode
        self.count = count
        self.session = session
        self.jsonPath = jsonPath
        self.selection = selection && mode == "after" ? ConversationSelectionController() : nil
        self.selectAll = selectAll
        // A ceiling on what is held — the phone's is 1,000, the Mac's 4,000. `before` had none on the Mac.
        record = FakeRecord(session: session, itemCap: mode == "after" ? 4_000 : nil, latency: 0.04)
    }

    var maxY: CGFloat { (scrollView.documentView?.bounds.height ?? 0) - clip.bounds.height }
    var busy: Bool { record.loading || !record.paging.rereading.isEmpty || record.bodiesInFlight }

    func start() {
        Markers.shared.enabled = mode == "after"
        let root: AnyView = mode == "after"
            ? AnyView(AfterStack(record: record, selection: selection))
            : AnyView(BeforeStack(record: record, whole: mode == "eager-whole", anchor: anchor))
        window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: 760, height: 900),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = NSHostingView(rootView: root.background(ConchColor.surface))
        window.orderFrontRegardless()
        record.onLanded = { [weak self] kind in
            self?.landings += 1
            self?.trace.append("lands")
            self?.tags.insert(kind)
        }


        let wake = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue, true, 0) { [weak self] _, _ in
            MainActor.assumeIsolated {
                self?.turnStart = CACurrentMediaTime()
                self?.tags = []
            }
        }
        // After Core Animation's commit (order 2,000,000): what is on screen now.
        let committed = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, 3_000_000) { [weak self] _, _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if self.measuring, self.turnStart > 0 {
                    let ms = (CACurrentMediaTime() - self.turnStart) * 1_000
                    if ms > 0.2 { self.turns.append(ms) }
                    let real = self.record.region.window.materialised
                    let added = real.filter { !self.lastReal.contains($0) }.count
                    if added > 0 { self.tags.insert(added > 3 ? "rows>3" : "rows<=3") }
                    self.lastReal = real
                    if ms > 16.7 {
                        let key = self.tags.isEmpty ? "(nothing tagged)" : self.tags.sorted().joined(separator: "+")
                        self.slowBy[key, default: 0] += 1
                    }
                }
                self.sample()
            }
        }
        observers = [wake!, committed!]
        for observer in observers { CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes) }
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { autoreleasepool { self?.tick() } }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func scroll(to y: CGFloat) {
        scrolledSinceSample = true
        trace.append("== scroll \(y)")
        clip.scroll(to: NSPoint(x: 0, y: max(0, y)))
        scrollView.reflectScrolledClipView(clip)
    }

    func tick() {
        ticks += 1
        switch phase {
        case .opening:
            if ticks == 15 {
                guard let found = findScrollView(in: window.contentView!) else { fatalError("no scroll view") }
                scrollView = found
                anchor.watch(found)
                // The process with the session generated and an empty window up: what every mode shares.
                baseline = footprint()
                record.loadOlder()
            }
            if ticks == 45 { scroll(to: maxY) }
            if ticks == 80, selectAll { selection?.selectAll() }
            if ticks == 90 {
                memory.append(("1 at rest, opened at the end", footprint() - baseline))
                clock = CACurrentMediaTime()
                measuring = true
                phase = .up(1)
            }
        case let .up(round):
            guard !busy else { return }
            let before = clip.bounds.minY
            scroll(to: before - clip.bounds.height * 0.25)
            tags.insert("scroll")
            if mode != "after", clip.bounds.minY <= clip.bounds.height { record.loadOlder() }
            steps += 1
            note()
            let atTop = clip.bounds.minY <= 0.5 && !record.paging.canLoadOlder && !record.loading
            stillAtEnd = atTop ? stillAtEnd + 1 : 0
            if stillAtEnd >= 3 {
                stillAtEnd = 0
                if round == 1 { memory.append(("2 after scrolling to the top", footprint() - baseline)) }
                phase = .down(round)
            }
        case let .down(round):
            guard !busy else { return }
            scroll(to: min(clip.bounds.minY + clip.bounds.height * 0.25, maxY))
            tags.insert("scroll")
            steps += 1
            note()
            stillAtEnd = clip.bounds.minY >= maxY - 0.5 ? stillAtEnd + 1 : 0
            if stillAtEnd >= 3 {
                stillAtEnd = 0
                if round == 1 {
                    memory.append(("3 back at the end", footprint() - baseline))
                    phase = .up(2)
                } else {
                    memory.append(("4 after a second round trip", footprint() - baseline))
                    phase = .done
                    finish()
                }
            }
        case .done:
            break
        }
        if steps > 200_000 { finish() }
    }

    func note() {
        maxViews = max(maxViews, record.region.window.materialised.count)
        maxHeld = max(maxHeld, record.paging.items.count)
    }

    /// After every commit: where the row under the eye is.
    ///
    /// The row under the eye is the one covering the viewport's top, else the first starting in
    /// it. If nothing has scrolled since the last commit it must be exactly where it was, whatever
    /// landed in between — a page, a released page read again, a body, a row measured for the
    /// first time. One that moved is a jump; one that vanished from under the eye is a jump; a
    /// commit with no row in the viewport at all, and nothing drawn there, is a blank frame.
    func sample() {
        guard mode == "after", scrollView != nil else { return }
        let visible = clip.bounds
        var tops: [String: CGFloat] = [:]
        var bottoms: [String: CGFloat] = [:]
        for (id, weak) in Markers.shared.views {
            guard let view = weak.view, view.window != nil else { continue }
            let y = view.convert(view.bounds, to: clip).minY - visible.minY
            if id.hasSuffix("#end") { bottoms[String(id.dropLast(4))] = y } else { tops[id] = y }
        }
        var anchor: (String, CGFloat)?
        for (id, top) in tops {
            guard let bottom = bottoms[id], bottom > 0, top < visible.height else { continue }
            if anchor.map({ top < $0.1 }) ?? true { anchor = (id, top) }
        }
        if !scrolledSinceSample, let previous = tracked {
            if let y = tops[previous.id] {
                let moved = abs(y - previous.y)
                drift.append(moved)
                if moved >= 0.5 {
                    jumps += 1
                    if ProcessInfo.processInfo.environment["BENCH_DEBUG"] != nil {
                        print("jump \(previous.id) \(previous.y) -> \(y) clip=\(visible.minY) rows=\(record.paging.rows.count)")
                        for line in trace.suffix(30) { print("    " + line) }
                    }
                }
            } else {
                jumps += 1
                lost += 1
            }
        }
        let covered = tops.contains { id, top in top < visible.height && (bottoms[id] ?? top) > 0 }
        // A row taller than the viewport can have both markers far off screen, and SwiftUI lets
        // those go; the pixels are the judge then: anything drawn but the ground is not blank.
        if !covered, visible.minY > 60, !drawsSomething() {
            blank += 1
            if ProcessInfo.processInfo.environment["BENCH_DEBUG"] != nil {
                let w = record.region.window
                print("blank clip=\(visible.minY) doc=\(scrollView.documentView?.bounds.height ?? -1) rows=\(record.paging.rows.count) real=\(w.materialised) readerTop=\(w.readerTop ?? -1) total=\(w.total) target=\(String(describing: w.target)) markers=\(tops.count)")
                if let rt = w.readerTop {
                    let rows = w.rows(from: rt, to: rt + visible.height)
                    print("   table rows at reader: \(rows) ids \(rows.map { w.ids[$0] }.prefix(4)) tops \(rows.map { w.top(of: $0) - rt }.prefix(4))")
                }
                for line in trace.suffix(12) { print("    " + line) }
            }
        }
        tracked = anchor.map { (id: $0.0, y: $0.1) }
        scrolledSinceSample = false
        let line = "-- commit anchor \(tracked?.id ?? "-")@\(tracked?.y ?? -1) clip \(visible.minY) doc \(scrollView.documentView?.bounds.height ?? -1)"
        if trace.last != line { trace.append(line) }
        if trace.count > 600 { trace.removeFirst(300) }
    }

    /// Whether the scroll view's layers, rendered, hold anything but one flat colour.
    func drawsSomething() -> Bool {
        guard let layer = scrollView.layer else { return true }
        let size = scrollView.bounds.size
        let width = Int(size.width / 4), height = Int(size.height / 4)
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return true }
        context.scaleBy(x: 0.25, y: 0.25)
        layer.render(in: context)
        guard let data = context.data else { return true }
        let pixels = data.bindMemory(to: UInt32.self, capacity: width * height)
        let ground = pixels[0]
        var different = 0
        for i in 0..<(width * height) where pixels[i] != ground { different += 1 }
        return different > width * height / 500
    }

    func finish() {
        timer?.invalidate()
        measuring = false
        let elapsed = CACurrentMediaTime() - clock
        let result: [String: Any] = [
            "mode": mode,
            "items": count,
            "selection": selection == nil ? "off" : (selectAll ? "all selected" : "on"),
            "selectionRowsRegistered": selection?.registeredRows.count ?? 0,
            "baselineMB": (baseline * 10).rounded() / 10,
            "memoryMB": Dictionary(uniqueKeysWithValues: memory.map { ($0.0, ($0.1 * 10).rounded() / 10) }),
            "steps": steps,
            "turnMs": ["count": turns.count, "median": percentile(turns, 0.5), "p95": percentile(turns, 0.95),
                       "p99": percentile(turns, 0.99), "max": turns.max() ?? 0,
                       "over16": turns.filter { $0 > 16.7 }.count, "over33": turns.filter { $0 > 33.3 }.count],
            "maxRealRows": mode == "after" ? maxViews : record.paging.items.count + session.live.count,
            "maxHeldItems": maxHeld,
            "heldBodyMB": Double(record.heldBodyBytes) / 1_048_576,
            "pagesServed": record.pagesServed,
            "bodiesServed": record.bodiesServed,
            "landingsWatched": landings,
            "anchorSamples": drift.count,
            "anchorMaxDriftPt": drift.max() ?? 0,
            "anchorJumps": jumps,
            "anchorLost": lost,
            "blankFrames": blank,
            "seconds": elapsed,
            "slowTurnsBy": slowBy,
        ]
        let json = try! JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        print(String(decoding: json, as: UTF8.self))
        if let jsonPath { try? json.write(to: URL(fileURLWithPath: jsonPath)) }
        // The row under the eye moved while nothing scrolled, or the screen was blank: the two
        // things this must never do.
        exit(mode == "after" && (jumps > 0 || blank > 0) ? 1 : 0)
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
let mode = arguments.first ?? "after"
let count = arguments.dropFirst().first.flatMap(Int.init) ?? 5_000
let jsonPath = arguments.firstIndex(of: "--json").flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }
let withSelection = !arguments.contains("--no-selection")
let selectAll = arguments.contains("--select-all")

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let images = writeImages(to: FileManager.default.temporaryDirectory.appendingPathComponent("conch-scroll-bench"))
let session = Synthetic.make(count: count, images: images)
let bench = MainActor.assumeIsolated { Bench(mode: mode, count: count, session: session, jsonPath: jsonPath, selection: withSelection, selectAll: selectAll) }
MainActor.assumeIsolated { bench.start() }
app.run()
