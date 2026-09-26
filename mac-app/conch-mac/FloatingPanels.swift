import AppKit
import ConchDesign
import SwiftUI

/// A borderless panel over every app, on every space, and out of the window cycle (M3). Non-activating: a
/// click in it never makes conch the active app. It becomes key only if `takesKeys`, and then, with
/// `becomesKeyOnlyIfNeeded`, only when a view that needs the keyboard (the fog's reply field) is clicked, or when the
/// fog takes the keys itself (`FloatingPanels.takeKeys`).
final class FloatingPanel: NSPanel {
    var takesKeys = false
    /// The panel's own keys, seen before whatever view has the keyboard: true when it was one of them (`PanelKeys`).
    var onKey: ((NSEvent) -> Bool)?
    override var canBecomeKey: Bool { takesKeys }
    override var canBecomeMain: Bool { false }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown, let onKey, onKey(event) { return }
        super.sendEvent(event)
    }
}

/// The first click on a control acts. conch never comes forward, so there is no click to focus it first. For the same
/// reason SwiftUI's hover can't be relied on (`FogView`), so an always-active tracking area feeds it the pointer: the
/// Ready pill's pointing hand.
final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
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
    /// How far the glass floats inside the window, panel.html's `left:24px;bottom:24px`. The words and the buttons come
    /// in by the same amount, so everything the panel holds sits on it rather than beside it.
    static let glassInset: CGFloat = ConchSpace.x6
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

    private(set) static var installed: FloatingPanels?

    static func install(store: StateStore) {
        guard installed == nil else { return }
        installed = FloatingPanels(store: store)
    }

    /// A session picked in conch's window: the conversation comes off the Ready pill's scene, unless that is the one.
    static func picked(_ id: SessionRow.ID) {
        guard let panels = installed, panels.staged != nil, panels.staged != id else { return }
        panels.staged = nil
    }

    /// The conversation panel and the control bar themselves, for what must tell them apart by identity (`DebugSnapshot`).
    var conversationWindow: NSWindow { fog }
    var controlBarWindow: NSWindow { controlBar }

    /// The conversation panel while it fills the screen: then it IS what is on screen, the deliverable it shows or the
    /// words, and a canvas's still or Show keeps it in the picture (`CanvasController.leftOut`). Docked, it is conch's own
    /// chrome over the work, and left out.
    var coveringWindow: NSWindow? { isFullScreen && fog.isVisible ? fog : nil }

    /// Where the glass is on screen while the panel shows docked, for the canvas's tools to rise out of its top edge.
    var glassFrame: NSRect? {
        fog.isVisible && !isCollapsed && !isFullScreen ? fog.frame.insetBy(dx: Self.glassInset, dy: Self.glassInset) : nil
    }

    /// While the canvas's pen is down its glass takes every click, so docked the panel rises over it, and its own controls
    /// still work; full screen it stays under, since it is what is being marked up (`CanvasController.apply`). Full screen
    /// from the moment it starts to grow, so it never rides over the glass on the way.
    func overGlass(_ over: Bool) {
        let level: NSWindow.Level = over && !isFullScreen ? NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1) : .floating
        if fog.level != level { fog.level = level }
    }

    /// The fog fills its screen; leaving docks it back in its corner. Set as the morph starts: the words follow `form`.
    @Published private(set) var isFullScreen = false
    @Published private(set) var isCollapsed = false
    /// What the panel has landed as, which is what its words lay out for: the frame morphs first, and the words, laid out
    /// for where it is going, come back once it has all but arrived (`arrive`). Never full-screen type in a docked-size
    /// window, nor docked type in a full-screen one.
    enum Form: Equatable { case docked, fullScreen, collapsed }
    @Published private(set) var form = Form.docked
    /// The words and buttons, or the handle, show: out as the frame starts to morph, back `ConchMotion.revealDelay` after
    /// it lands.
    @Published private(set) var revealed = true
    /// The glass under the words, where it is in the window and its corner, frame by frame as it morphs.
    @Published private(set) var glass = PanelGlass.Geometry.docked
    /// The glass shows: everywhere but the collapsed handle, which draws its own.
    @Published private(set) var glassShows = true
    /// Where the words lay out: the glass of the form the panel landed in, and the screen's insets over its window then.
    /// Held while the frame morphs.
    @Published private(set) var laidGlass = PanelGlass.Geometry.docked
    @Published private(set) var laidInsets = EdgeInsets()
    /// The row the keyboard has picked out in the open switcher.
    @Published private(set) var switcherSelection: SessionRow.ID?
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
    /// Where the Ready pill and the panel's Previous and Next are in what is ready: one walk, so they agree.
    let queue = ReviewQueue()
    /// Told when the fog starts or stops covering the screen (`coverChanged`).
    private weak var store: StateStore?
    /// The panel's session switcher is open. Here rather than in the view, so a press anywhere else on the fog, which is
    /// AppKit's (`pressed`), closes it; so does a click in any other app, or the panel losing the keys. Open, it has the
    /// keys, for Esc, ↑, ↓ and Return.
    @Published var switching = false {
        didSet { if switching != oldValue { switchingChanged() } }
    }
    /// The reply line shows (`ConchStatusItem.showReplyLineKey`).
    @Published private(set) var showsReply = true
    /// Full screen, docked or collapsed on the morph spring: the frame it left and the frame it is going to, the glass in
    /// each, the form it lands as, whether the words have come back for it, and how far along it is.
    private var morphing: (from: NSRect, to: NSRect, glassFrom: PanelGlass.Geometry, glassTo: PanelGlass.Geometry, form: Form, arrived: Bool, progress: CGFloat, velocity: CGFloat)?
    /// How far along a morph the words come back for where it is going: all but there.
    private static let arrives: CGFloat = 0.99
    /// When the words come back, on the display's clock.
    private var revealAt: TimeInterval?
    /// The words' view held at the size it had as a morph began, in its corner, so it never lays out again mid-morph.
    private var wordsFrozen: CGSize?
    /// Set once the panels are up: anything before (a collapsed panel restored at launch) lands at once.
    private var settled = false
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
    private var resignObserver: NSObjectProtocol?
    /// While the switcher is open: a click in any other app closes it. conch is never the app in front, so no activation
    /// says so.
    private var outsideClicks: Any?

    /// The look's mask for the blur. A behind-window blur ignores layer masks, so NSVisualEffectView takes this small image
    /// and stretches it to its own size.
    private func blurMask() -> NSImage? {
        guard let mask = look.mask(strength: blurStrength) else { return nil }
        let image = NSImage(cgImage: mask, size: NSSize(width: mask.width, height: mask.height))
        image.resizingMode = .stretch
        return image
    }

    private init(store: StateStore) {
        self.store = store
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
        // Never shown, but what VoiceOver names each window by.
        controlBar.title = "Voice controls"
        fog.title = "Conversation"

        let bar = FirstClickHostingView(rootView: ControlBarHost(store: store, queue: queue, panels: self, onSize: { [weak self] size in self?.fitControlBar(to: size) }))
        controlBar.contentView = bar
        place(controlBar, name: Self.controlBarFrameName, size: bar.fittingSize) { screen, size in
            // Top centre, just under the menu bar.
            NSPoint(x: screen.midX - size.width / 2, y: screen.maxY - size.height)
        }

        fog.takesKeys = true
        fog.becomesKeyOnlyIfNeeded = true
        fog.onKey = { [weak self] event in MainActor.assumeIsolated { self?.key(event) ?? false } }
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
        // Liquid Glass draws the panel, docked and full screen alike: the blur is only for below macOS 26 (`showBlur`).
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
        words = FirstClickHostingView(rootView: ConversationFogHost(store: store, panels: self, queue: queue, history: store.overlayHistory))
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
        // Another app coming forward mid-drag takes the pointer with it: the gesture ends there, with no throw. It closes
        // the switcher too, as a click outside a menu does.
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.released(cancelled: true)
                self?.switching = false
            }
        }
        // The keys gone to another window: the switcher they drove closes.
        resignObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification,
            object: fog,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.switching = false }
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
        settled = true
    }

    /// Where it was last left, or where it starts; saved under `name` from then on.
    private func place(_ panel: NSPanel, name: String, size: NSSize, start: (NSRect, NSSize) -> NSPoint) {
        panel.setContentSize(size)
        if !panel.setFrameUsingName(name), let screen = NSScreen.screens.first?.visibleFrame {
            panel.setFrameOrigin(start(screen, size))
        }
        // `setFrameUsingName` restores the ORIGIN of a borderless, non-resizable panel and drops the size — so a fog
        // resized by hand came back at this default on every single launch, and the size someone chose was never the
        // size they got. The saved string is "x y w h ...", so take the size out of it directly.
        if panel !== controlBar, let saved = Self.savedSize(forFrameName: name) { panel.setContentSize(saved) }
        // The control bar's size is its content's, whatever size was saved.
        if panel === controlBar { panel.setContentSize(size) }
        panel.setFrameAutosaveName(name)
    }

    /// The size inside an autosaved frame string, `"x y w h screenX screenY screenW screenH"`.
    private static func savedSize(forFrameName name: String) -> NSSize? {
        guard let saved = UserDefaults.standard.string(forKey: "NSWindow Frame \(name)") else { return nil }
        let numbers = saved.split(separator: " ").compactMap { Double($0) }
        guard numbers.count >= 4, numbers[2] > 1, numbers[3] > 1 else { return nil }
        return NSSize(width: numbers[2], height: numbers[3])
    }

    private func showWhatIsOn() {
        let defaults = UserDefaults.standard
        setCollapsed(defaults.bool(forKey: Self.conversationCollapsedKey))
        let reply = defaults.bool(forKey: ConchStatusItem.showReplyLineKey)
        if reply != showsReply {
            showsReply = reply
            // The look thickens where the reply line was, or where it is now.
            container.run(true)
        }
        show(controlBar, defaults.bool(forKey: ConchStatusItem.showControlBarKey))
        show(fog, defaults.bool(forKey: ConchStatusItem.showConversationKey))
        coverChanged()
    }

    /// Full screen and showing, the fog covers whatever app is in front: the store stops taking that app for what Tyler
    /// sees, and reads it again the moment the fog stops covering it (`StateStore.screenCovered`).
    private func coverChanged() {
        store?.screenCovered(isFullScreen && fog.isVisible)
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
            if !isCollapsed, !isFullScreen, !blur.isHidden { blur.maskImage = blurMask() }
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

    /// Collapsed, the fog is a small hover area in its corner, clear of the Dock and the menu bar: the glass shrinks into
    /// the handle's circle on the morph spring and the handle takes over from it. Opened, it docks there again at the size
    /// it had, the glass growing out of the handle. Full screen, it goes straight to the handle.
    private func setCollapsed(_ collapsed: Bool) {
        guard collapsed != isCollapsed else { return }
        switching = false
        isCollapsed = collapsed
        guard let screen = screen() else { return }
        if collapsed {
            if isFullScreen {
                // It no longer covers the screen, and the keys it took for full screen go back.
                isFullScreen = false
                coverChanged()
                giveKeysBack()
            } else {
                // Whatever it was doing ends in its corner, where it opens again.
                dock(corner, on: screen)
            }
            // Not saved while collapsed, so the saved frame stays the open one.
            fog.setFrameAutosaveName("")
            let side = FogHandle.side
            morph(to: FogDock.frame(size: CGSize(width: side, height: side), corner: corner, in: screen.visibleFrame), form: .collapsed)
        } else {
            // Docked in its corner at the size it had, from the handle's own frame: `dock` would set the docked frame at
            // once. Saved again once it has landed (`landed`).
            motion.dock(corner, in: screen.frame)
            glassShows = true
            morph(to: FogDock.frame(size: motion.size, corner: corner, in: screen.frame), form: .docked)
        }
        showBlur()
    }

    /// Command-Return, the fog's button, Esc, or a pick the panel shows itself (`showInPanel`): fill the screen, or dock
    /// back in its corner at the size it had. It stays glass all the way, the corner easing from 30 to 26 as it grows to
    /// 12 pt from the screen's edges (`PanelGlass.Geometry`), and the words come back laid out for where it landed.
    func toggleFullScreen() {
        guard !isCollapsed, let screen = screen() else { return }
        dock(corner, on: screen)
        switching = false
        if isFullScreen {
            isFullScreen = false
            let frame = FogDock.frame(size: motion.size, corner: corner, in: screen.frame)
            updateInsets(frame, on: screen)
            morph(to: frame, form: .docked)
            // The keys it took for full screen go back to the app in front.
            giveKeysBack()
        } else {
            fog.setFrameAutosaveName("")
            // Full screen before the morph starts, so a morph that lands at once (Reduce Motion) never saves this frame.
            isFullScreen = true
            updateInsets(screen.frame, on: screen)
            morph(to: screen.frame, form: .fullScreen)
            // Full screen, the panel is what is on screen, so it takes the keys: Esc, Command-Return and the rest reach it.
            takeKeys()
        }
        showBlur()
        coverChanged()
    }

    /// A pick the panel shows itself, full screen: the deliverable it is on when that is one the panel draws
    /// (`ReviewScene.panelShowsContent`), else, with nothing to open, the session's words (`panelShowsWords`). Already full
    /// screen, the deliverable crossfades in place.
    func showInPanel() {
        if !isFullScreen { toggleFullScreen() }
    }

    /// A pick in the panel that opens something elsewhere: the fog docks first, so it isn't left over what comes forward.
    func dockForScene() {
        if isFullScreen { toggleFullScreen() }
    }

    /// On and open, now, for an open that shows in the panel and for the first open from the pill or the menu
    /// (`ConchStatusItem.open`): the menu's own defaults, so it stays on, applied at once rather than when their notice
    /// comes, so what follows finds the panel out. Folded, it opens on the morph; a full screen asked for next picks the
    /// morph up from wherever it is.
    func bringOut() {
        UserDefaults.standard.set(true, forKey: ConchStatusItem.showConversationKey)
        UserDefaults.standard.set(false, forKey: Self.conversationCollapsedKey)
        showWhatIsOn()
    }

    /// The glass for each form: 24 pt in with the panel's corner docked, 12 pt from the screen's edges full screen, the
    /// handle's circle collapsed.
    private func geometry(for form: Form) -> PanelGlass.Geometry {
        switch form {
        case .docked: .docked
        case .fullScreen: .fullScreen(menuBar: insets.top)
        case .collapsed: .collapsed(corner: corner)
        }
    }

    /// The fog's frame and its glass to `target` on the morph spring (ConchMotion's), stepped on the display's frames with
    /// the rest of its motion; at once under Reduce Motion, and before the panels are up. The words step aside as it
    /// starts, held as they were rather than laid out again at every size on the way, and come back for `form` once it
    /// has all but landed (`arrive`). It was AppKit's own resize animation, which no spring could tune, and then a frame
    /// that went full screen before the glass did.
    private func morph(to target: NSRect, form next: Form) {
        let from = glass, to = geometry(for: next)
        revealAt = nil
        revealed = false
        if wordsFrozen == nil { wordsFrozen = words.frame.size }
        guard settled, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            morphing = nil
            fog.setFrame(target, display: true)
            glass = to
            arrive(next, at: 0)
            return landed()
        }
        morphing = (from: fog.frame, to: target, glassFrom: from, glassTo: to, form: next, arrived: false, progress: 0, velocity: 0)
        container.run(true)
    }

    /// The frame all but landed as `next`: the words lay out for it in the window's whole bounds, and come back `delay`
    /// later, from a touch small and soft (`ConchMotion.reveal`). Collapsed, the glass gives way to the handle at once.
    private func arrive(_ next: Form, at delay: TimeInterval) {
        form = next
        wordsFrozen = nil
        laidGlass = geometry(for: next)
        laidInsets = insets
        glassShows = next != .collapsed
        layOut(margin: EdgeInsets())
        if delay > 0 {
            revealAt = ProcessInfo.processInfo.systemUptime + delay
            container.run(true)
        } else {
            revealed = true
        }
    }

    /// Docked again, it is saved again: only once it is back, so the next launch never restores a frame from full screen
    /// or from on the way.
    private func landed() {
        if !isFullScreen, !isCollapsed { fog.setFrameAutosaveName(Self.conversationFrameName) }
        showBlur()
    }

    /// The behind-window blur, below macOS 26 only: Liquid Glass draws its own. Docked, it lies under the look's mask; while
    /// the panel morphs or fills the screen it is the glass's own rounded shape, so full screen is the same glass panel
    /// there too, never a square. Hidden with the handle.
    private func showBlur() {
        let hidden = !Self.showsFog || Self.usesGlass || (form == .collapsed && morphing == nil)
        if blur.isHidden != hidden { blur.isHidden = hidden }
        // Drawn only while it shows: a hidden blur's mask is an image nobody sees.
        if !blur.isHidden { blur.maskImage = isFullScreen || morphing != nil ? Self.roundedMask(radius: glass.radius) : blurMask() }
        layOut(margin: EdgeInsets())
    }

    /// A rounded rect for the blur's mask, stretched to any size about its corners.
    private static func roundedMask(radius: CGFloat) -> NSImage {
        let side = 2 * radius + 1
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
            return true
        }
        image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
        image.resizingMode = .stretch
        return image
    }

    // MARK: The keys

    /// A key on the panel while it has the keys (`PanelKeys`): full screen, the switcher open, or typing a reply. True when
    /// it was the panel's; anything else goes on to the view with the keyboard.
    private func key(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags
        guard let action = PanelKeys.action(
            key: event.keyCode,
            command: flags.contains(.command),
            option: flags.contains(.option),
            control: flags.contains(.control),
            shift: flags.contains(.shift),
            switching: switching,
            fullScreen: isFullScreen,
            typing: fog.firstResponder is NSTextView
        ) else { return false }
        switch action {
        case .fullScreen: toggleFullScreen()
        case .exitFullScreen: if isFullScreen { toggleFullScreen() }
        case .previous, .next:
            // Only while something is held to walk to, as the buttons are; the panel's own walk (`from: .panel`).
            guard let store, !ConchStatusItem.heldRows(store.state).isEmpty else { return false }
            queue.walk(backward: action == .previous, from: .panel, store: store, panels: self)
        case .collapse: toggleCollapsed()
        case .closeSwitcher: switching = false
        case let .move(step): switcherSelection = FogSession.selection(after: switcherSelection, in: switcherSessions, by: step)
        case .pick:
            guard let store, let id = switcherSelection else { return true }
            queue.pick(id, store: store, panels: self)
        case .giveBack: giveKeysBack()
        }
        return true
    }

    /// What the switcher lists, in its order, for the keyboard to walk.
    private var switcherSessions: [FogSession] {
        ConversationFogHost.sessions(store?.state, staged: staged, lastStaged: queue.lastStaged)
    }

    /// The panel takes the keys without bringing conch forward: a non-activating panel is key while the app in front stays
    /// in front, as the canvas's glass is while the pen is down.
    private func takeKeys() {
        guard fog.isVisible, !fog.isKeyWindow else { return }
        fog.makeKey()
    }

    /// The keys back to the app in front, which never stopped being in front: the canvas's way (`CanvasController`'s
    /// `giveKeysBack`). A non-activating panel gives up the keyboard by leaving the screen, so it goes out and straight
    /// back in within the turn. conch is never activated.
    private func giveKeysBack() {
        guard fog.isKeyWindow else { return }
        fog.makeFirstResponder(nil)
        fog.orderOut(nil)
        fog.orderFrontRegardless()
    }

    /// Esc in the reply line, once the field has let go: docked, the keys go back to the app in front, so the next ones
    /// reach it rather than a panel with nothing to type into. Full screen, or with the switcher open, the panel keeps them.
    func replyLeft() {
        guard !isFullScreen, !switching else { return }
        giveKeysBack()
    }

    /// The switcher opened or closed. Open, it has the keys, the row on screen picked out, and a click in any other app
    /// closes it; closed, the keys go back unless full screen or a reply being typed still wants them.
    private func switchingChanged() {
        if switching {
            switcherSelection = ConversationFogHost.session(store?.state, staged: staged)?.id
            takeKeys()
            outsideClicks = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
                MainActor.assumeIsolated { self?.switching = false }
            }
        } else {
            if let outsideClicks { NSEvent.removeMonitor(outsideClicks) }
            outsideClicks = nil
            switcherSelection = nil
            if !isFullScreen, !(fog.firstResponder is NSTextView) { giveKeysBack() }
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
        // Mid-morph the morph has the frame.
        guard !isCollapsed, !isFullScreen, morphing == nil else { return layOut(margin: EdgeInsets()) }
        if motion.corner != corner { corner = motion.corner }
        if motion.isMoving != floating { floating = motion.isMoving }
        if let screen = NSScreen.screens.first(where: { $0.frame == motion.screen }) {
            updateInsets(FogDock.frame(size: motion.size, corner: corner, in: screen.frame), on: screen)
        }
        // Docked and still, the words follow the insets as it moves.
        if laidInsets != insets { laidInsets = insets }
        var next = FogLook(motion, insets: insets)
        (next.resizeHover, next.darkness, next.tint, next.colour, next.scrim) = (resizeHover, darkness, look.tint, look.colour, look.scrim)
        // With no reply line, the look thickens behind the newest words themselves.
        next.replyHeight = showsReply ? text.replyHeight : 0
        setLook(next)
        // The glass ends at its own rounded edge and the window's shadow is drawn from that shape, so the window is
        // exactly the fog: no margin to reach into, and nothing for the saved frame to grow by on the next launch.
        let frame = motion.frame
        if fog.frame != frame { fog.setFrame(frame, display: true) }
        layOut(margin: EdgeInsets())
    }

    /// The words where the fog is in its window, and the blur and its look over the whole window. The container's origin
    /// stays the fog's, so presses and control frames need no converting. Mid-morph the words keep the size they had, in
    /// the fog's corner, rather than laying out again at every size on the way (`morph`); and below macOS 26 the blur is
    /// the glass's own rect while it morphs or fills the screen.
    private func layOut(margin: EdgeInsets) {
        let origin = CGPoint(x: -margin.leading, y: -margin.top)
        if container.bounds.origin != origin { container.setBoundsOrigin(origin) }
        let bounds = container.bounds
        let inset = glass.insets
        blur.frame = isFullScreen || morphing != nil
            ? CGRect(x: bounds.minX + inset.leading, y: bounds.minY + inset.top, width: max(0, bounds.width - inset.leading - inset.trailing), height: max(0, bounds.height - inset.top - inset.bottom))
            : bounds
        lookHost.frame = bounds
        let size = wordsFrozen ?? CGSize(width: bounds.width - margin.leading - margin.trailing, height: bounds.height - margin.top - margin.bottom)
        // Top left, as the fog's view is flipped: a bottom corner holds the words to the bottom, a trailing one to the right.
        let frame = CGRect(x: corner.leading ? 0 : bounds.width - size.width, y: corner.bottom ? bounds.height - size.height : 0, width: size.width, height: size.height)
        if words.frame != frame { words.frame = frame }
    }

    /// A new look, and the blur's mask drawn again for it: only while the blur shows. On Liquid Glass it is always hidden,
    /// and drawing its mask on every frame of a drag drew an image nobody saw (`showBlur` draws it on the way back).
    private func setLook(_ next: FogLook) {
        guard next != look else { return }
        look = next
        guard !isCollapsed, !isFullScreen else { return }
        if !blur.isHidden { blur.maskImage = blurMask() }
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

    /// Pressed near any edge, text included, the fog resizes from its docked corner; in the middle it moves. Not while it
    /// morphs: the morph has the frame.
    func pressed() {
        // A press anywhere but the switcher closes it, as a click outside a menu does.
        if switching { switching = false }
        guard morphing == nil, form != .collapsed else { return }
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

    /// `t` of the way from one frame to another; past 1 it overshoots, as the spring does.
    private static func frame(from a: NSRect, to b: NSRect, at t: CGFloat) -> NSRect {
        NSRect(x: a.minX + (b.minX - a.minX) * t, y: a.minY + (b.minY - a.minY) * t, width: a.width + (b.width - a.width) * t, height: a.height + (b.height - a.height) * t)
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
        if ConchMotion.hover.step(&resizeHover, velocity: &hoverVelocity, to: hoverTarget, dt: dt) {
            resizeHover = hoverTarget
            hoverVelocity = 0
        }
        let now = ProcessInfo.processInfo.systemUptime
        let words = text.step(dt: dt, now: now, reduceMotion: motion.reduceMotion)
        if var morph = morphing {
            let done = ConchMotion.morph.step(&morph.progress, velocity: &morph.velocity, to: 1, dt: dt)
            let arrives = !morph.arrived && (done || morph.progress >= Self.arrives)
            morph.arrived = morph.arrived || arrives
            morphing = done ? nil : morph
            fog.setFrame(done ? morph.to : Self.frame(from: morph.from, to: morph.to, at: morph.progress), display: true)
            glass = done ? morph.glassTo : PanelGlass.Geometry.lerp(morph.glassFrom, morph.glassTo, morph.progress)
            // The window's shadow is drawn from the glass, whose shape just changed.
            fog.invalidateShadow()
            if arrives { arrive(morph.form, at: morph.form == .collapsed ? 0 : ConchMotion.revealDelay) }
            showBlur()
            if done { landed() }
        }
        if let at = revealAt, now >= at {
            revealAt = nil
            revealed = true
        }
        apply()
        if motion.isSettled, darkness == darkTarget, resizeHover == hoverTarget, morphing == nil, revealAt == nil, !words { container.run(false) }
    }
}

/// The control bar on the store. Talk and Quiet are the daemon's global resume and pause, as the menu bar
/// sends them. The conversation is the menu's to show and hide.
private struct ControlBarHost: View {
    @ObservedObject var store: StateStore
    /// The walk the pill takes through what is ready, shared with the panel's Previous and Next.
    @ObservedObject var queue: ReviewQueue
    /// Not observed: the bar only tells it what it staged, and the fog's motion publishes every frame.
    let panels: FloatingPanels
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
            ),
            // The next ready item's session, where it is among what is ready, and what the agent asked you to check.
            ready: queue.pill(store.state),
            news: ConchStatusItem.news(store.state),
            onTap: { queue.walk(from: .pill, store: store, panels: panels) }
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

/// What is held, walked by the Ready pill, the menu's Ready for you and the panel's Previous and Next (Tyler: "ability to
/// click next or select different session form that"). One walk rather than one each, so they agree on where it is; and
/// its own object, so the control bar can watch it without watching the fog, whose motion publishes every frame.
@MainActor
final class ReviewQueue: ObservableObject {
    /// The review version the last click brought forward, and the versions handed off: for the next click to move on from.
    @Published private(set) var lastStaged: ReviewItem.ID?
    @Published private(set) var opened: Set<ReviewItem.ID> = []
    /// The click being staged. Clicks run one at a time, the pill's and the panel's alike.
    private var staging: Task<Void, Never>?

    /// What the walk reaches: every deliverable a session that isn't working still holds, not only its newest, looked at
    /// or not, so Previous goes back to what you have seen. Each by its exact version (`ReviewItem.id`: what the daemon
    /// minted when it was filed), never by a place in the queue.
    static func held(_ state: PublishedState?) -> [ReviewItem] {
        ConchStatusItem.heldRows(state).flatMap { row in row.held.map { ReviewItem(row: row, review: $0) } }
    }

    /// What is ready: the held ones nobody has looked at yet (`ReadyForYou`), oldest filed first. What the pill counts.
    func ready(in held: [ReviewItem], state: PublishedState?) -> [ReviewItem] {
        let seen = seen(in: held, state: state)
        let order = ReviewScene.order(held.map { (key: $0.id, at: $0.reviewedAt ?? 0) })
        return order.compactMap { key in held.first { $0.id == key && !seen.contains(key) } }
    }

    /// The pill: the session the next click opens, and where that item is among what is ready. Nil while nothing is.
    func pill(_ state: PublishedState?) -> ControlBar.Ready? {
        let held = Self.held(state)
        let ready = ready(in: held, state: state)
        guard let next = next(in: held, state: state), let at = ready.firstIndex(where: { $0.id == next.id }) else { return nil }
        return ControlBar.Ready(label: next.label, position: at + 1, count: ready.count, inspect: next.inspect)
    }

    /// What has been looked at: whatever the daemon remembers, on any device, plus whatever
    /// this window has just handed off. The local half is optimistic — the pill moves on at
    /// the click and the daemon's answer catches up — and it is the whole story against a
    /// daemon too old to remember, which is what `features.viewedState` distinguishes.
    private func seen(in held: [ReviewItem], state: PublishedState?) -> Set<ReviewItem.ID> {
        guard state?.features?.viewedState != nil else { return opened }
        return opened.union(held.filter { $0.viewedAt != nil }.map(\.id))
    }

    /// The review the next click brings forward: the next nobody has looked at, else round again.
    func next(in held: [ReviewItem], state: PublishedState?) -> ReviewItem? {
        let key = ReviewScene.next(after: lastStaged, in: held.map { (key: $0.id, at: $0.reviewedAt ?? 0) }, opened: seen(in: held, state: state))
        return held.first { $0.id == key }
    }

    /// A click on the Ready pill, or on the panel's Previous or Next. The version is taken at the click, and found again
    /// when its turn comes: still that version, and still held.
    func walk(backward: Bool = false, from origin: ConchStatusItem.OpenFrom, store: StateStore, panels: FloatingPanels) {
        let held = Self.held(store.state)
        let key = backward
            ? ReviewScene.previous(before: lastStaged, in: held.map { (key: $0.id, at: $0.reviewedAt ?? 0) })
            : next(in: held, state: store.state)?.id
        guard let key else { return }
        lastStaged = key
        stage(from: origin, store: store, panels: panels) { state in Self.find(key, in: state) }
    }

    /// A Ready for you row in the menu bar menu: that session's next item nobody has looked at, oldest filed first, else
    /// its newest; opened as the pill opens one.
    func open(session id: SessionRow.ID, store: StateStore, panels: FloatingPanels) {
        let held = Self.held(store.state).filter { $0.rowID == id }
        guard let item = ready(in: held, state: store.state).first ?? held.last else { return }
        lastStaged = item.id
        stage(from: .menu, store: store, panels: panels) { state in Self.find(item.id, in: state) }
    }

    /// A held review by its exact version, as its session's row holding it.
    private static func find(_ key: ReviewItem.ID, in state: PublishedState?) -> (row: SessionRow, key: ReviewItem.ID?)? {
        for row in ConchStatusItem.heldRows(state) {
            if let review = row.held.first(where: { ReviewItem(row: row, review: $0).id == key }) { return (row.holding(review), key) }
        }
        return nil
    }

    /// The version the panel is on was published again, newer (the same artifact, `SessionRow.newest(of:)`): the walk goes
    /// on from the newest, so Next moves past it, and the agent's marks, which follow this key, are the newest's. Nothing is
    /// counted opened by it.
    func follow(to key: ReviewItem.ID) {
        guard key != lastStaged else { return }
        lastStaged = key
    }

    /// A session picked in the panel's switcher: pinned, and its newest deliverable brought forward as the pill brings
    /// one, ready or not; with none, its words.
    func pick(_ id: SessionRow.ID, store: StateStore, panels: FloatingPanels) {
        panels.switching = false
        stage(from: .panel, store: store, panels: panels) { [self] state in
            guard let row = state?.row(id) else { return nil }
            let key = row.review.map { ReviewItem(row: row, review: $0).id }
            if let key { lastStaged = key }
            return (row, key)
        }
    }

    /// Clicks run one at a time, so an earlier one finishing late can't retarget the conversation after a later one. Each
    /// finds what it is showing (`find`), pins the conversation to its session, brings it forward by the one opening rule
    /// (`ConchStatusItem.open`), and counts its review opened only once handed off. Never the mic or speech.
    private func stage(
        from origin: ConchStatusItem.OpenFrom,
        store: StateStore,
        panels: FloatingPanels,
        find: @escaping @MainActor (PublishedState?) -> (row: SessionRow, key: ReviewItem.ID?)?
    ) {
        let previous = staging
        staging = Task { @MainActor in
            await previous?.value
            guard let found = find(store.state) else { return }
            panels.staged = found.row.id
            guard await ConchStatusItem.open(found.row, from: origin, store: store, panels: panels), let key = found.key else { return }
            opened.insert(key)
            // So the phone, the terminal and the next launch agree with this window.
            if store.state?.features?.viewedState != nil {
                store.markReviewViewed(sessionId: found.row.id, review: key)
            }
        }
    }
}

extension SessionRow {
    /// Every deliverable the session still holds, oldest first; from a daemon too old to send them all, its newest. An
    /// empty list is that too: a ready row must never drop out of the queue its `review` put it in.
    var held: [ReviewInfo] {
        if let reviews, !reviews.isEmpty { return reviews }
        return review.map { [$0] } ?? []
    }

    /// The newest filing of the artifact `key` is a version of, among what this session holds (`DeliverableGroups`, the
    /// dashboard's own grouping: the daemon's artifact, else the link): `key` itself when nothing newer has been published,
    /// or when it is no longer held. A different artifact arriving is never a newer version of this one.
    func newest(of key: ReviewItem.ID) -> ReviewItem.ID {
        let versions = held.map { DeliverableVersion(id: ReviewItem(row: self, review: $0).id, link: $0.link, artifact: $0.artifact) }
        return DeliverableGroups.newest(of: key, in: versions) ?? key
    }

    /// This row with `review` as its newest, so `ConchStatusItem.stage`, which brings a row's `review` forward, brings
    /// an older held one.
    func holding(_ review: ReviewInfo) -> SessionRow {
        var row = self
        row.review = review
        return row
    }

    /// Its newest deliverable, when the conversation panel draws it itself, full screen, in the side panel's renderers
    /// (`ReviewScene.panelShowsContent`); read as `ConchStatusItem.stage` reads a scene.
    var panelContent: ReviewItem? {
        guard let review, let item = ReviewItem(row: self) else { return nil }
        let kind = ReviewScene.Kind(rawValue: review.sceneKind ?? "") ?? .auto
        let link = item.link.map { LinkTarget.url(for: $0, cwd: cwd) }
        return ReviewScene.panelShowsContent(kind: kind, deliverable: review.kind, link: link, fileExists: { FileManager.default.fileExists(atPath: $0) }) ? item : nil
    }
}

private struct ControlBarSize: PreferenceKey {
    static let defaultValue = CGSize.zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

/// The glass under the words, in the voice's colour (the control bar's voice state), wherever the panel is on its way.
private struct FogLookHost: View {
    @ObservedObject var store: StateStore
    @ObservedObject var panels: FloatingPanels
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if FloatingPanels.showsFog {
            // panel.html floats the panel off the corner (`left:24px;bottom:24px`) rather than hanging it flush, which
            // is what lets all four corners round and the shadow read on every side. It stays glass everywhere: docked,
            // full screen, and on the way between them and into the collapsed handle, where it gives way to the handle
            // (`PanelGlass.Geometry`). The window is the frame, so the magnet, the docking contract and every motion test
            // are untouched.
            ConchGlassPanel(darkness: panels.look.darkness, voice: ConchStatusItem.voiceState(store.state), radius: panels.glass.radius)
                .padding(panels.glass.insets)
                .animation(reduceMotion ? nil : ConchMotion.liftOff.animation(reduceMotion: false)) {
                    $0.opacity(panels.glassShows ? 1 : 0)
                }
        }
    }
}

/// The panel's words and buttons, or its handle, stepping aside while the frame morphs and coming back once it lands
/// (`FloatingPanels.revealed`): out quick, in on the reveal spring from a touch small and soft, as panel-lab's content
/// fades in once the panel has room for it. Under Reduce Motion they cut.
private struct Revealed: ViewModifier {
    let shown: Bool
    let reduceMotion: Bool

    func body(content: Content) -> some View {
        content
            .animation(reduceMotion ? nil : (shown ? ConchMotion.reveal : ConchMotion.liftOff).animation(reduceMotion: false)) {
                $0.opacity(shown ? 1 : 0)
                    .scaleEffect(shown || reduceMotion ? 1 : ConchMotion.revealScale)
                    .blur(radius: shown || reduceMotion ? 0 : ConchMotion.revealBlur)
            }
            .allowsHitTesting(shown)
    }
}

/// The conversation fog on the store, for the session the voice is on. The reply is that session's
/// composer draft, sent and dictated the way the dashboard's composer does it.
private struct ConversationFogHost: View {
    @ObservedObject var store: StateStore
    @ObservedObject var panels: FloatingPanels
    /// The walk through what is ready: the header names the review it brought forward, and Previous and Next take it.
    @ObservedObject var queue: ReviewQueue
    /// The overlay's own reader: it follows the staged session, which is not necessarily
    /// the one the dashboard is showing.
    @ObservedObject var history: HistoryStore
    @ObservedObject private var drafts = ComposerDraftStore.shared
    @ObservedObject private var canvas = CanvasController.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let row = Self.session(store.state, staged: panels.staged)
        let turns = row.map { Self.turns(store.state, $0, whole: history.fullBodies) } ?? []
        // Previous and Next only while something is held to walk to, looked at or not: with nothing they would do nothing.
        let walks = !ConchStatusItem.heldRows(store.state).isEmpty
        // The words lay out for the form the panel has landed in, inside its glass (`FloatingPanels.laidGlass`).
        let glass = panels.laidGlass
        Group {
            if panels.form == .collapsed {
                FogHandle(corner: panels.corner, hovering: panels.hovering) { panels.toggleCollapsed() }
            } else {
                ConversationFog(
                    turns: turns,
                    draft: row.map { drafts.textBinding(for: $0.id) } ?? .constant(""),
                    text: panels.text,
                    isListening: row.map { ["listening", "recording"].contains(voice(for: $0)) } ?? false,
                    // The store's own working state, not a timer: "Thinking" after your message until the reply comes.
                    isWorking: row?.status == .working,
                    isFullScreen: panels.form == .fullScreen,
                    corner: panels.corner,
                    insets: panels.laidInsets.less(glass.insets),
                    look: panels.look,
                    floating: panels.floating,
                    hovering: panels.hovering,
                    session: row.map { Self.fogSession($0, item: Self.review(of: $0, staged: panels.staged, lastStaged: queue.lastStaged)?.summary) },
                    // Built only while the switcher is open.
                    sessions: panels.switching ? Self.sessions(store.state, staged: panels.staged, lastStaged: queue.lastStaged) : [],
                    isSwitching: $panels.switching,
                    switcherSelection: panels.switcherSelection,
                    // No session, nothing to reply to: no line to type into that goes nowhere.
                    showsReply: panels.showsReply && row != nil,
                    content: panels.form == .fullScreen ? row.flatMap(content(of:)) : nil,
                    // What the store says of this session's last send: why a reply didn't go (`ConchSendFailure`).
                    notice: row.flatMap { store.rowMessages[$0.id] },
                    empty: row == nil ? Self.empty(store.liveness) : nil,
                    speaking: Self.speaking(store.state, besides: row?.id),
                    onPick: { queue.pick($0, store: store, panels: panels) },
                    onPrevious: walks ? { queue.walk(backward: true, from: .panel, store: store, panels: panels) } : nil,
                    onNext: walks ? { queue.walk(from: .panel, store: store, panels: panels) } : nil,
                    onMic: { if let row { mic(row) } },
                    onSend: { if let row { send(row) } },
                    onLeaveReply: { panels.replyLeft() },
                    onCollapse: { panels.toggleCollapsed() },
                    onFullScreen: { panels.toggleFullScreen() },
                    onCanvas: { canvas.toggle() },
                    isCanvasOn: canvas.armed
                )
                // The glass is inset inside the window, so the words and the buttons come in with it — the buttons are
                // placed from the edge they are given, and left at the window's they sat out on the desktop beside the
                // panel. Inside the Group, so `FogControls` frames and the presses they are matched against
                // (`grabs`, in the container's space) move together; outside it they would not.
                .padding(glass.insets)
                // A throw's flight: it softens and shrinks a little mid-air, and lands whole. Reduce Motion keeps only the fade.
                .scaleEffect(1 - (1 - ConchMotion.flightScale) * (reduceMotion ? 0 : panels.throwMotion))
                .blur(radius: reduceMotion ? 0 : ConchMotion.flightBlur * panels.throwMotion)
            }
        }
        .modifier(Revealed(shown: panels.revealed, reduceMotion: reduceMotion))
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
        // A newer version of the item the panel is on, published again as the same artifact, is followed to: the queue's
        // walk, and with it the header, full screen and the agent's marks (`AgentInkController`). Not while Tyler has marks
        // of his own on the canvas, which a new item clears (`CanvasController`): they are on this version, and it follows
        // once they are sent or thrown away.
        .onChange(of: canvas.document?.has(.you) == true ? nil : Self.followed(store.state, staged: panels.staged, lastStaged: queue.lastStaged)) { _, newer in
            if let newer { queue.follow(to: newer) }
        }
    }

    /// The session the Ready pill staged, else the one the voice is on, else the daemon's active or selected one, else
    /// the first. Never a subagent. The chain is the window's own (ConchDesign/Workspace.swift): the overlay pins a
    /// different session from the dashboard, but it must not resolve it by a different rule.
    static func session(_ state: PublishedState?, staged: SessionRow.ID? = nil) -> SessionRow? {
        state?.row(WorkspaceFocus.viewed(in: Workspace(state), pinned: staged))
    }

    /// With no session to show, what the panel says instead: the daemon not answering, or nothing to show yet. While it
    /// is still finding out, nothing.
    static func empty(_ liveness: DaemonLiveness) -> String? {
        switch liveness {
        case .checking: nil
        case .alive: "No sessions yet"
        case .dead, .stalled: "conch isn't running"
        }
    }

    /// The session the voice is reading aloud, when it isn't the one the panel shows (`besides`): named in the panel's
    /// header row, a click from it. The session the voice is on is the dashboard's rule (`WorkspaceFocus.addressed`).
    static func speaking(_ state: PublishedState?, besides shown: SessionRow.ID?) -> FogSession? {
        guard let state, state.live.state == "speaking", let id = WorkspaceFocus.addressed(in: Workspace(state)), id != shown,
              let row = state.row(id) else { return nil }
        return fogSession(row, item: nil)
    }

    /// Every session the switcher lists: ready for you and working as the menu bar menu groups them, then the rest
    /// (`FogSession.ordered`). Never a subagent, which has nothing to reply to.
    static func sessions(_ state: PublishedState?, staged: SessionRow.ID?, lastStaged: ReviewItem.ID?) -> [FogSession] {
        let ready = Set(ConchStatusItem.readyRows(state).map(\.id)), working = Set(ConchStatusItem.workingRows(state).map(\.id))
        return FogSession.ordered((state?.rows ?? []).filter { $0.parentSessionId == nil }.map { row in
            fogSession(
                row,
                item: review(of: row, staged: staged, lastStaged: lastStaged)?.summary,
                standing: ready.contains(row.id) ? .ready : working.contains(row.id) ? .working : .other
            )
        })
    }

    static func fogSession(_ row: SessionRow, item: String?, standing: FogSession.Standing = .other) -> FogSession {
        // ponytail: the session list's two marks (AgentBadge); a third backend gets Claude's until it has its own asset.
        let codex = row.backend?.lowercased() == "codex"
        return FogSession(id: row.id, label: row.label, agent: codex ? "Codex" : "Claude", mark: codex ? "AgentCodex" : "AgentClaude", item: item, standing: standing)
    }

    /// The item a session is on: the review the queue brought forward when this is the session it staged (which follows a
    /// newer version of it, `followed`), else the session's newest held one; with none, nothing. The header names it, and
    /// full screen shows it.
    static func review(of row: SessionRow, staged: SessionRow.ID?, lastStaged: ReviewItem.ID?) -> ReviewInfo? {
        if row.id == staged, let review = row.held.first(where: { ReviewItem(row: row, review: $0).id == lastStaged }) {
            return review
        }
        return row.review
    }

    /// The newer version the queue should follow to, when the item it brought forward has been published again as the same
    /// artifact; nil while it is the newest, or the panel isn't on the session it staged.
    static func followed(_ state: PublishedState?, staged: SessionRow.ID?, lastStaged: ReviewItem.ID?) -> ReviewItem.ID? {
        guard let lastStaged, let row = state?.row(staged) else { return nil }
        let newest = row.newest(of: lastStaged)
        return newest == lastStaged ? nil : newest
    }

    /// Full screen, the item the header names, in the panel itself when it is one the panel draws
    /// (`SessionRow.panelContent`); else nil, and the words.
    private func content(of row: SessionRow) -> FogContent? {
        guard let review = Self.review(of: row, staged: panels.staged, lastStaged: queue.lastStaged),
              let item = row.holding(review).panelContent else { return nil }
        return FogContent(id: item.id) { PanelContent(item: item, cwd: row.cwd, store: store, panels: panels) }
    }

    /// What was said, both ways. Tools, thinking and materials stay in the dashboard.
    /// `whole` is what the record store says the message actually was, by provider id.
    /// The snapshot keeps only the last 4,000 characters of a long one, so enlarging the
    /// overlay without this enlarged the cut rather than showing the message.
    /// Something Tyler sent through conch is its title alone ("Marked up Invite page"): the
    /// words are the fog's, and the whole message is written for the agent.
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
                    text: $0.receipt?.title ?? whole[HistorySnapshot.nativeId(forSnapshotItem: $0.id)] ?? $0.text
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

/// A deliverable inside the conversation panel, full screen, in the side panel's own renderer (`InlineReviewView`), so a
/// local file goes through the same checks here as there. Its arrow opens it where it lives, the panel docking first so it
/// isn't left over what comes forward.
private struct PanelContent: View {
    let item: ReviewItem
    let cwd: String?
    let store: StateStore
    let panels: FloatingPanels
    /// Where the pane has browsed to, for the arrow to open: each deliverable's own, since the panel keys it by version.
    @State private var address: String?

    var body: some View {
        InlineReviewView(item: item, onOpenInPlace: openWhereItLives, liveAddress: $address)
            .environmentObject(store)
    }

    private func openWhereItLives() {
        guard let link = address ?? item.link else { return }
        panels.dockForScene()
        // The one door for links files a failure (A13); docked, the panel has no line left to show it on.
        store.openLink(link, cwd: cwd, rowId: item.rowID) { _ in }
    }
}
