import Combine
import CoreGraphics
import Foundation

/// Tells one row's highlight to draw again: only the rows whose part of the selection changed are told, so a drag redraws
/// the rows it moves through and not the conversation.
@MainActor
public final class RowSelectionBox: ObservableObject {
    public init() {}
}

/// The conversation's selection, and everything that turns the pointer into it.
///
/// Every selectable row tells it where it is (`place`), and let go when it stops being a view (`unregister`). Where a
/// row's WORDS are costs more: reading SwiftUI's layout of a row's texts made a row a third dearer to bring into view
/// (measured offscreen, 5 rows a turn: 27.5 ms plain, 28.5 placed, 36 read), and rows come into view on nearly every
/// step of a scroll. So a row reads it only once it is armed — the pointer moved onto it, rested on it after a scroll,
/// a drag passed over it, or the selection covers it (`arm`) — and then reports it (`register`). Rows scrolled under a
/// still pointer are never armed. The pointer's surface asks whether a press is on text, and hands it presses and drags
/// in the stack's coordinates. What is selected is kept as `SelectionPoint`s, so it outlives every view it was made
/// over.
@MainActor
public final class ConversationSelectionController: ObservableObject {
    /// How the conversation is read: its rows in order, their texts, and what a row that left the live window is called
    /// now (the snapshot and the record name one message differently).
    public struct Source {
        public var rowIDs: () -> [String]
        public var rowTexts: ([String]) -> [String: SelectableRowText]
        public var alias: (String) -> String?

        public init(
            rowIDs: @escaping () -> [String],
            rowTexts: @escaping ([String]) -> [String: SelectableRowText],
            alias: @escaping (String) -> String? = { _ in nil }
        ) {
            self.rowIDs = rowIDs
            self.rowTexts = rowTexts
            self.alias = alias
        }

        public static let empty = Source(rowIDs: { [] }, rowTexts: { _ in [:] })
    }

    /// One selectable text as a row reports it: which it is, and how to find where its words are, in the ROW's own
    /// coordinates, once its text is known. In the row's, so a row that only moves — a page landing above it moves every
    /// row below — keeps what was worked out, and only says where it is now (`place`).
    public struct RegisteredSegment {
        public let index: Int
        public let geometry: (String) -> SegmentGeometry
        /// Each line's box, from the layout alone: all a row wholly inside the selection needs to be lit, without
        /// working out where every one of its characters is, or reading its text. Nil: from `geometry`.
        public let lines: (() -> [CGRect])?

        public init(index: Int, geometry: @escaping (String) -> SegmentGeometry, lines: (() -> [CGRect])? = nil) {
            self.index = index
            self.geometry = geometry
            self.lines = lines
        }
    }

    /// Set by the conversation every time it is drawn. Reading it is deferred to when the selection needs it.
    public var source: Source = .empty {
        didSet { orderIsStale = true }
    }

    public private(set) var selection: ConversationSelection?
    /// The conversation has the keyboard: the selection is drawn in the accent colour, else in grey (a text view's
    /// selection in a window or view that is not focused).
    public private(set) var isEmphasized = false

    private final class Row {
        var token: UUID
        var frame: CGRect
        var wholeRow: Bool
        var segments: [RegisteredSegment]
        var geometries: [Int: SegmentGeometry] = [:]
        var lineBoxes: [Int: [CGRect]] = [:]
        var text: SelectableRowText?
        var textLoaded = false

        init(token: UUID, frame: CGRect, wholeRow: Bool, segments: [RegisteredSegment]) {
            self.token = token
            self.frame = frame
            self.wholeRow = wholeRow
            self.segments = segments
        }
    }

    private var rows: [String: Row] = [:]
    /// Rows reading their layout. Kept for as long as the row is a view: arming is a rebuild of the row, and a row
    /// armed and disarmed as the pointer crossed it would be rebuilt twice for nothing.
    private var armed: Set<String> = []
    private var generations: [String: Int] = [:]
    private var boxes: [String: RowSelectionBox] = [:]
    private var order = SelectionOrder([])
    private var orderIsStale = true
    /// The text of every selected row that has stopped being a view, as it was when it went: a row scrolled away and let
    /// go of, or whose long body was released since, still copies what was selected in it. A row that is a view is read
    /// as it is now.
    public private(set) var captured: [String: SelectableRowText] = [:]

