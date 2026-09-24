import AppKit
import ApplicationServices
import ConchDesign

/// The front-window observer (docs/screen-context.md): the app in front and, where it can be read
/// without asking Tyler for anything, what it shows. It is how `showing` follows him when he moves
/// on from what conch staged, to another app, or to a document or page he opened himself.
///
/// It reads when an app comes to the front, and every few seconds while Accessibility is granted,
/// since a new tab or document changes what is shown without any app activating. Every reading
/// goes to `StateStore.reportFrontWindow`, whose gate drops repeats: while nothing changes,
/// nothing is sent.
///
/// Accessibility is only checked, with `AXIsProcessTrusted()`, which never prompts; onboarding is
/// what will ask for it. Without it a reading is the app alone: its bundle id, and the kind that
/// implies. With it, the front window's document (Preview, QuickTime, an editor: `AXDocument`) or a
/// browser's page (Safari: `AXURL` on the page; Chrome: its address field). There is no
/// AppleScript here, so no Automation prompt either, and Terminal's tab, which only Terminal's
/// AppleScript names, stays unknown.
///
/// A window title is never read. conch's own windows are left to `reportShowing`, which knows the
/// session they show.
@MainActor
final class FrontWindowObserver {
    private let report: (ConchScreenSurface, ConchScreenApp) -> Void
    private var activation: NSObjectProtocol?
    private var poll: Timer?
    private var reading: Task<Void, Never>?

    init(report: @escaping (ConchScreenSurface, ConchScreenApp) -> Void) {
        self.report = report
        activation = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // Half a second for the app to settle on its window; a burst of switches is one reading.
            MainActor.assumeIsolated { self?.read(after: .milliseconds(500)) }
        }
        // For the tab or document that changes without an activation. Without the grant the app is
        // all there is to say, and activations already say it.
        let poll = Timer(timeInterval: 3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                if AXIsProcessTrusted() { self?.read(after: .zero) }
            }
        }
        poll.tolerance = 1
        RunLoop.main.add(poll, forMode: .common)
        self.poll = poll
        read(after: .zero)
    }

    /// Read the app in front now, as an activation does: conch's panel stopped covering it (`StateStore.screenCovered`).
    func readNow() {
        read(after: .zero)
    }

    /// Read the app in front once `delay` has passed. A newer request replaces one still waiting.
    private func read(after delay: Duration) {
        reading?.cancel()
        reading = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled,
                  let front = NSWorkspace.shared.frontmostApplication,
                  front.processIdentifier != ProcessInfo.processInfo.processIdentifier,
                  let bundleId = front.bundleIdentifier else { return }
            let pid = front.processIdentifier
            let trusted = AXIsProcessTrusted()
            // Accessibility asks the other app and waits for its answer: off the main thread.
            let surface = await Task.detached {
                FrontWindowReader.surface(pid: pid, bundleId: bundleId, trusted: trusted)
            }.value
            // An answer that comes back after Tyler moved on says nothing.
            guard !Task.isCancelled, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
            self?.report(surface, ConchScreenApp(bundleId: bundleId, pid: pid, name: front.localizedName))
        }
    }
}

/// The Accessibility reads: each one a synchronous call into another app, so they run off the main
/// thread and on a short leash.
enum FrontWindowReader {
    /// The most elements a browser window is searched through for its page's address.
    ///
    /// ponytail: the window is searched again on each reading, every 3 s while a browser is in
    /// front. Keep the address field found per window if a browser ever feels it.
    private static let budget = 300

    /// Controls: nothing the address could be under.
    private static let leaves: Set<String> = [
        kAXButtonRole, kAXRadioButtonRole, kAXCheckBoxRole, kAXPopUpButtonRole, kAXMenuButtonRole,
        kAXStaticTextRole, kAXImageRole, kAXTextFieldRole, kAXMenuBarRole,
    ]

    static func surface(pid: pid_t, bundleId: String, trusted: Bool) -> ConchScreenSurface {
        let kind = ScreenAppKind(bundleId: bundleId)
        switch kind {
        case .terminal: return .terminal
        case .simulator: return .simulator
        case .design: return .design
        case .pageAddressBrowser, .addressFieldBrowser, .app: break
        }
        let app = ConchScreenSurface.app(bundleId: bundleId)
        guard trusted else { return app }
        // An app that hangs answers nothing within a quarter second, rather than holding this
        // reading for Accessibility's default six.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)
        guard let window = element(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute) else { return app }
        // Preview, QuickTime, TextEdit, Xcode: the document the window is for.
        if let document = string(window, kAXDocumentAttribute).flatMap(URL.init(string:)),
           let surface = surface(of: document) {
            return surface
        }
        let page: URL?
        switch kind {
        case .pageAddressBrowser:
            page = first(under: window) { element, role in
                role == "AXWebArea" ? url(element, kAXURLAttribute) : nil
            }
        case .addressFieldBrowser:
            page = first(under: window) { element, role in
                role == kAXTextFieldRole ? string(element, kAXValueAttribute).flatMap(ScreenAppKind.addressFieldURL) : nil
            }
        default:
            page = nil
        }
        return page.flatMap(surface(of:)) ?? app
    }

    /// A file by its path, a web page by its address. Any other scheme is nothing to report.
    private static func surface(of url: URL) -> ConchScreenSurface? {
        if url.isFileURL { return .file(path: url.path) }
        return url.scheme == "http" || url.scheme == "https" ? .url(url.absoluteString) : nil
    }

    /// Breadth first under `root`, through at most `budget` elements, for the first that `pick`
    /// answers. It never goes into a page (AXWebArea): the address is not in there, and walking a
    /// page is slow and makes a browser switch its own accessibility on.
    private static func first<T>(under root: AXUIElement, _ pick: (AXUIElement, String) -> T?) -> T? {
        var queue = [root]
        var next = 0
        while next < queue.count {
            let element = queue[next]
            next += 1
            let role = string(element, kAXRoleAttribute) ?? ""
            if let found = pick(element, role) { return found }
            if role == "AXWebArea" || leaves.contains(role) { continue }
            queue += children(element).prefix(budget - queue.count)
        }
        return nil
    }

    private static func copy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
    }

    private static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        copy(element, attribute) as? String
    }

    private static func url(_ element: AXUIElement, _ attribute: String) -> URL? {
        copy(element, attribute) as? URL
    }

    private static func element(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let value = copy(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private static func children(_ element: AXUIElement) -> [AXUIElement] {
        copy(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    }
}
