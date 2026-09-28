import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

// The conversation's selection as views: which texts can be selected, where their words are, the highlight, and (on the
// Mac) the surface that takes the pointer and the keyboard. The model is ConversationSelection.swift.

/// Marks a `Text` as selectable text `segment` of row `row`. SwiftUI reports each text's layout with its runs' custom
/// attributes (`Text.LayoutKey`), so the row finds its own texts by this tag and skips everything else it draws — a
/// bullet, a tool's name, a button's title.
public struct ConversationSelectionTag: TextAttribute {
    public let row: String
    public let segment: Int

    public init(row: String, segment: Int) {
        self.row = row
        self.segment = segment
    }
}

extension EnvironmentValues {
    /// The selectable row a view is drawn in, for a renderer that does not know its row (`MarkdownView`): its texts are
    /// tagged with it. Nil outside the conversation, where a document keeps its own selection.
    @Entry public var conversationSelectionRow: String? = nil
}

extension Text {
    /// Tagged as selectable text `segment` of `row`, when there is a row.
    public func conversationSelectable(row: String?, segment: Int) -> Text {
        guard let row else { return self }
        return customAttribute(ConversationSelectionTag(row: row, segment: segment))
    }
}

/// The coordinate space rows report their words in, and the surface reads the pointer in: the stack's.
public enum ConversationSelectionSpace {
    public static let name = "conch.conversation.selection"
}

#if os(macOS)
extension View {
    /// A row of the conversation whose tagged texts are selected with the rest of it. `wholeRow`: the row is all text (a
    /// message), so a press anywhere on it selects; otherwise only its texts take the pointer.
    public func conversationSelectionRow(_ id: String, in controller: ConversationSelectionController, wholeRow: Bool = true) -> some View {
        modifier(SelectableRow(id: id, controller: controller, box: controller.box(for: id), wholeRow: wholeRow))
    }

    /// The stack the selectable rows are in: its coordinate space, and over it the surface that takes presses on text.
    public func conversationSelectionSurface(_ controller: ConversationSelectionController) -> some View {
        coordinateSpace(name: ConversationSelectionSpace.name)
            // Out of the accessibility tree: VoiceOver finds the texts under it, as before.
            .overlay { ConversationSelectionSurface(controller: controller).accessibilityHidden(true) }
    }
}

