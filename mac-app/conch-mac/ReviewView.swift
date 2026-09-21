import AppKit
import ConchDesign
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
    /// The one thing the agent asked you to check there (`scene.inspect`), for the Ready pill's tooltip.
    let inspect: String?
    /// Waiting to be looked at: the deliverable stays on a working row, but a
    /// session that went back to work is not waiting on you.
    let isReady: Bool
    /// When it was looked at, as the daemon remembers it — on any device. Nil means nobody
    /// has, or that this daemon is too old to know (`features.viewedState`).
    let viewedAt: Double?

    init?(row: SessionRow) {
        guard let review = row.review else {
            return nil
        }
        self.init(row: row, review: review)
    }

    /// One of the several a session may hold, rather than only its newest.
    init(row: SessionRow, review: ReviewInfo) {
        rowID = row.id
        label = row.label
        summary = review.summary
        let link = review.link?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.link = link.isEmpty ? nil : link
        reviewedAt = review.at
        inspect = review.inspect
        isReady = row.status != .working
        viewedAt = review.viewedAt
        // The identity the daemon minted when it filed this deliverable, which it carries
        // unchanged through every later event — so this id moves only when a NEWER deliverable
        // replaces this one. Everything keyed on it (the pane, the row pulse, the
        // notification) relies on that. An older daemon sends none and the old key stands in.
        id = ReviewIdentity.key(published: review.id, sessionId: row.id, filedAt: review.at)
    }
}

struct InlineReviewView: View {
    let item: ReviewItem
    /// Takes the address the pane is actually showing, when it has one.
    let onOpenInPlace: (String?) -> Void

    @State private var isWebLoading = false
    @State private var liveAddress: String?

    var body: some View {
        ReviewSurface(
            item: item,
            // The arrow OUT, not a bigger box. This control used to swap between filling the
            // conch window and sharing it, which meant the deliverable had no way to reach the
            // thing it actually is — a page in a browser, a file in its own app. Tyler: "maybe
            // we add some sort of arrow type thing u can click on that brings you to the
            // artifact 'in the wild'". It no longer depends on the stage at all, so it says one
            // thing and does one thing.
            actionSymbol: "arrow.up.forward.app",
            actionHelp: "Open where it lives (⌘3)",
            actionAccessibilityLabel: "Open the deliverable where it lives",
            // The page you are LOOKING AT, not the one that was filed. "Open in browser" sat
            // one row below doing exactly this while the arrow opened the original link, so the
            // two controls looked like duplicates and quietly disagreed. One control now.
            action: item.link == nil ? nil : { onOpenInPlace(liveAddress) },
            isWebLoading: $isWebLoading,
            liveAddress: $liveAddress
        )
    }
}

