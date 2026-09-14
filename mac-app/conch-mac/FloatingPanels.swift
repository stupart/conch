import AppKit
import ConchDesign
import SwiftUI

/// A borderless panel over every app, on every space, and out of the window cycle (M3). Non-activating: a
/// click in it never makes conch the active app. It becomes key only if `takesKeys`, and then, with
/// `becomesKeyOnlyIfNeeded`, only when a view that needs the keyboard (the fog's reply field) is clicked.
final class FloatingPanel: NSPanel {
    var takesKeys = false
    override var canBecomeKey: Bool { takesKeys }
    override var canBecomeMain: Bool { false }
}

/// The first click on a control acts. conch never comes forward, so there is no click to focus it first.
private final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The floating control bar and the conversation fog (M3), shown and hidden by the menu bar's
/// Show control bar and Show conversation, and kept where they were last left.
@MainActor
final class FloatingPanels: ObservableObject {
    static let controlBarFrameName = "conch.controlBar"
    static let conversationFrameName = "conch.conversation"
    /// The fog folded down to its handle. A default like the two show keys, so the menu can open it too.
    static let conversationCollapsedKey = "conch.conversationCollapsed"

    private static var installed: FloatingPanels?

    static func install(store: StateStore) {
        guard installed == nil else { return }
        installed = FloatingPanels(store: store)
    }

