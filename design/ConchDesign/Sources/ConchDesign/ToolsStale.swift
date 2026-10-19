import SwiftUI

// A session whose conch tools are out of date (2026-10-19).
//
// Each session runs its own `conch mcp` server and keeps the tools it loaded when it started. The 18 Oct review found
// agents never used conch's browser tools, because 18 of 19 live sessions' servers predated them; a server started before
// 15 Oct can't take a newer conch's tools at all. The daemon now says which sessions those are (`rows[].toolsStale`,
// src/mcp-servers.ts), and restarting one, which keeps its conversation, is the fix. This is how the app says so: one
// quiet line under the session's header with Restart, a row in "What this session carries", and Settings › General's
// "Restart idle sessions". Not on the sidebar: with most sessions out of date at once, a mark on nearly every row says
// nothing, and it would sit among marks that each mean "this needs you", which this doesn't.

/// What the daemon puts on a session's row when its conch MCP server can't get conch's current tools
/// (`rows[].toolsStale`, src/mcp-servers.ts `ToolsStale`). Absent from an older daemon, and from a session that is current.
public struct ToolsStale: Decodable, Equatable, Sendable {
    /// The current tools its server lacks, by name, in the daemon's order. Never empty: a verdict naming nothing is none.
    public let missing: [String]
    /// "reported" (its server said what it has) or "estimated" (a server too old to say, judged by when it started).
    public let basis: String?
    /// When its conch MCP server started, ISO 8601.
    public let serverStartedAt: String?
    /// Why it won't get them without a restart, in the daemon's words ("its conch MCP server started 2026-10-12, …").
    public let why: String?

    public init(missing: [String], basis: String? = nil, serverStartedAt: String? = nil, why: String? = nil) {
        self.missing = missing
        self.basis = basis
        self.serverStartedAt = serverStartedAt
        self.why = why
    }

    private enum CodingKeys: String, CodingKey { case missing, basis, serverStartedAt, why }

    /// Leniently, like the rest of a row: anything but `missing` may be absent or a newer shape. A verdict with no tools
    /// named throws, so the row decodes it as no verdict (`try?`) rather than a line that says "missing nothing".
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let missing = (try? c.decode([String].self, forKey: .missing))?.filter { !$0.isEmpty } ?? []
        guard !missing.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .missing, in: c, debugDescription: "no tools named")
        }
        self.missing = missing
        basis = try? c.decodeIfPresent(String.self, forKey: .basis)
        serverStartedAt = try? c.decodeIfPresent(String.self, forKey: .serverStartedAt)
        why = try? c.decodeIfPresent(String.self, forKey: .why)
    }
}

/// The words for an out-of-date session, wherever the app says it.
public enum ToolsStaleWords {
    public static let headline = "conch's tools are out of date"
    /// Beside Restart: what a restart costs, which is the thing a person wants to know before pressing it.
    public static let keepsConversation = "keeps the conversation"
    /// Where conch can't restart it itself (no terminal to type into).
    public static let restartByHand = "close it and resume it to update"

    /// How many names a line keeps when there are more than one more than this: four are said, five are three and "2 more".
    static let named = 3

    /// What it is missing, as a person would say it, most useful first: "the browser tools" for `browser_*` (when it
    /// has none of them; when it has the browser and lacks newer ones, those by name, or how many), "fork" for
    /// `conch_fork`, "Atlas pages" for `atlas_show`, and any other tool by its own name, in the daemon's order.
    public static func missingNames(_ tools: [String]) -> [String] {
        let browser = tools.filter { $0.hasPrefix("browser_") }
        var names: [String] = []
        if tools.contains("browser_open") {
            names.append("the browser tools")
        } else if browser.count == 1 {
            names.append(browser[0])
        } else if browser.count > 1 {
            names.append("\(browser.count) browser tools")
        }
        if tools.contains("conch_fork") { names.append("fork") }
        if tools.contains("atlas_show") { names.append("Atlas pages") }
        var seen = Set<String>()
        for tool in tools where !tool.hasPrefix("browser_") && tool != "conch_fork" && tool != "atlas_show" {
            if seen.insert(tool).inserted { names.append(tool) }
        }
        return names
    }

