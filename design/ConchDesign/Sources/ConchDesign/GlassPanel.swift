import SwiftUI

/// The conversation overlay as a glass panel rather than a fog: Apple's Liquid Glass in a rounded rect with a hairline
/// and a grab bar, conch's own colour under it (`~/Projects/conch-design/panel.html`, and the voice's hue the fog's
/// glows carried). Below macOS 26 it falls back to the design system's own glass token over the host's blur.
///
/// The host draws this UNDER the words as a sibling, never as their parent: a material that masks its children faded the
/// words themselves and hid the collapsed handle (Tyler: "when i press the (v) it just disappears").
public struct ConchGlassPanel: View {
    /// 0 light to 1 dark, the crossfade the fog's look took.
    public var darkness: Double
    /// The voice, whose hue colours the glass.
    public var voice: VoiceState

    public init(darkness: Double = 0, voice: VoiceState = .talk) {
        self.darkness = darkness
        self.voice = voice
    }

    /// The panel's corner, the design system's (`ConchRadius.panel`, 30) and panel.html's.
    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: ConchRadius.panel, style: .continuous) }

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
                // panel.html's `.grab`: 44 x 5, rounded, faint — it says the panel moves.
                Capsule()
                    .fill(ConchColor.textPrimary.rgba(darkness: darkness).color.opacity(0.18))
                    .frame(width: 44, height: 5)
                    .padding(.top, 9)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    /// The colour under the glass: warm at the top left falling to cool violet, the one treatment of three that read as
    /// its own thing on a light ground and a dark one (the others were indistinguishable from plain glass).
    @ViewBuilder private var colour: some View {
        if #available(macOS 15.0, iOS 18.0, *) {
            MeshGradient(width: 3, height: 3, points: Self.meshPoints, colors: Self.meshColours)
                .opacity(0.42 * (1 - 0.3 * darkness))
                .blur(radius: 40)
        } else {
            Color.clear
        }
    }

    static let meshPoints: [SIMD2<Float>] = [
        [0, 0], [0.5, 0], [1, 0],
        [0, 0.5], [0.5, 0.5], [1, 0.5],
        [0, 1], [0.5, 1], [1, 1],
    ]

    static let meshColours: [Color] = [
        Color(.sRGB, red: 0.99, green: 0.84, blue: 0.72), Color(.sRGB, red: 0.96, green: 0.80, blue: 0.84), Color(.sRGB, red: 0.85, green: 0.83, blue: 0.99),
        Color(.sRGB, red: 0.98, green: 0.87, blue: 0.79), Color(.sRGB, red: 0.93, green: 0.88, blue: 0.98), Color(.sRGB, red: 0.79, green: 0.86, blue: 0.99),
        Color(.sRGB, red: 0.95, green: 0.91, blue: 0.98), Color(.sRGB, red: 0.84, green: 0.89, blue: 1.00), Color(.sRGB, red: 0.78, green: 0.85, blue: 0.99),
    ]
}

/// Liquid Glass where the OS has it, the design system's glass token where it does not.
private struct GlassMaterial: ViewModifier {
    let shape: RoundedRectangle
    let tint: Color
    let darkness: Double

    func body(content: Content) -> some View {
        if #available(macOS 26.0, iOS 26.0, *) {
            content.glassEffect(.regular.tint(tint), in: shape)
        } else {
            content.background(ConchColor.glass.rgba(darkness: darkness).color, in: shape)
        }
    }
}