    private var pressed = false

    public init() {}

    // MARK: - Rows

    /// A selectable row laid out, armed or not: where it is, so the pointer can be matched to it.
    public func place(row id: String, token: UUID, frame: CGRect, wholeRow: Bool) {
        if let row = rows[id] {
            row.token = token
            row.frame = frame
            row.wholeRow = wholeRow
        } else {
            rows[id] = Row(token: token, frame: frame, wholeRow: wholeRow, segments: [])
            if order.position(of: id) == nil { orderIsStale = true }
        }
    }

    /// Whether row `id` reads its layout. A row the selection covers always does: its highlight is drawn from it.
    public func isArmed(_ id: String) -> Bool {
        if armed.contains(id) { return true }
        guard selection != nil, slice(for: id) != nil else { return false }
        armed.insert(id)
        return true
    }

    /// Arm row `id`: from its next layout it reports where its words are.
    public func arm(row id: String) {
        guard !armed.contains(id) else { return }
        armed.insert(id)
        box(for: id).objectWillChange.send()
    }

    /// Arm the row under `point`, if there is one.
    public func arm(at point: CGPoint) {
        if let id = rows.first(where: { $0.value.frame.contains(point) })?.key { arm(row: id) }
    }

    /// A row armed and laid out anew: where each of its texts is, within the row. Called when its texts' layout changes —
    /// its words, or its width — never merely because it moved. `wholeRow`: the row is text through and through (a
    /// message), so a press anywhere in it selects; otherwise only a press on its texts does, and the rest of it — a tool
    /// row's header, say — keeps its buttons. `frame`, when given, is where it is (else `place` says). Returns a number that
    /// changes with every call, for the row's highlight.
    @discardableResult
    public func register(row id: String, token: UUID, frame: CGRect? = nil, wholeRow: Bool, segments: [RegisteredSegment]) -> Int {
        if let row = rows[id] {
            row.token = token
            if let frame { row.frame = frame }
            row.wholeRow = wholeRow
            row.segments = segments
            row.geometries = [:]
            row.lineBoxes = [:]
            row.textLoaded = false
            row.text = nil
        } else {
            rows[id] = Row(token: token, frame: frame ?? .zero, wholeRow: wholeRow, segments: segments)
            if order.position(of: id) == nil { orderIsStale = true }
        }
        // Only an armed row reads its layout, so one reporting it is armed (and must not be told so again).
        armed.insert(id)
        let generation = (generations[id] ?? 0) &+ 1
        generations[id] = generation
        return generation
    }

    /// The row stopped being a view. Only the registration `token` made is removed, so a view that was replaced by a new
    /// one of the same row cannot take the new one's place away when it goes. A selected row's text is kept as it goes.
    public func unregister(row id: String, token: UUID) {
        guard rows[id]?.token == token else { return }
        if selection != nil, slice(for: id) != nil { capture(id) }
        rows[id] = nil
        // A row comes back as a new view, which asks for its own: nothing is kept for the thousands scrolled past.
        boxes[id] = nil
        generations[id] = nil
        armed.remove(id)
    }

    public func box(for id: String) -> RowSelectionBox {
        if let box = boxes[id] { return box }
        let box = RowSelectionBox()
        boxes[id] = box
        return box
    }

    /// The rows that are views now.
    public var registeredRows: [String] { Array(rows.keys) }

    public func frame(of id: String) -> CGRect? { rows[id]?.frame }

    // MARK: - What is selected

    public var hasSelection: Bool {
        guard let selection else { return false }
        return !selection.isEmpty(in: currentOrder())
    }

    public func slice(for id: String) -> RowSelectionSlice? {
        guard let selection else { return nil }
        return selection.slice(for: id, in: currentOrder())
    }

