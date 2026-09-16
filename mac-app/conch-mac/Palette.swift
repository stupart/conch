import AppKit
import ConchDesign
import SwiftUI

/// One `Color` per token, resolved for whichever appearance the view is drawn in.
///
/// Every palette call site stores and mutates a `Color` — `.opacity(…)`, `.fill(…)`, a colour
/// held in a struct — so the palette cannot simply become a `ShapeStyle` without touching all
/// 448 of them. An `NSColor` with a dynamic provider keeps the type and still follows the
/// system theme.
private extension ConchColorToken {
    var dynamic: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return NSColor(self.rgba(isDark ? .dark : .light).color)
        })
    }
}

/// The Mac app's colours, now the design system's colours.
///
/// This palette was a second source of truth: a fixed dark set of literals, maintained beside
/// `ConchDesign/Tokens.swift` and drifting from it. Every name below still exists, so no call
/// site changes, but each one now resolves from a token — which also means the window follows
/// the system appearance instead of forcing dark, the "Light mode" half of the original brief.
///
/// The voice and state colours are deliberately NOT moved yet. Mapping them onto the design
/// system's own (mic-open from cyan to `listening` orange, "your turn" to ink) rewrites the
/// colour language Tyler reads the ledger by every day, which is a change to see and react to
/// rather than one to slip in under a theme change.
enum ConchPalette {
    static let bg = ConchColor.ground.dynamic
    /// Chips, capsules and panels that sit above the ground. In light that is plain white
    /// against the off-white ground; in dark, one step up from it.
    static let raised = ConchColor.surfaceRaised.dynamic
    /// The quiet fill behind your own turns (§3), and the one the switch tracks use.
    static let fill = ConchColor.fill.dynamic
    /// Selection must outrank hover — this palette's oldest bug was the two inverted. Both now
    /// come from measured tokens that step the same way off the ground (design/ConchDesign).
    static let selection = ConchColor.rowSelected.dynamic
    static let hover = ConchColor.rowHover.dynamic
    static let textPrimary = ConchColor.textPrimary.dynamic
    static let textDim = ConchColor.textSecondary.dynamic
    static let textFaint = ConchColor.textTertiary.dynamic
    static let divider = ConchColor.hairline.dynamic
    /// The stage's own panel (§3) — the lab's `--surface`, #FFFFFF in light. Distinct from
    /// `raised`, which is a step above the ground in dark.
    static let surface = ConchColor.surface.dynamic
    /// The design system's accent: near-black ink, the lab's `--accent:#1D1D1F`. Deliberately
    /// NOT the `accent` below, which is the orange of the old state language and moves as its
    /// own change.
    static let ink = ConchColor.accent.dynamic
    static let onInk = ConchColor.onAccent.dynamic

    // Still literals, and still dark-only, until the state language moves as its own change.
    static let accent = Color(
        red: 0.957,
        green: 0.44,
        blue: 0.0
    )
    static let brandCyan = Color(
        red: 88.0 / 255.0,
        green: 201.0 / 255.0,
        blue: 212.0 / 255.0
    )
    // A calm -> act-now ladder, matching the terminal. "working" is the only
    // restful state; "waiting" means a finished turn is sitting on YOU, so it
    // reads as attention rather than inert grey; "needs" is blocking and
    // outranks it.
    // Machine-busy states share a calmer cyan so the brand cyan at full strength
    // can mean one thing only: your microphone is open. That is the state with
    // the highest cost of being wrong about.
    static let statusWorking = Color(
        red: 0.31,
        green: 0.55,
        blue: 0.60
    )
    static let statusMicOpen = brandCyan
    // Waiting and review were 20/255 apart in a single channel — the same gold,
    // separated only by glyph shape. Waiting now sits at the orange end, where
    // "a finished turn is sitting on you" belongs.
    static let statusWaiting = Color(
        red: 0.96,
        green: 0.60,
        blue: 0.13
    )
    /// These two have exact token equivalents whose meaning already matches, and both were
    /// unreadable on a light ground as literals — the review gold measured 1.3:1 there.
    static let statusNeeds = ConchColor.attention.dynamic
    static let statusReview = ConchColor.ready.dynamic
}

enum ConchTypography {
    private static let family = "Helvetica Neue"

    /// `relativeTo:` is what makes a custom face respect the system text-size
    /// setting. Without it every size here was a fixed point value and the app
    /// ignored Dynamic Type entirely — bad for a dashboard meant to be
    /// glanceable from across a room.
    static func font(
        size: CGFloat,
        weight: Font.Weight = .regular,
        relativeTo style: Font.TextStyle = .body
    ) -> Font {
        guard NSFont(name: family, size: size) != nil else {
            return .system(size: size, weight: weight)
        }
        return .custom(family, size: size, relativeTo: style).weight(weight)
    }

    static func nsFont(size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        guard let base = NSFont(name: family, size: size) else {
            return .systemFont(ofSize: size, weight: weight)
        }
        guard weight >= .medium else { return base }
        return NSFontManager.shared.convert(base, toHaveTrait: .boldFontMask)
    }
}