    /// "the browser tools, fork and Atlas pages"; up to four by name, then three and "and 2 more".
    public static func missing(_ tools: [String]) -> String {
        let names = missingNames(tools)
        if names.count > named + 1 {
            return list(Array(names.prefix(named)) + ["\(names.count - named) more"])
        }
        return list(names)
    }

    /// The line: "conch's tools are out of date · missing the browser tools, fork and Atlas pages".
    public static func line(_ stale: ToolsStale) -> String {
        "\(headline) · missing \(missing(stale.missing))"
    }

    /// The tooltip: every tool by name, why a running session can't take them, and what a restart does.
    public static func help(_ stale: ToolsStale, canRestart: Bool) -> String {
        var lines = ["Missing: \(stale.missing.joined(separator: ", "))."]
        if let why = stale.why?.trimmingCharacters(in: .whitespacesAndNewlines), let first = why.first {
            let sentence = first.uppercased() + why.dropFirst()
            lines.append(sentence.hasSuffix(".") ? sentence : sentence + ".")
        }
        lines.append(canRestart
            ? "Restart closes it cleanly and resumes the same conversation in a new Terminal window, with conch's current tools."
            : "Close it and resume it to get conch's current tools; its conversation comes back with it.")
        return lines.joined(separator: "\n")
    }

    /// "a", "a and b", "a, b and c".
    static func list(_ names: [String]) -> String {
        switch names.count {
        case 0: return ""
        case 1: return names[0]
        default: return names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
        }
    }
}

/// When Restart restarts at once, and which sessions "Restart idle sessions" takes.
public enum ToolsStaleRestart {
    /// At rest: its turn is over (`waiting`, or `review` holding a result), nothing it started is still running, and
    /// nothing waits on an answer. A restart there loses nothing, so one click does it. Anything else asks first, with
    /// the session menu's own confirmation, because a turn in progress stops.
    public static func isIdle(status: String?, waitingOnAgents: Bool, approvalPending: Bool) -> Bool {
        guard !waitingOnAgents, !approvalPending else { return false }
        return status == "waiting" || status == "review"
    }

    /// A session as "Restart idle sessions" sees it.
    public struct Session: Equatable, Sendable {
        public let id: String
        public let label: String
        public let stale: Bool
        public let isIdle: Bool
        /// conch can restart it: a top-level session with a terminal to type into.
        public let canRestart: Bool

        public init(id: String, label: String, stale: Bool, isIdle: Bool, canRestart: Bool) {
            self.id = id
            self.label = label
            self.stale = stale
            self.isIdle = isIdle
            self.canRestart = canRestart
        }
    }

    /// The out-of-date sessions, split: the idle ones conch can restart now, and the rest (working, or with no terminal).
    public static func split(_ sessions: [Session]) -> (idle: [Session], other: [Session]) {
        let stale = sessions.filter(\.stale)
        return (stale.filter { $0.isIdle && $0.canRestart }, stale.filter { !($0.isIdle && $0.canRestart) })
    }

    /// The confirmation for restarting `idle`: each by name, one a line, and that the other out-of-date ones are left alone.
    public static func confirmation(idle: [String], leftAlone: Int) -> (title: String, message: String) {
        let title = idle.count == 1 ? "Restart \(idle[0])?" : "Restart \(idle.count) idle sessions?"
        var message = idle.count == 1 ? "" : idle.joined(separator: "\n") + "\n\n"
        message += idle.count == 1
            ? "conch closes it cleanly, then resumes the same conversation in a new Terminal window, with conch's current tools."
            : "conch closes each cleanly, one at a time, then resumes the same conversation in a new Terminal window, with conch's current tools."
        if leftAlone > 0 {
            message += leftAlone == 1 ? " The other one is left alone." : " The other \(leftAlone) are left alone."
        }
        return (title, message)
    }

    /// Settings › General's row: "conch's tools are out of date in 9 sessions".
    public static func title(sessions: Int) -> String {
        "\(ToolsStaleWords.headline) in \(sessions == 1 ? "1 session" : "\(sessions) sessions")"
    }

