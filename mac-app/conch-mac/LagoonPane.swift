import AppKit
import ConchDesign
import OSLog
import SwiftUI
import WebKit

// The lagoon as a page in the window (the brand repo's experiments/bridge/MAC-APP-SPEC.md): conch's sessions as hermit
// crabs on a three.js beach, in place of the conversation, in the same panel. Phase A (2026-10-04): read-only, behind the
// hidden setting `conch.lagoon.enabled` (Debug ▸ Show Lagoon), and only in a build that carries the page
// (`Contents/Resources/Lagoon`, copied in by scripts/build-app.sh from the brand repo; never committed here).
//
// LagoonWeb.swift is the web view, its scheme and its script handler; this is the app around it: when it shows, what it
// is fed, what it may do.

extension Notification.Name {
    /// ⌘0, Session ▸ Lagoon, and the header's shell: the lagoon, or back to the conversation. Posted, like ⌘1–⌘3
    /// (`setStage`), so the shortcut works whatever holds focus and the menu and the button are one path.
    static let showLagoon = Notification.Name("com.conch.mac.show-lagoon")
}

enum LagoonFeature {
    /// The app's copy of the page, when this build carries one. Read once: a bundle's resources don't change under it.
    static let bundleRoot: URL? = Bundle.main.url(forResource: Lagoon.bundleName, withExtension: nil)

    /// Whether the lagoon can be shown at all: switched on, and in this build.
    static func available(enabled: Bool) -> Bool { enabled && bundleRoot != nil }

    /// The page the window shows: the lagoon only while it is available, whatever was remembered.
    static func page(_ stored: Lagoon.Page, enabled: Bool) -> Lagoon.Page {
        available(enabled: enabled) ? stored : .sessions
    }

    /// Every message the page sends, and what came of it: `log stream --predicate 'category == "lagoon"'`.
    static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "ai.blueprintstudio.conch", category: Lagoon.logCategory)

    static func name(_ liveness: DaemonLiveness) -> String {
        switch liveness {
        case .checking: "checking"
        case .alive: "alive"
        case .dead: "dead"
        case .stalled: "stalled"
        }
    }
}

/// Debug ▸ Show Lagoon: the hidden setting, in the same place as the Terminal Mirror's. Off by default.
struct LagoonMenuToggle: View {
    @AppStorage(Lagoon.enabledKey) private var isOn = false

    var body: some View {
        if LagoonFeature.bundleRoot == nil {
            Toggle("Show Lagoon (not in this build)", isOn: .constant(false)).disabled(true)
        } else {
            Toggle("Show Lagoon", isOn: $isOn)
        }
    }
}

/// Session ▸ Lagoon, ⌘0: only there while the lagoon is.
struct LagoonMenuItem: View {
    @AppStorage(Lagoon.enabledKey) private var enabled = false

    var body: some View {
        if LagoonFeature.available(enabled: enabled) {
            Button("Lagoon") { NotificationCenter.default.post(name: .showLagoon, object: nil) }
                .keyboardShortcut("0", modifiers: .command)
        }
    }
}

/// The window's lagoon, for as long as the window lives: going to the conversation and back finds it where it was. Its web
/// view goes after ten minutes unseen (`LagoonWebHost`), and comes back the next time it is shown.
@MainActor
final class LagoonModel: ObservableObject {
    /// Bumped when the web view is let go, so a lagoon on screen puts the new one in its place.
    @Published private(set) var webGeneration = 0
    private(set) var host: LagoonWebHost?
    private let actions = LagoonStoreActions()

    /// The host, made the first time the lagoon is shown (making it makes no web view yet).
    func host(store: StateStore, workspace: WorkspaceModel) -> LagoonWebHost? {
        actions.store = store
        actions.workspace = workspace
        if let host { return host }
        guard let root = LagoonFeature.bundleRoot else { return nil }
        let made = LagoonWebHost(bundleRoot: root, environment: .init(
            source: { [weak store] in store?.state.map(LagoonSnapshot.Source.init) },
            resolveLink: { LinkTarget.url(for: $0, cwd: $1) },
            flags: { LagoonActionFlags(defaultsValue: UserDefaults.standard.object(forKey: Lagoon.actionsKey)) },
            home: NSHomeDirectory(),
            report: { [weak self] in self?.log($0) }
        ))
        made.sink = actions
        host = made
        return made
    }

    func focus(_ sessionId: String) {
        host?.focus(sessionId)
    }

    /// Switched off: the web view goes now, not in ten minutes.
    func teardown() {
        host?.drop()
        host = nil
    }

