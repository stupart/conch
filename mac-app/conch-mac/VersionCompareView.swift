import AppKit
import ConchDesign
import SwiftUI

/// Which two versions of one artifact the deliverable pane is comparing, in which session, and how.
///
/// Feedback, 2026-10-03: an agent that edited a photo hand-stitched a before/after composite with PIL so the change could
/// be seen at all, though publishing the after under the same `key` already made it the artifact's next version. What
/// was missing was this: the deliverable tab's "N ⌄" menu, or the pane's compare button, puts two versions in the pane
/// together. Transient, like the pane's web address: a comparison is a look, not a place to come back to, so opening a
/// version from the tab strip ends it.
struct DeliverableComparison: Equatable {
    let rowID: String
    var pair: VersionPair
    /// The reader's pick; nil is the content's first (`VersionCompare.mode`).
    var mode: CompareMode?
}

/// Two versions of one artifact in the deliverable pane: a picture with a slider or side by side, a text as its changed
/// lines or side by side, anything else side by side in the pane's own viewer. The rules — which pair, which modes, what
/// each side is called — are ConchDesign's (`VersionCompare`), where they are tested; this lays them out in the window.
struct DeliverableCompareView: View {
    /// Every version of the artifact the session holds, NEWEST FIRST (`DeliverableGroup.versions`).
    let versions: [ReviewItem]
    let pair: VersionPair
    let mode: CompareMode?
    /// What the session changed, for a folder version's tree to mark (`InlineReviewView.changed`).
    let changed: ConchFileChanges
    let onPick: (VersionPair) -> Void
    let onMode: (CompareMode) -> Void
    /// Open one side where it lives, as the pane's arrow does for one deliverable.
    let onOpenInPlace: (ReviewItem) -> Void
    let onClose: () -> Void

    @State private var fraction = CompareSlider.start
    @State private var beforeAddress: String?
    @State private var afterAddress: String?

    private var before: ReviewItem? { versions.first { $0.id == pair.before } }
    private var after: ReviewItem? { versions.first { $0.id == pair.after } }

    private var content: CompareContent {
        guard let before, let after else { return .other }
        return .shared(.of(kind: before.kind, link: before.link), .of(kind: after.kind, link: after.link))
    }

    private var shownMode: CompareMode { VersionCompare.mode(mode, for: content, wide: true) }

    /// "v2": the daemon's number, else its place among those held, oldest 1.
    private func name(_ item: ReviewItem) -> String {
        VersionLabel.number(item.version, place: place(item))
    }

    private func place(_ item: ReviewItem) -> Int {
        versions.count - (versions.firstIndex { $0.id == item.id } ?? 0)
    }

    private func line(_ item: ReviewItem, now: Date) -> String {
        VersionLabel.line(version: item.version, place: place(item), filedAt: item.reviewedAt, summary: item.summary, now: now)
    }

