import SwiftUI

extension EnvironmentValues {
    /// Set by the gallery. ImageRenderer cannot draw a platform text field, so a component that hosts one
    /// draws a SwiftUI stand-in in the same type and colours instead.
    @Entry public var conchRendersStatically = false
    /// Set by the overlay: how far its palette has crossfaded from light (0) to dark (1). Colour tokens follow it rather
    /// than the colour scheme, so the words turn with the look.
    @Entry public var conchDarkness: Double? = nil
    /// How much of the overlay's button fills show, 0 to 1: all of them while the pointer is over the panel, none while it
    /// is away. Only the fills fade, never the icons or the words on them, which keep their contrast.
    @Entry public var overlayFills: Double = 1
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

    /// How far the listening ring reaches past the orb, as a fraction of its size.
    public static let ringSpread: CGFloat = 5 / 36
    /// The mic on listening's orange, the same in light and dark as the orange is.
    public static let onListening = ConchColor.textPrimary.light
    /// Ready's disc, under a white check: the light green in both schemes, as the menu bar mark draws it. Dark's
    /// brighter green is for a mark on a dark ground, and the check on it measured 2.72; on this it is 3.57.
    public static let readyFill = ConchColor.ready.light

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
                Circle().fill(ConchColor.listeningRing).padding(-size * Self.ringSpread)
                Circle().fill(ConchColor.listening)
                // Dark on the orange: white on #FF9F0A measured 2.06, this 8.19.
                VoiceGlyph(.listening, size: size / 2).foregroundStyle(Self.onListening.color)
            case .quiet:
                Circle().fill(ConchColor.fill)
                VoiceGlyph(.quiet, size: size / 2).foregroundStyle(ConchColor.textSecondary)
            case .talk:
                Circle().fill(ConchColor.fill)
                Image(systemName: "mic")
                    .font(.system(size: size * 15 / 36, weight: .semibold))
                    .foregroundStyle(ConchColor.textSecondary)
            case .ready:
                Circle().fill(Self.readyFill.color)
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

/// The glass capsule's measures: its height, and how far its contents sit in from its ends.
enum PillMetrics {
    static let height: CGFloat = 48
    static let inset: CGFloat = 6
}

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
            .padding(.horizontal, PillMetrics.inset)
            .frame(height: PillMetrics.height)
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
        /// Over another app (the fog's buttons): the overlay's translucent circle with a hairline, as the overlay lab draws them.
        case glass
    }

    let systemName: String
    let label: String
    let style: Style
    let size: CGFloat
    /// The key that does the same, named in its tooltip: "Full screen (⌘↩)".
    let shortcut: String?
    let action: () -> Void
    @Environment(\.overlayFills) private var fills

    public init(_ systemName: String, label: String, style: Style = .plain, size: CGFloat = 36, shortcut: String? = nil, action: @escaping () -> Void) {
        self.systemName = systemName
        self.label = label
        self.style = style
        self.size = size
        self.shortcut = shortcut
        self.action = action
    }

    /// The tooltip: what it does, and its key when it has one.
    public static func help(_ label: String, shortcut: String?) -> String {
        shortcut.map { "\(label) (\($0))" } ?? label
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(style == .primary ? ConchColor.onAccent : style == .glass ? ConchColor.overlayGlassIcon : ConchColor.textSecondary)
                .frame(width: size, height: size)
                .background {
                    switch style {
                    case .plain: Circle().fill(ConchColor.fill)
                    case .primary: Circle().fill(ConchColor.accent)
                    case .glass:
                        Circle().fill(ConchColor.overlayGlass)
                            .overlay(Circle().strokeBorder(ConchColor.overlayLine, lineWidth: 0.5))
                            .opacity(fills)
                    }
                }
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(Self.help(label, shortcut: shortcut))
        .accessibilityLabel(label)
    }
}

// MARK: - InlineReplyLine

/// Replying without a text box: the mic comes first, then your words in the conversation's own type. Return sends,
/// Shift-Return starts a new line and Esc leaves the field, and then `onLeave`, for a host that gives the keys back. Its
/// host gives it its height (`FogReply`): it grows to five lines, then scrolls inside itself.
public struct InlineReplyLine: View {
    @Binding var text: String
    let isListening: Bool
    let placeholder: String
    let fontSize: CGFloat
    /// Hanging from the top, the mic lines up with the first line rather than the last.
    let alignsTop: Bool
    /// Longer than it has room for: it scrolls inside itself, under a soft top edge.
    let overflows: Bool
    let onMic: () -> Void
    let onSend: () -> Void
    let onLeave: (() -> Void)?
    @Environment(\.conchRendersStatically) private var rendersStatically

    public init(
        text: Binding<String>,
        isListening: Bool,
        placeholder: String = "Reply",
        fontSize: CGFloat = 24,
        alignsTop: Bool = false,
        overflows: Bool = false,
        onMic: @escaping () -> Void,
        onSend: @escaping () -> Void,
        onLeave: (() -> Void)? = nil
    ) {
        _text = text
        self.isListening = isListening
        self.placeholder = placeholder
        self.fontSize = fontSize
        self.alignsTop = alignsTop
        self.overflows = overflows
        self.onMic = onMic
        self.onSend = onSend
        self.onLeave = onLeave
    }

    public var body: some View {
        let line = FogReply.lineHeight(fontSize) + 2 * FogReply.padding(fontSize)
        let edge: Alignment = alignsTop ? .topLeading : .bottomLeading
        HStack(alignment: alignsTop ? .top : .bottom, spacing: ConchSpace.x3) {
            Button(action: onMic) {
                Image(systemName: "mic")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(isListening ? ConchColor.onVoice : ConchColor.overlayTextSecondary)
                    .frame(width: 40, height: 40)
                    .background {
                        if isListening { Circle().fill(ConchColor.listeningRing).padding(-5) }
                        Circle().fill(isListening ? ConchColor.listening : ConchColor.overlayFill)
                    }
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isListening ? "Stop listening" : "Speak your reply")
            .frame(height: line)

            Group {
                if rendersStatically {
                    // ImageRenderer can't draw the text view: its words as they would sit, scrolled to the end.
                    Text(text)
                        .font(.system(size: fontSize, weight: .medium))
                        .tracking(-0.014 * fontSize)
                        .lineSpacing(0.1 * fontSize)
                        .foregroundStyle(ConchColor.overlayText)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, FogReply.padding(fontSize))
                } else {
                    #if os(macOS)
                    ReplyField(text: $text, fontSize: fontSize, onSend: onSend, onLeave: onLeave)
                    #else
                    TextField("", text: $text, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(.system(size: fontSize, weight: .medium))
                        .foregroundStyle(ConchColor.overlayText)
                        .onSubmit(onSend)
                    #endif
                }
            }
            // minHeight 0, or a long draft's frame grows to fit it and nothing is clipped.
            .frame(maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: edge)
            .clipped()
            .mask {
                VStack(spacing: 0) {
                    LinearGradient(colors: [overflows ? .clear : .black, .black], startPoint: .top, endPoint: .bottom).frame(height: 16)
                    Rectangle()
                }
            }
            .overlay(alignment: edge) {
                if text.isEmpty {
                    HStack(spacing: 6.5) {
                        if rendersStatically { caret }
                        Text(placeholder).lineLimit(1)
                    }
                    .font(.system(size: fontSize, weight: .medium))
                    .tracking(-0.014 * fontSize)
                    .foregroundStyle(ConchColor.overlayPlaceholder)
                    .frame(height: line)
                    .allowsHitTesting(false)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Reply")
        }
    }

    private var caret: some View {
        RoundedRectangle(cornerRadius: 1.5).fill(ConchColor.overlayText).frame(width: 2.5, height: fontSize)
    }
}

#if os(macOS)
/// The reply's text: AppKit's text view, so a 50 KB draft edits and scrolls as cheaply as a short one, and Return,
/// Shift-Return and Esc do what the lab's do (`FogReply.key`).
private struct ReplyField: NSViewRepresentable {
    @Binding var text: String
    let fontSize: CGFloat
    let onSend: () -> Void
    let onLeave: (() -> Void)?
    @Environment(\.conchDarkness) private var darkness
    @Environment(\.colorScheme) private var scheme

    /// conch never comes forward, so the first click in the field has to place the cursor.
    final class TextView: NSTextView {
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var field: ReplyField

        init(_ field: ReplyField) {
            self.field = field
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            field.text = view.string
        }

        func textView(_ view: NSTextView, doCommandBy selector: Selector) -> Bool {
            let flags = NSApp.currentEvent?.modifierFlags ?? []
            let returnKey = selector == #selector(NSResponder.insertNewline(_:)) || selector == #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:))
            guard returnKey || selector == #selector(NSResponder.cancelOperation(_:)) else { return false }
            switch FogReply.key(returnKey: returnKey, shift: flags.contains(.shift), option: flags.contains(.option)) {
            case .send: field.onSend()
            case .newline: view.insertNewlineIgnoringFieldEditor(nil)
            case .leave:
                view.window?.makeFirstResponder(nil)
                // Left, the field no longer wants the keys; the host decides whether the panel keeps them.
                field.onLeave?()
            }
            return true
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let view = TextView(frame: .zero)
        view.delegate = context.coordinator
        view.isRichText = false
        view.allowsUndo = true
        view.drawsBackground = false
        // Every other editor in the app turns this off; this one did not, so clicking the panel drew a focus ring
        // around the reply line (Tyler: "theres a weird select outline that forms when i click on it").
        view.focusRingType = .none
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        view.textContainer?.widthTracksTextView = true
        view.textContainer?.lineFragmentPadding = 0
        view.layoutManager?.allowsNonContiguousLayout = true
        view.setAccessibilityLabel("Reply")
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        // AppKit draws the focus ring on the SCROLL VIEW, not on the text view inside it, so turning it off there
        // (line above's sibling, `view.focusRingType`) left the ring exactly where it was — a rectangle around the
        // reply line whenever it had the keyboard (Tyler: "thers still a strange outline around teh component").
        scroll.focusRingType = .none
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        scroll.documentView = view
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.field = self
        guard let view = scroll.documentView as? NSTextView, let storage = view.textStorage else { return }
        let ink = ConchColor.overlayText.rgba(darkness: darkness ?? (scheme == .dark ? 1 : 0))
        var attributes = FogReply.attributes(fontSize: fontSize)
        attributes[.foregroundColor] = NSColor(srgbRed: ink.red, green: ink.green, blue: ink.blue, alpha: ink.alpha)
        let inset = NSSize(width: 0, height: FogReply.padding(fontSize))
        if view.textContainerInset != inset { view.textContainerInset = inset }
        let restyle = !(view.typingAttributes as NSDictionary).isEqual(to: attributes)
        if restyle {
            view.typingAttributes = attributes
            view.insertionPointColor = attributes[.foregroundColor] as? NSColor
        }
        if view.string != text {
            view.string = text
            storage.setAttributes(attributes, range: NSRange(location: 0, length: storage.length))
            view.scrollRangeToVisible(view.selectedRange())
        } else if restyle {
            storage.setAttributes(attributes, range: NSRange(location: 0, length: storage.length))
        }
    }
}
#endif

// MARK: - ControlBar

/// The floating control bar (M3): the voice and what it is about, and Talk or Quiet. The conversation is shown and
/// hidden from the menu bar menu, not from here. While anything is ready its label is the Ready pill, a button that
/// opens the next ready item (`ReviewScene`), and it stays one while conch speaks or listens.
public struct ControlBar: View {
    /// What the pill opens next, and where that is among what is ready.
    public struct Ready: Equatable, Sendable {
        /// The session the next item is in.
        public let label: String
        /// Its place among what is ready, from 1, and how many are.
        public let position: Int
        public let count: Int
        /// What the agent asked you to check there (`scene.inspect`), when it said.
        public let inspect: String?

        public init(label: String, position: Int, count: Int, inspect: String? = nil) {
            self.label = label
            self.position = position
            self.count = count
            self.inspect = inspect
        }

        /// "Ready · 1 of 3". One alone is just Ready: "1 of 1" says nothing.
        public var line: String { count > 1 ? "Ready · \(position) of \(count)" : "Ready" }

        /// The tooltip: "Open Prime page wireframe · 1 of 3", then what to check there when the agent said.
        public var help: String {
            let open = count > 1 ? "Open \(label) · \(position) of \(count)" : "Open \(label)"
            return inspect.map { "\(open)\n\($0)" } ?? open
        }
    }

    let state: VoiceState
    let detail: String
    @Binding var mode: VoiceMode
    let ready: Ready?
    /// News for the second line while it would only repeat Talk or Quiet, which the switch beside it says: "2 working".
    let news: String?
    let onTap: (() -> Void)?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(state: VoiceState, detail: String, mode: Binding<VoiceMode>, ready: Ready? = nil, news: String? = nil, onTap: (() -> Void)? = nil) {
        self.state = state
        self.detail = detail
        _mode = mode
        self.ready = ready
        self.news = news
        self.onTap = onTap
    }

    /// The label is the Ready pill while anything is ready, whatever the voice is doing: it used to stop taking clicks
    /// the moment conch spoke or listened. Talk and Quiet keep their own.
    var taps: Bool { onTap != nil && ready != nil }

    /// A size down from the menu's orb, and sat in the capsule's round end (`PillMetrics`), so the listening ring
    /// clears the capsule by `ringClearance` all round. At 36 it came within a point of the end.
    static let orbSize: CGFloat = 32
    static let orbLead = PillMetrics.height / 2 - PillMetrics.inset - orbSize / 2
    static var ringClearance: CGFloat { PillMetrics.height / 2 - orbSize * (0.5 + VoiceOrb.ringSpread) }

    /// How a new orb comes in: out of a touch smaller as it fades up; under Reduce Motion, the fade alone.
    static func orbEntryScale(reduceMotion: Bool) -> CGFloat { reduceMotion ? 1 : 0.8 }

    /// The two lines beside the orb.
    var lines: (title: String, subtitle: String?) {
        switch (state, ready) {
        case (.speaking, _), (.listening, _):
            // What it is about, and what it is doing, and that something is still ready behind it.
            let waiting = ready.map { "\($0.count) ready" }
            guard !detail.isEmpty else { return (state.title, waiting) }
            return (detail, [state.title, waiting].compactMap { $0 }.joined(separator: " · "))
        case let (_, ready?):
            // The session the pill opens next, and where it is among what is ready.
            return (ready.label, ready.line)
        case (.ready, nil):
            return detail.isEmpty ? (state.title, nil) : (detail, state.title)
        case (.talk, nil), (.quiet, nil):
            // The switch beside it says Talk or Quiet already, so the line is news, or nothing.
            return detail.isEmpty ? (news ?? state.title, nil) : (detail, news)
        }
    }

    public var body: some View {
        GlassPill("Voice controls") {
            let lines = lines
            let words = [lines.title, lines.subtitle].compactMap { $0 }.joined(separator: "\n")
            let label = HStack(spacing: ConchSpace.x3) {
                // One on top of the other while they cross, rather than side by side.
                ZStack {
                    VoiceOrb(state: state, size: Self.orbSize)
                        .id(state)
                        .transition(.opacity.combined(with: .scale(scale: Self.orbEntryScale(reduceMotion: reduceMotion))))
                }
                .frame(width: Self.orbSize, height: Self.orbSize)
                ZStack(alignment: .leading) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(lines.title)
                            .font(ConchType.uiEmphasis)
                            .foregroundStyle(ConchColor.textPrimary)
                            .lineLimit(1)
                        if let subtitle = lines.subtitle {
                            Text(subtitle)
                                .font(ConchType.secondary)
                                .foregroundStyle(ConchColor.textSecondary)
                                .lineLimit(1)
                        }
                    }
                    .id(words)
                    .transition(.opacity)
                }
                Spacer(minLength: 0)
                if taps {
                    // Says it opens something before the pointer finds it.
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(ConchColor.textSecondary)
                        .transition(.opacity)
                }
            }
            .padding(.leading, Self.orbLead)
            // A fixed width, so the bar keeps its size and place as the state and the session change. The session
            // first: the orb and the menu bar mark already say what the voice is doing. 224 rather than 196 now the ›
            // shares it, so a name like "Prime page wireframe" still reads whole.
            .frame(width: 224, alignment: .leading)
            // The voice's colour takes over on its own spring, the words cross with it; Reduce Motion keeps the fades.
            .animation(ConchMotion.voiceColour.animation(reduceMotion: reduceMotion), value: state)
            .animation(ConchMotion.voiceColour.animation(reduceMotion: reduceMotion), value: words)
            .animation(ConchMotion.voiceColour.animation(reduceMotion: reduceMotion), value: taps)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(words.replacingOccurrences(of: "\n", with: ", ").replacingOccurrences(of: " · ", with: ", "))
            if taps, let onTap {
                Button(action: onTap) { label.contentShape(Rectangle()) }
                    .buttonStyle(PillPress())
                    #if os(macOS)
                    .onContinuousHover { phase in
                        if case .active = phase { NSCursor.pointingHand.set() } else { NSCursor.arrow.set() }
                    }
                    #endif
                    .help(ready?.help ?? "")
                    .accessibilityHint("Opens the next ready item")
            } else {
                label
            }
            TalkQuietSwitch(mode: $mode)
        }
    }
}

/// A pressed pill label settles in a little on the pop spring, and springs back.
private struct PillPress: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: configuration.isPressed)
    }
}

