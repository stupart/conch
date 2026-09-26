import SwiftUI

// MARK: - Colour

/// An sRGB colour with alpha, kept as data so contrast is measured rather than judged by eye.
public struct ConchRGBA: Equatable, Sendable {
    public let hex: UInt32
    public let alpha: Double

    public init(_ hex: UInt32, alpha: Double = 1) {
        self.hex = hex
        self.alpha = alpha
    }

    var red: Double { Double(hex >> 16 & 0xFF) / 255 }
    var green: Double { Double(hex >> 8 & 0xFF) / 255 }
    var blue: Double { Double(hex & 0xFF) / 255 }

    public var color: Color { Color(.sRGB, red: red, green: green, blue: blue, opacity: alpha) }

    public var hexString: String {
        String(format: "#%06X", hex) + (alpha < 1 ? " @ \(Int((alpha * 100).rounded()))%" : "")
    }

    /// This colour laid over an opaque `background`: what is seen there, opaque.
    public func over(_ background: ConchRGBA) -> ConchRGBA {
        func mix(_ fore: Double, _ back: Double) -> UInt32 { UInt32(((fore * alpha + back * (1 - alpha)) * 255).rounded()) }
        return ConchRGBA(mix(red, background.red) << 16 | mix(green, background.green) << 8 | mix(blue, background.blue))
    }

    /// WCAG 2 contrast ratio of this colour, composited over an opaque `background`, against it.
    public func contrast(on background: ConchRGBA) -> Double {
        func over(_ fore: Double, _ back: Double) -> Double { fore * alpha + back * (1 - alpha) }
        let fore = Self.luminance(over(red, background.red), over(green, background.green), over(blue, background.blue))
        let back = Self.luminance(background.red, background.green, background.blue)
        return (max(fore, back) + 0.05) / (min(fore, back) + 0.05)
    }

    static func luminance(_ r: Double, _ g: Double, _ b: Double) -> Double {
        func linear(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }
}

/// A colour role with a light and a dark value. It is a ShapeStyle, so `.foregroundStyle(ConchColor.textPrimary)`
/// resolves from the view's own colour scheme, in an app window and in `ImageRenderer` alike.
public struct ConchColorToken: ShapeStyle, Sendable {
    public let name: String
    public let light: ConchRGBA
    public let dark: ConchRGBA

    init(_ name: String, _ light: ConchRGBA, _ dark: ConchRGBA) {
        self.name = name
        self.light = light
        self.dark = dark
    }

    init(_ name: String, both: ConchRGBA) {
        self.init(name, both, both)
    }

    public func rgba(_ scheme: ColorScheme) -> ConchRGBA { scheme == .dark ? dark : light }
    public func color(_ scheme: ColorScheme) -> Color { rgba(scheme).color }

    /// Part way from light (0) to dark (1): the overlay crossfades its palette as it turns (the lab's PAL).
    public func rgba(darkness: Double) -> ConchRGBA {
        let t = min(max(darkness, 0), 1)
        func mix(_ a: Double, _ b: Double) -> UInt32 { UInt32(((a + (b - a) * t) * 255).rounded()) }
        return ConchRGBA(mix(light.red, dark.red) << 16 | mix(light.green, dark.green) << 8 | mix(light.blue, dark.blue), alpha: light.alpha + (dark.alpha - light.alpha) * t)
    }

    /// The view's `conchDarkness` when it has one, else its colour scheme.
    public func resolve(in environment: EnvironmentValues) -> Color {
        environment.conchDarkness.map { rgba(darkness: $0).color } ?? color(environment.colorScheme)
    }
}

/// Calm and Apple-native: warm off-white grounds, off-black text, hairlines at 10% or less,
/// glass only for floating controls, and colour kept for voice state.
public enum ConchColor {
    // Grounds and surfaces
    public static let ground = ConchColorToken("ground", .init(0xF2F1EF), .init(0x161615))
    public static let surface = ConchColorToken("surface", .init(0xFFFFFF), .init(0x1F1F1E))
    public static let surfaceRaised = ConchColorToken("surfaceRaised", .init(0xFFFFFF), .init(0x2C2C2B))
    /// The conversation fog's tint (M3).
    public static let fog = ConchColorToken("fog", .init(0xFAF9F7), .init(0x161619))
    /// Laid over a material, for floating controls only.
    public static let glass = ConchColorToken("glass", .init(0xFFFFFF, alpha: 0.7), .init(0x262625, alpha: 0.7))
    /// The quiet fill behind a round control or a switch track.
    public static let fill = ConchColorToken("fill", .init(0x000000, alpha: 0.06), .init(0xFFFFFF, alpha: 0.1))
    /// The selected segment on a fill track. Translucent in dark, so it is always lighter than the track.
    public static let fillSelected = ConchColorToken("fillSelected", .init(0xFFFFFF), .init(0xFFFFFF, alpha: 0.16))

