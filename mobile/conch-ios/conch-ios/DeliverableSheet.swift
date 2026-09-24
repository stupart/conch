import ConchDesign
import QuickLook
import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// The review screen: one ready piece of work, a reply to the session that
/// made it, and Next. It used to be a sheet with only Done, so every review
/// meant dismissing it, finding the next session and scrolling to its end.
struct ReviewSheet: View {
    @ObservedObject var bridge: BridgeClient
    @ObservedObject var talk: TalkController
    /// The session whose work is on screen. Next moves it.
    @State var sessionId: String
    /// Reviews already looked at here, by version, so Next brings the
    /// unopened first, as the Mac's Ready pill does.
    @State private var opened: Set<String> = []
    @Environment(\.dismiss) private var dismiss

    private var row: PublishedState.Row? {
        bridge.state?.rows.first { $0.id == sessionId }
    }

    private var ready: [ReviewQueue.Entry] {
        ReviewQueue.ready((bridge.state?.rows ?? []).map {
            (id: $0.id, status: $0.status, hasReview: $0.review != nil, filedAt: $0.review?.at, published: $0.review?.id)
        })
    }

    /// What the Mac's daemon remembers being looked at, on any device. Empty against a daemon
    /// too old to know, where this screen's own `opened` is the whole story.
    private var viewedKeys: Set<String> {
        guard bridge.state?.features?.viewedState != nil else { return [] }
        var keys: Set<String> = []
        for row in bridge.state?.rows ?? [] {
            let held = row.reviews ?? row.review.map { [$0] } ?? []
            for one in held where one.viewedAt != nil {
                keys.insert(ReviewQueue.key(sessionId: row.id, filedAt: one.at, published: one.id))
            }
        }
        return keys
    }

    private var currentKey: String? {
        row?.review.map { ReviewQueue.key(sessionId: sessionId, filedAt: $0.at, published: $0.id) }
    }

