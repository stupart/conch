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

/// A start sheet's answers to "Do you trust this folder?": kept for that sheet only, and sent back as `trustFolder`
/// with the start they belong to. The Mac's sheet and the phone's both keep one.
///
/// The daemon asks about the folder a session WILL run in (src/control-server.ts), which a start that names none
/// still has: the Mac's home for a blank folder field, conch's own for Help. The phone looked its yes up by the
/// folder it sent, so a start naming none never carried one, and the daemon would have asked again forever; before
/// the daemon asked at all, Claude sat on its own prompt in the home folder while the sheet waited (2026-10-05,
/// Tyler: "trying to start a new session (background session with claude account) and it didn't start … and the
/// modal didn't close"). So the folder the Mac named is remembered for the start that named none.
public struct StartTrustAnswers: Equatable, Sendable {
    private var trusted: Set<String> = []
    /// The folder the Mac said a start naming none runs in: a blank field's, and Help's.
    private var unnamed: String?
    private var help: String?

    public init() {}

    /// The Mac asked about `folder` for a start that sent `sent` (nil or blank: no folder; `help`: Help with conch).
    public mutating func asked(about folder: String, sent: String?, help: Bool = false) {
        guard Self.named(sent) == nil else { return }
        if help { self.help = folder } else { unnamed = folder }
    }

    /// "Yes, I trust this folder" (Codex: "Yes, continue") for the folder asked about.
    public mutating func trust(_ folder: String) {
        trusted.insert(folder)
    }

    /// Whether a start sending `sent` carries a yes: for the folder it names, or, naming none, for the one the Mac
    /// said it runs in. Never for a different start than the one asked about.
    public func trustFolder(sent: String?, help: Bool = false) -> Bool {
        guard let folder = Self.named(sent) ?? (help ? self.help : unnamed) else { return false }
        return trusted.contains(folder)
    }

    private static func named(_ folder: String?) -> String? {
        let trimmed = folder?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

public extension StartedSessionWatch {
    /// What a start sheet says once its session hasn't checked in (both wait 20 s), in the same words on the Mac and
    /// the phone. A background session has no window to look at, so it names what holds one and where to answer it:
    /// the "Open startup terminal" button both sheets show beside it.
    static func notCheckedIn(backend: String, background: Bool, onPhone: Bool) -> String {
        let mac = onPhone ? " on your Mac" : ""
        guard background else {
            return "Started, but it hasn\u{2019}t checked in. Terminal\(mac) may be waiting for you to answer something \u{2014} take a look there."
        }
        let waiting = backend == "codex"
            ? "Codex may be waiting at a login or setup prompt"
            : "Claude may be waiting at its trust or login prompt"
        return "Started in the background, but it hasn\u{2019}t checked in. \(waiting): open its startup terminal\(mac) to answer it."
    }
}
