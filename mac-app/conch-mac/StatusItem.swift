import AppKit
import Combine
import ConchDesign
import SwiftUI

extension Notification.Name {
    /// A session chosen in the menu bar menu. ContentView selects it, as a click on its row does.
    static let selectSessionFromStatusItem = Notification.Name("com.conch.mac.select-session-from-status-item")
    /// A deliverable opened from outside conch's window: ContentView selects the session and puts that version in its
    /// deliverable pane, beside the conversation (`ConchStatusItem.openInWindow`). Its object is a `WindowOpen`.
    static let openInWindowFromStatusItem = Notification.Name("com.conch.mac.open-in-window-from-status-item")
}

/// The conch mark in the menu bar (M2): an NSStatusItem whose mark shows the voice's state (`ConchMark`, a template
/// image in every state), and a standard NSMenu when it is clicked. No hover behaviour.
///
/// AppKit rather than SwiftUI's menu bar scene, which draws a custom label once and never redraws it,
/// blocks the run loop while its menu is open, and exposes no item whose window can be watched for the
/// notch hiding it.
///
/// Nothing here activates conch or takes focus except Open conch and choosing a session: switching
/// Talk and Quiet or stopping speech from the menu bar leaves you where you were.
@MainActor
final class ConchStatusItem: NSObject, NSMenuDelegate {
    private static var installed: ConchStatusItem?

    static func install(store: StateStore) {
        guard installed == nil else { return }
        installed = ConchStatusItem(store: store)
        // The natural voices' calm line, for the window's notices.
        NaturalVoicesNoticeStore.shared.install(store: store)
        // The floating pill, shown while its switch is on (on by default), which it watches itself.
        FloatingPillController.shared.install(store: store)
    }

    private let store: StateStore
    private let item: NSStatusItem
    private var stateSubscription: AnyCancellable?
    private var occlusionObserver: NSObjectProtocol?
    private var shownInMenuBar: Bool?

    private init(store: StateStore) {
        self.store = store
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        item.autosaveName = "conch"
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        item.menu = menu

        show(Self.voiceState(store.state))
        stateSubscription = store.$state
            .map(Self.voiceState)
            .removeDuplicates()
            .sink { [weak self] voice in
                MainActor.assumeIsolated { self?.show(voice) }
            }
        watchOcclusion()
    }

    // MARK: State

    /// Ready for you: the session isn't working and holds a deliverable nobody has looked at or approved yet
    /// (`ReadyForYou`, the daemon's `reviewReady`). What the menu bar mark, the menu and the switcher count.
    nonisolated static func readyRows(_ state: PublishedState?) -> [SessionRow] {
        state?.rows.filter { ReadyForYou.isReady(working: $0.status == .working, held: $0.held.map { ($0.viewedAt, $0.approvedAt) }) } ?? []
    }

    /// Every session that isn't working and still holds a deliverable, looked at or not (`ReviewQueue.held`).
    nonisolated static func heldRows(_ state: PublishedState?) -> [SessionRow] {
        state?.rows.filter { $0.review != nil && $0.status != .working } ?? []
    }

    nonisolated static func workingRows(_ state: PublishedState?) -> [SessionRow] {
        state?.rows.filter { $0.status == .working } ?? []
    }

    nonisolated static func voiceState(_ state: PublishedState?) -> VoiceState {
        guard let state else { return .talk }
        return VoiceState.resolve(live: state.live.state, paused: state.mode.paused, readyCount: readyRows(state).count)
    }

    /// The state's mark, which macOS inks for the bar in every state.
    private func show(_ voice: VoiceState) {
        guard let button = item.button else { return }
        button.image = ConchMark.statusImage(for: voice)
        button.setAccessibilityLabel("conch, \(voice.title)")
    }

    // MARK: Menu

    /// Rebuilt each time it opens, from the state at that moment. The words and what each does are `StatusMenu`'s.
    // ponytail: an open menu does not update live; watch store.$state while open if that ever matters.
    func menuNeedsUpdate(_ menu: NSMenu) {
        let state = store.state
        let voice = Self.voiceState(state)
        menu.removeAllItems()
        let input = StatusMenu.Input(
            voice: voice,
            quiet: state?.mode.paused ?? false,
            exchangeActive: state?.live.isExchangeActive == true,
            ready: Self.readyRows(state).map { StatusMenu.Session(id: $0.id, label: $0.label) },
            working: Self.workingRows(state).map { StatusMenu.Session(id: $0.id, label: $0.label) },
            // Setup put away with steps left: a reminder at the top until it's done.
            setupLeft: OnboardingController.shared.menuReminder(),
            readAloud: !(state?.mode.speechOff ?? false),
            floatingPill: FloatingPillController.isOn
        )
        for row in StatusMenu.rows(input) {
            switch row {
            case .header: menu.addItem(header(voice, detail: Self.detail(state, voice, message: store.daemonMessage)))
            case .separator: menu.addItem(.separator())
            case let .section(title): menu.addItem(.sectionHeader(title: title))
            case let .item(item): menu.addItem(entry(item))
            }
        }
    }