private struct ReviewSurface: View {
    let item: ReviewItem
    let actionSymbol: String
    let actionHelp: String
    let actionAccessibilityLabel: String
    let action: (() -> Void)?
    @Binding var isWebLoading: Bool
    @Binding var liveAddress: String?

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                if let link = item.link {
                    ReviewContent(
                        link: link,
                        rowID: item.rowID,
                        isWebLoading: $isWebLoading,
                        liveAddress: $liveAddress
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
        .background(ConchPalette.surface)
        .overlay(alignment: .topTrailing) { stageControl }
    }

    /// The stage control, and nothing else.
    ///
    /// There was a bar here: a review check, the session's name in brand cyan, and the summary
    /// again — three restatements of what the pane already is, above a picture of the work.
    /// Tyler: "please also remove the weird bar element that ahows above the deliverables ... i
    /// don't get what its for an it adds clutter / jank", which is the same note that took the
    /// inline card down to a picture and one line ("little or no text").
    ///
    /// What each part was saying, and why none of it earns a bar: the check duplicated the ledger
    /// row's own mark; the session label duplicated the header above the pane; the summary
    /// duplicated the card in the conversation that opened this. The control is the one thing that
    /// was not a restatement, so it stays — it is the only way to reach side-by-side and fill-the-
    /// stage with a mouse (both also on Cmd-2 and Cmd-3).
    ///
    /// NOT the origin bar below this, which looks similar and is not decoration: a deliverable is
    /// an agent-authored URL rendered full-bleed in conch's own chrome, so naming the origin is
    /// what keeps a third-party sign-in page distinguishable from conch's UI.
    @ViewBuilder
    private var stageControl: some View {
        if let action {
            Button(action: action) {
                Image(systemName: actionSymbol)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(ConchPalette.textDim)
                    .frame(width: 28, height: 28)
                    .background(
                        Circle().fill(ConchPalette.raised.opacity(0.92))
                    )
                    .overlay(
                        Circle().strokeBorder(ConchPalette.divider, lineWidth: 0.5)
                    )
                    .contentShape(Circle())
            }
            .buttonStyle(ReviewPressButtonStyle())
            .help(actionHelp)
            .accessibilityLabel(actionAccessibilityLabel)
            .padding(10)
        }
    }
}

/// The session's working folder: the tree on the left, the file you picked on the right.
///
/// Not a Finder in a pane. conch knows the one thing Finder cannot — which of these files this
/// session just changed — so the folders holding the work are marked before you open anything,
/// and the path to it is visible rather than hunted for. That is the whole reason this is here
/// and not a "reveal in Finder" button.
///
/// The right-hand side is `ReviewContent`, unchanged: it already turns ANY path into the right
/// renderer — image, PDF, markdown, text, video, or the web view — so picking a file in the
/// tree is exactly the same act as opening a deliverable, and there is no second viewer to
/// keep in step with the first.
struct WorkspaceFilesView: View {
    /// The session's working folder. Nothing is drawn above it: this is a session's workspace,
    /// not a file browser, and the folder it runs in is the whole of it.
    let root: String
    let rowID: String
    let changed: ConchFileChanges

    /// Folders read once, when opened, and kept.
    ///
    /// The disk is NOT read from `body`. A listing in the render path runs again on every
    /// unrelated state change — a keystroke in the composer, a snapshot from the daemon — and
    /// stutters the very scroll it is drawing.
    @State private var listings: [String: [ConchFileEntry]] = [:]
    @State private var expanded: Set<String> = []
    @State private var selected: String?
    @State private var isWebLoading = false

    private static let railWidth: CGFloat = 232

    private var rows: [ConchFileRow] {
        ConchFileTree.rows(root: root, listings: listings, expanded: expanded)
    }

    var body: some View {
        HStack(spacing: 0) {
            rail
                .frame(width: Self.railWidth)
                // `raised`, never `bg`. Nothing inside the stage repaints the WINDOW ground:
                // the pane is a panel sitting on that ground, and painting it again in here
                // punches a hole in the panel — the "right shape, wrong colour" §3 fixed once
                // already, and which `mac-phase1-source` pins for this whole file.
                //
                // In light mode `raised` and `surface` are the same white, so the rail is told
                // apart by the hairline beside it rather than by its fill — exactly how the
                // origin bar below already behaves.
                .background(ConchPalette.raised)

            Rectangle()
                .fill(ConchPalette.divider)
                .frame(width: 1)

            Group {
                if let selected {
                    // No header arrow in this pane, so nothing consumes the live address.
                    ReviewContent(
                        link: selected,
                        rowID: rowID,
                        isWebLoading: $isWebLoading,
                        liveAddress: .constant(nil)
                    )
                        .id(selected)
                } else {
                    nothingPicked
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(ConchPalette.surface)
        .onAppear(perform: loadRoot)
        .onChange(of: root) { _, _ in
            listings = [:]
            expanded = []
            selected = nil
            loadRoot()
        }
    }

    private var rail: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { row in
                    FileRowView(
                        row: row,
                        isSelected: selected == row.entry.path,
                        isOpen: expanded.contains(row.entry.path),
                        isChanged: changed.changed(row.entry),
                        holdsChanges: changed.contains(row.entry),
                        action: { pick(row.entry) }
                    )
                }
            }
            .padding(.vertical, ConchSpace.x1)
        }
    }

