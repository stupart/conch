import Foundation

struct PublishedState: Decodable, Equatable, Sendable {
    static let knownVersion = 1

    let v: Int
    let newerDaemon: Bool
    let ts: TimeInterval
    let mode: ModeState
    let live: LiveState
    let reply: ConversationReply?
    let preview: ConversationReply?
    let conversation: Conversation?
    /// Keyed by session id, so a viewer finds the one it is showing.
    let conversations: [String: Conversation]?
    let rows: [SessionRow]
    let dismissed: [String]
    let dismissedRows: [DismissedSessionRow]

    private enum CodingKeys: String, CodingKey {
        case v
        case ts
        case mode
        case live
        case reply
        case preview
        case conversation
        case conversations
        case rows
        case dismissed
        case dismissedRows
    }

    init(
        v: Int,
        ts: TimeInterval,
        mode: ModeState,
        live: LiveState,
        reply: ConversationReply?,
        preview: ConversationReply?,
        conversation: Conversation? = nil,
        conversations: [String: Conversation]? = nil,
        rows: [SessionRow],
        dismissed: [String],
        dismissedRows: [DismissedSessionRow]
    ) {
        self.v = v
        newerDaemon = v > Self.knownVersion
        self.ts = ts
        self.mode = mode
        self.live = live
        self.reply = reply
        self.conversation = conversation
        self.conversations = conversations
        self.preview = preview
        self.rows = rows
        self.dismissed = dismissed
        self.dismissedRows = dismissedRows
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decode(Int.self, forKey: .v)

        guard version >= Self.knownVersion else {
            throw DecodingError.dataCorruptedError(
                forKey: .v,
                in: container,
                debugDescription: "Unsupported conch state version \(version)"
            )
        }

        v = version
        newerDaemon = version > Self.knownVersion
        rows = Self.decodeLossyArray(
            SessionRow.self,
            from: container,
            forKey: .rows
        )
        ts = (try? container.decodeIfPresent(TimeInterval.self, forKey: .ts)) ?? 0
        mode = (try? container.decodeIfPresent(ModeState.self, forKey: .mode)) ?? ModeState()
        live = (try? container.decodeIfPresent(LiveState.self, forKey: .live)) ?? LiveState()
        reply = try? container.decodeIfPresent(ConversationReply.self, forKey: .reply)
        conversation = try? container.decodeIfPresent(Conversation.self, forKey: .conversation)
        conversations = try? container.decodeIfPresent([String: Conversation].self, forKey: .conversations)
        preview = try? container.decodeIfPresent(ConversationReply.self, forKey: .preview)
        dismissed = (try? container.decodeIfPresent([String].self, forKey: .dismissed)) ?? []
        dismissedRows = Self.decodeLossyArray(
            DismissedSessionRow.self,
            from: container,
            forKey: .dismissedRows
        )
    }

    private static func decodeLossyArray<Element: Decodable>(
        _ type: Element.Type,
        from container: KeyedDecodingContainer<CodingKeys>,
        forKey key: CodingKeys
    ) -> [Element] {
        let elements = try? container.decodeIfPresent(
            [LossyDecodable<Element>].self,
            forKey: key
        )
        return elements?.compactMap(\.value) ?? []
    }

    /// `ts` proves the daemon is alive, but changes even when nothing a person
    /// can see has changed. StateStore keeps the fresh source snapshot for
    /// liveness and command reconciliation; this comparison keeps that heartbeat
    /// from invalidating the entire SwiftUI dashboard four times a second.
    func hasSamePresentation(as other: PublishedState) -> Bool {
        v == other.v
            && mode == other.mode
            && live == other.live
            && reply == other.reply
            && preview == other.preview
            && conversation == other.conversation
            && conversations == other.conversations
            && rows == other.rows
            && dismissed == other.dismissed
            && dismissedRows == other.dismissedRows
    }
}

struct DismissedSessionRow: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let label: String

    private enum CodingKeys: String, CodingKey {
        case id
        case label
    }

    init(id: String, label: String) {
        self.id = id
        self.label = label
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = (try? container.decodeIfPresent(String.self, forKey: .label)) ?? id
    }
}

struct ModeState: Decodable, Equatable, Sendable {
    let paused: Bool
    let holding: Int

    init(paused: Bool = false, holding: Int = 0) {
        self.paused = paused
        self.holding = holding
    }

