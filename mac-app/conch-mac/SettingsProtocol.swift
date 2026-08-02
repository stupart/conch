import Combine
import Foundation

enum ConchSettingValue: Codable, Hashable, Sendable {
    case number(Double)
    case boolean(Bool)
    case string(String)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Bool.self) {
            self = .boolean(value)
        } else if let value = try? container.decode(Double.self), value.isFinite {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else {
            throw DecodingError.typeMismatch(
                ConchSettingValue.self,
                DecodingError.Context(
                    codingPath: decoder.codingPath,
                    debugDescription: "Expected a finite number, boolean, or string"
                )
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .number(value):
            try container.encode(value)
        case let .boolean(value):
            try container.encode(value)
        case let .string(value):
            try container.encode(value)
        }
    }

    var numberValue: Double? {
        guard case let .number(value) = self else { return nil }
        return value
    }

    var booleanValue: Bool? {
        guard case let .boolean(value) = self else { return nil }
        return value
    }

    var displayText: String {
        switch self {
        case let .number(value):
            if value.rounded() == value {
                return String(format: "%.0f", value)
            }
            return String(format: "%.12g", value)
        case let .boolean(value):
            return value ? "true" : "false"
        case let .string(value):
            return value
        }
    }
}

enum ConchSettingSource: String, Codable, Sendable {
    case environment = "env"
    case file
    case defaultValue = "default"

    var label: String {
        switch self {
        case .environment:
            return "Environment · read only"
        case .file:
            return "File"
        case .defaultValue:
            return "Default"
        }
    }
}

struct ConchSettingBounds: Decodable, Equatable, Sendable {
    let min: Double?
    let max: Double?
    let minInclusive: Bool?
    let maxInclusive: Bool?
    let integer: Bool?

    var requiresInteger: Bool {
        integer == true
    }

    func contains(_ value: Double, forceInteger: Bool) -> Bool {
        guard value.isFinite else { return false }
        if (forceInteger || requiresInteger), value.rounded() != value {
            return false
        }
        if let min {
            if minInclusive == false {
                guard value > min else { return false }
            } else {
                guard value >= min else { return false }
            }
        }
        if let max {
            if maxInclusive == false {
                guard value < max else { return false }
            } else {
                guard value <= max else { return false }
            }
        }
        return true
    }

    func description(forceInteger: Bool) -> String? {
        var parts: [String] = []
        if let min {
            parts.append("\(minInclusive == false ? ">" : "≥") \(ConchSettingValue.number(min).displayText)")
        }
        if let max {
            parts.append("\(maxInclusive == false ? "<" : "≤") \(ConchSettingValue.number(max).displayText)")
        }
        if forceInteger || requiresInteger {
            parts.append("whole numbers")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

struct ConchConfigEntry: Decodable, Equatable, Sendable {
    var value: ConchSettingValue
    var source: ConchSettingSource
    var diagnostic: String?
    let kind: String
    let bounds: ConchSettingBounds?
    let choices: [ConchSettingValue]?
    let defaultValue: ConchSettingValue
    let help: String

    private enum CodingKeys: String, CodingKey {
        case value
        case source
        case diagnostic
        case kind
        case bounds
        case choices
        case defaultValue = "default"
        case help
    }
}

struct ConchConfigSetting: Identifiable, Equatable, Sendable {
    let key: String
    var entry: ConchConfigEntry

    var id: String { key }
}

private struct ConchConfigSnapshotReply: Decodable {
    let snapshot: [String: ConchConfigEntry]
}

private struct ConchConfigErrorReply: Decodable {
    let error: String
}

private struct ConchConfigAcknowledgement: Decodable {
    let key: String
    let action: String
    let status: String
    let effective: ConchSettingValue
    let source: ConchSettingSource
    let env: String?
    let diagnostic: String?
}

private enum ConchConfigReply: Decodable {
    case snapshot([String: ConchConfigEntry])
    case acknowledgement(ConchConfigAcknowledgement)
    case error(String)
    case unknown(String)

    private enum CodingKeys: String, CodingKey {
        case kind
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "config-snapshot":
            self = .snapshot(try ConchConfigSnapshotReply(from: decoder).snapshot)
        case "config-ack":
            self = .acknowledgement(try ConchConfigAcknowledgement(from: decoder))
        case "config-error":
            self = .error(try ConchConfigErrorReply(from: decoder).error)
        default:
            self = .unknown(kind)
        }
    }
}

private struct ConchSetConfigRequest: Encodable, Sendable {
    let kind = "set-config"
    let key: String
    let value: ConchSettingValue
}

private struct ConchUnsetConfigRequest: Encodable, Sendable {
    let kind = "unset-config"
    let key: String
}

struct ConchSettingsFeedback: Equatable, Sendable {
    enum Tone: Sendable {
        case success
        case warning
        case error
    }

    let text: String
    let tone: Tone
}

@MainActor
final class ConchSettingsStore: ObservableObject {
    @Published private(set) var settings: [ConchConfigSetting] = []
    @Published private(set) var isLoading = true
    @Published private(set) var isRefreshing = false
    @Published private(set) var globalFeedback: ConchSettingsFeedback?
    @Published private(set) var rowFeedback: [String: ConchSettingsFeedback] = [:]
    @Published private(set) var pendingKeys: Set<String> = []

    private let socketClient: ConchSocketClient

    init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        socketClient = ConchSocketClient(environment: environment)
    }

    func load() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        if settings.isEmpty {
            isLoading = true
        }
        defer {
            isLoading = false
            isRefreshing = false
        }

        let outcome = await socketClient.request(ConchGetConfigRequest())
        switch outcome {
        case let .reply(data):
            do {
                switch try JSONDecoder().decode(ConchConfigReply.self, from: data) {
                case let .snapshot(snapshot):
                    settings = snapshot.map { key, entry in
                        ConchConfigSetting(key: key, entry: entry)
                    }
                    .sorted {
                        $0.key.localizedStandardCompare($1.key) == .orderedAscending
                    }
                    globalFeedback = nil
                    rowFeedback = [:]
                case let .error(error):
                    globalFeedback = .init(text: normalized(error, fallback: "Could not load settings"), tone: .error)
                case let .unknown(kind):
                    globalFeedback = .init(text: "Unexpected daemon reply: \(kind)", tone: .error)
                case .acknowledgement:
                    globalFeedback = .init(text: "Unexpected acknowledgement while loading settings", tone: .error)
                }
            } catch {
                globalFeedback = .init(text: "Invalid settings reply from daemon", tone: .error)
            }
        case .connectFailed:
            globalFeedback = .init(text: "Daemon not running", tone: .error)
        case .timeout:
            globalFeedback = .init(text: "Daemon did not reply", tone: .error)
        }
    }

