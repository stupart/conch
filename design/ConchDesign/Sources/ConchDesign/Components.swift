import SwiftUI

extension EnvironmentValues {
    /// Set by the gallery. ImageRenderer cannot draw a platform text field, so a component that hosts one
    /// draws a SwiftUI stand-in in the same type and colours instead.
    @Entry public var conchRendersStatically = false
}

// MARK: - VoiceGlyph

/// The voice everywhere except the menu bar: a waveform while speaking, a mic while listening, a muted
/// speaker when quiet. The waveform swells and the mic breathes, gently; both hold still under Reduce Motion.
public struct VoiceGlyph: View {
    public enum Kind: Sendable {
        case speaking
        case listening
        case quiet

        var label: String {
            switch self {
            case .speaking: "Speaking"
            case .listening: "Listening"
            case .quiet: "Quiet"
            }
        }
    }

    let kind: Kind
    let size: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ kind: Kind, size: CGFloat = 18) {
        self.kind = kind
        self.size = size
    }

    /// Bar heights from the approved control bar, out of 18.
    static let bars: [CGFloat] = [7, 14, 10, 16, 6]

    public var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || kind == .quiet)) { timeline in
            glyph(at: reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate)
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(kind.label)
    }

    @ViewBuilder
    private func glyph(at time: Double) -> some View {
        let unit = size / 18
        switch kind {
        case .speaking:
            HStack(spacing: 2 * unit) {
                ForEach(Self.bars.indices, id: \.self) { index in
                    // Each bar swells on its own phase, so they never move as one block.
                    let swell = reduceMotion ? 1 : 0.72 + 0.28 * sin(2 * .pi * (time / ConchMotion.wavePeriod + Double(index) * 0.23))
                    Capsule().frame(width: 2.5 * unit, height: Self.bars[index] * unit * swell)
                }
            }
        case .listening:
            Image(systemName: "mic")
                .font(.system(size: 15 * unit, weight: .semibold))
                .opacity(reduceMotion ? 1 : 0.82 + 0.18 * sin(2 * .pi * time / ConchMotion.breathPeriod))
        case .quiet:
            Image(systemName: "speaker.slash")
                .font(.system(size: 14 * unit, weight: .semibold))
        }
    }
}

// MARK: - VoiceOrb

/// The round voice control at the start of the control bar and the menu header.
public struct VoiceOrb: View {
    let state: VoiceState
    let size: CGFloat

    public init(state: VoiceState, size: CGFloat = 36) {
        self.state = state
        self.size = size
    }

