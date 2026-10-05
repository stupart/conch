import Foundation
import SwiftUI

// The Terminal tab for a session conch hosts: the session itself, live and typeable, inside conch.
//
// A session started "In conch" runs in conch's own tmux server (src/conch-tmux.ts), never Tyler's. The Mac app's
// Terminal tab is a real terminal emulator (SwiftTerm) running a tmux client attached to that session; "Open in
// Terminal" attaches a Terminal window to the same session, and the daemon delivers messages with send-keys, so nothing
// is brought to the front to type. Everything here decides what the app does and is XCTested; the app draws it.

/// A session conch hosts, as the daemon publishes it on the row (`hosted`).
public struct ConchHostedTerminal: Decodable, Equatable, Sendable {
    /// The tmux binary conch's server runs.
    public let tmux: String
    /// The server's socket, absolute.
    public let socket: String
    /// The tmux session, `claude-conch-7k2f`.
    public let session: String
    /// The agent's pane, `%3`.
    public let pane: String

    public init(tmux: String, socket: String, session: String, pane: String) {
        self.tmux = tmux
        self.socket = socket
        self.session = session
        self.pane = pane
    }

    /// Only what conch itself makes is handed to a process: absolute paths, a session name of conch's own shape, a
    /// pane id. The row comes from a file in /tmp; a value of any other shape is not attached to.
    public var isUsable: Bool {
        tmux.hasPrefix("/") && (tmux as NSString).lastPathComponent == "tmux"
            && socket.hasPrefix("/") && !socket.contains("\0")
            && session.range(of: #"^[A-Za-z0-9_-]{1,64}$"#, options: .regularExpression) != nil
            && pane.range(of: #"^%\d+$"#, options: .regularExpression) != nil
    }

    /// The client's arguments after the tmux binary (src/conch-tmux.ts `hostedAttachArgs`): UTF-8, the server by its
    /// socket, the session by its exact name, and `ignore-size`. Measured on tmux 3.7c: alone, this client sizes the
    /// window like any other; with a Terminal window attached too, the window follows that one, and typing here doesn't
    /// take it back. conch's view never resizes someone else's.
    public var attachArguments: [String] {
        ["-u", "-S", socket, "attach-session", "-f", "ignore-size", "-t", "=\(session)"]
    }

    /// Which tmux to run the client with: the one the daemon started the server with, since a client and its server
    /// should be one build (in the app that is its own `Contents/Helpers/tmux`, which the daemon resolves first), else
    /// the app's own when that one can't be run.
    public static func binary(published: String, bundled: String?, isExecutable: (String) -> Bool) -> String? {
        if published.hasPrefix("/"), (published as NSString).lastPathComponent == "tmux", isExecutable(published) { return published }
        if let bundled, isExecutable(bundled) { return bundled }
        return nil
    }

    /// The client's environment: the app's, with the terminal SwiftTerm emulates, 24-bit colour, and a UTF-8 locale.
    /// An app launched from Finder has no LANG, and a tmux client without one draws everything past ASCII as `_`.
    public static func clientEnvironment(_ base: [String: String]) -> [String: String] {
        var environment = base
        environment["TERM"] = "xterm-256color"
        environment["COLORTERM"] = "truecolor"
        if (environment["LANG"] ?? "").isEmpty { environment["LANG"] = "en_US.UTF-8" }
        environment.removeValue(forKey: "TMUX")
        environment.removeValue(forKey: "TMUX_PANE")
        return environment
    }
}

/// Keys the embedded terminal sends itself, rather than as SwiftTerm would.
public enum ConchTerminalKeys {
    /// Shift-Return as CSI u, which conch's tmux (`extended-keys always`, `csi-u`) passes on as it is and Claude Code
    /// reads as a newline (measured, Claude Code 2.1.280 through tmux 3.7c). SwiftTerm on its own sends a plain Return
    /// for it, and the message is sent.
    public static let shiftReturn: [UInt8] = Array("\u{1b}[13;2u".utf8)

    /// Ctrl-V: Claude Code's own key for pasting an image. It reads the Mac's clipboard itself, so the terminal only has
    /// to say "paste".
    public static let imagePaste: [UInt8] = [0x16]

    /// What a key press sends, when it is one of conch's: Return with Shift and nothing else.
    public static func bytes(keyCode: UInt16, shift: Bool, control: Bool, option: Bool, command: Bool) -> [UInt8]? {
        // 36 is Return, 76 the keypad's Enter.
        guard keyCode == 36 || keyCode == 76 else { return nil }
        return shift && !control && !option && !command ? shiftReturn : nil
    }

    /// What Cmd-V does with what is on the clipboard.
    public enum Paste: Equatable, Sendable {
        /// The text, as the terminal pastes it (bracketed when the program asked).
        case text
        /// Only an image: Ctrl-V, so Claude Code attaches it the way it does in Terminal.
        case image
        /// Nothing to paste.
        case nothing
    }

    public static func paste(hasText: Bool, hasImage: Bool) -> Paste {
        if hasText { return .text }
        return hasImage ? .image : .nothing
    }
}

/// Where a new session runs: the New session sheet's choice.
public enum SessionStartHost: String, CaseIterable, Identifiable, Sendable {
    /// A Terminal window, as conch always did. The default until Tyler flips `run-in-conch`.
    case terminal
    /// conch's own tmux: the session's Terminal tab, typed into without taking the front.
    case conch

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .terminal: "In Terminal"
        case .conch: "In conch"
        }
    }

