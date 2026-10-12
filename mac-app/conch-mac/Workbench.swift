import AppKit
import ConchDesign
import SwiftUI
import WebKit

/// The Workbench, conch's in-app browser: the Mac app's half (src/browser-workbench.ts is the daemon's). Each tab the
/// daemon publishes is a live web view here, made when the tab first appears and kept alive while the app runs, so
/// switching tabs never reloads a page and an agent can drive one nobody is looking at. Shown, a page sits in the
/// deliverables pane (`WorkbenchPane`), where Tyler clicks and types in it directly: that is taking over. Not shown, it is
/// parked in a window of its own off every screen, still drawing, so a read or a screenshot sees it as it is.
///
/// An agent's command comes the way a page capture does (`PageCaptureRequests`): named on the sessions file, acked at
/// once (the ack's reply carries what to type, which is never on the file), run against the page by `WorkbenchScript`,
/// and answered over the socket.
///
/// Tyler, 2026-10-09: "Agents's pages should live as tabs in the deliverables plane just like the deliverables."
@MainActor
final class WorkbenchStore: ObservableObject {
    static let shared = WorkbenchStore(socket: ConchSocketClient(environment: ProcessInfo.processInfo.environment))

    /// Tabs that have just appeared, for the pane to bring the one in view to the front (`Workbench.front`).
    struct Arrival: Equatable {
        let tabs: [Workbench.Tab]
        let serial: Int
    }

    /// Every open tab, oldest first, as the daemon publishes them, less any closed here and not yet gone from the file.
    @Published private(set) var tabs: [Workbench.Tab] = []
    /// Each profile's name, by id.
    @Published private(set) var profileNames: [String: String] = [:]
    @Published private(set) var arrival: Arrival?

    private let socket: ConchSocketClient
    private var pages: [String: WorkbenchPage] = [:]
    private var known: Set<String> = []
    /// Closed here: never made again while the daemon still names it.
    private var closed: Set<String> = []
    /// Commands already taken in hand; one is run once, however many polls name it.
    private var handled: Set<String> = []
    private var stores: [UUID: WKWebsiteDataStore] = [:]
    private var serial = 0

    init(socket: ConchSocketClient) {
        self.socket = socket
    }

    func tabs(of sessionId: String) -> [Workbench.Tab] {
        tabs.filter { $0.sessionId == sessionId }
    }

    func page(for id: String) -> WorkbenchPage? {
        pages[id]
    }

    /// The sessions file, read: a page made for each new tab and closed for each gone, and the commands taken in hand.
    /// A daemon with no browser publishes no tabs at all, which says nothing, and closes nothing.
    func accept(_ snapshot: PublishedState) {
        guard let published = snapshot.browserTabs else { return }
        profileNames = Dictionary((snapshot.browserProfiles ?? []).map { ($0.id, $0.name) }, uniquingKeysWith: { _, last in last })
        let all = published.map(\.workbenchTab)
        let ids = Set(all.map(\.id))
        closed.formIntersection(ids)
        for (id, page) in pages where !ids.contains(id) {
            page.close()
            pages[id] = nil
        }
        for tab in all where pages[tab.id] == nil && !closed.contains(tab.id) {
            guard let store = dataStore(for: tab.profile) else { continue }
            let socket = socket
            pages[tab.id] = WorkbenchPage(tab: tab, store: store) { event in
                Task { _ = await socket.request(event, timeout: 2) }
            }
        }
        let open = all.filter { !closed.contains($0.id) }
        if open != tabs { tabs = open }
        let arrived = Workbench.arrivals(open, known: known, now: Date())
        known = ids
        if !arrived.isEmpty {
            serial += 1
            arrival = Arrival(tabs: arrived, serial: serial)
        }
        handle(snapshot.browserRequests)
    }

    /// Tyler's ×: the page goes now, and the daemon is told, which takes the tab off the file.
    func close(_ id: String) {
        closed.insert(id)
        pages[id]?.close()
        pages[id] = nil
        tabs.removeAll { $0.id == id }
        let socket = socket
        Task { _ = await socket.request(WorkbenchTabEvent(tab: id, closed: true), timeout: 2) }
    }

