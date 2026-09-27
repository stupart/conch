import AppKit
import Combine
import ConchDesign
import SwiftUI

/// One input, in one place. Tyler: "Have to make sure only one is in use or active at a time — think of it like: the input
/// box is leaving the Mac app and coming with you — we literally remove it from the Mac app UI until they go back to the app
/// and it swoops back into the UI."
///
/// While conch's window is in front, the composer is in it and the conversation panel has no reply line. When Tyler leaves
/// (conch stops being the app in front, or its window is minimised, hidden, closed or on another space) the composer leaves
/// the window's layout and comes with him: into the panel's reply line when the panel is open, else as the reply line alone,
/// in the panel's corner. Coming back to the window brings it home. Where it is is one value, `place`, from one rule
/// (`ComposerPlacement`), so there is never a second input to type into.
///
/// It travels as one piece of glass (`ComposerSwoop`): a picture of it springs from where it was to where it goes, its
/// corner and chrome morphing from the window's card to the panel's glass, what is on it crossfading from one layout to the
/// other, and then hands off to the live composer there. Nothing it carries is the window's or the panel's: the draft and
/// attachments are the session's (`ComposerDraftStore`), a send in flight too, and the mic is read from the daemon's state.
/// The caret goes with it, and the keyboard comes back to it in the window if it had it when it left. It never takes the
/// keyboard from the app Tyler went to: out of the window it is in a non-activating panel that is never made key but by a
/// click in its field.
@MainActor
final class ComposerDock: ObservableObject {
    static let shared = ComposerDock()

    /// What the window's composer addresses, and whether Tyler picked it there (`WorkspaceModel.viewing`).
    struct Address: Equatable {
        var session: SessionRow.ID?
        var picked: SessionRow.ID?
    }

    /// Where the input is. conch's window lays its composer out only while this is `.window`; the floating composer shows
    /// only while it is `.panel` or `.replyLine`.
    @Published private(set) var place: ComposerPlace = .window
    /// The live input at `place` shows. False while the swoop is still on its way to it: it is laid out there, unseen and
    /// untouchable, for the swoop to land on.
    @Published private(set) var shown = true
    /// Bumped when the input lands back in the window with the keyboard it left with (`SessionComposer.focusRequest`).
    @Published private(set) var focusRequests = 0
    /// How the floating composer lays out, apart from the rest: it changes every frame the panel is dragged or resized,
    /// and conch's window, which watches the dock, must not lay out again with it.
    let layout = ComposerFloatingLayout()

    /// What the window's composer addresses (DashboardView).
    var windowAddress = Address()

    /// Around the floating composer's glass, inside its window: room for the glass's own floating shadow, which a window
    /// cut to the glass would clip. The margin is see-through, so clicks there go to what is under it.
    static let margin = EdgeInsets(top: 20, leading: 28, bottom: 36, trailing: 28)

    private weak var store: StateStore?
    private var panels: FloatingPanels? { FloatingPanels.installed }
    private var dashboard: NSWindow? { ReviewNotifications.shared.reviewWindow }
    /// The window composer's card, while it is laid out (`ComposerCardAnchor`).
    private weak var windowCard: NSView?
    /// Where that card last was on screen: where a swoop back aims until the card is laid out again.
    private var lastWindowCard: NSRect?
    /// conch's window is closing or being minimised: gone, though AppKit still calls it visible for a moment, which is
    /// the moment the input leaves from its card.
    private weak var closing: NSWindow?
    /// conch is being hidden: its windows, the panel's with them, are about to go.
    private var hiding = false
    /// The field goes to the window's composer when it lands there: it had the keyboard where it was.
    private var focusOnArrival = false
    private let floating = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    private let swoop = ComposerSwoop()
    /// The floating composer's height as it last laid out.
    private var floatingHeight: CGFloat = 80
    private var observers: [NSObjectProtocol] = []
    private var subscriptions: Set<AnyCancellable> = []
    /// Something the input opened is up (its file picker): it stays where it is.
    private var holds = 0
    private var holdUntil: TimeInterval = 0
    /// The field had the keyboard where the input last was: it takes it again when it lands in the window.
    private var wantsFocus = false
    /// The selection it carries.
    private var caret: NSRange?
    private var installed = false

    private init() {}

    // MARK: Setting up

