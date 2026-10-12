import AppKit
import ConchDesign
import SwiftUI

struct ConchSettingsView: View {
    @StateObject private var store = ConchSettingsStore()
    @EnvironmentObject private var daemon: DaemonHost

    var body: some View {
        // One scroll view, header and all: on the Settings page it is what stops at the readable column
        // (`SettingsLayout`), so nothing here is pinned outside it.
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                SettingsSectionHeader(title: "General", subtitle: "Values are read from the running daemon.") {
                    HStack(spacing: 10) {
                        if store.isRefreshing, !store.isLoading {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Button {
                            Task { await store.load() }
                        } label: {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                        .disabled(store.isRefreshing)
                        .help("Reload settings from the daemon")
                    }
                }
                .padding(.bottom, SettingsLayout.headerGap)

                // Deliberately NOT one of the rows below: those are read from the
                // daemon over its socket, so the one control that can turn the
                // daemon off cannot be among the things that disappear when it is.
                // The app's login item sits with it, for the same reason: opening
                // at login is macOS's answer, not a daemon setting. One card, the
                // design system's (Settings › Setup's).
                OnboardingCard {
                    DaemonPowerRow(daemon: daemon)
                    Rectangle()
                        .fill(ConchPalette.divider)
                        .frame(height: 1)
                    LoginItemRow()
                }

                content
            }
            .padding(SettingsLayout.inset)
        }
        // No frame here. This view used to BE the settings window and sized it;
        // the page around it owns the size now.
        .background(ConchPalette.bg)
        .task {
            await store.load()
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.isLoading, store.settings.isEmpty {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Loading settings…")
                    .font(ConchTypography.font(size: 12))
                    .foregroundStyle(ConchPalette.textDim)
            }
            .padding(.top, 24)
        } else if store.settings.isEmpty {
            SettingsEmptyView(feedback: store.globalFeedback) {
                Task { await store.load() }
            }
        } else {
            VStack(spacing: 0) {
                if let feedback = store.globalFeedback {
                    SettingsGlobalFeedback(feedback: feedback)
                        .padding(.top, 16)
                }

                LazyVStack(spacing: 0) {
                    ForEach(store.settings) { setting in
                        ConchSettingRowView(
                            setting: setting,
                            feedback: store.rowFeedback[setting.key],
                            isPending: store.pendingKeys.contains(setting.key),
                            onSet: { value in
                                Task { await store.setValue(value, for: setting.key) }
                            },
                            onReset: {
                                Task { await store.reset(setting.key) }
                            }
                        )

                        Rectangle()
                            .fill(ConchPalette.divider)
                            .frame(height: 1)
                    }

                    SessionVoicesSection()
                    AgentDefaultsSection()
                }
                .padding(.top, 8)
            }
        }
    }
}

/// Per-session voices, moved off the ledger — they are reference information,
/// not something you act on while triaging. Read straight from the daemon's
/// published snapshot; voices are session state, not a curated setting.
///
/// Headed by where the natural voices stand (`naturalVoices`, src/voice-env.ts).
/// A first run builds them in the background while macOS `say` speaks, and
/// without this line nothing on screen said why every session sounded the same
/// (Tyler, 2026-09-27: "the voices are all default Mac — what happened there?").
private struct SessionVoicesSection: View {
    @State private var rows: [(label: String, voice: String)] = []
    @State private var natural: NaturalVoicesStatus?
    @State private var engine: SpeechEngineStatus?

