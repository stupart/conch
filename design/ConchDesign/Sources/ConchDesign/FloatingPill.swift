import CoreGraphics
import Foundation
import SwiftUI

/// The floating pill (2026-11-11): one small pill over every app, on every space, docked to a screen edge, that says what
/// conch is doing at a glance and does the one obvious thing when clicked. Tyler: "redoing the live overlay idea,
/// simplifying it to just have one lil nub or pill and actually work."
///
/// It replaces everything the old overlays put over other apps (the control bar and its Ready pill, the conversation
/// panel, the canvas's glass, the reply line and its swoop, the tour), which were too much and never reliable. This is the
/// rule; the Mac's `FloatingPillController` feeds it the daemon's published state and draws what it returns
/// (`FloatingPillView`).
///
/// What it shows, at most one of each, and nothing at all of what isn't happening:
/// - who the voice is with: the session being read aloud or listened to, as the menu header's orb draws it;
/// - whether a session needs Tyler: a permission, a question, a deliverable ready to look at, as the sidebar marks them;
/// - how many sessions are working: the sidebar's breathing blue dot and a number;
/// - manual mode: a slashed speaker. Auto, the default, shows nothing.
/// With nothing happening it is the conch mark alone, a nub.
public enum FloatingPill {
    // MARK: The switch

    /// The switch, a UserDefaults bool: the menu bar menu's Floating Pill and Settings' row. Never set is `byDefault`.
    public static let key = "conch.floatingPill"
    /// On. The old overlays were off by default (#510) because they were big, took over the screen and didn't work
    /// reliably; this is a nub that never takes focus, does nothing with audio itself, and is the one way to see conch's
    /// state from another app. Off by default, nobody would find it.
    public static let byDefault = true

    public static func enabled(stored: Any?) -> Bool {
        (stored as? Bool) ?? byDefault
    }

    /// The old overlays' switch (Debug ▸ Overlays (experimental)), which this replaces.
    public static let legacyKey = "conch.overlays"

    /// Everything the old overlays kept in UserDefaults, which nothing reads any more: their switches, where the control
    /// bar, the panel and the reply line were left, the panel's look, and the tour's tip.
    public static let retiredKeys: [String] = [
        legacyKey,
        "conch.showControlBar", "conch.showConversation", "conch.showReplyLine", "conch.replyLineAlone",
        "conch.conversationTurnedOnByOpen", "conch.conversationCollapsed", "conch.replyLine.spot",
        "NSWindow Frame conch.controlBar", "NSWindow Frame conch.conversation",
        "conch.overlay.appearance", "conch.overlay.blur", "conch.overlay.colour", "conch.overlay.colourDark",
        "conch.overlay.material", "conch.overlay.scrim", "conch.overlay.scrimDark", "conch.overlay.tint",
        "conch.overlay.tintDark", "conch.tour.pillTip",
    ]

    /// What to do to UserDefaults once, at launch: the pill's switch to write, if any, and the retired keys to remove.
    public struct Migration: Equatable, Sendable {
        public let set: Bool?
        public let remove: [String]
    }

    /// An explicit choice about the old overlays carries over to the pill, the one thing left that draws over other apps:
    /// on stays on, off stays off. Never set, the pill takes its own default. A pill switch already set is never touched.
    /// Then every retired key that is there goes, so nothing is left behind that nothing reads.
    public static func migration(pill: Any?, legacy: Any?, present: Set<String>) -> Migration {
        let carried = pill == nil ? legacy as? Bool : nil
        return Migration(set: carried, remove: retiredKeys.filter(present.contains))
    }

    // MARK: What it says

    /// What a session wants of Tyler, most pressing first: a permission holds an agent up, a question waits on an
    /// answer, a deliverable only waits to be looked at.
    public enum Need: Int, Comparable, Sendable {
        case permission, question, ready

        public static func < (a: Need, b: Need) -> Bool { a.rawValue < b.rawValue }

        /// What it asks, said on its own line: "Wants to run Bash", "Has a question", or the deliverable's own summary.
        public func ask(_ detail: String?) -> String {
            switch self {
            case .permission: detail.map { "Wants to run \($0)" } ?? "Asks permission"
            case .question: "Has a question"
            case .ready: detail ?? VoiceState.ready.title
            }
        }

        /// How it reads after the session's name, behind the voice: "wants to run Bash".
        public func aside(_ detail: String?) -> String {
            switch self {
            case .permission: detail.map { "wants to run \($0)" } ?? "asks permission"
            case .question: "has a question"
            case .ready: "has something ready"
            }
        }

