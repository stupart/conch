import Foundation
import SwiftUI

/// The published state, decoded leniently: unknown fields ignored, missing
/// fields defaulted, `v` a floor not an equality — failing closed on a newer
/// daemon is indistinguishable from a dead one, and the Mac app learned that
/// lesson the hard way.
struct PublishedState: Decodable, Equatable {
    var v: Int = 1
    var ts: Double = 0
    var mode = Mode()
    var live = Live()
    var rows: [Row] = []
    var dismissedRows: [DismissedRow] = []
    var reply: Reply?
    /// Keyed by session id — the phone looks up whichever session it is showing.
    var conversations: [String: Conversation] = [:]

    struct Mode: Decodable, Equatable {
        var paused = false
        var holding = 0

        private enum CodingKeys: String, CodingKey { case paused, holding }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            paused = (try? c.decodeIfPresent(Bool.self, forKey: .paused)) ?? false
            holding = (try? c.decodeIfPresent(Int.self, forKey: .holding)) ?? 0
        }
    }

    struct Live: Decodable, Equatable {
        var state = "idle"
        var label = ""
        var partial = ""
        var reading: Reading?

        struct Reading: Decodable, Equatable {
            var text = ""
            var spokenChars = 0
            var markdown: String?

            private enum CodingKeys: String, CodingKey { case text, spokenChars, markdown }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
                spokenChars = (try? c.decodeIfPresent(Int.self, forKey: .spokenChars)) ?? 0
                markdown = try? c.decodeIfPresent(String.self, forKey: .markdown)
            }
        }

        private enum CodingKeys: String, CodingKey { case state, label, partial, reading }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "idle"
            label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
            partial = (try? c.decodeIfPresent(String.self, forKey: .partial)) ?? ""
            reading = try? c.decodeIfPresent(Reading.self, forKey: .reading)
        }
    }

    struct Reply: Decodable, Equatable {
        var sessionId = ""
        var text = ""
        var spokenChars = 0
        var markdown: String?
        /// The daemon caps published replies at 4,000 chars and keeps the TAIL,
        /// so this arrives with its beginning missing. Indistinguishable from a
        /// complete short reply by looking — hence the flag, and hence /reply.
        var truncated = false

        private enum CodingKeys: String, CodingKey {
            case sessionId, text, spokenChars, markdown, truncated
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            sessionId = (try? c.decodeIfPresent(String.self, forKey: .sessionId)) ?? ""
            text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
            spokenChars = (try? c.decodeIfPresent(Int.self, forKey: .spokenChars)) ?? 0
            markdown = try? c.decodeIfPresent(String.self, forKey: .markdown)
            truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
        }

        var displayText: String {
            guard let markdown, !markdown.isEmpty else { return text }
            return markdown
        }
    }

    struct Row: Decodable, Equatable, Identifiable {
        struct ContextUsage: Decodable, Equatable {
            var usedTokens = 0
            var limitTokens = 0

            private enum CodingKeys: String, CodingKey { case usedTokens, limitTokens }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                usedTokens = max(0, (try? c.decodeIfPresent(Int.self, forKey: .usedTokens)) ?? 0)
                limitTokens = max(0, (try? c.decodeIfPresent(Int.self, forKey: .limitTokens)) ?? 0)
            }

            var proportion: Double {
                guard limitTokens > 0 else { return 0 }
                return min(1, Double(usedTokens) / Double(limitTokens))
            }
        }

        var id = ""
        var label = ""
        var status = "working"
        /// Which agent runs this session; decides how an image is sized for it.
        var backend: String?
        /// The quality boundary that decides whether this session should keep
        /// going. Absent on older daemons rather than guessed by the client.
        var context: ContextUsage?
        var detail: String?
        var at: Double = 0
        var live: String?
        var paused = false
        var review: Review?

        struct Review: Decodable, Equatable {
            var summary = ""
            var link: String?
            var at: Double?

            private enum CodingKeys: String, CodingKey { case summary, link, at }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? ""
                link = try? c.decodeIfPresent(String.self, forKey: .link)
                at = try? c.decodeIfPresent(Double.self, forKey: .at)
            }
        }

        private enum CodingKeys: String, CodingKey {
            case id, label, status, backend, context, detail, at, live, paused, review
        }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
            label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
            status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "working"
            backend = try? c.decodeIfPresent(String.self, forKey: .backend)
            context = try? c.decodeIfPresent(ContextUsage.self, forKey: .context)
            detail = try? c.decodeIfPresent(String.self, forKey: .detail)
            at = (try? c.decodeIfPresent(Double.self, forKey: .at)) ?? 0
            live = try? c.decodeIfPresent(String.self, forKey: .live)
            paused = (try? c.decodeIfPresent(Bool.self, forKey: .paused)) ?? false
            review = try? c.decodeIfPresent(Review.self, forKey: .review)
        }
    }

    /// A session hidden from the ledger but still running on the Mac.
    ///
    /// Labels travel with ids because restoration is a human choice. An opaque
    /// id is enough for the command and not enough to decide which session to
    /// bring back.
    struct DismissedRow: Decodable, Equatable, Identifiable {
        var id: String
        var label: String

        private enum CodingKeys: String, CodingKey { case id, label }

        init(id: String, label: String) {
            self.id = id
            self.label = label
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
            let decodedLabel = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
            label = decodedLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? String(id.prefix(8))
                : decodedLabel
        }
    }

    private enum CodingKeys: String, CodingKey {
        case v, ts, mode, live, rows, dismissed, dismissedRows, reply, conversations
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = (try? c.decodeIfPresent(Int.self, forKey: .v)) ?? 1
        ts = (try? c.decodeIfPresent(Double.self, forKey: .ts)) ?? 0
        mode = (try? c.decodeIfPresent(Mode.self, forKey: .mode)) ?? Mode()
        live = (try? c.decodeIfPresent(Live.self, forKey: .live)) ?? Live()
        // Element-by-element, so one malformed row cannot blank the ledger.
        if var rowsContainer = try? c.nestedUnkeyedContainer(forKey: .rows) {
            var decoded: [Row] = []
            while !rowsContainer.isAtEnd {
                if let row = try? rowsContainer.decode(Row.self) {
                    decoded.append(row)
                } else {
                    _ = try? rowsContainer.decode(AnyIgnored.self)
                }
            }
            rows = decoded
        }
        // Restore must remain reachable even if one entry from a newer daemon is
        // malformed. Decode independently, then fill any ids supplied by older
        // publishers that did not yet include labels.
        var decodedDismissed: [DismissedRow] = []
        if var dismissedContainer = try? c.nestedUnkeyedContainer(forKey: .dismissedRows) {
            while !dismissedContainer.isAtEnd {
                if let row = try? dismissedContainer.decode(DismissedRow.self) {
                    if !row.id.isEmpty {
                        decodedDismissed.append(row)
                    }
                    // A valid-but-empty row was consumed just as surely as a
                    // useful one. Falling through would discard its successor.
                    continue
                }
                _ = try? dismissedContainer.decode(AnyIgnored.self)
            }
        }
        var seenDismissed = Set(decodedDismissed.map(\.id))
        let legacyDismissed = (try? c.decodeIfPresent([String].self, forKey: .dismissed)) ?? []
        for id in legacyDismissed where !id.isEmpty && seenDismissed.insert(id).inserted {
            decodedDismissed.append(DismissedRow(id: id, label: String(id.prefix(8))))
        }
        dismissedRows = decodedDismissed
        reply = try? c.decodeIfPresent(Reply.self, forKey: .reply)
        conversations = (try? c.decodeIfPresent([String: Conversation].self, forKey: .conversations)) ?? [:]
    }
}