    var body: some View {
        Group {
            if rows.isEmpty, natural == nil, engine == nil {
                EmptyView()
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Session voices")
                        .font(ConchTypography.font(size: 13, weight: .semibold))
                        .foregroundStyle(ConchPalette.textPrimary)

                    // What hears you, beside what speaks: seashell's engine the
                    // app carries, and the first-run model download's progress.
                    if let engine {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(engine.headline)
                                .font(ConchTypography.font(size: 12.5, weight: .medium))
                                .foregroundStyle(engine.state == "ready" ? ConchPalette.textPrimary : ConchPalette.textDim)
                            Text(engine.detail)
                                .font(ConchTypography.font(size: 11))
                                .foregroundStyle(ConchPalette.textDim)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                    }

                    if let natural {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 10) {
                                Text(natural.headline)
                                    .font(ConchTypography.font(size: 12.5, weight: .medium))
                                    .foregroundStyle(natural.state == "ready" ? ConchPalette.textPrimary : ConchPalette.textDim)
                                // Where the window's "Why?" leads: the same Try again as its line, beside the reason.
                                if natural.canTryAgain {
                                    Button("Try again") { NaturalVoicesNoticeStore.shared.tryAgain() }
                                        .buttonStyle(.plain)
                                        .font(ConchTypography.font(size: 11, weight: .medium))
                                        .foregroundStyle(ConchPalette.brandCyan)
                                }
                            }
                            Text(natural.detail)
                                .font(ConchTypography.font(size: 11))
                                .foregroundStyle(ConchPalette.textDim)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                    }

                    if !rows.isEmpty {
                        Text("Change one with `conch voice <session> <voice>`, or just say it.")
                            .font(ConchTypography.font(size: 11))
                            .foregroundStyle(ConchPalette.textDim)
                    }

                    ForEach(rows, id: \.label) { row in
                        HStack(spacing: 10) {
                            Text(row.label)
                                .font(ConchTypography.font(size: 12.5))
                                .foregroundStyle(ConchPalette.textPrimary)
                                .lineLimit(1)
                            Spacer(minLength: 12)
                            Text(row.voice)
                                .font(ConchTypography.font(size: 11.5))
                                .foregroundStyle(ConchPalette.textDim)
                                .monospacedDigit()
                                .lineLimit(1)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 18)
            }
        }
        // Re-read while Settings is open: a first-run setup walks through its
        // steps over minutes, and "setting up…" that never moves reads as stuck.
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private func load() async {
        let path = ProcessInfo.processInfo.environment["CONCH_SESSIONS_FILE"]
            ?? "/tmp/conch-sessions.json"
        let (parsed, status, speech) = await Task.detached(priority: .utility) { () -> ([(String, String)], NaturalVoicesStatus?, SpeechEngineStatus?) in
            guard let data = FileManager.default.contents(atPath: path) else { return ([], nil, nil) }
            // Decoded apart, so one status an older or newer daemon shapes
            // differently never hides the other.
            let status = (try? JSONDecoder().decode(NaturalVoicesEnvelope.self, from: data))?.naturalVoices
            let speech = (try? JSONDecoder().decode(SpeechEngineEnvelope.self, from: data))?.speechEngine
            guard let state = try? JSONDecoder().decode(PublishedState.self, from: data) else { return ([], status, speech) }
            let rows: [(String, String)] = state.rows.compactMap { row in
                let voice = row.voice?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return voice.isEmpty ? nil : (row.label, voice)
            }
            return (rows, status, speech)
        }.value
        rows = parsed.map { (label: $0.0, voice: $0.1) }
        if natural != status { natural = status }
        if engine != speech { engine = speech }
    }
}

/// Each agent's own default model and effort, as its config names them (`sessionSettings`,
/// src/session-settings.ts), read-only. conch never writes them: a model or effort picked in a
/// session's header is for that session only, and a new session gets these unless one is picked
/// for it in the New session sheet.
private struct AgentDefaultsSection: View {
    @State private var catalog: SessionSettingsCatalog?

    var body: some View {
        Group {
            if let catalog, catalog.claude != nil || catalog.codex != nil {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Agent defaults")
                        .font(ConchTypography.font(size: 13, weight: .semibold))
                        .foregroundStyle(ConchPalette.textPrimary)
                    Text("Read from each agent's own config; conch doesn't change them. A model or effort picked in a session's header is for that session only.")
                        .font(ConchTypography.font(size: 11))
                        .foregroundStyle(ConchPalette.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                    if let claude = catalog.claude { agent("Claude Code", claude.defaults) }
                    if let codex = catalog.codex { agent("Codex", codex.defaults) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 18)
            }
        }
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    private func agent(_ name: String, _ defaults: AgentSettingsCatalog.Defaults) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(name)
                .font(ConchTypography.font(size: 12.5, weight: .medium))
                .foregroundStyle(ConchPalette.textPrimary)
            Text(SessionSettingsPresentation.defaultsLine(defaults))
                .font(ConchTypography.font(size: 11.5))
                .foregroundStyle(ConchPalette.textDim)
                .textSelection(.enabled)
            ForEach(SessionSettingsPresentation.perModelEffortLines(defaults), id: \.self) { line in
                Text(line)
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.textDim)
            }
            Text(defaults.source ?? "No config file found")
                .font(ConchTypography.font(size: 10.5))
                .foregroundStyle(ConchPalette.textFaint)
                .textSelection(.enabled)
        }
    }

    private func load() async {
        let path = ProcessInfo.processInfo.environment["CONCH_SESSIONS_FILE"]
            ?? "/tmp/conch-sessions.json"
        let decoded = await Task.detached(priority: .utility) { () -> SessionSettingsCatalog? in
            guard let data = FileManager.default.contents(atPath: path) else { return nil }
            return (try? JSONDecoder().decode(SessionSettingsEnvelope.self, from: data))?.sessionSettings
        }.value
        if catalog != decoded { catalog = decoded }
    }
}

private struct SessionSettingsEnvelope: Decodable {
    let sessionSettings: SessionSettingsCatalog?
}

/// Where the natural voices stand, as the daemon publishes it (`naturalVoices`
/// in /tmp/conch-sessions.json, from src/voice-env.ts). Absent from an older
/// daemon and in CONCH_TTS=server mode; the line is then simply not drawn.
private struct NaturalVoicesStatus: Decodable, Equatable, Sendable {
    /// "checking" | "setting-up" | "ready" | "off"
    let state: String
    /// Short, for "off (reason)".
    let reason: String?
    /// One sentence: which step, from where, or why not.
    let detail: String
    /// Setting up: 0–99 across the whole of it.
    let percent: Int?
    /// Off, and why: "choice", "unsupported" or "failed".
    let off: String?
    /// Waiting before the next try: "network", "space" or "retry".
    let waiting: String?

