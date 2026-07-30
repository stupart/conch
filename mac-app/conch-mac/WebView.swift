import AppKit
import SwiftUI
import WebKit

struct DeliverableWebView: NSViewRepresentable {
    let link: String

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var loadedLink: String?

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
        Coordinator()
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
        webView.underPageBackgroundColor = NSColor(
            red: 0.035,
            green: 0.043,
            blue: 0.041,
            alpha: 1
        )
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.loadedLink != link else { return }
        context.coordinator.loadedLink = link
        load(link, in: webView)
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
