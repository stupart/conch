import Foundation

/// What a session is actually carrying: its plugins, skills, MCP servers and
/// their tools, each labelled by how conch knows it.
///
/// Decoded exactly as `src/agent-capabilities.ts` publishes it. Nothing is
/// computed on this side — in particular the evidence states, which are the
/// whole point: conch attaches to sessions it did not start, so it can see what
/// is CONFIGURED without knowing what is LOADED, and a UI that blurred those
/// would be lying in the one place it must not.
public struct AgentCapabilities: Decodable, Equatable, Sendable {
    public let context: Context
    public let entities: [Entity]
    public let diagnostics: [Diagnostic]
    /// False when a source could not be read. The list is then a floor, not a
    /// census, and the UI has to say so.
    public let complete: Bool

    public struct Context: Decodable, Equatable, Sendable {
        public let backend: String
        public let cwd: String
        public let projectTrust: ProjectTrust?
        /// What Codex recorded this thread as having STARTED with. Not a claim
        /// about what is live in its memory now.
        public let threadConfiguration: ThreadConfiguration?
    }

    public struct ProjectTrust: Decodable, Equatable, Sendable {
        public let projectPath: String
        /// nil means no decision has been recorded — which is not the same as a
        /// refusal, and must not be shown as one.
        public let trusted: Bool?
        public let basis: String
        public let detail: String
    }

    public struct ThreadConfiguration: Decodable, Equatable, Sendable {
        public let model: String?
        public let reasoningEffort: String?
        public let approvalMode: String?
        public let sandboxPolicy: String?
        public let cliVersion: String?
    }

    public struct Evidence: Decodable, Equatable, Sendable {
        /// "yes" | "no" | "unknown"
        public let state: String
        public let basis: String
        public let detail: String
    }

    public struct EvidenceSet: Decodable, Equatable, Sendable {
        public let configured: Evidence
        public let available: Evidence
        public let loaded: Evidence
        public let observed: Evidence
    }

    public struct Source: Decodable, Equatable, Sendable {
        public let kind: String
        public let path: String
        public let scope: String
    }

    public struct Diagnostic: Decodable, Equatable, Sendable {
        public let code: String?
        public let message: String?
        public let severity: String?
    }

    public struct Entity: Decodable, Equatable, Identifiable, Sendable {
        public let id: String
        /// "plugin" | "skill" | "mcp-server" | "mcp-tool"
        public let kind: String
        public let name: String
        public let displayName: String
        public let description: String?
        /// Tools hang off their server; this is how the tree is built.
        public let parentId: String?
        public let scope: String
        public let sources: [Source]
        public let evidence: EvidenceSet
        public let diagnostics: [Diagnostic]
        /// Per-kind facts. Exactly one is present, matching `kind`.
        public let plugin: Plugin?
        public let skill: Skill?
        public let mcpServer: McpServer?
        public let mcpTool: McpTool?

        /// A switch conch can honestly write (B3): a standalone plugin or MCP
        /// server at a scope conch edits. A plugin's own servers ride with the
        /// plugin, and a managed or unknown scope has no file conch writes.
        public var isToggleable: Bool {
            (kind == "plugin" || kind == "mcp-server") && parentId == nil
                && ["user", "project", "local"].contains(scope)
        }

        /// What the file says for the NEXT session — the toggle's position,
        /// never a claim about the running process. Unset reads as on: an
        /// installed plugin and a defined server run unless switched off, and
        /// a `.mcp.json` server Claude has not decided on is still pending.
        public var enabledForNextSession: Bool {
            if let plugin { return plugin.enabledForNextSession ?? true }
            if let mcpServer { return mcpServer.enabledForNextSession ?? (mcpServer.projectDecision != "rejected") }
            return false
        }

        /// The key the writer edits: `name@marketplace` for a plugin, the server name otherwise.
        public var configId: String { plugin?.pluginId ?? name }
    }

    public struct Plugin: Decodable, Equatable, Sendable {
        public let pluginId: String
        public let marketplace: String?
        public let version: String?
        public let installed: Bool
        /// Persisted state for a NEW session. Never presented as live state.
        public let enabledForNextSession: Bool?
        public let installPath: String?
        public let components: Components

        public struct Components: Decodable, Equatable, Sendable {
            public let skills: Int
            public let mcpServers: Int
            public let hooks: Bool
            public let apps: Bool
        }
    }

    public struct Skill: Decodable, Equatable, Sendable {
        public let path: String
        public let ownerPluginId: String?
        public let enabledForNextSession: Bool?
        /// "on" | "name-only" | "user-invocable-only" | "off"
        public let visibility: String?
        public let userInvocable: Bool
        public let modelInvocable: Bool
        public let allowedTools: [String]
        public let argumentHint: String?
        public let model: String?
        public let bytes: Int
    }