    private enum CodingKeys: String, CodingKey {
        case paused
        case holding
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        paused = (try? container.decodeIfPresent(Bool.self, forKey: .paused)) ?? false
        holding = (try? container.decodeIfPresent(Int.self, forKey: .holding)) ?? 0
    }
}

struct LiveState: Decodable, Equatable, Sendable {
    let state: String
    let label: String
    let partial: String
    let transcriptPrefix: String
    let reading: ReadingProgress?
    /// A finished dictation meant for the composer. Applied once, by `id`.
    let dictated: Dictation?

    init(
        state: String = "idle",
        label: String = "",
        partial: String = "",
        transcriptPrefix: String = "",
        reading: ReadingProgress? = nil,
        dictated: Dictation? = nil
    ) {
        self.state = state
        self.label = label
        self.partial = partial
        self.transcriptPrefix = transcriptPrefix
        self.reading = reading
        self.dictated = dictated
    }

    private enum CodingKeys: String, CodingKey {
        case state
        case label
        case partial
        case transcriptPrefix
        case reading
        case dictated
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = (try? container.decodeIfPresent(String.self, forKey: .state)) ?? "idle"
        label = (try? container.decodeIfPresent(String.self, forKey: .label)) ?? ""
        partial = (try? container.decodeIfPresent(String.self, forKey: .partial)) ?? ""
        transcriptPrefix =
            (try? container.decodeIfPresent(String.self, forKey: .transcriptPrefix)) ?? ""
        reading = try? container.decodeIfPresent(ReadingProgress.self, forKey: .reading)
        dictated = try? container.decodeIfPresent(Dictation.self, forKey: .dictated)
    }

    var isCapturing: Bool {
        state == "listening" || state == "recording"
    }

    var isExchangeActive: Bool {
        isCapturing || state == "speaking" || state == "transcribing"
    }
}

/// Spoken text handed back for the composer.
///
/// `id` is the whole idempotency mechanism: state republishes several times a
/// second, so appending on sight of `text` would append it on every frame. The
/// app applies an id it has not seen and ignores every frame after.
struct Dictation: Decodable, Equatable, Sendable {
    let text: String
    let id: Int
}

struct ReadingProgress: Decodable, Equatable, Sendable {
    /// Speech text: markdown stripped and flattened. `spokenChars` indexes this.
    let text: String
    let spokenChars: Int
    /// The same reply with markdown intact. Absent on older daemons.
    let markdown: String?

    init(text: String = "", spokenChars: Int = 0, markdown: String? = nil) {
        self.text = text
        self.spokenChars = spokenChars
        self.markdown = markdown
    }

    private enum CodingKeys: String, CodingKey {
        case text
        case spokenChars
        case markdown
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = (try? container.decodeIfPresent(String.self, forKey: .text)) ?? ""
        spokenChars = Self.decodeCharacterCount(from: container)
        markdown = (try? container.decodeIfPresent(String.self, forKey: .markdown)) ?? nil
    }

    /// Text to RENDER, preferring the markdown copy when the daemon sends one.
    var displayText: String {
        guard let markdown, !markdown.isEmpty else { return text }
        return markdown
    }

    /// Reading progress as a fraction. Markdown syntax has no spoken counterpart,
    /// so a character offset from the speech text cannot index the rendered one.
    var spokenFraction: Double {
        guard !text.isEmpty else { return 0 }
        return min(1, max(0, Double(spokenChars) / Double(text.count)))
    }

    fileprivate static func decodeCharacterCount<Key: CodingKey>(
        from container: KeyedDecodingContainer<Key>,
        forKey key: Key
    ) -> Int {
        if let count = try? container.decodeIfPresent(Int.self, forKey: key) {
            return max(0, count)
        }
        if let number = try? container.decodeIfPresent(Double.self, forKey: key),
           number.isFinite {
            if number <= 0 { return 0 }
            if number >= Double(Int.max) { return Int.max }
            return Int(number)
        }
        if let text = try? container.decodeIfPresent(String.self, forKey: key),
           let count = Int(text) {
            return max(0, count)
        }
        return 0
    }

    private static func decodeCharacterCount(
        from container: KeyedDecodingContainer<CodingKeys>
    ) -> Int {
        decodeCharacterCount(from: container, forKey: .spokenChars)
    }
}


