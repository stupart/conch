import CoreGraphics
import Foundation

// Infinite scroll for recorded history, as logic rather than as a view.
//
// Tyler: "Why do I keep seeing 'show all' or 'show more' in the convo on the Mac app and iPhone app —
// those should just smooth infinite scroll via a skillful implementation that doesn't blow up memory."
//
// So scrolling up reads the page before on its own, a long message is read whole as it comes into
// view, and only the rows near the viewport are real views. What can go wrong with that is mostly
// arithmetic — where the reader is, how far a change above them moves what they are reading, which
// rows to keep, when to ask for more — and it is all here, where `swift test` reaches it without a
// window. `HistoryRegion.swift` is the view and the scroll view around it.

// MARK: - When to read further back

public enum HistoryPrefetch {
    /// Screens of content left above the viewport when the page before is asked for: enough
    /// that a page read over a phone relay has usually landed before the reader gets there.
    public static let screens: CGFloat = 1.5

    /// Whether the reader is close enough to the top of what is held to ask for more.
    public static func shouldLoadOlder(contentAbove: CGFloat, viewport: CGFloat, screens: CGFloat = screens) -> Bool {
        guard viewport > 0 else { return false }
        return contentAbove < screens * viewport
    }
}

// MARK: - A read that failed, tried again

/// A failed read is tried again without a button: after a pause that doubles, and then only
/// when the reader scrolls back to the top. Every scroll tick near the top asks for the page
/// before, so without the pause a record store that is down would be asked sixty times a second.
public enum HistoryRetry {
    /// Tries the reader makes on its own before leaving the next one to the reader's scrolling.
    public static let attempts = 6

    /// How long to wait after `failures` reads have failed in a row: 1, 2, 4, 8, 16, then 30 s.
    /// Nil before any failure and once the tries are spent.
    public static func delay(afterFailures failures: Int) -> TimeInterval? {
        guard failures > 0, failures <= attempts else { return nil }
        return min(30, pow(2, Double(failures - 1)))
    }
}

// MARK: - What the top of the conversation says

/// The one line above the oldest message on screen.
///
/// It replaced a header that said four things with two buttons — "Load earlier messages",
/// "Retry" — and a phone that stopped at a thousand rows. Now the top says only what is true
/// of it: nothing while more is coming, a spinner only once a read is actually slow, "Start of
/// the conversation" at the true start, and the plain sentence where history genuinely is not
/// there. Never a button.
public struct HistoryEdge: Equatable, Sendable {
    public enum Mark: Equatable, Sendable {
        case none
        /// A read has taken longer than `slowAfter`.
        case loading
        /// Every message of the conversation is on screen.
        case start
    }

    public let mark: Mark
    /// Plain sentences, each said once, in order.
    public let notes: [String]

    public init(mark: Mark, notes: [String] = []) {
        self.mark = mark
        self.notes = notes
    }

    /// A read quicker than this shows nothing at all: a spinner that flashes for 80 ms is
    /// noise, and most pages arrive faster than that over the socket.
    public static let slowAfter: TimeInterval = 0.3

    /// What the top says.
    ///
    /// `liveIsWhole`: the live window holds the entire conversation (the daemon did not cut it,
    /// and it is not empty), so its first message is the start whatever the record says.
    /// `slow`: the read in flight has taken longer than `slowAfter`. `oldest` is the oldest
    /// recorded date, written out by the caller in the reader's own locale.
    public static func of(_ paging: HistoryPaging, liveIsWhole: Bool, slow: Bool, oldest: String? = nil) -> HistoryEdge {
        if liveIsWhole && paging.rows.isEmpty { return HistoryEdge(mark: .start) }
        if paging.status == .off { return HistoryEdge(mark: .none, notes: [HistoryNotice.off]) }

        var notes: [String] = []
        func say(_ note: String?) {
            if let note, !notes.contains(note) { notes.append(note) }
        }
        // Said while the reader tries again, so a retry does not blink the reason away.
        say(paging.lastFailure)
        say(HistoryNotice.coverage(
            paging.coverage,
            reachedStart: paging.reachedStart,
            oldest: oldest,
            sharedBranch: paging.sharedBranch
        ))
        // The record answered, holds nothing for this session, and the live window says there
        // was more: history that genuinely is not there.
        if paging.reachedStart && paging.rows.isEmpty && !liveIsWhole { say(HistoryNotice.unrecorded) }

        if paging.status == .loading { return HistoryEdge(mark: slow ? .loading : .none, notes: notes) }
        if paging.reachedStart && notes.isEmpty { return HistoryEdge(mark: .start) }
        return HistoryEdge(mark: .none, notes: notes)
    }
}

