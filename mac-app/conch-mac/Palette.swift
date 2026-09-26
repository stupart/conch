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
    /// The lab's `--hair2` (`rgba(0,0,0,.1)`), a step up from `divider`'s `--hair`. It is what
    /// `.dc` draws around the inline deliverable: `box-shadow:inset 0 0 0 1px var(--hair2)`.
    static let hairlineStrong = ConchColor.hairlineStrong.dynamic
    /// The drop target's ring — the lab's `.cbox.drop{box-shadow:0 0 0 2px #0A84FF,...}`.
    /// macOS's own drop blue, hard-coded in the prototype rather than following the system
    /// accent, because a drop target that changes colour per person is not a signal.
    static let dropTarget = Color(red: 0.039, green: 0.518, blue: 1)
    /// The stage's own panel (§3) — the lab's `--surface`, #FFFFFF in light. Distinct from
    /// `raised`, which is a step above the ground in dark.
    static let surface = ConchColor.surface.dynamic
    /// The selected segment on a `fill` track — the lab's `--fillSel`, plain white in light.
    /// `.seg button.on` puts `--shRaised` over it as well: see `ConchElevation.raised`.
    static let fillSelected = ConchColor.fillSelected.dynamic
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
    // No other session state borrows the brand cyan at full strength, so in the
    // ledger it can mean one thing only: your microphone is open. That is the
    // state with the highest cost of being wrong about.
    //
    // Working is BLUE: an agent running, a session or one of its sub-agents. It was the faint ink
    // idle uses, on Tyler's earlier "no icon or color at all since its working"; he has since
    // asked the other way — "could maybe generally replace the gray color for work with a blue or
    // yea idk some other color that feels more like 'active' and 'positive'" — and "make it more
    // clear when sub-agents are working vs paused". Grey said "nothing is happening" about the
    // sessions where the most was.
    //
    // It stays the calm end of the ladder by shape and stillness rather than by greyness: a small
    // dot, still apart from a slow breath of its halo (`activeBreath`), while waiting, needs and
    // review keep the larger, still marks. The value is ConchDesign's `active`: #0A84FF in light,
    // #4A9EFF in dark. As a mark it clears 3:1 on bg, surface, raised and fog in both schemes, 3.23
    // at worst in light (bg) and 5.08 in dark (raised), and sits 25-27 degrees of hue from the
    // mic's cyan (ActiveMarkTests).
    //
    // For an agent's working state only. A sub-agent that is not running is PAUSED, a hollow ring
    // in `textFaint`, never waiting's green: nobody replies to a sub-agent.
    static let statusActive = ConchColor.active.dynamic
    // The faint ink working used to share, kept for the marks that are not an agent at work and so
    // did not move with it: reading a reply aloud (the turn is over), a starting daemon, "Copied",
    // a notice's button, an observed capability, a tool call or plan step in the transcript.
    static let statusQuiet = textFaint
    static let statusMicOpen = brandCyan
    // Waiting is GREEN, in review's family, because both mean the same thing to the person
    // reading the ledger: come and look. Tyler: "does orange dot mean its waiting for me? We
    // should make that green or blue or something" — then, on how to keep it apart from review:
    // "maybe do same green circle just with no check?". The glyph already does that work
    // (`circle.inset.filled` against review's `checkmark.circle.fill`), so only the colour moved.
    //
    // It was NOT review's own #30B35A then: a mark needs 3:1 and that green measured 2.41-2.72 on
    // the light grounds — the same failure the note below records for the review gold at 1.3:1.
    // #279B4C is the nearest green that clears it everywhere, 3.16 at worst, and ConchDesign's
    // `ready` has since taken it as its light value for the same reason, so waiting IS ready's token
    // now: one green for "come and look", the phone's too. Dark keeps ready's #30B35A, which clears
    // 3:1 by more than #279B4C did. The orange it replaced failed too (2.11-2.22 on light).
    //
    // This reverses the earlier decision that put waiting at the orange end. That was to separate
    // it from review when the two were 20/255 apart in one channel; the glyph separates them now.
    static let statusWaiting = ConchColor.ready.dynamic
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
