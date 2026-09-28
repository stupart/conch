import Foundation
import SwiftUI

// The session's own terminal, from the strip.
//
// In normal use the strip's Terminal is a BUTTON: a press brings the session's real terminal forward (its Terminal window
// and tab, or its tmux window and pane in the terminal attached to it) and nothing else — the pane stays where it was and
// nothing is read. Tyler: "it is no use having an image of the terminal lol. Maybe we just make that button bring you to
// the terminal session instead of showing an image of it?"
//
// The Terminal Mirror — the session's Claude Code or Codex as its terminal shows it, view-only, beside conch's view of the
// same conversation — is kept as a DEBUG view, off unless Debug › Show Terminal Mirror is on (or Option is held on the
// button): "We could keep it as a debugging feature tho, cause it is useful for u to make sure the terminal matches conch
// in one image." Agents get the same comparison as one picture from `conch parity` (src/parity.ts).
//
// The daemon finds the terminal and reads it (src/terminal-mirror.ts); the Mac app asks it while the mirror is on screen
// and pictures a Terminal window itself; everything that decides what the strip offers and what the mirror shows is here,
// where it is tested.

/// What the strip offers for a session's own terminal: the Terminal button, and the mirror only while the debug view is on.
public struct ConchTerminalStrip: Equatable, Sendable {
    /// Where "Show Terminal Mirror" is kept (UserDefaults): off unless someone turns it on.
    public static let mirrorDefaultsKey = "conch.debug.terminalMirror"

    /// What a press on the Terminal button does.
    public enum Press: Equatable, Sendable {
        /// Bring the real terminal forward. The pane doesn't change.
        case reveal
        /// Option held: open the mirror, the debug view.
        case openMirror
    }

    /// The session has a terminal of its own (the app's `SessionRow.hasAgentTerminal`).
    public let hasTerminal: Bool
    /// Debug › Show Terminal Mirror.
    public let mirrorOn: Bool

    public init(hasTerminal: Bool, mirrorOn: Bool) {
        self.hasTerminal = hasTerminal
        self.mirrorOn = mirrorOn
    }

    /// The button, wherever there is a terminal to bring forward.
    public var showsButton: Bool { hasTerminal }
    /// The mirror's tab, and a remembered choice of it honoured, only while the debug view is on.
    public var showsMirror: Bool { hasTerminal && mirrorOn }
    /// What it adds to the strip's places.
    public var places: Int { (showsButton ? 1 : 0) + (showsMirror ? 1 : 0) }

    /// A plain press reveals; Option opens the mirror, which is how the debug view is reached from the strip.
    public func press(option: Bool) -> Press {
        option && hasTerminal ? .openMirror : .reveal
    }
}

/// Screen Recording, for the mirror's picture of a Terminal window: asked at most once a launch, and only after a press
/// that opened the mirror (its tab, or Option on the Terminal button) while the debug view is on. Restoring the mirror at
/// launch is not a press, and the Terminal button never asks: it reveals, and a reveal needs no picture.
public struct ConchMirrorPermissionAsk: Equatable, Sendable {
    public private(set) var pressed = false
    public private(set) var asked = false

    public init() {}

    /// The mirror was opened by hand.
    public mutating func press() { pressed = true }

    /// True once: after a press, while the mirror is on, the first time its picture needs the permission.
    public mutating func shouldAsk(mirrorOn: Bool) -> Bool {
        guard mirrorOn, pressed, !asked else { return false }
        asked = true
        return true
    }
}

/// The daemon's answer to `terminal-screen`.
public struct ConchTerminalLocation: Decodable, Equatable, Sendable {
    public enum Host: String, Decodable, Sendable { case tmux, terminal, none }
    public struct Cursor: Decodable, Equatable, Sendable {
        public let x: Int
        public let y: Int
    }

    public let sessionId: String
    public let host: Host
    // tmux
    public let pane: String?
    public let columns: Int?
    public let rows: Int?
    public let cursor: Cursor?
    public let screen: String?
    // Terminal
    public let tty: String?
    /// The window server's number for the window, which is what ScreenCaptureKit names it by.
    public let window: UInt32?
    public let minimized: Bool?
    public let selected: Bool?
    public let text: String?
    // none
    public let reason: String?

