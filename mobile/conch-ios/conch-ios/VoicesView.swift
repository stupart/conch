import ConchDesign
import SwiftUI

/// Reference information from the Mac's Settings, read straight from the published state: what
/// hears you (the speech engine), what speaks (the natural voices), the voice each session is read
/// in, and each agent's own default model and effort. Nothing here is a switch.
struct VoicesView: View {
    @ObservedObject var bridge: BridgeClient

    private var sessionVoices: [(label: String, voice: String)] {
        (bridge.state?.rows ?? []).compactMap { row in
            guard row.parentSessionId == nil,
                  let voice = row.voice?.trimmingCharacters(in: .whitespacesAndNewlines), !voice.isEmpty else { return nil }
            return (row.label, voice)
        }
    }

    var body: some View {
        List {
            Section("On your Mac") {
                if let engine = bridge.state?.speechEngine {
                    status(Self.headline(engine), detail: engine.problem.map(Self.problem) ?? engine.detail, ready: engine.state == "ready")
                }
                if let natural = bridge.state?.naturalVoices {
                    status(Self.headline(natural), detail: natural.detail, ready: natural.state == "ready")
                }
                if bridge.state?.speechEngine == nil, bridge.state?.naturalVoices == nil {
                    Text("Your Mac hasn't said how its voices stand.").font(Type.caption).foregroundStyle(Palette.textDim)
                }
            }
            .listRowBackground(Palette.bg)

            if !sessionVoices.isEmpty {
                Section {
                    ForEach(sessionVoices, id: \.label) { entry in
                        HStack {
                            Text(entry.label).font(Type.summary).foregroundStyle(Palette.textPrimary).lineLimit(1)
                            Spacer(minLength: 12)
                            Text(entry.voice).font(Type.caption).foregroundStyle(Palette.textDim).lineLimit(1)
                        }
                        .listRowBackground(Palette.bg)
                    }
                } header: {
                    Text("Session voices")
                } footer: {
                    Text("Change one on your Mac with `conch voice <session> <voice>`, or just say it.")
                }
            }

            if let catalog = bridge.state?.sessionSettings, catalog.claude != nil || catalog.codex != nil {
                Section {
                    if let claude = catalog.claude { agent("Claude Code", claude.defaults) }
                    if let codex = catalog.codex { agent("Codex", codex.defaults) }
                } header: {
                    Text("Agent defaults")
                } footer: {
                    Text("Read from each agent's own config; conch doesn't change them. A model or effort picked in a session's menu is for that session only.")
                }
                .listRowBackground(Palette.bg)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Palette.bg)
        .navigationTitle("Voices & agents")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func status(_ headline: String, detail: String?, ready: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(headline).font(Type.summary.weight(.medium)).foregroundStyle(ready ? Palette.textPrimary : Palette.textDim)
            if let detail, !detail.isEmpty {
                Text(detail).font(Type.caption).foregroundStyle(Palette.textDim).textSelection(.enabled)
            }
        }
    }

    private func agent(_ name: String, _ defaults: AgentSettingsCatalog.Defaults) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(name).font(Type.summary.weight(.medium)).foregroundStyle(Palette.textPrimary)
            Text(SessionSettingsPresentation.defaultsLine(defaults)).font(Type.caption).foregroundStyle(Palette.textDim)
            ForEach(SessionSettingsPresentation.perModelEffortLines(defaults), id: \.self) { line in
                Text(line).font(Type.caption).foregroundStyle(Palette.textDim)
            }
            Text(defaults.source.map(shortHomePath) ?? "No config file found")
                .font(Type.caption).foregroundStyle(Palette.textFaint).lineLimit(1).truncationMode(.middle)
        }
    }

    /// The Mac's own lines (its Settings ▸ Session voices), from the same published fields.
    static func headline(_ engine: SpeechEngineReport) -> String {
        switch engine.state {
        case "ready": return "Speech engine: ready"
        case "downloading":
            guard let progress = engine.progress, progress.total > 0 else { return "Speech engine: downloading…" }
            return "Speech engine: downloading… \(Int((progress.bytes / progress.total * 100).rounded(.down)))%"
        case "checking": return "Speech engine: checking…"
        default: return "Speech engine: off" + (engine.reason.map { " (\($0))" } ?? "")
        }
    }

    static func headline(_ natural: NaturalVoicesReport) -> String {
        switch natural.state {
        case "ready": return "Natural voices: ready"
        case "setting-up": return "Natural voices: setting up…" + (natural.percent.map { " \($0)%" } ?? "")
        case "checking": return "Natural voices: checking…"
        default: return "Natural voices: off" + (natural.reason.map { " (\($0))" } ?? "")
        }
    }

    private static func problem(_ problem: SpeechEngineReport.Problem) -> String {
        switch problem.kind {
        case "offline": return "Waiting for the network to download the speech model."
        case "no-space": return "Not enough free space on your Mac for the speech model."
        default: return "The last attempt didn't finish; it will try again."
        }
    }
}

/// What the ledger's marks mean, in the calm → act-now order they escalate in: the Mac's legend,
/// drawn from the phone's own marks so the two can't disagree.
struct MarksLegendView: View {
    private static let marks: [StatusMark] = [
        .working, .waitingOnAgents, .micOpen, .waiting, .needs, .review, .speaking, .usageLimit, .agentPaused, .idle,
    ]

    var body: some View {
        List {
            Section {
                ForEach(Self.marks, id: \.symbol) { mark in
                    row(symbol: mark.symbol, color: mark.color, meaning: mark.meaning)
                }
                row(symbol: SessionVoice.Mark.quiet.symbol, color: Palette.textDim, meaning: SessionVoice.Mark.quiet.meaning)
                row(symbol: SessionVoice.Mark.speaks.symbol, color: Palette.textDim, meaning: SessionVoice.Mark.speaks.meaning)
                row(symbol: "diamond.fill", color: Palette.textDim, meaning: "Prioritised — jumps the queue")
            } footer: {
                Text("Saying a session's name addresses it.")
            }
            .listRowBackground(Palette.bg)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Palette.bg)
        .navigationTitle("What the marks mean")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(symbol: String, color: Color, meaning: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 13)).foregroundStyle(color).frame(width: 22)
            Text(meaning).font(Type.summary).foregroundStyle(Palette.textPrimary)
        }
        .accessibilityElement(children: .combine)
    }
}