// MARK: - ReviewScene

/// What a click on the Ready pill brings forward for one review: the agents showing you their work, rather than you
/// going to find it (Tyler: "it's like the agents are messaging me 'look at this' and showing me stuff").
public enum ReviewScene: Equatable {
    /// The deliverable itself, in whatever app macOS opens it with.
    case open(URL)
    /// conch's window, on the session.
    case app
    /// The session's terminal.
    case terminal

    /// The scene a review asked for (`scene.target.kind`, v1). None, or one this build doesn't know, is `auto`.
    public enum Kind: String, Sendable {
        case auto, link, conversation, terminal
    }

    /// `auto` and `link`: the link first, a web page or a file that is there; else conch's window if it is open; else the
    /// session's terminal; else conch's window anyway, for a session there is nothing else to show of. `link` is the
    /// same order said explicitly: a link that fails to open (passed back as nil) falls through to the rest.
    /// `conversation`: conch's window on the session, even with a link, opened if it is closed. `terminal`: the
    /// session's terminal, else conch's window.
    public static func choose(kind: Kind = .auto, link: URL?, fileExists: (String) -> Bool, appWindowOpen: Bool, revealable: Bool) -> ReviewScene {
        switch kind {
        case .conversation: return .app
        case .terminal: return revealable ? .terminal : .app
        case .auto, .link: break
        }
        if let link, ["http", "https"].contains(link.scheme?.lowercased() ?? "") { return .open(link) }
        if let link, link.isFileURL, fileExists(link.path) { return .open(link) }
        if appWindowOpen { return .app }
        if revealable { return .terminal }
        return .app
    }

    /// The review a click brings forward, from the ready ones by version (a session and when its review was filed) and
    /// filing time. Oldest filed first, ties by version so the order never shuffles; the unopened before any already
    /// opened; the next after `last`, round to the first again. A `last` no longer ready starts the queue over.
    public static func next<Key: Comparable & Hashable>(after last: Key?, in ready: [(key: Key, at: Double)], opened: Set<Key>) -> Key? {
        let queue = order(ready)
        let unopened = queue.filter { !opened.contains($0) }
        let pool = unopened.isEmpty ? queue : unopened
        guard let lastIndex = last.flatMap(queue.firstIndex(of:)) else { return pool.first }
        return pool.first { queue.firstIndex(of: $0)! > lastIndex } ?? pool.first
    }

    /// The panel's Previous: the review filed before `last`, opened or not, round to the newest. Next goes on to what you
    /// haven't seen; Previous goes back to what you have, which skipping the opened would never reach. None yet, the newest.
    public static func previous<Key: Comparable & Hashable>(before last: Key?, in ready: [(key: Key, at: Double)]) -> Key? {
        let queue = order(ready)
        guard let index = last.flatMap(queue.firstIndex(of:)) else { return queue.last }
        return queue[(index + queue.count - 1) % queue.count]
    }

    /// Oldest filed first, ties by version so the order never shuffles: the walk's order, and the pill's "1 of 3".
    public static func order<Key: Comparable>(_ ready: [(key: Key, at: Double)]) -> [Key] {
        ready.sorted { ($0.at, $0.key) < ($1.at, $1.key) }.map { $0.key }
    }

    /// A pick in the conversation panel (its switcher, Previous and Next) that has nothing to open is the session's words,
    /// full screen in the panel, rather than a terminal or conch's window (Tyler: "maybe just shows fullscreen text
    /// transcript / writer convo if there is no content"). True for a session with no review, or one whose `auto` or
    /// `link` scene has no link that opens. A scene the review asked for by name, `terminal` or `conversation`, is still
    /// that scene.
    public static func panelShowsWords(hasReview: Bool, kind: Kind, link: URL?, fileExists: (String) -> Bool) -> Bool {
        guard hasReview else { return true }
        switch kind {
        case .terminal, .conversation: return false
        case .auto, .link:
            if case .open = choose(kind: kind, link: link, fileExists: fileExists, appWindowOpen: false, revealable: false) { return false }
            return true
        }
    }

    /// The deliverable kinds (src/deliverables.ts) the panel shows inside itself, in the side panel's own renderers
    /// (ReviewView.swift): a page, a document, a picture, a video, a sound, a live url.
    static let panelKinds: Set<String> = ["page", "markdown", "text", "image", "pdf", "video", "audio", "url"]
    /// The same kinds by a file's extension, src/deliverables.ts's table, for a deliverable filed without one.
    static let panelExtensions: Set<String> = [
        "html", "htm", "png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "tiff", "mp4", "mov", "m4v", "webm",
        "mp3", "m4a", "wav", "aac", "aiff", "flac", "ogg", "pdf", "md", "markdown",
        "txt", "log", "json", "yaml", "yml", "toml", "csv", "diff", "patch",
    ]

    /// A pick in the conversation panel whose deliverable the panel shows itself, full screen, rather than bringing it
    /// forward in its own app (09-21, "BOTH": full screen shows the content in the panel, the reply floating over it).
    /// Only where the pill's scene would open the link, so a scene asked for by name, or a link with nothing behind it, is
    /// as before; and only a kind the panel can draw, so an app window, the Simulator, a terminal, a design or an office
    /// document still comes forward in its own app. `deliverable` is the kind it was filed as; with none, from a daemon
    /// older than kinds, the link says: a web page but Figma's, or a file by its extension.
    public static func panelShowsContent(kind: Kind, deliverable: String?, link: URL?, fileExists: (String) -> Bool) -> Bool {
        guard case let .open(url) = choose(kind: kind, link: link, fileExists: fileExists, appWindowOpen: false, revealable: false) else { return false }
        if let deliverable { return panelKinds.contains(deliverable) }
        if url.isFileURL { return panelExtensions.contains(url.pathExtension.lowercased()) }
        let host = url.host?.lowercased() ?? ""
        return host != "figma.com" && !host.hasSuffix(".figma.com")
    }
}

// MARK: - FogSession

/// A session as the conversation panel names it and its switcher lists it (Tyler: "knows what content is on the screen
/// and what session relates to that, ability to click next or select different session").
public struct FogSession: Identifiable, Equatable, Sendable {
    /// Where a session stands, which is where the switcher lists it: the menu bar menu's two groups, then the rest.
    public enum Standing: Int, Sendable {
        case ready, working, other

        var title: String {
            switch self {
            case .ready: "Ready for you"
            case .working: "Working"
            case .other: "Other sessions"
            }
        }

        /// What VoiceOver says of a row after its name, as its mark says it to the eye; the rest say nothing.
        var spoken: String {
            switch self {
            case .ready: "Ready"
            case .working: "Working"
            case .other: ""
            }
        }
    }

    public let id: String
    public let label: String
    /// Who does the work, by name: "Claude" or "Codex".
    public let agent: String
    /// The agent's mark, an image asset in the host's own bundle (the Mac app's AgentClaude and AgentCodex); nil draws
    /// the name instead.
    public let mark: String?
    /// What the panel is on for this session, as one line; nil says nothing about an item.
    public let item: String?
    public let standing: Standing