    /// After the panels and the canvas, whose windows it rides over.
    func install(store: StateStore) {
        guard !installed else { return }
        installed = true
        self.store = store

        floating.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        floating.isExcludedFromWindowsMenu = true
        // conch is almost never the app in front while this shows, and hiding conch takes the input with Tyler rather
        // than away from him.
        floating.hidesOnDeactivate = false
        floating.canHide = false
        floating.isReleasedWhenClosed = false
        floating.backgroundColor = .clear
        floating.isOpaque = false
        // The glass draws its own floating shadow, the one the swoop draws, inside the margin.
        floating.hasShadow = false
        // Key only when its field is clicked (`pressed`); never on arriving.
        floating.takesKeys = true
        floating.becomesKeyOnlyIfNeeded = true
        floating.title = "Reply"
        floating.onKey = { [weak self] event in MainActor.assumeIsolated { self?.key(event) ?? false } }
        floating.onPress = { [weak self] event in MainActor.assumeIsolated { self?.pressed(event) } }
        let host = FirstClickHostingView(rootView: ComposerFloatingHost(store: store, dock: self, layout: layout))
        // Only `follow` sizes and places it.
        host.sizingOptions = []
        floating.contentView = host

        swoop.onArrived = { [weak self] place in self?.arrived(at: place) }

        let center = NotificationCenter.default
        let app: [Notification.Name] = [
            NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification,
            NSApplication.willHideNotification, NSApplication.didHideNotification, NSApplication.didUnhideNotification,
            NSApplication.didChangeScreenParametersNotification,
        ]
        for name in app {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                MainActor.assumeIsolated {
                    // Hiding takes the windows away after this: the input leaves from where it is while it still is.
                    if note.name == NSApplication.willHideNotification { self?.hiding = true }
                    if note.name == NSApplication.didUnhideNotification { self?.hiding = false }
                    self?.update()
                }
            })
        }
        // conch's own window: minimised, back, closing, or a new one made key.
        let window: [Notification.Name] = [
            NSWindow.willMiniaturizeNotification, NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification,
            NSWindow.willCloseNotification,
            NSWindow.didBecomeKeyNotification, NSWindow.didChangeOcclusionStateNotification, NSWindow.didMoveNotification,
        ]
        for name in window {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                MainActor.assumeIsolated { self?.windowChanged(note) }
            })
        }
        // A full-screen space, or any other, coming forward.
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.update() }
        })
        // The menu's Conversation Panel, Reply Line and With Panel Off.
        observers.append(center.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.update() }
        })
        if let panels {
            // The panel folding, filling the screen, moving or growing: where its room is, and whether it has one.
            panels.objectWillChange
                .receive(on: RunLoop.main)
                .sink { [weak self] _ in MainActor.assumeIsolated { self?.update() } }
                .store(in: &subscriptions)
            // Another session in the panel: the floating composer is that session's.
            panels.$staged
                .receive(on: RunLoop.main)
                .sink { [weak self] _ in MainActor.assumeIsolated { self?.layout.objectWillChange.send() } }
                .store(in: &subscriptions)
        }
        // The pen down: over the canvas's glass with the panel.
        CanvasController.shared.$armed
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.follow() } }
            .store(in: &subscriptions)
        update()
    }

    // MARK: Where it is

    /// What decides it, as things stand.
    private var situation: ComposerSituation {
        let defaults = UserDefaults.standard
        let window = dashboard
        let windowShown = window.map { $0 !== closing && $0.isVisible && !$0.isMiniaturized && $0.isOnActiveSpace } == true && !NSApp.isHidden && !hiding
        let panel: ComposerSituation.Panel
        // Hidden with conch, the panel goes too; the input, which conch never hides, stays with Tyler alone.
        if !defaults.bool(forKey: ConchStatusItem.showConversationKey) || panels?.isOnScreen != true || hiding {
            panel = .off
        } else if panels?.isCollapsed == true {
            panel = .collapsed
        } else {
            panel = .open
        }
        return ComposerSituation(
            appActive: NSApp.isActive,
            windowShown: windowShown,
            panel: panel,
            replyLine: defaults.bool(forKey: ConchStatusItem.showReplyLineKey),
            withPanelOff: defaults.bool(forKey: ConchStatusItem.replyLineAloneKey),
            held: holds > 0 || NSApp.modalWindow != nil || ProcessInfo.processInfo.systemUptime < holdUntil
        )
    }

    /// Where it should be now; there if it is not.
    func update() {
        guard installed else { return }
        let next = ComposerPlacement.place(situation, current: place)
        guard next != place else { return follow() }
        move(to: next)
    }

    /// A file picker from the composer is up: the input stays where it is (`ComposerView.chooseFiles`).
    func hold() { holds += 1 }

    /// The picker has gone. From the panel it brought conch forward, so the app Tyler was in gets the front back, and the
    /// input stays put the moment that takes.
    func release(handingBackTo app: NSRunningApplication?) {
        holds = max(0, holds - 1)
        guard let app, app != .current else { return update() }
        holdUntil = ProcessInfo.processInfo.systemUptime + 0.6
        app.activate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.65) { [weak self] in self?.update() }
    }

    private func windowChanged(_ note: Notification) {
        guard let window = note.object as? NSWindow else { return }
        if window === floating {
            // Clicked into: its field has the keyboard, and takes it home with it.
            if note.name == NSWindow.didBecomeKeyNotification { wantsFocus = true }
            return
        }
        guard window === dashboard || (note.name == NSWindow.didBecomeKeyNotification && window.canBecomeMain) else { return }
        switch note.name {
        case NSWindow.willCloseNotification, NSWindow.willMiniaturizeNotification: closing = window
        case NSWindow.didBecomeKeyNotification, NSWindow.didDeminiaturizeNotification: if closing === window { closing = nil }
        case NSWindow.didMoveNotification: if let card = windowCard { windowCardMoved(card) }
        default: break
        }
        update()
    }

    /// The input goes from where it is to `next`: taking the conversation it is in, its caret and its keyboard, and
    /// swooping there as one piece of glass. A new place mid-flight bends the flight already going rather than starting
    /// another.
    private func move(to next: ComposerPlace) {
        let from = place
        let row = carry(from: from, to: next)
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let dark = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua

        // Where it is now: the glass in flight if it is flying, else the live input where it was.
        let source = swoop.flight?.current ?? shape(of: from)
        let covered = from == .window && sourceUnseen()
        let sourceFace = swoop.isFlying ? nil : face(of: row, width: source?.rect.width, dark: dark)

        // It leaves at once: out of the window's layout, or out of the panel's room.
        place = next
        shown = false
        if from.floats { floating.orderOut(nil) }
        follow()

        let target = shape(of: next)
        let targetFace = face(of: row, width: target?.rect.width, dark: dark)
        if swoop.isFlying {
            if let target {
                swoop.retarget(to: next, at: target, face: targetFace)
            } else if let current = swoop.flight?.current {
                swoop.retarget(to: .none, at: current.scaled(ConchMotion.appearScale), face: nil)
                showWithoutLanding(next)
            }
            return
        }
        var faces: [ComposerPlace: CGImage] = [:]
        faces[from] = sourceFace
        faces[next] = targetFace
        switch (source, target) {
        case let (source?, target?):
            swoop.fly(ComposerFlight(from: from, at: source, to: next, at: target, emerges: covered, reduceMotion: reduceMotion), faces: faces, dark: dark)
        case let (nil, target?):
            // Nowhere to come from (the window gone, or nothing laid out yet): it appears where it goes, from a touch small.
            swoop.fly(ComposerFlight(from: .none, at: target.scaled(ConchMotion.appearScale), to: next, at: target, emerges: true, reduceMotion: reduceMotion), faces: faces, dark: dark)
        case let (source?, nil):
            // Nowhere to land that is laid out: it leaves, to a touch small, and the input is at its place as soon as
            // that place is.
            swoop.fly(ComposerFlight(from: from, at: source, to: .none, at: source.scaled(ConchMotion.appearScale), reduceMotion: reduceMotion), faces: faces, dark: dark)
            showWithoutLanding(next)
        case (nil, nil):
            arrived(at: next)
        }
    }

    /// No glass will land at `place`: the live input there shows as soon as it is laid out, rather than waiting unseen for
    /// a swoop that is not coming.
    private func showWithoutLanding(_ place: ComposerPlace) {
        guard place != .none else { return }
        arrived(at: place)
    }

    /// The live input where the swoop has come to rest: shown, and given the caret it carried; home in the window with the
    /// keyboard it left with, unless something else there has taken it since.
    private func arrived(at arrival: ComposerPlace) {
        guard arrival == place else { return }
        shown = true
        follow()
        let field = field(at: place)
        if place == .window, focusOnArrival, let field, let window = field.window, window.firstResponder !== field {
            // Unless a click has since given the keyboard to another field there.
            if !((window.firstResponder as? NSTextView)?.isEditable ?? false) { window.makeFirstResponder(field) }
        }
        focusOnArrival = false
        if let caret, let field, NSMaxRange(caret) <= (field.string as NSString).length {
            field.setSelectedRange(caret)
        }
    }

    /// What goes with the input: the conversation it is in, and its keyboard and caret. Leaving the window with a session
    /// Tyler picked there, the panel goes to it, unless the canvas holds marks a new item would clear; coming back from the
    /// panel, the window goes to the panel's. The session whose composer it is, for the swoop's pictures.
    private func carry(from: ComposerPlace, to: ComposerPlace) -> SessionRow? {
        let field = field(at: from)
        if let field {
            caret = field.selectedRange()
            if from == .window { wantsFocus = field.window?.firstResponder === field }
        }
        guard let store, let panels else { return nil }
        if from == .window, to.floats {
            if let picked = windowAddress.picked, picked == windowAddress.session, panels.session?.id != picked,
               CanvasController.shared.document?.has(.you) != true {
                panels.staged = picked
            }
            return store.state?.row(windowAddress.session) ?? panels.session
        }
        if from.floats, to == .window {
            let session = panels.session
            if let session, session.parentSessionId == nil, session.id != windowAddress.session {
                // As a click on its row does: the window shows the conversation the input comes back from.
                NotificationCenter.default.post(name: .selectSessionFromStatusItem, object: session.id)
            }
            if wantsFocus {
                focusOnArrival = true
                requestFocusOnLanding()
            }
            return session
        }
        return panels.session
    }

    /// The window's composer is laid out again, unseen, as the swoop sets off: the keyboard goes to it now, so nothing typed
    /// on the way is lost, unless a click has since given it to another field.
    private func requestFocusOnLanding() {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.place == .window, let window = self.dashboard else { return }
            if let other = window.firstResponder as? NSTextView, other.isEditable { return }
            self.focusRequests += 1
        }
    }

    // MARK: The floating composer

    /// The session the floating composer is: the panel's, by the panel's one rule (`FloatingPanels.session`). Never a
    /// subagent, which has no composer of its own.
    func floatingRow(_ state: PublishedState?) -> SessionRow? {
        guard let row = panels?.session, row.parentSessionId == nil else { return nil }
        return state?.row(row.id) ?? row
    }

    /// Typing in the floating composer claims its session, as typing in the window pins the pane: the panel stays on it
    /// whatever the voice does. Not over marks on the canvas, which a new item in the panel would clear.
    func claim(_ row: SessionRow) {
        guard let panels, panels.staged != row.id, CanvasController.shared.document?.has(.you) != true else { return }
        panels.staged = row.id
    }

    /// Sent from the panel's reply line: it flies into the panel's words, and comes back out of them if it didn't go.
    func sent(_ text: String, _ delivery: Task<Bool, Never>) {
        guard place == .panel, let fog = panels?.text else { return }
        fog.send(text)
        Task {
            guard !(await delivery.value) else { return }
            fog.sendFailed()
        }
    }

    /// The floating composer laid itself out this tall.
    func floatingLaidOut(height: CGFloat) {
        guard abs(height - floatingHeight) > 0.5 else { return }
        floatingHeight = height
        follow()
    }

    /// The floating composer where its place is: the panel's room, which it holds open, or the reply line alone in the
    /// panel's corner; over the canvas's glass while the pen is down, as the docked panel is; faint with the panel mid-throw
    /// and gone while the panel morphs. A flight on its way there aims at where it now is.
    func follow() {
        guard installed else { return }
        panels?.holdReply(place == .panel ? floatingHeight : 0)
        guard let card = floatingCard(for: place) else {
            if floating.isVisible { floating.orderOut(nil) }
            return
        }
        if abs(card.width - layout.width) > 0.5 { layout.width = card.width }
        let down = place == .panel ? panelGrowsDown : !(panels?.corner.bottom ?? true)
        if down != layout.growsDown { layout.growsDown = down }
        let margin = Self.margin
        let frame = NSRect(x: card.minX - margin.leading, y: card.minY - margin.bottom, width: card.width + margin.leading + margin.trailing, height: card.height + margin.top + margin.bottom)
        if floating.frame != frame { floating.setFrame(frame, display: true) }
        let level = level(for: place)
        if floating.level != level { floating.level = level }
        if shown {
            let alpha = place == .panel ? ((panels?.wordsShown ?? true) ? (panels?.alpha ?? 1) : 0) : 1
            if !floating.isVisible {
                // The glass has just handed off to it here: straight in at the panel's own opacity, not faded in again.
                floating.alphaValue = alpha
                floating.orderFrontRegardless()
            }
            if abs(floating.alphaValue - alpha) > 0.01 {
                // With the panel's words as they step aside and come back; with its throw frame by frame.
                if panels?.wordsShown == false || floating.alphaValue < 0.05 {
                    NSAnimationContext.runAnimationGroup { context in
                        context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : ConchMotion.quick
                        floating.animator().alphaValue = alpha
                    }
                } else {
                    floating.alphaValue = alpha
                }
            }
        } else if swoop.flight?.to == place {
            swoop.follow(.floating(card))
        }
    }

    /// The glass's rect out of the window, on screen: the panel's room for the composer's height, or the reply line alone.
    private func floatingCard(for place: ComposerPlace) -> NSRect? {
        switch place {
        case .panel:
            return panels?.replySlot(height: floatingHeight)
        case .replyLine:
            guard let screen = panels?.screenForReply ?? NSScreen.main else { return nil }
            let visible = screen.visibleFrame
            let width = ComposerDockGeometry.replyLineWidth(measure: ConversationTextView.composerMeasure, in: visible)
            let besideHandle = panels?.isCollapsed == true && panels?.isOnScreen == true
            return ComposerDockGeometry.replyLineFrame(size: CGSize(width: width, height: floatingHeight), corner: panels?.corner ?? .bottomLeading, in: visible, besideHandle: besideHandle)
        case .window, .none:
            return nil
        }
    }

    /// In the panel's room, it hangs from the top when the panel does.
    private var panelGrowsDown: Bool {
        guard let panels else { return false }
        return ConversationFog.newestAtTop(corner: panels.corner, fullScreen: panels.isFullScreen) && !(panels.isFullScreen && panels.contentShown)
    }

    /// Always just over what it sits on: the panel, which rises over the canvas's glass while the pen is down and it is
    /// docked; alone, over the glass too while the pen is down.
    private func level(for place: ComposerPlace) -> NSWindow.Level {
        if place == .panel, let panels { return NSWindow.Level(rawValue: panels.level.rawValue + 1) }
        return CanvasController.shared.armed
            ? NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 2)
            : NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
    }

    /// A first click on the floating composer's field places the cursor: conch never comes forward to be clicked into
    /// first, so the field's window takes the keys and the click goes on to it. Only the field: a click on the mic or send
    /// acts and leaves the keys where they were. The one way it becomes key.
    private func pressed(_ event: NSEvent) {
        guard !floating.isKeyWindow, let hit = floating.contentView?.hitTest(event.locationInWindow), Self.isField(hit) else { return }
        floating.makeKey()
    }

    private static func isField(_ view: NSView) -> Bool {
        var each: NSView? = view
        while let view = each {
            if let text = view as? NSTextView { return text.isEditable }
            if let scroll = view as? NSScrollView, let text = scroll.documentView as? NSTextView { return text.isEditable }
            each = view.superview
        }
        return false
    }

    /// The floating composer's own keys: in the panel, the panel's (⌘↩ full screen and the rest, `replyKey`) before the
    /// field sees them, which would send on ⌘↩. Esc lets go of the field: docked or alone, the keys go back to the app in
    /// front; full screen, to the panel, which is what is on screen then.
    private func key(_ event: NSEvent) -> Bool {
        if place == .panel, panels?.replyKey(event) == true { return true }
        guard event.keyCode == 53, floating.firstResponder is NSTextView else { return false }
        floating.makeFirstResponder(nil)
        wantsFocus = false
        if place == .panel, panels?.isFullScreen == true {
            panels?.takeKeysBack()
        } else {
            // A non-activating panel gives up the keyboard by leaving the screen: out and straight back in, the
            // canvas's and the panel's way. conch is never activated.
            floating.orderOut(nil)
            floating.orderFrontRegardless()
        }
        return true
    }

    // MARK: The window's card

    /// The window composer's card, laid out or gone (`ComposerCardAnchor`).
    func windowCard(_ view: NSView, laidOut: Bool) {
        if laidOut {
            windowCard = view
            windowCardMoved(view)
        } else if windowCard === view {
            windowCard = nil
        }
    }

    /// The card moved or changed size: remembered, and a swoop on its way to it aims at where it now is.
    func windowCardMoved(_ view: NSView) {
        guard view === windowCard, let rect = screenRect(of: view) else { return }
        lastWindowCard = rect
        if swoop.flight?.to == .window, !shown { swoop.follow(.window(rect)) }
    }

    private func screenRect(of view: NSView) -> NSRect? {
        guard let window = view.window, view.bounds.width > 1 else { return nil }
        return window.convertToScreen(view.convert(view.bounds, to: nil))
    }

    // MARK: Shapes, pictures and fields

    /// The input's glass at a place, on screen: the window's card as laid out (or where it last was), or the floating one's.
    private func shape(of place: ComposerPlace) -> ComposerFlight.Shape? {
        switch place {
        case .window:
            // Laid out: where it is, even as its window goes (closing, minimising, hiding, another space).
            if let rect = windowCard.flatMap(screenRect(of:)) { return .window(rect) }
            guard let window = dashboard, window.isVisible, !window.isMiniaturized else { return nil }
            // Not laid out yet: where it last was, else where the window keeps it, at its foot. The card's own report
            // corrects the flight the moment it is laid out (`windowCardMoved`).
            if let lastWindowCard, window.frame.contains(lastWindowCard) { return .window(lastWindowCard) }
            let width = min(ConversationTextView.composerMeasure, max(0, window.frame.width - 32))
            return .window(NSRect(x: window.frame.midX - width / 2, y: window.frame.minY + 14, width: width, height: floatingHeight))
        case .panel, .replyLine:
            return floatingCard(for: place).map { .floating($0) }
        case .none:
            return nil
        }
    }

    /// The window's card is out of sight as the input leaves it: minimised, on a space no longer in front, or with another
    /// app's window over it now. Then the glass fades in as it leaves rather than appearing on top of that app.
    private func sourceUnseen() -> Bool {
        guard let window = dashboard else { return true }
        if window.isMiniaturized || !window.isOnActiveSpace { return true }
        guard let rect = windowCard.flatMap(screenRect(of:)) ?? lastWindowCard else { return true }
        return Self.covered(rect, above: window)
    }

    /// Another app's window lies over `rect` in front of `window`. Bounds only, which need no Screen Recording grant.
    private static func covered(_ rect: NSRect, above window: NSWindow) -> Bool {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow, .excludeDesktopElements], CGWindowID(window.windowNumber)) as? [[String: Any]],
              let primary = NSScreen.screens.first?.frame else { return false }
        // Core Graphics counts from the top of the main display, down.
        let flipped = CGRect(x: rect.minX, y: primary.maxY - rect.maxY, width: rect.width, height: rect.height)
        let mine = ProcessInfo.processInfo.processIdentifier
        return list.contains { info in
            guard (info[kCGWindowOwnerPID as String] as? Int32) != mine,
                  (info[kCGWindowLayer as String] as? Int) == 0,
                  let bounds = info[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: bounds) else { return false }
            return frame.intersects(flipped)
        }
    }

    /// A picture of the composer for the swoop: bare, only what is on the glass, at the width it has there, drawn the way
    /// the live one is (`ComposerView`'s static face). The same view, so the picture and the live input cannot disagree.
    private func face(of row: SessionRow?, width: CGFloat?, dark: Bool) -> CGImage? {
        guard let row, let store, let width, width > 1 else { return nil }
        let picture = SessionComposer(row: row, state: store.state, store: store, chrome: .bare, onDraftStarted: {})
            .frame(width: width)
            .fixedSize(horizontal: false, vertical: true)
            .environment(\.conchRendersStatically, true)
            .environment(\.colorScheme, dark ? .dark : .light)
        let renderer = ImageRenderer(content: picture)
        // One scale for every picture, so the swoop can cut them in points (`SwoopFace`).
        renderer.scale = SwoopFace.scale
        var image: CGImage?
        // The palette resolves against the drawing appearance, which a picture drawn off screen does not inherit.
        (NSAppearance(named: dark ? .darkAqua : .aqua) ?? NSApp.effectiveAppearance).performAsCurrentDrawingAppearance {
            image = renderer.cgImage
        }
        return image
    }

    /// The composer's own editor at a place: in the window, the editable text view nearest its card; floating, the one in
    /// its window.
    private func field(at place: ComposerPlace) -> NSTextView? {
        switch place {
        case .window:
            var ancestor = windowCard?.superview
            while let next = ancestor {
                if let found = Self.editable(in: next) { return found }
                if next === next.window?.contentView { return nil }
                ancestor = next.superview
            }
            return nil
        case .panel, .replyLine:
            return floating.contentView.flatMap(Self.editable(in:))
        case .none:
            return nil
        }
    }

    private static func editable(in view: NSView) -> NSTextView? {
        if let text = view as? NSTextView, text.isEditable { return text }
        for child in view.subviews {
            if let found = editable(in: child) { return found }
        }
        return nil
    }
}

