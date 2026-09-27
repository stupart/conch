import SwiftUI
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

// Recorded history as a view: the older messages above a conversation's live tail, read as the
// reader scrolls up and drawn only near the viewport.
//
// Why a region above a live tail, rather than one lazy list for the whole transcript: the Mac's
// stack is deliberately eager, because a lazy stack left the viewport on rows it had not built
// while a streaming reply changed the document's height, and the reader saw bare background. The
// live tail keeps that — at most the daemon's forty-item window, built in full, growing at the
// bottom, followed there. Everything older is here, where nothing streams: rows near the viewport
// are real views, the rest are one spacer above and one below, and every row keeps the height it
// was drawn at (`HistoryWindow`). The heights being exact is what makes it invisible, and what
// lets a page arrive above the reader without moving them: the scroll position is moved by
// exactly what was added, in the same layout pass (`HistoryScrollDriver`).

/// One row of recorded history as the region is given it.
public struct HistoryEntry<Payload>: Identifiable {
    public let id: String
    /// Its height before it is first drawn, the gap above it included (`HistoryEstimate`).
    public let estimate: CGFloat
    /// What to draw. Nil for a row whose page was released: it keeps its place and height, and
    /// comes back when its page is read again.
    public let payload: Payload?

    public init(id: String, estimate: CGFloat, payload: Payload?) {
        self.id = id
        self.estimate = estimate
        self.payload = payload
    }
}

/// The region's state, held by the reader it belongs to rather than by the view, so the view
/// that draws a conversation is not redrawn every time a row is measured or the reader scrolls.
@MainActor
public final class HistoryRegionModel: ObservableObject {
    public private(set) var window: HistoryWindow
    let driver = HistoryScrollDriver()
    /// The reader is within `HistoryPrefetch.screens` of the top of what is held.
    public var onNearTop: () -> Void = {}
    /// A different set of rows is real: every one of them (the region reads bodies and released
    /// pages for these), and the one in the middle of the viewport (what the ceiling releases
    /// farthest from).
    public var onShown: (_ ids: [String], _ center: String?) -> Void = { _, _ in }
    /// The width rows were last drawn at: what their estimates should assume.
    public private(set) var width: CGFloat = 0
    private let overscan: CGFloat
    private let cap: Int
    private var shownScheduled = false
    private var growthScheduled = false

    public init(overscan: CGFloat = 2, cap: Int = 160) {
        self.overscan = overscan
        self.cap = cap
        window = HistoryWindow(overscan: overscan, cap: cap)
        driver.onScroll = { [weak self] top, height, above in self?.scrolled(top: top, height: height, contentAbove: above) }
    }

    /// Another session: nothing about the last one's rows or heights applies.
    public func reset() {
        window = HistoryWindow(overscan: overscan, cap: cap)
        driver.cancel()
        objectWillChange.send()
    }

    /// The rows, as the region's body is given them. Called from `body`, so it publishes
    /// nothing: the body it is called from draws the result.
    func sync(_ slots: [HistoryWindow.Slot]) {
        let before = window.materialised.map { window.ids[$0] }
        let total = window.total
        shifted(by: window.set(slots), from: total)
        if window.materialised.map({ window.ids[$0] }) != before { scheduleShown() }
        scheduleGrowth()
    }

    /// A row was drawn: from here on it is laid out at exactly this height.
    ///
    /// Recorded even when it is the height the row is already laid out at. A row drawn at its
    /// estimate and never recorded as drawn is one the next estimate moves — and the row, whose
    /// own height did not change, never says so again.
    func measured(_ id: String, height: CGFloat) {
        guard let laidOut = window.height(of: id) else { return }
        let total = window.total
        let shift = window.measure(id, height: height)
        guard abs(laidOut - height) >= 0.5 else { return }
        shifted(by: shift, from: total)
        if window.reframe() { scheduleShown() }
        scheduleGrowth()
        objectWillChange.send()
    }