    /// Under it: how many can restart now (the rest are at work, or have no terminal for conch to restart them in), and
    /// what a restart costs.
    public static func detail(idle: Int, other: Int) -> String {
        let total = idle + other
        let now: String
        switch idle {
        case total: now = total == 1 ? "It's idle" : "All are idle"
        case 0: now = total == 1 ? "It isn't idle" : "None is idle"
        case 1: now = "1 is idle"
        default: now = "\(idle) are idle"
        }
        return "\(now). Restarting keeps \(total == 1 ? "its" : "each") conversation."
    }
}

// MARK: - The line under the session's header

/// One line under a session's header when its conch tools are out of date: a mark and the words on the header's left
/// axis, where the title starts (14 in), and Restart on its right, ending where the header's ••• ends, "keeps the
/// conversation" before it while there is room. Quiet on purpose: the header's own surface, no wash, no attention colour;
/// it isn't asking for anything now, it's saying what a restart would bring.
public struct SessionToolsNotice: View {
    let stale: ToolsStale
    /// nil where conch can't restart it: the line then says how to by hand.
    let restart: (() -> Void)?
    let isRestarting: Bool
    @State private var isHovered: Bool

    /// Tall enough for Restart's capsule with 5 above and below, like the Workdesk's strip under its address bar.
    public static let height: CGFloat = 30
    static let buttonHeight: CGFloat = 20
    /// Restart's shape: the Workdesk's Done, half a point short of a capsule, which draws clean ends (WorkbenchNotice).
    static let buttonShape = RoundedRectangle(cornerRadius: buttonHeight / 2 - 0.5)
    /// Where the mark's image starts, so its ink starts on the title's (the session header's leading 14, and the first
    /// letter's own side bearing, measured at a point).
    static let markInset: CGFloat = 14
    /// From the right edge to Restart's: where the header's ••• ink ends. The session menu is a borderless-button menu,
    /// which draws its label as AppKit builds a menu item's, not in the 28-point box its code gives it: its dots are 12
    /// wide and end 12 from the header's edge (measured in conch's window and in SessionToolsRenderTests, 2026-10-19).
    public static let trailingInset: CGFloat = 12
    /// The mark's image from its start to the end of its ink: a point of room before the ink, nine of arrow.
    static let markSlot: CGFloat = 10

    public init(_ stale: ToolsStale, isRestarting: Bool = false, isHovered: Bool = false, restart: (() -> Void)?) {
        self.stale = stale
        self.isRestarting = isRestarting
        self.restart = restart
        _isHovered = State(initialValue: isHovered)
    }

