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

    private static var installed: ConchStatusItem?

    static func install(store: StateStore) {
        guard installed == nil else { return }
        installed = ConchStatusItem(store: store)
        // After the status item, which registers the defaults that show and hide the panels.
        FloatingPanels.install(store: store)
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

    /// Ready for you: a review is filed and the session is not working. The daemon's `reviewReady` (PR #191).
    nonisolated static func readyRows(_ state: PublishedState?) -> [SessionRow] {
        state?.rows.filter { $0.review != nil && $0.status != .working } ?? []
    }

    nonisolated static func workingRows(_ state: PublishedState?) -> [SessionRow] {
        state?.rows.filter { $0.status == .working } ?? []
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

    /// Rebuilt each time it opens, from the state at that moment.
    // ponytail: an open menu does not update live; watch store.$state while open if that ever matters.
    func menuNeedsUpdate(_ menu: NSMenu) {
        let state = store.state
        let voice = Self.voiceState(state)
        let quiet = state?.mode.paused ?? false
        let defaults = UserDefaults.standard
        menu.removeAllItems()

        menu.addItem(header(voice, detail: Self.detail(state, voice, message: store.daemonMessage)))
        menu.addItem(.separator())
        menu.addItem(entry("Talk", #selector(talk), checked: !quiet))
        menu.addItem(entry("Quiet", #selector(quietMode), checked: quiet))
        menu.addItem(.separator())
        // Space is the conch window's stop key.
        let stop = entry(voice == .listening ? "Stop listening" : "Stop speaking", #selector(stopSpeaking), key: " ")
        stop.isEnabled = state?.live.isExchangeActive == true
        menu.addItem(stop)
        menu.addItem(.separator())
        // FloatingPanels watches these two defaults and shows or hides its panels as they change.
        menu.addItem(entry("Show control bar", #selector(toggleControlBar), checked: defaults.bool(forKey: Self.showControlBarKey)))
        menu.addItem(entry("Show conversation", #selector(toggleConversation), checked: defaults.bool(forKey: Self.showConversationKey)))

        let ready = Self.readyRows(state)
        let working = Self.workingRows(state)
        if !ready.isEmpty || !working.isEmpty {
            menu.addItem(.separator())
            addSessions("Ready for you", ready, symbol: "circle.fill", to: menu)
            addSessions("Working", working, symbol: "circle", to: menu)
        }
        menu.addItem(.separator())
        menu.addItem(entry("Open conch", #selector(openConch)))
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

    private func addSessions(_ title: String, _ rows: [SessionRow], symbol: String, to menu: NSMenu) {
        guard !rows.isEmpty else { return }
        menu.addItem(.sectionHeader(title: title))
        let dot = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 7, weight: .regular))
        for row in rows {
            let session = entry(row.label, #selector(openSession(_:)))
            session.representedObject = row.id
            session.image = dot
            menu.addItem(session)
        }
    }

    private func entry(_ title: String, _ action: Selector, checked: Bool = false, key: String = "") -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.target = self
        entry.state = checked ? .on : .off
        entry.keyEquivalentModifierMask = []
        return entry
    }

    // MARK: Commands

    // Talk and Quiet are the daemon's global resume and pause, as the dashboard sends with no session selected.
    @objc private func talk() { store.send(.global(.resume)) }
    @objc private func quietMode() { store.send(.global(.pause)) }
    // The dashboard's spacebar: stops the speech or listening that is running.
    @objc private func stopSpeaking() { store.send(.stop()) }

    @objc private func toggleControlBar() { toggle(Self.showControlBarKey) }
    @objc private func toggleConversation() {
        // Turned on from the menu, the conversation opens full size, not as its collapsed handle.
        if !UserDefaults.standard.bool(forKey: Self.showConversationKey) {
            UserDefaults.standard.set(false, forKey: FloatingPanels.conversationCollapsedKey)
        }
        toggle(Self.showConversationKey)
    }

    private func toggle(_ key: String) {
        UserDefaults.standard.set(!UserDefaults.standard.bool(forKey: key), forKey: key)
    }

    @objc private func openSession(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        bringConchForward()
        // ponytail: if the window has to be rebuilt first, this selection is lost; conch still opens.
        NotificationCenter.default.post(name: .selectSessionFromStatusItem, object: id)
    }

    @objc private func openConch() {
        bringConchForward()
    }

    /// The one place the status item takes focus, for Open conch and choosing a session.
    private func bringConchForward() {
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
