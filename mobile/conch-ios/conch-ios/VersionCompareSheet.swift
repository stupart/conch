import ConchDesign
import SwiftUI

/// Two versions of one artifact in the review sheet: a before and an after.
///
/// Feedback, 2026-10-03: an agent that edited a photo hand-stitched a before/after composite with PIL so the change could
/// be seen at all, though publishing the after under the same `key` already made it the artifact's next version. This is
/// the phone's look at two of them, from the sheet's "Compare with…" menu: a picture with a slider or side by side (the
/// same views the Mac draws, in ConchDesign), a text as the lines that changed, and anything else one at a time, a tap
/// apart — there is no room on a phone for two pages. Both files come over the bridge's `/file`, as one deliverable does.
struct VersionCompareSheet: View {
    @ObservedObject var bridge: BridgeClient
    let before: PublishedState.Row.Review
    let after: PublishedState.Row.Review
    /// The session the versions belong to; what a failure is filed under.
    let sessionId: String
    /// "v1", and "v1 · 2h ago — summary", for each side (`VersionLabel`).
    let names: (before: String, after: String)
    let lines: (before: String, after: String)
    @Binding var mode: CompareMode?
    let onClose: () -> Void

    @State private var fraction = CompareSlider.start
    @State private var pictures: (before: CGImage, after: CGImage)?
    @State private var diff: TextDiff?
    @State private var tooLarge = false
    @State private var failure: String?
    /// The side on screen while flipping.
    @State private var flipped = VersionSide.after

    private var content: CompareContent {
        .shared(.of(kind: before.kind, link: before.link), .of(kind: after.kind, link: after.link))
    }

    private var modes: [CompareMode] { VersionCompare.modes(for: content, wide: false) }
    private var shownMode: CompareMode { VersionCompare.mode(mode, for: content, wide: false) }
    private var sameFile: Bool { VersionCompare.sharesLink(before.link, after.link) }

    /// Like the sheet's own review key: the filing, never just the link, since two versions may share one.
    private func key(_ review: PublishedState.Row.Review) -> String {
        ReviewQueue.key(sessionId: sessionId, filedAt: review.at, published: review.id)
    }

    var body: some View {
        VStack(spacing: 0) {
            controls
            Rectangle()
                .fill(Palette.divider)
                .frame(height: 1)
            stage
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Palette.bg)
        .task(id: "\(key(before))\u{1F}\(key(after))") { await load() }
    }

