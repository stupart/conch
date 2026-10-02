import ConchDesign
import SwiftUI

/// The Mac's ⌘K, for one session: conch's controls, session actions, the agent's slash commands and
/// its skills, in one searchable list, each row saying what it will do.
///
/// A typed line is put in the composer, not sent: on a phone a stray tap on `/clear` should cost a
/// look, and the argument a command takes is typed after it there, as in the terminal.
struct CommandsSheet: View {
    enum Category: String, CaseIterable {
        case conch = "conch"
        case session = "Session"
        case provider = "Slash commands"
        case skills = "Skills"
    }

    enum Action: Equatable {
        case toggleQuiet, rename, reveal, dismiss, inspect
        /// Put this line in the composer; `takesArgument` leaves a space after it.
        case type(String, takesArgument: Bool)
    }

    struct Entry: Identifiable, Equatable {
        let id: String
        let group: Category
        let title: String
        let detail: String
        var argumentHint: String?
        let action: Action
    }

    @ObservedObject var bridge: BridgeClient
    let row: PublishedState.Row
    let everythingQuiet: Bool
    /// Carried out by the session screen, which owns the composer, the alerts and the sheets, once
    /// this sheet has gone.
    let onAction: (Action) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var capabilities: AgentCapabilities?
    @State private var readSkills = false

    /// Typing needs a pane the daemon can reach, which is what `revealable` says (the Mac's rule).
    private var canType: Bool { row.parentSessionId == nil && row.revealable }

    private var entries: [Entry] {
        var out: [Entry] = []
        guard row.parentSessionId == nil else { return out }
        // The one rule the ledger's mark reads (`SessionVoice`).
        let voice = row.voice(everythingQuiet: everythingQuiet)
        out.append(Entry(
            id: "quiet", group: .conch,
            title: voice.togglesToQuiet ? "Quiet \(row.label)" : "Let \(row.label) speak",
            detail: voice.togglesToQuiet
                ? "Stop reading its turns aloud; it keeps working, and its latest turn waits for you"
                : "Read its turns aloud again",
            action: .toggleQuiet
        ))
        out.append(Entry(
            id: "rename", group: .conch, title: "Rename…",
            detail: "Give \(row.label) the name you use for it; Claude Code's own label follows",
            argumentHint: "new name", action: .rename
        ))
        if let location = row.location {
            out.append(Entry(
                id: "reveal", group: .conch, title: "\(location.label) on Mac",
                detail: "\(location.help), on your Mac", action: .reveal
            ))
        }
        out.append(Entry(
            id: "dismiss", group: .session, title: "Dismiss \(row.label)",
            detail: "Hide it from the ledger and stop announcing it; the session keeps running", action: .dismiss
        ))
        out.append(Entry(
            id: "inspect", group: .session, title: "What \(row.label) carries…",
            detail: "Plugins, skills, MCP servers and their tools", action: .inspect
        ))
        if canType {
            out += AgentCommands.slash(for: row.backend).map { command in
                Entry(id: "provider:\(command.line)", group: .provider, title: command.line, detail: command.detail,
                      argumentHint: command.argumentHint, action: .type(command.line, takesArgument: command.argumentHint != nil))
            }
            let codex = AgentCommands.isCodex(row.backend)
            out += AgentCommands.skills(in: capabilities, backend: row.backend).map { command in
                Entry(id: "skill:\(command.line)", group: .skills, title: command.line,
                      detail: codex ? "Send a message mentioning the skill: \(command.detail)" : command.detail,
                      argumentHint: command.argumentHint, action: .type(command.line, takesArgument: command.argumentHint != nil || codex))
            }
        }
        return out
    }

    /// Best match first within each group, which keeps its place; catalog order breaks ties.
    private var visible: [Entry] {
        let order = Category.allCases
        return entries.enumerated()
            .compactMap { index, entry in
                CommandMatch.rank(query, title: entry.title, detail: entry.detail).map { (entry, $0, index) }
            }
            .sorted { a, b in
                let sa = order.firstIndex(of: a.0.group) ?? 0
                let sb = order.firstIndex(of: b.0.group) ?? 0
                if sa != sb { return sa < sb }
                if a.1 != b.1 { return a.1 > b.1 }
                return a.2 < b.2
            }
            .map(\.0)
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(Category.allCases, id: \.self) { group in
                    let rows = visible.filter { $0.group == group }
                    if !rows.isEmpty {
                        Section(group.rawValue) {
                            ForEach(rows) { entry in
                                Button { choose(entry) } label: { EntryRow(entry: entry) }
                                    .listRowBackground(Palette.bg)
                            }
                        }
                    }
                }
                if canType, !readSkills, query.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Reading its skills…").font(Type.caption).foregroundStyle(Palette.textFaint)
                    }
                    .listRowBackground(Palette.bg)
                }
                if visible.isEmpty {
                    Text("Nothing matches “\(query)”.").font(Type.summary).foregroundStyle(Palette.textDim)
                        .listRowBackground(Palette.bg)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Palette.bg)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Commands and skills")
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .navigationTitle("Commands")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
        }
        // The inspector's read: the skills a person may invoke are the user-invocable ones it lists.
        .task {
            guard canType else { return }
            capabilities = await bridge.capabilities(backend: row.backend ?? "claude", cwd: "", sessionId: row.id)?.inventory
            readSkills = true
        }
    }

    /// Said first, then the sheet goes: the session screen carries it out once it has.
    private func choose(_ entry: Entry) {
        onAction(entry.action)
        dismiss()
    }
}

private struct EntryRow: View {
    let entry: CommandsSheet.Entry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(entry.title)
                    .font(isTyped ? Type.mono : Type.body)
                    .foregroundStyle(Palette.textPrimary)
                    .lineLimit(1)
                if let hint = entry.argumentHint {
                    Text(hint).font(Type.caption).foregroundStyle(Palette.textFaint).lineLimit(1)
                }
            }
            Text(entry.detail)
                .font(Type.caption)
                .foregroundStyle(Palette.textDim)
                .lineLimit(2)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var isTyped: Bool {
        if case .type = entry.action { return true }
        return false
    }
}
