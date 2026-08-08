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
    var reply: Reply?
    /// Keyed by session id — the phone looks up whichever session it is showing.
    var conversations: [String: Conversation] = [:]

    struct Mode: Decodable, Equatable {
        var muted = false
        var paused = false
        var holding = 0

        private enum CodingKeys: String, CodingKey { case muted, paused, holding }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            muted = (try? c.decodeIfPresent(Bool.self, forKey: .muted)) ?? false
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
        var id = ""
        var label = ""
        var status = "working"
        var detail: String?
        var at: Double = 0
        var live: String?
        var muted = false
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
            case id, label, status, detail, at, live, muted, paused, review
        }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
            label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
            status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "working"
            detail = try? c.decodeIfPresent(String.self, forKey: .detail)
            at = (try? c.decodeIfPresent(Double.self, forKey: .at)) ?? 0
            live = try? c.decodeIfPresent(String.self, forKey: .live)
            muted = (try? c.decodeIfPresent(Bool.self, forKey: .muted)) ?? false
            paused = (try? c.decodeIfPresent(Bool.self, forKey: .paused)) ?? false
            review = try? c.decodeIfPresent(Review.self, forKey: .review)
        }
    }

    private enum CodingKeys: String, CodingKey { case v, ts, mode, live, rows, reply, conversations }

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
        reply = try? c.decodeIfPresent(Reply.self, forKey: .reply)
        conversations = (try? c.decodeIfPresent([String: Conversation].self, forKey: .conversations)) ?? [:]
    }
}

private struct AnyIgnored: Decodable {}

/// The Mac ledger's glyph vocabulary, one for one.
enum StatusMark {
    case working, waiting, needs, review, muted, paused, micOpen, speaking, idle

    init(row: PublishedState.Row) {
        let wantsUser = row.status == "waiting" || row.status == "needs"
        if row.review != nil { self = .review; return }
        if row.muted, !wantsUser { self = .muted; return }
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
        case .muted: "speaker.slash.fill"
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
        case .muted, .paused: Palette.textDim
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
        case .waiting, .needs, .review, .micOpen, .speaking, .muted, .paused: true
        }
    }

    var meaning: String {
        switch self {
        case .working: "Working"
        case .waiting: "Waiting for you"
        case .needs: "Needs an answer"
        case .review: "Has work to look at"
        case .muted: "Muted"
        case .paused: "Paused"
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
        var name = ""
        var status = "running"
        var result: String?
        private enum CodingKeys: String, CodingKey { case name, status, result }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
            status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "running"
            result = try? c.decodeIfPresent(String.self, forKey: .result)
        }
    }

    var id = ""
    var rev = 0
    /// Unknown kinds render as plain text rather than vanishing.
    var kind = "assistant"
    var text = ""
    var tool: Tool?

    private enum CodingKeys: String, CodingKey { case id, rev, kind, text, tool }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        rev = (try? c.decodeIfPresent(Int.self, forKey: .rev)) ?? 0
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "assistant"
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        tool = try? c.decodeIfPresent(Tool.self, forKey: .tool)
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
