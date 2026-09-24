import CoreGraphics
import CoreText
import Foundation
import ImageIO

// The canvas (wave 2): a clear sheet over whatever is on screen that Tyler, and later an agent, draws on. Tyler: "transparent
// canvas that both the ai and the user can write to over top of what they're looking at". This is its data and its one
// path builder, pure, so what is on screen and the picture an agent is sent are drawn from the same thing. The research it
// follows is ~/Projects/conch-design/canvas-research-2026-09-25.md; the feel is panel-lab.html's.

// MARK: - The document

/// One canvas: its marks, kept as data, and what they are drawn over.
public struct CanvasDocument: Codable, Equatable, Sendable {
    public var v = 1
    public let id: String
    /// Epoch-ms, when it was started.
    public let at: Double
    public let anchor: CanvasAnchor
    /// Oldest first, which is the order they are drawn in: the newest is on top, and is the one undo takes.
    public private(set) var marks: [CanvasMark] = []

    public init(anchor: CanvasAnchor, id: String = UUID().uuidString, at: Double = (Date().timeIntervalSince1970 * 1000).rounded()) {
        self.id = id
        self.at = at
        self.anchor = anchor
    }

    public var isEmpty: Bool { marks.isEmpty }

    public mutating func add(_ mark: CanvasMark) {
        marks.append(mark)
    }

    /// The newest mark taken off, if there is one.
    @discardableResult
    public mutating func undo() -> CanvasMark? {
        marks.popLast()
    }

    /// What a note says, as it is typed.
    public mutating func setText(_ text: String, of id: CanvasMark.ID) {
        guard let index = marks.firstIndex(where: { $0.id == id }) else { return }
        marks[index].text = text
    }

    /// A note's number on its pin, 1 up, counted among its author's notes in the order they were pinned.
    public func number(of note: CanvasMark) -> Int? {
        let notes = marks.filter { $0.kind == .note && $0.author == note.author }
        return notes.firstIndex { $0.id == note.id }.map { $0 + 1 }
    }

    /// The mark a note is pinned on, if any: the newest box it sits inside, or stroke or arrow it sits on, within `reach`
    /// points. Pinned in open space, it is about that place alone.
    public func target(of note: CanvasMark, reach: CGFloat = 24) -> CanvasMark? {
        guard let pin = note.points.first else { return nil }
        let size = anchor.frame.size
        let at = pin.point(in: size)
        return marks.last { mark in
            guard mark.kind != .note, mark.id != note.id, !mark.points.isEmpty else { return false }
            let points = mark.points.map { $0.point(in: size) }
            switch mark.kind {
            case .box:
                return mark.rect(in: size).insetBy(dx: -reach, dy: -reach).contains(at)
            case .highlight:
                return Self.distance(from: at, to: points) <= reach + CanvasInk.highlightWidth / 2
            default:
                return Self.distance(from: at, to: points) <= reach
            }
        }
    }

    /// How far `point` is from the nearest part of the line through `points`.
    static func distance(from point: CGPoint, to points: [CGPoint]) -> CGFloat {
        guard var previous = points.first else { return .infinity }
        var nearest = hypot(point.x - previous.x, point.y - previous.y)
        for next in points.dropFirst() {
            let dx = next.x - previous.x, dy = next.y - previous.y
            let length = dx * dx + dy * dy
            let t = length > 0 ? min(1, max(0, ((point.x - previous.x) * dx + (point.y - previous.y) * dy) / length)) : 0
            nearest = min(nearest, hypot(point.x - (previous.x + t * dx), point.y - (previous.y + t * dy)))
            previous = next
        }
        return nearest
    }
}

/// What a canvas's marks are relative to. Their points run 0 to 1 across and down it, so a canvas means the same at any
/// scale: on the display it was drawn on, and in the smaller picture an agent is sent.
public struct CanvasAnchor: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        /// A whole display. The research orders two stronger anchors ahead of it, so ink can follow what it was drawn on: a
        /// page conch renders itself (its scroll position), then the window underneath (its id and bounds). Each is a case
        /// here, its `frame` read the same way.
        case display
    }

    public let kind: Kind
    /// The display's `CGDirectDisplayID`.
    public let id: UInt32
    /// Where it is, in AppKit's screen points.
    public let frame: CGRect

    public init(kind: Kind = .display, id: UInt32, frame: CGRect) {
        self.kind = kind
        self.id = id
        self.frame = frame
    }
}

