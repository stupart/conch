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
    /// Waiting to be looked at (`ReadyForYou`): the deliverable stays on a working
    /// row, but a session that went back to work is not waiting on you, and nor is
    /// one you have already looked at, here or on the phone.
    let isReady: Bool
    /// When it was looked at, as the daemon remembers it — on any device. Nil means nobody
    /// has, or that this daemon is too old to know (`features.viewedState`).
    let viewedAt: Double?
    /// When it was approved, which marks it done (2026-10-05, Tyler's decision): out of Ready for you, and no Approve on
    /// it. Nil means it wasn't, or a daemon too old to approve.
    let approvedAt: Double?
    /// Its agent asked for your yes, and what a yes does ("Open the PR"): only then is there a ✓ to press (2026-10-05,
    /// after using #502). False, and no label, on everything else.
    let asksApproval: Bool
    let approvalLabel: String?
    /// The artifact this filing is a version of, as the daemon filed it; nil from an older one.
    let artifact: String?
    /// Which filing of its artifact this is, from 1, as the daemon numbered it; nil from an older one (`VersionLabel`).
    let version: Int?
    /// What the agent drew over it (`scene.marks`), for the canvas to draw where it shows (`AgentInkController`).
    let marks: [AgentMark]
    /// What kind of thing it is, as the daemon filed it (src/deliverables.ts); nil from an older daemon.
    let kind: String?
    /// A folder deliverable's paths to point at, relative to the folder (`focus`); empty for anything else.
    let focus: [String]
    /// Why the link its agent gave was not published, when one was given and refused (`linkRefused`).
    let linkRefused: String?
    /// What a live page's login-wall check found when it was published (`access`): the banner over a page that asked
    /// conch to sign in (`PageAccess.macBanner`).
    let access: PageAccess.Found?

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
        isReady = ReadyForYou.isReady(working: row.status == .working, held: [(review.viewedAt, review.approvedAt)])
        viewedAt = review.viewedAt
        approvedAt = review.approvedAt
        asksApproval = review.asksApproval
        approvalLabel = review.approvalLabel
        artifact = review.artifact
        version = review.version
        marks = review.marks
        kind = review.kind
        focus = review.focus
        linkRefused = review.linkRefused
        access = review.access
        // The identity the daemon minted when it filed this deliverable, which it carries
        // unchanged through every later event — so this id moves only when a NEWER deliverable
        // replaces this one. Everything keyed on it (the pane, the row pulse, the
        // notification) relies on that. An older daemon sends none and the old key stands in.
        id = ReviewIdentity.key(published: review.id, sessionId: row.id, filedAt: review.at)
    }
}

extension SessionRow {
    /// What this session changed, resolved against its own folder: what a tree of its files marks.
    ///
    /// Read from the conversation the daemon published FOR THIS ROW, with the same session
    /// check the transcript uses: the daemon publishes one conversation at a time, and marking
    /// another session's edits on this session's tree would be a confident lie about work.
    /// One rule for the Files tab and a folder deliverable, in the window and in the panel.
    func changedFiles(in state: PublishedState?) -> ConchFileChanges {
        let conversation = state?.conversations?[id] ?? state?.conversation
        let items = conversation?.sessionId == id ? conversation?.items ?? [] : []
        return ConchFileChanges(
            changed: items.compactMap { $0.change?.path },
            relativeTo: workFolder ?? ""
        )
    }
}

struct InlineReviewView: View {
    let item: ReviewItem
    let onOpenInPlace: () -> Void
    /// Where the pane IS, owned by the pane rather than by this view.
    ///
    /// It started as `@State` here, which compiled and was wrong: ⌘3 posts a notification the
    /// pane answers, and the pane could not see a private `@State` — so the key would have
    /// opened the FILED link while the arrow opened the live one. That is the exact
    /// disagreement this change exists to delete, rebuilt on a different control.
    @Binding var liveAddress: String?
    /// What the session changed, for a folder deliverable's tree to mark as the Files tab does (`SessionRow.changedFiles`).
    var changed = ConchFileChanges(changed: [], relativeTo: "")
    /// Compare this with another version of its artifact (`DeliverableCompareView`): a button beside the arrow, only where
    /// the session holds another version. Nil draws no button.
    var onCompare: (() -> Void)?
    /// Whether the page or picture below says it shows this review, for the agent's marks to be drawn on it. Off for the
    /// two sides of a comparison: marks are drawn for one review at a time, and two would take the canvas in turns.
    var showsInk = true

    @State private var isWebLoading = false

    var body: some View {
        ReviewSurface(
            item: item,
            changed: changed,
            // The arrow OUT, not a bigger box. This control used to swap between filling the
            // conch window and sharing it, which meant the deliverable had no way to reach the
            // thing it actually is — a page in a browser, a file in its own app. Tyler: "maybe
            // we add some sort of arrow type thing u can click on that brings you to the
            // artifact 'in the wild'". It no longer depends on the stage at all, so it says one
            // thing and does one thing.
            actionSymbol: "arrow.up.forward.app",
            // Where a Figma file lives is Figma (`FigmaLink`; `openLink` hands it over), and a
            // private one is often a sign-in wall in here — so the way out says where it goes.
            actionHelp: opensInFigma ? "Open in Figma (⌘3)" : "Open where it lives (⌘3)",
            actionAccessibilityLabel: opensInFigma ? "Open the design in Figma" : "Open the deliverable where it lives",
            // The page you are LOOKING AT, not the one that was filed. "Open in browser" sat
            // one row below doing exactly this while the arrow opened the original link, so the
            // two controls looked like duplicates and quietly disagreed. One control now.
            action: item.link == nil ? nil : onOpenInPlace,
            onCompare: onCompare,
            isWebLoading: $isWebLoading,
            liveAddress: $liveAddress
        )
        // The page or image below says it shows this review, for its marks to find (`AgentInkController`).
        .environment(\.agentInkItem, showsInk ? item : nil)
    }

    /// Read from where the pane IS, as the arrow opens.
    private var opensInFigma: Bool {
        URL(string: liveAddress ?? item.link ?? "").flatMap(FigmaLink.appURL(for:)) != nil
    }
}

