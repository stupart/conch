import CoreGraphics
import SwiftUI

// The before/after views both apps draw (VersionCompare.swift has the rules they follow). Plain SwiftUI over decoded
// pictures and a worked-out diff, so the Mac's deliverable pane and the phone's review sheet draw one comparison, and a
// test can render it offscreen (`VersionCompareRenderTests`) and look at the pixels.

/// Which side of a comparison a caption names.
public enum VersionSide: String, Sendable {
    case before
    case after

    public var title: String { self == .before ? "Before" : "After" }
}

/// One side's name above its picture or page: "BEFORE  v1 · 2h ago — Flat grade, straight from the camera".
public struct VersionCaption: View {
    private let side: VersionSide
    private let line: String

    public init(_ side: VersionSide, line: String) {
        self.side = side
        self.line = line
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(side.title.uppercased())
                .font(ConchType.meta)
                .foregroundStyle(ConchColor.textTertiary)
                .fixedSize()
            Text(line)
                .font(ConchType.secondary)
                .foregroundStyle(ConchColor.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// The two versions of a picture one over the other, the before left of a divider and the after right of it. Drag
/// (or press) anywhere on the picture to put the divider there; with the keyboard, ← and → move it a step, shift a
/// larger one; VoiceOver adjusts it as a slider. Both are drawn in the after's frame, fitted whole, so a before of
/// another shape sits centred in it rather than being stretched.
public struct VersionCompareSlider: View {
    private let before: CGImage
    private let after: CGImage
    private let beforeName: String
    private let afterName: String
    private let matte: ConchColorToken
    @Binding private var fraction: Double
    @FocusState private var focused: Bool

    /// `matte` is what shows where a version has no pixels (a narrower before, a transparent one): the ground the view
    /// sits on, so the picture's frame does not show as a box of its own.
    public init(
        before: CGImage,
        after: CGImage,
        beforeName: String,
        afterName: String,
        fraction: Binding<Double>,
        matte: ConchColorToken = ConchColor.ground
    ) {
        self.before = before
        self.after = after
        self.beforeName = beforeName
        self.afterName = afterName
        self.matte = matte
        _fraction = fraction
    }

    public var body: some View {
        GeometryReader { geometry in
            let rect = CompareSlider.fit(CGSize(width: after.width, height: after.height), in: geometry.size)
            stage(rect.size)
                .offset(x: rect.minX, y: rect.minY)
        }
    }

    private func stage(_ size: CGSize) -> some View {
        let x = CompareSlider.dividerX(fraction, width: size.width)
        return ZStack(alignment: .topLeading) {
            Self.picture(after)
                .background(matte)
            // On a ground of its own: a before of another shape, or one with transparent parts, must show the ground
            // where it has nothing, never the after through it, or the left of the divider stops being the before.
            Self.picture(before)
                .background(matte)
                .mask(alignment: .leading) {
                    Rectangle().frame(width: x)
                }
            // A white line with a dark edge either side, so it reads over a white page and a night sky alike.
            Rectangle()
                .fill(Color.white)
                .frame(width: 2, height: size.height)
                .overlay(Rectangle().stroke(Color.black.opacity(0.25), lineWidth: 0.5))
                .offset(x: x - 1)
            handle
                .position(x: x, y: size.height / 2)
            HStack(alignment: .top) {
                if CompareSlider.showsBeforeLabel(fraction) { chip(beforeName) }
                Spacer(minLength: 0)
                if CompareSlider.showsAfterLabel(fraction) { chip(afterName) }
            }
            .padding(10)
            .frame(width: size.width)
            .allowsHitTesting(false)
        }
        .frame(width: size.width, height: size.height)
        .clipped()
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { drag in
                    fraction = CompareSlider.fraction(atX: drag.location.x, width: size.width)
                    focused = true
                }
        )
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(keys: [.leftArrow, .rightArrow]) { press in
            fraction = CompareSlider.moved(
                fraction,
                by: press.key == .leftArrow ? -1 : 1,
                large: press.modifiers.contains(.shift)
            )
            return .handled
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Before and after: \(beforeName) on the left, \(afterName) on the right")
        .accessibilityValue(CompareSlider.accessibilityValue(fraction, before: beforeName, after: afterName))
        .accessibilityHint("Adjust to move the divider")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: fraction = CompareSlider.moved(fraction, by: 1)
            case .decrement: fraction = CompareSlider.moved(fraction, by: -1)
            @unknown default: break
            }
        }
    }

    /// The grip on the divider: what says it can be dragged. Ringed while the keys move it.
    private var handle: some View {
        Image(systemName: "arrow.left.and.right")
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(Color.black.opacity(0.75))
            .frame(width: 30, height: 30)
            .background(Circle().fill(Color.white))
            .overlay(Circle().stroke(Color.black.opacity(0.2), lineWidth: 0.5))
            .overlay {
                if focused {
                    Circle().stroke(ConchColor.active, lineWidth: 2).padding(-3)
                }
            }
            .shadow(color: .black.opacity(0.3), radius: 3, y: 1)
    }

    /// A side's name in its corner, on the picture: dark glass, so it reads over anything.
    private func chip(_ name: String) -> some View {
        Text(name)
            .font(ConchType.meta)
            .foregroundStyle(Color.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(Color.black.opacity(0.55)))
    }

    static func picture(_ image: CGImage, alignment: Alignment = .center) -> some View {
        Image(decorative: image, scale: 1)
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment)
    }
}