    /// A list row under the cursor, and the row that is selected.
    ///
    /// Both step the SAME way — darker in light, lighter in dark — so selection always outranks
    /// hover instead of the two competing from opposite sides of the ground. The Mac palette
    /// they replace learned this the hard way: hover once read as more selected than selection.
    ///
    /// Measured, not judged. That palette's note puts the floor where a surface step is
    /// perceptible at all at ~1.2:1, and workspace-v1 §7's proposed 3.5% / 6.5% lands at 1.08
    /// and 1.15 in light — a selected row fainter than the dark one it replaces (1.56).
    public static let rowHover = ConchColorToken("rowHover", .init(0x000000, alpha: 0.07), .init(0xFFFFFF, alpha: 0.08))
    public static let rowSelected = ConchColorToken("rowSelected", .init(0x000000, alpha: 0.12), .init(0xFFFFFF, alpha: 0.16))

    /// What needs YOU: a question waiting on you, daemon trouble, a destructive action. Tokens
    /// had no session-state colour at all, and the Mac app carried its own.
    ///
    /// §7 proposed #E5533D and flagged it as a guess. It measures 3.30 on the light ground —
    /// under AA, for a colour that carries text — so the light value is darkened until it
    /// clears 4.5 on both the ground and the white stage. The dark value measured 6.42 and
    /// stands.
    public static let attention = ConchColorToken("attention", .init(0xCA321B), .init(0xFF6A55))

    /// An agent at work: a session, or one of its sub-agents, running. Tyler: "could maybe generally
    /// replace the gray color for work with a blue or yea idk some other color that feels more like
    /// 'active' and 'positive'".
    ///
    /// Apple's system blue, a step brighter than a link on each ground: the dark scheme's #0A84FF
    /// in light (a link there is #0068DA to #007AFF), and in dark the accessible dark blue #409CFF
    /// lifted a touch, to #4A9EFF. Held to a mark's 3:1 (ActiveMarkTests). Light: 3.23 on the
    /// ground, 3.47 on the fog, 3.65 on surface and raised, 3.62 on the switcher's glass. Dark: 5.08
    /// on raised, 5.99 on surface, 6.56 on the fog, 6.58 on the ground, and 3.10 on the switcher's
    /// glass, where #0A84FF measured 2.34 and #409CFF 2.99.
    ///
    /// Blue, not the brand cyan: full-strength cyan means one thing, that your microphone is open.
    /// This sits 25 degrees of hue from it in light and 27 in dark (the cyan is 185, this 210 and
    /// 212), and 71 from waiting's green, so the mark that says "it is working" never reads as "it
    /// can hear you" or "come and look". Stopped short of violet, which read soft rather than
    /// active beside the cyan and drifted toward the overlay's iris glow.
    public static let active = ConchColorToken("active", .init(0x0A84FF), .init(0x4A9EFF))

    // Text: every level is at least 4.5:1 on every ground above (ConchDesignTests pins it).
    public static let textPrimary = ConchColorToken("textPrimary", .init(0x1D1D1F), .init(0xF2F1EF))
    public static let textSecondary = ConchColorToken("textSecondary", .init(0x5C5C61), .init(0xAEAEB2))
    public static let textTertiary = ConchColorToken("textTertiary", .init(0x6B6B70), .init(0x98989D))

    // Lines
    public static let hairline = ConchColorToken("hairline", .init(0x000000, alpha: 0.08), .init(0xFFFFFF, alpha: 0.08))
    public static let hairlineStrong = ConchColorToken("hairlineStrong", .init(0x000000, alpha: 0.1), .init(0xFFFFFF, alpha: 0.1))

    // Primary action
    public static let accent = ConchColorToken("accent", .init(0x1D1D1F), .init(0xF2F1EF))
    public static let onAccent = ConchColorToken("onAccent", .init(0xFFFFFF), .init(0x1D1D1F))