    public init(id: String, label: String, agent: String, mark: String? = nil, item: String? = nil, standing: Standing = .other) {
        self.id = id
        self.label = label
        self.agent = agent
        self.mark = mark
        let item = item?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.item = item.isEmpty ? nil : item
        self.standing = standing
    }

    /// This session naming another item, or none.
    public func with(item: String?) -> FogSession {
        FogSession(id: id, label: label, agent: agent, mark: mark, item: item, standing: standing)
    }

    /// The switcher's keyboard selection moved `by` rows from `current`, stopping at either end rather than wrapping (the
    /// lab's clamp). None yet, or one no longer listed, starts from the first.
    public static func selection(after current: String?, in sessions: [FogSession], by step: Int) -> String? {
        guard !sessions.isEmpty else { return nil }
        guard let index = sessions.firstIndex(where: { $0.id == current }) else { return sessions[0].id }
        return sessions[min(max(index + step, 0), sessions.count - 1)].id
    }

    /// A standing's mark in the switcher, the menu bar menu's own (`StatusMenu.Dot`): a filled dot for ready and for
    /// working. Working was a ring, which the sidebar now draws for a paused sub-agent.
    static func markSymbol(_ standing: Standing) -> String {
        switch standing {
        case .ready: StatusMenu.Dot.ready.symbol
        // The rest draw it clear (`markColor`), so the names stay in line.
        case .working, .other: StatusMenu.Dot.working.symbol
        }
    }

    /// The colour of a standing's mark in the switcher: ready's green, working's blue. The rest draw no mark.
    static func markColor(_ standing: Standing) -> ConchColorToken {
        switch standing {
        case .ready: ConchColor.ready
        case .working: ConchColor.active
        case .other: ConchColor.overlayTextSecondary
        }
    }

    /// Ready for you first, then working, then the rest, each group in the order the daemon sent it.
    public static func ordered(_ sessions: [FogSession]) -> [FogSession] {
        sessions.enumerated()
            .sorted { ($0.element.standing.rawValue, $0.offset) < ($1.element.standing.rawValue, $1.offset) }
            .map(\.element)
    }
}

/// A deliverable the conversation panel shows inside itself, full screen (`ReviewScene.panelShowsContent`): the host's own
/// renderer, keyed by the deliverable's version so another one crossfades in rather than cutting.
public struct FogContent {
    public let id: String
    let view: AnyView

    public init<Content: View>(id: String, @ViewBuilder view: () -> Content) {
        self.id = id
        self.view = AnyView(view())
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
/// bottom. Its two other edges are free: where it fades. Screen coordinates, y up.
public extension EdgeInsets {
    /// These insets with `amount` taken off each side, never below zero: the screen's edges are that much further from a
    /// panel that floats in from them.
    func less(_ amount: CGFloat) -> EdgeInsets {
        less(EdgeInsets(top: amount, leading: amount, bottom: amount, trailing: amount))
    }

    /// These insets with each of `other`'s sides taken off its own, never below zero: the screen's edges as seen from a
    /// glass that sits `other` in from its window.
    func less(_ other: EdgeInsets) -> EdgeInsets {
        EdgeInsets(top: max(0, top - other.top), leading: max(0, leading - other.leading), bottom: max(0, bottom - other.bottom), trailing: max(0, trailing - other.trailing))
    }
}

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
        FogCorner(
            leading: center.x + ConchMotion.projectedDistance(velocity.dx) < screen.midX,
            bottom: center.y + ConchMotion.projectedDistance(velocity.dy) < screen.midY
        )
    }

    /// Biggest: the screen itself. The lab capped this at 1280 by 900 — its own viewport's convention, not a rule about
    /// the panel — which stopped a 1117 pt screen 217 pt short of full height (Tyler: "can we make it so that I can have
    /// the panel fill the pt height and go to the edges like a normal window?").
    public static func maxSize(in screen: CGRect) -> CGSize {
        CGSize(width: screen.width, height: screen.height)
    }

    /// Smallest: 480 by 360, never more than the biggest.
    public static func minSize(in screen: CGRect) -> CGSize {
        let most = maxSize(in: screen)
        return CGSize(width: min(480, most.width), height: min(360, most.height))
    }

    /// A press at `point` (from the fog's corner) resizes it: a deep band along every edge, words and all
    /// (Tyler: "grabbing onto text area should still allow resize"). Only the middle moves it.
    public static func resizes(at point: CGPoint, in size: CGSize) -> Bool {
        let band = max(120, min(size.width, size.height) / 5)
        return point.x < band || point.x > size.width - band || point.y < band || point.y > size.height - band
    }

    /// UIScrollView's rubber band: past `lo` or `hi`, `value` gives less the further it goes, never more than 200 pt.
    public static func rubberBand(_ value: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat {
        let give = { (x: CGFloat) in (1 - 1 / (x * 0.55 / 200 + 1)) * 200 }
        return value < lo ? lo - give(lo - value) : value > hi ? hi + give(value - hi) : value
    }

    /// `start` resized by a drag of `delta` from `corner`, both ways at once: away from the corner grows, toward it
    /// shrinks (Tyler: "i shouldn't get locked into resizing vertically or horizontally"). Past its limits it rubber-bands.
    public static func resized(_ start: CGSize, corner: FogCorner, by delta: CGVector, in screen: CGRect) -> CGSize {
        let least = minSize(in: screen), most = maxSize(in: screen)
        return CGSize(
            width: rubberBand(start.width + (corner.leading ? delta.dx : -delta.dx), least.width, most.width),
            height: rubberBand(start.height + (corner.bottom ? delta.dy : -delta.dy), least.height, most.height)
        )
    }
}

/// The fog's motion, the overlay lab's (~/Projects/conch-design/overlay-lab.html), stepped by hand at display rate.
/// Pressed near an edge it resizes from its docked corner, which never moves; pressed in the middle it follows the
/// pointer, and let go it flies into the corner its momentum picks. Screen coordinates, y up.
public struct FogMotion {
    public private(set) var corner: FogCorner
    public private(set) var size: CGSize
    public private(set) var origin: CGPoint
    /// The screen it docks in.
    public private(set) var screen: CGRect
    /// 0 docked to 1 dragged or mid-air: how far into the flight's scale, blur and fade it is.
    public private(set) var flying: CGFloat = 0
    /// 0 docked to 1 dragged by its middle or in flight: how far its look has let go of its corner for the edges it is
    /// near (`magnet`).
    public private(set) var free: CGFloat = 0
    /// Springs without overshoot.
    public var reduceMotion = false

    private var flyingVelocity: CGFloat = 0
    private var freeVelocity: CGFloat = 0
    private var flight: Flight?
    private var sizeTarget: CGSize?
    private var sizeVelocity = CGVector.zero
    private var gesture: Gesture?

    private struct Gesture {
        let mouse: CGPoint
        let origin: CGPoint
        let size: CGSize
        let resizes: Bool
        var samples: [(time: TimeInterval, point: CGPoint)]
    }

    public init(size: CGSize, corner: FogCorner, in screen: CGRect) {
        self.size = size
        self.corner = corner
        self.screen = screen
        origin = .zero
        dock(corner, in: screen)
    }

    public var frame: CGRect { CGRect(origin: origin, size: size) }
    public var isGesturing: Bool { gesture != nil }
    public var isResizing: Bool { gesture?.resizes == true }
    /// Off its corner: dragged by its middle or in flight.
    public var isMoving: Bool { gesture?.resizes == false || flight != nil }
    public var isSettled: Bool { gesture == nil && flight == nil && sizeTarget == nil && flying == 0 && free == 0 }

    /// How far each side is from its screen's edge, negative past it.
    public var gaps: EdgeInsets {
        EdgeInsets(top: screen.maxY - frame.maxY, leading: frame.minX - screen.minX, bottom: frame.minY - screen.minY, trailing: screen.maxX - frame.maxX)
    }

    /// How hard each screen edge pulls the look toward it, 0 to 1: the lab's magnet, strength 1 over 160 pt. Docked, its
    /// corner's two edges pull fully; moving, every edge it comes within 160 pt of, eased in as it lets go of its corner.
    public var magnet: EdgeInsets {
        func near(_ gap: CGFloat) -> CGFloat {
            let t = 1 - min(max(gap / 160, 0), 1)
            return t * t * (3 - 2 * t)
        }
        let gaps = self.gaps, top = near(gaps.top), leading = near(gaps.leading), bottom = near(gaps.bottom), trailing = near(gaps.trailing)
        let across = max(1, leading + trailing), up = max(1, top + bottom)
        func pull(_ anchored: Bool, _ measured: CGFloat) -> CGFloat { (anchored ? 1 : 0) * (1 - free) + measured * free }
        return EdgeInsets(
            top: pull(!corner.bottom, top / up),
            leading: pull(corner.leading, leading / across),
            bottom: pull(corner.bottom, bottom / up),
            trailing: pull(!corner.leading, trailing / across)
        )
    }

    /// Where a press at `point` would resize rather than move. Grabbed mid-flight it always moves.
    public func resizes(at point: CGPoint) -> Bool {
        flight == nil && FogDock.resizes(at: CGPoint(x: point.x - origin.x, y: point.y - origin.y), in: size)
    }

    /// Docked in `corner` of `screen` at once, within its size limits, ending whatever it was doing.
    public mutating func dock(_ corner: FogCorner, in screen: CGRect) {
        self.corner = corner
        fit(screen)
        gesture = nil
        flight = nil
        sizeTarget = nil
        sizeVelocity = .zero
        flying = 0
        flyingVelocity = 0
        free = 0
        freeVelocity = 0
        origin = docked
    }

    public mutating func press(at point: CGPoint, time: TimeInterval) {
        let resizes = resizes(at: point)
        gesture = Gesture(mouse: point, origin: origin, size: size, resizes: resizes, samples: [(time, point)])
        // Grabbed mid-flight, it stops where it is.
        flight = nil
        if resizes {
            sizeTarget = nil
            sizeVelocity = .zero
        }
    }

    public mutating func drag(to point: CGPoint, time: TimeInterval) {
        guard var gesture else { return }
        gesture.samples.append((time, point))
        while gesture.samples.count > 2, time - gesture.samples[0].time > 0.12 { gesture.samples.removeFirst() }
        self.gesture = gesture
        let delta = CGVector(dx: point.x - gesture.mouse.x, dy: point.y - gesture.mouse.y)
        if gesture.resizes {
            size = FogDock.resized(gesture.size, corner: corner, by: delta, in: screen)
            origin = docked
        } else {
            origin = CGPoint(x: gesture.origin.x + delta.dx, y: gesture.origin.y + delta.dy)
        }
    }

    /// Let go at `time` over `screen`. A resize springs back inside its limits; a move flies into the corner its
    /// momentum picks on `screen`, with no momentum if `cancelled` or the pointer rested first.
    public mutating func release(at time: TimeInterval, in screen: CGRect, cancelled: Bool = false) {
        guard let gesture else { return }
        self.gesture = nil
        if gesture.resizes {
            let least = FogDock.minSize(in: self.screen), most = FogDock.maxSize(in: self.screen)
            sizeTarget = CGSize(width: min(max(size.width, least.width), most.width), height: min(max(size.height, least.height), most.height))
            return
        }
        // Velocity over the last 80 ms; a pause of more than 50 ms before letting go throws nothing.
        var velocity = CGVector.zero
        if !cancelled, let last = gesture.samples.last, time - last.time <= 0.05,
           let first = gesture.samples.first(where: { last.time - $0.time <= 0.08 }), last.time - first.time > 0.004 {
            let seconds = last.time - first.time
            velocity = CGVector(dx: (last.point.x - first.point.x) / seconds, dy: (last.point.y - first.point.y) / seconds)
        }
        let speed = hypot(velocity.dx, velocity.dy)
        if speed > 6000 { velocity = CGVector(dx: velocity.dx * 6000 / speed, dy: velocity.dy * 6000 / speed) }
        fit(screen)
        corner = FogDock.corner(releasedAt: CGPoint(x: frame.midX, y: frame.midY), velocity: velocity, in: screen)
        flight = Flight(from: origin, velocity: velocity, motion: self)
    }

