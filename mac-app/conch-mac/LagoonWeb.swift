import AppKit
import WebKit
// test/lagoon-page.test.ts compiles this file with ConchDesign's sources (and LagoonSource.swift and the models) as one
// module, and drives it in a real offscreen web view.
#if canImport(ConchDesign)
import ConchDesign
#endif

// The lagoon's web view (spec §3): the page, served from the app's own copy of it over `conch-lagoon://`, fed the app's
// snapshots, and heard on one script handler. Nothing here reads StateStore: what it needs comes in through
// `LagoonWebHost.Environment`, so the harness can hand it a fixture. LagoonPane.swift is the app's side.

/// `conch-lagoon://lagoon/…`: the bundle's files, and the deliverables on the lagoon's glass (spec §3). Read-only, GET only,
/// with byte ranges; each request is checked by ConchDesign's `LagoonFiles` before a byte is read, and read off the main
/// thread.
final class LagoonSchemeHandler: NSObject, WKURLSchemeHandler {
    /// `Contents/Resources/Lagoon`.
    let bundleRoot: URL
    /// The file a review in the CURRENT state links to, asked at the moment of each request: nil when the session or the
    /// review isn't in it any more, or it is a web link.
    let reviewTarget: @MainActor (_ sessionId: String, _ reviewId: String) -> URL?

    /// Tasks WebKit hasn't stopped. Touching a stopped one raises, so every reply checks first; the reads check too, and
    /// stop reading a file nobody wants any more.
    private var runningTasks = Set<ObjectIdentifier>()
    private let lock = NSLock()
    private let io = DispatchQueue(label: "conch.lagoon.files", qos: .userInitiated, attributes: .concurrent)
    /// Large enough that a 4.6 MB texture is two hops, small enough that a long video never sits in memory whole.
    private static let chunk = 2 << 20

    init(bundleRoot: URL, reviewTarget: @escaping @MainActor (String, String) -> URL?) {
        self.bundleRoot = bundleRoot
        self.reviewTarget = reviewTarget
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        MainActor.assumeIsolated { start(task) }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        finished(ObjectIdentifier(task))
    }

    private func isRunning(_ key: ObjectIdentifier) -> Bool { lock.withLock { runningTasks.contains(key) } }
    private func finished(_ key: ObjectIdentifier) { lock.withLock { _ = runningTasks.remove(key) } }

    @MainActor
    private func start(_ task: WKURLSchemeTask) {
        lock.withLock { _ = runningTasks.insert(ObjectIdentifier(task)) }
        guard let url = task.request.url else { return reply(task, URL(string: "\(Lagoon.scheme)://\(Lagoon.host)/")!, 400, "no address") }
        guard (task.request.httpMethod ?? "GET").uppercased() == "GET" else { return reply(task, url, 405, "read-only") }
        let range = task.request.value(forHTTPHeaderField: "Range")
        switch LagoonFiles.route(url) {
        case let .refused(why):
            reply(task, url, 403, why)
        case let .bundle(parts):
            guard let file = LagoonFiles.file(in: bundleRoot, parts) else { return reply(task, url, 404, "not in the lagoon") }
            serve(task, url, file, range: range, cache: true)
        case let .review(sessionId, reviewId, rest):
            guard let target = reviewTarget(sessionId, reviewId) else { return reply(task, url, 404, "not in the current snapshot") }
            switch LagoonFiles.review(target: target, rest: rest) {
            case let .refused(why):
                reply(task, url, 404, why)
            case let .file(file):
                serve(task, url, file, range: range, cache: false)
            case let .redirect(name):
                // WebKit doesn't follow a 3xx a scheme handler answers with (2026-10-04, macOS 26: fetch saw the 302
                // itself), and the public API has no redirect. A page is sent on to its own address, where its relative
                // links resolve beside it; anything else (an image, a video, a PDF on the glass) has no relative links to
                // resolve, and is served right here.
                let to = LagoonFiles.redirectURL(sessionId: sessionId, reviewId: reviewId, to: name)
                if ["html", "htm"].contains((name as NSString).pathExtension.lowercased()) {
                    reply(task, url, 200, Self.forwardingPage(to: to), type: "text/html; charset=utf-8")
                } else if case let .file(file) = LagoonFiles.review(target: target, rest: [name]) {
                    serve(task, url, file, range: range, cache: false)
                } else {
                    reply(task, url, 404, "not there")
                }
            }
        }
    }

    /// The stand-in for a redirect: a page that replaces itself with `to` at once (with no script, by the refresh).
    static func forwardingPage(to: String) -> String {
        let attribute = to.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
        let script = to.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'").replacingOccurrences(of: "<", with: "\\x3c")
        return "<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"0;url=\(attribute)\"><script>location.replace('\(script)')</script>"
    }

