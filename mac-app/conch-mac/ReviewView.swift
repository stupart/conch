import AppKit
import SwiftUI

struct ReviewItem: Identifiable, Equatable {
    let id: String
    let rowID: String
    let label: String
    let summary: String
    let link: String
    let reviewedAt: TimeInterval?

    init?(row: SessionRow) {
        guard row.status == .review, let review = row.review else {
            return nil
        }

        let link = review.link?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !link.isEmpty else {
            return nil
        }

        rowID = row.id
        label = row.label
        summary = review.summary
        self.link = link
        reviewedAt = review.at
        let timestampIdentity = review.at.map { String($0.bitPattern) } ?? "undated"
        id = [row.id, link, review.summary, timestampIdentity].joined(separator: "\u{1F}")
    }
}

struct ReviewTakeover: View {
    let item: ReviewItem
    let items: [ReviewItem]
    let onSelect: (ReviewItem) -> Void
    let onClose: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isChromeVisible = true
    @State private var isCloseHovered = false
    @State private var isWebLoading = false
    @State private var chromeHideTask: Task<Void, Never>?
    @State private var inputPresentationID = UUID()

    private var selectedIndex: Int {
        items.firstIndex(of: item) ?? 0
    }

    var body: some View {
        ZStack(alignment: .top) {
            ReviewContent(
                link: item.link,
                isWebLoading: $isWebLoading
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            captionBar
                .opacity(isChromeVisible ? 1 : 0)
                .allowsHitTesting(isChromeVisible)
                .zIndex(1)

            loadingIndicator
                .animation(.easeOut(duration: 0.16), value: isWebLoading)
                .zIndex(2)
        }
        .background(ConchPalette.bg)
        .background(
            ReviewInputMonitor(
                presentationID: inputPresentationID,
                onDismiss: onClose,
                onMouseActivity: revealChrome
            )
        )
        .onAppear {
            inputPresentationID = UUID()
            isChromeVisible = true
            scheduleChromeHide()
        }
        .onChange(of: item.id) { _, _ in
            inputPresentationID = UUID()
            revealChrome()
        }
        .onDisappear {
            chromeHideTask?.cancel()
        }
    }

    private var captionBar: some View {
        HStack(spacing: 9) {
            Button(action: onClose) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(ConchPalette.textDim)
                    .frame(width: 40, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(ReviewPressButtonStyle())
            .help("Return to dashboard (Esc)")
            .accessibilityLabel("Return to dashboard")

            Image(systemName: "star.fill")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.statusReview)
                .accessibilityHidden(true)

            Text(item.label)
                .font(ConchTypography.font(size: 12.5, weight: .medium))
                .tracking(-0.3)
                .foregroundStyle(ConchPalette.accent)
                .lineLimit(1)

            Text(item.summary.isEmpty ? "Ready for review" : item.summary)
                .font(ConchTypography.font(size: 12.5))
                .tracking(-0.3)
                .foregroundStyle(ConchPalette.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 12)

            if items.count > 1 {
                Button(action: selectNext) {
                    HStack(spacing: 5) {
                        Text("\(selectedIndex + 1)/\(items.count)")
                            .font(ConchTypography.font(size: 10.5))
                            .tracking(-0.3)
                            .monospacedDigit()

                        Image(systemName: "chevron.right")
                            .font(.system(size: 8, weight: .semibold))
                    }
                    .foregroundStyle(ConchPalette.textDim)
                    .frame(minWidth: 40, minHeight: 40)
                    .contentShape(Rectangle())
                }
                .buttonStyle(ReviewPressButtonStyle())
                .help("Next review")
                .accessibilityLabel(
                    "Review \(selectedIndex + 1) of \(items.count). Show next review."
                )
            }

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(
                        isCloseHovered
                            ? ConchPalette.textPrimary
                            : ConchPalette.textDim
                    )
                    .frame(width: 40, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(ReviewPressButtonStyle())
            .onHover { hovering in
                isCloseHovered = hovering
            }
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.15),
                value: isCloseHovered
            )
            .help("Return to dashboard (Esc)")
            .keyboardShortcut(.cancelAction)
            .accessibilityLabel("Return to dashboard")
        }
        .padding(.leading, 2)
        .padding(.trailing, 2)
        .frame(height: 40)
        .background(ConchPalette.bg.opacity(0.94))
        .contentShape(Rectangle())
        .simultaneousGesture(
            DragGesture(minimumDistance: 12)
                .onEnded { value in
                    let mostlyVertical = abs(value.translation.height) > abs(value.translation.width)
                    if mostlyVertical && value.translation.height > 44 {
                        onClose()
                    }
                }
        )
    }

    @ViewBuilder
    private var loadingIndicator: some View {
        if isWebLoading {
            VStack(spacing: 0) {
                DeliverableLoadingLine()
                Spacer(minLength: 0)
            }
            .transition(.opacity)
            .allowsHitTesting(false)
        }
    }

    private func selectNext() {
        guard items.count > 1 else { return }
        onSelect(items[(selectedIndex + 1) % items.count])
    }

    private func revealChrome() {
        chromeHideTask?.cancel()

        if !isChromeVisible {
            withAnimation(.easeOut(duration: reduceMotion ? 0.10 : 0.18)) {
                isChromeVisible = true
            }
        }

        scheduleChromeHide()
    }

    private func scheduleChromeHide() {
        chromeHideTask?.cancel()
        chromeHideTask = Task { @MainActor in
            do {
                try await Task.sleep(nanoseconds: 2_500_000_000)
            } catch {
                return
            }

            guard !Task.isCancelled else { return }
            isCloseHovered = false
            withAnimation(.easeOut(duration: reduceMotion ? 0.10 : 0.20)) {
                isChromeVisible = false
            }
        }
    }
}

private struct ReviewContent: View {
    let link: String
    @Binding var isWebLoading: Bool

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
            DeliverableWebView(
                link: link,
                isLoading: $isWebLoading
            )
            .background(ConchPalette.bg)
        }
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

    func makeNSView(context: Context) -> NSImageView {
        let imageView = NSImageView()
        imageView.imageAlignment = .alignCenter
        imageView.imageFrameStyle = .none
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.animates = true
        imageView.wantsLayer = true
        imageView.layer?.backgroundColor = NSColor.clear.cgColor
        imageView.layer?.borderWidth = 1
        imageView.layer?.borderColor = NSColor.white.withAlphaComponent(0.10).cgColor
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