    /// A change to the table moved the reader by `shift`: applied when the document resizes to
    /// hold the change (`HistoryScrollDriver`). A change that leaves the region's height where it
    /// was — a row above grew by exactly what one below shrank — resizes nothing, so it is not
    /// compensated: a move with no layout to wait for is the one that lands ahead of its layout,
    /// or lingers until some later resize applies it to the wrong one.
    private func shifted(by shift: CGFloat, from total: CGFloat) {
        guard abs(window.total - total) >= 0.5 else { return }
        driver.shift(by: shift)
    }

    func resized(width: CGFloat) {
        guard abs(width - self.width) >= 1 else { return }
        // The first width is not a change: rows have not been drawn at another yet.
        if self.width > 0 { window.forgetMeasurements() }
        self.width = width
    }

    private func scrolled(top: CGFloat, height: CGFloat, contentAbove: CGFloat) {
        if window.scrolled(top: top, height: height) {
            scheduleShown()
            objectWillChange.send()
        }
        scheduleGrowth()
        if HistoryPrefetch.shouldLoadOlder(contentAbove: contentAbove, viewport: height) { onNearTop() }
    }

    /// The rest of a re-centre, a few rows a turn, until the real rows reach their target.
    private func scheduleGrowth() {
        guard window.target != nil, !growthScheduled else { return }
        growthScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.growthScheduled = false
            if self.window.reframe() {
                self.scheduleShown()
                self.objectWillChange.send()
            }
            self.scheduleGrowth()
        }
    }

    /// Told after the update that changed it, never during one: the reader answers by changing
    /// what it publishes.
    private func scheduleShown() {
        guard !shownScheduled else { return }
        shownScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.shownScheduled = false
            let ids = self.window.materialised.map { self.window.ids[$0] }.filter { $0 != HistoryRegionID.edge }
            var center: String?
            if let top = self.window.readerTop, let height = self.window.readerHeight {
                let middle = self.window.rows(from: top + height / 2, to: top + height / 2 + 1)
                if let row = middle.first, row < self.window.count { center = self.window.ids[row] }
            }
            self.onShown(ids, center)
        }
    }
}

enum HistoryRegionID {
    /// The line at the top, laid out as the first row so its changes are absorbed like any other.
    static let edge = "history-edge"
}

/// The older history above a conversation's live tail.
///
/// `gap` is the space above each row, which is the transcript's own rhythm: 22 on the Mac, 14 on
/// the phone. The first row's gap is the one between it and the edge line, as it always was.
public struct HistoryRegion<Payload, Row: View>: View {
    @ObservedObject var model: HistoryRegionModel
    let edge: HistoryEdge
    let note: String?
    let entries: [HistoryEntry<Payload>]
    let gap: CGFloat
    let edgeFont: Font
    let row: (Payload) -> Row
    /// A picture of the region (the design gallery): one layout pass, no scroll view, so every
    /// row at the height it wants rather than the height a later pass would measure.
    @Environment(\.conchRendersStatically) private var rendersStatically

    public init(
        model: HistoryRegionModel,
        edge: HistoryEdge,
        note: String? = nil,
        entries: [HistoryEntry<Payload>],
        gap: CGFloat,
        edgeFont: Font,
        @ViewBuilder row: @escaping (Payload) -> Row
    ) {
        self.model = model
        self.edge = edge
        self.note = note
        self.entries = entries
        self.gap = gap
        self.edgeFont = edgeFont
        self.row = row
    }

