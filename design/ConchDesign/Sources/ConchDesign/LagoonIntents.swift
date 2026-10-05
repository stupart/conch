import Foundation

/// What the lagoon asks of conch (spec §5): named messages on the `conchWorld` script handler, each checked here before
/// anything sees it, then logged, then acted on only when its own flag says so.
///
/// The rollout (spec §8) is per name, in `conch.lagoon.actions`:
/// - phase A (2026-10-04, this): no flags. Every message is checked and logged, and nothing acts but the three below.
/// - phase B: `focusSession` and `openReview` (look, and go to it): reversible, and nothing reaches an agent.
/// - phase C: `answer` and `pause`, which do reach one. Each is its own flag, so either can go back to logging.
/// Three act by default, with no flag at all (`byDefault`), ahead of phases B and C, and whether the page is read-only
/// or not:
/// - `approve` and `unapprove` (2026-10-05, Tyler's decision): the same store action as the review pane's Approve, and
///   only for a result whose agent asked for your yes, which is told `Approved: <label>.` once the 10 s undo window
///   closes (the daemon holds it; an undo inside the window cancels it).
/// - `reply` (2026-10-05, Tyler's go, replies only): what you type to a session on the glass, sent exactly as the
///   composer sends it, through the same store action and delivery path. It was phase C's.
/// `newSession` has no conch action yet and only ever logs. `ready` isn't an intent: it is the page saying it booted, and
/// the app answers it with the latest snapshot whatever the flags say.
public enum LagoonIntent {
    public enum Name: String, Equatable, Hashable, Sendable, CaseIterable {
        case ready, openReview, reply, answer, focusSession, pause, approve, unapprove, newSession
    }

    /// The names that can act at all, by phase. Anything else is logged and never acted on.
    public static let phaseB: Set<Name> = [.focusSession, .openReview]
    public static let phaseC: Set<Name> = [.answer, .pause]
    /// The names that act with no flag set, in the order the page's `act=` names them: approving a result, taking it
    /// back within 10 s, and replying to a session (2026-10-05).
    public static let byDefaultInOrder: [Name] = [.approve, .unapprove, .reply]
    public static let byDefault: Set<Name> = Set(byDefaultInOrder)

    /// One message, checked: every field the app may act on, typed.
    public struct Message: Equatable, Sendable {
        public var name: Name
        public var sessionId: String?
        public var reviewId: String?
        /// openReview: `viewed` (the lagoon showed it on its glass) or `open` (Open ↗: go to where it lives).
        public var how: How?
        public var text: String?
        /// answer: the permission prompt's id, and Once (allow) or No (deny).
        public var approvalId: String?
        public var allow: Bool?
        /// The page was in its read-only phase when it sent this (`readonly=1`).
        public var readOnly: Bool

        public enum How: String, Equatable, Sendable { case viewed, open }

        public init(name: Name, sessionId: String? = nil, reviewId: String? = nil, how: How? = nil, text: String? = nil,
                    approvalId: String? = nil, allow: Bool? = nil, readOnly: Bool = false) {
            self.name = name
            self.sessionId = sessionId
            self.reviewId = reviewId
            self.how = how
            self.text = text
            self.approvalId = approvalId
            self.allow = allow
            self.readOnly = readOnly
        }
    }

    public enum Check: Equatable, Sendable {
        case accepted(Message)
        case rejected(String)
    }

    /// The sessions in the current state and the reviews each holds (by the lagoon's review key), which is all a message may
    /// name.
    public typealias Sessions = [String: Set<String>]

    /// The checks before acting: a known name, a session in the current state (and a review it holds), text no longer than
    /// 4,000 characters, and no more than 10 messages a second. A page that sends an eleventh in a second, or junk, has every
    /// such message refused, and is logged saying so.
    public struct Gate: Sendable {
        public static let maxText = 4_000
        public static let perSecond = 10
        private var recent: [Date] = []

        public init() {}

