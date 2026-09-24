import AppKit
import Carbon
import Combine
import ConchDesign
import SwiftUI

/// The canvas (wave 2). Tyler: "transparent canvas that both the ai and the user can write to over top of what they're
/// looking at ... can navigate to next agent/content and give new clear canvas"; "canvas is a clear window that shows over
/// the other stuff and only activates when u have like your 'canvas open' or pen open ... changes pointer event to click
/// through or not". The research it follows is ~/Projects/conch-design/canvas-research-2026-09-25.md.
///
/// A clear glass panel on each display, over everything but menus and system alerts, that lets every click through until
/// the pen is down; a small pill of tools beside the conversation panel; and one `CanvasDocument` whose marks both are
/// drawn from. States: off; armed (the pen is down: the glass takes the pointer and the keys and draws); up with ink
/// left (the glass lets clicks through again, the ink and the tools stay); sending (`CanvasSend.swift`). Esc lifts the pen
/// and keeps the ink; Esc again clears it. A new item in the panel — Next, the Ready pill, the switcher — starts a clear
/// canvas. An agent's marks on the review in front (`AgentInkController.swift`) are in the same document, drawn under Tyler's; they
/// never put the pen down.
@MainActor
final class CanvasController: ObservableObject {
    static let shared = CanvasController()

    /// The pen is down.
    @Published private(set) var armed = false
    /// Send is capturing and packing: the glass lets clicks through, so the Screen Recording prompt can be answered.
    @Published var sending = false
    @Published private(set) var tool: CanvasMark.Kind = .pen
    /// The marks and what they are over; nil with nothing drawn.
    @Published private(set) var document: CanvasDocument?
    /// Why Send didn't go, on the pill until the next thing happens.
    @Published var message: String?
    /// Whose the agent's marks are, for their labels ("Claude · …").
    private var agentName = "Claude"
    /// The agent's marks, faded while what they are on moves under them (`AgentInkController`).
    private var agentHidden = false
    /// Show: the screen being recorded, or stopped and waiting for Send or Esc (`CanvasShow.swift`).
    @Published var recorder: CanvasRecorder?

    /// In use: the pen is down, ink is showing, or there is a Show. The glass and the pill show only then.
    var inUse: Bool { armed || document?.isEmpty == false || recorder != nil }

    private(set) weak var store: StateStore?
    /// Each display's glass.
    private var glass: [(panel: FloatingPanel, ink: CanvasInkView)] = []
    /// The tools: their own panel, above the glass, that always takes clicks.
    private let pill = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    private var pillSize = CGSize.zero
    /// Hiding waits for the ink to lift away and the pill to sink; a newer change cancels it.
    private var hiding: Task<Void, Never>?
    private var subscriptions: Set<AnyCancellable> = []
    private var observers: [NSObjectProtocol] = []

