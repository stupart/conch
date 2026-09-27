import Foundation

// The recorded-history reader, as logic rather than as a view.
//
// The daemon's snapshot carries a preview: the last few dozen items, messages cut
// at 4,000 characters, tool output at 400. That is the right thing to publish
// every quarter second and the wrong thing to read a session from. The record
// store (docs/records-paging.md) pages the whole session instead, oldest on
// demand, bodies on request.
//
// Everything a reader can get wrong about that is here, away from SwiftUI, so it
// can be tested without a window: which generation of a request an answer belongs
// to, what a stale epoch invalidates, where the reader was looking when older
// messages arrived, and what to say when the record is off or incomplete.

// MARK: - What the store returns

/// One recorded item, as `history.page` describes it: enough to draw a row, not its body.
public struct HistoryItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let role: String?
    /// The provider's own id for this item — a Claude message UUID, a Codex item id.
    /// It is what a live snapshot row can be matched against (`snapshotNativeId`).
    public let nativeId: String?
    public let toolName: String?
    public let at: Double?
    public let revision: Int
    /// At most 240 characters. The body is a separate read, made only when someone opens it.
    public let preview: String
    public let bodyBytes: Int

    public init(
        id: String,
        kind: String = "message",
        role: String? = nil,
        nativeId: String? = nil,
        toolName: String? = nil,
        at: Double? = nil,
        revision: Int = 1,
        preview: String = "",
        bodyBytes: Int = 0
    ) {
        self.id = id
        self.kind = kind
        self.role = role
        self.nativeId = nativeId
        self.toolName = toolName
        self.at = at
        self.revision = revision
        self.preview = preview
        self.bodyBytes = bodyBytes
    }

    /// Whether anything is behind the preview. A short item is already whole, and
    /// asking for its body would be a request that could only return what is shown.
    public var hasFullBody: Bool { bodyBytes > preview.utf8.count }
}

/// How much of a session actually reached the index.
public struct HistoryCoverage: Equatable, Sendable {
    public let sources: Int
    public let statuses: [String: Int]
    public let replayRequired: Bool
    public let indexedBytes: Int
    public let observedBytes: Int
    /// Which branch these items are: `"ancestry"` when the reader's tip was proven,
    /// `"all"` when every branch of the transcript was read.
    ///
    /// Nil from a daemon too old to say, which is not a claim either way — and so never
    /// the grounds for telling someone their history is somebody else's.
    public let branch: String?

    public init(
        sources: Int = 0,
        statuses: [String: Int] = [:],
        replayRequired: Bool = false,
        indexedBytes: Int = 0,
        observedBytes: Int = 0,
        branch: String? = nil
    ) {
        self.sources = sources
        self.statuses = statuses
        self.replayRequired = replayRequired
        self.indexedBytes = indexedBytes
        self.observedBytes = observedBytes
        self.branch = branch
    }

    /// Every source read to its end, and nothing waiting to be read again.
    public var isComplete: Bool {
        !replayRequired
            && indexedBytes >= observedBytes
            && statuses.allSatisfy { $0.key == "complete" || $0.value == 0 }
    }

    /// Work in progress rather than a gap: saying "not recorded" here would be wrong a second later.
    public var isIndexing: Bool {
        replayRequired || (statuses["queued"] ?? 0) + (statuses["indexing"] ?? 0) > 0
    }
}

/// One answered `history.page`.
public struct HistoryPage: Equatable, Sendable {
    public let items: [HistoryItem]
    public let previousCursor: String?
    public let epoch: String
    public let coverage: HistoryCoverage

    public init(items: [HistoryItem], previousCursor: String?, epoch: String, coverage: HistoryCoverage = HistoryCoverage()) {
        self.items = items
        self.previousCursor = previousCursor
        self.epoch = epoch
        self.coverage = coverage
    }
}

/// Why a read did not return what was asked for.
public enum HistoryFailure: Equatable, Sendable {
    /// The `records` setting is off. Not an error: nothing is being recorded, and it can be turned on.
    case off
    /// The cursor belonged to an index generation that no longer exists. Start again.
    case stale
    /// Anything else, in the daemon's own words.
    case message(String)
}

