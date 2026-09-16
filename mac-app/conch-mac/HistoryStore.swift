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

/// One transcript's reader. The dashboard and the overlay each hold their own,
/// because they show different sessions and neither may answer with the other's.
@MainActor
final class HistoryStore: ObservableObject {
    @Published private(set) var paging = HistoryPaging()
    /// Bodies being read, by RECORD item id.
    @Published private(set) var bodies: [String: HistoryBody] = [:]
    /// Complete bodies by PROVIDER id: what a cut live row shows once it is opened.
    @Published private(set) var fullBodies: [String: String] = [:]

    /// The API's own default. A page is about 28 KiB, so this is one socket read.
    static let pageLimit = 50
    /// A history read is a SQLite query behind a worker, not an agent: slow means broken.
    private static let timeout: TimeInterval = 5

    private let client: ConchSocketClient
    private var pageTask: Task<Void, Never>?
    private var bodyTasks: [String: Task<Void, Never>] = [:]
    /// Live rows waiting for their complete body, by provider id, until a page names them.
    private var wantedBodies: Set<String> = []

    init(client: ConchSocketClient = ConchSocketClient()) {
        self.client = client
    }

    /// Follow the transcript. A different session is a different reader: everything in
    /// flight for the old one is cancelled and refused rather than merged.
    func select(session: String?) {
        let next = session ?? ""
        guard next != paging.session else { return }
        pageTask?.cancel()
        pageTask = nil
        for task in bodyTasks.values { task.cancel() }
        bodyTasks = [:]
        bodies = [:]
        fullBodies = [:]
        wantedBodies = []
        paging.select(session: next)
    }

    /// The newest page, or the one before the oldest item held. `anchor` is the item the
    /// reader is looking at, which the view puts back under the eye after the prepend.
    func loadOlder(anchor: String? = nil) {
        guard !paging.session.isEmpty, paging.canLoadOlder else { return }
        let generation = paging.beginLoad(anchor: anchor)
        let request = ConchHistoryPageRequest(session: paging.session, before: paging.previousCursor, limit: Self.pageLimit)
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
    }

    // MARK: - Bodies

    func body(for item: String) -> HistoryBody? { bodies[item] }

    /// Read one item's body to its end, a chunk at a time.
    func loadBody(item: String, nativeId: String? = nil) {
        guard !paging.session.isEmpty, bodyTasks[item] == nil else { return }
        var body = bodies[item] ?? HistoryBody()
        guard !body.isComplete else { return }
        body.begin()
        bodies[item] = body

        let client = self.client
        let session = paging.session
        let generation = paging.generation
        bodyTasks[item] = Task { @MainActor [weak self] in
            defer { self?.bodyTasks[item] = nil }
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
                    return
                }
                if reply.kind == "history-item", let content = reply.content, let revision = reply.revision {
                    next.apply(chunk: content, revision: revision, next: reply.nextBodyCursor, encoding: reply.encoding ?? "text")
                    store.bodies[item] = next
                    if next.isComplete {
                        if let nativeId { store.fullBodies[nativeId] = next.text }
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
                return
            }
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
        // A page is what names these items: the snapshot knows the provider's id, and only
        // the record store knows the id its bodies are addressed by.
        if paging.items.isEmpty { loadOlder() } else { drainWantedBodies() }
    }

    private func drainWantedBodies() {
        guard !wantedBodies.isEmpty else { return }
        for item in paging.items {
            guard let nativeId = item.nativeId, wantedBodies.contains(nativeId), item.hasFullBody else { continue }
            wantedBodies.remove(nativeId)
            loadBody(item: item.id, nativeId: nativeId)
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
