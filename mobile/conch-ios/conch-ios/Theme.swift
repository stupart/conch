import ConchDesign
import SwiftUI
import UIKit

/// The design system's colours, so the two surfaces read as one product.
///
/// These used to be the Mac dashboard's palette COPIED — literal values kept in step by
/// hand across two apps. The Mac now resolves from `ConchDesign/Tokens.swift`, which left
/// this file as the last copy; it resolves from the same tokens instead. Every name here is
/// unchanged, so no call site moves.
///
/// A `UIColor` with a dynamic provider is what lets that happen without touching the ~240
/// call sites: they all store and pass a `Color`.
private extension ConchColorToken {
    var dynamic: Color {
        Color(uiColor: UIColor { traits in
            UIColor(self.rgba(traits.userInterfaceStyle == .dark ? .dark : .light).color)
        })
    }
}

enum Palette {
    static let bg = ConchColor.ground.dynamic
    static let raised = ConchColor.surfaceRaised.dynamic
    static let textPrimary = ConchColor.textPrimary.dynamic
    static let textDim = ConchColor.textSecondary.dynamic
    static let textFaint = ConchColor.textTertiary.dynamic
    static let divider = ConchColor.hairline.dynamic

    // The voice and state ladder stays literal, exactly as it does on the Mac: mapping
    // mic-open onto `listening` orange, or "a finished turn" onto ink, rewrites the colour
    // language the ledger is read by. That is a change to see and react to, not one to slip
    // in under a theme change.

    /// An agent at work, a session or one of its sub-agents running: ConchDesign's `active`, the
    /// Mac's working blue. Tyler: "could maybe generally replace the gray color for work with a
    /// blue or yea idk some other color that feels more like 'active' and 'positive'". Its 3:1 on
    /// every ground, and its distance from the mic's cyan, are measured in ActiveMarkTests.
    static let active = ConchColor.active.dynamic
    /// Calm, ignorable: reading a reply aloud, a tool call or plan step, an added line, a live
    /// connection. It drew the working mark too until that became `active`; what is left here is
    /// not an agent at work, so it did not move.
    static let calm = Color(red: 0.31, green: 0.55, blue: 0.60)
    /// Your microphone is open — the one state that owns full brand cyan.
    static let micOpen = Color(red: 88 / 255, green: 201 / 255, blue: 212 / 255)
    /// A finished turn is sitting on you: ready for you, in ready's green, as on the Mac. It was
    /// orange here after the Mac moved to green ("does orange dot mean its waiting for me? We
    /// should make that green"), so the two apps disagreed about the one state that asks for
    /// you; the glyph, not the colour, tells it from a deliverable.
    static let waiting = ConchColor.ready.dynamic
    /// The orange waiting used to borrow, kept for what is a caution rather than a state: a
    /// connection gone quiet, a send conch could not confirm, the button that stops a turn.
    static let caution = Color(red: 0.96, green: 0.60, blue: 0.13)
    /// Blocked on an answer. Its token equivalent already means this, and the literal was
    /// dark-only.
    static let needs = ConchColor.attention.dynamic
    /// Ready for you, with work to look at. The literal gold measured 1.3:1 on a light ground.
    static let review = ConchColor.ready.dynamic
}

/// iOS speaks SF. The Mac app's Helvetica Neue is its own voice; forcing it
/// here would fight Dynamic Type and read as a port. Same hierarchy, native
/// materials — that is what makes the two feel like siblings, not clones.
///
/// TEXT STYLES, not point sizes: fixed sizes opted the whole app out of the
/// platform's accessibility contract — at XXXL only the nav title scaled.
enum Type {
    static func label(_ size: CGFloat = 17, weight: Font.Weight = .regular) -> Font {
        // Actually ride the user's text size: a fixed .system(size:) here made
        // card TITLES stay put while their scaling captions outgrew them -
        // hierarchy inverted exactly at the accessibility sizes that need it.
        let scaled = UIFontMetrics(forTextStyle: .body).scaledValue(for: size)
        return .system(size: scaled, weight: weight)
    }

    static let sessionName = Font.body.weight(.semibold)
    static let summary = Font.subheadline
    static let body = Font.body
    static let caption = Font.footnote
    static let mono = Font.system(.subheadline, design: .monospaced)
}