/// What the reader is doing, and what it should say while doing it.
public enum HistoryStatus: Equatable, Sendable {
    case idle
    case loading
    case off
    case failed(String)
}

// MARK: - Paging

/// One page as the record served it: the rows it holds, and the cursor that reads it again.
///
/// Kept after its rows are let go. The record pages backwards only, but every cursor it hands
/// out stays good for the life of its epoch (`docs/records-paging.md`: a traversal's insertion
/// fence keeps a page's slice fixed), so a page released to stay under the ceiling is one
/// request away from coming back — in either direction the reader scrolls.
public struct HistoryPageSlot: Equatable, Sendable, Identifiable {
    /// Numbered as pages arrive, so one being read again is still found after older pages
    /// have landed in front of it.
    public let id: Int
    /// The `before` it was read with. Nil for the newest page, which is never released:
    /// read again without a cursor it would be a different, newer slice.
    public let cursor: String?
    /// Its rows, in order. They outlive `items`, so a released page keeps its place.
    public fileprivate(set) var ids: [String]
    /// Nil once released.
    public fileprivate(set) var items: [HistoryItem]?

    public var isReleased: Bool { items == nil }
}

/// One row of recorded history in display order: an item, or the place a released one keeps.
public struct HistoryRow: Equatable, Sendable, Identifiable {
    public let id: String
    /// Nil while its page is released. The view draws the row's last known height instead.
    public let item: HistoryItem?
    /// The page it belongs to, to read it again by.
    public let page: Int
}

/// The transcript's reader: which items it holds, where it can go back to, and which answers it will still accept.
///
/// Answers are tagged with a generation. Selecting another session, and any restart
/// forced by a stale epoch, moves the generation on — so a page that was already in
/// flight lands in a reader that will not take it, rather than mixing one session's
/// or one epoch's items into another's.
public struct HistoryPaging: Equatable, Sendable {
    public private(set) var session: String
    public private(set) var epoch: String?
    /// Every item held, in display order. A released page's items are not among them.
    public private(set) var items: [HistoryItem]
    /// Every row, held or released, in display order: what the transcript lays out.
    public private(set) var rows: [HistoryRow]
    /// Every page read so far, oldest first.
    public private(set) var pages: [HistoryPageSlot]
    public private(set) var previousCursor: String?
    public private(set) var coverage: HistoryCoverage?
    public private(set) var status: HistoryStatus
    /// The item the reader was looking at when the last load began: what the view puts
    /// back under the eye once older messages have been added above it.
    public private(set) var anchor: String?
    public private(set) var generation: Int
    /// The tip of THIS window's branch, sent with every page so the record answers with
    /// one window's history rather than both (A8, #170).
    ///
    /// Captured when the session is selected and never again — see `select`.
    public private(set) var branchTip: String?
    /// The most recorded items this reader will hold at once, or nil for no ceiling.
    ///
    /// A ceiling on what is HELD, not on how far back the reader can go. It used to be the
    /// phone's stopping point — "That's as far back as this phone will hold" — because a
    /// released page could not be read again. It can: every page keeps the cursor it was read
    /// with. So past the ceiling the pages farthest from the reader are let go, their rows keep
    /// their place and height, and whichever of them the reader scrolls back to is read again.
    public private(set) var itemCap: Int?
    /// When the oldest page read so far begins, kept once that page is released.
    public private(set) var oldestAt: Double?
    /// Why the last read failed, until one succeeds. Said at the top while the reader tries again.
    public private(set) var lastFailure: String?
    /// Reads failed in a row: how long to wait before the next (`HistoryRetry`).
    public private(set) var failures: Int
    /// Released pages being read again.
    public private(set) var rereading: Set<Int>
    /// The page the reader is looking at: what the ceiling releases farthest from.
    public private(set) var focusPage: Int?
    private var nextPage: Int
    /// The cursor the load in flight was asked with: the new page's own `cursor`.
    private var loadingCursor: String?