    // MARK: Controls

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                if sameFile {
                    Text("Same file")
                        .font(Type.label(15, weight: .semibold))
                        .foregroundStyle(Palette.textPrimary)
                } else if shownMode == .flip {
                    // One at a time: which one is the control.
                    Picker("Version", selection: $flipped) {
                        Text("Before · \(names.before)").tag(VersionSide.before)
                        Text("After · \(names.after)").tag(VersionSide.after)
                    }
                    .pickerStyle(.segmented)
                } else if modes.count > 1 {
                    Picker("Compare as", selection: Binding(get: { shownMode }, set: { mode = $0 })) {
                        ForEach(modes) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                Spacer(minLength: 0)
                // Not "Done": the sheet's own Done sits just above it, and closes the sheet.
                Button("Back to \(names.after)", action: onClose)
                    .font(Type.label(15, weight: .semibold))
                    .foregroundStyle(Palette.micOpen)
                    .frame(minHeight: 44)
                    .accessibilityLabel("Stop comparing, back to \(names.after)")
            }
            // Text that flips can go back to its changes from here, where the segmented control is the sides.
            if shownMode == .flip, modes.contains(.diff) {
                Button { mode = .diff } label: {
                    Label("Show the changed lines", systemImage: CompareMode.diff.symbol)
                        .font(Type.caption)
                }
                .foregroundStyle(Palette.micOpen)
            }
            // Side by side captions each picture itself; twice over, the same words read as clutter.
            if sameFile || shownMode != .sideBySide {
                VersionCaption(.before, line: lines.before)
                VersionCaption(.after, line: lines.after)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    // MARK: Stage

    @ViewBuilder
    private var stage: some View {
        if sameFile {
            VStack(spacing: 0) {
                Text("\(names.before) and \(names.after) are the same file, which now holds \(names.after). conch keeps a link to each version, not a copy, so there is no earlier one to compare.")
                    .font(Type.caption)
                    .foregroundStyle(Palette.textDim)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                DeliverableSheet(bridge: bridge, review: after, sessionId: sessionId)
                    .id(key(after))
            }
        } else if let failure {
            VersionCompareNotice(symbol: "exclamationmark.triangle", title: "Couldn't compare them", detail: failure)
        } else if shownMode == .flip {
            // The sheet's own viewer for the side picked: every kind it draws, drawn here.
            DeliverableSheet(bridge: bridge, review: flipped == .before ? before : after, sessionId: sessionId)
                .id(key(flipped == .before ? before : after))
        } else if content == .image {
            if let pictures {
                if shownMode == .slider {
                    VersionCompareSlider(
                        before: pictures.before,
                        after: pictures.after,
                        beforeName: names.before,
                        afterName: names.after,
                        fraction: $fraction
                    )
                    .padding(12)
                } else {
                    VersionPicturesSideBySide(before: pictures.before, after: pictures.after, beforeLine: lines.before, afterLine: lines.after)
                        .padding(12)
                }
            } else {
                ProgressView()
            }
        } else if tooLarge {
            VStack(spacing: 4) {
                VersionCompareNotice(
                    symbol: "text.page",
                    title: "Too much changed to list line by line",
                    detail: "Flip between \(names.before) and \(names.after) instead."
                )
                Button("Flip between them") { mode = .flip }
                    .foregroundStyle(Palette.micOpen)
                    .padding(.bottom, 24)
            }
        } else if let diff {
            VersionTextDiffView(diff: diff, beforeName: names.before, afterName: names.after)
        } else {
            ProgressView()
        }
    }

    // MARK: Loading

    /// Both files, fetched as a deliverable is (`BridgeClient.downloadFile`), read, and let go of: a picture decoded for a
    /// phone's screen, a text read to 2MB and diffed. Off the main thread, both.
    private func load() async {
        pictures = nil
        diff = nil
        tooLarge = false
        failure = nil
        guard !sameFile, content != .other else { return }
        var files: [URL] = []
        defer { for file in files { try? FileManager.default.removeItem(at: file) } }
        for (name, review) in [(names.before, before), (names.after, after)] {
            guard let link = review.link else {
                return fail("\(name) has no file to fetch.")
            }
            guard let file = await bridge.downloadFile(path: link) else {
                return fail("Couldn't fetch \(name) from your Mac: \(bridge.lastError ?? "it sent nothing back.")")
            }
            files.append(file)
            if Task.isCancelled { return }
        }
        let paths = files.map(\.path)
        if content == .image {
            let decoded = await Task.detached(priority: .userInitiated) {
                paths.map { ConchImage.thumbnail(atPath: $0, maxPixelSize: 2_400) }
            }.value
            guard !Task.isCancelled else { return }
            guard let first = decoded[0], let second = decoded[1] else {
                return fail("iPhone couldn't draw \(decoded[0] == nil ? names.before : names.after) as a picture.")
            }
            pictures = (first, second)
        } else {
            let result = await Task.detached(priority: .userInitiated) { () -> TextDiff? in
                let texts = paths.map { path in
                    let data = (try? Data(contentsOf: URL(fileURLWithPath: path), options: .alwaysMapped)) ?? Data()
                    return String(decoding: data.prefix(2 * 1024 * 1024), as: UTF8.self)
                }
                return TextDiff.between(texts[0], texts[1])
            }.value
            guard !Task.isCancelled else { return }
            if let result { diff = result } else { tooLarge = true }
        }
    }

    /// Said where the comparison would be, with the files' paths on the Mac, and filed there as `open-deliverable` (A13).
    private func fail(_ reason: String) {
        let message = "\(reason) — \(before.link ?? "") and \(after.link ?? "")"
        failure = message
        Task { await bridge.reportAppError(operation: "open-deliverable", message: message, sessionId: sessionId) }
    }
}
