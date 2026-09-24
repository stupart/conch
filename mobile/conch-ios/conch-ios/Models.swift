import Foundation
import SwiftUI

/// The published state, decoded leniently: unknown fields ignored, missing
/// fields defaulted, `v` a floor not an equality — failing closed on a newer
/// daemon is indistinguishable from a dead one, and the Mac app learned that
/// lesson the hard way.
struct PublishedState: Decodable, Equatable {
    var v: Int = 1
    var ownerDeviceId = ""
    var ts: Double = 0
    var mode = Mode()
    var live = Live()
    var rows: [Row] = []
    var dismissedRows: [DismissedRow] = []
    var reply: Reply?
    /// Keyed by session id — the phone looks up whichever session it is showing.
    var conversations: [String: Conversation] = [:]
    /// What became of recent sends, against the ids their senders gave them. This is how an
    /// outcome reaches a phone whose request was answered and closed twenty seconds before
    /// the delivery actually finished.
    var deliveries: [Delivery] = []
    /// What the Mac's daemon can do; absent from one older than these capabilities.
    var features: Features?

    struct Features: Decodable, Equatable {
        var deliverables: Int?
        var viewedState: Int?
    }

    struct Delivery: Decodable, Equatable {
        var opId = ""
        var sessionId = ""
        var at: Double = 0
        var receipt: InjectReceipt = .accepted

