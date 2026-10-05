import CoreGraphics
import Foundation

/// Approving a published result (2026-10-05, Tyler's decision): it is done. The daemon takes it out of the review queue
/// on every surface (`ReadyForYou`), counts one piece of sea glass (`seaGlass`, the lagoon's jar), and sends the agent
/// nothing. Approving one already approved changes nothing; ⌘Z within 10 s takes it back, and after that it stands.
///
/// The Mac's review pane offers it as a small "✓ Approve" in the session bar, after the Conversation / Side by side track;
/// ↵ approves while the review pane has the keyboard; the lagoon's Approve reaches the same store action
/// (`LagoonActionSink.approveReview`). What each of those shows and decides is here, where it is tested.
public enum ReviewApproval {
    /// How long an approval can be taken back: the daemon's `UNAPPROVE_WINDOW_MS`, which refuses it after this.
    public static let undoWindow: TimeInterval = 10

    /// How long the control says "✓ Approved" after an approval made here, before it goes: the quiet confirmation, in
    /// place of a modal or a toast over the work.
    public static let confirmation: TimeInterval = 2.4

    /// The daemon's answer to approving or taking one back.
    public enum Reply: Equatable, Sendable {
        /// Done; `changed` is false when there was nothing to do (approved already, or nothing to take back).
        case done(changed: Bool)
        /// Refused, in the daemon's words: no such result, or past the undo window.
        case refused(String)
    }

    /// What the session bar's control is.
    public enum Control: Equatable, Sendable {
        /// Nothing: no result showing, a daemon too old to approve, or one approved before you got here.
        case hidden
        /// "✓ Approve": a result nobody has approved.
        case approve
        /// "✓ Approved": the one just approved here, for a moment.
        case approved
    }

    /// The control for the result the pane shows. Offered only for one that isn't approved, from a daemon that can
    /// approve (`seaGlass` published); one approved here says so for a moment (`confirming`), then goes.
    public static func control(showing: Bool, daemonCanApprove: Bool, approvedAt: Double?, confirming: Bool) -> Control {
        guard showing, daemonCanApprove else { return .hidden }
        if confirming { return .approved }
        return approvedAt == nil ? .approve : .hidden
    }

    /// Below this header width the control is the check alone, so the title keeps its room.
    public static let compactBelow: CGFloat = 640

    public static func isCompact(headerWidth: CGFloat) -> Bool {
        headerWidth > 0 && headerWidth < compactBelow
    }

    /// The words on it, or nil for none.
    public static func label(_ control: Control, compact: Bool) -> String? {
        switch control {
        case .hidden: nil
        case .approve: compact ? "✓" : "✓ Approve"
        case .approved: compact ? "✓" : "✓ Approved"
        }
    }

    /// The tooltip, with its key.
    public static func help(_ control: Control) -> String {
        switch control {
        case .hidden, .approve: "Approve: mark this result done (↵)"
        case .approved: "Approved. Undo with ⌘Z within 10 seconds"
        }
    }

    /// What VoiceOver says for it.
    public static func accessibilityLabel(_ control: Control) -> String {
        switch control {
        case .hidden, .approve: "Approve this result"
        case .approved: "Approved"
        }
    }

    /// Said to VoiceOver when an approval lands.
    public static let announcement = "Approved. Press Command-Z within 10 seconds to undo."

    // MARK: ⌘Z

    /// The one approval made here that ⌘Z can still take back.
    public struct Undo: Equatable, Sendable {
        public var sessionId: String
        public var reviewId: String
        public var at: Date

        public init(sessionId: String, reviewId: String, at: Date) {
            self.sessionId = sessionId
            self.reviewId = reviewId
            self.at = at
        }

        /// Within the window (and not from a clock that ran backwards past it).
        public func isOpen(now: Date) -> Bool {
            let elapsed = now.timeIntervalSince(at)
            return elapsed >= -1 && elapsed <= ReviewApproval.undoWindow
        }

        /// When ⌘Z stops offering it.
        public var closes: Date { at.addingTimeInterval(ReviewApproval.undoWindow) }
    }

    // MARK: ↵

    /// Where the keyboard is when Return is pressed.
    public enum KeyFocus: Equatable, Sendable {
        /// The composer or any other text field: Return is theirs, always.
        case text
        /// A web page (a page deliverable, the lagoon): Return is the page's (a link, a form).
        case web
        /// Anything else in the window.
        case other
    }

    /// What Return does in the main window.
    public enum ReturnKey: Equatable, Sendable {
        /// On the lagoon: the selected session's conversation.
        case openConversation
        /// Approve the result the review pane shows.
        case approve
        /// Not the window's: the key goes on to whatever has it.
        case pass
    }

    /// Return approves only while the review pane has the keyboard (the last click in the window was in it) and the
    /// result it shows can be approved. Never from the composer or another text field, never inside a web page.
    public static func returnKey(focus: KeyFocus, onLagoon: Bool, reviewPaneFocused: Bool, canApprove: Bool) -> ReturnKey {
        switch focus {
        case .text, .web: return .pass
        case .other: break
        }
        if onLagoon { return .openConversation }
        return reviewPaneFocused && canApprove ? .approve : .pass
    }
}
