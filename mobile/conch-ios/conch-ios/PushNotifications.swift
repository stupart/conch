import ConchDesign
import SwiftUI
import UIKit
import UserNotifications

// The phone's half of a notice (daemon notify-user.ts, 2026-11-10, Tyler: "we should also add a way for me to let
// sessions send me messages on my phone via conch that ping and show notification").
//
// A notice reaches a phone with conch in the background or closed only through Apple, so this asks iOS for permission
// (from the ledger's card once the Mac can push, or Settings; never at launch), registers with Apple, and gives the
// paired Mac this phone's device token over the same authenticated bridge or relay as everything else (`/push-token`).
// A tap opens the session the notice is about. With the app in front, a notice shows in the app's own banner instead of
// a second, system one over it.

/// Push, for the whole app: one, made at launch by the app delegate, before any notice can be tapped.
@MainActor
final class PushNotifications: NSObject, ObservableObject {
    static let shared = PushNotifications()

    /// A notice that arrived with the app in front.
    struct Banner: Identifiable, Equatable {
        let id: String
        let title: String
        let body: String
        let route: NoticeRoute
        let link: URL?
    }

    @Published private(set) var authorization: PushAuthorization = .notAsked
    /// Whether the paired Mac can push (`/push`): it has an APNs key. The offer waits for it.
    @Published private(set) var macReady = false
    /// Whether the Mac has this phone's token.
    @Published private(set) var registered = false
    /// Why Apple gave this phone no token, when it didn't (a build without the push entitlement, a Simulator).
    @Published private(set) var registrationError: String?
    /// The ledger's "Get pinged" card, put away.
    @Published private(set) var offerDismissed = UserDefaults.standard.bool(forKey: PushNotifications.offerDismissedKey)
    /// A tapped notice's way in, taken by the ledger (`LedgerView`): its session, or Settings.
    @Published var pendingRoute: NoticeRoute?
    /// A notice that arrived with the app in front, shown in the app (`NoticeBannerView`).
    @Published var banner: Banner?

    private static let offerDismissedKey = "conch.push.offer-dismissed.v1"
    private var token: String?
    private var install: String?
    private weak var bridge: BridgeClient?

    var showsOffer: Bool { PushOffer.shows(macReady: macReady, authorization: authorization, dismissed: offerDismissed) }