/// One mark: a stroke, a highlight, an arrow, a box or a numbered note.
public struct CanvasMark: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, CaseIterable, Sendable {
        case pen, highlight, arrow, box, note
    }

    public enum Author: String, Codable, Sendable {
        case you, agent
    }

    public let id: String
    public let kind: Kind
    public let author: Author
    /// 0 to 1 across and down the anchor, from its top left: a pen or highlight stroke's samples as they came, an arrow's
    /// tail then its head, a box's first corner then the opposite one, a note's pin.
    public var points: [CanvasPoint]
    /// What a note says.
    public var text: String?

    public init(kind: Kind, author: Author = .you, points: [CanvasPoint], text: String? = nil, id: String = UUID().uuidString) {
        self.id = id
        self.kind = kind
        self.author = author
        self.points = points
        self.text = text
    }

    /// The box between the first point and the last, in a space of `size`.
    public func rect(in size: CGSize) -> CGRect {
        guard let first = points.first?.point(in: size), let last = points.last?.point(in: size) else { return .null }
        return CGRect(x: min(first.x, last.x), y: min(first.y, last.y), width: abs(last.x - first.x), height: abs(last.y - first.y))
    }

    /// How far it reaches, in points of a space of `size`: a click that never moved is not an arrow or a box.
    public func extent(in size: CGSize) -> CGFloat {
        let rect = rect(in: size)
        return rect.isNull ? 0 : max(rect.width, rect.height)
    }
}

/// A point on a canvas, 0 to 1 across and down its anchor.
public struct CanvasPoint: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    /// A tablet's pressure, 0 to 1. Nil from a mouse or a trackpad, whose pressure is flat: the width comes from speed.
    public var p: Double?
    /// Seconds since the mark began.
    public var t: Double

    public init(x: Double, y: Double, p: Double? = nil, t: Double = 0) {
        self.x = x
        self.y = y
        self.p = p
        self.t = t
    }

    public func point(in size: CGSize) -> CGPoint {
        CGPoint(x: x * size.width, y: y * size.height)
    }
}

// MARK: - Ink

/// The one path builder. Every mark becomes a filled outline, whatever its kind — a stroke's is as wide as its pressure or
/// speed says at each point — so a CAShapeLayer on screen and the CGContext that draws the picture an agent is sent fill
/// the very same path. Coordinates are top left, y down, in the space the marks are drawn in: points on screen, pixels in
/// the picture.
public enum CanvasInk {
    /// The lab's `inkWidth`, `hlWidth` and box stroke, in points.
    public static let penWidth: CGFloat = 3.2
    public static let highlightWidth: CGFloat = 18
    public static let boxWidth: CGFloat = 2.4
    public static let boxRadius: CGFloat = 10
    /// A note's pin: a badge this big, its sharper bottom-left corner on the spot it marks.
    public static let pinSide: CGFloat = 24

    /// Tyler's ink and an agent's (panel-lab's `--you` and `--agent`); the highlighter's yellow, laid over what is under it.
    public static let you = ConchRGBA(0xFF6A3D)
    public static let agent = ConchRGBA(0x7C5CFF)
    public static let highlight = ConchRGBA(0xFFD60A, alpha: 0.42)
    /// Inside a box, the faintest wash of its colour.
    public static let washOpacity = 0.06

    public static func colour(_ author: CanvasMark.Author) -> ConchRGBA { author == .agent ? agent : you }

    /// What to fill: the mark in its colour, and under it a box's wash.
    public struct Shape {
        public let ink: CGPath
        public let wash: CGPath?
    }

    /// `mark` in a space of `size`, its widths in points times `scale` (the picture's pixels per screen point).
    public static func shape(of mark: CanvasMark, in size: CGSize, scale: CGFloat = 1) -> Shape {
        let points = mark.points.map { $0.point(in: size) }
        switch mark.kind {
        case .pen:
            return Shape(ink: stroke(mark.points, in: size, width: penWidth * scale, thinning: 0.5, scale: scale), wash: nil)
        case .highlight:
            // A marker's even line: no thinning.
            return Shape(ink: stroke(mark.points, in: size, width: highlightWidth * scale, thinning: 0, scale: scale), wash: nil)
        case .arrow:
            return Shape(ink: arrow(from: points.first ?? .zero, to: points.last ?? .zero, width: penWidth * scale), wash: nil)
        case .box:
            let rect = mark.rect(in: size)
            let radius = min(boxRadius * scale, rect.width / 2, rect.height / 2)
            let box = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
            return Shape(ink: box.copy(strokingWithWidth: boxWidth * scale, lineCap: .round, lineJoin: .round, miterLimit: 10), wash: box)
        case .note:
            return Shape(ink: pin(at: points.first ?? .zero, side: pinSide * scale), wash: nil)
        }
    }