    /// The default store for the built-in profile; a store of its own, kept by WebKit, for any other.
    private func dataStore(for profile: String) -> WKWebsiteDataStore? {
        switch Workbench.dataStore(forProfile: profile) {
        case .default:
            return .default()
        case let .identified(uuid):
            if let known = stores[uuid] { return known }
            let store = WKWebsiteDataStore(forIdentifier: uuid)
            stores[uuid] = store
            return store
        case nil:
            return nil
        }
    }

    private func handle(_ requests: [PublishedState.BrowserRequest]) {
        // A command gone from the file is answered or expired, and its id never comes back.
        handled.formIntersection(requests.map(\.id))
        for request in requests where !handled.contains(request.id) {
            handled.insert(request.id)
            let socket = socket
            let page = pages[request.tab]
            Task { @MainActor in
                // Said first, as a capture's is: how the daemon tells an app that isn't running from a page that is slow.
                // Its reply hands over what an agent types, which never goes on the sessions file.
                guard case let .reply(data) = await socket.request(WorkbenchAnswer(request: request.id, ack: true), timeout: 5),
                      let ack = try? JSONDecoder().decode(WorkbenchAck.self, from: data), ack.kind == "browser-ack"
                else { return }
                guard let page else {
                    _ = await socket.request(WorkbenchAnswer(request: request.id, error: "that tab isn't open in conch's window"), timeout: 5)
                    return
                }
                let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated], reason: "running a command an agent gave conch's browser")
                let answer = await page.run(request, text: ack.text)
                ProcessInfo.processInfo.endActivity(activity)
                _ = await socket.request(answer, timeout: 5)
            }
        }
    }
}

