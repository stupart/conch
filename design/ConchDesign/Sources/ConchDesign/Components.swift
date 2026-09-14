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

/// The orb with the state and what it is about: "Speaking / Blueprint monorepo", or with `leadsWithDetail`,
/// "Blueprint monorepo / Speaking".
public struct VoiceStateLabel: View {
    let state: VoiceState
    let detail: String
    let orbSize: CGFloat
    let leadsWithDetail: Bool

    public init(state: VoiceState, detail: String, orbSize: CGFloat = 36, leadsWithDetail: Bool = false) {
        self.state = state
        self.detail = detail
        self.orbSize = orbSize
        self.leadsWithDetail = leadsWithDetail
    }

    public var body: some View {
        let detailFirst = leadsWithDetail && !detail.isEmpty
        HStack(spacing: ConchSpace.x3) {
            VoiceOrb(state: state, size: orbSize)
            VStack(alignment: .leading, spacing: 1) {
                Text(detailFirst ? detail : state.title)
                    .font(ConchType.uiEmphasis)
                    .foregroundStyle(ConchColor.textPrimary)
                    .lineLimit(1)
                if detailFirst || !detail.isEmpty {
                    Text(detailFirst ? state.title : detail)
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
                        .fixedSize()
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
                .foregroundStyle(style == .primary ? ConchColor.onAccent : style == .glass ? ConchColor.textPrimary : ConchColor.textSecondary)
                .frame(width: size, height: size)
                .background {
                    switch style {
                    case .plain: Circle().fill(ConchColor.fill)
                    case .primary: Circle().fill(ConchColor.accent)
                    case .glass:
                        Circle().fill(ConchColor.glass)
                            .overlay(Circle().strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
                            .conchElevation(.raised)
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
                    // Grows to five lines, then scrolls like the transcript rather than pushing it away.
                    .lineLimit(1...5)
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
            // The session first: the orb and the menu bar mark already say what the voice is doing.
            VoiceStateLabel(state: state, detail: detail, leadsWithDetail: true)
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

/// The screen corner the conversation fog belongs to: the one nearest the panel. The corner fog turns to face it.
public enum FogCorner: Hashable, Sendable {
    case bottomLeading, bottomTrailing, topLeading, topTrailing

    public init(leading: Bool, bottom: Bool) {
        self = switch (leading, bottom) {
        case (true, true): .bottomLeading
        case (false, true): .bottomTrailing
        case (true, false): .topLeading
        case (false, false): .topTrailing
        }
    }

    public var leading: Bool { self == .bottomLeading || self == .topLeading }
    public var bottom: Bool { self == .bottomLeading || self == .bottomTrailing }
    var unitPoint: UnitPoint { UnitPoint(x: leading ? 0 : 1, y: bottom ? 1 : 0) }
    var alignment: Alignment { bottom ? (leading ? .bottomLeading : .bottomTrailing) : (leading ? .topLeading : .topTrailing) }

    /// The corner of `screen` nearest the middle of `rect`, in screen coordinates (y up). Close to a middle line it
    /// keeps `current`, so dragging across one doesn't flicker between two corners.
    public static func nearest(to rect: CGRect, in screen: CGRect, current: FogCorner) -> FogCorner {
        let dx = rect.midX - screen.midX
        let dy = rect.midY - screen.midY
        return FogCorner(
            leading: abs(dx) < screen.width * 0.05 ? current.leading : dx < 0,
            bottom: abs(dy) < screen.height * 0.05 ? current.bottom : dy < 0
        )
    }
}

/// Where the conversation fog sits: always docked in a corner of its screen, touching one side and the top or the
/// bottom. Its two other edges are free: they are what it is resized by, and where it fades. Screen coordinates, y up.
public enum FogDock {
    /// A fog of `size` docked in `corner` of `screen`, never bigger than the screen.
    public static func frame(size: CGSize, corner: FogCorner, in screen: CGRect) -> CGRect {
        let width = min(size.width, screen.width)
        let height = min(size.height, screen.height)
        return CGRect(
            x: corner.leading ? screen.minX : screen.maxX - width,
            y: corner.bottom ? screen.minY : screen.maxY - height,
            width: width,
            height: height
        )
    }

    /// The corner a fog let go at `center`, moving at `velocity` (points per second), comes to rest in: the one nearest
    /// where its momentum would carry it, as iOS picture in picture chooses (WWDC18, "Designing Fluid Interfaces").
    public static func corner(releasedAt center: CGPoint, velocity: CGVector, in screen: CGRect) -> FogCorner {
        // The distance a scroll view's normal deceleration (0.998 per millisecond) carries a velocity.
        let carry = 0.998 / (1 - 0.998) / 1000
        return FogCorner(
            leading: center.x + velocity.dx * carry < screen.midX,
            bottom: center.y + velocity.dy * carry < screen.midY
        )
    }

    /// `start` resized by a drag of `delta`, both ways at once: its corner stays where it is. Held between `minSize` and
    /// the screen, or with `rubberBand`, let a little past them with growing resistance, as a scroll view overscrolls.
    public static func resize(_ start: CGRect, corner: FogCorner, by delta: CGVector, in screen: CGRect, minSize: CGSize, rubberBand: Bool = false) -> CGRect {
        let width = limit(start.width + (corner.leading ? delta.dx : -delta.dx), minSize.width, screen.width, rubberBand: rubberBand)
        let height = limit(start.height + (corner.bottom ? delta.dy : -delta.dy), minSize.height, screen.height, rubberBand: rubberBand)
        return CGRect(
            x: corner.leading ? screen.minX : screen.maxX - width,
            y: corner.bottom ? screen.minY : screen.maxY - height,
            width: width,
            height: height
        )
    }

    /// `value` between `low` and `high`, or past them by UIScrollView's rubber band: `(1 − 1 / (x·0.55 / d + 1))·d`.
    static func limit(_ value: CGFloat, _ low: CGFloat, _ high: CGFloat, rubberBand: Bool) -> CGFloat {
        guard rubberBand else { return min(max(value, low), high) }
        func band(_ over: CGFloat, _ dimension: CGFloat) -> CGFloat { (1 - 1 / (over * 0.55 / dimension + 1)) * dimension }
        if value < low { return low - band(low - value, low) }
        if value > high { return high + band(value - high, high) }
        return value
    }

    /// Whether a drag starting at `point` (the fog's own coordinates, y down) resizes it rather than moving it: anywhere
    /// within reach of a free edge, text included. Reach is a third of the fog or 120 pt, whichever is more; the rest,
    /// toward its docked corner, moves it.
    public static func resizes(at point: CGPoint, in size: CGSize, corner: FogCorner) -> Bool {
        let fromSide = corner.leading ? size.width - point.x : point.x
        let fromEnd = corner.bottom ? point.y : size.height - point.y
        return fromSide < max(120, size.width / 3) || fromEnd < max(120, size.height / 3)
    }

    /// The two edges away from `corner`.
    public static func freeEdges(_ corner: FogCorner) -> Edge.Set {
        [corner.leading ? .trailing : .leading, corner.bottom ? .top : .bottom]
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
    /// The screen corner the fog is docked in: it gathers there, and the words keep to that side.
    let corner: FogCorner
    /// Where the Dock and the menu bar overlap the fog, so the words stay clear of them.
    let insets: EdgeInsets
    /// Draws the fog's tint; off, the words and buttons stand alone.
    let showsFog: Bool
    /// Draws the collapse and full-screen buttons; a host that layers its own controls over the fog draws them itself.
    let showsButtons: Bool
    let onMic: () -> Void
    let onSend: () -> Void
    let onCollapse: () -> Void
    let onFullScreen: () -> Void
    @Environment(\.conchRendersStatically) private var rendersStatically

    public init(
        turns: [ConversationTurn],
        draft: Binding<String>,
        isListening: Bool,
        isFullScreen: Bool,
        corner: FogCorner = .bottomLeading,
        insets: EdgeInsets = EdgeInsets(),
        showsFog: Bool = true,
        showsButtons: Bool = true,
        onMic: @escaping () -> Void,
        onSend: @escaping () -> Void,
        onCollapse: @escaping () -> Void,
        onFullScreen: @escaping () -> Void
    ) {
        self.turns = turns
        _draft = draft
        self.isListening = isListening
        self.isFullScreen = isFullScreen
        self.corner = corner
        self.insets = insets
        self.showsFog = showsFog
        self.showsButtons = showsButtons
        self.onMic = onMic
        self.onSend = onSend
        self.onCollapse = onCollapse
        self.onFullScreen = onFullScreen
    }

    /// Where the fog is, as a mask (only its alpha matters). Full screen, everywhere; otherwise the corner fog,
    /// strongest in the panel's `corner` and gone three quarters of the way out, so there is no edge to look at.
    public static func density(fullScreen: Bool, corner: FogCorner = .bottomLeading) -> EllipticalGradient {
        EllipticalGradient(
            stops: fullScreen
                ? [.init(color: .black, location: 0), .init(color: .black, location: 1)]
                : [
                    .init(color: .black, location: 0.36),
                    .init(color: .black.opacity(0.75), location: 0.5),
                    .init(color: .black.opacity(0.3), location: 0.64),
                    .init(color: .clear, location: 0.78),
                ],
            center: corner.unitPoint,
            endRadiusFraction: 1.1
        )
    }

    /// Inside the fog, before the screen's own insets.
    public static let padding: CGFloat = ConchSpace.x6
    static let buttonSize: CGFloat = 36

    /// Where the words and the reply line sit: all of the fog but its padding, the screen's insets and a row for the
    /// buttons, so a bigger fog is all more room for words. Past a comfortable line they keep to the fog's corner.
    static func textFrame(in size: CGSize, corner: FogCorner, insets: EdgeInsets, fullScreen: Bool) -> CGRect {
        let top = insets.top + padding + buttonSize + ConchSpace.x3
        let height = max(0, size.height - top - insets.bottom - padding)
        let leading = insets.leading + padding
        let trailing = insets.trailing + padding
        let room = max(0, size.width - leading - trailing)
        if fullScreen {
            let width = min(1040, room)
            return CGRect(x: leading + (room - width) / 2, y: top, width: width, height: height)
        }
        let width = min(960, room)
        return CGRect(x: corner.leading ? leading : size.width - trailing - width, y: top, width: width, height: height)
    }

    /// How much of the fog colour lies over the blur where the fog is densest.
    static let tintOpacity = 0.86

    public var body: some View {
        GeometryReader { proxy in
            let text = Self.textFrame(in: proxy.size, corner: corner, insets: insets, fullScreen: isFullScreen)
            ZStack(alignment: .topLeading) {
                if showsFog {
                    Group {
                        if isFullScreen {
                            // panel.html's wash: light at the top so the blurred work still shows, deepening toward the words.
                            Rectangle().fill(ConchColor.fog).mask(LinearGradient(
                                stops: [.init(color: .black.opacity(0.12), location: 0), .init(color: .black.opacity(0.42), location: 0.55), .init(color: .black.opacity(0.62), location: 1)],
                                startPoint: .top,
                                endPoint: .bottom
                            ))
                        } else {
                            Rectangle()
                                .fill(ConchColor.fog)
                                .opacity(Self.tintOpacity)
                                .mask(Self.density(fullScreen: false, corner: corner))
                        }
                    }
                    .accessibilityHidden(true)
                }
                // The words keep a short soft edge of their own at the bottom; this is the rest of the gap to the reply.
                VStack(alignment: .leading, spacing: isFullScreen ? ConchSpace.x6 : ConchSpace.x4) {
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
                .offset(x: text.minX, y: text.minY)
                if showsButtons {
                    // On the free side of the top row, away from the edge the fog is docked to.
                    FogPanelButtons(corner: corner, isFullScreen: isFullScreen, onCollapse: onCollapse, onFullScreen: onFullScreen)
                        .frame(
                            width: max(0, proxy.size.width - insets.leading - insets.trailing - 2 * Self.padding),
                            alignment: isFullScreen || !corner.leading ? .leading : .trailing
                        )
                        .offset(x: insets.leading + Self.padding, y: insets.top + Self.padding)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
        }
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

    /// Agent replies are markdown; the fog shows the inline parts (emphasis, code, links) and keeps line breaks.
    static func inlineMarkdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}

// MARK: - FogPanelButtons

/// The fog's collapse and full-screen buttons: in that order, as a Mac window's minimise and zoom come. Always fully
/// there: a hover can't be relied on in a panel of an app that isn't active.
public struct FogPanelButtons: View {
    let corner: FogCorner
    let isFullScreen: Bool
    let onCollapse: () -> Void
    let onFullScreen: () -> Void

    public init(corner: FogCorner, isFullScreen: Bool, onCollapse: @escaping () -> Void, onFullScreen: @escaping () -> Void) {
        self.corner = corner
        self.isFullScreen = isFullScreen
        self.onCollapse = onCollapse
        self.onFullScreen = onFullScreen
    }

    public var body: some View {
        HStack(spacing: ConchSpace.x2) {
            IconButton(
                corner.bottom || isFullScreen ? "chevron.down" : "chevron.up",
                label: "Collapse conversation",
                style: .glass,
                size: ConversationFog.buttonSize,
                action: onCollapse
            )
            IconButton(
                isFullScreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                label: isFullScreen ? "Exit full screen" : "Full screen",
                style: .glass,
                size: ConversationFog.buttonSize,
                action: onFullScreen
            )
            .keyboardShortcut(.return, modifiers: .command)
        }
    }
}

// MARK: - FogHandle

/// The conversation fog collapsed (M3): nothing to see until the pointer comes into the fog's corner, then a caret
/// that opens it again at the size it had. The whole corner area opens it.
public struct FogHandle: View {
    /// The corner area the pointer shows the caret in.
    public static let side: CGFloat = 72

    let corner: FogCorner
    let hovering: Bool
    let onExpand: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(corner: FogCorner = .bottomLeading, hovering: Bool = true, onExpand: @escaping () -> Void) {
        self.corner = corner
        self.hovering = hovering
        self.onExpand = onExpand
    }

    public var body: some View {
        ZStack(alignment: corner.alignment) {
            Color.clear
            Button(action: onExpand) {
                Image(systemName: corner.bottom ? "chevron.up" : "chevron.down")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(ConchColor.textPrimary)
                    .frame(width: 44, height: 44)
                    .background {
                        Circle().fill(.ultraThinMaterial)
                        Circle().fill(ConchColor.glass)
                    }
                    .overlay(Circle().strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
                    .conchElevation(.raised)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .padding(ConchSpace.x3)
            // Hidden until the pointer is in the corner (Tyler: "only shows when your hovering in that area").
            .opacity(hovering ? 1 : 0)
            .animation(ConchMotion.animation(ConchMotion.quick, reduceMotion: reduceMotion), value: hovering)
            .accessibilityLabel("Show conversation")
        }
        .frame(width: Self.side, height: Self.side)
        .contentShape(Rectangle())
        .onTapGesture(perform: onExpand)
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