    // Voice state: the same in light and dark, like the macOS mic indicator, but for ready.
    public static let speaking = ConchColorToken("speaking", both: .init(0x2BB5C8))
    public static let listening = ConchColorToken("listening", both: .init(0xFF9F0A))
    public static let quiet = ConchColorToken("quiet", both: .init(0x8E8E93))
    /// Ready for you, and every mark that means come and look: the orb, the menu's dot, the sidebar's check, the
    /// switcher's dot, the phone's waiting and review.
    ///
    /// A mark needs 3:1, and #30B35A, the same in both schemes, failed it on every light surface it marks something that
    /// needs Tyler: 2.41 on the ground, 2.72 on white, about 2.4 in the menu, and 2.72 for the orb's white check. Light
    /// is #279B4C, the green the Mac's waiting mark already moved to for the same reason: 3.16 on the ground, 3.39 on the
    /// fog, 3.57 on surface and raised, about 3.1 in the menu, and the white check 3.57. Dark keeps #30B35A, which clears
    /// it everywhere: 5.14 at worst on raised, 3.14 on the switcher's glass (ActiveMarkTests).
    public static let ready = ConchColorToken("ready", .init(0x279B4C), .init(0x30B35A))
    public static let listeningRing = ConchColorToken("listeningRing", both: .init(0xFF9F0A, alpha: 0.22))
    public static let onVoice = ConchColorToken("onVoice", both: .init(0xFFFFFF))
    /// The overlay's glow while nobody is talking: a calm iris between listening's orange and speaking's teal.
    public static let idleGlow = ConchColorToken("idleGlow", both: .init(0x7F8CFF))

    // The conversation overlay, drawn over whatever is on screen, from the overlay lab's light and dark palettes.
    // Every text level is held to 4.5:1 on the panel's glass at its worst, over black or white (PanelContrastTests).
    public static let overlayText = ConchColorToken("overlayText", .init(0x1D1D1F), .init(0xF5F5F7))
    /// The light value is the dashboard's `textSecondary`. The lab's #6E6E73 measured 1.7 to 3.5 for "You" over a real
    /// screen through the glass.
    public static let overlayTextSecondary = ConchColorToken("overlayTextSecondary", .init(0x5C5C61), .init(0xB8B8BE))
    /// Words still to be read out.
    public static let overlayTextPending = ConchColorToken("overlayTextPending", .init(0x1D1D1F, alpha: 0.32), .init(0xF5F5F7, alpha: 0.36))
    /// "Reply to …" in the empty reply line: 4.5:1 like any other words, since it is the only thing saying the line is there.
    /// The lab's 28% and 32% measured 1.6 to 2.8.
    public static let overlayPlaceholder = ConchColorToken("overlayPlaceholder", .init(0x1D1D1F, alpha: 0.68), .init(0xF5F5F7, alpha: 0.64))
    public static let overlayFill = ConchColorToken("overlayFill", .init(0x1D1D1F, alpha: 0.07), .init(0xFFFFFF, alpha: 0.12))
    public static let overlayFillStrong = ConchColorToken("overlayFillStrong", .init(0x1D1D1F, alpha: 0.12), .init(0xFFFFFF, alpha: 0.2))
    /// The overlay's round buttons.
    public static let overlayGlass = ConchColorToken("overlayGlass", .init(0xFFFFFF, alpha: 0.55), .init(0x3E3E42, alpha: 0.55))
    public static let overlayGlassStrong = ConchColorToken("overlayGlassStrong", .init(0xFFFFFF, alpha: 0.9), .init(0x56565C, alpha: 0.85))
    public static let overlayGlassIcon = ConchColorToken("overlayGlassIcon", .init(0x6E6E73), .init(0xD6D6DC))
    public static let overlayLine = ConchColorToken("overlayLine", .init(0x000000, alpha: 0.14), .init(0xFFFFFF, alpha: 0.16))

