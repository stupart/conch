import Foundation

/// Which ledger row is the session a start sheet just launched, once it has checked in. The Mac's
/// New session sheet and the phone's both wait on this, then close onto that session.
///
/// Nothing announces a new session: a fresh Terminal start comes back with no id at all
/// (`session-started` in src/control-server.ts), so the sheet watches the published rows for one
/// that was not there before.
public struct StartedSessionWatch: Equatable, Sendable {
    /// A ledger row, reduced to what identifies a launch.
    public struct Row: Equatable, Sendable {
        public let id: String
        public let backend: String?
        public let parentSessionId: String?
        public let accountId: String?

        public init(id: String, backend: String?, parentSessionId: String?, accountId: String?) {
            self.id = id
            self.backend = backend
            self.parentSessionId = parentSessionId
            self.accountId = accountId
        }
    }

    /// The agent launched: "claude" or "codex".
    public let backend: String
    /// The account it was launched with; nil accepts any.
    public let accountId: String?
    /// The id known in advance (a resume, an account handoff), when there is one.
    public let expectedId: String?
    /// Every row before the launch. A fresh start is the first session that is not among them.
    public let before: Set<String>

    public init(backend: String, accountId: String?, expectedId: String?, before: Set<String>) {
        self.backend = backend
        self.accountId = accountId
        self.expectedId = expectedId
        self.before = before
    }

    /// The launched session's id, once it is in `rows`.
    public func match(in rows: [Row]) -> String? {
        let sessions = rows.filter(isLaunch)
        if let expectedId {
            return sessions.contains { $0.id == expectedId } ? expectedId : nil
        }
        return sessions.first { !before.contains($0.id) }?.id
    }

    /// Sessions only: a session's agents are rows too, and one appearing is not the session you started.
    ///
    /// The daemon publishes `backend` only for Codex and for agents; a top-level Claude row carries none
    /// (src/panel.ts), so absent is Claude. Comparing the raw field missed every new Claude session, and the
    /// sheet sat on "Opening…" over a session that was already running.
    private func isLaunch(_ row: Row) -> Bool {
        row.parentSessionId == nil
            && (row.backend ?? "claude") == backend
            && (accountId == nil || (row.accountId ?? "default") == accountId)
    }
}