    @MainActor
    private func reply(_ task: WKURLSchemeTask, _ url: URL, _ status: Int, _ text: String, type: String = "text/plain; charset=utf-8") {
        guard isRunning(ObjectIdentifier(task)) else { return }
        let body = Data(text.utf8)
        task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": type, "Content-Length": String(body.count), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        ])!)
        task.didReceive(body)
        task.didFinish()
        finished(ObjectIdentifier(task))
    }

    /// The file, or the part of it the `Range` header asks for, read in chunks on `io` and handed over on the main thread.
    @MainActor
    private func serve(_ task: WKURLSchemeTask, _ url: URL, _ file: URL, range header: String?, cache: Bool) {
        let key = ObjectIdentifier(task)
        io.async { [weak self] in
            guard let handle = try? FileHandle(forReadingFrom: file),
                  let length = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue else {
                DispatchQueue.main.async { MainActor.assumeIsolated { self?.reply(task, url, 404, "unreadable") } }
                return
            }
            defer { try? handle.close() }
            var headers = [
                "Content-Type": Lagoon.mimeType(forPathExtension: file.pathExtension),
                "Accept-Ranges": "bytes",
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": cache ? "max-age=3600" : "no-store",
            ]
            let span: ClosedRange<Int>?
            let status: Int
            switch LagoonFiles.byteRange(header, length: length) {
            case .whole:
                span = length > 0 ? 0...(length - 1) : nil
                status = 200
            case let .part(part):
                span = part
                status = 206
                headers["Content-Range"] = "bytes \(part.lowerBound)-\(part.upperBound)/\(length)"
            case .unsatisfiable:
                headers["Content-Range"] = "bytes */\(length)"
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self?.respond(task, key, HTTPURLResponse(url: url, statusCode: 416, httpVersion: "HTTP/1.1", headerFields: headers)!, finish: true) }
                }
                return
            }
            headers["Content-Length"] = String(span?.count ?? 0)
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.respond(task, key, response, finish: span == nil) } }
            guard let span else { return }
            do {
                try handle.seek(toOffset: UInt64(span.lowerBound))
                var left = span.count
                // At most two chunks waiting for the main thread: a video asked for whole (`bytes=0-`) is read as WebKit
                // takes it, not all at once into memory.
                let inFlight = DispatchSemaphore(value: 2)
                while left > 0 {
                    inFlight.wait()
                    // Stopped (the page went, or WebKit has what it wanted of a video): read no more.
                    guard self?.isRunning(key) == true else { return }
                    let data = try handle.read(upToCount: min(Self.chunk, left)) ?? Data()
                    if data.isEmpty { inFlight.signal(); break }
                    left -= data.count
                    let last = left == 0
                    DispatchQueue.main.async {
                        defer { inFlight.signal() }
                        MainActor.assumeIsolated { self?.receive(task, key, data, finish: last) }
                    }
                }
                if left > 0 { DispatchQueue.main.async { MainActor.assumeIsolated { self?.fail(task, key) } } }
            } catch {
                DispatchQueue.main.async { MainActor.assumeIsolated { self?.fail(task, key) } }
            }
        }
    }

    @MainActor
    private func respond(_ task: WKURLSchemeTask, _ key: ObjectIdentifier, _ response: URLResponse, finish: Bool) {
        guard isRunning(key) else { return }
        task.didReceive(response)
        if finish {
            task.didFinish()
            finished(key)
        }
    }

    @MainActor
    private func receive(_ task: WKURLSchemeTask, _ key: ObjectIdentifier, _ data: Data, finish: Bool) {
        guard isRunning(key) else { return }
        task.didReceive(data)
        if finish {
            task.didFinish()
            finished(key)
        }
    }

    @MainActor
    private func fail(_ task: WKURLSchemeTask, _ key: ObjectIdentifier) {
        guard isRunning(key) else { return }
        task.didFailWithError(URLError(.cannotOpenFile))
        finished(key)
    }
}

/// The page's script handler, held weakly: `WKUserContentController` keeps what it is handed for as long as it lives, and
/// the host owns the web view that owns the controller, so handing it the host itself would keep both forever.
final class LagoonScriptProxy: NSObject, WKScriptMessageHandler {
    private weak var target: LagoonWebHost?

    init(_ target: LagoonWebHost) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { target?.received(message) }
    }
}

