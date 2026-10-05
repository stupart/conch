import Foundation

/// What became of a message you sent — the three states a person actually has to tell apart.
///
/// The Mac answers `inject-accepted` twenty seconds into a delivery that is still running,
/// and then closes the request. Reading that as "sent" is the bug this type exists to make
/// impossible: on 2026-09-16 Tyler watched messages that never arrived sit on his screen
/// looking delivered, with their words already cleared from the draft.
public enum ConchDeliveryState: Equatable, Codable, Sendable {
    /// Optimistic and immediate. It is in the conversation the moment you send it, and it
    /// stays here while the Mac is still working — accepted is this, not `confirmed`.
    case sent
    /// Proven: the Mac typed it and the session took it. Only this clears the draft.
    case confirmed
    /// Placed in the input box and never submitted.
    case staged
    /// It did not arrive, in the daemon's own words (`ConchSendFailure.sentence`).
    case failed(String)
    /// Sent, and the answer never reached this device: a timeout, a dropped link, a relay that
    /// could not say. This is NOT a rejection — the Mac may well have typed it — and treating
    /// it as one is how a message that landed ended up showing as failed for good, with its
    /// words stuck in the draft. Not terminal, so the daemon's authoritative outcome still
    /// lands when it arrives, however late.
    case unknown(String)

    /// Settled. A terminal state is final — a late answer can never un-confirm a message,
    /// nor quietly upgrade one the daemon actually refused.
    ///
    /// `unknown` is deliberately NOT terminal: nothing has been settled, and the whole point
    /// is that the real answer is still coming.
    public var isTerminal: Bool {
        switch self {
        case .sent, .unknown: false
        case .confirmed, .staged, .failed: true
        }
    }

    /// Only proof lets the words go. Everything else keeps them where they can be recovered.
    public var clearsDraft: Bool { self == .confirmed }
}

/// One message on its way, and what became of it.
public struct ConchOutboxEntry: Identifiable, Equatable, Codable, Sendable {
    /// The operation id that went out with the send and comes back with its outcome.
    public let id: String
    public let session: String
    public let text: String
    public var state: ConchDeliveryState
    public let sentAt: Date
    /// The session's user messages when this was sent, so the transcript's own copy of it
    /// is told apart from an older line that happens to say the same thing.
    public let earlierUserItems: Set<String>

    public init(
        id: String = UUID().uuidString,
        session: String,
        text: String,
        state: ConchDeliveryState = .sent,
        sentAt: Date = Date(),
        earlierUserItems: Set<String> = []
    ) {
        self.id = id
        self.session = session
        self.text = text
        self.state = state
        self.sentAt = sentAt
        self.earlierUserItems = earlierUserItems
    }
}

/// Every message sent from this device that has not been accounted for yet.
///
/// It outlives the app, because the answer can outlive the request: a terminal outcome
/// arrives late, after a reconnect, or after a relaunch, and the entry waits for it. Nothing
/// in here retries by itself — an unresolved send stays visible and says so, and the person
/// decides what to do about it.
public struct ConchOutbox: Equatable, Codable, Sendable {
    public private(set) var entries: [ConchOutboxEntry]
    /// Sends the person dismissed, by id, with when: nothing may put one of them back.
    ///
    /// 2026-10-05: Dismiss "didn't work per usual" (and 2026-10-02: "Dismiss button doesn't work", then "Oh its gone
    /// now"). The cause was the press never reaching the button (ConversationStackView's `PendingMessage`) and, on the
    /// phone, there being no Dismiss for a failed send at all. These make the other half a rule rather than a
    /// coincidence: whatever a reconcile or a late receipt does, a dismissed send stays gone.
    public private(set) var dismissed: [String: Date]

    /// How long a dismissal is remembered. Ids are minted per send and a send's outcome is settled within minutes, so a
    /// day is far past any receipt that could still name one, and the set stays a handful of ids.
    public static let dismissalMemory: TimeInterval = 24 * 60 * 60

    public init(entries: [ConchOutboxEntry] = [], dismissed: [String: Date] = [:]) {
        self.entries = entries
        self.dismissed = dismissed
    }

    /// Start a send: it appears immediately, reading as sent.
    ///
    /// One unsettled message per session, as before — its words head that session's draft,
    /// so re-sending carries them again rather than leaving two copies in flight.
    ///
    /// Never one that was dismissed: an id is a send, and that send was taken off the conversation on purpose.
    @discardableResult
    public mutating func begin(_ entry: ConchOutboxEntry) -> ConchOutboxEntry {
        forgetDismissals(before: entry.sentAt.addingTimeInterval(-Self.dismissalMemory))
        guard dismissed[entry.id] == nil else { return entry }
        entries.removeAll { $0.session == entry.session && !$0.state.clearsDraft }
        entries.append(entry)
        return entry
    }