    public init(session: String = "", itemCap: Int? = nil) {
        self.session = session
        self.itemCap = itemCap
        epoch = nil
        items = []
        rows = []
        pages = []
        previousCursor = nil
        coverage = nil
        status = .idle
        anchor = nil
        generation = 0
        branchTip = nil
        oldestAt = nil
        lastFailure = nil
        failures = 0
        rereading = []
        focusPage = nil
        nextPage = 0
        loadingCursor = nil
    }

    /// Older messages exist and can be asked for. The first load is the one with no cursor yet.
    ///
    /// The ceiling is not in this: holding as much as it will, the reader releases the pages
    /// farthest from where it is looking and keeps going.
    public var canLoadOlder: Bool {
        guard status != .loading, status != .off else { return false }
        return epoch == nil || previousCursor != nil
    }

    /// The whole session is on screen: the store has been read back to its first item.
    public var reachedStart: Bool { epoch != nil && previousCursor == nil }

    /// Whether anything belongs above the live window: recorded messages, or the one
    /// honest sentence about why there are none.
    ///
    /// It is the view's gate, and it lives here because getting it wrong is invisible:
    /// recorded history is drawn INSIDE the conversation stack, so a phone that drew
    /// the stack only when the daemon's snapshot had items showed a session with an
    /// empty live window and a full record as nothing at all — no messages, no state
    /// line.
    ///
    /// `.off` is deliberately not something to show. Nothing is being recorded, so
    /// there is nothing above the window, and whatever the app already draws for a
    /// session with no messages says that better than an empty stack would. Neither is
    /// a record that answered and does not hold this session: same screen, same reason.
    public var hasAnythingToShow: Bool {
        guard status != .off else { return false }
        return !rows.isEmpty || status != .idle || canLoadOlder
    }

    /// A different session is a different reader. Nothing in flight for the old one may land here.
    ///
    /// `branchTip` is captured HERE and nowhere else: the newest row of the live pane at
    /// the moment this session was selected. That pane is already this window's branch —
    /// the daemon picked it from the transcript's own signals — so its newest message is
    /// a tip the record can walk the ancestry above.
    ///
    /// Once, because a tip that moved would be a different ancestry under an open cursor:
    /// the store would answer `stale-cursor`, and the transcript someone is scrolling
    /// would empty and start again every time the session said something.
    public mutating func select(session: String, branchTip: String? = nil) {
        guard session != self.session else { return }
        let next = HistoryPaging(session: session, itemCap: itemCap)
        let generation = self.generation + 1
        self = next
        self.generation = generation
        self.branchTip = branchTip
    }

    /// Every branch of a shared transcript is what is above the live conversation: this
    /// reader asked for its own and the record could not prove which that is.
    ///
    /// Three things have to be true, and the third is why this is not noise. The record
    /// is always a little behind the pane — the tip can be a message the indexer has not
    /// reached yet — so an unproven tip is ordinary and momentary, and on a session with
    /// ONE window every branch is that window's anyway. Only a session conch is keying
    /// per window has another window's messages to show by mistake, and the daemon says
    /// which those are in the id itself: `<session>#<pid>` while an id is shared, the
    /// plain id when it is not (`src/window-key.ts`).
    ///
    /// A missing tip is not a failed proof either — it is a reader that never claimed a
    /// branch (a Codex session, or one with no live pane to take a tip from), and those
    /// read exactly as they always have.
    public var sharedBranch: Bool {
        branchTip != nil && coverage?.branch == "all" && session.contains("#")
    }

    /// Begin a load, remembering where the reader is looking. The returned generation tags the request.
    @discardableResult
    public mutating func beginLoad(anchor: String? = nil) -> Int {
        self.anchor = anchor ?? self.anchor
        status = .loading
        loadingCursor = epoch == nil ? nil : previousCursor
        return generation
    }