/// Says where the row is; once armed, reports where its texts are, from SwiftUI's own layout of each, and draws the part
/// of the row that is selected.
///
/// Measured by the row itself, while it is a view: a row that is let go of takes nothing with it but its registration,
/// and the selection, which is in terms of the model, lights it again when it comes back. Unarmed, it reads no layout
/// at all (`ConversationSelectionController`): arming rebuilds it once, reading.
struct SelectableRow: ViewModifier {
    let id: String
    let controller: ConversationSelectionController
    @ObservedObject var box: RowSelectionBox
    let wholeRow: Bool
    @State private var token = UUID()
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        let tagged = content.environment(\.conversationSelectionRow, id)
        Group {
            if controller.isArmed(id) {
                tagged.overlayPreferenceValue(Text.LayoutKey.self) { layouts in
                    // Within the row only: nothing here reads where the row is, so a row that moves is not laid out
                    // again, and keeps what was worked out from its layout (`place` says where it went).
                    GeometryReader { proxy in
                        let generation = controller.register(
                            row: id,
                            token: token,
                            wholeRow: wholeRow,
                            segments: Self.segments(layouts, row: id, proxy: proxy)
                        )
                        SelectionHighlight(box: box, controller: controller, id: id, generation: generation, dark: colorScheme == .dark)
                    }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
            } else {
                tagged
            }
        }
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(ConversationSelectionSpace.name)) } action: { frame in
            controller.place(row: id, token: token, frame: frame, wholeRow: wholeRow)
        }
        .onDisappear { controller.unregister(row: id, token: token) }
    }

    /// The row's own tagged texts, placed in the row.
    static func segments(_ layouts: [Text.LayoutKey.AnchoredLayout], row: String, proxy: GeometryProxy) -> [ConversationSelectionController.RegisteredSegment] {
        var result: [ConversationSelectionController.RegisteredSegment] = []
        for anchored in layouts {
            guard let tag = tag(of: anchored.layout), tag.row == row else { continue }
            let origin = proxy[anchored.origin]
            let layout = anchored.layout
            result.append(.init(index: tag.segment, geometry: { text in
                SegmentGeometry(lines: lines(of: layout), text: text, origin: origin)
            }, lines: {
                layout.map { line in
                    let box = line.typographicBounds.rect
                    return CGRect(x: origin.x + box.minX, y: origin.y + box.minY, width: box.width, height: box.height)
                }
            }))
        }
        return result
    }

    static func tag(of layout: Text.Layout) -> ConversationSelectionTag? {
        for line in layout {
            for run in line {
                if let tag = run[ConversationSelectionTag.self] { return tag }
            }
        }
        return nil
    }

    /// Each line's glyphs as SwiftUI laid them out: their paragraph-relative character indices and horizontal extents.
    static func lines(of layout: Text.Layout) -> [SelectionLayoutLine] {
        layout.map { line in
            let bounds = line.typographicBounds.rect
            var glyphs: [(index: Int, minX: CGFloat, maxX: CGFloat)] = []
            for run in line {
                let indices = run.characterIndices
                for glyph in 0..<min(run.count, indices.count) {
                    let extent = run[glyph].typographicBounds
                    glyphs.append((characterOffset(indices[glyph]), extent.origin.x, extent.origin.x + extent.width))
                }
            }
            return SelectionLayoutLine(top: bounds.minY, bottom: bounds.maxY, glyphs: glyphs)
        }
    }

    /// A laid-out character's index as a number. `CharacterIndex` is a frozen struct holding exactly that number, and
    /// says so only to SwiftUI's own package.
    static func characterOffset(_ index: Text.Layout.CharacterIndex) -> Int {
        precondition(MemoryLayout<Text.Layout.CharacterIndex>.size == MemoryLayout<Int>.size)
        return unsafeBitCast(index, to: Int.self)
    }
}

/// The lit part of one row.
///
/// Laid OVER the row and blended — darken in light, lighten in dark — rather than drawn under it: under it, a bubble's or
/// a code block's fill would sit between the selection and the words and wash it out, and an opaque fill would hide it.
/// Blended, the selection colour replaces the ground around the glyphs exactly (the ground is lighter than it in light
/// and darker in dark) and the glyphs, darker in light and lighter in dark, keep their own colour: what a text view draws.
struct SelectionHighlight: View {
    @ObservedObject var box: RowSelectionBox
    let controller: ConversationSelectionController
    let id: String
    /// Changes with every layout of the row, so the highlight follows the words.
    let generation: Int
    let dark: Bool

    var body: some View {
        let rects = controller.highlightRects(for: id)
        if !rects.isEmpty {
            Path { path in
                for rect in rects { path.addRect(rect) }
            }
            .fill(Color(nsColor: controller.isEmphasized ? .selectedTextBackgroundColor : .unemphasizedSelectedTextBackgroundColor))
            .blendMode(dark ? .lighten : .darken)
        }
    }
}

/// The surface over the conversation that takes the pointer where it is on text, and the keyboard's Copy and Select All
/// once it has been pressed.
struct ConversationSelectionSurface: NSViewRepresentable {
    let controller: ConversationSelectionController

    func makeNSView(context: Context) -> ConversationSelectionSurfaceView {
        let view = ConversationSelectionSurfaceView()
        view.controller = controller
        return view
    }

    func updateNSView(_ view: ConversationSelectionSurfaceView, context: Context) {
        view.controller = controller
    }

    static func dismantleNSView(_ view: ConversationSelectionSurfaceView, coordinator: ()) {
        view.stopAutoscroll()
        view.stopWatchingScrolling()
    }
}