/// One lagoon page: its web view, made when first shown and let go after ten minutes unseen; when it is handed snapshots
/// (`LagoonPacer`); whether it draws (`setVisible`); and what it says (`LagoonIntent`), checked and routed.
@MainActor
final class LagoonWebHost: NSObject, WKNavigationDelegate, WKUIDelegate {
    struct Environment {
        /// The current state, as the lagoon may read it; nil before conch's first snapshot.
        var source: @MainActor () -> LagoonSnapshot.Source?
        /// The app's own link resolution (`LinkTarget.url(for:cwd:)`).
        var resolveLink: @MainActor (_ link: String, _ cwd: String?) -> URL
        /// Which intents act (`conch.lagoon.actions`); read when each message arrives, so a flag flips without a rebuild.
        var flags: @MainActor () -> LagoonActionFlags
        /// What `~` stands for in the paths sent.
        var home: String
        /// Told about every message, and every call into the page that failed: the app logs them.
        var report: @MainActor (Report) -> Void
    }

    enum Report {
        case refused(reason: String, body: String)
        case routed(LagoonIntent.Message, LagoonRouting)
        case callFailed(String)
        case loaded
        case dropped
    }

    let bundleRoot: URL
    private let environment: Environment
    /// Phase B and C's actions; with no flag on (phase A) nothing is ever handed to it.
    weak var sink: LagoonActionSink?
    private(set) var webView: WKWebView?
    /// The review pane's store by default (`DeliverableWebView`): a page signed in to there is signed in on the glass.
    var dataStore: WKWebsiteDataStore = .default()
    private var pacer = LagoonPacer<LagoonSnapshot>()
    private var gate = LagoonIntent.Gate()
    private var visibility = LagoonVisibility(pageCurrent: false, windowVisible: true, appHidden: false)
    private var liveness = "checking"
    private var tickTask: Task<Void, Never>?
    private var dropTask: Task<Void, Never>?
    /// For the harness: every snapshot handed to the page, in order.
    private(set) var sentCount = 0

    init(bundleRoot: URL, environment: Environment) {
        self.bundleRoot = bundleRoot
        self.environment = environment
    }

    var isReady: Bool { pacer.isReady }

    // MARK: The web view

    /// The page's web view, made and loaded if it was never made or has been let go.
    @discardableResult
    func attach() -> WKWebView {
        if let webView { return webView }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = dataStore
        config.setURLSchemeHandler(
            LagoonSchemeHandler(bundleRoot: bundleRoot) { [weak self] sessionId, reviewId in self?.reviewTarget(sessionId, reviewId) },
            forURLScheme: Lagoon.scheme
        )
        config.userContentController.add(LagoonScriptProxy(self), name: Lagoon.messageHandlerName)   // weak proxy: no retain cycle
        config.mediaTypesRequiringUserActionForPlayback = []   // a deliverable's silent video plays on the glass
        config.preferences.isElementFullscreenEnabled = false
        let web = WKWebView(frame: .zero, configuration: config)
        web.setValue(false, forKey: "drawsBackground")         // the page paints its own sand (#E9CFB0) from the first frame
        web.underPageBackgroundColor = NSColor(red: 0.914, green: 0.812, blue: 0.690, alpha: 1)
        web.allowsBackForwardNavigationGestures = false        // a two-finger swipe pans the beach
        web.allowsMagnification = false                        // a pinch zooms the world (Island ↔ Shore ↔ Underwater)
        #if DEBUG
        web.isInspectable = true
        #endif
        web.navigationDelegate = self
        web.uiDelegate = self
        webView = web
        web.load(URLRequest(url: Lagoon.pageURL(readOnly: environment.flags().pageReadOnly)))
        return web
    }

    /// Let the web view go, freeing its GPU memory: after ten minutes unseen, or when the lagoon is switched off. The next
    /// `attach` makes a new one, which says `ready` for itself.
    func drop() {
        tickTask?.cancel()
        tickTask = nil
        dropTask?.cancel()
        dropTask = nil
        guard let web = webView else { return }
        web.configuration.userContentController.removeScriptMessageHandler(forName: Lagoon.messageHandlerName)
        web.stopLoading()
        web.navigationDelegate = nil
        web.uiDelegate = nil
        web.removeFromSuperview()
        webView = nil
        pacer.pageGone()
        environment.report(.dropped)
    }

    // MARK: What the page is told

    /// The store's state changed: the newest snapshot, handed over when the pacer says.
    func offer(_ source: LagoonSnapshot.Source) {
        guard webView != nil, let ts = source.ts else { return }
        handle(pacer.offer(LagoonSnapshot(source, home: environment.home), ts: ts, now: Date()))
    }

    /// `store.liveness`, as the page names it: `alive`, `checking`, `stalled` or `dead`.
    func setLiveness(_ state: String) {
        guard state != liveness else { return }
        liveness = state
        if pacer.isReady { call("window.conchWorld.setLiveness(state)", ["state": state]) }
    }

