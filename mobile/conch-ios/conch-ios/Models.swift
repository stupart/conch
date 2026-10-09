import ConchDesign
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
    /// Each agent's model and effort choices and its own defaults (src/session-settings.ts). Absent from a
    /// daemon too old to change them safely, so the session menu then shows the model without a picker.
    var sessionSettings: SessionSettingsCatalog?
    /// Where the Mac's natural voices stand (src/voice-env.ts): the list's calm line (`NaturalVoicesNotices`).
    var naturalVoices: NaturalVoicesReport?
    /// Where the Mac's speech engine stands (src/speech-engine.ts), for Settings' Voices.
    var speechEngine: SpeechEngineReport?

    struct Features: Decodable, Equatable {
        var deliverables: Int?
        var viewedState: Int?
        var sessionHosts: Int?
        /// `session-start` takes `help: true`: Help with conch, which the phone can't name a folder for.
        var helpSession: Int?
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
        /// Read replies aloud is off on the Mac (settings `speak`): this phone reads nothing aloud either.
        var speechOff = false

        private enum CodingKeys: String, CodingKey { case paused, holding, speechOff }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            paused = (try? c.decodeIfPresent(Bool.self, forKey: .paused)) ?? false
            holding = (try? c.decodeIfPresent(Int.self, forKey: .holding)) ?? 0
            speechOff = (try? c.decodeIfPresent(Bool.self, forKey: .speechOff)) ?? false
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
        /// The model and effort it runs, from its own record, and a change conch is driving
        /// (src/session-settings.ts). Absent when nothing is known: the menu then says "default".
        var settings: SessionSettingsState?
        var usageLimit: String?
        var detail: String?
        var at: Double = 0
        var live: String?
        /// Quieted by name: conch won't read it aloud, and it keeps working (`SessionVoice`).
        var paused = false
        /// Let speak by name while every session is quiet. Never true alongside `paused`; older
        /// daemons never send it, which reads as false.
        var pauseExempt = false
        var review: Review?
        /// Every deliverable the session still holds, oldest first; `review` is the last.
        var reviews: [Review]?
        /// Why this row has no terminal to type into or close: a closed Codex
        /// thread, or one an app-server hosts. Older daemons never send it.
        var noTerminal: String?
        var revealable = false
        var claudeAccountId: String?
        var codexAccountId: String?
        /// The account it runs under, by the name the Mac gave it. Older daemons never send it.
        var accountLabel: String?
        /// Jumps the queue: its turns are read before the others' (the Mac's diamond).
        var prioritized = false
        /// The voice conch reads it in, when it has one of its own.
        var voice: String?
        var messageRoute: String?
        var messageUnavailableReason: String? { messageRoute == "codex-app" ? nil : noTerminal }
        var location: SessionLocation? {
            SessionLocation.resolve(backend: backend, messageRoute: messageRoute, revealable: revealable,
                                    noTerminal: noTerminal, parentSessionId: parentSessionId)
        }
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

        /// The Mac can fork it (daemon `forkLiveSession`, session-fork.ts): a top-level session in a terminal or conch's
        /// background host, Claude Code's or Codex's, or a Claude background job.
        var canFork: Bool {
            parentSessionId == nil && (noTerminal == nil || attachable)
        }
        var startedBySessionId: String?
        /// Working only because agents it started are still running; its own turn is over, so
        /// it can be talked to. Older daemons never send it.
        var waitingOnAgents = false
        /// The permission prompt a row that needs you is showing. Older daemons never send it.
        var approval: PendingApproval?
        /// What its agent is doing right now, while it works on its own turn: the ledger's second line
        /// (src/live-activity.ts; `SidebarActivity`). Older daemons never send it.
        var activity: Activity?

        /// What a working agent is doing right now: its running step, or its words from the last minute.
        struct Activity: Decodable, Equatable {
            var text = ""
            /// "step" or "commentary"; a kind a newer daemon adds is still a line.
            var kind: String?
            /// Epoch milliseconds the step started or the words were written.
            var at: Double?
        }

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
            /// When it was approved, which marks it done (2026-10-05): not waiting on you, here or on the Mac. Absent
            /// means it wasn't, and from a daemon too old to approve.
            var approvedAt: Double?
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
            /// A snapshot of it from the Mac, for a kind the phone can't draw (`features.deliverables` 4).
            var preview: Preview?
            /// A folder deliverable's paths to point at, relative to the folder (`focus`). Empty for anything else, and
            /// from an older daemon.
            var focus: [String] = []
            /// Why the link its agent gave was not published, when one was given and refused (`linkRefused`). Nil when
            /// there was no link, and from an older daemon.
            var linkRefused: String?
            /// A live page as conch's Mac drew it when it was published, with the Mac's sign-ins (src/page-access.ts):
            /// shown first, since this phone has none of them. Nil when the Mac didn't draw the page, and from an older daemon.
            var snapshot: Preview?
            /// What the login-wall check found: whether the Mac, and a device without its sign-ins like this phone, were
            /// shown the page or a sign-in page (`PageAccess`). Nil for anything but a live page, and from an older daemon.
            var access: PageAccess.Found?

            struct Preview: Decodable, Equatable {
                var path: String
                /// Epoch-ms it was taken.
                var capturedAt: Double
            }

            private enum CodingKeys: String, CodingKey {
                case summary, link, at, scene, id, viewedAt, approvedAt, artifact, version, kind, preview, focus, linkRefused, snapshot, access
            }
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
                approvedAt = try? c.decodeIfPresent(Double.self, forKey: .approvedAt)
                // A scene this build can't read is no scene, never a review that fails.
                let scene = try? c.decodeIfPresent(Scene.self, forKey: .scene)
                inspect = scene?.inspect
                marks = scene?.marks?.all ?? []
                artifact = try? c.decodeIfPresent(String.self, forKey: .artifact)
                version = try? c.decodeIfPresent(Int.self, forKey: .version)
                kind = try? c.decodeIfPresent(String.self, forKey: .kind)
                preview = try? c.decodeIfPresent(Preview.self, forKey: .preview)
                focus = (try? c.decodeIfPresent([String].self, forKey: .focus)) ?? []
                linkRefused = try? c.decodeIfPresent(String.self, forKey: .linkRefused)
                snapshot = try? c.decodeIfPresent(Preview.self, forKey: .snapshot)
                access = try? c.decodeIfPresent(PageAccess.Found.self, forKey: .access)
            }
        }

        private enum CodingKeys: String, CodingKey {
            case id, label, status, backend, context, detail, at, live, paused, pauseExempt, review, reviews, noTerminal, messageRoute, attachable
            case revealable, claudeAccountId, codexAccountId, accountLabel, prioritized, voice
            case usageLimit
            case cwd, workDirs, parentSessionId, startedBySessionId, waitingOnAgents, approval, settings
            case activity
        }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
            label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
            // A null status is a session with nothing to report, not one at work: the Mac reads it
            // as none. Only a missing key still reads as working, as it always has.
            status = c.contains(.status) ? ((try? c.decodeIfPresent(String.self, forKey: .status)) ?? "idle") : "working"
            backend = try? c.decodeIfPresent(String.self, forKey: .backend)
            context = try? c.decodeIfPresent(ContextUsage.self, forKey: .context)
            settings = try? c.decodeIfPresent(SessionSettingsState.self, forKey: .settings)
            detail = try? c.decodeIfPresent(String.self, forKey: .detail)
            at = (try? c.decodeIfPresent(Double.self, forKey: .at)) ?? 0
            live = try? c.decodeIfPresent(String.self, forKey: .live)
            paused = (try? c.decodeIfPresent(Bool.self, forKey: .paused)) ?? false
            pauseExempt = (try? c.decodeIfPresent(Bool.self, forKey: .pauseExempt)) ?? false
            review = try? c.decodeIfPresent(Review.self, forKey: .review)
            reviews = try? c.decodeIfPresent([Review].self, forKey: .reviews)
            noTerminal = try? c.decodeIfPresent(String.self, forKey: .noTerminal)
            usageLimit = try? c.decodeIfPresent(String.self, forKey: .usageLimit)
            revealable = (try? c.decodeIfPresent(Bool.self, forKey: .revealable)) ?? false
            claudeAccountId = try? c.decodeIfPresent(String.self, forKey: .claudeAccountId)
            codexAccountId = try? c.decodeIfPresent(String.self, forKey: .codexAccountId)
            accountLabel = try? c.decodeIfPresent(String.self, forKey: .accountLabel)
            prioritized = (try? c.decodeIfPresent(Bool.self, forKey: .prioritized)) ?? false
            voice = try? c.decodeIfPresent(String.self, forKey: .voice)
            messageRoute = try? c.decodeIfPresent(String.self, forKey: .messageRoute)
            attachable = (try? c.decodeIfPresent(Bool.self, forKey: .attachable)) ?? false
            cwd = try? c.decodeIfPresent(String.self, forKey: .cwd)
            workDirs = try? c.decodeIfPresent([String].self, forKey: .workDirs)
            parentSessionId = try? c.decodeIfPresent(String.self, forKey: .parentSessionId)
            startedBySessionId = try? c.decodeIfPresent(String.self, forKey: .startedBySessionId)
            waitingOnAgents = (try? c.decodeIfPresent(Bool.self, forKey: .waitingOnAgents)) ?? false
            approval = try? c.decodeIfPresent(PendingApproval.self, forKey: .approval)
            // A line this build can't read is no line, never a row that fails.
            activity = try? c.decodeIfPresent(Activity.self, forKey: .activity)
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
        case ownerDeviceId, deliveries, sessionSettings, naturalVoices, speechEngine, features
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
        sessionSettings = try? c.decodeIfPresent(SessionSettingsCatalog.self, forKey: .sessionSettings)
        naturalVoices = try? c.decodeIfPresent(NaturalVoicesReport.self, forKey: .naturalVoices)
        speechEngine = try? c.decodeIfPresent(SpeechEngineReport.self, forKey: .speechEngine)
        // Declared since deliverables were versioned and never read, so everything the daemon gates on
        // it (Background sessions, the viewed state) read as unsupported on every Mac.
        features = try? c.decodeIfPresent(Features.self, forKey: .features)
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