    private func log(_ report: LagoonWebHost.Report) {
        let log = LagoonFeature.log
        switch report {
        case let .refused(reason, body):
            log.notice("refused (\(reason, privacy: .public)): \(body, privacy: .private)")
        case let .routed(message, routing):
            // Ids are conch's own; what was typed is the person's, and stays out of a shared log.
            log.info("\(message.name.rawValue, privacy: .public) \(String(describing: routing), privacy: .public) session=\(message.sessionId ?? "-", privacy: .public) review=\(message.reviewId ?? "-", privacy: .public) how=\(message.how?.rawValue ?? "-", privacy: .public) readOnly=\(message.readOnly, privacy: .public) text=\(message.text ?? "", privacy: .private)")
        case let .callFailed(what):
            log.error("call into the page failed: \(what, privacy: .public)")
        case .loaded:
            log.info("page loaded")
        case .dropped:
            log.info("web view let go")
            webGeneration += 1
        }
    }
}

/// The lagoon's actions, on the app's own paths (spec §5). Phase B and C's are compiled and never reached in phase A:
/// `LagoonIntentRouter` hands one here only when its name's flag is on in `conch.lagoon.actions`. Approve, its undo and
/// a reply act with no flag (`LagoonIntent.byDefault`).
@MainActor
final class LagoonStoreActions: LagoonActionSink {
    weak var store: StateStore?
    weak var workspace: WorkspaceModel?

    private func row(_ id: String) -> SessionRow? {
        store?.state?.rows.first { $0.id == id }
    }

    /// The review a lagoon key names (`LagoonSnapshot.reviewKey`), and the id the rest of the app knows it by.
    private func review(_ reviewId: String, in row: SessionRow) -> (info: ReviewInfo, item: String)? {
        let held = LagoonSnapshot.held(reviews: row.reviews, review: row.review)
        for (index, info) in held.enumerated() where LagoonSnapshot.reviewKey(id: info.id, artifact: info.artifact, index: index) == reviewId {
            return (info, ReviewItem(row: row, review: info).id)
        }
        return nil
    }

    /// B: the crab was clicked. The sidebar highlights it; the page stays.
    func focusSession(_ sessionId: String) {
        guard row(sessionId) != nil else { return }
        workspace?.viewing = sessionId
    }

    /// B: the lagoon showed the work on its glass.
    func markReviewViewed(sessionId: String, reviewId: String) {
        guard let row = row(sessionId), let found = review(reviewId, in: row), found.info.viewedAt == nil else { return }
        store?.markReviewViewed(sessionId: sessionId, review: found.item)
    }

    /// B: Open ↗. A link outside the app opens where it lives; anything else is staged as the session's deliverable, and the
    /// window leaves the lagoon for it.
    func openReview(sessionId: String, reviewId: String) {
        guard let store, let workspace, let row = row(sessionId), let found = review(reviewId, in: row) else { return }
        if let link = found.info.link {
            let url = LinkTarget.url(for: link, cwd: row.cwd)
            if !url.isFileURL, !LagoonSnapshot.isWebLink(link) {
                store.openLink(link, cwd: row.cwd, rowId: row.id) { failure in
                    LagoonFeature.log.error("open from the lagoon failed: \(failure, privacy: .public)")
                }
                return
            }
        }
        workspace.viewing = sessionId
        workspace.show(work: .deliverable, for: sessionId)
        workspace.select(deliverable: found.item, for: sessionId)
        workspace.show(stage: .deliverable, for: sessionId)
        UserDefaults.standard.set(Lagoon.Page.sessions.rawValue, forKey: Lagoon.pageKey)
    }

    /// What you typed to it on the glass, without its @name: live with no flag since 2026-10-05 (Tyler's go, replies only),
    /// read-only page or not. Exactly the composer's send (`SessionComposer`'s `onSend`): the same store action, so the
    /// same delivery path; the gate has checked the session is in the state and the text is at most 4,000 characters.
    func reply(sessionId: String, text: String) {
        guard let row = row(sessionId), row.parentSessionId == nil else { return }
        store?.send(.inject(sessionId: row.id, label: row.label, text: text))
    }

    /// C: exactly `DashboardView`'s `onApprove`, for the prompt the row shows now.
    func answer(sessionId: String, allow: Bool, approvalId: String) {
        guard let row = row(sessionId), let approval = row.approval, approval.id == approvalId, approval.answerable != false else { return }
        store?.send(.inject(
            sessionId: row.id,
            label: row.label,
            text: "\(allow ? "Allow" : "Deny") \(approval.name)",
            approve: ConchApproval(kind: allow ? "once" : "deny", id: approval.id)
        ))
    }

    /// C: conch's Quiet for that session, as `toggleQuiet` does for one that isn't quiet; one that is stays as it is.
    func pause(sessionId: String) {
        guard let store, let row = row(sessionId),
              row.voice(everythingQuiet: store.state?.mode.paused ?? false).togglesToQuiet else { return }
        store.send(.scoped(.pause, sessionId: row.id, label: row.label))
    }