    func install(store: StateStore) {
        guard self.store == nil else { return }
        self.store = store
        pill.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        pill.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .transient]
        pill.isExcludedFromWindowsMenu = true
        pill.hidesOnDeactivate = false
        pill.isReleasedWhenClosed = false
        pill.backgroundColor = .clear
        pill.isOpaque = false
        pill.hasShadow = false
        pill.contentView = FirstClickHostingView(rootView: CanvasPillHost(canvas: self, store: store) { [weak self] size in self?.placePill(size: size) })
        buildGlass()

        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.buildGlass() }
        })
        // A full-screen space coming forward: the glass goes back on top of it.
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.apply() }
        })
        if let panels = FloatingPanels.installed {
            // A new item in the panel, however it came (the Ready pill, Next and Previous, the switcher): a clear canvas.
            panels.$staged.combineLatest(panels.queue.$lastStaged)
                .dropFirst()
                .removeDuplicates { $0.0 == $1.0 && $0.1 == $1.1 }
                .sink { [weak self] _ in MainActor.assumeIsolated { self?.clear() } }
                .store(in: &subscriptions)
            // The tools ride on the panel's top edge, wherever it goes.
            panels.objectWillChange
                .receive(on: RunLoop.main)
                .sink { [weak self] _ in MainActor.assumeIsolated { if self?.inUse == true { self?.placePill() } } }
                .store(in: &subscriptions)
        }
        CanvasHotKey.register()
        // An agent's marks on what it published, in this same document.
        AgentInkController.shared.install(store: store)
    }

    // MARK: The pen

    /// The pen button, the menu's Canvas and the hotkey.
    func toggle() {
        armed ? lift() : arm()
    }

    /// The pen down: the glass takes the pointer, and the one under the pointer the keys, without bringing conch forward.
    func arm() {
        guard !armed, !sending, store != nil else { return }
        message = nil
        armed = true
        apply()
        let pointer = NSEvent.mouseLocation
        guard let under = glass.first(where: { $0.panel.frame.contains(pointer) }) ?? glass.first else { return }
        under.panel.makeKey()
        under.panel.makeFirstResponder(under.ink)
    }

    /// The pen up. The ink stays, and every click goes through to what is under it again.
    func lift() {
        guard armed else { return }
        armed = false
        if document?.isEmpty == true { document = nil }
        apply()
    }

    /// Esc: the pen comes up and the ink stays; again, with the pen up, the ink goes. A Show is thrown away first.
    func escape() {
        if recorder != nil { return cancelShow() }
        armed ? lift() : clear()
    }

    /// A tool from the pill: in hand, the pen down. The tool already in hand, picked again, lifts the pen — the pill is
    /// the one control the glass never covers.
    func pick(_ kind: CanvasMark.Kind) {
        if armed, tool == kind { return lift() }
        tool = kind
        arm()
    }

    /// A tool by its number key, with the pen down.
    func select(_ kind: CanvasMark.Kind) {
        tool = kind
    }

    // MARK: The marks

    /// A finished mark. The canvas lives on one display: a mark on another starts it there, and the old ink lifts away.
    // ponytail: one canvas, one display; a document per display, each sent as its own picture, if marking up two at once
    // is ever wanted.
    func commit(_ mark: CanvasMark, on ink: CanvasInkView) {
        if document?.anchor.id != ink.display {
            document = CanvasDocument(anchor: CanvasAnchor(id: ink.display, frame: ink.window?.frame ?? ink.bounds))
        }
        document?.add(mark)
        message = nil
        apply()
    }

    /// A note pinned where the pointer went down, its words typed straight in.
    func pin(at point: CanvasPoint, on ink: CanvasInkView) {
        let note = CanvasMark(kind: .note, points: [point], text: "")
        commit(note, on: ink)
        ink.edit(note.id)
    }

    func setText(_ text: String, of id: CanvasMark.ID) {
        document?.setText(text, of: id)
    }

    func undo() {
        guard document?.undo() != nil else { return }
        if document?.isEmpty == true, !armed { document = nil }
        apply()
    }

    /// A canvas back after a Send that didn't get there, unless something new was drawn meanwhile.
    func restore(_ document: CanvasDocument) {
        guard self.document == nil else { return }
        self.document = document
        apply()
    }

    /// A clear canvas: the ink lifts away, the agent's with it, and its marks aren't put back. The pen stays as it was.
    func clear() {
        AgentInkController.shared.stop()
        guard document != nil else { return }
        document = nil
        message = nil
        apply()
    }

    // MARK: An agent's marks

    /// An agent's marks, placed (`AgentInkController`), in place of any it had drawn: merged by id, so one it still has keeps its
    /// layer and moves rather than drawing on again. On a display with none of Tyler's ink, they start the canvas there;
    /// with his ink on another display, they wait. The pen and the glass's click-through are left exactly as they are.
    func showAgent(_ marks: [CanvasMark], on display: CGDirectDisplayID, frame: CGRect, by name: String) {
        if document?.anchor.id != display {
            guard document?.has(.you) != true else {
                return NSLog("conch: an agent's marks are on another display than Tyler's ink; they wait until it clears")
            }
            document = CanvasDocument(anchor: CanvasAnchor(id: display, frame: frame))
        }
        agentName = name
        agentHidden = false
        document?.merge(agent: marks)
        if document?.isEmpty == true, !armed { document = nil }
        apply()
    }

    /// The agent's marks fade out while what they are on moves, and back once it is still.
    func hideAgent(_ hidden: Bool) {
        guard hidden != agentHidden, document?.has(.agent) == true else { return }
        agentHidden = hidden
        apply()
    }

    /// The agent's marks gone, Tyler's left.
    func clearAgent() {
        guard document?.has(.agent) == true else { return }
        document?.merge(agent: [])
        if document?.isEmpty == true, !armed { document = nil }
        apply()
    }

    /// The glass on `display`, while it shows: agent ink judges what is visible by the windows below it.
    func glassNumber(on display: CGDirectDisplayID) -> Int? {
        glass.first { $0.ink.display == display && $0.panel.isVisible }?.panel.windowNumber
    }

    // MARK: On screen

    /// One glass per display, rebuilt when the displays change: with "Displays have separate Spaces" no window can span two.
    private func buildGlass() {
        for each in glass { each.panel.orderOut(nil) }
        glass = NSScreen.screens.compactMap { screen in
            guard let display = screen.displayID else { return nil }
            let panel = FloatingPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.setFrame(screen.frame, display: false)
            // Above the Dock and the menu bar, below menus, drag images and system alerts (the research's levels).
            panel.level = .statusBar
            // Every space and full-screen app, out of Command-` and hidden by Mission Control: never `.stationary`.
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .transient]
            panel.isExcludedFromWindowsMenu = true
            panel.hidesOnDeactivate = false
            panel.isReleasedWhenClosed = false
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = false
            // Click-through, for the whole window: the window server picks the window a click goes to before AppKit
            // runs, so there is no letting part of it through. It takes the pointer only while the pen is down (`apply`).
            panel.ignoresMouseEvents = true
            let ink = CanvasInkView(display: display, controller: self)
            panel.contentView = ink
            return (panel, ink)
        }
        // A display that went takes its canvas with it.
        if let document, !glass.contains(where: { $0.ink.display == document.anchor.id }) { self.document = nil }
        apply()
    }

    /// Everything on screen, from the state: the glass while the canvas is in use, taking the pointer only while the pen is
    /// down and nothing is sending; each display's ink; and the tools.
    func apply() {
        let inUse = inUse
        for (panel, ink) in glass {
            // Keys while in use, so a second Esc after the pen comes up still reaches the canvas; a click into the app
            // underneath takes them back.
            panel.takesKeys = inUse
            panel.ignoresMouseEvents = !armed || sending
            // The pen's edge light is on the glass, which a Show records: while it does, the red ring (its own window, left
            // out) says so instead.
            ink.show(document?.anchor.id == ink.display ? document : nil, armed: armed && recorder?.isRecording != true, agentHidden: agentHidden, agentName: agentName)
        }
        hiding?.cancel()
        if inUse {
            for (panel, _) in glass { panel.orderFrontRegardless() }
            placePill()
            pill.orderFrontRegardless()
        } else {
            // After the ink has lifted away and the pill has sunk.
            hiding = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(450))
                guard !Task.isCancelled, let self, !self.inUse else { return }
                for (panel, _) in glass { panel.orderOut(nil) }
                pill.orderOut(nil)
            }
        }
    }

    /// The tools rise out of the conversation panel's top edge, centred on it; hanging from the top of the screen, they
    /// sit under it instead. With the panel hidden, collapsed or full screen, at the top of the screen, under the menu bar.
    private func placePill(size: CGSize? = nil) {
        if let size { pillSize = size }
        guard pillSize.width > 0 else { return }
        // The pill's own margin, for its shadow and its rise (`CanvasPillHost`).
        let margin = CanvasPillHost.margin
        let anchor = FloatingPanels.installed?.glassFrame
        let pointer = NSEvent.mouseLocation
        guard let screen = anchor.flatMap({ frame in NSScreen.screens.first { $0.frame.intersects(frame) } })
            ?? NSScreen.screens.first(where: { $0.frame.contains(pointer) }) ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        var origin: NSPoint
        if let anchor {
            origin = NSPoint(x: anchor.midX - pillSize.width / 2, y: anchor.maxY + ConchSpace.x2 - margin)
            if origin.y + pillSize.height - margin > visible.maxY { origin.y = anchor.minY - ConchSpace.x2 - pillSize.height + margin }
        } else {
            origin = NSPoint(x: visible.midX - pillSize.width / 2, y: visible.maxY - ConchSpace.x3 - pillSize.height + margin)
        }
        origin.x = min(max(origin.x, visible.minX - margin), visible.maxX - pillSize.width + margin)
        let frame = NSRect(origin: origin, size: pillSize)
        if pill.frame != frame { pill.setFrame(frame, display: true) }
    }
}

