import SwiftUI

/// A session's model and reasoning effort, as the daemon publishes them on its row
/// (`rows[].settings`, src/session-settings.ts): read from the session's own transcript or
/// rollout, never guessed. Anything absent is unknown, and is said as "default".
public struct SessionSettingsState: Decodable, Equatable, Sendable {
    public let model: String?
    /// How a person reads it: "Opus 5.5", "GPT-6-Astra".
    public let modelLabel: String?
    /// The catalog choice the model is (`opus`, `gpt-6-astra`), when it plainly is one.
    public let modelChoice: String?
    public let effort: String?
    /// A change conch is driving through the session's own picker, or how the last one went.
    public let change: Change?

    public struct Change: Decodable, Equatable, Sendable {
        /// "applying" | "applied" | "failed"
        public let state: String
        public let model: String?
        public let effort: String?
        /// Epoch-ms it started (applying) or settled.
        public let at: Double
        /// The agent's own confirmation, or why nothing changed.
        public let message: String?

        public init(state: String, model: String? = nil, effort: String? = nil, at: Double = 0, message: String? = nil) {
            self.state = state
            self.model = model
            self.effort = effort
            self.at = at
            self.message = message
        }

        private enum CodingKeys: String, CodingKey { case state, model, effort, at, message }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? ""
            model = try? c.decodeIfPresent(String.self, forKey: .model)
            effort = try? c.decodeIfPresent(String.self, forKey: .effort)
            at = (try? c.decodeIfPresent(Double.self, forKey: .at)) ?? 0
            message = try? c.decodeIfPresent(String.self, forKey: .message)
        }
    }

    public init(model: String? = nil, modelLabel: String? = nil, modelChoice: String? = nil, effort: String? = nil, change: Change? = nil) {
        self.model = model
        self.modelLabel = modelLabel
        self.modelChoice = modelChoice
        self.effort = effort
        self.change = change
    }

    private enum CodingKeys: String, CodingKey { case model, modelLabel, modelChoice, effort, change }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        modelLabel = try? c.decodeIfPresent(String.self, forKey: .modelLabel)
        modelChoice = try? c.decodeIfPresent(String.self, forKey: .modelChoice)
        effort = try? c.decodeIfPresent(String.self, forKey: .effort)
        change = try? c.decodeIfPresent(Change.self, forKey: .change)
    }
}

/// One agent's half of the published `sessionSettings`: the models and efforts it offers, and
/// its own defaults for a new session, read from its config (read-only in conch).
public struct AgentSettingsCatalog: Decodable, Equatable, Sendable {
    public struct Model: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        /// Nil: the agent's whole list. Empty: this model takes no effort (Haiku).
        public let efforts: [String]?
        public let defaultEffort: String?

        public init(id: String, label: String, efforts: [String]? = nil, defaultEffort: String? = nil) {
            self.id = id
            self.label = label
            self.efforts = efforts
            self.defaultEffort = defaultEffort
        }
    }

    public struct Defaults: Decodable, Equatable, Sendable {
        public let model: String?
        public let effort: String?
        /// Claude keeps effort per model (`modelSettings.<id>.effortLevel`).
        public let perModelEffort: [String: String]?
        public let profile: String?
        /// The file they were read from; nil when there was none.
        public let source: String?

        public init(model: String? = nil, effort: String? = nil, perModelEffort: [String: String]? = nil, profile: String? = nil, source: String? = nil) {
            self.model = model
            self.effort = effort
            self.perModelEffort = perModelEffort
            self.profile = profile
            self.source = source
        }
    }

    public let models: [Model]
    public let efforts: [String]
    public let defaults: Defaults

    public init(models: [Model], efforts: [String], defaults: Defaults = Defaults()) {
        self.models = models
        self.efforts = efforts
        self.defaults = defaults
    }

    private enum CodingKeys: String, CodingKey { case models, efforts, defaults }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        models = ((try? c.decodeIfPresent([Lossy<Model>].self, forKey: .models)) ?? []).compactMap(\.value)
        efforts = (try? c.decodeIfPresent([String].self, forKey: .efforts)) ?? []
        defaults = (try? c.decodeIfPresent(Defaults.self, forKey: .defaults)) ?? Defaults()
    }
}

/// Both agents' catalogs, as the published state's top-level `sessionSettings`.
public struct SessionSettingsCatalog: Decodable, Equatable, Sendable {
    public let claude: AgentSettingsCatalog?
    public let codex: AgentSettingsCatalog?

    public init(claude: AgentSettingsCatalog? = nil, codex: AgentSettingsCatalog? = nil) {
        self.claude = claude
        self.codex = codex
    }

    private enum CodingKeys: String, CodingKey { case claude, codex }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        claude = try? c.decodeIfPresent(AgentSettingsCatalog.self, forKey: .claude)
        codex = try? c.decodeIfPresent(AgentSettingsCatalog.self, forKey: .codex)
    }

    /// A row's `backend`: absent is Claude.
    public func agent(_ backend: String?) -> AgentSettingsCatalog? {
        backend?.lowercased() == "codex" ? codex : claude
    }
}

