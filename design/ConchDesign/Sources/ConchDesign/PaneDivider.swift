#if os(macOS)
import AppKit
import SwiftUI

/// The part of a divider that answers the pointer: 16 points across, centred on the line it moves, as the window's own
/// sidebar and split resizers are (DashboardView.swift: "16 against a 1 pt line"). Drag it to resize; double-click it
/// to put the split back as it opened; VoiceOver adjusts it a step at a time.
///
/// It draws nothing but an optional grip: the hairline is the layout's own, so it stays one point wide and on the pixel
/// grid, and this sits over it.
public struct PaneDividerHandle: View {
    /// How far the grab area reaches across the line: the window's other resizers' 16.
    public static let thickness: CGFloat = 16
    /// The grip a gap divider draws (between two versions, where there is no hairline): 4 x 28, rounded.
    public static let grip = CGSize(width: 4, height: 28)

    private let axis: Axis
    private let label: String
    private let showsGrip: Bool
    private let onDrag: (CGFloat) -> Void
    private let onEnd: () -> Void
    private let onReset: () -> Void
    private let onStep: (Int) -> Void

    @State private var hovering = false
    @State private var dragging = false
    @State private var cursorPushed = false

    /// `axis` is the one the two sides are laid along: `.horizontal` is side by side, with a line up and down that is
    /// dragged left and right. `onDrag` gets the drag's travel along it since it began, `onEnd` that it let go.
    public init(
        axis: Axis = .horizontal,
        label: String,
        showsGrip: Bool = false,
        onDrag: @escaping (CGFloat) -> Void,
        onEnd: @escaping () -> Void,
        onReset: @escaping () -> Void,
        onStep: @escaping (Int) -> Void = { _ in }
    ) {
        self.axis = axis
        self.label = label
        self.showsGrip = showsGrip
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
                if showsGrip {
                    RoundedRectangle(cornerRadius: Self.grip.width / 2, style: .continuous)
                        .fill(ConchColor.textTertiary)
                        .opacity(hovering || dragging ? 0.7 : 0.3)
                        .frame(
                            width: axis == .horizontal ? Self.grip.width : Self.grip.height,
                            height: axis == .horizontal ? Self.grip.height : Self.grip.width
                        )
                        .allowsHitTesting(false)
                }
            }
            .contentShape(Rectangle())
            .onHover { inside in
                hovering = inside
                updateCursor()
            }
            // In the window's space: the handle moves with the drag, and a translation measured in its own space would
            // chase itself.
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { drag in
                        dragging = true
                        updateCursor()
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

    /// The resize cursor while the pointer is over the handle or dragging it, pushed once and popped once: a drag that
    /// outruns the handle must not drop it mid-drag, nor leave it pushed when it ends elsewhere.
    private func updateCursor() {
        let wanted = hovering || dragging
        if wanted, !cursorPushed {
            (axis == .horizontal ? NSCursor.resizeLeftRight : NSCursor.resizeUpDown).push()
            cursorPushed = true
        } else if !wanted, cursorPushed {
            NSCursor.pop()
            cursorPushed = false
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
    /// double-click, never on every point of a drag. The hairline is what says it moves, so it draws no grip unless
    /// asked (`showsGrip`: the render test, which measures where the handle is by it).
    public init(
        split: PaneSplit,
        width: Binding<Double>,
        label: String,
        showsGrip: Bool = false,
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
            HStack(spacing: 0) {
                leading
                    .frame(width: shown)
                    .frame(maxHeight: .infinity)
                Rectangle()
                    .fill(ConchColor.hairline)
                    .frame(width: PaneSplit.hairline)
                trailing
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            // Over both sides, not beside them: the trailing side is drawn after the line, and a handle laid out as
            // a sibling would be under it for the half of its reach that crosses into it.
            .overlay(alignment: .topLeading) {
                PaneDividerHandle(
                    label: label,
                    showsGrip: showsGrip,
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
