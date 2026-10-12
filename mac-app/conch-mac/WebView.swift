import AppKit
import ConchDesign
import SwiftUI
import WebKit

struct DeliverableNavigationFailure: Equatable {
    let title: String
    let link: String
    let url: URL
    let message: String
    let canRetry: Bool
    let canOpenInBrowser: Bool
}

struct DeliverableWebView: NSViewRepresentable {
    let link: String
    let reloadID: UUID
    @Binding var isLoading: Bool
    /// Where the view actually IS, which stops being the surfaced link the moment you
    /// navigate. The bar above reads this: with navigation free, a bar derived from the link
    /// that was FILED would confidently name the wrong origin, which is worse than no bar.
    @Binding var currentLink: String?
    let onNavigationFailure: (DeliverableNavigationFailure) -> Void

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: DeliverableWebView
        var loadedLink: String?
        var loadedReloadID: UUID?
        var activeNavigation: WKNavigation?
        var loadingObservation: NSKeyValueObservation?
        var urlObservation: NSKeyValueObservation?
        var isObservingLoadingState = false
        var surfacedURL: URL?

        init(parent: DeliverableWebView) {
            self.parent = parent
        }

        deinit {
            loadingObservation?.invalidate()
            urlObservation?.invalidate()
        }

        /// The same KVO shape as the loading state beside it, for the same reason: WebKit is
        /// the only thing that knows where a page went, and a redirect or an in-page link
        /// moves it without anyone calling us.
        func observeCurrentURL(of webView: WKWebView) {
            urlObservation = webView.observe(\.url, options: [.initial, .new]) { view, _ in
                let here = view.url?.absoluteString
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.parent.currentLink != here else { return }
                    self.parent.currentLink = here
                }
            }
        }

        func observeLoadingState(of webView: WKWebView) {
            isObservingLoadingState = true
            loadingObservation = webView.observe(
                \.isLoading,
                options: [.initial, .new]
            ) { [weak self] _, change in
                let isLoading = change.newValue ?? false
                DispatchQueue.main.async { [weak self] in
                    guard let self,
                          self.isObservingLoadingState,
                          self.parent.isLoading != isLoading else {
                        return
                    }
                    self.parent.isLoading = isLoading
                }
            }
        }

        func stopObservingLoadingState() {
            isObservingLoadingState = false
            loadingObservation?.invalidate()
            loadingObservation = nil
            urlObservation?.invalidate()
            urlObservation = nil
            activeNavigation = nil
        }

        func webView(
            _ webView: WKWebView,
            didStartProvisionalNavigation navigation: WKNavigation?
        ) {
            activeNavigation = navigation
        }

        func webView(
            _ webView: WKWebView,
            didFinish navigation: WKNavigation?
        ) {
            if navigation == nil || navigation === activeNavigation {
                activeNavigation = nil
            }
            // A new page can come back at another pinch: said, so the control reads what shows.
            reportZoom(of: webView)
        }

        /// The page's zoom (`ContentZoom.page`), for the control: its page zoom times its pinch.
        weak var zoom: ZoomTarget?

        func reportZoom(of webView: WKWebView) {
            zoom?.report(ContentZoom.page.readout(DeliverableWebView.level(of: webView), resting: 1))
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation?,
            withError error: Error
        ) {
            reportNavigationFailure(error, navigation: navigation, in: webView)
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation?,
            withError error: Error
        ) {
            reportNavigationFailure(error, navigation: navigation, in: webView)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            // A frame INSIDE the page, not the page. Nil is a new window, which is folded into
            // this view below, so it is held to the page's rules.
            let inSubframe = navigationAction.targetFrame?.isMainFrame == false
            guard let destination = navigationAction.request.url else {
                refuseNavigation(
                    to: nil,
                    message: "The page requested a destination with no valid URL.",
                    inSubframe: inSubframe
                )
                decisionHandler(.cancel)
                return
            }

            switch navigationPolicy(for: destination, inSubframe: inSubframe) {
            case .allow:
                decisionHandler(.allow)
            case let .refuse(message):
                refuseNavigation(to: destination, message: message, inSubframe: inSubframe)
                decisionHandler(.cancel)
            }
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            // A window opened at about:blank has nothing in it yet: its opener means to write
            // into it, and gets nil back here, so loading it would only swap the page for a
            // blank one.
            if navigationAction.targetFrame == nil,
               navigationAction.request.url?.absoluteString != "about:blank" {
                activeNavigation = webView.load(navigationAction.request)
            }
            return nil
        }

        private func reportNavigationFailure(
            _ error: Error,
            navigation: WKNavigation?,
            in webView: WKWebView
        ) {
            let nsError = error as NSError
            guard nsError.domain != NSURLErrorDomain
                    || nsError.code != NSURLErrorCancelled else {
                return
            }
            guard navigation == nil || navigation === activeNavigation else {
                return
            }
            activeNavigation = nil

            let failingURL = nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL
            let failingLink =
                failingURL?.absoluteString
                ?? nsError.userInfo[NSURLErrorFailingURLStringErrorKey] as? String
                ?? webView.url?.absoluteString
                ?? parent.link

            parent.isLoading = false
            parent.onNavigationFailure(
                DeliverableNavigationFailure(
                    title: "Couldn’t load deliverable",
                    link: failingLink,
                    url: failingURL ?? DeliverableLink.url(for: failingLink),
                    message: error.localizedDescription,
                    canRetry: true,
                    canOpenInBrowser: true
                )
            )
        }

        private func navigationPolicy(for destination: URL, inSubframe: Bool) -> NavigationPolicy {
            guard let scheme = destination.scheme?.lowercased() else {
                return .refuse("Only HTTP, HTTPS, and the surfaced local file can be opened in the review.")
            }

            switch scheme {
            case "http", "https":
                // The pane browses rather than refuses (Tyler's call, 2026-09-20). The
                // boundary moves from ENFORCED to DISCLOSED: anywhere on the web is
                // reachable, and the bar above always says where you actually are. That is
                // only true because the bar reads the LIVE url — relaxing this without that
                // would leave it naming the filed link while you were somewhere else, which
                // is the failure the boundary existed to prevent, wearing a badge.
                return .allow
            // NOT relaxed with the web. Free navigation was asked for so the pane can browse;
            // reading arbitrary local files is a different power nobody asked for, and the
            // published file is still the only one this pane was handed.
            case "file":
                guard let surfacedURL,
                      surfacedURL.isFileURL,
                      destination.standardizedFileURL.path
                        == surfacedURL.standardizedFileURL.path else {
                    return .refuse("Local file navigation is limited to the exact file published for review.")
                }
                return .allow
            // A web app builds frames inside itself at about:blank and about:srcdoc: an empty
            // document, or markup the page wrote. Neither loads anything from anywhere. Refusing
            // them put "Link blocked · about:blank" over a Figma design and blanked the pane
            // (Tyler, 2026-09-25). Only those two: the rest of about: is the browser's own
            // pages, which nobody asked for.
            case "about" where ["about:blank", "about:srcdoc"].contains(destination.absoluteString.lowercased()):
                return .allow
            // The same thing spelled differently: a blob is bytes the page made, under the
            // page's own origin, and a data: frame gets an origin that can reach nothing. So in
            // a frame they add no power the page lacks, and Safari shows them there. NOT as the
            // page itself: the pane would then be showing a document no link ever named.
            // (A `where` binds to one pattern only, hence twice.)
            case "blob" where inSubframe, "data" where inSubframe:
                return .allow
            default:
                return .refuse("The \(scheme) URL scheme is not allowed in the review.")
            }
        }

        private func refuseNavigation(to destination: URL?, message: String, inSubframe: Bool) {
            // A frame inside the page is cancelled and nothing more. The card replaces the WHOLE
            // pane, so one refused frame took down a page that was otherwise fine — a page's
            // embedded frame must never do that. Logged, since nothing on screen says it.
            guard !inSubframe else {
                NSLog("conch: the review pane refused a frame inside the page: %@", message)
                return
            }
            parent.isLoading = false
            let link = destination?.absoluteString ?? parent.link
            parent.onNavigationFailure(
                DeliverableNavigationFailure(
                    title: "Link blocked",
                    link: link,
                    url: destination ?? DeliverableLink.url(for: parent.link),
                    message: message,
                    canRetry: false,
                    canOpenInBrowser: false
                )
            )
        }

        private enum NavigationPolicy {
            case allow
            case refuse(String)
        }

    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true

        let webView = DeliverableWKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        // A pinch magnifies as Safari's does, without reflowing; ⌘+, ⌘− and the control set the page zoom, which does.
        webView.allowsMagnification = true
        if let zoom = context.environment.conchZoomTarget {
            let coordinator = context.coordinator
            coordinator.zoom = zoom
            zoom.attach(webView) { [weak webView, weak coordinator] action in
                guard let webView else { return }
                Self.zoom(webView, action)
                coordinator?.reportZoom(of: webView)
            }
            webView.onMagnify = { [weak webView, weak coordinator, weak zoom] in
                guard let webView else { return }
                zoom?.touch()
                coordinator?.reportZoom(of: webView)
            }
            coordinator.reportZoom(of: webView)
        }
        webView.underPageBackgroundColor = NSColor(ConchPalette.bg)
        webView.wantsLayer = true
        webView.layer?.backgroundColor = NSColor(ConchPalette.bg).cgColor
        context.coordinator.observeLoadingState(of: webView)
        context.coordinator.observeCurrentURL(of: webView)
        // A review's page: its agent's marks are found in it (`AgentInkController`).
        if let item = context.environment.agentInkItem { AgentInkController.shared.appeared(webView, showing: item) }
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        guard context.coordinator.loadedLink != link
                || context.coordinator.loadedReloadID != reloadID else {
            return
        }
        context.coordinator.loadedLink = link
        context.coordinator.loadedReloadID = reloadID
        context.coordinator.surfacedURL = DeliverableLink.url(for: link)
        context.coordinator.activeNavigation = load(link, in: webView)
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        AgentInkController.shared.gone(webView)
        coordinator.stopObservingLoadingState()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.stopLoading()
    }

    /// Where a page is: at rest at 100% and no pinch; else its page zoom times its pinch.
    static func level(of webView: WKWebView) -> ZoomLevel {
        let atRest = abs(webView.pageZoom - 1) < 0.001 && abs(webView.magnification - 1) < 0.001
        return atRest ? .rest : .scale(webView.pageZoom * webView.magnification)
    }

    /// A key or the control: a step from what shows, pinch and all, as a page zoom with the pinch let go, so the page
    /// reflows to the pane at its new size rather than running off its edges.
    static func zoom(_ webView: WKWebView, _ action: ZoomAction) {
        guard let next = ContentZoom.page.level(after: action, from: level(of: webView), resting: 1) else { return }
        webView.magnification = 1
        webView.pageZoom = ContentZoom.page.clamped(next.scale(resting: 1), resting: 1)
    }

    private func load(_ link: String, in webView: WKWebView) -> WKNavigation? {
        let url = DeliverableLink.url(for: link)
        if !url.isFileURL {
            return webView.load(URLRequest(url: url))
        }

        // Every file it links to, as a browser opening the same page allows. Scoped to the page's
        // own folder, a page with `../scenes/shore-hero.png` showed broken images here and full
        // ones outside (Tyler, 2026-09-24: the brand session's characters page, 6 of 52 images).
        return webView.loadFileURL(
            url,
            allowingReadAccessTo: URL(fileURLWithPath: "/", isDirectory: true)
        )
    }
}

/// The review pane's web view, which says when a pinch has zoomed it: WebKit pinches by itself
/// (`allowsMagnification`), and tells no one.
final class DeliverableWKWebView: WKWebView {
    var onMagnify: () -> Void = {}

    override func magnify(with event: NSEvent) {
        super.magnify(with: event)
        onMagnify()
    }

    /// A two-finger double tap: WebKit animates it, so it is read again once it has landed.
    override func smartMagnify(with event: NSEvent) {
        super.smartMagnify(with: event)
        onMagnify()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.onMagnify() }
    }
}

private enum DeliverableLink {
    static func url(for link: String) -> URL {
        if let parsedURL = URL(string: link), parsedURL.scheme != nil {
            return parsedURL.isFileURL
                ? parsedURL.standardizedFileURL
                : parsedURL
        }

        let expanded = NSString(string: link).expandingTildeInPath
        return URL(
            fileURLWithPath: expanded,
            isDirectory: false
        ).standardizedFileURL
    }
}