    public struct McpServer: Decodable, Equatable, Sendable {
        public let ownerPluginId: String?
        /// "stdio" | "http" | "sse" | "websocket" | "unknown"
        public let transport: String
        /// Executable only — arguments and environment values never cross the wire.
        public let command: String?
        public let argsCount: Int?
        /// Origin only — path, query, fragment and credentials are removed.
        public let url: String?
        public let credentialSources: [String]
        public let enabledForNextSession: Bool?
        public let projectDecision: String?
        public let required: Bool?
        public let startupTimeoutSeconds: Double?
        public let toolTimeoutSeconds: Double?
    }

    public struct McpTool: Decodable, Equatable, Sendable {
        public let serverName: String
        public let ownerPluginId: String?
        public let policy: String?
        public let approvalMode: String?
        /// Named by a manifest for display, with no catalog behind it.
        public let manifestHint: Bool
    }
}

extension AgentCapabilities.Entity {
    /// What this row leads with, in the order that matters to a reader.
    ///
    /// A DISABLED thing leads with being disabled. Preferring "configured"
    /// simply because a definition exists on disk made a switched-off MCP
    /// server, plugin or denied tool render identically to a working one — the
    /// reader can prove `available: no`, and the row hid it behind the fact
    /// that it was configured at all. That is precisely the lie this feature
    /// exists to avoid, and it is worse than saying nothing.
    ///
    /// After that: configured beats observed-only, because a definition on disk
    /// is stronger evidence than having seen it used once.
    public var headline: AgentCapabilities.Evidence {
        if evidence.available.state == "no" { return evidence.available }
        if evidence.configured.state == "yes" { return evidence.configured }
        if evidence.observed.state == "yes" { return evidence.observed }
        return evidence.configured
    }

    /// Configured nowhere conch could find, but seen in use. Worth showing
    /// rather than hiding: it means the session has something conch cannot
    /// account for.
    public var isObservedOnly: Bool {
        evidence.configured.state != "yes"
            && evidence.available.state != "no"
            && evidence.observed.state == "yes"
    }

    public var isUnavailable: Bool { evidence.available.state == "no" }
}

extension AgentCapabilities.Entity {
    /// The one line that answers "what KIND of thing is this" — transport for a
    /// server, version and marketplace for a plugin, who may invoke a skill,
    /// what approval a tool needs.
    ///
    /// The readers gathered all of this and the model used to drop it, so every
    /// row read as a name and a verdict: two MCP servers looked identical when
    /// one ran a local binary and the other reached a remote host, which is the
    /// single most useful thing to know about them.
    public var kindSummary: String? {
        var parts: [String] = []
        if let plugin {
            if let version = plugin.version, !version.isEmpty { parts.append("v\(version)") }
            if let marketplace = plugin.marketplace, !marketplace.isEmpty { parts.append(marketplace) }
            parts.append(contentsOf: plugin.componentSummary)
        } else if let skill {
            // "on" is the default and says nothing; anything else is the point.
            if let visibility = skill.visibility, visibility != "on" { parts.append(visibility) }
            parts.append(skill.invocationSummary)
            if !skill.allowedTools.isEmpty { parts.append(toolCount(skill.allowedTools.count)) }
        } else if let mcpServer {
            parts.append(mcpServer.transport)
            if let endpoint = mcpServer.endpoint { parts.append(endpoint) }
            if mcpServer.projectDecision == "rejected" { parts.append("rejected here") }
        } else if let mcpTool {
            if let approval = mcpTool.approvalMode ?? mcpTool.policy { parts.append(approval) }
            parts.append("from \(mcpTool.serverName)")
        }
        let summary = parts.filter { !$0.isEmpty }.joined(separator: " · ")
        return summary.isEmpty ? nil : summary
    }