private struct Lossy<Value: Decodable>: Decodable {
    let value: Value?
    init(from decoder: Decoder) throws { value = try? Value(from: decoder) }
}

/// What a person picked in the menu: a model, an effort, or both.
public struct SessionSettingsPick: Equatable, Sendable {
    public let model: String?
    public let effort: String?

    public init(model: String? = nil, effort: String? = nil) {
        self.model = model
        self.effort = effort
    }
}

/// The words and choices every surface shows for a session's settings. Pure, so it is tested once.
public enum SessionSettingsPresentation {
    /// The header's line: "Opus 5.5 · xhigh", "default · high", "default". Unknown is never a guess.
    public static func title(_ state: SessionSettingsState?) -> String {
        let model = state?.modelLabel ?? state?.model
        let effort = state?.effort
        switch (model, effort) {
        case let (model?, effort?): return "\(model) · \(effort)"
        case let (model?, nil): return model
        case let (nil, effort?): return "default · \(effort)"
        case (nil, nil): return "default"
        }
    }

    /// While conch drives the picker: what it is switching to.
    public static func applying(_ state: SessionSettingsState?) -> String? {
        guard let change = state?.change, change.state == "applying" else { return nil }
        let to = [change.model, change.effort].compactMap { $0 }.joined(separator: " · ")
        return to.isEmpty ? "Switching…" : "Switching to \(to)…"
    }

    /// Why the last change didn't happen, in the daemon's words; nil when it did or none was tried.
    public static func failure(_ state: SessionSettingsState?) -> String? {
        guard let change = state?.change, change.state == "failed" else { return nil }
        return change.message.map { "Not changed: \($0)" } ?? "Not changed"
    }

    /// The model the menu ticks: the choice the daemon matched, else nothing.
    public static func currentModel(_ state: SessionSettingsState?, in catalog: AgentSettingsCatalog?) -> AgentSettingsCatalog.Model? {
        guard let choice = state?.modelChoice?.lowercased() else { return nil }
        return catalog?.models.first { $0.id.lowercased() == choice }
    }

    /// The efforts the session's model takes: its own list when the catalog knows the model, else the agent's.
    public static func efforts(for state: SessionSettingsState?, in catalog: AgentSettingsCatalog?) -> [String] {
        currentModel(state, in: catalog)?.efforts ?? catalog?.efforts ?? []
    }

    /// Each agent's own default, for Settings: what its config names, or that it names none.
    public static func defaultsLine(_ defaults: AgentSettingsCatalog.Defaults) -> String {
        var parts = [
            "Model: \(defaults.model ?? "the agent's own default")",
            "Effort: \(defaults.effort ?? (defaults.perModelEffort?.isEmpty == false ? "set per model" : "the agent's own default"))",
        ]
        if let profile = defaults.profile { parts.append("Profile: \(profile)") }
        return parts.joined(separator: " · ")
    }

    /// Claude's per-model efforts, sorted, for Settings: "claude-opus-5-5 xhigh".
    public static func perModelEffortLines(_ defaults: AgentSettingsCatalog.Defaults) -> [String] {
        (defaults.perModelEffort ?? [:]).sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }
    }
}

/// The picker's sections, for inside a `Menu`: Model, then Effort, then what it applies to.
/// Every choice is one `SessionSettingsPick`; the daemon drives the agent's own picker to it,
/// for this session only.
public struct SessionSettingsMenuContent: View {
    let state: SessionSettingsState?
    let catalog: AgentSettingsCatalog?
    let onPick: (SessionSettingsPick) -> Void

    public init(state: SessionSettingsState?, catalog: AgentSettingsCatalog?, onPick: @escaping (SessionSettingsPick) -> Void) {
        self.state = state
        self.catalog = catalog
        self.onPick = onPick
    }

    public var body: some View {
        let current = SessionSettingsPresentation.currentModel(state, in: catalog)
        let efforts = SessionSettingsPresentation.efforts(for: state, in: catalog)
        if let failure = SessionSettingsPresentation.failure(state) {
            Text(failure)
        }
        if let models = catalog?.models, !models.isEmpty {
            Section("Model") {
                ForEach(models) { model in
                    Button {
                        onPick(SessionSettingsPick(model: model.id))
                    } label: {
                        if model.id == current?.id {
                            Label(model.label, systemImage: "checkmark")
                        } else {
                            Text(model.label)
                        }
                    }
                }
            }
        }
        Section("Effort") {
            if efforts.isEmpty {
                Text(current.map { "\($0.label) takes no effort level" } ?? "No effort levels known")
            }
            ForEach(efforts, id: \.self) { effort in
                Button {
                    onPick(SessionSettingsPick(effort: effort))
                } label: {
                    if effort == state?.effort {
                        Label(effort, systemImage: "checkmark")
                    } else {
                        Text(effort)
                    }
                }
            }
        }
        Section {
            Text("For this session only. New sessions keep the agent's own default.")
        }
    }
}
