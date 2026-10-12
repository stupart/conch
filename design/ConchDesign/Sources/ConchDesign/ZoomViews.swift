#if os(macOS)
import AppKit
import SwiftUI

// Zoom on a deliverable, on the Mac: the model between a view that draws the content and the control and keys that
// zoom it (`ZoomTarget`), the control (`ZoomControl`, `ZoomOverlay`), the keys (`ZoomKeys`), and a text view that
// zooms (`ZoomingTextScrollView`). The arithmetic is ContentZoom.swift's.

extension EnvironmentValues {
    /// The zoom of the deliverable a view draws, set by the pane around it: the renderer below attaches itself to it
    /// (`ZoomTarget.attach`), as it finds the review its marks are for. Nil draws no zoom.
    @Entry public var conchZoomTarget: ZoomTarget? = nil
}

/// One deliverable's zoom, between the AppKit view that draws it and the control and keys that change it.
///
/// The view attaches itself with what it does with an action (`attach`), and reports where it is after every change
/// (`report`); the control reads `readout`, and the keys find it by where its view is on screen (`ZoomKeys`).
@MainActor
public final class ZoomTarget: ObservableObject {
    /// Where it is, as the control shows it; nil until the view has drawn it, and the control is not drawn till then.
    @Published public private(set) var readout: ZoomReadout?
    /// The pointer is over it: when the control shows at rest.
    @Published public private(set) var isHovering = false

    /// The view drawing the content: what the keys aim at by where it is on screen.
    public private(set) weak var view: NSView?
    /// When it was last zoomed, clicked or pointed at: the keys' second choice, after the one under the pointer.
    public private(set) var touched: Date?
    private var handler: ((ZoomAction) -> Void)?
    private var hover: HoverWatch?
    private var pending: ZoomReadout?

    public init() {}

    /// The view that draws the content, and what it does with an action. From `makeNSView`.
    public func attach(_ view: NSView, perform: @escaping (ZoomAction) -> Void) {
        self.view = view
        handler = perform
        hover?.detach()
        hover = HoverWatch(view) { [weak self] inside in
            guard let self else { return }
            if inside { self.touch() }
            if self.isHovering != inside { self.isHovering = inside }
        }
        ZoomKeys.register(self)
    }

    /// Zoom: from a key, the control, or the view's own double-click.
    public func zoom(_ action: ZoomAction) {
        touch()
        handler?(action)
    }

    /// Where it is now. Published on the next turn of the main queue, once: a view reports from `layout()`, which can run
    /// inside SwiftUI's own update, and SwiftUI does not take changes from there.
    public func report(_ readout: ZoomReadout) {
        guard readout != (pending ?? self.readout) else { return }
        pending = readout
        DispatchQueue.main.async { [weak self] in
            guard let self, let pending = self.pending else { return }
            self.pending = nil
            if self.readout != pending { self.readout = pending }
        }
    }

    /// Pinched or clicked in: the one the keys go to next, wherever the pointer has gone since.
    public func touch() {
        touched = Date()
    }

    /// Whether it is on screen in `window`, and where, in the window's coordinates: what the keys can aim at.
    func frame(in window: NSWindow) -> CGRect? {
        guard let view, view.window === window, !view.isHiddenOrHasHiddenAncestor else { return nil }
        let visible = view.visibleRect
        guard visible.width >= 1, visible.height >= 1 else { return nil }
        return view.convert(visible, to: nil)
    }
}

/// Whether the pointer is over a view, without being the view: an owner of its own for one tracking area, so a web
/// view's own entered and exited events are never sent twice or taken from it.
@MainActor
final class HoverWatch: NSResponder {
    private weak var view: NSView?
    private var area: NSTrackingArea?
    private let onChange: (Bool) -> Void

    init(_ view: NSView, onChange: @escaping (Bool) -> Void) {
        self.view = view
        self.onChange = onChange
        super.init()
        // The visible rect, kept up by AppKit as the view moves and scrolls; mouse moves too, so a view that appears
        // under a still pointer knows it the first time the pointer stirs.
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeInActiveApp, .inVisibleRect], owner: self)
        view.addTrackingArea(area)
        self.area = area
    }

    required init?(coder: NSCoder) { nil }

    func detach() {
        if let area { view?.removeTrackingArea(area) }
        area = nil
    }

    override func mouseEntered(with event: NSEvent) { onChange(true) }
    override func mouseMoved(with event: NSEvent) { onChange(true) }
    override func mouseExited(with event: NSEvent) { onChange(false) }
}

/// ⌘+, ⌘− and ⌘0 for whichever deliverable is in front: the one under the pointer, else the one last zoomed or pointed
/// at, else the biggest (`ZoomAim.pick`). Wherever the keyboard is, the message box included: it usually has it.
///
/// ⌘0 is taken only from a deliverable that is zoomed. It is also Session ▸ Lagoon, and a deliverable already where it
/// opened has nothing to go back to, so there the key goes on to the menu as before.
@MainActor
public enum ZoomKeys {
    private struct Held {
        weak var target: ZoomTarget?
    }