    public var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "arrow.clockwise")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(ConchColor.textSecondary)
                // A slot that ends where its ink does (the Workdesk strip's rule), so the words start 7 after the mark
                // itself rather than after the symbol's image, which runs past its ink.
                .frame(width: Self.markSlot, alignment: .leading)
                .accessibilityHidden(true)
            // The longest that fits: the words and the hint, then the words alone, then the words cut.
            ViewThatFits(in: .horizontal) {
                trailing(words.fixedSize(), hint: true)
                trailing(words.fixedSize(), hint: false)
                trailing(words.lineLimit(1).truncationMode(.tail), hint: false)
            }
        }
        .padding(.leading, Self.markInset)
        .padding(.trailing, Self.trailingInset)
        .frame(height: Self.height)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ConchColor.surface)
        .help(ToolsStaleWords.help(stale, canRestart: restart != nil))
        .accessibilityElement(children: .contain)
    }

    private var words: some View {
        (Text(verbatim: ToolsStaleWords.headline).fontWeight(.medium).foregroundStyle(ConchColor.textPrimary)
            + Text(verbatim: " · missing \(ToolsStaleWords.missing(stale.missing))").foregroundStyle(ConchColor.textSecondary))
            .font(.system(size: 11))
            .accessibilityLabel(ToolsStaleWords.line(stale))
    }

    /// 7 between the hint's frame and Restart's: with the last letter's own side bearing, 8 between the ink.
    private func trailing(_ words: some View, hint: Bool) -> some View {
        HStack(spacing: 7) {
            words
            Spacer(minLength: 12)
            if restart == nil {
                if hint { hintText(ToolsStaleWords.restartByHand) }
            } else {
                if hint, !isRestarting { hintText(ToolsStaleWords.keepsConversation) }
                button
            }
        }
    }

    private func hintText(_ text: String) -> some View {
        Text(verbatim: text)
            .font(.system(size: 11))
            .foregroundStyle(ConchColor.textTertiary)
            .lineLimit(1)
            .fixedSize()
    }

    private var button: some View {
        Button {
            guard !isRestarting else { return }
            restart?()
        } label: {
            Text(isRestarting ? "Restarting…" : "Restart")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(isRestarting ? ConchColor.textSecondary : ConchColor.textPrimary)
                .padding(.horizontal, 10)
                .frame(height: Self.buttonHeight)
                // Hover steps the way a row's does: `fillSelected` is the surface's own white in light, and answered nothing.
                .background(Self.buttonShape.fill(isHovered && !isRestarting ? AnyShapeStyle(ConchColor.rowHover) : AnyShapeStyle(ConchColor.surface)))
                .overlay(Self.buttonShape.strokeBorder(ConchColor.hairlineStrong, lineWidth: 1))
                .contentShape(Self.buttonShape)
                .fixedSize()
        }
        .buttonStyle(.plain)
        // Not `.disabled`: that fades the label and the border a second time, to 2.2:1 and a ghost of an outline. The
        // label's own colour already says it is busy; it just can't be pressed again.
        .allowsHitTesting(!isRestarting)
        .onHover { isHovered = $0 }
        .accessibilityLabel(isRestarting ? "Restarting" : "Restart")
        .accessibilityHint("Restarts the session with conch's current tools; it keeps the conversation")
    }
}

// MARK: - "What this session carries"

/// The capability inspector's row for it, under Version and in its words: "conch tools  out of date · missing …", and
/// Restart session with what it costs beside it. Two lines rather than one, so the 620-point sheet never cuts the names.
public struct InspectorToolsRow: View {
    let stale: ToolsStale
    let restart: (() -> Void)?

    public init(_ stale: ToolsStale, restart: (() -> Void)?) {
        self.stale = stale
        self.restart = restart
    }

    public var body: some View {
        // The inspector header's own spacing between its lines.
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(verbatim: "conch tools")
                    .font(.system(size: 11))
                    .foregroundStyle(ConchColor.textTertiary)
                Text(verbatim: "out of date · missing \(ToolsStaleWords.missing(stale.missing))")
                    .font(.system(size: 11))
                    .foregroundStyle(ConchColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .help(ToolsStaleWords.help(stale, canRestart: restart != nil))
            if let restart {
                // On the button label's baseline: centred, the smaller hint sat half a point high.
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Button("Restart session", action: restart)
                        .controlSize(.small)
                    Text(verbatim: ToolsStaleWords.keepsConversation)
                        .font(.system(size: 10.5))
                        .foregroundStyle(ConchColor.textTertiary)
                }
            }
        }
    }
}

// MARK: - Settings › General

/// Settings › General's row for every out-of-date session at once, in the card style of the rows above it (the daemon's
/// switch, open at login): a mark in their 7-point column, the count and how many are idle, and Restart Idle Sessions…,
/// which the app confirms by naming each one.
public struct StaleToolsSettingsRow: View {
    let idle: Int
    let other: Int
    let action: () -> Void

    public init(idle: Int, other: Int, action: @escaping () -> Void) {
        self.idle = idle
        self.other = other
        self.action = action
    }

    public var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "arrow.clockwise")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(ConchColor.textSecondary)
                .frame(width: 7)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: ToolsStaleRestart.title(sessions: idle + other))
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(ConchColor.textPrimary)
                Text(verbatim: ToolsStaleRestart.detail(idle: idle, other: other))
                    .font(.system(size: 11))
                    .foregroundStyle(ConchColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 12)

            Button("Restart Idle Sessions…", action: action)
                .controlSize(.small)
                .disabled(idle == 0)
                .help("Restarts each idle one with conch's current tools, one at a time. Sessions at work are left alone.")
        }
        .padding(.horizontal, ConchSpace.x4)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