    var headline: String {
        switch state {
        case "ready": return "Natural voices: ready"
        case "setting-up": return "Natural voices: setting up…" + (percent.map { " \($0)%" } ?? "")
        case "checking": return "Natural voices: checking…"
        default: return "Natural voices: off" + (reason.map { " (\($0))" } ?? "")
        }
    }

    /// Stopped and not by choice or a limit of this Mac, or waiting on something: Try again starts it over now.
    var canTryAgain: Bool {
        if state == "off" { return off != "choice" && off != "unsupported" && reason != "needs Apple silicon" && reason?.hasPrefix("CONCH_TTS") != true }
        return state == "setting-up" && waiting != nil
    }
}

/// Where the speech engine stands, as the daemon publishes it (`speechEngine`
/// in /tmp/conch-sessions.json, from src/speech-engine.ts): checking, downloading
/// the whisper model on a first run, ready, or off and why. Absent from an older
/// daemon; the line is then simply not drawn.
private struct SpeechEngineStatus: Decodable, Equatable, Sendable {
    struct Progress: Decodable, Equatable, Sendable {
        let bytes: Double
        let total: Double
    }

    /// "checking" | "downloading" | "ready" | "off"
    let state: String
    let reason: String?
    let detail: String
    let progress: Progress?

    var headline: String {
        switch state {
        case "ready": return "Speech engine: ready"
        case "downloading":
            guard let progress, progress.total > 0 else { return "Speech engine: downloading…" }
            return "Speech engine: downloading… \(Int((progress.bytes / progress.total * 100).rounded(.down)))%"
        case "checking": return "Speech engine: checking…"
        default: return "Speech engine: off" + (reason.map { " (\($0))" } ?? "")
        }
    }
}

private struct NaturalVoicesEnvelope: Decodable {
    let naturalVoices: NaturalVoicesStatus?
}

private struct SpeechEngineEnvelope: Decodable {
    let speechEngine: SpeechEngineStatus?
}

private struct SettingsEmptyView: View {
    let feedback: ConchSettingsFeedback?
    let onRetry: () -> Void

    /// Under the card, where the rows would be, rather than centred in a window that no longer exists.
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(feedback?.text ?? "No settings were published")
                .font(ConchTypography.font(size: 13))
                .foregroundStyle(feedbackColor(feedback?.tone ?? .warning))
                .fixedSize(horizontal: false, vertical: true)
            Button("Try Again", action: onRetry)
                .frame(minHeight: 28)
        }
        .padding(.top, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct SettingsGlobalFeedback: View {
    let feedback: ConchSettingsFeedback

    var body: some View {
        Text(feedback.text)
            .font(ConchTypography.font(size: 12))
            .foregroundStyle(feedbackColor(feedback.tone))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, ConchSpace.x3)
            .padding(.vertical, 9)
            .background(ConchPalette.raised.opacity(0.72), in: RoundedRectangle(cornerRadius: ConchRadius.small, style: .continuous))
    }
}

private struct ConchSettingRowView: View {
    let setting: ConchConfigSetting
    let feedback: ConchSettingsFeedback?
    let isPending: Bool
    let onSet: (ConchSettingValue) -> Void
    let onReset: () -> Void

    private var isReadOnly: Bool {
        setting.entry.source == .environment
    }

    /// Auto-titling produced "Voice Qa" and "Say Wpm". These are a dozen fixed
    /// keys; writing them out is cheaper than any clever de-abbreviator.
    private static let displayNames: [String: String] = [
        "end-silence": "End-of-speech pause",
        "mic-gain": "Microphone gain",
        "hold-submit-delay": "Hold before sending",
        "listen-window": "Listening window",
        "typing-grace": "Typing grace period",
        "barge-threshold": "Barge-in threshold",
        "voice-speed": "Voice speed",
        "keystroke-fallback": "Type into the session window",
        "speak": "Read replies aloud",
        "bell": "Attention chime",
        "mic-cues": "Mic sounds",
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
    ]

    private var displayName: String {
        Self.displayNames[setting.key]
            ?? setting.key.replacingOccurrences(of: "-", with: " ").capitalized
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 18) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(displayName)
                        .font(ConchTypography.font(size: 14, weight: .medium))
                        .foregroundStyle(ConchPalette.textPrimary)
                        .textSelection(.enabled)

                    Text(setting.entry.help)
                        .font(ConchTypography.font(size: 12))
                        .foregroundStyle(ConchPalette.textDim)
                        .fixedSize(horizontal: false, vertical: true)