    /// How much a sample moves toward where the pointer is, 0 to 1: the rest is the stroke before it, which takes out a
    /// hand's jitter. The lab's `inkSmoothing` 0.5, applied at 0.6.
    static let follow: CGFloat = 0.7
    /// A mouse's speed, in points a second, at which a pen stroke is at its thinnest.
    static let fastest: CGFloat = 1800

    /// A stroke's variable-width outline: the samples smoothed, each point as wide as its pressure — or, from a mouse or a
    /// trackpad, as its slowness — with round ends, as one closed shape. `thinning` is how much
    /// the width gives: 0 is an even line, 0.5 halves it at the lightest touch.
    public static func stroke(_ samples: [CanvasPoint], in size: CGSize, width: CGFloat, thinning: CGFloat, scale: CGFloat = 1) -> CGPath {
        var points: [CGPoint] = [], radii: [CGFloat] = []
        var pressure: CGFloat = 1, lastTime = samples.first?.t ?? 0
        for (index, sample) in samples.enumerated() {
            let raw = sample.point(in: size)
            // The last sample stands where the pen came up, unsmoothed, so the stroke ends there.
            let at = points.last.map { index == samples.count - 1 ? raw : $0 + (raw - $0) * follow } ?? raw
            if let last = points.last, hypot(at.x - last.x, at.y - last.y) < 0.5 * scale { continue }
            if let p = sample.p {
                pressure = CGFloat(min(1, max(0, p)))
            } else if let last = points.last {
                // Faster is thinner, eased so a single quick sample doesn't pinch the line.
                let speed = hypot(at.x - last.x, at.y - last.y) / scale / CGFloat(max(sample.t - lastTime, 1.0 / 240))
                pressure += (1 - min(1, speed / fastest) - pressure) * 0.35
            }
            lastTime = sample.t
            points.append(at)
            radii.append(width / 2 * (1 - thinning + thinning * pressure))
        }
        let path = CGMutablePath()
        guard let first = points.first else { return path }
        guard points.count > 1 else {
            path.addEllipse(in: CGRect(x: first.x - radii[0], y: first.y - radii[0], width: 2 * radii[0], height: 2 * radii[0]))
            return path
        }
        // Each side, a radius off the line either way, square to where it is heading there.
        var left: [CGPoint] = [], right: [CGPoint] = [], headings: [CGFloat] = []
        for index in points.indices {
            let before = points[max(0, index - 1)], after = points[min(points.count - 1, index + 1)]
            let heading = atan2(after.y - before.y, after.x - before.x)
            let normal = CGPoint(x: -sin(heading), y: cos(heading)) * radii[index]
            left.append(points[index] + normal)
            right.append(points[index] - normal)
            headings.append(heading)
        }
        // Down one side, round the end, back up the other and round the start: one outline, drawn through the midpoints
        // between samples so its edge is a curve rather than a polygon.
        path.move(to: left[0])
        curve(through: left, on: path)
        path.addArc(center: points[points.count - 1], radius: radii[radii.count - 1], startAngle: headings[headings.count - 1] + .pi / 2, endAngle: headings[headings.count - 1] - .pi / 2, clockwise: true)
        curve(through: Array(right.reversed()), on: path)
        path.addArc(center: points[0], radius: radii[0], startAngle: headings[0] - .pi / 2, endAngle: headings[0] + .pi / 2, clockwise: true)
        path.closeSubpath()
        return path
    }

    /// From the path's current point (`points[0]`) through the rest to the last, each sample the control of a curve
    /// between its neighbours' midpoints.
    private static func curve(through points: [CGPoint], on path: CGMutablePath) {
        path.addLine(to: points[0])
        for index in 1..<points.count - 1 {
            path.addQuadCurve(to: (points[index] + points[index + 1]) * 0.5, control: points[index])
        }
        path.addLine(to: points[points.count - 1])
    }

