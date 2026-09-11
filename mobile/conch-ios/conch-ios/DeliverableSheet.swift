import PDFKit
import AVKit
import SwiftUI
import WebKit

/// Every deliverable type the Mac renders, rendered here too — same coverage
/// promise. Web loads directly; local files arrive through the bridge's
/// scoped /file endpoint, which serves only what the dashboard is showing.
struct DeliverableSheet: View {
    @ObservedObject var bridge: BridgeClient
    let review: PublishedState.Row.Review
    /// The session the deliverable belongs to; what a failure is filed under.
    let sessionId: String
    @Environment(\.dismiss) private var dismiss
    @State private var localURL: URL?
    /// Why the deliverable would not arrive or render, with its path on the
    /// Mac — said in the sheet instead of a blank one (A13).
    @State private var failure: String?
    /// A link tapped inside a rendered document that could not be opened.
    @State private var linkFailure: String?

    private enum LocalKind { case image, video, pdf, markdown, page, text, unsupported }
    private enum Kind {
        case web(URL)
        case local(LocalKind)
        case unavailable(String)
    }

    private var kind: Kind {
        guard let link = review.link else { return .unavailable("No link on this review.") }
        if let url = URL(string: link),
           let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            return .web(url)
        }
        // Kept in step with the Mac's router in ReviewView.swift. They had
        // DRIFTED: a local .html rendered as a page there and as raw markup
        // here, and anything unrecognised — a video, a zip, an .app — was
        // printed as text, which for a binary means pages of bytes.
        switch (link as NSString).pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "svg":
            return .local(.image)
        case "mp4", "mov", "m4v", "webm":
            return .local(.video)
        case "pdf":
            return .local(.pdf)
        case "md", "markdown":
            return .local(.markdown)
        case "html", "htm", "svgz":
            return .local(.page)
        case "txt", "log", "json", "yaml", "yml", "toml", "csv", "diff", "patch",
             "swift", "ts", "js", "tsx", "jsx", "py", "rb", "go", "rs", "sh", "css":
            return .local(.text)
        default:
            // Honest about what it cannot show, rather than rendering bytes.
            return .local(.unsupported)
        }
    }

    var body: some View {
        NavigationStack {
            content
                .overlay { if let failure { unavailableView(failure).background(Palette.bg) } }
                .overlay(alignment: .bottom) { LinkFailureLine(message: $linkFailure).padding(12) }
                // A link in a rendered .md behaves as it does in the
                // conversation: a web page opens, a path says it is on the Mac.
                .environment(\.openURL, OpenURLAction { url in
                    linkFailure = nil
                    bridge.openLink(url, sessionId: sessionId) { linkFailure = $0 }
                    return .handled
                })
                .background(Palette.bg)
                .navigationTitle(review.summary)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .preferredColorScheme(.dark)
        .task(id: review.link) {
            localURL = nil
            failure = nil
            linkFailure = nil
            guard case .local = kind, let link = review.link else { return }
            let downloaded = await bridge.downloadFile(path: link)
            if Task.isCancelled {
                if let downloaded { try? FileManager.default.removeItem(at: downloaded) }
                return
            }
            localURL = downloaded
            // The bridge's own reason, read on the main actor straight after
            // the call that set it; "couldn't be fetched" alone said nothing.
            if downloaded == nil {
                fail("Couldn't fetch this from your Mac: \(bridge.lastError ?? "it sent nothing back.")")
            }
        }
        .onDisappear {
            if let localURL { try? FileManager.default.removeItem(at: localURL) }
            localURL = nil
        }
    }

    @ViewBuilder
    private var content: some View {
        switch kind {
        case let .web(url):
            BridgedWebView(url: url, onFailure: fail)
        case let .local(localKind):
            if let url = localURL {
                localContent(localKind, url: url)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        case let .unavailable(reason):
            unavailableView(reason)
        }
    }

    @ViewBuilder
    private func localContent(_ kind: LocalKind, url: URL) -> some View {
        switch kind {
        case .image:
            // Fit to WIDTH, scroll vertically, start at the top. Two-axis
            // panning at native pixel scale made a tall screenshot — the single
            // most likely deliverable — unreadable.
            ScrollView(.vertical) {
                LocalImageView(url: url)
            }
        case .video:
            // A real player. Routed to `.text` before, which meant a video
            // deliverable rendered as pages of bytes.
            //
            // Playback is deliberate, so Manual does not alter it. Manual owns
            // only what conch does by itself: automatic reading and mic opening.
            VideoPlayer(player: AVPlayer(url: url))
                .background(Palette.bg)
        case .pdf:
            BridgedPDFView(url: url, onFailure: fail)
        case .markdown:
            RemoteDocumentView(url: url, renderMarkdown: true, onFailure: fail)
        case .page:
            // A local .html is a PAGE. The Mac has always rendered it as one;
            // here it was raw markup, so the same deliverable looked finished
            // on one surface and broken on the other.
            // loadFileURL, not load(URLRequest:) — a file:// page needs read
            // access granted to its own directory or its assets never load.
            LocalPageView(url: url, onFailure: fail)
        case .text:
            RemoteDocumentView(url: url, renderMarkdown: false, onFailure: fail)
        case .unsupported:
            unavailableView(
                "conch can't preview a \(url.pathExtension.uppercased()) yet — "
                + "it's on the Mac at \(url.lastPathComponent)."
            )
        }
    }

    /// Said in the sheet with the path on the Mac — the one a person can go
    /// and look at — and filed on the Mac as `open-deliverable` (A13).
    private func fail(_ reason: String) {
        let message = "\(reason) — \(review.link ?? "")"
        failure = message
        Task { await bridge.reportAppError(operation: "open-deliverable", message: message, sessionId: sessionId) }
    }

    private func unavailableView(_ reason: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "questionmark.folder")
                .font(.system(size: 22))
                .foregroundStyle(Palette.textDim)
            Text(reason)
                .font(Type.summary)
                .foregroundStyle(Palette.textDim)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }
}

