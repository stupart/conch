import Foundation

/// The environment conch's daemon starts with, from the app's own.
///
/// An app opened from inside an agent session (`open -a`, `scripts/build-app.sh`'s relaunch) inherits that
/// session's environment: its `CLAUDE_CONFIG_DIR`, its `TMUX`, `CONCH_BACKGROUND_PID`, a dozen `CLAUDE_CODE_*`.
/// On 2026-10-02 a daemon started that way took one account's folder for the default account's, read the two as
/// one, and could list no sessions at all. None of it was the user's: it was one session's.
///
/// So when the app's environment says it came from inside an agent session, everything agent-scoped is dropped
/// before the daemon sees it. Started any other way, nothing is touched: a `CLAUDE_CONFIG_DIR` a person set for
/// themselves stays theirs.
public enum DaemonEnvironment {
    /// Set only inside an agent's session (Claude Code, Codex, or one conch hosts).
    public static let sessionMarkers = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_SHELL", "CONCH_BACKGROUND_PID", "AI_AGENT"]

    /// Whose they are, by name: the agents', tmux's, and conch's own (the app sets conch's afresh).
    static let sessionPrefixes = ["CLAUDE", "CODEX_", "TMUX", "AI_AGENT", "CONCH_"]

    public static func launchedFromAgentSession(_ environment: [String: String]) -> Bool {
        sessionMarkers.contains { environment[$0] != nil }
    }

    public static func cleaned(_ environment: [String: String]) -> [String: String] {
        guard launchedFromAgentSession(environment) else { return environment }
        return environment.filter { key, _ in !sessionPrefixes.contains { key.hasPrefix($0) } }
    }
}