                    // Metadata and the source note share ONE line. Each row
                    // carried four: name, help, bounds, and an override note —
                    // so the two that matter were outnumbered two to one, and
                    // a dozen rows became a wall. Truncated with the full text
                    // on hover, because the detail is worth keeping and not
                    // worth the height.
                    Text(footnote)
                        .font(ConchTypography.font(size: 11))
                        .foregroundStyle(isReadOnly ? ConchPalette.textDim : ConchPalette.textFaint)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help(footnote)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                // Every control's RIGHT edge lands on the same line, hard
                // against the right margin — the way a settings pane reads
                // everywhere else.
                //
                // I tried leading alignment first, reasoning that the left
                // edge is what the eye follows. It left a dead gap between
                // each control and the row's right edge, so the column looked
                // unfinished: "still looks wack... just right align all the
                // main elements for each setting row against the right edge
                // like normal settings." The slot is sized to the widest
                // control so trailing alignment costs no dead space.
                HStack(alignment: .center, spacing: 10) {
                    if isPending {
                        ProgressView().controlSize(.small)
                    }

                    settingControl
                        .frame(width: 150, alignment: .trailing)
                        .disabled(isReadOnly || isPending)

                    // An icon, not a word. "Reset" as a bordered button is the
                    // heaviest thing in the row and appears on exactly the rows
                    // you have already touched — so the list got louder the more
                    // you used it. The slot stays reserved either way, because an
                    // empty Group collapses and the column goes jagged again.
                    Group {
                        if setting.entry.source != .defaultValue, !isReadOnly {
                            Button(action: onReset) {
                                Image(systemName: "arrow.uturn.backward")
                                    .font(.system(size: 11, weight: .medium))
                            }
                            .buttonStyle(.borderless)
                            .foregroundStyle(ConchPalette.textDim)
                            .disabled(isPending)
                            .help("Reset to the default")
                            .accessibilityLabel("Reset \(displayName)")
                        } else {
                            Color.clear
                        }
                    }
                    .frame(width: 22, height: 22)
                }
                .frame(minHeight: 34)
            }

            if isReadOnly {
                Text("Set by the environment — a saved value cannot override it.")
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.textDim)
            }


            if let feedback {
                Text(feedback.text)
                    .font(ConchTypography.font(size: 11, weight: .medium))
                    .foregroundStyle(feedbackColor(feedback.tone))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 15)
    }

    /// The one dim line under the help text: bounds, default, and where the
    /// value came from, joined rather than stacked.
    private var footnote: String {
        var parts = [metadata]
        if let diagnostic = setting.entry.diagnostic?.trimmingCharacters(in: .whitespacesAndNewlines),
           !diagnostic.isEmpty {
            parts.append(diagnostic)
        }
        return parts.joined(separator: " · ")
    }

    private var metadata: String {
        // Naming the source and then the default said "Default · Default: 350"
        // whenever the value simply was the default — which is most rows.
        var parts: [String] = []
        if setting.entry.source == .defaultValue {
            parts.append("Default \(setting.entry.defaultValue.displayText)")
        } else {
            parts.append(setting.entry.source.label)
            parts.append("Default: \(setting.entry.defaultValue.displayText)")
        }
        if let bounds = setting.entry.bounds?.description(
            forceInteger: setting.entry.kind == "integer"
        ) {
            parts.append(bounds)
        }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var settingControl: some View {
        switch setting.entry.kind {
        case "number", "integer":
            NumberSettingControl(entry: setting.entry, onSet: onSet)
        case "boolean":
            if let current = setting.entry.value.booleanValue {
                Toggle(
                    "",
                    isOn: Binding(
                        get: { current },
                        set: { onSet(.boolean($0)) }
                    )
                )
                .labelsHidden()
                .toggleStyle(.switch)
                .accessibilityLabel(displayName)
            } else {
                UnsupportedSettingControl(text: "Invalid boolean value")
            }
        case "enum":
            if let choices = setting.entry.choices, !choices.isEmpty {
                Picker(
                    "",
                    selection: Binding(
                        get: { setting.entry.value },
                        set: onSet
                    )
                ) {
                    ForEach(choices, id: \.self) { choice in
                        Text(choice.displayText).tag(choice)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .accessibilityLabel(displayName)
            } else {
                UnsupportedSettingControl(text: "No choices published")
            }
        default:
            UnsupportedSettingControl(text: "Unsupported kind: \(setting.entry.kind)")
        }
    }
}

private struct NumberSettingControl: View {
    let entry: ConchConfigEntry
    let onSet: (ConchSettingValue) -> Void

    @State private var draft: Double
    @State private var validationMessage: String?

    init(entry: ConchConfigEntry, onSet: @escaping (ConchSettingValue) -> Void) {
        self.entry = entry
        self.onSet = onSet
        _draft = State(initialValue: entry.value.numberValue ?? 0)
    }

    private var current: Double {
        entry.value.numberValue ?? 0
    }

    private var forceInteger: Bool {
        entry.kind == "integer"
    }

    @FocusState private var isEditing: Bool

    private var canApply: Bool {
        draft != current && accepts(draft)
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 7) {
                TextField(
                    "Value",
                    value: $draft,
                    format: .number.precision(.fractionLength(0...6))
                )
                .textFieldStyle(.roundedBorder)
                .multilineTextAlignment(.trailing)
                .monospacedDigit()
                .frame(width: 92)
                .focused($isEditing)
                .onSubmit { commit(draft) }
                // Commit on blur as well as Enter. Requiring Apply made numbers
                // behave differently from the toggles beside them, and a value
                // typed but not applied silently did nothing.
                .onChange(of: isEditing) { _, editing in
                    if !editing, canApply { commit(draft) }
                }
                .accessibilityLabel("Setting value")

                Stepper(
                    value: Binding(
                        get: { draft },
                        set: { commit($0) }
                    ),
                    step: step
                ) {
                    Text("Adjust value")
                }
                .labelsHidden()

                // Present only while an edit is pending. A permanently dim
                // Apply on every row is chrome, not an affordance.
                if canApply {
                    Button("Apply") {
                        commit(draft)
                    }
                    .frame(minHeight: 28)
                }
            }

            if let validationMessage {
                Text(validationMessage)
                    .font(ConchTypography.font(size: 10))
                    .foregroundStyle(ConchPalette.statusNeeds)
            }
        }
        .onChange(of: entry.value) { _, value in
            guard let number = value.numberValue else { return }
            draft = number
            validationMessage = nil
        }
    }

    private var step: Double {
        if forceInteger || entry.bounds?.requiresInteger == true {
            return 1
        }
        let values = [
            entry.value.numberValue,
            entry.defaultValue.numberValue,
            entry.bounds?.min,
            entry.bounds?.max,
        ].compactMap { $0 }
        let digits = min(6, values.map(fractionDigits).max() ?? 1)
        return pow(10, -Double(max(1, digits)))
    }

    private func fractionDigits(_ value: Double) -> Int {
        let text = String(format: "%.6f", value)
            .replacingOccurrences(of: "0+$", with: "", options: .regularExpression)
        guard let decimal = text.firstIndex(of: ".") else { return 0 }
        return text.distance(from: text.index(after: decimal), to: text.endIndex)
    }

    private func accepts(_ value: Double) -> Bool {
        guard value.isFinite else { return false }
        if forceInteger, value.rounded() != value { return false }
        return entry.bounds?.contains(value, forceInteger: forceInteger) ?? true
    }

    private func commit(_ candidate: Double) {
        guard accepts(candidate) else {
            let constraint = entry.bounds?.description(forceInteger: forceInteger)
                ?? (forceInteger ? "whole numbers" : "a finite number")
            validationMessage = "Expected \(constraint)"
            return
        }
        let normalized = Double(String(format: "%.12g", candidate)) ?? candidate
        draft = normalized
        validationMessage = nil
        guard normalized != current else { return }
        onSet(.number(normalized))
    }
}