    var body: some View {
        if let before, let after {
            VStack(spacing: 0) {
                // The ages tick on the tab strip's clock, for the same reason: "2h ago" is a claim about now.
                TimelineView(.periodic(from: .now, by: 10)) { timeline in
                    header(before: before, after: after, now: timeline.date)
                }
                Rectangle()
                    .fill(ConchPalette.divider)
                    .frame(height: 1)
                stage(before: before, after: after)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(ConchPalette.surface)
        }
    }

    // MARK: Header

    private func header(before: ReviewItem, after: ReviewItem, now: Date) -> some View {
        HStack(spacing: 8) {
            sidePicker(.before, current: before, other: after, now: now)
            Image(systemName: "arrow.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(ConchPalette.textFaint)
                .accessibilityHidden(true)
            sidePicker(.after, current: after, other: before, now: now)
            Spacer(minLength: 8)
            let modes = VersionCompare.modes(for: content, wide: true)
            if modes.count > 1 {
                Picker("Compare as", selection: Binding(get: { shownMode }, set: onMode)) {
                    ForEach(modes) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .help("How to compare the two versions")
            }
            // No Esc: the dashboard's own Esc releases the selection, and one key doing two things is how a reader
            // loses their place. Named for where it goes, rather than "Done".
            Button("Back to \(name(after))", action: onClose)
                .controlSize(.small)
                .help("Stop comparing, and show \(name(after)) alone")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(ConchPalette.raised)
    }

    /// One side's version, and the menu that changes it. ONE Text with the chevron interpolated: `.borderlessButton`
    /// rebuilds its label as an NSMenuItem does, and dropped an HStack's parts (seen in the tab strip's own menu).
    private func sidePicker(_ side: VersionSide, current: ReviewItem, other: ReviewItem, now: Date) -> some View {
        Menu {
            ForEach(versions) { version in
                Button {
                    if let picked = VersionCompare.pair(version.id, other.id, in: versions.map(\.id)) { onPick(picked) }
                } label: {
                    if version.id == current.id { Image(systemName: "checkmark") }
                    Text(line(version, now: now))
                }
                // A version against itself is no comparison.
                .disabled(version.id == other.id)
            }
        } label: {
            Text("\(side.title): \(line(current, now: now)) \(Image(systemName: "chevron.down"))")
                .font(ConchTypography.font(size: 11.5))
                .foregroundStyle(ConchPalette.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .frame(maxWidth: 320, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .help("\(side.title): \(current.summary) — pick another version")
        .accessibilityLabel("\(side.title): \(line(current, now: now))")
    }

    // MARK: Stage

    @ViewBuilder
    private func stage(before: ReviewItem, after: ReviewItem) -> some View {
        let now = Date()
        if VersionCompare.sharesLink(before.link, after.link) {
            // Both versions are the same file or page, which holds only the newest now: two of it would claim a change
            // that can't be seen. Said, with the one thing there is to show.
            VStack(spacing: 0) {
                SameLinkNote(beforeName: name(before), afterName: name(after), link: after.link ?? "")
                InlineReviewView(item: after, onOpenInPlace: { onOpenInPlace(after) }, liveAddress: $afterAddress, changed: changed)
            }
        } else {
            if content == .image {
                ComparePictures(
                    before: before,
                    after: after,
                    mode: shownMode,
                    fraction: $fraction,
                    names: (name(before), name(after)),
                    lines: (line(before, now: now), line(after, now: now))
                )
            } else if shownMode == .diff {
                CompareTexts(before: before, after: after, names: (name(before), name(after))) {
                    onMode(.sideBySide)
                }
            } else {
                // The pane's own viewer, twice: a page, a PDF, a folder, a video — whatever one version shows alone, each
                // side shows here. Without agent ink: two of them would fight over one canvas.
                VersionPanes(beforeLine: line(before, now: now), afterLine: line(after, now: now), spacing: 12) {
                    pane(before, address: $beforeAddress)
                } after: {
                    pane(after, address: $afterAddress)
                }
                .padding(12)
            }
        }
    }

    private func pane(_ item: ReviewItem, address: Binding<String?>) -> some View {
        InlineReviewView(item: item, onOpenInPlace: { onOpenInPlace(item) }, liveAddress: address, changed: changed, showsInk: false)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ConchPalette.divider, lineWidth: 1))
    }
}

/// Two versions that are one file: said, rather than shown twice.
private struct SameLinkNote: View {
    let beforeName: String
    let afterName: String
    let link: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "doc.on.doc")
                .font(.system(size: 11))
                .foregroundStyle(ConchPalette.textDim)
                .accessibilityHidden(true)
            Text("\(beforeName) and \(afterName) are the same file, \((link as NSString).lastPathComponent), which now holds \(afterName). conch keeps a link to each version, not a copy, so there is no earlier one to compare: the agent can save each version as its own file under one key.")
                .font(ConchTypography.font(size: 11.5))
                .foregroundStyle(ConchPalette.textDim)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ConchPalette.raised)
    }
}

/// Two versions of a picture: a slider over one frame, or each whole side by side. Decoded off the main thread, for
/// the pane rather than whole: a compare fits each picture to the pane, so 3,000 pixels on the long edge is as sharp
/// as a Retina pane gets, and a 30,000-pixel page capture is not decoded to its last row twice.
private struct ComparePictures: View {
    let before: ReviewItem
    let after: ReviewItem
    let mode: CompareMode
    @Binding var fraction: Double
    let names: (before: String, after: String)
    let lines: (before: String, after: String)

    @State private var pictures: (before: CGImage, after: CGImage)?
    @State private var failure: String?

    var body: some View {
        Group {
            if let pictures {
                if mode == .slider {
                    VersionCompareSlider(
                        before: pictures.before,
                        after: pictures.after,
                        beforeName: names.before,
                        afterName: names.after,
                        fraction: $fraction,
                        matte: ConchColor.surface
                    )
                } else {
                    VersionPicturesSideBySide(before: pictures.before, after: pictures.after, beforeLine: lines.before, afterLine: lines.after)
                }
            } else if let failure {
                VersionCompareNotice(symbol: "photo.badge.exclamationmark", title: "Couldn't draw both versions", detail: failure)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: "\(before.id)\u{1F}\(after.id)") { await load() }
    }

    private func load() async {
        pictures = nil
        failure = nil
        let sides = [(names.before, before), (names.after, after)]
        var paths: [String] = []
        for (name, item) in sides {
            switch DeliverableSource(link: item.link ?? "") {
            case let .image(url):
                paths.append(url.path)
            case let .missing(url):
                failure = "\(name) isn't there any more: \(url.path)"
                return
            default:
                failure = "\(name) isn't a picture on this Mac: \(item.link ?? "no link")"
                return
            }
        }
        let decoded = await Task.detached(priority: .userInitiated) { paths.map(Self.decode) }.value
        guard !Task.isCancelled else { return }
        guard let first = decoded[0], let second = decoded[1] else {
            let unread = decoded[0] == nil ? (names.before, paths[0]) : (names.after, paths[1])
            failure = "macOS couldn't read \(unread.0): \(unread.1)"
            return
        }
        pictures = (first, second)
    }

    /// ImageIO for anything it reads; AppKit for the rest (an SVG), rasterised at its own size.
    private static func decode(_ path: String) -> CGImage? {
        if let picture = ConchImage.thumbnail(atPath: path, maxPixelSize: 3_000) { return picture }
        return NSImage(contentsOfFile: path)?.cgImage(forProposedRect: nil, context: nil, hints: nil)
    }
}

/// Two versions of a text as the lines that changed. Read off the main thread, 2MB of each at most — the pane's own
/// limit for a text deliverable — and diffed there too; past `TextDiff`'s bounds it says so and offers side by side.
private struct CompareTexts: View {
    let before: ReviewItem
    let after: ReviewItem
    let names: (before: String, after: String)
    let onSideBySide: () -> Void

    private enum Outcome {
        case loading
        case ready(TextDiff)
        case tooLarge
        case failed(String)
    }

    @State private var outcome = Outcome.loading

    private static let maxBytes = 2 * 1024 * 1024

    var body: some View {
        Group {
            switch outcome {
            case .loading:
                ProgressView().controlSize(.small)
            case let .ready(diff):
                VersionTextDiffView(diff: diff, beforeName: names.before, afterName: names.after)
            case .tooLarge:
                VStack(spacing: 4) {
                    VersionCompareNotice(
                        symbol: "text.page",
                        title: "Too much changed to list line by line",
                        detail: "\(names.before) and \(names.after) differ in more than \(TextDiff.maxChanges) places, or run past \(TextDiff.maxLines) lines."
                    )
                    Button("Show side by side", action: onSideBySide)
                        .padding(.bottom, 24)
                }
            case let .failed(reason):
                VersionCompareNotice(symbol: "doc.badge.ellipsis", title: "Couldn't read both versions", detail: reason)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: "\(before.id)\u{1F}\(after.id)") { await load() }
    }

    private func load() async {
        outcome = .loading
        let sides = [(names.before, before.link), (names.after, after.link)]
        let result = await Task.detached(priority: .userInitiated) { () -> Outcome in
            var texts: [String] = []
            for (name, link) in sides {
                guard let link, let path = Self.localPath(link) else { return .failed("\(name) has no file on this Mac.") }
                do {
                    let data = try Data(contentsOf: URL(fileURLWithPath: path), options: .alwaysMapped)
                    texts.append(String(decoding: data.prefix(Self.maxBytes), as: UTF8.self))
                } catch {
                    return .failed("\(name): \(error.localizedDescription) — \(path)")
                }
            }
            return TextDiff.between(texts[0], texts[1]).map(Outcome.ready) ?? .tooLarge
        }.value
        guard !Task.isCancelled else { return }
        outcome = result
    }

    /// A link as a path on this Mac: a `file:` URL's path, or the path itself with `~` expanded. A web address has none.
    private static func localPath(_ link: String) -> String? {
        if let url = URL(string: link), let scheme = url.scheme?.lowercased() {
            return scheme == "file" ? url.path : nil
        }
        return (link as NSString).expandingTildeInPath
    }
}
