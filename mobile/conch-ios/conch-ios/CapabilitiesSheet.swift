import ConchDesign
import SwiftUI

/// What is this session actually carrying? The Mac's inspector, on the phone.
///
/// An inspector, not a settings screen: conch attaches to sessions it did not start, so it can
/// read what a session is CONFIGURED with and cannot know what the running process LOADED. The
/// one honest switch says so on its face: a plugin or MCP server's "next session" toggle edits
/// the agent's own file, shows the diff first, and only Apply writes. The running session is
/// never touched.
struct CapabilitiesSheet: View {
    @ObservedObject var bridge: BridgeClient
    let row: PublishedState.Row
    /// Restart onto the installed version, asked once this sheet has gone; nil where the session has
    /// no terminal to restart in.
    var onRestart: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var inventory: AgentCapabilities?
    @State private var install: AgentInstall?
    @State private var loading = true
    /// Bumped after a switch is written, so the inventory is read again rather than assumed.
    @State private var reloads = 0
    @State private var pending: PendingToggle?

    struct PendingToggle: Identifiable {
        let entity: AgentCapabilities.Entity
        let enabled: Bool
        var id: String { entity.id }
    }

    private static let order = ["mcp-server", "plugin", "skill"]
    private static let titles = ["mcp-server": "MCP servers", "plugin": "Plugins", "skill": "Skills"]

