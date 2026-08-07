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
    @Environment(\.dismiss) private var dismiss
    @State private var localURL: URL?
    @State private var localFailed = false

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
            localFailed = false
            guard case .local = kind, let link = review.link else { return }
            let downloaded = await bridge.downloadFile(path: link)
            if Task.isCancelled {
                if let downloaded { try? FileManager.default.removeItem(at: downloaded) }
                return
            }
            localURL = downloaded
            localFailed = localURL == nil
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
            BridgedWebView(url: url)
        case let .local(localKind):
            if let url = localURL {
                localContent(localKind, url: url)
            } else if localFailed {
                unavailableView("This deliverable lives on your Mac and couldn't be fetched.")
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        case let .unavailable(reason):
            unavailableView(reason)
        }
    }

    private func mutedAwarePlayer(url: URL) -> AVPlayer {
        let player = AVPlayer(url: url)
        player.isMuted = bridge.state?.mode.muted == true
        return player
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
            // Starts silent while conch is muted, audible on one tap. Playing
            // is a deliberate act so it is never blocked — the same rule that
            // lets Talk work while passive — but mute usually means "I am in a
            // meeting", and this one lives in a pocket.
            VideoPlayer(player: mutedAwarePlayer(url: url))
                .background(Palette.bg)
        case .pdf:
            BridgedPDFView(url: url)
        case .markdown:
            RemoteDocumentView(url: url, renderMarkdown: true)
        case .page:
            // A local .html is a PAGE. The Mac has always rendered it as one;
            // here it was raw markup, so the same deliverable looked finished
            // on one surface and broken on the other.
            // loadFileURL, not load(URLRequest:) — a file:// page needs read
            // access granted to its own directory or its assets never load.
            LocalPageView(url: url)
        case .text:
            RemoteDocumentView(url: url, renderMarkdown: false)
        case .unsupported:
            unavailableView(
                "conch can't preview a \(url.pathExtension.uppercased()) yet — "
                + "it's on the Mac at \(url.lastPathComponent)."
            )
        }
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
    @State private var content: String?
    @State private var failed = false

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
            } else if failed {
                Text("Couldn't load this from your Mac.")
                    .font(Type.summary)
                    .foregroundStyle(Palette.textDim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                failed = true
            }
        }
    }
}

private struct BridgedWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView()
        view.isOpaque = false
        view.backgroundColor = UIColor(Palette.bg)
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

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView()
        view.isOpaque = false
        view.backgroundColor = UIColor(Palette.bg)
        view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}

private struct BridgedPDFView: UIViewRepresentable {
    let url: URL

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
            }
        }
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {}
}

private struct LocalImageView: View {
    let url: URL

    var body: some View {
        if let image = UIImage(contentsOfFile: url.path) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
        } else {
            Text("Couldn't load the image from your Mac.")
                .font(Type.summary)
                .foregroundStyle(Palette.textDim)
                .padding(40)
        }
    }
}
