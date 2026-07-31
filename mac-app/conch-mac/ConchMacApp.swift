import SwiftUI
import AppKit
import UserNotifications

@main
struct ConchMacApp: App {
    @NSApplicationDelegateAdaptor(ConchAppDelegate.self) private var appDelegate
    @StateObject private var store = StateStore()

    var body: some Scene {
        WindowGroup("conch") {
            ContentView()
                .environmentObject(store)
                .frame(minWidth: 640, minHeight: 400)
                .preferredColorScheme(.dark)
                .background(WindowBackgroundConfigurator())
        }
        .defaultSize(width: 1_040, height: 720)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}

private final class ConchAppDelegate: NSObject,
    NSApplicationDelegate,
    UNUserNotificationCenterDelegate
{
    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        ReviewNotifications.shared.requestAuthorizationAtLaunch()
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler:
            @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list])
    }
}

final class ReviewNotifications {
    static let shared = ReviewNotifications()

    private enum DeliveryState {
        case resolvingAuthorization
        case authorized
        case denied
    }

    private let center = UNUserNotificationCenter.current()
    private var deliveryState = DeliveryState.resolvingAuthorization
    private var didStartAuthorization = false
    private var seenReviewIDs: Set<ReviewItem.ID> = []
    private var queuedRequests: [UNNotificationRequest] = []

    private init() {}

    func requestAuthorizationAtLaunch() {
        precondition(Thread.isMainThread)
        guard !didStartAuthorization else { return }
        didStartAuthorization = true

        center.getNotificationSettings { [weak self] settings in
            DispatchQueue.main.async {
                self?.handleAuthorizationStatus(settings.authorizationStatus)
            }
        }
    }

    func postOnce(for item: ReviewItem) {
        precondition(Thread.isMainThread)
        guard seenReviewIDs.insert(item.id).inserted else { return }

        let content = UNMutableNotificationContent()
        content.title = "Review ready"
        content.subtitle = item.label
        content.body = item.summary.isEmpty
            ? "A deliverable is ready for review."
            : item.summary

        let request = UNNotificationRequest(
            identifier: "conch.review.\(item.id)",
            content: content,
            trigger: nil
        )

        switch deliveryState {
        case .resolvingAuthorization:
            queuedRequests.append(request)
        case .authorized:
            center.add(request)
        case .denied:
            break
        }
    }

    private func handleAuthorizationStatus(_ status: UNAuthorizationStatus) {
        switch status {
        case .authorized, .provisional:
            completeAuthorization(isAuthorized: true)
        case .notDetermined:
            center.requestAuthorization(options: [.alert]) { [weak self] granted, _ in
                DispatchQueue.main.async {
                    self?.completeAuthorization(isAuthorized: granted)
                }
            }
        case .denied:
            completeAuthorization(isAuthorized: false)
        @unknown default:
            completeAuthorization(isAuthorized: false)
        }
    }

    private func completeAuthorization(isAuthorized: Bool) {
        precondition(Thread.isMainThread)
        deliveryState = isAuthorized ? .authorized : .denied

        guard isAuthorized else {
            queuedRequests.removeAll()
            return
        }

        let requests = queuedRequests
        queuedRequests.removeAll()
        for request in requests {
            center.add(request)
        }
    }
}

/// Paints the host NSWindow's background dark so it never flashes white for a
/// frame before SwiftUI's dark content draws on cold launch.
private struct WindowBackgroundConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { [weak view] in
            guard let window = view?.window else { return }
            window.backgroundColor = NSColor(ConchPalette.bg)
            window.isOpaque = true
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}
