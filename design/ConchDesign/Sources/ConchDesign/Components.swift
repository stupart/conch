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
/// bottom. Its two other edges are free: where it fades. Screen coordinates, y up.
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

    /// Biggest: 1280 by 900, never more than the screen.
    public static func maxSize(in screen: CGRect) -> CGSize {
        CGSize(width: min(1280, screen.width), height: min(900, screen.height))
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
    /// Springs without overshoot.
    public var reduceMotion = false

    private var flyingVelocity: CGFloat = 0
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
    public var isSettled: Bool { gesture == nil && flight == nil && sizeTarget == nil && flying == 0 }

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
    /// How much of the fog colour lies over the blur where it is densest.
    let tint: Double
    /// Draws the collapse and full-screen buttons; a host that layers its own controls over the fog draws them itself.
    let showsButtons: Bool
    /// Off its corner: the fog fades on every side instead of gathering in the corner.
    let floating: Bool
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
        tint: Double = ConversationFog.tintOpacity,
        showsButtons: Bool = true,
        floating: Bool = false,
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
        self.tint = tint
        self.showsButtons = showsButtons
        self.floating = floating
        self.onMic = onMic
        self.onSend = onSend
        self.onCollapse = onCollapse
        self.onFullScreen = onFullScreen
    }

    /// Where the fog is, as a mask (only its alpha matters). Full screen, everywhere; otherwise the corner fog,
    /// strongest in the panel's `corner` and gone three quarters of the way out, so there is no edge to look at.
    public static func density(fullScreen: Bool, corner: FogCorner = .bottomLeading, floating: Bool = false) -> EllipticalGradient {
        EllipticalGradient(
            stops: fullScreen
                ? [.init(color: .black, location: 0), .init(color: .black, location: 1)]
                : [
                    .init(color: .black, location: 0.36),
                    .init(color: .black.opacity(0.75), location: 0.5),
                    .init(color: .black.opacity(0.3), location: 0.64),
                    .init(color: .clear, location: 0.78),
                ],
            // Off its corner (dragged, or in flight) it gathers in the middle and fades out before any of its own edges,
            // so pulled off a screen edge it never ends in a line (Tyler: "when u pull it off an edge thers a line").
            center: floating ? .center : corner.unitPoint,
            endRadiusFraction: floating ? 0.64 : 1.1
        )
    }

    /// Inside the fog, before the screen's own insets.
    public static let padding: CGFloat = ConchSpace.x6
    static let buttonSize: CGFloat = 36

    /// Where the words and the reply line sit: all of the fog but its padding, the screen's insets and a row for the
    /// buttons, so a bigger fog is all more room for words. Past a comfortable line they keep to the fog's corner.
    static func textFrame(in size: CGSize, corner: FogCorner, insets: EdgeInsets, fullScreen: Bool) -> CGRect {
        // The button row is on the docked side: above the words when the fog hangs from the top, below the reply
        // when it sits on the bottom.
        let row = buttonSize + ConchSpace.x3
        let atBottom = buttonsAtBottom(corner: corner, fullScreen: fullScreen)
        let top = insets.top + padding + (atBottom ? 0 : row)
        // Below the words: the Dock's inset, or on the bottom the button row in the corner, whichever is taller.
        let bottom = atBottom ? max(insets.bottom, row) + padding : insets.bottom + padding
        let height = max(0, size.height - top - bottom)
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

    /// The tint a host doesn't choose one: how much of the fog colour lies over the blur where it is densest.
    public static let tintOpacity = 0.86

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
                                .opacity(tint)
                                .mask(Self.density(fullScreen: false, corner: corner, floating: floating))
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
                    .fogControl()
                }
                .frame(width: text.width, height: text.height, alignment: .bottomLeading)
                .offset(x: text.minX, y: text.minY)
                if showsButtons {
                    let buttons = Self.buttonInsets(insets)
                    FogPanelButtons(corner: corner, isFullScreen: isFullScreen, onCollapse: onCollapse, onFullScreen: onFullScreen)
                        .fogControl()
                        .frame(
                            width: max(0, proxy.size.width - buttons.leading - buttons.trailing - 2 * Self.padding),
                            alignment: Self.buttonsAlignment(corner: corner, fullScreen: isFullScreen)
                        )
                        .offset(
                            x: buttons.leading + Self.padding,
                            y: Self.buttonsY(in: proxy.size, corner: corner, insets: buttons, fullScreen: isFullScreen)
                        )
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