    private func header(_ voice: VoiceState, detail: String) -> NSMenuItem {
        let label = VoiceStateLabel(state: voice, detail: detail, orbSize: 30)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .frame(width: 280, alignment: .leading)
        let view = NSHostingView(rootView: label)
        view.frame.size = view.fittingSize
        let header = NSMenuItem()
        header.view = view
        return header
    }

    /// What the voice is about, under its state, in the menu header.
    nonisolated static func detail(_ state: PublishedState?, _ voice: VoiceState, message: String?) -> String {
        if let message { return message }
        if voice == .ready {
            let ready = Self.readyRows(state)
            return ready.count == 1 ? ready[0].label : "\(ready.count) sessions"
        }
        return state?.live.label ?? ""
    }

    /// One of `StatusMenu`'s items as an NSMenuItem: its command, its tick, its key, and
    /// its dot. An alternate takes the place of the item before it while ⌥ is held.
    private func entry(_ item: StatusMenu.Item) -> NSMenuItem {
        let entry = NSMenuItem(title: item.title, action: action(item.command), keyEquivalent: item.key)
        entry.target = self
        entry.state = item.mark == .on ? .on : .off
        entry.keyEquivalentModifierMask = NSEvent.ModifierFlags(item.modifiers.map { modifier -> NSEvent.ModifierFlags in
            switch modifier {
            case .control: .control
            case .option: .option
            case .command: .command
            }
        })
        entry.isAlternate = item.alternate
        entry.isEnabled = item.enabled
        entry.indentationLevel = item.indent
        switch item.command {
        case let .openItem(session), let .openSession(session): entry.representedObject = session
        default: break
        }
        if let dot = item.dot { entry.image = Self.dot(dot) }
        if item.command == .finishSetup { Self.dressSetupReminder(entry, detail: item.detail) }
        return entry
    }

