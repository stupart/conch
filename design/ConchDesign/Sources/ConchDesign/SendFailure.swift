/// Why a send didn't land, in words the person who sent it can act on.
///
/// The daemon always knew exactly why (`src/inject.ts`): a modal dialog swallowing every
/// AppleScript call, a revoked Automation or Accessibility permission, a window it could not reach. It kept
/// that to itself — it spoke the reason aloud on the Mac and told the phone only "failed".
/// On 2026-09-16 a dialog was open on Tyler's Mac and ate three sends from his phone; all he
/// saw was a generic failure, and his words sat on a clipboard he was nowhere near.
///
/// Both apps read this one table, so the phone and the Mac never describe the same failure
/// differently. A code conch does not recognise stays "Not delivered" — an invented cause
/// is worse than no cause, because it sends someone to fix the wrong thing. A reason the daemon
/// wrote as a sentence is shown as it wrote it: a question it could not answer says why in
/// words of its own ("the session is asking 3 questions at once, …"), and reading those as an
/// unknown code is how Tyler's refused answer showed as a bare "Not delivered." (2026-09-28).
public enum ConchSendFailure {
    /// The whole sentence to show: what went wrong, and where the words are if they survived.
    ///
    /// `reason` is the daemon's own code from the delivery receipt; `onClipboard` is the daemon
    /// saying it left the text on the Mac's clipboard, which is worth saying because it is the
    /// difference between lost words and a paste away.
    public static func sentence(reason: String?, onClipboard: Bool = false) -> String {
        let opening = (clause(for: reason) ?? written(reason)).map { "Not delivered — \($0)" } ?? "Not delivered."
        return onClipboard ? "\(opening) Your words are on the Mac's clipboard." : opening
    }

    /// Every reason the daemon can name. `nil` for one it cannot, which stays "Not delivered".
    public static func clause(for reason: String?) -> String? {
        switch reason {
        // The Mac is blocked by something only a person standing at it can clear.
        case "system-dialog-blocking":
            "a dialog is open on your Mac and it's blocking conch. Dismiss it and send again."
        case "automation-permission-denied":
            "macOS is blocking conch from controlling Terminal. Turn conch on under Privacy & Security → Automation."
        // The keystrokes themselves were refused: conch isn't allowed in Accessibility (`ConchPermissionTrouble.typing`).
        case "accessibility-permission-denied":
            "conch can't type into Terminal: allow conch in Accessibility."
        // conch never found, or never held, the window to type into.
        case "window-not-focusable", "clipboard-fallback":
            "couldn't reach that session's window."
        case "hosted-app-unavailable":
            "the Codex app isn't reachable on this Mac. Open it, then send again."
        case "hosted-session-not-open":
            "open this task in the Codex app, then send again."
        case "hosted-protocol-incompatible":
            "this Codex app version doesn't support conch's message connection."
        case "hosted-delivery-unconfirmed":
            "the Codex app didn't confirm delivery. Check the task before retrying to avoid sending twice."
        case "hosted-message-too-large":
            "this message is too large for the Codex app connection. Shorten it and send again."
        case "session-not-routable":
            "conch can't tell which window that session is in."
        case "front-window-changed":
            "another window came to the front on your Mac, so conch stopped typing."
        case "keystroke-fallback-off":
            "conch is set not to type into windows, and that session isn't in a tmux pane."
        // The typing itself went wrong.
        case "clipboard-changed":
            "something else copied on your Mac mid-send, so conch stopped."
        case "clipboard-unavailable":
            "conch couldn't use the Mac's clipboard."
        // conch refused to touch a clipboard it could not put back — the refusal is the feature.
        case "clipboard-unpreservable":
            "something on your Mac's clipboard can't be put back, so conch left it alone. Copy something else and send again."
        case "automation-failed", "delivery-failed", "transport-error":
            "the Mac wouldn't let conch type into that session."
        case "submit-failed", "submit-error":
            "the words went in but the Return didn't."
        // It may have gone in. Neither of these claims more than conch can see.
        case "delivery-unconfirmed":
            "conch typed it but the session never took it."
        case "delivery-unattributed":
            "another window shares this session, so conch can't tell whether it landed."
        case "delivery-interrupted":
            "the send was stopped before it went in."
        // Keys typed into an open dialog would answer it, so conch typed nothing. A question conch
        // can see takes the words as its answer instead, so this is a dialog it cannot see.
        case "session-awaiting-answer":
            "that session has a prompt open in its terminal, and typing would answer it. Answer it there, then send again."
        case "session-awaiting-permission":
            "that session is waiting on a permission prompt. Allow or deny it first, then send again."
        // The terminal the row names no longer holds the session, so conch typed nothing there.
        case "session-stopped":
            "that session isn't running in its terminal any more: it was stopped. Resume it, and conch will pick it up."
        case "session-ended":
            "that session isn't running in its terminal any more: its process has ended. Resume it, and conch will pick it up."
        default:
            nil
        }
    }

    /// A reason the daemon wrote as a sentence (it has spaces; a code never does), ending on a
    /// full stop. Nil for a code, which only the table above may name.
    static func written(_ reason: String?) -> String? {
        guard let reason = reason?.trimmingCharacters(in: .whitespacesAndNewlines),
              reason.contains(" ") else { return nil }
        return reason.hasSuffix(".") ? reason : reason + "."
    }
}