    /// At launch: the delegate, the link's button, and what iOS already has. Asks nothing.
    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let open = UNNotificationAction(identifier: NoticeRoute.openLinkAction, title: "Open link", options: [.foreground])
        center.setNotificationCategories([UNNotificationCategory(identifier: NoticeRoute.linkCategory, actions: [open], intentIdentifiers: [])])
        Task { await refresh() }
    }

    /// What iOS says now: at launch and on every return to the app, since iOS Settings may have changed it. Once allowed,
    /// registered with Apple each time, as Apple asks (the token can change); turned off there, the Mac is told so.
    func refresh() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let now: PushAuthorization = switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: .allowed
        case .denied: .denied
        default: .notAsked
        }
        let changed = now != authorization
        authorization = now
        if now == .allowed {
            UIApplication.shared.registerForRemoteNotifications()
        } else if changed, token != nil {
            await send()
        }
        // Back in the app: the Mac may have set push up meanwhile, which is when the offer appears.
        await askMac()
    }

    /// The ask: from the ledger's card or Settings › Notifications.
    func turnOn() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        await refresh()
    }

    func dismissOffer() {
        offerDismissed = true
        UserDefaults.standard.set(true, forKey: Self.offerDismissedKey)
    }

    /// Connected to the paired Mac: whether it can push, and this phone's token when there is one.
    func connected(_ bridge: BridgeClient, install: String) async {
        self.bridge = bridge
        self.install = install
        await askMac()
        await send()
    }

    /// Whether the paired Mac can push, and has this phone. Nothing before a link.
    private func askMac() async {
        guard let bridge, let install else { return }
        if let state = await bridge.pushState(install: install) {
            macReady = state.ready
            registered = state.registered
        } else {
            // A Mac from before push, or no answer: nothing to offer.
            macReady = false
        }
    }

    /// Apple's token for this install (the app delegate).
    func didRegister(deviceToken: Data) {
        token = deviceToken.map { String(format: "%02x", $0) }.joined()
        registrationError = nil
        Task { await send() }
    }

    func didFailToRegister(_ error: Error) {
        registrationError = error.localizedDescription
    }

    /// The token, where its notices come from and whether iOS shows them, to the Mac. Nothing without a link or a token.
    private func send() async {
        guard let bridge, let install, let token else { return }
        let environment = PushEnvironment.from(provisioningProfile: Self.provisioningProfile, debugBuild: Self.debugBuild)
        let taken = await bridge.registerPush(
            token: token,
            environment: environment,
            topic: Bundle.main.bundleIdentifier ?? "",
            alerts: authorization == .allowed,
            device: UIDevice.current.name,
            install: install
        )
        if taken { registered = true }
    }

    /// The profile Xcode signed this build with; absent from an App Store or TestFlight build.
    private static var provisioningProfile: Data? {
        Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision").flatMap { try? Data(contentsOf: $0) }
    }

    private static var debugBuild: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    /// A banner tapped, or a notice tapped in Notification Center: its way in.
    func open(_ route: NoticeRoute) {
        banner = nil
        pendingRoute = route
    }

    /// A notice's link, through the phone's one door (`BridgeClient.openLink`, which tells the Mac of a failure), or with
    /// no link to the Mac yet (a tap that launched the app), the unpaired one.
    func openLink(_ url: URL, route: NoticeRoute) {
        banner = nil
        let session: String? = if case let .session(id) = route { id } else { nil }
        if let bridge {
            bridge.openLink(url, sessionId: session) { _ in }
        } else {
            BridgeClient.openUnpaired(url) { _ in }
        }
    }
}

extension PushNotifications: UNUserNotificationCenterDelegate {
    /// With the app in front: the app's own banner, and the notice kept in Notification Center, never a second banner.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let content = notification.request.content
        guard content.userInfo["conch"] != nil else { return [.banner, .list, .sound] }
        let banner = Banner(
            id: notification.request.identifier,
            title: content.title,
            body: content.body,
            route: NoticeRoute.from(userInfo: content.userInfo),
            link: NoticeRoute.link(userInfo: content.userInfo)
        )
        await MainActor.run { self.banner = banner }
        return [.list]
    }

    /// A tap: the session it's about, Settings for an account to sign in again, or its link from "Open link".
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        let link = response.actionIdentifier == NoticeRoute.openLinkAction ? NoticeRoute.link(userInfo: info) : nil
        let route = NoticeRoute.from(userInfo: info)
        await MainActor.run {
            if let link {
                self.openLink(link, route: route)
            } else {
                self.open(route)
            }
        }
    }
}

/// The app delegate, for what only one gets: Apple's token, or why there is none. Made before any notice can be tapped,
/// so a tap that launches the app is still routed.
final class ConchPhoneAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        PushNotifications.shared.start()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushNotifications.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushNotifications.shared.didFailToRegister(error)
    }
}

/// The ledger's offer, once the Mac can push and iOS hasn't been asked: what a notice is for, Turn on, or put it away.
struct PushOfferRow: View {
    let onTurnOn: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "bell.badge")
                    .font(.system(size: 12))
                    .accessibilityHidden(true)
                Text("Get pinged when a session needs you")
                    .font(Type.caption.weight(.medium))
                    .foregroundStyle(Palette.textPrimary)
                Spacer(minLength: 8)
                Button(action: onDismiss) {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))
                }
                .foregroundStyle(Palette.textFaint)
                .buttonStyle(.borderless)
                .accessibilityLabel("Not now")
            }
            Text("Your Mac can now send this phone a notification when you ask a session to tell you something, even with conch closed. Tapping it opens the session.")
                .font(Type.caption)
                .foregroundStyle(Palette.textDim)
                .fixedSize(horizontal: false, vertical: true)
            Button("Turn on notifications", action: onTurnOn)
                .font(Type.caption.weight(.medium))
                .foregroundStyle(Palette.micOpen)
                .buttonStyle(.borderless)
        }
        .foregroundStyle(Palette.textDim)
        .transition(.opacity)
    }
}

