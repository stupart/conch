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
            case .talk, .ready:
                Circle().fill(ConchColor.fill)
                Image(systemName: "mic")
                    .font(.system(size: size * 15 / 36, weight: .semibold))
                    .foregroundStyle(ConchColor.textSecondary)
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

    public init(_ label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    public var body: some View {
        HStack(spacing: ConchSpace.x3) { content }
            .padding(.horizontal, 6)
            .frame(height: 48)
            .background {
                Capsule().fill(.ultraThinMaterial)
                Capsule().fill(ConchColor.glass)
            }
            .overlay(Capsule().strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
            .conchElevation(.floating)
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
                .background(Circle().fill(style == .primary ? ConchColor.accent : ConchColor.fill))
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
    let onMic: () -> Void
    let onSend: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.conchRendersStatically) private var rendersStatically

    public init(
        text: Binding<String>,
        isListening: Bool,
        placeholder: String = "Reply",
        onMic: @escaping () -> Void,
        onSend: @escaping () -> Void
    ) {
        _text = text
        self.isListening = isListening
        self.placeholder = placeholder
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
                .font(ConchType.conversationNow)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Reply")
            } else {
                TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(ConchColor.textTertiary), axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(ConchType.conversationNow)
                    .foregroundStyle(ConchColor.textPrimary)
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
