import Foundation

/// How a message you sent reads when it is matched against the session's own record of it: its words, without its
/// pictures.
///
/// What conch sends names a picture by its file (a dropped screenshot is `/var/folders/…/conch-drop-….png`, or a
/// `file://` URL). Claude Code writes the same picture into its transcript as `[Image #10]`, glued to the words after it,
/// and the daemon then shows the picture beside the message and drops that stand-in from its words. Matched as text, the
/// sent words and the delivered ones never met, so the bubble conch shows while a send lands stayed under the delivered
/// message as a second copy. 2026-10-09, Tyler: "this message sent twice and images aren't rendering properly as
/// images in the chat".
public enum SentMessageText {
    /// `text` without its pictures: Claude's `[Image #N]` stand-ins, and paths or `file://` URLs to image files, each as
    /// a word of its own.
    public static func withoutImages(_ text: String) -> String {
        let placeholders = text.replacingOccurrences(of: #"\[Image #\d+\]"#, with: " ", options: .regularExpression)
        return placeholders.replacingOccurrences(
            of: #"(?i)(?<!\S)(?:file://)?/\S+\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp)(?!\S)"#,
            with: " ",
            options: .regularExpression
        )
    }
}