private struct UnsupportedSettingControl: View {
    let text: String

    var body: some View {
        Text(text)
            .font(ConchTypography.font(size: 11))
            .foregroundStyle(ConchPalette.statusNeeds)
            .multilineTextAlignment(.trailing)
    }
}

private func feedbackColor(_ tone: ConchSettingsFeedback.Tone) -> Color {
    switch tone {
    case .success:
        return ConchPalette.brandCyan
    case .warning:
        return ConchPalette.statusWaiting
    case .error:
        return ConchPalette.statusNeeds
    }
}


/// The one switch that turns conch on and off.
///
/// Before this, conch was an app plus a launchd agent, and stopping it meant
/// knowing that `conch service off` existed. The daemon is a child of the app
/// now, so this is the whole story: one switch, and quitting the app.
private struct DaemonPowerRow: View {
    @ObservedObject var daemon: DaemonHost

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(indicator)
                .frame(width: 7, height: 7)

            VStack(alignment: .leading, spacing: 2) {
                Text("conch")
                    .font(ConchTypography.font(size: 12.5, weight: .medium))
                    .foregroundStyle(ConchPalette.textPrimary)
                Text(detail)
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.textDim)
            }

            Spacer(minLength: 12)

            // An adopted daemon belongs to a terminal or a launchd agent. The
            // switch stays — hiding it read as "the app lost its toggle" (A2) —
            // but disabled, with the reason beside it, and when launchd is the
            // owner, the one fix the app can make on its own (A3). The switch is
            // all that is off: one that freezes is still replaced, and one paused
            // in a terminal or debugger is left alone (DaemonHost, DaemonHealth).
            if daemon.adoptedIdentity?.startedBy == "launchd" {
                Button("Let the app own it") { daemon.takeOverFromLaunchd() }
                    .controlSize(.small)
            }
            if adopted {
                Text("the switch can't turn off what the app didn't start")
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.textDim)
                    .help("If it stops answering while it runs, conch still replaces it. Paused in a terminal or debugger (Ctrl-Z), it's left alone.")
            }
            Toggle("", isOn: Binding(
                get: { daemon.isOurs || daemon.state == .starting || adopted },
                set: { wanted in wanted ? daemon.start() : daemon.stop() }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .disabled(adopted)
        }
        .padding(.horizontal, ConchSpace.x4)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var adopted: Bool {
        if case .adopted = daemon.state { return true }
        return false
    }

    private var indicator: Color {
        if daemon.paused { return ConchPalette.statusWaiting }
        switch daemon.state {
        case .running, .adopted: return ConchPalette.brandCyan
        case .starting: return ConchPalette.statusQuiet
        case .stopped: return ConchPalette.textDim
        case .failed: return ConchPalette.statusWaiting
        }
    }

    private var detail: String {
        // Stopped with Ctrl-Z or at a debugger: never signalled, and said so until it's continued.
        if daemon.paused { return "Paused — stopped in a terminal or debugger. conch leaves it alone until it's continued." }
        switch daemon.state {
        case .running(let pid): return "Running · pid \(pid)"
        case .adopted: return adoptedDetail
        case .starting: return "Starting…"
        case .stopped: return "Off — voice, hooks, and the phone are all asleep"
        case .failed(let reason): return reason
        }
    }

    /// Who started it, from the daemon's identity file. The old wording is
    /// kept only for a daemon too old to have written one.
    private var adoptedDetail: String {
        guard let identity = daemon.adoptedIdentity else { return "Running — started outside this app" }
        switch identity.startedBy {
        case "launchd": return "Running — started by the launchd service"
        case "terminal": return "Running — started from a terminal (pid \(identity.pid))"
        default: return "Running — started by another copy of this app (pid \(identity.pid))"
        }
    }
}

