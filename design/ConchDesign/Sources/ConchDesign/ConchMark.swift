import CoreGraphics
import SwiftUI
#if os(macOS)
import AppKit
#endif

/// The conch mark in the menu bar: "the circle, looking", the brand's monochrome menu bar glyph (conch-design's
/// brand/deck/marks, section 04, glyph A v6, the pick; built there by `glyph3.look6`). The ring is the shell's opening and
/// the wordmark's o; the hermit crab inside puts its eyes up out of it on two stalks, which pass through the ring's top
/// together as a short neck, with a seam either side so the ring reads whole and everything comes out of the opening. It is
/// the app icon's peekaboo crab, drawn for 18 pt.
///
/// It replaces the scallop spiral (six scallops around one inner turn, from conch-design/icon), which predates the brand
/// and was kept only until the brand adopted a menu bar mark. Of the brand's two, the colour OG and this one, the menu bar
/// gets this one: a template image is what lets macOS draw it for a light or dark bar, a tinted or translucent one, and the
/// open menu's highlight, and the brand's own head-to-head picked it over the shell glyph for 16 to 18 pt (the shell glyph's
/// ring eyes over a round body read as a bee or a frog's face there; this one stays light and is the word's own o).
///
/// Every state keeps the circle, looking, and the shell never moves, so a change of state is something added beside it,
/// never a jump. The brand drew four states for an app with no Talk; conch's five, in one ink:
/// - **Talk:** the circle, looking. The crab is out, as on the icon.
/// - **Quiet:** the same, dimmed (`quietOpacity`), as macOS dims a status item that is switched off. The brand's quiet,
///   the ring alone, would sit 3 pt low in the bar without the eyes above it, so the eyes stay and the ink fades.
/// - **Ready for you:** the brand's state dot at the shell's top right: something is waiting, as a dot says everywhere.
/// - **Speaking:** the brand's speaking, sound off both sides of the shell.
/// - **Listening:** the opening glows (`listeningGlow`): the shell lit while the mic is open, as the control bar's orb
///   wears a ring of light while it listens, and the brand's other state signal ("only ever a small dot or a glow"). A
///   solid dot there was tried: under the neck it read as a keyhole, or an exclamation mark.
///
/// Drawn per backing scale, not scaled: each `Grid` is the mark laid out in that scale's own pixels, every edge it can put
/// on a pixel boundary there, as the brand's "every size is redrawn and snapped, never scaled". Talk's ink is centred in
/// the 18 pt square to the pixel at both scales, so its margins are equal on all four sides (`ConchMarkTests`).
public struct ConchMark: Shape {
    /// The status item's square, in points: a touch larger than the 16 pt default (Tyler: "can also be a touch larger up
    /// there"), and the size the brand drew the glyph for.
    public static let side: CGFloat = 18
    /// Quiet's ink, of Talk's. Under the bar's own ink (about 85%) it is about 55%: 4.7:1 on a light bar (#F6F6F6), 5.9:1 on
    /// a dark one (#1E1E1E), and 2.6:1 on the see-through bar over Tyler's blue wallpaper (#2E78AC, measured), where Apple's
    /// own full-strength glyphs make 3.8. At 0.55 that bar had it at 2.2, too faint to find.
    public static let quietOpacity: CGFloat = 0.65
    /// Listening's glow in the opening, of the ink: light enough that the ring still reads as a ring around it, not a
    /// filled o (the brand's filled os read as a ball or a snail), and strong enough to see on a see-through bar (at 0.45
    /// it was 2.0:1 against the blue one, and against its own ring).
    public static let listeningGlow: CGFloat = 0.6

    /// The two things the mark is drawn in: the ink, and listening's glow under it.
    public enum Layer: Sendable {
        case ink
        case glow
    }

    let state: VoiceState
    let layer: Layer

    public init(state: VoiceState = .talk, layer: Layer = .ink) {
        self.state = state
        self.layer = layer
    }

