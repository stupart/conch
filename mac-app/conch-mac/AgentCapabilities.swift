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