    /// A shaft with round ends and a solid head. Both are traced the same way round (one side forward, round the front,
    /// the other side back), so filling them together is their union.
    static func arrow(from tail: CGPoint, to head: CGPoint, width: CGFloat) -> CGPath {
        let length = hypot(head.x - tail.x, head.y - tail.y)
        guard length > 0 else { return stroke([CanvasPoint(x: tail.x, y: tail.y)], in: CGSize(width: 1, height: 1), width: width, thinning: 0) }
        let direction = (head - tail) * (1 / length), normal = CGPoint(x: -direction.y, y: direction.x)
        let headLength = min(4.5 * width, length * 0.5), headHalf = headLength * 0.62
        let base = head - direction * (headLength * 0.8)
        let path = CGMutablePath()
        path.addPath(stroke([CanvasPoint(x: tail.x, y: tail.y), CanvasPoint(x: base.x, y: base.y)], in: CGSize(width: 1, height: 1), width: width, thinning: 0))
        path.move(to: head - direction * headLength + normal * headHalf)
        path.addLine(to: head)
        path.addLine(to: head - direction * headLength - normal * headHalf)
        path.closeSubpath()
        return path
    }

    /// A note's badge: rounded but for the corner on the spot, which is its bottom left (panel-lab's `.pin b`).
    static func pin(at spot: CGPoint, side: CGFloat) -> CGPath {
        let rect = CGRect(x: spot.x, y: spot.y - side, width: side, height: side)
        let round = side / 2, tip = side / 8
        let path = CGMutablePath()
        path.move(to: CGPoint(x: rect.minX + round, y: rect.minY))
        path.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.minY), tangent2End: CGPoint(x: rect.maxX, y: rect.maxY), radius: round)
        path.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.maxY), tangent2End: CGPoint(x: rect.minX, y: rect.maxY), radius: round)
        path.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.maxY), tangent2End: CGPoint(x: rect.minX, y: rect.minY), radius: tip)
        path.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.minY), tangent2End: CGPoint(x: rect.maxX, y: rect.minY), radius: round)
        path.closeSubpath()
        return path
    }
}

// MARK: - The picture

extension CanvasInk {
    /// The picture an agent is sent: what was on screen (`screen`, the display's own pixels), the marks drawn over it by
    /// the same builder as the glass, the whole no longer than `longEdge` pixels (the phone uploads' rule). With no
    /// screen — no Screen Recording grant — the marks alone, on the ground colour, so they read in any viewer.
    public static func render(_ document: CanvasDocument, over screen: CGImage?, longEdge: CGFloat = 1568) -> CGImage? {
        let points = document.anchor.frame.size
        guard points.width > 0, points.height > 0 else { return nil }
        let source = screen.map { CGSize(width: $0.width, height: $0.height) } ?? CGSize(width: points.width * 2, height: points.height * 2)
        let fit = min(1, longEdge / max(source.width, source.height))
        let size = CGSize(width: (source.width * fit).rounded(), height: (source.height * fit).rounded())
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        context.interpolationQuality = .high
        let bounds = CGRect(origin: .zero, size: size)
        if let screen {
            context.draw(screen, in: bounds)
        } else {
            context.setFillColor(ConchColor.ground.light.cgColor)
            context.fill(bounds)
        }
        // The marks are kept y down; a bitmap context is y up.
        context.translateBy(x: 0, y: size.height)
        context.scaleBy(x: 1, y: -1)
        draw(document, in: context, size: size, scale: size.width / points.width)
        return context.makeImage()
    }

    /// Every mark into `context`, y down, in a space of `size` at `scale` pixels a point: the ink, a box's wash under it,
    /// a highlight multiplied over what is under it, a note's number on its badge.
    public static func draw(_ document: CanvasDocument, in context: CGContext, size: CGSize, scale: CGFloat) {
        for mark in document.marks {
            let shape = shape(of: mark, in: size, scale: scale)
            let colour = mark.kind == .highlight ? highlight : colour(mark.author)
            context.saveGState()
            if let wash = shape.wash {
                context.addPath(wash)
                context.setFillColor(colour.cgColor.copy(alpha: washOpacity) ?? colour.cgColor)
                context.fillPath()
            }
            if mark.kind == .highlight { context.setBlendMode(.multiply) }
            context.addPath(shape.ink)
            context.setFillColor(colour.cgColor)
            context.fillPath()
            context.restoreGState()
            if mark.kind == .note, let number = document.number(of: mark), let spot = mark.points.first?.point(in: size) {
                let side = pinSide * scale
                label(mark.author == .agent ? "✦" : "\(number)", centredIn: CGRect(x: spot.x, y: spot.y - side, width: side, height: side), size: 12 * scale, in: context)
            }
        }
    }

