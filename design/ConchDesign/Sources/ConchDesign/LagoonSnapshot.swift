import Foundation

/// What the lagoon may see of conch's published state (spec §4), and nothing else: a whitelist, field by field, in the
/// shape and under the names the brand repo's `experiments/bridge/sanitize.mjs` writes, which is the source of truth (the
/// lagoon's adapter, `js/data/live.js`, reads exactly those). test/lagoon-page.test.ts runs sanitize.mjs and this on one
/// fixture and compares the two.
///
/// The type IS the whitelist: what isn't a property here can't be encoded. Never sent: transcript paths, account labels and
/// ids, settings, voices, the execution catalogue, the device id, a deliverable's raw link and its snapshot or marks,
/// deliveries, audio, phone and screen state, thinking and material, and every conversation item beyond a session's last
/// message and last two steps. A deliverable's link becomes `open`: a `conch-lagoon://lagoon/review/…` URL that serves that
/// one file's folder read-only, or the link itself when it is already a web address.
///
/// The app reads `Source` off its `PublishedState` (mac-app/conch-mac/LagoonSource.swift), field for field, and this
/// does the stripping: the same `str` cuts, `~` for home, the resolved agent.
public struct LagoonSnapshot: Encodable, Equatable, Sendable {
    public var v = 1
    public var ts: Double?
    public var mode: Mode
    public var live: Live
    public var rows: [Row]
    public var conversations: [String: Conversation]
    public var dismissed: [String]

    public struct Mode: Encodable, Equatable, Sendable {
        public var paused: Bool
        public var holding: Int
    }

    public struct Live: Encodable, Equatable, Sendable {
        public var state: String
    }

    public struct Row: Encodable, Equatable, Sendable {
        public var id: String
        public var label: String?
        /// `working`, `waiting` or `needs`; null otherwise (sent as null, as sanitize.mjs does).
        public var status: String?
        public var needsResponse: Bool
        public var detail: String?
        public var snippet: String?
        public var cwd: String?
        public var workDirs: [String]?
        /// `claude` or `codex`, resolved: the daemon publishes `backend` only on subagent rows.
        public var backend: String
        public var parentSessionId: String?
        public var startedBySessionId: String?
        public var context: Context?
        public var paused: Bool
        /// True or absent.
        public var pauseExempt: Bool?
        public var muted: Bool
        /// Sent as null when there is none.
        public var live: String?
        public var active: Bool
        public var waitingOnAgents: Bool?
        /// That it hit one (true or absent), never the provider's words.
        public var usageLimit: Bool?
        public var at: Double?
        public var activity: Activity?
        public var approval: Approval?
        public var reviews: [Review]

