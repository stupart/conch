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

/// The transcript's reader: which items it holds, where it can go back to, and which answers it will still accept.
///
/// Answers are tagged with a generation. Selecting another session, and any restart
/// forced by a stale epoch, moves the generation on — so a page that was already in
/// flight lands in a reader that will not take it, rather than mixing one session's
/// or one epoch's items into another's.
public struct HistoryPaging: Equatable, Sendable {
    public private(set) var session: String
    public private(set) var epoch: String?
    public private(set) var items: [HistoryItem]
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
    /// The most recorded items this reader will hold, or nil for no ceiling.
    ///
    /// The Mac has no ceiling: it lays out a whole session and has the memory to.
    /// A phone does not — the largest session in this record store is twelve
    /// thousand items, and every page held is laid out as well as retained. So the
    /// phone stops asking rather than dropping: the store pages BACKWARDS only
    /// (`docs/records-paging.md` has no forward cursor), so anything released to
    /// make room could not be fetched again when the reader scrolled back down,
    /// and a transcript with a hole torn in the middle of it is worse than one
    /// that says plainly where it stops.
    public private(set) var itemCap: Int?

    public init(session: String = "", itemCap: Int? = nil) {
        self.session = session
        self.itemCap = itemCap
        epoch = nil
        items = []
        previousCursor = nil
        coverage = nil
        status = .idle
        anchor = nil
        generation = 0
        branchTip = nil
    }

    /// Holding as much as this reader will. Not the same as having reached the start:
    /// the record goes further back, and the Mac can read it.
    public var isAtCap: Bool {
        guard let itemCap else { return false }
        return items.count >= itemCap
    }

    /// Older messages exist and can be asked for. The first load is the one with no cursor yet.
    public var canLoadOlder: Bool {
        guard status != .loading, status != .off, !isAtCap else { return false }
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
    /// empty live window and a full record as nothing at all — no messages, no "Load
    /// earlier messages", no state line.
    ///
    /// `.off` is deliberately not something to show. Nothing is being recorded, so
    /// there is nothing above the window, and whatever the app already draws for a
    /// session with no messages says that better than an empty stack would. Neither is
    /// a record that answered and does not hold this session: same screen, same reason.
    public var hasAnythingToShow: Bool {
        guard status != .off else { return false }
        return !items.isEmpty || status != .idle || canLoadOlder
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
        items = epoch == nil ? page.items : Self.merge(older: page.items, into: items)
        epoch = page.epoch
        previousCursor = page.previousCursor
        coverage = page.coverage
        status = .idle
    }

    /// Take a failure, if it still belongs to this reader.
    public mutating func apply(failure: HistoryFailure, generation: Int) {
        guard generation == self.generation else { return }
        switch failure {
        case .off:
            // Not a failure to retry: there is nothing recorded to read.
            items = []
            epoch = nil
            previousCursor = nil
            coverage = nil
            status = .off
        case .stale:
            restart()
        case let .message(text):
            // What is already on screen stays there. Losing a read is not a reason
            // to lose the messages the reader was in the middle of.
            status = .failed(text)
        }
    }

    /// Drop everything bound to the old index generation, keep the anchor and the tip,
    /// and refuse what is in flight. The epoch moved; which window this is did not.
    public mutating func restart() {
        items = []
        epoch = nil
        previousCursor = nil
        coverage = nil
        status = .idle
        generation += 1
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

    /// The phone is holding as much of this session as it will. The record goes
    /// further back, and the machine with the memory to read it is named.
    public static let cap = "That's as far back as this phone will hold — the rest of this session is on your Mac."

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
        guard let oldest, !oldest.isEmpty else { return "Part of this session wasn't recorded." }
        return reachedStart
            ? "Recorded back to \(oldest) — anything earlier wasn't recorded."
            : "Part of this session wasn't recorded."
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

// MARK: - What a phone will hold

/// The other half of the phone's memory ceiling: opened message bodies.
///
/// `HistoryPaging` bounds the ROWS, whose previews are 240 characters each. A
/// body is unbounded — a tool result can be megabytes — so a reader who opens
/// twenty of them has retained something no row count describes. Releasing one
/// costs a request, not a message: it is read again on demand.
public enum HistoryBudget {
    /// What one phone holds in opened bodies at a time.
    public static let phoneBodyBytes = 2 * 1024 * 1024

    /// Which bodies to let go of, least recently read first, until what is kept fits.
    ///
    /// The most recently read is never released: it is the one being looked at, and
    /// releasing it would empty the row that asked for it. One body larger than the
    /// whole budget is therefore kept.
    public static func release(_ sizes: [(id: String, bytes: Int)], keepingUnder limit: Int) -> [String] {
        var total = sizes.reduce(0) { $0 + $1.bytes }
        var released: [String] = []
        for entry in sizes.dropLast() where total > limit {
            released.append(entry.id)
            total -= entry.bytes
        }
        return released
    }
}