/// How the floating composer lays out (`ComposerDock.follow`).
@MainActor
final class ComposerFloatingLayout: ObservableObject {
    /// The panel's column, or the window composer's measure alone.
    @Published var width: CGFloat = ConversationTextView.composerMeasure
    /// It grows down from a top edge rather than up from a bottom one: the panel hangs from a top corner.
    @Published var growsDown = false
}

/// The floating composer: the session's composer (`SessionComposer`), wearing the panel's glass, at the width its place
/// gives it and as tall as it lays out, against the edge it grows away from.
private struct ComposerFloatingHost: View {
    @ObservedObject var store: StateStore
    @ObservedObject var dock: ComposerDock
    @ObservedObject var layout: ComposerFloatingLayout

    var body: some View {
        Group {
            // Only while the input is out of the window: in it, this composer is not built at all, so there is only ever
            // one to type into.
            if dock.place.floats, let row = dock.floatingRow(store.state) {
                SessionComposer(
                    row: row,
                    state: store.state,
                    store: store,
                    chrome: .panel,
                    onDraftStarted: { dock.claim(row) },
                    onSent: { dock.sent($0, $1) }
                )
                .frame(width: layout.width)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { dock.floatingLaidOut(height: $0) }
            }
        }
        .padding(ComposerDock.margin)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: layout.growsDown ? .top : .bottom)
    }
}