    /// One display frame of `dt` seconds.
    public mutating func step(dt: Double) {
        let spring = ConchMotion.dock.resolved(reduceMotion: reduceMotion)
        if gesture == nil, var flight {
            let done = flight.step(&origin, motion: self, spring: spring, dt: dt)
            self.flight = done ? nil : flight
            if done { origin = docked }
        }
        if gesture == nil, let target = sizeTarget {
            let width = spring.step(&size.width, velocity: &sizeVelocity.dx, to: target.width, dt: dt, epsilon: 0.25)
            let height = spring.step(&size.height, velocity: &sizeVelocity.dy, to: target.height, dt: dt, epsilon: 0.25)
            if width && height {
                size = target
                sizeVelocity = .zero
                sizeTarget = nil
            }
            // Anchored in its corner; a throw in flight keeps flying.
            if flight == nil { origin = docked }
        }
        let goal: CGFloat = gesture.map { $0.resizes ? 0 : 1 } ?? (flight == nil ? 0 : min(1, hypot(docked.x - origin.x, docked.y - origin.y) / 90))
        if ConchMotion.liftOff.step(&flying, velocity: &flyingVelocity, to: goal, dt: dt) {
            flying = goal
            flyingVelocity = 0
        }
        if ConchMotion.liftOff.step(&free, velocity: &freeVelocity, to: isMoving ? 1 : 0, dt: dt) {
            free = isMoving ? 1 : 0
            freeVelocity = 0
        }
    }

    /// Its origin docked in its corner.
    var docked: CGPoint {
        CGPoint(x: corner.leading ? screen.minX : screen.maxX - size.width, y: corner.bottom ? screen.minY : screen.maxY - size.height)
    }

    /// The origins that keep it on the screen.
    var bounds: (lo: CGPoint, hi: CGPoint) {
        (CGPoint(x: screen.minX, y: screen.minY), CGPoint(x: screen.maxX - size.width, y: screen.maxY - size.height))
    }

    private mutating func fit(_ screen: CGRect) {
        self.screen = screen
        let least = FogDock.minSize(in: screen), most = FogDock.maxSize(in: screen)
        size = CGSize(width: min(max(size.width, least.width), most.width), height: min(max(size.height, least.height), most.height))
    }

    /// A throw flies on ONE spring, along the straight line from where it was let go to its corner, so both axes arrive
    /// together. (Two per-axis springs let the axis with most of the throw land first and park on a side while the other
    /// was still travelling.) Its sideways momentum becomes a small curve on a quicker spring, capped so it can't reach a
    /// screen side. Past a screen edge it rubber-bands.
    private struct Flight {
        let start: CGPoint
        var along: CGFloat = 0
        var alongVelocity: CGFloat
        var across: CGFloat = 0
        var acrossVelocity: CGFloat
        var inside: (x: Bool, y: Bool)

        init(from start: CGPoint, velocity: CGVector, motion: FogMotion) {
            self.start = start
            let (lo, hi) = motion.bounds
            let (ux, uy) = Self.path(from: start, to: motion.docked)
            // How far every point can go along (cx, cy) and stay on the screen; 0 if any is already off it.
            func room(_ points: [CGPoint], _ cx: CGFloat, _ cy: CGFloat) -> CGFloat {
                var r = CGFloat.greatestFiniteMagnitude
                for q in points {
                    if cx > 1e-6 { r = min(r, (hi.x - q.x) / cx) }
                    if cx < -1e-6 { r = min(r, (q.x - lo.x) / -cx) }
                    if cy > 1e-6 { r = min(r, (hi.y - q.y) / cy) }
                    if cy < -1e-6 { r = min(r, (q.y - lo.y) / -cy) }
                }
                return max(0, r)
            }
            // A critically damped spring let go at v travels at most v / (ωe).
            let response = ConchMotion.dock.response
            let wA = 2 * .pi / response, wB = 2 * .pi / (response * 0.6), e = CGFloat(M_E)
            var va = velocity.dx * ux + velocity.dy * uy
            var vb = velocity.dy * ux - velocity.dx * uy
            if va < 0 { va = -min(-va, 0.6 * wA * e * room([start], -ux, -uy)) }
            // Sliding along an edge it shares with its corner: no arc off it.
            let onX = motion.corner.leading ? start.x <= lo.x + 1 : start.x >= hi.x - 1
            let onY = motion.corner.bottom ? start.y <= lo.y + 1 : start.y >= hi.y - 1
            if onX || onY { vb = 0 }
            let side: CGFloat = vb < 0 ? -1 : 1
            vb = side * min(abs(vb), wB * e * min(48, room([start, motion.docked], -uy * side, ux * side)))
            alongVelocity = va
            acrossVelocity = vb
            inside = (start.x >= lo.x && start.x <= hi.x, start.y >= lo.y && start.y <= hi.y)
        }

        static func path(from start: CGPoint, to end: CGPoint) -> (CGFloat, CGFloat) {
            let dx = end.x - start.x, dy = end.y - start.y, length = hypot(dx, dy)
            return length > 0.5 ? (dx / length, dy / length) : (1, 0)
        }

        /// Re-aimed every frame, since its size and screen can change mid-flight. True once it has landed.
        mutating func step(_ origin: inout CGPoint, motion: FogMotion, spring: ConchSpring, dt: Double) -> Bool {
            let target = motion.docked, (lo, hi) = motion.bounds
            let (ux, uy) = Self.path(from: start, to: target)
            let a = spring.step(&along, velocity: &alongVelocity, to: hypot(target.x - start.x, target.y - start.y), dt: dt, epsilon: 0.25)
            let b = ConchSpring(bounce: 0, response: spring.response * 0.6).step(&across, velocity: &acrossVelocity, to: 0, dt: dt, epsilon: 0.25)
            let x = start.x + ux * along - uy * across, y = start.y + uy * along + ux * across
            // Rubber-banded past a screen edge once it has been inside, so a release half off the screen glides in.
            inside = (inside.x || (x >= lo.x && x <= hi.x), inside.y || (y >= lo.y && y <= hi.y))
            origin = CGPoint(x: inside.x ? FogDock.rubberBand(x, lo.x, hi.x) : x, y: inside.y ? FogDock.rubberBand(y, lo.y, hi.y) : y)
            return a && b
        }
    }
}

/// The frames of the fog's own controls, its buttons and its reply line, in the `space` coordinate space. A host that
/// drags the fog by hand leaves a press there to them.
public struct FogControls: PreferenceKey {
    public static let space = "conch.fog"
    public static let defaultValue: [CGRect] = []
    public static func reduce(value: inout [CGRect], nextValue: () -> [CGRect]) { value += nextValue() }
}

extension View {
    /// This view's frame is one of the fog's controls (`FogControls`).
    func fogControl() -> some View {
        background(GeometryReader { Color.clear.preference(key: FogControls.self, value: [$0.frame(in: .named(FogControls.space))]) })
    }
}

/// The conversation as a soft fog rather than a pane (M3): no edge, just a quieter patch of screen with the words in it,
/// as the overlay lab has them (~/Projects/conch-design/overlay-lab.html). The newest reply is large and its words come
/// in one by one (`WordReveal`); the transcript scrolls under the reader's wheel and otherwise follows the newest line
/// (`FogScroll`), fading out toward its far end; and the reply line grows under it (`FogReply`). Hanging from a top corner
/// it all runs top-down, the newest nearest the top. The glass is the host's (`ConchGlassPanel` on the Mac, under the
/// words as a sibling); this draws the words, and the panel's buttons, whose fills come in on hover.
public struct ConversationFog: View {
    let turns: [ConversationTurn]
    @Binding var draft: String
    /// The words as they move: the scroll, the reveal, the reply line's growth and a sent message's flight.
    @ObservedObject var text: FogTextState
    let isListening: Bool
    /// The session is working: after your message, "Thinking" shows until its reply comes.
    let isWorking: Bool
    let isFullScreen: Bool
    /// The screen corner the fog is docked in: it gathers there, and the words keep to that side.
    let corner: FogCorner
    /// Where the Dock and the menu bar overlap the fog, so the words stay clear of them.
    let insets: EdgeInsets
    /// The look under the words: they fade where its blur does, and off a corner its magnet moves them.
    let look: FogLook?
    /// Draws the collapse and full-screen buttons; a host that layers its own controls over the fog draws them itself.
    let showsButtons: Bool
    /// Off its corner, dragged or in flight: the buttons hide.
    let floating: Bool
    /// The pointer is over the fog: the buttons' fills show.
    let hovering: Bool
    /// The session the words are from, named beside the buttons (`FogHeader`); nil names none.
    let session: FogSession?
    /// What the switcher lists, in its order (`FogSession.ordered`).
    let sessions: [FogSession]
    /// The switcher is open. The host's, so a press anywhere else on the fog can close it.
    @Binding var isSwitching: Bool
    /// The row the keyboard has picked out in the open switcher (↑ and ↓), the host's since it has the keys.
    let switcherSelection: String?
    /// The reply line; off, the transcript takes its room (the menu bar's Show Reply Line).
    let showsReply: Bool
    /// Full screen, the deliverable the panel is on, under the button row in place of the words; the reply line floats at
    /// its foot. Docked, the words as ever.
    let content: FogContent?
    /// Under the reply line: why the last reply didn't go, in the sentence the store has for it (`ConchSendFailure`).
    let notice: String?
    /// With no session to show, what to say instead of the words: "No sessions yet", or that conch isn't running.
    let empty: String?
    /// The session the voice is reading aloud, when it isn't this one: named beside the header, a click away.
    let speaking: FogSession?
    let onPick: (String) -> Void
    /// Back and on through what is ready; nil leaves the button out.
    let onPrevious: (() -> Void)?
    let onNext: (() -> Void)?
    let onMic: () -> Void
    let onSend: () -> Void
    /// Esc in the reply line, once it has left the field: the host hands the keys back.
    let onLeaveReply: (() -> Void)?
    let onCollapse: () -> Void
    let onFullScreen: () -> Void
    /// The canvas's pen; nil leaves the button out.
    let onCanvas: (() -> Void)?
    let isCanvasOn: Bool
    @Environment(\.conchRendersStatically) private var rendersStatically
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The notice's height as laid out, so the transcript gives it room.
    @State private var noticeHeight: CGFloat = 0
    /// Full screen on a deliverable, the newest reply opened whole rather than its one line.
    @State private var newestOpen = false

    public init(
        turns: [ConversationTurn],
        draft: Binding<String>,
        text: FogTextState,
        isListening: Bool,
        isWorking: Bool = false,
        isFullScreen: Bool,
        corner: FogCorner = .bottomLeading,
        insets: EdgeInsets = EdgeInsets(),
        look: FogLook? = nil,
        showsButtons: Bool = true,
        floating: Bool = false,
        hovering: Bool = true,
        session: FogSession? = nil,
        sessions: [FogSession] = [],
        isSwitching: Binding<Bool> = .constant(false),
        switcherSelection: String? = nil,
        showsReply: Bool = true,
        content: FogContent? = nil,
        notice: String? = nil,
        empty: String? = nil,
        speaking: FogSession? = nil,
        onPick: @escaping (String) -> Void = { _ in },
        onPrevious: (() -> Void)? = nil,
        onNext: (() -> Void)? = nil,
        onMic: @escaping () -> Void,
        onSend: @escaping () -> Void,
        onLeaveReply: (() -> Void)? = nil,
        onCollapse: @escaping () -> Void,
        onFullScreen: @escaping () -> Void,
        onCanvas: (() -> Void)? = nil,
        isCanvasOn: Bool = false
    ) {
        self.turns = turns
        _draft = draft
        _text = ObservedObject(wrappedValue: text)
        self.isListening = isListening
        self.isWorking = isWorking
        self.isFullScreen = isFullScreen
        self.corner = corner
        self.insets = insets
        self.look = look
        self.showsButtons = showsButtons
        self.floating = floating
        self.hovering = hovering
        self.session = session
        self.sessions = sessions
        _isSwitching = isSwitching
        self.switcherSelection = switcherSelection
        self.showsReply = showsReply
        self.content = content
        self.notice = notice
        self.empty = empty
        self.speaking = speaking
        self.onPick = onPick
        self.onPrevious = onPrevious
        self.onNext = onNext
        self.onMic = onMic
        self.onSend = onSend
        self.onLeaveReply = onLeaveReply
        self.onCollapse = onCollapse
        self.onFullScreen = onFullScreen
        self.onCanvas = onCanvas
        self.isCanvasOn = isCanvasOn
    }

