import AppKit
import WebKit
// test/page-capture-render.test.ts compiles this file with ConchDesign's PageCapture.swift, AgentInk.swift and
// Canvas.swift beside it, as one module, and draws real pages with it.
#if canImport(ConchDesign)
import ConchDesign
#endif

/// `conch_capture`'s drawing (src/page-capture.ts is the daemon's half): a page drawn in a web view of conch's own, at
/// the size the agent asked, settled, its target scrolled to the middle, and captured with `takeSnapshot`, which needs no
/// Screen Recording. Tyler (2026-10-02, item 2): agents were driving Chrome to a section, waiting, re-scrolling after
/// the layout shifted, screenshotting and guessing the box by eye.
///
/// Its website data store is the default one, the same one the review pane's web view uses (WebView.swift makes its
/// web view with a plain `WKWebViewConfiguration`): a page the user signed in to inside conch's review pane is signed
/// in here too. It is not Safari's or Chrome's, and never could be.
///
/// The web view lives in a window of its own, borderless, transparent, off every screen, never key or main, and taking
/// no clicks. It has to be in a window at all: measured 2026-10-03 on macOS 26, a web view in no window, or in one
/// WebKit sees is covered, reports `visibilityState` "hidden" and runs no animation frames, so a page that builds
/// itself in frames never finishes, and the settling below has nothing to wait on. WebKit's window-occlusion check is
/// switched off for this view alone (`_setWindowOcclusionDetectionEnabled:`, guarded: without it the page is drawn
/// hidden, which still captures, less faithfully).
@MainActor
final class PageCapturer: NSObject, WKNavigationDelegate, WKUIDelegate {
    enum Target: Equatable, Sendable {
        case selector(String)
        case quote(String)

        var how: String { if case .selector = self { "selector" } else { "quote" } }
        var what: String {
            switch self {
            case let .selector(text), let .quote(text): text
            }
        }
    }

    struct Spec: Sendable {
        var url: URL
        var target: Target?
        /// CSS pixels; the view is this many points, at a page zoom of 1.
        var viewport: CGSize
        var fullPage: Bool
        var deadline: Date
    }

    /// A capture: the PNG, its size in pixels, and the target's box in them.
    struct Shot {
        var png: Data
        var width: Int
        var height: Int
        /// Pixels per CSS pixel in the picture.
        var scale: Double
        var element: CGRect?
        var finalURL: String
        var title: String
        var loginWall: Bool
        var clipped: Bool
        var settled: Bool
    }

    /// Why there's no capture, and what the view showed instead when conch could take a picture of it.
    struct Failure: Error {
        var message: String
        var seen: Shot?
        var headings: [String] = []
        var finalURL: String?
        var title: String?
        var loginWall = false
    }

    /// How long a page has to finish loading before it is drawn as it is: a page that never finishes (a long poll, a
    /// tracker that hangs) still has something to show.
    static let loadWait: TimeInterval = 20
    /// How long a target may take to appear once the page has loaded: an app that renders after its data arrives.
    static let findWait: TimeInterval = 6
    /// Where the window is parked: further off than any arrangement of displays reaches.
    static let parking = NSPoint(x: -30_000, y: -30_000)

    private let spec: Spec
    private let webView: WKWebView
    private let window: NSWindow
    /// conch's own content world: the page never sees what runs in it, and can't interfere with it.
    private let world = WKContentWorld.world(name: "conch-capture")
    private var loaded = false
    private var loadError: Error?
    /// The most recent `Settle` gave up rather than settled.
    private var unsettled = false

