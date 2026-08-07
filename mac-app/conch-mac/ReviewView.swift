import AppKit
import PDFKit
import AVKit
import SwiftUI

struct ReviewItem: Identifiable, Equatable {
    let id: String
    let rowID: String
    let label: String
    let summary: String
    let link: String?
    let reviewedAt: TimeInterval?

    init?(row: SessionRow) {
        guard let review = row.review else {
            return nil
        }

        rowID = row.id
        label = row.label
        summary = review.summary
        let link = review.link?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.link = link.isEmpty ? nil : link
        reviewedAt = review.at
        let timestampIdentity = review.at.map { String($0.bitPattern) } ?? "undated"
        id = [row.id, timestampIdentity].joined(separator: "\u{1F}")
    }
}

struct InlineReviewView: View {
    let item: ReviewItem
    let onExpand: () -> Void

    @State private var isWebLoading = false

    var body: some View {
        ReviewSurface(
            item: item,
            actionSymbol: "arrow.up.left.and.arrow.down.right",
            actionHelp: "Expand deliverable",
            actionAccessibilityLabel: "Expand deliverable full window",
            action: item.link == nil ? nil : onExpand,
            actionShortcut: nil,
            isWebLoading: $isWebLoading
        )
    }
}

struct ExpandedReviewView: View {
    let item: ReviewItem
    let onCollapse: () -> Void

    @State private var isWebLoading = false

    var body: some View {
        ReviewSurface(
            item: item,
            actionSymbol: "arrow.down.right.and.arrow.up.left",
            actionHelp: "Collapse deliverable (Esc)",
            actionAccessibilityLabel: "Collapse deliverable",
            action: onCollapse,
            actionShortcut: .cancelAction,
            isWebLoading: $isWebLoading
        )
        .background(ConchPalette.bg)
    }
}

private struct ReviewSurface: View {
    let item: ReviewItem
    let actionSymbol: String
    let actionHelp: String
    let actionAccessibilityLabel: String
    let action: (() -> Void)?
    let actionShortcut: KeyboardShortcut?
    @Binding var isWebLoading: Bool

