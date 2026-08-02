import AppKit
import SwiftUI
import WebKit

struct DeliverableNavigationFailure: Equatable {
    let link: String
    let url: URL
    let message: String
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
                    link: failingLink,
                    url: failingURL ?? DeliverableLink.url(for: failingLink),
                    message: error.localizedDescription
                )
            )
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
        // Don't paint the webview's own (white) background — let the dark app
        // background show through until the page renders, so the deliverable has
        // no white flash in either inline or expanded presentation.
        webView.setValue(false, forKey: "drawsBackground")
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
