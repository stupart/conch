import PDFKit
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

    private enum LocalKind { case image, pdf, markdown, text }
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
        switch (link as NSString).pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "svg":
            return .local(.image)
        case "pdf":
            return .local(.pdf)
        case "md", "markdown":
            return .local(.markdown)
        default:
            return .local(.text)
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
        case .pdf:
            BridgedPDFView(url: url)
        case .markdown:
            RemoteDocumentView(url: url, renderMarkdown: true)
        case .text:
            RemoteDocumentView(url: url, renderMarkdown: false)
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
