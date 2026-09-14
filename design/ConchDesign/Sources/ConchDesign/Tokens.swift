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
    public func resolve(in environment: EnvironmentValues) -> Color { color(environment.colorScheme) }
}

/// Calm and Apple-native: warm off-white grounds, off-black text, hairlines at 10% or less,
/// glass only for floating controls, and colour kept for voice state.
public enum ConchColor {
    // Grounds and surfaces
    public static let ground = ConchColorToken("ground", .init(0xF2F1EF), .init(0x161615))
    public static let surface = ConchColorToken("surface", .init(0xFFFFFF), .init(0x1F1F1E))
    public static let surfaceRaised = ConchColorToken("surfaceRaised", .init(0xFFFFFF), .init(0x2C2C2B))
    /// The conversation fog's tint (M3).
    public static let fog = ConchColorToken("fog", .init(0xFAF9F7), .init(0x1A1A19))
    /// Laid over a material, for floating controls only.
    public static let glass = ConchColorToken("glass", .init(0xFFFFFF, alpha: 0.7), .init(0x262625, alpha: 0.7))
    /// The quiet fill behind a round control or a switch track.
    public static let fill = ConchColorToken("fill", .init(0x000000, alpha: 0.06), .init(0xFFFFFF, alpha: 0.1))
    /// The selected segment on a fill track. Translucent in dark, so it is always lighter than the track.
    public static let fillSelected = ConchColorToken("fillSelected", .init(0xFFFFFF), .init(0xFFFFFF, alpha: 0.16))

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

    // Voice state: the same in light and dark, like the macOS mic indicator.
    public static let speaking = ConchColorToken("speaking", both: .init(0x2BB5C8))
    public static let listening = ConchColorToken("listening", both: .init(0xFF9F0A))
    public static let quiet = ConchColorToken("quiet", both: .init(0x8E8E93))
    public static let ready = ConchColorToken("ready", both: .init(0x30B35A))
    public static let listeningRing = ConchColorToken("listeningRing", both: .init(0xFF9F0A, alpha: 0.22))
    public static let onVoice = ConchColorToken("onVoice", both: .init(0xFFFFFF))

    public static let grounds = [ground, surface, surfaceRaised, fog]
    public static let text = [textPrimary, textSecondary, textTertiary]
    public static let all = grounds + [glass, fill, fillSelected] + text + [hairline, hairlineStrong, accent, onAccent]
        + [speaking, listening, quiet, ready, listeningRing, onVoice]
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
    #endif

    /// Line spacing to add to reading text.
    public static let readingLineSpacing: CGFloat = 4

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

public enum ConchElevation: String, CaseIterable, Sendable {
    /// On the ground.
    case flat
    /// A selected segment, a key.
    case raised
    /// The control bar and other glass.
    case floating
    /// A panel over other apps.
    case overlay

    var radius: CGFloat { [0, 1.5, 14, 24][index] }
    var y: CGFloat { [0, 1, 10, 18][index] }
    var opacity: Double { [0, 0.1, 0.22, 0.26][index] }
    private var index: Int { Self.allCases.firstIndex(of: self)! }
}

private struct ElevationModifier: ViewModifier {
    let level: ConchElevation
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        // Dark grounds swallow a shadow, so it doubles there.
        content.shadow(
            color: .black.opacity(scheme == .dark ? min(0.6, level.opacity * 2) : level.opacity),
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

public enum ConchMotion {
    public static let quick: Double = 0.15
    public static let standard: Double = 0.25
    public static let gentle: Double = 0.4
    /// One swell of a waveform bar.
    public static let wavePeriod: Double = 1.1
    /// One breath of a listening mic.
    public static let breathPeriod: Double = 2.4

    /// Nil under Reduce Motion, so `withAnimation(ConchMotion.animation(...))` simply jumps.
    public static func animation(_ duration: Double = standard, reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .easeInOut(duration: duration)
    }
}
