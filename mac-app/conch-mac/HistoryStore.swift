import ConchDesign
import Combine
import Foundation

// The app's reader for recorded history (docs/records-paging.md).
//
// The published snapshot is a preview and always will be: the newest items, messages
// cut at 4,000 characters, tool output at 400. It is what the daemon can afford to
// write four times a second. Everything older, and everything cut, is read from the
// record store over the same control socket the rest of the app already uses.
//
// The decisions worth getting wrong live in ConchDesign's `HistoryPaging` and
// `HistoryBody`, where they can be tested without a window. This file is the socket
// and the task bookkeeping around them.

// MARK: - Wire

/// Optional fields are OMITTED, never sent as null. The daemon validates a history
/// request by its key set, so `before: null` is an invalid request rather than "no
/// cursor" — and the difference between those two is a whole transcript.
struct ConchHistoryPageRequest: Encodable, Sendable {
    let session: String
    /// The tip of this window's branch: which of a shared transcript's conversations
    /// this reader is reading (A8). Omitted when nothing proves one, and the record
    /// then answers with every branch and says that is what it did.
    var branch: String?
    var before: String?
    var limit: Int?

    private enum CodingKeys: String, CodingKey { case kind, session, branch, before, limit }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("history-page", forKey: .kind)
        try container.encode(session, forKey: .session)
        try container.encodeIfPresent(branch, forKey: .branch)
        try container.encodeIfPresent(before, forKey: .before)
        try container.encodeIfPresent(limit, forKey: .limit)
    }
}

struct ConchHistoryItemRequest: Encodable, Sendable {
    let session: String
    let item: String
    var bodyCursor: String?

    private enum CodingKeys: String, CodingKey { case kind, session, item, bodyCursor }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("history-item", forKey: .kind)
        try container.encode(session, forKey: .session)
        try container.encode(item, forKey: .item)
        try container.encodeIfPresent(bodyCursor, forKey: .bodyCursor)
    }
}

/// Every history answer, flat. One shape decodes a page, a body chunk, the off reply
/// and an error, because the only field guaranteed across them is `kind`.
struct ConchHistoryReply: Decodable, Sendable {
    struct Item: Decodable, Sendable {
        let id: String
        let kind: String?
        let role: String?
        let nativeId: String?
        let toolName: String?
        let at: Double?
        let revision: Int?
        let preview: String?
        let bodyBytes: Int?
    }

    struct Coverage: Decodable, Sendable {
        let sources: Int?
        let statuses: [String: Int]?
        let replayRequired: Bool?
        let indexedBytes: Int?
        let observedBytes: Int?
        /// "ancestry" when this window's branch was proven, "all" when every branch was
        /// read. Absent from a daemon too old to say.
        let branch: String?
    }

    let kind: String
    let items: [Item]?
    let previousCursor: String?
    let epoch: String?
    let coverage: Coverage?
    let content: String?
    let nextBodyCursor: String?
    let revision: Int?
    let encoding: String?
    let code: String?
    let error: String?

    /// The page, when this is one.
    var page: HistoryPage? {
        guard kind == "history-page", let items, let epoch else { return nil }
        return HistoryPage(
            items: items.map {
                HistoryItem(
                    id: $0.id,
                    kind: $0.kind ?? "message",
                    role: $0.role,
                    nativeId: $0.nativeId,
                    toolName: $0.toolName,
                    at: $0.at,
                    revision: $0.revision ?? 1,
                    preview: $0.preview ?? "",
                    bodyBytes: $0.bodyBytes ?? 0
                )
            },
            previousCursor: previousCursor,
            epoch: epoch,
            coverage: HistoryCoverage(
                sources: coverage?.sources ?? 0,
                statuses: coverage?.statuses ?? [:],
                replayRequired: coverage?.replayRequired ?? false,
                indexedBytes: coverage?.indexedBytes ?? 0,
                observedBytes: coverage?.observedBytes ?? 0,
                branch: coverage?.branch
            )
        )
    }