    var body: some View {
        NavigationStack {
            Group {
                if loading && inventory == nil {
                    ProgressView("Reading what this session carries…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let inventory {
                    list(inventory)
                } else {
                    VStack(spacing: 10) {
                        Text("Couldn't read this session's capabilities.")
                            .font(Type.summary).foregroundStyle(Palette.textDim)
                        Button("Try again") { reloads += 1 }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Palette.bg)
            .navigationTitle(row.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .task(id: reloads) {
            loading = true
            // Empty: the daemon resolves the session's own folder, which it knows and the phone does not.
            let read = await bridge.capabilities(backend: row.backend ?? "claude", cwd: "", sessionId: row.id)
            inventory = read?.inventory
            install = read?.install
            loading = false
        }
        .sheet(item: $pending) { pending in
            if let context = inventory?.context {
                ConfigToggleSheet(
                    bridge: bridge, entity: pending.entity, enabled: pending.enabled,
                    agent: context.backend, projectDir: context.cwd,
                    onApplied: { reloads += 1 }
                )
            }
        }
    }

    private func list(_ inventory: AgentCapabilities) -> some View {
        List {
            Section {
                header(inventory)
            }
            .listRowBackground(Palette.bg)
            if !inventory.complete {
                // A source could not be read: the list is a floor, not a census.
                Text("Some sources couldn't be read, so this may not be everything.")
                    .font(Type.caption).foregroundStyle(Palette.caution)
                    .listRowBackground(Palette.bg)
            }
            if inventory.entities.isEmpty {
                Text("Nothing configured for this session.")
                    .font(Type.summary).foregroundStyle(Palette.textDim)
                    .listRowBackground(Palette.bg)
            }
            ForEach(Self.order, id: \.self) { kind in
                let entities = inventory.entities.filter { $0.kind == kind && $0.parentId == nil }
                if !entities.isEmpty {
                    Section(Self.titles[kind] ?? kind) {
                        ForEach(entities) { entity in
                            EntityRow(
                                entity: entity,
                                tools: inventory.entities.filter { $0.kind == "mcp-tool" && $0.parentId == entity.id },
                                onToggle: entity.isToggleable && bridge.isConnected
                                    ? { pending = PendingToggle(entity: entity, enabled: $0) } : nil
                            )
                            .listRowBackground(Palette.bg)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }

    @ViewBuilder
    private func header(_ inventory: AgentCapabilities) -> some View {
        let context = inventory.context
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(context.backend == "codex" ? "Codex" : "Claude")
                if let trust = context.projectTrust {
                    Text("·").foregroundStyle(Palette.textFaint)
                    // Three states: nil is not knowing, never a refusal.
                    Text(trust.trusted == nil ? "trust unknown" : (trust.trusted == true ? "trusted" : "not trusted"))
                        .foregroundStyle(trust.trusted == false ? Palette.needs : Palette.textDim)
                }
            }
            .font(Type.caption).foregroundStyle(Palette.textDim)
            Text(shortHomePath(context.cwd))
                .font(Type.caption).foregroundStyle(Palette.textFaint)
                .lineLimit(1).truncationMode(.head)
            if let thread = context.threadConfiguration {
                // What Codex recorded for this thread, not a claim about what is live now.
                Text(([thread.model, thread.reasoningEffort, thread.approvalMode, thread.sandboxPolicy].compactMap { $0 })
                    .joined(separator: " · "))
                    .font(Type.caption).foregroundStyle(Palette.textFaint)
            }
            if let install {
                VStack(alignment: .leading, spacing: 4) {
                    Text([install.version.map { "v\($0)" }, install.locationLabel].compactMap { $0 }.joined(separator: " · "))
                        .font(Type.caption).foregroundStyle(Palette.textDim)
                    if install.behind, let newer = install.newerVersion {
                        Text(install.restartToUpdate == true
                            ? "v\(newer) is installed. Restarting the session runs it."
                            : "v\(newer) is running elsewhere on your Mac."
                                + (install.updateCommand.map { " Update this one with: \($0)" } ?? ""))
                            .font(Type.caption).foregroundStyle(Palette.caution)
                            .textSelection(.enabled)
                        if install.restartToUpdate == true, let onRestart {
                            Button("Restart session…") {
                                onRestart()
                                dismiss()
                            }
                            .font(Type.caption.weight(.medium))
                            .buttonStyle(.borderless)
                        }
                    }
                }
                .padding(.top, 2)
            }
        }
    }
}

/// One plugin, skill or server: what kind of thing it is, the evidence it leads with, and the
/// "next session" switch where conch can honestly write one. A server's tools fold under it.
private struct EntityRow: View {
    let entity: AgentCapabilities.Entity
    let tools: [AgentCapabilities.Entity]
    let onToggle: ((Bool) -> Void)?
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(entity.displayName)
                        .font(Type.body.weight(.medium))
                        .foregroundStyle(entity.isUnavailable ? Palette.textDim : Palette.textPrimary)
                    if let summary = entity.kindSummary {
                        Text(summary).font(Type.caption).foregroundStyle(Palette.textDim).lineLimit(2)
                    }
                    Text(chip)
                        .font(Type.caption.weight(.medium))
                        .foregroundStyle(chipTint)
                }
                Spacer(minLength: 8)
                if let onToggle {
                    // The file's position for the NEXT session, never a claim about the running one.
                    Toggle("Next session", isOn: Binding(get: { entity.enabledForNextSession }, set: { onToggle($0) }))
                        .labelsHidden()
                        .accessibilityLabel("\(entity.displayName) in the next session")
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() } }

            if expanded {
                VStack(alignment: .leading, spacing: 3) {
                    if let description = entity.description, !description.isEmpty {
                        Text(description).font(Type.caption).foregroundStyle(Palette.textDim)
                    }
                    // Each state, its value, and how conch knows: every claim carries its basis.
                    ForEach(evidenceLines, id: \.0) { name, state, detail in
                        Text("\(name): \(state)\(detail.isEmpty ? "" : " — \(detail)")")
                            .font(Type.caption).foregroundStyle(state == "no" ? Palette.needs : Palette.textFaint)
                    }
                    ForEach(Array(entity.kindLines.enumerated()), id: \.offset) { _, line in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(line.0).foregroundStyle(Palette.textFaint).frame(width: 92, alignment: .leading)
                            Text(line.1).foregroundStyle(Palette.textDim).textSelection(.enabled)
                        }
                        .font(Type.caption)
                    }
                    if !tools.isEmpty {
                        Text(tools.count == 1 ? "1 tool" : "\(tools.count) tools")
                            .font(Type.caption.weight(.medium)).foregroundStyle(Palette.textDim).padding(.top, 4)
                        ForEach(tools) { tool in
                            VStack(alignment: .leading, spacing: 1) {
                                Text(tool.displayName).font(Type.caption).foregroundStyle(Palette.textPrimary)
                                if let summary = tool.kindSummary {
                                    Text(summary).font(Type.caption).foregroundStyle(Palette.textFaint)
                                }
                            }
                        }
                    }
                }
                .transition(.opacity)
            }
        }
        .padding(.vertical, 3)
    }

    /// One word for what conch knows about it, as the Mac's chip: disabled leads, then configured,
    /// then seen in use (`headline`). Never a bare "absent": the reader can only say it is off
    /// WHERE IT LOOKED.
    private var chip: String {
        if entity.isObservedOnly { return "observed" }
        switch entity.headline.state {
        case "yes": return "configured"
        case "no": return "disabled"
        default: return "unknown"
        }
    }

    /// Unknown is the common case and must not read as a warning; only disabled catches the eye.
    private var chipTint: Color {
        if entity.isObservedOnly { return Palette.calm }
        switch entity.headline.state {
        case "yes": return Palette.textDim
        case "no": return Palette.needs
        default: return Palette.textFaint
        }
    }

    private var evidenceLines: [(String, String, String)] {
        [
            ("configured", entity.evidence.configured.state, entity.evidence.configured.detail),
            ("available", entity.evidence.available.state, entity.evidence.available.detail),
            ("loaded", entity.evidence.loaded.state, entity.evidence.loaded.detail),
            ("observed", entity.evidence.observed.state, entity.evidence.observed.detail),
        ]
    }
}

/// The diff before the write. The daemon plans the edit against the file as it is now and this
/// shows exactly that: the file, the scope, the diff, and that it is for the NEXT session. Apply
/// sends the preview's hash back, so a file that moved in between is refused, not overwritten.
private struct ConfigToggleSheet: View {
    @ObservedObject var bridge: BridgeClient
    let entity: AgentCapabilities.Entity
    let enabled: Bool
    let agent: String
    let projectDir: String
    let onApplied: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var scope: String
    @State private var plan: BridgeClient.ConfigTogglePlan?
    @State private var message: String?
    @State private var busy = false
    @State private var applied = false

    init(bridge: BridgeClient, entity: AgentCapabilities.Entity, enabled: Bool, agent: String, projectDir: String, onApplied: @escaping () -> Void) {
        self.bridge = bridge
        self.entity = entity
        self.enabled = enabled
        self.agent = agent
        self.projectDir = projectDir
        self.onApplied = onApplied
        let perProject = agent == "claude" && entity.kind == "mcp-server"
        _scope = State(initialValue: !perProject && entity.scope == "user" ? "user" : "project")
    }

    /// Claude Code keeps MCP enablement per project; there is no user-wide off to offer.
    private var perProjectOnly: Bool { agent == "claude" && entity.kind == "mcp-server" }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Scope", selection: $scope) {
                        Text("User").tag("user")
                        Text("Project").tag("project")
                    }
                    .pickerStyle(.segmented)
                    .disabled(perProjectOnly || busy || applied)
                } footer: {
                    Text(perProjectOnly
                        ? "Claude Code keeps MCP enablement per project. Applies to the next session; a running session is untouched."
                        : "Applies to the next session; a running session is untouched.")
                }
                Section {
                    if let plan {
                        Text(plan.file).font(Type.caption).foregroundStyle(Palette.textDim).lineLimit(1).truncationMode(.middle)
                        ScrollView(.horizontal) {
                            Text(plan.diff.isEmpty ? "No change: the file already says so." : plan.diff)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(Palette.textPrimary)
                                .textSelection(.enabled)
                                .padding(.vertical, 4)
                        }
                    } else if message == nil {
                        ProgressView("Reading the file…")
                    }
                    if let message {
                        Text(message).font(Type.caption).foregroundStyle(applied ? Palette.textDim : Palette.needs)
                    }
                }
            }
            .navigationTitle("\(enabled ? "Enable" : "Disable") \(entity.displayName)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(applied ? "Done" : "Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") { Task { await apply() } }
                        .disabled(plan == nil || plan?.diff.isEmpty == true || busy || applied)
                }
            }
        }
        .task(id: scope) { await preview() }
    }

    private func send(preview: Bool) async -> BridgeClient.ConfigToggleOutcome {
        await bridge.toggleCapability(
            agent: agent, scope: scope, projectDir: scope == "project" ? projectDir : nil,
            capability: entity.kind, id: entity.configId, enabled: enabled,
            preview: preview, expectBeforeHash: preview ? nil : plan?.beforeHash
        )
    }

    private func preview() async {
        plan = nil
        message = nil
        switch await send(preview: true) {
        case let .plan(next): plan = next
        case let .refused(reason): message = reason
        }
    }

    private func apply() async {
        busy = true
        defer { busy = false }
        switch await send(preview: false) {
        case let .plan(result) where result.applied:
            applied = true
            message = "Written to \(shortHomePath(result.file)). The next session picks it up."
            onApplied()
        case .plan:
            message = "The Mac didn't write it."
        case let .refused(reason):
            // The daemon's own words: a file that moved since the preview is refused, not overwritten.
            message = reason
        }
    }
}