// MARK: - Heights, the reader's place, and which rows are real

/// The older history's geometry: every row's height, which rows are real views, and how far
/// the reader must be moved when something above them changes.
///
/// Rows far from the viewport are not views at all, only their height, so a session of twelve
/// thousand items lays out as a few dozen. For that to be invisible the heights must be exact:
/// a row is laid out at the height in this table, measured the first time it is drawn, and
/// every change to the table says how far it moved the row the reader is looking at. The view
/// moves the scroll position by exactly that, in the same layout pass, so nothing under the
/// eye ever moves — whether a page arrived above, a row above was measured for the first time,
/// or a released page kept its place.
public struct HistoryWindow: Equatable, Sendable {
    public struct Slot: Equatable, Sendable {
        public let id: String
        /// What to lay the row out at before it has been drawn. Nil for a row whose content is
        /// not held (a released page): it keeps the height it last had.
        public let estimate: CGFloat?

        public init(id: String, estimate: CGFloat?) {
            self.id = id
            self.estimate = estimate
        }
    }

    public private(set) var ids: [String] = []
    public private(set) var heights: [CGFloat] = []
    /// `tops[i]` is row i's top; `tops[count]` is the total.
    private var tops: [CGFloat] = [0]
    private var index: [String: Int] = [:]
    /// Heights rows were actually drawn at.
    private var measured: [String: CGFloat] = [:]
    /// The last height every row was laid out at, drawn or estimated — kept for rows that leave
    /// the list, so a released page or a closed fold comes back at the height it had.
    private var known: [String: CGFloat] = [:]
    /// The rows that are real views; everything else is a height.
    public private(set) var materialised: Range<Int> = 0..<0
    /// Where `materialised` is growing to, a few rows a turn (`growth`); nil once it is there.
    public private(set) var target: Range<Int>?
    /// The top of the viewport in this table's coordinates, as it will be once the shifts
    /// returned so far have been applied. Nil until a scroll view has reported one.
    public private(set) var readerTop: CGFloat?
    public private(set) var readerHeight: CGFloat?
    /// Screens above and below the viewport that are real views.
    public let overscan: CGFloat
    /// The most rows that are real views at once, however small they are. The visible rows
    /// always are, so a viewport taller than `cap` rows is never drawn blank.
    public let cap: Int
    /// Rows at the top that are furniture rather than content (the line that says where the
    /// history starts). A change above the reader's first content row is compensated; one of
    /// these never anchors.
    public let leading: Int
    /// Rows made real per turn beyond the visible ones. Building a row is its parse and its
    /// layout, 2–4 ms for a reply; re-centring after a screen of scrolling makes ten or so real
    /// at once, which is a 30 ms frame. A few a turn, nearest the reader first, keeps every
    /// frame short, and still outruns a fast fling: the set moves a screen before it is needed.
    public let growth: Int
    /// Before a row has any estimate or history at all.
    public static let fallbackHeight: CGFloat = 44

    public init(overscan: CGFloat = 2, cap: Int = 160, leading: Int = 1, growth: Int = 3) {
        self.overscan = overscan
        self.cap = cap
        self.leading = leading
        self.growth = growth
    }