    /// Whether the page can be seen. Unseen, it stops drawing altogether and is sent nothing; seen again, it is given the
    /// latest. Ten minutes unseen and its web view goes.
    func setVisibility(_ next: LagoonVisibility) {
        let was = visibility.visible
        visibility = next
        guard next.visible != was else { return }
        if pacer.isReady { call("window.conchWorld.setVisible(v)", ["v": next.visible]) }
        dropTask?.cancel()
        dropTask = nil
        if !next.visible, webView != nil {
            let since = Date()
            dropTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(LagoonVisibility.dropAfter * 1_000_000_000))
                guard let self, !Task.isCancelled, LagoonVisibility.shouldDrop(hiddenSince: since, now: Date()), !self.visibility.visible else { return }
                self.drop()
            }
        }
        handle(pacer.visible(next.visible, now: Date()))
    }

    /// The sidebar picked a session: the camera glides to its crab.
    func focus(_ sessionId: String) {
        guard pacer.isReady else { return }
        call("return window.conchWorld.focus(id)", ["id": sessionId])
    }

    /// Run `body` in the page, with `arguments` handed over as values (never spliced into the source).
    func call(_ body: String, _ arguments: [String: Any], done: ((Result<Any, Error>) -> Void)? = nil) {
        guard let webView else { return }
        webView.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { [weak self] result in
            if case let .failure(error) = result { self?.environment.report(.callFailed("\(body.prefix(60)): \(error.localizedDescription)")) }
            done?(result)
        }
    }

    private func handle(_ step: LagoonPacer<LagoonSnapshot>.Step) {
        switch step {
        case .none:
            break
        case let .send(snapshot):
            guard let object = try? snapshot.jsonObject() else { return }
            sentCount += 1
            call("return window.conchWorld.update(s)", ["s": object])
            // `update` lifts the "conch is offline" fog by itself; while conch is still down, it goes straight back.
            if liveness != "alive" { call("window.conchWorld.setLiveness(state)", ["state": liveness]) }
        case let .later(seconds):
            guard tickTask == nil else { return }
            tickTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
                guard let self, !Task.isCancelled else { return }
                self.tickTask = nil
                self.handle(self.pacer.tick(now: Date()))
            }
        }
    }

    // MARK: What the page says

    fileprivate func received(_ message: WKScriptMessage) {
        // Only the lagoon itself: a deliverable on its glass is a frame that can see `webkit.messageHandlers` too, and a web
        // page there must never speak for the lagoon.
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == Lagoon.scheme else {
            return environment.report(.refused(reason: "from a frame that isn't the lagoon's own", body: Self.describe(message.body)))
        }
        let sessions = environment.source()?.sessions ?? [:]
        switch gate.check(message.body, sessions: sessions, now: Date()) {
        case let .rejected(reason):
            environment.report(.refused(reason: reason, body: Self.describe(message.body)))
        case let .accepted(intent):
            let routing = LagoonIntentRouter.route(intent, flags: environment.flags(), sink: sink)
            environment.report(.routed(intent, routing))
            if routing == .ready { pageReady() }
        }
    }

    /// The page booted: tell it whether it can be seen, then the latest snapshot, then the daemon's liveness (after, since
    /// `update` lifts the fog).
    private func pageReady() {
        call("window.conchWorld.setVisible(v)", ["v": visibility.visible])
        if let source = environment.source(), let ts = source.ts {
            _ = pacer.offer(LagoonSnapshot(source, home: environment.home), ts: ts, now: Date())
        }
        handle(pacer.ready(now: Date()))
        call("window.conchWorld.setLiveness(state)", ["state": liveness])
    }

    /// A message for the log: short, and never more than a line.
    static func describe(_ body: Any) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .fragmentsAllowed])) ?? Data()
        let text = String(decoding: data, as: UTF8.self)
        return text.count > 300 ? String(text.prefix(299)) + "…" : text
    }

    private func reviewTarget(_ sessionId: String, _ reviewId: String) -> URL? {
        guard let source = environment.source(),
              let held = LagoonFiles.heldLink(sessionId: sessionId, reviewId: reviewId, in: source) else { return nil }
        return environment.resolveLink(held.link, held.cwd)
    }

    // MARK: Navigation (spec §3)

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let decision = Lagoon.navigation(to: action.request.url, mainFrame: action.targetFrame?.isMainFrame ?? true, newWindow: action.targetFrame == nil)
        if case let .refuse(why) = decision {
            environment.report(.refused(reason: "navigation: \(why)", body: action.request.url?.absoluteString ?? ""))
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        // Never a new window: in the app "Open ↗" is a message, not `window.open`.
        environment.report(.refused(reason: "navigation: the lagoon never opens a window", body: action.request.url?.absoluteString ?? ""))
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        environment.report(.loaded)
    }

    /// The page's process died (memory, a GPU reset): a new page, which says `ready` for itself.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        pacer.pageGone()
        webView.load(URLRequest(url: Lagoon.pageURL(readOnly: environment.flags().pageReadOnly)))
    }
}