extension PublishedState.Row {
    /// Whether conch reads this session aloud: the Mac's rule, from the same two flags and the global mode.
    func voice(everythingQuiet: Bool) -> SessionVoice {
        SessionVoice(sessionQuiet: paused, exempt: pauseExempt, everythingQuiet: everythingQuiet)
    }
}

/// The Mac ledger's glyph vocabulary, one for one.
///
/// No mode among them. A quiet session (manual for that one) keeps working, so its mark says what it is doing and a
/// small speaker mark beside its name says conch won't read it aloud (`SessionVoice`), as on the Mac.
enum StatusMark {
    case usageLimit
    /// `agentPaused` is a sub-agent that is not running (C4).
    case working, waitingOnAgents, waiting, needs, review, micOpen, speaking, idle, agentPaused

    init(row: PublishedState.Row) {
        if row.usageLimit != nil, row.live != "listening", row.live != "recording" { self = .usageLimit; return }
        // The deliverable stays on a working row; the mark means it is waiting for you, and one you have looked at or
        // approved (2026-10-05), here, on the Mac or in the lagoon, isn't (`ReadyForYou`, the Mac's rule): that row reads
        // as its status.
        let held = row.reviews.flatMap { $0.isEmpty ? nil : $0 } ?? row.review.map { [$0] } ?? []
        if ReadyForYou.isReady(working: row.status == "working", held: held.map { ($0.viewedAt, $0.approvedAt) }) { self = .review; return }
        // A sub-agent is working or it is paused, as on the Mac. Nobody replies to one, so a
        // Codex helper between turns is not "waiting for you", and waiting's colour was wrong on
        // it. Only a question it is blocked on still asks something of you.
        if row.parentSessionId != nil, row.status != "working", row.status != "needs" { self = .agentPaused; return }
        switch row.live {
        case "listening", "recording": self = .micOpen
        case "speaking": self = .speaking
        default:
            switch row.status {
            case "waiting": self = .waiting
            case "needs": self = .needs
            // Its own turn is over and only its agents are running: talk to it.
            case "working" where row.waitingOnAgents: self = .waitingOnAgents
            case "working": self = .working
            // Nothing to report, which the Mac draws idle. This was `.working`, a false working
            // dot, and working is blue now: the colour must only ever mean an agent is running.
            default: self = .idle
            }
        }
    }