    public var count: Int { ids.count }
    public var total: CGFloat { tops[ids.count] }
    public func top(of index: Int) -> CGFloat { tops[index] }
    /// The height of everything above the real rows: one spacer.
    public var above: CGFloat { tops[materialised.lowerBound] }
    /// The height of everything below them.
    public var below: CGFloat { total - tops[materialised.upperBound] }
    public func height(of id: String) -> CGFloat? { index[id].map { heights[$0] } }
    public func isMeasured(_ id: String) -> Bool { measured[id] != nil }

    /// Replace the rows. Returns how far to move the reader so that what they are looking at
    /// stays where it is: down by whatever arrived above them, up by whatever left.
    @discardableResult
    public mutating func set(_ slots: [Slot]) -> CGFloat {
        let newIDs = slots.map(\.id)
        let oldIDs = ids
        let wasMaterialised = Set(ids[materialised])
        if newIDs == oldIDs {
            // The same rows: only an estimate can have moved, and a drawn row ignores those.
            var shift: CGFloat = 0
            for (i, slot) in slots.enumerated() where measured[slot.id] == nil {
                if let estimate = slot.estimate, abs(estimate - heights[i]) >= 0.5 {
                    shift += resize(i, to: estimate)
                }
            }
            return shift
        }
        let oldTops = tops

        ids = newIDs
        heights = slots.map { measured[$0.id] ?? $0.estimate ?? known[$0.id] ?? Self.fallbackHeight }
        // First occurrence wins: the pager never sends a row twice, and a crash here would take
        // the whole transcript with it if it ever did.
        index = Dictionary(ids.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        tops = Self.prefixSums(heights)
        for (id, height) in zip(ids, heights) { known[id] = height }

        let shift = Self.shift(
            from: oldIDs, tops: oldTops, to: index, tops: tops, readerTop: readerTop, leading: leading
        )
        if let top = readerTop { readerTop = top + shift }

        // The same rows stay real where they still exist, so a page landing does not redraw the
        // screen; `reframe` then decides whether the reader's new place needs others.
        let kept = ids.indices.filter { wasMaterialised.contains(ids[$0]) }
        materialised = kept.isEmpty ? 0..<0 : kept.min()!..<(kept.max()! + 1)
        reframe(force: kept.isEmpty)
        return shift
    }

    /// A row was drawn at a height other than the one it was laid out at. Returns how far to
    /// move the reader: its whole growth if the row is above the one they are reading, else 0.
    @discardableResult
    public mutating func measure(_ id: String, height: CGFloat) -> CGFloat {
        measured[id] = height
        known[id] = height
        guard let i = index[id] else { return 0 }
        return resize(i, to: height)
    }

    /// Everything drawn was drawn at another width: keep the heights as estimates until each
    /// row is drawn again.
    public mutating func forgetMeasurements() {
        measured = [:]
    }

    /// The reader moved, or the viewport changed size. Returns whether a different set of rows
    /// should be real.
    @discardableResult
    public mutating func scrolled(top: CGFloat, height: CGFloat) -> Bool {
        readerTop = top
        readerHeight = height
        return reframe(force: false)
    }

    /// The rows that should be real for where the reader is now. Returns whether that changed.
    ///
    /// With some slack: the set only moves once the reader is within half the overscan of its
    /// edge, and then it re-centres on them, so scrolling changes it once every screen or so
    /// rather than on every tick — each change is a SwiftUI update.
    @discardableResult
    public mutating func reframe(force: Bool = false) -> Bool {
        let old = materialised
        guard !ids.isEmpty else {
            materialised = 0..<0
            target = nil
            return old != materialised
        }
        guard let top = readerTop, let height = readerHeight, height > 0 else {
            // No viewport yet: the end, which is where a conversation opens.
            materialised = max(0, ids.count - cap)..<ids.count
            target = nil
            return old != materialised
        }
        let visible = rows(from: top, to: top + height)
        var need = rows(from: top - overscan * height / 2, to: top + height + overscan * height / 2)
        if need.count > cap { need = visible }
        // And no more than a screen past the overscan: rows the reader has left are let go.
        let outer = rows(from: top - (overscan + 1) * height, to: top + height + (overscan + 1) * height)
        if !force, target == nil, !materialised.isEmpty,
           materialised.lowerBound <= need.lowerBound, materialised.upperBound >= need.upperBound,
           materialised.lowerBound >= outer.lowerBound, materialised.upperBound <= outer.upperBound,
           materialised.count <= max(cap, visible.count) {
            return false
        }
        var want = rows(from: top - overscan * height, to: top + height + overscan * height)
        if want.count > max(cap, visible.count) {
            // Grow from the visible rows outwards, one each side in turn, until the cap.
            var lo = visible.lowerBound, hi = visible.upperBound
            var room = max(cap - visible.count, 0)
            while room > 0, lo > want.lowerBound || hi < want.upperBound {
                if lo > want.lowerBound { lo -= 1; room -= 1 }
                if room > 0, hi < want.upperBound { hi += 1; room -= 1 }
            }
            want = lo..<hi
        }
        materialised = Self.grow(from: old, toward: want, visible: visible, by: growth)
        target = materialised == want ? nil : want
        return old != materialised
    }

    /// One turn's growth toward `want`: rows outside it go at once (letting go is cheap), the
    /// visible rows are always real, and then up to `count` more, nearest the visible rows first.
    static func grow(from current: Range<Int>, toward want: Range<Int>, visible: Range<Int>, by count: Int) -> Range<Int> {
        // What is already real and still wanted, joined to what must be real now.
        let kept = current.clamped(to: want)
        var lo = visible.isEmpty ? want.lowerBound : visible.lowerBound
        var hi = visible.isEmpty ? min(want.upperBound, want.lowerBound + 1) : visible.upperBound
        if !kept.isEmpty, kept.upperBound >= lo, kept.lowerBound <= hi {
            lo = min(lo, kept.lowerBound)
            hi = max(hi, kept.upperBound)
        }
        var room = count
        while room > 0, lo > want.lowerBound || hi < want.upperBound {
            if hi < want.upperBound { hi += 1; room -= 1 }
            if room > 0, lo > want.lowerBound { lo -= 1; room -= 1 }
        }
        return lo..<hi
    }

    /// The rows whose extent meets `[from, to)`.
    public func rows(from: CGFloat, to: CGFloat) -> Range<Int> {
        guard !ids.isEmpty else { return 0..<0 }
        // First row whose bottom is below `from`.
        let lower = Self.firstIndex(in: tops, count: ids.count, from: 0) { tops[$0 + 1] > from }
        // First row whose top is at or past `to`.
        let upper = Self.firstIndex(in: tops, count: ids.count, from: lower) { tops[$0] >= to }
        return lower..<max(lower, upper)
    }

    /// The row the reader's place is kept by: the first content row still showing at the top of
    /// the viewport. Nil when the reader is below every row, or there are none but furniture.
    public func anchor(readerTop: CGFloat) -> Int? {
        Self.anchor(tops: tops, count: ids.count, readerTop: readerTop, leading: leading)
    }

    // MARK: Arithmetic

    /// How far to move the reader when the rows change from one list to another.
    ///
    /// The reader's place is the first content row still showing at the top of the viewport.
    /// Where that row is now, less where it was, is the answer — which covers a page arriving
    /// above, rows above being measured, and rows leaving, all at once. If that row has gone,
    /// the next one that survived is used instead. Below every row (reading the live tail
    /// underneath), everything that changed is above the reader, so the whole difference.
    static func shift(
        from oldIDs: [String],
        tops oldTops: [CGFloat],
        to newIndex: [String: Int],
        tops newTops: [CGFloat],
        readerTop: CGFloat?,
        leading: Int
    ) -> CGFloat {
        let oldTotal = oldTops[oldIDs.count]
        let newTotal = newTops[newTops.count - 1]
        guard let readerTop,
              let first = anchor(tops: oldTops, count: oldIDs.count, readerTop: readerTop, leading: leading)
        else { return newTotal - oldTotal }
        for old in first..<oldIDs.count {
            if let new = newIndex[oldIDs[old]] { return newTops[new] - oldTops[old] }
        }
        // Nothing at or below the reader survived (the reader started again from nothing).
        // There is no row to hold on to, and moving them anywhere would be a guess.
        return 0
    }

    static func anchor(tops: [CGFloat], count: Int, readerTop: CGFloat, leading: Int) -> Int? {
        guard count > leading, readerTop < tops[count] else { return nil }
        let first = firstIndex(in: tops, count: count, from: leading) { tops[$0 + 1] > readerTop }
        return first < count ? first : nil
    }

    /// Resize row `i`, returning how far the reader must move for it.
    private mutating func resize(_ i: Int, to height: CGFloat) -> CGFloat {
        let delta = height - heights[i]
        guard abs(delta) >= 0.5 else { return 0 }
        var shift: CGFloat = 0
        if let top = readerTop {
            let first = anchor(readerTop: top)
            if first.map({ i < $0 }) ?? true { shift = delta }
        } else {
            shift = delta
        }
        heights[i] = height
        known[ids[i]] = height
        for j in (i + 1)...ids.count { tops[j] += delta }
        if let top = readerTop { readerTop = top + shift }
        return shift
    }

    static func prefixSums(_ heights: [CGFloat]) -> [CGFloat] {
        var tops = [CGFloat](repeating: 0, count: heights.count + 1)
        for (i, height) in heights.enumerated() { tops[i + 1] = tops[i] + height }
        return tops
    }

    /// The first index in `from..<count` for which `predicate` holds, given it is monotone; `count` if none.
    private static func firstIndex(in tops: [CGFloat], count: Int, from: Int, where predicate: (Int) -> Bool) -> Int {
        var lo = from, hi = count
        while lo < hi {
            let mid = (lo + hi) / 2
            if predicate(mid) { hi = mid } else { lo = mid + 1 }
        }
        return lo
    }
}

// MARK: - How tall a row will be before it is drawn

/// A row's height before it has been drawn once, from what the record says about it.
///
/// Only has to be close. A row is measured when it comes within `overscan` screens of the
/// viewport — well before it is seen — and the difference is absorbed where the reader cannot
/// see it. What matters is that a page of fifty rows arrives at roughly its real height, so the
/// scroll bar and the next prefetch are not wildly off in the meantime.
public struct HistoryEstimate: Equatable, Sendable {
    /// The reading font's average advance.
    public let characterWidth: CGFloat
    public let lineHeight: CGFloat
    /// A folded tool line.
    public let toolRow: CGFloat
    public let material: CGFloat
    /// Your turns sit in a bubble: its vertical padding, and the room it leaves at the side.
    public let bubbleInset: CGFloat
    public let bubbleIndent: CGFloat
    /// The space above every row but the first.
    public let gap: CGFloat