    /// The mark as the 2x grid draws it, scaled into the largest square that fits: the drawing the brand designed on.
    public func path(in rect: CGRect) -> Path {
        let grid = Grid.twoX
        let side = min(rect.width, rect.height)
        let scale = side / grid.side
        let transform = CGAffineTransform(translationX: rect.midX - side / 2, y: rect.midY - side / 2).scaledBy(x: scale, y: scale)
        let path = layer == .ink ? Self.path(for: state, on: grid) : Self.glow(for: state, on: grid)
        return Path(path).applying(transform)
    }

    // MARK: Geometry

    /// The mark in one backing scale's pixels, y down, on a `side`-pixel square. 2x is the brand's design grid (36 px is
    /// 18 pt); 1x is redrawn on its own 18 px, since halving the 2x layout would put most of its edges mid-pixel.
    struct Grid {
        /// The square, in pixels.
        var side: CGFloat
        /// The shell's opening: its centre, outer radius and thickness.
        var ring: (x: CGFloat, y: CGFloat, radius: CGFloat, thickness: CGFloat)
        /// Each eye's distance either side of the ring's centre, its centre's height, and its diameter.
        var eyes: (spread: CGFloat, y: CGFloat, diameter: CGFloat)
        /// The neck the two stalks make: its width, where they part above the ring, and where it ends, flush with the
        /// opening's top. Rooted 2 px inside it, as the brand roots it, the stub in the hole made a power symbol (⏻) of the
        /// ring, and "(⏻)" of Speaking.
        var neck: (width: CGFloat, top: CGFloat, root: CGFloat)
        /// Each stalk, from the neck to its eye.
        var stalk: Stalk
        /// The gap cut into whatever is behind a part where the part crosses it. None at 1x, where a 1 px seam either side
        /// of a 2 px neck would cut the ring's 2 px top to stubs; the neck joins the ring there instead.
        var seam: CGFloat
        /// Ready's dot: its centre and diameter.
        var dot: (x: CGFloat, y: CGFloat, diameter: CGFloat)
        /// Speaking's sound, off both sides of the shell.
        var sound: Sound

        enum Stalk {
            /// A curve of this width, leaving the neck upright and rising this far before it turns out to its eye.
            case curve(width: CGFloat, rise: CGFloat)
            /// One whole pixel on the diagonal between the neck's top corner and the eye: at 1x the stalks are a pixel
            /// long, and a curve that short is only grey smear (209, 145, 142 on the pixels it touched).
            case pixel
        }

        enum Sound {
            /// An arc about the ring's centre either side: its radius, width, and reach either side of level in degrees.
            case arcs(radius: CGFloat, width: CGFloat, reach: CGFloat)
            /// The left one's pixels, mirrored for the right: at 1x a 1 px arc's ends smeared into the ring beside them.
            case pixels([CGRect])
        }

        /// 18 pt at 2x: the brand's grid. The ring is 20 px across with a 4 px wall, so the counter is 12; the eyes are 8 px
        /// and as wide apart as the ring, so the pair spans exactly its 20 px; Talk's ink runs 8–28 across and 2–34 down,
        /// 8 px clear each side and 2 px top and bottom. The arcs' 3 px width is centred on whole pixels where they are
        /// upright (x 3–6 and 30–33), 2 px clear of the ring. The wall's 4 px is the Wi-Fi glyph's stroke beside it.
        static let twoX = Grid(
            side: 36,
            ring: (x: 18, y: 24, radius: 10, thickness: 4),
            eyes: (spread: 6, y: 6, diameter: 8),
            neck: (width: 2, top: 12, root: 18),
            stalk: .curve(width: 2, rise: 1),
            seam: 1,
            dot: (x: 32, y: 14, diameter: 6),
            sound: .arcs(radius: 13.5, width: 3, reach: 30)
        )

