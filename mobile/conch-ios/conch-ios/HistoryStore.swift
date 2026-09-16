import Combine
import ConchDesign
import Foundation

// The phone's reader for recorded history (docs/records-paging.md).
//
// The daemon's published conversation is a preview and always will be: the newest
// items, messages cut at 4,000 characters, tool output at 400. That is what the Mac
// can afford to send four times a second over a phone relay, and the wrong thing to
// read a session from. Everything older, and everything cut, is read from the record
// store through the phone's own authenticated /history/page and /history/item routes.
//
// Everything a reader can get wrong about that already lives in ConchDesign's
// HistoryPaging, HistoryBody and HistoryBudget, where `swift test` reaches it without
// a simulator: which generation of a request an answer belongs to, what a stale epoch
// invalidates, and how much one phone will hold. This file is the transport and the
// task bookkeeping around them — the same split the Mac's HistoryStore uses, and the
// same shared types, so the two readers cannot drift apart.

// MARK: - Wire

/// Optional fields are OMITTED, never sent as null. The daemon validates a history
/// request by its key set, so `before: null` is an invalid request rather than "no
/// cursor" — and the difference between those two is a whole transcript.
struct PhoneHistoryPageRequest: Encodable, Sendable {
    let session: String
    var before: String?
    var limit: Int?

    private enum CodingKeys: String, CodingKey { case kind, session, before, limit }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("history-page", forKey: .kind)
        try container.encode(session, forKey: .session)
        try container.encodeIfPresent(before, forKey: .before)
        try container.encodeIfPresent(limit, forKey: .limit)
    }
}

struct PhoneHistoryItemRequest: Encodable, Sendable {
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
struct PhoneHistoryReply: Decodable, Sendable {
    struct Item: Decodable, Sendable {
        let id: String
        let kind: String?
        let role: String?
        let nativeId: String?
        let toolName: String?
        let toolId: String?
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
                    toolId: $0.toolId,
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
                observedBytes: coverage?.observedBytes ?? 0
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

/// One transcript's reader, for as long as that session is on screen.
@MainActor
final class HistoryStore: ObservableObject {
    @Published private(set) var paging = HistoryPaging(itemCap: HistoryStore.itemCap)
    /// Bodies being read, by RECORD item id.
    @Published private(set) var bodies: [String: HistoryBody] = [:]
    /// Complete bodies by PROVIDER id: what a cut live row shows once it is opened.
    @Published private(set) var fullBodies: [String: String] = [:]

    /// The API's own default. A page is about 28 KiB, so this is one request.
    static let pageLimit = 50
    /// How many recorded rows this phone will hold: twenty pages.
    ///
    /// Not a guess about bytes — the rows themselves are small (a 240-character
    /// preview each, so twenty pages is well under a megabyte). It is a bound on
    /// LAYOUT. The stack is eager, like the Mac's, so every row held is also a row
    /// measured, and the largest session in this record store is twelve thousand
    /// items. Twenty pages is more than anyone scrolls back through on a phone and
    /// still a number the view can lay out.
    static let itemCap = 1_000

    private weak var bridge: BridgeClient?
    private var pageTask: Task<Void, Never>?
    private var bodyTasks: [String: Task<Void, Never>] = [:]
    /// Live rows waiting for their complete body, by provider id, until a page names them.
    private var wantedBodies: Set<String> = []
    /// Record item ids whose bodies are held, least recently read first.
    private var bodyOrder: [String] = []
    /// The provider id each held body answers for, so releasing one releases both copies.
    private var bodyNative: [String: String] = [:]

    /// Follow a session. A different one is a different reader: everything in flight
    /// for the old session is cancelled and refused rather than merged into this one.
    func follow(session: String, on bridge: BridgeClient) {
        self.bridge = bridge
        guard session != paging.session else { return }
        pageTask?.cancel()
        pageTask = nil
        resetEpochCaches()
        paging.select(session: session)
        // One read answers "is any of this recorded" — including the honest "records
        // are off" — rather than leaving that to a button nobody presses.
        loadOlder()
    }

    /// The newest page, or the one before the oldest item held. `anchor` is the row the
    /// reader is looking at, which the view puts back under the eye after the prepend.
    func loadOlder(anchor: String? = nil) {
        guard !paging.session.isEmpty, paging.canLoadOlder, let bridge else { return }
        let generation = paging.beginLoad(anchor: anchor)
        let request = PhoneHistoryPageRequest(
            session: paging.session,
            before: paging.previousCursor,
            limit: Self.pageLimit
        )
        pageTask?.cancel()
        pageTask = Task { @MainActor [weak self] in
            let outcome = await bridge.readHistory(path: "/history/page", request: request)
            guard !Task.isCancelled, let self else { return }
            self.receive(outcome, generation: generation)
        }
    }

    /// The same request again, after an error the reader was shown.
    func retry() {
        loadOlder(anchor: paging.anchor)
    }

