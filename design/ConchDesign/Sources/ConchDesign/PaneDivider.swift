#if os(macOS)
import AppKit
import SwiftUI

/// The part of a divider that answers the pointer: 16 points across, centred on the line it moves, as the window's own
/// sidebar and split resizers are (DashboardView.swift: "16 against a 1 pt line"). Drag it to resize; double-click it
/// to put the split back as it opened; VoiceOver adjusts it a step at a time.
///
/// It draws a grip, and on a hairline (`onLine`) lights the line while the pointer is on it; the hairline itself is the
/// layout's own, so it stays one point wide and on the pixel grid, and this sits over it.
///
/// The grip is there at rest, not only on hover (2026-10-29). The file tree's divider was a bare hairline, the same as
/// every other line in the window, and the only sign it moved was the cursor, once the pointer was already within 8
/// points of it: Tyler asked for the column to be resizable two weeks after it was.
public struct PaneDividerHandle: View {
    /// How far the grab area reaches across the line: the window's other resizers' 16.
    public static let thickness: CGFloat = 16
    /// The grip a gap divider draws (between two versions, where there is no hairline): 4 x 28, rounded.
    public static let grip = CGSize(width: 4, height: 28)
    /// The grip on a hairline: 5 wide, so centred on the line's middle (a half point) it still lands on whole points.
    public static let lineGrip = CGSize(width: 5, height: 28)

    private let axis: Axis
    private let label: String
    private let showsGrip: Bool
    private let onLine: Bool
    private let onDrag: (CGFloat) -> Void
    private let onEnd: () -> Void
    private let onReset: () -> Void
    private let onStep: (Int) -> Void

    @State private var hovering = false
    @State private var dragging = false
    @State private var cursorPushed = false

    /// `axis` is the one the two sides are laid along: `.horizontal` is side by side, with a line up and down that is
    /// dragged left and right. `onDrag` gets the drag's travel along it since it began, `onEnd` that it let go. `onLine`:
    /// the handle sits on a hairline (`ConchSplitView`), whose grip straddles it and which lights while the pointer is on
    /// it; otherwise it is in a gap, where only the grip is drawn.
    public init(
        axis: Axis = .horizontal,
        label: String,
        showsGrip: Bool = false,
        onLine: Bool = false,
        onDrag: @escaping (CGFloat) -> Void,
        onEnd: @escaping () -> Void,
        onReset: @escaping () -> Void,
        onStep: @escaping (Int) -> Void = { _ in }
    ) {
        self.axis = axis
        self.label = label
        self.showsGrip = showsGrip
        self.onLine = onLine
        self.onDrag = onDrag
        self.onEnd = onEnd
        self.onReset = onReset
        self.onStep = onStep
    }

    public var body: some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: axis == .horizontal ? Self.thickness : nil, height: axis == .vertical ? Self.thickness : nil)
            .overlay {
                if onLine {
                    // The whole line, lit while it is held or the pointer is on it: this is what moves.
                    Rectangle()
                        .fill(ConchColor.textTertiary)
                        .opacity(hovering || dragging ? 0.45 : 0)
                        .frame(width: axis == .horizontal ? PaneSplit.hairline : nil, height: axis == .vertical ? PaneSplit.hairline : nil)
                        .allowsHitTesting(false)
                }
            }
            .overlay {
                if showsGrip { grip.allowsHitTesting(false) }
            }
            .contentShape(Rectangle())
            // The window's own answer for the cursor here, where it has one (macOS 15): AppKit asks again whenever views
            // move or resize, as a drag makes them, and without one it puts the arrow back.
            .modifier(ResizePointer(axis: axis))
            // Continuous, not `onHover`: the view beside the line may set its own cursor as the pointer moves (a PDF),
            // and the resize cursor is set again on every move so it is the one that shows.
            .onContinuousHover { phase in
                switch phase {
                case .active:
                    hovering = true
                    updateCursor()
                    if cursorPushed { resizeCursor.set() }
                case .ended:
                    hovering = false
                    updateCursor()
                }
            }
            // In the window's space: the handle moves with the drag, and a translation measured in its own space would
            // chase itself.
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { drag in
                        dragging = true
                        updateCursor()
                        resizeCursor.set()
                        onDrag(axis == .horizontal ? drag.translation.width : drag.translation.height)
                    }
                    .onEnded { _ in
                        dragging = false
                        onEnd()
                        updateCursor()
                    }
            )
            .simultaneousGesture(TapGesture(count: 2).onEnded { onReset() })
            .onDisappear {
                if cursorPushed {
                    NSCursor.pop()
                    cursorPushed = false
                }
            }
            .animation(.easeOut(duration: 0.12), value: hovering || dragging)
            .accessibilityElement()
            .accessibilityLabel(label)
            .accessibilityHint("Drag to resize. Double-click to put it back.")
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: onStep(1)
                case .decrement: onStep(-1)
                @unknown default: break
                }
            }
            .accessibilityAction(named: "Put it back") { onReset() }
    }

    /// The grip: on a hairline, a bead on an opaque ground so the line doesn't show through it; in a gap, the pill alone.
    private var grip: some View {
        let size = onLine ? Self.lineGrip : Self.grip
        let shape = RoundedRectangle(cornerRadius: size.width / 2, style: .continuous)
        return shape
            .fill(onLine ? AnyShapeStyle(ConchColor.surfaceRaised) : AnyShapeStyle(Color.clear))
            .overlay(shape.fill(ConchColor.textTertiary).opacity(hovering || dragging ? 0.7 : (onLine ? 0.35 : 0.3)))
            .frame(
                width: axis == .horizontal ? size.width : size.height,
                height: axis == .horizontal ? size.height : size.width
            )
    }

    private var resizeCursor: NSCursor { axis == .horizontal ? .resizeLeftRight : .resizeUpDown }

    /// The resize cursor while the pointer is over the handle or dragging it, pushed once and popped once: a drag that
    /// outruns the handle must not drop it mid-drag, nor leave it pushed when it ends elsewhere.
    private func updateCursor() {
        let wanted = hovering || dragging
        if wanted, !cursorPushed {
            resizeCursor.push()
            cursorPushed = true
        } else if !wanted, cursorPushed {
            NSCursor.pop()
            cursorPushed = false
        }
    }
}