/// One message in a session's conversation.
///
/// The daemon publishes an ordered stack of these instead of a single flattened
/// reply. `id` is stable across renders on purpose: SwiftUI rebuilds and
/// re-measures any row whose identity changes, so stable identity is what lets
/// the stack append without disturbing what is already on screen.
struct ConversationItem: Decodable, Equatable, Sendable, Identifiable {
    enum Kind: String, Decodable, Sendable {
        case user, assistant, thinking, tool, review
        /// A future daemon may add kinds; an unknown one renders as plain text
        /// rather than dropping the message.
        static func parse(_ raw: String?) -> Kind { Kind(rawValue: raw ?? "") ?? .assistant }
    }

    struct Tool: Decodable, Equatable, Sendable {
        /// What sort of operation this was. The daemon maps both agents' tool
        /// names onto one vocabulary, so the app never learns either — it only
        /// decides how a "file change" or a "command" should look.
        enum Kind: String, Decodable, Sendable {
            case commandExecution = "command_execution"
            case fileChange = "file_change"
            case fileRead = "file_read"
            case search
            case webSearch = "web_search"
            case subagent
            case plan
            case question
            case mcpToolCall = "mcp_tool_call"
            case unknown

            var symbol: String {
                switch self {
                case .commandExecution: return "terminal"
                case .fileChange: return "square.and.pencil"
                case .fileRead: return "doc.text"
                case .search: return "magnifyingglass"
                case .webSearch: return "globe"
                case .subagent: return "person.2"
                case .plan: return "checklist"
                case .question: return "questionmark.circle"
                case .mcpToolCall: return "wrench.adjustable"
                case .unknown: return "circle.dashed"
                }
            }
        }

        var name = ""
        var kind = Kind.unknown
        var status = "running"
        var result: String?

        private enum CodingKeys: String, CodingKey { case name, kind, status, result }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
            // An unrecognised kind is not a decode failure. A newer daemon may
            // name a kind this build has never heard of, and one unknown tool
            // must not cost the whole conversation.
            kind = (try? c.decodeIfPresent(Kind.self, forKey: .kind)) ?? .unknown
            status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "running"
            result = try? c.decodeIfPresent(String.self, forKey: .result)
        }
    }

    /// One line of a plan. Agents emit these constantly; as a generic tool row
    /// they were noise, as a checklist they are the clearest answer on screen
    /// to "what is it actually doing".
    struct PlanStep: Decodable, Equatable, Sendable, Identifiable {
        enum Status: String, Decodable, Sendable { case pending, running, done }
        var text = ""
        var status = Status.pending
        var id: String { "\(status.rawValue):\(text)" }

        private enum CodingKeys: String, CodingKey { case text, status }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
            status = (try? c.decodeIfPresent(Status.self, forKey: .status)) ?? .pending
        }
    }

    /// The lines an edit moved. Not a unified diff: in a stack you are scanning
    /// rather than reviewing, the changed lines ARE the story, and context lines
    /// would multiply what crosses the relay for something nobody reads here.
    struct FileChange: Decodable, Equatable, Sendable {
        var file = ""
        var removed: [String] = []
        var added: [String] = []
        var truncated = false

        private enum CodingKeys: String, CodingKey { case file, removed, added, truncated }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            file = (try? c.decodeIfPresent(String.self, forKey: .file)) ?? ""
            removed = (try? c.decodeIfPresent([String].self, forKey: .removed)) ?? []
            added = (try? c.decodeIfPresent([String].self, forKey: .added)) ?? []
            truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
        }
    }

    /// Keeping options structured lets every surface answer the same prompt
    /// without scraping labels back out of rendered prose.
    struct AgentQuestion: Decodable, Equatable, Sendable {
        struct Option: Decodable, Equatable, Sendable {
            var label = ""
            var description: String?

            private enum CodingKeys: String, CodingKey { case label, description }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
                description = try? c.decodeIfPresent(String.self, forKey: .description)
            }
        }

        var header = ""
        var question = ""
        var options: [Option] = []
        var multiSelect = false

        private enum CodingKeys: String, CodingKey {
            case header, question, options, multiSelect
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            header = (try? c.decodeIfPresent(String.self, forKey: .header)) ?? ""
            question = (try? c.decodeIfPresent(String.self, forKey: .question)) ?? ""
            options = (try? c.decodeIfPresent([Option].self, forKey: .options)) ?? []
            multiSelect = (try? c.decodeIfPresent(Bool.self, forKey: .multiSelect)) ?? false
        }
    }

    let id: String
    let rev: Int
    let kind: Kind
    let text: String
    let at: TimeInterval?
    let tool: Tool?
    let plan: [PlanStep]?
    let change: FileChange?
    let question: AgentQuestion?

    private enum CodingKeys: String, CodingKey {
        case id, rev, kind, text, at, tool, plan, change, question
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        rev = (try? c.decodeIfPresent(Int.self, forKey: .rev)) ?? 0
        kind = Kind.parse(try? c.decodeIfPresent(String.self, forKey: .kind))
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        at = try? c.decodeIfPresent(TimeInterval.self, forKey: .at)
        tool = try? c.decodeIfPresent(Tool.self, forKey: .tool)
        plan = try? c.decodeIfPresent([PlanStep].self, forKey: .plan)
        change = try? c.decodeIfPresent(FileChange.self, forKey: .change)
        question = try? c.decodeIfPresent(AgentQuestion.self, forKey: .question)
    }
}