    /// Take a page, if it still belongs to this reader.
    public mutating func apply(page: HistoryPage, generation: Int) {
        guard generation == self.generation else { return }
        // A page from another index generation cannot be joined to what is on screen:
        // the ordering and the item ids behind it may both have moved. Start again.
        guard epoch == nil || page.epoch == epoch else {
            restart()
            return
        }
        let fresh = absorb(page.items)
        pages.insert(
            HistoryPageSlot(id: nextPage, cursor: epoch == nil ? nil : loadingCursor, ids: fresh.map(\.id), items: fresh),
            at: 0
        )
        nextPage += 1
        if let at = fresh.first?.at { oldestAt = at }
        epoch = page.epoch
        previousCursor = page.previousCursor
        coverage = page.coverage
        status = .idle
        succeeded()
        releaseOverCeiling()
        rebuild()
    }

    /// Take a failure, if it still belongs to this reader.
    public mutating func apply(failure: HistoryFailure, generation: Int) {
        guard generation == self.generation else { return }
        switch failure {
        case .off:
            // Not a failure to retry: there is nothing recorded to read.
            epoch = nil
            previousCursor = nil
            coverage = nil
            pages = []
            rereading = []
            oldestAt = nil
            succeeded()
            status = .off
            rebuild()
        case .stale:
            restart()
        case let .message(text):
            // What is already on screen stays there. Losing a read is not a reason
            // to lose the messages the reader was in the middle of.
            status = .failed(text)
            lastFailure = text
            failures += 1
        }
    }

    /// Drop everything bound to the old index generation, keep the anchor and the tip,
    /// and refuse what is in flight. The epoch moved; which window this is did not.
    public mutating func restart() {
        epoch = nil
        previousCursor = nil
        coverage = nil
        status = .idle
        pages = []
        rereading = []
        focusPage = nil
        oldestAt = nil
        generation += 1
        rebuild()
    }

    // MARK: Released pages, read again

    /// The released pages holding any of these rows: what the reader has scrolled back to.
    public func releasedPages(holding ids: Set<String>) -> [Int] {
        pages.filter { $0.isReleased && !rereading.contains($0.id) && $0.ids.contains(where: ids.contains) }.map(\.id)
    }

    /// Begin reading a released page again, with the cursor it was first read with.
    public mutating func beginReread(page id: Int) -> (cursor: String, generation: Int)? {
        guard let slot = pages.first(where: { $0.id == id }), slot.isReleased,
              let cursor = slot.cursor, !rereading.contains(id) else { return nil }
        rereading.insert(id)
        return (cursor, generation)
    }

    /// A released page, read again. Its rows are what they were — the cursor's fence keeps
    /// the slice fixed — so they fill the places they kept; a revision can still have moved.
    public mutating func apply(reread page: HistoryPage, page id: Int, generation: Int) {
        guard generation == self.generation else { return }
        rereading.remove(id)
        guard page.epoch == epoch else {
            restart()
            return
        }
        guard let released = pages.firstIndex(where: { $0.id == id }), pages[released].isReleased else { return }
        // Held (and empty) while the page is absorbed, so it is not deduplicated against itself.
        pages[released].items = []
        let fresh = absorb(page.items)
        guard let index = pages.firstIndex(where: { $0.id == id }) else { return }
        pages[index].items = fresh
        pages[index].ids = fresh.map(\.id)
        releaseOverCeiling()
        rebuild()
    }

    /// A released page that would not come back. It stays released, and is asked for again
    /// the next time the reader needs it; a stale cursor starts the reader again.
    public mutating func apply(rereadFailure failure: HistoryFailure, page id: Int, generation: Int) {
        guard generation == self.generation else { return }
        rereading.remove(id)
        if failure == .stale { restart() }
    }

    /// The page a row belongs to.
    public func page(of id: String?) -> Int? {
        id.flatMap { id in rows.first { $0.id == id }?.page }
    }

    /// Where the reader is looking: the ceiling releases farthest from here.
    public mutating func focus(on id: String?) {
        let page = page(of: id)
        guard page != focusPage else { return }
        focusPage = page
        if releaseOverCeiling() { rebuild() }
    }

    // MARK: Bookkeeping

