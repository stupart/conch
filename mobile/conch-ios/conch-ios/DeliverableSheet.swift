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

    private enum Kind {
        case web(URL)
        case image(URL)
        case pdf(URL)
        case markdown(URL)
        case text(URL)
        case unavailable(String)
    }

    private var kind: Kind {
        guard let link = review.link else { return .unavailable("No link on this review.") }
        if let url = URL(string: link),
           let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            return .web(url)
        }
        guard let served = bridge.fileURL(for: link) else {
            return .unavailable("This deliverable lives on your Mac and couldn't be fetched.")
        }
        switch (link as NSString).pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "svg":
            return .image(served)
        case "pdf":
            return .pdf(served)
        case "md", "markdown":
            return .markdown(served)
        default:
            return .text(served)
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
    }

    @ViewBuilder
    private var content: some View {
        switch kind {
        case let .web(url):
            BridgedWebView(url: url)
        case let .image(url):
            ScrollView([.vertical, .horizontal]) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image):
                        image.resizable().scaledToFit()
                    case .failure:
                        unavailableView("Couldn't load the image from your Mac.")
                    default:
                        ProgressView().padding(60)
                    }
                }
            }
        case let .pdf(url):
            BridgedPDFView(url: url)
        case let .markdown(url):
            RemoteDocumentView(url: url, renderMarkdown: true)
        case let .text(url):
            RemoteDocumentView(url: url, renderMarkdown: false)
        case let .unavailable(reason):
            unavailableView(reason)
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
                            Text(content)
                                .font(Type.mono)
                                .frame(maxWidth: .infinity, alignment: .leading)
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
                let (data, _) = try await URLSession.shared.data(from: url)
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
            if let (data, _) = try? await URLSession.shared.data(from: url) {
                await MainActor.run { view.document = PDFDocument(data: data) }
            }
        }
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {}
}