    /// The newest page again, keeping the older pages already held.
    ///
    /// The store pages BACKWARDS only, so a message written since the last read is in no
    /// page the reader holds: looking for it among those items finds nothing however many
    /// times it is asked, and the row waiting to be expanded waits forever. This is the
    /// only read that can see the end of the transcript again.
    private func loadNewest() {
        guard !paging.session.isEmpty, paging.status != .loading, let bridge else { return }
        let generation = paging.beginLoad(anchor: paging.anchor)
        let request = PhoneHistoryPageRequest(session: paging.session, limit: Self.pageLimit)
        pageTask?.cancel()
        pageTask = Task { @MainActor [weak self] in
            let outcome = await bridge.readHistory(path: "/history/page", request: request)
            guard !Task.isCancelled, let self else { return }
            self.receive(outcome, generation: generation, newest: true)
        }
    }

    /// Everything the index generation owned, let go of together.
    ///
    /// Pages, bodies and the reads in flight for them are all true of ONE epoch. Throwing
    /// away the pages while keeping the bodies is what let a message read before a replay
    /// be drawn under a row from after it — the reader looked consistent and was quoting a
    /// transcript that no longer exists.
    private func resetEpochCaches() {
        for task in bodyTasks.values { task.cancel() }
        bodyTasks = [:]
        bodies = [:]
        fullBodies = [:]
        bodyOrder = []
        bodyNative = [:]
        wantedBodies = []
    }

    /// Let go of the bodies a page has just made untrue, and ask for them again where a
    /// live row was showing one: a revised message should REPLACE what is on screen, not
    /// leave the old text standing and not blank the row that was reading it.
    private func retire(_ items: [String]) {
        for item in items {
            bodyTasks[item]?.cancel()
            bodyTasks[item] = nil
            bodies[item] = nil
            bodyOrder.removeAll { $0 == item }
            if let native = bodyNative[item] {
                fullBodies[native] = nil
                wantedBodies.insert(native)
            }
            bodyNative[item] = nil
        }
    }

    private func receive(_ outcome: BridgeClient.HistoryOutcome, generation: Int, newest: Bool = false) {
        guard case let .reply(data) = outcome,
              let reply = try? JSONDecoder().decode(PhoneHistoryReply.self, from: data) else {
            let reason: String = if case let .unreachable(message) = outcome { message } else { "History couldn't be read." }
            paging.apply(failure: .message(reason), generation: generation)
            return
        }
        let restarted = paging.generation
        if let page = reply.page {
            if newest { paging.apply(newest: page, generation: generation) }
            else { paging.apply(page: page, generation: generation) }
            // The page belonged to an epoch that has gone: the reader restarted itself
            // and now holds no cursor, so reading again cannot be stale a second time —
            // and every body it held was read out of the transcript that went away.
            if paging.generation != restarted {
                resetEpochCaches()
                loadOlder(anchor: paging.anchor)
                return
            }
            retire(HistoryCache.stale(bodies, against: page.items))
            drainWantedBodies()
            // Whatever this page did not name is not in the record under that id; the row
            // keeps its own text rather than waiting on a read nothing will answer.
            if newest { wantedBodies = [] }
            return
        }
        let failure = reply.failure ?? .message("History couldn't be read.")
        paging.apply(failure: failure, generation: generation)
        if paging.generation != restarted {
            resetEpochCaches()
            loadOlder(anchor: paging.anchor)
        }
    }

    // MARK: - Bodies

    func body(for item: String) -> HistoryBody? { bodies[item] }

    /// Read one item's body to its end, a chunk at a time.
    func loadBody(item: String, nativeId: String? = nil) {
        guard !paging.session.isEmpty, bodyTasks[item] == nil, let bridge else { return }
        var body = bodies[item] ?? HistoryBody()
        guard !body.isComplete else { return }
        body.begin()
        bodies[item] = body

        let session = paging.session
        let generation = paging.generation
        bodyTasks[item] = Task { @MainActor [weak self] in
            defer { self?.bodyTasks[item] = nil }
            while !Task.isCancelled {
                guard let store = self, store.paging.generation == generation, store.paging.session == session else { return }
                let request = PhoneHistoryItemRequest(
                    session: session,
                    item: item,
                    bodyCursor: store.bodies[item]?.cursor
                )
                let outcome = await bridge.readHistory(path: "/history/item", request: request)
                guard !Task.isCancelled, let store = self, store.paging.generation == generation else { return }

                var next = store.bodies[item] ?? HistoryBody()
                guard case let .reply(data) = outcome,
                      let reply = try? JSONDecoder().decode(PhoneHistoryReply.self, from: data) else {
                    next.apply(failure: .message("That message couldn't be loaded."))
                    store.bodies[item] = next
                    return
                }
                if reply.kind == "history-item", let content = reply.content, let revision = reply.revision {
                    next.apply(chunk: content, revision: revision, next: reply.nextBodyCursor, encoding: reply.encoding ?? "text")
                    store.bodies[item] = next
                    if next.isComplete {
                        store.keep(body: next.text, item: item, nativeId: nativeId)
                        return
                    }
                    continue
                }
                let failure = reply.failure ?? .message("That message couldn't be loaded.")
                next.apply(failure: failure)
                store.bodies[item] = next
                // A body that moved is read again from its start — and that read carries
                // no cursor, so it cannot come back stale a second time.
                if failure == .stale { continue }
                return
            }
        }
    }