    /// A new page's items, less any already held: the held copy moves to the page's
    /// position and keeps the newer revision, as `merge(older:into:)` always has.
    private mutating func absorb(_ incoming: [HistoryItem]) -> [HistoryItem] {
        guard !pages.isEmpty else { return incoming }
        var incomingIDs: [String: Int] = [:]
        var fresh = incoming
        for (index, item) in incoming.enumerated() { incomingIDs[item.id] = index }
        for p in pages.indices {
            guard let held = pages[p].items, held.contains(where: { incomingIDs[$0.id] != nil }) else {
                if pages[p].items == nil { pages[p].ids.removeAll { incomingIDs[$0] != nil } }
                continue
            }
            for item in held {
                if let index = incomingIDs[item.id], item.revision > fresh[index].revision { fresh[index] = item }
            }
            pages[p].items = held.filter { incomingIDs[$0.id] == nil }
            pages[p].ids = pages[p].items!.map(\.id)
        }
        pages.removeAll { $0.ids.isEmpty && $0.cursor != nil }
        return fresh
    }

    private mutating func succeeded() {
        lastFailure = nil
        failures = 0
    }

    /// Let go of the pages farthest from the reader until what is held fits under the ceiling.
    ///
    /// Never the newest two pages: they meet the live window, and the newest cannot be read
    /// again without becoming a different slice. Never the page being looked at, or one either
    /// side of it. Of what is left, the farthest goes first, and between two as far the older.
    @discardableResult
    private mutating func releaseOverCeiling() -> Bool {
        guard let itemCap else { return false }
        var held = pages.reduce(0) { $0 + ($1.items?.count ?? 0) }
        guard held > itemCap else { return false }
        let focus = focusPage.flatMap { id in pages.firstIndex { $0.id == id } } ?? (pages.count - 1)
        var released = false
        while held > itemCap {
            let candidates = pages.indices.filter { index in
                !pages[index].isReleased && pages[index].cursor != nil
                    && index < pages.count - 2 && abs(index - focus) > 1
                    && !rereading.contains(pages[index].id)
            }
            guard let farthest = candidates.max(by: { abs($0 - focus) < abs($1 - focus) || (abs($0 - focus) == abs($1 - focus) && $0 > $1) })
            else { break }
            held -= pages[farthest].items?.count ?? 0
            pages[farthest].items = nil
            released = true
        }
        return released
    }

    private mutating func rebuild() {
        var items: [HistoryItem] = []
        var rows: [HistoryRow] = []
        for page in pages {
            if let held = page.items {
                items.append(contentsOf: held)
                rows.append(contentsOf: held.map { HistoryRow(id: $0.id, item: $0, page: page.id) })
            } else {
                rows.append(contentsOf: page.ids.map { HistoryRow(id: $0, item: nil, page: page.id) })
            }
        }
        self.items = items
        self.rows = rows
    }

    /// Older items in front of what is already held, with any item the store has
    /// since revised kept at its newest revision.
    public static func merge(older page: [HistoryItem], into existing: [HistoryItem]) -> [HistoryItem] {
        guard !page.isEmpty else { return existing }
        var byId: [String: Int] = [:]
        var merged = page
        for (index, item) in page.enumerated() { byId[item.id] = index }
        for item in existing {
            guard let index = byId[item.id] else {
                merged.append(item)
                continue
            }
            if item.revision > merged[index].revision { merged[index] = item }
        }
        return merged
    }
}

// MARK: - Bodies

/// One item's body, read in chunks.
///
/// A body can be revised under the reader — a tool result arriving, a message edited.
/// Chunks from two revisions concatenated would be a body that never existed, so a
/// changed revision throws away what was collected and starts the read again.
public struct HistoryBody: Equatable, Sendable {
    public private(set) var text: String
    public private(set) var cursor: String?
    public private(set) var revision: Int?
    public private(set) var status: HistoryStatus
    /// Structured bodies are only JSON once every chunk is in hand.
    public private(set) var encoding: String

    public init() {
        text = ""
        cursor = nil
        revision = nil
        status = .idle
        encoding = "text"
    }

    /// Read to its end: nothing more to ask for, and nothing failed on the way.
    public var isComplete: Bool { revision != nil && cursor == nil && status == .idle }