/// A notice that came while the app was in front, at the top of the screen for a few seconds: tap to open it.
struct NoticeBannerView: View {
    let banner: PushNotifications.Banner
    let onOpen: () -> Void
    let onOpenLink: (URL) -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "bell.fill")
                .font(.system(size: 13))
                .foregroundStyle(Palette.micOpen)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(banner.title)
                    .font(Type.summary.weight(.semibold))
                    .foregroundStyle(Palette.textPrimary)
                    .lineLimit(1)
                Text(banner.body)
                    .font(Type.caption)
                    .foregroundStyle(Palette.textDim)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                if let link = banner.link {
                    Button("Open link") { onOpenLink(link) }
                        .font(Type.caption.weight(.medium))
                        .foregroundStyle(Palette.micOpen)
                        .buttonStyle(.borderless)
                }
            }
            Spacer(minLength: 0)
            Button(action: onDismiss) {
                Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))
            }
            .foregroundStyle(Palette.textFaint)
            .buttonStyle(.borderless)
            .accessibilityLabel("Dismiss")
        }
        .padding(12)
        .background(Palette.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.divider, lineWidth: 1))
        .padding(.horizontal, 12)
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Opens it")
        // Gone by itself, as a system banner goes; still in Notification Center.
        .task(id: banner.id) {
            try? await Task.sleep(for: .seconds(6))
            onDismiss()
        }
        .transition(.move(edge: .top).combined(with: .opacity))
    }
}

/// Settings › Notifications: where push stands on this phone, and the ask when it hasn't been made.
struct PushSettingsRow: View {
    @ObservedObject var push: PushNotifications
    /// For the phone's one door to iOS Settings (`BridgeClient.openLink`).
    let bridge: BridgeClient
    @State private var openFailure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle()
                    .fill(dot)
                    .frame(width: 7, height: 7)
                Text(line)
                    .font(Type.summary)
                    .foregroundStyle(Palette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            if let detail {
                Text(detail)
                    .font(Type.caption)
                    .foregroundStyle(Palette.textFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }
            switch push.authorization {
            case .notAsked:
                Button("Turn on notifications") { Task { await push.turnOn() } }
                    .font(Type.caption.weight(.medium))
                    .foregroundStyle(Palette.micOpen)
                    .buttonStyle(.borderless)
            case .denied:
                Button("Open iPhone Settings") {
                    guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
                    openFailure = nil
                    bridge.openLink(url, sessionId: nil) { openFailure = $0 }
                }
                .font(Type.caption.weight(.medium))
                .foregroundStyle(Palette.micOpen)
                .buttonStyle(.borderless)
                if let openFailure {
                    Text(openFailure)
                        .font(Type.caption)
                        .foregroundStyle(Palette.needs)
                }
            case .allowed:
                EmptyView()
            }
        }
    }

    private var line: String {
        switch push.authorization {
        case .notAsked: return "Off"
        case .denied: return "Off in iPhone Settings"
        case .allowed:
            if push.registrationError != nil { return "On, but Apple gave this phone no token" }
            if !push.macReady { return "On · your Mac hasn't set up push" }
            return push.registered ? "On · your Mac can reach this phone" : "On · telling your Mac…"
        }
    }

    private var detail: String? {
        switch push.authorization {
        case .notAsked: return "Sessions you ask to tell you something, and conch's own alerts, ping this phone, even with conch closed."
        case .denied: return "conch's notifications are turned off for this phone. Turn them on in iPhone Settings › Notifications › conch."
        case .allowed:
            if let error = push.registrationError { return error }
            if !push.macReady { return "On your Mac: conch › Settings › Phone app › Notifications › Set up." }
            return nil
        }
    }

    private var dot: Color {
        switch push.authorization {
        case .allowed: return push.registrationError == nil && push.macReady && push.registered ? Palette.calm : Palette.caution
        case .denied: return Palette.needs
        case .notAsked: return Palette.textFaint
        }
    }
}
