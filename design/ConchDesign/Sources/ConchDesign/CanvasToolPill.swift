import CoreGraphics
import SwiftUI

/// The canvas's tools (panel-lab's `#tools`): pen, highlight, arrow, box and note, then undo, Show and ×, then Send and,
/// while the pen is down, Done, in a small glass pill beside the conversation panel while the canvas is in use. With the
/// pen down (`armed`) the tool in hand is picked out; up, with ink still showing, none is, and picking one puts the pen
/// down again. It says what became of a Send on itself (`Notice`) — "Sent to …", or why not and where the picture is —
/// and what Screen Recording still needs; and an agent's marks alone raise only a chip to clear them (`Mode.agentChip`),
/// never the tools.
public struct CanvasToolPill: View {
    /// Each tool: its mark, its symbol, what it is called, and the number key that picks it.
    public static let tools: [(kind: CanvasMark.Kind, symbol: String, label: String, key: Character)] = [
        (.pen, "pencil", "Pen", "1"),
        (.highlight, "highlighter", "Highlight", "2"),
        (.arrow, "arrow.up.right", "Arrow", "3"),
        (.box, "rectangle", "Box", "4"),
        (.note, "text.bubble", "Note", "5"),
    ]

    let mode: Mode
    let hangs: Bool
    let tool: CanvasMark.Kind
    let armed: Bool
    let canUndo: Bool
    let canSend: Bool
    let sending: Bool
    /// Where Send goes, and whether conch is sure of it.
    let route: Route?
    /// Every session Send could go to, most likely first, for its menu.
    let destinations: [Destination]
    /// Send's menu, while it is open.
    let routeMenu: RouteMenu?
    /// What the pill says, until the next thing happens.
    let notice: Notice?
    let onTool: (CanvasMark.Kind) -> Void
    let onUndo: () -> Void
    let onSend: () -> Void
    let onRouteMenu: (RouteMenu?) -> Void
    let onPick: (Destination.ID) -> Void
    let onNotice: (Notice.Action) -> Void
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
    /// Done: the pen up, the ink kept. Nil, and no Done, while the pen is up.
    let onDone: (() -> Void)?
    /// Whose the agent's marks are, for the chip: "Claude", "Codex".
    let agent: String
    /// An agent's marks conch couldn't place here, said on the chip.
    let missed: AgentInk.Missed?
    let onClearAgent: () -> Void
    @Namespace private var picked
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// What it showed last, for it to sink as it was rather than as nothing.
    @State private var lastShown: Mode = .tools

    public init(
        mode: Mode = .tools,
        hangs: Bool = false,
        tool: CanvasMark.Kind,
        armed: Bool,
        canUndo: Bool,
        canSend: Bool,
        sending: Bool = false,
        route: Route?,
        destinations: [Destination] = [],
        routeMenu: RouteMenu? = nil,
        notice: Notice? = nil,
        onTool: @escaping (CanvasMark.Kind) -> Void,
        onUndo: @escaping () -> Void,
        onSend: @escaping () -> Void,
        onRouteMenu: @escaping (RouteMenu?) -> Void = { _ in },
        onPick: @escaping (Destination.ID) -> Void = { _ in },
        onNotice: @escaping (Notice.Action) -> Void = { _ in },
        recording: Recording? = nil,
        onShow: (() -> Void)? = nil,
        narrate: Bool = false,
        onNarrate: (() -> Void)? = nil,
        onDiscard: (() -> Void)? = nil,
        onDone: (() -> Void)? = nil,
        agent: String = "Claude",
        missed: AgentInk.Missed? = nil,
        onClearAgent: @escaping () -> Void = {}
    ) {
        self.mode = mode
        self.hangs = hangs
        self.tool = tool
        self.armed = armed
        self.canUndo = canUndo
        self.canSend = canSend
        self.sending = sending
        self.route = route
        self.destinations = destinations
        self.routeMenu = routeMenu
        self.notice = notice
        self.onTool = onTool
        self.onUndo = onUndo
        self.onSend = onSend
        self.onRouteMenu = onRouteMenu
        self.onPick = onPick
        self.onNotice = onNotice
        self.recording = recording
        self.onShow = onShow
        self.narrate = narrate
        self.onNarrate = onNarrate
        self.onDiscard = onDiscard
        self.onDone = onDone
        self.agent = agent
        self.missed = missed
        self.onClearAgent = onClearAgent
    }