        /// Its colour: the sidebar's needs and ready.
        public var colour: ConchColorToken { self == .ready ? ConchColor.ready : ConchColor.attention }
    }

    /// A top-level session, as the pill reads it.
    public struct Session: Equatable, Sendable {
        public let id: String
        public let label: String
        public let working: Bool
        public let need: Need?
        /// What the need is about: the permission's tool, the ready deliverable's summary.
        public let detail: String?
        /// Epoch milliseconds of its current status: the oldest need is the first answered.
        public let at: Double

        public init(id: String, label: String, working: Bool = false, need: Need? = nil, detail: String? = nil, at: Double = 0) {
            self.id = id
            self.label = label
            self.working = working
            self.need = need
            self.detail = detail
            self.at = at
        }
    }

    /// What the voice is doing right now.
    public enum Voice: Equatable, Sendable {
        case speaking, listening
    }

    /// Everything the pill reads, from one published state.
    public struct Input: Equatable, Sendable {
        public var sessions: [Session]
        /// Speaking or listening; nil while the voice is idle.
        public var voice: Voice?
        /// The session it is with (`row.active`).
        public var voiceSession: String?
        /// The daemon's live label: the session the voice is with, or last was.
        public var voiceLabel: String
        /// The words going by: what is being read aloud, up to where it has got, or what the mic is hearing.
        public var caption: String?
        /// Manual mode: conch reads nothing aloud and opens no mic by itself (the daemon's global pause).
        public var manual: Bool
        /// Speech or listening is running, so Talk is Stop.
        public var exchangeActive: Bool
        /// Another Mac or the phone has conch's audio: Talk can't open a mic here.
        public var audioElsewhere: Bool
        /// The daemon isn't publishing, in its own words, when it has some.
        public var daemonNote: String?

        public init(sessions: [Session] = [], voice: Voice? = nil, voiceSession: String? = nil, voiceLabel: String = "",
                    caption: String? = nil, manual: Bool = false, exchangeActive: Bool = false, audioElsewhere: Bool = false,
                    daemonNote: String? = nil) {
            self.sessions = sessions
            self.voice = voice
            self.voiceSession = voiceSession
            self.voiceLabel = voiceLabel
            self.caption = caption
            self.manual = manual
            self.exchangeActive = exchangeActive
            self.audioElsewhere = audioElsewhere
            self.daemonNote = daemonNote
        }

        /// What needs Tyler, most pressing first, then the longest waiting.
        public var needs: [Session] {
            sessions.filter { $0.need != nil }.sorted { ($0.need!, $0.at) < ($1.need!, $1.at) }
        }

        public var working: Int { sessions.filter(\.working).count }

        /// Who Talk opens the mic to: the session the voice is with; else one with a question waiting, the one to answer;
        /// else the one the voice was last with (the daemon keeps its label). Never a guess past that.
        public var talkTarget: Session? {
            if let id = voiceSession, let session = sessions.first(where: { $0.id == id }) { return session }
            if let asking = needs.first(where: { $0.need == .question }) { return asking }
            return voiceLabel.isEmpty ? nil : sessions.first { $0.label == voiceLabel }
        }

        /// Who the voice was last with, when it is idle: what a click on a pill with nothing waiting opens.
        public var lastVoice: Session? {
            if let id = voiceSession, let session = sessions.first(where: { $0.id == id }) { return session }
            return voiceLabel.isEmpty ? nil : sessions.first { $0.label == voiceLabel }
        }
    }

    /// What the pill draws, collapsed and expanded.
    public struct Face: Equatable, Sendable {
        /// The mark at its start.
        public enum Mark: Equatable, Sendable {
            /// The conch mark: nothing more pressing. Quieter in manual, as the menu bar's is.
            case conch(manual: Bool)
            case speaking, listening
            case need(Need)
        }

        /// The Talk button: open the mic to a session, stop what is running, or why it can't.
        public enum Talk: Equatable, Sendable {
            case talk(to: String)
            case stop(listening: Bool)
            case unavailable(String)

            public var help: String {
                switch self {
                case let .talk(label): "Talk to \(label)"
                case let .stop(listening): listening ? "Stop listening" : "Stop speaking"
                case let .unavailable(why): why
                }
            }
        }