    var body: some View {
        VStack(spacing: 0) {
            caption

            Rectangle()
                .fill(ConchPalette.divider)
                .frame(height: 1)

            ZStack(alignment: .top) {
                if let link = item.link {
                    ReviewContent(
                        link: link,
                        isWebLoading: $isWebLoading
                    )
                    .id(item.id)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    MissingDeliverableView()
                        .onAppear {
                            isWebLoading = false
                        }
                }

                if isWebLoading {
                    DeliverableLoadingLine()
                        .transition(.opacity)
                        .allowsHitTesting(false)
                }
            }
            .animation(.easeOut(duration: 0.16), value: isWebLoading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ConchPalette.bg)
    }

    private var caption: some View {
        HStack(spacing: 9) {
            Image(systemName: "star.fill")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.statusReview)
                .accessibilityHidden(true)

            Text(item.label)
                .font(ConchTypography.font(size: 12.5, weight: .medium))
                .tracking(-0.3)
                .foregroundStyle(ConchPalette.brandCyan)
                .lineLimit(1)

            Text(item.summary.isEmpty ? "Ready for review" : item.summary)
                .font(ConchTypography.font(size: 12.5))
                .tracking(-0.3)
                .foregroundStyle(ConchPalette.textPrimary)
                .lineLimit(2)
                .truncationMode(.tail)
                .textSelection(.enabled)

            Spacer(minLength: 12)

            if let action {
                Button(action: action) {
                    Image(systemName: actionSymbol)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(ConchPalette.textDim)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(ReviewPressButtonStyle())
                .keyboardShortcut(actionShortcut)
                .help(actionHelp)
                .accessibilityLabel(actionAccessibilityLabel)
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 2)
        .frame(minHeight: 44)
        .background(ConchPalette.raised.opacity(0.72))
    }
}

private struct MissingDeliverableView: View {
    var body: some View {
        VStack(spacing: 9) {
            Image(systemName: "doc.badge.ellipsis")
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(ConchPalette.textFaint)

            Text("No deliverable link was published for this review.")
                .font(ConchTypography.font(size: 12.5))
                .foregroundStyle(ConchPalette.textDim)
                .textSelection(.enabled)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ConchPalette.bg)
    }
}

private struct ReviewContent: View {
    let link: String

    /// Scheme + host together: on a bar whose job is marking a trust boundary,
    /// http:// and https:// must not look alike.
    private var originText: String {
        guard let url = URL(string: link), let host = url.host else { return link }
        guard let scheme = url.scheme else { return host }
        return scheme + "://" + host
    }
    @Binding var isWebLoading: Bool
    @State private var navigationFailure: DeliverableNavigationFailure?
    @State private var reloadID = UUID()

    var body: some View {
        switch DeliverableSource(link: link) {
        case let .image(url):
            DeliverableImageView(url: url)
                .padding(18)
                .background(ConchPalette.bg)
                .onAppear {
                    isWebLoading = false
                }
        case let .video(url):
            DeliverableVideoView(url: url)
                .background(ConchPalette.bg)
                .onAppear {
                    isWebLoading = false
                }
        case let .pdf(url):
            DeliverablePDFView(url: url)
                .background(ConchPalette.bg)
                .onAppear {
                    isWebLoading = false
                }
        case let .markdown(url):
            DeliverableDocumentView(url: url, renderMarkdown: true)
                .background(ConchPalette.bg)
                .onAppear {
                    isWebLoading = false
                }
        case let .text(url):
            DeliverableDocumentView(url: url, renderMarkdown: false)
                .background(ConchPalette.bg)
                .onAppear {
                    isWebLoading = false
                }
        case let .missing(url):
            VStack(spacing: 10) {
                Image(systemName: "questionmark.folder")
                    .font(.system(size: 22, weight: .regular))
                    .foregroundStyle(ConchPalette.textDim)
                Text("Couldn't find \(url.lastPathComponent)")
                    .font(ConchTypography.font(size: 14, weight: .medium))
                    .foregroundStyle(ConchPalette.textPrimary)
                Text("It may have been moved or deleted since the review was filed.")
                    .font(ConchTypography.font(size: 12))
                    .foregroundStyle(ConchPalette.textDim)
                Text(url.path)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ConchPalette.textFaint)
                    .textSelection(.enabled)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .frame(maxWidth: 460)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(24)
            .background(ConchPalette.bg)
            .onAppear {
                isWebLoading = false
            }
        case .web:
            VStack(spacing: 0) {
                // A deliverable is an agent-authored URL rendered full-bleed in
                // conch's own chrome, so a third-party page — a sign-in form,
                // say — was indistinguishable from conch's UI. Naming the origin
                // is what makes the boundary visible.
                HStack(spacing: 6) {
                    Image(systemName: "globe")
                        .font(.system(size: 9.5))
                    // Scheme included: on a bar whose stated job is marking a
                    // trust boundary, http:// and https:// must not look alike.
                    Text(originText)
                        .font(ConchTypography.font(size: 11))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 8)
                    Button("Open in browser") {
                        if let url = URL(string: link) { NSWorkspace.shared.open(url) }
                    }
                    .buttonStyle(.link)
                    .font(ConchTypography.font(size: 11))
                }
                .foregroundStyle(ConchPalette.textDim)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(ConchPalette.raised)

                Rectangle()
                    .fill(ConchPalette.divider)
                    .frame(height: 1)

                ZStack {
                DeliverableWebView(
                    link: link,
                    reloadID: reloadID,
                    isLoading: $isWebLoading,
                    onNavigationFailure: { failure in
                        navigationFailure = failure
                    }
                )

                // WKWebView paints the document white until the page's own
                // background lands, so a remote deliverable flashed a blinding
                // white rectangle for several seconds inside a dark app. Cover
                // it until the load settles. Failure states set isLoading false
                // too, so this can't strand the pane behind a permanent cover.
                if isWebLoading, navigationFailure == nil {
                    ConchPalette.bg
                        .overlay(
                            VStack(spacing: 10) {
                                ProgressView().controlSize(.small)
                                Text(URL(string: link)?.host ?? "loading…")
                                    .font(ConchTypography.font(size: 12))
                                    .foregroundStyle(ConchPalette.textDim)
                            }
                        )
                        .transition(.opacity)
                }

                if let failure = navigationFailure {
                    DeliverableFailureView(
                        failure: failure,
                        onRetry: retryNavigation,
                        onDismiss: {
                            navigationFailure = nil
                        },
                        onOpenInBrowser: {
                            NSWorkspace.shared.open(failure.url)
                        }
                    )
                }
                }
            }
            .background(ConchPalette.bg)
        }
    }

    private func retryNavigation() {
        navigationFailure = nil
        isWebLoading = true
        reloadID = UUID()
    }
}

private struct DeliverableFailureView: View {
    let failure: DeliverableNavigationFailure
    let onRetry: () -> Void
    let onDismiss: () -> Void
    let onOpenInBrowser: () -> Void