// MARK: - The swoop

/// The input's glass in flight between windows (`ComposerFlight`), drawn by Core Animation in a clear, click-through panel
/// over each display it crosses, so it travels between displays as one piece rather than being cut at an edge. It steps on
/// the display's own frames, never takes the pointer or the keys, and is gone the moment it lands.
@MainActor
final class ComposerSwoop {
    private(set) var flight: ComposerFlight?
    var isFlying: Bool { flight != nil }
    /// The live input shows under the glass from here, which then hands off to it.
    var onArrived: (ComposerPlace) -> Void = { _ in }

    /// The pictures of the composer, by the place each is the look of, cut where the composer's layout cuts.
    private var faces: [ComposerPlace: SwoopFace] = [:]
    private var dark = false
    private var told = false
    private var screens: [(frame: NSRect, panel: FloatingPanel, view: SwoopView)] = []
    private var lastFrame: CFTimeInterval = 0

    func fly(_ next: ComposerFlight, faces: [ComposerPlace: CGImage], dark: Bool) {
        flight = next
        self.faces = faces.compactMapValues(SwoopFace.init)
        self.dark = dark
        told = false
        build()
        render()
        for screen in screens { screen.panel.orderFrontRegardless() }
        run(true)
    }

    /// Somewhere new, from where the glass is and as fast as it is going; never a second flight.
    func retarget(to place: ComposerPlace, at shape: ComposerFlight.Shape, face: CGImage?) {
        guard var current = flight else { return }
        current.retarget(to: place, at: shape)
        flight = current
        if let face = face.flatMap(SwoopFace.init) { faces[place] = face }
        told = false
        run(true)
    }