        public let mark: Mark
        /// The session after the mark, collapsed: the voice's, else the most pressing need's. Nil is the mark alone.
        public let label: String?
        /// More sessions need Tyler than the one named: drawn as a second mark behind the first, said in the subtitle.
        public let more: Int
        /// Top-level sessions at work, as the sidebar's blue dot and a number.
        public let working: Int
        /// A need behind the voice: its mark, small, after the voice's session, so a session talking never hides it.
        public let needBehind: Need?
        public let manual: Bool
        /// Expanded: the first line, and the second when there is something to say.
        public let title: String
        public let subtitle: String?
        /// The second line is a need behind the voice ("api asks permission"), and so carries its mark and the chevron:
        /// the click goes there, not to the session named above it.
        public let subtitleNeed: Need?
        /// Whether the working count follows the title (not when the title is the count).
        public let countsWorking: Bool
        /// Where a click goes, for its chevron's colour: a need's, else nil (conch's window).
        public let opens: Need?
        public let talk: Talk

        /// The buttons it shows: Talk only when there is someone to talk to or something to stop. Off, it isn't there at
        /// all (a 30% mic read as a smudge); the second line says why when the voice is on another device.
        public var actions: [Action] {
            if case .unavailable = talk { return [.mode] }
            return [.talk, .mode]
        }

        /// Talk's reason when there is nobody to talk to yet.
        public static let nobody = "No session has spoken yet"

        /// The whole of it in one sentence, for VoiceOver and the tooltip.
        public var accessibility: String {
            var parts = [title]
            if let subtitle { parts.append(subtitle) }
            if countsWorking, working > 0 { parts.append("\(working) working") }
            if more > 0 { parts.append("\(more) more need\(more == 1 ? "s" : "") you") }
            if manual { parts.append("manual") }
            return "conch: " + parts.joined(separator: ", ")
        }
    }

    public static func face(_ input: Input) -> Face {
        let needs = input.needs
        let top = needs.first
        let working = input.working
        let voiceLabel = input.voiceLabel.isEmpty ? nil : input.voiceLabel

        // The one thing it leads with: the voice, because it is happening now (`VoiceState.resolve`'s order); else what
        // needs Tyler; else the conch mark.
        let mark: Face.Mark
        let label: String?
        let title: String
        var subtitle: String?
        var subtitleNeed: Need?
        if let voice = input.voice {
            mark = voice == .listening ? .listening : .speaking
            label = voiceLabel
            title = voiceLabel ?? (voice == .listening ? VoiceState.listening : VoiceState.speaking).title
            // What needs him first, never hidden by a session talking; else the words going by. Nothing at all rather
            // than "Speaking" under the orb that already says so.
            if let top, let need = top.need {
                subtitle = "\(top.label) \(need.aside(top.detail))"
                subtitleNeed = need
            } else {
                subtitle = input.caption.flatMap { tail($0) }
            }
        } else if let top, let need = top.need {
            mark = .need(need)
            label = top.label
            title = top.label
            subtitle = need.ask(top.detail)
        } else {
            mark = .conch(manual: input.manual)
            label = nil
            if working > 0 {
                title = "\(working) working"
                let names = input.sessions.filter(\.working).map(\.label)
                subtitle = names.prefix(2).joined(separator: ", ") + (names.count > 2 ? " and \(names.count - 2) more" : "")
            } else {
                title = input.daemonNote ?? "Nothing needs you"
                subtitle = nil
            }
        }

        let talk: Face.Talk
        if input.exchangeActive {
            talk = .stop(listening: input.voice == .listening)
        } else if input.audioElsewhere {
            talk = .unavailable("Your iPhone or another Mac has conch's voice")
        } else if let target = input.talkTarget {
            talk = .talk(to: target.label)
        } else {
            talk = .unavailable(Face.nobody)
        }
        // Why Talk is off, where there is room to say it.
        if input.audioElsewhere, subtitle == nil { subtitle = "The voice is on another device" }
        return Face(
            mark: mark,
            label: label,
            more: max(0, needs.count - 1),
            working: working,
            needBehind: input.voice != nil ? top?.need : nil,
            manual: input.manual,
            title: title,
            subtitle: subtitle,
            subtitleNeed: subtitleNeed,
            countsWorking: label != nil,
            opens: top?.need,
            talk: talk
        )
    }