    var symbol: String {
        switch self {
        case .usageLimit: "hourglass.circle"
        case .working: "circle.fill"
        // Two figures: the agents it handed work to, still at it.
        case .waitingOnAgents: "person.2.fill"
        case .waiting: "circle.inset.filled"
        case .needs: "exclamationmark.circle.fill"
        case .review: "checkmark.circle.fill"
        case .micOpen: "mic.fill"
        case .speaking: "play.fill"
        case .idle: "circle.dotted"
        // Hollow: the working dot with the work taken out of it. Solid, where idle's is dotted.
        case .agentPaused: "circle"
        }
    }

    var color: Color {
        switch self {
        case .usageLimit: Palette.needs
        case .working: Palette.active
        // Reading aloud comes once the turn is over, when no agent is running: not working's blue.
        case .speaking: Palette.calm
        // The waiting colour: the same answer to "can I talk to it?"; the glyph says why.
        case .waiting, .waitingOnAgents: Palette.waiting
        case .needs: Palette.needs
        case .review: Palette.review
        case .micOpen: Palette.micOpen
        case .idle, .agentPaused: Palette.textFaint
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
        case .usageLimit: true
        case .working, .idle, .agentPaused: false
        case .waitingOnAgents, .waiting, .needs, .review, .micOpen, .speaking: true
        }
    }