        /// 18 pt at 1x: the ring 10 px across with a 2 px wall, 4 px eyes over its edges, the neck 2 px on the centre line
        /// and joined to the ring, a pixel on the diagonal to each eye. Talk's ink runs 4–14 across and 1–17 down, every
        /// pixel of it mirrored. The sound is a ")" of whole pixels each side (columns 1–2 and 15–16), 1 px clear of the
        /// ring at every row.
        static let oneX = Grid(
            side: 18,
            ring: (x: 9, y: 12, radius: 5, thickness: 2),
            eyes: (spread: 3, y: 3, diameter: 4),
            neck: (width: 2, top: 6, root: 9),
            stalk: .pixel,
            seam: 0,
            dot: (x: 16.5, y: 7.5, diameter: 3),
            sound: .pixels([CGRect(x: 1, y: 10, width: 1, height: 4), CGRect(x: 2, y: 9, width: 1, height: 1), CGRect(x: 2, y: 14, width: 1, height: 1)])
        )
    }

    /// The mark for a state on a grid, as one filled shape: the parts are laid back to front, each cutting `seam` out of
    /// everything behind it (the brand's `flatten`, which is how SF Symbols separate overlapping parts).
    static func path(for state: VoiceState, on grid: Grid) -> CGPath {
        let ring = grid.ring
        let opening = circle(ring.x, ring.y, ring.radius).subtracting(circle(ring.x, ring.y, ring.radius - ring.thickness))
        var parts = [opening, crab(on: grid)]
        switch state {
        case .ready:
            parts.append(circle(grid.dot.x, grid.dot.y, grid.dot.diameter / 2))
        case .speaking:
            switch grid.sound {
            case let .arcs(radius, width, reach):
                let reach = reach * .pi / 180
                for start in [CGFloat.pi - reach, -reach] {
                    let arc = CGMutablePath()
                    arc.addArc(center: CGPoint(x: ring.x, y: ring.y), radius: radius, startAngle: start, endAngle: start + 2 * reach, clockwise: false)
                    parts.append(arc.copy(strokingWithWidth: width, lineCap: .round, lineJoin: .round, miterLimit: 10))
                }
            case let .pixels(left):
                let both = CGMutablePath()
                for pixel in left {
                    both.addRect(pixel)
                    both.addRect(CGRect(x: grid.side - pixel.maxX, y: pixel.minY, width: pixel.width, height: pixel.height))
                }
                parts.append(both)
            }
        case .talk, .quiet, .listening:
            break
        }
        var mark = CGMutablePath() as CGPath
        for (index, part) in parts.enumerated() {
            let front = parts[(index + 1)...].reduce(CGMutablePath() as CGPath) { $0.union($1) }
            let cut = grid.seam > 0 && !front.isEmpty
                ? front.union(front.copy(strokingWithWidth: 2 * grid.seam, lineCap: .round, lineJoin: .round, miterLimit: 10))
                : front
            mark = mark.union(cut.isEmpty ? part : part.subtracting(cut))
        }
        return mark
    }

    /// Listening's glow: the opening, a pixel in from the ring and clear of the neck by one, so the ring and the crab keep
    /// their edges against it. Empty in every other state.
    static func glow(for state: VoiceState, on grid: Grid) -> CGPath {
        guard state == .listening else { return CGMutablePath() }
        let ring = grid.ring
        let crab = crab(on: grid)
        return circle(ring.x, ring.y, ring.radius - ring.thickness - 1)
            .subtracting(crab.union(crab.copy(strokingWithWidth: 2, lineCap: .round, lineJoin: .round, miterLimit: 10)))
    }