/// Markdown and text deliverables, fetched then rendered natively.
private struct RemoteDocumentView: View {
    let url: URL
    let renderMarkdown: Bool
    let onFailure: (String) -> Void
    @State private var content: String?

    var body: some View {
        Group {
            if let content {
                ScrollView {
                    Group {
                        if renderMarkdown {
                            MarkdownView(text: content)
                        } else {
                            // Logs and tables keep their columns: wrap breaks
                            // "712 pass, 0 fail" across lines.
                            ScrollView(.horizontal, showsIndicators: false) {
                                Text(content)
                                    .font(Type.mono)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .foregroundStyle(Palette.textPrimary)
                    .padding(20)
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            do {
                let data: Data
                if url.isFileURL {
                    data = try Data(contentsOf: url)
                } else {
                    data = try await URLSession.shared.data(from: url).0
                }
                content = String(decoding: data, as: UTF8.self)
            } catch {
                // The OS's words, not a generic line that hid them (A13).
                onFailure(error.localizedDescription)
            }
        }
    }
}

private struct BridgedWebView: UIViewRepresentable {
    let url: URL
    let onFailure: (String) -> Void

    func makeCoordinator() -> PageLoadFailure { PageLoadFailure() }

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView()
        view.isOpaque = false
        view.backgroundColor = UIColor(Palette.bg)
        view.navigationDelegate = context.coordinator
        context.coordinator.onFailure = onFailure
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}

/// A local HTML page, with read access to its own folder.
///
/// WKWebView will not fetch a page's sibling assets — its CSS, its images —
/// from a file:// URL unless it is granted the containing directory, so a page
/// loaded the ordinary way renders unstyled and looks broken.
private struct LocalPageView: UIViewRepresentable {
    let url: URL
    let onFailure: (String) -> Void

    func makeCoordinator() -> PageLoadFailure { PageLoadFailure() }

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView()
        view.isOpaque = false
        view.backgroundColor = UIColor(Palette.bg)
        view.navigationDelegate = context.coordinator
        context.coordinator.onFailure = onFailure
        view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}

private struct BridgedPDFView: UIViewRepresentable {
    let url: URL
    let onFailure: (String) -> Void

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.backgroundColor = UIColor(Palette.bg)
        Task {
            let document: PDFDocument?
            if url.isFileURL {
                document = PDFDocument(url: url)
            } else if let data = try? await URLSession.shared.data(from: url).0 {
                document = PDFDocument(data: data)
            } else {
                document = nil
            }
            if let document {
                await MainActor.run {
                    view.document = document
                    // Scale and position are computed against an EMPTY document
                    // otherwise, which opened with a dead gap above the page.
                    view.autoScales = true
                    if let first = view.document?.page(at: 0) {
                        view.go(to: PDFDestination(page: first, at: CGPoint(x: 0, y: first.bounds(for: .mediaBox).height)))
                    }
                }
            } else {
                // PDFKit answers nil, never why. Foundation's wording for
                // bytes a reader refused, instead of a blank sheet (A13).
                await MainActor.run { onFailure(CocoaError(.fileReadCorruptFile).localizedDescription) }
            }
        }
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {}
}

/// A page that will not load says why instead of staying blank (A13).
private final class PageLoadFailure: NSObject, WKNavigationDelegate {
    var onFailure: (String) -> Void = { _ in }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        report(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        report(error)
    }

    private func report(_ error: Error) {
        // A newer load cancelling the last one is not a failure.
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        onFailure(error.localizedDescription)
    }
}

/// A link that would not open, said where it was tapped (A13) — in the
/// conversation and in a rendered deliverable alike. Selectable, so the
/// path can be copied; dismissable, so it does not outstay its use.
struct LinkFailureLine: View {
    @Binding var message: String?

    var body: some View {
        if let message {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(Type.caption)
                    .foregroundStyle(Palette.needs)
                    .accessibilityHidden(true)
                Text(message)
                    .font(Type.caption)
                    .foregroundStyle(Palette.textPrimary)
                    .textSelection(.enabled)
                Spacer(minLength: 8)
                Button { self.message = nil } label: {
                    Image(systemName: "xmark").font(Type.caption)
                }
                .foregroundStyle(Palette.textDim)
                .accessibilityLabel("Dismiss")
            }
            .padding(12)
            .background(Palette.raised, in: RoundedRectangle(cornerRadius: 10))
        }
    }
}

private struct LocalImageView: View {
    let url: URL
    @State private var image: UIImage?
    @State private var failure: String?

    /// A 4096 px square is at most 64 MB decoded, versus an unbounded source;
    /// 32 MB compressed also rejects pathological files before ImageIO opens
    /// them. Tall screenshots retain substantially more useful width here than
    /// they would under the agents' smaller inference limits.
    private static let maxPixelSize = 4096
    private static let maxBytes = 32 * 1024 * 1024

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else if let failure {
                Text(failure)
                    .font(Type.summary)
                    .foregroundStyle(Palette.textDim)
                    .padding(40)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 200)
            }
        }
        .task(id: url) {
            image = nil
            failure = nil
            let result = await ImageDownsampler.filePreview(
                at: url,
                maxBytes: Self.maxBytes,
                maxPixelSize: Self.maxPixelSize
            )
            guard !Task.isCancelled else { return }
            switch result {
            case let .image(decoded):
                // ImageIO already decoded this bounded thumbnail on its worker;
                // UIImage is only the cheap SwiftUI wrapper at this point.
                image = UIImage(cgImage: decoded)
            case .tooLarge:
                failure = "This image is too large to preview on iPhone."
            case .unreadable:
                failure = "Couldn't load the image from your Mac."
            }
        }
    }
}
