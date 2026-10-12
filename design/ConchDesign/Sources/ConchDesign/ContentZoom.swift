import CoreGraphics
import Foundation

// Zoom on a deliverable: a picture, a PDF, a page or a text in the review pane (Tyler, 2026-10-12: "make it so I can
// zoom in on items in the deliverables place that are images or files"). The arithmetic is here, where it is tested;
// the Mac's views (ReviewView.swift, WebView.swift) and the control and keys (ZoomViews.swift) only apply it.

/// What a zoom key, the zoom control or a double-click asks of a deliverable.
public enum ZoomAction: Equatable, Sendable {
    /// ⌘+, and the control's +.
    case zoomIn
    /// ⌘−, and the control's −.
    case zoomOut
    /// ⌘0: back to where it opened, fitted (a picture, a PDF) or at 100% (a page, a text).
    case reset
    /// A double-click on a picture, and the control's middle: from where it opened to 100% (200% for a picture that
    /// already opens at its own size), and from anywhere else back again.
    case toggle
}

/// How far in a deliverable is drawn: where it opened (`rest`), or a scale of its own size, 1 being 100%.
///
/// `rest` is not a number, because for a picture or a PDF it is "fitted to the pane", and that number moves with the
/// pane: a fitted picture stays fitted as the window is resized, where a remembered 53% would not.
public enum ZoomLevel: Equatable, Sendable {
    case rest
    case scale(CGFloat)

    public var isRest: Bool { self == .rest }

    /// The scale it is drawn at, given the scale at rest.
    public func scale(resting fit: CGFloat) -> CGFloat {
        switch self {
        case .rest: fit
        case let .scale(scale): scale
        }
    }
}

