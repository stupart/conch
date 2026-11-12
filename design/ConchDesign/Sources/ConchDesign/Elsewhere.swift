import SwiftUI

// Not in conch: the agents running on this Mac that conch has no row for (2026-11-12).
//
// Tyler: "is there a way to see ones that are active but not in conch and then move them in? maybe new section at
// bottom of left sidebar that's usually collapsed?" The daemon finds them (src/elsewhere.ts) and says, for each, why
// conch can't watch it and the one thing that would bring it in. What that sounds like lives here, so the Mac's section
// and the phone's say it the same way: the daemon sends codes, never sentences.

/// One agent as `PublishedState.elsewhere` carries it.
public struct ElsewhereAgent: Decodable, Equatable, Sendable, Identifiable {
    /// `<backend>:<pid>`: what an action names it by.
    public let id: String
    public let backend: String
    public let pid: Int
    /// Where its terminal is: terminal, iterm, tmux, vscode, cursor, warp, ghostty, ssh, chatgpt, claude-app,
    /// other-terminal or none.
    public let host: String
    /// profile, no-registry, codex-thread or app.
    public let reason: String
    /// add-account, resume, start-sheet or none.
    public let remedy: String
    public let label: String?
    public let cwd: String?
    /// The profile it runs in, as a short name: never a path with an email in it.
    public let account: String?
    public let conversationId: String?
    /// Epoch-ms.
    public let startedAt: Double?

    public init(
        id: String, backend: String, pid: Int, host: String, reason: String, remedy: String,
        label: String? = nil, cwd: String? = nil, account: String? = nil, conversationId: String? = nil, startedAt: Double? = nil
    ) {
        self.id = id
        self.backend = backend
        self.pid = pid
        self.host = host
        self.reason = reason
        self.remedy = remedy
        self.label = label
        self.cwd = cwd
        self.account = account
        self.conversationId = conversationId
        self.startedAt = startedAt
    }

    /// What its action is.
    public enum Action: Equatable, Sendable {
        /// Read its profile folder as a Claude account: it becomes a row where it runs.
        case addAccount
        /// Its conversation, again, in a conch terminal; the original keeps running.
        case resume
        /// New session, to pick its conversation under Resume.
        case startSheet
    }

    public var action: Action? {
        switch remedy {
        case "add-account": return .addAccount
        case "resume": return conversationId == nil ? nil : .resume
        case "start-sheet": return .startSheet
        default: return nil
        }
    }
}

/// What Not in conch says, in words.
public enum ElsewhereText {
    /// The section's header.
    public static let header = "Not in conch"

    public static func headerAccessibility(count: Int, collapsed: Bool) -> String {
        "\(header), \(count) \(count == 1 ? "agent" : "agents")\(collapsed ? ", collapsed" : "")"
    }

    /// The app its terminal is in, as a sentence names it.
    public static func hostName(_ host: String) -> String {
        switch host {
        case "terminal": return "Terminal"
        case "iterm": return "iTerm"
        case "tmux": return "tmux"
        case "vscode": return "VS Code"
        case "cursor": return "Cursor"
        case "warp": return "Warp"
        case "ghostty": return "Ghostty"
        case "ssh": return "an SSH session"
        case "chatgpt": return "the ChatGPT app"
        case "claude-app": return "the Claude app"
        case "other-terminal": return "another terminal"
        default: return "no terminal conch knows"
        }
    }

    private static func agentName(_ backend: String) -> String {
        backend == "codex" ? "Codex" : "Claude"
    }

    /// Its row's name: what its registry calls it, else its folder, else the agent and where it runs.
    public static func title(_ agent: ElsewhereAgent) -> String {
        if agent.host == "chatgpt" { return "ChatGPT app" }
        if let label = present(agent.label) { return label }
        if let cwd = present(agent.cwd), cwd != "/" { return (cwd as NSString).lastPathComponent }
        return "\(agentName(agent.backend)) in \(hostName(agent.host))"
    }

    /// Why conch has no row for it, short enough for the row's second line.
    public static func why(_ agent: ElsewhereAgent) -> String {
        switch agent.reason {
        case "profile": return "Profile conch doesn't read"
        case "no-registry": return "Not registered where conch looks"
        case "codex-thread": return "No thread conch can see"
        case "app": return "conch can't type into it"
        default: return "conch can't watch it"
        }
    }

    /// The app its terminal is in, as the start of a row's line names it.
    public static func shortHostName(_ host: String) -> String {
        switch host {
        case "ssh": return "SSH"
        case "chatgpt": return "ChatGPT app"
        case "claude-app": return "Claude app"
        case "other-terminal": return "Other terminal"
        case "terminal", "iterm", "tmux", "vscode", "cursor", "warp", "ghostty": return hostName(host)
        default: return "No terminal"
        }
    }

    /// The row's second line: where it runs, and why it isn't a row. The ChatGPT app's says Codex, the app is its name.
    public static func line(_ agent: ElsewhereAgent) -> String {
        "\(agent.host == "chatgpt" ? "Codex" : shortHostName(agent.host)) · \(why(agent))"
    }

    /// The one thing that would bring it in, said in full: the tooltip's, VoiceOver's, and the row's own when it has
    /// no button.
    public static func fix(_ agent: ElsewhereAgent) -> String {
        let account = present(agent.account) ?? "its profile folder"
        switch (agent.remedy, agent.action) {
        case ("add-account", _):
            return "Add \(account) as a Claude account: conch reads it like Default, and this becomes a row where it runs."
        case ("resume", .resume?):
            return "Resume it in conch: the same conversation in a conch terminal. The original keeps running in \(hostName(agent.host)) until you quit it."
        case ("start-sheet", _) where agent.host == "chatgpt":
            return "Its threads show in conch while one is open, but conch can't type into them. To talk to one here, resume it from New session › Resume."
        case ("start-sheet", _):
            return "Quit it, then resume its thread from New session › Resume."
        default:
            return agent.backend == "claude"
                ? "If it's waiting on Claude's first question (trusting its folder), answer it there and it becomes a row. Otherwise quit it and start it again from conch."
                : "Quit it and start it again from conch."
        }
    }