    public mutating func begin() {
        status = .loading
    }

    public mutating func apply(chunk: String, revision: Int, next: String?, encoding: String = "text") {
        if let held = self.revision, held != revision {
            text = ""
        }
        self.revision = revision
        self.encoding = encoding
        text += chunk
        cursor = next
        status = .idle
    }

    public mutating func apply(failure: HistoryFailure) {
        switch failure {
        case .off:
            status = .off
        case .stale:
            // The body moved. Everything collected describes the old one.
            text = ""
            cursor = nil
            revision = nil
            status = .idle
        case let .message(message):
            status = .failed(message)
        }
    }
}

// MARK: - What the reader is told

public enum HistoryNotice {
    /// The record store is off. The only honest thing to show, with the one command that changes it.
    public static let off = "History isn't recorded for this session. Turn it on with: conch set records true"

    /// The top of a conversation whose every message is on screen: the record was read back to
    /// its first item, or the live window never lost one.
    public static let start = "Start of the conversation"

    /// The record answered and holds nothing for this session, while the live window says
    /// earlier messages exist. The same plain sentence a partly recorded session gets.
    public static let unrecorded = "Part of this session wasn't recorded."

    /// Everything above the live conversation belongs to more than one window, because
    /// the record could not prove which branch is this one's.
    ///
    /// The pane says this about ITSELF when the daemon cannot choose; this says it about
    /// the messages above it, which are chosen somewhere else and can be every branch
    /// while the pane is exactly one.
    public static let allBranches =
        "Earlier messages are from every branch of this transcript — conch couldn't tell which is this window's."

    /// What to say above the oldest message on screen, or nil when there is nothing worth saying.
    ///
    /// `oldest` is already written out by the caller: a date in the reader's own locale
    /// belongs to the view, and a note that reads differently in Tokyo is not a note a test can hold.
    ///
    /// Whose messages these are outranks how completely they were recorded: "still
    /// reading" is a sentence that stops being true a moment later, and "these may be
    /// another window's" does not.
    public static func coverage(
        _ coverage: HistoryCoverage?,
        reachedStart: Bool,
        oldest: String? = nil,
        sharedBranch: Bool = false
    ) -> String? {
        if sharedBranch { return allBranches }
        guard let coverage else { return nil }
        if coverage.isIndexing { return "Still reading this session's history — earlier messages may appear." }
        if coverage.isComplete { return nil }
        guard let oldest, !oldest.isEmpty else { return unrecorded }
        return reachedStart
            ? "Recorded back to \(oldest) — anything earlier wasn't recorded."
            : unrecorded
    }
}

// MARK: - Matching a live row to a recorded item

public enum HistorySnapshot {
    /// The provider id behind a live snapshot row's item id.
    ///
    /// The daemon decorates its snapshot ids — a thinking block and a material carry
    /// their message's UUID with a suffix, a tool row carries its call id behind
    /// `tool:` — while the record store keeps the provider's id bare in `nativeId`.
    /// Undecorating is what lets a capped row on screen find its recorded body.
    ///
    /// Codex messages are keyed by a hash of their own text rather than by a provider
    /// id, so they will not match; the caller keeps the snapshot's own text, which is
    /// honest, instead of showing another item's body.
    public static func nativeId(forSnapshotItem id: String) -> String {
        var value = id
        if value.hasPrefix("tool:") { value.removeFirst("tool:".count) }
        if value.hasSuffix(":thinking") { value.removeLast(":thinking".count) }
        if let range = value.range(of: ":material:", options: .backwards),
           value[range.upperBound...].allSatisfy(\.isNumber),
           !value[range.upperBound...].isEmpty {
            value = String(value[..<range.lowerBound])
        }
        return value
    }