    /// What the sheet starts on: the `run-in-conch` setting when the daemon says it, else Terminal.
    public static func initial(runInConch: Bool?) -> SessionStartHost {
        runInConch == true ? .conch : .terminal
    }

    /// The sheet's line about where a new session will open.
    public func footnote(agent: String) -> String {
        switch self {
        case .terminal:
            "Opens \(agent) in a new Terminal window."
        case .conch:
            "Runs \(agent) inside conch: it is this session\u{2019}s Terminal tab, and Open in Terminal shows the same session in a Terminal window. It keeps running when conch quits."
        }
    }
}

/// The embedded terminal's colours: conch's surface and text, with sixteen that read on it in either appearance.
public enum ConchEmbeddedTerminalColors {
    public static let lightANSI: [ConchRGBA] = [
        0x1D1D1F, 0xC4271D, 0x1F8A3B, 0x946300, 0x0B5FD6, 0xA23BB5, 0x0E7C86, 0x8E8E93,
        0x5C5C61, 0xE0412F, 0x2DA44E, 0xB07A00, 0x2F7CF6, 0xBF4FD1, 0x1596A3, 0xC7C7CC,
    ].map { ConchRGBA($0) }

    public static let darkANSI: [ConchRGBA] = [
        0x3A3A3C, 0xFF6A55, 0x5FD37A, 0xE5C07B, 0x5AA2FF, 0xD68CF0, 0x5CCFD8, 0xD1D1D6,
        0x6E6E73, 0xFF8A78, 0x7FE39A, 0xF5D48F, 0x7DB6FF, 0xE4A8F5, 0x7FDCE3, 0xF2F1EF,
    ].map { ConchRGBA($0) }

    /// The theme for a colour scheme: the ground is the stage's surface, the text is conch's primary text.
    public static func theme(_ scheme: ColorScheme) -> ConchTerminalTheme {
        ConchTerminalTheme(
            foreground: ConchColor.textPrimary.rgba(scheme),
            background: ConchColor.surface.rgba(scheme),
            ansi: scheme == .dark ? darkANSI : lightANSI
        )
    }

    /// The caret: the active blue, so the place you are typing is never taken for text.
    public static func caret(_ scheme: ColorScheme) -> ConchRGBA { ConchColor.active.rgba(scheme) }

    /// The selection's ground.
    public static func selection(_ scheme: ColorScheme) -> ConchRGBA {
        scheme == .dark ? ConchRGBA(0x4A9EFF, alpha: 0.35) : ConchRGBA(0x0A84FF, alpha: 0.22)
    }
}
