import SwiftUI

/// The conversation overlay as a glass panel rather than a fog: Apple's Liquid Glass in a rounded rect with a hairline
/// and a grab bar, conch's own colour under it (`~/Projects/conch-design/panel.html`, and the voice's hue the fog's
/// glows carried), and a wash over that colour dense enough to read on (`PanelGlass.wash`). Below macOS 26 it falls back
/// to the design system's own glass token over the host's blur.
///
/// The host draws this UNDER the words as a sibling, never as their parent: a material that masks its children faded the
/// words themselves and hid the collapsed handle (Tyler: "when i press the (v) it just disappears").
public struct ConchGlassPanel: View {
    /// 0 light to 1 dark, the crossfade the fog's look took.
    public var darkness: Double
    /// The voice, whose hue colours the glass.
    public var voice: VoiceState
    /// Its corner: the panel's 30 docked, 26 full screen, the handle's circle collapsed; it morphs between them with the
    /// window (`PanelGlass.Geometry`).
    public var radius: CGFloat

    public init(darkness: Double = 0, voice: VoiceState = .talk, radius: CGFloat = ConchRadius.panel) {
        self.darkness = darkness
        self.voice = voice
        self.radius = radius
    }

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: radius, style: .continuous) }

    /// The voice's hue, kept faint: the glass carries the density, so this only colours it.
    private var tint: Color {
        let rgb = FogLook.glowColour(FogLook.glowToken(voice), darkness: darkness)
        return Color(.sRGB, red: rgb.x, green: rgb.y, blue: rgb.z).opacity(0.12)
    }

    public var body: some View {
        colour
            .clipShape(shape)
            .modifier(GlassMaterial(shape: shape, tint: tint, darkness: darkness))
            .overlay(shape.strokeBorder(ConchColor.hairlineStrong.rgba(darkness: darkness).color, lineWidth: 0.5))
            .overlay(alignment: .top) {
                // panel.html's `.grab`: 44 x 5, rounded, faint — it says the panel moves. It fades as the glass shrinks into
                // the collapsed handle, which is narrower than it.
                GeometryReader { proxy in
                    Capsule()
                        .fill(ConchColor.textPrimary.rgba(darkness: darkness).color.opacity(0.18))
                        .frame(width: 44, height: 5)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 9)
                        .opacity(min(1, max(0, (proxy.size.width - 88) / 120)))
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    /// The colour under the glass: warm at the top left falling to cool violet, the one treatment of three that read as
    /// its own thing on a light ground and a dark one (the others were indistinguishable from plain glass). Then the wash.
    private var colour: some View {
        ZStack {
            if #available(macOS 15.0, iOS 18.0, *) {
                MeshGradient(width: 3, height: 3, points: Self.meshPoints, colors: PanelGlass.mesh.map(\.color))
                    .opacity(PanelGlass.meshOpacity(darkness: darkness))
                    .blur(radius: 40)
            }
            ConchColor.fog.rgba(darkness: darkness).color.opacity(PanelGlass.wash.at(darkness))
        }
    }

    static let meshPoints: [SIMD2<Float>] = [
        [0, 0], [0.5, 0], [1, 0],
        [0, 0.5], [0.5, 0.5], [1, 0.5],
        [0, 1], [0.5, 1], [1, 1],
    ]
}

/// The glass under the conversation panel's words, measured: what it lays over whatever is on screen, and where it sits in
/// the panel's window as that window morphs between docked, full screen and the collapsed handle.
public enum PanelGlass {
    /// The panel's wash over its glass and colour, 0 to 1, in light and in dark: dense enough that every level of the
    /// panel's text holds 4.5:1 whatever is under it, black or white, a light panel or a dark one (PanelContrastTests).
    /// Without it, over a real screen, past turns measured 2.3 to 3.0, "You" 1.7 to 3.5 and the placeholder 1.6 to 2.8.
    ///
    /// A wash, and not the overlay lab's reading of what is under the panel (it turns dark over dark content): that reading
    /// needs Screen Recording, which conch asks for only to record a Show, so most Macs never grant it; it would capture
    /// the screen the whole time the panel shows; and it can pick only one appearance for a panel that sits half over a
    /// dark editor and half over a light page. The wash holds everywhere, granted or not. The glass's edge, its refraction
    /// and the colour under it still show through.
    public static let wash = LightDark(0.7, 0.68)

    /// Liquid Glass as the gallery and the tests stand it in, since ImageRenderer can't draw it: panel-lab's `#panel .glass`,
    /// white at 52% in light and #1E1E22 at 50% in dark, over the screen blurred.
    public static func standIn(darkness: Double) -> ConchRGBA {
        darkness > 0.5 ? ConchRGBA(0x1E1E22, alpha: 0.5) : ConchRGBA(0xFFFFFF, alpha: 0.52)
    }

