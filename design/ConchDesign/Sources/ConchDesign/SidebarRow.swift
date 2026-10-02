import SwiftUI

// The Mac sidebar's session rows, as a name first (2026-09-28).
//
// Tyler, beside ChatGPT's recents: "we should show as much of the beginning of the name as we can. There's probably a
// lot more space than we need and random details on the right side that could be shown better." The row was one line of
// mark, name, agent mark, a summary and an age, and the name had the least room of any of them: "Co…egy" for "Conch UI
// strategy", beside a summary cut to "Screen…". Now the name has the line, and ends in a fade rather than an ellipsis;
// the summary moves to the tooltip, and only what asks something of you earns a second line under it.

/// One line of text that shows as much of its beginning as fits and, when it doesn't all fit, fades out over its last
/// few points instead of ending in an ellipsis.
///
/// The start of a name is the part that says which one it is, and a fade reads as "there is more" without spending
/// three characters' width on dots. Text that fits is drawn plainly, so a short name never loses its last letters to a
/// fade over nothing. Takes the font and colour of its environment, like `Text`.
public struct TailFadeText: View {
    let text: String
    let fade: CGFloat

    /// `fade`: how wide the trailing fade is, in points.
    public init(_ text: String, fade: CGFloat = 28) {
        self.text = text
        self.fade = fade
    }

    public var body: some View {
        ViewThatFits(in: .horizontal) {
            line
            line
                .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                .clipped()
                .mask {
                    HStack(spacing: 0) {
                        Rectangle()
                        LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: fade)
                    }
                }
        }
    }

    private var line: some View {
        Text(text)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
    }
}

/// What a sidebar row says in words, beyond the marks it draws: its second line, its tooltip, and what VoiceOver reads.
public enum SidebarRowText {
    /// A row's second line and what earned it, which decides how it is drawn (`SidebarSecondLine`).
    public struct SecondLine: Equatable, Sendable {
        public enum Kind: Equatable, Sendable {
            /// conch's own word about the row: a rename that failed. Drawn in the needs colour.
            case message
            /// The question a blocked session is waiting on.
            case question
            /// What a working agent is doing right now (`SidebarActivity`). Drawn faintest: it is news, not a request.
            case activity
            /// Which session started this one.
            case startedBy
        }

        public let text: String
        public let kind: Kind

        public init(text: String, kind: Kind) {
            self.text = text
            self.kind = kind
        }
    }

    /// The one line under the name, when the row has earned one; nil for a row that is its name alone.
    ///
    /// Earned by what asks something of you or explains itself: conch's own word about this row (a rename that failed),
    /// the question a blocked session is waiting on, or which session started this one. A finished session's summary
    /// does not: its check or dot already says "come and look", the conversation says what it made, and cut to sidebar
    /// width it was a word and an ellipsis ("Screen…") that pushed the name down to "Co…egy". The tooltip carries it.
    public static func subtitle(message: String?, blockedOn: String?, startedBy: String?) -> String? {
        secondLine(message: message, blockedOn: blockedOn, activity: nil, startedBy: startedBy)?.text
    }

    /// `subtitle`'s rule with a working row's activity in it (2026-10-03): conch's word, then the question, then what the
    /// agent is doing, then its starter. Pass `activity` through `SidebarActivity.line`, which says when a row has one.
    ///
    /// Below the question, so a blocked row says what it is blocked on; above the starter, because a started session
    /// already sits indented under its starter, and the tooltip and VoiceOver still name it.
    public static func secondLine(message: String?, blockedOn: String?, activity: String?, startedBy: String?) -> SecondLine? {
        if let message = present(message) { return SecondLine(text: message, kind: .message) }
        if let blockedOn = present(blockedOn) { return SecondLine(text: blockedOn, kind: .question) }
        if let activity = SidebarActivity.clean(activity) { return SecondLine(text: activity, kind: .activity) }
        return present(startedBy).map { SecondLine(text: "started by \($0)", kind: .startedBy) }
    }

    /// The whole name, then what the row knows beyond it, one per line.
    public static func tooltip(name: String, snippet: String?, startedBy: String?) -> String {
        var lines = [name]
        if let snippet = present(snippet), snippet != name { lines.append(snippet) }
        if let startedBy = present(startedBy) { lines.append("Started by \(startedBy)") }
        return lines.joined(separator: "\n")
    }