    /// Where it is going moved.
    func follow(_ shape: ComposerFlight.Shape) {
        flight?.follow(shape)
    }

    /// A clear panel over each display, above conch's own and the canvas's, never taking a click. Made again only when the
    /// displays changed.
    private func build() {
        let frames = NSScreen.screens.map(\.frame)
        guard frames != screens.map(\.frame) else { return }
        for screen in screens {
            screen.view.stop()
            screen.panel.orderOut(nil)
        }
        screens = frames.map { frame in
            let panel = FloatingPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.setFrame(frame, display: false)
            panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 3)
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .transient]
            panel.isExcludedFromWindowsMenu = true
            panel.hidesOnDeactivate = false
            panel.canHide = false
            panel.isReleasedWhenClosed = false
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = false
            panel.ignoresMouseEvents = true
            let view = SwoopView(frame: NSRect(origin: .zero, size: frame.size))
            view.step = { [weak self] link in self?.step(link) }
            panel.contentView = view
            return (frame, panel, view)
        }
    }

    private func run(_ on: Bool) {
        guard let view = screens.first?.view else { return }
        lastFrame = 0
        view.run(on)
    }

    private func step(_ link: CADisplayLink) {
        // The real time since the last frame; the first counts as one at 120 Hz, and a stall never makes a jump.
        let dt = lastFrame > 0 ? min(link.timestamp - lastFrame, 0.05) : 1.0 / 120
        lastFrame = link.timestamp
        guard var current = flight else { return finish() }
        let done = current.step(dt: dt)
        flight = current
        if current.arrived, !told {
            told = true
            onArrived(current.to)
        }
        render()
        if done { finish() }
    }

    private func finish() {
        flight = nil
        run(false)
        for screen in screens {
            screen.view.draw([], faces: (nil, nil), origin: screen.frame.origin, dark: dark)
            screen.panel.orderOut(nil)
        }
    }

    private func render() {
        guard let flight else { return }
        let cards = flight.cards
        for screen in screens {
            screen.view.draw(cards, faces: (faces[flight.from], faces[flight.to]), origin: screen.frame.origin, dark: dark)
        }
    }
}