        private enum CodingKeys: String, CodingKey { case opId, sessionId, at }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            opId = (try? c.decodeIfPresent(String.self, forKey: .opId)) ?? ""
            sessionId = (try? c.decodeIfPresent(String.self, forKey: .sessionId)) ?? ""
            at = (try? c.decodeIfPresent(Double.self, forKey: .at)) ?? 0
            // The same fields the socket answer carries, read by the same rules.
            receipt = InjectReceipt.decode(try InjectReceipt.Wire(from: decoder))
        }
    }

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
        /// Every deliverable the session still holds, oldest first; `review` is the last.
        var reviews: [Review]?
        /// Why this row has no terminal to type into or close: a closed Codex
        /// thread, or one an app-server hosts. Older daemons never send it.
        var noTerminal: String?
        /// A Claude Code background job no window is attached to: it can be
        /// opened in Terminal on the Mac. Older daemons never send it.
        var attachable = false
        /// The folder this session runs in. The daemon has always sent it and the
        /// Mac has always read it; the phone simply never asked, so its list could
        /// not say which project a row belonged to.
        var cwd: String?
        /// The folder(s) its agent said it actually works in, when not `cwd`.
        var workDirs: [String]?
        /// The session this one runs inside (C4), or the one that started it (C15).
        /// Present on the wire since both landed; decoding it is what lets the phone
        /// nest a subagent under its parent instead of listing it as a peer.
        var parentSessionId: String?
        var startedBySessionId: String?
        /// Working only because agents it started are still running; its own turn is over, so
        /// it can be talked to. Older daemons never send it.
        var waitingOnAgents = false
        /// The permission prompt a row that needs you is showing. Older daemons never send it.
        var approval: PendingApproval?

        /// A permission prompt: which tool, and the one line that names what it wants to do.
        struct PendingApproval: Decodable, Equatable {
            var id = ""
            var name = ""
            var summary = ""
            /// False where conch can't press keys at the agent's dialog (Codex's).
            var answerable: Bool?
        }

        struct Review: Decodable, Equatable {
            var summary = ""
            var link: String?
            var at: Double?
            /// The identity the daemon minted at filing; absent from an older daemon.
            var id: String?
            /// When it was looked at, on whichever device looked; absent means nobody has.
            var viewedAt: Double?
            /// The one thing the agent asked you to check (`scene.inspect`). A build from before scenes never asks
            /// for the key, and a keyed container ignores keys it isn't asked for, so it decodes the review unchanged.
            var inspect: String?
            /// What the agent drew over it, in order (`scene.marks`, `features.deliverables` 3). Empty
            /// from an older daemon and from a review with none.
            var marks: [AgentMark] = []
            /// Which artifact this filing is a version of, which version, and what kind of thing it
            /// is (`features.deliverables` 2). Absent from an older daemon.
            var artifact: String?
            var version: Int?
            var kind: String?

            private enum CodingKeys: String, CodingKey { case summary, link, at, scene, id, viewedAt, artifact, version, kind }
            private struct Scene: Decodable {
                var inspect: String?
                var marks: AgentMark.List?
            }

            /// A synthetic review for a path the phone wants to open as a
            /// deliverable — a tapped file link, not anything the ledger
            /// filed. `init(from:)` being custom means the memberwise init
            /// Swift would otherwise synthesize doesn't exist; this is that,
            /// narrowed to the one field a tapped link actually has.
            init(link: String) {
                self.link = link
            }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? ""
                link = try? c.decodeIfPresent(String.self, forKey: .link)
                at = try? c.decodeIfPresent(Double.self, forKey: .at)
                id = try? c.decodeIfPresent(String.self, forKey: .id)
                viewedAt = try? c.decodeIfPresent(Double.self, forKey: .viewedAt)
                // A scene this build can't read is no scene, never a review that fails.
                let scene = try? c.decodeIfPresent(Scene.self, forKey: .scene)
                inspect = scene?.inspect
                marks = scene?.marks?.all ?? []
                artifact = try? c.decodeIfPresent(String.self, forKey: .artifact)
                version = try? c.decodeIfPresent(Int.self, forKey: .version)
                kind = try? c.decodeIfPresent(String.self, forKey: .kind)
            }
        }

        private enum CodingKeys: String, CodingKey {
            case id, label, status, backend, context, detail, at, live, paused, review, reviews, noTerminal, attachable
            case cwd, workDirs, parentSessionId, startedBySessionId, waitingOnAgents, approval
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
            reviews = try? c.decodeIfPresent([Review].self, forKey: .reviews)
            noTerminal = try? c.decodeIfPresent(String.self, forKey: .noTerminal)
            attachable = (try? c.decodeIfPresent(Bool.self, forKey: .attachable)) ?? false
            cwd = try? c.decodeIfPresent(String.self, forKey: .cwd)
            workDirs = try? c.decodeIfPresent([String].self, forKey: .workDirs)
            parentSessionId = try? c.decodeIfPresent(String.self, forKey: .parentSessionId)
            startedBySessionId = try? c.decodeIfPresent(String.self, forKey: .startedBySessionId)
            waitingOnAgents = (try? c.decodeIfPresent(Bool.self, forKey: .waitingOnAgents)) ?? false
            approval = try? c.decodeIfPresent(PendingApproval.self, forKey: .approval)
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
        case ownerDeviceId, deliveries
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = (try? c.decodeIfPresent(Int.self, forKey: .v)) ?? 1
        ownerDeviceId = (try? c.decodeIfPresent(String.self, forKey: .ownerDeviceId)) ?? ""
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
        // Element by element: one malformed outcome must not cost the others, which are the
        // only thing that can resolve a message someone is still holding.
        if var deliveriesContainer = try? c.nestedUnkeyedContainer(forKey: .deliveries) {
            var decoded: [Delivery] = []
            while !deliveriesContainer.isAtEnd {
                if let entry = try? deliveriesContainer.decode(Delivery.self) {
                    decoded.append(entry)
                    continue
                }
                _ = try? deliveriesContainer.decode(AnyIgnored.self)
            }
            deliveries = decoded
        }
    }
}

private struct AnyIgnored: Decodable {}

/// The Mac ledger's glyph vocabulary, one for one.
enum StatusMark {
    case working, waitingOnAgents, waiting, needs, review, paused, micOpen, speaking, idle