/// "Open conch when you log in", the same switch as setup's You're set: macOS's own answer, read again when Settings
/// shows it (`LoginItem`). When macOS wants it allowed, or refused it, the note says so beside the button that opens
/// System Settings › General › Login Items.
private struct LoginItemRow: View {
    @ObservedObject private var login = LoginItem.shared

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "power")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(ConchPalette.textDim)
                .frame(width: 7)

            VStack(alignment: .leading, spacing: 2) {
                Text("Open conch when you log in")
                    .font(ConchTypography.font(size: 12.5, weight: .medium))
                    .foregroundStyle(ConchPalette.textPrimary)
                Text(login.note?.words ?? "So your agents can reach you. macOS lists it in System Settings › General › Login Items.")
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(login.note == nil ? ConchPalette.textDim : ConchPalette.statusWaiting)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 12)

            if login.note?.opensLoginItems == true {
                Button(LoginItemLine.openLoginItems, action: login.openLoginItems)
                    .controlSize(.small)
            }
            Toggle("", isOn: Binding(get: { login.isOn }, set: { login.set($0) }))
                .labelsHidden()
                .toggleStyle(.switch)
                .accessibilityLabel("Open conch when you log in")
        }
        .padding(.horizontal, ConchSpace.x4)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { login.refresh() }
    }
}


/// The one Settings page for the app (`SettingsPageState`): whether conch's window shows it, and which section. Every way in
/// comes here: the header's gear, ⌘, and conch › Settings…, the menu bar menu's Settings…, Manage… beside an account in the
/// New session sheet, and the natural voices' Why?. The window reads it rather than being told, so a way in that has to
/// build the window first (the menu bar menu, with the window closed) still opens on Settings.
@MainActor
final class SettingsRouter: ObservableObject {
    static let shared = SettingsRouter()

    @Published private(set) var state: SettingsPageState
    /// conch's window in front, or built again (`ConchStatusItem.bringConchForward`).
    var bringForward: () -> Void = { ConchStatusItem.bringConchForward() }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        state = SettingsPageState(section: SettingsSection(stored: defaults.string(forKey: SettingsSection.storageKey)))
    }

    private let defaults: UserDefaults

    /// A way in: the page in a window in front, at `section`, or where it was left.
    func open(_ section: SettingsSection? = nil) {
        state.open(section)
        remember()
        bringForward()
    }

    /// ⌘, and conch › Settings…: the page, or back to the sessions when it already shows in the window in front.
    func command() {
        let window = ReviewNotifications.shared.reviewWindow
        let inFront = NSApp.isActive && window?.isVisible == true && window?.isMiniaturized == false && window?.isMainWindow == true
        state.toggle(windowInFront: inFront)
        if state.isShown { bringForward() }
    }

    /// The back control, and a session chosen while the page shows: the sessions, as they were. Nothing to publish when
    /// the page isn't showing, which is every row click.
    func close() {
        guard state.isShown else { return }
        state.close()
    }

    /// Esc, once nothing is being read aloud. False when the page isn't showing, so Esc goes on to the sessions.
    func escape() -> Bool {
        state.escape()
    }

    func select(_ section: SettingsSection) {
        guard section != state.section else { return }
        state.select(section)
        remember()
    }

    private func remember() {
        defaults.set(state.section.rawValue, forKey: SettingsSection.storageKey)
    }
}

/// Settings, a page of conch's window in place of the sessions (2026-10-11; it was SwiftUI's `Settings` window, 840 by 620
/// at most). The strip along the top is the sessions' own, where the way back sits beside the traffic lights; the sections
/// are listed down the side; and the one shown runs from beside the list to a readable width (`SettingsLayout`), with its
/// scroller still at the window's edge.
///
/// It stays dark, the whole window with it, while it shows (`SettingsAppearance`). Providers is drawn in claude-swap's dark
/// palette (ClaudeAccountsView), so a Settings that followed a light system would put a dark block in a light page. One
/// dark page is a place you went; a dark block in a light one looks broken.
struct ConchSettingsPage: View {
    @ObservedObject var router: SettingsRouter