    var body: some View {
        let next = ReviewQueue.next(after: currentKey, in: ready, opened: opened.union(viewedKeys))
        let more = ready.filter { $0.key != currentKey }.count
        NavigationStack {
            Group {
                if let review = row?.review {
                    DeliverableSheet(bridge: bridge, review: review, sessionId: sessionId)
                        // A different review is a different viewer: nothing of
                        // the last one's download, page or failure carries over.
                        .id(currentKey)
                } else {
                    Text("This work isn't waiting for you any more.")
                        .font(Type.summary)
                        .foregroundStyle(Palette.textDim)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 6) {
                    // What the agent asked you to check, when it said (scene.inspect).
                    if let inspect = row?.review?.inspect {
                        Label(inspect, systemImage: "eye")
                            .font(Type.caption)
                            .foregroundStyle(Palette.textDim)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .accessibilityLabel("Check: \(inspect)")
                    }
                    if let next {
                        HStack {
                            Spacer()
                            Button {
                                if let currentKey {
                                    // Optimistic: it greys here at the tap, and the daemon's
                                    // copy is what carries it to the Mac and past a relaunch.
                                    opened.insert(currentKey)
                                    if bridge.state?.features?.viewedState != nil {
                                        Task { _ = await bridge.send(sessionCommand: .reviewViewed, sessionId: sessionId, review: currentKey) }
                                    }
                                }
                                sessionId = next
                            } label: {
                                HStack(spacing: 6) {
                                    Text("Next")
                                        .font(Type.label(15, weight: .semibold))
                                    Text("\(more) more")
                                        .font(Type.caption)
                                        .foregroundStyle(Palette.textDim)
                                    Image(systemName: "chevron.forward")
                                        .font(Type.caption.weight(.semibold))
                                }
                                .padding(.horizontal, 14)
                                .frame(minHeight: 44)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Palette.micOpen)
                            .accessibilityLabel("Next review, \(more) more waiting")
                        }
                        .padding(.horizontal, 6)
                    }
                    ReviewReplyBar(bridge: bridge, talk: talk, sessionId: sessionId)
                }
                .padding(.top, 4)
                .background(Palette.bg)
            }
            .background(Palette.bg)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Which session, then what it made: the summary alone said
                // neither whose work this was nor that it was a review.
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text(row?.label ?? "")
                            .font(Type.sessionName)
                            .foregroundStyle(Palette.textPrimary)
                            .lineLimit(1)
                        Text(row?.review?.summary ?? "")
                            .font(Type.caption)
                            .foregroundStyle(Palette.textDim)
                            .lineLimit(1)
                    }
                    .accessibilityElement(children: .combine)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

/// Which ready review comes next. Foundation plus `ReviewScene`, so the bun
/// test runs it under `swift` with the Mac pill's own rule beside it.
enum ReviewQueue {
    typealias Entry = (sessionId: String, key: String, at: Double)

    /// A review's version, exactly as the Mac spells it — one rule, in ConchDesign.
    static func key(sessionId: String, filedAt: Double?, published: String? = nil) -> String {
        ReviewIdentity.key(published: published, sessionId: sessionId, filedAt: filedAt)
    }

    /// Ready as the Mac's pill counts it (`StatusItem.readyRows`): a review on
    /// a session that is not working.
    static func ready(_ rows: [(id: String, status: String, hasReview: Bool, filedAt: Double?, published: String?)]) -> [Entry] {
        rows.filter { $0.hasReview && $0.status != "working" }
            .map { (sessionId: $0.id, key: key(sessionId: $0.id, filedAt: $0.filedAt, published: $0.published), at: $0.filedAt ?? 0) }
    }

    /// The session Next opens: `ReviewScene.next`, oldest filed first and the
    /// unopened before the opened, never the review already on screen. Nil
    /// when that is the only one.
    static func next(after current: String?, in ready: [Entry], opened: Set<String>) -> String? {
        let seen = current.map { opened.union([$0]) } ?? opened
        let key = ReviewScene.next(after: current, in: ready.map { (key: $0.key, at: $0.at) }, opened: seen)
        return ready.first { $0.key == key && $0.key != current }?.sessionId
    }
}

/// A page the agent opened on its Mac's own loopback address. The phone
/// loading `localhost` asks itself, and "Could not connect to the server" read
/// as broken work rather than as the wrong machine. Foundation only, so the
/// bun test runs it under `swift`.
enum MacLocalPage {
    /// Whether `url` names the machine that loads it.
    static func isLoopback(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        if host == "localhost" || host.hasSuffix(".localhost") || host == "::1" || host == "0.0.0.0" { return true }
        return host.hasPrefix("127.") && host.allSatisfy { $0.isNumber || $0 == "." }
    }

    /// The same page at the Mac's address on the Wi-Fi. The phone knows that
    /// address only from a LAN pairing; over the relay it has none.
    static func onLAN(_ url: URL, pairedHost: String, isRelay: Bool) -> URL? {
        guard !isRelay,
              var page = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let mac = URLComponents(string: "http://\(pairedHost)")?.host,
              !mac.isEmpty else { return nil }
        page.host = mac
        return page.url
    }
}

/// Every deliverable type the Mac renders, rendered here too — same coverage
/// promise. Web loads directly; local files arrive through the bridge's
/// scoped /file endpoint, which serves only what sessions have published and
/// what a published page or document loads from its own folder.
struct DeliverableSheet: View {
    @ObservedObject var bridge: BridgeClient
    let review: PublishedState.Row.Review
    /// The session the deliverable belongs to; what a failure is filed under.
    let sessionId: String
    @State private var localURL: URL?
    /// Why the deliverable would not arrive or render, with its path on the
    /// Mac — said in the sheet instead of a blank one (A13).
    @State private var failure: String?
    /// A link tapped inside a rendered document that could not be opened.
    @State private var linkFailure: String?
    /// The web view on screen, for Back and Reload.
    @StateObject private var page = PageLoadFailure()
    /// A Mac-local page, tried at the Mac's own address on the Wi-Fi.
    @State private var lanPage: URL?
    /// Quick Look full screen, where Share and Markup live.
    @State private var markingUp = false
    /// Which deliverable a local page's `conch-page://` addresses name.
    @State private var pageHost = UUID().uuidString.lowercased()
    /// A link tapped in here that turned out to be a Mac file, opened the
    /// same way as any other deliverable (`openLink`'s `onFile`).
    @State private var openFile: FileLink?

    private enum LocalKind { case image, video, pdf, markdown, page, text, unsupported }
    private enum Kind {
        case web(URL)
        /// On the Mac's own loopback: said, not loaded (`MacLocalPage`).
        case macLocal(URL)
        case local(LocalKind)
        case unavailable(String)
    }

    private var kind: Kind {
        guard let link = review.link else { return .unavailable("No link on this review.") }
        if let url = URL(string: link),
           let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            return MacLocalPage.isLoopback(url) ? .macLocal(url) : .web(url)
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

    /// The page on screen, if there is one: what Back, Reload and Safari act on.
    private var pageURL: URL? {
        switch kind {
        case let .web(url): url
        case .macLocal: lanPage
        case .local(.page): review.link.flatMap { ConchPagePath.entry(host: pageHost, page: $0) }
        default: nil
        }
    }

    /// Image and PDF: Quick Look's Markup draws on them.
    private var marksUp: Bool {
        switch kind {
        case .local(.image), .local(.pdf): localURL != nil && failure == nil
        default: false
        }
    }

    var body: some View {
        content
            .overlay { if let failure { unavailableView(failure).background(Palette.bg) } }
            .overlay(alignment: .bottom) { LinkFailureLine(message: $linkFailure).padding(12) }
            // Below the failure, so Reload is still there to press.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let pageURL { webControls(pageURL) }
            }
            // A link in a rendered .md behaves as it does in the
            // conversation: a web page opens, a currently published Mac file
            // opens the way this very sheet did, and anything else says why.
            .environment(\.openURL, OpenURLAction { url in
                linkFailure = nil
                bridge.openLink(url, sessionId: sessionId, onFile: { openFile = FileLink(id: $0) }) { linkFailure = $0 }
                return .handled
            })
            .sheet(item: $openFile) { file in
                FileLinkSheet(bridge: bridge, path: file.id, sessionId: sessionId)
            }
            .background(Palette.bg)
            .toolbar {
                // A `conch-page://` address means nothing outside this sheet.
                if let shared = localURL ?? pageURL, shared.scheme != ConchPagePath.scheme, failure == nil {
                    ToolbarItem(placement: .topBarLeading) {
                        ShareLink(item: shared) {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .accessibilityLabel("Share")
                    }
                }
                if marksUp {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { markingUp = true } label: {
                            Image(systemName: "pencil.tip.crop.circle")
                        }
                        .accessibilityLabel("Mark up")
                    }
                }
            }
        // Keyed on the deliverable's identity: its link plus its FILING time,
        // which the daemon never re-stamps. Routine republishes leave it alone;
        // re-sending the same path (a re-rendered file) is new and reloads.
        .task(id: "\(review.link ?? "")\u{1F}\(review.id ?? "")\u{1F}\(review.at ?? 0)") {
            localURL = nil
            failure = nil
            linkFailure = nil
            // A page is served, not downloaded: `LocalPageView` reads it and everything it loads.
            guard case let .local(localKind) = kind, localKind != .page, let link = review.link else { return }
            let downloaded = await bridge.downloadFile(path: link)
            if Task.isCancelled {
                if let downloaded { try? FileManager.default.removeItem(at: downloaded) }
                return
            }
            // Under its own name: Quick Look titles it and Share sends it by
            // that name, and both transports download to a random one.
            localURL = downloaded.map { Self.named($0, like: link) }
            // The bridge's own reason, read on the main actor straight after
            // the call that set it; "couldn't be fetched" alone said nothing.
            if downloaded == nil {
                fail("Couldn't fetch this from your Mac: \(bridge.lastError ?? "it sent nothing back.")")
            }
        }
        .onDisappear {
            if let localURL {
                try? FileManager.default.removeItem(at: localURL)
                // The folder `named` made for it, and only that.
                let folder = localURL.deletingLastPathComponent()
                if UUID(uuidString: folder.lastPathComponent) != nil {
                    try? FileManager.default.removeItem(at: folder)
                }
            }
            localURL = nil
        }
    }

    /// The download, moved into a folder of its own under the file's real name.
    private static func named(_ file: URL, like link: String) -> URL {
        let folder = file.deletingLastPathComponent().appendingPathComponent(UUID().uuidString, isDirectory: true)
        let named = folder.appendingPathComponent((link as NSString).lastPathComponent)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: file, to: named)
            return named
        } catch {
            return file
        }
    }