/// The tools on the controller and the store.
private struct CanvasPillHost: View {
    /// Room around the pill for its shadow and its rise.
    static let margin: CGFloat = ConchSpace.x6

    @ObservedObject var canvas: CanvasController
    @ObservedObject var store: StateStore
    let onSize: (CGSize) -> Void

    var body: some View {
        // Only Tyler's marks are his to undo and to send; the agent's are what he is answering.
        let drawn = canvas.document?.has(.you) == true
        CanvasToolPill(
            shown: canvas.inUse,
            tool: canvas.tool,
            armed: canvas.armed,
            canUndo: drawn,
            canSend: drawn || canvas.recorder != nil,
            sending: canvas.sending,
            route: CanvasController.route(store.state, panel: FloatingPanels.installed?.staged)?.label,
            message: canvas.message,
            onTool: { canvas.pick($0) },
            onUndo: { canvas.undo() },
            onSend: { canvas.send() },
            recording: canvas.recorder?.phase,
            onShow: CanvasController.canShow ? { canvas.toggleShow() } : nil
        )
        .padding(Self.margin)
        .fixedSize()
        .background(GeometryReader { proxy in Color.clear.preference(key: CanvasPillSize.self, value: proxy.size) })
        .onPreferenceChange(CanvasPillSize.self, perform: onSize)
    }
}