    func setValue(_ value: ConchSettingValue, for key: String) async {
        guard canMutate(key) else { return }
        let outcome = await socketClient.request(
            ConchSetConfigRequest(key: key, value: value)
        )
        finishMutation(key: key, expectedAction: "set", outcome: outcome)
    }

    func reset(_ key: String) async {
        guard canMutate(key) else { return }
        let outcome = await socketClient.request(ConchUnsetConfigRequest(key: key))
        finishMutation(key: key, expectedAction: "unset", outcome: outcome)
    }

    private func canMutate(_ key: String) -> Bool {
        guard !pendingKeys.contains(key) else { return false }
        guard let setting = settings.first(where: { $0.key == key }) else { return false }
        guard setting.entry.source != .environment else {
            rowFeedback[key] = .init(
                text: "Controlled by the environment; file changes cannot override it",
                tone: .warning
            )
            return false
        }
        pendingKeys.insert(key)
        rowFeedback[key] = nil
        return true
    }

    private func finishMutation(
        key: String,
        expectedAction: String,
        outcome: ConchSocketRequestOutcome
    ) {
        defer { pendingKeys.remove(key) }

        switch outcome {
        case let .reply(data):
            do {
                switch try JSONDecoder().decode(ConchConfigReply.self, from: data) {
                case let .acknowledgement(acknowledgement):
                    guard acknowledgement.key == key,
                          acknowledgement.action == expectedAction else {
                        rowFeedback[key] = .init(text: "Unexpected acknowledgement from daemon", tone: .error)
                        return
                    }
                    apply(acknowledgement)
                case let .error(error):
                    rowFeedback[key] = .init(
                        text: normalized(error, fallback: "Setting change failed"),
                        tone: .error
                    )
                case let .unknown(kind):
                    rowFeedback[key] = .init(text: "Unexpected daemon reply: \(kind)", tone: .error)
                case .snapshot:
                    rowFeedback[key] = .init(text: "Unexpected settings snapshot from daemon", tone: .error)
                }
            } catch {
                rowFeedback[key] = .init(text: "Invalid acknowledgement from daemon", tone: .error)
            }
        case .connectFailed:
            rowFeedback[key] = .init(text: "Daemon not running", tone: .error)
        case .timeout:
            rowFeedback[key] = .init(text: "Daemon did not reply", tone: .error)
        }
    }

    private func apply(_ acknowledgement: ConchConfigAcknowledgement) {
        guard let index = settings.firstIndex(where: { $0.key == acknowledgement.key }) else {
            return
        }
        settings[index].entry.value = acknowledgement.effective
        settings[index].entry.source = acknowledgement.source
        settings[index].entry.diagnostic = acknowledgement.diagnostic

        let verb = acknowledgement.action == "unset" ? "Reset" : "Saved"
        let status: String
        let tone: ConchSettingsFeedback.Tone
        switch acknowledgement.status {
        case "applied":
            status = "applied live"
            tone = .success
        case "hook-next":
            status = "takes effect on the next hook"
            tone = .success
        case "masked":
            let source = acknowledgement.env.map { " by \($0)" } ?? " by the environment"
            status = "saved, but masked\(source)"
            tone = .warning
        default:
            status = "acknowledged (\(acknowledgement.status))"
            tone = .warning
        }

        var details = "\(verb) · \(status) · effective \(acknowledgement.effective.displayText) from \(acknowledgement.source.label.lowercased())"
        if let diagnostic = acknowledgement.diagnostic?.trimmingCharacters(in: .whitespacesAndNewlines),
           !diagnostic.isEmpty {
            details += " · \(diagnostic)"
        }
        rowFeedback[acknowledgement.key] = .init(text: details, tone: tone)
    }

    private func normalized(_ message: String, fallback: String) -> String {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : trimmed
    }
}