    private enum Key: String, CodingKey {
        case kind, sessionId, host, pane, columns, rows, cursor, screen, tty, window, minimized, selected, text, reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Key.self)
        guard try container.decode(String.self, forKey: .kind) == "terminal-screen" else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "not a terminal-screen reply")
        }
        sessionId = try container.decode(String.self, forKey: .sessionId)
        host = try container.decode(Host.self, forKey: .host)
        pane = try container.decodeIfPresent(String.self, forKey: .pane)
        columns = try container.decodeIfPresent(Int.self, forKey: .columns)
        rows = try container.decodeIfPresent(Int.self, forKey: .rows)
        cursor = try container.decodeIfPresent(Cursor.self, forKey: .cursor)
        screen = try container.decodeIfPresent(String.self, forKey: .screen)
        tty = try container.decodeIfPresent(String.self, forKey: .tty)
        window = try container.decodeIfPresent(UInt32.self, forKey: .window)
        minimized = try container.decodeIfPresent(Bool.self, forKey: .minimized)
        selected = try container.decodeIfPresent(Bool.self, forKey: .selected)
        text = try container.decodeIfPresent(String.self, forKey: .text)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
    }
}

/// Why a Terminal window is shown as its text rather than its picture.
public enum ConchTerminalFallback: Equatable, Sendable {
    /// conch may not picture windows yet, and where macOS stands on that.
    case needsScreenRecording(ConchPermissionStatus)
    /// The window is showing another of its tabs, so a picture of it would be of someone else.
    case otherTab
    case minimized
    /// ScreenCaptureKit refused, in its words.
    case pictureFailed(String)

    /// What the tab says about it.
    public var line: String {
        switch self {
        case let .needsScreenRecording(status):
            status == .needsRelaunch
                ? "Screen Recording is on for conch: reopen conch to show this terminal as it looks."
                : "To show this terminal as it looks, conch needs Screen Recording. It pictures only this window, only while this tab is open."
        case .otherTab: "Another tab is in front in this Terminal window, so this is the session's text without its colours."
        case .minimized: "This Terminal window is in the Dock, so this is its text without its colours."
        case let .pictureFailed(why): "conch couldn't picture this Terminal window (\(why)), so this is its text without its colours."
        }
    }

    /// The permission's one button, when there is one.
    public var action: ConchPermissionAction? {
        guard case let .needsScreenRecording(status) = self else { return nil }
        switch status {
        // Nothing conch can do: it is on, or whoever manages the Mac decides.
        case .granted, .restricted: return nil
        // Still being read: Settings is where it is turned on either way.
        case .unknown: return .openSettings
        default: return status.action
        }
    }
}

/// What the Terminal Mirror is showing.
public enum ConchAgentTerminalState: Equatable, Sendable {
    /// Asking the daemon where the terminal is.
    case finding
    /// A tmux pane's screen: exact text, in its colours.
    case screen(ConchTerminalScreen)
    /// Terminal's window, pictured live; the app draws the picture.
    case window(UInt32)
    /// Terminal's own text for the session's tab, without colour, and why it isn't the picture. Nil until it arrives.
    case text(ConchTerminalScreen?, ConchTerminalFallback)
    /// Nothing to show, and why.
    case unavailable(String)

    /// What the tab shows for the daemon's answer, given where Screen Recording stands and whether the last picture failed.
    public static func deciding(
        _ location: ConchTerminalLocation,
        screenRecording: ConchPermissionStatus,
        pictureFailure: String? = nil
    ) -> ConchAgentTerminalState {
        switch location.host {
        case .tmux:
            guard let screen = location.screen, let columns = location.columns, let rows = location.rows else {
                return .unavailable("tmux sent conch a screen it couldn't read.")
            }
            return .screen(ConchTerminalScreen(capture: screen, columns: columns, rows: rows, cursor: location.cursor.map { ($0.x, $0.y) }))
        case .terminal:
            guard let window = location.window else { return .unavailable("Terminal didn't say which window holds this session.") }
            let text = location.text.map { ConchTerminalScreen(plain: $0) }
            if screenRecording != .granted { return .text(text, .needsScreenRecording(screenRecording)) }
            if location.minimized == true { return .text(text, .minimized) }
            if location.selected == false { return .text(text, .otherTab) }
            if let pictureFailure { return .text(text, .pictureFailed(pictureFailure)) }
            return .window(window)
        case .none:
            return .unavailable(location.reason ?? "conch can't find this session's terminal.")
        }
    }

    /// Whether the next read should ask Terminal for the tab's text: only while the text is what is shown, or about to be.
    public static func wantsText(after state: ConchAgentTerminalState, screenRecording: ConchPermissionStatus) -> Bool {
        if screenRecording != .granted { return true }
        if case .text = state { return true }
        return false
    }

    /// How long until the next read. A tmux screen is re-read often, since a read IS the picture; a Terminal window's
    /// picture streams by itself, so the daemon is asked only to notice it minimised, or its tab changed.
    public var nextRead: Duration {
        switch self {
        case .screen: .milliseconds(300)
        case .window: .seconds(3)
        case .text: .milliseconds(1_500)
        case .finding: .seconds(1)
        case .unavailable: .seconds(5)
        }
    }

