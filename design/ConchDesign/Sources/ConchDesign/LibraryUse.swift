import Foundation

/// Using and managing what the library lists (2026-11-11). Tyler: "Workflows - making the rest of the app like skills,
/// workflows, etc much more pleasurable to use." Settings › Skills showed what a skill was and could try it in a new
/// session; it couldn't run one in a session already open, switch one off, say which sessions had it, or remove one, and
/// conch had no notion of Claude Code's workflows at all (src/workflows.ts says what they are).
///
/// This file is the wire and the rules the readers share: which open sessions load a skill (or, in Workflows.swift, a
/// workflow), the line typed to use it there, and what can be done to each copy. The views are LibraryUseViews.swift; the
/// Mac wires them in SkillsLibraryView.swift.

// MARK: - Sessions

/// An open session as the library sees it: whose agent and account it runs as, where it works, and whether conch can
/// type into it.
public struct LibrarySession: Identifiable, Hashable, Sendable {
    public let id: String
    public let label: String
    /// "claude" or "codex".
    public let agent: String
    /// Its conch account; nil is the default one.
    public let accountId: String?
    /// Its folder and the folders it says it works in.
    public let folders: [String]
    /// conch can type into it (a pane it can reach, or a message route).
    public let canType: Bool

    public init(id: String, label: String, agent: String, accountId: String? = nil, folders: [String] = [], canType: Bool = true) {
        self.id = id
        self.label = label
        self.agent = agent
        self.accountId = accountId
        self.folders = folders
        self.canType = canType
    }

    /// Whether a copy in this place reaches this session: same agent; a project's copy for a session working in that
    /// project; an account's copy for a session on that account; one every account of the agent loads, for any.
    public func loads(agent: String, accountId: String?, projectPath: String?) -> Bool {
        guard self.agent == agent else { return false }
        if let projectPath {
            let root = projectPath.hasSuffix("/") ? String(projectPath.dropLast()) : projectPath
            return folders.contains { $0 == root || $0.hasPrefix(root + "/") }
        }
        if let accountId { return (self.accountId ?? "default") == accountId }
        return true
    }
}

/// One way to use something in an open session: the session, and the line typed there.
public struct LibraryUse: Identifiable, Hashable, Sendable {
    public let session: LibrarySession
    /// What is typed: `/name`, `/plugin:name`, `$name`, or words asking for it when it can't be typed by name.
    public let line: String
    public var id: String { session.id }

    public init(session: LibrarySession, line: String) {
        self.session = session
        self.line = line
    }
}

public enum LibraryUses {
    /// Where an installed skill can be used now: each open session one of its switched-on copies reaches, with that
    /// copy's own line. A skill only the model may call is asked for in words.
    public static func skill(_ skill: InstalledSkillInfo, among sessions: [LibrarySession]) -> [LibraryUse] {
        sessions.compactMap { session in
            guard let location = skill.locations.first(where: { $0.enabled != false
                && session.loads(agent: $0.agent, accountId: $0.origin == "project" ? nil : $0.accountId, projectPath: $0.origin == "project" ? $0.projectPath : nil) })
            else { return nil }
            return LibraryUse(session: session, line: location.invocation ?? "Use the \(skill.name) skill.")
        }
    }

    /// "storefront and conch help", "storefront, conch help and 2 more": who has it, as a line says it.
    public static func names(_ uses: [LibraryUse], limit: Int = 3) -> String {
        let labels = uses.map(\.session.label)
        guard labels.count > 1 else { return labels.first ?? "" }
        if labels.count <= limit { return labels.dropLast().joined(separator: ", ") + " and " + labels.last! }
        return labels.prefix(limit).joined(separator: ", ") + " and \(labels.count - limit) more"
    }
}

// MARK: - Managing a skill's copy

