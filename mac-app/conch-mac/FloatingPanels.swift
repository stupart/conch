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

/// The fog's own view. It knows when the pointer is over it even while conch is in the background, which a SwiftUI
/// hover inside a panel of an app that isn't active can't be relied on for. It takes every press that isn't on one of
/// the fog's controls itself, in AppKit: a SwiftUI gesture was cancelled by the window resizing under it (#205). And it
/// steps the fog's motion on its display's own frames.
private final class FogView: NSView {
    weak var panels: FloatingPanels?
    var onHover: (Bool) -> Void = { _ in }
    private var lastFrame: CFTimeInterval = 0
    private lazy var link: CADisplayLink = {
        let link = displayLink(target: self, selector: #selector(step(_:)))
        link.add(to: .main, forMode: .common)
        return link
    }()

    /// Top left, as the fog's SwiftUI lays out its controls (`FogControls`).
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { onHover(true) }
    override func mouseExited(with event: NSEvent) { onHover(false) }
    override func mouseMoved(with event: NSEvent) { panels?.pointerMoved(to: convert(event.locationInWindow, from: nil)) }

    /// A press on the fog's buttons or its reply line goes to them; anywhere else, text included, it is the fog's.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        guard hit != nil, NSApp.currentEvent?.type == .leftMouseDown, panels?.grabs(convert(point, from: superview)) == true else { return hit }
        return self
    }

    override func mouseDown(with event: NSEvent) { panels?.pressed() }
    override func mouseDragged(with event: NSEvent) { panels?.dragged() }
    override func mouseUp(with event: NSEvent) { panels?.released() }

    /// Frames run while the fog moves, and stop once it rests.
    func run(_ on: Bool) {
        guard on == link.isPaused else { return }
        lastFrame = 0
        link.isPaused = !on
    }

    @objc private func step(_ link: CADisplayLink) {
        // The real time since the last frame; the first counts as one at 120 Hz, and a stall never makes a jump.
        let dt = lastFrame > 0 ? min(link.timestamp - lastFrame, 0.05) : 1.0 / 120
        lastFrame = link.timestamp
        panels?.step(dt: dt)
    }
}

/// The floating control bar and the conversation fog (M3), shown and hidden by the menu bar's
/// Show control bar and Show conversation, and kept where they were last left.
///
/// conch owns the fog's geometry outright; the window server never moves or resizes it, so nothing races. The fog is
/// always docked in a screen corner, and moves the way the overlay lab does (`FogMotion`): dragged by its middle it
/// follows the pointer and, let go, flies into the corner its momentum carries it to. Dragged from near any edge it
/// grows or shrinks from its corner.
@MainActor
final class FloatingPanels: ObservableObject {
    static let controlBarFrameName = "conch.controlBar"
    static let conversationFrameName = "conch.conversation"
    /// The fog folded down to its handle. A default like the two show keys, so the menu can open it too.
    static let conversationCollapsedKey = "conch.conversationCollapsed"
    /// The overlay's look: the system blur and a tint, gathered in the corner it is docked to.
    static let showsFog = true
    /// The look, tunable live with `defaults write ai.blueprintstudio.conch <key> <value>`: the running app picks a
    /// change up within half a second, no rebuild.
    enum Look {
        /// The fog colour over the blur, 0 to 1 (`-float`).
        static let tintKey = "conch.overlay.tint"
        /// How much of the system blur shows, 0 to 1 (`-float`).
        static let blurKey = "conch.overlay.blur"
        /// The system blur's material, by name (`-string`): fullScreenUI, hudWindow, popover, menu, sidebar, sheet,
        /// headerView, titlebar, toolTip, windowBackground, underWindowBackground, contentBackground.
        static let materialKey = "conch.overlay.material"
    }

    private static var installed: FloatingPanels?

    static func install(store: StateStore) {
        guard installed == nil else { return }
        installed = FloatingPanels(store: store)
    }