    /// Where `id`'s selected text is, in the row's own coordinates.
    public func highlightRects(for id: String) -> [CGRect] {
        guard let slice = slice(for: id), let row = rows[id] else { return [] }
        // Wholly inside the selection: every line of every text, edge to edge. Scrolling a selected conversation brings
        // rows in whole on every step, and working out each character's place for them was most of that step's time.
        if slice.from == nil, slice.to == nil {
            return row.segments.flatMap { Self.wholeRects(boxes: lineBoxes(of: $0, in: row, id: id)) }
        }
        var rects: [CGRect] = []
        for segment in row.segments {
            guard let geometry = geometry(of: segment.index, in: id),
                  let range = slice.range(ofSegment: segment.index, length: geometry.length) else { continue }
            rects += geometry.rects(for: range, continues: slice.continues(pastSegment: segment.index))
        }
        return rects
    }

    /// What Copy puts on the pasteboard; nil with nothing selected.
    public func copiedText() -> String? {
        let order = currentOrder()
        guard let selection, let (start, end) = selection.bounds(in: order), start != end,
              let first = order.position(of: start.row), let last = order.position(of: end.row), first <= last else { return nil }
        let ids = Array(order.ids[first...last])
        // A row that is a view is read as it is; one that has gone, as it was when it went.
        var texts = source.rowTexts(ids.filter { rows[$0] != nil || captured[$0] == nil })
        for id in ids where rows[id] == nil || texts[id] == nil { if let kept = captured[id] { texts[id] = kept } }
        let text = SelectionCopy.text(rows: ids.compactMap { texts[$0] }, start: start, end: end, order: order)
        return text.isEmpty ? nil : text
    }

    public func selectAll() {
        let order = currentOrder()
        guard let first = order.ids.first, let last = order.ids.last else { return }
        let start = SelectionPoint(row: first, segment: 0, offset: 0)
        let end = SelectionPoint(row: last, segment: Int.max, offset: Int.max)
        set(ConversationSelection(anchor: .caret(start), focus: .caret(end)))
    }

    public func clear() {
        pressed = false
        set(nil)
    }

    /// Selects between two points directly: what a test, or a picture of the selection, starts from.
    public func select(from start: SelectionPoint, to end: SelectionPoint) {
        set(ConversationSelection(anchor: .caret(start), focus: .caret(end)))
    }

    public func setEmphasized(_ on: Bool) {
        guard on != isEmphasized else { return }
        isEmphasized = on
        for id in rows.keys where slice(for: id) != nil { boxes[id]?.objectWillChange.send() }
    }

    // MARK: - The pointer

    /// Whether a press at `point` is the selection's: on a message, or on the text of a row that is more than text. A
    /// press on a link is not — the link opens, as it always did — unless it extends a selection.
    public func accepts(pressAt point: CGPoint, extending: Bool) -> Bool {
        if pressed { return true }
        // A row not armed yet cannot say where its words are: this press is its texts' own, as it always was, and
        // from its next layout the row can answer.
        if row(containing: point) == nil, let placed = rows.first(where: { $0.value.frame.contains(point) })?.key {
            arm(row: placed)
            return false
        }
        guard let id = row(containing: point), let row = rows[id] else { return false }
        if extending, hasSelection { return true }
        guard let hit = hit(at: point, in: id) else { return false }
        if !row.wholeRow {
            let local = CGPoint(x: point.x - row.frame.minX, y: point.y - row.frame.minY)
            guard let geometry = geometry(of: hit.segment, in: id), geometry.bounds.insetBy(dx: -4, dy: -4).contains(local) else { return false }
        }
        if let character = hit.character, let segment = text(of: id)?.segments[selectionSafe: hit.segment], segment.isLink(at: character) {
            return false
        }
        return true
    }

    /// `point` is on the lit selection: a secondary click there offers Copy.
    public func isSelected(at point: CGPoint) -> Bool {
        guard let id = row(containing: point), let frame = rows[id]?.frame else { return false }
        let local = CGPoint(x: point.x - frame.minX, y: point.y - frame.minY)
        return highlightRects(for: id).contains { $0.insetBy(dx: -1, dy: -1).contains(local) }
    }