/// What can be done about one copy of a skill, where it lives.
public enum SkillManagement: Equatable, Sendable {
    /// A Claude skill of the person's own: switched on or off for new sessions with Claude Code's `skillOverrides`.
    case toggle(isOn: Bool)
    /// It comes with a plugin, and is switched and removed with it, in Settings › Plugins & MCP.
    case plugin(String)
    /// Synced from claude.ai, and turned off there.
    case claudeAI
    /// Codex keeps the switch in its config.toml, which conch doesn't edit.
    case codexConfig
    /// A command: no switch of its own.
    case command
    /// Built into Codex, or set by whoever manages the Mac: nothing to do.
    case fixed(String)

    public static func of(_ location: SkillLocationInfo) -> SkillManagement {
        switch location.origin {
        case "plugin": return .plugin(location.pluginId.map { String($0.split(separator: "@")[0]) } ?? "its plugin")
        case "claude.ai": return .claudeAI
        case "system": return .fixed("Built into Codex")
        case "user", "project":
            if location.kind == "command" { return .command }
            if location.agent == "codex" { return .codexConfig }
            return .toggle(isOn: location.enabled != false)
        default: return .fixed("Set by whoever manages this Mac")
        }
    }

    /// The words beside a copy that has no switch here: where it is switched instead.
    public var note: String? {
        switch self {
        case .toggle: nil
        case let .plugin(name): "Comes with plugin \(name)"
        case .claudeAI: "Synced from claude.ai"
        case .codexConfig: "switched in Codex's config.toml"
        case .command: "A command: remove its file to remove it"
        case let .fixed(why): why
        }
    }
}

public enum SkillCopies {
    /// The person's own file, which Move to Trash may take: their skill's folder or their command's file, never a
    /// plugin's, claude.ai's, Codex's own or an administrator's.
    public static func canTrash(_ location: SkillLocationInfo) -> Bool {
        location.origin == "user" || location.origin == "project"
    }

    /// What Move to Trash takes: a skill's whole folder, a command's one file.
    public static func trashTarget(_ location: SkillLocationInfo) -> String {
        location.kind == "command" ? location.path : location.folder
    }

    /// A copy's kind, as the reader's "Where" list says it beside its place.
    public static func kindTitle(_ location: SkillLocationInfo) -> String {
        let what = location.kind == "command" ? "command" : "skill"
        switch location.origin {
        case "user": return "your \(what)"
        case "project": return "project \(what)"
        case "plugin":
            let name = location.pluginId.map { String($0.split(separator: "@")[0]) } ?? "a plugin"
            return "plugin \(name)" + (location.pluginVersion.map { " \($0)" } ?? "")
        case "claude.ai": return "from claude.ai"
        case "system": return "built into Codex"
        default: return "managed"
        }
    }
}

// MARK: - The skill switch's wire

extension SkillsLibraryRequest {
    /// The edit a switch makes, shown before it is made.
    public static func togglePreview(_ location: SkillLocationInfo, enabled: Bool, accountId: String? = nil) -> Self {
        var request = Self(action: "toggle-preview")
        request.path = location.path
        request.agent = location.agent
        request.accountId = location.accountId ?? accountId
        request.enabled = enabled
        return request
    }

    /// The edit the preview showed, carrying its hash so a file that moved since is refused.
    public static func toggle(_ location: SkillLocationInfo, enabled: Bool, planHash: String, accountId: String? = nil) -> Self {
        var request = togglePreview(location, enabled: enabled, accountId: accountId)
        request.action = "toggle"
        request.planHash = planHash
        return request
    }

}

public struct SkillToggleReply: Decodable, Equatable, Sendable {
    public let name: String
    public let enabled: Bool
    public let file: String
    /// Unified diff; empty when the file already says so.
    public let diff: String
    public let planHash: String
    public let applied: Bool
    public let backup: String?

    public init(name: String, enabled: Bool, file: String, diff: String, planHash: String = "", applied: Bool = false, backup: String? = nil) {
        self.name = name
        self.enabled = enabled
        self.file = file
        self.diff = diff
        self.planHash = planHash
        self.applied = applied
        self.backup = backup
    }
}