    /// Hold a finished body, and let go of the ones read longest ago if this phone is
    /// now holding more than its budget.
    ///
    /// Both copies go together. `bodies` is keyed by record id and `fullBodies` by
    /// provider id; releasing only one of them would free nothing, because the other
    /// still holds the string — a cap that frees nothing is worse than no cap, since
    /// it reads as a bound that isn't there.
    private func keep(body text: String, item: String, nativeId: String?) {
        if let nativeId {
            fullBodies[nativeId] = text
            bodyNative[item] = nativeId
        }
        bodyOrder.removeAll { $0 == item }
        bodyOrder.append(item)

        let held = bodyOrder.map { (id: $0, bytes: bodies[$0]?.text.utf8.count ?? 0) }
        for released in HistoryBudget.release(held, keepingUnder: HistoryBudget.phoneBodyBytes) {
            bodies[released] = nil
            if let native = bodyNative[released] { fullBodies[native] = nil }
            bodyNative[released] = nil
            bodyOrder.removeAll { $0 == released }
        }
    }

    // MARK: - Complete text behind a cut live row

    /// The whole text behind a snapshot row, when the record has it.
    ///
    /// Nothing matching means the snapshot's own text stands: showing a different
    /// item's body under this one's id would be worse than showing a short one.
    func fullText(forSnapshotItem id: String) -> String? {
        fullBodies[HistorySnapshot.nativeId(forSnapshotItem: id)]
    }

    /// Ask for the complete bodies behind live rows the snapshot cut.
    func loadFullBodies(forSnapshotItems ids: [String]) {
        guard !paging.session.isEmpty else { return }
        let wanted = Set(ids.map(HistorySnapshot.nativeId(forSnapshotItem:))).subtracting(fullBodies.keys)
        guard !wanted.isEmpty else { return }
        wantedBodies.formUnion(wanted)
        // A page is what names these items: the snapshot knows the provider's id, and
        // only the record store knows the id its bodies are addressed by.
        drainWantedBodies()
        guard !wantedBodies.isEmpty else { return }
        if paging.items.isEmpty { loadOlder() } else { loadNewest() }
    }

    private func drainWantedBodies() {
        guard !wantedBodies.isEmpty else { return }
        for item in paging.items {
            // By the id the live row is keyed by: a tool row carries its CALL id, which is
            // not the UUID of the message the call was written in.
            guard let nativeId = wantedBodies.first(where: item.answers(snapshotNativeId:)), item.hasFullBody else { continue }
            wantedBodies.remove(nativeId)
            loadBody(item: item.id, nativeId: nativeId)
        }
    }
}

// MARK: - Recorded items as conversation rows

extension ConversationItem {
    /// A recorded item drawn by the same renderers as a live one.
    ///
    /// Built as the daemon's own JSON and put through the app's OWN decoder, rather
    /// than a second construction path. The stack already knows how to draw a message,
    /// a tool row and a material, and a recorded item is one of those read from
    /// somewhere else; going through the decoder is what guarantees a recorded row is
    /// the same shape as a published one, with no second set of defaults to drift.
    init?(recorded: HistoryItem, text: String) {
        let kind: String = switch recorded.kind {
        case "message": recorded.role == "user" ? "user" : "assistant"
        case "tool_call", "tool_result": "tool"
        case "material", "context", "compaction": "material"
        default: "assistant"
        }
        var payload: [String: Any] = [
            "id": recorded.id,
            "rev": recorded.revision,
            "kind": kind,
            // A tool row carries its output in the tool, not as the row's own text.
            "text": kind == "tool" ? "" : text,
        ]
        if let at = recorded.at { payload["at"] = at }
        if kind == "tool" {
            payload["tool"] = [
                "name": recorded.toolName ?? "tool",
                "kind": "unknown",
                // Recorded means finished. Whatever this call was doing when it was
                // written, it is not running now, and a recorded row that pulses like
                // a live one is a lie about what the session is doing.
                "status": "done",
                "result": text,
            ]
        }
        if kind == "material" {
            payload["material"] = [
                "kind": "unknown",
                "title": recorded.toolName ?? "Material",
                "detail": text,
            ]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let decoded = try? JSONDecoder().decode(ConversationItem.self, from: data) else { return nil }
        self = decoded
    }
}