    /// "Finish setting up conch", with conch's icon and what's left under it: the menu's own second line where macOS
    /// has one, else after the title.
    private static func dressSetupReminder(_ entry: NSMenuItem, detail: String?) {
        let icon = NSApp.applicationIconImage.copy() as? NSImage
        icon?.size = NSSize(width: 26, height: 26)
        entry.image = icon
        guard let detail else { return }
        if #available(macOS 14.4, *) {
            entry.subtitle = detail
        } else {
            entry.title = "\(entry.title) · \(detail)"
        }
    }

    private func action(_ command: StatusMenu.Command) -> Selector {
        switch command {
        case .talk: #selector(talk)
        case .quiet: #selector(quietMode)
        case .stop: #selector(stopSpeaking)
        case .openItem: #selector(openItem(_:))
        case .openSession: #selector(openSession(_:))
        case .openConch: #selector(openConch)
        case .readAloud: #selector(toggleReadAloud)
        case .finishSetup: #selector(finishSetup)
        case .settings: #selector(openSettings)
        case .floatingPill: #selector(toggleFloatingPill)
        }
    }

    /// Each group's mark in the colour the sidebar draws the same state in: ready's green, working's
    /// blue, both filled. They were template images in the menu's own ink, so working read as nothing
    /// happening and ready no louder than it.
    private static func dot(_ dot: StatusMenu.Dot) -> NSImage? {
        let tint = NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return NSColor(dot.colour.rgba(isDark ? .dark : .light).color)
        }
        let image = NSImage(systemSymbolName: dot.symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(
                NSImage.SymbolConfiguration(pointSize: 7, weight: .regular)
                    .applying(NSImage.SymbolConfiguration(paletteColors: [tint]))
            )
        // Coloured, so not a template: a menu tints a template image with its own ink.
        image?.isTemplate = false
        return image
    }

    // MARK: Commands

    // Talk and Quiet are the daemon's global resume and pause, as the dashboard sends with no session selected.
    @objc private func talk() { store.send(.global(.resume)) }
    @objc private func quietMode() { store.send(.global(.pause)) }
    // Read replies aloud: on if it is off now, off if it is on.
    @objc private func toggleReadAloud() { store.setReadAloud(store.state?.mode.speechOff ?? false) }
    // The dashboard's spacebar: stops the speech or listening that is running.
    @objc private func stopSpeaking() { store.send(.stop()) }

    // The pill hears its switch flip (`FloatingPillController.apply`).
    @objc private func toggleFloatingPill() {
        UserDefaults.standard.set(!FloatingPillController.isOn, forKey: FloatingPill.key)
    }

    @objc private func openSession(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        Self.openSession(id)
    }

    /// A Ready for you row: its session's next ready item, opened by the one opening rule (`open`).
    @objc private func openItem(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        ReviewQueue.shared.open(session: id, store: store)
    }

    /// conch's window on a session: chosen in the menu, or a scene that falls through to conch.
    static func openSession(_ id: SessionRow.ID) {
        bringConchForward()
        // ponytail: if the window has to be rebuilt first, this selection is lost; conch still opens.
        NotificationCenter.default.post(name: .selectSessionFromStatusItem, object: id)
    }

    @objc private func openConch() {
        Self.bringConchForward()
    }

    /// Settings…: conch's window, forward, on its Settings page where it was left. The page is the window's
    /// (`SettingsRouter`), so a window that has to be built first opens on it too.
    @objc private func openSettings() {
        SettingsRouter.shared.open()
    }

    /// Setup's window, where it was left.
    @objc private func finishSetup() {
        OnboardingController.shared.finishSettingUp()
    }

    /// The one opening rule, for the menu's Ready for you rows and the floating pill alike. What conch's own window draws
    /// in its deliverable pane (`SessionRow.windowContent`) opens there, beside the conversation (`openInWindow`), and so
    /// does a review only conch can show as it was published (marks, a folder's tree); everything else is brought forward
    /// in its own app (`stage`).
    ///
    /// 2026-11-11: the conversation panel this used to choose between is gone with the rest of the old overlays, so the
    /// rule is what it already was with them switched off.
    static func open(_ row: SessionRow, store: StateStore) async -> Bool {
        let marked = !(row.review?.marks.isEmpty ?? true)
        // Marks, a folder's tree, or a Figma file's embed: conch shows each as it was published, so they open in conch's
        // window from anywhere, never handed to Figma (2026-11-11, "Make figma show in the deliverables area instead of
        // automatically sending me to figma").
        let link = ReviewItem(row: row)?.link.map { LinkTarget.url(for: $0, cwd: row.cwd) }
        if row.windowContent != nil || ReviewScene.opensOnlyInConch(deliverable: row.review?.kind, marked: marked, link: link) {
            openInWindow(row, store: store)
            return true
        }
        return await stage(row, store: store)
    }

    /// What `openInWindowFromStatusItem` carries: the session, and the version of its deliverable to show.
    struct WindowOpen {
        let sessionId: SessionRow.ID
        let reviewId: ReviewItem.ID?
    }

    /// conch's window, forward, on the session, its deliverable pane beside the conversation on this version
    /// (`row.review`), as a click on the deliverable's card in the conversation opens it. The screen context hears it as
    /// the main window's.
    static func openInWindow(_ row: SessionRow, store: StateStore) {
        let review = ReviewItem(row: row)
        bringConchForward()
        // ponytail: if the window has to be rebuilt first, this is lost, as `openSession`'s selection is; conch still opens.
        NotificationCenter.default.post(name: .openInWindowFromStatusItem, object: WindowOpen(sessionId: row.id, reviewId: review?.id))
        store.reportShowing(.conch(sessionId: row.id, view: "main"), staged: ConchScreenStaged(sessionId: row.id, reviewId: review?.id, link: review?.link))
    }

    /// What this session's review is about, brought forward in its own app, in `ReviewScene`'s order for the scene the
    /// review asked for (none is auto): what `open` does with anything conch's window doesn't show. A scene that fails falls
    /// through to the next, down to conch's window on the session. True once it was handed off; nothing is raised later.
    static func stage(_ row: SessionRow, store: StateStore) async -> Bool {
        let window = ReviewNotifications.shared.reviewWindow
        let kind = ReviewScene.Kind(rawValue: row.review?.sceneKind ?? "") ?? .auto
        var link = ReviewItem(row: row)?.link.map { LinkTarget.url(for: $0, cwd: row.cwd) }
        var revealable = row.revealable
        // What the screen context is told this click put on screen, and for whom (the conch-staged observer).
        let review = ReviewItem(row: row)
        let staged = ConchScreenStaged(sessionId: row.id, reviewId: review?.id, link: review?.link)
        while true {
            switch ReviewScene.choose(
                kind: kind,
                link: link,
                fileExists: { FileManager.default.fileExists(atPath: $0) },
                appWindowOpen: window.map { $0.isVisible && !$0.isMiniaturized } ?? false,
                revealable: revealable
            ) {
            case let .open(url):
                // A page on this Mac whose server has stopped: conch's window on the session, whose pane says so and
                // offers to ask for it again (`ServerDownView`), rather than a browser tab that can't connect.
                if LocalServer.port(of: url) != nil, !(await LocalServer.isListening(url)) {
                    openSession(row.id)
                    store.reportShowing(.conch(sessionId: row.id, view: "main"), staged: staged)
                    return true
                }
                // Through the one door for links, which logs a failure; the pill has no pane to show it in.
                let opened = await withCheckedContinuation { done in
                    store.openLink(LinkTarget.text(of: url), cwd: nil, rowId: row.id, onOpened: { app in
                        store.reportShowing(ConchScreenSurface(opened: url), app: app, staged: staged)
                        done.resume(returning: true)
                    }) { _ in
                        done.resume(returning: false)
                    }
                }
                if opened { return true }
                link = nil
            case .terminal:
                // The daemon's ack, a process to raise, is the handoff. reveal raises the window inside Terminal and leaves
                // the front alone (revealOnTurn's raise), so a click brings Terminal forward too: opening a running app
                // activates it, and never launches one that isn't running.
                if await store.reveal(row).value {
                    if let terminal = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Terminal").first?.bundleURL {
                        _ = try? await NSWorkspace.shared.openApplication(at: terminal, configuration: NSWorkspace.OpenConfiguration())
                    }
                    store.reportShowing(.terminal, app: ConchScreenApp(bundleId: "com.apple.Terminal"), staged: staged)
                    return true
                }
                revealable = false
            case .app:
                openSession(row.id)
                store.reportShowing(.conch(sessionId: row.id, view: "main"), staged: staged)
                return true
            }
        }
    }

    /// The one place the status item takes focus, for Open conch, choosing a session, and a scene that falls through to
    /// conch: conch's window in front, or built again when it was closed. Settings comes forward the same way
    /// (`SettingsRouter`).
    static func bringConchForward() {
        NSApp.activate(ignoringOtherApps: true)
        guard let window = ReviewNotifications.shared.reviewWindow else {
            // No dashboard window: open conch the way a Dock click does, which builds one.
            NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: NSWorkspace.OpenConfiguration())
            return
        }
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
    }

    // MARK: Notch

    /// A Mac with a notch hides status items once the menu bar runs out of room, and tells no app.
    /// The item's own window knows, so watch it: log each change, and keep conch a regular app with its
    /// Dock icon and window, so it stays one click away. A full-screen space hiding the whole menu bar
    /// reads the same, and the log line says so.
    ///
    /// On macOS 26 the item is drawn by Control Center, but AppKit still gives the button a stand-in window
    /// whose occlusion state loses `.visible` when there is no room (checked in a scratch app, Sep 2026). That
    /// window may not exist yet when conch installs the item, which used to end the watch silently, so it is
    /// attached again after the delay, and a watch that still cannot attach says so once.
    private func watchOcclusion() {
        attachOcclusionObserver()
        // A bar already full at launch may never post a change, so look once it has had time to lay out.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self else { return }
            attachOcclusionObserver()
            guard occlusionObserver != nil else {
                return NSLog("conch: cannot watch the menu bar item (its button has no window), so a notch hiding it goes unnoticed")
            }
            occlusionChanged()
        }
    }

    private func attachOcclusionObserver() {
        guard occlusionObserver == nil, let window = item.button?.window else { return }
        occlusionObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didChangeOcclusionStateNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.occlusionChanged() }
        }
    }

    private func occlusionChanged() {
        guard let window = item.button?.window else { return }
        let visible = window.occlusionState.contains(.visible)
        guard visible != shownInMenuBar else { return }
        shownInMenuBar = visible
        if visible {
            NSLog("conch: the menu bar item is visible")
        } else {
            NSLog("conch: the menu bar item is hidden (no room beside the notch, or the menu bar is hidden); conch stays in the Dock")
            if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) }
        }
    }
}