private struct AnyIgnored: Decodable {}

/// The Mac ledger's glyph vocabulary, one for one.
enum StatusMark {
    case working, waiting, needs, review, paused, micOpen, speaking, idle

    init(row: PublishedState.Row) {
        let wantsUser = row.status == "waiting" || row.status == "needs"
        if row.review != nil { self = .review; return }
        if row.paused, !wantsUser { self = .paused; return }
        switch row.live {
        case "listening", "recording": self = .micOpen
        case "speaking": self = .speaking
        default:
            switch row.status {
            case "waiting": self = .waiting
            case "needs": self = .needs
            default: self = .working
            }
        }
    }

    var symbol: String {
        switch self {
        case .working: "circle.fill"
        case .waiting: "circle.inset.filled"
        case .needs: "exclamationmark.circle.fill"
        case .review: "star.fill"
        case .paused: "pause.fill"
        case .micOpen: "mic.fill"
        case .speaking: "play.fill"
        case .idle: "circle.dotted"
        }
    }

    var color: Color {
        switch self {
        case .working, .speaking: Palette.working
        case .waiting: Palette.waiting
        case .needs: Palette.needs
        case .review: Palette.review
        case .paused: Palette.textDim
        case .micOpen: Palette.micOpen
        case .idle: Palette.textFaint
        }
    }