    public static let grounds = [ground, surface, surfaceRaised, fog]
    public static let text = [textPrimary, textSecondary, textTertiary]
    public static let all = grounds + [glass, fill, fillSelected, rowHover, rowSelected] + text
        + [hairline, hairlineStrong, accent, onAccent, attention, active]
        + [speaking, listening, quiet, ready, listeningRing, onVoice, idleGlow] + overlay
    public static let overlay = [overlayText, overlayTextSecondary, overlayTextPending, overlayPlaceholder, overlayFill,
                                 overlayFillStrong, overlayGlass, overlayGlassStrong, overlayGlassIcon, overlayLine]
}

// MARK: - Type

/// A text role, with what it is on each platform. macOS uses SF at fixed sizes (there is no Dynamic Type);
/// iOS uses text styles, so every role follows the reader's text size.
public struct ConchTypeRole: Sendable {
    public let name: String
    public let font: Font
    public let mac: String
    public let iOS: String
}

public enum ConchType {
    #if os(macOS)
    public static let title = Font.system(size: 22, weight: .semibold)
    public static let heading = Font.system(size: 15, weight: .semibold)
    public static let readingBody = Font.system(size: 15)
    public static let uiBody = Font.system(size: 13)
    public static let uiEmphasis = Font.system(size: 13, weight: .semibold)
    public static let secondary = Font.system(size: 12)
    public static let meta = Font.system(size: 11, weight: .medium)
    public static let code = Font.system(size: 12, design: .monospaced)
    public static let conversationNow = Font.system(size: 24, weight: .medium)
    public static let conversationPast = Font.system(size: 17)
    /// The conversation full screen: the words grow with the space they have.
    public static let conversationNowFull = Font.system(size: 36, weight: .medium)
    public static let conversationPastFull = Font.system(size: 24)
    /// `conversationNow`'s size, for type drawn outside SwiftUI (the reply line's text view) and measured by it.
    public static let conversationNowSize: CGFloat = 24
    #else
    public static let title = Font.title2.weight(.semibold)
    public static let heading = Font.headline
    public static let readingBody = Font.body
    public static let uiBody = Font.subheadline
    public static let uiEmphasis = Font.subheadline.weight(.semibold)
    public static let secondary = Font.footnote
    public static let meta = Font.caption.weight(.medium)
    public static let code = Font.system(.footnote, design: .monospaced)
    public static let conversationNow = Font.system(.title, weight: .medium)
    public static let conversationPast = Font.title3
    public static let conversationNowFull = Font.largeTitle.weight(.medium)
    public static let conversationPastFull = Font.title2
    public static let conversationNowSize: CGFloat = 28
    #endif

    /// Line spacing to add to reading text.
    public static let readingLineSpacing: CGFloat = 4
    /// `readingBody`'s point size, for type that is scaled from it (a document's headings and code).
    #if os(macOS)
    public static let readingBodySize: CGFloat = 15
    #else
    public static let readingBodySize: CGFloat = 17
    #endif

    public static let roles: [ConchTypeRole] = [
        .init(name: "title", font: title, mac: "22 semibold", iOS: ".title2 semibold (22)"),
        .init(name: "heading", font: heading, mac: "15 semibold", iOS: ".headline (17)"),
        .init(name: "readingBody", font: readingBody, mac: "15 regular, +4 leading", iOS: ".body (17), +4 leading"),
        .init(name: "uiBody", font: uiBody, mac: "13 regular", iOS: ".subheadline (15)"),
        .init(name: "uiEmphasis", font: uiEmphasis, mac: "13 semibold", iOS: ".subheadline semibold (15)"),
        .init(name: "secondary", font: secondary, mac: "12 regular", iOS: ".footnote (13)"),
        .init(name: "meta", font: meta, mac: "11 medium", iOS: ".caption medium (12)"),
        .init(name: "code", font: code, mac: "12 SF Mono", iOS: ".footnote SF Mono (13)"),
        .init(name: "conversationNow", font: conversationNow, mac: "24 medium", iOS: ".title medium (28)"),
        .init(name: "conversationPast", font: conversationPast, mac: "17 regular", iOS: ".title3 (20)"),
        .init(name: "conversationNowFull", font: conversationNowFull, mac: "36 medium", iOS: ".largeTitle medium (34)"),
        .init(name: "conversationPastFull", font: conversationPastFull, mac: "24 regular", iOS: ".title2 (22)"),
    ]
}

// MARK: - Space, radius, elevation, motion

/// A 4-point scale.
public enum ConchSpace {
    public static let x1: CGFloat = 4
    public static let x2: CGFloat = 8
    public static let x3: CGFloat = 12
    public static let x4: CGFloat = 16
    public static let x5: CGFloat = 20
    public static let x6: CGFloat = 24
    public static let x8: CGFloat = 32
    public static let x10: CGFloat = 40
    public static let x12: CGFloat = 48
    public static let scale = [x1, x2, x3, x4, x5, x6, x8, x10, x12]
}

public enum ConchRadius {
    /// Menu rows, keycaps.
    public static let small: CGFloat = 6
    /// Menus, fields.
    public static let medium: CGFloat = 12
    /// Cards.
    public static let large: CGFloat = 18
    /// Floating panels.
    public static let panel: CGFloat = 30
    public static let scale = [small, medium, large, panel]
}

/// The lab's four shadows in SwiftUI's terms. CSS blur is twice SwiftUI's shadow radius, so
/// `0 1px 2px` is radius 1 at y 1; every value below is `workspace-lab.html`'s own, light and
/// dark, rather than one derived from the other.
public enum ConchElevation: String, CaseIterable, Sendable {
    /// On the ground.
    case flat
    /// The stage's own panel — `--shPanel`, a whisper in light that vanishes on dark.
    case panel
    /// A selected segment, a key — `--shRaised`.
    case raised
    /// The control bar and other glass — `--shFloat`.
    case floating
    /// A panel over other apps — `--shOver`.
    case overlay