    /// The picture is the thing on screen, so the app keeps its stream running.
    public var showsPicture: Bool {
        if case .window = self { return true }
        return false
    }
}

/// When the mirror reads anything at all: only while it can be seen. Off the moment its tab is left (or the debug view is
/// turned off, which takes the tab away), conch's window is hidden, minimised or covered, or the Mac sleeps — no timer, no
/// stream, no daemon reads.
public struct ConchTerminalMirrorGate: Equatable, Sendable {
    public var tabShown = false
    public var windowVisible = true
    public var asleep = false

    public init(tabShown: Bool = false, windowVisible: Bool = true, asleep: Bool = false) {
        self.tabShown = tabShown
        self.windowVisible = windowVisible
        self.asleep = asleep
    }

    public var isLive: Bool { tabShown && windowVisible && !asleep }
}

/// Which agent's terminal it is, for the tab's own line.
public enum ConchTerminalAgent {
    public static func name(backend: String?) -> String { backend == "codex" ? "Codex" : "Claude Code" }
}

// MARK: - The mirror

/// The Terminal Mirror's content: a line saying whose terminal this is, that this is the debug view, with "Open in
/// Terminal", over the terminal itself.
public struct ConchAgentTerminalPane<Picture: View>: View {
    let agent: String
    let state: ConchAgentTerminalState
    /// Where it is, said small on the line: "tmux %7 · 120×40", "Terminal".
    let place: String?
    /// What went wrong the last time "Open in Terminal" was pressed.
    let openFailure: String?
    let onOpen: (() -> Void)?
    let onPermission: (ConchPermissionAction) -> Void
    let picture: () -> Picture

    public init(
        agent: String,
        state: ConchAgentTerminalState,
        place: String? = nil,
        openFailure: String? = nil,
        onOpen: (() -> Void)?,
        onPermission: @escaping (ConchPermissionAction) -> Void,
        @ViewBuilder picture: @escaping () -> Picture
    ) {
        self.agent = agent
        self.state = state
        self.place = place
        self.openFailure = openFailure
        self.onOpen = onOpen
        self.onPermission = onPermission
        self.picture = picture
    }

    public var body: some View {
        VStack(spacing: 0) {
            bar
            Rectangle().fill(ConchColor.hairline).frame(height: 1)
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(ConchColor.surface)
    }

    private var bar: some View {
        HStack(spacing: 8) {
            Image(systemName: "terminal")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchColor.textSecondary)
            Text("\(agent) in its terminal")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(ConchColor.textPrimary)
                .lineLimit(1)
            if let place {
                Text(place)
                    .font(.system(size: 11))
                    .foregroundStyle(ConchColor.textTertiary)
                    .lineLimit(1)
            }
            // Said, so nobody types at a picture and wonders where it went, or takes the debug view for the feature.
            Text("Debug · view only")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(ConchColor.textSecondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(ConchColor.fill))
            Spacer(minLength: 8)
            if let openFailure {
                Text(openFailure)
                    .font(.system(size: 11))
                    .foregroundStyle(ConchColor.attention)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if let onOpen {
                Button(action: onOpen) {
                    HStack(spacing: 4) {
                        Text("Open in Terminal")
                        Image(systemName: "arrow.up.forward.app")
                    }
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ConchColor.textPrimary)
                    .padding(.horizontal, 8)
                    .frame(height: 22)
                    .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(ConchColor.fill))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Bring this session's terminal forward to type in")
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .finding:
            message(symbol: "terminal", "Finding \(agent)'s terminal…")
        case let .screen(screen):
            ConchTerminalScreenView(screen: screen)
        case .window:
            picture()
        case let .text(screen, why):
            VStack(spacing: 0) {
                notice(why)
                Rectangle().fill(ConchColor.hairline).frame(height: 1)
                if let screen {
                    ConchTerminalScreenView(screen: screen)
                } else {
                    message(symbol: "text.alignleft", "Reading the terminal's text…")
                }
            }
        case let .unavailable(why):
            message(symbol: "terminal", why)
        }
    }

    private func notice(_ why: ConchTerminalFallback) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: why.action == nil ? "info.circle" : ConchPermission.screenRecording.symbol)
                .font(.system(size: 12))
                .foregroundStyle(ConchColor.textSecondary)
            Text(why.line)
                .font(.system(size: 12))
                .foregroundStyle(ConchColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if let action = why.action {
                Button(action.title) { onPermission(action) }
                    .buttonStyle(.plain)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(ConchColor.onAccent)
                    .padding(.horizontal, 10)
                    .frame(height: 24)
                    .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(ConchColor.accent))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(ConchColor.surfaceRaised)
    }

    private func message(symbol: String, _ text: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 20, weight: .light))
                .foregroundStyle(ConchColor.textTertiary)
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(ConchColor.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