    public init(characterWidth: CGFloat, lineHeight: CGFloat, toolRow: CGFloat, material: CGFloat,
                bubbleInset: CGFloat, bubbleIndent: CGFloat, gap: CGFloat) {
        self.characterWidth = characterWidth
        self.lineHeight = lineHeight
        self.toolRow = toolRow
        self.material = material
        self.bubbleInset = bubbleInset
        self.bubbleIndent = bubbleIndent
        self.gap = gap
    }

    /// The Mac transcript: 15/23 reading type, 22 between messages (workspace-v1 §3).
    public static let mac = HistoryEstimate(
        characterWidth: 7.3, lineHeight: 23, toolRow: 16, material: 42,
        bubbleInset: 16, bubbleIndent: 72, gap: 22
    )
    /// The phone's: body text, 14 between rows.
    public static let phone = HistoryEstimate(
        characterWidth: 8.4, lineHeight: 22, toolRow: 20, material: 44,
        bubbleInset: 16, bubbleIndent: 64, gap: 14
    )

    /// A recorded item's height, gap included. `characters` is the whole body's length when
    /// the record says how long it is, not the preview's.
    public func height(kind: String, role: String?, characters: Int, width: CGFloat) -> CGFloat {
        let width = max(width, 120)
        func lines(_ characters: Int, in measure: CGFloat) -> CGFloat {
            let perLine = max(measure / characterWidth, 8)
            // A paragraph break every ~400 characters costs most of a line of its own.
            return max(1, (CGFloat(characters) / perLine).rounded(.up)) + CGFloat(characters / 400) * 0.6
        }
        switch kind {
        case "tool_call", "tool_result":
            return toolRow + gap
        case "material", "context", "compaction":
            return material + gap
        default:
            if role == "user" {
                return lines(characters, in: width - bubbleIndent) * lineHeight + bubbleInset + gap
            }
            return lines(characters, in: width) * lineHeight + gap
        }
    }
}

// MARK: - Which bodies to read

public enum HistoryDemand {
    /// How many bodies one reader reads at once. The daemon serves eight history reads in
    /// flight across every reader, and a page read must never queue behind a screenful of bodies.
    public static let concurrentBodies = 3