/// The zoom rules for one kind of content: how far in and out it goes, and whether it rests fitted to the pane.
public struct ContentZoom: Equatable, Sendable {
    /// The scales ⌘+ and ⌘− step through: a browser's, finer near 100%, out to Preview's 800%.
    public static let steps: [CGFloat] = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8]

    /// How far it goes, as scales of its own size. The fitted scale is always inside it too (`range(resting:)`).
    public let range: ClosedRange<CGFloat>
    /// Whether it rests fitted to the pane (a picture, a PDF) rather than at 100% (a page, a text): what ⌘0 and the
    /// control's "Fit" go back to.
    public let fits: Bool

    public init(range: ClosedRange<CGFloat>, fits: Bool) {
        self.range = range
        self.fits = fits
    }

    /// A picture: fitted to the pane's width as it opens (never upscaled), from 10% to 800% of its own size.
    public static let picture = ContentZoom(range: 0.1...8, fits: true)
    /// A PDF: fitted to the pane's width as it opens, as PDFKit's own auto scale has it.
    public static let pdf = ContentZoom(range: 0.1...8, fits: true)
    /// A web page: Safari's 50% to 300%, reflowed, at 100% as it opens.
    public static let page = ContentZoom(range: 0.5...3, fits: false)
    /// A markdown or plain text: as a page, wrapped to the pane at every scale.
    public static let text = ContentZoom(range: 0.5...3, fits: false)

    /// Two scales this close are one: a pinch that ends 3% off fitted has ended fitted.
    static let snap: CGFloat = 0.04
    /// Steps closer than this to where it is are not a step.
    static let epsilon: CGFloat = 0.005
    /// Steps this close to the fitted scale give way to it: from fitted at 66%, ⌘+ goes to 75%, not to a 67% nobody
    /// could tell from where it was.
    static let crowd: CGFloat = 0.05

    /// The range with the fitted scale in it: a 20,000-point panorama fits a pane at 3%, and ⌘0 must be able to put it
    /// there.
    public func range(resting fit: CGFloat) -> ClosedRange<CGFloat> {
        min(range.lowerBound, fit)...max(range.upperBound, fit)
    }

    public func clamped(_ scale: CGFloat, resting fit: CGFloat) -> CGFloat {
        let bounds = range(resting: fit)
        guard scale.isFinite else { return fit }
        return min(max(scale, bounds.lowerBound), bounds.upperBound)
    }

    /// The level after `action`, from `level`, with `fit` the scale at rest. Nil when it does nothing: a toggle on a page
    /// already at 100%, which has nowhere to go.
    public func level(after action: ZoomAction, from level: ZoomLevel, resting fit: CGFloat) -> ZoomLevel? {
        switch action {
        case .zoomIn: stepped(1, from: level, resting: fit)
        case .zoomOut: stepped(-1, from: level, resting: fit)
        case .reset: .rest
        case .toggle: toggled(from: level, resting: fit)
        }
    }

    /// One step in (`direction` 1) or out (−1). Rest is a step too, so ⌘+ and ⌘− pass through Fit on their way; at the
    /// end of the range they stay where they are.
    public func stepped(_ direction: Int, from level: ZoomLevel, resting fit: CGFloat) -> ZoomLevel {
        let current = level.scale(resting: fit)
        let bounds = range(resting: fit)
        let stops = (Self.steps.filter { bounds.contains($0) && !Self.near($0, fit, within: Self.crowd) } + [fit]).sorted()
        let next: CGFloat?
        if direction > 0 {
            next = stops.first { $0 > current * (1 + Self.epsilon) }
        } else {
            next = stops.last { $0 < current * (1 - Self.epsilon) }
        }
        guard let next else { return level }
        return Self.near(next, fit) ? .rest : .scale(next)
    }

    /// A pinch's `magnification` (AppKit's, 0 for none) applied to where it is: the scale it is drawn at while the
    /// fingers move. Never `rest` mid-pinch; `settled` decides that once they lift.
    public func pinched(_ level: ZoomLevel, by magnification: CGFloat, resting fit: CGFloat) -> ZoomLevel {
        .scale(clamped(level.scale(resting: fit) * (1 + magnification), resting: fit))
    }

    /// Where a pinch comes to rest: on fitted, or on 100%, when it ended within a few percent of either.
    public func settled(_ level: ZoomLevel, resting fit: CGFloat) -> ZoomLevel {
        guard case let .scale(scale) = level else { return level }
        if Self.near(scale, fit) { return .rest }
        if Self.near(scale, 1) { return .scale(1) }
        return level
    }

    /// From rest to 100% (or 200%, for what already rests at 100%), and from anywhere else back to rest. A page or a
    /// text rests at 100%, so at rest it has nowhere to toggle to.
    public func toggled(from level: ZoomLevel, resting fit: CGFloat) -> ZoomLevel? {
        guard level.isRest else { return .rest }
        guard let target = toggleTarget(resting: fit) else { return nil }
        return .scale(target)
    }

    /// Where a toggle at rest goes: 100%, or 200% where rest is already about 100%. None for what rests at 100%.
    public func toggleTarget(resting fit: CGFloat) -> CGFloat? {
        guard fits else { return nil }
        return clamped(fit < 1 - Self.snap ? 1 : 2, resting: fit)
    }

    /// What the control shows, and which of its buttons do anything.
    public func readout(_ level: ZoomLevel, resting fit: CGFloat) -> ZoomReadout {
        let scale = level.scale(resting: fit)
        let bounds = range(resting: fit)
        return ZoomReadout(
            scale: scale,
            isAtRest: level.isRest,
            fits: fits,
            canZoomIn: scale < bounds.upperBound * (1 - Self.epsilon),
            canZoomOut: scale > bounds.lowerBound * (1 + Self.epsilon),
            toggleTarget: level.isRest ? toggleTarget(resting: fit) : nil
        )
    }

    static func near(_ a: CGFloat, _ b: CGFloat, within tolerance: CGFloat = snap) -> Bool {
        guard b > 0 else { return a == b }
        return abs(a - b) / b <= tolerance
    }
}

/// A deliverable's zoom as the control shows it.
public struct ZoomReadout: Equatable, Sendable {
    /// The scale it is drawn at, 1 being 100%.
    public let scale: CGFloat
    /// Where it opened: fitted, or 100%.
    public let isAtRest: Bool
    /// Whether rest is "fitted" (a picture, a PDF) rather than 100% (a page, a text).
    public let fits: Bool
    public let canZoomIn: Bool
    public let canZoomOut: Bool
    /// Where the control's middle goes from rest; nil when it has nowhere to go, and away from rest (where it goes back).
    public let toggleTarget: CGFloat?

    public init(scale: CGFloat, isAtRest: Bool, fits: Bool, canZoomIn: Bool, canZoomOut: Bool, toggleTarget: CGFloat?) {
        self.scale = scale
        self.isAtRest = isAtRest
        self.fits = fits
        self.canZoomIn = canZoomIn
        self.canZoomOut = canZoomOut
        self.toggleTarget = toggleTarget
    }