    var radius: CGFloat { [0, 1.5, 1, 14, 32][index] }
    var y: CGFloat { [0, 1, 1, 10, 24][index] }
    var opacity: Double { [0, 0.04, 0.14, 0.24, 0.32][index] }
    /// The lab's dark block, not a rule applied to the light value: the panel keeps its ring
    /// and drops its shadow outright, and the three that remain go heavier than any blanket
    /// factor would guess (`--shFloat` is .24 light and .7 dark).
    var darkOpacity: Double { [0, 0, 0.4, 0.7, 0.75][index] }
    private var index: Int { Self.allCases.firstIndex(of: self)! }
}

private struct ElevationModifier: ViewModifier {
    let level: ConchElevation
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        // Each level carries the lab's own dark value. "Dark grounds swallow a shadow, so it
        // doubles there" was wrong in both directions: `--shPanel` has NO drop on dark, and
        // the three that keep one go far past doubling.
        content.shadow(
            color: .black.opacity(scheme == .dark ? level.darkOpacity : level.opacity),
            radius: level.radius,
            y: level.y
        )
    }
}

extension View {
    public func conchElevation(_ level: ConchElevation) -> some View {
        modifier(ElevationModifier(level: level))
    }
}

/// A spring in SwiftUI's own terms: `bounce` 0 settles without overshoot and higher overshoots more; `response` is
/// roughly how long it takes, in seconds. Tuned in the overlay lab (~/Projects/conch-design/overlay-lab.html).
public struct ConchSpring: Equatable, Sendable {
    public let bounce: Double
    public let response: Double

    public init(bounce: Double, response: Double) {
        self.bounce = bounce
        self.response = response
    }

    /// For stepping a spring by hand, as a window frame has to be: unit mass, the same curve as `animation`.
    public var stiffness: Double { pow(2 * .pi / response, 2) }
    public var damping: Double { 4 * .pi * (1 - bounce) / response }

    /// One frame of `value` pulled toward `target`, in fixed 240 Hz substeps so it moves the same at any frame rate.
    /// True once it rests within `epsilon`.
    @discardableResult
    public func step(_ value: inout CGFloat, velocity: inout CGFloat, to target: CGFloat, dt: Double, epsilon: CGFloat = 0.001) -> Bool {
        let k = CGFloat(stiffness), c = CGFloat(damping)
        var t = dt
        while t > 1e-9 {
            let h = CGFloat(min(t, 1.0 / 240))
            velocity += (-k * (value - target) - c * velocity) * h
            value += velocity * h
            t -= 1.0 / 240
        }
        return abs(value - target) < epsilon && abs(velocity) < epsilon * 10
    }

    /// Reduce Motion keeps the timing and drops the overshoot, so things still resolve, calmly.
    public func resolved(reduceMotion: Bool) -> ConchSpring {
        reduceMotion ? ConchSpring(bounce: 0, response: response) : self
    }

    public func animation(reduceMotion: Bool) -> Animation {
        let spring = resolved(reduceMotion: reduceMotion)
        return .spring(duration: spring.response, bounce: spring.bounce)
    }
}

