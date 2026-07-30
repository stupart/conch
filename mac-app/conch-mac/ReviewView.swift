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

    private var selectedIndex: Int {
        items.firstIndex(of: item) ?? 0
    }

    var body: some View {
        VStack(spacing: 0) {
            captionBar

            Rectangle()
                .fill(ConchPalette.divider)
                .frame(height: 1)

            ReviewContent(link: item.link)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(ConchPalette.background)
        .background(ReviewInputMonitor(onReveal: onClose))
    }

    private var captionBar: some View {
        HStack(spacing: 10) {
            Text("⭐")
                .font(.system(size: 12))
                .accessibilityHidden(true)

            Text(item.label)
                .fontWeight(.semibold)
                .foregroundStyle(ConchPalette.gold)
                .lineLimit(1)

            Rectangle()
                .fill(ConchPalette.divider)
                .frame(width: 1, height: 13)

            Text(item.summary.isEmpty ? "Ready for review" : item.summary)
                .foregroundStyle(ConchPalette.primary)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 12)

            if items.count > 1 {
                Button(action: selectNext) {
                    HStack(spacing: 5) {
                        Text("\(selectedIndex + 1)/\(items.count)")
                            .monospacedDigit()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8, weight: .bold))
                    }
                    .foregroundStyle(ConchPalette.secondary)
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
                    .foregroundStyle(ConchPalette.secondary)
                    .frame(width: 40, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(ReviewPressButtonStyle())
            .help("Return to dashboard (Esc)")
            .keyboardShortcut(.cancelAction)
            .accessibilityLabel("Return to dashboard")
        }
        .font(.system(size: 11, weight: .regular, design: .monospaced))
        .padding(.leading, 13)
        .padding(.trailing, 2)
        .frame(height: 40)
        .background(ConchPalette.raised)
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

    private func selectNext() {
        guard items.count > 1 else { return }
        onSelect(items[(selectedIndex + 1) % items.count])
    }
}

private struct ReviewContent: View {
    let link: String

    var body: some View {
        switch DeliverableSource(link: link) {
        case let .image(url):
            DeliverableImageView(url: url)
                .padding(18)
                .background(ConchPalette.background)
        case .web:
            DeliverableWebView(link: link)
                .background(ConchPalette.background)
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
            ?? NSImage(systemSymbolName: "photo.badge.exclamationmark", accessibilityDescription: nil)
    }
}

private struct ReviewPressButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(configuration.isPressed ? Color.white.opacity(0.055) : .clear)
            )
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