        public mutating func check(_ body: Any, sessions: Sessions, now: Date) -> Check {
            recent = recent.filter { now.timeIntervalSince($0) < 1 && now >= $0 }
            guard recent.count < Self.perSecond else { return .rejected("more than \(Self.perSecond) messages a second") }
            recent.append(now)
            return LagoonIntent.validate(body, sessions: sessions)
        }
    }

    /// The checks that need no clock (`Gate` adds the rate).
    public static func validate(_ body: Any, sessions: Sessions) -> Check {
        guard let fields = body as? [String: Any] else { return .rejected("not an object") }
        guard number(fields["v"]) == 1 else { return .rejected("not version 1") }
        guard let raw = fields["name"] as? String, let name = Name(rawValue: raw) else {
            return .rejected("an unknown name: \(String(describing: fields["name"] ?? "none").prefix(40))")
        }
        var message = Message(name: name, readOnly: fields["readOnly"] as? Bool ?? false)

        let needsSession: Set<Name> = [.openReview, .reply, .answer, .focusSession, .pause, .approve, .unapprove]
        if needsSession.contains(name) {
            guard let id = fields["sessionId"] as? String, !id.isEmpty else { return .rejected("\(raw) without a session") }
            guard let reviews = sessions[id] else { return .rejected("\(raw) for a session that isn't in the current state") }
            message.sessionId = id
            if name == .openReview || name == .approve || name == .unapprove {
                guard let review = fields["reviewId"] as? String, !review.isEmpty else { return .rejected("\(raw) without a review") }
                guard reviews.contains(review) else { return .rejected("\(raw) for a review its session doesn't hold") }
                message.reviewId = review
            }
        }
        switch name {
        case .openReview:
            guard let how = (fields["how"] as? String).flatMap(Message.How.init(rawValue:)) else {
                return .rejected("openReview neither viewed nor open")
            }
            message.how = how
        case .reply, .newSession:
            guard let text = fields["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return .rejected("\(raw) without text")
            }
            // Refused rather than cut: half of what someone typed, delivered to an agent as though it were all of it, is
            // worse than nothing.
            guard text.count <= Gate.maxText else { return .rejected("\(raw) text over \(Gate.maxText) characters") }
            message.text = text
        case .answer:
            // The live card offers Once and No only: the daemon takes `once` and `deny`, never "always".
            let choice = fields["choice"] as? String
            guard let approval = fields["approval"] as? [String: Any],
                  let kind = approval["kind"] as? String,
                  let id = approval["id"] as? String, !id.isEmpty else { return .rejected("answer without its prompt") }
            switch (choice, kind) {
            case ("Once", "once"): message.allow = true
            case ("No", "deny"): message.allow = false
            default: return .rejected("answer that is neither Once nor No")
            }
            message.approvalId = id
        case .ready, .focusSession, .pause, .approve, .unapprove:
            break
        }
        return .accepted(message)
    }

    private static func number(_ value: Any?) -> Double? {
        // A JavaScript number reaches Swift as an NSNumber; a Bool is one too, and is not a version.
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() { return number.doubleValue }
        return nil
    }
}

/// Which intents act, by name (`conch.lagoon.actions`): a dictionary of name → bool, a list of names, or one string of
/// them separated by commas. Missing, unreadable, or naming nothing it knows: none, which is phase A.
public struct LagoonActionFlags: Equatable, Sendable {
    public var on: Set<LagoonIntent.Name>

    public init(_ on: Set<LagoonIntent.Name> = []) {
        // Only the phase B and C names can be switched on at all.
        self.on = on.intersection(LagoonIntent.phaseB.union(LagoonIntent.phaseC))
    }

    /// What UserDefaults holds under `Lagoon.actionsKey`.
    public init(defaultsValue value: Any?) {
        var names: [String] = []
        switch value {
        case let flags as [String: Any]:
            names = flags.compactMap { name, flag in ((flag as? Bool) ?? ((flag as? NSNumber)?.boolValue ?? false)) ? name : nil }
        case let list as [Any]:
            names = list.compactMap { $0 as? String }
        case let text as String:
            names = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        default:
            break
        }
        self.init(Set(names.compactMap(LagoonIntent.Name.init(rawValue:))))
    }