    static let buttonSize: CGFloat = 32

    /// What is on it while it shows; while it sinks, what it showed last.
    private var showing: Mode { mode == .hidden ? lastShown : mode }

    public var body: some View {
        let shown = mode != .hidden
        VStack(spacing: ConchSpace.x2) {
            if !hangs { said }
            switch showing {
            case .tools, .hidden: row
            case .agentChip: agentChip
            case .notice: EmptyView()
            }
            if hangs { said }
        }
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: notice)
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: routeMenu)
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: showing)
        // Rises out of the panel's edge on the pop spring (panel-lab: translateY(10px) scale(.9) blur(4px)), or drops from
        // what it hangs from; under Reduce Motion it only fades.
        .opacity(shown ? 1 : 0)
        .scaleEffect(shown || reduceMotion ? 1 : 0.9, anchor: hangs ? .top : .bottom)
        .offset(y: shown || reduceMotion ? 0 : hangs ? -10 : 10)
        .blur(radius: shown || reduceMotion ? 0 : 4)
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: shown)
        .allowsHitTesting(shown)
        .onChange(of: mode, initial: true) { _, mode in if mode != .hidden { lastShown = mode } }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Canvas")
    }

    /// What the pill says and Send's menu, on the side away from what it rises out of or hangs from.
    @ViewBuilder private var said: some View {
        if let routeMenu, showing == .tools { routes(routeMenu) }
        if let notice { say(notice) }
    }

    /// What changes the row's width: the × coming and going, Done, where Send goes, the timer. Each change springs on `pop`
    /// in a window wider than the row (`CanvasPillPlacement`), so the pill grows from its middle rather than jumping
    /// sideways, as it did when the first mark brought the × in.
    private struct Width: Equatable {
        let discard: Bool
        let done: Bool
        let route: Route?
        let recording: Recording?
        let sending: Bool
    }

    private var row: some View {
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
            done
        }
        .padding(5)
        .background(glass(RoundedRectangle(cornerRadius: 18, style: .continuous)))
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: tool)
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: armed)
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: Width(discard: onDiscard != nil, done: onDone != nil, route: route, recording: recording, sending: sending))
    }

    private var separator: some View {
        Rectangle().fill(ConchColor.overlayLine).frame(width: 0.5, height: 20).padding(.horizontal, 4)
    }

    /// Comes and goes on the pop spring, from its own middle.
    private var popIn: AnyTransition {
        reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity)
    }

    /// The ×, with something to throw away: the pen up, the one way to, since the keys are the app underneath's again.
    /// Nothing it clears is ever sent.
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
            .help(recording != nil ? "Delete the recording (nothing is sent)" : "Clear marks (nothing is sent)")
            .accessibilityLabel(recording != nil ? "Delete the recording" : "Clear marks")
            .transition(popIn)
        }
    }

    /// Done: the pen comes up and the ink stays, as Esc does; the pill's own way, beside the panel's pen.
    @ViewBuilder private var done: some View {
        if let onDone {
            Button(action: onDone) {
                Text("Done")
                    .font(ConchType.uiEmphasis)
                    .foregroundStyle(ConchColor.overlayText)
                    .padding(.horizontal, 10)
                    .frame(height: Self.buttonSize)
                    .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .help("Done drawing (Esc): the pen comes up, your marks stay")
            .accessibilityLabel("Done drawing")
            .transition(popIn)
        }
    }

    /// Send, in Tyler's ink colour, naming where it goes. The name is itself a menu that only changes where (the ink stays);
    /// a guess — conch not sure whose the screen is — reads "Send to…" and asks rather than sending.
    private var send: some View {
        let asks = route?.sure == false
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return HStack(spacing: 0) {
            Button(action: asks ? { onRouteMenu(routeMenu == .sendTo ? nil : .sendTo) } : onSend) {
                HStack(spacing: 6) {
                    if sending {
                        ProgressView().controlSize(.small).tint(CanvasInk.onYou.color)
                    } else {
                        Image(systemName: "arrow.up").font(.system(size: 12, weight: .bold))
                    }
                    Text(asks ? "Send to…" : "Send").font(ConchType.uiEmphasis)
                }
                .padding(.leading, 10)
                .padding(.trailing, asks || route == nil ? 12 : 6)
                .frame(height: Self.buttonSize)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(asks ? "Send to… (Return): conch isn't sure whose this is, so it asks" : route.map { "Send to \($0.label) (Return)" } ?? "Send (Return)")
            .accessibilityLabel(asks ? "Send to" : route.map { "Send to \($0.label)" } ?? "Send")
            if let route, !asks {
                Button { onRouteMenu(routeMenu == .change ? nil : .change) } label: {
                    HStack(spacing: 3) {
                        Text(route.label)
                            .font(ConchType.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(maxWidth: 140, alignment: .leading)
                        Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
                    }
                    // 85% of the ink's own text colour still clears 4.5:1 on the orange (CanvasPillTests).
                    .opacity(Self.routeOpacity)
                    .padding(.trailing, 12)
                    .frame(height: Self.buttonSize)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(sending)
                .help("Where Send goes. Pick another session: your marks stay.")
                .accessibilityLabel("Where Send goes: \(route.label)")
            }
        }
        .foregroundStyle(CanvasInk.onYou.color)
        .background(shape.fill(CanvasInk.you.color))
        .clipShape(shape)
        .disabled(!canSend || sending)
        .opacity(canSend || sending ? 1 : 0.4)
    }

    /// How far the route's name is faded against Send's own word.
    public static let routeOpacity = 0.85

    /// Send's menu: every session, most likely first, the one it goes to ticked. Picking one from the name only changes
    /// where; from "Send to…" it sends there.
    private func routes(_ menu: RouteMenu) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(menu == .sendTo ? "Send to" : "Send goes to")
                .font(ConchType.meta)
                .foregroundStyle(ConchColor.overlayTextSecondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
            ForEach(destinations) { each in
                Button { onPick(each.id) } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark")
                            .font(.system(size: 10, weight: .bold))
                            .opacity(each.id == route?.id && menu == .change ? 1 : 0)
                        Text(each.label).font(ConchType.uiBody).lineLimit(1).truncationMode(.tail)
                        Spacer(minLength: ConchSpace.x3)
                        if let why = each.why {
                            Text(why).font(ConchType.secondary).foregroundStyle(ConchColor.overlayTextSecondary)
                        }
                    }
                    .foregroundStyle(ConchColor.overlayText)
                    .padding(.horizontal, 8)
                    .frame(height: 28)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(each.id == route?.id ? .isSelected : [])
            }
        }
        .padding(5)
        .frame(width: 280)
        .background(glass(RoundedRectangle(cornerRadius: 12, style: .continuous)))
        .transition(reduceMotion ? .opacity : .scale(scale: 0.94, anchor: hangs ? .top : .bottom).combined(with: .opacity))
    }

    /// A notice: its words, and what can be done about it there and then, the first way picked out.
    private func say(_ notice: Notice) -> some View {
        VStack(spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if notice.tone == .done {
                    Image(systemName: "checkmark").font(.system(size: 11, weight: .bold))
                }
                Text(notice.text)
                    .font(ConchType.secondary)
                    .multilineTextAlignment(.center)
                    .frame(width: notice.text.count > Self.oneLine ? Self.noticeWidth : nil)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(ConchColor.overlayText)
            if !notice.actions.isEmpty {
                HStack(spacing: 6) {
                    ForEach(Array(notice.actions.enumerated()), id: \.element) { index, action in
                        Button { onNotice(action) } label: {
                            Text(action.title)
                                .font(ConchType.secondary.weight(.semibold))
                                .foregroundStyle(index == 0 ? ConchColor.onAccent : ConchColor.overlayText)
                                .padding(.horizontal, 10)
                                .frame(height: 24)
                                .background(Capsule().fill(index == 0 ? AnyShapeStyle(ConchColor.accent) : AnyShapeStyle(ConchColor.overlayFillStrong)))
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.horizontal, ConchSpace.x3)
        .padding(.vertical, 7)
        .background(glass(RoundedRectangle(cornerRadius: 12, style: .continuous)))
        .transition(reduceMotion ? .opacity : .scale(scale: 0.9, anchor: hangs ? .top : .bottom).combined(with: .opacity))
    }

    /// Past this many characters a notice wraps, at `noticeWidth`.
    static let oneLine = 44
    static let noticeWidth: CGFloat = 320

    /// An agent's marks with none of Tyler's: a chip to clear them, and what couldn't be shown here.
    private var agentChip: some View {
        VStack(spacing: 2) {
            Button(action: onClearAgent) {
                HStack(spacing: 6) {
                    Circle().fill(CanvasInk.agent.color).frame(width: 7, height: 7)
                    Text("Clear marks").font(ConchType.uiEmphasis)
                    Image(systemName: "xmark").font(.system(size: 10, weight: .bold))
                }
                .foregroundStyle(ConchColor.overlayText)
                .padding(.horizontal, 12)
                .frame(height: 30)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .help("Clear \(agent)'s marks (nothing is sent)")
            .accessibilityLabel("Clear \(agent)'s marks")
            if let missed {
                Text(missed.text)
                    .font(ConchType.secondary)
                    .foregroundStyle(ConchColor.overlayText)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
                    .help(missed.help)
                    .accessibilityHint(missed.help)
            }
        }
        .padding(2)
        .background(glass(RoundedRectangle(cornerRadius: 17, style: .continuous)))
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

// MARK: - What it shows

extension CanvasToolPill {
    /// What the pill is: the tools, an agent's chip, only something said, or nothing.
    public enum Mode: Equatable, Sendable {
        /// Sunk: nothing in use and nothing to say.
        case hidden
        /// The tools: the pen down, Tyler's ink up, or a Show.
        case tools
        /// An agent's marks and none of Tyler's: the chip that clears them, and never the tools, which drawing puts up.
        case agentChip
        /// Only a notice: a Send that went ("Sent to …"), or what a Show with no ink needs.
        case notice
    }

    /// The pill for the canvas's state. The tools while the pen is down, Tyler has ink up or there is a Show; an agent's
    /// marks alone, the chip; else whatever it has to say — so a notice keeps it up, however it came (it hid with the
    /// "Show needs Screen Recording" still on it); else nothing.
    public static func mode(armed: Bool, yourInk: Bool, agentInk: Bool, show: Bool, notice: Bool) -> Mode {
        if armed || yourInk || show { return .tools }
        if agentInk { return .agentChip }
        return notice ? .notice : .hidden
    }

    /// Where Send goes: a session, and whether conch is sure it is the one (`CanvasRouting`).
    public struct Route: Equatable, Sendable {
        public let id: String
        public let label: String
        /// conch staged what is on screen, it is a held deliverable's link or the session's own terminal, or Tyler picked
        /// it. Not sure, Send asks (`RouteMenu.sendTo`) rather than sending to a guess.
        public let sure: Bool

        public init(id: String, label: String, sure: Bool) {
            self.id = id
            self.label = label
            self.sure = sure
        }
    }

    /// A session in Send's menu.
    public struct Destination: Identifiable, Equatable, Sendable {
        public let id: String
        public let label: String
        /// Why it is near the top: "on screen", "in the panel".
        public let why: String?

        public init(id: String, label: String, why: String? = nil) {
            self.id = id
            self.label = label
            self.why = why
        }
    }

    /// Send's menu, open: from the route's name, to change only where it goes; from "Send to…", to send there.
    public enum RouteMenu: Equatable, Sendable {
        case change, sendTo
    }

    /// What the pill says, and what can be done about it there and then.
    public struct Notice: Equatable, Sendable {
        public enum Tone: Equatable, Sendable {
            case plain
            /// It went: a tick.
            case done
        }

        public enum Action: String, CaseIterable, Sendable {
            case openSettings, sendMarksOnly, reopen, showInFinder

            public var title: String {
                switch self {
                case .openSettings: "Open Settings"
                case .sendMarksOnly: "Send marks only"
                case .reopen: "Reopen conch"
                case .showInFinder: "Show in Finder"
                }
            }
        }

        public let text: String
        public let tone: Tone
        public let actions: [Action]

        public init(_ text: String, tone: Tone = .plain, actions: [Action] = []) {
            self.text = text
            self.tone = tone
            self.actions = actions
        }
    }
}

// MARK: - The words

extension CanvasToolPill.Notice {
    /// Send or Show without the Screen Recording grant. Nothing goes, and nothing records, without saying so: a Send
    /// used to go quietly as the marks alone — the agent was told, Tyler wasn't — and Show's word was on a pill it had
    /// just hidden. With ink, the marks alone are one press away.
    public static func noScreen(marks: Bool) -> Self {
        Self("conch can't see your screen yet.", actions: marks ? [.openSettings, .sendMarksOnly] : [.openSettings])
    }

    /// Once System Settings is open: macOS gives a running app the grant only when it opens again.
    public static func reopen(marks: Bool) -> Self {
        Self("Turn conch on in Screen Recording, then reopen conch to finish.", actions: marks ? [.reopen, .sendMarksOnly] : [.reopen])
    }

    /// Reopening didn't happen.
    public static let reopenFailed = Self("Couldn't reopen conch. Quit it from the menu bar and open it again.")

    /// A Send the daemon took: on the pill for a moment, then it sinks.
    public static func sent(to label: String) -> Self {
        Self("Sent to \(label)", tone: .done)
    }

    /// How long "Sent to …" stays.
    public static let sentFor: Duration = .milliseconds(1500)

    public static let nowhere = Self("Nothing to send this to: no session owns what is on screen, and the panel has none.")

    /// A Send that didn't land: why, in the daemon's own words (`ConchSendFailure`, the one table both apps read), and that
    /// nothing was lost. `sentence` is the daemon's; nil when the daemon never answered at all.
    public static func notSent(to label: String, sentence: String?, kept: String = "Your marks are still here.") -> Self {
        let why: String?
        if let sentence { why = reason(in: sentence) } else { why = "conch isn't answering." }
        return Self(why.map { "Not sent to \(label): \($0) \(kept)" } ?? "Not sent to \(label). \(kept)", actions: [.showInFinder])
    }

    /// The reason in a failure's sentence ("Not delivered — a dialog is open…"), as the rest of a sentence of the pill's
    /// own; nil for one conch has no reason for ("Not delivered."). The clipboard's line goes: the message the Mac kept
    /// there is the prompt, and the marks are back on screen.
    static func reason(in sentence: String) -> String? {
        let bare = ConchSendFailure.sentence(reason: nil)
        let opening = bare.hasSuffix(".") ? String(bare.dropLast()) + " — " : bare + " — "
        guard sentence.hasPrefix(opening) else { return nil }
        var clause = String(sentence.dropFirst(opening.count))
        let clipboard = ConchSendFailure.sentence(reason: nil, onClipboard: true).dropFirst(bare.count)
        if clause.hasSuffix(clipboard) { clause = String(clause.dropLast(clipboard.count)) }
        clause = clause.trimmingCharacters(in: .whitespaces)
        guard !clause.isEmpty else { return nil }
        return clause.hasSuffix(".") ? clause : clause + "."
    }

    /// The picture couldn't be written.
    public static let noPicture = Self("Couldn't save the picture. Your marks are still here.")

    /// A Show stopped by its button, or at the cap.
    public static func stopped(at length: TimeInterval) -> Self {
        Self("Stopped at \(CanvasStoryboard.clock(length)). Send it, or × to delete it.")
    }

    /// A Show stopped under it — macOS's own Stop, a display gone, the stream failing — never a system error's words.
    public static func stoppedByMacOS(at length: TimeInterval) -> Self {
        Self("macOS stopped the recording at \(CanvasStoryboard.clock(length)). Send it, or × to delete it.")
    }

    public static let noRecording = Self("Couldn't start recording.")
    public static let noFrames = Self("Couldn't turn the recording into frames.", actions: [.showInFinder])
    public static let deleted = Self("Recording deleted. Nothing was sent.")

    /// Narration refused: the Show goes on without it.
    public static func silent(_ reason: String) -> Self {
        Self("Recording without your voice: \(reason).")
    }
}

// MARK: - On screen

/// Where the pill goes, in AppKit's screen coordinates (y up). It sat on Tyler's Dock, and in the default layout (the
/// panel off, the control bar on) exactly on the Ready pill; so: always inside the screen's visible frame, never over the
/// control bar; out of the docked panel's top edge, or beside it; under the full-screen panel's header row; below the
/// control bar, or the menu bar, with the panel hidden or collapsed.
public enum CanvasPillPlacement {
    public enum Panel: Equatable, Sendable {
        case hidden
        /// Docked in a corner: its glass, the rounded rect inside its window.
        case docked(CGRect)
        /// Filling the screen: the y its header row ends at.
        case fullScreen(headerBottom: CGFloat)
    }

    /// The pill's frame, and whether it hangs from what is above it (and says things under itself) rather than rising out
    /// of the panel's top edge.
    public struct Spot: Equatable, Sendable {
        public let frame: CGRect
        public let hangs: Bool

        public init(frame: CGRect, hangs: Bool) {
            self.frame = frame
            self.hangs = hangs
        }
    }

    /// Between the pill and what it sits beside.
    public static let gap = ConchSpace.x2

    /// A pill of `size` on a screen whose visible frame (clear of the menu bar and the Dock) is `visible`.
    public static func spot(size: CGSize, visible: CGRect, panel: Panel, controlBar: CGRect?) -> Spot {
        let bar = controlBar.flatMap { $0.intersects(visible) ? $0 : nil }
        func clear(_ frame: CGRect) -> Bool { visible.contains(frame) && !(bar?.intersects(frame) ?? false) }
        /// Inside the visible frame; off the control bar, by going under it.
        func kept(_ frame: CGRect) -> CGRect {
            var frame = frame
            frame.origin.x = min(max(frame.minX, visible.minX), visible.maxX - frame.width)
            frame.origin.y = min(max(frame.minY, visible.minY), visible.maxY - frame.height)
            if let bar, bar.intersects(frame) {
                frame.origin.y = max(visible.minY, bar.minY - gap - frame.height)
            }
            return frame
        }
        /// Centred on `x`, its top at `top`.
        func hanging(x: CGFloat, top: CGFloat) -> CGRect {
            CGRect(x: x - size.width / 2, y: top - size.height, width: size.width, height: size.height)
        }
        /// The top of the screen, centred: under the control bar when it is there, else under the menu bar.
        func top() -> Spot {
            Spot(frame: kept(hanging(x: visible.midX, top: visible.maxY - ConchSpace.x3)), hangs: true)
        }
        switch panel {
        case .hidden:
            return top()
        case let .fullScreen(headerBottom):
            return Spot(frame: kept(hanging(x: visible.midX, top: min(headerBottom, visible.maxY) - gap)), hangs: true)
        case let .docked(glass):
            // Out of its top edge, centred on it.
            var above = CGRect(x: glass.midX - size.width / 2, y: glass.maxY + gap, width: size.width, height: size.height)
            above.origin.x = min(max(above.minX, visible.minX), visible.maxX - size.width)
            if clear(above) { return Spot(frame: above, hangs: false) }
            // No room over it (it reaches the top, or the control bar is there): beside its top edge, level with it, on
            // the side with more room.
            let right = CGRect(x: glass.maxX + gap, y: glass.maxY - size.height, width: size.width, height: size.height)
            let left = CGRect(x: glass.minX - gap - size.width, y: glass.maxY - size.height, width: size.width, height: size.height)
            let sides = visible.maxX - glass.maxX >= glass.minX - visible.minX ? [right, left] : [left, right]
            for side in sides {
                let level = kept(side)
                if clear(level), !level.intersects(glass) { return Spot(frame: level, hangs: true) }
            }
            // It fills the screen's width: at the top, over it.
            return top()
        }
    }
}
