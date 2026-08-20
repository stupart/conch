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
    /// The one word this row leads with. Configured-on-disk is the strongest
    /// thing conch can say about an attached session, so it wins; observed-only
    /// means conch saw it used without finding a definition, which is worth
    /// surfacing rather than hiding.
    var headline: AgentCapabilities.Evidence {
        if evidence.configured.state == "yes" { return evidence.configured }
        if evidence.observed.state == "yes" { return evidence.observed }
        return evidence.configured
    }

    var isObservedOnly: Bool {
        evidence.configured.state != "yes" && evidence.observed.state == "yes"
    }
}