    /// A press: one click puts the caret down — which clears what was selected, and is where a Shift-click then selects
    /// from, as in a document; two select the word, three the paragraph; with Shift, the selection is extended to it.
    public func press(at point: CGPoint, clickCount: Int, extending: Bool) {
        pressed = true
        guard let id = row(containing: point) ?? nearestRow(to: point), let hit = hit(at: point, in: id) else {
            set(nil)
            return
        }
        if extending, clickCount <= 1, var current = selection, current.bounds(in: currentOrder()) != nil {
            current.focus = unit(at: hit, row: id, granularity: current.granularity)
            set(current)
            return
        }
        let granularity: ConversationSelection.Granularity = clickCount >= 3 ? .paragraph : clickCount == 2 ? .word : .character
        let unit = unit(at: hit, row: id, granularity: granularity)
        set(ConversationSelection(anchor: unit, focus: unit, granularity: granularity))
    }

    public func drag(to point: CGPoint) {
        arm(at: point)
        guard pressed, var current = selection, let id = row(containing: point) ?? nearestRow(to: point),
              let hit = hit(at: point, in: id) else { return }
        current.focus = unit(at: hit, row: id, granularity: current.granularity)
        set(current)
    }

    public func release() {
        pressed = false
    }

    public var isPressing: Bool { pressed }

    // MARK: - Internals

    struct Hit {
        let segment: Int
        let caret: Int
        let character: Int?
    }

    private func currentOrder() -> SelectionOrder {
        if orderIsStale {
            order = SelectionOrder(source.rowIDs())
            orderIsStale = false
            reconcile()
        }
        return order
    }