    /// Whether the ledger spells this state out beside the glyph.
    ///
    /// Working is the resting state and by far the most common; printing it
    /// on every quiet row is the kind of repetition that teaches you to stop
    /// reading the column entirely. Everything here either wants you or is
    /// happening right now.
    var showsMeaningInLedger: Bool {
        switch self {
        case .working, .idle: false
        case .waiting, .needs, .review, .micOpen, .speaking, .paused: true
        }
    }

    var meaning: String {
        switch self {
        case .working: "Working"
        case .waiting: "Waiting for you"
        case .needs: "Needs an answer"
        case .review: "Has work to look at"
        case .paused: "Manual"
        case .micOpen: "Mic open"
        case .speaking: "Reading aloud"
        case .idle: "Idle"
        }
    }
}

func relativeAge(epochMilliseconds: Double, now: Date = Date()) -> String? {
    guard epochMilliseconds.isFinite, epochMilliseconds > 0 else { return nil }
    let elapsed = max(0, now.timeIntervalSince1970 - epochMilliseconds / 1_000)
    if elapsed < 60 { return "<1m" }
    if elapsed < 3_600 { return "\(Int(elapsed / 60))m" }
    if elapsed < 86_400 { return "\(Int(elapsed / 3_600))h" }
    return "\(Int(elapsed / 86_400))d"
}

/// One message in a session's conversation — the shape the daemon publishes for
/// every visible session, so the phone never depends on which one the Mac
/// happens to be showing.
struct ConversationItem: Decodable, Equatable, Sendable, Identifiable {
    struct Tool: Decodable, Equatable, Sendable {
        /// What sort of operation this was. The daemon maps both agents' tool
        /// names onto one vocabulary, so the phone never learns either — it
        /// only decides how a "file change" or a "command" should look.
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

            /// The Mac's per-kind glyph vocabulary, one for one.
            var symbol: String {
                switch self {
                case .commandExecution: "terminal"
                case .fileChange: "square.and.pencil"
                case .fileRead: "doc.text"
                case .search: "magnifyingglass"
                case .webSearch: "globe"
                case .subagent: "person.2"
                case .plan: "checklist"
                case .question: "questionmark.circle"
                case .mcpToolCall: "wrench.adjustable"
                case .unknown: "circle.dashed"
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

    /// The lines an edit moved. Not a unified diff: in a stack you scan rather
    /// than review, the changed lines ARE the story, and context lines would
    /// multiply what crosses the relay for something nobody reads here.
    struct FileChange: Decodable, Equatable, Sendable {
        var file = ""
        var removed: [String] = []
        var added: [String] = []
        /// The daemon caps how many lines it carries, so the counts above are
        /// a floor, not the size of the change.
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

    /// A question the agent is blocked on: a header naming the decision, the
    /// question, and options the person picks between. The one row in a
    /// conversation that is waiting on YOU rather than reporting what happened.
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
        /// More than one answer may be chosen.
        var multiSelect = false
        private enum CodingKeys: String, CodingKey { case header, question, options, multiSelect }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            header = (try? c.decodeIfPresent(String.self, forKey: .header)) ?? ""
            question = (try? c.decodeIfPresent(String.self, forKey: .question)) ?? ""
            options = (try? c.decodeIfPresent([Option].self, forKey: .options)) ?? []
            multiSelect = (try? c.decodeIfPresent(Bool.self, forKey: .multiSelect)) ?? false
        }
    }

    var id = ""
    var rev = 0
    /// Unknown kinds render as plain text rather than vanishing.
    var kind = "assistant"
    var text = ""
    var tool: Tool?
    /// Present when this item IS a plan, so the stack renders a checklist.
    var plan: [PlanStep]?
    /// Present when this item changed a file, so the stack can show the lines.
    var change: FileChange?
    /// Present when the agent is WAITING on you to choose.
    var question: AgentQuestion?

    private enum CodingKeys: String, CodingKey { case id, rev, kind, text, tool, plan, change, question }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        rev = (try? c.decodeIfPresent(Int.self, forKey: .rev)) ?? 0
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "assistant"
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        tool = try? c.decodeIfPresent(Tool.self, forKey: .tool)
        plan = try? c.decodeIfPresent([PlanStep].self, forKey: .plan)
        change = try? c.decodeIfPresent(FileChange.self, forKey: .change)
        question = try? c.decodeIfPresent(AgentQuestion.self, forKey: .question)
    }
}

struct Conversation: Decodable, Equatable, Sendable {
    var sessionId = ""
    var items: [ConversationItem] = []
    var truncated = false
    private enum CodingKeys: String, CodingKey { case sessionId, items, truncated }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = (try? c.decodeIfPresent(String.self, forKey: .sessionId)) ?? ""
        items = (try? c.decodeIfPresent([ConversationItem].self, forKey: .items)) ?? []
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
    }
}