    /// The end of a caption, at most `limit` characters, cut at a word: the words just said, never "…hree of".
    public static func tail(_ caption: String, limit: Int = 34) -> String? {
        let words = caption.split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return nil }
        var kept: [Substring] = []
        var length = 0
        for word in words.reversed() {
            let next = length + word.count + (kept.isEmpty ? 0 : 1)
            if next > limit, !kept.isEmpty { break }
            kept.insert(word, at: 0)
            length = next
        }
        let text = kept.joined(separator: " ")
        return kept.count < words.count ? "…" + text : text
    }

    /// What a click on the pill opens: the session that needs Tyler, else conch's window on the one the voice is with (or
    /// last was), else conch's window as it was. The pill's own click: there is no second button for it.
    public enum Open: Equatable, Sendable {
        /// Its next ready deliverable, by the menu's one opening rule.
        case ready(String)
        /// conch's window on the session: its permission or question is answered there.
        case session(String)
        case conch
    }

    public static func open(_ input: Input) -> Open {
        if let top = input.needs.first { return top.need == .ready ? .ready(top.id) : .session(top.id) }
        if let last = input.lastVoice { return .session(last.id) }
        return .conch
    }

    /// The expanded pill's buttons, in order. Opening conch is the pill's own click (`open`), not a third.
    public enum Action: CaseIterable, Sendable {
        /// Talk to the voice's session, or stop what is running.
        case talk
        /// Manual or auto, for every session.
        case mode
    }

    // MARK: Its measures

    public enum Metrics {
        /// Collapsed: as tall as a menu bar item's hit target, and as wide as its mark when nothing else is shown.
        public static let height: CGFloat = 30
        /// Expanded, for two lines.
        public static let expandedHeight: CGFloat = 46
        /// The mark, collapsed and expanded.
        public static let mark: CGFloat = 20
        public static let expandedMark: CGFloat = 26
        /// The buttons' height, the round ones' width, and the gap between them.
        public static let button: CGFloat = 28
        public static let buttonGap: CGFloat = 6
        /// The mode's switch: "Auto" and "Manual" side by side, the one it is in raised (the main window's words).
        public static let autoSegment: CGFloat = 40
        public static let manualSegment: CGFloat = 54
        public static let modeButton: CGFloat = autoSegment + manualSegment + 4
        public static let modeHeight: CGFloat = 24
        /// From the last button to the pill's end: its round end's own inset.
        public static let buttonInset: CGFloat = (expandedHeight - button) / 2
        /// Between the things the collapsed pill shows, and inside one (a dot and its number).
        public static let groupGap: CGFloat = 12
        public static let innerGap: CGFloat = 4
        /// Round the pill, inside its window: room for its shadow, which a window cut to the pill would clip.
        public static let shadowRoom: CGFloat = 10
        /// From the screen's edge to the pill.
        public static let edgeGap: CGFloat = 6
        /// The longest a name runs before it is cut short; and the expanded lines' one measure, whatever they say, so
        /// the buttons never move under the pointer as the words change.
        public static let label: CGFloat = 140
        public static let title: CGFloat = 200
    }

    /// A button's width: the mode's words, the others round.
    public static func width(of action: Action) -> CGFloat {
        action == .mode ? Metrics.modeButton : Metrics.button
    }

    /// A button's height: the mode's switch a touch shorter than Talk, so it reads as a setting beside an action.
    public static func height(of action: Action) -> CGFloat {
        action == .mode ? Metrics.modeHeight : Metrics.button
    }

    /// Where each of `actions` is in an expanded pill `size` big, y down from its top left: the last at the pill's end,
    /// the others before it. A press there is the button's; anywhere else on the pill is the pill's (a click, or a drag).
    public static func actionFrames(_ actions: [Action] = Action.allCases, in size: CGSize) -> [(action: Action, frame: CGRect)] {
        var x = size.width - Metrics.buttonInset
        var frames: [(action: Action, frame: CGRect)] = []
        for action in actions.reversed() {
            x -= width(of: action)
            let frame = CGRect(x: x, y: (size.height - height(of: action)) / 2, width: width(of: action), height: height(of: action))
            frames.insert((action, frame), at: 0)
            x -= Metrics.buttonGap
        }
        return frames
    }

    /// The button a press at `point` in an expanded pill `size` big lands on, if any: inside its capsule, give or take a
    /// point.
    public static func action(at point: CGPoint, in size: CGSize, actions: [Action] = Action.allCases) -> Action? {
        actionFrames(actions, in: size).first { entry in
            let radius = entry.frame.height / 2
            let core = entry.frame.insetBy(dx: radius, dy: radius)
            let nearest = CGPoint(x: min(max(point.x, core.minX), core.maxX), y: min(max(point.y, core.minY), core.maxY))
            return hypot(point.x - nearest.x, point.y - nearest.y) <= radius + 1
        }?.action
    }

    // MARK: Where it sits

    public enum Edge: String, Codable, CaseIterable, Sendable {
        case top, bottom, left, right
    }

    /// Where the pill is docked: an edge, how far along it its middle is (0 to 1: left to right, bottom to top), and which
    /// display. Persisted as JSON under `dockKey`.
    public struct Dock: Codable, Equatable, Sendable {
        public var edge: Edge
        public var along: Double
        /// The display's id (`CGDirectDisplayID`) as a string; nil, or one that isn't connected, is the main display.
        public var display: String?

        public init(edge: Edge, along: Double, display: String? = nil) {
            self.edge = edge
            self.along = min(max(along, 0), 1)
            self.display = display
        }
    }

    public static let dockKey = "conch.floatingPill.dock"
    /// Under the middle of the menu bar, where a notch is: the place a Mac already shows what is live.
    public static let defaultDock = Dock(edge: .top, along: 0.5)

    /// The pill's frame, `size` big, docked in `visible` (a screen's visible frame, y up): `edgeGap` in from its edge,
    /// its middle `along` it, and never past either end.
    public static func frame(size: CGSize, dock: Dock, in visible: CGRect) -> CGRect {
        let gap = Metrics.edgeGap
        func clamp(_ value: CGFloat, _ low: CGFloat, _ high: CGFloat) -> CGFloat { high < low ? (low + high) / 2 : min(max(value, low), high) }
        switch dock.edge {
        case .top, .bottom:
            let x = clamp(visible.minX + dock.along * visible.width - size.width / 2, visible.minX + gap, visible.maxX - gap - size.width)
            let y = dock.edge == .top ? visible.maxY - gap - size.height : visible.minY + gap
            return CGRect(x: x, y: y, width: size.width, height: size.height)
        case .left, .right:
            let y = clamp(visible.minY + dock.along * visible.height - size.height / 2, visible.minY + gap, visible.maxY - gap - size.height)
            let x = dock.edge == .left ? visible.minX + gap : visible.maxX - gap - size.width
            return CGRect(x: x, y: y, width: size.width, height: size.height)
        }
    }

    /// Where a pill let go of at `frame` docks in `visible`: the edge its middle is nearest, at the place along it.
    public static func dock(droppedAt frame: CGRect, in visible: CGRect, display: String? = nil) -> Dock {
        let x = frame.midX, y = frame.midY
        let distances: [(Edge, CGFloat)] = [
            (.top, visible.maxY - y), (.bottom, y - visible.minY), (.left, x - visible.minX), (.right, visible.maxX - x),
        ]
        let edge = distances.min { $0.1 < $1.1 }!.0
        let along = edge == .top || edge == .bottom
            ? (x - visible.minX) / max(visible.width, 1)
            : (y - visible.minY) / max(visible.height, 1)
        return Dock(edge: edge, along: Double(along), display: display)
    }

    /// From one size to the next: the window, big enough for both pills and their shadow, and where each pill sits in it,
    /// y down from its top left. The window takes the union at once and the pill moves within it, so it grows out of, and
    /// shrinks back into, exactly where it is; the window settles to the new pill once it has.
    public static func transition(from: CGRect, to: CGRect) -> (window: CGRect, from: CGRect, to: CGRect) {
        let window = from.union(to).insetBy(dx: -Metrics.shadowRoom, dy: -Metrics.shadowRoom)
        func local(_ rect: CGRect) -> CGRect {
            CGRect(x: rect.minX - window.minX, y: window.maxY - rect.maxY, width: rect.width, height: rect.height)
        }
        return (window, local(from), local(to))
    }

    // MARK: Its timing

    /// The pointer resting on the pill this long opens it: long enough that crossing it on the way somewhere doesn't.
    public static let hoverDelay: TimeInterval = 0.25
    /// And gone this long closes it, so a pointer slipping off its edge doesn't snap it shut.
    public static let leaveDelay: TimeInterval = 0.45
    /// A press that moves this far is a drag, not a click.
    public static let dragThreshold: CGFloat = 3
}