/// One display's share of the swoop: each card as layers, its shadow, its glass, and the two pictures crossfading on it.
private final class SwoopView: NSView {
    var step: (CADisplayLink) -> Void = { _ in }
    private var cards: [SwoopCard] = []
    private lazy var link: CADisplayLink = {
        let link = displayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        return link
    }()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .never
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func run(_ on: Bool) {
        guard on == link.isPaused else { return }
        link.isPaused = !on
    }

    /// Its display went: the link, which holds this view, lets it go.
    func stop() {
        link.invalidate()
    }

    @objc private func tick(_ link: CADisplayLink) { step(link) }

    func draw(_ next: [ComposerFlight.Card], faces: (leaving: SwoopFace?, arriving: SwoopFace?), origin: CGPoint, dark: Bool) {
        guard let root = layer else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        while cards.count < next.count { cards.append(SwoopCard(in: root)) }
        for (index, card) in cards.enumerated() {
            if index < next.count {
                card.show(next[index], faces: faces, origin: origin, dark: dark)
            } else {
                card.hide()
            }
        }
        CATransaction.commit()
    }
}

/// A picture of the composer for the swoop, cut once into the pieces its layout moves as (`ComposerFlight.slices`): the
/// field, and the bar's two clusters.
struct SwoopFace {
    /// Every picture is drawn at this scale, so a piece's size in points is known.
    static let scale: CGFloat = 2
    let size: CGSize
    let pieces: [CGImage]

