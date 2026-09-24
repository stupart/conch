import SwiftUI

/// The canvas's tools (panel-lab's `#tools`): pen, highlight, arrow, box and note, then undo, Show and ×, then Send, in a small glass
/// pill that rises out of the conversation panel's top edge while the canvas is in use. With the pen down (`armed`) the
/// tool in hand is picked out; up, with ink still showing, none is, and picking one puts the pen down again.
public struct CanvasToolPill: View {
    /// Each tool: its mark, its symbol, what it is called, and the number key that picks it.
    public static let tools: [(kind: CanvasMark.Kind, symbol: String, label: String, key: Character)] = [
        (.pen, "pencil", "Pen", "1"),
        (.highlight, "highlighter", "Highlight", "2"),
        (.arrow, "arrow.up.right", "Arrow", "3"),
        (.box, "rectangle", "Box", "4"),
        (.note, "text.bubble", "Note", "5"),
    ]

    let shown: Bool
    let tool: CanvasMark.Kind
    let armed: Bool
    let canUndo: Bool
    let canSend: Bool
    let sending: Bool
    /// Where Send goes: the session's name.
    let route: String?
    /// Why Send didn't go, said over the pill until the next thing happens.
    let message: String?
    let onTool: (CanvasMark.Kind) -> Void
    let onUndo: () -> Void
    let onSend: () -> Void
    /// Show, while it records or waits for Send; nil otherwise.
    let recording: Recording?
    /// Show's record button (`showControl`); nil where there is no Show, and the pill has no button.
    let onShow: (() -> Void)?
    /// Show narrates: Tyler's voice recorded with it, by the daemon.
    let narrate: Bool
    /// The mic beside the record button; nil, and no mic, where there is no narration.
    let onNarrate: (() -> Void)?
    /// The ×: a Show or the ink thrown away, nothing sent; nil, and no ×, with nothing to throw away.
    let onDiscard: (() -> Void)?
    @Namespace private var picked
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        shown: Bool = true,
        tool: CanvasMark.Kind,
        armed: Bool,
        canUndo: Bool,
        canSend: Bool,
        sending: Bool = false,
        route: String?,
        message: String? = nil,
        onTool: @escaping (CanvasMark.Kind) -> Void,
        onUndo: @escaping () -> Void,
        onSend: @escaping () -> Void,
        recording: Recording? = nil,
        onShow: (() -> Void)? = nil,
        narrate: Bool = false,
        onNarrate: (() -> Void)? = nil,
        onDiscard: (() -> Void)? = nil
    ) {
        self.shown = shown
        self.tool = tool
        self.armed = armed
        self.canUndo = canUndo
        self.canSend = canSend
        self.sending = sending
        self.route = route
        self.message = message
        self.onTool = onTool
        self.onUndo = onUndo
        self.onSend = onSend
        self.recording = recording
        self.onShow = onShow
        self.narrate = narrate
        self.onNarrate = onNarrate
        self.onDiscard = onDiscard
    }

    static let buttonSize: CGFloat = 32

    public var body: some View {
        VStack(spacing: ConchSpace.x2) {
            if let message {
                Text(message)
                    .font(ConchType.secondary)
                    .foregroundStyle(ConchColor.overlayText)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, ConchSpace.x3)
                    .padding(.vertical, 6)
                    .frame(maxWidth: 360)
                    .background(glass(RoundedRectangle(cornerRadius: 12, style: .continuous)))
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.9, anchor: .bottom).combined(with: .opacity))
            }
            HStack(spacing: 2) {
                ForEach(Self.tools, id: \.kind) { each in
                    let on = armed && tool == each.kind
                    Button { onTool(each.kind) } label: {
                        Image(systemName: each.symbol)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(on ? ConchColor.onAccent : ConchColor.overlayGlassIcon)
                            .frame(width: Self.buttonSize, height: Self.buttonSize)
                            .background {
                                // The picked tool's dark disc slides to the next on the pop spring.
                                if on { Circle().fill(ConchColor.accent).matchedGeometryEffect(id: "tool", in: picked) }
                            }
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .help("\(each.label) (\(String(each.key)))")
                    .accessibilityLabel(each.label)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
                separator
                Button(action: onUndo) {
                    Image(systemName: "arrow.uturn.backward")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(ConchColor.overlayGlassIcon)
                        .frame(width: Self.buttonSize, height: Self.buttonSize)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canUndo)
                .opacity(canUndo ? 1 : 0.4)
                .help("Undo (⌘Z)")
                .accessibilityLabel("Undo")
                showControl
                discard
                separator
                send
            }
            .padding(5)
            .background(glass(RoundedRectangle(cornerRadius: 18, style: .continuous)))
            .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: tool)
            .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: armed)
        }
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: message)
        // Rises out of the panel's edge on the pop spring (panel-lab: translateY(10px) scale(.9) blur(4px)); under Reduce
        // Motion it only fades.
        .opacity(shown ? 1 : 0)
        .scaleEffect(shown || reduceMotion ? 1 : 0.9, anchor: .bottom)
        .offset(y: shown || reduceMotion ? 0 : 10)
        .blur(radius: shown || reduceMotion ? 0 : 4)
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: shown)
        .allowsHitTesting(shown)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Canvas")
    }

    private var separator: some View {
        Rectangle().fill(ConchColor.overlayLine).frame(width: 0.5, height: 20).padding(.horizontal, 4)
    }

    /// The ×, with something to throw away: the pen up, the one way to, since the keys are the app underneath's again.
    @ViewBuilder private var discard: some View {
        if let onDiscard {
            Button(action: onDiscard) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ConchColor.overlayGlassIcon)
                    .frame(width: Self.buttonSize, height: Self.buttonSize)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(sending)
            .opacity(sending ? 0.4 : 1)
            .help(recording != nil ? "Throw the recording away: nothing is sent" : "Throw the ink away: nothing is sent")
            .accessibilityLabel(recording != nil ? "Throw the recording away" : "Throw the ink away")
        }
    }

    /// Send, in Tyler's ink colour, naming where it goes.
    private var send: some View {
        Button(action: onSend) {
            HStack(spacing: 6) {
                if sending {
                    ProgressView().controlSize(.small).tint(ConchColor.onVoice)
                } else {
                    Image(systemName: "arrow.up").font(.system(size: 12, weight: .bold))
                }
                Text("Send").font(ConchType.uiEmphasis)
                if let route {
                    Text(route)
                        .font(ConchType.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: 140, alignment: .leading)
                        .opacity(0.85)
                }
            }
            .foregroundStyle(ConchColor.onVoice)
            .padding(.leading, 10)
            .padding(.trailing, 12)
            .frame(height: Self.buttonSize)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(CanvasInk.you.color))
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!canSend || sending)
        .opacity(canSend || sending ? 1 : 0.4)
        .help(route.map { "Send to \($0) (Return)" } ?? "Send (Return)")
        .accessibilityLabel(route.map { "Send to \($0)" } ?? "Send")
    }

    /// The overlay's glass: the system blur, its wash, and a hairline; the control bar's shadow under it.
    private func glass<S: InsettableShape>(_ shape: S) -> some View {
        ZStack {
            shape.fill(.ultraThinMaterial)
            shape.fill(ConchColor.overlayGlassStrong)
            shape.strokeBorder(ConchColor.overlayLine, lineWidth: 0.5)
        }
        .conchElevation(.floating)
    }
}