// MARK: - The view

/// The pill as `FloatingPill.face` says, collapsed or expanded. Its own size: the Mac's window is fitted round it.
/// `hovered` and `pressed` are what is under the pointer and held down, which the Mac's window knows: SwiftUI in a panel
/// of an app that isn't active can't be relied on to.
public struct FloatingPillView: View {
    /// Part of the pill: itself (its click, or a drag), or one of its buttons.
    public enum Target: Equatable, Sendable {
        case pill
        case action(FloatingPill.Action)
    }

    let face: FloatingPill.Face
    let expanded: Bool
    let hovered: Target?
    let pressed: Target?
    let onAction: (FloatingPill.Action) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    public init(face: FloatingPill.Face, expanded: Bool = false, hovered: Target? = nil, pressed: Target? = nil,
                onAction: @escaping (FloatingPill.Action) -> Void = { _ in }) {
        self.face = face
        self.expanded = expanded
        self.hovered = hovered
        self.pressed = pressed
        self.onAction = onAction
    }

    private typealias M = FloatingPill.Metrics

    private var height: CGFloat { expanded ? M.expandedHeight : M.height }

    public var body: some View {
        HStack(spacing: 0) {
            PillMark(mark: face.mark, more: face.more > 0, size: expanded ? M.expandedMark : M.mark, lit: hovered != nil)
                .frame(width: height, height: height)
            if expanded {
                expandedContent
            } else {
                collapsedContent
            }
        }
        .frame(height: height)
        .fixedSize()
        .modifier(PillGlass())
        // A press settles it in a touch, on the pop spring.
        .scaleEffect(pressed == .pill ? 0.97 : 1)
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: pressed)
        // The voice's colour takes over on its own spring; Reduce Motion drops the bounce.
        .animation(ConchMotion.voiceColour.animation(reduceMotion: reduceMotion), value: face.mark)
        .accessibilityElement(children: expanded ? .contain : .ignore)
        .accessibilityLabel(face.accessibility)
        .accessibilityAddTraits(.isButton)
    }

    // MARK: Collapsed

    @ViewBuilder private var collapsedContent: some View {
        if face.label != nil || face.working > 0 || face.manual {
            HStack(spacing: M.groupGap) {
                if let label = face.label {
                    AtMost(width: M.label) {
                        Text(label)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(ConchColor.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                if face.working > 0 { WorkingCount(count: face.working) }
                if face.manual { ManualMark() }
                // A need behind the voice, set apart at the end behind a hairline: it is another session's, not the one
                // named at the start.
                if let need = face.needBehind {
                    HStack(spacing: 8) {
                        Rectangle().fill(ConchColor.hairlineStrong).frame(width: 1, height: 14)
                        NeedMark(need: need, size: 14)
                    }
                }
            }
            .padding(.leading, face.label == nil ? 0 : 1)
            .padding(.trailing, 12)
            .transition(.opacity)
        }
    }

    // MARK: Expanded

    private var expandedContent: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    // "3 working" keeps the dot the collapsed count has.
                    if !face.countsWorking, face.working > 0, face.mark == .conch(manual: face.manual) { ActiveMark(pointSize: 7) }
                    Text(face.title)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(ConchColor.textPrimary)
                        .truncationMode(.tail)
                        .layoutPriority(1)
                    if face.countsWorking, face.working > 0 { WorkingCount(count: face.working).padding(.leading, 6) }
                    if face.subtitleNeed == nil { chevron }
                }
                if let subtitle = face.subtitle {
                    HStack(spacing: 4) {
                        // A need behind the voice: its own line, with its mark and the chevron, since the click goes there.
                        if let need = face.subtitleNeed { NeedMark(need: need, size: 11) }
                        Text(subtitle)
                            .font(.system(size: 11))
                            .foregroundStyle(ConchColor.textSecondary)
                            .truncationMode(.tail)
                        if face.subtitleNeed != nil { chevron }
                    }
                    .transition(.opacity)
                }
            }
            .lineLimit(1)
            // One measure whatever the words say, so the buttons never move under the pointer as they change; without
            // Talk the words take its room, so the pill is one width either way.
            .frame(width: M.title + (face.actions.contains(.talk) ? 0 : M.button + M.buttonGap), alignment: .leading)
            .padding(.leading, 2)
            .padding(.trailing, 12)
            HStack(spacing: M.buttonGap) {
                if face.actions.contains(.talk) { talkButton }
                ModeSwitch(manual: face.manual, lit: hovered == .action(.mode), pressed: pressed == .action(.mode)) { onAction(.mode) }
            }
            .padding(.trailing, M.buttonInset)
        }
        .animation(ConchMotion.appearance.animation(reduceMotion: reduceMotion), value: face.subtitle)
        .transition(.opacity)
    }

    /// Says the pill's click opens something, in a need's colour when that is where it goes, and nudges on hover.
    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(chevronInk)
            .offset(x: hovered == .pill && !reduceMotion ? 2 : 0)
            .animation(ConchMotion.hover.animation(reduceMotion: reduceMotion), value: hovered == .pill)
    }

    private var chevronInk: AnyShapeStyle {
        if let need = face.opens { return AnyShapeStyle(need.colour) }
        return AnyShapeStyle(hovered == .pill ? ConchColor.textPrimary : ConchColor.textTertiary)
    }

    private var talkButton: some View {
        let symbol: String
        var enabled = true
        switch face.talk {
        case .talk: symbol = "mic.fill"
        case .stop: symbol = "stop.fill"
        case .unavailable: symbol = "mic.fill"; enabled = false
        }
        let lit = enabled && (hovered == .action(.talk) || pressed == .action(.talk))
        return Button { onAction(.talk) } label: {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(ConchColor.textPrimary)
                .frame(width: M.button, height: M.button)
                .background(Circle().fill(PillInk.button(lit: lit, dark: scheme == .dark)))
                .contentShape(Circle())
                .scaleEffect(enabled && pressed == .action(.talk) ? 0.97 : 1)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.3)
        .help(face.talk.help)
        .accessibilityLabel(face.talk.help)
    }
}