/// What is held, opened from the menu's Ready for you rows and the floating pill: one queue, so every open agrees on what
/// has been looked at.
/// 2026-11-11: the Ready pill's walk and the panel's Previous, Next and switcher went with the old overlays; what is left
/// is opening a session's next ready item.
@MainActor
final class ReviewQueue {
    static let shared = ReviewQueue()

    /// The versions handed off this launch: counted looked at before the daemon's answer catches up.
    private var opened: Set<ReviewItem.ID> = []
    /// The open being staged. Opens run one at a time.
    private var staging: Task<Void, Never>?

    /// Every deliverable a session that isn't working still holds, not only its newest, looked at or not. Each by its
    /// exact version (`ReviewItem.id`: what the daemon minted when it was filed), never by a place in the queue.
    static func held(_ state: PublishedState?) -> [ReviewItem] {
        ConchStatusItem.heldRows(state).flatMap { row in row.held.map { ReviewItem(row: row, review: $0) } }
    }

    /// What is ready: the held ones nobody has looked at yet (`ReadyForYou`), oldest filed first.
    func ready(in held: [ReviewItem], state: PublishedState?) -> [ReviewItem] {
        let seen = seen(in: held, state: state)
        let order = ReviewScene.order(held.map { (key: $0.id, at: $0.reviewedAt ?? 0) })
        return order.compactMap { key in held.first { $0.id == key && !seen.contains(key) } }
    }

