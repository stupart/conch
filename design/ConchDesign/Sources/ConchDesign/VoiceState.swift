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
    /// with something to look at; then the mode. `transcribing` has shut the mic, so it is not Listening.
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
