import SwiftUI

extension EnvironmentValues {
    /// Set by the gallery. ImageRenderer cannot draw a platform text field, so a component that hosts one
    /// draws a SwiftUI stand-in in the same type and colours instead.
    @Entry public var conchRendersStatically = false
    /// Set by the overlay: how far its palette has crossfaded from light (0) to dark (1). Colour tokens follow it rather
    /// than the colour scheme, so the words turn with the look.
    @Entry public var conchDarkness: Double? = nil
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
        /// Over another app (the fog's buttons): the overlay's translucent circle with a hairline, as the overlay lab draws them.
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
                .foregroundStyle(style == .primary ? ConchColor.onAccent : style == .glass ? ConchColor.overlayGlassIcon : ConchColor.textSecondary)
                .frame(width: size, height: size)
                .background {
                    switch style {
                    case .plain: Circle().fill(ConchColor.fill)
                    case .primary: Circle().fill(ConchColor.accent)
                    case .glass:
                        Circle().fill(ConchColor.overlayGlass)
                            .overlay(Circle().strokeBorder(ConchColor.overlayLine, lineWidth: 0.5))
                    }
                }
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

// MARK: - InlineReplyLine

/// Replying without a text box: the mic comes first, then your words in the conversation's own type. Return sends,
/// Shift-Return starts a new line and Esc leaves the field. Its host gives it its height (`FogReply`): it grows to five
/// lines, then scrolls inside itself.
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
    @Environment(\.conchRendersStatically) private var rendersStatically

