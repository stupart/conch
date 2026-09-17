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

/// The first click on a control acts. conch never comes forward, so there is no click to focus it first. For the same
/// reason SwiftUI's hover can't be relied on (`FogView`), so an always-active tracking area feeds it the pointer: the
/// Ready pill's pointing hand.
private final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        guard !trackingAreas.contains(where: { $0.owner === self && $0.options.contains(.activeAlways) }) else { return }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect], owner: self))
    }
}

/// The look over the fog's blur never takes the pointer: a press there is the fog's (`FogView.hitTest`).
private final class LookHostingView<Content: View>: NSHostingView<Content> {
    override func hitTest(_: NSPoint) -> NSView? { nil }
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

    /// A press on the fog's buttons or its reply line goes to them; anywhere else, text included, it is the fog's. So is a
    /// scroll anywhere but the reply line (which scrolls itself): the fog moves its transcript with it, and never drags.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        guard hit != nil, let panels, let type = NSApp.currentEvent?.type else { return hit }
        let local = convert(point, from: superview)
        if type == .leftMouseDown, panels.grabs(local) { return self }
        if type == .scrollWheel, panels.scrolls(local) { return self }
        return hit
    }

    override func mouseDown(with event: NSEvent) { panels?.pressed() }
    override func mouseDragged(with event: NSEvent) { panels?.dragged() }
    override func mouseUp(with event: NSEvent) { panels?.released() }
    override func scrollWheel(with event: NSEvent) { panels?.scrolled(event) }

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
    /// The overlay's look: the system blur under the lab's wash, voice colour and scrim (`FogLook`), gathered to the
    /// screen edges it touches.
    static let showsFog = true
    /// Liquid Glass draws the panel itself, so the behind-window effect view is not needed. It stays a sibling either
    /// way — hidden here, drawing the blur below macOS 26 — because a material that parents the words masks them.
    static var usesGlass: Bool { if #available(macOS 26.0, *) { true } else { false } }
    /// The look, tunable live with `defaults write ai.blueprintstudio.conch <key> <value>`: the running app picks a
    /// change up within half a second, no rebuild.
    enum Look {
        /// The wash over the blur where it is densest, 0 to 1.2 (`-float`), in light and in dark. Below the lab's 0.78
        /// and 0.8, because the system material lays a tint of its own over the blur first.
        static let tintKey = "conch.overlay.tint"
        static let tintDarkKey = "conch.overlay.tintDark"
        /// The voice's colour in the blur, 0 to 1.2 (`-float`), in light and in dark.
        static let colourKey = "conch.overlay.colour"
        static let colourDarkKey = "conch.overlay.colourDark"
        /// The extra wash and blur behind the newest words, 0 to 1.2 (`-float`), in light and in dark.
        static let scrimKey = "conch.overlay.scrim"
        static let scrimDarkKey = "conch.overlay.scrimDark"
        /// How much of the system blur shows, 0 to 1 (`-float`).
        static let blurKey = "conch.overlay.blur"
        /// The system blur's material, by name (`-string`): fullScreenUI, hudWindow, popover, menu, sidebar, sheet,
        /// headerView, titlebar, toolTip, windowBackground, underWindowBackground, contentBackground.
        static let materialKey = "conch.overlay.material"
        /// Light or dark (`-string`): auto (the system's), light or dark.
        static let appearanceKey = "conch.overlay.appearance"
        static let defaults: [String: Any] = [
            tintKey: 0.45, tintDarkKey: 0.46, colourKey: 0.75, colourDarkKey: 0.55, scrimKey: 0.3, scrimDarkKey: 0.25,
            blurKey: 1.0, materialKey: "fullScreenUI", appearanceKey: "auto",
        ]
    }

    private static var installed: FloatingPanels?

    static func install(store: StateStore) {
        guard installed == nil else { return }
        installed = FloatingPanels(store: store)
    }

    /// A session picked in conch's window: the conversation comes off the Ready pill's scene, unless that is the one.
    static func picked(_ id: SessionRow.ID) {
        guard let panels = installed, panels.staged != nil, panels.staged != id else { return }
        panels.staged = nil
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
    /// The look over the blur: where its blob is, how dark it is, and its tunables (`Look`).
    @Published private(set) var look = FogLook(FogMotion(size: CGSize(width: 900, height: 640), corner: .bottomLeading, in: .zero))
    /// How much of the blur shows (`Look.blurKey`).
    private var blurStrength = 1.0
    /// The look's own crossfades, light to dark and the resize band's glow, stepped with the motion: where each is, where
    /// it is heading, and how fast.
    private var darkness: CGFloat = 0, darkTarget: CGFloat = 0, darkVelocity: CGFloat = 0
    private var resizeHover: CGFloat = 0, hoverTarget: CGFloat = 0, hoverVelocity: CGFloat = 0
    private var lookTimer: Timer?
    /// How far into a throw's flight the fog is, 0 at rest to 1 mid-air: it fades, softens and shrinks with it.
    @Published private(set) var throwMotion: CGFloat = 0
    /// The session the Ready pill last brought forward. The conversation stays on it, whatever the voice does, until the
    /// pill is clicked again or another session is picked (`picked`).
    @Published var staged: SessionRow.ID?
    /// Where the fog is, at what size, and how it is moving; kept through collapsing and full screen.
    private var motion = FogMotion(size: CGSize(width: 900, height: 640), corner: .bottomLeading, in: .zero)
    /// Where the fog's buttons and reply line are (`FogControls`): a press there is theirs.
    var controlFrames: [CGRect] = []
    /// The fog's words as they move (`FogTextState`): stepped with the motion, fed the store and the reader's scrolling.
    let text = FogTextState()
    private let container = FogView()
    private let controlBar = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    private let fog = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    private let blur = NSVisualEffectView()
    private var lookHost = NSView()
    private var words = NSView()
    private var defaultsObserver: NSObjectProtocol?
    private var screenObserver: NSObjectProtocol?
    private var activationObserver: NSObjectProtocol?

    /// The look's mask for the blur. A behind-window blur ignores layer masks, so NSVisualEffectView takes this small image
    /// and stretches it to its own size.
    private func blurMask() -> NSImage? {
        guard let mask = look.mask(strength: blurStrength) else { return nil }
        let image = NSImage(cgImage: mask, size: NSSize(width: mask.width, height: mask.height))
        image.resizingMode = .stretch
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

        let bar = FirstClickHostingView(rootView: ControlBarHost(store: store, panels: self, onSize: { [weak self] size in self?.fitControlBar(to: size) }))
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
        // AppKit takes a window's shadow from what it draws, and the glass draws a rounded rect: no margin required.
        fog.hasShadow = Self.usesGlass
        UserDefaults.standard.register(defaults: Look.defaults)
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.isHidden = !Self.showsFog || Self.usesGlass
        // The blur, its look and the words are siblings: a visual effect view's mask shapes everything inside it, which
        // faded the words with the fog and hid the collapsed handle along with the blur.
        container.panels = self
        text.wake = { [weak self] in MainActor.assumeIsolated { self?.container.run(true) } }
        container.onHover = { [weak self] inside in
            MainActor.assumeIsolated {
                self?.hovering = inside
                if !inside { self?.hoverResizeBand(false) }
            }
        }
        fog.acceptsMouseMovedEvents = true
        fog.contentView = container
        lookHost = LookHostingView(rootView: FogLookHost(store: store, panels: self))
        words = FirstClickHostingView(rootView: ConversationFogHost(store: store, panels: self, history: store.overlayHistory))
        for view in [blur, lookHost, words] {
            view.frame = container.bounds
            view.autoresizingMask = [.width, .height]
            container.addSubview(view)
        }
        place(fog, name: Self.conversationFrameName, size: NSSize(width: 900, height: 640)) { screen, _ in
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
        func value(_ key: String) -> Double { min(max(defaults.double(forKey: key), 0), 1.2) }
        var next = look
        next.tint = LightDark(value(Look.tintKey), value(Look.tintDarkKey))
        next.colour = LightDark(value(Look.colourKey), value(Look.colourDarkKey))
        next.scrim = LightDark(value(Look.scrimKey), value(Look.scrimDarkKey))
        setLook(next)
        let material = Self.material(named: defaults.string(forKey: Look.materialKey))
        if blur.material != material { blur.material = material }
        let strength = min(max(defaults.double(forKey: Look.blurKey), 0), 1)
        if strength != blurStrength {
            blurStrength = strength
            if !isCollapsed, !isFullScreen { blur.maskImage = blurMask() }
        }
        let systemDark = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        let dark: CGFloat = FogLook.isDark(defaults.string(forKey: Look.appearanceKey), systemDark: systemDark) ? 1 : 0
        guard dark != darkTarget else { return }
        darkTarget = dark
        // At launch (before the timer) it starts there; after, it crossfades.
        if lookTimer == nil { darkness = dark }
        container.run(true)
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
            blur.isHidden = !Self.showsFog || Self.usesGlass
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
            blur.maskImage = blurMask()
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
    /// Its look follows: gathered to the screen edges it touches, a blob in its middle away from them, and its window
    /// reaching past it toward an edge the blob spills to, so the blob never ends in a line.
    private func apply() {
        fog.alphaValue = 1 - (1 - ConchMotion.flightOpacity) * motion.flying
        if abs(motion.flying - throwMotion) > 0.01 || (motion.flying == 0 && throwMotion != 0) { throwMotion = motion.flying }
        guard !isCollapsed, !isFullScreen else { return layOut(margin: EdgeInsets()) }
        if motion.corner != corner { corner = motion.corner }
        if motion.isMoving != floating { floating = motion.isMoving }
        if let screen = NSScreen.screens.first(where: { $0.frame == motion.screen }) {
            updateInsets(FogDock.frame(size: motion.size, corner: corner, in: screen.frame), on: screen)
        }
        var next = FogLook(motion, insets: insets)
        (next.resizeHover, next.darkness, next.tint, next.colour, next.scrim) = (resizeHover, darkness, look.tint, look.colour, look.scrim)
        next.replyHeight = text.replyHeight
        setLook(next)
        // The glass ends at its own rounded edge and the window's shadow is drawn from that shape, so the window is
        // exactly the fog: no margin to reach into, and nothing for the saved frame to grow by on the next launch.
        let frame = motion.frame
        if fog.frame != frame { fog.setFrame(frame, display: true) }
        layOut(margin: EdgeInsets())
    }

    /// The words where the fog is in its window, and the blur and its look over the whole window. The container's origin
    /// stays the fog's, so presses and control frames need no converting.
    private func layOut(margin: EdgeInsets) {
        let origin = CGPoint(x: -margin.leading, y: -margin.top)
        if container.bounds.origin != origin { container.setBoundsOrigin(origin) }
        let bounds = container.bounds
        blur.frame = bounds
        lookHost.frame = bounds
        words.frame = CGRect(x: 0, y: 0, width: bounds.width - margin.leading - margin.trailing, height: bounds.height - margin.top - margin.bottom)
    }

    /// A new look, and the blur's mask drawn again for it.
    private func setLook(_ next: FogLook) {
        guard next != look else { return }
        look = next
        guard !isCollapsed, !isFullScreen else { return }
        blur.maskImage = blurMask()
        let appearance = NSAppearance(named: next.darkness > 0.5 ? .darkAqua : .aqua)
        if blur.appearance?.name != appearance?.name { blur.appearance = appearance }
    }

    /// Over the resize band the blob swells a little and its colour deepens, as the lab's does.
    private func hoverResizeBand(_ on: Bool) {
        let target: CGFloat = on ? 1 : 0
        guard target != hoverTarget else { return }
        hoverTarget = target
        container.run(true)
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

    /// A scroll at `point` moves the transcript, full screen too; on the reply line it scrolls the reply.
    func scrolls(_ point: CGPoint) -> Bool {
        !isCollapsed && !controlFrames.contains { $0.contains(point) }
    }

    /// The reader's wheel or trackpad, in points toward the oldest line: up the screen's content bottom-up, down it when
    /// the newest line is at the top. A mouse wheel's deltas are lines. Only this ever unpins the transcript (`FogScroll`).
    func scrolled(_ event: NSEvent) {
        let points = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY : event.scrollingDeltaY * 16
        let towardOldest = ConversationFog.newestAtTop(corner: corner, fullScreen: isFullScreen) ? -points : points
        text.scroll(by: towardOldest, momentum: event.momentumPhase != [])
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

    /// Where a press would resize, the pointer says so, and the look glows.
    func pointerMoved(to point: CGPoint) {
        guard !motion.isGesturing else { return }
        let resizes = grabs(point) && motion.resizes(at: NSEvent.mouseLocation)
        hoverResizeBand(resizes)
        guard grabs(point) else { return }
        guard resizes else { return NSCursor.arrow.set() }
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
        if ConchMotion.appearance.step(&darkness, velocity: &darkVelocity, to: darkTarget, dt: dt) {
            darkness = darkTarget
            darkVelocity = 0
        }
        if ConchSpring(bounce: 0, response: 0.3).step(&resizeHover, velocity: &hoverVelocity, to: hoverTarget, dt: dt) {
            resizeHover = hoverTarget
            hoverVelocity = 0
        }
        let words = text.step(dt: dt, now: ProcessInfo.processInfo.systemUptime, reduceMotion: motion.reduceMotion)
        apply()
        if motion.isSettled, darkness == darkTarget, resizeHover == hoverTarget, !words { container.run(false) }
    }
}

/// The control bar on the store. Talk and Quiet are the daemon's global resume and pause, as the menu bar
/// sends them. The conversation is the menu's to show and hide.
private struct ControlBarHost: View {
    @ObservedObject var store: StateStore
    /// Not observed: the bar only tells it what it staged, and the fog's motion publishes every frame.
    let panels: FloatingPanels
    /// Its ideal size, for the panel to take.
    let onSize: (CGSize) -> Void
    /// The review version the last click brought forward, and the versions handed off: for the next click to move on from.
    @State private var lastStaged: ReviewItem.ID?
    @State private var opened: Set<ReviewItem.ID> = []
    /// The click being staged. Clicks run one at a time.
    @State private var staging: Task<Void, Never>?

    var body: some View {
        let voice = ConchStatusItem.voiceState(store.state)
        let ready = Self.ready(store.state)
        ControlBar(
            state: voice,
            detail: ConchStatusItem.detail(store.state, voice, message: store.daemonMessage),
            mode: Binding(
                get: { store.state?.mode.paused == true ? .quiet : .talk },
                set: { store.send($0 == .talk ? .global(.resume) : .global(.pause)) }
            ),
            onTap: stageNext,
            // What the agent asked you to check, when it said; else how many are waiting.
            help: next(in: ready).map { "Show \($0.label) · \($0.inspect ?? "\(ready.count) ready")" } ?? ""
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

    /// The reviews waiting on you, as the menu counts them.
    private static func ready(_ state: PublishedState?) -> [ReviewItem] {
        ConchStatusItem.readyRows(state).compactMap(ReviewItem.init(row:))
    }

    /// The review the next click brings forward, by its exact version (`ReviewItem.id`: the session and when its review
    /// was filed), never by a place in the queue.
    /// What has been looked at: whatever the daemon remembers, on any device, plus whatever
    /// this window has just handed off. The local half is optimistic — the pill moves on at
    /// the click and the daemon's answer catches up — and it is the whole story against a
    /// daemon too old to remember, which is what `features.viewedState` distinguishes.
    private func seen(in ready: [ReviewItem]) -> Set<ReviewItem.ID> {
        guard store.state?.features?.viewedState != nil else { return opened }
        return opened.union(ready.filter { $0.viewedAt != nil }.map(\.id))
    }

    private func next(in ready: [ReviewItem]) -> ReviewItem? {
        let key = ReviewScene.next(after: lastStaged, in: ready.map { (key: $0.id, at: $0.reviewedAt ?? 0) }, opened: seen(in: ready))
        return ready.first { $0.id == key }
    }

    /// A click on the Ready pill. The version is taken at the click. Clicks run one at a time, so an earlier one finishing
    /// late can't retarget the conversation after a later one; each checks its review is still that version and still
    /// ready, pins the conversation to its session, brings its scene forward (`ConchStatusItem.stage`), and counts it
    /// opened only once handed off. Never the mic or speech.
    private func stageNext() {
        guard let key = next(in: Self.ready(store.state))?.id else { return }
        lastStaged = key
        let previous = staging
        staging = Task { @MainActor in
            await previous?.value
            guard let row = ConchStatusItem.readyRows(store.state).first(where: { ReviewItem(row: $0)?.id == key }) else { return }
            panels.staged = row.id
            if await ConchStatusItem.stage(row, store: store) {
                opened.insert(key)
                // So the phone, the terminal and the next launch agree with this window.
                if store.state?.features?.viewedState != nil {
                    store.markReviewViewed(sessionId: row.id, review: key)
                }
            }
        }
    }
}

private struct ControlBarSize: PreferenceKey {
    static let defaultValue = CGSize.zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

/// The look over the fog's blur, in the voice's colour: the control bar's voice state.
private struct FogLookHost: View {
    @ObservedObject var store: StateStore
    @ObservedObject var panels: FloatingPanels

    var body: some View {
        if FloatingPanels.showsFog, !panels.isCollapsed, !panels.isFullScreen {
            // panel.html floats the panel off the corner (`left:24px;bottom:24px`) rather than hanging it flush, which
            // is what lets all four corners round and the shadow read on every side. The window stays the docked frame,
            // so the magnet, the docking contract and every motion test are untouched.
            ConchGlassPanel(darkness: panels.look.darkness, voice: ConchStatusItem.voiceState(store.state))
                .padding(ConchSpace.x6)
        }
    }
}

/// The conversation fog on the store, for the session the voice is on. The reply is that session's
/// composer draft, sent and dictated the way the dashboard's composer does it.
private struct ConversationFogHost: View {
    @ObservedObject var store: StateStore
    @ObservedObject var panels: FloatingPanels
    /// The overlay's own reader: it follows the staged session, which is not necessarily
    /// the one the dashboard is showing.
    @ObservedObject var history: HistoryStore
    @ObservedObject private var drafts = ComposerDraftStore.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let row = Self.session(store.state, staged: panels.staged)
        let turns = row.map { Self.turns(store.state, $0, whole: history.fullBodies) } ?? []
        Group {
            if panels.isCollapsed {
                FogHandle(corner: panels.corner, hovering: panels.hovering) { panels.toggleCollapsed() }
            } else {
                ConversationFog(
                    turns: turns,
                    draft: row.map { drafts.textBinding(for: $0.id) } ?? .constant(""),
                    text: panels.text,
                    isListening: row.map { ["listening", "recording"].contains(voice(for: $0)) } ?? false,
                    // The store's own working state, not a timer: "Thinking" after your message until the reply comes.
                    isWorking: row?.status == .working,
                    isFullScreen: panels.isFullScreen,
                    corner: panels.corner,
                    insets: panels.insets,
                    showsFog: FloatingPanels.showsFog,
                    look: panels.look,
                    floating: panels.floating,
                    hovering: panels.hovering,
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
        // The palette crossfades with the look, light to dark.
        .environment(\.conchDarkness, panels.look.darkness)
        .environment(\.colorScheme, panels.look.darkness > 0.5 ? .dark : .light)
        // Where the buttons and the reply line are, for the fog's view to leave presses there to them.
        .coordinateSpace(name: FogControls.space)
        .onPreferenceChange(FogControls.self) { panels.controlFrames = $0 }
        // A dictation lands in the draft once, whichever of this and the dashboard sees it first.
        .onChange(of: store.state?.live.dictated?.id) { _, _ in
            drafts.apply(store.state?.live.dictated)
        }
        // Words come in as the daemon sends them; another session starts from its newest line, its reply whole.
        .onChange(of: row?.id) { _, _ in panels.text.session() }
        // Its own modifier rather than a line inside that one: what the fog does with a
        // new session's words is a separate thing from reading that session whole.
        .onChange(of: row?.id) { _, _ in if panels.isFullScreen { readWhole(row) } }
        .onChange(of: panels.isFullScreen) { _, full in if full { readWhole(row) } }
        .onChange(of: turns, initial: true) { _, turns in panels.text.update(turns: turns, now: ProcessInfo.processInfo.systemUptime) }
    }

    /// The session the Ready pill staged, else the one the voice is on, else the daemon's active or selected one, else
    /// the first. Never a subagent. The chain is the window's own (ConchDesign/Workspace.swift): the overlay pins a
    /// different session from the dashboard, but it must not resolve it by a different rule.
    static func session(_ state: PublishedState?, staged: SessionRow.ID? = nil) -> SessionRow? {
        state?.row(WorkspaceFocus.viewed(in: Workspace(state), pinned: staged))
    }

    /// What was said, both ways. Tools, thinking and materials stay in the dashboard.
    /// `whole` is what the record store says the message actually was, by provider id.
    /// The snapshot keeps only the last 4,000 characters of a long one, so enlarging the
    /// overlay without this enlarged the cut rather than showing the message.
    static func turns(
        _ state: PublishedState?,
        _ row: SessionRow,
        whole: [String: String] = [:]
    ) -> [ConversationTurn] {
        guard let conversation = state?.conversations?[row.id] ?? state?.conversation,
              conversation.sessionId == row.id else { return [] }
        return conversation.items
            .filter { ($0.kind == .user || $0.kind == .assistant) && !$0.text.isEmpty }
            .map {
                ConversationTurn(
                    id: $0.id,
                    fromYou: $0.kind == .user,
                    text: whole[HistorySnapshot.nativeId(forSnapshotItem: $0.id)] ?? $0.text
                )
            }
    }

    /// Full screen is where someone READS rather than glances, so it is where the whole
    /// text of anything the snapshot cut is fetched.
    private func readWhole(_ row: SessionRow?) {
        guard let row else { return }
        let conversation = store.state?.conversations?[row.id] ?? store.state?.conversation
        // The same branch the pane is showing (A8): the overlay reads one window's
        // history, not both windows' of a transcript they share.
        history.select(session: row.id, branchTip: HistorySnapshot.branchTip(
            forSnapshotItems: (conversation?.items ?? []).map(\.id),
            shared: conversation?.shared ?? false
        ))
        let cut = (conversation?.items ?? [])
            .filter { ($0.kind == .user || $0.kind == .assistant) && HistorySnapshot.wasCut($0.text, cap: 4_000) }
            .map(\.id)
        history.loadFullBodies(forSnapshotItems: cut)
    }

    /// The live voice state when it is this session's, by identity — the rule the dashboard's composer reads too.
    private func voice(for row: SessionRow) -> String {
        guard let state = store.state, WorkspaceFocus.isAddressed(row.id, in: Workspace(state)) else { return "" }
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
        let delivery = store.send(.inject(sessionId: row.id, label: row.label, text: text))
        // It shows at once, flying in from the reply line, until the daemon's copy takes its place.
        let fog = panels.text
        fog.send(text)
        draft.wrappedValue = ""
        Task {
            guard !(await delivery.value) else { return }
            fog.sendFailed()
            // A reply that didn't go comes back to the line, unless something new was typed meanwhile.
            if draft.wrappedValue.isEmpty { draft.wrappedValue = text }
        }
    }
}
