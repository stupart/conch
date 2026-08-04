import SwiftUI

/// The Mac dashboard's exact palette, so the two surfaces read as one product.
/// Values are copied, not approximated — the status ladder was converged on by
/// measurement over five audits and is not to be re-derived by eye here.
enum Palette {
    static let bg = Color(red: 0.043, green: 0.051, blue: 0.047)
    static let raised = Color(red: 0.186, green: 0.209, blue: 0.198)
    static let textPrimary = Color(red: 0.91, green: 0.93, blue: 0.91)
    static let textDim = Color(red: 0.48, green: 0.52, blue: 0.50)
    static let textFaint = Color(red: 0.48, green: 0.52, blue: 0.50).opacity(0.93)
    static let divider = Color.white.opacity(0.075)

    /// Machine-busy. Calm, ignorable.
    static let working = Color(red: 0.31, green: 0.55, blue: 0.60)
    /// Your microphone is open — the one state that owns full brand cyan.
    static let micOpen = Color(red: 88 / 255, green: 201 / 255, blue: 212 / 255)
    /// A finished turn is sitting on you.
    static let waiting = Color(red: 0.96, green: 0.60, blue: 0.13)
    /// Blocked on an answer.
    static let needs = Color(red: 0.94, green: 0.38, blue: 0.24)
    /// Has work for you to look at.
    static let review = Color(red: 0.98, green: 0.84, blue: 0.32)
}

/// iOS speaks SF. The Mac app's Helvetica Neue is its own voice; forcing it
/// here would fight Dynamic Type and read as a port. Same hierarchy, native
/// materials — that is what makes the two feel like siblings, not clones.
///
/// TEXT STYLES, not point sizes: fixed sizes opted the whole app out of the
/// platform's accessibility contract — at XXXL only the nav title scaled.
enum Type {
    static func label(_ size: CGFloat = 17, weight: Font.Weight = .regular) -> Font {
        // Sized labels ride .body so they still scale with the user's setting.
        .system(size: size, weight: weight)
    }

    static let sessionName = Font.body.weight(.semibold)
    static let summary = Font.subheadline
    static let body = Font.body
    static let caption = Font.footnote
    static let mono = Font.system(.subheadline, design: .monospaced)
}
