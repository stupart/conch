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
    let muted: Bool
    let paused: Bool
    let holding: Int

    init(muted: Bool = false, paused: Bool = false, holding: Int = 0) {
        self.muted = muted
        self.paused = paused
        self.holding = holding
    }

    private enum CodingKeys: String, CodingKey {
        case muted
        case paused
        case holding
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        muted = (try? container.decodeIfPresent(Bool.self, forKey: .muted)) ?? false
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

    init(
        state: String = "idle",
        label: String = "",
        partial: String = "",
        transcriptPrefix: String = "",
        reading: ReadingProgress? = nil
    ) {
        self.state = state
        self.label = label
        self.partial = partial
        self.transcriptPrefix = transcriptPrefix
        self.reading = reading
    }

    private enum CodingKeys: String, CodingKey {
        case state
        case label
        case partial
        case transcriptPrefix
        case reading
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = (try? container.decodeIfPresent(String.self, forKey: .state)) ?? "idle"
        label = (try? container.decodeIfPresent(String.self, forKey: .label)) ?? ""
        partial = (try? container.decodeIfPresent(String.self, forKey: .partial)) ?? ""
        transcriptPrefix =
            (try? container.decodeIfPresent(String.self, forKey: .transcriptPrefix)) ?? ""
        reading = try? container.decodeIfPresent(ReadingProgress.self, forKey: .reading)
    }

    var isCapturing: Bool {
        state == "listening" || state == "recording"
    }

    var isExchangeActive: Bool {
        isCapturing || state == "speaking" || state == "transcribing"
    }
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

    let id: String
    let rev: Int
    let kind: Kind
    let text: String
    let at: TimeInterval?
    let tool: Tool?

    private enum CodingKeys: String, CodingKey { case id, rev, kind, text, at, tool }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        rev = (try? c.decodeIfPresent(Int.self, forKey: .rev)) ?? 0
        kind = Kind.parse(try? c.decodeIfPresent(String.self, forKey: .kind))
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        at = try? c.decodeIfPresent(TimeInterval.self, forKey: .at)
        tool = try? c.decodeIfPresent(Tool.self, forKey: .tool)
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
    let status: RowStatus?
    /// Epoch milliseconds for the status currently visible on this row.
    let at: Double?
    let needsResponse: Bool
    let detail: String?
    let review: ReviewInfo?
    let paused: Bool
    let muted: Bool
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
        case status
        case at
        case needsResponse
        case detail
        case review
        case paused
        case muted
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
        status: RowStatus?,
        at: Double?,
        needsResponse: Bool,
        detail: String?,
        review: ReviewInfo?,
        paused: Bool,
        muted: Bool,
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
        self.status = status
        self.at = at
        self.needsResponse = needsResponse
        self.detail = detail
        self.review = review
        self.paused = paused
        self.muted = muted
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
        status = try? container.decodeIfPresent(RowStatus.self, forKey: .status)
        at = Timestamp.decode(from: container, forKey: .at)
        needsResponse =
            (try? container.decodeIfPresent(Bool.self, forKey: .needsResponse)) ?? false
        detail = try? container.decodeIfPresent(String.self, forKey: .detail)
        review = try? container.decodeIfPresent(ReviewInfo.self, forKey: .review)
        paused = (try? container.decodeIfPresent(Bool.self, forKey: .paused)) ?? false
        muted = (try? container.decodeIfPresent(Bool.self, forKey: .muted)) ?? false
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
            status: status,
            at: at,
            needsResponse: needsResponse,
            detail: detail,
            review: review,
            paused: paused,
            muted: muted,
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