    var body: some View {
        GeometryReader { proxy in
            VStack(spacing: 0) {
                SettingsStrip(titleBarInset: proxy.safeAreaInsets.top, onBack: router.close)

                Rectangle()
                    .fill(ConchPalette.divider)
                    .frame(height: 1)

                HStack(spacing: 0) {
                    SettingsSectionList(selected: router.state.section, onSelect: router.select)
                        .frame(width: SettingsLayout.listWidth)

                    Rectangle()
                        .fill(ConchPalette.divider)
                        .frame(width: 1)

                    GeometryReader { content in
                        section(router.state.section)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            // Every section is one scroll view: this stops its content at the column and leaves the
                            // scroll view, and its scroller, the full width.
                            .contentMargins(.trailing, SettingsLayout.trailingMargin(width: content.size.width), for: .scrollContent)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            // The strip extends under the traffic lights, as the sessions' header does (DashboardView, E1).
            .ignoresSafeArea(.container, edges: .top)
        }
        .foregroundStyle(ConchPalette.textPrimary)
        .background(ConchPalette.bg)
        .background(SettingsAppearance(name: SettingsAppearance.pinned))
        .font(ConchTypography.font(size: 12.5))
    }

    @ViewBuilder
    private func section(_ section: SettingsSection) -> some View {
        switch section {
        case .providers: ClaudeAccountsView()
        case .environments: ConchEnvironmentsView()
        case .tools: AccountToolsView { request in
            switch await ConchSocketClient().request(request, timeout: 22) {
            case .reply(let data): return data
            case .connectFailed, .timeout:
                throw NSError(domain: "ConchTools", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not reach the Conch daemon."])
            }
        }
        case .browser: ConchBrowserSettingsView()
        case .general: ConchSettingsView()
        case .phone: ConchPairingView()
        case .permissions: ConchPermissionsView()
        case .setup: SetupSettingsTab()
        }
    }
}

/// The sessions' strip, on the Settings page: the way back where the sidebar's button sits, beside the traffic lights.
private struct SettingsStrip: View {
    /// The title-bar strip: 32 pt on macOS 26 with the title bar hidden, 0 in full screen (DashboardHeader's rule).
    let titleBarInset: CGFloat
    let onBack: () -> Void

    /// The sessions' header's clearance (DashboardHeader.trafficLightClearance).
    private static let trafficLightClearance: CGFloat = 78

    var body: some View {
        HStack(spacing: 0) {
            SettingsBackButton(action: onBack)
            Spacer(minLength: 0)
        }
        .padding(.leading, titleBarInset > 0 ? Self.trafficLightClearance : ConchSpace.x4)
        .padding(.trailing, ConchSpace.x2)
        .frame(height: max(titleBarInset, 28))
        .frame(maxWidth: .infinity)
        .background(ConchPalette.bg)
    }
}

/// "‹ Sessions": the header's buttons' size and states (HeaderButton), with the place it goes back to named.
private struct SettingsBackButton: View {
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 11, weight: .semibold))
                Text("Sessions")
                    .font(ConchTypography.font(size: 12, weight: .medium))
            }
            .padding(.leading, 8)
            .padding(.trailing, 10)
            .frame(height: 28)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(isHovered ? ConchPalette.hover : .clear)
            )
            .foregroundStyle(isHovered ? ConchPalette.textPrimary : ConchPalette.textDim)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help("Back to your sessions (Esc or ⌘,)")
        .accessibilityLabel("Back to your sessions")
    }
}