    /// Inside the fog, before the screen's own insets.
    public static let padding: CGFloat = ConchSpace.x6
    static let buttonSize: CGFloat = 36
    /// From a screen side the words are docked against to their column: the buttons' own 24, so the buttons, the mic and
    /// the words share one left edge. The lab's 52 set the words 28 pt in from the buttons under them.
    static let side: CGFloat = padding
    /// The mic and the gap after it, before the reply's words.
    public static let micSpace: CGFloat = 40 + ConchSpace.x3
    /// ponytail: the daemon sends 40 turns at most; a runaway list shows its newest 200 rather than laying out thousands.
    static let turnsShown = 200
    /// A past turn against the newest: 70% of the words' ink, which holds 4.5:1 on the glass at its worst. Half, as the
    /// lab had it, measured 2.3 to 3.0 over a real screen.
    public static let pastOpacity: Double = 0.7
    /// Full screen on a deliverable, the newest reply's one line above the floating reply, and the gap under it.
    static let newestLineHeight: CGFloat = 34
    static let newestLineGap: CGFloat = ConchSpace.x2

    /// The reply line's type size: the conversation's newest, `ConchType.conversationNow` (24) or, full screen, 36.
    public static func replyFontSize(fullScreen: Bool) -> CGFloat { fullScreen ? 36 : 24 }

    /// What the empty reply line says: whom a reply goes to.
    public static func placeholder(for session: FogSession?) -> String {
        session.map { "Reply to \($0.label)" } ?? "Reply"
    }

    /// Where the words and the reply line sit: a column up to 620 pt wide, clear of the fog's padding, the
    /// screen's insets and the button row. Docked it keeps to its corner's side; off its corner `magnet` pulls it toward the
    /// screen edges it nears and centres it between them. Full screen, a wider column in the middle.
    public static func textFrame(in size: CGSize, corner: FogCorner, insets: EdgeInsets, fullScreen: Bool, magnet: EdgeInsets? = nil) -> CGRect {
        // The button row is on the docked side: above the words when the fog hangs from the top, below the reply
        // when it sits on the bottom.
        let row = buttonSize + ConchSpace.x3
        let atBottom = buttonsAtBottom(corner: corner, fullScreen: fullScreen)
        let top = insets.top + padding + (atBottom ? 0 : row)
        // Below the words: the Dock's inset, or on the bottom the button row in the corner, whichever is taller.
        let bottom = atBottom ? max(insets.bottom, row) + padding : insets.bottom + padding
        let height = max(0, size.height - top - bottom)
        if fullScreen {
            let leading = insets.leading + padding, room = max(0, size.width - leading - insets.trailing - padding)
            let width = min(1040, room)
            return CGRect(x: leading + (room - width) / 2, y: top, width: width, height: height)
        }
        let leading = insets.leading + side, trailing = insets.trailing + side
        // 620 at the sizes the panel is usually at, growing toward full screen's own 1040 measure as it is dragged
        // wider. The lab's 540 left 312 pt of a 900 pt panel empty; a fixed 620 left a RIBBON of text against one edge
        // of a nearly full-screen sheet of glass, most of it blurred nothing (Tyler, expanding it: "pretty silly when
        // i expand the convo panel").
        //
        // 60% of the room rather than simply following it, because `pull` below slides the column between its docked
        // side and the centre by (room - width): a column that fills its fog has nowhere to travel and the magnet dies
        // outright. At 60% the default 900 pt panel is unchanged at 620, and a panel past about 1185 pt earns a wider
        // column instead of a wider margin.
        let room = max(0, size.width - leading - trailing)
        let measure = min(1040, max(620, room * 0.6))
        let width = min(measure, room)
        let pull = magnet ?? EdgeInsets(top: corner.bottom ? 0 : 1, leading: corner.leading ? 1 : 0, bottom: corner.bottom ? 1 : 0, trailing: corner.leading ? 0 : 1)
        let midX = (size.width - width) / 2, midY = (size.height - height) / 2
        return CGRect(
            x: midX + (leading - midX) * pull.leading + (size.width - trailing - width - midX) * pull.trailing,
            y: midY + (top - midY) * min(1, pull.top + pull.bottom),
            width: width,
            height: height
        )
    }

    /// Hanging from a top corner the words run top-down, the newest nearest the top edge, the reply line above them.
    /// Otherwise, and full screen, bottom-up.
    public static func newestAtTop(corner: FogCorner, fullScreen: Bool) -> Bool {
        !corner.bottom && !fullScreen
    }

    /// The collapse and full-screen buttons sit in the fog's docked corner, the nook against the screen's edges, away
    /// from the free corner it is resized by (Tyler: "they're distracting and right where i want to pull to resize").
    /// Full screen, top left.
    public static func buttonsAtBottom(corner: FogCorner, fullScreen: Bool) -> Bool {
        corner.bottom && !fullScreen
    }

    public static func buttonsY(in size: CGSize, corner: FogCorner, insets: EdgeInsets, fullScreen: Bool) -> CGFloat {
        buttonsAtBottom(corner: corner, fullScreen: fullScreen) ? size.height - insets.bottom - padding - buttonSize : insets.top + padding
    }

    /// The buttons go into the corner proper. The Dock doesn't run edge to edge, so its inset doesn't reach a corner;
    /// only the menu bar, which does, keeps them clear.
    public static func buttonInsets(_ insets: EdgeInsets) -> EdgeInsets {
        EdgeInsets(top: insets.top, leading: 0, bottom: 0, trailing: 0)
    }

    public static func buttonsAlignment(corner: FogCorner, fullScreen: Bool) -> Alignment {
        fullScreen || corner.leading ? .leading : .trailing
    }

    /// Full screen on a deliverable, the reply line is a capsule centred at the panel's foot, this wide (panel-lab's
    /// `min(640px, 100% - 48px)`), its line this far inside its edge.
    public static func floatingReplyWidth(in size: CGSize) -> CGFloat { min(640, max(0, size.width - 48)) }
    static let floatingReplyPadding: CGFloat = ConchSpace.x2

    /// Full screen on a deliverable, where it sits: under the button row, as wide as the row runs, down to a one-line
    /// reply capsule and the gap above it, or with the reply line off to the foot; and above the newest reply's line when
    /// there is one (`showsNewest`). A reply that grows past one line floats up over it.
    public static func contentFrame(in size: CGSize, insets: EdgeInsets, showsReply: Bool, showsNewest: Bool = false) -> CGRect {
        let top = buttonsY(in: size, corner: .topLeading, insets: buttonInsets(insets), fullScreen: true) + buttonSize + ConchSpace.x3
        let fontSize = replyFontSize(fullScreen: false)
        let reply = showsReply ? FogReply.lineHeight(fontSize) + 2 * FogReply.padding(fontSize) + 2 * floatingReplyPadding + FogReply.gap : 0
        let newest = showsNewest ? newestLineHeight + newestLineGap + (showsReply ? 0 : FogReply.gap) : 0
        let leading = insets.leading + padding
        return CGRect(
            x: leading,
            y: top,
            width: max(0, size.width - leading - insets.trailing - padding),
            height: max(0, size.height - insets.bottom - padding - reply - newest - top)
        )
    }

    public var body: some View {
        GeometryReader { proxy in
            let frame = Self.textFrame(in: proxy.size, corner: corner, insets: insets, fullScreen: isFullScreen, magnet: look?.magnet)
            let top = Self.newestAtTop(corner: corner, fullScreen: isFullScreen)
            // Full screen on a deliverable the panel shows itself: it takes the words' room, and the reply line keeps the
            // docked panel's size in a capsule at the foot.
            let shown = isFullScreen ? content : nil
            let fontSize = Self.replyFontSize(fullScreen: isFullScreen && shown == nil)
            let lineWidth = shown == nil ? frame.width : Self.floatingReplyWidth(in: proxy.size) - 2 * Self.floatingReplyPadding
            // The notice under the reply line takes its room from the transcript, never from the reply.
            let noticeRoom = notice == nil || !showsReply ? 0 : noticeHeight + ConchSpace.x1
            let target = text.replyTarget(for: draft, width: max(0, lineWidth - Self.micSpace), fontSize: fontSize, in: frame.height - noticeRoom)
            let reply = rendersStatically ? target : text.replyHeight
            let overflows = CGFloat(text.replyLines) * FogReply.lineHeight(fontSize) + 2 * FogReply.padding(fontSize) > target + 0.5
            let box = showsReply ? max(0, frame.height - FogReply.gap - reply - noticeRoom) : frame.height
            // With the words stepped aside for a deliverable, the newest reply still shows, as one line.
            let newest = shown == nil ? nil : turns.last { !$0.fromYou }
            ZStack(alignment: .topLeading) {
                if shown == nil {
                    if session == nil, turns.isEmpty, let empty {
                        emptyState(empty, in: frame)
                    } else {
                        VStack(alignment: .leading, spacing: FogReply.gap) {
                            if top {
                                if showsReply { replyLine(fontSize: fontSize, height: reply, top: true, overflows: overflows) }
                                words(width: frame.width, height: box, top: true, fontSize: fontSize)
                            } else {
                                words(width: frame.width, height: box, top: false, fontSize: fontSize)
                                if showsReply { replyLine(fontSize: fontSize, height: reply, top: false, overflows: overflows) }
                            }
                        }
                        .frame(width: frame.width, height: frame.height, alignment: .topLeading)
                        // The oldest words fade out at the panel's far end rather than ending in a cut — panel.html's
                        // `.body{-webkit-mask-image:linear-gradient(transparent 0,#000 26%)}`. The newest end never fades, so
                        // the gradient runs from whichever end holds the oldest (`newestAtTop`).
                        .mask(alignment: .topLeading) {
                            LinearGradient(
                                stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.26)],
                                startPoint: top ? .bottom : .top,
                                endPoint: top ? .top : .bottom
                            )
                        }
                        .offset(x: frame.minX, y: frame.minY)
                    }
                }
                deliverable(shown, frame: Self.contentFrame(in: proxy.size, insets: insets, showsReply: showsReply, showsNewest: newest != nil))
                if let newest {
                    let foot = proxy.size.height - insets.bottom - Self.padding - (showsReply ? reply + noticeRoom + 2 * Self.floatingReplyPadding + Self.newestLineGap : 0)
                    newestLine(newest, width: Self.floatingReplyWidth(in: proxy.size), room: proxy.size.height * 0.4)
                        .frame(width: proxy.size.width, height: max(0, foot), alignment: .bottom)
                }
                if shown != nil, showsReply { floatingReply(in: proxy.size, fontSize: fontSize, height: reply, overflows: overflows) }
                if showsButtons {
                    let buttons = Self.buttonInsets(insets)
                    let alignment = Self.buttonsAlignment(corner: corner, fullScreen: isFullScreen)
                    let y = Self.buttonsY(in: proxy.size, corner: corner, insets: buttons, fullScreen: isFullScreen)
                    // The session is named beside the buttons, on their free side: the buttons keep the nook. Its item only
                    // full screen on a deliverable, where the words are hidden; anywhere else the newest reply says it.
                    HStack(spacing: ConchSpace.x3) {
                        if alignment != .leading {
                            speakingChip
                            header(showsItem: shown != nil)
                        }
                        FogPanelButtons(corner: corner, isFullScreen: isFullScreen, onCollapse: onCollapse, onFullScreen: onFullScreen, onPrevious: onPrevious, onNext: onNext, onCanvas: onCanvas, isCanvasOn: isCanvasOn)
                            .fogControl()
                        if alignment == .leading {
                            header(showsItem: shown != nil)
                            speakingChip
                        }
                    }
                    .frame(width: max(0, proxy.size.width - buttons.leading - buttons.trailing - 2 * Self.padding), alignment: alignment)
                    .offset(x: buttons.leading + Self.padding, y: y)
                    // With the pointer away only the fills go, never an icon or the name, which keep their contrast on the
                    // glass; and all of it is gone while the panel flies.
                    .environment(\.overlayFills, isFullScreen || hovering ? 1 : 0)
                    .opacity(isFullScreen || !floating ? 1 : 0)
                    .allowsHitTesting(isFullScreen || !floating)
                    .animation(ConchMotion.hover.animation(reduceMotion: reduceMotion), value: hovering)
                    .animation(ConchMotion.liftOff.animation(reduceMotion: reduceMotion), value: floating)
                    switcher(in: proxy.size, y: y, leading: alignment == .leading)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
            .onChange(of: target, initial: true) { _, target in text.grow(to: target) }
            // Another reply is its own line again, folded.
            .onChange(of: newest?.id) { _, _ in newestOpen = false }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Conversation")
    }

    /// The reply line, its height springing (`FogTextState.replyHeight`), and under it why the last reply didn't go; and
    /// while the reader is scrolled away, the pill back to the newest line beside it, on the transcript's side.
    private func replyLine(fontSize: CGFloat, height: CGFloat, top: Bool, overflows: Bool) -> some View {
        VStack(alignment: .leading, spacing: ConchSpace.x1) {
            InlineReplyLine(text: $draft, isListening: isListening, placeholder: Self.placeholder(for: session), fontSize: fontSize, alignsTop: top, overflows: overflows, onMic: onMic, onSend: onSend, onLeave: onLeaveReply)
                .frame(height: height, alignment: top ? .top : .bottom)
                .fogControl()
                .overlay(alignment: top ? .bottomLeading : .topLeading) {
                    if !text.scroll.pinned {
                        pill(top: top)
                            .fogControl()
                            .offset(y: top ? 38 : -38)
                            .transition(reduceMotion ? .opacity : .scale(scale: 0.85, anchor: top ? .top : .bottom).combined(with: .opacity))
                    }
                }
                .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: text.scroll.pinned)
            if let notice { noticeLine(notice) }
        }
    }