    /// Draw `spec` and capture it, by its deadline whatever the page does: a page that hangs its own web process never
    /// answers a script again, so the deadline is kept here, outside the drawing, and the window goes either way.
    static func capture(_ spec: Spec, store: WKWebsiteDataStore = .default()) async -> Result<Shot, Failure> {
        let capturer = PageCapturer(spec: spec, store: store)
        let once = Once()
        let result: Result<Shot, Failure> = await withCheckedContinuation { continuation in
            let finish: @MainActor (Result<Shot, Failure>) -> Void = { result in
                if once.take() { continuation.resume(returning: result) }
            }
            let drawing = Task { @MainActor in
                do {
                    finish(.success(try await capturer.run()))
                } catch let failure as Failure {
                    finish(.failure(failure))
                } catch {
                    finish(.failure(Failure(message: error.localizedDescription)))
                }
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64((max(0, spec.deadline.timeIntervalSinceNow) + 1) * 1_000_000_000))
                drawing.cancel()
                finish(.failure(Failure(message: "the page didn't finish drawing before conch's deadline")))
            }
        }
        capturer.close()
        return result
    }

    /// True the first time it is asked, and never again.
    @MainActor
    private final class Once {
        private var taken = false
        func take() -> Bool {
            defer { taken = true }
            return !taken
        }
    }

    private init(spec: Spec, store: WKWebsiteDataStore) {
        self.spec = spec
        let configuration = WKWebViewConfiguration()
        // The review pane's store (see above), and the review pane's JavaScript.
        configuration.websiteDataStore = store
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        // Nothing plays sound from a page nobody is looking at.
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        webView = WKWebView(frame: CGRect(origin: .zero, size: spec.viewport), configuration: configuration)
        let window = PageCaptureWindow(contentRect: NSRect(origin: Self.parking, size: spec.viewport), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.hasShadow = false
        window.isExcludedFromWindowsMenu = true
        window.collectionBehavior = [.transient, .ignoresCycle, .stationary]
        window.animationBehavior = .none
        self.window = window
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.contentView = webView
        let occlusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        if webView.responds(to: occlusion) {
            typealias Setter = @convention(c) (NSObject, Selector, Bool) -> Void
            unsafeBitCast(webView.method(for: occlusion), to: Setter.self)(webView, occlusion, false)
        }
        // In, without bringing conch forward or taking a key: off every screen, it is seen by WebKit alone.
        window.orderFrontRegardless()
    }

    private func close() {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        window.orderOut(nil)
        window.contentView = nil
        window.close()
    }

    // MARK: Drawing

    private func run() async throws -> Shot {
        if spec.url.isFileURL {
            // Every file the page links to, as the review pane allows (WebView.swift `load`).
            webView.loadFileURL(spec.url, allowingReadAccessTo: URL(fileURLWithPath: "/", isDirectory: true))
        } else {
            webView.load(URLRequest(url: spec.url))
        }
        try await waitForLoad()
        try await waitForFonts()
        if spec.fullPage { return try await captureFullPage() }
        guard let target = spec.target else {
            _ = try await settle(nil, near: 0.5)
            return try await shoot(PageCapture.crop(target: nil, viewport: spec.viewport)!, target: nil)
        }
        var rect = try await find(target)
        for attempt in 0..<3 {
            let alignment = PageCapture.alignment(target: rect.size, viewport: spec.viewport)
            if attempt == 0 {
                _ = try await call(Self.scroll, ["how": target.how, "what": target.what, "block": alignment.rawValue])
            } else {
                // Moved off by a late layout shift: back by what it is off. (The first scroll handles a scrolling box
                // inside the page; this one the page.)
                let goal = alignment == .center ? (spec.viewport.height - rect.height) / 2 : PageCapture.padding
                _ = try await call("window.scrollBy(0, dy); return true;", ["dy": Double(rect.minY - goal)])
            }
            guard let settled = try await settle(target, near: 0.5).target else { throw try await notFound(target) }
            rect = settled
            if PageCapture.isPlaced(rect, viewport: spec.viewport) { break }
        }
        guard let crop = PageCapture.crop(target: rect, viewport: spec.viewport) else {
            throw try await failure("the target is on the page but conch couldn't bring it into view")
        }
        return try await shoot(crop, target: rect)
    }

    /// The whole page: every lazy image down it asked for, a view at a time, then the view made as tall as the page and
    /// captured whole. WebKit draws only what its view holds (measured 2026-10-03: a snapshot rect below the view comes
    /// back white), so a taller view is the only way down the page.
    private func captureFullPage() async throws -> Shot {
        let first = try await probe(nil, near: -1)
        let steps = min(Int((first.scrollHeight / spec.viewport.height).rounded(.up)), 24)
        if steps > 1 {
            for step in 1..<steps {
                _ = try await call("window.scrollTo(0, y); return true;", ["y": Double(step) * Double(spec.viewport.height)])
                try await pause(0.12)
            }
        }
        _ = try await call("window.scrollTo(0, 0); return true;", [:])
        var height = PageCapture.fullPageHeight(scrollHeight: first.scrollHeight, viewport: spec.viewport)
        // Twice at most: a page whose sections are sized to the window grows when the window does.
        for _ in 0..<2 {
            resize(height: height)
            let sample = try await settle(spec.target, near: -1)
            let next = PageCapture.fullPageHeight(scrollHeight: sample.scrollHeight, viewport: spec.viewport)
            if abs(next - height) < 1 { break }
            height = next
        }
        let size = CGSize(width: spec.viewport.width, height: height)
        var rect: CGRect?
        if let target = spec.target {
            rect = await locate(target)
            if rect == nil { throw try await notFound(target) }
        }
        let crop = PageCapture.Crop(rect: CGRect(origin: .zero, size: size), clipped: rect.map { $0.maxY > height + 0.5 } ?? false)
        return try await shoot(crop, target: rect)
    }

    private func resize(height: CGFloat) {
        let size = CGSize(width: spec.viewport.width, height: height)
        window.setContentSize(size)
        webView.frame = CGRect(origin: .zero, size: size)
    }

    /// The picture of `crop`, and what goes with it.
    private func shoot(_ crop: PageCapture.Crop, target: CGRect?) async throws -> Shot {
        let image = try await snapshot(crop.rect)
        // Through ImageIO, as the canvas writes its pictures: the snapshot comes back sRGB, and stays so.
        guard let png = CanvasInk.png(image) else {
            throw Failure(message: "the capture couldn't be written as a PNG")
        }
        let scale = Double(image.width) / Double(crop.rect.width)
        let signals = await self.signals(nil)
        return Shot(
            png: png,
            width: image.width,
            height: image.height,
            scale: scale,
            element: target.flatMap { PageCapture.box(target: $0, crop: crop.rect, scale: CGFloat(scale)) },
            finalURL: signals.url,
            title: signals.title,
            loginWall: signals.loginWall,
            clipped: crop.clipped,
            settled: !unsettled
        )
    }

    private func snapshot(_ rect: CGRect) async throws -> CGImage {
        let configuration = WKSnapshotConfiguration()
        configuration.rect = rect
        configuration.afterScreenUpdates = true
        if let width = PageCapture.snapshotWidth(for: rect.size, scale: window.backingScaleFactor) {
            configuration.snapshotWidth = NSNumber(value: Double(width))
        }
        let image: NSImage = try await withCheckedThrowingContinuation { continuation in
            webView.takeSnapshot(with: configuration) { image, error in
                if let image { continuation.resume(returning: image) }
                else { continuation.resume(throwing: Failure(message: "the page couldn't be drawn: \(error?.localizedDescription ?? "no picture came back")")) }
            }
        }
        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw Failure(message: "the page couldn't be drawn")
        }
        return cgImage
    }

    // MARK: Waiting

    private func checkDeadline() throws {
        if Date() >= spec.deadline {
            throw Failure(message: "the page didn't finish drawing before conch's deadline")
        }
    }

    private func pause(_ seconds: TimeInterval) async throws {
        try checkDeadline()
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    private func waitForLoad() async throws {
        let start = Date()
        while !loaded {
            if let loadError { throw Failure(message: "the page didn't load: \(loadError.localizedDescription)") }
            // Drawn as it is past `loadWait`, as long as there is a document at all.
            if Date().timeIntervalSince(start) > Self.loadWait {
                let state = try? await call("return document.readyState;", [:]) as? String
                if state == "interactive" || state == "complete" { return }
                throw Failure(message: "the page didn't load in \(Int(Self.loadWait)) s")
            }
            try await pause(0.05)
        }
    }

    /// Web fonts: a font that swaps in late moves every line under it.
    private func waitForFonts() async throws {
        try checkDeadline()
        _ = try? await call("if (document.fonts) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]); return true;", [:])
    }

    /// Look until the page has settled (`PageCapture.Settle`), and the last look. `near`: how many views beyond the view
    /// an image still counts as near (-1: anywhere on the page).
    private func settle(_ target: Target?, near: Double) async throws -> PageCapture.Sample {
        var settle = PageCapture.Settle()
        let start = Date()
        while true {
            let sample = try await probe(target, near: near, elapsed: Date().timeIntervalSince(start))
            switch settle.observe(sample) {
            case .wait: continue
            case .settled:
                unsettled = false
                return sample
            case .gaveUp:
                unsettled = true
                return sample
            }
        }
    }

    /// The target once it is there: an app that draws itself after its data arrives gets `findWait` to draw it.
    private func find(_ target: Target) async throws -> CGRect {
        let start = Date()
        while true {
            if let rect = await locate(target) { return rect }
            if Date().timeIntervalSince(start) > Self.findWait { throw try await notFound(target) }
            try await pause(0.1)
        }
    }

    // MARK: The page

    /// One look, a frame after the last (`probeScript`), with the target found the way agent ink finds one.
    private func probe(_ target: Target?, near: Double, elapsed: TimeInterval = 0) async throws -> PageCapture.Sample {
        try checkDeadline()
        // A page that navigates on after it loaded (a sign-in redirect, a client-side route) loses the script's context
        // mid-call: that look is a page still loading, and the wait goes on, rather than the capture failing.
        let state = (try? await call(Self.probeScript, ["near": near])) as? [String: Any] ?? [:]
        return PageCapture.Sample(
            readyState: state["readyState"] as? String ?? "loading",
            fontsLoaded: state["fonts"] as? Bool ?? true,
            pendingImages: (state["pending"] as? NSNumber)?.intValue ?? 0,
            target: target == nil ? nil : await locate(target!),
            scrollHeight: CGFloat((state["scrollHeight"] as? NSNumber)?.doubleValue ?? 0),
            elapsed: elapsed
        )
    }

    /// Where the target is in the view, in CSS pixels, by the one script both apps find a selector or a quote with
    /// (`AgentInk.finder`); nil when it isn't on the page, or has no size.
    private func locate(_ target: Target) async -> CGRect? {
        let answer = (try? await call(AgentInk.finder, ["marks": [["target", target.how, target.what]]])) as? [String: Any]
        guard let found = answer?["found"] as? [String: [Double]], let xywh = found["target"], xywh.count == 4 else { return nil }
        return CGRect(x: xywh[0], y: xywh[1], width: xywh[2], height: xywh[3])
    }

    private struct Signals {
        var url: String
        var title: String
        var loginWall: Bool
        var headings: [String]
        var selectorValid: Bool
        /// How many elements a selector matches, drawn or not.
        var matches: Int
        /// The words a quote names as the page has them, when they are there in another case or spacing.
        var nearly: String?
    }

    private func signals(_ target: Target?) async -> Signals {
        let page = (try? await call(Self.signalsScript, ["how": target?.how ?? "", "what": target?.what ?? ""])) as? [String: Any] ?? [:]
        let url = webView.url?.absoluteString ?? (page["href"] as? String) ?? spec.url.absoluteString
        let title = webView.title ?? (page["title"] as? String) ?? ""
        let wall = PageCapture.loginWall(PageCapture.PageSignals(
            url: webView.url,
            title: title,
            passwordFields: (page["passwords"] as? NSNumber)?.intValue ?? 0,
            signInWords: page["says"] as? Bool ?? false
        ))
        return Signals(
            url: url, title: title, loginWall: wall, headings: page["headings"] as? [String] ?? [],
            selectorValid: page["selectorValid"] as? Bool ?? true, matches: (page["matches"] as? NSNumber)?.intValue ?? 0,
            nearly: page["nearly"] as? String
        )
    }

    /// The target wasn't there: said with what was, and a picture of the view.
    private func notFound(_ target: Target) async throws -> Failure {
        let page = await signals(target)
        let missing: String
        switch target {
        case let .selector(selector):
            missing = !page.selectorValid ? "the selector \"\(selector)\" isn't valid CSS"
                : page.matches == 0 ? "nothing on the page matches the selector \"\(selector)\""
                : "the selector \"\(selector)\" matches \(page.matches == 1 ? "an element" : "\(page.matches) elements"), none of them drawn (hidden, or with no size)"
        case let .quote(quote):
            missing = page.nearly.map { "the words \"\(quote)\" aren't on the page as written; it has \"\($0)\"" }
                ?? "the words \"\(quote)\" aren't visible on the page"
        }
        return try await failure(missing, page: page)
    }

    private func failure(_ message: String, page known: Signals? = nil) async throws -> Failure {
        let page: Signals = if let known { known } else { await signals(nil) }
        var seen: Shot?
        if let crop = PageCapture.crop(target: nil, viewport: webView.bounds.size), let image = try? await snapshot(crop.rect),
           let png = CanvasInk.png(image) {
            seen = Shot(png: png, width: image.width, height: image.height, scale: Double(image.width) / Double(crop.rect.width), element: nil,
                        finalURL: page.url, title: page.title, loginWall: page.loginWall, clipped: false, settled: true)
        }
        return Failure(message: message, seen: seen, headings: page.headings, finalURL: page.url, title: page.title, loginWall: page.loginWall)
    }

    private func call(_ script: String, _ arguments: [String: Any]) async throws -> Any? {
        try checkDeadline()
        return try await webView.callAsyncJavaScript(script, arguments: arguments, in: nil, contentWorld: world)
    }

    /// One look a frame after the last: a frame, or a tenth of a second if frames don't come (a page drawn hidden).
    /// Images in or near the view (`near` views beyond it; -1, anywhere) not yet complete; the document's height.
    static let probeScript = """
        await new Promise((resolve) => { let done = false; const go = () => { if (!done) { done = true; resolve(); } }; requestAnimationFrame(go); setTimeout(go, 100); });
        const W = window.innerWidth, H = window.innerHeight;
        let pending = 0;
        for (const image of document.images) {
            if (image.complete) continue;
            const r = image.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            if (near < 0 || (r.bottom > -H * near && r.top < H * (1 + near) && r.right > -W * near && r.left < W * (1 + near))) pending++;
        }
        const body = document.body;
        return {
            readyState: document.readyState,
            fonts: document.fonts ? document.fonts.status === "loaded" : true,
            pending,
            scrollHeight: Math.max(document.documentElement.scrollHeight, body ? body.scrollHeight : 0),
        };
        """

    /// Bring the target into view: a selector's element, or the element a quote's words start in, scrolled to `block`
    /// by `scrollIntoView`, which also scrolls a scrolling box inside the page. The quote is looked for as `AgentInk.finder`
    /// looks for it: the first place its words are visible.
    static let scroll = """
        let node = null;
        if (how === "selector") { try { node = document.querySelector(what); } catch (_) {} }
        else {
            const root = document.body || document.documentElement;
            const hidden = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode: (n) => hidden.test(n.parentNode ? n.parentNode.nodeName : "") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
            });
            const nodes = [];
            let text = "";
            for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push([n, text.length]); text += n.data; }
            for (let from = text.indexOf(what), tries = 0; from >= 0 && tries < 20 && !node; from = text.indexOf(what, from + 1), tries++) {
                let i = nodes.length - 1;
                while (i > 0 && nodes[i][1] > from) i--;
                const element = nodes[i][0].parentElement;
                if (element && element.getClientRects().length) node = element;
            }
        }
        if (!node) return false;
        node.scrollIntoView({ block, inline: "nearest", behavior: "instant" });
        return true;
        """

    /// What the page says about itself: where it ended up, its title and headings, visible password fields, whether a
    /// visible heading, button or label says sign in, and whether a selector is valid CSS at all.
    static let signalsScript = """
        const visible = (element) => {
            const r = element.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            const style = getComputedStyle(element);
            return style.visibility !== "hidden" && style.display !== "none";
        };
        const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible).length;
        const words = /\\b(sign ?in|log ?in|sign on|continue with (google|github|gitlab|apple|microsoft|email|sso)|single sign-on)\\b/i;
        const says = [...document.querySelectorAll('h1, h2, button, [role="button"], input[type="submit"], label')]
            .slice(0, 400).filter(visible).some((element) => words.test(String(element.innerText || element.value || "").slice(0, 200)));
        const headings = [...document.querySelectorAll("h1, h2, h3")].filter(visible)
            .map((heading) => String(heading.innerText || "").replace(/\\s+/g, " ").trim()).filter(Boolean).slice(0, 8)
            .map((text) => text.slice(0, 80));
        let selectorValid = true, matches = 0, nearly = null;
        if (how === "selector") { try { matches = document.querySelectorAll(what).length; } catch (_) { selectorValid = false; } }
        if (how === "quote") {
            // The words in another case or spacing: what an agent misremembering a heading most often got wrong.
            const fold = (text) => text.replace(/\\s+/g, " ").trim().toLowerCase();
            const page = String((document.body && document.body.innerText) || "").replace(/\\s+/g, " ");
            const at = page.toLowerCase().indexOf(fold(what));
            if (at >= 0 && fold(what)) nearly = page.slice(at, at + fold(what).length).slice(0, 120);
        }
        return { href: location.href, title: document.title, passwords, says, headings, selectorValid, matches, nearly };
        """

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        record(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        record(error)
    }

    private func record(_ error: Error) {
        // A navigation the page itself replaced (a client redirect) is cancelled, not failed.
        if (error as NSError).domain == NSURLErrorDomain, (error as NSError).code == NSURLErrorCancelled { return }
        loadError = error
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        // A download isn't a page: said, rather than captured blank.
        if navigationResponse.isForMainFrame, !navigationResponse.canShowMIMEType {
            loadError = Failure(message: "it isn't a page conch can draw (\(navigationResponse.response.mimeType ?? "unknown type"))")
            return .cancel
        }
        return .allow
    }

    // MARK: WKUIDelegate

    /// A page opening a window opens nothing: there is no one to see it.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil
    }
}

extension PageCapturer.Failure: LocalizedError {
    var errorDescription: String? { message }
}

/// The capture's window: never key, never main, so nothing that looks for conch's windows (a Dock click's reopen, a
/// window list) ever takes it for one of them.
final class PageCaptureWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