/// The fills the pill's controls take, resting and lit: a step either side of the glass that holds in both schemes.
private enum PillInk {
    static func button(lit: Bool, dark: Bool) -> Color {
        dark ? .white.opacity(lit ? 0.24 : 0.1) : .black.opacity(lit ? 0.14 : 0.06)
    }
}

/// The mark at the pill's start, `size` across: the conch mark, the voice, or a need, with a second of it peeking from
/// behind when more than one session needs Tyler.
private struct PillMark: View {
    let mark: FloatingPill.Face.Mark
    let more: Bool
    let size: CGFloat
    /// The pointer is over the pill: the resting conch mark comes up to full ink.
    let lit: Bool
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        switch mark {
        case let .conch(manual):
            PillConchMark(ink: manual ? ConchColor.textTertiary : (lit ? ConchColor.textPrimary : ConchColor.textSecondary))
        case .speaking:
            // A dark disc in both schemes: on a dark pill the light one was the loudest thing there, louder than a need.
            ZStack {
                Circle().fill(scheme == .dark ? Color(white: 0.3) : Color(red: 0.114, green: 0.114, blue: 0.122))
                VoiceGlyph(.speaking, size: size * 0.6).foregroundStyle(.white)
            }
            .frame(width: size, height: size)
            .accessibilityLabel(VoiceState.speaking.title)
        case .listening:
            // Listening's orange, the mic on it dark (white on #FF9F0A measures 2.06; this 8.19), a size up from the
            // orb's so it reads at 1x. No halo: in a still frame it was a smudge.
            ZStack {
                Circle().fill(ConchColor.listening)
                Image(systemName: "mic.fill")
                    .font(.system(size: size * 0.5, weight: .semibold))
                    .foregroundStyle(VoiceOrb.onListening.color)
            }
            .frame(width: size, height: size)
            .accessibilityLabel(VoiceState.listening.title)
        case let .need(need):
            ZStack {
                if more {
                    // Another one waiting, behind: a smaller, lighter disc tucked up to the right inside the mark's own
                    // room, so the name doesn't move, with a ring of glass round the front one so the two read as two.
                    NeedMark(need: need, size: size * 0.65, glyph: false)
                        .opacity(0.55)
                        .offset(x: size * 0.4, y: -size * 0.24)
                    Circle()
                        .frame(width: size + 4, height: size + 4)
                        .blendMode(.destinationOut)
                }
                NeedMark(need: need, size: size)
            }
            .compositingGroup()
            .frame(width: size, height: size)
        }
    }
}