    @ViewBuilder
    private var content: some View {
        switch kind {
        case let .web(url):
            BridgedWebView(url: url, page: page, onFailure: fail)
        case let .macLocal(url):
            if let lanPage {
                BridgedWebView(url: lanPage, page: page, onFailure: fail)
            } else {
                macLocalView(url)
            }
        case let .local(localKind):
            if localKind == .page, let entry = pageURL {
                localContent(.page, url: entry)
            } else if let url = localURL {
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
        case .image, .video, .pdf:
            // Quick Look, as Files and Mail show them: pinch and double-tap
            // zoom on a screenshot, PDF pages, a real player. The fitted image
            // could not be zoomed, so a UI detail could not be inspected.
            QuickLookView(url: url, fullScreen: $markingUp, onFailure: fail)
        case .markdown:
            RemoteDocumentView(url: url, renderMarkdown: true, document: review.link, bridge: bridge, onFailure: fail)
        case .page:
            // A local .html is a PAGE. The Mac has always rendered it as one;
            // here it was raw markup, so the same deliverable looked finished
            // on one surface and broken on the other. Then it was the HTML
            // alone, downloaded into an empty folder, so its styles, scripts
            // and pictures were silently missing; now each is read from the
            // Mac as the page asks for it.
            LocalPageView(bridge: bridge, macPath: review.link ?? "", url: url, page: page, onFailure: fail)
        case .text:
            RemoteDocumentView(url: url, renderMarkdown: false, onFailure: fail)
        case .unsupported:
            if QLPreviewController.canPreview(url as NSURL) {
                QuickLookView(url: url, fullScreen: $markingUp, onFailure: fail)
            } else {
                // What it is, why it isn't drawn, and what the phone can do
                // with it: the file is here, so Share (top left) hands it on.
                unavailableView(
                    "iPhone can't preview a \(url.pathExtension.uppercased()) file, so \(url.lastPathComponent) isn't shown here. "
                    + "It's on this phone now: Share sends it to an app that opens it, or to Files."
                )
            }
        }
    }

    /// Back, Reload, and Safari for a page Safari can open. A tapped link used
    /// to leave no way back to the page the agent sent.
    private func webControls(_ url: URL) -> some View {
        HStack(spacing: 8) {
            Button { page.view?.goBack() } label: {
                Image(systemName: "chevron.backward").frame(width: 44, height: 44)
            }
            .disabled(!page.canGoBack)
            .accessibilityLabel("Back")
            Button {
                failure = nil
                page.reload(url)
            } label: {
                Image(systemName: "arrow.clockwise").frame(width: 44, height: 44)
            }
            .accessibilityLabel("Reload")
            Spacer(minLength: 0)
            if url.scheme == "http" || url.scheme == "https" {
                Button {
                    linkFailure = nil
                    bridge.openLink(page.view?.url ?? url, sessionId: sessionId) { linkFailure = $0 }
                } label: {
                    Label("Open in Safari", systemImage: "safari")
                        .frame(minHeight: 44)
                }
            }
        }
        .font(Type.label(15, weight: .medium))
        .foregroundStyle(Palette.micOpen)
        .padding(.horizontal, 10)
        .background(Palette.bg)
    }

    /// What a Mac-local page is, and the one thing that can work from here.
    private func macLocalView(_ url: URL) -> some View {
        let lan = MacLocalPage.onLAN(url, pairedHost: bridge.pairedHost, isRelay: bridge.isRelayPaired)
        return ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Image(systemName: "laptopcomputer")
                    .font(.system(size: 26))
                    .foregroundStyle(Palette.textDim)
                    .accessibilityHidden(true)
                Text("This page is running on your Mac")
                    .font(Type.label(17, weight: .semibold))
                    .foregroundStyle(Palette.textPrimary)
                Text("\(url.host ?? "localhost") is how your Mac reaches its own dev server. On iPhone the same address means the iPhone, so the page can't load here.")
                if let lan {
                    Text("On the same Wi-Fi, your Mac is at \(lan.host ?? ""). The page opens there if its dev server accepts other devices, for example `vite --host`.")
                    Button { lanPage = lan } label: {
                        Label("Open \(lan.absoluteString)", systemImage: "wifi")
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Palette.micOpen)
                    .foregroundStyle(Palette.bg)
                } else {
                    Text("This phone reaches your Mac through the relay, so it doesn't know the Mac's address on your Wi-Fi, and conch doesn't carry a dev server's pages through the relay yet. Paired on the same Wi-Fi, the page can open here.")
                }
                Text(url.absoluteString)
                    .font(Type.mono)
                    .textSelection(.enabled)
            }
            .font(Type.summary)
            .foregroundStyle(Palette.textDim)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
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
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }
}