    var body: some View {
        VStack {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(ConchPalette.statusNeeds)
                        .accessibilityHidden(true)

                    Text(failure.title)
                        .font(ConchTypography.font(size: 16, weight: .medium))
                        .foregroundStyle(ConchPalette.textPrimary)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text(failure.link)
                        .font(ConchTypography.font(size: 11.5))
                        .tracking(-0.2)
                        .foregroundStyle(ConchPalette.accent)
                        .lineLimit(4)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                        .help(failure.link)

                    Text(failure.message)
                        .font(ConchTypography.font(size: 12))
                        .tracking(-0.2)
                        .foregroundStyle(ConchPalette.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: 10) {
                    if failure.canRetry {
                        Button(action: onRetry) {
                            Label("Retry", systemImage: "arrow.clockwise")
                                .font(ConchTypography.font(size: 12, weight: .medium))
                                .foregroundStyle(ConchPalette.textPrimary)
                                .padding(.horizontal, 14)
                                .frame(minHeight: 40)
                                .background(
                                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                                        .fill(ConchPalette.accent.opacity(0.20))
                                )
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(ReviewPressButtonStyle())
                    } else {
                        Button(action: onDismiss) {
                            Text("Back to Review")
                                .font(ConchTypography.font(size: 12, weight: .medium))
                                .foregroundStyle(ConchPalette.textPrimary)
                                .padding(.horizontal, 14)
                                .frame(minHeight: 40)
                                .background(
                                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                                        .fill(ConchPalette.hover)
                                )
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(ReviewPressButtonStyle())
                    }

                    if failure.canOpenInBrowser {
                        Button(action: onOpenInBrowser) {
                            Label("Open in Browser", systemImage: "safari")
                                .font(ConchTypography.font(size: 12, weight: .medium))
                                .foregroundStyle(ConchPalette.textPrimary)
                                .padding(.horizontal, 14)
                                .frame(minHeight: 40)
                                .background(
                                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                                        .fill(ConchPalette.hover)
                                )
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(ReviewPressButtonStyle())
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: 560, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .fill(ConchPalette.raised)
                    .shadow(
                        color: .black.opacity(0.35),
                        radius: 24,
                        y: 10
                    )
            )
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ConchPalette.bg)
        .accessibilityElement(children: .contain)
    }
}

private struct DeliverableLoadingLine: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hasTravelled = false

    var body: some View {
        GeometryReader { proxy in
            let segmentWidth = min(
                max(proxy.size.width * 0.24, 96),
                180
            )

            Rectangle()
                .fill(ConchPalette.accent)
                .frame(width: segmentWidth, height: 2)
                .offset(
                    x: reduceMotion
                        ? (proxy.size.width - segmentWidth) / 2
                        : hasTravelled ? proxy.size.width : -segmentWidth
                )
        }
        .frame(height: 2)
        .clipped()
        .onAppear {
            updateTravel(reduceMotion: reduceMotion)
        }
        .onChange(of: reduceMotion) { _, currentValue in
            updateTravel(reduceMotion: currentValue)
        }
    }

    private func updateTravel(reduceMotion: Bool) {
        withAnimation(nil) {
            hasTravelled = false
        }
        guard !reduceMotion else { return }

        DispatchQueue.main.async {
            guard !self.reduceMotion else { return }
            withAnimation(
                .linear(duration: 0.95)
                .repeatForever(autoreverses: false)
            ) {
                hasTravelled = true
            }
        }
    }
}

enum DeliverableSource: Equatable {
    case image(URL)
    case video(URL)
    case pdf(URL)
    case markdown(URL)
    case text(URL)
    case missing(URL)
    case web

    private static let imageExtensions = Set([
        "png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "tiff",
    ])
    private static let markdownExtensions = Set(["md", "markdown"])
    // WebKit will play some of these and refuse others depending on codec, so
    // "it fell through to the web view" was luck rather than support. AVKit
    // plays them with real transport controls.
    private static let videoExtensions = Set([
        "mp4", "mov", "m4v", "webm",
    ])
    // Types that are TEXT to a person even when they aren't .txt. Everything
    // else local still falls through to the web view, which handles .html and
    // anything WebKit natively previews.
    private static let textExtensions = Set([
        "txt", "log", "json", "yaml", "yml", "toml", "csv", "diff", "patch",
    ])

    init(link: String) {
        if let url = URL(string: link),
           let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            self = .web
            return
        }

        // Every local type used to fall into the WKWebView, where a .md file
        // rendered as raw syntax and a .txt as a white page inside a dark app.
        // Each type now goes to a renderer that shows its WHOLE content.
        let localURL = Self.localFileURL(for: link)
        // A vanished file must SAY so. Falling through to a renderer produced a
        // lone glyph with no words — indistinguishable from a broken renderer.
        if !FileManager.default.fileExists(atPath: localURL.path) {
            self = .missing(localURL)
            return
        }
        switch localURL.pathExtension.lowercased() {
        case let ext where Self.imageExtensions.contains(ext):
            self = .image(localURL)
        case "pdf":
            self = .pdf(localURL)
        case let ext where Self.videoExtensions.contains(ext):
            self = .video(localURL)
        case let ext where Self.markdownExtensions.contains(ext):
            self = .markdown(localURL)
        case let ext where Self.textExtensions.contains(ext):
            self = .text(localURL)
        default:
            self = .web
        }
    }

    private static func localFileURL(for link: String) -> URL {
        if let url = URL(string: link), url.isFileURL {
            return url.standardizedFileURL
        }

        let expanded = NSString(string: link).expandingTildeInPath
        return URL(fileURLWithPath: expanded, isDirectory: false).standardizedFileURL
    }
}

/// A video deliverable with real transport controls.
///
/// These used to fall through to the web view, which plays some codecs and
/// silently refuses others — so support was luck. AVKit gives scrubbing,
/// volume and fullscreen, and fails loudly when it cannot decode.
private struct DeliverableVideoView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.controlsStyle = .inline
        view.videoGravity = .resizeAspect
        view.player = AVPlayer(url: url)
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
        if (view.player?.currentItem?.asset as? AVURLAsset)?.url != url {
            view.player = AVPlayer(url: url)
        }
    }
}

/// A PDF deliverable, whole and scrollable — WKWebView happened to preview
/// PDFs, but PDFKit gives continuous scroll, fit-to-width, and Select/Copy.
private struct DeliverablePDFView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displaysPageBreaks = true
        view.backgroundColor = NSColor(ConchPalette.bg)
        view.document = PDFDocument(url: url)
        return view
    }

    func updateNSView(_ view: PDFView, context: Context) {
        if view.document?.documentURL != url {
            view.document = PDFDocument(url: url)
        }
    }
}