    public func acts(_ name: LagoonIntent.Name) -> Bool { on.contains(name) }

    /// Phase C reaches an agent with no "would do" toast in the way, so the page loads without `readonly=1` once any of its
    /// names is on (spec §8). A reply needs neither: it acts by default and the page's `act=` names it.
    public var pageReadOnly: Bool { on.isDisjoint(with: LagoonIntent.phaseC) }
}

/// The app's existing actions, one per intent that can act (spec §5). The Mac app's is `LagoonStoreActions`
/// (LagoonPane.swift), onto StateStore and the workspace; a test hands in a recorder.
@MainActor
public protocol LagoonActionSink: AnyObject {
    /// `workspace.viewing = id`, staying on the lagoon.
    func focusSession(_ sessionId: String)
    /// `store.markReviewViewed(sessionId:review:)`.
    func markReviewViewed(sessionId: String, reviewId: String)
    /// Open ↗: select the session, stage its deliverable, leave the lagoon (or open a link outside the app where it lives).
    func openReview(sessionId: String, reviewId: String)
    /// `store.send(.inject(sessionId:, label:, text:))`: the composer's own send. Acts by default (`byDefault`).
    func reply(sessionId: String, text: String)
    /// `DashboardView`'s `onApprove`: "Allow <name>" or "Deny <name>", with `ConchApproval(kind: once | deny, id:)`.
    func answer(sessionId: String, allow: Bool, approvalId: String)
    /// conch's Quiet for that session: `store.send(.scoped(.pause, sessionId:, label:))`.
    func pause(sessionId: String)
    /// Approve the result: `store.approveReview(sessionId:review:)`, the review pane's Approve (`ReviewApproval`).
    func approveReview(sessionId: String, reviewId: String)
    /// The lagoon's Undo, within 10 s: `store.unapproveReview(sessionId:review:)`.
    func unapproveReview(sessionId: String, reviewId: String)
}

/// One checked message, routed: what happened to it, for the log line and the tests.
public enum LagoonRouting: Equatable, Sendable {
    /// The page booted: send it the latest snapshot and liveness.
    case ready
    /// Logged, and nothing done: its flag is off (and it doesn't act by default), or it has no action.
    case logged
    /// Handed to the sink.
    case acted
}

@MainActor
public enum LagoonIntentRouter {
    /// Every code path for phases B and C is here and compiled; each is reached only when that name's flag is on. With
    /// every flag off (phase A), only `approve`, `unapprove` and `reply` reach the sink (`LagoonIntent.byDefault`).
    public static func route(_ message: LagoonIntent.Message, flags: LagoonActionFlags, sink: LagoonActionSink?) -> LagoonRouting {
        if message.name == .ready { return .ready }
        guard LagoonIntent.byDefault.contains(message.name) || flags.acts(message.name), let sink else { return .logged }
        switch message.name {
        case .focusSession:
            guard let id = message.sessionId else { return .logged }
            sink.focusSession(id)
        case .openReview:
            guard let id = message.sessionId, let review = message.reviewId, let how = message.how else { return .logged }
            switch how {
            case .viewed: sink.markReviewViewed(sessionId: id, reviewId: review)
            case .open: sink.openReview(sessionId: id, reviewId: review)
            }
        case .reply:
            guard let id = message.sessionId, let text = message.text else { return .logged }
            sink.reply(sessionId: id, text: text)
        case .answer:
            guard let id = message.sessionId, let allow = message.allow, let approval = message.approvalId else { return .logged }
            sink.answer(sessionId: id, allow: allow, approvalId: approval)
        case .pause:
            guard let id = message.sessionId else { return .logged }
            sink.pause(sessionId: id)
        case .approve:
            guard let id = message.sessionId, let review = message.reviewId else { return .logged }
            sink.approveReview(sessionId: id, reviewId: review)
        case .unapprove:
            guard let id = message.sessionId, let review = message.reviewId else { return .logged }
            sink.unapproveReview(sessionId: id, reviewId: review)
        case .ready, .newSession:
            return .logged
        }
        return .acted
    }
}