    private static var held: [Held] = []
    private static var monitor: Any?

    static func register(_ target: ZoomTarget) {
        held.removeAll { $0.target == nil || $0.target === target }
        held.append(Held(target: target))
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            let passed = Passed(event: event)
            // AppKit hands local monitors their events on the main thread.
            let taken = MainActor.assumeIsolated { handle(passed.event) }
            return taken ? nil : event
        }
    }

    /// An event handed from the monitor to the main actor it is already on.
    private struct Passed: @unchecked Sendable {
        let event: NSEvent
    }

    /// Whether the key zoomed something, and so is taken; otherwise it goes on untouched.
    static func handle(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard let action = ZoomAim.action(
            characters: event.charactersIgnoringModifiers,
            keyCode: event.keyCode,
            command: flags.contains(.command),
            control: flags.contains(.control),
            option: flags.contains(.option)
        ), let window = event.window ?? NSApp.keyWindow else { return false }
        guard let target = aim(in: window) else { return false }
        if action == .reset, target.readout?.isAtRest != false { return false }
        target.zoom(action)
        return true
    }

    /// The deliverable the keys zoom in `window`, if one is showing there.
    public static func aim(in window: NSWindow) -> ZoomTarget? {
        held.removeAll { $0.target == nil }
        let shown = held.compactMap { held -> (ZoomTarget, CGRect)? in
            guard let target = held.target, let frame = target.frame(in: window) else { return nil }
            return (target, frame)
        }
        let index = ZoomAim.pick(shown.map { (frame: $0.1, touched: $0.0.touched) }, pointer: window.mouseLocationOutsideOfEventStream)
        return index.map { shown[$0].0 }
    }
}

/// The zoom control: − , where it is, +. The middle goes from where it opened to 100% and back (`ZoomAction.toggle`),
/// as a double-click on a picture does. Drawn as the pane's corner buttons are, at their size: 28 high, the raised
/// fill a little translucent, a hairline round it.
public struct ZoomControl: View {
    private let readout: ZoomReadout
    private let perform: (ZoomAction) -> Void

    /// As tall as the pane's corner buttons, and each end as wide: a square for − and +.
    public static let height: CGFloat = 28
    /// Wide enough for "800%" without moving the ends as the number changes.
    public static let labelWidth: CGFloat = 44
    public static var width: CGFloat { 2 * height + labelWidth }

    public init(readout: ZoomReadout, perform: @escaping (ZoomAction) -> Void) {
        self.readout = readout
        self.perform = perform
    }

    public var body: some View {
        HStack(spacing: 0) {
            end(symbol: "minus", action: .zoomOut, enabled: readout.canZoomOut, help: "Zoom out (⌘−)", label: "Zoom out")
            Button { perform(.toggle) } label: {
                Text(readout.label)
                    .font(.system(size: 11, weight: .medium).monospacedDigit())
                    .foregroundStyle(ConchColor.textSecondary)
                    .lineLimit(1)
                    .frame(width: Self.labelWidth, height: Self.height)
                    .contentShape(Rectangle())
            }
            .buttonStyle(ZoomPress())
            .disabled(!readout.canToggle)
            .help(readout.toggleHelp)
            .accessibilityLabel(readout.toggleHelp)
            .accessibilityValue(readout.spoken)
            end(symbol: "plus", action: .zoomIn, enabled: readout.canZoomIn, help: "Zoom in (⌘+)", label: "Zoom in")
        }
        .frame(width: Self.width, height: Self.height)
        .background(Capsule().fill(ConchColor.surfaceRaised.opacity(0.92)))
        .overlay(Capsule().strokeBorder(ConchColor.hairline, lineWidth: 0.5))
        .clipShape(Capsule())
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Zoom, \(readout.spoken)")
    }

    private func end(symbol: String, action: ZoomAction, enabled: Bool, help: String, label: String) -> some View {
        Button { perform(action) } label: {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(ConchColor.textSecondary)
                .opacity(enabled ? 1 : 0.35)
                .frame(width: Self.height, height: Self.height)
                .contentShape(Rectangle())
        }
        .buttonStyle(ZoomPress())
        .disabled(!enabled)
        .help(help)
        .accessibilityLabel(label)
    }
}

/// A pressed part of the control: the row-hover wash, as the pane's other buttons press.
private struct ZoomPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? AnyShapeStyle(ConchColor.rowHover) : AnyShapeStyle(Color.clear))
    }
}

/// The zoom control where a deliverable shows it: its bottom right corner, 10 in, as the corner buttons sit at its top
/// right. Only while the pointer is over the deliverable, or it is zoomed: at rest and unpointed-at, the work is all
/// there is.
public struct ZoomOverlay: View {
    @ObservedObject private var target: ZoomTarget
    @State private var overControl = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The control's inset from the pane's edges: the corner buttons' own.
    public static let inset: CGFloat = 10