    /// Approve, from the lagoon's glass, with no flag (`LagoonIntent.byDefault`, 2026-10-05, Tyler's decision): the same
    /// store action as the review pane's ✓ Approve. The daemon makes a second approval of one result change nothing.
    func approveReview(sessionId: String, reviewId: String) {
        guard let store, let row = row(sessionId), let found = review(reviewId, in: row) else { return }
        Task { await store.approveReview(sessionId: row.id, review: found.item) }
    }

    /// The lagoon's Undo, within 10 s: the daemon refuses it after that, and its words go on the row.
    func unapproveReview(sessionId: String, reviewId: String) {
        guard let store, let row = row(sessionId), let found = review(reviewId, in: row) else { return }
        Task { await store.unapproveReview(sessionId: row.id, review: found.item) }
    }
}

/// The lagoon, in the stage's panel. It draws only while it can be seen: the page in front, its window visible
/// (`conchHidden`), and conch not hidden.
struct LagoonPane: View {
    @EnvironmentObject private var store: StateStore
    @EnvironmentObject private var workspace: WorkspaceModel
    @EnvironmentObject private var lagoon: LagoonModel
    @Environment(\.conchHidden) private var windowHidden
    @State private var appHidden = NSApp.isHidden
    @State private var shown = false

    /// The sand the page paints, behind it until its first frame.
    private static let sand = Color(red: 0.914, green: 0.812, blue: 0.690)

    var body: some View {
        let host = lagoon.host(store: store, workspace: workspace)
        ZStack {
            Self.sand
            if let host {
                LagoonWebContainer(host: host, generation: lagoon.webGeneration, visible: shown && !windowHidden && !appHidden)
            }
        }
        .onAppear {
            shown = true
            report(host, shown: true)
            if let state = store.state { host?.offer(LagoonSnapshot.Source(state)) }
            host?.setLiveness(LagoonFeature.name(store.liveness))
        }
        .onDisappear {
            shown = false
            report(host, shown: false)
        }
        .onChange(of: windowHidden) { _, hidden in report(host, windowHidden: hidden) }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didHideNotification)) { _ in
            appHidden = true
            report(host, appHidden: true)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didUnhideNotification)) { _ in
            appHidden = false
            report(host, appHidden: false)
        }
        // The store publishes `state` only when what it shows changed (`hasSamePresentation`); the pacer takes it only
        // when its `ts` moved on, at most four a second.
        .onReceive(store.$state) { state in
            guard let state else { return }
            host?.offer(LagoonSnapshot.Source(state))
        }
        .onReceive(store.$liveness) { host?.setLiveness(LagoonFeature.name($0)) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("The lagoon: your sessions as hermit crabs")
    }

    /// Whether it can be seen, with the value that just changed passed in (a `@State` written in the same closure isn't
    /// promised to read back new).
    private func report(_ host: LagoonWebHost?, shown: Bool? = nil, windowHidden: Bool? = nil, appHidden: Bool? = nil) {
        host?.setVisibility(LagoonVisibility(
            pageCurrent: shown ?? self.shown,
            windowVisible: !(windowHidden ?? self.windowHidden),
            appHidden: appHidden ?? self.appHidden
        ))
    }
}

/// The host's web view, in a plain view of its own: the web view outlives this (the window's `LagoonModel` holds it), so
/// it is put in on show, taken out on hide, and replaced when a new one was made. A web view is only ever MADE while the
/// lagoon can be seen: one let go after ten minutes behind a minimised window stays gone until the window is back.
struct LagoonWebContainer: NSViewRepresentable {
    let host: LagoonWebHost
    /// `LagoonModel.webGeneration`: a change means the web view this holds was let go.
    let generation: Int
    let visible: Bool

    func makeNSView(context: Context) -> LagoonContainerView {
        let view = LagoonContainerView()
        updateNSView(view, context: context)
        return view
    }

    func updateNSView(_ view: LagoonContainerView, context: Context) {
        if let web = visible ? host.attach() : host.webView {
            view.show(web)
        } else {
            view.subviews.forEach { $0.removeFromSuperview() }
        }
    }

    static func dismantleNSView(_ view: LagoonContainerView, coordinator: ()) {
        view.subviews.forEach { $0.removeFromSuperview() }
    }
}

final class LagoonContainerView: NSView {
    func show(_ web: WKWebView) {
        guard web.superview !== self else { return }
        subviews.forEach { $0.removeFromSuperview() }
        web.removeFromSuperview()
        web.frame = bounds
        web.autoresizingMask = [.width, .height]
        addSubview(web)
    }
}