/// The resize pointer as SwiftUI's own pointer style, where there is one.
private struct ResizePointer: ViewModifier {
    let axis: Axis

    func body(content: Content) -> some View {
        if #available(macOS 15, *) {
            content.pointerStyle(axis == .horizontal ? .columnResize : .rowResize)
        } else {
            content
        }
    }
}

/// Two panes side by side with a hairline between them that you drag: the leading one a remembered width
/// (`PaneSplit`), the trailing one the rest. The file tree beside the file picked in it.
public struct ConchSplitView<Leading: View, Trailing: View>: View {
    private let split: PaneSplit
    @Binding private var width: Double
    private let label: String
    private let showsGrip: Bool
    private let leading: Leading
    private let trailing: Trailing
    @State private var drag: CGFloat = 0

    /// `width` is the leading side's remembered width (`@AppStorage(split.key)`): written when a drag lets go, and on a
    /// double-click, never on every point of a drag. The grip on the hairline is what says it moves (`showsGrip`; off only
    /// for the render test's picture without it).
    public init(
        split: PaneSplit,
        width: Binding<Double>,
        label: String,
        showsGrip: Bool = true,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.split = split
        _width = width
        self.label = label
        self.showsGrip = showsGrip
        self.leading = leading()
        self.trailing = trailing()
    }

    public var body: some View {
        GeometryReader { proxy in
            let total = proxy.size.width
            let shown = split.width(width, dragged: drag, in: total)
            // Each side clipped to itself, and not only for what it draws. Since macOS 14 a view that doesn't clip has a
            // visible rect reaching past its own bounds, so the AppKit views beside the tree (a PDF, a page, a text) tracked
            // the pointer over the whole window, the divider included, and set their own cursor on every move there: next
            // to a PDF the resize cursor never showed (2026-10-29, tree-rail probe). Clipped, each tracks only its side.
            HStack(spacing: 0) {
                leading
                    .frame(width: shown)
                    .frame(maxHeight: .infinity)
                    .clipped()
                Rectangle()
                    .fill(ConchColor.hairline)
                    .frame(width: PaneSplit.hairline)
                trailing
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipped()
            }
            // Over both sides, not beside them: the trailing side is drawn after the line, and a handle laid out as
            // a sibling would be under it for the half of its reach that crosses into it.
            .overlay(alignment: .topLeading) {
                PaneDividerHandle(
                    label: label,
                    showsGrip: showsGrip,
                    onLine: true,
                    onDrag: { drag = $0 },
                    onEnd: {
                        width = Double(split.width(width, dragged: drag, in: total))
                        drag = 0
                    },
                    onReset: {
                        drag = 0
                        width = Double(split.standard)
                    },
                    onStep: { step in
                        width = Double(split.width(width, dragged: CGFloat(step) * PaneSplit.step, in: total))
                    }
                )
                .frame(height: proxy.size.height)
                .offset(x: Self.handleOffset(leading: shown))
            }
        }
    }

    /// Where the handle's left edge goes so its middle is the hairline's middle.
    public static func handleOffset(leading width: CGFloat) -> CGFloat {
        width + PaneSplit.hairline / 2 - PaneDividerHandle.thickness / 2
    }
}
#endif
