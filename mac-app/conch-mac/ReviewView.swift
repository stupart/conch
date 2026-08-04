import AppKit
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
        case .web:
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

private enum DeliverableSource {
    case image(URL)
    case web

    private static let imageExtensions = Set([
        "png", "jpg", "jpeg", "gif", "webp", "svg",
    ])

    init(link: String) {
        if let url = URL(string: link),
           let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            self = .web
            return
        }

        let localURL = Self.localFileURL(for: link)
        if Self.imageExtensions.contains(localURL.pathExtension.lowercased()) {
            self = .image(localURL)
        } else {
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

private struct DeliverableImageView: NSViewRepresentable {
    let url: URL

    final class Coordinator {
        var loadedURL: URL?
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    /// NSImageView reports the image's NATIVE size as its intrinsic size, so a
    /// screenshot-sized deliverable laid out larger than the pane and got
    /// clipped — and shoved the header around on its way. Claiming no intrinsic
    /// size lets SwiftUI size it to the pane, which is what makes
    /// `scaleProportionallyUpOrDown` actually fit instead of crop.
    final class FittingImageView: NSImageView {
        override var intrinsicContentSize: NSSize {
            NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
        }
    }

    func makeNSView(context: Context) -> NSImageView {
        let imageView = FittingImageView()
        imageView.setContentHuggingPriority(.defaultLow, for: .horizontal)
        imageView.setContentHuggingPriority(.defaultLow, for: .vertical)
        imageView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        imageView.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        imageView.imageAlignment = .alignCenter
        imageView.imageFrameStyle = .none
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.animates = true
        imageView.wantsLayer = true
        imageView.layer?.backgroundColor = NSColor.clear.cgColor
        // No border: a deliverable is usually a screenshot that already carries
        // its own window chrome, so framing it again reads as a frame in a frame.
        return imageView
    }

    func updateNSView(_ imageView: NSImageView, context: Context) {
        guard context.coordinator.loadedURL != url else { return }
        context.coordinator.loadedURL = url
        imageView.image = NSImage(contentsOf: url)
            ?? NSImage(
                systemSymbolName: "photo.badge.exclamationmark",
                accessibilityDescription: nil
            )
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