private struct ReviewSurface: View {
    let item: ReviewItem
    let changed: ConchFileChanges
    let actionSymbol: String
    let actionHelp: String
    let actionAccessibilityLabel: String
    let action: (() -> Void)?
    let onCompare: (() -> Void)?
    @Binding var isWebLoading: Bool
    @Binding var liveAddress: String?
    /// An Atlas page a wiki link led to is up, with its line, which carries the controls as a page's address line does
    /// (`ReviewContent`'s `onTrail`).
    @State private var controlsOnTrail = false

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                if let link = item.link, case let .folder(folder) = DeliverableSource(link: link) {
                    // A folder is its tree: the Files tab's own, rooted at the folder the session published, with what
                    // it changed marked and what the agent pointed at open and marked (`focus`). Keyed on the version,
                    // so the next one opens on its own focus rather than inheriting this one's open folders.
                    WorkspaceFilesView(
                        root: folder.path,
                        rowID: item.rowID,
                        changed: changed,
                        focus: item.focus,
                        title: folder.lastPathComponent
                    )
                    .id(item.id)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .onAppear { isWebLoading = false }
                } else if let link = item.link {
                    ReviewContent(
                        link: link,
                        rowID: item.rowID,
                        isWebLoading: $isWebLoading,
                        liveAddress: $liveAddress,
                        signInBanner: PageAccess.macBanner(item.access),
                        // A page's way out is on its address line, at the right end, as the lagoon's glass has it.
                        lineControls: paneControls,
                        onTrail: { controlsOnTrail = $0 }
                    )
                    .id(item.id)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    MissingDeliverableView(refusal: item.linkRefused)
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
    ///
    /// The compare button sits beside it, and only on an artifact with another version held: a before/after is the one
    /// other thing done with a deliverable from here (`DeliverableCompareView`), and with nothing to compare it is not
    /// drawn at all, so the pane of a lone deliverable is exactly what it was.
    ///
    /// A page has no corner circle (2026-10-05, Tyler's decision, matching the lagoon's glass): its ↗ sits at the right
    /// end of its thin address line instead (`ReviewContent`'s `lineControls`), where it no longer covers the top of the
    /// page or the line's own words. Pictures, films, PDFs and everything else keep the corner circle. Same key (⌘3),
    /// tooltip and VoiceOver label either way, from the one list (`paneControls`).
    private var stageControl: some View {
        HStack(spacing: 6) {
            if !opensFromAddressLine, !controlsOnTrail {
                ForEach(paneControls) { control in
                    circleButton(symbol: control.symbol, help: control.help, label: control.label, action: control.action)
                }
            }
        }
        .padding(10)
    }

    /// Compare (only with another version held) and the way out, in that order, so ↗ is always the last.
    private var paneControls: [ReviewPaneControl] {
        var controls: [ReviewPaneControl] = []
        if let onCompare {
            controls.append(ReviewPaneControl(
                symbol: "rectangle.split.2x1",
                help: "Compare with the version before",
                label: "Compare with another version",
                action: onCompare,
                comparesVersions: true
            ))
        }
        if let action {
            controls.append(ReviewPaneControl(symbol: actionSymbol, help: actionHelp, label: actionAccessibilityLabel, action: action))
        }
        return controls
    }

    /// A page, drawn with its address line: its controls go there (`ReviewContent`).
    private var opensFromAddressLine: Bool {
        guard let link = item.link else { return false }
        return DeliverableSource(link: link) == .web
    }

    private func circleButton(symbol: String, help: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
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
        .help(help)
        .accessibilityLabel(label)
    }
}

/// One of the review pane's own controls (Compare, Open where it lives): drawn as a circle over the work's corner, or on
/// a page's address line.
struct ReviewPaneControl: Identifiable {
    let symbol: String
    let help: String
    let label: String
    let action: () -> Void
    /// Compare: versions of the filed deliverable, so it has nothing to say about an Atlas page a link led to.
    var comparesVersions = false
    var id: String { symbol }
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
    /// The session's working folder, or a folder it published. Nothing is drawn above the Files tab's: this is a
    /// session's workspace, not a file browser, and the folder it runs in is the whole of it. A folder deliverable is
    /// named above its tree (`title`), since it is one thing the session made rather than where it works.
    let root: String
    let rowID: String
    let changed: ConchFileChanges
    /// A folder deliverable's paths to point at, relative to `root`: opened and marked on first draw (`ConchFileFocus`).
    var focus: [String] = []
    var title: String?

    /// Folders read once, when opened, and kept.
    ///
    /// The disk is NOT read from `body`. A listing in the render path runs again on every
    /// unrelated state change — a keystroke in the composer, a snapshot from the daemon — and
    /// stutters the very scroll it is drawing.
    @State private var listings: [String: [ConchFileEntry]] = [:]
    @State private var expanded: Set<String> = []
    @State private var selected: String?
    @State private var isWebLoading = false
    /// How wide the tree is: the divider beside it drags (2026-10-12, Tyler: "i want ot be able to control the size of
    /// that plane as well"), and a double-click on it puts it back to 232. Remembered once for every tree, a folder
    /// deliverable's and the Files tab's alike, as the sidebar's width is: the names in it want the same room in both.
    @AppStorage(PaneSplit.fileTree.key) private var railWidth = Double(PaneSplit.fileTree.standard)

    private var rows: [ConchFileRow] {
        ConchFileTree.rows(root: root, listings: listings, expanded: expanded)
    }

    private var pointedAt: ConchFileFocus { ConchFileFocus(focus: focus, relativeTo: root) }