        enum CodingKeys: String, CodingKey {
            case id, label, status, needsResponse, detail, snippet, cwd, workDirs, backend, parentSessionId, startedBySessionId
            case context, paused, pauseExempt, muted, live, active, waitingOnAgents, usageLimit, at, activity, approval, reviews
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id)
            try c.encodeIfPresent(label, forKey: .label)
            try c.encode(status, forKey: .status)   // (null, not absent)
            try c.encode(needsResponse, forKey: .needsResponse)
            try c.encodeIfPresent(detail, forKey: .detail)
            try c.encodeIfPresent(snippet, forKey: .snippet)
            try c.encodeIfPresent(cwd, forKey: .cwd)
            try c.encodeIfPresent(workDirs, forKey: .workDirs)
            try c.encode(backend, forKey: .backend)
            try c.encodeIfPresent(parentSessionId, forKey: .parentSessionId)
            try c.encodeIfPresent(startedBySessionId, forKey: .startedBySessionId)
            try c.encodeIfPresent(context, forKey: .context)
            try c.encode(paused, forKey: .paused)
            try c.encodeIfPresent(pauseExempt, forKey: .pauseExempt)
            try c.encode(muted, forKey: .muted)
            try c.encode(live, forKey: .live)   // (null, not absent)
            try c.encode(active, forKey: .active)
            try c.encodeIfPresent(waitingOnAgents, forKey: .waitingOnAgents)
            try c.encodeIfPresent(usageLimit, forKey: .usageLimit)
            try c.encodeIfPresent(at, forKey: .at)
            try c.encodeIfPresent(activity, forKey: .activity)
            try c.encodeIfPresent(approval, forKey: .approval)
            try c.encode(reviews, forKey: .reviews)
        }
    }

    public struct Context: Encodable, Equatable, Sendable {
        public var usedTokens: Int
        public var limitTokens: Int
    }

    public struct Activity: Encodable, Equatable, Sendable {
        public var text: String?
        public var kind: String?
        public var at: Double?
    }

    public struct Approval: Encodable, Equatable, Sendable {
        public var id: String?
        public var name: String?
        public var summary: String?
        /// False when conch can't press keys at the agent's dialog; absent otherwise.
        public var answerable: Bool?
    }

    public struct Review: Encodable, Equatable, Sendable {
        /// The review's id, else its artifact, else its place in the list: what `…/review/<s>/<r>` names.
        public var id: String
        public var summary: String?
        public var kind: String?
        public var at: Double?
        public var viewedAt: Double?
        public var version: Int?
        public var scene: Scene?
        public var open: String?
    }

    public struct Scene: Encodable, Equatable, Sendable {
        public var target: Target?
        public var inspect: String?

        public struct Target: Encodable, Equatable, Sendable {
            public var kind: String?
        }
    }

    public struct Conversation: Encodable, Equatable, Sendable {
        public var sessionId: String
        public var items: [Item]
    }

    public struct Item: Encodable, Equatable, Sendable {
        public var id: String?
        public var kind: String
        public var text: String?
        public var at: Double?
    }

    // MARK: What the app hands over

    /// The fields of `PublishedState` this reads, and no others: the app fills it in field for field.
    public struct Source: Equatable, Sendable {
        public var ts: Double?
        public var paused: Bool
        public var holding: Int
        public var liveState: String?
        public var rows: [Row]
        /// Each session's conversation items, by session id.
        public var conversations: [String: [Item]]
        /// `dismissed`, then `dismissedRows`' ids.
        public var dismissed: [String]

        public init(ts: Double?, paused: Bool, holding: Int, liveState: String?, rows: [Row], conversations: [String: [Item]], dismissed: [String]) {
            self.ts = ts
            self.paused = paused
            self.holding = holding
            self.liveState = liveState
            self.rows = rows
            self.conversations = conversations
            self.dismissed = dismissed
        }

        public struct Row: Equatable, Sendable {
            public var id: String
            public var label: String?
            public var status: String?
            public var needsResponse: Bool
            public var detail: String?
            public var snippet: String?
            public var cwd: String?
            public var workDirs: [String]?
            /// The row's own `backend` (subagent rows only) and its execution's provider: read together into one agent.
            public var backend: String?
            public var providerId: String?
            public var parentSessionId: String?
            public var startedBySessionId: String?
            public var usedTokens: Int?
            public var limitTokens: Int?
            public var paused: Bool
            public var pauseExempt: Bool
            public var live: String?
            public var active: Bool
            public var waitingOnAgents: Bool
            /// The provider's message: only whether there is one is sent.
            public var usageLimit: String?
            public var at: Double?
            public var activity: Activity?
            public var approval: Approval?
            /// Everything it holds, oldest first (`reviews`, or `[review]` from an older daemon: `held`).
            public var reviews: [Review]

            public init(id: String, label: String? = nil, status: String? = nil, needsResponse: Bool = false, detail: String? = nil,
                        snippet: String? = nil, cwd: String? = nil, workDirs: [String]? = nil, backend: String? = nil,
                        providerId: String? = nil, parentSessionId: String? = nil, startedBySessionId: String? = nil,
                        usedTokens: Int? = nil, limitTokens: Int? = nil, paused: Bool = false, pauseExempt: Bool = false,
                        live: String? = nil, active: Bool = false, waitingOnAgents: Bool = false, usageLimit: String? = nil,
                        at: Double? = nil, activity: Activity? = nil, approval: Approval? = nil, reviews: [Review] = []) {
                self.id = id
                self.label = label
                self.status = status
                self.needsResponse = needsResponse
                self.detail = detail
                self.snippet = snippet
                self.cwd = cwd
                self.workDirs = workDirs
                self.backend = backend
                self.providerId = providerId
                self.parentSessionId = parentSessionId
                self.startedBySessionId = startedBySessionId
                self.usedTokens = usedTokens
                self.limitTokens = limitTokens
                self.paused = paused
                self.pauseExempt = pauseExempt
                self.live = live
                self.active = active
                self.waitingOnAgents = waitingOnAgents
                self.usageLimit = usageLimit
                self.at = at
                self.activity = activity
                self.approval = approval
                self.reviews = reviews
            }
        }

        /// What its agent is doing right now, and the permission prompt it shows: as the app decoded them.
        public struct Activity: Equatable, Sendable {
            public var text: String?
            public var kind: String?
            public var at: Double?

            public init(text: String?, kind: String?, at: Double?) {
                self.text = text
                self.kind = kind
                self.at = at
            }
        }

        public struct Approval: Equatable, Sendable {
            public var id: String?
            public var name: String?
            public var summary: String?
            public var answerable: Bool?

            public init(id: String?, name: String?, summary: String?, answerable: Bool?) {
                self.id = id
                self.name = name
                self.summary = summary
                self.answerable = answerable
            }
        }

        public struct Review: Equatable, Sendable {
            public var id: String?
            public var artifact: String?
            public var summary: String?
            public var kind: String?
            public var at: Double?
            public var viewedAt: Double?
            public var version: Int?
            /// Whether it carried a scene at all, and what of it the lagoon may see.
            public var hasScene: Bool
            public var targetKind: String?
            public var inspect: String?
            /// Never sent: it decides `open`, and the scheme handler resolves it again from the current state.
            public var link: String?

            public init(id: String? = nil, artifact: String? = nil, summary: String? = nil, kind: String? = nil, at: Double? = nil,
                        viewedAt: Double? = nil, version: Int? = nil, hasScene: Bool = false, targetKind: String? = nil,
                        inspect: String? = nil, link: String? = nil) {
                self.id = id
                self.artifact = artifact
                self.summary = summary
                self.kind = kind
                self.at = at
                self.viewedAt = viewedAt
                self.version = version
                self.hasScene = hasScene
                self.targetKind = targetKind
                self.inspect = inspect
                self.link = link
            }
        }

        public struct Item: Equatable, Sendable {
            public var id: String?
            public var kind: String
            public var text: String?
            public var at: Double?

            public init(id: String?, kind: String, text: String?, at: Double?) {
                self.id = id
                self.kind = kind
                self.text = text
                self.at = at
            }
        }
    }

    // MARK: The stripping

    /// sanitize.mjs `held`: every deliverable a row holds, or the one `review` from a daemon older than many-per-session.
    public static func held<Review>(reviews: [Review]?, review: Review?) -> [Review] {
        if let reviews, !reviews.isEmpty { return reviews }
        return review.map { [$0] } ?? []
    }

    /// sanitize.mjs `reviewKey`: the review's id, else its artifact, else its index, as a string.
    public static func reviewKey(id: String?, artifact: String?, index: Int) -> String {
        if let id, !id.isEmpty { return id }
        if let artifact, !artifact.isEmpty { return artifact }
        return String(index)
    }

    /// Where the page may open a review: its own web link, or the scheme's read-only copy of its file; nothing without a
    /// link (bridge's `openUrl`, serve.mjs).
    public static func openURL(sessionId: String, reviewKey: String, link: String?) -> String? {
        guard let link, !link.isEmpty else { return nil }
        if isWebLink(link) { return link }
        return Lagoon.reviewURL(sessionId: sessionId, reviewKey: reviewKey)
    }

    public static func isWebLink(_ link: String) -> Bool {
        let lowered = link.lowercased()
        return lowered.hasPrefix("http://") || lowered.hasPrefix("https://")
    }

    public init(_ source: Source, home: String) {
        func tilde(_ path: String?) -> String? {
            guard let path else { return nil }
            if path == home || path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
            return path
        }
        func finite(_ number: Double?) -> Double? { number.flatMap { $0.isFinite ? $0 : nil } }
        let statuses: Set<String> = ["working", "waiting", "needs"]

        let rows = source.rows.map { r in
            let backendName = (r.backend.map { !$0.isEmpty && $0 != "conch" } ?? false) ? r.backend : r.providerId
            return Row(
                id: r.id,
                label: Self.cut(r.label, 120),
                status: r.status.flatMap { statuses.contains($0) ? $0 : nil },
                needsResponse: r.needsResponse,
                detail: Self.cut(r.detail, 200),
                snippet: Self.cut(r.snippet, 160),
                cwd: tilde(r.cwd),
                workDirs: r.workDirs.map { $0.prefix(3).map { tilde($0)! } },
                backend: backendName == "codex" ? "codex" : "claude",
                parentSessionId: Self.cut(r.parentSessionId, 120),
                startedBySessionId: Self.cut(r.startedBySessionId, 120),
                context: r.limitTokens.flatMap { $0 != 0 ? Context(usedTokens: r.usedTokens ?? 0, limitTokens: $0) : nil },
                paused: r.paused,
                pauseExempt: r.pauseExempt ? true : nil,
                // Always false on the wire: the daemon has published `muted: false` on every row since manual replaced it.
                muted: false,
                live: Self.cut(r.live, 20),
                active: r.active,
                waitingOnAgents: r.waitingOnAgents ? true : nil,
                usageLimit: (r.usageLimit.map { !$0.isEmpty } ?? false) ? true : nil,
                at: finite(r.at),
                activity: r.activity.map { Activity(text: Self.cut($0.text, 90), kind: Self.cut($0.kind, 20), at: finite($0.at)) },
                approval: r.approval.map {
                    Approval(id: Self.cut($0.id, 120), name: Self.cut($0.name, 60), summary: Self.cut($0.summary, 200),
                             answerable: $0.answerable == false ? false : nil)
                },
                reviews: r.reviews.enumerated().map { index, rv in
                    let key = Self.reviewKey(id: rv.id, artifact: rv.artifact, index: index)
                    return Review(
                        id: key,
                        summary: Self.cut(rv.summary, 160),
                        kind: Self.cut(rv.kind, 20),
                        at: finite(rv.at),
                        viewedAt: finite(rv.viewedAt),
                        version: rv.version,
                        scene: rv.hasScene || rv.targetKind != nil || rv.inspect != nil
                            ? Scene(target: rv.targetKind.map { Scene.Target(kind: Self.cut($0, 20)) }, inspect: Self.cut(rv.inspect, 200))
                            : nil,
                        open: Self.openURL(sessionId: r.id, reviewKey: key, link: rv.link)
                    )
                }
            )
        }

        self.rows = rows

        // The last thing each session said and its last two steps, short: what a hover or the report on the glass shows.
        var conversations: [String: Conversation] = [:]
        for row in rows {
            guard let items = source.conversations[row.id] else { continue }
            let said = items.last { $0.kind == "assistant" }
            let tools = items.filter { $0.kind == "tool" }.suffix(2)
            let kept = Self.stableSorted(Array(tools) + (said.map { [$0] } ?? [])) { ($0.at ?? 0) < ($1.at ?? 0) }
            conversations[row.id] = Conversation(sessionId: row.id, items: kept.map {
                Item(id: Self.cut($0.id, 120), kind: $0.kind, text: Self.cut($0.text, $0.kind == "tool" ? 120 : 240), at: finite($0.at))
            })
        }
        self.conversations = conversations
        ts = finite(source.ts)
        mode = Mode(paused: source.paused, holding: source.holding)
        live = Live(state: Self.cut(source.liveState, 20).flatMap { $0.isEmpty ? nil : $0 } ?? "idle")
        var seen = Set<String>()
        dismissed = source.dismissed.filter { seen.insert($0).inserted }
    }

    /// sanitize.mjs `str`: past `limit`, the first `limit − 1` and an ellipsis. Counted in UTF-16 units, as JavaScript
    /// counts, so both cut at the same place; a cut that would split a surrogate pair takes one unit fewer.
    public static func cut(_ text: String?, _ limit: Int) -> String? {
        guard let text else { return nil }
        let units = Array(text.utf16)
        guard units.count > limit else { return text }
        var end = limit - 1
        if end > 0, UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
        return String(decoding: units[..<end], as: UTF16.self) + "…"
    }

    /// JavaScript's `sort` is stable; Swift's isn't promised to be.
    static func stableSorted<T>(_ items: [T], by less: (T, T) -> Bool) -> [T] {
        items.enumerated().sorted { a, b in
            less(a.element, b.element) || (!less(b.element, a.element) && a.offset < b.offset)
        }.map(\.element)
    }

    /// The JSON object `callAsyncJavaScript` hands the page (via JSONSerialization, so no JSON is escaped into source).
    public func jsonObject() throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(self))
    }
}
