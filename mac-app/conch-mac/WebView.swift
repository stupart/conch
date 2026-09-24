import AppKit
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
            guard let destination = navigationAction.request.url else {
                refuseNavigation(
                    to: nil,
                    message: "The page requested a destination with no valid URL."
                )
                decisionHandler(.cancel)
                return
            }

            switch navigationPolicy(for: destination) {
            case .allow:
                decisionHandler(.allow)
            case let .refuse(message):
                refuseNavigation(to: destination, message: message)
                decisionHandler(.cancel)
            }
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.targetFrame == nil {
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

        private func navigationPolicy(for destination: URL) -> NavigationPolicy {
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
            default:
                return .refuse("The \(scheme) URL scheme is not allowed in the review.")
            }
        }

        private func refuseNavigation(to destination: URL?, message: String) {
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

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        webView.underPageBackgroundColor = NSColor(ConchPalette.bg)
        webView.wantsLayer = true
        webView.layer?.backgroundColor = NSColor(ConchPalette.bg).cgColor
        context.coordinator.observeLoadingState(of: webView)
        context.coordinator.observeCurrentURL(of: webView)
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
        coordinator.stopObservingLoadingState()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.stopLoading()
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