    private var nothingPicked: some View {
        VStack(spacing: 9) {
            Image(systemName: "sidebar.squares.left")
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(ConchPalette.textFaint)
            Text("Pick a file to read it here.")
                .font(ConchTypography.font(size: 12.5))
                .foregroundStyle(ConchPalette.textDim)
            if !changed.isEmpty {
                // The marks are the point, so say what they mean once, where someone who has
                // not opened anything yet will actually read it.
                Text("A dot marks what this session changed.")
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.textFaint)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ConchPalette.surface)
    }

    private func pick(_ entry: ConchFileEntry) {
        guard entry.isDirectory else {
            selected = entry.path
            return
        }
        if expanded.contains(entry.path) {
            expanded.remove(entry.path)
        } else {
            expanded.insert(entry.path)
            load(entry.path)
        }
    }

    private func loadRoot() {
        guard !root.isEmpty else { return }
        load(ConchFileTree.standardized(root))
    }

    /// Listed off the main thread, because a cold folder on a network or a spinning disk takes
    /// long enough to drop frames, and this runs while the pane is already on screen.
    private func load(_ directory: String) {
        guard listings[directory] == nil else { return }
        Task.detached(priority: .userInitiated) {
            let children = ConchFileTree.children(of: directory)
            await MainActor.run { listings[directory] = children }
        }
    }
}

/// One line of the tree.
private struct FileRowView: View {
    let row: ConchFileRow
    let isSelected: Bool
    let isOpen: Bool
    let isChanged: Bool
    let holdsChanges: Bool
    let action: () -> Void

    @State private var isHovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                // The chevron turns rather than swapping glyph: one control that moves is
                // easier to follow than two that replace each other. `pop` because the tokens
                // say small things bounce more.
                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(ConchPalette.textFaint)
                    .rotationEffect(.degrees(isOpen ? 90 : 0))
                    .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: isOpen)
                    .frame(width: 10)
                    .opacity(row.entry.isDirectory ? 1 : 0)

                Image(systemName: row.entry.isDirectory ? "folder" : "doc")
                    .font(.system(size: 10))
                    .foregroundStyle(isChanged ? ConchPalette.statusReview : ConchPalette.textFaint)
                    .frame(width: 13)

                Text(row.entry.name)
                    .font(ConchTypography.font(size: 11.5, weight: isChanged ? .medium : .regular))
                    .foregroundStyle(isChanged || isSelected ? ConchPalette.textPrimary : ConchPalette.textDim)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer(minLength: 4)

                // Two strengths, on purpose. A file the session edited is the claim; a folder
                // merely CONTAINING one is the route to it, and must not shout as loudly or
                // every folder from the root down reads as edited.
                if isChanged || holdsChanges {
                    Circle()
                        .fill(ConchPalette.statusReview)
                        .opacity(isChanged ? 1 : 0.35)
                        .frame(width: 5, height: 5)
                        .accessibilityHidden(true)
                }
            }
            .padding(.leading, ConchSpace.x2 + CGFloat(row.depth) * ConchSpace.x3)
            .padding(.trailing, ConchSpace.x2)
            .frame(height: 22)
            .background(
                RoundedRectangle(cornerRadius: ConchRadius.small, style: .continuous)
                    .fill(isSelected ? ConchPalette.selection : (isHovered ? ConchPalette.hover : .clear))
                    .padding(.horizontal, ConchSpace.x1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(row.entry.path)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        var said = row.entry.name
        if row.entry.isDirectory { said += isOpen ? ", open folder" : ", folder" }
        if isChanged { said += ", changed by this session" }
        else if holdsChanges { said += ", holds changed files" }
        return said
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
        .background(ConchPalette.surface)
    }
}

