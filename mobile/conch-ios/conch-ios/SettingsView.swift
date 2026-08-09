import SwiftUI

/// conch's settings, rendered from the daemon's own registry.
///
/// The daemon publishes every curated setting with its kind, bounds, choices,
/// default, help text, current value and source — precisely so a client does
/// not duplicate the registry and drift from it. Nothing here is hardcoded:
/// add a setting on the Mac and it appears on the phone.
struct SettingsView: View {
    @ObservedObject var bridge: BridgeClient
    @Environment(\.dismiss) private var dismiss

    @State private var entries: [ConchSetting] = []
    @State private var loadError: String?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let loadError {
                    VStack(spacing: 10) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 20))
                            .foregroundStyle(Palette.textDim)
                        Text(loadError)
                            .font(Type.summary)
                            .foregroundStyle(Palette.textDim)
                            .multilineTextAlignment(.center)
                        Button("Try again") { Task { await load() } }
                            .font(Type.caption.weight(.medium))
                            .foregroundStyle(Palette.micOpen)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(24)
                } else {
                    List {
                        ForEach($entries) { $entry in
                            SettingRow(setting: $entry) { value in
                                await apply(entry.key, value)
                            }
                            .listRowBackground(Palette.bg)
                            .listRowSeparatorTint(Palette.divider)
                        }

                        // What the connection actually did, so a failure away
                        // from the desk can be reported instead of guessed at.
                        Section("Connection") {
                            HStack {
                                Circle()
                                    .fill(bridge.isConnected ? Palette.working : Palette.needs)
                                    .frame(width: 7, height: 7)
                                Text(bridge.isConnected ? "Connected" : "Not connected")
                                    .font(Type.summary)
                                    .foregroundStyle(Palette.textPrimary)
                                Spacer()
                            }
                            .listRowBackground(Palette.bg)

                            if bridge.journal.isEmpty {
                                Text("No connection changes since the app opened.")
                                    .font(Type.caption)
                                    .foregroundStyle(Palette.textFaint)
                                    .listRowBackground(Palette.bg)
                            }
                            ForEach(bridge.journal.reversed()) { event in
                                HStack(alignment: .top, spacing: 8) {
                                    Text(event.at, style: .time)
                                        .font(Type.mono)
                                        .foregroundStyle(Palette.textFaint)
                                    Text(event.connected ? "connected" : (event.detail ?? "disconnected"))
                                        .font(Type.caption)
                                        .foregroundStyle(
                                            event.connected ? Palette.textDim : Palette.needs
                                        )
                                    Spacer(minLength: 0)
                                }
                                .listRowBackground(Palette.bg)
                                .listRowSeparatorTint(Palette.divider)
                            }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .background(Palette.bg)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
        .task { await load() }
    }

    private func load() async {
        loading = true
        loadError = nil
        switch await bridge.fetchSettings() {
        case let .loaded(settings):
            // Alphabetical by the name shown, not by registry order — a list
            // ordered by something invisible cannot be scanned.
            entries = settings.sorted { $0.displayName < $1.displayName }
        case let .failed(reason):
            loadError = reason
        }
        loading = false
    }

    private func apply(_ key: String, _ value: ConchSettingValue) async {
        guard await bridge.setSetting(key: key, value: value) else {
            loadError = "That didn't apply — the Mac may have gone away."
            return
        }
        await load()
    }
}

private struct SettingRow: View {
    @Binding var setting: ConchSetting
    let onChange: (ConchSettingValue) async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(setting.displayName)
                        .font(Type.label(16, weight: .medium))
                        .foregroundStyle(Palette.textPrimary)
                    Text(setting.help)
                        .font(Type.caption)
                        .foregroundStyle(Palette.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                control
            }

            if setting.isEnvLocked {
                Text("Set by the environment — can't be changed from here.")
                    .font(Type.caption)
                    .foregroundStyle(Palette.textFaint)
            }
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var control: some View {
        switch setting.value {
        case let .bool(on):
            Toggle("", isOn: Binding(
                get: { on },
                set: { next in Task { await onChange(.bool(next)) } }
            ))
            .labelsHidden()
            .disabled(setting.isEnvLocked)
        case let .number(value):
            Stepper(
                value: Binding(
                    get: { value },
                    set: { next in Task { await onChange(.number(next)) } }
                ),
                in: setting.range,
                step: setting.step
            ) {
                Text(setting.formatted)
                    .font(Type.mono)
                    .foregroundStyle(Palette.textPrimary)
                    .monospacedDigit()
            }
            .disabled(setting.isEnvLocked)
            .fixedSize()
        case let .string(current):
            if setting.choices.isEmpty {
                Text(current)
                    .font(Type.mono)
                    .foregroundStyle(Palette.textDim)
            } else {
                Picker("", selection: Binding(
                    get: { current },
                    set: { next in Task { await onChange(.string(next)) } }
                )) {
                    ForEach(setting.choices, id: \.self) { choice in
                        Text(choice).tag(choice)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .disabled(setting.isEnvLocked)
            }
        }
    }
}
