import AppKit
import Combine
import ConchDesign
import SwiftUI

extension Notification.Name {
    /// A session chosen in the menu bar menu. ContentView selects it, as a click on its row does.
    static let selectSessionFromStatusItem = Notification.Name("com.conch.mac.select-session-from-status-item")
}

/// The conch mark in the menu bar (M2): an NSStatusItem whose mark takes the voice's colour, and a
/// standard NSMenu when it is clicked. No hover behaviour.
///
/// AppKit rather than SwiftUI's menu bar scene, which draws a custom label once and never redraws it,
/// blocks the run loop while its menu is open, and exposes no item whose window can be watched for the
/// notch hiding it.
///
/// Nothing here activates conch or takes focus except Open conch and choosing a session: switching
/// Talk and Quiet or stopping speech from the menu bar leaves you where you were.
@MainActor
final class ConchStatusItem: NSObject, NSMenuDelegate {
    static let showControlBarKey = "conch.showControlBar"
    static let showConversationKey = "conch.showConversation"
    /// The conversation panel's reply line; off, the panel only shows the words.
    static let showReplyLineKey = "conch.showReplyLine"
    /// A first open from the Ready pill or the menu has turned the conversation panel on (`open`): once, so a panel
    /// turned off after that stays off.
    static let panelTurnedOnByOpenKey = "conch.conversationTurnedOnByOpen"

    private static var installed: ConchStatusItem?

