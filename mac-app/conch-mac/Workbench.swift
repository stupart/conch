import AppKit
import ConchDesign
import SwiftUI
import WebKit

/// The Workbench, conch's in-app browser: the Mac app's half (src/browser-workbench.ts is the daemon's). Each tab the
/// daemon publishes is a live web view here, made when the tab first appears and kept alive while the app runs, so
/// switching tabs never reloads a page and an agent can drive one nobody is looking at. Shown, a page sits in the
/// Workdesk (`WorkbenchPane`), where Tyler clicks and types in it directly: that is taking over. Not shown, it is
/// parked in a window of its own off every screen, still drawing, so a read or a screenshot sees it as it is.
///
/// An agent's command comes the way a page capture does (`PageCaptureRequests`): named on the sessions file, acked at
/// once (the ack's reply carries what to type, which is never on the file), run against the page by `WorkbenchScript`,
/// and answered over the socket.
///
/// Tyler opens tabs too (`openTab`, the Workdesk's +), on a profile he picks while the tab is blank, and pauses agents
/// in one (`setPaused`), which refuses their commands there. While an agent's command runs he sees it: the tab and its
/// bar say Agent (`working`), its click or its field is marked on the page (`WorkbenchPage.mark`), and a tab he isn't
/// looking at gets a dot (`actedIn`), or comes forward when it may (`agentActivity`, `Workbench.follows`).
///
/// Tyler, 2026-10-09: "Agents's pages should live as tabs in the deliverables plane just like the deliverables."
/// 2026-10-16: "letting me sign-in in an in-conch browser session and letting agents use that browser in the app so i
/// can watch them work".
@MainActor
final class WorkbenchStore: ObservableObject {
    static let shared = WorkbenchStore(socket: ConchSocketClient(environment: ProcessInfo.processInfo.environment))

    /// Tabs that have just appeared, for the pane to bring the one in view to the front (`Workbench.front`).
    struct Arrival: Equatable {
        let tabs: [Workbench.Tab]
        let serial: Int
    }

    /// An agent's command starting in a tab: for the pane to bring that tab forward, when it may (`Workbench.follows`).
    struct AgentActivity: Equatable {
        let tab: Workbench.Tab
        let serial: Int
    }

    /// Every open tab, oldest first, as the daemon publishes them, less any closed here and not yet gone from the file.
    @Published private(set) var tabs: [Workbench.Tab] = []
    /// Each profile's name, by id.
    @Published private(set) var profileNames: [String: String] = [:]
    /// Every profile, the default first, for a blank tab's picker.
    @Published private(set) var profiles: [WorkbenchProfileList.Profile] = []
    @Published private(set) var arrival: Arrival?
    /// The tabs an agent's command is running in, or ended in within `Workbench.agentLinger`, and what it is doing.
    @Published private(set) var working: [String: String] = [:]
    /// Tabs an agent acted in while they weren't shown: each keeps its dot until it is.
    @Published private(set) var actedIn: Set<String> = []
    @Published private(set) var agentActivity: AgentActivity?
    /// A tab whose address field takes the keyboard when it is shown: the one Tyler just opened.
    @Published var focusAddress: String?

    /// The browser tab the Workdesk shows now, as its pane says.
    private(set) var shown: String?
    /// When Tyler last touched the Workdesk: a click, a key or a scroll in a shown page, or a press in its strip.
    private(set) var lastTouch: Date?

    private let socket: ConchSocketClient
    private var pages: [String: WorkbenchPage] = [:]
    private var known: Set<String> = []
    /// Closed here: never made again while the daemon still names it.
    private var closed: Set<String> = []
    /// Commands already taken in hand; one is run once, however many polls name it.
    private var handled: Set<String> = []
    private var stores: [UUID: WKWebsiteDataStore] = [:]
    private var serial = 0
    /// Pause agents, set here and not yet on the file: what the tab says meanwhile.
    private var pausing: [String: Bool] = [:]
    /// Commands under way per tab, and the linger before a tab's badge goes.
    private var running: [String: Int] = [:]
    private var lingering: [String: Task<Void, Never>] = [:]
    private var touchMonitor: Any?