    /// Why there is no page or body, in words a reader can act on.
    var failure: HistoryFailure? {
        if kind == "history-off" { return .off }
        guard kind == "history-error" else { return nil }
        switch code {
        // Everything the store binds to an index generation: the answer is the same
        // for all of them, which is to read again from the newest page.
        case "stale-cursor", "invalid-cursor", "stale-item":
            return .stale
        case "busy":
            return .message("conch's record store is busy.")
        case "unavailable":
            return .message("conch's record store isn't running.")
        case "session-not-found", "ambiguous-session":
            return .message("This session isn't in the record.")
        default:
            return .message(error ?? "History couldn't be read.")
        }
    }
}

// MARK: - Store

/// One transcript's reader. The dashboard and the overlay each hold their own,
/// because they show different sessions and neither may answer with the other's.
@MainActor
final class HistoryStore: ObservableObject {
    @Published private(set) var paging = HistoryPaging(itemCap: HistoryStore.itemCap)
    /// Bodies being read, by RECORD item id.
    @Published private(set) var bodies: [String: HistoryBody] = [:]
    /// Complete bodies by PROVIDER id: what a cut live row shows once it is opened.
    @Published private(set) var fullBodies: [String: String] = [:]
    /// The transcript's older rows as laid out: which are real views, their heights, and the
    /// scroll view they sit in. Held here, with the reader, and not published: the stack drawing
    /// the conversation is not redrawn every time a row is measured.
    let region = HistoryRegionModel(overscan: 2, cap: 160)

    /// The API's own default. A page is about 28 KiB, so this is one socket read.
    static let pageLimit = 50
    /// How many recorded items this reader holds at once. The Mac read a whole session and held
    /// all of it; the largest in this record store is twelve thousand items. Past this the pages
    /// farthest from the reader are released and read again if they scroll back (`HistoryPaging`).
    static let itemCap = 4_000
    /// A history read is a SQLite query behind a worker, not an agent: slow means broken.
    private static let timeout: TimeInterval = 5

    private let client: ConchSocketClient
    private var pageTask: Task<Void, Never>?
    private var bodyTasks: [String: Task<Void, Never>] = [:]
    private var rereadTasks: [Int: Task<Void, Never>] = [:]
    /// Live rows waiting for their complete body, by provider id, and the record item each is
    /// read by: named by a held page, or looked for where none names it (`HistoryWanted`).
    private var wanted = HistoryWanted()
    /// The look for a live row no held page names, while it is in flight.
    private var findTask: Task<Void, Never>?
    /// Recorded messages near the viewport that are longer than their preview, nearest the
    /// middle of the viewport first: what is read whole next.
    private var wantedRecorded: [HistoryItem] = []
    private var wantedCenter = 0
    /// The rows that are real views now, in order: their bodies are never released under them.
    private var shown: Set<String> = []
    private var shownOrder: [String] = []
    private var shownCenter: String?
    /// Record item ids whose bodies are held, least recently read first.
    private var bodyOrder: [String] = []
    /// The provider id each held body answers for, so releasing one releases both copies.
    private var bodyNative: [String: String] = [:]
    /// No read before this: the pause after a failure (`HistoryRetry`).
    private var retryNotBefore: Date?
    private var retryTask: Task<Void, Never>?
    /// Every other read that failed — a body, a released page, a look — paused on its own
    /// (`HistoryBackoff`); and the one timer that asks again when the soonest pause ends.
    private var backoff = HistoryBackoff()
    private var wakeTask: Task<Void, Never>?
    private var wakeAt: Date?
    /// When each live row's body was last asked for, by provider id.
    private var readAt: [String: Date] = [:]
    /// Live rows the record is behind on: how many times each was read again for which cut.
    private var behind: [String: (cut: String, tries: Int)] = [:]
    /// The live window's cut rows as last given, so a pause ending can look at them again.
    private var liveCut: [(id: String, cut: String)] = []