/// One tab's page: the web view, the windows it opened over itself, and where it is parked when it isn't shown.
@MainActor
final class WorkbenchPage: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    /// The same Safari user agent as Claude's sign-in sheet (`ClaudeSignInWebView`): Google's sign-in turns away
    /// browsers it takes for embedded ones, and this is Safari's engine.
    static let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
    /// A page never shown yet is laid out at a laptop's browser window.
    static let parkedSize = CGSize(width: 1280, height: 860)
    private static let world = WKContentWorld.world(name: WorkbenchScript.contentWorld)

    let id: String
    let webView: WKWebView
    /// Where the page in front is (the newest window it opened, else itself) and what it is called.
    @Published private(set) var url: URL?
    @Published private(set) var title = ""
    @Published private(set) var isLoading = false
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var popupCount = 0
    /// Why the last load didn't, when it didn't: said over the page.
    @Published private(set) var failure: String?

    /// Windows the page opened (a "Continue with Google"), each a real web view over it, so `window.opener` works.
    private var popups: [WKWebView] = []
    private let window: WorkbenchParkingWindow
    private var observations: [NSKeyValueObservation] = []
    /// One command at a time, in order: two at once on one page would trip over each other.
    private var queue: Task<Void, Never>?
    /// The address this page was last sent to by a load of conch's own.
    private var lastRequested: URL?
    private let report: (WorkbenchTabEvent) -> Void
    private var reporting: Task<Void, Never>?
    private var isClosed = false

    /// The page in front: what a command runs against and the bar describes.
    var front: WKWebView { popups.last ?? webView }

    init(tab: Workbench.Tab, store: WKWebsiteDataStore, report: @escaping (WorkbenchTabEvent) -> Void) {
        id = tab.id
        self.report = report
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        // An agent's click on "Continue with Google" has to be able to open its window.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        webView = WKWebView(frame: CGRect(origin: .zero, size: Self.parkedSize), configuration: configuration)
        window = WorkbenchParkingWindow(contentRect: NSRect(origin: PageCapturer.parking, size: Self.parkedSize), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.hasShadow = false
        window.isExcludedFromWindowsMenu = true
        window.collectionBehavior = [.transient, .ignoresCycle, .stationary]
        window.animationBehavior = .none
        window.contentView = NSView(frame: CGRect(origin: .zero, size: Self.parkedSize))
        super.init()
        Self.prepare(webView, delegate: self)
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        park()
        // In, without bringing conch forward or taking a key: off every screen, seen by WebKit alone, which draws a page
        // only in a window it takes to be visible (PageCapturer.swift says how this was measured).
        window.orderFrontRegardless()
        observe(webView)
        if let url = URL(string: tab.url), Workbench.isWeb(url) { load(url) }
    }

    /// What every web view of a tab is set up with: the Safari agent, this page as its delegate, and never taken to be
    /// hidden, so a page parked off screen keeps running its frames.
    private static func prepare(_ view: WKWebView, delegate: WorkbenchPage) {
        view.customUserAgent = userAgent
        view.navigationDelegate = delegate
        view.uiDelegate = delegate
        view.underPageBackgroundColor = NSColor(ConchPalette.bg)
        let occlusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        if view.responds(to: occlusion) {
            typealias Setter = @convention(c) (NSObject, Selector, Bool) -> Void
            unsafeBitCast(view.method(for: occlusion), to: Setter.self)(view, occlusion, false)
        }
    }

    private func observe(_ view: WKWebView) {
        let changed: () -> Void = { [weak self] in
            Task { @MainActor in self?.sync() }
        }
        observations += [
            view.observe(\.url, options: [.new]) { _, _ in changed() },
            view.observe(\.title, options: [.new]) { _, _ in changed() },
            view.observe(\.isLoading, options: [.new]) { _, _ in changed() },
            view.observe(\.canGoBack, options: [.new]) { _, _ in changed() },
            view.observe(\.canGoForward, options: [.new]) { _, _ in changed() },
        ]
    }

    /// The bar's facts from the page in front, and the daemon told where the tab itself is, a moment after it settles.
    private func sync() {
        guard !isClosed else { return }
        let view = front
        if url != view.url { url = view.url }
        let named = view.title ?? ""
        if title != named { title = named }
        if isLoading != view.isLoading { isLoading = view.isLoading }
        if canGoBack != view.canGoBack { canGoBack = view.canGoBack }
        if canGoForward != view.canGoForward { canGoForward = view.canGoForward }
        if popupCount != popups.count { popupCount = popups.count }
        reporting?.cancel()
        reporting = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard let self, !Task.isCancelled, !self.isClosed else { return }
            let here = self.webView.url
            self.report(WorkbenchTabEvent(
                tab: self.id,
                url: Workbench.isWeb(here) ? here?.absoluteString : nil,
                title: self.webView.title
            ))
        }
    }

    // MARK: Where it is shown

    /// Shown in the pane: the page moves into its view, at its size.
    func attach(to container: NSView) {
        guard !isClosed, webView.superview !== container else { return }
        webView.removeFromSuperview()
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)
    }

    /// Off screen again, alive: back in its own window, at the size it was last shown. Only from the view it is in, so a
    /// pane that has already taken it elsewhere keeps it.
    func park(from container: NSView? = nil) {
        guard !isClosed, let content = window.contentView else { return }
        if let container, webView.superview !== container { return }
        let shown = webView.bounds.size
        let size = shown.width >= 200 && shown.height >= 200 ? shown : Self.parkedSize
        window.setContentSize(size)
        content.frame = CGRect(origin: .zero, size: size)
        webView.removeFromSuperview()
        webView.frame = content.bounds
        webView.autoresizingMask = [.width, .height]
        content.addSubview(webView)
    }

    func close() {
        guard !isClosed else { return }
        isClosed = true
        reporting?.cancel()
        queue?.cancel()
        observations.forEach { $0.invalidate() }
        observations = []
        for view in popups + [webView] {
            view.stopLoading()
            view.navigationDelegate = nil
            view.uiDelegate = nil
            view.removeFromSuperview()
        }
        popups = []
        window.orderOut(nil)
        window.contentView = nil
        window.close()
    }

    // MARK: Tyler's controls

    func load(_ url: URL) {
        guard Workbench.isWeb(url) else { return }
        lastRequested = url
        failure = nil
        webView.load(URLRequest(url: url))
    }

    /// The address field: the page in front goes there, a window it opened included.
    func navigate(to url: URL) {
        guard Workbench.isWeb(url) else { return }
        if front === webView { load(url) } else { failure = nil; front.load(URLRequest(url: url)) }
    }

    func goBack() { front.goBack() }
    func goForward() { front.goForward() }
    func reload() { failure = nil; front.reload() }
    func stop() { front.stopLoading() }

    /// The newest window the page opened, closed, as its own close button would.
    func closeTopPopup() {
        guard let popup = popups.popLast() else { return }
        popup.stopLoading()
        popup.removeFromSuperview()
        sync()
    }

    // MARK: An agent's command

    func run(_ request: PublishedState.BrowserRequest, text: String?) async -> WorkbenchAnswer {
        let previous = queue
        let work = Task { @MainActor [weak self] () -> WorkbenchAnswer in
            await previous?.value
            guard let self, !self.isClosed else { return WorkbenchAnswer(request: request.id, error: "the tab was closed") }
            return await self.raced(request, text: text)
        }
        queue = Task { _ = await work.value }
        return await work.value
    }

    /// By the command's deadline whatever the page does: a page that hangs its web process never answers a script again.
    private func raced(_ request: PublishedState.BrowserRequest, text: String?) async -> WorkbenchAnswer {
        let deadline = Date(timeIntervalSince1970: request.deadline / 1000)
        let once = WorkbenchOnce()
        return await withCheckedContinuation { continuation in
            let finish: @MainActor (WorkbenchAnswer) -> Void = { answer in
                if once.take() { continuation.resume(returning: answer) }
            }
            let work = Task { @MainActor in
                finish(await self.perform(request, text: text, deadline: deadline))
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(max(0, deadline.timeIntervalSinceNow) * 1_000_000_000))
                work.cancel()
                finish(self.answer(request, error: "conch's browser ran out of time on this page; it may still be loading"))
            }
        }
    }

    private func perform(_ request: PublishedState.BrowserRequest, text: String?, deadline: Date) async -> WorkbenchAnswer {
        // Its own deadline for a navigation a command sets off, inside the command's.
        let settleBy = min(deadline.addingTimeInterval(-1), Date().addingTimeInterval(10))
        switch request.op {
        case "open":
            guard let raw = request.url, let url = URL(string: raw), Workbench.isWeb(url) else {
                return answer(request, error: "that isn't an http(s) address")
            }
            // A tab made for this command is already loading it: waited for, not loaded twice.
            if !(request.fresh == true && lastRequested == url) {
                for popup in popups { popup.removeFromSuperview() }
                popups = []
                load(url)
            }
            _ = await waitForLoad(until: deadline.addingTimeInterval(-1))
            if let failure { return answer(request, error: failure) }
            return answer(request, result: [:])
        case "read":
            switch await script(front, op: "read", target: nil, text: nil, submit: false) {
            case let .failure(message): return answer(request, error: message)
            case let .success(value): return answer(request, result: value)
            }
        case "click":
            guard let target = request.target?.pair else { return answer(request, error: "a click needs its target") }
            let outcome = await script(front, op: "click", target: target, text: nil, submit: false)
            guard case let .success(value) = outcome else { return answer(request, error: outcome.message ?? "the click didn't happen") }
            await settle(until: settleBy)
            return answer(request, result: value)
        case "type":
            guard let target = request.target?.pair else { return answer(request, error: "typing needs its target") }
            guard let text else { return answer(request, error: "conch's daemon didn't hand over what to type") }
            let outcome = await script(front, op: "type", target: target, text: text, submit: request.submit == true)
            guard case let .success(value) = outcome else { return answer(request, error: outcome.message ?? "nothing was typed") }
            if request.submit == true { await settle(until: settleBy) }
            return answer(request, result: value)
        case "screenshot":
            return await screenshot(request)
        default:
            return answer(request, error: "conch's browser has no \(request.op)")
        }
    }

    /// After a click or a submit: a moment for a navigation to start, then its load, if one did.
    private func settle(until deadline: Date) async {
        try? await Task.sleep(nanoseconds: 400_000_000)
        _ = await waitForLoad(until: deadline)
    }

    /// Until the page in front has loaded, or the time runs out (false).
    private func waitForLoad(until deadline: Date) async -> Bool {
        try? await Task.sleep(nanoseconds: 100_000_000)
        while front.isLoading {
            if Date() >= deadline || Task.isCancelled { return false }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return true
    }

    private enum ScriptOutcome {
        case success([String: WorkbenchJSON])
        case failure(String)

        var message: String? { if case let .failure(message) = self { message } else { nil } }
    }

    /// `WorkbenchScript`, in conch's own content world, in the page's main frame.
    private func script(_ view: WKWebView, op: String, target: (how: String, what: String)?, text: String?, submit: Bool) async -> ScriptOutcome {
        let arguments: [String: Any] = ["op": op, "how": target?.how ?? "", "what": target?.what ?? "", "text": text ?? "", "submit": submit]
        do {
            let value = try await view.callAsyncJavaScript(WorkbenchScript.page, arguments: arguments, in: nil, contentWorld: Self.world)
            guard let object = value as? [String: Any] else { return .failure("the page didn't answer conch's browser") }
            if let error = object["error"] as? String { return .failure(error) }
            return .success(object.mapValues { WorkbenchJSON($0) })
        } catch {
            // Never the page's own words: an exception's message is the page's, and could say anything.
            return .failure("the page couldn't run conch's browser just then (it may be navigating); try again")
        }
    }

    /// What the page in front shows, as a PNG in conch's capture folder, its owner's alone.
    private func screenshot(_ request: PublishedState.BrowserRequest) async -> WorkbenchAnswer {
        guard let named = request.folder, let folder = PageCapture.folder(named, home: NSHomeDirectory()),
              let name = PageCapture.fileName(request: request.id)
        else { return answer(request, error: "the daemon named a folder that isn't conch's capture folder") }
        let configuration = WKSnapshotConfiguration()
        configuration.afterScreenUpdates = true
        let view = front
        let image: NSImage? = await withCheckedContinuation { continuation in
            view.takeSnapshot(with: configuration) { image, _ in continuation.resume(returning: image) }
        }
        guard let image, let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil), let png = CanvasInk.png(cgImage) else {
            return answer(request, error: "the page couldn't be drawn")
        }
        let path = (folder as NSString).appendingPathComponent(name)
        guard FileManager.default.createFile(atPath: path, contents: png, attributes: [.posixPermissions: 0o600]) else {
            return answer(request, error: "the screenshot couldn't be written")
        }
        return answer(request, result: ["path": .string(path)])
    }

    /// An answer, with where the page in front is now and what it is called.
    private func answer(_ request: PublishedState.BrowserRequest, result: [String: WorkbenchJSON]) -> WorkbenchAnswer {
        WorkbenchAnswer(request: request.id, result: result.merging(pageFacts()) { own, _ in own })
    }

    private func answer(_ request: PublishedState.BrowserRequest, error: String) -> WorkbenchAnswer {
        WorkbenchAnswer(request: request.id, error: error, result: pageFacts())
    }

    private func pageFacts() -> [String: WorkbenchJSON] {
        let view = front
        var facts: [String: WorkbenchJSON] = ["url": .string(view.url?.absoluteString ?? ""), "title": .string(view.title ?? "")]
        if view !== webView { facts["popup"] = .bool(true) }
        if view.isLoading { facts["loading"] = .bool(true) }
        return facts
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if webView === front { failure = nil }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        record(error, in: webView)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        record(error, in: webView)
    }

    private func record(_ error: Error, in view: WKWebView) {
        // A navigation the page itself replaced (a redirect, a click while loading) is cancelled, not failed.
        let error = error as NSError
        if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled { return }
        if error.domain == "WebKitErrorDomain", error.code == 102 { return } // frame load interrupted: a download, or a policy change
        if view === front { failure = error.localizedDescription }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        // A download isn't a page: said, and left for the browser.
        if navigationResponse.isForMainFrame, !navigationResponse.canShowMIMEType {
            failure = "conch's browser doesn't download files; open it in your browser to get \(navigationResponse.response.suggestedFilename ?? "it")"
            return .cancel
        }
        return .allow
    }

    // MARK: WKUIDelegate

    /// A window the page opens comes up over it, a real web view built with WebKit's configuration, so the page that
    /// opened it hears back from it (`window.opener`): what a "Continue with Google" needs, as Claude's sign-in sheet
    /// found (`ClaudeSignInWebView`). A plain link that only asked for a new tab opens in this one.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.navigationType == .linkActivated, windowFeatures.width == nil, windowFeatures.height == nil {
            webView.load(navigationAction.request)
            return nil
        }
        let popup = WKWebView(frame: self.webView.bounds, configuration: configuration)
        popup.autoresizingMask = [.width, .height]
        Self.prepare(popup, delegate: self)
        self.webView.addSubview(popup)
        popups.append(popup)
        observe(popup)
        sync()
        return popup
    }

    /// The window closed itself (it has reported back): the page beneath carries on. The tab's own page asking to close
    /// is left open: only Tyler and its agent close a tab.
    func webViewDidClose(_ webView: WKWebView) {
        guard webView !== self.webView else { return }
        webView.removeFromSuperview()
        popups.removeAll { $0 === webView }
        sync()
    }
}

