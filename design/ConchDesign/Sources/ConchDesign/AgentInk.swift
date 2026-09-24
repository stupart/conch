import CoreGraphics
import Foundation

/// Agent ink: the marks an agent published over its result (`scene.marks`), as canvas marks in Tyler's canvas, so his ink
/// and the agent's are one document drawn by one builder (`CanvasInk`). This is the geometry, pure: an agent's numbers
/// mapped onto what they are fractions of, and a mark placed on something conch found (a selector's element, a quote's
/// words), in a display's own 0-1 space, top left, y down. Where on screen those things are is the Mac app's to find.
public enum AgentInk {
    /// The kinds an agent draws (`REVIEW_MARK_KINDS`).
    public enum Kind: String, CaseIterable, Sendable {
        case arrow, box, ellipse, highlight, text, pin, stroke
    }

    /// A mark whose numbers are 0 to 1 of `frame`, itself a rect in the display's 0-1 space: a canvas (the whole display
    /// it was drawn on) or an image (where conch shows it). Nil when the mark lacks the geometry its kind takes: the daemon
    /// checked it, but nothing is ever drawn at a guessed position.
    public static func mark(
        id: String, kind: Kind, label: String?,
        at: CGPoint?, to: CGPoint?, rect: CGRect?, pts: [CGPoint],
        in frame: CGRect
    ) -> CanvasMark? {
        // An agent's line is even: a full pressure, where a mouse's would be read from its speed.
        func map(_ point: CGPoint) -> CanvasPoint {
            CanvasPoint(x: Double(frame.minX + point.x * frame.width), y: Double(frame.minY + point.y * frame.height), p: 1)
        }
        func mark(_ kind: CanvasMark.Kind, _ points: [CGPoint]) -> CanvasMark {
            CanvasMark(kind: kind, author: .agent, points: points.map(map), text: label, id: id)
        }
        switch kind {
        case .arrow:
            guard let at, let to else { return nil }
            return mark(.arrow, [at, to])
        case .box, .ellipse, .highlight:
            guard let rect, rect.width > 0, rect.height > 0 else { return nil }
            return mark(canvasKind(kind), [rect.origin, CGPoint(x: rect.maxX, y: rect.maxY)])
        case .pin:
            guard let at else { return nil }
            return mark(.note, [at])
        case .text:
            guard let at, label?.isEmpty == false else { return nil }
            return mark(.text, [at])
        case .stroke:
            guard pts.count >= 2 else { return nil }
            return mark(.pen, pts)
        }
    }

    /// Room, in points, round what a box or an ellipse is drawn about (panel-lab's `agentInk`: 10 across, 8 down).
    static let padding = CGSize(width: 10, height: 8)
    /// How far an arrow's tail stands off what it points at, across and down (the lab's 150 and 70).
    static let reach = CGSize(width: 150, height: 70)
    /// How close to a display's edge a placed mark may come.
    static let margin: CGFloat = 40

    /// A mark conch places itself, on something it found: `element` in the display's 0-1 space, the display `size`
    /// points across. A box or an ellipse padded round it, a highlight over it, an arrow from clear space beside it
    /// pointing in, a pin on its top right corner, text under it. Nil for a stroke, which is its own points and so is
    /// drawn on a canvas or an image, never on an element.
    public static func mark(id: String, kind: Kind, label: String?, on element: CGRect, size: CGSize) -> CanvasMark? {
        guard size.width > 0, size.height > 0, element.width > 0, element.height > 0 else { return nil }
        let found = CGRect(x: element.minX * size.width, y: element.minY * size.height, width: element.width * size.width, height: element.height * size.height)
        let room = CGRect(origin: .zero, size: size).insetBy(dx: margin, dy: margin)
        func clamp(_ point: CGPoint) -> CGPoint {
            CGPoint(x: min(max(point.x, room.minX), room.maxX), y: min(max(point.y, room.minY), room.maxY))
        }
        let points: [CGPoint]
        switch kind {
        case .box, .ellipse:
            let around = found.insetBy(dx: -padding.width, dy: -padding.height)
            points = [around.origin, CGPoint(x: around.maxX, y: around.maxY)]
        case .highlight:
            let over = found.insetBy(dx: -3, dy: -2)
            points = [over.origin, CGPoint(x: over.maxX, y: over.maxY)]
        case .arrow:
            // From whichever side has room, down and out; up and out if below is the screen's edge.
            let right = size.width - found.maxX >= found.minX
            let head = CGPoint(x: right ? found.maxX + 8 : found.minX - 8, y: found.midY)
            var tail = clamp(CGPoint(x: right ? found.maxX + reach.width : found.minX - reach.width, y: found.maxY + reach.height))
            if found.insetBy(dx: -8, dy: -8).contains(tail) { tail = clamp(CGPoint(x: tail.x, y: found.minY - reach.height)) }
            points = [tail, head]
        case .pin:
            // Its sharper corner on the element's top right, its badge above it; under the top edge, on the element.
            points = [CGPoint(x: min(found.maxX, size.width - CanvasInk.pinSide), y: max(found.minY, CanvasInk.pinSide))]
        case .text:
            guard label?.isEmpty == false else { return nil }
            points = [clamp(CGPoint(x: found.minX, y: found.maxY + 8))]
        case .stroke:
            return nil
        }
        return CanvasMark(
            kind: canvasKind(kind),
            author: .agent,
            points: points.map { CanvasPoint(x: Double($0.x / size.width), y: Double($0.y / size.height), p: 1) },
            text: label,
            id: id
        )
    }

    static func canvasKind(_ kind: Kind) -> CanvasMark.Kind {
        switch kind {
        case .arrow: .arrow
        case .box: .box
        case .ellipse: .ellipse
        case .highlight: .area
        case .text: .text
        case .pin: .note
        case .stroke: .pen
        }
    }

    /// What a page says about its own viewport, for turning its client rects into the web view's points.
    public struct Viewport: Equatable, Sendable {
        /// `visualViewport`'s offset into the layout viewport, and its pinch scale.
        public var left: CGFloat
        public var top: CGFloat
        public var scale: CGFloat
        /// `innerWidth`: the layout viewport, in CSS pixels.
        public var width: CGFloat

        public init(left: CGFloat = 0, top: CGFloat = 0, scale: CGFloat = 1, width: CGFloat) {
            self.left = left
            self.top = top
            self.scale = scale
            self.width = width
        }
    }

    /// A `getBoundingClientRect` in the web view's own points, top left: CSS pixels relative to the layout viewport, less
    /// the visual viewport's offset, times its pinch scale and the view's points per CSS pixel (the page zoom).
    public static func viewRect(client: CGRect, viewport: Viewport, viewWidth: CGFloat) -> CGRect {
        guard viewport.width > 0 else { return .null }
        let k = viewport.scale * viewWidth / viewport.width
        return CGRect(x: (client.minX - viewport.left) * k, y: (client.minY - viewport.top) * k, width: client.width * k, height: client.height * k)
    }

    /// A rect in AppKit's screen coordinates (y up) as 0-1 of `display`, top left, y down: the space a canvas's marks live
    /// in.
    public static func unit(_ screen: CGRect, on display: CGRect) -> CGRect {
        guard display.width > 0, display.height > 0 else { return .null }
        return CGRect(
            x: (screen.minX - display.minX) / display.width,
            y: (display.maxY - screen.maxY) / display.height,
            width: screen.width / display.width,
            height: screen.height / display.height
        )
    }
}
