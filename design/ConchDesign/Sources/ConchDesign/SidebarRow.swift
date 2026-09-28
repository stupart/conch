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
    /// The one line under the name, when the row has earned one; nil for a row that is its name alone.
    ///
    /// Earned by what asks something of you or explains itself: conch's own word about this row (a rename that failed),
    /// the question a blocked session is waiting on, or which session started this one. A finished session's summary
    /// does not: its check or dot already says "come and look", the conversation says what it made, and cut to sidebar
    /// width it was a word and an ellipsis ("Screen…") that pushed the name down to "Co…egy". The tooltip carries it.
    public static func subtitle(message: String?, blockedOn: String?, startedBy: String?) -> String? {
        if let message = present(message) { return message }
        if let blockedOn = present(blockedOn) { return blockedOn }
        return present(startedBy).map { "started by \($0)" }
    }

    /// The whole name, then what the row knows beyond it, one per line.
    public static func tooltip(name: String, snippet: String?, startedBy: String?) -> String {
        var lines = [name]
        if let snippet = present(snippet), snippet != name { lines.append(snippet) }
        if let startedBy = present(startedBy) { lines.append("Started by \(startedBy)") }
        return lines.joined(separator: "\n")
    }

    /// The whole name, never the faded one, then the state its mark shows and the agent it runs; then its voice and its
    /// starter, when it has them.
    public static func accessibilityLabel(
        name: String,
        state: String,
        agent: String,
        voice: SessionVoice.Mark?,
        startedBy: String?
    ) -> String {
        var parts = [name, state, agent]
        if let voice { parts.append(voice.meaning) }
        if let startedBy = present(startedBy) { parts.append("started by \(startedBy)") }
        return parts.joined(separator: ", ")
    }

    private static func present(_ text: String?) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }
}