/// The sections, down the side: their marks in one column so their names start on one line, and the rows the ledger's
/// (30 pt, radius 7, its hover and selection).
private struct SettingsSectionList: View {
    let selected: SettingsSection
    let onSelect: (SettingsSection) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Settings")
                .font(ConchType.heading)
                .foregroundStyle(ConchPalette.textPrimary)
                .padding(.horizontal, ConchSpace.x2)
                .padding(.bottom, ConchSpace.x3)
                .accessibilityAddTraits(.isHeader)
            ForEach(SettingsSection.allCases) { section in
                SettingsSectionRow(section: section, isSelected: section == selected) { onSelect(section) }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, ConchSpace.x3)
        .padding(.top, SettingsLayout.inset)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct SettingsSectionRow: View {
    let section: SettingsSection
    let isSelected: Bool
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: ConchSpace.x2) {
                Image(systemName: section.symbol)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(isSelected ? ConchPalette.textPrimary : ConchPalette.textDim)
                    .frame(width: 18)
                Text(section.title)
                    .font(ConchTypography.font(size: 13, weight: isSelected ? .medium : .regular))
                    .foregroundStyle(ConchPalette.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, ConchSpace.x2)
            .frame(maxWidth: .infinity, minHeight: 30)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(isSelected ? ConchPalette.selection : isHovered ? ConchPalette.hover : .clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

/// A section's title and the line under it, where every section starts: `SettingsLayout.inset` in, the design system's
/// title over its secondary line (Plugins & MCP's, ConchDesign/AccountTools.swift).
struct SettingsSectionHeader<Trailing: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder var trailing: Trailing

    var body: some View {
        // Top, not a baseline: a taller control beside the title would push the title down, off every other section's.
        HStack(alignment: .top, spacing: ConchSpace.x3) {
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(ConchType.title)
                    .foregroundStyle(ConchPalette.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text(subtitle)
                    .font(ConchType.secondary)
                    .foregroundStyle(ConchPalette.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            trailing
        }
    }
}

extension SettingsSectionHeader where Trailing == EmptyView {
    init(title: String, subtitle: String) {
        self.init(title: title, subtitle: subtitle) { EmptyView() }
    }
}

/// A heading inside a section ("This Mac", "Other Macs", "Codex cloud"): the design system's emphasis, after its mark in
/// a 22-point column, so every heading's words start on one line whatever the mark.
struct SettingsSubheading<Mark: View>: View {
    let title: String
    @ViewBuilder var mark: Mark

    var body: some View {
        HStack(spacing: ConchSpace.x2) {
            mark.frame(width: 22, height: 22)
            Text(title)
                .font(ConchType.uiEmphasis)
                .foregroundStyle(ConchPalette.textPrimary)
                .accessibilityAddTraits(.isHeader)
        }
    }
}

extension SettingsSubheading where Mark == EmptyView {
    init(title: String) {
        self.init(title: title) { EmptyView() }
    }
}

/// The page's one rule between blocks: the hairline token, as the strip's and the list's are. SwiftUI's `Divider` draws
/// its own, heavier grey.
struct SettingsHairline: View {
    var body: some View {
        Rectangle()
            .fill(ConchPalette.divider)
            .frame(height: 1)
    }
}

/// The window's appearance while Settings shows, set on the window itself so everything in it agrees: the strip, the
/// traffic lights, the controls, and the palette's dynamic colours. Put back as it was when Settings goes.
///
/// On the window rather than `.preferredColorScheme`, whose going back to the system is SwiftUI's to get right: here the
/// page sets it as it arrives and restores it as it leaves.
struct SettingsAppearance: NSViewRepresentable {
    /// Dark, while Providers draws in claude-swap's dark palette (ClaudeAccountsView). Nil follows the system, like the
    /// rest of the window: the one line to change once Providers draws from ConchPalette.
    static let pinned: NSAppearance.Name? = .darkAqua

    let name: NSAppearance.Name?

    func makeNSView(context: Context) -> NSView { Pin(name: name) }
    func updateNSView(_ nsView: NSView, context: Context) {}
    static func dismantleNSView(_ nsView: NSView, coordinator: ()) { (nsView as? Pin)?.release() }

    final class Pin: NSView {
        private let name: NSAppearance.Name?
        private weak var pinned: NSWindow?
        private var previous: NSAppearance?

        init(name: NSAppearance.Name?) {
            self.name = name
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if pinned !== window { release() }
            guard let window, let name, pinned == nil else { return }
            previous = window.appearance
            pinned = window
            window.appearance = NSAppearance(named: name)
        }

        func release() {
            guard let window = pinned else { return }
            window.appearance = previous
            pinned = nil
            previous = nil
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}


struct ConchEnvironmentsView: View {
    @StateObject private var accounts = ClaudeAccountsStore(providerId: "codex")
    @State private var accountId = "default"
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SettingsLayout.headerGap) {
                SettingsSectionHeader(title: "Environments", subtitle: "Where your sessions run")
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 10) {
                        SettingsSubheading(title: "This Mac") {
                            Image(systemName: "laptopcomputer").font(.system(size: 14, weight: .regular))
                        }
                        Text("New sessions open here in Terminal with the account you choose. Resume keeps the original account and working folder.")
                    }
                    SettingsHairline()
                    RemoteMacPairingsView()
                    SettingsHairline()
                    VStack(alignment: .leading, spacing: 12) {
                        SettingsSubheading(title: "Codex cloud") {
                            Image("AgentCodex").resizable().scaledToFit()
                        }
                        Text("Browse your cloud environments and tasks in Codex’s terminal interface. Cloud environments belong to the selected OpenAI account.")
                        Picker("Account", selection: $accountId) {
                            if accounts.accounts.isEmpty { Text("Default").tag("default") }
                            ForEach(accounts.accounts) { account in
                                Text([account.label, account.email].compactMap { $0 }.joined(separator: " · ")).tag(account.id)
                            }
                        }
                        Button("Open Codex cloud in Terminal") { Task { await accounts.send("cloud", id: accountId) } }
                            .disabled(accounts.busy || accounts.accounts.first(where: { $0.id == accountId })?.authType != "chatgpt")
                        if let error = accounts.error { Text(error).foregroundStyle(ConchPalette.statusNeeds) }
                        if let notice = accounts.notice { Text(notice) }
                    }
                }
            }
            .font(ConchTypography.font(size: 12))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(SettingsLayout.inset)
        }
        .task { await accounts.send("list") }
        .onChange(of: accounts.accounts.map(\.id)) { _, ids in
            if !ids.contains(accountId) { accountId = "default" }
        }
    }
}