    /// The fog fills its screen; leaving docks it back in its corner.
    @Published private(set) var isFullScreen = false
    @Published private(set) var isCollapsed = false
    /// The screen corner the fog is docked in.
    @Published private(set) var corner: FogCorner = .bottomLeading
    /// Where the Dock and the menu bar overlap the fog, so its words stay clear of them.
    @Published private(set) var insets = EdgeInsets()
    /// The pointer is over the fog (or, collapsed, its corner).
    @Published private(set) var hovering = false
    /// Off its corner, dragged or in flight: it fades on every side until it lands.
    @Published private(set) var floating = false
    /// The tint over the blur (`Look.tintKey`).
    @Published private(set) var tintOpacity = 0.2
    /// How much of the blur shows (`Look.blurKey`).
    private var blurStrength = 1.0
    private var lookTimer: Timer?
    /// How far into a throw's flight the fog is, 0 at rest to 1 mid-air: it fades, softens and shrinks with it.
    @Published private(set) var throwMotion: CGFloat = 0
    /// Where the fog is, at what size, and how it is moving; kept through collapsing and full screen.
    private var motion = FogMotion(size: CGSize(width: 760, height: 560), corner: .bottomLeading, in: .zero)
    /// Where the fog's buttons and reply line are (`FogControls`): a press there is theirs.
    var controlFrames: [CGRect] = []
    private let container = FogView()
    private let controlBar = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    private let fog = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    private let blur = NSVisualEffectView()
    private var defaultsObserver: NSObjectProtocol?
    private var screenObserver: NSObjectProtocol?
    private var activationObserver: NSObjectProtocol?

    /// The corner fog as an image for the blur's mask, one per corner: a behind-window blur ignores layer masks, and
    /// NSVisualEffectView stretches this image to its own size, so one small image serves any panel size.
    private static var masks: [String: NSImage] = [:]