    /// The fog fills its screen; leaving puts it back in the frame it had.
    @Published private(set) var isFullScreen = false
    @Published private(set) var isCollapsed = false
    /// The screen corner the fog faces (`fogChanged`).
    @Published private(set) var corner: FogCorner = .bottomLeading
    private var fogObservers: [NSObjectProtocol] = []
    /// The open fog's frame, to go back to from the handle.
    private var expandedFrame = NSRect(x: 0, y: 0, width: 760, height: 560)
    /// Where a drag would have put the fog, and the size it was last given: pushed against an edge it shrinks from
    /// these, and grows back to them as it comes away.
    private var virtualOrigin = NSPoint.zero
    private var preferredSize = NSSize(width: 760, height: 560)
    private var lastFrame = NSRect.zero
    /// Set while conch itself moves the fog, so its own frame changes aren't taken for the user's.
    private var adjusting = false
    private static let fogMinSize = NSSize(width: 480, height: 360)
    private var frameBeforeFullScreen: NSRect?
    private let controlBar = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    private let fog = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel, .resizable], backing: .buffered, defer: true)
    private let blur = NSVisualEffectView()
    private var defaultsObserver: NSObjectProtocol?

    /// The corner fog as an image for the blur's mask, one per corner: a behind-window blur ignores layer masks, and
    /// NSVisualEffectView stretches this image to its own size, so one small image serves any panel size.
    private static var masks: [FogCorner: NSImage] = [:]

    private static func blurMask(_ corner: FogCorner) -> NSImage? {
        if let mask = masks[corner] { return mask }
        let image = ImageRenderer(content: ConversationFog.density(fullScreen: false, corner: corner).frame(width: 256, height: 256)).nsImage
        image?.resizingMode = .stretch
        masks[corner] = image
        return image
    }

    private init(store: StateStore) {
        for panel in [controlBar, fog] {
            panel.level = .floating
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
            panel.isExcludedFromWindowsMenu = true
            // conch is almost never the active app, so the default would hide both panels almost always.
            panel.hidesOnDeactivate = false
            panel.isMovableByWindowBackground = true
            panel.isReleasedWhenClosed = false
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = false
        }

        let bar = FirstClickHostingView(rootView: ControlBarHost(store: store, onSize: { [weak self] size in self?.fitControlBar(to: size) }))
        controlBar.contentView = bar
        place(controlBar, name: Self.controlBarFrameName, size: bar.fittingSize) { screen, size in
            // Top centre, just under the menu bar.
            NSPoint(x: screen.midX - size.width / 2, y: screen.maxY - size.height)
        }

        fog.takesKeys = true
        fog.becomesKeyOnlyIfNeeded = true
        fog.minSize = Self.fogMinSize
        blur.material = .underWindowBackground
        blur.blendingMode = .behindWindow
        blur.state = .active
        // The blur and the words are siblings: a visual effect view's mask shapes everything inside it, which faded
        // the words with the fog and hid the collapsed handle along with the blur.
        let container = NSView()
        fog.contentView = container
        let words = FirstClickHostingView(rootView: ConversationFogHost(store: store, panels: self))
        for view in [blur, words] as [NSView] {
            view.frame = container.bounds
            view.autoresizingMask = [.width, .height]
            container.addSubview(view)
        }
        place(fog, name: Self.conversationFrameName, size: NSSize(width: 760, height: 560)) { screen, _ in
            // The bottom-left corner.
            screen.origin
        }
        // Wherever the fog is dragged or resized, it stays on its screen and faces its nearest corner.
        for name in [NSWindow.didMoveNotification, NSWindow.didResizeNotification] {
            fogObservers.append(NotificationCenter.default.addObserver(forName: name, object: fog, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.fogChanged() }
            })
        }
        fogObservers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.fogChanged() }
        })
        remember(fog.frame)
        fogChanged()

        // The menu's toggles and the control bar's conversation button all write these two defaults.
        defaultsObserver = NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.showWhatIsOn() }
        }
        showWhatIsOn()
    }

    /// Where it was last left, or where it starts; saved under `name` from then on.
    private func place(_ panel: NSPanel, name: String, size: NSSize, start: (NSRect, NSSize) -> NSPoint) {
        panel.setContentSize(size)
        if !panel.setFrameUsingName(name), let screen = NSScreen.screens.first?.visibleFrame {
            panel.setFrameOrigin(start(screen, size))
        }
        // The control bar's size is its content's, whatever size was saved.
        if !panel.styleMask.contains(.resizable) { panel.setContentSize(size) }
        panel.setFrameAutosaveName(name)
    }

    private func showWhatIsOn() {
        let defaults = UserDefaults.standard
        setCollapsed(defaults.bool(forKey: Self.conversationCollapsedKey))
        show(controlBar, defaults.bool(forKey: ConchStatusItem.showControlBarKey))
        show(fog, defaults.bool(forKey: ConchStatusItem.showConversationKey))
    }

    /// `orderFrontRegardless` shows a panel without activating conch.
    private func show(_ panel: NSPanel, _ on: Bool) {
        guard on != panel.isVisible else { return }
        if on { panel.orderFrontRegardless() } else { panel.orderOut(nil) }
    }

    /// The bar is exactly as big as what it shows, growing or shrinking about its top centre, where it was put.
    /// Sized once at launch it came out a few points short and cut "Quiet" off.
    private func fitControlBar(to size: CGSize) {
        let frame = controlBar.frame
        guard size.width > 0, abs(frame.width - size.width) > 0.5 || abs(frame.height - size.height) > 0.5 else { return }
        controlBar.setFrame(NSRect(x: frame.midX - size.width / 2, y: frame.maxY - size.height, width: size.width, height: size.height), display: true)
    }

    /// The fog's collapse button and its handle both flip the default; `showWhatIsOn` does the rest.
    func toggleCollapsed() {
        UserDefaults.standard.set(!isCollapsed, forKey: Self.conversationCollapsedKey)
    }

    /// Collapsed, the fog is a small handle in its own corner; opened, it has the frame it had.
    private func setCollapsed(_ collapsed: Bool) {
        guard collapsed != isCollapsed else { return }
        if collapsed, isFullScreen { toggleFullScreen() }
        isCollapsed = collapsed
        adjusting = true
        if collapsed {
            expandedFrame = fog.frame
            // Not saved while collapsed, so the saved frame stays the open one.
            fog.setFrameAutosaveName("")
            fog.styleMask.remove(.resizable)
            fog.minSize = .zero
            // The handle sits in the fog's own corner.
            let side = FogHandle.side
            let x = corner.leading ? expandedFrame.minX : expandedFrame.maxX - side
            let y = corner.bottom ? expandedFrame.minY : expandedFrame.maxY - side
            fog.setFrame(NSRect(x: x, y: y, width: side, height: side), display: true)
            // Collapsed, the fog is only its handle.
            blur.isHidden = true
            adjusting = false
        } else {
            fog.styleMask.insert(.resizable)
            fog.minSize = Self.fogMinSize
            fog.setFrame(expandedFrame, display: true)
            fog.setFrameAutosaveName(Self.conversationFrameName)
            blur.isHidden = false
            adjusting = false
            remember(expandedFrame)
            fogChanged()
        }
    }

    /// Takes `frame` as where the fog is and the size it was given, before any edge cuts it back.
    private func remember(_ frame: NSRect) {
        lastFrame = frame
        virtualOrigin = frame.origin
        preferredSize = frame.size
    }

    /// Keeps the fog on its screen and facing the screen corner nearest it. A drag moves where the fog would be and a
    /// resize sets the size it wants; pushed against an edge it is cut back to fit (never below its minimum), and it
    /// grows back as it comes away. The visible frame, so it stays clear of the menu bar and the Dock.
    private func fogChanged() {
        guard !isCollapsed, !isFullScreen, !adjusting,
              let screen = (fog.screen ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame else { return }
        let frame = fog.frame
        if frame.size != lastFrame.size {
            remember(frame)
        } else {
            virtualOrigin.x += frame.minX - lastFrame.minX
            virtualOrigin.y += frame.minY - lastFrame.minY
        }
        let fitted = FogPlacement.fit(NSRect(origin: virtualOrigin, size: preferredSize), in: screen, minSize: Self.fogMinSize)
        if fitted != frame {
            adjusting = true
            fog.setFrame(fitted, display: true)
            adjusting = false
        }
        lastFrame = fitted
        let next = FogCorner.nearest(to: fitted, in: screen, current: corner)
        if next != corner { corner = next }
        blur.maskImage = Self.blurMask(corner)
    }

    /// Command-Return or the fog's button: fill the screen, or go back to the frame it had.
    func toggleFullScreen() {
        let animate = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        adjusting = true
        if let frame = frameBeforeFullScreen {
            frameBeforeFullScreen = nil
            fog.setFrame(frame, display: true, animate: animate)
            // Saved again only once it is back, so the next launch never restores a full-screen frame.
            fog.setFrameAutosaveName(Self.conversationFrameName)
            remember(frame)
        } else if let screen = fog.screen ?? NSScreen.screens.first {
            frameBeforeFullScreen = fog.frame
            fog.setFrameAutosaveName("")
            fog.setFrame(screen.frame, display: true, animate: animate)
        }
        adjusting = false
        isFullScreen = frameBeforeFullScreen != nil
        if isFullScreen { blur.maskImage = nil } else { fogChanged() }
    }
}

