import Foundation

/// A shortcut to the existing host, independent of deliverables or message delivery.
public enum SessionLocation: Equatable, Sendable {
    case terminal
    case codexApp

    public static func resolve(backend: String?, messageRoute: String?, revealable: Bool,
                               noTerminal: String?, parentSessionId: String?) -> Self? {
        guard parentSessionId == nil else { return nil }
        if backend == "codex", messageRoute == "codex-app" { return .codexApp }
        return revealable && noTerminal == nil ? .terminal : nil
    }

    public var symbol: String { self == .terminal ? "terminal" : "macwindow" }
    public var label: String { self == .terminal ? "Open terminal" : "Open in Codex" }
    public var help: String {
        self == .terminal ? "Bring this session's terminal to the front" : "Open this chat in the Codex app"
    }
}

public struct SessionAppOpenRequest: Encodable, Sendable {
    public let kind = "session-open-app"
    public let sessionId: String
    public init(sessionId: String) { self.sessionId = sessionId }
}

public struct SessionAppOpenReply: Decodable, Sendable {
    public let kind: String
    public let sessionId: String
    public let opened: Bool
    public let reason: String?
}