    /// The tip of this window's branch: the newest live row carrying a provider message id.
    ///
    /// The pane is already one window's branch (A8) — and where the daemon could not
    /// tell which branch that is, it says `shared`, and neither can this: no tip, so
    /// history reads every branch, which is what the pane beneath it is showing anyway.
    ///
    /// Only a message UUID will do. A tool row is keyed by its CALL id, a Codex row by a
    /// hash of its own text, and a row from a record with no uuid by its position in the
    /// conversation. None of those names a message whose ancestry can be walked, and
    /// sending one would ask the store to prove something it cannot — which reads back
    /// as "this is every branch" on a session that has only ever had one.
    public static func branchTip(forSnapshotItems ids: [String], shared: Bool) -> String? {
        guard !shared else { return nil }
        for id in ids.reversed() {
            let native = nativeId(forSnapshotItem: id)
            if UUID(uuidString: native) != nil { return native }
        }
        return nil
    }

    /// Whether the snapshot cut this text to fit the wire.
    ///
    /// The daemon keeps the TAIL of a long message and marks the cut with a leading
    /// ellipsis; a tool result is cut at its cap with no mark at all, so length is the
    /// only evidence there is.
    public static func wasCut(_ text: String, cap: Int) -> Bool {
        text.hasPrefix("…") || text.count >= cap
    }
}

extension HistorySnapshot {
    /// The recorded items that come BEFORE what the live snapshot is already showing.
    ///
    /// The two overlap by design: the record holds the whole session and the snapshot
    /// holds its newest items. Drawing both would double the end of the conversation,
    /// so the recorded rows stop where the live ones start — by id where the provider
    /// numbers its messages, and by time where it does not (Codex keys a snapshot row
    /// by a hash of its own text, which no recorded id can equal).
    public static func older(
        _ items: [HistoryItem],
        thanSnapshot ids: Set<String>,
        startingAt oldest: Double? = nil
    ) -> [HistoryItem] {
        Array(items.prefix { candidate in
            if ids.contains(candidate.nativeId ?? candidate.id) { return false }
            if let oldest, let at = candidate.at, at >= oldest { return false }
            return true
        })
    }
}

extension HistorySnapshot {
    /// The same seam over rows, some of whose pages may be released.
    ///
    /// A released row is always older than the live window: the two newest pages, where the
    /// record meets the snapshot, are never released (`HistoryPaging`).
    public static func older(
        rows: [HistoryRow],
        thanSnapshot ids: Set<String>,
        startingAt oldest: Double? = nil
    ) -> [HistoryRow] {
        Array(rows.prefix { row in
            guard let candidate = row.item else { return true }
            if ids.contains(candidate.nativeId ?? candidate.id) { return false }
            if let oldest, let at = candidate.at, at >= oldest { return false }
            return true
        })
    }
}

// MARK: - What a phone will hold

/// The other half of each reader's memory ceiling: message bodies.
///
/// `HistoryPaging` bounds the ROWS, whose previews are 240 characters each. A
/// body is unbounded — a tool result can be megabytes — and now that a long
/// message is read whole as it scrolls into view rather than when someone asks,
/// a reader that scrolls a long session reads a great many of them. Releasing one
/// costs a request, not a message: it is read again when its row comes back.
public enum HistoryBudget {
    /// What one phone holds in bodies at a time.
    public static let phoneBodyBytes = 2 * 1024 * 1024
    /// What one Mac reader holds. Larger, not unbounded: the Mac reads the same twelve
    /// thousand item sessions the phone does, and holds two readers.
    public static let macBodyBytes = 16 * 1024 * 1024

    /// Which bodies to let go of, least recently read first, until what is kept fits.
    ///
    /// The most recently read is never released: it is the one being looked at, and
    /// releasing it would empty the row that asked for it. One body larger than the
    /// whole budget is therefore kept. Neither is any body in `pinned` — the rows drawn
    /// right now, which would shrink under the reader's eye.
    public static func release(
        _ sizes: [(id: String, bytes: Int)],
        keepingUnder limit: Int,
        pinned: Set<String> = []
    ) -> [String] {
        var total = sizes.reduce(0) { $0 + $1.bytes }
        var released: [String] = []
        for entry in sizes.dropLast() where total > limit && !pinned.contains(entry.id) {
            released.append(entry.id)
            total -= entry.bytes
        }
        return released
    }
}