private struct CanvasPillSize: PreferenceKey {
    static let defaultValue = CGSize.zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

// MARK: - The glass

/// One display's glass: the ink on it, and the pointer and keys while the pen is down. Core Animation draws it: a layer for
/// the stroke being drawn, rebuilt with every pointer event and never animated, and one for each finished mark, which
/// then costs nothing per frame. Every shape comes from `CanvasInk`, as the picture an agent is sent does.
final class CanvasInkView: NSView {
    let display: CGDirectDisplayID
    private weak var controller: CanvasController?
    /// The thin light round the edge while the pen is down, in Tyler's ink colour. No dimming.
    private let edge = CALayer()
    private let glow = CAShapeLayer()
    /// This canvas's finished marks, together, so a fresh canvas lifts them away as one.
    private var marks = CALayer()
    /// Inside it, under Tyler's, the agent's: faded as one while what they are on moves.
    private var agents = CALayer()
    private let live = CAShapeLayer()
    private var drawn: [CanvasMark.ID: CALayer] = [:]
    private var notes: [CanvasMark.ID: CanvasNoteView] = [:]
    /// An agent's labels beside its marks.
    private var labels: [CanvasMark.ID: CanvasNoteView] = [:]
    /// Each mark as it was drawn, so one that moved is drawn again where it is now.
    private var seen: [CanvasMark.ID: CanvasMark] = [:]
    private var agentsHidden = false
    /// The canvas on show, by its id.
    private var shown: String?
    private var drawing: CanvasMark?
    private var began: TimeInterval = 0
    private var edgeOn = false

    init(display: CGDirectDisplayID, controller: CanvasController) {
        self.display = display
        self.controller = controller
        super.init(frame: .zero)
        wantsLayer = true
        // For the blur a lifting canvas softens with.
        layerUsesCoreImageFilters = true
        edge.opacity = 0
        edge.masksToBounds = true
        edge.borderWidth = 2
        edge.borderColor = CanvasInk.you.cgColor.copy(alpha: 0.55)
        // The glow is the shadow of a frame just outside the screen, falling inward.
        glow.fillColor = CanvasInk.you.cgColor
        glow.shadowColor = CanvasInk.you.cgColor
        glow.shadowOpacity = 0.35
        glow.shadowRadius = 28
        glow.shadowOffset = .zero
        edge.addSublayer(glow)
        edge.shouldRasterize = true
        marks.addSublayer(agents)
        for each in [edge, marks, live] { layer?.addSublayer(each) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Top left, y down, as the marks are kept.
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        layOutLayers()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        layOutLayers()
    }

    /// The layers fill the glass; the edge's glow is the shadow of a frame just outside it.
    private func layOutLayers() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for each in [edge, marks, agents, live] { each.frame = bounds }
        glow.frame = bounds
        let ring = CGMutablePath()
        ring.addRect(bounds.insetBy(dx: -80, dy: -80))
        // The screen's own rect the other way round, so the ring's middle is a hole.
        ring.addLines(between: [CGPoint(x: bounds.minX, y: bounds.minY), CGPoint(x: bounds.minX, y: bounds.maxY), CGPoint(x: bounds.maxX, y: bounds.maxY), CGPoint(x: bounds.maxX, y: bounds.minY)])
        ring.closeSubpath()
        glow.path = ring
        glow.shadowPath = ring
        edge.rasterizationScale = window?.backingScaleFactor ?? 2
        CATransaction.commit()
    }

    // MARK: Showing a canvas