/// A tapped link's target, once `openLink` has said it is a file
/// (`BridgeClient.LinkRoute.file`) — `.sheet(item:)` needs Identifiable, and
/// the Mac path itself is the identity.
struct FileLink: Identifiable { let id: String }

/// A tapped file link, opened the way any other deliverable is: reuses
/// `DeliverableSheet` — its download, its honest 403, its renderers — rather
/// than a second one for a Mac path that happens to arrive from a tap
/// instead of the ledger.
struct FileLinkSheet: View {
    @ObservedObject var bridge: BridgeClient
    let path: String
    let sessionId: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            DeliverableSheet(bridge: bridge, review: .init(link: path), sessionId: sessionId)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}

/// Quick Look, inline and full screen. Inline gives zoom, pages and playback;
/// full screen adds Quick Look's own Share and Markup.
private struct QuickLookView: UIViewControllerRepresentable {
    let url: URL
    @Binding var fullScreen: Bool
    let onFailure: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        context.coordinator.inline = controller
        // Quick Look draws its own "can't preview" page and reports nothing,
        // so ask first and say why, like every other viewer here (A13).
        if !QLPreviewController.canPreview(url as NSURL) {
            let onFailure = onFailure
            let ext = url.pathExtension.uppercased()
            DispatchQueue.main.async { onFailure("Quick Look can't open this \(ext) file") }
        }
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        guard fullScreen else { return }
        DispatchQueue.main.async { fullScreen = false }
        guard controller.presentedViewController == nil else { return }
        let full = QLPreviewController()
        full.dataSource = context.coordinator
        full.delegate = context.coordinator
        controller.present(full, animated: true)
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
        let url: URL
        weak var inline: QLPreviewController?