/// A markdown or plain-text deliverable rendered natively, dark and complete.
/// These used to fall into the WKWebView: markdown showed its raw syntax and
/// text files painted a white system page inside a dark app.
private struct DeliverableDocumentView: NSViewRepresentable {
    let url: URL
    let renderMarkdown: Bool

    /// Deliverables are files an agent just produced, but an unbounded read is
    /// still an unbounded read. 2MB of text is far past what a review is for.
    private static let maxBytes = 2 * 1024 * 1024

    final class Coordinator {
        var loadedURL: URL?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true

        let textView = NSTextView()
        textView.drawsBackground = false
        textView.isEditable = false
        textView.isSelectable = true
        textView.textContainerInset = NSSize(width: 24, height: 20)
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard context.coordinator.loadedURL != url,
              let textView = scrollView.documentView as? NSTextView else { return }
        context.coordinator.loadedURL = url

        let content = Self.read(url)
        if renderMarkdown {
            let attributes = ConversationDocument.attributes(
                color: NSColor(ConchPalette.textPrimary)
            )
            textView.textStorage?.setAttributedString(
                ConversationDocument.markdown(content, attributes: attributes)
            )
        } else {
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = 3
            textView.textStorage?.setAttributedString(
                NSAttributedString(string: content, attributes: [
                    .font: NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular),
                    .foregroundColor: NSColor(ConchPalette.textPrimary),
                    .paragraphStyle: paragraph,
                ])
            )
        }
    }

    private static func read(_ url: URL) -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            return "Couldn't read \(url.lastPathComponent)."
        }
        defer { try? handle.close() }
        let data = (try? handle.read(upToCount: maxBytes)) ?? Data()
        var text = String(decoding: data, as: UTF8.self)
        if data.count == maxBytes {
            text += "\n\n… truncated at 2MB — open the file for the rest."
        }
        return text
    }
}