    public var body: some View {
        ZStack {
            switch state {
            case .speaking:
                Circle().fill(ConchColor.accent)
                VoiceGlyph(.speaking, size: size / 2).foregroundStyle(ConchColor.onAccent)
            case .listening:
                Circle().fill(ConchColor.listeningRing).padding(-size * 5 / 36)
                Circle().fill(ConchColor.listening)
                VoiceGlyph(.listening, size: size / 2).foregroundStyle(ConchColor.onVoice)
            case .quiet:
                Circle().fill(ConchColor.fill)
                VoiceGlyph(.quiet, size: size / 2).foregroundStyle(ConchColor.textSecondary)
            case .talk:
                Circle().fill(ConchColor.fill)
                Image(systemName: "mic")
                    .font(.system(size: size * 15 / 36, weight: .semibold))
                    .foregroundStyle(ConchColor.textSecondary)
            case .ready:
                Circle().fill(ConchColor.ready)
                Image(systemName: "checkmark")
                    .font(.system(size: size * 15 / 36, weight: .bold))
                    .foregroundStyle(ConchColor.onVoice)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(state.title)
    }
}

/// The orb with the state and what it is about: "Speaking / Blueprint monorepo".
public struct VoiceStateLabel: View {
    let state: VoiceState
    let detail: String
    let orbSize: CGFloat

    public init(state: VoiceState, detail: String, orbSize: CGFloat = 36) {
        self.state = state
        self.detail = detail
        self.orbSize = orbSize
    }

    public var body: some View {
        HStack(spacing: ConchSpace.x3) {
            VoiceOrb(state: state, size: orbSize)
            VStack(alignment: .leading, spacing: 1) {
                Text(state.title)
                    .font(ConchType.uiEmphasis)
                    .foregroundStyle(ConchColor.textPrimary)
                if !detail.isEmpty {
                    Text(detail)
                        .font(ConchType.secondary)
                        .foregroundStyle(ConchColor.textSecondary)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(detail.isEmpty ? state.title : "\(state.title), \(detail)")
    }
}

// MARK: - TalkQuietSwitch

/// Talk or Quiet, as a two-segment pill.
public struct TalkQuietSwitch: View {
    @Binding var mode: VoiceMode
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var thumb

    public init(mode: Binding<VoiceMode>) {
        _mode = mode
    }

    public var body: some View {
        HStack(spacing: 0) {
            ForEach(VoiceMode.allCases) { option in
                let selected = option == mode
                Button {
                    withAnimation(ConchMotion.animation(ConchMotion.quick, reduceMotion: reduceMotion)) { mode = option }
                } label: {
                    Text(option.title)
                        .font(ConchType.uiEmphasis)
                        .foregroundStyle(selected ? ConchColor.textPrimary : ConchColor.textSecondary)
                        .padding(.vertical, 6)
                        .padding(.horizontal, 14)
                        .background {
                            if selected {
                                Capsule()
                                    .fill(ConchColor.fillSelected)
                                    .overlay(Capsule().strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
                                    .conchElevation(.raised)
                                    .matchedGeometryEffect(id: "thumb", in: thumb)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.title)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Capsule().fill(ConchColor.fill))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Voice mode")
    }
}

// MARK: - GlassPill

/// The one place glass is used: a floating capsule for the control bar (M3).
public struct GlassPill<Content: View>: View {
    let label: String
    let content: Content
    @Environment(\.colorScheme) private var scheme

    public init(_ label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    public var body: some View {
        HStack(spacing: ConchSpace.x3) { content }
            .padding(.horizontal, 6)
            .frame(height: 48)
            .background {
                // panel.html's shadow, 0 14px 34px -14px: pulled in from the edges and dropped below, so it sits
                // under the pill instead of glowing around it. Dark grounds swallow it, so it deepens there.
                Capsule()
                    .fill(Color.black.opacity(scheme == .dark ? 0.5 : 0.28))
                    .padding(14)
                    .offset(y: 14)
                    .blur(radius: 17)
                Capsule().fill(.ultraThinMaterial)
                Capsule().fill(ConchColor.glass)
            }
            .overlay(Capsule().strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
            .accessibilityElement(children: .contain)
            .accessibilityLabel(label)
    }
}

// MARK: - IconButton

/// A round icon button: quiet (a soft fill) or primary (the accent, for the one action that moves things on).
public struct IconButton: View {
    public enum Style: Sendable {
        case plain
        case primary
        /// Over another app (the fog's buttons): a translucent white circle with a hairline, as panel.html drew them.
        case glass
    }

    let systemName: String
    let label: String
    let style: Style
    let size: CGFloat
    let action: () -> Void

    public init(_ systemName: String, label: String, style: Style = .plain, size: CGFloat = 36, action: @escaping () -> Void) {
        self.systemName = systemName
        self.label = label
        self.style = style
        self.size = size
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(style == .primary ? ConchColor.onAccent : ConchColor.textSecondary)
                .frame(width: size, height: size)
                .background {
                    switch style {
                    case .plain: Circle().fill(ConchColor.fill)
                    case .primary: Circle().fill(ConchColor.accent)
                    case .glass:
                        Circle().fill(ConchColor.glass)
                            .overlay(Circle().strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
                    }
                }
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

// MARK: - InlineReplyLine

/// Replying without a text box: the mic comes first, your words follow the cursor in the conversation's
/// own type, and a send arrow appears once there is something to send.
public struct InlineReplyLine: View {
    @Binding var text: String
    let isListening: Bool
    let placeholder: String
    let font: Font
    let onMic: () -> Void
    let onSend: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.conchRendersStatically) private var rendersStatically

    public init(
        text: Binding<String>,
        isListening: Bool,
        placeholder: String = "Reply",
        font: Font = ConchType.conversationNow,
        onMic: @escaping () -> Void,
        onSend: @escaping () -> Void
    ) {
        _text = text
        self.isListening = isListening
        self.placeholder = placeholder
        self.font = font
        self.onMic = onMic
        self.onSend = onSend
    }

    public var body: some View {
        HStack(spacing: ConchSpace.x3) {
            Button(action: onMic) {
                Image(systemName: "mic")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(isListening ? ConchColor.onVoice : ConchColor.textSecondary)
                    .frame(width: 40, height: 40)
                    .background {
                        if isListening { Circle().fill(ConchColor.listeningRing).padding(-5) }
                        Circle().fill(isListening ? ConchColor.listening : ConchColor.fill)
                    }
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isListening ? "Stop listening" : "Speak your reply")

            if rendersStatically {
                // The field as it looks focused: the caret, then the words or the placeholder.
                HStack(spacing: 3) {
                    if text.isEmpty { caret }
                    Text(text.isEmpty ? placeholder : text)
                        .foregroundStyle(text.isEmpty ? ConchColor.textTertiary : ConchColor.textPrimary)
                    if !text.isEmpty { caret }
                }
                .font(font)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Reply")
            } else {
                TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(ConchColor.textTertiary), axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(font)
                    .foregroundStyle(ConchColor.textPrimary)
                    .onSubmit(onSend)
                    .accessibilityLabel("Reply")
            }

            if !text.isEmpty {
                IconButton("arrow.up", label: "Send", style: .primary, size: 40, action: onSend)
                    .transition(reduceMotion ? .identity : .scale.combined(with: .opacity))
            }
        }
        .animation(ConchMotion.animation(ConchMotion.quick, reduceMotion: reduceMotion), value: text.isEmpty)
    }

    private var caret: some View {
        RoundedRectangle(cornerRadius: 1.5).fill(ConchColor.textPrimary).frame(width: 2.5, height: 26)
    }
}

// MARK: - ControlBar

/// The floating control bar (M3): the voice and what it is about, and Talk or Quiet. The conversation is
/// shown and hidden from the menu bar menu, not from here.
public struct ControlBar: View {
    let state: VoiceState
    let detail: String
    @Binding var mode: VoiceMode

    public init(state: VoiceState, detail: String, mode: Binding<VoiceMode>) {
        self.state = state
        self.detail = detail
        _mode = mode
    }

    public var body: some View {
        GlassPill("Voice controls") {
            // A fixed width, so the bar keeps its size and place as the state and the session change.
            VoiceStateLabel(state: state, detail: detail)
                .frame(width: 196, alignment: .leading)
            TalkQuietSwitch(mode: $mode)
        }
    }
}

// MARK: - ConversationFog

/// One turn in the conversation fog.
public struct ConversationTurn: Identifiable, Equatable, Sendable {
    public let id: String
    public let fromYou: Bool
    public let text: String

    public init(id: String, fromYou: Bool, text: String) {
        self.id = id
        self.fromYou = fromYou
        self.text = text
    }
}

/// The conversation as a soft fog rather than a pane (M3): no edge, just a quieter patch of screen with the
/// words in it. The latest turn is large, earlier ones smaller and fading as they rise, and the reply line
/// sits at the bottom. The blur is the host's (a behind-window visual effect view on the Mac, masked with
/// `density`); this draws the tint, the words, and collapse and full-screen buttons that brighten on hover.
public struct ConversationFog: View {
    let turns: [ConversationTurn]
    @Binding var draft: String
    let isListening: Bool
    let isFullScreen: Bool
    /// The panel's edges that sit on its screen's edges. The fog runs out to those and fades on the rest.
    let flush: Edge.Set
    let onMic: () -> Void
    let onSend: () -> Void
    let onCollapse: () -> Void
    let onFullScreen: () -> Void
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.conchRendersStatically) private var rendersStatically

    public init(
        turns: [ConversationTurn],
        draft: Binding<String>,
        isListening: Bool,
        isFullScreen: Bool,
        flush: Edge.Set = [.leading, .bottom],
        onMic: @escaping () -> Void,
        onSend: @escaping () -> Void,
        onCollapse: @escaping () -> Void,
        onFullScreen: @escaping () -> Void
    ) {
        self.turns = turns
        _draft = draft
        self.isListening = isListening
        self.isFullScreen = isFullScreen
        self.flush = flush
        self.onMic = onMic
        self.onSend = onSend
        self.onCollapse = onCollapse
        self.onFullScreen = onFullScreen
    }

    /// Where the fog is, as a mask (only its alpha matters). Full screen, everywhere. Otherwise it gathers toward
    /// the screen edges the panel sits on (`flush`) and thins away from them, and every edge that is not on a
    /// screen edge fades to nothing, so wherever the panel is moved and however it is sized there is never a line
    /// to look at. In the bottom-left corner this is the original corner fog.
    @ViewBuilder
    public static func density(fullScreen: Bool, flush: Edge.Set = [.leading, .bottom]) -> some View {
        if fullScreen {
            Color.black
        } else {
            GeometryReader { proxy in
                let fade = edgeFade(proxy.size)
                ZStack(alignment: .topLeading) {
                    EllipticalGradient(
                        stops: [
                            .init(color: .black, location: 0.36),
                            .init(color: .black.opacity(0.75), location: 0.5),
                            .init(color: .black.opacity(0.3), location: 0.64),
                            .init(color: .clear, location: 0.78),
                        ],
                        center: anchor(flush),
                        endRadiusFraction: reach(flush)
                    )
                    // Thick behind the words, the reply line and their buttons, wherever the panel is, so they read.
                    textBacking(textFrame(in: proxy.size, flush: flush, fullScreen: false), fade: fade)
                }
                .mask {
                    // A soft rectangle: short of every free edge, past every edge that is on the screen's.
                    Rectangle()
                        .padding(.leading, flush.contains(.leading) ? -fade : fade / 2)
                        .padding(.trailing, flush.contains(.trailing) ? -fade : fade / 2)
                        .padding(.top, flush.contains(.top) ? -fade : fade / 2)
                        .padding(.bottom, flush.contains(.bottom) ? -fade : fade / 2)
                        .blur(radius: fade / 4)
                }
            }
        }
    }

    /// How far in from a free edge the fog takes to thicken. It grows and shrinks with the panel.
    public static func edgeFade(_ size: CGSize) -> CGFloat {
        min(96, max(32, min(size.width, size.height) * 0.16))
    }

    /// The fog's densest point: on the screen edges the panel touches, else its middle.
    static func anchor(_ flush: Edge.Set) -> UnitPoint {
        func along(_ start: Bool, _ end: Bool) -> CGFloat { start == end ? 0.5 : (start ? 0 : 1) }
        return UnitPoint(
            x: along(flush.contains(.leading), flush.contains(.trailing)),
            y: along(flush.contains(.top), flush.contains(.bottom))
        )
    }

    /// From a corner the fog reaches across the panel; centred on an axis it has half as far to go.
    static func reach(_ flush: Edge.Set) -> CGFloat {
        let point = anchor(flush)
        return [1.1, 0.85, 0.62][[point.x, point.y].filter { $0 == 0.5 }.count]
    }

    /// Room above the words for the collapse and full-screen buttons.
    static let buttonRoom: CGFloat = 30 + ConchSpace.x2

    /// A soft patch around the words, the reply line and the buttons above them.
    static func textBacking(_ text: CGRect, fade: CGFloat) -> some View {
        // Wide and very soft, so it thickens the fog behind the words without ever reading as a pane.
        let pad = ConchSpace.x10
        return RoundedRectangle(cornerRadius: fade)
            .frame(width: text.width + 2 * pad, height: text.height + buttonRoom + 2 * pad)
            .offset(x: text.minX - pad, y: text.minY - buttonRoom - pad)
            .blur(radius: fade / 2)
    }

    /// Where the words and the reply line sit in a panel of `size`: toward the edge the fog gathers on, inset
    /// from every edge, with room above for the buttons. The fog's density is built around this same frame.
    static func textFrame(in size: CGSize, flush: Edge.Set, fullScreen: Bool) -> CGRect {
        if fullScreen {
            let width = max(0, min(1040, size.width - 2 * ConchSpace.x12))
            let height = max(0, size.height * 0.8)
            return CGRect(x: (size.width - width) / 2, y: size.height - ConchSpace.x12 - height, width: width, height: height)
        }
        let fade = edgeFade(size)
        let leading = inset(.leading, flush: flush, fade: fade)
        let trailing = inset(.trailing, flush: flush, fade: fade)
        let bottom = inset(.bottom, flush: flush, fade: fade)
        let top = inset(.top, flush: flush, fade: fade) + buttonRoom
        let width = max(0, min(560, size.width * 0.66, size.width - leading - trailing))
        let height = max(0, min(size.height * 0.62, size.height - bottom - top))
        let x: CGFloat = switch anchor(flush).x {
        case 0: leading
        case 1: size.width - trailing - width
        default: (size.width - width) / 2
        }
        return CGRect(x: x, y: size.height - bottom - height, width: width, height: height)
    }

    /// About 50 pt in from a screen edge, where blur.html set the corner's words; clear of the fade on a free edge.
    static func inset(_ edge: Edge.Set, flush: Edge.Set, fade: CGFloat) -> CGFloat {
        flush.contains(edge) ? ConchSpace.x12 : fade + ConchSpace.x4
    }

    /// How much of the fog colour lies over the blur where the fog is densest.
    static let tintOpacity = 0.9

    public var body: some View {
        GeometryReader { proxy in
            let text = Self.textFrame(in: proxy.size, flush: flush, fullScreen: isFullScreen)
            ZStack(alignment: .topLeading) {
                Group {
                    if isFullScreen {
                        // panel.html's wash, light at the top so the blurred work still shows and deepening toward the
                        // words, with a thicker patch right behind them.
                        Rectangle().fill(ConchColor.fog).mask {
                            ZStack(alignment: .topLeading) {
                                LinearGradient(
                                    stops: [.init(color: .black.opacity(0.12), location: 0), .init(color: .black.opacity(0.42), location: 0.55), .init(color: .black.opacity(0.62), location: 1)],
                                    startPoint: .top,
                                    endPoint: .bottom
                                )
                                Self.textBacking(text, fade: 64).opacity(0.5)
                            }
                        }
                    } else {
                        Rectangle()
                            .fill(ConchColor.fog)
                            .opacity(Self.tintOpacity)
                            .mask(Self.density(fullScreen: false, flush: flush))
                    }
                }
                .accessibilityHidden(true)
                // The words keep a short soft edge of their own at the bottom, so the gap to the reply is that plus this.
                VStack(alignment: .leading, spacing: isFullScreen ? ConchSpace.x2 : ConchSpace.x1) {
                    words
                    InlineReplyLine(
                        text: $draft,
                        isListening: isListening,
                        font: isFullScreen ? ConchType.conversationNowFull : ConchType.conversationNow,
                        onMic: onMic,
                        onSend: onSend
                    )
                }
                .frame(width: text.width, height: text.height, alignment: .bottomLeading)
                .overlay(alignment: .topLeading) { panelButtons.offset(y: -Self.buttonRoom) }
                .offset(x: text.minX, y: text.minY)
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
        }
        .onHover { hovering = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Conversation")
    }

    private var words: some View {
        let recent = Array(turns.suffix(8))
        let column = VStack(alignment: .leading, spacing: isFullScreen ? ConchSpace.x6 : ConchSpace.x4) {
            ForEach(Array(recent.enumerated()), id: \.element.id) { index, turn in
                let age = recent.count - 1 - index
                VStack(alignment: .leading, spacing: ConchSpace.x1) {
                    if turn.fromYou {
                        Text("You")
                            .font(ConchType.meta)
                            .fontWeight(.semibold)
                            .tracking(0.6)
                            .textCase(.uppercase)
                            .foregroundStyle(ConchColor.textTertiary)
                    }
                    Text(Self.inlineMarkdown(turn.text))
                        .font(Self.font(latest: age == 0, fullScreen: isFullScreen))
                        // Large type reads better set a touch tighter.
                        .tracking(age == 0 ? (isFullScreen ? -0.8 : -0.3) : 0)
                        .foregroundStyle(age == 0 ? ConchColor.textPrimary : ConchColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // The turn before the latest reads plainly; older ones fade as they rise.
                .opacity(max(0.45, 1 - 0.18 * Double(max(0, age - 1))))
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // At rest the latest turn sits above the soft bottom edge, not in it.
        .padding(.bottom, ConchSpace.x4)

        return Group {
            if rendersStatically {
                // ImageRenderer cannot draw a scroll view: the same column, pinned to the bottom.
                // minHeight 0, or the frame grows to fit the column and nothing is clipped.
                column.frame(minHeight: 0, maxHeight: .infinity, alignment: .bottom).clipped()
            } else {
                ScrollView { column }
                    .scrollIndicators(.never)
                    .defaultScrollAnchor(.bottom)
            }
        }
        // Soft at both ends: turns thin out as they rise, and anything scrolled below slips under a short fade
        // above the reply line instead of ending in a cut.
        .mask {
            GeometryReader { proxy in
                VStack(spacing: 0) {
                    LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                        .frame(height: proxy.size.height * (isFullScreen ? 0.34 : 0.26))
                    Rectangle()
                    LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                        .frame(height: ConchSpace.x4)
                }
            }
        }
    }

    static func font(latest: Bool, fullScreen: Bool) -> Font {
        switch (latest, fullScreen) {
        case (true, false): ConchType.conversationNow
        case (false, false): ConchType.conversationPast
        case (true, true): ConchType.conversationNowFull
        case (false, true): ConchType.conversationPastFull
        }
    }

    /// Collapse, then full screen: the order a Mac window's minimise and zoom buttons come in.
    private var panelButtons: some View {
        HStack(spacing: ConchSpace.x2) {
            IconButton("chevron.down", label: "Collapse conversation", style: .glass, size: 30, action: onCollapse)
            IconButton(
                isFullScreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                label: isFullScreen ? "Exit full screen" : "Full screen",
                style: .glass,
                size: 30,
                action: onFullScreen
            )
            .keyboardShortcut(.return, modifiers: .command)
        }
        // Quiet until the pointer is over the fog, but never gone: hover may not reach a panel of an app that is
        // not active. Always there for VoiceOver and for Command-Return.
        .opacity(hovering || rendersStatically ? 1 : 0.4)
        .animation(ConchMotion.animation(ConchMotion.quick, reduceMotion: reduceMotion), value: hovering)
    }

    /// Agent replies are markdown; the fog shows the inline parts (emphasis, code, links) and keeps line breaks.
    static func inlineMarkdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}

// MARK: - FogHandle

/// The conversation fog collapsed (M3): next to nothing, a small faint dot where the fog's corner was. A click
/// opens the fog again at the size it had.
public struct FogHandle: View {
    public static let side: CGFloat = 30

    let onExpand: () -> Void
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(onExpand: @escaping () -> Void) {
        self.onExpand = onExpand
    }

    public var body: some View {
        Button(action: onExpand) {
            Image(systemName: "chevron.up")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(ConchColor.textSecondary)
                .frame(width: Self.side, height: Self.side)
                .background {
                    Circle().fill(.ultraThinMaterial)
                    Circle().fill(ConchColor.glass)
                }
                .overlay(Circle().strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        // Faint at rest, clear under the pointer; hover may never arrive, so never invisible.
        .opacity(hovering ? 1 : 0.8)
        .onHover { hovering = $0 }
        .animation(ConchMotion.animation(ConchMotion.quick, reduceMotion: reduceMotion), value: hovering)
        .accessibilityLabel("Show conversation")
    }
}

// MARK: - Previews

#Preview("Voice") {
    VStack(alignment: .leading, spacing: 20) {
        HStack(spacing: 20) {
            VoiceGlyph(.speaking)
            VoiceGlyph(.listening)
            VoiceGlyph(.quiet)
        }
        .foregroundStyle(ConchColor.textPrimary)
        HStack(spacing: 20) {
            ForEach(VoiceState.allCases, id: \.self) { VoiceOrb(state: $0) }
        }
        VoiceStateLabel(state: .speaking, detail: "Blueprint monorepo")
    }
    .padding(32)
    .background(ConchColor.ground)
}

#Preview("Controls") {
    @Previewable @State var mode = VoiceMode.talk
    @Previewable @State var draft = ""
    VStack(alignment: .leading, spacing: 24) {
        GlassPill("Voice controls") {
            VoiceStateLabel(state: .speaking, detail: "Blueprint monorepo")
            TalkQuietSwitch(mode: $mode)
            IconButton("bubble.left", label: "Show conversation") {}
        }
        HStack {
            IconButton("arrow.up.left.and.arrow.down.right", label: "Full screen") {}
            IconButton("arrow.up", label: "Send", style: .primary) {}
        }
        InlineReplyLine(text: $draft, isListening: false, onMic: {}, onSend: {})
    }
    .padding(32)
    .frame(width: 640)
    .background(ConchColor.ground)
}