    /// The whole name, never the faded one, then the state its mark shows and, for a working agent, what it is doing;
    /// then the agent it runs, its voice and its starter, when it has them.
    public static func accessibilityLabel(
        name: String,
        state: String,
        agent: String,
        voice: SessionVoice.Mark?,
        startedBy: String?,
        activity: String? = nil
    ) -> String {
        var parts = [name, state]
        if let activity = SidebarActivity.clean(activity) { parts.append(activity) }
        parts.append(agent)
        if let voice { parts.append(voice.meaning) }
        if let startedBy = present(startedBy) { parts.append("started by \(startedBy)") }
        return parts.joined(separator: ", ")
    }

    private static func present(_ text: String?) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }
}

/// What a working agent is doing right now, as its row's second line (2026-10-03).
///
/// Tyler: "Could also be cool to see an agent work live in the side bar." The daemon publishes `rows[].activity` for a
/// row working on its own turn, a live sub-agent's included (src/live-activity.ts): its running step said as what is
/// happening ("Running the test suite", "Editing src/voice-loop.ts", "Reading 3 files"), else its words from the last
/// minute. This decides when a row draws it and keeps it to one line, on the Mac and the phone alike.
public enum SidebarActivity {
    /// The daemon's own cap, held here too: a line from anywhere else is never longer than a sidebar's.
    public static let maxCharacters = 90

    /// The line a row draws, or nil. Only while it is working on its own turn: an idle, waiting or blocked row stays its
    /// name alone, as does one whose turn is over while only its agents run (their own rows say what they are doing),
    /// and one stopped by a usage limit, whose dimmed name already says why nothing moves.
    public static func line(_ activity: String?, working: Bool, waitingOnAgents: Bool = false, usageLimited: Bool = false) -> String? {
        guard working, !waitingOnAgents, !usageLimited else { return nil }
        return clean(activity)
    }

    /// One line: whitespace and newlines collapsed, nothing at all when that leaves nothing, and at most
    /// `maxCharacters`, cut on a word near the end with an ellipsis.
    public static func clean(_ text: String?) -> String? {
        guard let text else { return nil }
        let flat = text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        guard !flat.isEmpty else { return nil }
        guard flat.count > maxCharacters else { return flat }
        let cut = String(flat.prefix(maxCharacters - 1))
        var kept = cut
        if let space = cut.lastIndex(of: " "), cut.distance(from: cut.startIndex, to: space) > cut.count * 3 / 5 {
            kept = String(cut[..<space])
        }
        while let last = kept.last, last.isWhitespace || ",;:.-–—".contains(last) { kept.removeLast() }
        return kept + "…"
    }
}

/// A sidebar row's second line, drawn for what earned it: conch's word in the needs colour, a question or a starter in
/// the secondary ink, a working agent's activity in the faintest. One line, faded at its end like the name.
///
/// The activity changes as the agent works, at most once a second, so a new line crossfades over the old in place:
/// nothing slides, nothing takes focus, and under Reduce Motion it is simply replaced. It is plain text, never a
/// control: VoiceOver hears it as part of its row (the Mac's row names it in its own label,
/// `SidebarRowText.accessibilityLabel(activity:)`), and a change is never announced over what is being read.
public struct SidebarSecondLine: View {
    let line: SidebarRowText.SecondLine
    let font: Font

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// `font`: the Mac's fixed sidebar size, or a text style on the phone, which scales with the reader's text size.
    public init(_ line: SidebarRowText.SecondLine, font: Font = .system(size: 11)) {
        self.line = line
        self.font = font
    }

    public var body: some View {
        ZStack(alignment: .leading) {
            TailFadeText(line.text, fade: 24)
                .id(line.text)
                .transition(.opacity)
        }
        .font(font)
        .foregroundStyle(style)
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipped()
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: line.text)
    }

    private var style: AnyShapeStyle {
        switch line.kind {
        case .message: return AnyShapeStyle(ConchColor.attention.opacity(0.9))
        case .question, .startedBy: return AnyShapeStyle(ConchColor.textSecondary)
        case .activity: return AnyShapeStyle(ConchColor.textTertiary)
        }
    }
}