    init(row: PublishedState.Row) {
        let wantsUser = row.status == "waiting" || row.status == "needs"
        // The deliverable stays on a working row; the mark means it is waiting for you.
        if row.review != nil, row.status != "working" { self = .review; return }
        if row.paused, !wantsUser { self = .paused; return }
        switch row.live {
        case "listening", "recording": self = .micOpen
        case "speaking": self = .speaking
        default:
            switch row.status {
            case "waiting": self = .waiting
            case "needs": self = .needs
            // Its own turn is over and only its agents are running: talk to it.
            case "working" where row.waitingOnAgents: self = .waitingOnAgents
            default: self = .working
            }
        }
    }

    var symbol: String {
        switch self {
        case .working: "circle.fill"
        // Two figures: the agents it handed work to, still at it.
        case .waitingOnAgents: "person.2.fill"
        case .waiting: "circle.inset.filled"
        case .needs: "exclamationmark.circle.fill"
        case .review: "checkmark.circle.fill"
        case .paused: "pause.fill"
        case .micOpen: "mic.fill"
        case .speaking: "play.fill"
        case .idle: "circle.dotted"
        }
    }

    var color: Color {
        switch self {
        case .working, .speaking: Palette.working
        // The waiting colour: the same answer to "can I talk to it?"; the glyph says why.
        case .waiting, .waitingOnAgents: Palette.waiting
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
        case .waitingOnAgents, .waiting, .needs, .review, .micOpen, .speaking, .paused: true
        }
    }

    /// The meaning, short enough for the one line beside a glyph. Only this state's full
    /// sentence runs past that line, and it cut off at "you…" — the half that says why it matters.
    var caption: String {
        self == .waitingOnAgents ? "Agents working — talk to it" : meaning
    }