    /// Which recorded messages to read whole, nearest the middle of the viewport first.
    ///
    /// Only a message the 240-character preview cuts short: a tool row keeps its output behind
    /// its own disclosure, and anything already held or on its way is not asked for twice.
    public static func bodies(
        for rows: [HistoryItem],
        around center: Int,
        held: Set<String>,
        reading: Set<String>,
        limit: Int = concurrentBodies
    ) -> [String] {
        let room = limit - reading.count
        guard room > 0 else { return [] }
        return rows.enumerated()
            .filter { _, item in
                item.kind == "message" && item.hasFullBody && !held.contains(item.id) && !reading.contains(item.id)
            }
            .sorted { abs($0.offset - center) < abs($1.offset - center) }
            .prefix(room)
            .map(\.element.id)
    }
}

// MARK: - A cut message, whole

extension HistorySnapshot {
    /// The whole message behind a row the snapshot cut, from the record's body and the
    /// snapshot's own tail — or nil when the two cannot honestly be joined.
    ///
    /// The snapshot keeps the TAIL of a long message, behind a "…"; the record keeps the whole
    /// of it, but runs behind the transcript. For a message still being written the record's
    /// copy ends before the snapshot's does, and showing it alone would lose the newest part —
    /// the very part being streamed. So the record supplies the head, the snapshot the tail,
    /// joined where they overlap. With no overlap (the record is too far behind) there is no
    /// seam to join at, and the caller keeps showing the cut text until the record catches up.
    ///
    /// A cut tool result is not a tail — the daemon keeps its start and end — so the record's
    /// body replaces it outright, as it always has.
    public static func whole(record: String, cut: String) -> String? {
        guard cut.hasPrefix("…") else { return record }
        let tail = cut.dropFirst()
        guard !tail.isEmpty else { return record }
        if record.hasSuffix(tail) { return record }

        let r = Array(record.utf8)
        let t = Array(tail.utf8)
        // Enough overlap that a coincidence is not taken for the seam.
        let minimum = min(64, t.count)
        guard r.count >= minimum else { return nil }
        let joined: String? = r.withUnsafeBufferPointer { rb in
            t.withUnsafeBufferPointer { tb in
                // The record ends inside the tail: find where, longest overlap first.
                var p = max(0, r.count - t.count)
                while p <= r.count - minimum {
                    let overlap = r.count - p
                    if memcmp(rb.baseAddress! + p, tb.baseAddress!, overlap) == 0 {
                        return String(decoding: r + t[overlap...], as: UTF8.self)
                    }
                    p += 1
                }
                return nil
            }
        }
        if let joined { return joined }
        // The record has moved past the snapshot: it already holds the tail, and more.
        if record.contains(tail) { return record }
        return nil
    }
}