    /// `document` on this display, or nothing. Marks come and go by id as they are added, undone and merged: a new one is
    /// drawn (an agent's drawn on), one that moved is drawn again where it is, without drawing on. A different canvas, or
    /// none, lifts the old one away.
    func show(_ document: CanvasDocument?, armed: Bool, agentHidden: Bool = false, agentName: String = "Claude") {
        light(armed)
        if document?.id != shown {
            liftAway()
            shown = document?.id
        }
        guard let document else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let present = Dictionary(document.marks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for id in Array(seen.keys) where !Self.drawnAlike(present[id], seen[id]) {
            // An agent's mark that is gone rather than moved fades as it goes.
            remove(id, fading: present[id] == nil && seen[id]?.author == .agent)
        }
        // An agent's new marks draw on one after another, 60 ms apart.
        var order = 0
        for mark in document.marks where seen[mark.id] == nil {
            seen[mark.id] = mark
            let fresh = mark.author == .agent && !(drawnBefore.contains(mark.id))
            let delay = fresh ? Double(order) * 0.06 : 0
            if fresh { order += 1 }
            drawnBefore.insert(mark.id)
            if mark.kind == .note {
                let note = CanvasNoteView(mark, number: document.number(of: mark) ?? 0, in: bounds.size, by: agentName)
                note.onText = { [weak controller] text in controller?.setText(text, of: mark.id) }
                note.onDone = { [weak self] in
                    guard let self else { return }
                    window?.makeFirstResponder(self)
                }
                addSubview(note)
                notes[mark.id] = note
                if mark.author == .agent { note.alphaValue = agentsHidden ? 0 : 1 }
                if fresh || mark.author == .you { note.pop(after: delay) }
            } else {
                let layer = Self.layer(for: mark, in: bounds.size)
                (mark.author == .agent ? agents : marks).addSublayer(layer)
                drawn[mark.id] = layer
                if fresh { drawOn(layer, mark, after: delay) }
                if mark.author == .agent, let words = mark.text, !words.isEmpty {
                    let label = CanvasNoteView(mark, number: 0, in: bounds.size, by: agentName)
                    addSubview(label)
                    labels[mark.id] = label
                    label.alphaValue = agentsHidden ? 0 : 1
                    // The label pops as its mark is four fifths drawn.
                    if fresh { label.pop(after: delay + (Self.reduceMotion ? 0 : Self.drawOnTime * 0.8)) }
                }
            }
        }
        CATransaction.commit()
        hideAgents(agentHidden)
    }

    /// Whether a mark still looks as drawn. Tyler's note's words are the typing in its own field, not a redraw.
    static func drawnAlike(_ now: CanvasMark?, _ then: CanvasMark?) -> Bool {
        guard let now, let then else { return now == nil && then == nil }
        return now.kind == then.kind && now.points == then.points && (now.author == .you || now.text == then.text)
    }

    /// Ids already drawn on in this canvas: moved or faded back, a mark doesn't draw on twice.
    private var drawnBefore: Set<CanvasMark.ID> = []

    private func remove(_ id: CanvasMark.ID, fading: Bool = false) {
        seen[id] = nil
        let layer = drawn.removeValue(forKey: id)
        let views = [labels.removeValue(forKey: id), notes.removeValue(forKey: id)].compactMap { $0 }
        if views.contains(where: \.isEditing) { window?.makeFirstResponder(self) }
        guard fading else {
            layer?.removeFromSuperlayer()
            return views.forEach { $0.removeFromSuperview() }
        }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        fade.duration = 0.16
        CATransaction.begin()
        CATransaction.setCompletionBlock {
            layer?.removeFromSuperlayer()
            views.forEach { $0.removeFromSuperview() }
        }
        layer?.opacity = 0
        layer?.add(fade, forKey: "gone")
        for view in views {
            view.layer?.opacity = 0
            view.layer?.add(fade, forKey: "gone")
        }
        CATransaction.commit()
    }

    static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    /// How long an agent's mark takes to draw on (the research's ~400 ms).
    static let drawOnTime: CFTimeInterval = 0.4

    /// An agent's mark drawn on as a pen would: its ink revealed along its own line (`CanvasInk.spine`) by a mask whose
    /// stroke grows to its end. Reduce Motion: it fades in instead.
    private func drawOn(_ layer: CALayer, _ mark: CanvasMark, after delay: CFTimeInterval) {
        let start = CACurrentMediaTime() + delay
        guard !Self.reduceMotion, let spine = CanvasInk.spine(of: mark, in: bounds.size) else {
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0
            fade.toValue = 1
            fade.duration = 0.2
            fade.beginTime = start
            fade.fillMode = .backwards
            return layer.add(fade, forKey: "appear")
        }
        let reveal = CAShapeLayer()
        reveal.frame = layer.bounds
        reveal.path = spine.path
        reveal.lineWidth = spine.width
        reveal.lineCap = .round
        reveal.lineJoin = .round
        reveal.fillColor = nil
        reveal.strokeColor = NSColor.black.cgColor
        layer.mask = reveal
        let draw = CABasicAnimation(keyPath: "strokeEnd")
        draw.fromValue = 0
        draw.toValue = 1
        draw.duration = Self.drawOnTime
        draw.beginTime = start
        draw.fillMode = .backwards
        // panel-lab's agent ink: cubic-bezier(.3,.1,.2,1).
        draw.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0.1, 0.2, 1)
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak layer] in layer?.mask = nil }
        reveal.add(draw, forKey: "draw")
        CATransaction.commit()
    }

    /// The agent's marks and their labels faded out, or back (120 ms).
    private func hideAgents(_ hidden: Bool) {
        guard hidden != agentsHidden else { return }
        agentsHidden = hidden
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = agents.presentation()?.opacity ?? agents.opacity
        fade.duration = 0.12
        agents.opacity = hidden ? 0 : 1
        agents.add(fade, forKey: "hide")
        let views = labels.values + notes.values.filter(\.isAgents)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            for view in views { view.animator().alphaValue = hidden ? 0 : 1 }
        }
    }

    /// A note's words, focused for typing.
    func edit(_ id: CanvasMark.ID) {
        notes[id]?.edit()
    }

    /// The edge light fades in as the pen goes down and out as it comes up (160 ms, the research's).
    private func light(_ on: Bool) {
        guard on != edgeOn else { return }
        edgeOn = on
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = edge.presentation()?.opacity ?? edge.opacity
        fade.duration = 0.16
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        edge.opacity = on ? 1 : 0
        edge.add(fade, forKey: "light")
    }

    /// The old ink lifts away, fading and softening (panel-lab's `sweepInk`), rather than vanishing. Reduce Motion keeps
    /// only the fade.
    private func liftAway() {
        let old = marks, oldAgents = agents, leaving = Array(notes.values) + Array(labels.values)
        marks = CALayer()
        marks.frame = bounds
        agents = CALayer()
        agents.frame = bounds
        marks.addSublayer(agents)
        agentsHidden = false
        layer?.insertSublayer(marks, below: live)
        drawn = [:]
        notes = [:]
        labels = [:]
        seen = [:]
        drawnBefore = []
        if leaving.contains(where: { $0.isEditing }) { window?.makeFirstResponder(self) }
        let inked = (old.sublayers ?? []).contains { $0 !== oldAgents } || oldAgents.sublayers?.isEmpty == false
        guard inked || !leaving.isEmpty else { return old.removeFromSuperlayer() }
        let fade = CASpringAnimation(perceptualDuration: 0.32, bounce: 0)
        fade.keyPath = "opacity"
        fade.fromValue = 1
        fade.toValue = 0
        fade.duration = fade.settlingDuration
        CATransaction.begin()
        CATransaction.setCompletionBlock {
            old.removeFromSuperlayer()
            leaving.forEach { $0.removeFromSuperview() }
        }
        old.opacity = 0
        old.add(fade, forKey: "lift")
        if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, let blur = CIFilter(name: "CIGaussianBlur") {
            blur.name = "blur"
            blur.setValue(4, forKey: kCIInputRadiusKey)
            old.filters = [blur]
            let soften = CABasicAnimation(keyPath: "filters.blur.inputRadius")
            soften.fromValue = 0
            soften.toValue = 4
            soften.duration = fade.duration
            soften.timingFunction = CAMediaTimingFunction(name: .easeOut)
            old.add(soften, forKey: "soften")
        }
        for note in leaving {
            note.layer?.opacity = 0
            note.layer?.add(fade, forKey: "lift")
        }
        CATransaction.commit()
    }

    /// A finished mark: its ink, and a box's wash under it.
    static func layer(for mark: CanvasMark, in size: CGSize) -> CALayer {
        let shape = CanvasInk.shape(of: mark, in: size)
        let ink = CAShapeLayer()
        ink.frame = CGRect(origin: .zero, size: size)
        style(ink, for: mark)
        ink.path = shape.ink
        guard let wash = shape.wash else { return ink }
        let under = CAShapeLayer()
        under.frame = ink.frame
        under.path = wash
        under.fillColor = CanvasInk.colour(mark.author).cgColor.copy(alpha: CanvasInk.washOpacity)
        under.addSublayer(ink)
        return under
    }

    /// Ink in its author's colour; a highlight in the marker's yellow and an agent's area in a wash of its colour, both
    /// multiplied over any ink under them. Over another app they can only be translucent: a window can't blend with what
    /// is behind it.
    static func style(_ layer: CAShapeLayer, for mark: CanvasMark) {
        layer.fillColor = CanvasInk.fill(of: mark).cgColor
        layer.strokeColor = nil
        layer.compositingFilter = CanvasInk.multiplies(mark) ? "multiplyBlendMode" : nil
    }

    // MARK: Drawing

    override func mouseDown(with event: NSEvent) {
        guard let controller, controller.armed else { return }
        // Pressing on the glass ends a note being typed.
        window?.makeFirstResponder(self)
        began = event.timestamp
        let point = unit(event)
        if controller.tool == .note { return controller.pin(at: point, on: self) }
        drawing = CanvasMark(kind: controller.tool, points: [point])
        // Every tablet sample, not one per frame.
        NSEvent.isMouseCoalescingEnabled = false
        drawLive()
    }

    override func mouseDragged(with event: NSEvent) {
        guard var mark = drawing else { return }
        let point = unit(event)
        // A stroke keeps every sample; an arrow and a box only where they started and where the pointer is now.
        if mark.kind == .pen || mark.kind == .highlight { mark.points.append(point) } else { mark.points = [mark.points[0], point] }
        drawing = mark
        drawLive()
    }

    override func mouseUp(with event: NSEvent) {
        NSEvent.isMouseCoalescingEnabled = true
        guard let mark = drawing else { return }
        drawing = nil
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        live.path = nil
        // A click with the arrow or the box drew nothing.
        if mark.kind == .pen || mark.kind == .highlight || mark.extent(in: bounds.size) >= 4 { controller?.commit(mark, on: self) }
        CATransaction.commit()
    }

    /// The stroke being drawn, straight onto its layer: no implicit animation, so it keeps up with the pointer.
    private func drawLive() {
        guard let mark = drawing else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        Self.style(live, for: mark)
        live.path = CanvasInk.shape(of: mark, in: bounds.size).ink
        CATransaction.commit()
    }

    /// Where the pointer is, 0 to 1 across and down this display; a tablet's pressure, never a mouse's flat one.
    private func unit(_ event: NSEvent) -> CanvasPoint {
        let at = convert(event.locationInWindow, from: nil)
        func round(_ value: Double, _ places: Double) -> Double { (value * places).rounded() / places }
        return CanvasPoint(
            x: round(at.x / max(bounds.width, 1), 100_000),
            y: round(at.y / max(bounds.height, 1), 100_000),
            p: event.subtype == .tabletPoint ? round(Double(event.pressure), 1000) : nil,
            t: round(event.timestamp - began, 1000)
        )
    }

    // MARK: Keys

    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case UInt16(kVK_Escape):
            controller?.escape()
        case UInt16(kVK_Return), UInt16(kVK_ANSI_KeypadEnter):
            controller?.send()
        case UInt16(kVK_ANSI_R) where controller?.armed == true:
            // R with the pen down: Show (panel-lab's R).
            controller?.toggleShow()
        default:
            // The number keys pick a tool (panel-lab's 1 to 5). Anything else is dropped: while the glass has the keys,
            // the app underneath can't have them.
            if controller?.armed == true, let key = event.charactersIgnoringModifiers?.first,
               let tool = CanvasToolPill.tools.first(where: { $0.key == key }) {
                controller?.select(tool.kind)
            }
        }
    }

    /// ⌘Z takes the newest mark off; while a note is being typed, it is the note's own undo.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
              event.charactersIgnoringModifiers == "z",
              window?.firstResponder === self else { return super.performKeyEquivalent(with: event) }
        controller?.undo()
        return true
    }
}

