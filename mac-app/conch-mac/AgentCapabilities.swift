import Foundation

/// What a session is actually carrying: its plugins, skills, MCP servers and
/// their tools, each labelled by how conch knows it.
///
/// Decoded exactly as `src/agent-capabilities.ts` publishes it. Nothing is
/// computed on this side — in particular the evidence states, which are the
/// whole point: conch attaches to sessions it did not start, so it can see what
/// is CONFIGURED without knowing what is LOADED, and a UI that blurred those
/// would be lying in the one place it must not.
struct AgentCapabilities: Decodable, Equatable, Sendable {
    let context: Context
    let entities: [Entity]
    let diagnostics: [Diagnostic]
    /// False when a source could not be read. The list is then a floor, not a
    /// census, and the UI has to say so.
    let complete: Bool

    struct Context: Decodable, Equatable, Sendable {
        let backend: String
        let cwd: String
        let projectTrust: ProjectTrust?
        /// What Codex recorded this thread as having STARTED with. Not a claim
        /// about what is live in its memory now.
        let threadConfiguration: ThreadConfiguration?
    }

    struct ProjectTrust: Decodable, Equatable, Sendable {
        let projectPath: String
        /// nil means no decision has been recorded — which is not the same as a
        /// refusal, and must not be shown as one.
        let trusted: Bool?
        let basis: String
        let detail: String
    }

    struct ThreadConfiguration: Decodable, Equatable, Sendable {
        let model: String?
        let reasoningEffort: String?
        let approvalMode: String?
        let sandboxPolicy: String?
        let cliVersion: String?
    }

    struct Evidence: Decodable, Equatable, Sendable {
        /// "yes" | "no" | "unknown"
        let state: String
        let basis: String
        let detail: String
    }

    struct EvidenceSet: Decodable, Equatable, Sendable {
        let configured: Evidence
        let available: Evidence
        let loaded: Evidence
        let observed: Evidence
    }

    struct Source: Decodable, Equatable, Sendable {
        let kind: String
        let path: String
        let scope: String
    }

    struct Diagnostic: Decodable, Equatable, Sendable {
        let code: String?
        let message: String?
        let severity: String?
    }

    struct Entity: Decodable, Equatable, Identifiable, Sendable {
        let id: String
        /// "plugin" | "skill" | "mcp-server" | "mcp-tool"
        let kind: String
        let name: String
        let displayName: String
        let description: String?
        /// Tools hang off their server; this is how the tree is built.
        let parentId: String?
        let scope: String
        let sources: [Source]
        let evidence: EvidenceSet
        let diagnostics: [Diagnostic]
        /// Per-kind facts. Exactly one is present, matching `kind`.
        let plugin: Plugin?
        let skill: Skill?
        let mcpServer: McpServer?
        let mcpTool: McpTool?
    }

    struct Plugin: Decodable, Equatable, Sendable {
        let pluginId: String
        let marketplace: String?
        let version: String?
        let installed: Bool
        /// Persisted state for a NEW session. Never presented as live state.
        let enabledForNextSession: Bool?
        let installPath: String?
        let components: Components

        struct Components: Decodable, Equatable, Sendable {
            let skills: Int
            let mcpServers: Int
            let hooks: Bool
            let apps: Bool
        }
    }

    struct Skill: Decodable, Equatable, Sendable {
        let path: String
        let ownerPluginId: String?
        let enabledForNextSession: Bool?
        /// "on" | "name-only" | "user-invocable-only" | "off"
        let visibility: String?
        let userInvocable: Bool
        let modelInvocable: Bool
        let allowedTools: [String]
        let argumentHint: String?
        let model: String?
        let bytes: Int
    }

    struct McpServer: Decodable, Equatable, Sendable {
        let ownerPluginId: String?
        /// "stdio" | "http" | "sse" | "websocket" | "unknown"
        let transport: String
        /// Executable only — arguments and environment values never cross the wire.
        let command: String?
        let argsCount: Int?
        /// Origin only — path, query, fragment and credentials are removed.
        let url: String?
        let credentialSources: [String]
        let enabledForNextSession: Bool?
        let projectDecision: String?
        let required: Bool?
        let startupTimeoutSeconds: Double?
        let toolTimeoutSeconds: Double?
    }

    struct McpTool: Decodable, Equatable, Sendable {
        let serverName: String
        let ownerPluginId: String?
        let policy: String?
        let approvalMode: String?
        /// Named by a manifest for display, with no catalog behind it.
        let manifestHint: Bool
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
    var headline: AgentCapabilities.Evidence {
        if evidence.available.state == "no" { return evidence.available }
        if evidence.configured.state == "yes" { return evidence.configured }
        if evidence.observed.state == "yes" { return evidence.observed }
        return evidence.configured
    }

    /// Configured nowhere conch could find, but seen in use. Worth showing
    /// rather than hiding: it means the session has something conch cannot
    /// account for.
    var isObservedOnly: Bool {
        evidence.configured.state != "yes"
            && evidence.available.state != "no"
            && evidence.observed.state == "yes"
    }

    var isUnavailable: Bool { evidence.available.state == "no" }
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
    var kindSummary: String? {
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
    var kindLines: [(String, String)] {
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
    var componentSummary: [String] {
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
    var invocationSummary: String {
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
    var endpoint: String? {
        if let command, !command.isEmpty { return (command as NSString).lastPathComponent }
        guard let url, !url.isEmpty else { return nil }
        return URL(string: url)?.host ?? url
    }
}