/// A need's mark: ready's check on its green, as the orb draws Ready, or a permission's or a question's "!" on the needs
/// red. Both in their light values in light and dark, as ready's disc is: white on #CA321B measures 5.3:1, on the dark
/// scheme's #FF6A55 2.9.
private struct NeedMark: View {
    let need: FloatingPill.Need
    let size: CGFloat
    var glyph = true

    var body: some View {
        ZStack {
            Circle().fill((need == .ready ? ConchColor.ready : ConchColor.attention).light.color)
            if glyph {
                Image(systemName: need == .ready ? "checkmark" : "exclamationmark")
                    .font(.system(size: size * 0.5, weight: .heavy))
                    .foregroundStyle(ConchColor.onVoice)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(need == .permission ? "Asks permission" : need == .question ? "Has a question" : VoiceState.ready.title)
    }
}

/// How many sessions are working: the sidebar's working dot, breathing, and the number in the label's ink.
private struct WorkingCount: View {
    let count: Int

    var body: some View {
        HStack(spacing: FloatingPill.Metrics.innerGap) {
            ActiveMark(pointSize: 7)
            Text("\(count)")
                .font(.system(size: 12, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(ConchColor.textSecondary)
        }
        .accessibilityElement()
        .accessibilityLabel("\(count) working")
    }
}

/// Manual mode, collapsed: the slashed speaker the mode switch shows beside "Manual".
private struct ManualMark: View {
    var body: some View {
        Image(systemName: "speaker.slash.fill")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ConchColor.textSecondary)
            .accessibilityLabel("Manual")
    }
}

/// Auto and Manual side by side, the mode it is in raised: one look says which it is and that it switches. A click
/// anywhere on it switches every session to the other, as the menu bar's Talk and Quiet do.
private struct ModeSwitch: View {
    let manual: Bool
    let lit: Bool
    let pressed: Bool
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    private typealias M = FloatingPill.Metrics

    var body: some View {
        Button(action: action) {
            HStack(spacing: 0) {
                segment("Auto", width: M.autoSegment, on: !manual)
                segment("Manual", width: M.manualSegment, on: manual)
            }
            .padding(2)
            .background(Capsule().fill(PillInk.button(lit: lit, dark: scheme == .dark)))
            .contentShape(Capsule())
            .scaleEffect(pressed ? 0.97 : 1)
        }
        .buttonStyle(.plain)
        .help(manual
              ? "Manual: finished turns wait for you. Click to switch every session to auto."
              : "Auto: conch reads finished turns aloud and opens the mic itself. Click to switch every session to manual.")
        .accessibilityLabel("Mode")
        .accessibilityValue(manual ? "Manual" : "Auto")
    }

    private func segment(_ words: String, width: CGFloat, on: Bool) -> some View {
        Text(words)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(on ? ConchColor.textPrimary : ConchColor.textSecondary)
            .frame(width: width, height: M.modeHeight - 4)
            .background {
                if on { Capsule().fill(scheme == .dark ? Color.white.opacity(0.2) : Color.white.opacity(0.85)) }
            }
    }
}

/// The conch mark at the menu bar's 18 points, in `ink`. On the Mac it is the status item's own image, drawn for each
/// backing scale rather than scaled (`ConchMark.statusImage`), so it is as crisp at 1x as at 2x; the phone draws the shape.
private struct PillConchMark: View {
    let ink: ConchColorToken

    var body: some View {
        Group {
            #if os(macOS)
            Image(nsImage: ConchMark.statusImage(for: .talk))
                .renderingMode(.template)
                .foregroundStyle(ink)
            #else
            ConchMark(state: .talk).fill(ink)
            #endif
        }
        .frame(width: ConchMark.side, height: ConchMark.side)
        .accessibilityLabel("conch")
    }
}

/// Its child at its own width, but never wider than `width`, where it truncates: a long session name stops at the
/// pill's measure rather than stretching it across the screen.
private struct AtMost: Layout {
    let width: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let ideal = child.sizeThatFits(.unspecified)
        return child.sizeThatFits(ProposedViewSize(width: min(ideal.width, width, proposal.width ?? .infinity), height: proposal.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}

/// The pill's glass: Liquid Glass where there is some (macOS 26), over a wash dense enough to read 12-point words on
/// whatever is behind it; the design system's glass over the system blur below that; and the glass token alone in a
/// picture, which can draw neither. A hairline round it, and a soft shadow under it.
private struct PillGlass: ViewModifier {
    @Environment(\.conchRendersStatically) private var rendersStatically
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let shape = Capsule()
        Group {
            if rendersStatically {
                content.background(shape.fill(ConchColor.glass))
            } else if #available(macOS 26.0, iOS 26.0, *) {
                content
                    .background(shape.fill(ConchColor.glass.opacity(0.6)))
                    .glassEffect(.regular, in: shape)
            } else {
                content.background {
                    ZStack {
                        shape.fill(.ultraThinMaterial)
                        shape.fill(ConchColor.glass)
                    }
                }
            }
        }
        .clipShape(shape)
        .overlay(shape.strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
        .shadow(color: .black.opacity(scheme == .dark ? 0.5 : 0.18), radius: 6, y: 2)
    }
}
