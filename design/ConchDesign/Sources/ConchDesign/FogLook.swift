import CoreGraphics
import SwiftUI

/// A setting with a light and a dark value, crossfaded by how dark the overlay is (0 light to 1 dark).
public struct LightDark: Equatable, Sendable {
    public var light: Double
    public var dark: Double

    public init(_ light: Double, _ dark: Double) {
        self.light = light
        self.dark = dark
    }

    public func at(_ darkness: Double) -> Double { light + (dark - light) * darkness }
}

/// The overlay's look, the overlay lab's (`render()` in ~/Projects/conch-design/overlay-lab.html). A blob of blur gathers
/// to the screen edges the fog touches and floats as a soft blob in its middle between them (Tyler: "blobs like a
/// magnet"); a wash lies over it, a little thicker behind the newest words; and the voice's colour pools in it, toward
/// those edges. Nothing ends in a line: every layer fades out inside the window, or runs off the screen.
///
/// Geometry is in the fog's own space, top left. Its window reaches `margin` past the fog where the blob spills toward a
/// screen edge.
public struct FogLook: Equatable {
    public var size: CGSize
    public var corner: FogCorner
    /// Where the Dock and the menu bar overlap the fog.
    public var insets: EdgeInsets
    /// How hard each screen edge pulls the blob toward it (`FogMotion.magnet`).
    public var magnet: EdgeInsets
    /// How far each side of the fog is from its screen's edge (`FogMotion.gaps`).
    public var gaps: EdgeInsets
    /// 0 docked to 1 mid-air: the blob shrinks a little with the words.
    public var flying: CGFloat
    /// 0 to 1, the pointer over the resize band: the blob swells a little and its wash and colour deepen.
    public var resizeHover: CGFloat = 0
    /// 0 light to 1 dark.
    public var darkness: Double = 0
    /// The wash over the blur where the blob is densest.
    public var tint = LightDark(0.78, 0.8)
    /// The voice's colour.
    public var colour = LightDark(0.75, 0.55)
    /// The extra wash, and blur, behind the newest words.
    public var scrim = LightDark(0.3, 0.25)

    public init(_ motion: FogMotion, insets: EdgeInsets = EdgeInsets()) {
        size = motion.size
        corner = motion.corner
        self.insets = insets
        magnet = motion.magnet
        gaps = motion.gaps
        flying = motion.flying
    }

    /// The blob's density from its middle out, at fractions of its radii: solid to 36%, gone by 78%.
    public static let density: [(location: CGFloat, alpha: Double)] = [(0, 1), (0.36, 1), (0.5, 0.75), (0.64, 0.3), (0.78, 0)]
    /// The words' fade, over `wordsFade`.
    public static let wordsDensity: [(location: CGFloat, alpha: Double)] = [(0.62, 1), (0.84, 0)]

    /// The blob, as the rect of the ellipse it fills. Off its corner it sits in the middle at 58% of the fog; against an
    /// edge it is centred on that edge and reaches 115% across the fog or 100% up it.
    public var blob: CGRect { ellipse(across: (0.58, 1.15), up: (0.58, 1), scale: scale) }

    /// Mid-air a little smaller, over the resize band a little bigger.
    private var scale: CGFloat { (1 - (1 - ConchMotion.flightScale) * flying) * (1 + 0.08 * resizeHover) }

    /// Where the words fade, so they never sit on screen the blur hasn't softened: the blob's ellipse, though never so
    /// small that the newest lines (the reply line and the 230 pt above it) begin to fade.
    public var wordsFade: CGRect {
        let text = self.text
        let rect = ellipse(across: (0.58, 1.15), up: (0.58, 1), scale: 1)
        let newest = CGRect(x: text.minX, y: text.maxY - 230, width: text.width, height: 230)
        let rx = max(rect.width / 2, max(abs(newest.minX - rect.midX), abs(newest.maxX - rect.midX)) / 0.62)
        let ry = max(rect.height / 2, max(abs(newest.minY - rect.midY), abs(newest.maxY - rect.midY)) / 0.62)
        return CGRect(x: rect.midX - rx, y: rect.midY - ry, width: 2 * rx, height: 2 * ry)
    }

