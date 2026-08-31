import SwiftUI

/// What is this session actually carrying?
///
/// An inspector, deliberately, not a settings screen. conch attaches to
/// sessions it did not start, so almost nothing here can be honestly switched:
/// it can read what a session is CONFIGURED with while having no way to know
/// what the running process actually LOADED. A control that pretended
/// otherwise would be the one lie this whole feature exists to avoid, so this
/// pass shows no controls at all.
///
/// The two agents stay apart for the same reason. Codex records an explicit
/// `enabled` flag per MCP server in `config.toml`; Claude records per-project
/// enable and disable lists in `~/.claude.json`. Those are different
/// mechanisms, and merging them into one row would invent a switch that works
/// for one and misleads for the other.
struct CapabilityInspectorView: View {
    let capabilities: AgentCapabilities?
    let isLoading: Bool
    let sessionLabel: String
    /// Debug captures open every row, so a screenshot can prove what the
    /// detail actually renders. Never set from the UI.
    var expandAll: Bool = false
    @State private var expanded: Set<String> = []

    private static let order = ["mcp-server", "plugin", "skill"]

    private static let groupTitles = [
        "mcp-server": "MCP servers",
        "plugin": "Plugins",
        "skill": "Skills",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(ConchPalette.textDim.opacity(0.14))
            if isLoading && capabilities == nil {
                centred("Reading what this session carries…")
            } else if let capabilities {
                if capabilities.entities.isEmpty {
                    centred("Nothing configured for this session")
                } else {
                    ScrollView { groups(capabilities) }
                }
            } else {
                centred("Could not read this session's capabilities")
            }
        }
        .background(ConchPalette.bg)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(sessionLabel)
                .font(ConchTypography.font(size: 15, weight: .medium))
                .foregroundStyle(ConchPalette.textPrimary)
            if let context = capabilities?.context {
                HStack(spacing: 8) {
                    Text(context.backend == "codex" ? "Codex" : "Claude")
                        .font(ConchTypography.font(size: 11))
                        .foregroundStyle(ConchPalette.textDim)
                    if let trust = context.projectTrust {
                        Text("·").foregroundStyle(ConchPalette.textFaint)
                        // Three states, not two, and the third is honest about
                        // being ignorance rather than a refusal. nil arises BOTH
                        // when no decision was recorded and when conch could not
                        // read the file that would hold one, so it must not
                        // claim the decision has not been made. The tooltip
                        // carries the reader's own detail, which distinguishes
                        // them.
                        Text(trust.trusted == nil
                            ? "trust unknown"
                            : (trust.trusted == true ? "trusted" : "not trusted"))
                            .font(ConchTypography.font(size: 11))
                            .foregroundStyle(trust.trusted == false
                                ? ConchPalette.statusNeeds
                                : ConchPalette.textDim)
                            .help(trust.detail)
                    }
                }
                if let thread = context.threadConfiguration {
                    // Codex records this per thread, which is real evidence and
                    // far better than a global default — but the reader's own
                    // contract calls it "configuration persisted for one
                    // thread", not a launch snapshot, and nothing establishes
                    // the values have not changed since. So: what Codex
                    // recorded, not what the session started with.
                    Text(threadLine(thread))
                        .font(ConchTypography.font(size: 10.5))
                        .foregroundStyle(ConchPalette.textFaint)
                }
            }
            if let capabilities, !capabilities.complete {
                // Deliberately does not name a cause. Incompleteness also
                // arises from a row limit or a missing package, so claiming
                // "sources could not be read" could itself be false — and the
                // diagnostics below are what actually explain it.
                Text("This list is a floor, not a census.")
                    .font(ConchTypography.font(size: 10.5))
                    .foregroundStyle(ConchPalette.statusWaiting)
            }
            // Inventory-level diagnostics were decoded and never shown, so a
            // partial read could look like an authoritative empty one.
            if let capabilities {
                ForEach(capabilities.diagnostics.indices, id: \.self) { index in
                    if let message = capabilities.diagnostics[index].message {
                        Text(message)
                            .font(ConchTypography.font(size: 10.5))
                            .foregroundStyle(ConchPalette.statusWaiting)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func threadLine(_ thread: AgentCapabilities.ThreadConfiguration) -> String {
        let parts = [thread.model, thread.reasoningEffort, thread.approvalMode, thread.sandboxPolicy]
            .compactMap { $0 }
        return parts.isEmpty ? "" : "Codex recorded " + parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func groups(_ capabilities: AgentCapabilities) -> some View {
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
            ForEach(Self.order, id: \.self) { kind in
                let rows = capabilities.entities.filter { $0.kind == kind }
                if !rows.isEmpty {
                    // The same name legitimately appears more than once: a
                    // plugin installed at user scope and again from a project
                    // marketplace are different entities with identical names.
                    // Rendering both as bare "context7" made the list look like
                    // it was repeating itself. Scope is shown ONLY where it
                    // tells two rows apart — on every row it would be noise.
                    let badges = disambiguators(for: rows, in: capabilities.entities)
                    Section {
                        ForEach(rows) { entity in
                            CapabilityRow(
                                entity: entity,
                                children: capabilities.entities.filter { $0.parentId == entity.id },
                                badge: badges[entity.id],
                                isExpanded: expandAll || expanded.contains(entity.id),
                                toggle: {
                                    if expanded.contains(entity.id) { expanded.remove(entity.id) }
                                    else { expanded.insert(entity.id) }
                                }
                            )
                        }
                    } header: {
                        HStack {
                            Text(Self.groupTitles[kind] ?? kind)
                                .font(ConchTypography.font(size: 10.5, weight: .medium))
                                .foregroundStyle(ConchPalette.textDim)
                                .textCase(.uppercase)
                                .tracking(0.5)
                            Spacer()
                            Text("\(rows.count)")
                                .font(ConchTypography.font(size: 10.5))
                                .foregroundStyle(ConchPalette.textFaint)
                                .monospacedDigit()
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 7)
                        .background(ConchPalette.bg)
                    }
                }
            }
        }
        .padding(.bottom, 14)
    }

    /// What tells namesakes apart — and nothing when nothing does.
    ///
    /// The same name legitimately appears more than once: a plugin installed at
    /// user scope and again from a project marketplace are different entities
    /// with identical names. But the obvious label is not always the
    /// distinguishing one. Two `context7` MCP servers both have scope
    /// "plugin"; what differs is the scope of the PLUGIN that owns them, one
    /// local and one user. Labelling both "plugin" reads as a badge that
    /// failed, which is worse than no badge at all — so a row gets one only
    /// when it genuinely separates it from its namesake.
    private func disambiguators(
        for rows: [AgentCapabilities.Entity],
        in all: [AgentCapabilities.Entity]
    ) -> [String: String] {
        var result: [String: String] = [:]
        let byName = Dictionary(grouping: rows, by: \.displayName)
        for (_, group) in byName where group.count > 1 {
            let ownScopes = Set(group.map(\.scope))
            if ownScopes.count == group.count {
                for entity in group { result[entity.id] = entity.scope }
                continue
            }
            let parentScope = { (entity: AgentCapabilities.Entity) -> String? in
                guard let parentId = entity.parentId else { return nil }
                return all.first { $0.id == parentId }?.scope
            }
            let parentScopes = group.map(parentScope)
            if Set(parentScopes.compactMap { $0 }).count == group.count {
                for entity in group {
                    // Say whose scope it is. A bare "user" on a server whose own
                    // scope is "plugin" reads as the server's scope and is not.
                    if let scope = parentScope(entity) { result[entity.id] = "from \(scope)" }
                }
                continue
            }
            // Last resort: where they came from. Two same-named skills in
            // different discovery roots, or the same server key in a root and a
            // nested `.mcp.json`, share both their own scope and their owner's
            // — and would otherwise render as identical rows, which is the
            // thing this whole function exists to prevent.
            let paths = group.map { $0.sources.first?.path }
            if Set(paths.compactMap { $0 }).count == group.count {
                for entity in group {
                    if let path = entity.sources.first?.path {
                        result[entity.id] = shorten(path)
                    }
                }
            }
            // Otherwise: leave them unlabelled. Two rows that conch genuinely
            // cannot tell apart should look like two rows, not like two broken
            // badges.
        }
        return result
    }

    /// Enough of a path to tell two of them apart, from the end where they
    /// differ rather than the start where they usually do not.
    private func shorten(_ path: String) -> String {
        let parts = path.split(separator: "/")
        return parts.suffix(2).joined(separator: "/")
    }

    private func centred(_ text: String) -> some View {
        VStack {
            Spacer()
            Text(text)
                .font(ConchTypography.font(size: 12))
                .foregroundStyle(ConchPalette.textFaint)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}

private struct CapabilityRow: View {
    let entity: AgentCapabilities.Entity
    let children: [AgentCapabilities.Entity]
    /// What tells this row apart from a namesake, or nil when it is unique.
    let badge: String?
    let isExpanded: Bool
    let toggle: () -> Void
    @State private var isHovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: toggle) {
                HStack(alignment: .firstTextBaseline, spacing: 9) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(ConchPalette.textFaint)
                        .frame(width: 10)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(entity.displayName)
                                .font(ConchTypography.font(size: 12.5))
                                .foregroundStyle(ConchPalette.textPrimary)
                                .lineLimit(1)
                            if let badge {
                                Text(badge)
                                    .font(ConchTypography.font(size: 9.5))
                                    .foregroundStyle(ConchPalette.textFaint)
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1)
                                    .background(ConchPalette.raised, in: Capsule())
                            }
                        }
                        if let description = entity.description, !description.isEmpty {
                            Text(description)
                                .font(ConchTypography.font(size: 10.5))
                                .foregroundStyle(ConchPalette.textFaint)
                                .lineLimit(1)
                        }
                        if let summary = entity.kindSummary {
                            Text(summary)
                                .font(ConchTypography.font(size: 10))
                                .foregroundStyle(ConchPalette.textFaint.opacity(0.85))
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    Spacer(minLength: 8)
                    if !children.isEmpty {
                        Text("\(children.count)")
                            .font(ConchTypography.font(size: 10))
                            .foregroundStyle(ConchPalette.textFaint)
                            .monospacedDigit()
                    }
                    EvidenceChip(evidence: entity.headline, observedOnly: entity.isObservedOnly)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(isHovering ? ConchPalette.hover : .clear)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { isHovering = $0 }

            if isExpanded { detail }
        }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 5) {
            // What it IS, before what conch knows about it. A transport, a
            // version, an approval mode — the facts the readers gather and the
            // row used to throw away.
            ForEach(entity.kindLines, id: \.0) { line in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(line.0)
                        .font(ConchTypography.font(size: 10))
                        .foregroundStyle(ConchPalette.textFaint)
                        .frame(width: 66, alignment: .leading)
                    Text(line.1)
                        .font(ConchTypography.font(size: 10))
                        .foregroundStyle(ConchPalette.textDim)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if !entity.kindLines.isEmpty {
                Divider().overlay(ConchPalette.textDim.opacity(0.1)).padding(.vertical, 2)
            }
            // Every state, with the reason conch believes it. This is the part
            // that makes "unknown" legible rather than broken-looking.
            ForEach(evidenceLines, id: \.0) { line in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(line.0)
                        .font(ConchTypography.font(size: 10))
                        .foregroundStyle(ConchPalette.textFaint)
                        .frame(width: 66, alignment: .leading)
                    Text(line.1)
                        .font(ConchTypography.font(size: 10, weight: .medium))
                        .foregroundStyle(line.1 == "no"
                            ? ConchPalette.statusNeeds
                            : (line.1 == "yes" ? ConchPalette.textDim : ConchPalette.textFaint))
                        .frame(width: 46, alignment: .leading)
                    Text(line.2)
                        .font(ConchTypography.font(size: 10))
                        .foregroundStyle(ConchPalette.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            ForEach(entity.sources, id: \.path) { source in
                Text("\(source.scope) · \(source.path)")
                    .font(ConchTypography.font(size: 10))
                    .foregroundStyle(ConchPalette.textFaint)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            ForEach(entity.diagnostics.indices, id: \.self) { index in
                if let message = entity.diagnostics[index].message {
                    Text(message)
                        .font(ConchTypography.font(size: 10))
                        .foregroundStyle(ConchPalette.statusWaiting)
                }
            }
            ForEach(children) { child in
                HStack(spacing: 8) {
                    Text(child.displayName)
                        .font(ConchTypography.font(size: 10.5))
                        .foregroundStyle(ConchPalette.textDim)
                    if let approval = child.mcpTool?.approvalMode ?? child.mcpTool?.policy {
                        Text(approval)
                            .font(ConchTypography.font(size: 9.5))
                            .foregroundStyle(ConchPalette.textFaint)
                    }
                    Spacer(minLength: 8)
                    EvidenceChip(evidence: child.headline, observedOnly: child.isObservedOnly)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.leading, 19)
        .padding(.bottom, 9)
    }

    /// Each state, its VALUE, and how conch knows — the prose alone left the
    /// actual state and basis invisible, which is most of "every claim carries
    /// its basis".
    private var evidenceLines: [(String, String, String)] {
        [
            ("configured", entity.evidence.configured.state, entity.evidence.configured.detail),
            ("available", entity.evidence.available.state, entity.evidence.available.detail),
            ("loaded", entity.evidence.loaded.state, entity.evidence.loaded.detail),
            ("observed", entity.evidence.observed.state, entity.evidence.observed.detail),
        ]
    }
}

/// One word for what conch knows, coloured by how sure it is.
private struct EvidenceChip: View {
    let evidence: AgentCapabilities.Evidence
    let observedOnly: Bool

    var body: some View {
        Text(label)
            .font(ConchTypography.font(size: 9.5, weight: .medium))
            .foregroundStyle(tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.12), in: Capsule())
            .help(evidence.detail)
    }

    private var label: String {
        if observedOnly { return "observed" }
        switch evidence.state {
        case "yes": return "configured"
        // Never a bare "absent": the reader can only say a thing is switched
        // off or denied WHERE IT LOOKED, which is not the same as absent from
        // the running session.
        case "no": return "disabled"
        default: return "unknown"
        }
    }

    /// Unknown is the common case here and must not read as a warning — conch
    /// genuinely cannot see inside a session it did not start, and saying so
    /// calmly is the honest thing. Colour is reserved for the states that
    /// actually differ from the norm.
    private var tint: Color {
        if observedOnly { return ConchPalette.statusWorking }
        switch evidence.state {
        case "yes": return ConchPalette.textDim
        // The one state that has to catch the eye: everything else on this
        // screen is a fact about configuration, and this one is a thing that
        // will not work.
        case "no": return ConchPalette.statusNeeds
        default: return ConchPalette.textFaint
        }
    }
}

/// The inspector as a sheet, owning its own fetch.
///
/// Split out of `DashboardView` because inlining it there defeated Swift's
/// type-checker — that view's body is already large enough that one more
/// closure with an async task pushed it past the limit. Owning the state here
/// is also simply correct: the fetch belongs to the thing being presented.
struct CapabilityInspectorSheet: View {
    let row: SessionRow
    /// Set only by a debug capture, so a screenshot shows the expanded detail.
    var expandAll: Bool = false
    let onDone: () -> Void

    @EnvironmentObject private var store: StateStore
    @State private var capabilities: AgentCapabilities?
    @State private var isLoading = true

    var body: some View {
        CapabilityInspectorView(
            capabilities: capabilities,
            isLoading: isLoading,
            sessionLabel: row.label,
            expandAll: expandAll
        )
        .frame(width: 620, height: 560)
        .overlay(alignment: .topTrailing) {
            Button("Done", action: onDone)
                .keyboardShortcut(.cancelAction)
                .padding(12)
        }
        .task(id: row.id) {
            // Read on open rather than continuously: this is a deliberate look,
            // and 35-48ms against real configuration is cheap enough that
            // asking again beats deciding when a cache went stale.
            isLoading = true
            capabilities = await store.capabilities(
                backend: row.backend ?? "claude",
                // Empty: the daemon resolves the session's own directory,
                // which it already knows and the app does not.
                cwd: "",
                sessionId: row.id
            )
            isLoading = false
        }
    }
}