        init(url: URL) { self.url = url }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }

        /// Markup draws on the downloaded copy, so Share sends what you marked.
        func previewController(_ controller: QLPreviewController, editingModeFor previewItem: QLPreviewItem) -> QLPreviewItemEditingMode {
            .updateContents
        }

        func previewControllerDidDismiss(_ controller: QLPreviewController) {
            inline?.refreshCurrentPreviewItem()
        }
    }
}

/// Markdown and text deliverables, fetched then rendered natively.
private struct RemoteDocumentView: View {
    let url: URL
    let renderMarkdown: Bool
    /// The document's path on the Mac, which the pictures in it are relative to.
    var document: String? = nil
    var bridge: BridgeClient? = nil
    let onFailure: (String) -> Void
    @State private var content: String?

    /// Pictures come from where the document sits on the Mac; without that they stay alt text.
    private var images: MarkdownView.ImageView? {
        guard let bridge, let document else { return nil }
        return { source, alt in AnyView(MarkdownImage(bridge: bridge, source: source, alt: alt, document: document)) }
    }

    var body: some View {
        Group {
            if let content {
                ScrollView {
                    Group {
                        if renderMarkdown {
                            MarkdownView(text: content, image: images)
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
                    // Copy a paragraph, a command or the whole log out of it.
                    .textSelection(.enabled)
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
    let page: PageLoadFailure
    let onFailure: (String) -> Void

    func makeCoordinator() -> PageLoadFailure { page }

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView()
        view.isOpaque = false
        view.backgroundColor = UIColor(Palette.bg)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        context.coordinator.view = view
        context.coordinator.onFailure = onFailure
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}

/// A local HTML page, and everything it loads, read from the Mac as it asks
/// (`ConchPageSchemeHandler`).
private struct LocalPageView: UIViewRepresentable {
    let bridge: BridgeClient
    /// The page's path on the Mac; its folder is what the page's addresses resolve against.
    let macPath: String
    let url: URL
    let page: PageLoadFailure
    let onFailure: (String) -> Void

    func makeCoordinator() -> PageLoadFailure { page }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(
            ConchPageSchemeHandler(bridge: bridge, entry: url, page: macPath),
            forURLScheme: ConchPagePath.scheme
        )
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = UIColor(Palette.bg)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        context.coordinator.view = view
        context.coordinator.onFailure = onFailure
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}

/// A page that will not load says why instead of staying blank (A13); a link
/// that asks for a new window opens in this one; Back knows when it can.
private final class PageLoadFailure: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    var onFailure: (String) -> Void = { _ in }
    @Published private(set) var canGoBack = false
    private var backObservation: NSKeyValueObservation?
    weak var view: WKWebView? {
        didSet {
            backObservation = view?.observe(\.canGoBack, options: [.initial, .new]) { [weak self] view, _ in
                DispatchQueue.main.async { self?.canGoBack = view.canGoBack }
            }
        }
    }

    /// Reload what is there, or load `url` again when nothing ever arrived.
    func reload(_ url: URL) {
        guard let view else { return }
        if view.url == nil { view.load(URLRequest(url: url)) } else { view.reload() }
    }

    /// `target="_blank"` and `window.open` ask for a new window, which a sheet
    /// has none of, so those links did nothing. They open here instead.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
    }

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

/// Where a local page and what it loads live on the phone:
/// `conch-page://<id>/<path>`, the id standing for the page's folder on the
/// Mac. The id is the host, so a root-relative `/style.css` resolves against
/// that folder, as it does for the page opened from disk. Foundation only, so
/// the bun test runs it under `swift`.
enum ConchPagePath {
    static let scheme = "conch-page"

    /// The page itself, at the root of its folder.
    static func entry(host: String, page: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.path = "/" + (page as NSString).lastPathComponent
        return components.url
    }

    /// The Mac file a request names: `folder` plus the request's path. Nil for
    /// another page's id, or for a path that climbs, `..` however it was
    /// spelled, since the path is read decoded (`%2e%2e`, `..%2F`). The Mac
    /// refuses those too (`servableFile`); this keeps them off the wire.
    static func macPath(for url: URL, host: String, folder: String) -> String? {
        guard url.scheme == scheme, url.host == host else { return nil }
        let parts = url.path.split(separator: "/")
        guard !parts.isEmpty, !parts.contains(where: { $0 == ".." || $0 == "." || $0.contains("\0") }) else { return nil }
        return ([folder] + parts.map(String.init)).joined(separator: "/")
    }

    /// A markdown picture's source, resolved the way the document opened from
    /// disk resolves it: a web address as it is, anything else a file against
    /// the document's own folder on the Mac. Nil for what is neither.
    static func markdownImage(_ source: String, document: String) -> URL? {
        if let url = URL(string: source), let scheme = url.scheme?.lowercased() {
            if scheme == "http" || scheme == "https" { return url }
            return url.isFileURL ? url.standardizedFileURL : nil
        }
        let folder = URL(fileURLWithPath: (document as NSString).deletingLastPathComponent, isDirectory: true)
        // Markdown spells a space %20; the file on the Mac has a space.
        return URL(fileURLWithPath: source.removingPercentEncoding ?? source, relativeTo: folder).standardizedFileURL
    }
}

/// Serves a local page, and everything it loads, from the Mac: each
/// `conch-page://` request is one `/file` read over whichever transport is
/// live, LAN or relay, with the token attached by `fetchFile`, never in an
/// address the page can see. Tyler: "a huge improvement would be having all
/// content viewable and interative on phone app - currently it just says to go
/// to desktop which kinda defeats a lot of the purpose of having it."
@MainActor
final class ConchPageSchemeHandler: NSObject, WKURLSchemeHandler {
    private let bridge: BridgeClient
    private let entry: URL
    private let folder: String
    /// Reads in flight. Each read's Task holds its WKURLSchemeTask until it
    /// ends, so no other task can take the same identity while it is here.
    private var reads: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(bridge: BridgeClient, entry: URL, page: String) {
        self.bridge = bridge
        self.entry = entry
        folder = (page as NSString).deletingLastPathComponent
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        // The page itself failing says why in the sheet; a missing picture
        // answers the page the way a web server would.
        let isPage = url == entry || task.request.mainDocumentURL == url
        guard let path = ConchPagePath.macPath(for: url, host: entry.host ?? "", folder: folder) else {
            answer(task, url: url, failure: BridgeTransportError.httpStatus(404), isPage: isPage)
            return
        }
        let key = ObjectIdentifier(task)
        reads[key] = Task { @MainActor [weak self, bridge] in
            let result: Result<URL, Error>
            do { result = .success(try await bridge.fetchFile(path: path)) } catch { result = .failure(error) }
            // Stopped (the page moved on, or the sheet closed): WebKit raises
            // an exception if a stopped task is answered.
            guard let self, self.reads.removeValue(forKey: key) != nil else {
                if case let .success(file) = result { try? FileManager.default.removeItem(at: file) }
                return
            }
            switch result {
            case let .success(file):
                let data = (try? Data(contentsOf: file, options: .mappedIfSafe)) ?? Data()
                try? FileManager.default.removeItem(at: file)
                task.didReceive(HTTPURLResponse(
                    url: url,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": Self.contentType(url.pathExtension), "Content-Length": String(data.count)]
                )!)
                if !data.isEmpty { task.didReceive(data) }
                task.didFinish()
            case let .failure(error):
                self.answer(task, url: url, failure: error, isPage: isPage)
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        reads.removeValue(forKey: ObjectIdentifier(task))?.cancel()
    }

    private func answer(_ task: WKURLSchemeTask, url: URL, failure: Error, isPage: Bool) {
        if !isPage, case let BridgeTransportError.httpStatus(status) = failure {
            task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!)
            task.didFinish()
        } else {
            task.didFailWithError(NSError(
                domain: "conch.page",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: BridgeClient.fileFailure(failure)]
            ))
        }
    }

    /// Scripts and wasm by the names a browser requires, since a module script
    /// with the wrong type does not run; text as UTF-8, which is what an agent
    /// writes, where WebKit would otherwise guess Latin-1 and mangle every dash.
    static func contentType(_ ext: String) -> String {
        let type: String = switch ext.lowercased() {
        case "js", "mjs": "text/javascript"
        case "wasm": "application/wasm"
        default: UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        }
        return type.hasPrefix("text/") ? "\(type); charset=utf-8" : type
    }
}

/// One picture in a rendered markdown document: a web address loaded
/// directly, a file on the Mac read through `/file`, which serves it when it
/// sits under the document's own folder. One that can't come says what it is
/// and why, where it would have been.
private struct MarkdownImage: View {
    let bridge: BridgeClient
    let source: String
    let alt: String
    let document: String
    @State private var image: UIImage?
    @State private var failure: String?

    private var target: URL? { ConchPagePath.markdownImage(source, document: document) }

    var body: some View {
        Group {
            if let web = target, !web.isFileURL {
                AsyncImage(url: web) { phase in
                    if let loaded = phase.image {
                        loaded.resizable().scaledToFit()
                    } else if phase.error != nil {
                        caption("iPhone couldn't load this picture from \(web.host ?? "the web").")
                    } else {
                        ProgressView()
                    }
                }
            } else if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: image.size.width)
            } else if let failure {
                caption(failure)
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 60)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel(alt.isEmpty ? "Picture" : alt)
        .task(id: source) { await load() }
    }

    private func caption(_ why: String) -> some View {
        Label(alt.isEmpty ? why : "\(alt): \(why)", systemImage: "photo")
            .font(Type.caption)
            .foregroundStyle(Palette.textDim)
    }

    @MainActor
    private func load() async {
        guard let target else {
            failure = "conch can't show a picture from \(source)."
            return
        }
        guard target.isFileURL else { return }
        do {
            let file = try await bridge.fetchFile(path: target.path)
            defer { try? FileManager.default.removeItem(at: file) }
            let preview = await ImageDownsampler.filePreview(at: file, maxBytes: 32 * 1024 * 1024, maxPixelSize: 2048)
            guard !Task.isCancelled else { return }
            if case let .image(decoded) = preview {
                image = UIImage(cgImage: decoded)
            } else {
                failure = "iPhone can't draw this \(target.pathExtension.uppercased()) picture."
            }
        } catch {
            if !Task.isCancelled { failure = BridgeClient.fileFailure(error) }
        }
    }
}