    /// What has been looked at, or approved: whatever the daemon remembers, on any device, plus whatever this app has just
    /// handed off. The local half is optimistic, and it is the whole story against a daemon too old to remember, which is
    /// what `features.viewedState` distinguishes.
    private func seen(in held: [ReviewItem], state: PublishedState?) -> Set<ReviewItem.ID> {
        guard state?.features?.viewedState != nil else { return opened }
        return opened.union(held.filter { !ReadyForYou.isWaiting(viewedAt: $0.viewedAt, approvedAt: $0.approvedAt) }.map(\.id))
    }

    /// A session's next item nobody has looked at, oldest filed first, else its newest; opened by the one opening rule
    /// (`ConchStatusItem.open`), and counted opened only once handed off. Never the mic or speech.
    func open(session id: SessionRow.ID, store: StateStore) {
        let held = Self.held(store.state).filter { $0.rowID == id }
        guard let item = ready(in: held, state: store.state).first ?? held.last else { return }
        let previous = staging
        staging = Task { @MainActor in
            await previous?.value
            guard let found = Self.find(item.id, in: store.state) else { return }
            guard await ConchStatusItem.open(found, store: store) else { return }
            opened.insert(item.id)
            // So the phone, the terminal and the next launch agree with this app.
            if store.state?.features?.viewedState != nil {
                store.markReviewViewed(sessionId: found.id, review: item.id)
            }
        }
    }

    /// A held review by its exact version, as its session's row holding it.
    private static func find(_ key: ReviewItem.ID, in state: PublishedState?) -> SessionRow? {
        for row in ConchStatusItem.heldRows(state) {
            if let review = row.held.first(where: { ReviewItem(row: row, review: $0).id == key }) { return row.holding(review) }
        }
        return nil
    }
}

extension SessionRow {
    /// Every deliverable the session still holds, oldest first; from a daemon too old to send them all, its newest. An
    /// empty list is that too: a ready row must never drop out of the queue its `review` put it in.
    var held: [ReviewInfo] {
        if let reviews, !reviews.isEmpty { return reviews }
        return review.map { [$0] } ?? []
    }

    /// This row with `review` as its newest, so `ConchStatusItem.stage`, which brings a row's `review` forward, brings
    /// an older held one.
    func holding(_ review: ReviewInfo) -> SessionRow {
        var row = self
        row.review = review
        return row
    }

    /// Its newest deliverable, when conch's window draws it itself in its deliverable pane (`ReviewScene.panelShowsContent`:
    /// the renderers the conversation panel shared with that pane); read as `ConchStatusItem.stage` reads a scene.
    var windowContent: ReviewItem? {
        guard let review, let item = ReviewItem(row: self) else { return nil }
        let kind = ReviewScene.Kind(rawValue: review.sceneKind ?? "") ?? .auto
        let link = item.link.map { LinkTarget.url(for: $0, cwd: cwd) }
        return ReviewScene.panelShowsContent(kind: kind, deliverable: review.kind, link: link, fileExists: { FileManager.default.fileExists(atPath: $0) }) ? item : nil
    }
}