    public init(target: ZoomTarget) {
        self.target = target
    }

    private var shows: Bool {
        guard let readout = target.readout else { return false }
        return target.isHovering || overControl || !readout.isAtRest
    }

    public var body: some View {
        Group {
            if let readout = target.readout {
                ZoomControl(readout: readout) { target.zoom($0) }
                    .onHover { overControl = $0 }
                    .opacity(shows ? 1 : 0)
                    .allowsHitTesting(shows)
                    .padding(Self.inset)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: shows)
    }
}

/// A text's scroll view that zooms: pinched, or by the keys and the control, with the text wrapped to the pane at every
/// scale, not run off its right edge, and the line at the top kept at the top as it rewraps.
///
/// AppKit's own magnification, so the type is drawn sharp at every scale, and a table or an inset grows with the words.
open class ZoomingTextScrollView: NSScrollView {
    public let rules = ContentZoom.text
    /// Where it is, after every change: for the control.
    public var onZoom: ((ZoomReadout) -> Void)?

    public override init(frame: NSRect) {
        super.init(frame: frame)
        allowsMagnification = true
        minMagnification = rules.range.lowerBound
        maxMagnification = rules.range.upperBound
        NotificationCenter.default.addObserver(self, selector: #selector(liveMagnifyEnded), name: NSScrollView.didEndLiveMagnifyNotification, object: self)
    }

    public required init?(coder: NSCoder) { nil }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    /// Where it is: 100%, or a scale of it.
    public var level: ZoomLevel {
        abs(magnification - 1) < 0.001 ? .rest : .scale(magnification)
    }

    public var readout: ZoomReadout { rules.readout(level, resting: 1) }

    public func zoom(_ action: ZoomAction) {
        guard let next = rules.level(after: action, from: level, resting: 1) else { return }
        apply(next)
    }

    /// Set the scale, rewrap, and keep the line that was at the top at the top.
    public func apply(_ level: ZoomLevel) {
        let top = topCharacter()
        magnification = rules.clamped(level.scale(resting: 1), resting: 1)
        reflow(keeping: top)
        onZoom?(readout)
    }

    open override func magnify(with event: NSEvent) {
        super.magnify(with: event)
        onZoom?(readout)
    }

    /// Where the fingers left it stays (2026-10-12, Tyler: "u zoom to one size visually and when your done it like
    /// snaps to another position"). It used to settle on 100% when near, and scroll back to the line that had been at
    /// the top: both moved what he had just put under his fingers. The text rewraps as the pinch goes (`tile()`), so
    /// there is nothing left to do but say where it is.
    @objc private func liveMagnifyEnded() {
        onZoom?(readout)
    }

    open override func tile() {
        super.tile()
        reflow(keeping: nil)
    }

    /// The text as wide as the pane shows at this scale (the clip view's bounds), so it wraps there; and, given the
    /// character that was at the top, scrolled back to its line. Rewrapped already, by the `tile()` a change of scale
    /// runs inside it, it still scrolls.
    func reflow(keeping top: Int?) {
        guard let text = documentView as? NSTextView else { return }
        let width = contentView.bounds.width
        guard width > 0 else { return }
        if abs(text.frame.width - width) > 0.5 {
            text.setFrameSize(NSSize(width: width, height: text.frame.height))
        }
        guard let top, let layout = text.layoutManager, top < layout.numberOfGlyphs else { return }
        // Laid out only as far as the line that was at the top: a 2MB text rewrapped whole would stall the zoom.
        let glyph = layout.glyphIndexForCharacter(at: top)
        layout.ensureLayout(forGlyphRange: NSRange(location: 0, length: glyph + 1))
        let line = layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        let y = line.minY + text.textContainerOrigin.y
        contentView.scroll(to: NSPoint(x: 0, y: max(0, y)))
        reflectScrolledClipView(contentView)
    }

    /// The first character of the line at the top of what shows.
    private func topCharacter() -> Int? {
        guard let text = documentView as? NSTextView, let layout = text.layoutManager, let container = text.textContainer,
              layout.numberOfGlyphs > 0 else { return nil }
        let visible = documentVisibleRect
        // Past the inset: a point at the very top is in it, above the first line.
        let point = NSPoint(x: text.textContainerOrigin.x, y: max(visible.minY - text.textContainerOrigin.y, 0) + 1)
        let glyph = layout.glyphIndex(for: point, in: container)
        let range = layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        // The line below when the top one is mostly scrolled past.
        if range.maxY + text.textContainerOrigin.y < visible.minY + range.height / 2, glyph + 1 < layout.numberOfGlyphs {
            var lineRange = NSRange()
            layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: &lineRange)
            return layout.characterIndexForGlyph(at: min(NSMaxRange(lineRange), layout.numberOfGlyphs - 1))
        }
        return layout.characterIndexForGlyph(at: glyph)
    }
}
#endif