/// Takes a press only where it is on selectable text (`hitTest`): everywhere else — a button, a link, a question's
/// options, the space between rows — the press goes to what is under it, as before. A press it takes makes it first
/// responder, so the Edit menu's Copy and Select All come to it.
///
/// It has no say over the pointer's shape: the texts under it are still SwiftUI's selectable texts, which show the
/// I-beam as they always did, and a surface that set a cursor would have to unset it over every button it passes.
/// The texts keep `.textSelection(.enabled)` for VoiceOver too, which reads and selects in them as before.
public final class ConversationSelectionSurfaceView: NSView {
    weak var controller: ConversationSelectionController?
    /// Where Copy goes: the general pasteboard, but for a test's own.
    var pasteboard = NSPasteboard.general
    private var autoscrollTimer: Timer?
    private var lastDrag: NSPoint?
    private var windowObservers: [NSObjectProtocol] = []
    private var scrollObserver: NSObjectProtocol?
    /// Fires once a scroll has been still for a moment. One timer, moved on by each scroll step, rather than a wake-up
    /// queued per step: a flick is sixty steps a second.
    private var restAfterScroll: Timer?

    public override var isFlipped: Bool { true }
    public override var acceptsFirstResponder: Bool { true }
    /// A drag here selects; it never moves the window, whatever the window allows.
    public override var mouseDownCanMoveWindow: Bool { false }

    public override func hitTest(_ point: NSPoint) -> NSView? {
        guard let controller, !isHidden, let event = NSApp.currentEvent else { return nil }
        let local = convert(point, from: superview)
        guard bounds.contains(local) else { return nil }
        switch event.type {
        case .leftMouseDown:
            if event.modifierFlags.contains(.control) { return controller.isSelected(at: local) ? self : nil }
            return controller.accepts(pressAt: local, extending: event.modifierFlags.contains(.shift)) ? self : nil
        case .rightMouseDown:
            return controller.isSelected(at: local) ? self : nil
        default:
            return nil
        }
    }

    public override func mouseDown(with event: NSEvent) {
        guard let controller else { return }
        if event.modifierFlags.contains(.control) {
            if let menu = menu(for: event) { NSMenu.popUpContextMenu(menu, with: event, for: self) }
            return
        }
        window?.makeFirstResponder(self)
        lastDrag = event.locationInWindow
        controller.press(at: convert(event.locationInWindow, from: nil), clickCount: event.clickCount, extending: event.modifierFlags.contains(.shift))
    }

    public override func mouseDragged(with event: NSEvent) {
        guard let controller, controller.isPressing else { return }
        lastDrag = event.locationInWindow
        controller.drag(to: convert(event.locationInWindow, from: nil))
        startAutoscroll()
    }

    public override func mouseUp(with event: NSEvent) {
        stopAutoscroll()
        lastDrag = nil
        controller?.release()
    }

    // MARK: Arming the row under the pointer

    /// The pointer moving over a row arms it. Only moving: rows scrolled under a still pointer read nothing.
    public override func mouseMoved(with event: NSEvent) {
        controller?.arm(at: convert(event.locationInWindow, from: nil))
    }