    /// Behind the newest lines (the reply line and the 70 pt above it) the blur and the wash thicken a little. Kept inside
    /// the window on every side short of a screen edge.
    public var scrimArea: CGRect {
        let text = self.text, room = self.room
        let x = text.minX + text.width * 0.45, y = text.maxY - 110
        let rx = max(0, min(text.width * 0.72 + 90, size.width * 0.75, x + room.leading, size.width - x + room.trailing))
        let ry = max(0, min(190, size.height * 0.36, y + room.top, size.height - y + room.bottom))
        return CGRect(x: x - rx, y: y - ry, width: 2 * rx, height: 2 * ry)
    }

    /// How far the window reaches past each side of the fog: into the gap to a screen edge as far as the blob spills and
    /// no further, so the blob always ends in its own fade or off the screen, never at the window's edge.
    public var margin: EdgeInsets {
        let blob = self.blob, reach = 1 - Self.density.last!.location
        let spill = blob.insetBy(dx: blob.width / 2 * reach, dy: blob.height / 2 * reach)
        func side(_ over: CGFloat, _ gap: CGFloat) -> CGFloat { max(0, min(over, gap)).rounded(.up) }
        return EdgeInsets(
            top: side(-spill.minY, gaps.top),
            leading: side(-spill.minX, gaps.leading),
            bottom: side(spill.maxY - size.height, gaps.bottom),
            trailing: side(spill.maxX - size.width, gaps.trailing)
        )
    }

    /// The whole window, fog and margin, in the fog's space.
    public var window: CGRect {
        let margin = self.margin
        return CGRect(x: -margin.leading, y: -margin.top, width: size.width + margin.leading + margin.trailing, height: size.height + margin.top + margin.bottom)
    }

    /// How far a layer may reach past each side: without end against a screen edge, else as far as the window does.
    private var room: EdgeInsets {
        let margin = self.margin
        func side(_ gap: CGFloat, _ margin: CGFloat) -> CGFloat { gap < 1 ? .infinity : margin }
        return EdgeInsets(top: side(gaps.top, margin.top), leading: side(gaps.leading, margin.leading), bottom: side(gaps.bottom, margin.bottom), trailing: side(gaps.trailing, margin.trailing))
    }

    private var text: CGRect { ConversationFog.textFrame(in: size, corner: corner, insets: insets, fullScreen: false) }

    /// An ellipse centred off the corner, pulled onto the edges by the magnet, its radii from `across.0` of the fog's width
    /// (`up.0` of its height) to `across.1` (`up.1`) against an edge.
    private func ellipse(across: (CGFloat, CGFloat), up: (CGFloat, CGFloat), scale: CGFloat) -> CGRect {
        let m = magnet, w = size.width, h = size.height
        let rx = w * lerp(across.0, across.1, max(m.leading, m.trailing)) * scale
        let ry = h * lerp(up.0, up.1, max(m.top, m.bottom)) * scale
        return CGRect(x: w * (0.5 + 0.5 * (m.trailing - m.leading)) - rx, y: h * (0.5 + 0.5 * (m.bottom - m.top)) - ry, width: 2 * rx, height: 2 * ry)
    }

    // MARK: Colour

    public struct Glow: Equatable {
        public var area: CGRect
        public var colour: SIMD3<Double>
        public var alpha: Double
    }

    /// The voice state's glow colour: listening and speaking their own, anything else the idle iris.
    public static func glowToken(_ voice: VoiceState) -> ConchColorToken {
        switch voice {
        case .listening: ConchColor.listening
        case .speaking: ConchColor.speaking
        default: ConchColor.idleGlow
        }
    }

    /// On dark a glow is lightened 15% toward white, so it reads as light.
    public static func glowColour(_ token: ConchColorToken, darkness: Double) -> SIMD3<Double> {
        let c = token.light, rgb = SIMD3(c.red, c.green, c.blue)
        return rgb + (1 - rgb) * 0.15 * darkness
    }