/// Two versions each whole, captioned, beside each other or one above the other: `axis`. Any content, so the Mac can
/// put two pages or two PDFs here as readily as two pictures.
public struct VersionPanes<Before: View, After: View>: View {
    private let beforeLine: String
    private let afterLine: String
    private let axis: Axis
    private let spacing: CGFloat
    private let before: Before
    private let after: After

    public init(
        beforeLine: String,
        afterLine: String,
        axis: Axis = .horizontal,
        spacing: CGFloat = 12,
        @ViewBuilder before: () -> Before,
        @ViewBuilder after: () -> After
    ) {
        self.beforeLine = beforeLine
        self.afterLine = afterLine
        self.axis = axis
        self.spacing = spacing
        self.before = before()
        self.after = after()
    }

    public var body: some View {
        let layout = axis == .horizontal ? AnyLayout(HStackLayout(spacing: spacing)) : AnyLayout(VStackLayout(spacing: spacing))
        layout {
            VStack(spacing: 6) {
                VersionCaption(.before, line: beforeLine)
                before.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            VStack(spacing: 6) {
                VersionCaption(.after, line: afterLine)
                after.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

/// Two versions of a picture side by side, or stacked when that draws them bigger (`CompareLayout.axis`).
public struct VersionPicturesSideBySide: View {
    private let before: CGImage
    private let after: CGImage
    private let beforeLine: String
    private let afterLine: String

    public init(before: CGImage, after: CGImage, beforeLine: String, afterLine: String) {
        self.before = before
        self.after = after
        self.beforeLine = beforeLine
        self.afterLine = afterLine
    }

    public var body: some View {
        GeometryReader { geometry in
            // Less the two captions' line, which either arrangement spends.
            let room = CGSize(width: geometry.size.width, height: max(0, geometry.size.height - 22))
            let axis = CompareLayout.axis(
                before: CGSize(width: before.width, height: before.height),
                after: CGSize(width: after.width, height: after.height),
                in: room
            )
            // Each picture right under its caption: centred in its half, a stacked pair floated away from the words
            // naming it, with the gap between the two reading as belonging to neither.
            VersionPanes(beforeLine: beforeLine, afterLine: afterLine, axis: axis) {
                VersionCompareSlider.picture(before, alignment: .top)
                    .accessibilityLabel("Before: \(beforeLine)")
            } after: {
                VersionCompareSlider.picture(after, alignment: .top)
                    .accessibilityLabel("After: \(afterLine)")
            }
        }
    }
}

/// What a comparison can't show, said where it would be: the same file twice, a version that didn't arrive, a diff
/// too large to read.
public struct VersionCompareNotice: View {
    private let symbol: String
    private let title: String
    private let detail: String?

    public init(symbol: String, title: String, detail: String? = nil) {
        self.symbol = symbol
        self.title = title
        self.detail = detail
    }

    public var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 20))
                .foregroundStyle(ConchColor.textTertiary)
                .accessibilityHidden(true)
            Text(title)
                .font(ConchType.uiEmphasis)
                .foregroundStyle(ConchColor.textPrimary)
                .multilineTextAlignment(.center)
            if let detail {
                Text(detail)
                    .font(ConchType.secondary)
                    .foregroundStyle(ConchColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: 440)
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The lines that changed between two versions of a text: removed in red with a −, added in green with a +, each with
/// its line numbers, and long unchanged stretches folded to a row that opens them. Scrolls; the rows themselves are
/// `VersionTextDiffRows`.
public struct VersionTextDiffView: View {
    private let diff: TextDiff
    private let beforeName: String
    private let afterName: String
    @State private var expanded: Set<Int> = []

    public init(diff: TextDiff, beforeName: String, afterName: String) {
        self.diff = diff
        self.beforeName = beforeName
        self.afterName = afterName
    }

    public var body: some View {
        ScrollView(.vertical) {
            VersionTextDiffRows(diff: diff, beforeName: beforeName, afterName: afterName, expanded: $expanded)
        }
    }
}

/// A diff's rows, unscrolled: what `VersionTextDiffView` scrolls, and what a test renders (a scroll view draws nothing
/// offscreen).
public struct VersionTextDiffRows: View {
    private let diff: TextDiff
    private let beforeName: String
    private let afterName: String
    @Binding private var expanded: Set<Int>

    public init(diff: TextDiff, beforeName: String, afterName: String, expanded: Binding<Set<Int>>) {
        self.diff = diff
        self.beforeName = beforeName
        self.afterName = afterName
        _expanded = expanded
    }

    private var gutter: CGFloat {
        let widest = diff.lines.reduce(0) { max($0, $1.before ?? 0, $1.after ?? 0) }
        return CGFloat(String(widest).count) * 8 + 10
    }

    public var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            summary
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            ForEach(diff.rows(expanded: expanded)) { row in
                switch row {
                case let .line(line): lineRow(line)
                case let .fold(id, count): foldRow(id: id, count: count)
                }
            }
        }
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var summary: some View {
        if diff.isIdentical {
            Text("No changes: \(beforeName) and \(afterName) are the same text.")
                .font(ConchType.secondary)
                .foregroundStyle(ConchColor.textSecondary)
        } else {
            HStack(spacing: 10) {
                Text("−\(diff.removed)").foregroundStyle(ConchColor.removed)
                Text("+\(diff.added)").foregroundStyle(ConchColor.added)
                Text("lines, \(beforeName) to \(afterName)").foregroundStyle(ConchColor.textSecondary)
            }
            .font(ConchType.secondary.monospacedDigit())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(diff.removed) lines removed and \(diff.added) added, from \(beforeName) to \(afterName)")
        }
    }

    private func lineRow(_ line: TextDiff.Line) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            number(line.before)
            number(line.after)
            Text(sign(line.change))
                .foregroundStyle(tint(line.change) ?? ConchColor.textTertiary)
                .frame(width: 18)
            Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(ConchColor.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .font(ConchType.code)
        .padding(.horizontal, 6)
        .padding(.vertical, 1)
        .background(tint(line.change).map { AnyShapeStyle($0.opacity(0.12)) } ?? AnyShapeStyle(Color.clear))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.spoken(line))
    }

    private func foldRow(id: Int, count: Int) -> some View {
        Button {
            expanded.insert(id)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                Text("\(count) unchanged lines")
                    .font(ConchType.meta)
            }
            .foregroundStyle(ConchColor.textTertiary)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ConchColor.fill)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(count) unchanged lines, folded")
        .accessibilityHint("Shows them")
    }

    private func number(_ value: Int?) -> some View {
        Text(value.map(String.init) ?? "")
            .foregroundStyle(ConchColor.textTertiary)
            .monospacedDigit()
            .frame(width: gutter, alignment: .trailing)
            .padding(.trailing, 4)
            .accessibilityHidden(true)
    }

    private func sign(_ change: TextDiff.Change) -> String {
        switch change {
        case .same: " "
        case .removed: "−"
        case .added: "+"
        }
    }

    private func tint(_ change: TextDiff.Change) -> ConchColorToken? {
        switch change {
        case .same: nil
        case .removed: ConchColor.removed
        case .added: ConchColor.added
        }
    }

    static func spoken(_ line: TextDiff.Line) -> String {
        let text = line.text.isEmpty ? "blank line" : line.text
        switch line.change {
        case .same: return "Line \(line.after ?? 0): \(text)"
        case .removed: return "Removed line \(line.before ?? 0): \(text)"
        case .added: return "Added line \(line.after ?? 0): \(text)"
        }
    }
}
