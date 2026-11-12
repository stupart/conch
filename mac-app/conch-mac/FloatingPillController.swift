import AppKit
import Combine
import ConchDesign
import SwiftUI

/// The floating pill's window: borderless, over every app and on every space, full-screen ones too, and out of the window
/// cycle. Non-activating and never key: a click in it leaves Tyler where he was, and his keys where they were.
///
/// Every press on the pill itself is handled here, before SwiftUI sees it, because the window moves under the pointer
/// while it is dragged and a SwiftUI gesture is cancelled by that (#205). A press on one of its buttons goes on to
/// SwiftUI's Button as usual (`FloatingPill.action(at:in:)` says which).
final class FloatingPillPanel: NSPanel {
    /// Seen before the view under it; true when it was the pill's own and is taken.
    var onMouse: ((NSEvent) -> Bool)?

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown, .leftMouseDragged, .leftMouseUp, .rightMouseDown:
            if let onMouse, onMouse(event) { return }
        default:
            break
        }
        super.sendEvent(event)
    }
}

/// The pill's view. It knows where the pointer is even while conch is in the background, which SwiftUI's hover inside a
/// panel of an app that isn't active can't be relied on for, and its first click acts: there is no click to focus it first.
private final class FloatingPillHostingView: NSHostingView<FloatingPillRoot> {
    var onPointer: ((NSPoint?) -> Void)?

    /// A point in the window as the pill's model has it: from the view's top left, y down.
    func topLeft(_ locationInWindow: NSPoint) -> NSPoint {
        let point = convert(locationInWindow, from: nil)
        return isFlipped ? point : NSPoint(x: point.x, y: bounds.height - point.y)
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        guard !trackingAreas.contains(where: { $0.owner === self && $0.options.contains(.activeAlways) }) else { return }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        onPointer?(topLeft(event.locationInWindow))
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        onPointer?(topLeft(event.locationInWindow))
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        onPointer?(nil)
    }
}

/// What the pill's view draws, and where in its window: the controller's to change, with the animation it wants.
@MainActor
final class FloatingPillModel: ObservableObject {
    @Published var face = FloatingPill.face(FloatingPill.Input())
    @Published var expanded = false
    @Published var hovered: FloatingPillView.Target?
    @Published var pressed: FloatingPillView.Target?
    /// The pill's frame in its window, y down.
    @Published var rect = CGRect.zero
}

private struct FloatingPillRoot: View {
    @ObservedObject var model: FloatingPillModel
    let onAction: (FloatingPill.Action) -> Void

    var body: some View {
        FloatingPillView(face: model.face, expanded: model.expanded, hovered: model.hovered, pressed: model.pressed, onAction: onAction)
            .frame(width: model.rect.width, height: model.rect.height, alignment: .leading)
            .position(x: model.rect.midX, y: model.rect.midY)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            // Its window can't be seen: the speaking and listening glyphs' clocks stop.
            .conchPausesWhenHidden()
    }
}

/// The floating pill (2026-11-11), the one thing conch draws over other apps: `FloatingPill` is the rule, this its
/// window. It shows while `FloatingPill.key` is on (on by default; the menu bar menu's Floating Pill and Settings switch
/// it, live), reads the daemon's published state through the store, and asks the daemon for everything it does. It never
/// speaks or opens a mic itself: Talk is the same wake the window's mic sends, so the daemon's rule that the mic never opens
/// while it speaks holds here as it does everywhere.
@MainActor
final class FloatingPillController {
    static let shared = FloatingPillController()

    /// The switch as it stands.
    nonisolated static var isOn: Bool { FloatingPill.enabled(stored: UserDefaults.standard.object(forKey: FloatingPill.key)) }

