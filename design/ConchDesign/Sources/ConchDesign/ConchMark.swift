import SwiftUI
#if os(macOS)
import AppKit
#endif

/// The conch mark: six scallops around one inner turn, for the menu bar only. Everywhere else the voice
/// is a `VoiceGlyph`.
///
/// Built from conch-design/icon/README.md and checked against conch-mark.svg point for point (to 0.001).
/// On a 24-unit grid centred at (12, 12), angle θ clockwise from the top:
/// - the inner turn: θ = 2πt, r = 1 + 5.2·(1 − (1 − t)³), for t from 0 to 1;
/// - the crown: θ = 2πt, r = 7.2 − cos 6θ, six scallops 2.0 deep between r 6.2 and 8.2.
/// The ease-out on the turn ends flat, so it flows into the crown without a corner.
/// Cropped to the square 3.181…20.819 and stroked at 1.268 units: 1.15 pt when drawn at 16 pt.
public struct ConchMark: Shape {
    public static let cropOrigin: CGFloat = 3.181
    public static let cropSide: CGFloat = 17.638
    public static let unitStroke: CGFloat = 1.268

    public init() {}

    public static func lineWidth(forSide side: CGFloat) -> CGFloat {
        side * unitStroke / cropSide
    }

    /// The mark in grid units, inner turn first: 1201 points, as in the SVG.
    static let unitPoints: [CGPoint] = {
        let steps = 600
        func point(_ radius: Double, _ theta: Double) -> CGPoint {
            CGPoint(x: 12 + radius * sin(theta), y: 12 - radius * cos(theta))
        }
        let turn = (0...steps).map { step -> CGPoint in
            let t = Double(step) / Double(steps)
            return point(1 + 5.2 * (1 - pow(1 - t, 3)), 2 * .pi * t)
        }
        let crown = (1...steps).map { step -> CGPoint in
            let theta = 2 * Double.pi * Double(step) / Double(steps)
            return point(7.2 - cos(6 * theta), theta)
        }
        return turn + crown
    }()

    public func path(in rect: CGRect) -> Path {
        let side = min(rect.width, rect.height)
        let scale = side / Self.cropSide
        let left = rect.midX - side / 2
        let top = rect.midY - side / 2
        var path = Path()
        path.addLines(Self.unitPoints.map {
            CGPoint(x: left + ($0.x - Self.cropOrigin) * scale, y: top + ($0.y - Self.cropOrigin) * scale)
        })
        return path
    }
}

/// The mark stroked as the README draws it, in the state's colour (Talk: primary text).
public struct ConchMarkView: View {
    let state: VoiceState

    public init(state: VoiceState = .talk) {
        self.state = state
    }

    public var body: some View {
        GeometryReader { geometry in
            let side = min(geometry.size.width, geometry.size.height)
            ConchMark().stroke(
                state.token.map { AnyShapeStyle($0) } ?? AnyShapeStyle(ConchColor.textPrimary),
                style: StrokeStyle(lineWidth: ConchMark.lineWidth(forSide: side), lineCap: .round, lineJoin: .round)
            )
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityElement()
        .accessibilityLabel("conch, \(state.title)")
    }
}

#if os(macOS)
extension ConchMark {
    /// The status item image: 16 pt square and drawn on demand, so it is sharp at any backing scale.
    /// Talk is a black template image that macOS tints for light and dark bars; every other state is its
    /// own colour. Every state is the same size, so nothing beside it in the menu bar moves.
    public static func statusImage(for state: VoiceState, side: CGFloat = 16) -> NSImage {
        let stroke = state.token.map { NSColor(srgbRed: $0.light.red, green: $0.light.green, blue: $0.light.blue, alpha: 1) } ?? .black
        let image = NSImage(size: NSSize(width: side, height: side), flipped: true) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.addPath(ConchMark().path(in: rect).cgPath)
            context.setLineWidth(lineWidth(forSide: side))
            context.setLineCap(.round)
            context.setLineJoin(.round)
            context.setStrokeColor(stroke.cgColor)
            context.strokePath()
            return true
        }
        image.isTemplate = state == .talk
        image.accessibilityDescription = "conch, \(state.title)"
        return image
    }
}
#endif

#Preview("Conch mark") {
    HStack(spacing: 24) {
        ForEach(VoiceState.allCases, id: \.self) { state in
            ConchMarkView(state: state).frame(width: 64, height: 64)
        }
    }
    .padding(32)
    .background(ConchColor.ground)
}