    init(client: ConchSocketClient = ConchSocketClient()) {
        self.client = client
        region.onNearTop = { [weak self] in self?.loadOlder() }
        region.onShown = { [weak self] ids, center in self?.show(ids, around: center) }
    }

    /// Follow the transcript. A different session is a different reader: everything in
    /// flight for the old one is cancelled and refused rather than merged.
    ///
    /// `branchTip` says which branch of a shared transcript this window is (A8). It is
    /// captured here, once, and carried by every page this session reads — re-reading it
    /// as messages arrive would change the ancestry under an open cursor and restart the
    /// transcript someone is scrolling.
    func select(session: String?, branchTip: String?) {
        let next = session ?? ""
        guard next != paging.session else { return }
        pageTask?.cancel()
        pageTask = nil
        for task in bodyTasks.values { task.cancel() }
        bodyTasks = [:]
        for task in rereadTasks.values { task.cancel() }
        rereadTasks = [:]
        findTask?.cancel()
        findTask = nil
        retryTask?.cancel()
        retryTask = nil
        retryNotBefore = nil
        wakeTask?.cancel()
        wakeTask = nil
        wakeAt = nil
        backoff = HistoryBackoff()
        bodies = [:]
        fullBodies = [:]
        wanted = HistoryWanted()
        wantedRecorded = []
        shown = []
        shownOrder = []
        shownCenter = nil
        bodyOrder = []
        bodyNative = [:]
        readAt = [:]
        behind = [:]
        liveCut = []
        livePinned = []
        paging.select(session: next, branchTip: branchTip)
        region.reset()
    }

    /// The newest page, or the one before the oldest item held. `anchor` is the item the
    /// reader is looking at, which the view puts back under the eye after the prepend.
    ///
    /// Asked for on every scroll tick near the top, so it is cheap to refuse: already reading,
    /// nothing older, or still pausing after a failure.
    func loadOlder(anchor: String? = nil) {
        guard !paging.session.isEmpty, paging.canLoadOlder else { return }
        if let retryNotBefore, Date() < retryNotBefore { return }
        let generation = paging.beginLoad(anchor: anchor)
        let request = ConchHistoryPageRequest(
            session: paging.session,
            branch: paging.branchTip,
            before: paging.previousCursor,
            limit: Self.pageLimit
        )
        let client = self.client
        pageTask?.cancel()
        pageTask = Task { @MainActor [weak self] in
            let outcome = await client.request(request, timeout: Self.timeout)
            guard !Task.isCancelled, let self else { return }
            self.receive(outcome, generation: generation)
        }
    }

    /// The same request again, after an error the reader was shown.
    func retry() {
        loadOlder(anchor: paging.anchor)
    }

    private func receive(_ outcome: ConchSocketRequestOutcome, generation: Int) {
        guard case let .reply(data) = outcome,
              let reply = try? JSONDecoder().decode(ConchHistoryReply.self, from: data) else {
            paging.apply(failure: .message("conch's daemon didn't answer."), generation: generation)
            scheduleRetry()
            return
        }
        if let page = reply.page {
            let restarted = paging.generation
            paging.apply(page: page, generation: generation)
            // The page belonged to an epoch that has gone: the reader restarted itself and
            // now holds no cursor, so reading again cannot be stale a second time.
            if paging.generation != restarted { loadOlder(anchor: paging.anchor) }
            drainWantedBodies()
            return
        }
        let failure = reply.failure ?? .message("History couldn't be read.")
        let restarted = paging.generation
        paging.apply(failure: failure, generation: generation)
        if paging.generation != restarted { loadOlder(anchor: paging.anchor) }
        if case .failed = paging.status { scheduleRetry() }
    }