/// The control bar on the store. Talk and Quiet are the daemon's global resume and pause, as the menu bar
/// sends them. The conversation is the menu's to show and hide.
private struct ControlBarHost: View {
    @ObservedObject var store: StateStore
    /// Its ideal size, for the panel to take.
    let onSize: (CGSize) -> Void

    var body: some View {
        let voice = ConchStatusItem.voiceState(store.state)
        ControlBar(
            state: voice,
            detail: ConchStatusItem.detail(store.state, voice, message: store.daemonMessage),
            mode: Binding(
                get: { store.state?.mode.paused == true ? .quiet : .talk },
                set: { store.send($0 == .talk ? .global(.resume) : .global(.pause)) }
            )
        )
        // A small gap under the menu bar, and room below for the glass's dropped shadow.
        .padding(.top, ConchSpace.x3)
        .padding(.horizontal, ConchSpace.x6)
        .padding(.bottom, ConchSpace.x10)
        // Never squeezed by the panel: the panel follows this size instead.
        .fixedSize()
        .background(GeometryReader { proxy in Color.clear.preference(key: ControlBarSize.self, value: proxy.size) })
        .onPreferenceChange(ControlBarSize.self, perform: onSize)
    }
}

private struct ControlBarSize: PreferenceKey {
    static let defaultValue = CGSize.zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

/// The conversation fog on the store, for the session the voice is on. The reply is that session's
/// composer draft, sent and dictated the way the dashboard's composer does it.
private struct ConversationFogHost: View {
    @ObservedObject var store: StateStore
    @ObservedObject var panels: FloatingPanels
    @ObservedObject private var drafts = ComposerDraftStore.shared