    private static func blurMask(_ corner: FogCorner, strength: Double, floating: Bool) -> NSImage? {
        let key = "\(corner)-\(floating)"
        if let mask = masks[key] { return mask }
        let image = ImageRenderer(
            content: ConversationFog.density(fullScreen: false, corner: corner, floating: floating)
                .opacity(strength)
                .frame(width: 256, height: 256)
        ).nsImage
        image?.resizingMode = .stretch
        masks[key] = image
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
        // conch moves and resizes the fog itself (dragMoved, resizeMoved), so the window server never races it.
        fog.isMovableByWindowBackground = false
        // Every click inside the panel is the fog's. Left alone, the window server lets clicks through a see-through
        // window's transparent pixels, which with the fog's look off is nearly all of it: a drag or a resize strip
        // would land on the app behind, and so would a click in the collapsed corner.
        fog.ignoresMouseEvents = false
        UserDefaults.standard.register(defaults: [Look.tintKey: 0.2, Look.blurKey: 1.0, Look.materialKey: "fullScreenUI"])
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.isHidden = !Self.showsFog
        // The blur and the words are siblings: a visual effect view's mask shapes everything inside it, which faded
        // the words with the fog and hid the collapsed handle along with the blur.
        container.panels = self
        container.onHover = { [weak self] inside in
            MainActor.assumeIsolated { self?.hovering = inside }
        }
        fog.acceptsMouseMovedEvents = true
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
        // Docked in the corner nearest where it was left, at the size it had.
        if let screen = screen() {
            motion = FogMotion(size: fog.frame.size, corner: FogCorner.nearest(to: fog.frame, in: screen.frame, current: .bottomLeading), in: screen.frame)
            apply()
        }
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.redock() }
        }
        // Another app coming forward mid-drag takes the pointer with it: the gesture ends there, with no throw.
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.released(cancelled: true) }
        }

        applyLook()
        // ponytail: polls twice a second, so a `defaults write` from a terminal shows at once; KVO per key if this ever
        // costs anything.
        let lookTimer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.applyLook() }
        }
        RunLoop.main.add(lookTimer, forMode: .common)
        self.lookTimer = lookTimer

        // The menu's toggles write these defaults.
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
        if panel === controlBar { panel.setContentSize(size) }
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

    /// The overlay's look from its defaults (`Look`), applied only where it changed.
    private func applyLook() {
        let defaults = UserDefaults.standard
        let tint = min(max(defaults.double(forKey: Look.tintKey), 0), 1)
        if tint != tintOpacity { tintOpacity = tint }
        let material = Self.material(named: defaults.string(forKey: Look.materialKey))
        if blur.material != material { blur.material = material }
        let strength = min(max(defaults.double(forKey: Look.blurKey), 0), 1)
        if strength != blurStrength {
            blurStrength = strength
            Self.masks = [:]
            if !isCollapsed, !isFullScreen { blur.maskImage = Self.blurMask(corner, strength: strength, floating: floating) }
        }
    }

    private static func material(named name: String?) -> NSVisualEffectView.Material {
        switch name {
        case "hudWindow": .hudWindow
        case "popover": .popover
        case "menu": .menu
        case "sidebar": .sidebar
        case "sheet": .sheet
        case "headerView": .headerView
        case "titlebar": .titlebar
        case "toolTip": .toolTip
        case "windowBackground": .windowBackground
        case "underWindowBackground": .underWindowBackground
        case "contentBackground": .contentBackground
        default: .fullScreenUI
        }
    }

    /// The screen under `point`, else the fog's own.
    private func screen(containing point: NSPoint? = nil) -> NSScreen? {
        if let point, let screen = NSScreen.screens.first(where: { $0.frame.contains(point) }) { return screen }
        return fog.screen ?? NSScreen.main ?? NSScreen.screens.first
    }

    // MARK: Collapsing and full screen

    /// The fog's collapse button and its handle both flip the default; `showWhatIsOn` does the rest.
    func toggleCollapsed() {
        UserDefaults.standard.set(!isCollapsed, forKey: Self.conversationCollapsedKey)
    }

    /// Collapsed, the fog is a small hover area in its corner, clear of the Dock and the menu bar; opened, it docks
    /// there again at the size it had.
    private func setCollapsed(_ collapsed: Bool) {
        guard collapsed != isCollapsed else { return }
        if collapsed, isFullScreen { toggleFullScreen() }
        isCollapsed = collapsed
        guard let screen = screen() else { return }
        // Whatever it was doing ends in its corner, where it opens again.
        dock(corner, on: screen)
        if collapsed {
            // Not saved while collapsed, so the saved frame stays the open one.
            fog.setFrameAutosaveName("")
            let side = FogHandle.side
            fog.setFrame(FogDock.frame(size: CGSize(width: side, height: side), corner: corner, in: screen.visibleFrame), display: true)
            blur.isHidden = true
        } else {
            fog.setFrameAutosaveName(Self.conversationFrameName)
            blur.isHidden = !Self.showsFog
        }
    }

    /// Command-Return or the fog's button: fill the screen, or dock back in its corner at the size it had.
    func toggleFullScreen() {
        guard let screen = screen() else { return }
        dock(corner, on: screen)
        let animate = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if isFullScreen {
            isFullScreen = false
            let frame = FogDock.frame(size: motion.size, corner: corner, in: screen.frame)
            fog.setFrame(frame, display: true, animate: animate)
            // Saved again only once it is back, so the next launch never restores a full-screen frame.
            fog.setFrameAutosaveName(Self.conversationFrameName)
            updateInsets(frame, on: screen)
            blur.maskImage = Self.blurMask(corner, strength: blurStrength, floating: floating)
        } else {
            fog.setFrameAutosaveName("")
            fog.setFrame(screen.frame, display: true, animate: animate)
            isFullScreen = true
            updateInsets(screen.frame, on: screen)
            blur.maskImage = nil
        }
    }

    // MARK: Docking

    /// Docks the fog in `corner` of `screen` at once, ending whatever it was doing.
    private func dock(_ corner: FogCorner, on screen: NSScreen) {
        motion.dock(corner, in: screen.frame)
        apply()
    }

    /// The fog where its motion has it. Mid-flight it fades a little (and the words soften and shrink), whole as it lands.
    private func apply() {
        fog.alphaValue = 1 - (1 - ConchMotion.flightOpacity) * motion.flying
        if abs(motion.flying - throwMotion) > 0.01 || (motion.flying == 0 && throwMotion != 0) { throwMotion = motion.flying }
        guard !isCollapsed, !isFullScreen else { return }
        if fog.frame != motion.frame { fog.setFrame(motion.frame, display: true) }
        if motion.corner != corner {
            corner = motion.corner
            blur.maskImage = Self.blurMask(corner, strength: blurStrength, floating: floating)
        }
        setFloating(motion.isMoving)
        if let screen = NSScreen.screens.first(where: { $0.frame == motion.screen }) {
            updateInsets(FogDock.frame(size: motion.size, corner: corner, in: screen.frame), on: screen)
        }
    }

    /// Off its corner (dragged or in flight) the overlay fades on every side; docked, it gathers in its corner again.
    private func setFloating(_ value: Bool) {
        guard value != floating else { return }
        floating = value
        if !isCollapsed, !isFullScreen { blur.maskImage = Self.blurMask(corner, strength: blurStrength, floating: value) }
    }

    /// The screens changed (a display, the Dock): dock again where it was, ending any gesture.
    private func redock() {
        guard !isCollapsed, !isFullScreen, let screen = screen() else { return }
        dock(corner, on: screen)
    }

    /// The fog reaches the screen's edges, under the Dock and the menu bar; these are how far they cut into it.
    private func updateInsets(_ frame: NSRect, on screen: NSScreen) {
        let full = screen.frame
        let visible = screen.visibleFrame
        let next = EdgeInsets(
            top: max(0, min(frame.maxY, full.maxY) - visible.maxY),
            leading: max(0, visible.minX - max(frame.minX, full.minX)),
            bottom: max(0, visible.minY - max(frame.minY, full.minY)),
            trailing: max(0, min(frame.maxX, full.maxX) - visible.maxX)
        )
        if next != insets { insets = next }
    }

    // MARK: Dragging, throwing and resizing

    /// A press at `point` (in the fog, top left) is the fog's own unless it lands on a button or the reply line.
    func grabs(_ point: CGPoint) -> Bool {
        !isCollapsed && !isFullScreen && !controlFrames.contains { $0.contains(point) }
    }

    /// Pressed near any edge, text included, the fog resizes from its docked corner; in the middle it moves.
    func pressed() {
        motion.press(at: NSEvent.mouseLocation, time: ProcessInfo.processInfo.systemUptime)
        container.run(true)
    }

    func dragged() {
        motion.drag(to: NSEvent.mouseLocation, time: ProcessInfo.processInfo.systemUptime)
    }

    /// Let go, or cut short: a move flies into the corner its momentum picks on the screen it was let go over, with no
    /// momentum if `cancelled`; a resize springs back inside its limits.
    func released(cancelled: Bool = false) {
        guard motion.isGesturing else { return }
        let screen = screen(containing: NSEvent.mouseLocation)?.frame ?? motion.screen
        motion.release(at: ProcessInfo.processInfo.systemUptime, in: screen, cancelled: cancelled)
    }

    /// Where a press would resize, the pointer says so.
    func pointerMoved(to point: CGPoint) {
        guard grabs(point), !motion.isGesturing else { return }
        guard motion.resizes(at: NSEvent.mouseLocation) else { return NSCursor.arrow.set() }
        guard #available(macOS 15, *) else { return NSCursor.crosshair.set() }
        let free: NSCursor.FrameResizePosition = corner.bottom ? (corner.leading ? .topRight : .topLeft) : (corner.leading ? .bottomRight : .bottomLeft)
        NSCursor.frameResize(position: free, directions: .all).set()
    }

    /// One display frame: the motion stepped, and the fog put where it is.
    func step(dt: Double) {
        // The button came up somewhere we never heard about (another app, a lost event): the gesture ends here.
        if motion.isGesturing, NSEvent.pressedMouseButtons & 1 == 0 { released() }
        motion.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        motion.step(dt: dt)
        apply()
        if motion.isSettled { container.run(false) }
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let row = Self.session(store.state)
        Group {
            if panels.isCollapsed {
                FogHandle(corner: panels.corner, hovering: panels.hovering) { panels.toggleCollapsed() }
            } else {
                ConversationFog(
                    turns: row.map { Self.turns(store.state, $0) } ?? [],
                    draft: row.map { drafts.textBinding(for: $0.id) } ?? .constant(""),
                    isListening: row.map { ["listening", "recording"].contains(voice(for: $0)) } ?? false,
                    isFullScreen: panels.isFullScreen,
                    corner: panels.corner,
                    insets: panels.insets,
                    showsFog: FloatingPanels.showsFog,
                    tint: panels.tintOpacity,
                    floating: panels.floating,
                    onMic: { if let row { mic(row) } },
                    onSend: { if let row { send(row) } },
                    onCollapse: { panels.toggleCollapsed() },
                    onFullScreen: { panels.toggleFullScreen() }
                )
                // A throw's flight: it softens and shrinks a little mid-air, and lands whole. Reduce Motion keeps only the fade.
                .scaleEffect(1 - (1 - ConchMotion.flightScale) * (reduceMotion ? 0 : panels.throwMotion))
                .blur(radius: reduceMotion ? 0 : ConchMotion.flightBlur * panels.throwMotion)
            }
        }
        // Where the buttons and the reply line are, for the fog's view to leave presses there to them.
        .coordinateSpace(name: FogControls.space)
        .onPreferenceChange(FogControls.self) { panels.controlFrames = $0 }
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