    /// A selection whose end is a row that left the conversation — a live row the record now names differently — is moved
    /// onto what it is called now, or let go of.
    private func reconcile() {
        guard var current = selection else { return }
        var changed = false
        func fix(_ point: inout SelectionPoint) -> Bool {
            guard order.position(of: point.row) == nil else { return true }
            guard let renamed = source.alias(point.row), order.position(of: renamed) != nil else { return false }
            if let kept = captured.removeValue(forKey: point.row) {
                captured[renamed] = SelectableRowText(id: renamed, speaker: kept.speaker, segments: kept.segments)
            }
            point.row = renamed
            changed = true
            return true
        }
        let ok = fix(&current.anchor.start) && fix(&current.anchor.end) && fix(&current.focus.start) && fix(&current.focus.end)
        guard !ok || changed else { return }
        selection = ok ? current : nil
        if !ok { captured = [:] }
        // Asked while a row is drawn: the rows are told after, never during, a view update.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            for id in self.rows.keys { self.boxes[id]?.objectWillChange.send() }
        }
    }

    private func set(_ next: ConversationSelection?) {
        let order = currentOrder()
        let before = Dictionary(uniqueKeysWithValues: rows.keys.map { ($0, selection?.slice(for: $0, in: order)) })
        selection = next
        // Only what is selected is kept: a row the selection has left gives its text back.
        captured = captured.filter { next?.slice(for: $0.key, in: order) != nil }
        for (id, old) in before where next?.slice(for: id, in: order) != old {
            boxes[id]?.objectWillChange.send()
        }
    }

    private func capture(_ id: String) {
        if let text = text(of: id) { captured[id] = text }
    }

    private func text(of id: String) -> SelectableRowText? {
        if let row = rows[id] {
            if !row.textLoaded {
                row.text = source.rowTexts([id])[id]
                row.textLoaded = true
            }
            return row.text ?? captured[id]
        }
        return captured[id] ?? source.rowTexts([id])[id]
    }

    private func lineBoxes(of segment: RegisteredSegment, in row: Row, id: String) -> [CGRect] {
        if let known = row.lineBoxes[segment.index] { return known }
        let boxes = segment.lines?() ?? geometry(of: segment.index, in: id).map { geometry in
            geometry.lines.map { CGRect(x: $0.minX, y: $0.top, width: $0.maxX - $0.minX, height: $0.bottom - $0.top) }
        } ?? []
        row.lineBoxes[segment.index] = boxes
        return boxes
    }

    /// A text lit whole: each line from where it starts to the text's widest edge, and down to the next line, as
    /// `SegmentGeometry.rects` lights a selection that runs through it.
    static func wholeRects(boxes: [CGRect]) -> [CGRect] {
        guard let edge = boxes.map(\.maxX).max() else { return [] }
        return boxes.enumerated().map { index, box in
            let bottom = index + 1 < boxes.count ? max(box.maxY, boxes[index + 1].minY) : box.maxY
            return CGRect(x: box.minX, y: box.minY, width: max(edge - box.minX, 4), height: bottom - box.minY)
        }
    }

    /// Where row `id`'s text `segment` is, worked out from its layout the first time it is asked for.
    func geometry(of segment: Int, in id: String) -> SegmentGeometry? {
        guard let row = rows[id] else { return nil }
        if let known = row.geometries[segment] { return known }
        guard let registered = row.segments.first(where: { $0.index == segment }),
              let text = text(of: id)?.segments[selectionSafe: segment]?.text else { return nil }
        let geometry = registered.geometry(text)
        row.geometries[segment] = geometry
        return geometry
    }

    /// The row whose frame holds `point`.
    private func row(containing point: CGPoint) -> String? {
        rows.first { !$0.value.segments.isEmpty && $0.value.frame.contains(point) }?.key
    }

    /// The row nearest `point` up or down: where a drag between rows, or past the last, lands.
    private func nearestRow(to point: CGPoint) -> String? {
        var best: String?, distance = CGFloat.infinity
        for (id, row) in rows where !row.segments.isEmpty {
            let frame = row.frame
            let d = point.y < frame.minY ? frame.minY - point.y : (point.y > frame.maxY ? point.y - frame.maxY : 0)
            if d < distance || (d == distance && best.map { id < $0 } == true) { distance = d; best = id }
        }
        return best
    }

    /// The text in row `id` nearest `point` (in the stack's coordinates), and where in it.
    private func hit(at stackPoint: CGPoint, in id: String) -> Hit? {
        guard let row = rows[id] else { return nil }
        let point = CGPoint(x: stackPoint.x - row.frame.minX, y: stackPoint.y - row.frame.minY)
        var best: (segment: Int, geometry: SegmentGeometry)?
        var distance = CGFloat.infinity
        for segment in row.segments.sorted(by: { $0.index < $1.index }) {
            guard let geometry = geometry(of: segment.index, in: id), !geometry.lines.isEmpty else { continue }
            let bounds = geometry.bounds
            let dx = point.x < bounds.minX ? bounds.minX - point.x : (point.x > bounds.maxX ? point.x - bounds.maxX : 0)
            let dy = point.y < bounds.minY ? bounds.minY - point.y : (point.y > bounds.maxY ? point.y - bounds.maxY : 0)
            // Up and down counts for more than sideways: a press beside a short line is still on that line's row of text.
            let d = dy * 4 + dx
            if d < distance { distance = d; best = (segment.index, geometry) }
        }
        guard let best else { return nil }
        return Hit(segment: best.segment, caret: best.geometry.caret(at: point), character: best.geometry.character(at: point))
    }

    private func unit(at hit: Hit, row id: String, granularity: ConversationSelection.Granularity) -> SelectionSpan {
        func point(_ offset: Int) -> SelectionPoint { SelectionPoint(row: id, segment: hit.segment, offset: offset) }
        guard granularity != .character, let segment = text(of: id)?.segments[selectionSafe: hit.segment] else {
            return .caret(point(hit.caret))
        }
        let at = hit.character ?? max(hit.caret - 1, 0)
        let range = granularity == .word ? segment.wordRange(at: at) : segment.paragraphRange(at: at)
        return SelectionSpan(start: point(range.lowerBound), end: point(range.upperBound))
    }
}

private extension Array {
    subscript(selectionSafe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
