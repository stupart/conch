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
    let onNavigationFailure: (DeliverableNavigationFailure) -> Void

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: DeliverableWebView
        var loadedLink: String?
        var loadedReloadID: UUID?
        var activeNavigation: WKNavigation?
        var loadingObservation: NSKeyValueObservation?
        var isObservingLoadingState = false
        var surfacedURL: URL?

        init(parent: DeliverableWebView) {
            self.parent = parent
        }

        deinit {
            loadingObservation?.invalidate()
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

            switch navigationPolicy(
                for: destination,
                isTopLevel: navigationAction.targetFrame?.isMainFrame != false
            ) {
            case .allow:
                decisionHandler(.allow)
            case .openExternally:
                offerExternalNavigation(to: destination)
                decisionHandler(.cancel)
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

        private func navigationPolicy(
            for destination: URL,
            isTopLevel: Bool
        ) -> NavigationPolicy {
            guard let scheme = destination.scheme?.lowercased() else {
                return .refuse("Only HTTP, HTTPS, and the surfaced local file can be opened in the review.")
            }

            switch scheme {
            case "http", "https":
                guard isTopLevel else { return .allow }
                guard let surfacedURL,
                      let surfacedOrigin = WebOrigin(url: surfacedURL),
                      let destinationOrigin = WebOrigin(url: destination) else {
                    return .refuse("The destination does not have a valid web origin.")
                }
                guard surfacedOrigin == destinationOrigin else {
                    return .openExternally
                }
                return .allow
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

        private func offerExternalNavigation(to destination: URL) {
            parent.isLoading = false
            parent.onNavigationFailure(
                DeliverableNavigationFailure(
                    title: "Open link in browser?",
                    link: destination.absoluteString,
                    url: destination,
                    message: "This link leaves the review’s original website, so it wasn’t opened inside Conch.",
                    canRetry: false,
                    canOpenInBrowser: true
                )
            )
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
            case openExternally
            case refuse(String)
        }

        private struct WebOrigin: Equatable {
            let scheme: String
            let host: String
            let port: Int

            init?(url: URL) {
                guard let scheme = url.scheme?.lowercased(),
                      scheme == "http" || scheme == "https",
                      let host = url.host?.lowercased() else {
                    return nil
                }
                self.scheme = scheme
                self.host = host
                port = url.port ?? (scheme == "https" ? 443 : 80)
            }
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

        return webView.loadFileURL(
            url,
            allowingReadAccessTo: url.deletingLastPathComponent()
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