public enum ConchMotion {
    // Springs: the overlay lab's Default feel. Its Calm and Island presets are still to be chosen between.
    /// A throw docking in its corner.
    public static let dock = ConchSpring(bounce: 0.2, response: 0.45)
    /// A big view changing shape: collapse, full screen. Big things bounce less.
    public static let morph = ConchSpring(bounce: 0.12, response: 0.46)
    /// A small control appearing, like the collapsed caret. Small things bounce more.
    public static let pop = ConchSpring(bounce: 0.34, response: 0.36)
    /// The reply line growing a line.
    public static let grow = ConchSpring(bounce: 0.12, response: 0.34)
    /// A voice state's colour taking over.
    public static let voiceColour = ConchSpring(bounce: 0, response: 0.4)
    /// Light and dark trading places.
    public static let appearance = ConchSpring(bounce: 0, response: 0.3)
    /// One deliverable in the panel giving way to the next: the old one out soft and a touch large, the new one in from a
    /// touch small and soft (panel-lab's stage swoop).
    public static let swap = ConchSpring(bounce: 0.08, response: 0.52)
    /// Something letting go of its corner or settling back into it: a thrown panel's fade, its look leaving the corner,
    /// its buttons hiding mid-air, the panel's words stepping aside for a morph. Quick, and no overshoot.
    public static let liftOff = ConchSpring(bounce: 0, response: 0.2)
    /// The pointer coming over something: the panel's buttons filling in, the resize band's glow, a fade opening at the
    /// transcript's near end.
    public static let hover = ConchSpring(bounce: 0, response: 0.3)
    /// A message you sent flying from the reply line into the transcript.
    public static let sent = ConchSpring(bounce: 0.14, response: 0.42)
    /// The panel's words, or its deliverable, arriving once its frame has landed (panel-lab's `.inner`, 0.1 / 0.42).
    public static let reveal = ConchSpring(bounce: 0.1, response: 0.42)
    public static let springs: [(name: String, spring: ConchSpring)] = [
        ("dock", dock), ("morph", morph), ("pop", pop), ("grow", grow), ("voiceColour", voiceColour), ("appearance", appearance), ("swap", swap),
        ("liftOff", liftOff), ("hover", hover), ("sent", sent), ("reveal", reveal),
    ]

    /// How small and soft a deliverable comes in on `swap`; it leaves as much larger.
    public static let swapScale: CGFloat = 0.965
    public static let swapBlur: CGFloat = 6

    /// The panel's content coming back after its frame morphs (full screen, docked, collapsed): `revealDelay` after the
    /// frame lands, from a touch small and soft, on `reveal`. Never while it is still small: the words laid out for full
    /// screen inside a docked-size window was what the morph used to show.
    public static let revealScale: CGFloat = 0.985
    public static let revealBlur: CGFloat = 3
    public static let revealDelay: Double = 0.12

    /// One session's words and header giving way to another's (panel-lab's crossfade): the old out soft and up, the new in
    /// from a little below, on `pop`, the words `crossStagger` behind the header. Never a hard cut.
    public static let crossBlur: CGFloat = 4
    public static let crossShift: CGFloat = 8
    public static let crossScale: CGFloat = 0.985
    public static let crossStagger: Double = 0.024

    /// A popover opening on `pop` (the panel's switcher, panel-lab's `#switcher`): from a touch small, `popShift` toward
    /// where it opens from and soft; its rows following `popStagger` apart after `popLead`.
    public static let popScale: CGFloat = 0.94
    public static let popShift: CGFloat = 6
    public static let popBlur: CGFloat = 4
    public static let popLead: Double = 0.04
    public static let popStagger: Double = 0.018

    /// A thrown view mid-air: a little smaller, softer and fainter, whole again as it lands.
    public static let flightScale: CGFloat = 0.97
    public static let flightBlur: CGFloat = 3
    public static let flightOpacity: CGFloat = 0.9

    /// Words arriving: each fades up out of a small blur, at a talking pace.
    public static let wordReveal: Double = 0.36
    public static let wordRevealBlur: CGFloat = 4
    public static let wordsPerSecond: Double = 13

    /// A scroll view's normal deceleration, per millisecond.
    public static let deceleration = 0.998
    /// How far `velocity` (points per second) carries under that deceleration: where a throw is heading
    /// (WWDC18, "Designing Fluid Interfaces").
    public static func projectedDistance(_ velocity: CGFloat) -> CGFloat {
        velocity * deceleration / (1 - deceleration) / 1000
    }

    public static let quick: Double = 0.15
    public static let standard: Double = 0.25
    public static let gentle: Double = 0.4
    /// One swell of a waveform bar.
    public static let wavePeriod: Double = 1.1
    /// One breath of a listening mic.
    public static let breathPeriod: Double = 2.4
    /// One breath of an agent at work (`ActiveMark`): slower than the mic's, a resting pace, so a list of working
    /// sessions reads as alive rather than busy.
    public static let activeBreathPeriod: Double = 4

    /// Nil under Reduce Motion, so `withAnimation(ConchMotion.animation(...))` simply jumps.
    public static func animation(_ duration: Double = standard, reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .easeInOut(duration: duration)
    }
}