    /// White bold type, centred on its cap height in `rect`, in a y-down context.
    private static func label(_ text: String, centredIn rect: CGRect, size: CGFloat, in context: CGContext) {
        let font = CTFontCreateUIFontForLanguage(.emphasizedSystem, size, nil) ?? CTFontCreateWithName("Helvetica-Bold" as CFString, size, nil)
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1),
        ]))
        let width = CTLineGetTypographicBounds(line, nil, nil, nil)
        context.saveGState()
        // Type is drawn y up: flipped back for the glyphs alone.
        context.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        context.textPosition = CGPoint(x: rect.midX - width / 2, y: rect.midY + CTFontGetCapHeight(font) / 2)
        CTLineDraw(line, context)
        context.restoreGState()
    }

    /// A PNG of `image`.
    public static func png(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
}

// MARK: - The prompt

/// What a canvas says when it is sent: one message through the composer's own path. The picture's path comes first, on
/// its own line — both agents read an image whose path is in the message, and a leading path isn't skimmed past — then
/// what was marked up, each note by the number on its pin, and where the rest is.
public enum CanvasPrompt {
    /// `picture` is the flat PNG; `clean` the screen without the marks, nil when there was no screen to capture;
    /// `marks` the document as JSON.
    public static func text(for document: CanvasDocument, about label: String, picture: String, clean: String?, marks: String) -> String {
        var lines = [picture, "[canvas] Tyler marked up \(label)."]
        lines += notes(document)
        if let clean {
            lines.append("Clean screen + marks: \(clean), \(marks)")
        } else {
            lines.append("conch can't see the screen without the Screen Recording permission, so the picture is his marks alone. Marks: \(marks)")
        }
        return lines.joined(separator: "\n")
    }

    /// Tyler's notes with words in them, numbered as their pins are, each named by the mark it is pinned on:
    /// `1. box (62%,18%): "make this bigger"`.
    public static func notes(_ document: CanvasDocument) -> [String] {
        document.marks.filter { $0.kind == .note && $0.author == .you }.compactMap { note in
            let words = (note.text ?? "").split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
            guard !words.isEmpty, let number = document.number(of: note) else { return nil }
            return "\(number). \(place(document.target(of: note) ?? note)): \"\(words)\""
        }
    }

    /// A mark and where it is, in percent across and down the screen: a box by its middle, an arrow from tail to head.
    static func place(_ mark: CanvasMark) -> String {
        func percent(_ point: CGPoint) -> String { "(\(Int((point.x * 100).rounded()))%,\(Int((point.y * 100).rounded()))%)" }
        let unit = CGSize(width: 1, height: 1)
        let points = mark.points.map { $0.point(in: unit) }
        switch mark.kind {
        case .arrow:
            return "arrow \(percent(points.first ?? .zero))→\(percent(points.last ?? .zero))"
        case .note:
            return "note \(percent(points.first ?? .zero))"
        case .box:
            let rect = mark.rect(in: unit)
            return "box \(percent(CGPoint(x: rect.midX, y: rect.midY)))"
        case .pen, .highlight:
            let xs = points.map(\.x), ys = points.map(\.y)
            let middle = CGPoint(x: ((xs.min() ?? 0) + (xs.max() ?? 0)) / 2, y: ((ys.min() ?? 0) + (ys.max() ?? 0)) / 2)
            return "\(mark.kind.rawValue) \(percent(middle))"
        }
    }
}

extension ConchRGBA {
    public var cgColor: CGColor { CGColor(srgbRed: red, green: green, blue: blue, alpha: alpha) }
}

private func + (a: CGPoint, b: CGPoint) -> CGPoint { CGPoint(x: a.x + b.x, y: a.y + b.y) }
private func - (a: CGPoint, b: CGPoint) -> CGPoint { CGPoint(x: a.x - b.x, y: a.y - b.y) }
private func * (a: CGPoint, k: CGFloat) -> CGPoint { CGPoint(x: a.x * k, y: a.y * k) }