    /// The same facts in full, for the expanded row. Anything conch does not
    /// know is omitted rather than shown as a blank or a guess.
    public var kindLines: [(String, String)] {
        var lines: [(String, String)] = []
        func add(_ label: String, _ value: String?) {
            guard let value, !value.isEmpty else { return }
            lines.append((label, value))
        }
        if let plugin {
            add("id", plugin.pluginId)
            add("version", plugin.version)
            add("marketplace", plugin.marketplace)
            add("contains", plugin.componentSummary.joined(separator: ", "))
            add("next session", nextSession(plugin.enabledForNextSession))
            add("installed at", plugin.installPath)
        } else if let skill {
            add("visibility", skill.visibility)
            add("invocable by", skill.invocationSummary)
            add("tools", skill.allowedTools.isEmpty ? nil : skill.allowedTools.joined(separator: ", "))
            add("model", skill.model)
            add("argument", skill.argumentHint)
            add("owner", skill.ownerPluginId)
            add("next session", nextSession(skill.enabledForNextSession))
            add("size", "\(skill.bytes) bytes")
        } else if let mcpServer {
            add("transport", mcpServer.transport)
            add("command", mcpServer.command)
            add("arguments", mcpServer.argsCount.map { "\($0)" })
            add("url", mcpServer.url)
            // Names only — conch reads where a credential comes from, never its value.
            add("credentials", mcpServer.credentialSources.isEmpty
                ? nil
                : mcpServer.credentialSources.joined(separator: ", "))
            add("this project", mcpServer.projectDecision)
            add("required", mcpServer.required.map { $0 ? "yes" : "no" })
            add("startup", mcpServer.startupTimeoutSeconds.map { "\(Int($0))s" })
            add("tool timeout", mcpServer.toolTimeoutSeconds.map { "\(Int($0))s" })
            add("owner", mcpServer.ownerPluginId)
            add("next session", nextSession(mcpServer.enabledForNextSession))
        } else if let mcpTool {
            add("server", mcpTool.serverName)
            add("policy", mcpTool.policy)
            add("approval", mcpTool.approvalMode)
            add("owner", mcpTool.ownerPluginId)
            if mcpTool.manifestHint {
                add("catalog", "named by a manifest, not read from the server")
            }
        }
        return lines
    }

    private func nextSession(_ enabled: Bool?) -> String? {
        // nil is "conch could not tell", which is not the same as "off".
        guard let enabled else { return nil }
        return enabled ? "enabled" : "disabled"
    }

    private func toolCount(_ count: Int) -> String {
        count == 1 ? "1 tool" : "\(count) tools"
    }
}

extension AgentCapabilities.Plugin {
    public var componentSummary: [String] {
        var parts: [String] = []
        if components.skills > 0 {
            parts.append(components.skills == 1 ? "1 skill" : "\(components.skills) skills")
        }
        if components.mcpServers > 0 {
            parts.append(components.mcpServers == 1 ? "1 server" : "\(components.mcpServers) servers")
        }
        if components.hooks { parts.append("hooks") }
        if components.apps { parts.append("apps") }
        return parts
    }
}

extension AgentCapabilities.Skill {
    /// Who can actually reach this — the distinction between a slash command
    /// and something the model picks up on its own.
    public var invocationSummary: String {
        switch (userInvocable, modelInvocable) {
        case (true, true): return "you or the model"
        case (true, false): return "you only"
        case (false, true): return "the model only"
        case (false, false): return "neither"
        }
    }
}

extension AgentCapabilities.McpServer {
    /// What it actually talks to: the binary for stdio, the host for a remote.
    public var endpoint: String? {
        if let command, !command.isEmpty { return (command as NSString).lastPathComponent }
        guard let url, !url.isEmpty else { return nil }
        return URL(string: url)?.host ?? url
    }
}

/// Which Claude Code / Codex binary THIS session's process is actually
/// running, where it lives, and whether a newer copy of the same agent is
/// running elsewhere on this Mac right now.
///
/// A sibling of `AgentCapabilities`, not a field on it: this comes from the
/// process's own identity (the kernel's `proc_pidpath`, not a config file)
/// plus a bounded `--version` of that exact binary — the one thing here conch
/// knows with certainty rather than "configured, availability unknown". Absent
/// entirely when that identity was never captured, rather than shown as an
/// "unknown" row: SURFACE and ADVISE only, never a guess and never a
/// suggestion to run something conch did not verify.
public struct AgentInstall: Decodable, Equatable, Sendable {
    public let backend: String
    public let executable: String
    /// From `<executable> --version`; nil when it could not be read.
    public let version: String?
    /// "homebrew-cask" | "npm-global" | "claude-desktop-app" | "other"
    public let location: String
    public let packageId: String?
    /// What would update THIS install; nil when conch has no safe command to give.
    public let updateCommand: String?
    /// An older version than another copy of the SAME agent running on this Mac right now.
    public let behind: Bool
    /// The newer version found among this Mac's other live copies, when behind.
    public let newerVersion: String?
    /// The newer version is already installed where this one came from: restarting the session is the whole update.
    public let restartToUpdate: Bool?
}

extension AgentInstall {
    /// Says where it lives however specifically conch can, but never fabricates a token it doesn't have.
    public var locationLabel: String {
        switch location {
        case "homebrew-cask": return packageId.map { "Homebrew cask · \($0)" } ?? "Homebrew cask"
        case "npm-global": return packageId.map { "npm · \($0)" } ?? "npm global"
        case "claude-desktop-app": return "the Claude desktop app"
        default: return "an install conch does not recognize"
        }
    }
}