    public override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas where area.owner === self { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    /// A scroll that has come to rest arms the row under a pointer that did not move, so a press there after reading
    /// is the selection's too.
    func stopWatchingScrolling() {
        if let scrollObserver { NotificationCenter.default.removeObserver(scrollObserver) }
        scrollObserver = nil
        restAfterScroll?.invalidate()
        restAfterScroll = nil
    }

    private func watchScrolling() {
        stopWatchingScrolling()
        guard let clip = enclosingScrollView?.contentView else { return }
        clip.postsBoundsChangedNotifications = true
        scrollObserver = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.scrolled() }
        }
    }

    private func scrolled() {
        let rest = Date(timeIntervalSinceNow: 0.15)
        if let restAfterScroll, restAfterScroll.isValid {
            restAfterScroll.fireDate = rest
            return
        }
        let timer = Timer(fire: rest, interval: 0, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.cameToRest() }
        }
        RunLoop.main.add(timer, forMode: .common)
        restAfterScroll = timer
    }

    private func cameToRest() {
        guard let window, window.isKeyWindow else { return }
        let point = convert(window.mouseLocationOutsideOfEventStream, from: nil)
        if visibleRect.contains(point) { controller?.arm(at: point) }
    }

    // MARK: Copy, Select All, the context menu

    @objc public func copy(_ sender: Any?) {
        guard let text = controller?.copiedText() else { return }
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    public override func selectAll(_ sender: Any?) {
        controller?.selectAll()
    }

    /// Escape, when nothing above it took it: the selection goes.
    public override func cancelOperation(_ sender: Any?) {
        controller?.clear()
    }

    /// Copy only with something selected; Select All always.
    @objc public func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(copy(_:)): return controller?.hasSelection ?? false
        case #selector(selectAll(_:)): return controller != nil
        default: return true
        }
    }

    public override func menu(for event: NSEvent) -> NSMenu? {
        guard controller?.hasSelection == true else { return nil }
        window?.makeFirstResponder(self)
        let menu = NSMenu()
        menu.addItem(withTitle: "Copy", action: #selector(copy(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "Select All", action: #selector(selectAll(_:)), keyEquivalent: "")
        return menu
    }

    // MARK: Focus

    public override func becomeFirstResponder() -> Bool {
        controller?.setEmphasized(window?.isKeyWindow ?? true)
        return true
    }

    public override func resignFirstResponder() -> Bool {
        controller?.setEmphasized(false)
        return true
    }

    public override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        windowObservers.forEach(NotificationCenter.default.removeObserver)
        windowObservers = []
        guard let window else { return }
        // After the hierarchy settles: the scroll view is an ancestor only once SwiftUI has finished inserting this.
        DispatchQueue.main.async { [weak self] in self?.watchScrolling() }
        for name in [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification] {
            windowObservers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, let window = self.window else { return }
                    self.controller?.setEmphasized(window.isKeyWindow && window.firstResponder === self)
                }
            })
        }
    }

    // The surface is not something to read: VoiceOver reads the conversation's own texts under it.
    public override func isAccessibilityElement() -> Bool { false }

    // MARK: Dragging past the edge

    /// While a drag is past the top or bottom of what is showing, the conversation scrolls under it, faster the further
    /// past, and the selection follows.
    private func startAutoscroll() {
        guard autoscrollTimer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.autoscrollStep() }
        }
        RunLoop.main.add(timer, forMode: .common)
        autoscrollTimer = timer
    }

    func stopAutoscroll() {
        autoscrollTimer?.invalidate()
        autoscrollTimer = nil
    }

    private func autoscrollStep() {
        guard let controller, controller.isPressing, let lastDrag, let scrollView = enclosingScrollView,
              let document = scrollView.documentView else { stopAutoscroll(); return }
        let clip = scrollView.contentView
        let pointer = clip.convert(lastDrag, from: nil)
        let visible = clip.bounds
        let past: CGFloat = pointer.y < visible.minY ? pointer.y - visible.minY : (pointer.y > visible.maxY ? pointer.y - visible.maxY : 0)
        guard past != 0 else { return }
        // Flipped (SwiftUI's document is): up the screen is down the offset.
        let step = (past < 0 ? -1 : 1) * min(max(abs(past) * 0.35, 3), 48)
        let maxY = max(0, document.bounds.height - visible.height)
        let y = min(max(visible.origin.y + step, 0), maxY)
        guard y != visible.origin.y else { return }
        clip.scroll(to: NSPoint(x: visible.origin.x, y: y))
        scrollView.reflectScrolledClipView(clip)
        controller.drag(to: convert(lastDrag, from: nil))
    }
}
#endif