    public init(
        text: Binding<String>,
        isListening: Bool,
        placeholder: String = "Reply",
        fontSize: CGFloat = 24,
        alignsTop: Bool = false,
        overflows: Bool = false,
        onMic: @escaping () -> Void,
        onSend: @escaping () -> Void
    ) {
        _text = text
        self.isListening = isListening
        self.placeholder = placeholder
        self.fontSize = fontSize
        self.alignsTop = alignsTop
        self.overflows = overflows
        self.onMic = onMic
        self.onSend = onSend
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
                    ReplyField(text: $text, fontSize: fontSize, onSend: onSend)
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
                        Text(placeholder)
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
            case .leave: view.window?.makeFirstResponder(nil)
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

/// The floating control bar (M3): the voice and what it is about, and Talk or Quiet. The conversation is
/// shown and hidden from the menu bar menu, not from here. Ready, its label is a button that brings forward
/// what is ready (`ReviewScene`).
public struct ControlBar: View {
    let state: VoiceState
    let detail: String
    @Binding var mode: VoiceMode
    let onTap: (() -> Void)?
    /// What a click would show, as a tooltip on the Ready label.
    let help: String

    public init(state: VoiceState, detail: String, mode: Binding<VoiceMode>, onTap: (() -> Void)? = nil, help: String = "") {
        self.state = state
        self.detail = detail
        _mode = mode
        self.onTap = onTap
        self.help = help
    }

    /// Only a Ready pill takes a click, and only on its label: Talk and Quiet keep their own.
    var taps: Bool { onTap != nil && state == .ready }

    public var body: some View {
        GlassPill("Voice controls") {
            // A fixed width, so the bar keeps its size and place as the state and the session change.
            // The session first: the orb and the menu bar mark already say what the voice is doing.
            let label = VoiceStateLabel(state: state, detail: detail, leadsWithDetail: true)
                .frame(width: 196, alignment: .leading)
            if taps, let onTap {
                Button(action: onTap) { label.contentShape(Rectangle()) }
                    .buttonStyle(PillPress())
                    #if os(macOS)
                    .onContinuousHover { phase in
                        if case .active = phase { NSCursor.pointingHand.set() } else { NSCursor.arrow.set() }
                    }
                    #endif
                    .help(help)
                    .accessibilityHint("Brings forward what is ready")
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

    /// Oldest filed first, ties by version so the order never shuffles.
    static func order<Key: Comparable>(_ ready: [(key: Key, at: Double)]) -> [Key] {
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

    /// Ready for you first, then working, then the rest, each group in the order the daemon sent it.
    public static func ordered(_ sessions: [FogSession]) -> [FogSession] {
        sessions.enumerated()
            .sorted { ($0.element.standing.rawValue, $0.offset) < ($1.element.standing.rawValue, $1.offset) }
            .map(\.element)
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
        EdgeInsets(top: max(0, top - amount), leading: max(0, leading - amount), bottom: max(0, bottom - amount), trailing: max(0, trailing - amount))
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
        if ConchSpring(bounce: 0, response: 0.2).step(&flying, velocity: &flyingVelocity, to: goal, dt: dt) {
            flying = goal
            flyingVelocity = 0
        }
        if ConchSpring(bounce: 0, response: 0.22).step(&free, velocity: &freeVelocity, to: isMoving ? 1 : 0, dt: dt) {
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
/// it all runs top-down, the newest nearest the top. The blur is the host's (a behind-window visual effect view on the
/// Mac, masked with `FogLook.mask`), and so is the look over it (`FogLookView`); this draws the words, and collapse and
/// full-screen buttons that brighten on hover.
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
    /// Draws the full screen's wash; off, the words and buttons stand alone.
    let showsFog: Bool
    /// The look under the words: they fade where its blur does, and off a corner its magnet moves them.
    let look: FogLook?
    /// Draws the collapse and full-screen buttons; a host that layers its own controls over the fog draws them itself.
    let showsButtons: Bool
    /// Off its corner, dragged or in flight: the buttons hide.
    let floating: Bool
    /// The pointer is over the fog: the buttons show fully.
    let hovering: Bool
    /// The session the words are from, named beside the buttons (`FogHeader`); nil names none.
    let session: FogSession?
    /// What the switcher lists, in its order (`FogSession.ordered`).
    let sessions: [FogSession]
    /// The switcher is open. The host's, so a press anywhere else on the fog can close it.
    @Binding var isSwitching: Bool
    /// The reply line; off, the transcript takes its room (the menu bar's Show Reply Line).
    let showsReply: Bool
    let onPick: (String) -> Void
    /// Back and on through what is ready; nil leaves the button out.
    let onPrevious: (() -> Void)?
    let onNext: (() -> Void)?
    let onMic: () -> Void
    let onSend: () -> Void
    let onCollapse: () -> Void
    let onFullScreen: () -> Void
    @Environment(\.conchRendersStatically) private var rendersStatically
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        turns: [ConversationTurn],
        draft: Binding<String>,
        text: FogTextState,
        isListening: Bool,
        isWorking: Bool = false,
        isFullScreen: Bool,
        corner: FogCorner = .bottomLeading,
        insets: EdgeInsets = EdgeInsets(),
        showsFog: Bool = true,
        look: FogLook? = nil,
        showsButtons: Bool = true,
        floating: Bool = false,
        hovering: Bool = true,
        session: FogSession? = nil,
        sessions: [FogSession] = [],
        isSwitching: Binding<Bool> = .constant(false),
        showsReply: Bool = true,
        onPick: @escaping (String) -> Void = { _ in },
        onPrevious: (() -> Void)? = nil,
        onNext: (() -> Void)? = nil,
        onMic: @escaping () -> Void,
        onSend: @escaping () -> Void,
        onCollapse: @escaping () -> Void,
        onFullScreen: @escaping () -> Void
    ) {
        self.turns = turns
        _draft = draft
        _text = ObservedObject(wrappedValue: text)
        self.isListening = isListening
        self.isWorking = isWorking
        self.isFullScreen = isFullScreen
        self.corner = corner
        self.insets = insets
        self.showsFog = showsFog
        self.look = look
        self.showsButtons = showsButtons
        self.floating = floating
        self.hovering = hovering
        self.session = session
        self.sessions = sessions
        _isSwitching = isSwitching
        self.showsReply = showsReply
        self.onPick = onPick
        self.onPrevious = onPrevious
        self.onNext = onNext
        self.onMic = onMic
        self.onSend = onSend
        self.onCollapse = onCollapse
        self.onFullScreen = onFullScreen
    }

    /// Inside the fog, before the screen's own insets.
    public static let padding: CGFloat = ConchSpace.x6
    static let buttonSize: CGFloat = 36
    /// From a screen side the words are docked against to their column: the lab's 52.
    static let side: CGFloat = 52
    /// The mic and the gap after it, before the reply's words.
    public static let micSpace: CGFloat = 40 + ConchSpace.x3
    /// ponytail: the daemon sends 40 turns at most; a runaway list shows its newest 200 rather than laying out thousands.
    static let turnsShown = 200

    /// The reply line's type size: the conversation's newest, `ConchType.conversationNow` (24) or, full screen, 36.
    public static func replyFontSize(fullScreen: Bool) -> CGFloat { fullScreen ? 36 : 24 }

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

    public var body: some View {
        GeometryReader { proxy in
            let frame = Self.textFrame(in: proxy.size, corner: corner, insets: insets, fullScreen: isFullScreen, magnet: look?.magnet)
            let top = Self.newestAtTop(corner: corner, fullScreen: isFullScreen)
            let fontSize = Self.replyFontSize(fullScreen: isFullScreen)
            let target = text.replyTarget(for: draft, width: max(0, frame.width - Self.micSpace), fontSize: fontSize, in: frame.height)
            let reply = rendersStatically ? target : text.replyHeight
            let overflows = CGFloat(text.replyLines) * FogReply.lineHeight(fontSize) + 2 * FogReply.padding(fontSize) > target + 0.5
            let box = showsReply ? max(0, frame.height - FogReply.gap - reply) : frame.height
            ZStack(alignment: .topLeading) {
                if showsFog, isFullScreen {
                    // panel.html's wash: light at the top so the blurred work still shows, deepening toward the words.
                    Rectangle().fill(ConchColor.fog).mask(LinearGradient(
                        stops: [.init(color: .black.opacity(0.12), location: 0), .init(color: .black.opacity(0.42), location: 0.55), .init(color: .black.opacity(0.62), location: 1)],
                        startPoint: .top,
                        endPoint: .bottom
                    ))
                    .accessibilityHidden(true)
                }
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
                .onChange(of: target, initial: true) { _, target in text.grow(to: target) }
                if showsButtons {
                    let buttons = Self.buttonInsets(insets)
                    let alignment = Self.buttonsAlignment(corner: corner, fullScreen: isFullScreen)
                    let y = Self.buttonsY(in: proxy.size, corner: corner, insets: buttons, fullScreen: isFullScreen)
                    // The session is named beside the buttons, on their free side: the buttons keep the nook.
                    HStack(spacing: ConchSpace.x3) {
                        if alignment != .leading { header }
                        FogPanelButtons(corner: corner, isFullScreen: isFullScreen, onCollapse: onCollapse, onFullScreen: onFullScreen, onPrevious: onPrevious, onNext: onNext)
                            .fogControl()
                        if alignment == .leading { header }
                    }
                    .frame(width: max(0, proxy.size.width - buttons.leading - buttons.trailing - 2 * Self.padding), alignment: alignment)
                    .offset(x: buttons.leading + Self.padding, y: y)
                    // Faint until the pointer is over the fog, and gone while it flies.
                    .opacity(isFullScreen ? 1 : floating ? 0 : hovering ? 1 : 0.4)
                    .allowsHitTesting(isFullScreen || !floating)
                    .animation(ConchSpring(bounce: 0, response: 0.28).animation(reduceMotion: reduceMotion), value: hovering)
                    .animation(ConchSpring(bounce: 0, response: 0.2).animation(reduceMotion: reduceMotion), value: floating)
                    switcher(in: proxy.size, y: y, leading: alignment == .leading)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Conversation")
    }

    /// The reply line, its height springing (`FogTextState.replyHeight`); and while the reader is scrolled away, the pill
    /// back to the newest line beside it, on the transcript's side.
    private func replyLine(fontSize: CGFloat, height: CGFloat, top: Bool, overflows: Bool) -> some View {
        InlineReplyLine(text: $draft, isListening: isListening, fontSize: fontSize, alignsTop: top, overflows: overflows, onMic: onMic, onSend: onSend)
            .frame(height: height, alignment: top ? .top : .bottom)
            .fogControl()
            .overlay(alignment: top ? .bottomLeading : .topLeading) {
                if !text.scroll.pinned {
                    pill(top: top)
                        .fogControl()
                        .offset(y: top ? 38 : -38)
                        .transition(.scale(scale: 0.85, anchor: top ? .top : .bottom).combined(with: .opacity))
                }
            }
            .animation(ConchSpring(bounce: 0.25, response: 0.32).animation(reduceMotion: reduceMotion), value: text.scroll.pinned)
    }

    /// The transcript, crossfading to another session's rather than cutting to it. A dissolve is what Reduce Motion
    /// keeps, so it stays under it.
    private func words(width: CGFloat, height: CGFloat, top: Bool, fontSize: CGFloat) -> some View {
        ZStack {
            transcript(width: width, height: height, top: top, fontSize: fontSize)
                .id(session?.id)
                .transition(.opacity)
        }
        .animation(ConchMotion.appearance.animation(reduceMotion: reduceMotion), value: session?.id)
    }

    /// The session the words are from, crossfading with them. A click opens the switcher.
    @ViewBuilder private var header: some View {
        if let session {
            ZStack {
                FogHeader(session: session) { isSwitching.toggle() }
                    .id(session.id)
                    .transition(.opacity)
            }
            .animation(ConchMotion.appearance.animation(reduceMotion: reduceMotion), value: session.id)
            .fogControl()
        }
    }

    /// The switcher opens from the button row away from the edge the fog is docked on: up from a bottom corner, down from
    /// a top one and full screen, on the button row's side.
    private func switcher(in size: CGSize, y: CGFloat, leading: Bool) -> some View {
        let up = Self.buttonsAtBottom(corner: corner, fullScreen: isFullScreen)
        let top = up ? 0 : y + Self.buttonSize + ConchSpace.x2
        let room = max(0, up ? y - ConchSpace.x2 : size.height - top - Self.padding)
        let anchor: UnitPoint = up ? (leading ? .bottomLeading : .bottomTrailing) : (leading ? .topLeading : .topTrailing)
        return ZStack {
            if isSwitching {
                FogSwitcher(sessions: sessions, current: session?.id, tallest: room, onPick: onPick)
                    .fogControl()
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.96, anchor: anchor).combined(with: .opacity))
            }
        }
        .frame(width: max(0, size.width - 2 * Self.padding), height: room, alignment: Alignment(horizontal: leading ? .leading : .trailing, vertical: up ? .bottom : .top))
        .offset(x: Self.padding, y: top)
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: isSwitching)
    }

    private func pill(top: Bool) -> some View {
        Button(action: text.toNewest) {
            HStack(spacing: 5) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .bold))
                    .rotationEffect(.degrees(top ? 180 : 0))
                Text(text.scroll.unseen ? "New reply" : "Newest")
                    .font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(ConchColor.overlayText)
            .padding(.leading, 8)
            .padding(.trailing, 11)
            .frame(height: 28)
            .background(Capsule().fill(ConchColor.overlayGlassStrong).shadow(color: .black.opacity(0.18), radius: 8, y: 6))
            .overlay(Capsule().strokeBorder(ConchColor.overlayLine, lineWidth: 0.5))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Scroll to the newest message")
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
        .animation(ConchSpring(bounce: 0, response: 0.32).animation(reduceMotion: reduceMotion), value: pinned)
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
                .opacity(now ? 1 : 1 - 0.5 * e)
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
/// panel is on, on one line that gives way from its end. Small and in the buttons' glass, so it never competes with the
/// words. A click lists the other sessions.
private struct FogHeader: View {
    let session: FogSession
    let onSwitch: () -> Void

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
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(ConchColor.overlayTextSecondary)
            }
            .padding(.horizontal, 14)
            .frame(height: ConversationFog.buttonSize)
            .background(Capsule().fill(ConchColor.overlayGlass))
            .overlay(Capsule().strokeBorder(ConchColor.overlayLine, lineWidth: 0.5))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        // Past this a long summary only pushes the name further from the buttons.
        .modifier(AtMost(width: 460))
        .accessibilityLabel([session.label, session.agent, session.item].compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint("Lists the other sessions")
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

/// The panel's switcher: every session, ready for you first, then working, then the rest, under the menu bar menu's own
/// headings and marks, the one on screen marked. Its own height up to `tallest`, then it scrolls.
private struct FogSwitcher: View {
    static let width: CGFloat = 340
    static let rowHeight: CGFloat = 30
    static let headingHeight: CGFloat = 24

    let sessions: [FogSession]
    let current: String?
    /// The room it has, from the button row to the fog's far edge.
    let tallest: CGFloat
    let onPick: (String) -> Void
    @State private var hovered: String?

    private func startsGroup(_ index: Int) -> Bool {
        index == 0 || sessions[index - 1].standing != sessions[index].standing
    }

    var body: some View {
        let headings = sessions.indices.filter(startsGroup).count
        let content = CGFloat(sessions.count) * Self.rowHeight + CGFloat(headings) * Self.headingHeight + 2 * ConchSpace.x2
        let shape = RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous)
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
            }
        }
        .padding(ConchSpace.x2)
        Group {
            // A scroll view only when it doesn't fit.
            if content <= height { list } else { ScrollView(.vertical) { list } }
        }
        .frame(width: Self.width, height: height, alignment: .top)
        .background(shape.fill(ConchColor.overlayGlassStrong))
        .overlay(shape.strokeBorder(ConchColor.overlayLine, lineWidth: 0.5))
        .clipShape(shape)
        .conchElevation(.floating)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sessions")
    }

    private func row(_ session: FogSession) -> some View {
        let here = session.id == current
        return Button { onPick(session.id) } label: {
            HStack(spacing: ConchSpace.x2) {
                // The menu bar menu's marks: a dot for ready, a ring for working.
                Image(systemName: session.standing == .ready ? "circle.fill" : "circle")
                    .font(.system(size: 7))
                    .foregroundStyle(session.standing == .ready ? ConchColor.ready : ConchColor.overlayTextSecondary)
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
                RoundedRectangle(cornerRadius: ConchRadius.small, style: .continuous)
                    .fill(here ? ConchColor.overlayFillStrong : ConchColor.overlayFill)
                    .opacity(here || hovered == session.id ? 1 : 0)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { inside in
            if inside { hovered = session.id } else if hovered == session.id { hovered = nil }
        }
        .accessibilityLabel([session.label, session.agent, session.item].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(here ? .isSelected : [])
    }
}

// MARK: - FogPanelButtons

/// The fog's collapse and full-screen buttons: in that order, as a Mac window's minimise and zoom come. Then, while
/// something is ready, Previous and Next, which walk it as the Ready pill does.
public struct FogPanelButtons: View {
    let corner: FogCorner
    let isFullScreen: Bool
    let onCollapse: () -> Void
    let onFullScreen: () -> Void
    let onPrevious: (() -> Void)?
    let onNext: (() -> Void)?

    public init(corner: FogCorner, isFullScreen: Bool, onCollapse: @escaping () -> Void, onFullScreen: @escaping () -> Void, onPrevious: (() -> Void)? = nil, onNext: (() -> Void)? = nil) {
        self.corner = corner
        self.isFullScreen = isFullScreen
        self.onCollapse = onCollapse
        self.onFullScreen = onFullScreen
        self.onPrevious = onPrevious
        self.onNext = onNext
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
            if let onPrevious {
                IconButton("chevron.left", label: "Previous ready item", style: .glass, size: ConversationFog.buttonSize, action: onPrevious)
                    // A pair of their own, a little apart from the window's two.
                    .padding(.leading, ConchSpace.x1)
            }
            if let onNext {
                IconButton("chevron.right", label: "Next ready item", style: .glass, size: ConversationFog.buttonSize, action: onNext)
            }
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