/// A session's conversation, windowed and capped by the daemon for the wire.
struct Conversation: Decodable, Equatable, Sendable {
    var sessionId = ""
    var items: [ConversationItem] = []
    /// Older messages exist above the window, so a viewer can say so.
    var truncated = false

    private enum CodingKeys: String, CodingKey { case sessionId, items, truncated }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = (try? c.decodeIfPresent(String.self, forKey: .sessionId)) ?? ""
        items = (try? c.decodeIfPresent([ConversationItem].self, forKey: .items)) ?? []
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
    }
}

struct ConversationReply: Decodable, Equatable, Sendable {
    let sessionId: String
    let text: String
    let spokenChars: Int
    let markdown: String?

    private enum CodingKeys: String, CodingKey {
        case sessionId
        case text
        case spokenChars
        case markdown
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = (try? container.decodeIfPresent(String.self, forKey: .sessionId)) ?? ""
        text = (try? container.decodeIfPresent(String.self, forKey: .text)) ?? ""
        spokenChars = ReadingProgress.decodeCharacterCount(
            from: container,
            forKey: .spokenChars
        )
        markdown = (try? container.decodeIfPresent(String.self, forKey: .markdown)) ?? nil
    }

    var displayText: String {
        guard let markdown, !markdown.isEmpty else { return text }
        return markdown
    }

    var spokenFraction: Double {
        guard !text.isEmpty else { return 0 }
        return min(1, max(0, Double(spokenChars) / Double(text.count)))
    }
}

enum RowStatus: Equatable, Sendable {
    case working
    case waiting
    case needs
    case review
    case unknown

    var isReview: Bool {
        self == .review
    }
}

extension RowStatus: Decodable {
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = (try? container.decode(String.self))?.lowercased()

        switch value {
        case "working":
            self = .working
        case "waiting":
            self = .waiting
        case "needs":
            self = .needs
        case "review":
            self = .review
        default:
            self = .unknown
        }
    }
}

struct ReviewInfo: Decodable, Equatable, Sendable {
    let summary: String
    let link: String?
    /// Epoch milliseconds supplied by newer daemon snapshots.
    let at: Double?

    private enum CodingKeys: String, CodingKey {
        case summary
        case link
        case at
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        summary = (try? container.decodeIfPresent(String.self, forKey: .summary)) ?? ""
        link = try? container.decodeIfPresent(String.self, forKey: .link)
        at = Self.decodeTimestamp(from: container)
    }

    private static func decodeTimestamp(
        from container: KeyedDecodingContainer<CodingKeys>
    ) -> Double? {
        if let number = try? container.decodeIfPresent(Double.self, forKey: .at),
           number.isFinite {
            return number
        }
        if let text = try? container.decodeIfPresent(String.self, forKey: .at) {
            let number = Double(text)
            return number?.isFinite == true ? number : nil
        }
        return nil
    }
}