    init(socket: ConchSocketClient) {
        self.socket = socket
        // Tyler's hand in a shown page, however it got there: what keeps an agent's work from taking the Workdesk from him.
        touchMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .scrollWheel]) { [weak self] event in
            MainActor.assumeIsolated { self?.noteTouch(event) }
            return event
        }
    }

    /// A press in the Workdesk's own controls (its strip, its bar).
    func touched() {
        lastTouch = Date()
    }

    private func noteTouch(_ event: NSEvent) {
        for page in pages.values where page.isShown && page.webView.window === event.window {
            if event.type == .keyDown {
                guard let responder = event.window?.firstResponder as? NSView, responder.isDescendant(of: page.webView) else { continue }
            } else {
                let point = page.webView.convert(event.locationInWindow, from: nil)
                guard page.webView.bounds.contains(point) else { continue }
            }
            touched()
            return
        }
    }

    /// The pane's word on which browser tab it shows: that tab's dot goes.
    func show(_ id: String?) {
        shown = id
        if let id { actedIn.remove(id) }
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
        let listed = (snapshot.browserProfiles ?? []).map { WorkbenchProfileList.Profile(id: $0.id, name: $0.name) }
        if listed != profiles {
            profiles = listed
            // Which sites each is signed in to, kept from now on (Settings › Browser, and the logins inventory's report).
            BrowserSignInsStore.shared.keep(only: listed.isEmpty ? [Workbench.defaultProfile] : listed.map(\.id))
        }
        profileNames = Dictionary(listed.map { ($0.id, $0.name) }, uniquingKeysWith: { _, last in last })
        // A pause the daemon has taken is its to say again; one it hasn't yet still shows as Tyler set it.
        for (id, paused) in pausing where published.contains(where: { $0.id == id && ($0.paused == true) == paused }) || !published.contains(where: { $0.id == id }) {
            pausing[id] = nil
        }
        let all = published.map(\.workbenchTab).map { tab in
            pausing[tab.id].map { tab.with(paused: $0) } ?? tab
        }
        let ids = Set(all.map(\.id))
        closed.formIntersection(ids)
        actedIn.formIntersection(ids)
        for (id, page) in pages where !ids.contains(id) {
            page.close()
            pages[id] = nil
        }
        // A blank tab moved to another profile: its page is made again on that profile's store.
        for tab in all {
            guard let page = pages[tab.id], page.profile != tab.profile else { continue }
            page.close()
            pages[tab.id] = nil
        }
        for tab in all where pages[tab.id] == nil && !closed.contains(tab.id) {
            guard let store = dataStore(for: tab.profile) else { continue }
            let socket = socket
            pages[tab.id] = WorkbenchPage(tab: tab, store: store) { event in
                Task { _ = await socket.request(event, timeout: 2) }
            }
        }
        for tab in all { pages[tab.id]?.agentsPaused = tab.paused }
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
        touched()
        closed.insert(id)
        pages[id]?.close()
        pages[id] = nil
        tabs.removeAll { $0.id == id }
        let socket = socket
        Task { _ = await socket.request(WorkbenchTabEvent(tab: id, closed: true), timeout: 2) }
    }

    /// The Workdesk's +: a tab of Tyler's own in a session, blank, on a profile, its address field waiting for him. Its id
    /// once the tab is here (on the file), or why there is none.
    func openTab(sessionId: String, profile: String) async -> Result<String, WorkbenchFailure> {
        touched()
        guard case let .reply(data) = await socket.request(WorkbenchTabOpen(sessionId: sessionId, profile: profile), timeout: 5) else {
            return .failure(WorkbenchFailure(words: "conch's daemon didn't answer, so no tab was opened. Is it running?"))
        }
        guard let reply = try? JSONDecoder().decode(WorkbenchOpened.self, from: data) else {
            return .failure(WorkbenchFailure(words: "conch's daemon is older than this app and can't open a tab for you yet; restart it"))
        }
        guard reply.kind == "browser-opened", let id = reply.tabId else {
            return .failure(WorkbenchFailure(words: reply.error.map { "No tab was opened: \($0)" } ?? "conch's daemon is older than this app and can't open a tab for you yet; restart it"))
        }
        focusAddress = id
        // On the file within a poll or two: the pane shows it as soon as it is there.
        for _ in 0..<40 where !tabs.contains(where: { $0.id == id }) {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return .success(id)
    }

    /// Pause agents in a tab, or let them back in: at once here (a command already on its way is refused too), and on
    /// the daemon, which refuses theirs from now on.
    func setPaused(_ id: String, _ paused: Bool) {
        touched()
        pausing[id] = paused
        pages[id]?.agentsPaused = paused
        tabs = tabs.map { $0.id == id ? $0.with(paused: paused) : $0 }
        let socket = socket
        Task { _ = await socket.request(WorkbenchTabEvent(tab: id, paused: paused), timeout: 2) }
    }

    /// A blank tab's profile, picked: the daemon moves it, and its page is made again on that profile's store.
    func setProfile(_ id: String, profile: String) async -> WorkbenchFailure? {
        touched()
        guard case let .reply(data) = await socket.request(WorkbenchTabEvent(tab: id, profile: profile), timeout: 5),
              let reply = try? JSONDecoder().decode(WorkbenchOpened.self, from: data)
        else { return WorkbenchFailure(words: "conch's daemon didn't answer; the tab kept its profile") }
        return reply.kind == "browser-error" ? WorkbenchFailure(words: reply.error ?? "the tab kept its profile") : nil
    }

    /// A new profile by name (`browser-profiles add`, as Settings › Browser makes one): its id, or why not.
    func createProfile(named name: String) async -> Result<String, WorkbenchFailure> {
        switch await ChromeImport.profiles("add", name: name) {
        case let .profiles(_, created):
            guard let created else { return .failure(WorkbenchFailure(words: "conch's daemon didn't say which profile it made")) }
            return .success(created.id)
        case let .refused(words):
            return .failure(WorkbenchFailure(words: words))
        case .needsUpdate:
            return .failure(WorkbenchFailure(words: ChromeImportStore.needsUpdate))
        case .unreachable:
            return .failure(WorkbenchFailure(words: "conch's daemon isn't running, so no profile was made"))
        }
    }

    /// An agent's command starting in a tab: its badge on, its dot when it isn't shown, and word for the pane to follow.
    private func began(_ request: PublishedState.BrowserRequest) {
        let id = request.tab
        running[id, default: 0] += 1
        lingering[id]?.cancel()
        lingering[id] = nil
        working[id] = Workbench.agentWords(op: request.op)
        if id != shown { actedIn.insert(id) }
        if let tab = tabs.first(where: { $0.id == id }) {
            serial += 1
            agentActivity = AgentActivity(tab: tab, serial: serial)
        }
    }

    /// Its command done: the badge stays a moment, so a run of commands reads as one stretch of work.
    private func ended(_ request: PublishedState.BrowserRequest) {
        let id = request.tab
        running[id] = max(0, (running[id] ?? 1) - 1)
        guard running[id] == 0 else { return }
        lingering[id] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Workbench.agentLinger * 1_000_000_000))
            guard let self, !Task.isCancelled, self.running[id] == 0 else { return }
            self.working[id] = nil
            self.lingering[id] = nil
        }
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
                // Tyler's hand got there first: a command already on its way when he paused agents is refused too.
                if page.agentsPaused {
                    _ = await socket.request(WorkbenchAnswer(request: request.id, error: Workbench.pausedRefusal(tab: request.tab)), timeout: 5)
                    return
                }
                self.began(request)
                let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated], reason: "running a command an agent gave conch's browser")
                let answer = await page.run(request, text: ack.text)
                ProcessInfo.processInfo.endActivity(activity)
                self.ended(request)
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
    /// The profile whose store it was made on: a blank tab moved to another is made again (`WorkbenchStore.accept`).
    let profile: String
    /// Tyler paused agents in it: a command reaching it is refused, even one already queued.
    var agentsPaused = false
    /// Where an agent's command is landing now, marked over the page (`WorkbenchMarks`).
    @Published private(set) var mark: WorkbenchMark?
    private var markSerial = 0
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
        profile = tab.profile
        agentsPaused = tab.paused
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
        // A load that failed leaves WebKit on about:blank: the bar keeps the address that was asked for.
        let here = Workbench.isWeb(view.url) || view !== webView ? view.url : lastRequested ?? view.url
        if url != here { url = here }
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

    /// In the Workdesk now, not parked.
    var isShown: Bool {
        guard !isClosed, let superview = webView.superview else { return false }
        return superview !== window.contentView
    }

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
    /// Again: the page in front, or, when the first load never got anywhere, the address that was asked for.
    func reload() {
        failure = nil
        if front === webView, !Workbench.isWeb(webView.url), let lastRequested { load(lastRequested) } else { front.reload() }
    }
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
                finish(await self.execute(request, text: text, deadline: deadline))
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(max(0, deadline.timeIntervalSinceNow) * 1_000_000_000))
                work.cancel()
                finish(self.answer(request, error: "conch's browser ran out of time on this page; it may still be loading"))
            }
        }
    }

    private func execute(_ request: PublishedState.BrowserRequest, text: String?, deadline: Date) async -> WorkbenchAnswer {
        // Paused while it waited its turn: Tyler's hand comes first.
        if agentsPaused { return WorkbenchAnswer(request: request.id, error: Workbench.pausedRefusal(tab: id)) }
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
            // Where it will land, marked first, so Tyler sees the click happen where it happens.
            await markTarget(target, kind: .click)
            let outcome = await script(front, op: "click", target: target, text: nil, submit: false)
            guard case let .success(value) = outcome else { return answer(request, error: outcome.message ?? "the click didn't happen") }
            await settle(until: settleBy)
            return answer(request, result: value)
        case "type":
            guard let target = request.target?.pair else { return answer(request, error: "typing needs its target") }
            guard let text else { return answer(request, error: "conch's daemon didn't hand over what to type") }
            // The field outlined while it fills, as typing looks (WorkbenchScript): never what is typed, in conch's words.
            if let refused = await markTarget(target, kind: .type) { return answer(request, error: refused) }
            let outcome = await script(front, op: "type", target: target, text: text, submit: request.submit == true)
            clearMark(after: 0.35)
            guard case let .success(value) = outcome else { return answer(request, error: outcome.message ?? "nothing was typed") }
            if request.submit == true { await settle(until: settleBy) }
            return answer(request, result: value)
        case "screenshot":
            return await screenshot(request)
        default:
            return answer(request, error: "conch's browser has no \(request.op)")
        }
    }

    /// Mark where a command will land: the element scrolled into view and its box outlined, a click's spot rippling.
    /// A password field is refused here, before anything is marked; anything else the page can't find is left for the
    /// command itself to say.
    @discardableResult
    private func markTarget(_ target: (how: String, what: String), kind: WorkbenchMark.Kind) async -> String? {
        let view = front
        switch await script(view, op: kind == .type ? "locate-field" : "locate", target: target, text: nil, submit: false) {
        case let .failure(message):
            return message == WorkbenchScript.passwordRefusal ? message : nil
        case let .success(value):
            guard case let .array(numbers)? = value["box"] else { return nil }
            let box = numbers.compactMap { if case let .number(number) = $0 { number } else { nil } }
            guard let rect = Workbench.markRect(box: box, scale: Double(view.pageZoom * view.magnification)) else { return nil }
            markSerial += 1
            mark = WorkbenchMark(kind: kind, rect: rect, serial: markSerial)
            // A beat for the mark to be seen before the page moves under it.
            if kind == .click { try? await Task.sleep(nanoseconds: 160_000_000) }
            return nil
        }
    }

    private func clearMark(after seconds: Double) {
        let serial = markSerial
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard let self, self.markSerial == serial else { return }
            self.mark = nil
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

/// A tab moved, closed or paused under Tyler's own hand, or a blank one moved to another profile (`browser-tab-event`).
struct WorkbenchTabEvent: Encodable {
    let kind = "browser-tab-event"
    let tab: String
    var url: String?
    var title: String?
    var closed: Bool?
    var paused: Bool?
    var profile: String?
}

/// The Workdesk's +: a tab of Tyler's own in a session (`browser-tab-open`).
struct WorkbenchTabOpen: Encodable {
    let kind = "browser-tab-open"
    let sessionId: String
    let profile: String
}

/// The daemon's answer to a tab opened, or to a tab event: its id, or why not.
private struct WorkbenchOpened: Decodable {
    let kind: String
    let tabId: String?
    let error: String?
}

/// Why something Tyler asked of the browser didn't happen, in words to show him.
struct WorkbenchFailure: Error, Equatable {
    let words: String
}

extension PublishedState.BrowserTab {
    var workbenchTab: Workbench.Tab {
        Workbench.Tab(
            id: id, sessionId: sessionId, url: url, title: title, profile: profile, openedAt: openedAt,
            openedByUser: opener == "user", paused: paused == true
        )
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

/// A tab's live page, with its bar over it (ConchDesign `WorkbenchBar`): back, forward, reload, the address, the Agent
/// badge while an agent's command runs, the profile (a picker while the tab is blank), Pause agents, Open in Browser and
/// close. Over the page: where an agent's command lands (`WorkbenchMarks`), a blank tab's page, and why a load failed.
struct WorkbenchPane: View {
    @ObservedObject var page: WorkbenchPage
    @ObservedObject var store: WorkbenchStore
    let tab: Workbench.Tab
    /// Open in Browser, through the app's one door for links (`StateStore.openLink`), which says when it can't.
    let openInBrowser: (URL) -> Void
    let close: () -> Void

    @State private var draft = ""
    @FocusState private var editing: Bool
    @State private var pickingProfile = false
    @State private var problem: String?

    private var profileName: String {
        store.profileNames[tab.profile] ?? (tab.profile == Workbench.defaultProfile ? "Default" : tab.profile)
    }

    /// Blank, and never sent anywhere: its profile can still change, and its page says where to start.
    private var isBlank: Bool { tab.isBlank && page.url == nil }

    var body: some View {
        VStack(spacing: 0) {
            WorkbenchBar(
                facts: WorkbenchBar.Facts(
                    canGoBack: page.canGoBack,
                    canGoForward: page.canGoForward,
                    isLoading: page.isLoading,
                    isSecure: page.url?.scheme == "https",
                    hasPage: page.url != nil,
                    popupCount: page.popupCount,
                    profileName: profileName,
                    isDefaultProfile: tab.profile == Workbench.defaultProfile,
                    canPickProfile: isBlank,
                    agentWork: store.working[tab.id],
                    paused: tab.paused
                ),
                draft: $draft,
                editing: $editing,
                pickingProfile: $pickingProfile,
                profilePicker: AnyView(profilePicker),
                actions: WorkbenchBar.Actions(
                    back: { store.touched(); page.goBack() },
                    forward: { store.touched(); page.goForward() },
                    reloadOrStop: {
                        store.touched()
                        if page.isLoading { page.stop() } else { page.reload() }
                    },
                    go: { typed in
                        store.touched()
                        if let url = Workbench.address(typed: typed) { page.navigate(to: url) }
                    },
                    togglePause: { store.setPaused(tab.id, !tab.paused) },
                    closePopup: { store.touched(); page.closeTopPopup() },
                    openInBrowser: { if let url = page.url { openInBrowser(url) } },
                    close: close
                )
            )

            Rectangle()
                .fill(ConchPalette.divider)
                .frame(height: 1)

            WorkbenchHost(page: page)
                .overlay { WorkbenchMarks(mark: page.mark) }
                .overlay {
                    if isBlank { WorkbenchBlankPage(profileName: profileName) }
                }
                .overlay(alignment: .top) {
                    if let failure = page.failure ?? problem {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle")
                            Text(failure)
                                .font(ConchTypography.font(size: 11))
                                .lineLimit(2)
                            Spacer(minLength: 0)
                            if page.failure != nil {
                                Button("Retry") { page.reload() }
                                    .font(ConchTypography.font(size: 11))
                            } else {
                                Button("OK") { problem = nil }
                                    .font(ConchTypography.font(size: 11))
                            }
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
        .onAppear {
            draft = page.url?.absoluteString ?? ""
            store.show(tab.id)
            takeFocusIfAsked()
        }
        .onChange(of: store.focusAddress) { _, _ in takeFocusIfAsked() }
        // The field follows the page (a redirect, a link followed, an agent's command), unless Tyler is typing in it.
        .onChange(of: page.url) { _, url in
            if !editing { draft = url?.absoluteString ?? "" }
        }
        .onChange(of: editing) { _, now in if now { store.touched() } }
    }

    /// The tab Tyler just opened: its address field takes the keyboard, once, a moment after it is on screen.
    private func takeFocusIfAsked() {
        guard store.focusAddress == tab.id else { return }
        store.focusAddress = nil
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 120_000_000)
            editing = true
        }
    }

    private var profilePicker: some View {
        WorkbenchProfileList(
            profiles: store.profiles.isEmpty ? [WorkbenchProfileList.Profile(id: Workbench.defaultProfile, name: "Default")] : store.profiles,
            selected: tab.profile,
            pick: { id in
                pickingProfile = false
                guard id != tab.profile else { return }
                Task { @MainActor in
                    UserDefaults.standard.set(id, forKey: WorkbenchNewTab.profileKey)
                    problem = await store.setProfile(tab.id, profile: id)?.words
                }
            },
            create: { name in
                switch await store.createProfile(named: name) {
                case let .failure(failure):
                    return failure.words
                case let .success(id):
                    pickingProfile = false
                    UserDefaults.standard.set(id, forKey: WorkbenchNewTab.profileKey)
                    problem = await store.setProfile(tab.id, profile: id)?.words
                    return nil
                }
            }
        )
    }
}

/// What a new tab of Tyler's opens on: the profile he picked last for one, else Default.
enum WorkbenchNewTab {
    static let profileKey = "conch.workbench.newTabProfile"

    static func profile(among profiles: [WorkbenchProfileList.Profile]) -> String {
        let picked = UserDefaults.standard.string(forKey: profileKey)
        return profiles.contains(where: { $0.id == picked }) ? picked! : Workbench.defaultProfile
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