    /// The button's word, nil when there is nothing to press.
    public static func actionTitle(_ agent: ElsewhereAgent) -> String? {
        switch agent.action {
        case .addAccount: return "Add"
        case .resume: return "Resume"
        case .startSheet: return "Resume…"
        case nil: return nil
        }
    }

    /// The whole of it, one fact a line: name, where and why, the fix, then what conch read about it.
    public static func tooltip(_ agent: ElsewhereAgent) -> String {
        var lines = [title(agent), "\(agentName(agent.backend)) in \(hostName(agent.host)). \(why(agent)).", fix(agent)]
        if let cwd = present(agent.cwd) { lines.append(cwd) }
        if let account = present(agent.account) { lines.append("Profile: \(account)") }
        lines.append("Process \(agent.pid)")
        return lines.joined(separator: "\n")
    }

    public static func accessibilityLabel(_ agent: ElsewhereAgent) -> String {
        "\(title(agent)), \(agentName(agent.backend)) in \(hostName(agent.host)), \(why(agent))"
    }

    /// What the Mac asks before acting, as an alert's title, message and confirming button. Nil for an action that
    /// only opens a sheet.
    public static func confirmation(_ agent: ElsewhereAgent, background: Bool) -> (title: String, message: String, confirm: String)? {
        let name = title(agent)
        switch agent.action {
        case .resume:
            let place = background ? "a new background session" : "a new Terminal window"
            let profile = present(agent.account).map { " in \($0)" } ?? ""
            return (
                "Resume “\(name)” in conch?",
                "conch opens the same conversation in \(place)\(profile). The original keeps running in \(hostName(agent.host)); conch won't stop it. Quit it there once the new one is open, so the two don't both write to the conversation.",
                "Resume in conch"
            )
        case .addAccount:
            let account = present(agent.account) ?? "this profile folder"
            return (
                "Add \(account) as a Claude account?",
                "conch reads the sessions in that folder as it reads Default's, so “\(name)” becomes a row, and puts conch's hooks in that profile's settings so its turns are announced. Nothing is stopped or restarted.",
                "Add Account"
            )
        case .startSheet, nil:
            return nil
        }
    }

    private static func present(_ text: String?) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }
}

/// One agent in Not in conch: its agent's mark, its name and where-and-why, and the button that brings it in.
///
/// Fainter than a session's row: it is a thing conch knows of, not one it is talking to. The mark is the agent's own
/// (the host's AgentClaude or AgentCodex asset, `mark`), dimmed; the name fades at its end like a row's; the second
/// line is `ElsewhereText.line`. The button is small and plain, the active blue, and says one word: what it does is in
/// the tooltip and is asked before it happens.
public struct ElsewhereRow: View {
    let agent: ElsewhereAgent
    let mark: Image?
    let nameFont: Font
    let lineFont: Font
    let message: String?
    let onAction: (() -> Void)?

    /// `nameFont` and `lineFont`: the Mac's fixed sidebar sizes, or text styles on the phone, which scale with the
    /// reader's text size. `message`: conch's word about an action on it ("Resuming…", or why it didn't), in place of
    /// its second line. `onAction` nil draws no button (the phone's, which only shows).
    public init(
        _ agent: ElsewhereAgent,
        mark: Image? = nil,
        nameFont: Font = .system(size: 13),
        lineFont: Font = .system(size: 11),
        message: String? = nil,
        onAction: (() -> Void)? = nil
    ) {
        self.agent = agent
        self.mark = mark
        self.nameFont = nameFont
        self.lineFont = lineFont
        self.message = message
        self.onAction = onAction
    }

    public var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Group {
                if let mark {
                    mark.resizable().scaledToFit().frame(width: 12, height: 12)
                } else {
                    Image(systemName: "circle.dashed").font(.system(size: 9, weight: .medium))
                }
            }
            .foregroundStyle(ConchColor.textTertiary)
            .frame(width: 16, height: 16)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                TailFadeText(ElsewhereText.title(agent))
                    .font(nameFont)
                    .foregroundStyle(ConchColor.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                TailFadeText(message ?? ElsewhereText.line(agent), fade: 24)
                    .font(lineFont)
                    .foregroundStyle(message == nil ? ConchColor.textTertiary : ConchColor.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let onAction, let title = ElsewhereText.actionTitle(agent) {
                Button(action: onAction) {
                    Text(title)
                        .font(lineFont.weight(.medium))
                        .foregroundStyle(ConchColor.active)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Capsule(style: .continuous).fill(ConchColor.active.opacity(0.1)))
                        .contentShape(Capsule(style: .continuous))
                }
                .buttonStyle(.plain)
                .fixedSize()
                .help(ElsewhereText.fix(agent))
                .accessibilityLabel("\(title) \(ElsewhereText.title(agent))")
                .accessibilityHint(ElsewhereText.fix(agent))
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
        .contentShape(Rectangle())
        .help(ElsewhereText.tooltip(agent))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ElsewhereText.accessibilityLabel(agent))
        .accessibilityValue(agent.action == nil ? ElsewhereText.fix(agent) : "")
    }
}