    init?(_ image: CGImage) {
        let size = CGSize(width: CGFloat(image.width) / Self.scale, height: CGFloat(image.height) / Self.scale)
        let pieces = ComposerFlight.slices(picture: size, in: size).compactMap { slice in
            // CGImage counts from its top left, in pixels.
            image.cropping(to: CGRect(x: slice.from.minX * Self.scale, y: slice.from.minY * Self.scale, width: slice.from.width * Self.scale, height: slice.from.height * Self.scale).integral)
        }
        guard !pieces.isEmpty else { return nil }
        self.size = size
        self.pieces = pieces
    }
}

/// A card's layers: the shadow under it, the glass, and on the glass the look it left and the look it lands as, each in
/// the pieces its layout moves as, placed at their own size and never scaled, crossfaded, clipped to the glass's corner.
private final class SwoopCard {
    private let shadow = CALayer()
    private let glass = CALayer()
    private let leaving = SwoopPicture()
    private let arriving = SwoopPicture()

    init(in root: CALayer) {
        shadow.shadowColor = NSColor.black.cgColor
        // The glass and what is on it fade as one: faded apart, the glass's fill veiled its own words, which greyed them
        // over the live composer at the hand-off.
        glass.allowsGroupOpacity = true
        glass.masksToBounds = true
        glass.cornerCurve = .continuous
        glass.borderWidth = 0.5
        glass.addSublayer(leaving.layer)
        glass.addSublayer(arriving.layer)
        root.addSublayer(shadow)
        root.addSublayer(glass)
    }