    public var body: some View {
        if rendersStatically {
            VStack(alignment: .leading, spacing: 0) {
                HistoryEdgeView(edge: edge, note: note, font: edgeFont)
                ForEach(entries) { entry in
                    if let payload = entry.payload { row(payload).padding(.top, gap) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            windowed
        }
    }

    @ViewBuilder
    private var windowed: some View {
        let _ = model.sync(
            [HistoryWindow.Slot(id: HistoryRegionID.edge, estimate: HistoryEdgeView.height)]
                + entries.map { HistoryWindow.Slot(id: $0.id, estimate: $0.payload == nil ? nil : $0.estimate) }
        )
        let window = model.window
        let shown = window.materialised.map { Shown(index: $0, id: window.ids[$0]) }
        VStack(alignment: .leading, spacing: 0) {
            // Everything above the real rows, and everything below: one height each.
            Color.clear.frame(height: window.above)
            ForEach(shown) { slot in
                self.slot(slot.index, id: slot.id, height: window.heights[slot.index])
            }
            Color.clear.frame(height: window.below)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) {
            HistoryScrollProbe(driver: model.driver).frame(height: 0).allowsHitTesting(false)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { model.resized(width: $0) }
    }

    private struct Shown: Identifiable {
        let index: Int
        let id: String
    }

    /// One row, laid out at the height the table gives it and measured at the height it wants.
    /// The two differ only until the measurement lands, which is before the frame it lands in
    /// is drawn: a table change re-lays out and commits in the same pass.
    @ViewBuilder
    private func slot(_ index: Int, id: String, height: CGFloat) -> some View {
        if index == 0 {
            HistoryEdgeView(edge: edge, note: note, font: edgeFont)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { model.measured(id, height: $0) }
                .frame(height: height, alignment: .top)
        } else if let payload = entries[index - 1].payload {
            row(payload)
                .padding(.top, gap)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { model.measured(id, height: $0) }
                .frame(height: height, alignment: .top)
        } else {
            // Released, and being read again: its height, and a spinner if the read is slow.
            HistoryPlaceholder().frame(height: height)
        }
    }
}

/// The line at the top of recorded history (`HistoryEdge`).
public struct HistoryEdgeView: View {
    let edge: HistoryEdge
    let note: String?
    let font: Font
    @Environment(\.conchRendersStatically) private var rendersStatically
    /// The spinner waits `HistoryEdge.slowAfter` before it shows: most reads are over by then.
    @State private var slow = false

    /// One line's height, reserved whether or not anything is in it, so the spinner arriving and
    /// "Start of the conversation" replacing it never move anything below. A small spinner's.
    public static let height: CGFloat = 20

    public init(edge: HistoryEdge, note: String? = nil, font: Font) {
        self.edge = edge
        self.note = note
        self.font = font
    }

    public var body: some View {
        VStack(spacing: 6) {
            switch edge.mark {
            case .none:
                EmptyView()
            case .loading:
                if rendersStatically {
                    // A picture cannot draw the platform's spinner; this is its shape, still.
                    HistorySpinnerStill()
                } else {
                    ProgressView()
                        .controlSize(.small)
                        .opacity(slow ? 1 : 0)
                        .accessibilityLabel("Loading earlier messages")
                }
            case .start:
                HStack(spacing: 10) {
                    rule
                    Text(HistoryNotice.start).fixedSize()
                    rule
                }
            }
            ForEach(edge.notes, id: \.self) { Text($0) }
            if let note { Text(note) }
        }
        .font(font)
        .foregroundStyle(ConchColor.textTertiary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, minHeight: Self.height, alignment: .center)
        .task(id: edge.mark == .loading) {
            slow = false
            guard edge.mark == .loading else { return }
            try? await Task.sleep(nanoseconds: UInt64(HistoryEdge.slowAfter * 1_000_000_000))
            if !Task.isCancelled { slow = true }
        }
    }

    private var rule: some View {
        Rectangle().fill(ConchColor.hairlineStrong).frame(width: 36, height: 1)
    }
}

/// The small spinner as a still picture, for the design gallery.
struct HistorySpinnerStill: View {
    var body: some View {
        ZStack {
            ForEach(0..<8, id: \.self) { spoke in
                Capsule()
                    .fill(ConchColor.textTertiary.opacity(0.25 + 0.75 * Double(spoke) / 7))
                    .frame(width: 1.8, height: 4.5)
                    .offset(y: -5)
                    .rotationEffect(.degrees(Double(spoke) * 45))
            }
        }
        .frame(width: 16, height: 16)
    }
}

/// A released row's place, while its page is read again.
struct HistoryPlaceholder: View {
    @State private var slow = false

    var body: some View {
        Color.clear
            .overlay {
                if slow { ProgressView().controlSize(.small) }
            }
            .task {
                try? await Task.sleep(nanoseconds: UInt64(HistoryEdge.slowAfter * 1_000_000_000))
                if !Task.isCancelled { slow = true }
            }
    }
}

// MARK: - The scroll view

/// The scroll view the region is in: where the reader is, and moving them.
///
/// SwiftUI says neither on the versions this ships to — `onScrollGeometryChange` is macOS 15 and
/// iOS 18 — so the platform's own scroll view is found from a zero-height view at the region's
/// top and listened to. The move is applied when the document's size changes, which is inside the
/// layout pass that changed it (the Mac's `frameDidChange`, the phone's `contentSize`), so no frame
/// is ever drawn with the content moved and the reader not — whenever that layout comes. Usually
/// it is the same run-loop turn as the change; sometimes SwiftUI commits a frame first and lays the
/// change out a turn later, which is why nothing else ever applies a move (`shift(by:)`).
@MainActor
final class HistoryScrollDriver {
    /// The reader moved or the viewport resized: their top in region coordinates, the viewport's
    /// height, and how much content is above the viewport in the whole document.
    var onScroll: (_ top: CGFloat, _ height: CGFloat, _ contentAbove: CGFloat) -> Void = { _, _, _ in }
    /// Shifts asked for and not yet applied.
    private(set) var pending: CGFloat = 0
    private var reportScheduled = false

    #if canImport(AppKit)
    private weak var probe: NSView?
    private weak var scrollView: NSScrollView?
    private var observers: [NSObjectProtocol] = []

    func attach(probe: NSView) {
        self.probe = probe
        var ancestor = probe.superview
        while let candidate = ancestor, !(candidate is NSScrollView) { ancestor = candidate.superview }
        guard let found = ancestor as? NSScrollView, found !== scrollView else { scheduleReport(); return }
        detach()
        pending = 0
        scrollView = found
        found.contentView.postsBoundsChangedNotifications = true
        found.documentView?.postsFrameChangedNotifications = true
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSView.boundsDidChangeNotification, object: found.contentView, queue: nil) { [weak self] _ in
            MainActor.assumeIsolated { self?.scheduleReport() }
        })
        if let document = found.documentView {
            observers.append(center.addObserver(forName: NSView.frameDidChangeNotification, object: document, queue: nil) { [weak self] _ in
                MainActor.assumeIsolated { self?.documentResized() }
            })
        }
        scheduleReport()
    }

    func detach() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        scrollView = nil
    }

    /// Moves the reader down by `pending` — the content above them grew by that much.
    private func apply() {
        guard pending != 0, let scrollView, let document = scrollView.documentView, document.isFlipped else {
            pending = 0
            return
        }
        let clip = scrollView.contentView
        let delta = pending
        pending = 0
        // Relative to where the reader is NOW, so a flick that is still moving keeps its ground.
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: clip.bounds.origin.y + delta))
        scrollView.reflectScrolledClipView(clip)
    }

    private func report() {
        guard let scrollView, let probe, let document = scrollView.documentView, document.isFlipped else { return }
        let visible = scrollView.contentView.documentVisibleRect
        let regionTop = probe.convert(probe.bounds, to: document).minY
        // Plus any move still waiting for its layout: the table already describes the rows as
        // they will be, and a position from before the move would make the wrong rows real — one
        // blank frame when the move lands, measured.
        onScroll(visible.minY - regionTop + pending, visible.height, visible.minY - document.bounds.minY + pending)
    }
    #elseif canImport(UIKit)
    private weak var probe: UIView?
    private weak var scrollView: UIScrollView?
    private var observations: [NSKeyValueObservation] = []

    func attach(probe: UIView) {
        self.probe = probe
        var ancestor = probe.superview
        while let candidate = ancestor, !(candidate is UIScrollView) { ancestor = candidate.superview }
        guard let found = ancestor as? UIScrollView, found !== scrollView else { scheduleReport(); return }
        detach()
        pending = 0
        scrollView = found
        observations = [
            found.observe(\.contentOffset, options: []) { [weak self] _, _ in
                MainActor.assumeIsolated { self?.scheduleReport() }
            },
            found.observe(\.contentSize, options: []) { [weak self] _, _ in
                MainActor.assumeIsolated { self?.documentResized() }
            },
            found.observe(\.bounds, options: []) { [weak self] _, _ in
                MainActor.assumeIsolated { self?.scheduleReport() }
            },
        ]
        scheduleReport()
    }

    func detach() {
        observations = []
        scrollView = nil
    }

    private func apply() {
        guard pending != 0, let scrollView else {
            pending = 0
            return
        }
        let delta = pending
        pending = 0
        var offset = scrollView.contentOffset
        offset.y += delta
        scrollView.contentOffset = offset
    }

    private func report() {
        guard let scrollView, let probe else { return }
        let insets = scrollView.adjustedContentInset
        let top = scrollView.contentOffset.y + insets.top
        let height = scrollView.bounds.height - insets.top - insets.bottom
        let regionTop = probe.convert(CGPoint.zero, to: scrollView).y
        // Plus any move still waiting for its layout (the Mac's reason).
        onScroll(top - regionTop + pending, height, top + pending)
    }
    #endif

    /// Ask for the reader to be moved by `delta` once the change that needs it is laid out: when
    /// the document resizes to hold it, and not a moment before.
    ///
    /// Not on a timer as well. SwiftUI can evaluate the body carrying a change, commit a frame
    /// without laying it out, and lay it out a turn later; a move applied on the next turn then
    /// lands between the two, and the frame shows the whole page's jump — measured in
    /// conch-scroll-bench under NSApplication's own loop: an 8,712 pt jump in five runs of six.
    func shift(by delta: CGFloat) {
        // Before a scroll view is found there is no reader to move — the region is being laid out
        // for the first time — and a move kept until one is would be applied to a later layout.
        guard abs(delta) >= 0.5, scrollView != nil else { return }
        pending += delta
    }

    func cancel() {
        pending = 0
    }

    /// Inside the layout pass that changed the size: the move is applied now, so it is drawn with
    /// the change; what the reader's new place means for which rows are real is worked out after
    /// the pass, because answering it publishes, and publishing during an update is undefined.
    private func documentResized() {
        apply()
        scheduleReport()
    }

    /// One report per run-loop turn, after it: a flick delivers dozens of scroll events a frame.
    private func scheduleReport() {
        guard !reportScheduled else { return }
        reportScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.reportScheduled = false
            self.report()
        }
    }
}

