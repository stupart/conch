import AppKit
import ConchDesign
import UserNotifications

/// The Mac's half of a notice (daemon notify-user.ts, 2026-11-10, Tyler: "we should also add a way for me to let sessions
/// send me messages on my phone via conch that ping and show notification"): the daemon names it on this Mac's sessions
/// file (`notices`), this posts it once as a macOS notification (`ReviewNotifications.post(notices:answer:)`) and tells
/// the daemon whether it showed, which is what `conch_notify` reports to the agent. The phone gets its own from Apple.
///
/// Only ever from this Mac's own sessions file: a remote Mac's store never handles them (RemoteMacStore).
@MainActor
final class NoticeDelivery {
    private let socket: ConchSocketClient

    init(socket: ConchSocketClient) {
        self.socket = socket
    }

    func handle(_ notices: [ConchNotice]) {
        guard !notices.isEmpty else { return }
        let socket = socket
        ReviewNotifications.shared.post(notices: notices) { id, outcome, error in
            Task { _ = await socket.request(NoticeAnswer(id: id, outcome: outcome, error: error), timeout: 3) }
        }
    }
}

/// The app's word on a notice: `shown`, `asking` (macOS is asking whether conch may), `off`, or `failed` with why.
private struct NoticeAnswer: Encodable {
    let kind = "notice-answer"
    let id: String
    let outcome: String
    let error: String?
}

/// Where a click on a notice goes (`NoticeRoute`), on the Mac: the session in conch's window, Settings › Providers for
/// an account to sign in again, or conch itself. "Open link" opens the notice's link through the app's one door
/// (`StateStore.openLink`, A13), which files a failure as `open-link`.
@MainActor
enum NoticeTaps {
    /// The app's store, for its door; set as the app starts (ConchMacApp).
    static weak var store: StateStore?

    /// The "Open link" button on a notice that carries one, as the phone's has.
    static func registerCategories(on center: UNUserNotificationCenter) {
        let open = UNNotificationAction(identifier: NoticeRoute.openLinkAction, title: "Open link", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: NoticeRoute.linkCategory, actions: [open], intentIdentifiers: [], options: []),
        ])
    }

    static func open(_ response: UNNotificationResponse) {
        let info = response.notification.request.content.userInfo
        let route = NoticeRoute.from(userInfo: info)
        if response.actionIdentifier == NoticeRoute.openLinkAction, let link = NoticeRoute.link(userInfo: info) {
            let session: String? = if case let .session(id) = route { id } else { nil }
            // No pane was clicked to say a failure in: the door files it.
            store?.openLink(link.absoluteString, cwd: nil, rowId: session, onFailure: { _ in })
            return
        }
        switch route {
        case let .session(id): ConchStatusItem.openSession(id)
        case .providers: SettingsRouter.shared.open(.providers)
        case .app: ConchStatusItem.bringConchForward()
        }
    }
}