    /// The meaning, short enough for the one line beside a glyph. Only this state's full
    /// sentence runs past that line, and it cut off at "you…" — the half that says why it matters.
    /// Ready for you is one state with one name, on the Mac and here; the glyph says which kind.
    var caption: String {
        switch self {
        case .waitingOnAgents: "Agents working — talk to it"
        case .waiting, .review: "Ready for you"
        default: meaning
        }
    }

    var meaning: String {
        switch self {
        case .usageLimit: "Usage limit reached"
        case .working: "Working"
        case .waitingOnAgents: "Waiting on its agents — you can talk to it"
        case .waiting: "Ready for you — its turn is over"
        case .needs: "Needs an answer"
        case .review: "Ready for you — work to look at"
        case .micOpen: "Mic open"
        case .speaking: "Reading aloud"
        case .idle: "Idle"
        case .agentPaused: "Paused"
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
    var claudeAccountId: String? = nil
    var codexAccountId: String? = nil
    var accountLabel: String? = nil

    var id: String { "\(backend):\(claudeAccountId ?? codexAccountId ?? "default"):\(sessionId)" }

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
    /// Something Tyler sent through conch itself — a canvas, a Show, a video from this phone — summed up by the
    /// daemon and drawn as one quiet row. Nil from an older daemon, which keeps today's rows.
    var receipt: ConchSentReceipt?

    private enum CodingKeys: String, CodingKey {
        case id, rev, kind, text, at, tool, plan, change, question, questions, material, receipt
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
        receipt = try? c.decodeIfPresent(ConchSentReceipt.self, forKey: .receipt)
    }
}

/// One answer per question: the options picked (indexes into its options), or words of your own.
/// The daemon types it as the agent's picker keys; a label sent as text records option 1.
struct QuestionAnswer: Equatable {
    var choices: [Int]? = nil
    var text: String? = nil

    /// Choices, words, or — on a multi-select question — both: ticked options beside words of your own.
    var wire: [String: Any] {
        var wire: [String: Any] = [:]
        if let choices { wire["choices"] = choices }
        if let text { wire["text"] = text }
        return wire
    }
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