private struct ReviewContent: View {
    let link: String
    /// The session this deliverable belongs to; what an open failure is filed under.
    let rowID: String

    /// Scheme + host together: on a bar whose job is marking a trust boundary,
    /// http:// and https:// must not look alike.
    /// Where the user asked to go, if they typed somewhere. Nil means the filed deliverable.
    @State private var destination: String?
    /// Where the web view actually is, reported by WebKit.
    @State private var liveLink: String?
    @State private var addressDraft = ""

    /// What the pane is showing: a typed destination wins over the filed link.
    private var shownLink: String { destination ?? link }

    /// The address as it should READ — the live url when WebKit has one, else what we asked
    /// for. Derived from the live value on purpose: the pane can now navigate anywhere, so a
    /// bar computed from the filed link would name the wrong origin the moment you moved.
    private var addressText: String { liveLink ?? shownLink }

    private var originText: String {
        guard let url = URL(string: addressText), let host = url.host else { return addressText }
        guard let scheme = url.scheme else { return host }
        return scheme + "://" + host
    }

    /// A typed address, made into something loadable.
    ///
    /// NOT `DeliverableLink.url(for:)`: that turns a schemeless string into a FILE path, so
    /// "github.com" would have been read as a file on this Mac. Typed text is a web address.
    static func webDestination(from typed: String) -> String? {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() {
            return (scheme == "http" || scheme == "https") ? trimmed : nil
        }
        return "https://" + trimmed
    }
    @Binding var isWebLoading: Bool
    /// Where this pane is NOW, published upward so the header's arrow can open the page you
    /// are looking at rather than the one that was filed. The pane browses, so those diverge
    /// the moment you follow a link or type an address — and the arrow used to ignore it.
    @Binding var liveAddress: String?
    @State private var navigationFailure: DeliverableNavigationFailure?
    @State private var reloadID = UUID()
    @EnvironmentObject private var store: StateStore
    /// A link or file this pane could not open, in the OS's own words with
    /// the resolved target, shown here rather than as a Finder alert (A13).
    @State private var linkFailure: String?

    var body: some View {
        content.overlay(alignment: .bottom) { LinkFailureLine(message: $linkFailure) }
    }

    /// Every open from this pane goes through the one door that reports
    /// (A13); `cwd` is the document's own folder for a link inside a rendered
    /// deliverable, which is what its author meant a relative link against.
    private func open(_ link: String, cwd: String? = nil, reveal: Bool = false) {
        linkFailure = nil
        store.openLink(link, cwd: cwd, rowId: rowID, reveal: reveal) { linkFailure = $0 }
    }

    /// A deliverable this pane could not show: macOS's reason and the path,
    /// on the pane's failure line, filed as `open-deliverable` (A13). Text
    /// said "Couldn't read X." with no reason, an image showed only an
    /// icon, a PDF stayed empty and a video failed silently.
    private func loadFailed(_ url: URL, _ error: Error) {
        linkFailure = "\(error.localizedDescription) — \(url.path)"
        store.reportAppError(
            operation: "open-deliverable",
            message: error.localizedDescription,
            sessionId: rowID,
            state: ["target": url.path]
        )
    }