    func show(_ card: ComposerFlight.Card, faces: (leaving: SwoopFace?, arriving: SwoopFace?), origin: CGPoint, dark: Bool) {
        let rect = card.shape.rect.offsetBy(dx: -origin.x, dy: -origin.y)
        let look = ComposerGlass(chrome: card.shape.chrome, lift: card.lift, dark: dark)
        let radius = min(card.shape.radius, min(rect.width, rect.height) / 2)
        glass.isHidden = false
        shadow.isHidden = false
        glass.frame = rect
        glass.cornerRadius = radius
        glass.backgroundColor = Self.cgColor(look.fill)
        glass.borderColor = Self.cgColor(look.line)
        glass.opacity = Float(card.opacity)
        shadow.frame = rect
        shadow.shadowPath = CGPath(roundedRect: CGRect(origin: .zero, size: rect.size), cornerWidth: radius, cornerHeight: radius, transform: nil)
        shadow.shadowOpacity = Float(look.shadowOpacity * card.opacity)
        shadow.shadowRadius = look.shadowRadius
        // Down the screen, which is y up.
        shadow.shadowOffset = CGSize(width: 0, height: -look.shadowY)
        leaving.show(faces.leaving, on: rect.size, opacity: card.leaving)
        arriving.show(faces.arriving, on: rect.size, opacity: card.arriving)
    }

    func hide() {
        glass.isHidden = true
        shadow.isHidden = true
    }

    private static func cgColor(_ rgba: SIMD4<Double>) -> CGColor {
        CGColor(srgbRed: rgba.x, green: rgba.y, blue: rgba.z, alpha: rgba.w)
    }
}

/// One look on the glass: its pieces where the composer's layout puts them on glass of this size.
private final class SwoopPicture {
    let layer = CALayer()
    private var pieces: [CALayer] = []

    func show(_ face: SwoopFace?, on size: CGSize, opacity: CGFloat) {
        layer.frame = CGRect(origin: .zero, size: size)
        guard let face, opacity > 0.001 else {
            layer.opacity = 0
            return
        }
        layer.opacity = Float(opacity)
        let slices = ComposerFlight.slices(picture: face.size, in: size)
        while pieces.count < face.pieces.count {
            let piece = CALayer()
            piece.contentsScale = SwoopFace.scale
            layer.addSublayer(piece)
            pieces.append(piece)
        }
        for (index, piece) in pieces.enumerated() {
            guard index < face.pieces.count, index < slices.count else {
                piece.isHidden = true
                continue
            }
            let to = slices[index].to
            piece.isHidden = false
            if (piece.contents as AnyObject?) !== face.pieces[index] { piece.contents = face.pieces[index] }
            // The slices count from the top; the layer from the bottom.
            piece.frame = CGRect(x: to.minX, y: size.height - to.maxY, width: to.width, height: to.height)
        }
    }
}
