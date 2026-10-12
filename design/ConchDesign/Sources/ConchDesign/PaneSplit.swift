import CoreGraphics
import Foundation

// The deliverable pane's two-part layouts, made resizable (Tyler, 2026-10-12: "when its like files and images like
// that extra split type thing i want ot be able to control the size of that plane as well"): a folder's tree beside
// the file picked in it, and two versions side by side. The arithmetic is here, where it is tested; the divider is
// `PaneDividerHandle` (PaneDivider.swift).

/// A split whose leading side is a width in points: the file tree's rail beside what was picked in it. A width, not a
/// fraction, like the sidebar's: the tree wants the same room for its names however wide the window is.
public struct PaneSplit: Equatable, Sendable {
    /// Where the width is remembered (`@AppStorage`): one for every pane drawn this way, as the sidebar's is one.
    public let key: String
    /// The width it opens at, and goes back to on a double-click.
    public let standard: CGFloat
    /// The narrowest the leading side goes, and the widest.
    public let minimum: CGFloat
    public let maximum: CGFloat
    /// The room always left for the trailing side, past the divider.
    public let trailingMinimum: CGFloat

    public init(key: String, standard: CGFloat, minimum: CGFloat, maximum: CGFloat, trailingMinimum: CGFloat) {
        self.key = key
        self.standard = standard
        self.minimum = minimum
        self.maximum = maximum
        self.trailingMinimum = trailingMinimum
    }

    /// The file tree's rail, beside the file picked in it: a folder deliverable's, and the Files tab's, which are the
    /// same tree. 232 as it always was; never so narrow its names are only their first letters, nor so wide the file
    /// beside it can't be read.
    public static let fileTree = PaneSplit(
        key: "conch.fileTreeWidth",
        standard: 232,
        minimum: 160,
        maximum: 560,
        trailingMinimum: 240
    )

    /// The hairline between the two sides.
    public static let hairline: CGFloat = 1

    /// The leading side's width: the remembered one, moved by a drag in progress, kept inside its bounds and the room
    /// there is (`total`, the whole split's width), on a whole point so the hairline lands on the pixel grid.
    public func width(_ stored: Double, dragged: CGFloat = 0, in total: CGFloat) -> CGFloat {
        let wanted = restored(stored) + (dragged.isFinite ? dragged : 0)
        // The room for the leading side once the trailing one has its minimum; never under the leading's own minimum,
        // which wins in a pane too narrow for both.
        let room = total.isFinite ? total - Self.hairline - trailingMinimum : maximum
        let upper = max(minimum, min(maximum, room))
        return min(max(wanted, minimum), upper).rounded()
    }

    /// A remembered width, or the standard one when what was remembered is not a width (nothing yet, or garbage).
    public func restored(_ stored: Double) -> CGFloat {
        guard stored.isFinite, stored > 0 else { return standard }
        return CGFloat(stored)
    }

    /// A step from the keyboard (VoiceOver's adjust): this many points wider or narrower.
    public static let step: CGFloat = 24
}

/// A split whose sides share the width by a fraction: two versions side by side, which are equals.
public struct PaneFraction: Equatable, Sendable {
    public let key: String
    /// The before's share as it opens, and after a double-click: half.
    public let standard: Double
    /// The narrowest either side goes, in points.
    public let sideMinimum: CGFloat

    public init(key: String, standard: Double, sideMinimum: CGFloat) {
        self.key = key
        self.standard = standard
        self.sideMinimum = sideMinimum
    }

    /// Two versions of an artifact side by side in the deliverable pane.
    public static let compare = PaneFraction(key: "conch.compareSplit", standard: 0.5, sideMinimum: 200)

    /// The before's share of `total` (the width the two sides share, less the gap between them), with a drag in
    /// progress; each side kept to its minimum while there is room for both, and halved when there isn't.
    public func fraction(_ stored: Double, dragged: CGFloat = 0, in total: CGFloat) -> Double {
        let start = restored(stored)
        guard total.isFinite, total > 0 else { return start }
        let wanted = start + Double((dragged.isFinite ? dragged : 0) / total)
        let side = Double(sideMinimum / total)
        guard side < 0.5 else { return 0.5 }
        return min(max(wanted, side), 1 - side)
    }

    /// The before's width, on a whole point.
    public func leadingWidth(_ stored: Double, dragged: CGFloat = 0, in total: CGFloat) -> CGFloat {
        (CGFloat(fraction(stored, dragged: dragged, in: total)) * max(total, 0)).rounded()
    }

    public func restored(_ stored: Double) -> Double {
        guard stored.isFinite, stored > 0, stored < 1 else { return standard }
        return stored
    }
}
