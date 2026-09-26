import SwiftUI

/// The two voice modes. Talk was "auto"; Quiet was "manual" (the daemon's pause).
public enum VoiceMode: String, CaseIterable, Identifiable, Sendable {
    case talk
    case quiet

    public var id: String { rawValue }
    public var title: String { self == .talk ? "Talk" : "Quiet" }
}

/// What the voice is doing, as the menu bar mark and the control bar show it.
public enum VoiceState: String, CaseIterable, Sendable {
    case talk
    case speaking
    case listening
    case quiet
    case ready

    public var title: String {
        switch self {
        case .talk: "Talk"
        case .speaking: "Speaking"
        case .listening: "Listening"
        case .quiet: "Quiet"
        case .ready: "Ready for you"
        }
    }

    /// The state's colour; nil for Talk, which takes the ordinary menu bar or text colour.
    public var token: ConchColorToken? {
        switch self {
        case .talk: nil
        case .speaking: ConchColor.speaking
        case .listening: ConchColor.listening
        case .quiet: ConchColor.quiet
        case .ready: ConchColor.ready
        }
    }

    /// One daemon snapshot to one state. The live voice wins, because it is happening now; then a session
    /// with something to look at (`ReadyForYou`); then the mode. `transcribing` has shut the mic, so it is not Listening.
    public static func resolve(live: String, paused: Bool, readyCount: Int) -> VoiceState {
        switch live {
        case "speaking": return .speaking
        case "listening", "recording": return .listening
        default: break
        }
        if readyCount > 0 { return .ready }
        return paused || live == "paused" || live == "muted" ? .quiet : .talk
    }
}

/// Ready for you: a session that isn't working holds a deliverable nobody has looked at yet. The daemon's
/// `reviewReady` (src/panel.ts) is the same rule, and every surface that marks or counts ready asks it: the menu bar
/// mark, the Ready pill, the menu's Ready for you, the sidebar's check, and the phone's.
///
/// It was "a deliverable is held and the session isn't working", so looking changed nothing: the mark and the pill
/// stayed green and kept walking through what Tyler had already opened. Looked-at work stays held, and Previous, Next
/// and the switcher still reach it; it just isn't waiting on him any more.
public enum ReadyForYou {
    /// `viewedAt` is each held deliverable's (nil for one nobody has looked at, and for every one from a daemon too old
    /// to remember, which is then the old rule).
    public static func isReady(working: Bool, viewedAt: [Double?]) -> Bool {
        !working && viewedAt.contains { $0 == nil }
    }
}