/// A note: its numbered badge on the spot, and beside it the words, typed straight in while the pen is down (panel-lab's
/// `.pin`). The badge pops on the pop spring from the corner on the spot. An agent's is ✦, its words read-only and led by
/// its name; and any other mark of an agent's with a label has the words alone, beside it (`CanvasInk.labelSpot`).
final class CanvasNoteView: NSView, NSTextFieldDelegate {
    var onText: (String) -> Void = { _ in }
    var onDone: () -> Void = {}
    /// An agent's, faded with its other marks.
    let isAgents: Bool
    private let spot: CGPoint
    private let room: CGSize
    /// A note has a badge; a label is the words alone.
    private let pinned: Bool
    private let badge = CALayer()
    private let bubble = NSVisualEffectView()
    private let field = NSTextField()
    static let gap: CGFloat = 6
    static let widest: CGFloat = 240

    init(_ mark: CanvasMark, number: Int, in size: CGSize, by name: String = "Claude") {
        pinned = mark.kind == .note
        isAgents = mark.author == .agent
        spot = (pinned ? mark.points.first?.point(in: size) : CanvasInk.labelSpot(of: mark, in: size)) ?? .zero
        room = size
        super.init(frame: .zero)
        wantsLayer = true
        let side = CanvasInk.pinSide
        let shape = CAShapeLayer()
        // The builder's badge, moved to the badge's own corner.
        var home = CGAffineTransform(translationX: -spot.x, y: -(spot.y - side))
        shape.path = CanvasInk.shape(of: mark, in: size).ink.copy(using: &home)
        shape.fillColor = CanvasInk.colour(mark.author).cgColor
        shape.shadowOpacity = 0.3
        shape.shadowRadius = 6
        shape.shadowOffset = CGSize(width: 0, height: 3)
        let label = CATextLayer()
        label.string = mark.author == .agent ? "✦" : "\(number)"
        label.font = NSFont.systemFont(ofSize: 12, weight: .bold)
        label.fontSize = 12
        label.foregroundColor = NSColor.white.cgColor
        label.alignmentMode = .center
        label.frame = CGRect(x: 0, y: (side - 15) / 2, width: side, height: 15)
        label.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
        badge.bounds = CGRect(x: 0, y: 0, width: side, height: side)
        // Its corner on the spot is where it grows from.
        badge.anchorPoint = CGPoint(x: 0, y: 1)
        badge.addSublayer(shape)
        badge.addSublayer(label)
        if pinned { layer?.addSublayer(badge) }

        bubble.material = .popover
        bubble.blendingMode = .behindWindow
        bubble.state = .active
        bubble.wantsLayer = true
        bubble.layer?.cornerRadius = 12
        bubble.layer?.masksToBounds = true
        bubble.layer?.borderWidth = 0.5
        bubble.layer?.borderColor = NSColor.black.withAlphaComponent(0.14).cgColor
        field.isEditable = mark.author == .you
        field.isSelectable = true
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = .systemFont(ofSize: 13)
        field.textColor = .labelColor
        field.placeholderString = "Say what to change"
        field.stringValue = mark.text ?? ""
        if isAgents {
            // Its name in its colour, then its words (panel-lab's `.note[data-author]`).
            let words = NSMutableAttributedString(string: "\(name) · ", attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: NSColor(cgColor: CanvasInk.agent.cgColor) ?? .systemPurple])
            words.append(NSAttributedString(string: mark.text ?? "", attributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.labelColor]))
            field.attributedStringValue = words
        }
        field.usesSingleLineMode = false
        field.maximumNumberOfLines = 0
        field.lineBreakMode = .byWordWrapping
        field.cell?.wraps = true
        field.cell?.isScrollable = false
        field.delegate = self
        bubble.addSubview(field)
        addSubview(bubble)
        // An agent's pin with nothing to say is its badge alone.
        bubble.isHidden = isAgents && (mark.text ?? "").isEmpty
        layOut()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    var isEditing: Bool { field.currentEditor() != nil }

    func edit() {
        window?.makeFirstResponder(field)
    }

    /// The badge on the spot, the words beside it as wide as they need up to 240 pt; near the screen's right edge, on the
    /// badge's left instead.
    private func layOut() {
        let text = field.stringValue.isEmpty ? field.placeholderString ?? "" : field.stringValue
        let measure = NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 13, weight: isAgents ? .semibold : .regular)])
            .boundingRect(with: NSSize(width: Self.widest - 20, height: 400), options: [.usesLineFragmentOrigin, .usesFontLeading])
        let words = NSSize(width: max(40, ceil(measure.width) + 4), height: ceil(measure.height))
        let size = NSSize(width: words.width + 20, height: words.height + 14)
        guard pinned else {
            // A label: the words alone, kept on the screen.
            frame = NSRect(x: min(max(spot.x, 8), room.width - size.width - 8), y: min(max(spot.y, 8), room.height - size.height - 8), width: size.width, height: size.height)
            bubble.frame = NSRect(origin: .zero, size: size)
            field.frame = NSRect(x: 10, y: 7, width: words.width, height: words.height)
            return
        }
        let side = CanvasInk.pinSide
        let leftward = spot.x + side + Self.gap + size.width > room.width - 8
        let width = side + Self.gap + size.width
        frame = NSRect(x: leftward ? spot.x - Self.gap - size.width : spot.x, y: spot.y - side, width: width, height: max(side, size.height))
        bubble.frame = NSRect(x: leftward ? 0 : side + Self.gap, y: 0, width: size.width, height: size.height)
        field.frame = NSRect(x: 10, y: 7, width: words.width, height: words.height)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        badge.position = CGPoint(x: leftward ? size.width + Self.gap : 0, y: side)
        CATransaction.commit()
    }

    /// In on the pop spring, `delay` from now: the badge from half size at its corner, the words fading up beside it (a
    /// label's growing a little as they come). Reduce Motion: a fade.
    func pop(after delay: CFTimeInterval = 0) {
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let start = CACurrentMediaTime() + delay
        let spring = ConchMotion.pop.resolved(reduceMotion: reduce)
        let grow = CASpringAnimation(perceptualDuration: spring.response, bounce: spring.bounce)
        grow.keyPath = "transform.scale"
        grow.fromValue = reduce ? 1 : pinned ? 0.5 : 0.85
        grow.toValue = 1
        grow.duration = grow.settlingDuration
        grow.beginTime = start
        grow.fillMode = .backwards
        let appear = CABasicAnimation(keyPath: "opacity")
        appear.fromValue = 0
        appear.toValue = 1
        appear.duration = 0.18
        appear.beginTime = start
        appear.fillMode = .backwards
        badge.add(grow, forKey: "pop")
        badge.add(appear, forKey: "appear")
        bubble.layer?.add(appear, forKey: "appear")
        if !pinned { bubble.layer?.add(grow, forKey: "pop") }
    }

    func controlTextDidChange(_ notification: Notification) {
        layOut()
        onText(field.stringValue)
    }

    /// Return and Esc finish the note, and the glass has the keys again (Esc there then lifts the pen).
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        guard selector == #selector(NSResponder.insertNewline(_:)) || selector == #selector(NSResponder.cancelOperation(_:)) else { return false }
        onText(field.stringValue)
        onDone()
        return true
    }
}

extension NSScreen {
    /// The display's `CGDirectDisplayID`.
    var displayID: CGDirectDisplayID? {
        deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
    }
}

// MARK: - The hotkey

/// ⌃⌥⌘P from anywhere: the pen down, or up. Carbon's hot keys need no permission — a global key monitor needs
/// Accessibility, an event tap Input Monitoring — and arrive on the main thread.
enum CanvasHotKey {
    /// The chord, in one place.
    static let key = UInt32(kVK_ANSI_P)
    static let modifiers = UInt32(controlKey | optionKey | cmdKey)

    private static var registered: EventHotKeyRef?

    static func register() {
        guard registered == nil else { return }
        var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            MainActor.assumeIsolated { CanvasController.shared.toggle() }
            return noErr
        }, 1, &pressed, nil, nil)
        // "cnch", 1: conch's only hot key.
        let status = RegisterEventHotKey(key, modifiers, EventHotKeyID(signature: OSType(0x636E_6368), id: 1), GetApplicationEventTarget(), 0, &registered)
        if status != noErr { NSLog("conch: the canvas hotkey (⌃⌥⌘P) is taken (%d); the pen button and the menu still work", status) }
    }
}