    /// The crab: the neck, rising out of the opening through the ring's top, and from its top a stalk to each eye.
    private static func crab(on grid: Grid) -> CGPath {
        let ring = grid.ring, neck = grid.neck
        var crab = CGPath(rect: CGRect(x: ring.x - neck.width / 2, y: neck.top, width: neck.width, height: neck.root - neck.top), transform: nil)
        for side: CGFloat in [-1, 1] {
            let eye = CGPoint(x: ring.x + side * grid.eyes.spread, y: grid.eyes.y)
            switch grid.stalk {
            case let .curve(width, rise):
                // Leaving the neck upright, then turning out to come up under the eye.
                let from = CGPoint(x: ring.x + side * (neck.width - width) / 2, y: neck.top + width / 2)
                let line = CGMutablePath()
                line.move(to: from)
                line.addCurve(to: eye, control1: CGPoint(x: from.x, y: from.y - rise), control2: CGPoint(x: eye.x, y: eye.y + grid.eyes.diameter * 0.9))
                crab = crab.union(line.copy(strokingWithWidth: width, lineCap: .butt, lineJoin: .round, miterLimit: 10))
            case .pixel:
                let x = side < 0 ? ring.x - neck.width / 2 - 1 : ring.x + neck.width / 2
                crab = crab.union(CGPath(rect: CGRect(x: x, y: neck.top - 1, width: 1, height: 1), transform: nil))
            }
            crab = crab.union(circle(eye.x, eye.y, grid.eyes.diameter / 2))
        }
        return crab
    }

    private static func circle(_ x: CGFloat, _ y: CGFloat, _ radius: CGFloat) -> CGPath {
        CGPath(ellipseIn: CGRect(x: x - radius, y: y - radius, width: 2 * radius, height: 2 * radius), transform: nil)
    }
}

/// The mark in the state's ink: the menu bar's own, primary text, dimmed for Quiet and glowing for Listening as the status
/// item draws them. One colour, as the bar draws it; the voice's colours are the control bar's and the orb's.
public struct ConchMarkView: View {
    let state: VoiceState

    public init(state: VoiceState = .talk) {
        self.state = state
    }

    public var body: some View {
        ZStack {
            ConchMark(state: state, layer: .glow).fill(ConchColor.textPrimary).opacity(ConchMark.listeningGlow)
            ConchMark(state: state).fill(ConchColor.textPrimary)
        }
        .opacity(state == .quiet ? ConchMark.quietOpacity : 1)
        .aspectRatio(1, contentMode: .fit)
        .accessibilityElement()
        .accessibilityLabel("conch, \(state.title)")
    }
}

#if os(macOS)
extension ConchMark {
    /// The status item's image: 18 pt square, with a 1x and a 2x bitmap each drawn from its own grid, so AppKit picks the
    /// one for the screen and neither is a resample of the other. A template image in every state (black, and coverage in
    /// alpha), so macOS inks it for a light or dark bar and for the open menu's highlight, and Quiet's dimming and
    /// Listening's glow are in its alpha. Every state is the same size, so nothing beside it in the menu bar moves.
    public static func statusImage(for state: VoiceState) -> NSImage {
        let image = NSImage(size: NSSize(width: side, height: side))
        for grid in [Grid.oneX, Grid.twoX] {
            image.addRepresentation(bitmap(for: state, on: grid))
        }
        image.isTemplate = true
        image.accessibilityDescription = "conch, \(state.title)"
        return image
    }

    /// One scale's bitmap: the grid's pixels, black at the state's opacity, over listening's glow. Drawn straight into the bitmap's own bytes, in
    /// pixels: a graphics context made from the rep would scale by its point size, so the 2x grid would land doubled.
    static func bitmap(for state: VoiceState, on grid: Grid) -> NSBitmapImageRep {
        let pixels = Int(grid.side)
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        rep.size = NSSize(width: side, height: side)
        if let context = CGContext(data: rep.bitmapData, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: rep.bytesPerRow,
                                   space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
            // The grids are y down, as the brand drew them.
            context.translateBy(x: 0, y: grid.side)
            context.scaleBy(x: 1, y: -1)
            context.setFillColor(CGColor(gray: 0, alpha: listeningGlow))
            context.addPath(glow(for: state, on: grid))
            context.fillPath()
            context.setFillColor(CGColor(gray: 0, alpha: state == .quiet ? quietOpacity : 1))
            context.addPath(path(for: state, on: grid))
            context.fillPath()
        }
        return rep
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