    private weak var store: StateStore?
    private let model = FloatingPillModel()
    private var panel: FloatingPillPanel?
    private var host: FloatingPillHostingView?
    private var input = FloatingPill.Input()
    private var dock = FloatingPillController.savedDock()
    private var subscriptions: Set<AnyCancellable> = []
    private var observers: [NSObjectProtocol] = []
    private var installed = false
    private var shown = false
    /// The pointer is over the pill; and the timer that opens or closes it after a moment's rest.
    private var pointerInside = false
    private var hoverTimer: Timer?
    /// The window settling to the pill once a change of size has played out.
    private var settle: DispatchWorkItem?
    /// A press on the pill itself: where it started, the pill's frame then, and whether it has become a drag.
    private var press: (start: NSPoint, frame: CGRect, dragging: Bool)?

    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    // MARK: Install

    func install(store: StateStore) {
        guard !installed else { return }
        installed = true
        self.store = store
        Self.migrate(UserDefaults.standard)
        store.$state
            .combineLatest(store.$daemonMessage)
            .map { Self.input($0, daemonMessage: $1) }
            .removeDuplicates()
            .sink { [weak self] input in MainActor.assumeIsolated { self?.update(input) } }
            .store(in: &subscriptions)
        let center = NotificationCenter.default
        // The switch, flipped from the menu bar or Settings: shown or put away at once.
        observers.append(center.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.apply() }
        })
        // A display added, taken away or rearranged: docked again where it was, on the screen it is on now.
        observers.append(center.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.place(animated: false) }
        })
        apply()
    }

    /// The old overlays' settings, once: an explicit choice about them carries over to the pill, and their keys go
    /// (`FloatingPill.migration`).
    static func migrate(_ defaults: UserDefaults) {
        let present = Set(defaults.dictionaryRepresentation().keys)
        let migration = FloatingPill.migration(pill: defaults.object(forKey: FloatingPill.key),
                                               legacy: defaults.object(forKey: FloatingPill.legacyKey), present: present)
        if let set = migration.set { defaults.set(set, forKey: FloatingPill.key) }
        for key in migration.remove { defaults.removeObject(forKey: key) }
    }

    /// The pill's input from one published state. The daemon not answering is said, rather than shown as nothing to do.
    nonisolated static func input(_ state: PublishedState?, daemonMessage: String?) -> FloatingPill.Input {
        guard let state else {
            return FloatingPill.Input(daemonNote: daemonMessage ?? "Waiting for conch's daemon")
        }
        let sessions = state.rows.filter { $0.parentSessionId == nil }.map { row -> FloatingPill.Session in
            let ready = ReadyForYou.isReady(working: row.status == .working, held: row.held.map { ($0.viewedAt, $0.approvedAt) })
            let need: FloatingPill.Need? = row.approval != nil ? .permission
                : row.status == .needs ? .question
                : ready ? .ready : nil
            let detail: String? = switch need {
            case .permission: row.approval?.name
            case .ready: row.held.last { ReadyForYou.isWaiting(viewedAt: $0.viewedAt, approvedAt: $0.approvedAt) }?.summary
            case .question, nil: nil
            }
            return FloatingPill.Session(id: row.id, label: row.label, working: row.status == .working, need: need, detail: detail,
                                        at: row.at ?? 0)
        }
        let voice: FloatingPill.Voice? = switch state.live.state {
        case "speaking": .speaking
        case "listening", "recording": .listening
        default: nil
        }
        // The words going by: read aloud up to where the voice has got, or heard so far.
        let caption: String? = switch voice {
        case .speaking: state.live.reading.map { String($0.text.prefix($0.spokenChars)) }
        case .listening: [state.live.transcriptPrefix, state.live.partial].filter { !$0.isEmpty }.joined(separator: " ")
        case nil: nil
        }
        return FloatingPill.Input(
            sessions: sessions,
            voice: voice,
            voiceSession: state.rows.first { $0.active && $0.parentSessionId == nil }?.id,
            voiceLabel: state.live.label,
            caption: caption?.trimmingCharacters(in: .whitespacesAndNewlines),
            manual: state.mode.paused,
            exchangeActive: state.live.isExchangeActive,
            audioElsewhere: !state.audioControl.isLocal,
            daemonNote: daemonMessage
        )
    }

    // MARK: Showing it

    /// Shown while the switch is on, put away while it is off.
    private func apply() {
        let on = Self.isOn
        guard on != shown else { return }
        shown = on
        if on {
            let panel = panel ?? makePanel()
            place(animated: false)
            panel.orderFrontRegardless()
        } else {
            cancelHover()
            press = nil
            model.expanded = false
            panel?.orderOut(nil)
        }
    }

    private func makePanel() -> FloatingPillPanel {
        let panel = FloatingPillPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        // Over other apps' windows and their floating palettes, under menus.
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.isMovable = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        // The pill draws its own shadow (`FloatingPillView`), inside the window's margin.
        panel.hasShadow = false
        panel.animationBehavior = .none
        panel.isExcludedFromWindowsMenu = true
        panel.title = "conch floating pill"
        let host = FloatingPillHostingView(rootView: FloatingPillRoot(model: model) { [weak self] action in self?.act(action) })
        host.onPointer = { [weak self] point in self?.pointer(at: point) }
        panel.contentView = host
        panel.onMouse = { [weak self] event in self?.mouse(event) ?? false }
        self.panel = panel
        self.host = host
        return panel
    }

    /// The window that is the pill, for a debug capture (`DebugSnapshot`).
    var window: NSWindow? { panel }

    private func update(_ next: FloatingPill.Input) {
        input = next
        let face = FloatingPill.face(next)
        guard face != model.face else { return }
        // The words and marks change with the same spring the window's room is given on, so the pill grows round them.
        withAnimation(reduceMotion ? .easeInOut(duration: 0.15) : ConchMotion.grow.animation(reduceMotion: false)) { model.face = face }
        place(animated: true)
    }

    // MARK: Where it sits

    /// The pill's size for its face, collapsed or expanded, as SwiftUI lays it out.
    private func size(expanded: Bool) -> CGSize {
        let sizer = NSHostingView(rootView: FloatingPillView(face: model.face, expanded: expanded).fixedSize())
        let fitting = sizer.fittingSize
        return CGSize(width: ceil(fitting.width), height: ceil(fitting.height))
    }

    /// The screen it is docked on: the display it was left on, else the main one (the menu bar's).
    private var screen: NSScreen? {
        let id = dock.display
        return NSScreen.screens.first { id != nil && Self.displayID(of: $0) == id } ?? NSScreen.screens.first
    }

    private static func displayID(of screen: NSScreen) -> String? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber).map { "\($0.uint32Value)" }
    }

    /// The pill's frame on screen now, from its window and where it sits in it.
    private var pillFrame: CGRect? {
        guard let panel, model.rect != .zero else { return nil }
        return CGRect(x: panel.frame.minX + model.rect.minX, y: panel.frame.maxY - model.rect.maxY,
                      width: model.rect.width, height: model.rect.height)
    }

    /// Docked where `dock` says, at its size now. Animated, the window takes the room for both sizes at once and the pill
    /// grows or shrinks within it (`FloatingPill.transition`); the window settles to it after.
    private func place(animated: Bool) {
        guard shown, let panel, let screen else { return }
        let target = FloatingPill.frame(size: size(expanded: model.expanded), dock: dock, in: screen.visibleFrame)
        // The words changed and the size didn't: nothing to move.
        if let current = pillFrame, current == target, press == nil { return }
        settle?.cancel()
        guard animated, let from = pillFrame, panel.isVisible, !reduceMotion else {
            let window = target.insetBy(dx: -FloatingPill.Metrics.shadowRoom, dy: -FloatingPill.Metrics.shadowRoom)
            panel.setFrame(window, display: true)
            model.rect = CGRect(x: FloatingPill.Metrics.shadowRoom, y: FloatingPill.Metrics.shadowRoom, width: target.width, height: target.height)
            return
        }
        let step = FloatingPill.transition(from: from, to: target)
        panel.setFrame(step.window, display: false)
        // Where it is now, in the bigger window, without a frame of it anywhere else; then to where it is going.
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) { model.rect = step.from }
        withAnimation(ConchMotion.grow.animation(reduceMotion: false)) { model.rect = step.to }
        let work = DispatchWorkItem { [weak self] in
            guard let self, let panel = self.panel else { return }
            panel.setFrame(target.insetBy(dx: -FloatingPill.Metrics.shadowRoom, dy: -FloatingPill.Metrics.shadowRoom), display: false)
            withTransaction(still) {
                self.model.rect = CGRect(x: FloatingPill.Metrics.shadowRoom, y: FloatingPill.Metrics.shadowRoom, width: target.width, height: target.height)
            }
        }
        settle = work
        DispatchQueue.main.asyncAfter(deadline: .now() + ConchMotion.grow.response + 0.15, execute: work)
    }

    private static func savedDock() -> FloatingPill.Dock {
        guard let data = UserDefaults.standard.data(forKey: FloatingPill.dockKey),
              let dock = try? JSONDecoder().decode(FloatingPill.Dock.self, from: data) else { return FloatingPill.defaultDock }
        return dock
    }

    private func save(_ next: FloatingPill.Dock) {
        dock = next
        if let data = try? JSONEncoder().encode(next) { UserDefaults.standard.set(data, forKey: FloatingPill.dockKey) }
    }

    // MARK: The pointer

    /// The pointer moved over the window (nil: it left). Over the pill, a moment's rest opens it; off it, a moment more
    /// closes it. Over a button, that button lights.
    private func pointer(at point: NSPoint?) {
        guard press == nil else { return }
        let local = point.map { CGPoint(x: $0.x - model.rect.minX, y: $0.y - model.rect.minY) }
        let inside = local.map { CGRect(origin: .zero, size: model.rect.size).contains($0) } ?? false
        let action = model.expanded ? local.flatMap { FloatingPill.action(at: $0, in: model.rect.size, actions: model.face.actions) } : nil
        let hovered: FloatingPillView.Target? = inside ? action.map { .action($0) } ?? .pill : nil
        if hovered != model.hovered { model.hovered = hovered }
        guard inside != pointerInside else { return }
        pointerInside = inside
        hoverTimer?.invalidate()
        let open = inside
        guard open != model.expanded else { return }
        hoverTimer = Timer.scheduledTimer(withTimeInterval: open ? FloatingPill.hoverDelay : FloatingPill.leaveDelay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.setExpanded(open) }
        }
    }

    private func cancelHover() {
        hoverTimer?.invalidate()
        hoverTimer = nil
        pointerInside = false
        model.hovered = nil
    }

    private func setExpanded(_ open: Bool) {
        guard open != model.expanded else { return }
        if open { NSCursor.arrow.set() }
        // The words and buttons cross over as it grows; under Reduce Motion they only fade, and it takes its size at once.
        withAnimation(reduceMotion ? .easeInOut(duration: 0.15) : ConchMotion.grow.animation(reduceMotion: false)) {
            model.expanded = open
        }
        if !open { model.hovered = nil }
        place(animated: true)
    }

    // MARK: Presses

    /// A press in the window: on a button it goes on to SwiftUI; on the pill it is a click or a drag, handled here.
    private func mouse(_ event: NSEvent) -> Bool {
        guard let host else { return false }
        let point = host.topLeft(event.locationInWindow)
        let local = CGPoint(x: point.x - model.rect.minX, y: point.y - model.rect.minY)
        let onPill = CGRect(origin: .zero, size: model.rect.size).contains(local)
        switch event.type {
        case .rightMouseDown:
            guard onPill else { return false }
            showMenu(event)
            return true
        case .leftMouseDown:
            guard onPill else { return false }
            if model.expanded, let action = FloatingPill.action(at: local, in: model.rect.size, actions: model.face.actions) {
                model.pressed = .action(action)
                return false
            }
            guard let frame = pillFrame else { return false }
            press = (NSEvent.mouseLocation, frame, false)
            model.pressed = .pill
            return true
        case .leftMouseDragged:
            guard var current = press else { return false }
            let now = NSEvent.mouseLocation
            let dx = now.x - current.start.x, dy = now.y - current.start.y
            if !current.dragging, hypot(dx, dy) >= FloatingPill.dragThreshold {
                current.dragging = true
                model.pressed = nil
                hoverTimer?.invalidate()
                settle?.cancel()
            }
            press = current
            if current.dragging, let panel {
                let moved = current.frame.offsetBy(dx: dx, dy: dy)
                panel.setFrameOrigin(NSPoint(x: moved.minX - model.rect.minX, y: moved.maxY + model.rect.minY - panel.frame.height))
            }
            return true
        case .leftMouseUp:
            if press == nil {
                model.pressed = nil
                return false
            }
            let ended = press!
            press = nil
            model.pressed = nil
            if ended.dragging {
                drop()
            } else {
                open()
            }
            return true
        default:
            return false
        }
    }

    /// Let go after a drag: docked to the edge it is nearest, on the screen it is over.
    private func drop() {
        guard let frame = pillFrame else { return }
        let centre = NSPoint(x: frame.midX, y: frame.midY)
        let screen = NSScreen.screens.first { $0.frame.contains(centre) } ?? self.screen
        guard let screen else { return }
        save(FloatingPill.dock(droppedAt: frame, in: screen.visibleFrame, display: Self.displayID(of: screen)))
        place(animated: true)
    }

    /// The pill's one obvious thing (`FloatingPill.open`). The only thing here that brings conch forward.
    private func open() {
        guard let store else { return }
        switch FloatingPill.open(input) {
        case let .ready(id): ReviewQueue.shared.open(session: id, store: store)
        case let .session(id): ConchStatusItem.openSession(id)
        case .conch: ConchStatusItem.bringConchForward()
        }
    }

    /// A button: asked of the daemon, as the window's own controls ask it. Talk and the mode leave Tyler where he is.
    private func act(_ action: FloatingPill.Action) {
        guard let store else { return }
        switch action {
        case .talk:
            switch FloatingPill.face(input).talk {
            case .stop:
                store.send(.stop())
            case .talk:
                guard let target = input.talkTarget else { return }
                store.send(.wake(sessionId: target.id, label: target.label))
            case .unavailable:
                break
            }
        case .mode:
            store.send(.global(input.manual ? .resume : .pause))
        }
    }

    /// Right-click: conch's window whatever the pill's click would open, and the one way to put the pill away from where
    /// it is. It comes back from the menu bar menu or Settings.
    private func showMenu(_ event: NSEvent) {
        guard let host else { return }
        let menu = NSMenu()
        let open = NSMenuItem(title: "Open conch", action: #selector(FloatingPillMenuTarget.openConch), keyEquivalent: "")
        let hide = NSMenuItem(title: "Hide Floating Pill", action: #selector(FloatingPillMenuTarget.hide), keyEquivalent: "")
        for item in [open, hide] { item.target = FloatingPillMenuTarget.shared }
        menu.addItem(open)
        menu.addItem(.separator())
        menu.addItem(hide)
        NSMenu.popUpContextMenu(menu, with: event, for: host)
    }

    /// conch's window, on the session the voice is with or last was.
    fileprivate func openConch() {
        if let target = input.talkTarget { ConchStatusItem.openSession(target.id) } else { ConchStatusItem.bringConchForward() }
    }
}

/// The context menu's target: menu items want an Objective-C object.
private final class FloatingPillMenuTarget: NSObject {
    static let shared = FloatingPillMenuTarget()

    @objc func openConch() {
        MainActor.assumeIsolated { FloatingPillController.shared.openConch() }
    }

    @objc func hide() {
        UserDefaults.standard.set(false, forKey: FloatingPill.key)
    }
}