    static func install(store: StateStore) {
        guard installed == nil else { return }
        installed = ConchStatusItem(store: store)
        // After the status item, which registers the defaults that show and hide the panels.
        FloatingPanels.install(store: store)
        // After the panels, whose staged item it follows.
        CanvasController.shared.install(store: store)
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
        // The control bar is on until someone turns it off; the conversation opens when asked.
        UserDefaults.standard.register(defaults: [
            Self.showControlBarKey: true,
            Self.showConversationKey: false,
            Self.showReplyLineKey: true,
        ])
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

    /// Ready for you: the session isn't working and holds a deliverable nobody has looked at yet (`ReadyForYou`, the
    /// daemon's `reviewReady`). What the menu bar mark, the menu and the switcher count.
    nonisolated static func readyRows(_ state: PublishedState?) -> [SessionRow] {
        state?.rows.filter { ReadyForYou.isReady(working: $0.status == .working, viewedAt: $0.held.map(\.viewedAt)) } ?? []
    }

    /// Every session that isn't working and still holds a deliverable, looked at or not: what the Ready pill and the
    /// panel's Previous and Next can walk to (`ReviewQueue.held`).
    nonisolated static func heldRows(_ state: PublishedState?) -> [SessionRow] {
        state?.rows.filter { $0.review != nil && $0.status != .working } ?? []
    }

    nonisolated static func workingRows(_ state: PublishedState?) -> [SessionRow] {
        state?.rows.filter { $0.status == .working } ?? []
    }

    /// The control bar's second line while it would only repeat Talk or Quiet: how many sessions are at work, or nothing.
    nonisolated static func news(_ state: PublishedState?) -> String? {
        let working = workingRows(state).filter { $0.parentSessionId == nil }.count
        return working > 0 ? "\(working) working" : nil
    }

    nonisolated static func voiceState(_ state: PublishedState?) -> VoiceState {
        guard let state else { return .talk }
        return VoiceState.resolve(live: state.live.state, paused: state.mode.paused, readyCount: readyRows(state).count)
    }

    /// The whole mark recolours; Talk is the template image macOS tints for the bar.
    private func show(_ voice: VoiceState) {
        guard let button = item.button else { return }
        // A touch larger than the 16 pt default (Tyler: "can also be a touch larger up there").
        button.image = ConchMark.statusImage(for: voice, side: 18)
        button.setAccessibilityLabel("conch, \(voice.title)")
    }

    // MARK: Menu

    /// Rebuilt each time it opens, from the state at that moment. The words and what each does are `StatusMenu`'s.
    // ponytail: an open menu does not update live; watch store.$state while open if that ever matters.
    func menuNeedsUpdate(_ menu: NSMenu) {
        let state = store.state
        let voice = Self.voiceState(state)
        let defaults = UserDefaults.standard
        menu.removeAllItems()
        // FloatingPanels watches these defaults and shows or hides its panels, and the conversation's reply line, as they change.
        let input = StatusMenu.Input(
            voice: voice,
            quiet: state?.mode.paused ?? false,
            exchangeActive: state?.live.isExchangeActive == true,
            controlBar: defaults.bool(forKey: Self.showControlBarKey),
            conversation: defaults.bool(forKey: Self.showConversationKey),
            collapsed: defaults.bool(forKey: FloatingPanels.conversationCollapsedKey),
            replyLine: defaults.bool(forKey: Self.showReplyLineKey),
            drawing: CanvasController.shared.armed,
            ready: Self.readyRows(state).map { StatusMenu.Session(id: $0.id, label: $0.label) },
            working: Self.workingRows(state).map { StatusMenu.Session(id: $0.id, label: $0.label) }
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

    /// What the voice is about, under its state: in the menu header and on the control bar.
    nonisolated static func detail(_ state: PublishedState?, _ voice: VoiceState, message: String?) -> String {
        if let message { return message }
        if voice == .ready {
            let ready = Self.readyRows(state)
            return ready.count == 1 ? ready[0].label : "\(ready.count) sessions"
        }
        return state?.live.label ?? ""
    }

    /// One of `StatusMenu`'s items as an NSMenuItem: its command, its tick (a dash for on but not showing), its key, and
    /// its dot. An alternate takes the place of the item before it while ⌥ is held.
    private func entry(_ item: StatusMenu.Item) -> NSMenuItem {
        let entry = NSMenuItem(title: item.title, action: action(item.command), keyEquivalent: item.key)
        entry.target = self
        entry.state = switch item.mark {
        case .off: .off
        case .on: .on
        case .mixed: .mixed
        }
        entry.keyEquivalentModifierMask = NSEvent.ModifierFlags(item.modifiers.map { modifier -> NSEvent.ModifierFlags in
            switch modifier {
            case .control: .control
            case .option: .option
            case .command: .command
            }
        })
        entry.isAlternate = item.alternate
        entry.isEnabled = item.enabled
        switch item.command {
        case let .openItem(session), let .openSession(session): entry.representedObject = session
        default: break
        }
        if let dot = item.dot { entry.image = Self.dot(dot) }
        return entry
    }

    private func action(_ command: StatusMenu.Command) -> Selector {
        switch command {
        case .talk: #selector(talk)
        case .quiet: #selector(quietMode)
        case .stop: #selector(stopSpeaking)
        case .controlBar: #selector(toggleControlBar)
        case .conversation: #selector(toggleConversation)
        case .replyLine: #selector(toggleReplyLine)
        case .draw: #selector(toggleCanvas)
        case .openItem: #selector(openItem(_:))
        case .openSession: #selector(openSession(_:))
        case .openConch: #selector(openConch)
        }
    }

    /// Each group's mark in the colour the sidebar draws the same state in: ready's green, working's
    /// blue, both filled. They were template images in the menu's own ink, so working read as nothing
    /// happening and ready no louder than it; the conversation panel's switcher copies these marks.
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
    // The dashboard's spacebar: stops the speech or listening that is running.
    @objc private func stopSpeaking() { store.send(.stop()) }

    @objc private func toggleControlBar() { toggle(Self.showControlBarKey) }
    @objc private func toggleCanvas() { CanvasController.shared.toggle() }
    @objc private func toggleReplyLine() { toggle(Self.showReplyLineKey) }
    @objc private func toggleConversation() {
        // Turned on from the menu, the conversation opens full size, not as its collapsed handle; folded to its handle,
        // choosing it opens it rather than hiding a panel nobody could see (`StatusMenu.conversationToggle`).
        let defaults = UserDefaults.standard
        let next = StatusMenu.conversationToggle(
            on: defaults.bool(forKey: Self.showConversationKey),
            collapsed: defaults.bool(forKey: FloatingPanels.conversationCollapsedKey)
        )
        defaults.set(next.collapsed, forKey: FloatingPanels.conversationCollapsedKey)
        defaults.set(next.on, forKey: Self.showConversationKey)
    }

    private func toggle(_ key: String) {
        UserDefaults.standard.set(!UserDefaults.standard.bool(forKey: key), forKey: key)
    }

    @objc private func openSession(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        Self.openSession(id)
    }

    /// A Ready for you row: its session's next ready item, opened the way the Ready pill opens one (`open`).
    @objc private func openItem(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let panels = FloatingPanels.installed else { return }
        panels.queue.open(session: id, store: store, panels: panels)
    }

    /// conch's window on a session: chosen in the menu, or the Ready pill's scene.
    static func openSession(_ id: SessionRow.ID) {
        bringConchForward()
        // ponytail: if the window has to be rebuilt first, this selection is lost; conch still opens.
        NotificationCenter.default.post(name: .selectSessionFromStatusItem, object: id)
    }

    @objc private func openConch() {
        Self.bringConchForward()
    }

    /// Where an open came from: the Ready pill and the menu's Ready for you rows open from outside the conversation
    /// panel, its Previous, Next and switcher from inside it.
    enum OpenFrom {
        case pill, menu, panel
    }

    /// The one opening rule, for the pill, the menu's rows and the panel alike. They each did their own: the pill opened
    /// the work in its own app, the panel's Previous and Next in the panel, the menu conch's window, and the pill over a
    /// full-screen panel did both at once.
    ///
    /// While the panel is on, anything it can draw (`SessionRow.panelContent`) opens in it, full screen. So does a
    /// review with marks from anywhere, turning the panel on if it has to: marks are drawn only where conch shows the
    /// work. From inside the panel, a pick with nothing to open is the session's words there. Everything else opens in
    /// its own app (`stage`), the panel docking first so it isn't left over what comes forward. And the first open from
    /// the pill or the menu turns the panel on, docked and open, and it stays on: it was off by default, so nothing
    /// Tyler's setup did could put work on the screen conch draws in.
    static func open(_ row: SessionRow, from origin: OpenFrom, store: StateStore, panels: FloatingPanels) async -> Bool {
        let defaults = UserDefaults.standard
        if origin != .panel, !defaults.bool(forKey: panelTurnedOnByOpenKey) {
            defaults.set(true, forKey: panelTurnedOnByOpenKey)
            panels.bringOut()
        }
        let content = row.panelContent
        let marked = !(row.review?.marks.isEmpty ?? true)
        // What `stage` reads to choose, read the same way.
        let kind = ReviewScene.Kind(rawValue: row.review?.sceneKind ?? "") ?? .auto
        let link = ReviewItem(row: row)?.link.map { LinkTarget.url(for: $0, cwd: row.cwd) }
        let words = origin == .panel
            && ReviewScene.panelShowsWords(hasReview: row.review != nil, kind: kind, link: link, fileExists: { FileManager.default.fileExists(atPath: $0) })
        if (content != nil && (defaults.bool(forKey: showConversationKey) || marked)) || words {
            panels.bringOut()
            panels.showInPanel()
            // The screen context hears what the panel put on screen, as `stage` tells it what a scene did: the session,
            // and the deliverable when that is what shows.
            store.reportShowing(.conch(sessionId: row.id, view: "panel"), staged: ConchScreenStaged(sessionId: row.id, reviewId: content?.id, link: content?.link))
            return true
        }
        panels.dockForScene()
        return await stage(row, store: store)
    }

    /// What this session's review is about, brought forward in its own app, in `ReviewScene`'s order for the scene the
    /// review asked for (none is auto): what `open` does with anything the panel doesn't show. A scene that fails falls
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

    /// The one place the status item takes focus, for Open conch, choosing a session, and the Ready pill's conch scene.
    private static func bringConchForward() {
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