    var meaning: String {
        switch self {
        case .working: "Working"
        case .waitingOnAgents: "Waiting on its agents — you can talk to it"
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

/// One past session that could be restarted — a Claude or Codex transcript
/// the daemon's `resumable` control message already knows how to list.
///
/// Mirrors the Mac app's `ResumableSession` (`mac-app/conch-mac/ResumePickerView.swift`)
/// field for field and helper for helper, since both read the same wire shape.
struct ResumableSession: Decodable, Identifiable, Hashable {
    let sessionId: String
    let backend: String
    let label: String
    let cwd: String
    /// Epoch milliseconds. Used for "3h" and for ordering.
    let updatedAt: Double

    var id: String { sessionId }

    /// "now", "31m", "2h", "2d" — deliberately not `relativeAge(epochMilliseconds:)`
    /// above: that helper reads "<1m" for anything under a minute, where the Mac
    /// picker this is ported from reads "now". Two different questions ("how
    /// stale is this row?" vs "how long ago did I leave this?") that happen to
    /// share a unit ladder are still two different answers.
    var age: String {
        let seconds = max(0, Date().timeIntervalSince1970 - updatedAt / 1000)
        if seconds < 90 { return "now" }
        if seconds < 3_600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3_600))h" }
        return "\(Int(seconds / 86_400))d"
    }

    /// `cwd` is a path on the MAC that started this session, not on this phone
    /// — the phone's own sandboxed home directory has nothing to do with it.
    /// `/Users/<name>` is the one prefix every macOS user path carries, so it
    /// stands in here for the home directory the Mac app reads from
    /// `FileManager.default.homeDirectoryForCurrentUser`.
    ///
    /// Home itself is spelled out, same as the Mac: a bare "~" on its own line
    /// reads as missing data rather than as a place.
    var shortCwd: String { shortHomePath(cwd) }
}

/// `/Users/you/project` → `~/project`; home itself → `Home`. Shared by the
/// resume rows and the fresh-session folder list, so both say a place the
/// same way.
func shortHomePath(_ cwd: String) -> String {
    guard let range = cwd.range(of: #"^/Users/[^/]+"#, options: .regularExpression) else {
        return cwd
    }
    let home = String(cwd[range])
    if cwd == home { return "Home" }
    return "~" + cwd.dropFirst(home.count)
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

    struct Material: Decodable, Equatable, Sendable {
        var kind = "unknown"
        var title = "Material"
        var detail: String?
        var path: String?
        var dataUrl: String?
        var status: String?

        private enum CodingKeys: String, CodingKey {
            case kind, title, detail, path, dataUrl, status
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "unknown"
            title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? "Material"
            detail = try? c.decodeIfPresent(String.self, forKey: .detail)
            path = try? c.decodeIfPresent(String.self, forKey: .path)
            dataUrl = try? c.decodeIfPresent(String.self, forKey: .dataUrl)
            status = try? c.decodeIfPresent(String.self, forKey: .status)
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
        /// Where that file is, as the tool was given it. Empty from a daemon too old to send
        /// it. The phone only NAMES the file today, but the two apps decode one wire shape.
        var path = ""
        var removed: [String] = []
        var added: [String] = []
        /// The daemon caps how many lines it carries, so the counts above are
        /// a floor, not the size of the change.
        var truncated = false
        private enum CodingKeys: String, CodingKey { case file, path, removed, added, truncated }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            file = (try? c.decodeIfPresent(String.self, forKey: .file)) ?? ""
            path = (try? c.decodeIfPresent(String.self, forKey: .path)) ?? ""
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
    /// When the daemon saw this item, in epoch milliseconds.
    ///
    /// Only used to join the live window to the recorded one: a Codex snapshot row
    /// is keyed by a hash of its own text, which no recorded id can equal, so time
    /// is the only thing the two have in common (`HistorySnapshot.older`).
    var at: Double?
    var tool: Tool?
    /// Present when this item IS a plan, so the stack renders a checklist.
    var plan: [PlanStep]?
    /// Present when this item changed a file, so the stack can show the lines.
    var change: FileChange?
    /// Present when the agent is WAITING on you to choose.
    var question: AgentQuestion?
    /// Every question in the call when it asks more than one; `question` is the first.
    var questions: [AgentQuestion]?
    /// Machine-authored context shown as itself rather than under the user's name.
    var material: Material?

    private enum CodingKeys: String, CodingKey {
        case id, rev, kind, text, at, tool, plan, change, question, questions, material
    }

    /// What a question card shows: every question, or the one.
    var allQuestions: [AgentQuestion] { questions ?? question.map { [$0] } ?? [] }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        rev = (try? c.decodeIfPresent(Int.self, forKey: .rev)) ?? 0
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "assistant"
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        at = try? c.decodeIfPresent(Double.self, forKey: .at)
        tool = try? c.decodeIfPresent(Tool.self, forKey: .tool)
        plan = try? c.decodeIfPresent([PlanStep].self, forKey: .plan)
        change = try? c.decodeIfPresent(FileChange.self, forKey: .change)
        question = try? c.decodeIfPresent(AgentQuestion.self, forKey: .question)
        questions = try? c.decodeIfPresent([AgentQuestion].self, forKey: .questions)
        material = try? c.decodeIfPresent(Material.self, forKey: .material)
    }
}

/// One answer per question: the options picked (indexes into its options), or words of your own.
/// The daemon types it as the agent's picker keys; a label sent as text records option 1.
struct QuestionAnswer: Equatable {
    var choices: [Int]? = nil
    var text: String? = nil

    var wire: [String: Any] { choices.map { ["choices": $0] } ?? ["text": text ?? ""] }
}

struct Conversation: Decodable, Equatable, Sendable {
    var sessionId = ""
    var items: [ConversationItem] = []
    var truncated = false
    /// Two windows share this session and the daemon could not tell which
    /// branch is this one's, so this is both — said, rather than guessed (A8).
    var shared = false
    private enum CodingKeys: String, CodingKey { case sessionId, items, truncated, shared }

    /// An empty live window, for a session the daemon publishes none for. Recorded
    /// history is drawn inside the conversation stack and so needs one to draw in.
    init(sessionId: String) { self.sessionId = sessionId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = (try? c.decodeIfPresent(String.self, forKey: .sessionId)) ?? ""
        items = (try? c.decodeIfPresent([ConversationItem].self, forKey: .items)) ?? []
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
        shared = (try? c.decodeIfPresent(Bool.self, forKey: .shared)) ?? false
    }
}

/// A mark an agent drew over what it published (`scene.marks`): agent ink. The daemon checked it
/// (`checkReviewScene`); this only reads it. `frame` is what it is drawn on, and so what its
/// numbers mean: on a canvas or an image they are 0-1 of it from the top left, and a selector or a
/// quote names something in the linked page, which the renderer finds and marks itself, with no
/// numbers at all. There is no colour: every mark is drawn in the agent's own.
struct AgentMark: Decodable, Equatable, Sendable {
    enum Kind: String, Decodable, Sendable {
        case arrow, box, ellipse, highlight, text, pin, stroke
    }

    enum Frame: Equatable, Sendable {
        case canvas(String)
        case image(String)
        case selector(String)
        case quote(String)
    }

    let id: String
    let kind: Kind
    let frame: Frame
    /// An arrow's tail, or where a pin or text sits.
    let at: CGPoint?
    /// An arrow's head.
    let to: CGPoint?
    /// A box, ellipse or highlight: x, y, width, height.
    let rect: CGRect?
    /// A stroke's points; empty for every other kind.
    let pts: [CGPoint]
    /// The note beside the mark; for `text`, the text.
    let label: String?

    private enum CodingKeys: String, CodingKey { case id, kind, frame, at, to, rect, pts, label }
    private enum FrameKeys: String, CodingKey { case canvas, image, selector, quote }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        // A kind or a frame this build has no drawing for throws here, and `List` skips the mark.
        kind = try container.decode(Kind.self, forKey: .kind)
        let frames = try container.nestedContainer(keyedBy: FrameKeys.self, forKey: .frame)
        if let canvas = try frames.decodeIfPresent(String.self, forKey: .canvas) {
            frame = .canvas(canvas)
        } else if let image = try frames.decodeIfPresent(String.self, forKey: .image) {
            frame = .image(image)
        } else if let selector = try frames.decodeIfPresent(String.self, forKey: .selector) {
            frame = .selector(selector)
        } else if let quote = try frames.decodeIfPresent(String.self, forKey: .quote) {
            frame = .quote(quote)
        } else {
            throw DecodingError.dataCorruptedError(forKey: .frame, in: container, debugDescription: "no frame this build can draw on")
        }
        at = try Self.point(container.decodeIfPresent([Double].self, forKey: .at))
        to = try Self.point(container.decodeIfPresent([Double].self, forKey: .to))
        rect = try container.decodeIfPresent([Double].self, forKey: .rect).map { xywh in
            guard xywh.count == 4 else { throw DecodingError.dataCorruptedError(forKey: .rect, in: container, debugDescription: "rect is [x, y, width, height]") }
            return CGRect(x: xywh[0], y: xywh[1], width: xywh[2], height: xywh[3])
        }
        pts = try (container.decodeIfPresent([[Double]].self, forKey: .pts) ?? []).compactMap(Self.point)
        label = try container.decodeIfPresent(String.self, forKey: .label)
    }

    private static func point(_ xy: [Double]?) throws -> CGPoint? {
        guard let xy else { return nil }
        guard xy.count == 2 else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "a point is [x, y]")) }
        return CGPoint(x: xy[0], y: xy[1])
    }

    /// Every mark this build can read, in order. One it can't, such as a kind from a newer daemon,
    /// is skipped: never the review, and never the marks beside it.
    struct List: Decodable, Equatable, Sendable {
        let all: [AgentMark]

        init(from decoder: Decoder) throws {
            all = ((try? [Lossy](from: decoder)) ?? []).compactMap(\.mark)
        }
    }

    private struct Lossy: Decodable {
        let mark: AgentMark?

        init(from decoder: Decoder) throws {
            mark = try? AgentMark(from: decoder)
        }
    }
}