    @ViewBuilder
    private var content: some View {
        switch DeliverableSource(link: link) {
        case let .image(url):
            DeliverableImageView(url: url, onFailure: { loadFailed(url, $0) })
                .padding(18)
                .background(ConchPalette.surface)
                .onAppear {
                    isWebLoading = false
                }
        case let .video(url):
            DeliverableVideoView(url: url, onFailure: { loadFailed(url, $0) })
                .background(ConchPalette.surface)
                .onAppear {
                    isWebLoading = false
                }
        case let .pdf(url):
            DeliverablePDFView(url: url, onFailure: { loadFailed(url, $0) })
                .background(ConchPalette.surface)
                .onAppear {
                    isWebLoading = false
                }
        case let .markdown(url):
            DeliverableDocumentView(url: url, renderMarkdown: true, onFailure: { loadFailed(url, $0) }) { link in
                open(link, cwd: url.deletingLastPathComponent().path)
            }
                .background(ConchPalette.surface)
                .onAppear {
                    isWebLoading = false
                }
        case let .text(url):
            DeliverableDocumentView(url: url, renderMarkdown: false, onFailure: { loadFailed(url, $0) })
                .background(ConchPalette.surface)
                .onAppear {
                    isWebLoading = false
                }
        case let .unsupported(url):
            // A limitation stated plainly, not WebKit's "Frame load
            // interrupted" — which looked like conch had broken.
            VStack(spacing: 10) {
                Image(systemName: url.hasDirectoryPath ? "folder" : "doc.zipper")
                    .font(.system(size: 22, weight: .regular))
                    .foregroundStyle(ConchPalette.textDim)
                Text(url.hasDirectoryPath
                     ? "\(url.lastPathComponent) is a folder"
                     : "conch can't preview a \(url.pathExtension.uppercased())")
                    .font(ConchTypography.font(size: 14, weight: .medium))
                    .foregroundStyle(ConchPalette.textPrimary)
                Text("It's on this Mac — open it in Finder to look inside.")
                    .font(ConchTypography.font(size: 12))
                    .foregroundStyle(ConchPalette.textDim)
                Text(url.path)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ConchPalette.textDim)
                    .textSelection(.enabled)
                Button("Reveal in Finder") { open(url.path, reveal: true) }
                .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(ConchPalette.surface)
            .onAppear { isWebLoading = false }
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
            .background(ConchPalette.surface)
            .onAppear {
                isWebLoading = false
                // Said above, and filed too (A13), with the path it looked for.
                store.reportAppError(
                    operation: "open-deliverable",
                    message: "Couldn't find \(url.lastPathComponent)",
                    sessionId: rowID,
                    state: ["target": url.path]
                )
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
                    // An address, not a label: the pane browses now, so this is both where
                    // you are and where you can go. It still names the origin first — that is
                    // what keeps a third-party page from reading as conch's own UI.
                    TextField(originText, text: $addressDraft)
                        .textFieldStyle(.plain)
                        .font(ConchTypography.font(size: 11))
                        .lineLimit(1)
                        .onSubmit {
                            guard let target = Self.webDestination(from: addressDraft) else { return }
                            navigationFailure = nil
                            isWebLoading = true
                            destination = target
                            // The typed target directly: `addressText` still reads the old
                            // `liveLink` until WebKit reports the new one.
                            liveAddress = target
                        }
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
                    link: shownLink,
                    reloadID: reloadID,
                    isLoading: $isWebLoading,
                    currentLink: $liveLink,
                    onNavigationFailure: { failure in
                        navigationFailure = failure
                    }
                )
                // The field follows the page: a redirect, or a link followed inside it, moves
                // where you are without anyone typing.
                .onChange(of: liveLink) { _, here in
                    if let here { addressDraft = here }
                    liveAddress = addressText
                }
                .onAppear {
                    addressDraft = addressText
                    liveAddress = addressText
                }

                // WKWebView paints the document white until the page's own
                // background lands, so a remote deliverable flashed a blinding
                // white rectangle for several seconds inside a dark app. Cover
                // it until the load settles. Failure states set isLoading false
                // too, so this can't strand the pane behind a permanent cover.
                if isWebLoading, navigationFailure == nil {
                    ConchPalette.surface
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
                        onOpenInBrowser: { open(failure.url.absoluteString) }
                    )
                }
                }
            }
            .background(ConchPalette.surface)
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
        .background(ConchPalette.surface)
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
    case unsupported(URL)
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
    // Nothing can render these, and WebKit fails them with "Frame load
    // interrupted" — jargon that reads as a crash rather than a limitation.
    // Naming the type is the whole difference between "conch is broken" and
    // "conch can't show a zip".
    private static let unpreviewableExtensions = Set([
        "zip", "gz", "tar", "tgz", "dmg", "pkg", "app", "bin", "exe",
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
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: localURL.path, isDirectory: &isDirectory)
        if !exists {
            self = .missing(localURL)
            return
        }
        // A FOLDER is a real thing to hand over — Tyler filed a review pointing
        // at /tmp/deliverable-shots and got nothing, because a directory has no
        // extension, fell through to the web view, and WebKit refused it. It is
        // not missing and it is not broken; there is simply nothing to render,
        // and the useful action is to open it.
        if isDirectory.boolValue {
            self = .unsupported(localURL)
            return
        }
        switch localURL.pathExtension.lowercased() {
        case let ext where Self.imageExtensions.contains(ext):
            self = .image(localURL)
        case "pdf":
            self = .pdf(localURL)
        case let ext where Self.unpreviewableExtensions.contains(ext):
            self = .unsupported(localURL)
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

/// Why macOS could not show a deliverable that exists (A13). The renderers
/// answer nil, never why: this is the OS's own reason the file cannot be
/// read — permission, a vanished file — or, when the bytes read fine,
/// Foundation's "isn't in the correct format" for bytes the renderer refused.
///
/// Foundation only, on purpose: `test/open-link.test.ts` extracts this enum
/// and runs it under `swift`.
enum DeliverableLoadError {
    static func reason(_ url: URL) -> Error {
        do { _ = try Data(contentsOf: url, options: .alwaysMapped) } catch { return error }
        return CocoaError(.fileReadCorruptFile, userInfo: [NSURLErrorKey: url])
    }
}

/// A video deliverable with real transport controls.
///
/// These used to fall through to the web view, which plays some codecs and
/// silently refuses others — so support was luck. AVKit gives scrubbing,
/// volume and fullscreen, and fails loudly when it cannot decode.
private struct DeliverableVideoView: NSViewRepresentable {
    let url: URL
    let onFailure: (Error) -> Void

    final class Coordinator {
        /// Held for the item's life: AVPlayer reports a file it cannot play
        /// only through the item's status, and nothing read it (A13).
        var status: NSKeyValueObservation?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    private func player(_ coordinator: Coordinator) -> AVPlayer {
        let item = AVPlayerItem(url: url)
        let onFailure = onFailure
        coordinator.status = item.observe(\.status) { item, _ in
            guard item.status == .failed, let error = item.error else { return }
            DispatchQueue.main.async { onFailure(error) }
        }
        return AVPlayer(playerItem: item)
    }

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.controlsStyle = .inline
        view.videoGravity = .resizeAspect
        view.player = player(context.coordinator)
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
        // Only replace the player for a NEW video. Rebuilding it on every daemon
        // publication would reset the person's playback position and volume.
        if (view.player?.currentItem?.asset as? AVURLAsset)?.url != url {
            view.player = player(context.coordinator)
        }
    }
}

/// A PDF deliverable, whole and scrollable — WKWebView happened to preview
/// PDFs, but PDFKit gives continuous scroll, fit-to-width, and Select/Copy.
private struct DeliverablePDFView: NSViewRepresentable {
    let url: URL
    let onFailure: (Error) -> Void

    final class Coordinator {
        var loadedURL: URL?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displaysPageBreaks = true
        view.backgroundColor = NSColor(ConchPalette.surface)
        return view
    }

    func updateNSView(_ view: PDFView, context: Context) {
        // Once per file: comparing documentURL — nil after a failure — would
        // retry and re-file the failure on every publication.
        guard context.coordinator.loadedURL != url else { return }
        context.coordinator.loadedURL = url
        view.document = PDFDocument(url: url)
        // PDFKit answers nil, never why; an empty pane was the whole report.
        if view.document == nil {
            let error = DeliverableLoadError.reason(url)
            DispatchQueue.main.async { onFailure(error) }
        }
    }
}

/// A markdown or plain-text deliverable rendered natively, dark and complete.
/// These used to fall into the WKWebView: markdown showed its raw syntax and
/// text files painted a white system page inside a dark app.
private struct DeliverableDocumentView: NSViewRepresentable {
    let url: URL
    let renderMarkdown: Bool
    /// Why the file could not be read, in macOS's words (A13).
    let onFailure: (Error) -> Void
    /// A link inside the rendered document, clicked. NSTextView's own fallback
    /// is a silent `NSWorkspace.open` — exactly the dead click A13 is about.
    var onOpenLink: (String) -> Void = { _ in }

    /// Deliverables are files an agent just produced, but an unbounded read is
    /// still an unbounded read. 2MB of text is far past what a review is for.
    private static let maxBytes = 2 * 1024 * 1024

    final class Coordinator: NSObject, NSTextViewDelegate {
        var loadedURL: URL?
        var onOpenLink: (String) -> Void = { _ in }

        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            onOpenLink(LinkTarget.text(of: link))
            return true
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true

        let textView = NSTextView()
        // TextKit 1, up front: `NSTextView()` starts on TextKit 2, which has no `NSTextTable`, and a rendered
        // document's tables are `NSTextTable`s (TranscriptFallback.swift says the same, for the same reason).
        _ = textView.layoutManager
        textView.drawsBackground = false
        textView.isEditable = false
        textView.isSelectable = true
        textView.delegate = context.coordinator
        textView.textContainerInset = NSSize(width: 24, height: 20)
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.onOpenLink = onOpenLink
        guard context.coordinator.loadedURL != url,
              let textView = scrollView.documentView as? NSTextView else { return }
        context.coordinator.loadedURL = url

        let content: String
        do {
            content = try Self.read(url)
        } catch {
            content = ""
            DispatchQueue.main.async { onFailure(error) }
        }
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

    /// Mapped, so only the pages the 2MB prefix touches are read — and its
    /// error is Foundation's "you don't have permission to view it", where
    /// FileHandle's says "to save" (A13).
    private static func read(_ url: URL) throws -> String {
        let data = try Data(contentsOf: url, options: .alwaysMapped)
        var text = String(decoding: data.prefix(maxBytes), as: UTF8.self)
        if data.count > maxBytes {
            text += "\n\n… truncated at 2MB — open the file for the rest."
        }
        return text
    }
}

private struct DeliverableImageView: NSViewRepresentable {
    let url: URL
    let onFailure: (Error) -> Void

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
        let image = NSImage(contentsOf: url)
        // The icon alone said nothing; macOS's reason and the path do (A13).
        if image == nil {
            let error = DeliverableLoadError.reason(url)
            DispatchQueue.main.async { onFailure(error) }
        }
        view.imageView.image = image
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

/// A link that would not open: the OS's own words and the resolved target,
/// in the pane where the click happened (A13). Selectable, so the path can be
/// copied into a report; dismissable, so it does not outlive its usefulness.
struct LinkFailureLine: View {
    @Binding var message: String?

    var body: some View {
        if let message {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ConchPalette.statusNeeds)
                    .accessibilityHidden(true)
                Text(message)
                    .font(ConchTypography.font(size: 12))
                    .foregroundStyle(ConchPalette.textPrimary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button { self.message = nil } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(ConchPalette.textDim)
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(ConchPalette.raised, in: RoundedRectangle(cornerRadius: 9))
            .overlay(
                RoundedRectangle(cornerRadius: 9)
                    .strokeBorder(ConchPalette.statusNeeds.opacity(0.45), lineWidth: 1)
            )
            .padding(12)
        }
    }
}
