import Foundation

enum ConchSettingValue: Equatable {
    case bool(Bool)
    case number(Double)
    case string(String)
}

/// One row of the daemon's settings registry, decoded from its config snapshot.
/// Nothing about which settings exist is hardcoded here — the registry is the
/// single source of truth, on the Mac, in the terminal, and on the phone.
struct ConchSetting: Identifiable, Equatable {
    let key: String
    var value: ConchSettingValue
    let help: String
    let source: String
    let choices: [String]
    let minimum: Double?
    let maximum: Double?
    let isInteger: Bool

    var id: String { key }

    /// An env var beats a saved value, so offering an editor would be a lie.
    var isEnvLocked: Bool { source == "env" }

    /// Auto-titling produced "Voice Qa" and "Say Wpm" on the Mac; these are a
    /// couple of dozen fixed keys, so the names are written out. Anything new
    /// falls back to a readable capitalisation rather than disappearing.
    private static let names: [String: String] = [
        "end-silence": "End-of-speech pause",
        "mic-gain": "Microphone gain",
        "hold-submit-delay": "Hold before sending",
        "listen-window": "Listening window",
        "typing-grace": "Typing grace period",
        "barge-threshold": "Barge-in threshold",
        "voice-speed": "Voice speed",
        "keystroke-fallback": "Type into the session window",
        "read-full": "Read the full reply",
        "interrupt-on-manual-reply": "Stop reading when you type",
        "handoff-order": "Hand-off order",
        "reveal-on-turn": "Raise the window on a finished turn",
        "reveal-typing-grace": "Don't raise while typing",
        "working-mic": "Open the mic while working",
        "voice-qa": "Voice Q&A",
        "announce-summary": "Announce a summary",
        "haiku-timeout": "Haiku timeout",
        "meeting-autopause": "Auto-pause in meetings",
        "announce-sentences": "Sentences announced",
        "announce-max-chars": "Announcement length limit",
        "say-rate": "Fallback voice speed (wpm)",
        "phone": "Let this phone connect",
        "phone-port": "Phone connection port",
    ]

    var displayName: String {
        Self.names[key] ?? key.replacingOccurrences(of: "-", with: " ").capitalized
    }

    var formatted: String {
        guard case let .number(value) = self.value else { return "" }
        return isInteger ? String(Int(value)) : String(format: "%g", value)
    }

    /// Steppers need finite ends; the registry often bounds only one side.
    var range: ClosedRange<Double> {
        let low = minimum ?? 0
        let high = maximum ?? max(low + 1, defaultCeiling)
        return low...max(high, low + step)
    }

    var step: Double { isInteger ? 1 : 0.05 }

    private var defaultCeiling: Double {
        guard case let .number(value) = self.value else { return 100 }
        return max(value * 4, isInteger ? 100 : 10)
    }
}

extension ConchSetting {
    /// Decode one snapshot entry. Unknown kinds are skipped rather than
    /// rendered wrong — a newer daemon can add a kind this build can't draw.
    init?(key: String, raw: Any) {
        guard let entry = raw as? [String: Any] else { return nil }
        let kind = entry["kind"] as? String ?? ""
        let value = entry["value"]

        switch kind {
        case "boolean":
            guard let flag = value as? Bool else { return nil }
            self.value = .bool(flag)
        case "number", "integer":
            guard let number = value as? Double ?? (value as? Int).map(Double.init) else { return nil }
            self.value = .number(number)
        case "enum", "string":
            guard let text = value as? String else { return nil }
            self.value = .string(text)
        default:
            return nil
        }

        self.key = key
        help = entry["help"] as? String ?? ""
        source = entry["source"] as? String ?? "default"
        choices = (entry["choices"] as? [Any])?.compactMap { $0 as? String } ?? []
        isInteger = kind == "integer"
        let bounds = entry["bounds"] as? [String: Any]
        minimum = bounds?["min"] as? Double ?? (bounds?["min"] as? Int).map(Double.init)
        maximum = bounds?["max"] as? Double ?? (bounds?["max"] as? Int).map(Double.init)
    }
}