    /// Record what became of one send. Terminal outcomes are final and land exactly once;
    /// an id this device never sent is ignored rather than invented.
    public mutating func settle(_ id: String, _ state: ConchDeliveryState) {
        guard let index = entries.firstIndex(where: { $0.id == id }), !entries[index].state.isTerminal else { return }
        entries[index].state = state
    }

    public mutating func remove(_ id: String) {
        entries.removeAll { $0.id == id }
    }

    /// The person took this send off the conversation: it goes now, and it is remembered as gone so nothing can put
    /// it back. Other sends are untouched.
    public mutating func dismiss(_ id: String, at now: Date = Date()) {
        entries.removeAll { $0.id == id }
        dismissed[id] = now
        forgetDismissals(before: now.addingTimeInterval(-Self.dismissalMemory))
    }

    public func isDismissed(_ id: String) -> Bool { dismissed[id] != nil }

    /// Let go of dismissals made before `cutoff`. Called by `begin` and `dismiss`, so the set never outgrows a day of them.
    public mutating func forgetDismissals(before cutoff: Date) {
        guard dismissed.values.contains(where: { $0 < cutoff }) else { return }
        dismissed = dismissed.filter { $0.value >= cutoff }
    }

    /// This outbox, to be stored over `latest`: every dismissal in `latest` stands.
    ///
    /// A reconcile works on a copy and stores it (the Mac's `reconcileOutbox`, so an unchanged outbox is not written
    /// on every poll). A dismissal that lands between the copy and the store would be written back over by the copy;
    /// stored through this, it is not. Today both run on the main actor with nothing between them to wait on, so it
    /// cannot happen yet — this keeps it so when something does.
    public func honoringDismissals(of latest: ConchOutbox) -> ConchOutbox {
        guard !latest.dismissed.isEmpty else { return self }
        var merged = self
        merged.dismissed.merge(latest.dismissed) { max($0, $1) }
        merged.entries.removeAll { merged.dismissed[$0.id] != nil }
        return merged
    }

    /// The session's send that is still waiting, or that did not arrive — the one whose
    /// words are still in the draft.
    public func unsettled(for session: String) -> ConchOutboxEntry? {
        entries.last { $0.session == session && !$0.state.clearsDraft }
    }

    public func entries(for session: String) -> [ConchOutboxEntry] {
        entries.filter { $0.session == session }
    }

    /// Retire a confirmed message the conversation never showed for itself.
    ///
    /// Only confirmed ones: an unresolved or failed send is the user's to dismiss, and a
    /// tidy-up that swallowed it would be the original bug wearing a different hat.
    public mutating func prune(confirmedBefore cutoff: Date) {
        entries.removeAll { $0.state.clearsDraft && $0.sentAt < cutoff }
    }

    /// Clear sends to `session` that did not land (failed, or never confirmed) once a later message of yours has: the
    /// conversation has moved on, and a "Not delivered" from before it reads as a fresh failure (2026-10-02, one from
    /// the evening before was still under a session that had been working all night). By time, not by which messages
    /// were seen: a session whose conversation was not being published when the send failed saw none. `skew` covers
    /// the two clocks' small difference. Never a send still in flight, nor one left staged in the box.
    public mutating func retireSuperseded(in session: String, lastUserMessageAt: Date, skew: TimeInterval = 5) {
        entries.removeAll { entry in
            guard entry.session == session, entry.sentAt < lastUserMessageAt.addingTimeInterval(-skew) else { return false }
            switch entry.state {
            case .failed, .unknown: return true
            case .sent, .confirmed, .staged: return false
            }
        }
    }

    // MARK: - Persistence

    private enum CodingKeys: String, CodingKey { case entries, dismissed }

    /// An outbox stored before dismissals were remembered has none: read as an empty set, never as unreadable, which
    /// would lose every bubble waiting in it.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        entries = try container.decode([ConchOutboxEntry].self, forKey: .entries)
        dismissed = try container.decodeIfPresent([String: Date].self, forKey: .dismissed) ?? [:]
    }

    /// Never throws and never refuses to launch: an outbox that cannot be read is empty,
    /// which loses the bubbles but never the words — those live in the draft.
    public static func decode(_ data: Data?) -> ConchOutbox {
        guard let data, let outbox = try? JSONDecoder().decode(ConchOutbox.self, from: data) else { return ConchOutbox() }
        return outbox
    }

    public func encoded() -> Data? {
        try? JSONEncoder().encode(self)
    }
}
