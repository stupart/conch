import Foundation

struct PublishedState: Decodable, Equatable, Sendable {
    let v: Int
    let ts: TimeInterval
    let mode: ModeState
    let live: LiveState
    let rows: [SessionRow]
    let dismissed: [String]

    private enum CodingKeys: String, CodingKey {
        case v
        case ts
        case mode
        case live
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

    init(state: String = "idle", label: String = "") {
        self.state = state
        self.label = label
    }

    private enum CodingKeys: String, CodingKey {
        case state
        case label
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = (try? container.decodeIfPresent(String.self, forKey: .state)) ?? "idle"
        label = (try? container.decodeIfPresent(String.self, forKey: .label)) ?? ""
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
    let at: TimeInterval?

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
    ) -> TimeInterval? {
        if let number = try? container.decodeIfPresent(TimeInterval.self, forKey: .at) {
            return number
        }
        if let text = try? container.decodeIfPresent(String.self, forKey: .at) {
            return TimeInterval(text)
        }
        return nil
    }
}

struct SessionRow: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    let status: RowStatus?
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