    /// Why the last reply didn't go, under the reply line and in line with its words: the store's sentence
    /// (`ConchSendFailure`), which says what to do about it. The words stay in the line to send again.
    private func noticeLine(_ notice: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(ConchColor.attention)
            Text(notice)
                .font(ConchType.secondary)
                .foregroundStyle(ConchColor.overlayText)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, Self.micSpace)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { noticeHeight = $0 }
        .accessibilityElement(children: .combine)
    }

    /// Nothing to show: said quietly where the words would be.
    private func emptyState(_ message: String, in frame: CGRect) -> some View {
        Text(message)
            .font(ConchType.conversationPast)
            .foregroundStyle(ConchColor.overlayTextSecondary)
            .multilineTextAlignment(.center)
            .frame(width: frame.width, height: frame.height)
            .offset(x: frame.minX, y: frame.minY)
    }

    /// Full screen, the deliverable in a rounded card with a hairline under the button row. The next one crossfades in on
    /// `swap`, the old out soft and a touch large, the new in from a touch small and soft; under Reduce Motion they only
    /// fade. The card itself only fades in and out, so arriving with the panel's own reveal it never zooms inside it.
    /// Presses and scrolls on it are its own (`fogControl`), never the transcript's.
    private func deliverable(_ shown: FogContent?, frame: CGRect) -> some View {
        let shape = RoundedRectangle(cornerRadius: ConchRadius.large, style: .continuous)
        let swap: AnyTransition = reduceMotion ? .opacity : .asymmetric(
            insertion: .modifier(active: Swap(scale: ConchMotion.swapScale, blur: ConchMotion.swapBlur, opacity: 0), identity: Swap()),
            removal: .modifier(active: Swap(scale: 2 - ConchMotion.swapScale, blur: ConchMotion.swapBlur, opacity: 0), identity: Swap())
        )
        return ZStack(alignment: .topLeading) {
            if let shown {
                ZStack {
                    shown.view
                        .frame(width: frame.width, height: frame.height)
                        .id(shown.id)
                        .transition(swap)
                }
                .frame(width: frame.width, height: frame.height)
                .background(ConchColor.surface)
                .clipShape(shape)
                .overlay(shape.strokeBorder(ConchColor.overlayLine, lineWidth: 0.5))
                .fogControl()
                .offset(x: frame.minX, y: frame.minY)
                .transition(.opacity)
            }
        }
        .animation(ConchMotion.swap.animation(reduceMotion: reduceMotion), value: shown?.id)
    }

    /// Full screen on a deliverable, the reply line in a capsule centred at the panel's foot (panel-lab's full-screen
    /// `.reply`), in the overlay's glass so the deliverable under it never ghosts through. Past one line it grows up over
    /// the deliverable.
    private func floatingReply(in size: CGSize, fontSize: CGFloat, height: CGFloat, overflows: Bool) -> some View {
        let width = Self.floatingReplyWidth(in: size)
        let shape = RoundedRectangle(cornerRadius: ConchRadius.panel, style: .continuous)
        return VStack(alignment: .leading, spacing: ConchSpace.x1) {
            InlineReplyLine(text: $draft, isListening: isListening, placeholder: Self.placeholder(for: session), fontSize: fontSize, overflows: overflows, onMic: onMic, onSend: onSend, onLeave: onLeaveReply)
                .frame(height: height, alignment: .bottom)
            if let notice { noticeLine(notice) }
        }
        .padding(Self.floatingReplyPadding)
        .frame(width: width)
        .overlayGlass(shape)
        .fogControl()
        .frame(width: size.width, height: max(0, size.height - insets.bottom - Self.padding), alignment: .bottom)
    }

    /// Full screen on a deliverable, where the words have stepped aside: the newest reply's first line, quiet, above the
    /// floating reply, so a reply is never written blind. A click opens it whole over the deliverable, and folds it again.
    private func newestLine(_ turn: ConversationTurn, width: CGFloat, room: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: Self.newestLineHeight / 2, style: .continuous)
        return Button { newestOpen.toggle() } label: {
            HStack(alignment: newestOpen ? .top : .center, spacing: ConchSpace.x2) {
                if newestOpen {
                    ScrollView(.vertical) {
                        Text(Self.inlineMarkdown(turn.text))
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: room)
                    .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(Self.plain(turn.text).replacingOccurrences(of: "\n", with: " "))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Image(systemName: newestOpen ? "chevron.down" : "chevron.up")
                    .font(.system(size: 11, weight: .semibold))
                    .padding(.top, newestOpen ? 4 : 0)
            }
            .font(ConchType.uiBody)
            .foregroundStyle(newestOpen ? ConchColor.overlayText : ConchColor.overlayTextSecondary)
            .padding(.horizontal, 16)
            .padding(.vertical, newestOpen ? 10 : 0)
            .frame(minHeight: Self.newestLineHeight)
            .frame(width: width)
            .overlayGlass(shape)
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .fogControl()
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: newestOpen)
        .accessibilityLabel("Newest reply: \(Self.plain(turn.text))")
        .accessibilityHint(newestOpen ? "Folds it to one line" : "Shows the whole reply")
    }

