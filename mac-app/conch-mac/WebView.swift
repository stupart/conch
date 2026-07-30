import AppKit
import SwiftUI
import WebKit

struct DeliverableWebView: NSViewRepresentable {
    let link: String
    @Binding var isLoading: Bool

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: DeliverableWebView
        var loadedLink: String?
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
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.targetFrame == nil {
                webView.load(navigationAction.request)
            }
            return nil
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
        // background show through until the page renders, so the takeover has no
        // white flash.
        webView.setValue(false, forKey: "drawsBackground")
        context.coordinator.observeLoadingState(of: webView)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        guard context.coordinator.loadedLink != link else { return }
        context.coordinator.loadedLink = link
        load(link, in: webView)
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.stopObservingLoadingState()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.stopLoading()
    }

    private func load(_ link: String, in webView: WKWebView) {
        if let remoteURL = URL(string: link),
           let scheme = remoteURL.scheme?.lowercased(),
           scheme != "file" {
            webView.load(URLRequest(url: remoteURL))
            return
        }

        let fileURL: URL
        if let parsedURL = URL(string: link), parsedURL.isFileURL {
            fileURL = parsedURL.standardizedFileURL
        } else {
            let expanded = NSString(string: link).expandingTildeInPath
            fileURL = URL(
                fileURLWithPath: expanded,
                isDirectory: false
            ).standardizedFileURL
        }

        webView.loadFileURL(
            fileURL,
            allowingReadAccessTo: fileURL.deletingLastPathComponent()
        )
    }
}