    /// `token`'s colour pooled toward the edges the blob gathers to, bottom glow first: the pure hue in the corner, the hue
    /// turned 14° one way along the horizontal edge and 14° the other up the vertical one. They drift a few points and
    /// degrees over 7 to 12 s, and hold still under Reduce Motion.
    public func glows(_ token: ConchColorToken, at time: Double, reduceMotion: Bool) -> [Glow] {
        let t = time * 2 * .pi, drift = !reduceMotion
        let dx = drift ? sin(t / 7.3) * 5 : 0, dy = drift ? cos(t / 9.1) * 4 : 0, breathe = drift ? 1 + sin(t / 11) * 0.015 : 1
        let gx = drift ? sin(t / 8.3) * 14 : 0, gy = drift ? cos(t / 10.1) * 12 : 0
        let turn = 14 * (drift ? 0.6 + 0.4 * sin(t / 12) : 1)
        let m = magnet, w = size.width, h = size.height, blob = self.blob, s = scale * breathe
        let cx = blob.midX + dx, cy = blob.midY + dy
        let mx = max(m.leading, m.trailing), my = max(m.top, m.bottom), mc = min(mx, my)
        let alpha = colour.at(darkness) * (1 + 0.9 * resizeHover), base = Self.glowColour(token, darkness: darkness)
        func area(_ x: CGFloat, _ y: CGFloat, _ rx: CGFloat, _ ry: CGFloat) -> CGRect {
            CGRect(x: x - rx * s, y: y - ry * s, width: 2 * rx * s, height: 2 * ry * s)
        }
        return [
            Glow(area: area(cx, cy, lerp(w * 0.2, 260, mc), lerp(h * 0.22, 260, mc)), colour: base, alpha: 0.3 * alpha),
            Glow(area: area(cx, cy + (h / 2 - cy) * 0.55 + gy, lerp(w * 0.26, 150, mx), h * 0.5), colour: Self.hueShift(base, -turn), alpha: 0.36 * alpha),
            Glow(area: area(cx + (w / 2 - cx) * 0.55 + gx, cy, w * 0.52, lerp(h * 0.3, 150, my)), colour: Self.hueShift(base, turn), alpha: 0.42 * alpha),
        ]
    }

    /// `rgb` turned `degrees` round the hue circle, keeping its saturation and lightness.
    public static func hueShift(_ rgb: SIMD3<Double>, _ degrees: Double) -> SIMD3<Double> {
        let hi = rgb.max(), lo = rgb.min(), chroma = hi - lo
        guard chroma > 0 else { return rgb }
        let sector = hi == rgb.x ? ((rgb.y - rgb.z) / chroma).truncatingRemainder(dividingBy: 6) : hi == rgb.y ? (rgb.z - rgb.x) / chroma + 2 : (rgb.x - rgb.y) / chroma + 4
        let hue = ((sector * 60 + degrees).truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
        let x = chroma * (1 - abs((hue / 60).truncatingRemainder(dividingBy: 2) - 1)), m = (hi + lo) / 2 - chroma / 2
        let (r, g, b): (Double, Double, Double) = switch hue {
        case ..<60: (chroma, x, 0)
        case ..<120: (x, chroma, 0)
        case ..<180: (0, chroma, x)
        case ..<240: (0, x, chroma)
        case ..<300: (x, 0, chroma)
        default: (chroma, 0, x)
        }
        return SIMD3(r + m, g + m, b + m)
    }

    /// Light or dark from `conch.overlay.appearance`: "light", "dark", or anything else (auto) the system's.
    /// ponytail: auto is the system's for now. The lab turns dark over dark content under the words, which needs Screen
    /// Recording to read; that reading would come in here, beside `systemDark`.
    public static func isDark(_ setting: String?, systemDark: Bool) -> Bool {
        switch setting {
        case "light": false
        case "dark": true
        default: systemDark
        }
    }

    // MARK: The blur's mask

    /// The blur's mask: the blob and the scrim over the whole `window`, drawn small, since the blur view stretches it to
    /// its own size and soft gradients stretch without showing it. `strength` scales it all.
    public func mask(strength: Double = 1, pixels: Int = 128) -> CGImage? {
        let window = self.window, sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
        guard window.width > 0, window.height > 0,
              let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        // The window's points, top left, onto the pixels, bottom left.
        context.translateBy(x: 0, y: CGFloat(pixels))
        context.scaleBy(x: CGFloat(pixels) / window.width, y: -CGFloat(pixels) / window.height)
        context.translateBy(x: -window.minX, y: -window.minY)
        let scrim = min(1, self.scrim.at(darkness) * 1.2)
        let layers: [(CGRect, [(location: CGFloat, alpha: Double)])] = [(blob, Self.density), (scrimArea, [(0, scrim), (0.5, scrim), (1, 0)])]
        for (area, stops) in layers where area.width > 0 && area.height > 0 {
            let components: [CGFloat] = stops.flatMap { stop -> [CGFloat] in [0, 0, 0, CGFloat(stop.alpha * strength)] }
            guard let gradient = CGGradient(colorSpace: sRGB, colorComponents: components, locations: stops.map(\.location), count: stops.count) else { continue }
            context.saveGState()
            context.translateBy(x: area.midX, y: area.midY)
            context.scaleBy(x: area.width / 2, y: area.height / 2)
            context.drawRadialGradient(gradient, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: 1, options: [])
            context.restoreGState()
        }
        return context.makeImage()
    }

    /// A radial gradient of `colour` filling the ellipse in `rect`, placed in its parent's space.
    static func area(_ rect: CGRect, _ stops: [(location: CGFloat, alpha: Double)], _ colour: Color) -> some View {
        EllipticalGradient(stops: stops.map { .init(color: colour.opacity($0.alpha), location: $0.location) }, center: .center, startRadiusFraction: 0, endRadiusFraction: 0.5)
            .frame(width: max(0, rect.width), height: max(0, rect.height))
            .position(x: rect.midX, y: rect.midY)
    }
}

private func lerp(_ a: CGFloat, _ b: CGFloat, _ t: CGFloat) -> CGFloat { a + (b - a) * t }

/// The overlay's colour over its blur, as big as its window (`FogLook.window`): the wash, the scrim's wash and the voice's
/// glows, all inside the blob. A change of voice crossfades; the glows drift, slowly, and hold still under Reduce Motion.
public struct FogLookView: View {
    let look: FogLook
    let voice: VoiceState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.conchRendersStatically) private var rendersStatically