struct SessionRow: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    /// This is presentation metadata, not an implementation choice: it answers
    /// which agent the person is about to address.
    let backend: String?
    let context: SessionContext?
    let status: RowStatus?
    /// Epoch milliseconds for the status currently visible on this row.
    let at: Double?
    let needsResponse: Bool
    let detail: String?
    let review: ReviewInfo?
    let paused: Bool
    let live: String?
    let active: Bool
    let snippet: String?
    let transcriptPath: String?
    let voice: String?
    let prioritized: Bool
    let navSelected: Bool

    private enum CodingKeys: String, CodingKey {
        case id
        case label
        case backend
        case context
        case status
        case at
        case needsResponse
        case detail
        case review
        case paused
        case live
        case active
        case snippet
        case transcriptPath
        case voice
        case prioritized
        case navSelected
    }

    init(
        id: String,
        label: String,
        backend: String? = nil,
        context: SessionContext? = nil,
        status: RowStatus?,
        at: Double?,
        needsResponse: Bool,
        detail: String?,
        review: ReviewInfo?,
        paused: Bool,
        live: String?,
        active: Bool,
        snippet: String?,
        transcriptPath: String?,
        voice: String?,
        prioritized: Bool,
        navSelected: Bool
    ) {
        self.id = id
        self.label = label
        self.backend = backend
        self.context = context
        self.status = status
        self.at = at
        self.needsResponse = needsResponse
        self.detail = detail
        self.review = review
        self.paused = paused
        self.live = live
        self.active = active
        self.snippet = snippet
        self.transcriptPath = transcriptPath
        self.voice = voice
        self.prioritized = prioritized
        self.navSelected = navSelected
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        id = try container.decode(String.self, forKey: .id)
        label = (try? container.decodeIfPresent(String.self, forKey: .label)) ?? id
        backend = try? container.decodeIfPresent(String.self, forKey: .backend)
        context = try? container.decodeIfPresent(SessionContext.self, forKey: .context)
        status = try? container.decodeIfPresent(RowStatus.self, forKey: .status)
        at = Timestamp.decode(from: container, forKey: .at)
        needsResponse =
            (try? container.decodeIfPresent(Bool.self, forKey: .needsResponse)) ?? false
        detail = try? container.decodeIfPresent(String.self, forKey: .detail)
        review = try? container.decodeIfPresent(ReviewInfo.self, forKey: .review)
        paused = (try? container.decodeIfPresent(Bool.self, forKey: .paused)) ?? false
        live = try? container.decodeIfPresent(String.self, forKey: .live)
        active = (try? container.decodeIfPresent(Bool.self, forKey: .active)) ?? false
        snippet = try? container.decodeIfPresent(String.self, forKey: .snippet)
        transcriptPath = try? container.decodeIfPresent(String.self, forKey: .transcriptPath)
        voice = try? container.decodeIfPresent(String.self, forKey: .voice)
        prioritized =
            (try? container.decodeIfPresent(Bool.self, forKey: .prioritized)) ?? false
        navSelected =
            (try? container.decodeIfPresent(Bool.self, forKey: .navSelected)) ?? false
    }

    func replacingLabel(with label: String) -> SessionRow {
        SessionRow(
            id: id,
            label: label,
            backend: backend,
            context: context,
            status: status,
            at: at,
            needsResponse: needsResponse,
            detail: detail,
            review: review,
            paused: paused,
            live: live,
            active: active,
            snippet: snippet,
            transcriptPath: transcriptPath,
            voice: voice,
            prioritized: prioritized,
            navSelected: navSelected
        )
    }
}

struct SessionContext: Decodable, Equatable, Sendable {
    let usedTokens: Int
    let limitTokens: Int

    var fraction: Double {
        guard limitTokens > 0 else { return 0 }
        return min(1, max(0, Double(usedTokens) / Double(limitTokens)))
    }

    private enum CodingKeys: String, CodingKey { case usedTokens, limitTokens }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        usedTokens = max(0, (try? container.decodeIfPresent(Int.self, forKey: .usedTokens)) ?? 0)
        limitTokens = max(0, (try? container.decodeIfPresent(Int.self, forKey: .limitTokens)) ?? 0)
    }
}

private struct LossyDecodable<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}

private enum Timestamp {
    static func decode<Key: CodingKey>(
        from container: KeyedDecodingContainer<Key>,
        forKey key: Key
    ) -> Double? {
        if let number = try? container.decodeIfPresent(Double.self, forKey: key),
           number.isFinite {
            return number
        }
        if let text = try? container.decodeIfPresent(String.self, forKey: key),
           let number = Double(text),
           number.isFinite {
            return number
        }
        return nil
    }
}
