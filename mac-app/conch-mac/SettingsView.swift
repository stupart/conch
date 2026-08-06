import SwiftUI

struct ConchSettingsView: View {
    @StateObject private var store = ConchSettingsStore()

    var body: some View {
        VStack(spacing: 0) {
            header

            Rectangle()
                .fill(ConchPalette.divider)
                .frame(height: 1)

            content
        }
        // No frame here. This view used to BE the settings window and sized it;
        // inside a TabView that became a second, competing demand and the
        // window grew past the screen with nothing to scroll. The scene owns
        // the size now.
        .background(ConchPalette.bg)
        .preferredColorScheme(.dark)
        .task {
            await store.load()
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Settings")
                    .font(ConchTypography.font(size: 18, weight: .semibold))
                    .foregroundStyle(ConchPalette.textPrimary)
                Text("Values are read from the running daemon.")
                    .font(ConchTypography.font(size: 12))
                    .foregroundStyle(ConchPalette.textDim)
            }

            Spacer()

            if store.isRefreshing, !store.isLoading {
                ProgressView()
                    .controlSize(.small)
            }

            Button {
                Task { await store.load() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
                    .frame(minHeight: 28)
            }
            .disabled(store.isRefreshing)
            .help("Reload settings from the daemon")
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 16)
    }

    @ViewBuilder
    private var content: some View {
        if store.isLoading, store.settings.isEmpty {
            VStack(spacing: 12) {
                ProgressView()
                Text("Loading settings…")
                    .font(ConchTypography.font(size: 12))
                    .foregroundStyle(ConchPalette.textDim)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.settings.isEmpty {
            SettingsEmptyView(feedback: store.globalFeedback) {
                Task { await store.load() }
            }
        } else {
            VStack(spacing: 0) {
                if let feedback = store.globalFeedback {
                    SettingsGlobalFeedback(feedback: feedback)
                }

                ScrollView {
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
                                .padding(.horizontal, 22)
                        }

                        SessionVoicesSection()
                    }
                    .padding(.bottom, 12)
                }
            }
        }
    }
}

/// Per-session voices, moved off the ledger — they are reference information,
/// not something you act on while triaging. Read straight from the daemon's
/// published snapshot; voices are session state, not a curated setting.
private struct SessionVoicesSection: View {
    @State private var rows: [(label: String, voice: String)] = []

    var body: some View {
        Group {
            if rows.isEmpty {
                EmptyView()
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Session voices")
                        .font(ConchTypography.font(size: 13, weight: .semibold))
                        .foregroundStyle(ConchPalette.textPrimary)
                    Text("Change one with `conch voice <session> <voice>`, or just say it.")
                        .font(ConchTypography.font(size: 11))
                        .foregroundStyle(ConchPalette.textDim)

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
                .padding(.horizontal, 22)
                .padding(.top, 18)
            }
        }
        .task { await load() }
    }

    private func load() async {
        let path = ProcessInfo.processInfo.environment["CONCH_SESSIONS_FILE"]
            ?? "/tmp/conch-sessions.json"
        let parsed: [(String, String)] = await Task.detached(priority: .utility) {
            guard let data = FileManager.default.contents(atPath: path),
                  let state = try? JSONDecoder().decode(PublishedState.self, from: data)
            else { return [] }
            return state.rows.compactMap { row in
                let voice = row.voice?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return voice.isEmpty ? nil : (row.label, voice)
            }
        }.value
        rows = parsed.map { (label: $0.0, voice: $0.1) }
    }
}

private struct SettingsEmptyView: View {
    let feedback: ConchSettingsFeedback?
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "gearshape")
                .font(.system(size: 24, weight: .light))
                .foregroundStyle(ConchPalette.textDim)
            Text(feedback?.text ?? "No settings were published")
                .font(ConchTypography.font(size: 13))
                .foregroundStyle(feedbackColor(feedback?.tone ?? .warning))
                .multilineTextAlignment(.center)
            Button("Try Again", action: onRetry)
                .frame(minHeight: 28)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct SettingsGlobalFeedback: View {
    let feedback: ConchSettingsFeedback

    var body: some View {
        Text(feedback.text)
            .font(ConchTypography.font(size: 12))
            .foregroundStyle(feedbackColor(feedback.tone))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 22)
            .padding(.vertical, 9)
            .background(ConchPalette.raised.opacity(0.72))
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
        "read-full": "Read the full reply",
        "interrupt-on-manual-reply": "Stop reading when you type",
        "handoff-order": "Hand-off order",
        "reveal-on-turn": "Raise the window on a finished turn",
        "reveal-typing-grace": "Don't raise while typing",
        "working-mic": "Open the mic while working",
        "voice-qa": "Voice Q&A",
        "resume-digest": "Digest on resume",
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

                    Text(metadata)
                        .font(ConchTypography.font(size: 11, weight: .medium))
                        .foregroundStyle(isReadOnly ? ConchPalette.textDim : ConchPalette.textFaint)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                HStack(alignment: .center, spacing: 10) {
                    if isPending {
                        ProgressView()
                            .controlSize(.small)
                    }

                    settingControl
                        .frame(width: 215, alignment: .trailing)
                        .disabled(isReadOnly || isPending)

                    // Shown only when there is something TO reset. A permanently
                    // dim Reset on every default row is chrome, not an affordance.
                    // The slot is RESERVED either way, or rows without a Reset
                    // slide right and the control column comes out jagged.
                    Group {
                        if setting.entry.source != .defaultValue, !isReadOnly {
                            Button("Reset", action: onReset)
                                .disabled(isPending)
                                .help("Remove the saved value and use the next available source")
                        } else {
                            // An empty Group collapses, so the frame reserved
                            // nothing and the control column still came out
                            // jagged. Something has to occupy the slot.
                            Color.clear
                        }
                    }
                    .frame(width: 76, height: 28, alignment: .trailing)
                }
                .frame(minHeight: 40)
            }

            if isReadOnly {
                Text("Set by the environment — a saved value cannot override it.")
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.textDim)
            }

            if let diagnostic = setting.entry.diagnostic?.trimmingCharacters(in: .whitespacesAndNewlines),
               !diagnostic.isEmpty,
               feedback == nil {
                Text(diagnostic)
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let feedback {
                Text(feedback.text)
                    .font(ConchTypography.font(size: 11, weight: .medium))
                    .foregroundStyle(feedbackColor(feedback.tone))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 15)
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