    /// The colour under the glass (`ConchGlassPanel`), row by row: peach, pink and lavender along the top to blues below.
    public static let mesh: [ConchRGBA] = [
        rgb(0.99, 0.84, 0.72), rgb(0.96, 0.80, 0.84), rgb(0.85, 0.83, 0.99),
        rgb(0.98, 0.87, 0.79), rgb(0.93, 0.88, 0.98), rgb(0.79, 0.86, 0.99),
        rgb(0.95, 0.91, 0.98), rgb(0.84, 0.89, 1.00), rgb(0.78, 0.85, 0.99),
    ]

    private static func rgb(_ red: Double, _ green: Double, _ blue: Double) -> ConchRGBA {
        func byte(_ value: Double) -> UInt32 { UInt32((value * 255).rounded()) }
        return ConchRGBA(byte(red) << 16 | byte(green) << 8 | byte(blue))
    }

    /// How strongly the mesh shows: a little less in dark, where it lightens the glass.
    public static func meshOpacity(darkness: Double) -> Double { 0.42 * (1 - 0.3 * darkness) }

    /// What the panel's words are read against over `backdrop`, the screen under it as the glass blurs it: the stand-in
    /// glass, one of the mesh's colours (`mesh`, or none where it has faded), and the wash (`wash`, or the panel's own).
    public static func ground(over backdrop: ConchRGBA, darkness: Double, mesh: ConchRGBA? = nil, wash: Double? = nil) -> ConchRGBA {
        var ground = standIn(darkness: darkness).over(backdrop)
        if let mesh { ground = ConchRGBA(mesh.hex, alpha: meshOpacity(darkness: darkness)).over(ground) }
        let colour = ConchColor.fog.rgba(darkness: darkness)
        return ConchRGBA(colour.hex, alpha: wash ?? self.wash.at(darkness)).over(ground)
    }

    /// Where the glass sits in the panel's window, and its corner. The window and the glass morph together on
    /// `ConchMotion.morph`, so the glass's own rect runs in a straight line from one shape to the next.
    public struct Geometry: Equatable, Sendable {
        public var insets: EdgeInsets
        public var radius: CGFloat

        public init(insets: EdgeInsets, radius: CGFloat) {
            self.insets = insets
            self.radius = radius
        }

        /// Docked: panel.html's `left:24px;bottom:24px`, in from every side of its window, with the panel's corner.
        public static let docked = Geometry(insets: EdgeInsets(top: ConchSpace.x6, leading: ConchSpace.x6, bottom: ConchSpace.x6, trailing: ConchSpace.x6), radius: ConchRadius.panel)

        /// Full screen: panel-lab's `fullRect`, 12 pt in from the screen's sides and foot and from under the menu bar, with a
        /// 26 pt corner. It stays glass: the rounded panel grows into the screen rather than giving way to a square wash.
        public static func fullScreen(menuBar: CGFloat) -> Geometry {
            Geometry(insets: EdgeInsets(top: menuBar + ConchSpace.x3, leading: ConchSpace.x3, bottom: ConchSpace.x3, trailing: ConchSpace.x3), radius: 26)
        }

        /// Collapsed: the handle's own circle in its corner square (`FogHandle`), so the glass shrinks into the handle.
        public static func collapsed(corner: FogCorner) -> Geometry {
            let near = FogHandle.inset, far = FogHandle.side - FogHandle.inset - FogHandle.circle
            return Geometry(
                insets: EdgeInsets(top: corner.bottom ? far : near, leading: corner.leading ? near : far, bottom: corner.bottom ? near : far, trailing: corner.leading ? far : near),
                radius: FogHandle.circle / 2
            )
        }

        /// `t` of the way from `a` to `b`; past 1 it overshoots, as the spring does.
        public static func lerp(_ a: Geometry, _ b: Geometry, _ t: CGFloat) -> Geometry {
            func mix(_ x: CGFloat, _ y: CGFloat) -> CGFloat { x + (y - x) * t }
            return Geometry(
                insets: EdgeInsets(top: mix(a.insets.top, b.insets.top), leading: mix(a.insets.leading, b.insets.leading), bottom: mix(a.insets.bottom, b.insets.bottom), trailing: mix(a.insets.trailing, b.insets.trailing)),
                radius: max(0, mix(a.radius, b.radius))
            )
        }
    }
}

/// Liquid Glass where the OS has it, the design system's glass token where it does not. Drawn statically (the gallery),
/// neither: ImageRenderer can't draw Liquid Glass and drops everything inside it, the panel's colour and wash included,
/// so the gallery stands the glass in underneath and this draws only what lies on it.
private struct GlassMaterial: ViewModifier {
    let shape: RoundedRectangle
    let tint: Color
    let darkness: Double
    @Environment(\.conchRendersStatically) private var rendersStatically

    func body(content: Content) -> some View {
        if rendersStatically {
            content
        } else if #available(macOS 26.0, iOS 26.0, *) {
            content.glassEffect(.regular.tint(tint), in: shape)
        } else {
            content.background(ConchColor.glass.rgba(darkness: darkness).color, in: shape)
        }
    }
}