    /// Try again on its own after a pause that doubles; after the last, the reader's next
    /// scroll to the top tries again — or, holding nothing to scroll, every 30 s for as long as
    /// it is shown (`HistoryPaging.retryDelay`). There is no button.
    private func scheduleRetry() {
        retryTask?.cancel()
        guard let delay = paging.retryDelay else {
            retryNotBefore = nil
            return
        }
        retryNotBefore = Date().addingTimeInterval(delay)
        let generation = paging.generation
        retryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self, self.paging.generation == generation else { return }
            self.retryNotBefore = nil
            self.loadOlder(anchor: self.paging.anchor)
        }
    }

    // MARK: - Pauses

    /// One timer for everything a pause holds back — a failed body, a released page, a look, a
    /// live row whose record is behind — set for the soonest of them.
    private func wake(at date: Date?) {
        guard let date else { return }
        if let wakeAt, wakeAt <= date { return }
        wakeTask?.cancel()
        wakeAt = date
        wakeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, date.timeIntervalSinceNow) * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.wakeTask = nil
            self.wakeAt = nil
            self.service()
        }
    }

    /// A pause ended: whatever it held back is asked for again if it is still wanted — the
    /// released pages on screen, the bodies near the viewport, the live rows — and the timer is
    /// set for the next.
    private func service() {
        for page in paging.releasedPages(holding: shown) { reread(page: page) }
        pumpBodies()
        checkWhole()
        drainWantedBodies()
        wake(at: backoff.nextWake(after: Date()))
    }

    // MARK: - What is on screen

    /// A different set of rows is real: read what they need, and let go of what is far away.
    ///
    /// The ceiling releases pages farthest from the row in the middle of the viewport; a
    /// released page among the rows now shown is read again; and a message longer than its
    /// preview is read whole, nearest the middle first, so it is whole before it is seen.
    private func show(_ ids: [String], around center: String?) {
        // Only when it moves: every change to `paging` redraws the conversation.
        if paging.page(of: center) != paging.focusPage { paging.focus(on: center) }
        // What has just come into view: a read that gave up on it tries once more. The reader
        // coming back is what asks again once a read's pauses are spent.
        let appeared = Set(ids).subtracting(shown)
        for id in appeared { backoff.revisit(.body(id)) }
        for page in paging.releasedPages(holding: appeared) { backoff.revisit(.page(page)) }
        shown = Set(ids)
        shownOrder = ids
        shownCenter = center
        for page in paging.releasedPages(holding: shown) { reread(page: page) }
        refreshWanted()
    }

    /// The rows on or near screen for a reader with no region to lay them out: the conversation panel's, whose words are
    /// one flow rather than rows, and which says where it is by position (`PanelHistory.nearby`). The region's own demand:
    /// their bodies read whole, nearest the middle first, and held while they are near.
    func showing(_ ids: [String], around center: String?) {
        show(ids, around: center)
    }

    /// The shown rows' messages that are longer than their preview, nearest the middle first.
    private func refreshWanted() {
        let byID = Dictionary(paging.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        wantedRecorded = shownOrder.compactMap { byID[$0] }
        wantedCenter = shownCenter.flatMap { id in wantedRecorded.firstIndex { $0.id == id } } ?? wantedRecorded.count / 2
        pumpBodies()
    }

    private func pumpBodies() {
        let held = Set(bodies.compactMap { $0.value.isComplete ? $0.key : nil })
        let paused = backoff.pausedBodies(at: Date())
        for id in HistoryDemand.bodies(for: wantedRecorded, around: wantedCenter, held: held, reading: Set(bodyTasks.keys), paused: paused) {
            loadBody(item: id)
        }
    }

    /// A released page, read again with the cursor it was first read with.
    ///
    /// One that fails is asked for again after a pause (`HistoryBackoff`), not only when the
    /// reader next scrolls: until then its rows are a spinner.
    private func reread(page id: Int) {
        guard rereadTasks[id] == nil, backoff.allows(.page(id), at: Date()),
              let reread = paging.beginReread(page: id) else { return }
        let request = ConchHistoryPageRequest(
            session: paging.session,
            branch: paging.branchTip,
            before: reread.cursor,
            limit: Self.pageLimit
        )
        let client = self.client
        rereadTasks[id] = Task { @MainActor [weak self] in
            let outcome = await client.request(request, timeout: Self.timeout)
            guard !Task.isCancelled, let self else { return }
            self.rereadTasks[id] = nil
            var reply: ConchHistoryReply?
            if case let .reply(data) = outcome { reply = try? JSONDecoder().decode(ConchHistoryReply.self, from: data) }
            if let page = reply?.page {
                self.backoff.succeeded(.page(id))
                self.paging.apply(reread: page, page: id, generation: reread.generation)
            } else {
                let failure = reply?.failure ?? .message("History couldn't be read.")
                self.paging.apply(rereadFailure: failure, page: id, generation: reread.generation)
                // A stale cursor has started the reader again, and the page with it.
                if self.paging.generation == reread.generation {
                    self.wake(at: self.backoff.failed(.page(id), at: Date()))
                }
            }
            // The rows it filled in may be the very ones on screen: read their bodies too.
            self.refreshWanted()
        }
    }

    // MARK: - Bodies

    func body(for item: String) -> HistoryBody? { bodies[item] }

    /// Read one item's body to its end, a chunk at a time.
    func loadBody(item: String, nativeId: String? = nil) {
        guard !paging.session.isEmpty, bodyTasks[item] == nil else { return }
        var body = bodies[item] ?? HistoryBody()
        guard !body.isComplete else { return }
        // A read that failed waits out its pause; the timer asks again when it ends.
        guard backoff.allows(.body(item), at: Date()) else { return }
        body.begin()
        bodies[item] = body
        if let nativeId { readAt[nativeId] = Date() }

        let client = self.client
        let session = paging.session
        let generation = paging.generation
        bodyTasks[item] = Task { @MainActor [weak self] in
            defer {
                self?.bodyTasks[item] = nil
                self?.pumpBodies()
            }
            while !Task.isCancelled {
                guard let store = self, store.paging.generation == generation, store.paging.session == session else { return }
                let request = ConchHistoryItemRequest(session: session, item: item, bodyCursor: store.bodies[item]?.cursor)
                let outcome = await client.request(request, timeout: Self.timeout)
                guard !Task.isCancelled, let store = self, store.paging.generation == generation else { return }

                var next = store.bodies[item] ?? HistoryBody()
                guard case let .reply(data) = outcome,
                      let reply = try? JSONDecoder().decode(ConchHistoryReply.self, from: data) else {
                    next.apply(failure: .message("That message couldn't be loaded."))
                    store.bodies[item] = next
                    store.bodyFailed(item)
                    return
                }
                if reply.kind == "history-item", let content = reply.content, let revision = reply.revision {
                    next.apply(chunk: content, revision: revision, next: reply.nextBodyCursor, encoding: reply.encoding ?? "text")
                    store.bodies[item] = next
                    if next.isComplete {
                        store.backoff.succeeded(.body(item))
                        store.keep(body: next.text, item: item, nativeId: nativeId)
                        return
                    }
                    continue
                }
                let failure = reply.failure ?? .message("That message couldn't be loaded.")
                next.apply(failure: failure)
                store.bodies[item] = next
                // A body that moved is read again from its start — and that read carries no
                // cursor, so it cannot come back stale a second time.
                if failure == .stale { continue }
                store.bodyFailed(item)
                return
            }
        }
    }

    /// A body read failed — the daemon down or restarting, its reads coming back busy, records
    /// off: it pauses before it is asked for again (`HistoryBackoff`). Without the pause it was
    /// asked for again the moment this read ended, being neither held nor read, in a loop.
    private func bodyFailed(_ item: String) {
        wake(at: backoff.failed(.body(item), at: Date()))
    }

    /// Hold a finished body, and let go of the ones read longest ago once this reader holds more
    /// than its budget — never one drawn right now, which would shrink under the reader's eye.
    ///
    /// Both copies go together. `bodies` is keyed by record id and `fullBodies` by provider id;
    /// releasing only one of them would free nothing, because the other still holds the string.
    private func keep(body text: String, item: String, nativeId: String?) {
        if let nativeId {
            fullBodies[nativeId] = text
            bodyNative[item] = nativeId
            wanted.remove(nativeId)
        }
        bodyOrder.removeAll { $0 == item }
        bodyOrder.append(item)

        let held = bodyOrder.map { (id: $0, bytes: bodies[$0]?.text.utf8.count ?? 0) }
        let pinned = shown.union(bodyNative.filter { wanted.natives.contains($0.value) || livePinned.contains($0.value) }.keys)
        for released in HistoryBudget.release(held, keepingUnder: HistoryBudget.macBodyBytes, pinned: pinned) {
            bodies[released] = nil
            if let native = bodyNative[released] { fullBodies[native] = nil }
            bodyNative[released] = nil
            bodyOrder.removeAll { $0 == released }
        }
        // A live row whose record was behind: joined now, or read again when its time comes.
        if let nativeId, livePinned.contains(nativeId) { checkWhole() }
    }

    /// A recorded row's whole body, asked for when its tool output is opened.
    func loadRecordedBody(_ id: String) {
        guard let item = paging.items.first(where: { $0.id == id }), item.hasFullBody else { return }
        backoff.lift(.body(id))
        loadBody(item: id)
    }

    // MARK: - Complete text behind a cut live row

    /// The live rows cut to their tail, by provider id: their bodies are drawn now.
    private var livePinned: Set<String> = []

    /// The live window's cut messages, read whole as they appear rather than behind "Show the
    /// rest". One whose record is behind — still being written — is read again until the
    /// record's copy and the tail can be joined (`HistorySnapshot.refresh`).
    func wantWhole(_ rows: [(id: String, cut: String)]) {
        liveCut = rows
        livePinned = Set(rows.map { HistorySnapshot.nativeId(forSnapshotItem: $0.id) })
        checkWhole()
    }

    /// Each cut live row: wanted while the record's body is not held; read again once it is,
    /// if the record is behind and it is time; and the timer set for when it will be.
    ///
    /// Asked when the rows change, when one of their bodies lands and when a pause ends. Asked
    /// only when the rows changed, a reply that stopped streaming inside a refresh interval —
    /// or while its read was in flight — was never read again, and stayed cut.
    private func checkWhole() {
        let now = Date()
        var missing: [String] = []
        for row in liveCut {
            let native = HistorySnapshot.nativeId(forSnapshotItem: row.id)
            guard let full = fullBodies[native] else {
                missing.append(native)
                continue
            }
            let tries = behind[native].flatMap { $0.cut == row.cut ? $0.tries : nil } ?? 0
            switch HistorySnapshot.refresh(record: full, cut: row.cut, lastRead: readAt[native], tries: tries, now: now) {
            case .whole:
                behind[native] = nil
            case .spent:
                continue
            case let .at(due):
                wake(at: due)
            case .now:
                // One in flight says so when it lands.
                guard let record = wanted.records[native], bodyTasks[record] == nil else { continue }
                behind[native] = (row.cut, tries + 1)
                bodies[record] = nil
                fullBodies[native] = nil
                missing.append(native)
            }
        }
        if !missing.isEmpty { want(missing) }
    }

    /// The whole text behind a snapshot row, when the record has it.
    ///
    /// Nothing matching means the snapshot's own text stands: showing a different
    /// item's body under this one's id would be worse than showing a short one.
    func fullText(forSnapshotItem id: String) -> String? {
        fullBodies[HistorySnapshot.nativeId(forSnapshotItem: id)]
    }

    /// Ask for the complete bodies behind live rows the snapshot cut. Someone asked — a tool's
    /// output opened, Retry pressed, the overlay gone full screen — so a read paused after
    /// failing is made now rather than when its pause ends.
    func loadFullBodies(forSnapshotItems ids: [String]) {
        let natives = ids.map(HistorySnapshot.nativeId(forSnapshotItem:))
        for native in natives {
            backoff.lift(.find(native))
            if let record = wanted.records[native] { backoff.lift(.body(record)) }
        }
        want(natives)
    }

    /// Wanted whole: read once a page names them, and looked for where none does.
    private func want(_ natives: [String]) {
        guard !paging.session.isEmpty else { return }
        let missing = natives.filter { fullBodies[$0] == nil }
        guard !missing.isEmpty else { return }
        wanted.want(missing)
        // A page is what names these items: the snapshot knows the provider's id, and only
        // the record store knows the id its bodies are addressed by. Before the first page
        // there is nothing to name them or to look from.
        if paging.epoch == nil { loadOlder() } else { drainWantedBodies() }
    }

    /// Read the live rows' bodies a page names, and look for one that none does.
    private func drainWantedBodies() {
        guard !wanted.isEmpty else { return }
        let plan = wanted.plan(held: paging.items, reading: Set(bodyTasks.keys), backoff: backoff, now: Date())
        for named in plan.read { loadBody(item: named.record, nativeId: named.native) }
        if let tip = plan.find { find(tip) }
    }

    /// Look for a live row no held page names: a reply that arrived after this reader's first
    /// page, which was the newest when the session opened. The record pages backwards only, so
    /// the row is read from the newest page of its own branch — its own id as the tip, which
    /// makes that message the newest thing in the page.
    ///
    /// Not there yet (the record runs behind the transcript), or not read at all (busy, the
    /// daemon down): a pause, then another look.
    private func find(_ tip: String) {
        guard findTask == nil, !paging.session.isEmpty, paging.epoch != nil else { return }
        let request = ConchHistoryPageRequest(session: paging.session, branch: tip, before: nil, limit: Self.pageLimit)
        let client = self.client
        findTask = Task { @MainActor [weak self] in
            let outcome = await client.request(request, timeout: Self.timeout)
            guard !Task.isCancelled, let self else { return }
            self.findTask = nil
            var page: HistoryPage?
            if case let .reply(data) = outcome { page = (try? JSONDecoder().decode(ConchHistoryReply.self, from: data))?.page }
            for native in self.wanted.found(in: page?.items ?? []) { self.backoff.succeeded(.find(native)) }
            if self.wanted.records[tip] == nil { self.wake(at: self.backoff.failed(.find(tip), at: Date())) }
            self.drainWantedBodies()
        }
    }
}

// MARK: - Recorded items as conversation rows

extension ConversationItem {
    /// A recorded item drawn by the same renderers as a live one.
    ///
    /// The stack already knows how to draw a message, a tool row and a material; a
    /// recorded item is the same thing read from a different place, so it becomes one
    /// rather than growing a second set of rows for the redesign to inherit.
    init(recorded: HistoryItem, text: String) {
        let kind: Kind = switch recorded.kind {
        case "message": recorded.role == "user" ? .user : .assistant
        case "tool_call", "tool_result": .tool
        case "material", "context", "compaction": .material
        default: .assistant
        }
        self.init(
            id: recorded.id,
            rev: recorded.revision,
            kind: kind,
            text: kind == .tool ? "" : text,
            at: recorded.at,
            tool: kind == .tool
                ? Tool(name: recorded.toolName ?? "tool", kind: .unknown, status: "completed", result: text)
                : nil,
            plan: nil,
            change: nil,
            question: nil,
            material: kind == .material
                ? Material(kind: .unknown, title: recorded.toolName ?? "Material", detail: text)
                : nil
        )
    }
}