    var body: some View {
        // The tree, a hairline, and the file picked in it; the hairline is the divider (`ConchSplitView`).
        ConchSplitView(split: .fileTree, width: $railWidth, label: "Resize the file list") {
            rail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // `raised`, never `bg`. Nothing inside the stage repaints the WINDOW ground:
                // the pane is a panel sitting on that ground, and painting it again in here
                // punches a hole in the panel — the "right shape, wrong colour" §3 fixed once
                // already, and which `mac-phase1-source` pins for this whole file.
                //
                // In light mode `raised` and `surface` are the same white, so the rail is told
                // apart by the hairline beside it rather than by its fill — exactly how the
                // origin bar below already behaves.
                .background(ConchPalette.raised)
        } trailing: {
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

    /// The tree itself is ConchDesign's (`ConchFileTreeRail`), in this window's type.
    private var rail: some View {
        ConchFileTreeRail(
            rows: rows,
            selected: selected,
            expanded: expanded,
            changed: changed,
            focus: pointedAt,
            title: title,
            font: { ConchTypography.font(size: $0, weight: $1) },
            onPick: pick
        )
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
        openFocus()
    }

    /// What the agent pointed at, on screen on first draw: the folders on the way to each focus path open (and a focused
    /// folder itself), each listed off the main thread like any opened folder, and the first focused file in the viewer.
    /// Asked of the disk once, here, never from `body`.
    private func openFocus() {
        let focus = pointedAt
        guard !focus.isEmpty else { return }
        Task.detached(priority: .userInitiated) {
            let isDirectory = { (path: String) -> Bool in
                var directory: ObjCBool = false
                return FileManager.default.fileExists(atPath: path, isDirectory: &directory) && directory.boolValue
            }
            let open = focus.expanded(isDirectory: isDirectory)
            let first = focus.firstFile(isDirectory: isDirectory, exists: { FileManager.default.fileExists(atPath: $0) })
            await MainActor.run {
                expanded.formUnion(open)
                for folder in open { load(folder) }
                if selected == nil { selected = first }
            }
        }
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

/// Where a deliverable with no link would be. When its agent gave a link and conch refused it, this says which and why
/// (`linkRefused`): a refused link used to read exactly like one never given.
private struct MissingDeliverableView: View {
    var refusal: String?

    var body: some View {
        VStack(spacing: 9) {
            Image(systemName: "doc.badge.ellipsis")
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(ConchPalette.textFaint)

            Text(refusal ?? "No deliverable link was published for this review.")
                .font(ConchTypography.font(size: 12.5))
                .foregroundStyle(ConchPalette.textDim)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 460)
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
    /// Said over the live page when conch's own look at it, as it was published, was shown a sign-in page
    /// (`PageAccess.macBanner`, 2026-10-03 feedback item 3). This pane's web view keeps the sign-ins conch draws pages
    /// with, so signing in here once is the fix. Nil draws nothing.
    var signInBanner: String?
    /// A page's Compare and ↗, at the right end of its address line (`ReviewSurface.paneControls`). None for a file
    /// picked in the Files tab, whose pane has no way out of its own.
    var lineControls: [ReviewPaneControl] = []
    /// Whether an Atlas page a wiki link led to is up: its line carries `lineControls`, so the corner's circles go, as
    /// they do over a page, rather than sit on the line's right end.
    var onTrail: (Bool) -> Void = { _ in }
    /// The banner was closed, for as long as this deliverable is shown.
    @State private var signInBannerClosed = false
    @State private var navigationFailure: DeliverableNavigationFailure?
    @State private var reloadID = UUID()
    /// A page on this Mac whose server didn't answer the knock (`LocalServer`), shown in its place (`ServerDownView`).
    @State private var downPage: URL?
    /// The filed link has been knocked on, or needed no knock: the page may load.
    @State private var knocked = false
    /// Its session has been asked to start the server again, from here.
    @State private var askedToStart = false
    /// The Atlas pages wiki links in a markdown deliverable led to, in the order they were followed; the last is shown in
    /// the filed document's place, and empty shows the filed document (`AtlasStop`). The pane is keyed on the deliverable,
    /// so the next one opens on itself.
    @State private var atlasTrail: [AtlasStop] = []
    /// The pages its session has been asked for, from here (`askForAtlasPage`).
    @State private var askedForPages: Set<String> = []
    /// Where to put the page Back returned to: as far down it as it was when the link was followed.
    @State private var returnOffset: CGFloat?
    @EnvironmentObject private var store: StateStore
    /// A link or file this pane could not open, in the OS's own words with
    /// the resolved target, shown here rather than as a Finder alert (A13).
    @State private var linkFailure: String?
    /// How far in the picture, PDF, page or text is drawn (2026-10-12, Tyler: "make it so I can zoom in on items in the
    /// deliverables place that are images or files"): pinched, ⌘+ ⌘− ⌘0, a double-click on a picture, or the control in
    /// the bottom right corner. The renderer below attaches itself to it (`conchZoomTarget`); a video, a folder, or a
    /// file conch can't preview never does, so the control is never drawn there. One per file shown: the pane is keyed
    /// on it, so the next file opens fitted.
    @StateObject private var zoom = ZoomTarget()

    var body: some View {
        content.overlay(alignment: .bottom) { LinkFailureLine(message: $linkFailure) }
            .environment(\.conchZoomTarget, zoom)
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
                // In the PANE's corner, outside the picture's 18 point margin: 10 in, as the corner buttons above it.
                .overlay(alignment: .bottomTrailing) { ZoomOverlay(target: zoom) }
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
                .overlay(alignment: .bottomTrailing) { ZoomOverlay(target: zoom) }
                .onAppear {
                    isWebLoading = false
                }
        case let .markdown(filed):
            // The filed document, or the Atlas page a wiki link in it led to: conch's saved copy of it, or, with none
            // saved, the page saying so.
            let url = atlasTrail.last?.copy ?? filed
            VStack(spacing: 0) {
                if let stop = atlasTrail.last {
                    AtlasTrailLine(page: stop.page, back: stop.back, onBack: atlasBack) {
                        // The way out, to the copy shown; none on a page with no copy, where it could only open the
                        // filed document under a line naming another page. Compare is the filed deliverable's.
                        HStack(spacing: 6) {
                            ForEach(stop.copy == nil ? [] : lineControls.filter { !$0.comparesVersions }) { control in
                                lineButton(control)
                            }
                        }
                    }
                }
                if let stop = atlasTrail.last, stop.copy == nil {
                    AtlasPageUnsavedView(
                        title: stop.words ?? stop.page.name.split(separator: "/").last.map(String.init) ?? stop.page.name,
                        page: stop.page.name,
                        cameFrom: stop.back,
                        session: store.state?.row(rowID)?.label,
                        asked: askedForPages.contains(stop.page.name),
                        onAsk: { askForAtlasPage(stop.page, from: stop.from) }
                    )
                } else {
                    DeliverableDocumentView(url: url, renderMarkdown: true, anchor: atlasTrail.last?.page.heading, offset: returnOffset, onFailure: { loadFailed(url, $0) }) { link in
                        open(link, cwd: url.deletingLastPathComponent().path)
                    } onOpenAtlas: { followed in
                        followAtlas(followed, from: url)
                    }
                }
            }
                .onChange(of: atlasTrail.isEmpty) { _, empty in onTrail(!empty) }
                .onDisappear { onTrail(false) }
                .background(ConchPalette.surface)
                .overlay(alignment: .bottomTrailing) { ZoomOverlay(target: zoom) }
                .onAppear {
                    isWebLoading = false
                }
        case let .text(url):
            DeliverableDocumentView(url: url, renderMarkdown: false, onFailure: { loadFailed(url, $0) })
                .background(ConchPalette.surface)
                .overlay(alignment: .bottomTrailing) { ZoomOverlay(target: zoom) }
                .onAppear {
                    isWebLoading = false
                }
        case let .unsupported(url), let .folder(url):
            // A limitation stated plainly, not WebKit's "Frame load
            // interrupted" — which looked like conch had broken. A folder reaches
            // here only as a picked file, which the tree never picks; its tree is
            // `ReviewSurface`'s to draw.
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
                    // The way out, at the line's right end (2026-10-05): it sat over the page's top-right corner, where
                    // it covered the page and the end of a long address.
                    ForEach(lineControls) { control in
                        lineButton(control)
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
                if let downPage {
                    ServerDownView(
                        address: LocalServer.name(of: downPage),
                        session: store.state?.row(rowID)?.label ?? "the session",
                        asked: askedToStart,
                        onAsk: { askToStart(downPage) },
                        onRetry: { Task { await knock(downPage) } }
                    )
                } else if knocked {
                DeliverableWebView(
                    link: shownLink,
                    reloadID: reloadID,
                    isLoading: $isWebLoading,
                    currentLink: $liveLink,
                    onNavigationFailure: { failure in
                        navigationFailure = failure
                        // A page on this Mac that can't be reached, typed or followed to as well as filed: its server
                        // stopped if nothing answers the knock, and that is what the pane says.
                        if LocalServer.port(of: failure.url) != nil {
                            Task { if !(await LocalServer.isListening(failure.url)) { downPage = failure.url } }
                        }
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
                // On the page itself, under the loading cover and the failure card drawn over it below.
                .overlay(alignment: .bottomTrailing) { ZoomOverlay(target: zoom) }
                }

                // WKWebView paints the document white until the page's own
                // background lands, so a remote deliverable flashed a blinding
                // white rectangle for several seconds inside a dark app. Cover
                // it until the load settles. Failure states set isLoading false
                // too, so this can't strand the pane behind a permanent cover.
                if isWebLoading || !knocked, navigationFailure == nil, downPage == nil {
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

                if let failure = navigationFailure, downPage == nil {
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
                .overlay(alignment: .top) {
                    if let signInBanner, !signInBannerClosed, navigationFailure == nil, downPage == nil {
                        SignInBanner(text: signInBanner) { signInBannerClosed = true }
                            .padding(10)
                            .transition(.opacity)
                    }
                }
            }
            .background(ConchPalette.surface)
            // Before the filed page loads, a knock on its port when it is on this Mac: a dev server that has stopped
            // gave "Could not connect to the server", with "Open in Browser" as the way out, which can't help.
            .task(id: link) {
                (downPage, askedToStart) = (nil, false)
                guard let page = URL(string: link), LocalServer.port(of: page) != nil else { knocked = true; return }
                await knock(page)
            }
        }
    }

    private func retryNavigation() {
        navigationFailure = nil
        isWebLoading = true
        reloadID = UUID()
    }

    /// The corner circle, made to sit in the thin line: smaller, and allowed into the line's own padding so the line
    /// stays as thin as it was.
    private func lineButton(_ control: ReviewPaneControl) -> some View {
        Button(action: control.action) {
            Image(systemName: control.symbol)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(ConchPalette.textDim)
                .frame(width: 22, height: 22)
                .background(Circle().fill(ConchPalette.surface))
                .overlay(Circle().strokeBorder(ConchPalette.divider, lineWidth: 0.5))
                .contentShape(Circle())
        }
        .buttonStyle(ReviewPressButtonStyle())
        .padding(.vertical, -4)
        .help(control.help)
        .accessibilityLabel(control.label)
    }

    /// Knock on a local page's port: answered, it loads (again); refused, the pane says its server isn't running.
    private func knock(_ page: URL) async {
        guard await LocalServer.isListening(page) else {
            downPage = page
            isWebLoading = false
            return
        }
        let wasDown = downPage != nil
        downPage = nil
        askedToStart = false
        knocked = true
        if wasDown { retryNavigation() }
    }

    /// The one thing that helps a stopped server: its session, asked to start it again. Tyler presses it; conch never
    /// sends it by itself. Through the inject path every reply takes, so it lands in the session's own terminal.
    private func askToStart(_ page: URL) {
        guard let row = store.state?.row(rowID) else { return }
        askedToStart = true
        let delivery = store.send(.inject(sessionId: row.id, label: row.label, text: Self.startServerPrompt(page)))
        Task { if !(await delivery.value) { askedToStart = false } }
    }

    static func startServerPrompt(_ page: URL) -> String {
        "The page you filed for review, \(page.absoluteString), isn't loading: nothing is listening on \(LocalServer.name(of: page)). Please start its server again and tell me when it's up."
    }

    /// A wiki link followed: the page, from conch's copy when one is saved (`AtlasLink.Page.copy`), in this one's place.
    /// The way out (↗, ⌘3) follows it to the copy shown, as it follows a page the web view moved to; with no copy it
    /// opens the filed document.
    private func followAtlas(_ followed: AtlasFollow, from document: URL) {
        linkFailure = nil
        returnOffset = nil
        let page = followed.page
        let copy = page.copy()
        let saved = FileManager.default.fileExists(atPath: copy.path)
        let from = AtlasLink.path(ofCopy: document).map { AtlasLink.Page(path: $0).name }
        // Back is named for the page it returns to, by its title where it has one ("AI Benchmarks and Evals"), read once,
        // here, rather than from the disk on every draw.
        let back = Self.markdownTitle(of: document) ?? from ?? document.deletingPathExtension().lastPathComponent
        atlasTrail.append(AtlasStop(page: page, copy: saved ? copy : nil, words: followed.words, back: back, from: from, fromOffset: followed.offset))
        liveAddress = saved ? copy.path : nil
    }

    /// A document's title: its first top-level heading, read from the first 64 KB.
    private static func markdownTitle(of document: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: document) else { return nil }
        defer { try? handle.close() }
        let head = (try? handle.read(upToCount: 64 * 1024)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        return AtlasLink.title(of: head)
    }

    /// Back one page: the one the link was followed from, the filed document at the end, scrolled to where it was.
    private func atlasBack() {
        guard let left = atlasTrail.popLast() else { return }
        returnOffset = left.fromOffset
        liveAddress = atlasTrail.last?.copy?.path
    }

    /// The one thing that brings an unsaved page: the session that showed this one, asked to read it with its own Atlas
    /// tools and show it (`atlas_show`), which files it as its next deliverable. Tyler presses it; conch never asks by
    /// itself. Through the inject path every reply takes, as `askToStart` is.
    private func askForAtlasPage(_ page: AtlasLink.Page, from source: String?) {
        guard let row = store.state?.row(rowID) else { return }
        askedForPages.insert(page.name)
        let delivery = store.send(.inject(sessionId: row.id, label: row.label, text: Self.atlasPagePrompt(page, from: source)))
        Task { if !(await delivery.value) { askedForPages.remove(page.name) } }
    }

    static func atlasPagePrompt(_ page: AtlasLink.Page, from source: String?) -> String {
        let from = source.map { " in \(AtlasLink.Page(path: $0).name)" } ?? ""
        return "I followed a link to the Atlas page \(page.name)\(from), and conch has no copy of it. Please read it with your Atlas tools and show it to me with atlas_show."
    }
}

/// One wiki link followed in a markdown deliverable: the Atlas page, conch's copy of it (nil when none is saved), the link's
/// own words, what Back from it is called, the Atlas path of the page it was followed from when that was a copy too, and
/// how far down that page was scrolled.
private struct AtlasStop: Equatable {
    let page: AtlasLink.Page
    let copy: URL?
    let words: String?
    let back: String
    let from: String?
    let fromOffset: CGFloat
}

/// A wiki link clicked in a rendered document: its page, its words as the document shows them, and how far down the
/// document was scrolled, for Back to return to.
struct AtlasFollow {
    let page: AtlasLink.Page
    let words: String?
    let offset: CGFloat
}

/// Over an Atlas page a wiki link led to: the way back (⌘[), named for where it goes, which page this is, and the pane's
/// own controls at the right end, as a page's address line has them. Only once a link has been followed: the filed
/// document needs none of it, and a line over every document would be the bar Tyler had taken off the pane ("adds
/// clutter").
private struct AtlasTrailLine<Controls: View>: View {
    let page: AtlasLink.Page
    let back: String
    let onBack: () -> Void
    @ViewBuilder let controls: Controls
    @State private var hovering = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button(action: onBack) {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 9, weight: .semibold))
                        Text(back)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .foregroundStyle(hovering ? ConchPalette.textPrimary : ConchPalette.textDim)
                    // The whole height of the line takes the click, not only the words' 14 points of it.
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.vertical, -6)
                .onHover { hovering = $0 }
                .keyboardShortcut("[", modifiers: .command)
                .help("Back to \(back) (⌘[)")
                .accessibilityLabel("Back to \(back)")
                // Back is the line's point: it keeps its words, and the path gives way first.
                .layoutPriority(1)
                Spacer(minLength: 0)
                // "Atlas ·" always shows; a long path gives up its start, so its own name stays.
                HStack(spacing: 0) {
                    Text("Atlas · ")
                        .fixedSize()
                    Text(page.name)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                .foregroundStyle(ConchPalette.textFaint)
                .textSelection(.enabled)
                controls
            }
            .font(ConchTypography.font(size: 11))
            .foregroundStyle(ConchPalette.textDim)
            // Back's words start where the document's do (its text view's 24 pt inset and 5 pt of line padding), the
            // chevron hanging left of them; the right end matches a page's address line.
            .padding(.leading, 18)
            .padding(.trailing, 14)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ConchPalette.raised)

            Rectangle()
                .fill(ConchPalette.divider)
                .frame(height: 1)
        }
    }
}

/// A wiki link to an Atlas page conch has no copy of, said plainly in place of a dead click. conch can't read Atlas
/// itself (`AtlasLink`): the session that showed this page can, so the pane offers to ask it. With no session to ask,
/// it says who can.
private struct AtlasPageUnsavedView: View {
    /// The page as the link named it ("AI Benchmark Index Map — 2026-10-28"), else its path's last part: the line above
    /// already says its whole path.
    let title: String
    let page: String
    /// The page the link was in, by the name Back has for it.
    let cameFrom: String
    /// The session that filed the page this link was in, by name; nil when it is no longer there to ask.
    let session: String?
    let asked: Bool
    let onAsk: () -> Void

    private var detail: String {
        guard let session else {
            return "conch can\u{2019}t read Atlas itself, and the session that showed you \(cameFrom) isn\u{2019}t running. Any session with Atlas can save this page: ask it to show you \(page)."
        }
        return asked
            ? "Asked \(session). It comes in as a new deliverable once it\u{2019}s saved."
            : "conch can\u{2019}t read Atlas itself. \(session) showed you \(cameFrom), and can save this page with its Atlas tools."
    }

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(ConchPalette.textDim)
            Text("\(title) isn\u{2019}t saved in conch yet")
                .font(ConchTypography.font(size: 14, weight: .medium))
                .foregroundStyle(ConchPalette.textPrimary)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
            Text(detail)
                .font(ConchTypography.font(size: 12))
                .foregroundStyle(ConchPalette.textDim)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if let session {
                Button("Ask \(session) for it", action: onAsk)
                    .disabled(asked)
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: 460)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
        .background(ConchPalette.surface)
        .accessibilityElement(children: .contain)
    }
}

/// Over a live page whose login-wall check found conch's own look asked to sign in: the page you see may be the
/// sign-in page, and this pane is where to sign in, since its web view keeps the sign-ins conch draws pages with
/// (PageCapturer.swift uses the same default website data store). Small and closable: the page under it is the point.
private struct SignInBanner: View {
    let text: String
    let onClose: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "person.badge.key")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.statusNeeds)
                .accessibilityHidden(true)
            Text(text)
                .font(ConchTypography.font(size: 11.5))
                .foregroundStyle(ConchPalette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(ConchPalette.textDim)
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: 520, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(ConchPalette.raised)
                .shadow(color: .black.opacity(0.25), radius: 10, y: 3)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(ConchPalette.divider, lineWidth: 0.5)
        )
        .accessibilityElement(children: .combine)
    }
}