#if canImport(AppKit)
struct HistoryScrollProbe: NSViewRepresentable {
    let driver: HistoryScrollDriver

    func makeNSView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.onMoveToWindow = { [weak view] in if let view { driver.attach(probe: view) } }
        return view
    }

    func updateNSView(_ view: ProbeView, context: Context) {
        view.onMoveToWindow = { [weak view] in if let view { driver.attach(probe: view) } }
    }

    static func dismantleNSView(_ view: ProbeView, coordinator: ()) {
        view.onMoveToWindow = nil
    }

    final class ProbeView: NSView {
        var onMoveToWindow: (() -> Void)?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil else { return }
            // After the hierarchy settles: the scroll view is an ancestor only once SwiftUI has
            // finished inserting this view.
            DispatchQueue.main.async { [weak self] in self?.onMoveToWindow?() }
        }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}
#elseif canImport(UIKit)
struct HistoryScrollProbe: UIViewRepresentable {
    let driver: HistoryScrollDriver

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.isUserInteractionEnabled = false
        view.onMoveToWindow = { [weak view] in if let view { driver.attach(probe: view) } }
        return view
    }

    func updateUIView(_ view: ProbeView, context: Context) {
        view.onMoveToWindow = { [weak view] in if let view { driver.attach(probe: view) } }
    }

    final class ProbeView: UIView {
        var onMoveToWindow: (() -> Void)?
        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil else { return }
            DispatchQueue.main.async { [weak self] in self?.onMoveToWindow?() }
        }
    }
}
#endif
