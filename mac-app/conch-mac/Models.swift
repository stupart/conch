import Foundation

struct PublishedState: Decodable, Equatable, Sendable {
    let v: Int
    let ts: TimeInterval
    let mode: ModeState
    let live: LiveState
    let reply: ConversationReply?
    let preview: ConversationReply?
    let rows: [SessionRow]
    let dismissed: [String]

    private enum CodingKeys: String, CodingKey {
        case v
        case ts
        case mode
        case live
        case reply
        case preview
        case rows
        case dismissed
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decode(Int.self, forKey: .v)

        guard version == 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .v,
                in: container,
                debugDescription: "Unsupported conch state version \(version)"
            )
        }

        v = version
        rows = try container.decode([SessionRow].self, forKey: .rows)
        ts = (try? container.decodeIfPresent(TimeInterval.self, forKey: .ts)) ?? 0
        mode = (try? container.decodeIfPresent(ModeState.self, forKey: .mode)) ?? ModeState()
        live = (try? container.decodeIfPresent(LiveState.self, forKey: .live)) ?? LiveState()
        reply = try? container.decodeIfPresent(ConversationReply.self, forKey: .reply)
        preview = try? container.decodeIfPresent(ConversationReply.self, forKey: .preview)
        dismissed = (try? container.decodeIfPresent([String].self, forKey: .dismissed)) ?? []
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
    let text: String
    let spokenChars: Int

    init(text: String = "", spokenChars: Int = 0) {
        self.text = text
        self.spokenChars = spokenChars
    }

    private enum CodingKeys: String, CodingKey {
        case text
        case spokenChars
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = (try? container.decodeIfPresent(String.self, forKey: .text)) ?? ""
        spokenChars = Self.decodeCharacterCount(from: container)
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

struct ConversationReply: Decodable, Equatable, Sendable {
    let sessionId: String
    let text: String
    let spokenChars: Int

    private enum CodingKeys: String, CodingKey {
        case sessionId
        case text
        case spokenChars
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = (try? container.decodeIfPresent(String.self, forKey: .sessionId)) ?? ""
        text = (try? container.decodeIfPresent(String.self, forKey: .text)) ?? ""
        spokenChars = ReadingProgress.decodeCharacterCount(
            from: container,
            forKey: .spokenChars
        )
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