private struct DeliverableImageView: NSViewRepresentable {
    let url: URL

    final class Coordinator {
        var loadedURL: URL?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// Fit to WIDTH and scroll vertically. Fitting the whole image scaled a
    /// tall full-page screenshot down to an unreadable thumbnail — the pane's
    /// job is to show the entire deliverable at a size a person can judge.
    /// Images smaller than the pane centre at native size; nothing upscales.
    /// Flipped so the document's origin is the TOP — an unflipped container
    /// opened every tall screenshot scrolled to its bottom.
    private final class FlippedView: NSView {
        override var isFlipped: Bool { true }
    }

    final class FitWidthImageScrollView: NSScrollView {
        let imageView = NSImageView()
        private let container = FlippedView()

        init() {
            super.init(frame: .zero)
            drawsBackground = false
            hasVerticalScroller = true
            imageView.imageScaling = .scaleProportionallyUpOrDown
            container.addSubview(imageView)
            documentView = container
        }

        required init?(coder: NSCoder) { nil }

        override func layout() {
            super.layout()
            guard let image = imageView.image, image.size.width > 0 else { return }
            let paneWidth = contentSize.width
            let targetWidth = min(paneWidth - 36, image.size.width)
            guard targetWidth > 0 else { return }
            let height = targetWidth * image.size.height / image.size.width
            let containerHeight = max(height + 36, contentSize.height)
            container.frame = NSRect(x: 0, y: 0, width: paneWidth, height: containerHeight)
            imageView.frame = NSRect(
                x: (paneWidth - targetWidth) / 2,
                y: (containerHeight - height) / 2,
                width: targetWidth,
                height: height
            )
        }
    }

    func makeNSView(context: Context) -> FitWidthImageScrollView {
        FitWidthImageScrollView()
    }

    func updateNSView(_ view: FitWidthImageScrollView, context: Context) {
        guard context.coordinator.loadedURL != url else { return }
        context.coordinator.loadedURL = url
        view.imageView.image = NSImage(contentsOf: url)
            ?? NSImage(
                systemSymbolName: "photo.badge.exclamationmark",
                accessibilityDescription: nil
            )
        view.needsLayout = true
        view.contentView.scroll(to: .zero)
    }
}

private struct ReviewPressButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(configuration.isPressed ? ConchPalette.hover : .clear)
            )
            .scaleEffect(
                configuration.isPressed && !reduceMotion
                    ? 0.96
                    : 1
            )
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.12),
                value: configuration.isPressed
            )
    }
}