/// A page on this Mac whose server has stopped, said plainly in place of WebKit's "Could not connect to the server",
/// with what helps: asking the session that served it to start it again, and trying again once it has.
private struct ServerDownView: View {
    let address: String
    let session: String
    let asked: Bool
    let onAsk: () -> Void
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "bolt.horizontal.circle")
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(ConchPalette.textDim)
            Text("The page\u{2019}s server isn\u{2019}t running (\(address))")
                .font(ConchTypography.font(size: 14, weight: .medium))
                .foregroundStyle(ConchPalette.textPrimary)
                .multilineTextAlignment(.center)
            Text(asked ? "Asked \(session). Try again once it says the server is up." : "Nothing is answering there, so the page can\u{2019}t load.")
                .font(ConchTypography.font(size: 12))
                .foregroundStyle(ConchPalette.textDim)
                .multilineTextAlignment(.center)
            HStack(spacing: 10) {
                Button("Ask \(session) to start it", action: onAsk)
                    .disabled(asked)
                Button("Try Again", action: onRetry)
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: 460)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
        .background(ConchPalette.surface)
        .accessibilityElement(children: .contain)
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
                        .foregroundStyle(ConchPalette.accent)
                        .lineLimit(4)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                        .help(failure.link)

                    Text(failure.message)
                        .font(ConchTypography.font(size: 12))
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
    /// A folder: shown as its tree (`WorkspaceFilesView`), a folder deliverable's own renderer.
    case folder(URL)
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
        // A Figma file saved to disk: only Figma reads it, and the arrow opens it there.
        "fig",
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
        // its tree now (kind `folder`). A package is not a folder of work, and
        // opening one launches it: it stays a thing to reveal in Finder.
        if isDirectory.boolValue {
            let packaged = NSWorkspace.shared.isFilePackage(atPath: localURL.path)
            self = packaged ? .unsupported(localURL) : .folder(localURL)
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
        default:
            // Text to a person (source, config, data, LICENSE) is shown as text, decided by its name and, where the
            // name says nothing, its first bytes (`DeliverableText`). WebKit decides by its own MIME guess, which made
            // `starter-prompts.ts` an MPEG transport stream and failed it with "Frame load interrupted". A page
            // (`DeliverableText.pages`), and anything else WebKit previews itself (audio, say), falls through to the web view.
            self = DeliverableText.isText(path: localURL.path) ? .text(localURL) : .web
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
///
/// Zoomed by PDFKit itself: a pinch is its own, and the keys and the control set its scale, with "fitted" its auto
/// scale (`ContentZoom.pdf`). A double-click still selects a word, as it does in any PDF.
private struct DeliverablePDFView: NSViewRepresentable {
    let url: URL
    let onFailure: (Error) -> Void

    final class Coordinator {
        var loadedURL: URL?
        /// PDFKit's word that its scale changed: a pinch, a resize while fitted, or the keys.
        var scaled: NSObjectProtocol?

        deinit {
            if let scaled { NotificationCenter.default.removeObserver(scaled) }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displaysPageBreaks = true
        view.backgroundColor = NSColor(ConchPalette.surface)
        view.minScaleFactor = ContentZoom.pdf.range.lowerBound
        view.maxScaleFactor = ContentZoom.pdf.range.upperBound
        if let zoom = context.environment.conchZoomTarget {
            zoom.attach(view) { [weak view, weak zoom] action in
                guard let view else { return }
                Self.zoom(view, action)
                zoom?.report(Self.readout(of: view))
            }
            context.coordinator.scaled = NotificationCenter.default.addObserver(
                forName: .PDFViewScaleChanged, object: view, queue: .main
            ) { [weak view, weak zoom] _ in
                MainActor.assumeIsolated {
                    guard let view else { return }
                    zoom?.report(Self.readout(of: view))
                }
            }
        }
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
        } else {
            context.environment.conchZoomTarget?.report(Self.readout(of: view))
        }
    }

    /// Fitted while PDFKit auto scales; else its scale, 1 being the page's own size.
    private static func level(of view: PDFView) -> ZoomLevel {
        view.autoScales ? .rest : .scale(view.scaleFactor)
    }

    /// The scale fitting gives at the pane's width now: what PDFKit's auto scale would pick.
    private static func fit(of view: PDFView) -> CGFloat {
        let fit = view.scaleFactorForSizeToFit
        return fit > 0 ? fit : 1
    }

    static func readout(of view: PDFView) -> ZoomReadout {
        ContentZoom.pdf.readout(level(of: view), resting: fit(of: view))
    }

    static func zoom(_ view: PDFView, _ action: ZoomAction) {
        guard view.document != nil,
              let next = ContentZoom.pdf.level(after: action, from: level(of: view), resting: fit(of: view)) else { return }
        switch next {
        case .rest:
            view.autoScales = true
        case let .scale(scale):
            view.autoScales = false
            view.scaleFactor = ContentZoom.pdf.clamped(scale, resting: fit(of: view))
        }
    }
}

/// A markdown or plain-text deliverable rendered natively, dark and complete.
/// These used to fall into the WKWebView: markdown showed its raw syntax and
/// text files painted a white system page inside a dark app.
private struct DeliverableDocumentView: NSViewRepresentable {
    let url: URL
    let renderMarkdown: Bool
    /// The heading to open on, from a wiki link that named one (`[[page#status]]`); the top when nil.
    var anchor: String?
    /// How far down to open instead, when Back returned to this document: where it was when the link was followed.
    var offset: CGFloat?
    /// Why the file could not be read, in macOS's words (A13).
    let onFailure: (Error) -> Void
    /// A link inside the rendered document, clicked. NSTextView's own fallback
    /// is a silent `NSWorkspace.open` — exactly the dead click A13 is about.
    var onOpenLink: (String) -> Void = { _ in }
    /// A wiki link to another Atlas page, clicked (`AtlasLink`): the pane shows that page in this one's place.
    var onOpenAtlas: (AtlasFollow) -> Void = { _ in }

    /// Deliverables are files an agent just produced, but an unbounded read is
    /// still an unbounded read. 2MB of text is far past what a review is for.
    private static let maxBytes = 2 * 1024 * 1024

    final class Coordinator: NSObject, NSTextViewDelegate {
        var loadedURL: URL?
        var onOpenLink: (String) -> Void = { _ in }
        var onOpenAtlas: (AtlasFollow) -> Void = { _ in }

        /// Three kinds of link, each to where it means. A heading in this document (`#status`) is scrolled to, here: it
        /// used to reach the door as an empty path and open the document's folder in Finder. An Atlas page goes to the
        /// pane, unless it is this one, when only its heading is. Everything else, a web page or a file beside this one,
        /// goes through the door as it always did.
        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            if let anchor = MarkdownAnchor.target(of: link) {
                textView.scrollToMarkdownAnchor(anchor)
                return true
            }
            if let page = AtlasLink.page(of: LinkTarget.text(of: link)) {
                if page.copy().standardizedFileURL == loadedURL?.standardizedFileURL {
                    if let heading = page.heading { textView.scrollToMarkdownAnchor(heading) }
                } else {
                    // The link's own words, to name the page by, and where this document was, for Back.
                    var words = NSRange()
                    _ = textView.textStorage?.attribute(.link, at: charIndex, effectiveRange: &words)
                    let said = (textView.string as NSString).substring(with: words).trimmingCharacters(in: .whitespacesAndNewlines)
                    onOpenAtlas(AtlasFollow(page: page, words: said.isEmpty ? nil : said, offset: textView.enclosingScrollView?.contentView.bounds.minY ?? 0))
                }
                return true
            }
            onOpenLink(LinkTarget.text(of: link))
            return true
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        // Zooms as a page does: pinched, or by the keys and the control, wrapped to the pane at every scale
        // (`ZoomingTextScrollView`), 100% where it opens.
        let scrollView = ZoomingTextScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        if let zoom = context.environment.conchZoomTarget {
            zoom.attach(scrollView) { [weak scrollView] action in scrollView?.zoom(action) }
            scrollView.onZoom = { [weak zoom] readout in zoom?.report(readout) }
            zoom.report(scrollView.readout)
        }

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
        context.coordinator.onOpenAtlas = onOpenAtlas
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
                // A file: its soft line breaks are spaces, as Markdown means them (`MarkdownSoftBreaks`).
                ConversationDocument.markdown(MarkdownSoftBreaks.joined(content), attributes: attributes)
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
        // A page a wiki link led to opens at its top, or at the heading the link named, and one Back returned to where
        // it was left, not wherever the page before it was scrolled to: the view is the same one, given the next file.
        scrollView.contentView.scroll(to: .zero)
        scrollView.reflectScrolledClipView(scrollView.contentView)
        if let offset {
            DispatchQueue.main.async {
                if let layoutManager = textView.layoutManager, let container = textView.textContainer {
                    layoutManager.ensureLayout(for: container)
                }
                let clip = scrollView.contentView
                clip.scroll(to: NSPoint(x: 0, y: min(offset, max(0, textView.frame.height - clip.bounds.height))))
                scrollView.reflectScrolledClipView(clip)
            }
        } else if let anchor {
            DispatchQueue.main.async { textView.scrollToMarkdownAnchor(anchor) }
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

extension NSTextView {
    /// Scroll a rendered Markdown document so the heading a `#anchor` link names sits at the top of what shows, and flash
    /// it as Find does. The typesetter marks each heading with its anchor (`MarkdownTypesetter.anchorKey`); a link may
    /// name it as the slug or as the heading's own words. False, and nothing moves, when there is no such heading.
    @discardableResult
    func scrollToMarkdownAnchor(_ anchor: String) -> Bool {
        guard let storage = textStorage, let layoutManager, let textContainer else { return false }
        let wanted = MarkdownAnchor.slug(anchor)
        var found: NSRange?
        storage.enumerateAttribute(MarkdownTypesetter.anchorKey, in: NSRange(location: 0, length: storage.length)) { value, range, stop in
            guard (value as? String) == wanted else { return }
            found = range
            stop.pointee = true
        }
        guard let range = found else { return false }
        layoutManager.ensureLayout(for: textContainer)
        let rect = layoutManager.boundingRect(forGlyphRange: layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil), in: textContainer)
        if let clip = enclosingScrollView?.contentView {
            // The document's own top margin above the heading, as its first heading has, and never past its end.
            let top = min(max(0, rect.minY + textContainerOrigin.y - textContainerInset.height), max(0, frame.height - clip.bounds.height))
            clip.scroll(to: NSPoint(x: clip.bounds.minX, y: top))
            enclosingScrollView?.reflectScrolledClipView(clip)
        } else {
            scrollRangeToVisible(range)
        }
        // The heading's words, not the line break after them.
        showFindIndicator(for: NSRange(location: range.location, length: max(0, range.length - 1)))
        return true
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
    ///
    /// Decoded for the width it is drawn at, not whole. `NSImage(contentsOf:)`
    /// handed Core Animation the whole picture, and Core Animation shrinks a
    /// layer's contents with a bilinear filter and no mipmaps: a 2880-pixel
    /// page capture drawn 976 pixels wide in Side by Side sampled one pixel in
    /// three, and its small print broke up and shimmered as it scrolled (seen
    /// through CARenderer, 28 Sep). ImageIO's decode at the drawn width averages
    /// every pixel, and is drawn a pixel to a pixel; it is also a fifth of the
    /// memory (a 2880 x 30000 capture was 345 MB decoded whole).
    ///
    /// Zoomed (2026-10-12): pinched about the fingers, ⌘+ ⌘− ⌘0 and the control about the middle of what shows, a
    /// double-click between fitted and 100% (200% for a picture that opens at its own size) about where it lands
    /// (`ContentZoom.picture`). Zoomed, it is still decoded for the width it is drawn at, so a picture at 100% is a
    /// pixel of it to a pixel of the screen, and it pans by scrolling or dragging (`PictureCanvas`).
    ///
    /// The picture's document: flipped, so the document's origin is the top; and the one view a click lands on, so a
    /// double-click zooms and a drag pans wherever on the picture or its margin they start.
    final class PictureCanvas: NSView {
        override var isFlipped: Bool { true }
        var onDoubleClick: (NSPoint) -> Void = { _ in }
        /// Whether a drag moves the picture: zoomed in, with more of it than shows.
        var pans: () -> Bool = { false }
        private var dragFrom: NSPoint?

        override func hitTest(_ point: NSPoint) -> NSView? {
            super.hitTest(point) == nil ? nil : self
        }

        override func mouseDown(with event: NSEvent) {
            if event.clickCount == 2 {
                onDoubleClick(convert(event.locationInWindow, from: nil))
                return
            }
            guard pans() else { return super.mouseDown(with: event) }
            dragFrom = event.locationInWindow
            NSCursor.closedHand.push()
        }

        override func mouseDragged(with event: NSEvent) {
            guard let from = dragFrom, let clip = superview as? NSClipView else { return super.mouseDragged(with: event) }
            let to = event.locationInWindow
            dragFrom = to
            // The picture follows the pointer, so what shows moves the other way; the window's y runs up, the picture's down.
            // Magnified, a point of the window is 1/magnification of the document, so the picture keeps up with the hand.
            let magnification = max(clip.enclosingScrollView?.magnification ?? 1, 0.01)
            var origin = clip.bounds.origin
            origin.x -= (to.x - from.x) / magnification
            origin.y += (to.y - from.y) / magnification
            // Kept to the document, and on the screen's pixel grid.
            let kept = clip.constrainBoundsRect(NSRect(origin: origin, size: clip.bounds.size)).origin
            let grid = (window?.backingScaleFactor ?? 2) * magnification
            clip.scroll(to: NSPoint(x: (kept.x * grid).rounded() / grid, y: (kept.y * grid).rounded() / grid))
            clip.enclosingScrollView?.reflectScrolledClipView(clip)
        }

        override func mouseUp(with event: NSEvent) {
            guard dragFrom != nil else { return super.mouseUp(with: event) }
            dragFrom = nil
            NSCursor.pop()
            updateCursor(event)
        }

        /// The open hand where a drag would pan: over the picture zoomed in, never over the zoom control drawn above
        /// it, which a cursor rect (only a rect) could not tell apart.
        private lazy var pointer = NSTrackingArea(rect: .zero, options: [.cursorUpdate, .mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self)

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if !trackingAreas.contains(pointer) { addTrackingArea(pointer) }
        }

        override func cursorUpdate(with event: NSEvent) { updateCursor(event) }

        override func mouseMoved(with event: NSEvent) {
            super.mouseMoved(with: event)
            updateCursor(event)
        }

        func updateCursor(_ event: NSEvent? = nil) {
            guard dragFrom == nil else { return }
            let location = event?.locationInWindow ?? window?.mouseLocationOutsideOfEventStream ?? .zero
            let onPicture = window?.contentView?.hitTest(location) === self
            (pans() && onPicture ? NSCursor.openHand : NSCursor.arrow).set()
        }
    }

    final class FitWidthImageScrollView: NSScrollView {
        /// The picture's own view, exactly the rect it is drawn in: what the agent's marks are placed on
        /// (`AgentInkController`).
        let imageView = DeliverablePictureView()
        private let container = PictureCanvas()
        /// The picture as ImageIO reads it, decoded for the width it is drawn at (`ConchImage.decode(_:forWidth:)`).
        private(set) var picture: ConchImage.Picture?
        /// The file shown, for a decode that fails to say which.
        private var url: URL?
        /// What AppKit draws itself instead: a GIF that moves, an SVG, anything ImageIO can't read.
        private var whole: NSImage?
        /// The decode on screen, and the one on its way, in device pixels wide.
        private var decoded: CGImage?
        private var decoding: (key: String, width: Int)?
        private var decodeTask: Task<Void, Never>?
        var onFailure: (Error) -> Void = { _ in }
        /// The scale that fits the picture to the pane's width now, as the last layout found it. The picture is always
        /// laid out at it; zoom is AppKit's magnification of that layout (1 is fitted), so a pinch scales what shows
        /// under the fingers and nothing is laid out again until it ends (2026-10-12, Tyler: "u zoom to one size visually
        /// and when your done it like snaps to another position - maybe needs to be canvas?"). It used to lay the
        /// picture out afresh on every step of a pinch, settle on fitted or 100% when the fingers lifted, then swap in a
        /// decode drawn at that decode's own size: three moves after the one you made.
        private var fit: CGFloat = 1
        /// A pinch under way: no decode, no layout, until it ends.
        private var magnifying = false
        /// Where it is, after every layout: for the control (`ZoomTarget`).
        var onZoom: (ZoomReadout) -> Void = { _ in }
        /// Pinched or double-clicked: the one the keys zoom next.
        var onTouch: () -> Void = {}
        /// Zoomed since the last decode was asked for: the next is made for exactly the width it is drawn at, not kept
        /// from another scale because it is near enough. A picture zoomed back out to fit is drawn from a decode made
        /// for fit, never one made for 75% and shrunk, which Core Animation does without mipmaps.
        private var rezoomed = false

        /// Fitted, or the picture's scale (fit × magnification).
        private var level: ZoomLevel { abs(magnification - 1) < 0.001 ? .rest : .scale(fit * magnification) }

        init() {
            super.init(frame: .zero)
            drawsBackground = false
            hasVerticalScroller = true
            // Zoomed past the pane's width it scrolls across too; at fit the picture is never wider than the pane.
            hasHorizontalScroller = true
            autohidesScrollers = true
            allowsMagnification = true
            container.addSubview(imageView)
            documentView = container
            container.onDoubleClick = { [weak self] point in
                self?.onTouch()
                self?.zoom(.toggle, around: point)
            }
            container.pans = { [weak self] in
                guard let self, abs(self.magnification - 1) > 0.001 else { return false }
                return self.container.frame.width > self.contentView.bounds.width + 0.5
                    || self.container.frame.height > self.contentView.bounds.height + 0.5
            }
            let center = NotificationCenter.default
            center.addObserver(self, selector: #selector(magnifyStarted), name: NSScrollView.willStartLiveMagnifyNotification, object: self)
            center.addObserver(self, selector: #selector(magnifyEnded), name: NSScrollView.didEndLiveMagnifyNotification, object: self)
            // Zoomed out past fit, the shown area is bigger than the layout: laid out again to keep the picture centred.
            contentView.postsBoundsChangedNotifications = true
            center.addObserver(self, selector: #selector(shownChanged), name: NSView.boundsDidChangeNotification, object: contentView)
        }

        required init?(coder: NSCoder) { nil }

        deinit {
            decodeTask?.cancel()
            NotificationCenter.default.removeObserver(self)
        }

        private var shownSize: NSSize = .zero

        @objc private func shownChanged() {
            let size = contentView.bounds.size
            guard abs(size.width - shownSize.width) > 0.5 || abs(size.height - shownSize.height) > 0.5 else { return }
            shownSize = size
            needsLayout = true
        }

        @objc private func magnifyStarted() {
            magnifying = true
            onTouch()
        }

        /// Where the fingers left it stays: no settling on fitted or 100%. Only the decode is made again, for the width
        /// it is drawn at now, and swapped in where the picture already is.
        @objc private func magnifyEnded() {
            magnifying = false
            rezoomed = true
            needsLayout = true
            onZoom(ContentZoom.picture.readout(level, resting: fit))
        }

        /// What `url` holds, shown from the top. A GIF keeps AppKit's own view, which plays it; so does anything
        /// ImageIO has no header for (an SVG draws sharp at any size there). Anything else is decoded for its width.
        func show(_ url: URL) {
            decodeTask?.cancel()
            decodeTask = nil
            decoding = nil
            decoded = nil
            picture = nil
            whole = nil
            magnification = 1
            self.url = url
            let moves = url.pathExtension.lowercased() == "gif"
            if !moves, let picture = ConchImage.picture(atPath: url.path) {
                self.picture = picture
                imageView.clear()
            } else if let image = NSImage(contentsOf: url) {
                whole = image
                imageView.show(image)
            } else {
                // The icon alone said nothing; macOS's reason and the path do (A13).
                let error = DeliverableLoadError.reason(url)
                DispatchQueue.main.async { [onFailure] in onFailure(error) }
                let broken = NSImage(systemSymbolName: "photo.badge.exclamationmark", accessibilityDescription: nil)
                whole = broken
                broken.map(imageView.show)
            }
            needsLayout = true
            contentView.scroll(to: .zero)
        }

        /// The picture's size in points, as NSImage reads it (its resolution; 72 dpi when it says none).
        private var pointSize: CGSize? {
            picture?.points ?? whole?.size
        }

        private var scale: CGFloat { window?.backingScaleFactor ?? 2 }

        override func layout() {
            super.layout()
            guard let size = pointSize, size.width > 0, size.height > 0 else { return }
            // Fitted to the pane's own width (unmagnified); the zoom is the magnification of this layout.
            let paneWidth = contentSize.width
            var targetWidth = min(paneWidth - 36, size.width)
            guard targetWidth > 0 else { return }
            fit = targetWidth / size.width
            minMagnification = min(1, max(ContentZoom.picture.range.lowerBound / fit, 0.25))
            maxMagnification = max(1, ContentZoom.picture.range.upperBound / fit)
            var height = targetWidth * size.height / size.width
            // Drawn at the decode's own size when it was decoded for this width, at rest: a pixel of it to a pixel of
            // the screen. ImageIO rounds, and a picture resampled one pixel narrower is soft all the way across.
            if abs(magnification - 1) < 0.001, let decoded, abs(CGFloat(decoded.width) / scale - targetWidth) <= 1 / scale + 0.001 {
                targetWidth = CGFloat(decoded.width) / scale
                height = CGFloat(decoded.height) / scale
            }
            // The same 18 point margin all round: the picture centred in what shows while it is smaller than that
            // (zoomed out past fit, what shows is bigger than the pane), and scrolled to its edges once it is bigger.
            let shown = contentView.bounds.size
            let containerWidth = max(shown.width, paneWidth, targetWidth + 36)
            let containerHeight = max(height + 36, shown.height)
            container.frame = NSRect(x: 0, y: 0, width: containerWidth, height: containerHeight)
            // On the pixel grid, so a pixel of the decode lands on a pixel of the screen.
            imageView.frame = container.backingAlignedRect(NSRect(
                x: (containerWidth - targetWidth) / 2,
                y: (containerHeight - height) / 2,
                width: targetWidth,
                height: height
            ), options: [.alignMinXNearest, .alignMinYNearest, .alignWidthNearest, .alignHeightNearest])
            // For the width it is drawn at on screen: the layout's, magnified. Not mid-pinch: the decode it has is
            // scaled until the fingers lift.
            if !magnifying { decodeIfNeeded(forWidth: targetWidth * magnification * scale) }
            onZoom(ContentZoom.picture.readout(level, resting: fit))
        }

        // MARK: Zoom

        /// A key, the control, or a double-click: about `anchor` (in the picture's document), else the middle of what
        /// shows.
        func zoom(_ action: ZoomAction, around anchor: NSPoint? = nil) {
            guard pointSize != nil, let next = ContentZoom.picture.level(after: action, from: level, resting: fit) else { return }
            zoom(to: next, around: anchor)
        }

        /// A pinch is AppKit's own, about the fingers (`allowsMagnification`): the layout scaled as it is, under them.
        override func magnify(with event: NSEvent) {
            super.magnify(with: event)
            onZoom(ContentZoom.picture.readout(level, resting: fit))
        }

        /// A two-finger double tap: what a double-click does.
        override func smartMagnify(with event: NSEvent) {
            guard pointSize != nil else { return super.smartMagnify(with: event) }
            onTouch()
            zoom(.toggle, around: container.convert(event.locationInWindow, from: nil))
        }

        /// To `next`, about `anchor` (in the picture's document), else the middle of what shows: the magnification
        /// animated there, so a key, the control or a double-click glides rather than jumps. Laid out and decoded for
        /// the new width once it arrives.
        private func zoom(to next: ZoomLevel, around anchor: NSPoint?) {
            let visible = contentView.bounds
            let point = anchor ?? NSPoint(x: visible.midX, y: visible.midY)
            let target: CGFloat
            switch next {
            case .rest: target = 1
            case let .scale(scale): target = min(max(ContentZoom.picture.clamped(scale, resting: fit) / fit, minMagnification), maxMagnification)
            }
            guard abs(target - magnification) > 0.0005 else { return }
            let still = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = still ? 0 : 0.22
                context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                context.allowsImplicitAnimation = true
                animator().setMagnification(target, centeredAt: point)
            }, completionHandler: { [weak self] in
                guard let self else { return }
                self.rezoomed = true
                self.needsLayout = true
                self.onZoom(ContentZoom.picture.readout(self.level, resting: self.fit))
            })
            container.updateCursor()
        }

        override func viewDidChangeBackingProperties() {
            super.viewDidChangeBackingProperties()
            needsLayout = true
        }

        /// A window resized by hand is decoded again once it lets go; until then the decode it has is scaled.
        override func viewDidEndLiveResize() {
            super.viewDidEndLiveResize()
            needsLayout = true
        }

        /// Decoded again when the width it is drawn at outgrows the decode (a wider window, full screen, a sharper
        /// display), or falls to under half of it (so a narrowed pane lets the memory go); never mid-resize, and
        /// only once the width holds still: Side by Side's divider is dragged a few points a frame, and a decode a
        /// frame would be tens of milliseconds of decoding thrown away on every one.
        private func decodeIfNeeded(forWidth width: CGFloat) {
            guard let picture, !inLiveResize else { return }
            let wanted = ConchImage.decodeWidth(forDrawnWidth: width, of: picture.pixels)
            guard wanted > 0 else { return }
            let have = decoding?.key == picture.key ? decoding?.width : decoded.map(\.width)
            // A decode that rounded a pixel short of what was asked is the same decode.
            if let have, have >= wanted - 1, have <= wanted { return }
            if !rezoomed, let have, have >= wanted, have <= 2 * wanted { return }
            rezoomed = false
            // The first decode at once; a later one after the width has held still for a moment.
            let settle = decoded != nil
            decoding = (picture.key, wanted)
            decodeTask?.cancel()
            decodeTask = Task { [weak self] in
                if settle {
                    try? await Task.sleep(for: .milliseconds(150))
                    guard !Task.isCancelled else { return }
                }
                let image = await Task.detached(priority: .userInitiated) {
                    ConchImage.decode(picture, forWidth: CGFloat(wanted))
                }.value
                guard !Task.isCancelled, let self, self.picture?.key == picture.key else { return }
                self.decoding = nil
                guard let image else {
                    if let url = self.url { self.onFailure(DeliverableLoadError.reason(url)) }
                    return
                }
                self.decoded = image
                self.imageView.show(image)
                self.needsLayout = true
            }
        }
    }

    func makeNSView(context: Context) -> FitWidthImageScrollView {
        let view = FitWidthImageScrollView()
        if let item = context.environment.agentInkItem { AgentInkController.shared.appeared(view.imageView, image: url.path, showing: item) }
        if let zoom = context.environment.conchZoomTarget {
            zoom.attach(view) { [weak view] action in view?.zoom(action) }
            view.onZoom = { [weak zoom] readout in zoom?.report(readout) }
            view.onTouch = { [weak zoom] in zoom?.touch() }
        }
        return view
    }

    static func dismantleNSView(_ view: FitWidthImageScrollView, coordinator: Coordinator) {
        AgentInkController.shared.gone(view.imageView)
    }

    func updateNSView(_ view: FitWidthImageScrollView, context: Context) {
        view.onFailure = onFailure
        guard context.coordinator.loadedURL != url else { return }
        context.coordinator.loadedURL = url
        view.show(url)
    }
}

/// A deliverable picture in the rect it is drawn in: one layer holding the decode made for this width, handed to Core
/// Animation at a pixel to a pixel. Anything AppKit draws itself (`show(NSImage)`) is an image view filling the rect,
/// which plays a GIF and draws an SVG sharp.
final class DeliverablePictureView: NSView {
    private let picture = CALayer()
    private let appKit = NSImageView()

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        appKit.imageScaling = .scaleProportionallyUpOrDown
        picture.contentsGravity = .resize
        picture.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull()]
        layer?.addSublayer(picture)
    }

    required init?(coder: NSCoder) { nil }

    func clear() {
        picture.contents = nil
        appKit.image = nil
        appKit.removeFromSuperview()
    }

    func show(_ image: NSImage) {
        clear()
        appKit.image = image
        appKit.frame = bounds
        addSubview(appKit)
    }

    func show(_ image: CGImage) {
        clear()
        picture.contents = image
        needsLayout = true
    }

    override func layout() {
        super.layout()
        appKit.frame = bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        picture.frame = bounds
        CATransaction.commit()
    }

    /// The decode drawn now, in pixels, for tests and the render harness.
    var shown: (width: Int, height: Int)? {
        guard let contents = picture.contents else { return nil }
        let image = contents as! CGImage
        return (image.width, image.height)
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