    var body: some View {
        let row = Self.session(store.state)
        Group {
            if panels.isCollapsed {
                FogHandle { panels.toggleCollapsed() }
            } else {
                ConversationFog(
                    turns: row.map { Self.turns(store.state, $0) } ?? [],
                    draft: row.map { drafts.textBinding(for: $0.id) } ?? .constant(""),
                    isListening: row.map { ["listening", "recording"].contains(voice(for: $0)) } ?? false,
                    isFullScreen: panels.isFullScreen,
                    corner: panels.corner,
                    onMic: { if let row { mic(row) } },
                    onSend: { if let row { send(row) } },
                    onCollapse: { panels.toggleCollapsed() },
                    onFullScreen: { panels.toggleFullScreen() }
                )
                // ponytail: a temporary 1 pt outline of the panel's real bounds, to tune dragging, resizing and the
                // corner it faces (Tyler, 2026-09-14); take it off when the fog's style goes back on.
                .overlay { if !panels.isFullScreen { Rectangle().strokeBorder(Color.black, lineWidth: 1) } }
            }
        }
        // A dictation lands in the draft once, whichever of this and the dashboard sees it first.
        .onChange(of: store.state?.live.dictated?.id) { _, _ in
            drafts.apply(store.state?.live.dictated)
        }
    }

    /// The session the voice is on, else the daemon's active or selected one, else the first. Never a subagent.
    static func session(_ state: PublishedState?) -> SessionRow? {
        let rows = state?.rows.filter { $0.parentSessionId == nil } ?? []
        return rows.first { LiveState.isExchangeActive($0.live ?? "") }
            ?? rows.first(where: \.active)
            ?? rows.first(where: \.navSelected)
            ?? rows.first
    }

    /// What was said, both ways. Tools, thinking and materials stay in the dashboard.
    static func turns(_ state: PublishedState?, _ row: SessionRow) -> [ConversationTurn] {
        guard let conversation = state?.conversations?[row.id] ?? state?.conversation,
              conversation.sessionId == row.id else { return [] }
        return conversation.items
            .filter { ($0.kind == .user || $0.kind == .assistant) && !$0.text.isEmpty }
            .map { ConversationTurn(id: $0.id, fromYou: $0.kind == .user, text: $0.text) }
    }

    /// The live voice state when it is this session's, as DashboardView's voiceState(for:) reads it.
    private func voice(for row: SessionRow) -> String {
        guard let state = store.state, state.live.label.isEmpty || state.live.label == row.label else { return "" }
        return state.live.state
    }

    /// The composer's mic: stop what is running, or dictate into this session's draft.
    private func mic(_ row: SessionRow) {
        if LiveState.isExchangeActive(voice(for: row)) {
            store.send(.stop())
        } else {
            store.send(.dictate(sessionId: row.id, label: row.label))
        }
    }

    /// Typed into the session through the inject event, which waits for delivery and then hands the front
    /// back to the app the fog was over (StateStore.send).
    private func send(_ row: SessionRow) {
        let draft = drafts.textBinding(for: row.id)
        let text = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        store.send(.inject(sessionId: row.id, label: row.label, text: text))
        draft.wrappedValue = ""
    }
}