    /// "Fit" at rest for what fits, else the percent: "53%", "100%", "250%".
    public var label: String { isAtRest && fits ? "Fit" : Self.percent(scale) }

    /// Whether the control's middle does anything: back to rest, or from rest to `toggleTarget`.
    public var canToggle: Bool { !isAtRest || toggleTarget != nil }

    /// The middle's tooltip, naming its key where it has one.
    public var toggleHelp: String {
        if !isAtRest { return fits ? "Zoom to fit (⌘0)" : "Back to 100% (⌘0)" }
        return toggleTarget.map { "Zoom to \(Self.percent($0))" } ?? "Actual size"
    }

    /// What VoiceOver reads for the zoom.
    public var spoken: String { isAtRest && fits ? "Fitted, \(Self.percent(scale))" : Self.percent(scale) }

    public static func percent(_ scale: CGFloat) -> String {
        "\(Int((scale * 100).rounded()))%"
    }
}

/// Where to scroll so the point of the content under the pointer stays under it as the content grows or shrinks: what
/// makes a pinch, a double-click or a key zoom INTO something rather than away from it.
public enum ZoomAnchor {
    /// The visible rect's new origin, in the document's coordinates (y down).
    ///
    /// - `anchor`: the point zoomed about, in the document's coordinates before the zoom.
    /// - `visibleOrigin`: the visible rect's origin before it.
    /// - `before`, `after`: the content's frame in the document, before and after.
    /// - `document`, `visible`: the document's size after, and the visible rect's size.
    public static func origin(
        keeping anchor: CGPoint,
        visibleOrigin: CGPoint,
        from before: CGRect,
        to after: CGRect,
        document: CGSize,
        visible: CGSize
    ) -> CGPoint {
        func axis(_ point: CGFloat, _ origin: CGFloat, _ from: (CGFloat, CGFloat), _ to: (CGFloat, CGFloat), _ extent: CGFloat, _ window: CGFloat) -> CGFloat {
            let onScreen = point - origin
            let fraction = from.1 > 0 ? (point - from.0) / from.1 : 0.5
            let moved = to.0 + fraction * to.1
            return min(max(moved - onScreen, 0), max(extent - window, 0))
        }
        return CGPoint(
            x: axis(anchor.x, visibleOrigin.x, (before.minX, before.width), (after.minX, after.width), document.width, visible.width),
            y: axis(anchor.y, visibleOrigin.y, (before.minY, before.height), (after.minY, after.height), document.height, visible.height)
        )
    }
}

/// Which of the deliverables on screen ⌘+, ⌘− and ⌘0 zoom: two at once in a comparison, or a folder's preview beside a
/// page in the panel.
public enum ZoomAim {
    /// The index of the one to zoom: the one under the pointer; else the one last zoomed, clicked or pinched; else the
    /// biggest on screen. Nil with none.
    public static func pick(_ candidates: [(frame: CGRect, touched: Date?)], pointer: CGPoint) -> Int? {
        guard !candidates.isEmpty else { return nil }
        if let under = candidates.firstIndex(where: { $0.frame.contains(pointer) }) { return under }
        let touched = candidates.indices.filter { candidates[$0].touched != nil }
        if let last = touched.max(by: { candidates[$0].touched! < candidates[$1].touched! }) { return last }
        return candidates.indices.max { candidates[$0].frame.width * candidates[$0].frame.height < candidates[$1].frame.width * candidates[$1].frame.height }
    }

    /// The zoom a key asks for, from what the key types without its modifiers and its key code: ⌘= and ⌘+ in, ⌘− out,
    /// ⌘0 back, the keypad's too. Nil for anything else, and for any of them with ⌃ or ⌥ held.
    public static func action(characters: String?, keyCode: UInt16, command: Bool, control: Bool, option: Bool) -> ZoomAction? {
        guard command, !control, !option else { return nil }
        switch keyCode {
        case 69: return .zoomIn // keypad +
        case 78: return .zoomOut // keypad −
        case 82: return .reset // keypad 0
        default: break
        }
        switch characters {
        case "=", "+": return .zoomIn
        case "-": return .zoomOut
        case "0": return .reset
        default: return nil
        }
    }
}