    public init(look: FogLook, voice: VoiceState) {
        self.look = look
        self.voice = voice
    }

    public var body: some View {
        let window = look.window, dark = look.darkness
        let wash = ConchColor.fog.rgba(darkness: dark).color
        let tint = look.tint.at(dark) * (1 + 0.1 * look.resizeHover), scrim = look.scrim.at(dark)
        // Everything in the window's space.
        let shift = { (rect: CGRect) in rect.offsetBy(dx: -window.minX, dy: -window.minY) }
        ZStack(alignment: .topLeading) {
            FogLook.area(shift(look.blob), [(0.24, 0.86 * tint), (0.5, 0.5 * tint), (0.76, 0)], wash)
            FogLook.area(shift(look.scrimArea), [(0, 0.92 * scrim), (0.45, 0.78 * scrim), (1, 0)], wash)
            // ponytail: redraws the nine glows at 30 fps for the drift while the overlay shows; pause it off screen if that
            // ever shows up in a profile.
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || rendersStatically)) { timeline in
                let time = rendersStatically ? 0 : timeline.date.timeIntervalSinceReferenceDate
                ZStack(alignment: .topLeading) {
                    // Each voice is its own layer, so a change crossfades rather than mixing through mud.
                    ForEach([ConchColor.speaking, ConchColor.listening, ConchColor.idleGlow], id: \.name) { token in
                        ZStack(alignment: .topLeading) {
                            ForEach(Array(look.glows(token, at: time, reduceMotion: reduceMotion).enumerated()), id: \.offset) { _, glow in
                                FogLook.area(shift(glow.area), [(0, glow.alpha), (0.4, 0.45 * glow.alpha), (1, 0)], Color(.sRGB, red: glow.colour.x, green: glow.colour.y, blue: glow.colour.z))
                            }
                        }
                        .opacity(FogLook.glowToken(voice).name == token.name ? 1 : 0)
                    }
                }
                .animation(ConchMotion.voiceColour.animation(reduceMotion: reduceMotion), value: voice)
            }
        }
        .mask {
            let scrimMask = min(1, scrim * 1.2)
            ZStack(alignment: .topLeading) {
                FogLook.area(shift(look.blob), FogLook.density, .black)
                FogLook.area(shift(look.scrimArea), [(0, scrimMask), (0.5, scrimMask), (1, 0)], .black)
            }
        }
        .frame(width: window.width, height: window.height, alignment: .topLeading)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