    /// The transcript, crossing over to another session's rather than cutting to it (panel-lab's crossfade): out soft and
    /// up, in from a little below, a beat behind the header. Reduce Motion keeps the dissolve.
    private func words(width: CGFloat, height: CGFloat, top: Bool, fontSize: CGFloat) -> some View {
        ZStack {
            transcript(width: width, height: height, top: top, fontSize: fontSize)
                .id(session?.id)
                .transition(cross)
        }
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion).delay(ConchMotion.crossStagger), value: session?.id)
    }

    /// panel-lab's crossfade: out soft, up and a touch small; in from a little below. Reduce Motion keeps only the fade.
    private var cross: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(
            insertion: .modifier(active: Swap(scale: ConchMotion.crossScale, blur: ConchMotion.crossBlur, opacity: 0, y: ConchMotion.crossShift), identity: Swap()),
            removal: .modifier(active: Swap(scale: ConchMotion.crossScale, blur: ConchMotion.crossBlur, opacity: 0, y: -ConchMotion.crossShift), identity: Swap())
        )
    }

    /// What the header crosses over on: the session, and the item it names, so a new item in the same session crosses
    /// over too rather than cutting.
    static func crossKey(_ session: FogSession) -> String { "\(session.id)\n\(session.item ?? "")" }

    /// The session the words are from, crossing over with them. A click opens the switcher.
    @ViewBuilder private func header(showsItem: Bool) -> some View {
        if let session {
            let named = showsItem ? session : session.with(item: nil)
            ZStack {
                FogHeader(session: named, isOpen: isSwitching) { isSwitching.toggle() }
                    .id(Self.crossKey(named))
                    .transition(cross)
            }
            .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: Self.crossKey(named))
            .fogControl()
        }
    }

    /// The session the voice is reading aloud, when it isn't this one: "Speaking: Dayloop ›", quiet, a click from it.
    @ViewBuilder private var speakingChip: some View {
        if let speaking, speaking.id != session?.id {
            SpeakingChip(session: speaking) { onPick(speaking.id) }
                .fogControl()
                .transition(.opacity)
        }
    }

    /// The switcher opens from the button row away from the edge the fog is docked on: up from a bottom corner, down from
    /// a top one and full screen, on the button row's side. It pops as panel-lab's does: from a touch small, a little
    /// toward the row and soft, its rows following one another in.
    private func switcher(in size: CGSize, y: CGFloat, leading: Bool) -> some View {
        let up = Self.buttonsAtBottom(corner: corner, fullScreen: isFullScreen)
        let top = up ? 0 : y + Self.buttonSize + ConchSpace.x2
        let room = max(0, up ? y - ConchSpace.x2 : size.height - top - Self.padding)
        let anchor: UnitPoint = up ? (leading ? .bottomLeading : .bottomTrailing) : (leading ? .topLeading : .topTrailing)
        let pop: AnyTransition = reduceMotion ? .opacity : .modifier(
            active: Popped(scale: ConchMotion.popScale, anchor: anchor, y: up ? ConchMotion.popShift : -ConchMotion.popShift, blur: ConchMotion.popBlur, opacity: 0),
            identity: Popped(anchor: anchor)
        )
        return ZStack {
            if isSwitching {
                FogSwitcher(sessions: sessions, current: session?.id, selected: switcherSelection, tallest: room, onPick: onPick)
                    .fogControl()
                    .transition(pop)
            }
        }
        .frame(width: max(0, size.width - 2 * Self.padding), height: room, alignment: Alignment(horizontal: leading ? .leading : .trailing, vertical: up ? .bottom : .top))
        .offset(x: Self.padding, y: top)
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: isSwitching)
    }

    private func pill(top: Bool) -> some View {
        let label = text.scroll.unseen ? "New reply" : "Newest"
        return Button(action: text.toNewest) {
            HStack(spacing: 5) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .bold))
                    .rotationEffect(.degrees(top ? 180 : 0))
                Text(label)
                    .font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(ConchColor.overlayText)
            .padding(.leading, 8)
            .padding(.trailing, 11)
            .frame(height: 28)
            .overlayGlass(Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        // Its name is what it says, so a voice command that reads the screen finds it.
        .accessibilityLabel(label)
        .accessibilityHint("Scrolls to the newest message")
    }

    private enum Line: Identifiable {
        case turn(ConversationTurn)
        case thinking

        var id: String {
            if case let .turn(turn) = self { turn.id } else { "conch.thinking" }
        }

        var fromYou: Bool {
            if case let .turn(turn) = self { turn.fromYou } else { false }
        }
    }

    /// The transcript in its box: scrolled by `FogScroll.offset` from its newest end, which is the bottom (or, hanging from
    /// the top, the top), fading out toward its far end, and toward the near end too while the reader is scrolled away.
    private func transcript(width: CGFloat, height: CGFloat, top: Bool, fontSize: CGFloat) -> some View {
        let shown = turns.suffix(Self.turnsShown)
        let now = shown.last { !$0.fromYou }?.id
        var lines = shown.map { Line.turn($0) }
        if let sent = text.sent { lines.append(.turn(ConversationTurn(id: "conch.sent", fromYou: true, text: sent))) }
        if isWorking, lines.last?.fromYou == true { lines.append(.thinking) }
        let flying = text.flight == nil ? nil : lines.last(where: \.fromYou)?.id
        let pinned = text.scroll.pinned
        return VStack(alignment: .leading, spacing: 14) {
            ForEach(top ? Array(lines.reversed()) : lines) { line in
                switch line {
                case let .turn(turn):
                    // Only the newest reply while its words come in, and a message flying in, change frame to frame.
                    TurnLine(
                        turn: turn,
                        now: turn.id == now,
                        fullScreen: isFullScreen,
                        top: top,
                        fontSize: fontSize,
                        reveal: turn.id == now && text.reveal.id == turn.id && text.reveal.isRevealing(at: text.now) ? text.reveal : nil,
                        clock: turn.id == now ? text.now : 0,
                        flight: turn.id == flying ? text.flight.map { TurnLine.Flight(progress: $0.progress, replyHeight: $0.replyHeight, offset: text.scroll.offset) } : nil
                    )
                    .equatable()
                case .thinking: Thinking()
                }
            }
        }
        .padding(top ? .bottom : .top, 72)
        .frame(width: width, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { text.measured(content: $0) }
        .offset(y: top ? -text.scroll.offset : text.scroll.offset)
        .frame(width: width, height: height, alignment: top ? .top : .bottom)
        .clipped()
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { text.measured(box: $0) }
        .mask {
            VStack(spacing: 0) {
                LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                    .frame(height: min(72, height * 0.4))
                Rectangle()
                LinearGradient(colors: [.black, .black.opacity(0.08)], startPoint: .top, endPoint: .bottom)
                    .frame(height: pinned ? 0 : 56)
                Rectangle().opacity(0.08).frame(height: pinned ? 0 : 16)
            }
            .scaleEffect(y: top ? -1 : 1)
        }
        .animation(ConchMotion.hover.animation(reduceMotion: reduceMotion), value: pinned)
    }

    /// Where each word of `attributed` starts.
    static func wordStarts(_ attributed: AttributedString) -> [AttributedString.Index] {
        var starts: [AttributedString.Index] = [], space = true
        for index in attributed.characters.indices {
            let isSpace = attributed.characters[index].isWhitespace
            if space, !isSpace { starts.append(index) }
            space = isSpace
        }
        return starts
    }

    /// `attributed` as far as `reveal` has come at `now`: whole up to the first word still fading, then each fading word
    /// marked for `WordRevealRenderer`.
    @available(macOS 15, iOS 18, *)
    static func revealed(_ attributed: AttributedString, _ reveal: WordReveal, at now: Double) -> Text {
        let starts = wordStarts(attributed)
        let shown = min(reveal.shown(at: now), starts.count)
        var fading = shown
        while fading > 0, reveal.progress(ofWord: fading - 1, at: now) < 1 { fading -= 1 }
        let solid = fading < starts.count ? starts[fading] : attributed.endIndex
        var text = Text(AttributedString(attributed[attributed.startIndex..<solid]))
        for index in fading..<shown {
            let end = index + 1 < starts.count ? starts[index + 1] : attributed.endIndex
            text = text + Text(AttributedString(attributed[starts[index]..<end])).customAttribute(RevealedWord(index: index))
        }
        return text
    }

    static func font(latest: Bool, fullScreen: Bool) -> Font {
        switch (latest, fullScreen) {
        case (true, false): ConchType.conversationNow
        case (false, false): ConchType.conversationPast
        case (true, true): ConchType.conversationNowFull
        case (false, true): ConchType.conversationPastFull
        }
    }

    /// Agent replies are markdown, and a transcript that shows the source reads worst exactly where it matters most:
    /// `**Storage moved**` with its asterisks and `` `path/to/file` `` with its backticks is most of what a summary is
    /// made of.
    ///
    /// The fog's renderer: one text flow, because the newest reply comes in word by word through `revealed`, which
    /// walks ONE AttributedString, and a past turn must keep the shape it had while it was newest. Documents go through
    /// `MarkdownView` (Markdown.swift) everywhere else; here a table would not fit anyway — 24 pt words in a 620 pt
    /// column hold about 45 characters a line, and one cell of the atlas documents runs to 300 — so a table is read
    /// the way you would read it aloud, and a heading is bold. The frontmatter rule is the shared one.
    public static func inlineMarkdown(_ text: String) -> AttributedString {
        MarkdownDocument.inline(promoteHeadings(flattenTables(MarkdownDocument.stripFrontmatter(text))))
    }

    /// A markdown table as lines a person can read: an inline parse cannot lay one out, so it arrives as a wall of
    /// pipes. Each row becomes "first cell — the rest", which is how you would read it aloud.
    static func flattenTables(_ source: String) -> String {
        guard source.contains("|") else { return source }
        return source
            .split(separator: "\n", omittingEmptySubsequences: false)
            .compactMap { line -> String? in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard trimmed.hasPrefix("|"), trimmed.hasSuffix("|"), trimmed.count > 1 else { return String(line) }
                let cells = trimmed.dropFirst().dropLast()
                    .split(separator: "|", omittingEmptySubsequences: false)
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                // The alignment row carries no content once the grid is gone.
                let isDivider = cells.allSatisfy { cell in !cell.isEmpty && cell.allSatisfy { ":-".contains($0) } }
                if isDivider { return nil }
                let filled = cells.filter { !$0.isEmpty }
                if filled.isEmpty { return nil }
                if filled.count == 1 { return filled[0] }
                return "**\(filled[0])** — \(filled.dropFirst().joined(separator: " · "))"
            }
            .joined(separator: "\n")
    }

    /// `## Heading` keeps its hashes under an inline parse, and agents write in headings constantly. Bold keeps the
    /// emphasis without a block parse, which would collapse every newline.
    static func promoteHeadings(_ source: String) -> String {
        guard source.contains("#") else { return source }
        return source
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                guard line.hasPrefix("#") else { return line }
                let hashes = line.prefix { $0 == "#" }
                guard hashes.count <= 6 else { return line }
                let rest = line.dropFirst(hashes.count).drop { $0 == " " }
                // Bold needs something to wrap, and `**` alone parses as literal.
                guard !rest.isEmpty else { return line }
                return Substring("**\(rest)**")
            }
            .joined(separator: "\n")
    }

    /// The words as the fog shows them, markdown taken out.
    static func plain(_ text: String) -> String {
        String(inlineMarkdown(text).characters)
    }
}

/// A deliverable part way through `ConchMotion.swap`, or the words and header part way through a crossover.
private struct Swap: ViewModifier {
    var scale: CGFloat = 1
    var blur: CGFloat = 0
    var opacity: Double = 1
    var y: CGFloat = 0

    func body(content: Content) -> some View {
        content.scaleEffect(scale).blur(radius: blur).offset(y: y).opacity(opacity)
    }
}

/// A popover part way open (`ConchMotion.pop`): a touch small about the corner it opens from, a little toward it, soft.
private struct Popped: ViewModifier {
    var scale: CGFloat = 1
    var anchor: UnitPoint
    var y: CGFloat = 0
    var blur: CGFloat = 0
    var opacity: Double = 1

    func body(content: Content) -> some View {
        content.scaleEffect(scale, anchor: anchor).offset(y: y).blur(radius: blur).opacity(opacity)
    }
}

extension View {
    /// A small piece of the overlay over whatever is under it — the switcher, the Newest pill, the floating reply, the
    /// collapsed handle: the system blur, the overlay's strong glass and a hairline, raised. The canvas's tool pill is
    /// the same recipe. Without the blur, the words under the switcher read through its rows.
    func overlayGlass<S: InsettableShape>(_ shape: S) -> some View {
        background {
            ZStack {
                shape.fill(.ultraThinMaterial)
                shape.fill(ConchColor.overlayGlassStrong)
                shape.strokeBorder(ConchColor.overlayLine, lineWidth: 0.5)
            }
            .conchElevation(.floating)
        }
    }
}

/// One turn: yours small under "You", replies small but for the newest, which is large and comes in word by word. A
/// message you just sent flies in from the reply line: from its place, size and a little blur, on one spring. Equatable, so
/// a frame redraws only the rows that changed.
private struct TurnLine: View, Equatable {
    struct Flight: Equatable {
        let progress: CGFloat
        let replyHeight: CGFloat
        /// The transcript's scroll under it, which it flies through.
        let offset: CGFloat
    }

    let turn: ConversationTurn
    let now: Bool
    let fullScreen: Bool
    let top: Bool
    let fontSize: CGFloat
    /// While its words are coming in: the reveal, and its clock.
    let reveal: WordReveal?
    let clock: Double
    let flight: Flight?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static func == (a: TurnLine, b: TurnLine) -> Bool {
        a.turn == b.turn && a.now == b.now && a.fullScreen == b.fullScreen && a.top == b.top && a.fontSize == b.fontSize
            && a.reveal == b.reveal && a.clock == b.clock && a.flight == b.flight
    }

    var body: some View {
        let flight = reduceMotion ? nil : self.flight
        let e = flight?.progress ?? 1
        let past: CGFloat = fullScreen ? 24 : 17
        VStack(alignment: .leading, spacing: 1) {
            if turn.fromYou {
                Text("You")
                    .font(ConchType.meta)
                    .fontWeight(.semibold)
                    .tracking(0.66)
                    .textCase(.uppercase)
                    .foregroundStyle(ConchColor.overlayTextSecondary)
                    .opacity(flight == nil ? 1 : min(max((e - 0.55) / 0.45, 0), 1))
            }
            words
                .font(ConversationFog.font(latest: now, fullScreen: fullScreen))
                // Large type reads better set a touch tighter.
                .tracking(now ? (fullScreen ? -0.8 : -0.3) : 0)
                .foregroundStyle(ConchColor.overlayText)
                // Wraps at the column, long paths and links included, rather than running out of the blur.
                .fixedSize(horizontal: false, vertical: true)
                .opacity(now ? 1 : 1 - (1 - ConversationFog.pastOpacity) * e)
                .scaleEffect(1 + (fontSize / past - 1) * (1 - e), anchor: top ? .topLeading : .bottomLeading)
                .offset(
                    x: ConversationFog.micSpace * (1 - e),
                    y: flight.map { (top ? -1 : 1) * (FogReply.gap + $0.replyHeight - FogReply.padding(fontSize) - $0.offset) * (1 - e) } ?? 0
                )
                .blur(radius: flight == nil ? 0 : sin(.pi * min(max(e, 0), 1)) * 2)
        }
        .accessibilityElement(children: .combine)
    }

    /// Its words; the newest reply only as far as they have come in, the last few fading up out of a blur.
    @ViewBuilder
    private var words: some View {
        let attributed = ConversationFog.inlineMarkdown(turn.text)
        if let reveal {
            if #available(macOS 15, iOS 18, *) {
                ConversationFog.revealed(attributed, reveal, at: clock)
                    .textRenderer(WordRevealRenderer(
                        reveal: reveal,
                        now: clock,
                        blur: reduceMotion ? 0 : ConchMotion.wordRevealBlur,
                        rise: reduceMotion ? 0 : 0.28 * ConchType.conversationNowSize
                    ))
            } else {
                let starts = ConversationFog.wordStarts(attributed), shown = reveal.shown(at: clock)
                Text(AttributedString(attributed[attributed.startIndex..<(shown < starts.count ? starts[shown] : attributed.endIndex)]))
            }
        } else {
            Text(attributed)
        }
    }
}

@available(macOS 15, iOS 18, *)
private struct RevealedWord: TextAttribute {
    let index: Int
}

/// Each word still coming in drawn part way up out of a blur: its opacity, a little below its line, softened.
@available(macOS 15, iOS 18, *)
private struct WordRevealRenderer: TextRenderer {
    let reveal: WordReveal
    let now: Double
    let blur: CGFloat
    let rise: CGFloat

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        for line in layout {
            for run in line {
                guard let word = run[RevealedWord.self] else {
                    context.draw(run)
                    continue
                }
                let progress = reveal.progress(ofWord: word.index, at: now)
                var copy = context
                copy.opacity = progress
                copy.translateBy(x: 0, y: (1 - progress) * rise)
                if blur > 0 { copy.addFilter(.blur(radius: (1 - progress) * blur)) }
                copy.draw(run)
            }
        }
    }
}