/// True the first time it is asked, and never again.
@MainActor
private final class WorkbenchOnce {
    private var taken = false
    func take() -> Bool {
        defer { taken = true }
        return !taken
    }
}

/// A parked page's window: never key, never main, so nothing that looks for conch's windows (a Dock click's reopen, a
/// debug snapshot) takes it for one of them.
final class WorkbenchParkingWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// MARK: - The socket's shapes

/// What the page script answered, as JSON again: strings, numbers, booleans, arrays and objects; anything else is null.
enum WorkbenchJSON: Encodable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([WorkbenchJSON])
    case object([String: WorkbenchJSON])
    case null

    init(_ value: Any?) {
        switch value {
        case let string as String:
            self = .string(string)
        case let number as NSNumber:
            self = CFGetTypeID(number) == CFBooleanGetTypeID() ? .bool(number.boolValue) : .number(number.doubleValue)
        case let array as [Any]:
            self = .array(array.map { WorkbenchJSON($0) })
        case let object as [String: Any]:
            self = .object(object.mapValues { WorkbenchJSON($0) })
        default:
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

/// The daemon is told (`browser-answer`): `ack` first, then what the page said, or why not.
struct WorkbenchAnswer: Encodable {
    let kind = "browser-answer"
    let request: String
    var ack: Bool?
    var error: String?
    var result: [String: WorkbenchJSON]?
}

/// The daemon's reply to an ack: what to type, when it is a type.
private struct WorkbenchAck: Decodable {
    let kind: String
    let text: String?
}

/// A tab moved or closed under Tyler's own hand (`browser-tab-event`).
struct WorkbenchTabEvent: Encodable {
    let kind = "browser-tab-event"
    let tab: String
    var url: String?
    var title: String?
    var closed: Bool?
}

extension PublishedState.BrowserTab {
    var workbenchTab: Workbench.Tab {
        Workbench.Tab(id: id, sessionId: sessionId, url: url, title: title, profile: profile, openedAt: openedAt)
    }
}

extension PublishedState.BrowserRequest.Target {
    /// How the script finds it, and what it is.
    var pair: (how: String, what: String)? {
        if let ref { return ("ref", ref) }
        if let selector { return ("selector", selector) }
        if let text { return ("text", text) }
        if let auto { return ("auto", auto) }
        return nil
    }
}

// MARK: - The pane

/// A tab in the deliverables strip: a globe and the page's name, in the strip's own tab style, with a × on hover.
struct WorkbenchTabButton: View {
    let tab: Workbench.Tab
    let isSelected: Bool
    let open: () -> Void
    let close: () -> Void

    @State private var isHovered = false

    private var label: String { Workbench.label(title: tab.title, url: tab.url) }

    var body: some View {
        HStack(spacing: 0) {
            Button(action: open) {
                HStack(spacing: 5) {
                    Image(systemName: "globe")
                        .font(.system(size: 10))
                    Text(label)
                        .font(ConchTypography.font(size: 11))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: 180, alignment: .leading)
                }
                .foregroundStyle(isSelected ? ConchPalette.textPrimary : ConchPalette.textDim)
                .padding(.leading, 8)
                .padding(.trailing, isHovered ? 2 : 8)
                .frame(height: 24)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("\(label)\n\(tab.url)")
            .accessibilityLabel("\(label), browser tab")

            if isHovered {
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(ConchPalette.textDim)
                        .frame(width: 16, height: 16)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.trailing, 4)
                .help("Close this tab")
                .accessibilityLabel("Close \(label)")
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isSelected ? ConchPalette.selection : (isHovered ? ConchPalette.hover : .clear))
        )
        .onHover { isHovered = $0 }
        .contextMenu {
            Button("Close Tab", action: close)
        }
    }
}

/// A tab's live page, with a slim bar over it: back, forward, reload, the address (edit it and press Return to go),
/// the profile it is signed in with when it isn't the default, Open in Browser, and close.
struct WorkbenchPane: View {
    @ObservedObject var page: WorkbenchPage
    /// The profile's name, shown when the tab isn't on the default.
    let profile: String?
    let close: () -> Void

    @State private var draft = ""
    @FocusState private var editing: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                barButton("chevron.left", help: "Back", enabled: page.canGoBack) { page.goBack() }
                barButton("chevron.right", help: "Forward", enabled: page.canGoForward) { page.goForward() }
                barButton(page.isLoading ? "xmark" : "arrow.clockwise", help: page.isLoading ? "Stop loading" : "Reload") {
                    if page.isLoading { page.stop() } else { page.reload() }
                }
                Image(systemName: page.url?.scheme == "https" ? "lock" : "globe")
                    .font(.system(size: 9.5))
                    .padding(.leading, 4)
                TextField("Address", text: $draft)
                    .textFieldStyle(.plain)
                    .font(ConchTypography.font(size: 11))
                    .lineLimit(1)
                    .focused($editing)
                    .onSubmit {
                        if let url = Workbench.address(typed: draft) { page.navigate(to: url) }
                        editing = false
                    }
                if let profile {
                    Text(profile)
                        .font(ConchTypography.font(size: 10, weight: .medium))
                        .lineLimit(1)
                        .padding(.horizontal, 6)
                        .frame(height: 16)
                        .background(Capsule().fill(ConchPalette.fill))
                        .help("Signed in with the \(profile) profile")
                }
                if page.popupCount > 0 {
                    barButton("xmark.rectangle", help: "Close the window this page opened") { page.closeTopPopup() }
                }
                barButton("safari", help: "Open in your browser", enabled: page.url != nil) {
                    if let url = page.url { NSWorkspace.shared.open(url) }
                }
                barButton("xmark", help: "Close this tab", action: close)
            }
            .foregroundStyle(ConchPalette.textDim)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ConchPalette.raised)

            Rectangle()
                .fill(ConchPalette.divider)
                .frame(height: 1)

            WorkbenchHost(page: page)
                .overlay(alignment: .top) {
                    if let failure = page.failure {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle")
                            Text(failure)
                                .font(ConchTypography.font(size: 11))
                                .lineLimit(2)
                            Spacer(minLength: 0)
                            Button("Retry") { page.reload() }
                                .font(ConchTypography.font(size: 11))
                        }
                        .foregroundStyle(ConchPalette.textPrimary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 8).fill(ConchPalette.raised))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(ConchPalette.divider, lineWidth: 0.5))
                        .padding(10)
                    }
                }
        }
        .background(ConchPalette.surface)
        .onAppear { draft = page.url?.absoluteString ?? "" }
        // The field follows the page (a redirect, a link followed, an agent's command), unless Tyler is typing in it.
        .onChange(of: page.url) { _, url in
            if !editing { draft = url?.absoluteString ?? "" }
        }
    }

    private func barButton(_ symbol: String, help: String, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .help(help)
        .accessibilityLabel(help)
    }
}

/// The page's own web view, moved into the pane while it is shown and parked again when it isn't: never a second view,
/// so switching tabs neither reloads the page nor loses where Tyler was in it.
private struct WorkbenchHost: NSViewRepresentable {
    let page: WorkbenchPage

    final class Coordinator {
        var page: WorkbenchPage?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(ConchPalette.bg).cgColor
        context.coordinator.page = page
        page.attach(to: container)
        return container
    }

    func updateNSView(_ container: NSView, context: Context) {
        if context.coordinator.page !== page {
            context.coordinator.page?.park(from: container)
            context.coordinator.page = page
        }
        page.attach(to: container)
    }

    static func dismantleNSView(_ container: NSView, coordinator: Coordinator) {
        coordinator.page?.park(from: container)
        coordinator.page = nil
    }
}