/// Between your message and its reply, while the session works: "Thinking", a light passing through it.
private struct Thinking: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { timeline in
            let phase = reduceMotion ? 0.5 : 1.2 - 1.4 * (timeline.date.timeIntervalSinceReferenceDate / 1.6).truncatingRemainder(dividingBy: 1)
            let label = Text("Thinking").font(.system(size: 15, weight: .medium))
            label
                .foregroundStyle(ConchColor.overlayTextSecondary)
                .overlay {
                    label
                        .foregroundStyle(ConchColor.overlayText)
                        .mask(LinearGradient(
                            stops: [.init(color: .clear, location: phase - 0.12), .init(color: .black, location: phase), .init(color: .clear, location: phase + 0.12)],
                            startPoint: .leading,
                            endPoint: .trailing
                        ))
                }
        }
        .accessibilityLabel("Thinking")
    }
}

// MARK: - FogHeader and FogSwitcher

/// The agent's mark, as the session list draws it, else its name.
private struct FogAgentMark: View {
    let session: FogSession

    var body: some View {
        if let mark = session.mark {
            Image(mark)
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: 11, height: 11)
                .foregroundStyle(ConchColor.overlayTextSecondary)
                .accessibilityLabel("Agent: \(session.agent)")
        } else {
            Text(session.agent)
                .font(ConchType.meta)
                .foregroundStyle(ConchColor.overlayTextSecondary)
        }
    }
}

/// The session the fog's words are from, beside its buttons: the agent's mark, the session's name, and the item the
/// panel is on (full screen on a deliverable only), on one line that gives way from its end. Small and in the buttons'
/// glass, so it never competes with the words. A click lists the other sessions.
private struct FogHeader: View {
    let session: FogSession
    /// The switcher is open, for VoiceOver to say so.
    let isOpen: Bool
    let onSwitch: () -> Void
    @Environment(\.overlayFills) private var fills

    var body: some View {
        Button(action: onSwitch) {
            HStack(spacing: 6) {
                FogAgentMark(session: session)
                Text(session.label)
                    .font(ConchType.uiEmphasis)
                    .foregroundStyle(ConchColor.overlayText)
                    .lineLimit(1)
                    // The name stays whole longest; the item gives way first.
                    .layoutPriority(1)
                if let item = session.item {
                    Text(item)
                        .font(ConchType.secondary)
                        .foregroundStyle(ConchColor.overlayTextSecondary)
                        .lineLimit(1)
                }
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(ConchColor.overlayTextSecondary)
            }
            .padding(.horizontal, 14)
            .frame(height: ConversationFog.buttonSize)
            .background {
                Capsule().fill(ConchColor.overlayGlass)
                    .overlay(Capsule().strokeBorder(ConchColor.overlayLine, lineWidth: 0.5))
                    .opacity(fills)
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        // Past this a long summary only pushes the name further from the buttons.
        .modifier(AtMost(width: 460))
        .help("Switch session")
        .accessibilityLabel([session.label, session.agent, session.item].compactMap { $0 }.joined(separator: ", "))
        .accessibilityValue(isOpen ? "Sessions open" : "")
        .accessibilityHint(isOpen ? "Closes the list of sessions" : "Lists the other sessions")
    }
}

/// No wider than `width`, and no wider than it needs: `frame(maxWidth:)` would take all of `width` whenever it was offered,
/// leaving a short name in a long empty control that swallowed the fog's drags.
private struct AtMost: ViewModifier, Layout {
    let width: CGFloat

    func body(content: Content) -> some View { self { content } }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        subviews.first?.sizeThatFits(ProposedViewSize(width: min(proposal.width ?? width, width), height: proposal.height)) ?? .zero
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}

/// The session the voice is reading aloud while the panel shows another: "Speaking: Dayloop ›", quiet beside the header.
/// A click brings that one into the panel.
private struct SpeakingChip: View {
    let session: FogSession
    let onShow: () -> Void
    @Environment(\.overlayFills) private var fills

    var body: some View {
        Button(action: onShow) {
            HStack(spacing: 4) {
                Text("Speaking: \(session.label)")
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
            }
            .font(ConchType.secondary)
            .foregroundStyle(ConchColor.overlayTextSecondary)
            .padding(.horizontal, 12)
            .frame(height: 28)
            .background(Capsule().fill(ConchColor.overlayFill).opacity(fills))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .modifier(AtMost(width: 260))
        .help("Show \(session.label), which the voice is reading")
        .accessibilityLabel("Speaking: \(session.label)")
        .accessibilityHint("Shows that session in the panel")
    }
}

/// The panel's switcher: every session, ready for you first, then working, then the rest, under the menu bar menu's own
/// headings, the one on screen marked and the keyboard's pick (↑ ↓) lit. Its own height up to `tallest`, then it scrolls.
/// Its rows follow one another in as it opens (`ConchMotion.popStagger`).
private struct FogSwitcher: View {
    static let width: CGFloat = 340
    static let rowHeight: CGFloat = 30
    static let headingHeight: CGFloat = 24
    /// panel-lab's `#switcher`: a popover's corner, rounder than a menu's.
    static let radius: CGFloat = 20

    let sessions: [FogSession]
    let current: String?
    /// The row the keyboard has picked out.
    let selected: String?
    /// The room it has, from the button row to the fog's far edge.
    let tallest: CGFloat
    let onPick: (String) -> Void
    @State private var hovered: String?
    /// Rows in: false for the frame it opens on, so each row springs in after the one before.
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private func startsGroup(_ index: Int) -> Bool {
        index == 0 || sessions[index - 1].standing != sessions[index].standing
    }

    var body: some View {
        let headings = sessions.indices.filter(startsGroup).count
        let content = CGFloat(sessions.count) * Self.rowHeight + CGFloat(headings) * Self.headingHeight + 2 * ConchSpace.x2
        let shape = RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
        let height = min(content, 360, tallest)
        let list = VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(sessions.enumerated()), id: \.element.id) { index, session in
                if startsGroup(index) {
                    // "You" in the transcript is set the same way.
                    Text(session.standing.title)
                        .font(ConchType.meta)
                        .fontWeight(.semibold)
                        .tracking(0.66)
                        .textCase(.uppercase)
                        .foregroundStyle(ConchColor.overlayTextSecondary)
                        .padding(.horizontal, ConchSpace.x2)
                        .frame(height: Self.headingHeight, alignment: .bottomLeading)
                        .accessibilityAddTraits(.isHeader)
                }
                row(session)
                    .opacity(shown || reduceMotion ? 1 : 0)
                    .offset(y: shown || reduceMotion ? 0 : 5)
                    .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion).delay(ConchMotion.popLead + Double(index) * ConchMotion.popStagger), value: shown)
            }
        }
        .padding(ConchSpace.x2)
        Group {
            // A scroll view only when it doesn't fit.
            if content <= height { list } else { ScrollView(.vertical) { list } }
        }
        .frame(width: Self.width, height: height, alignment: .top)
        .clipShape(shape)
        .overlayGlass(shape)
        .onAppear { shown = true }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sessions")
    }

    private func row(_ session: FogSession) -> some View {
        let here = session.id == current
        let lit = here || session.id == selected || hovered == session.id
        return Button { onPick(session.id) } label: {
            HStack(spacing: ConchSpace.x2) {
                // The menu bar menu's marks, in the sidebar's colours for the same two states (`FogSession.markSymbol`).
                Image(systemName: FogSession.markSymbol(session.standing))
                    .font(.system(size: 7))
                    .foregroundStyle(FogSession.markColor(session.standing))
                    .opacity(session.standing == .other ? 0 : 1)
                FogAgentMark(session: session)
                Text(session.label)
                    .font(ConchType.uiBody)
                    .foregroundStyle(ConchColor.overlayText)
                    .lineLimit(1)
                    .layoutPriority(1)
                if let item = session.item {
                    Text(item)
                        .font(ConchType.secondary)
                        .foregroundStyle(ConchColor.overlayTextSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, ConchSpace.x2)
            .frame(height: Self.rowHeight)
            .background(
                RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous)
                    .fill(here ? ConchColor.overlayFillStrong : ConchColor.overlayFill)
                    .opacity(lit ? 1 : 0)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { inside in
            if inside { hovered = session.id } else if hovered == session.id { hovered = nil }
        }
        .accessibilityLabel([session.label, session.agent, session.item].compactMap { $0 }.joined(separator: ", "))
        .accessibilityValue(session.standing.spoken)
        .accessibilityAddTraits(here ? .isSelected : [])
    }
}

// MARK: - FogPanelButtons

/// The fog's collapse and full-screen buttons: in that order, as a Mac window's minimise and zoom come. Then, while
/// something is ready, Previous and Next, which walk it as the Ready pill does. Then, when it is given one, the canvas's
/// pen, dark while the pen is down (panel-lab's `#bPen`). Full screen, Collapse steps out: beside Exit full screen it hid
/// the whole panel down to a handle you can't see. Each names its key in its tooltip (`PanelKeys`).
public struct FogPanelButtons: View {
    let corner: FogCorner
    let isFullScreen: Bool
    let onCollapse: () -> Void
    let onFullScreen: () -> Void
    let onPrevious: (() -> Void)?
    let onNext: (() -> Void)?
    let onCanvas: (() -> Void)?
    let isCanvasOn: Bool

    public init(corner: FogCorner, isFullScreen: Bool, onCollapse: @escaping () -> Void, onFullScreen: @escaping () -> Void, onPrevious: (() -> Void)? = nil, onNext: (() -> Void)? = nil, onCanvas: (() -> Void)? = nil, isCanvasOn: Bool = false) {
        self.corner = corner
        self.isFullScreen = isFullScreen
        self.onCollapse = onCollapse
        self.onFullScreen = onFullScreen
        self.onPrevious = onPrevious
        self.onNext = onNext
        self.onCanvas = onCanvas
        self.isCanvasOn = isCanvasOn
    }

    public var body: some View {
        HStack(spacing: ConchSpace.x2) {
            if !isFullScreen {
                IconButton(
                    corner.bottom ? "chevron.down" : "chevron.up",
                    label: "Collapse conversation",
                    style: .glass,
                    size: ConversationFog.buttonSize,
                    shortcut: PanelKeys.Shortcut.collapse,
                    action: onCollapse
                )
            }
            IconButton(
                isFullScreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                label: isFullScreen ? "Exit full screen" : "Full screen",
                style: .glass,
                size: ConversationFog.buttonSize,
                shortcut: isFullScreen ? PanelKeys.Shortcut.exitFullScreen : PanelKeys.Shortcut.fullScreen,
                action: onFullScreen
            )
            if let onPrevious {
                IconButton("chevron.left", label: "Previous ready item", style: .glass, size: ConversationFog.buttonSize, shortcut: PanelKeys.Shortcut.previous, action: onPrevious)
                    // A pair of their own, a little apart from the window's two.
                    .padding(.leading, ConchSpace.x1)
            }
            if let onNext {
                IconButton("chevron.right", label: "Next ready item", style: .glass, size: ConversationFog.buttonSize, shortcut: PanelKeys.Shortcut.next, action: onNext)
            }
            if let onCanvas {
                IconButton("pencil", label: isCanvasOn ? "Stop drawing" : "Draw on the screen", style: isCanvasOn ? .primary : .glass, size: ConversationFog.buttonSize, shortcut: PanelKeys.Shortcut.pen, action: onCanvas)
                    .padding(.leading, ConchSpace.x1)
            }
        }
    }
}

// MARK: - FogHandle

/// The conversation fog collapsed (M3): nothing to see until the pointer comes into the fog's corner, then a caret
/// that opens it again at the size it had. The whole corner area opens it. The panel's glass shrinks into its circle as
/// the panel collapses (`PanelGlass.Geometry.collapsed`), and grows out of it as it opens.
public struct FogHandle: View {
    /// The corner area the pointer shows the caret in.
    public static let side: CGFloat = 72
    /// The caret's circle, and how far it sits in from the corner's two edges.
    public static let circle: CGFloat = 44
    public static let inset: CGFloat = ConchSpace.x3

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
                // The panel's own buttons' glyph: semibold, in their ink.
                Image(systemName: corner.bottom ? "chevron.up" : "chevron.down")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ConchColor.overlayGlassIcon)
                    .frame(width: Self.circle, height: Self.circle)
                    .overlayGlass(Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .padding(Self.inset)
            // Hidden until the pointer is in the corner (Tyler: "only shows when your hovering in that area").
            .opacity(hovering ? 1 : 0)
            .animation(ConchMotion.hover.animation(reduceMotion: reduceMotion), value: hovering)
            .help("Show conversation")
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
