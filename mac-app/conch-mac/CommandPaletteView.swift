import SwiftUI

/// One thing the palette can do to the selected session (B4).
struct PaletteCommand: Identifiable, Equatable {
    enum Section: String, CaseIterable {
        case conch = "conch"
        case session = "Session"
        case provider = "Slash commands"
        case skills = "Skills"
    }

    enum Action: Equatable {
        case pause, resume, wake, recite, stop, reveal, rename, setModel
        case dismiss, inspect, helpSession
        case restore(id: String, label: String)
        /// Typed into the session as written; an argument, if given, follows it.
        case type(String)
    }

    let id: String
    let section: Section
    let title: String
    /// What choosing it will do. Every row says.
    let detail: String
    /// Placeholder for the argument the command takes; nil means it takes none.
    var argumentHint: String? = nil
    let action: Action
}

/// Fuzzy ranking. Kept in Swift on purpose: a shared TypeScript ranker cannot
/// run inside the app, so this is pinned by source guards instead.
enum PaletteMatch {
    /// nil is no match. A prefix beats a word start beats a scattered
    /// subsequence, and within a tier fewer gaps win; the caller keeps catalog
    /// order for ties. Leading `/` and `$` are ignored so "comp" finds
    /// `/compact` and "pony" finds `$ponytail`.
    static func score(_ query: String, in text: String) -> Int? {
        let q = Array(query.lowercased().filter { !$0.isWhitespace })
        if q.isEmpty { return 0 }
        let t = Array(text.lowercased().drop(while: { $0 == "/" || $0 == "$" }))
        if t.starts(with: q) { return 300 - t.count }
        var wordStart = false
        for i in t.indices {
            if wordStart, t[i...].starts(with: q) { return 200 - t.count }
            wordStart = !(t[i].isLetter || t[i].isNumber)
        }
        var qi = 0
        var first = -1
        var last = -1
        for (index, ch) in t.enumerated() where qi < q.count && ch == q[qi] {
            if first < 0 { first = index }
            last = index
            qi += 1
        }
        guard qi == q.count else { return nil }
        return 100 - (last - first + 1 - q.count)
    }

    /// The title first; the detail only by word start, because a scattered
    /// subsequence matches almost any sentence.
    static func rank(_ query: String, _ command: PaletteCommand) -> Int? {
        if let score = score(query, in: command.title) { return score }
        guard let score = score(query, in: command.detail), score >= 200 else { return nil }
        return score - 200
    }
}

/// What the palette lists for a session, in section order.
enum PaletteCatalog {
    /// conch's own folder for the help session (C7): the same path the New
    /// session sheet uses, and the label `sessionLabel` pins to it.
    static let helpSessionDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".config/conch/help", isDirectory: true).path
    static let helpSessionLabel = "conch help"

    static func commands(
        for row: SessionRow?,
        state: PublishedState?,
        capabilities: AgentCapabilities?
    ) -> [PaletteCommand] {
        var out: [PaletteCommand] = []
        // A subagent is not a session: no pane, no mic, nothing to type into (C4).
        if let row, row.parentSessionId == nil {
            out += conch(row, globallyPaused: state?.mode.paused ?? false)
            out.append(PaletteCommand(
                id: "dismiss", section: .session, title: "Dismiss \(row.label)",
                detail: "Hide it from the ledger and stop announcing it; the session keeps running and Undo is offered",
                action: .dismiss
            ))
            out.append(PaletteCommand(
                id: "inspect", section: .session, title: "What \(row.label) carries…",
                detail: "Open the inspector: plugins, skills, MCP servers and their tools",
                action: .inspect
            ))
        }
        for dismissed in state?.dismissedRows ?? [] {
            out.append(PaletteCommand(
                id: "restore:\(dismissed.id)", section: .session, title: "Restore \(dismissed.label)",
                detail: "Bring it back to the ledger and announce its turns again",
                action: .restore(id: dismissed.id, label: dismissed.label)
            ))
        }
        out.append(PaletteCommand(
            id: "help", section: .session, title: "Help with conch",
            detail: "Select the conch help session, or start it: a Claude session that knows the app",
            action: .helpSession
        ))
        // Typing needs a pane the daemon can reach, which is what `revealable` says.
        if let row, row.parentSessionId == nil, row.revealable {
            out += provider(for: row)
            out += skills(for: row, capabilities: capabilities)
        }
        return out
    }

    private static func conch(_ row: SessionRow, globallyPaused: Bool) -> [PaletteCommand] {
        let paused = globallyPaused || row.paused
        var out = [
            PaletteCommand(
                id: "pause", section: .conch,
                title: paused ? "Resume \(row.label)" : "Pause \(row.label)",
                detail: paused
                    ? "Announce this session's turns and listen for replies again"
                    : "Manual for this session: turns are not read aloud and the mic stays shut; it keeps running",
                action: paused ? .resume : .pause
            ),
            PaletteCommand(id: "wake", section: .conch, title: "Wake", detail: "Open the mic to reply to \(row.label)", action: .wake),
            PaletteCommand(id: "recite", section: .conch, title: "Recite", detail: "Read \(row.label)'s latest reply aloud again", action: .recite),
            PaletteCommand(id: "stop", section: .conch, title: "Stop", detail: "Stop reading or listening, whichever conch is doing", action: .stop),
            PaletteCommand(
                id: "rename", section: .conch, title: "Rename…",
                detail: "Give \(row.label) the name you use for it; Claude Code's own label follows",
                argumentHint: "new name", action: .rename
            ),
        ]
        if row.revealable {
            out.append(PaletteCommand(
                id: "reveal", section: .conch, title: "Reveal terminal",
                detail: "Bring \(row.label)'s terminal window to the front", action: .reveal
            ))
            out.append(PaletteCommand(
                id: "model", section: .conch, title: "Model…",
                detail: "Type /model <name> into \(row.label); the agent switches natively",
                argumentHint: "model, e.g. opus or gpt-5", action: .setModel
            ))
        }
        return out
    }

    /// As documented for each agent. The session's own version has the final
    /// say, which the palette's subtitle says out loud.
    private static let claudeCommands: [(String, String, String?)] = [
        ("/compact", "Summarise the conversation to free context; optional focus", "what to keep (optional)"),
        ("/clear", "Clear the conversation and start fresh in the same session", nil),
        ("/context", "Show what is using the context window", nil),
        ("/cost", "Show token usage and cost for this session", nil),
        ("/status", "Show version, model, account and connection", nil),
        ("/usage", "Show plan usage and rate limits", nil),
        ("/model", "Choose the model in a picker in the terminal; Model… above takes a name", nil),
        ("/permissions", "View or change tool permissions, in the terminal", nil),
        ("/mcp", "MCP server status and sign-in, in the terminal", nil),
        ("/plugin", "Manage plugins, in the terminal", nil),
        ("/agents", "Manage subagents, in the terminal", nil),
        ("/hooks", "Manage hooks, in the terminal", nil),
        ("/memory", "Edit CLAUDE.md memory files, in the terminal", nil),
        ("/init", "Write a CLAUDE.md for this project", nil),
        ("/review", "Ask for a code review of the working tree", nil),
        ("/doctor", "Check the Claude Code install", nil),
        ("/help", "List Claude Code's commands", nil),
    ]

    private static let codexCommands: [(String, String, String?)] = [
        ("/compact", "Summarise the conversation to free context", nil),
        ("/new", "Start a new conversation in this terminal", nil),
        ("/status", "Show session configuration and token usage", nil),
        ("/diff", "Show the git diff, including untracked files", nil),
        ("/review", "Review the working tree; optional instructions", "what to review (optional)"),
        ("/model", "Choose model and reasoning effort in a picker in the terminal", nil),
        ("/permissions", "Choose approval and sandbox mode, in the terminal", nil),
        ("/personality", "Choose a personality, in the terminal", nil),
        ("/fast", "Toggle fast mode", nil),
        ("/mcp", "List configured MCP servers", nil),
        ("/skills", "List available skills", nil),
        ("/plugins", "Manage plugins, in the terminal", nil),
        ("/hooks", "Manage hooks, in the terminal", nil),
        ("/init", "Write an AGENTS.md for this project", nil),
        ("/fork", "Fork the conversation into a new thread", nil),
    ]

    private static func provider(for row: SessionRow) -> [PaletteCommand] {
        let codex = row.backend?.lowercased() == "codex"
        return (codex ? codexCommands : claudeCommands).map { line, what, hint in
            PaletteCommand(
                id: "provider:\(line)", section: .provider, title: line,
                detail: what, argumentHint: hint, action: .type(line)
            )
        }
    }

    /// Skills a person may invoke, from the same read the inspector uses.
    /// Claude runs a plugin's skill as `/plugin:skill`; Codex mentions a skill
    /// as `$name` inside a message, so that one goes as an ordinary prompt.
    private static func skills(for row: SessionRow, capabilities: AgentCapabilities?) -> [PaletteCommand] {
        guard let capabilities else { return [] }
        let codex = row.backend?.lowercased() == "codex"
        return capabilities.entities.compactMap { entity in
            guard entity.kind == "skill", let skill = entity.skill,
                  skill.userInvocable, !entity.isUnavailable else { return nil }
            let owner = skill.ownerPluginId.map { $0.split(separator: "@", maxSplits: 1)[0] }
            let line = codex
                ? "$\(entity.name)"
                : "/" + (owner.map { "\($0):" } ?? "") + entity.name
            let what = entity.description ?? "Run the \(entity.name) skill"
            return PaletteCommand(
                id: "skill:\(entity.id)", section: .skills, title: line,
                detail: codex ? "Send a message mentioning the skill: \(what)" : "Type it into \(row.label): \(what)",
                argumentHint: skill.argumentHint, action: .type(line)
            )
        }
    }
}

extension Notification.Name {
    static let showCommandPalette = Notification.Name("com.conch.mac.show-command-palette")
}

/// ⌘K. conch's own controls, session actions, the agent's slash commands and
/// its skills for the selected session, in one searchable list: arrows,
/// Return, Esc. Choosing something typed goes through the composer's own
/// `inject` door; the daemon takes a slash line through `injectProviderCommand`.
struct CommandPaletteSheet: View {
    let row: SessionRow?
    let onSelect: (SessionRow) -> Void
    let onDone: () -> Void

    @EnvironmentObject private var store: StateStore
    @State private var query = ""
    @State private var selectedID: String?
    /// A command waiting for its argument; the field becomes that argument.
    @State private var pending: PaletteCommand?
    @State private var argument = ""
    @State private var capabilities: AgentCapabilities?
    @FocusState private var focus: Field?

    private enum Field { case search, argument }

    private struct Group: Identifiable {
        let section: PaletteCommand.Section
        let rows: [PaletteCommand]
        var id: String { section.rawValue }
    }

    private var commands: [PaletteCommand] {
        PaletteCatalog.commands(for: row, state: store.state, capabilities: capabilities)
    }

    /// Sections stay in catalog order; within one, the best match first and
    /// catalog order for ties.
    private var visible: [PaletteCommand] {
        if let pending { return [pending] }
        let order = PaletteCommand.Section.allCases
        return commands.enumerated()
            .compactMap { index, command in
                PaletteMatch.rank(query, command).map { (index: index, command: command, score: $0) }
            }
            .sorted { a, b in
                let sa = order.firstIndex(of: a.command.section) ?? 0
                let sb = order.firstIndex(of: b.command.section) ?? 0
                if sa != sb { return sa < sb }
                if a.score != b.score { return a.score > b.score }
                return a.index < b.index
            }
            .map(\.command)
    }

    private var groups: [Group] {
        PaletteCommand.Section.allCases.compactMap { section in
            let rows = visible.filter { $0.section == section }
            return rows.isEmpty ? nil : Group(section: section, rows: rows)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            field
            list
            HStack {
                Text(pending == nil ? "↑↓ select · ⏎ run · esc close" : "⏎ run · esc back")
                    .font(ConchTypography.font(size: 10.5))
                    .foregroundStyle(ConchPalette.textFaint)
                Spacer()
                Button("Cancel", action: back)
                    .keyboardShortcut(.cancelAction)
            }
        }
        .padding(14)
        .frame(width: 560, height: 460)
        .background(ConchPalette.bg)
        .onExitCommand(perform: back)
        .onAppear {
            focus = .search
            selectedID = visible.first?.id
        }
        .onChange(of: query) { _, _ in selectedID = visible.first?.id }
        .task(id: row?.id) {
            guard let row, row.parentSessionId == nil, row.revealable else { return }
            // Read on open, like the inspector: 35-48ms against real config.
            capabilities = await store.capabilities(
                backend: row.backend ?? "claude",
                cwd: "",
                sessionId: row.id
            )
            if selectedID == nil { selectedID = visible.first?.id }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.map { "Commands for \($0.label)" } ?? "Commands")
                .font(ConchTypography.font(size: 14, weight: .medium))
                .foregroundStyle(ConchPalette.textPrimary)
            Text(subtitle)
                .font(ConchTypography.font(size: 11.5))
                .foregroundStyle(ConchPalette.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var subtitle: String {
        guard let row else { return "Select a session for its commands; session actions are below" }
        if row.parentSessionId != nil {
            return "A subagent has no pane of its own; select the session it runs inside"
        }
        if !row.revealable {
            return "Typed commands need a terminal conch can reach; this session is only observed"
        }
        let agent = row.backend?.lowercased() == "codex" ? "Codex" : "Claude Code"
        return "Slash commands and skills are typed into the session as documented for \(agent); its version has the final say"
    }

    @ViewBuilder
    private var field: some View {
        HStack(spacing: 7) {
            if let pending {
                Text(pending.title)
                    .font(ConchTypography.font(size: 12.5, weight: .medium))
                    .foregroundStyle(ConchPalette.textPrimary)
                TextField(pending.argumentHint ?? "argument", text: $argument)
                    .textFieldStyle(.plain)
                    .font(ConchTypography.font(size: 12.5))
                    .focused($focus, equals: .argument)
                    .onKeyPress(.return) {
                        run(pending, argument: argument)
                        return .handled
                    }
                    .accessibilityLabel("Argument for \(pending.title)")
            } else {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ConchPalette.textFaint)
                TextField("Search commands", text: $query)
                    .textFieldStyle(.plain)
                    .font(ConchTypography.font(size: 12.5))
                    .foregroundStyle(ConchPalette.textPrimary)
                    .focused($focus, equals: .search)
                    // The field holds focus while you type, so the arrows are
                    // caught here rather than on the list.
                    .onKeyPress(keys: [.upArrow, .downArrow]) { press in
                        move(press.key == .downArrow ? 1 : -1)
                        return .handled
                    }
                    .onKeyPress(.return) {
                        choose()
                        return .handled
                    }
                    .accessibilityLabel("Search commands")
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .background(ConchPalette.raised.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .strokeBorder(ConchPalette.textDim.opacity(0.14), lineWidth: 1)
        )
    }

    @ViewBuilder
    private var list: some View {
        if visible.isEmpty {
            VStack {
                Spacer()
                Text("Nothing matches “\(query)”")
                    .font(ConchTypography.font(size: 12))
                    .foregroundStyle(ConchPalette.textFaint)
                Spacer()
            }
            .frame(maxWidth: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(groups) { group in
                            Text(group.section.rawValue)
                                .font(ConchTypography.font(size: 10.5, weight: .semibold))
                                .foregroundStyle(ConchPalette.textFaint)
                                .padding(.horizontal, 10)
                                .padding(.top, 8)
                                .padding(.bottom, 3)
                            ForEach(group.rows) { command in
                                PaletteRow(command: command, isSelected: selectedID == command.id)
                                    .id(command.id)
                                    .contentShape(Rectangle())
                                    .onTapGesture {
                                        selectedID = command.id
                                        choose()
                                    }
                            }
                        }
                    }
                }
                .onChange(of: selectedID) { _, id in
                    if let id { proxy.scrollTo(id) }
                }
            }
            .background(ConchPalette.bg)
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .strokeBorder(ConchPalette.textDim.opacity(0.14), lineWidth: 1)
            )
        }
    }

    private func move(_ delta: Int) {
        let rows = visible
        guard !rows.isEmpty else { return }
        guard let selectedID, let index = rows.firstIndex(where: { $0.id == selectedID }) else {
            self.selectedID = rows.first?.id
            return
        }
        let next = index + delta
        guard rows.indices.contains(next) else { return }
        self.selectedID = rows[next].id
    }

    /// Esc: out of the argument first, then out of the palette.
    private func back() {
        if pending != nil {
            pending = nil
            argument = ""
            focus = .search
            return
        }
        onDone()
    }

    private func choose() {
        guard let command = visible.first(where: { $0.id == selectedID }) ?? visible.first else { return }
        if command.argumentHint != nil, pending == nil {
            pending = command
            argument = ""
            focus = .argument
            return
        }
        run(command, argument: nil)
    }

    private func run(_ command: PaletteCommand, argument: String?) {
        let value = argument?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // These have no meaning without a value; stay until there is one.
        if value.isEmpty, command.action == .rename || command.action == .setModel { return }
        perform(command.action, argument: value)
        onDone()
    }

    private func perform(_ action: PaletteCommand.Action, argument: String) {
        switch action {
        case .helpSession:
            if let help = store.state?.rows.first(where: { $0.label == PaletteCatalog.helpSessionLabel }) {
                onSelect(help)
            } else {
                Task {
                    _ = await store.startSession(
                        backend: .claude,
                        resumeSessionId: nil,
                        cwd: PaletteCatalog.helpSessionDir
                    )
                }
            }
            return
        case let .restore(id, label):
            store.restoreSession(id: id, label: label)
            return
        default:
            break
        }
        guard let row else { return }
        switch action {
        case .pause: store.send(.scoped(.pause, sessionId: row.id, label: row.label))
        case .resume: store.send(.scoped(.resume, sessionId: row.id, label: row.label))
        case .wake: store.send(.wake(sessionId: row.id, label: row.label))
        case .recite: store.send(.recite(sessionId: row.id, label: row.label))
        case .stop: store.send(.stop())
        case .reveal: store.reveal(row)
        case .rename: store.renameSession(id: row.id, label: argument)
        // The daemon's answer lands in errors.jsonl when it could not type;
        // the inspector's Model field is where the words come back verbatim.
        case .setModel: Task { _ = await store.setModel(id: row.id, model: argument) }
        case .dismiss: store.dismissSession(row)
        // The same request a debug capture uses to open this row's inspector.
        case .inspect: store.debugInspectRequest = row.id
        case let .type(line):
            // The composer's own door: the daemon routes a slash line through
            // injectProviderCommand, and a `$skill` mention as a message.
            store.send(.inject(
                sessionId: row.id,
                label: row.label,
                text: argument.isEmpty ? line : "\(line) \(argument)"
            ))
        case .helpSession, .restore: break
        }
    }
}

private struct PaletteRow: View {
    let command: PaletteCommand
    let isSelected: Bool
    @State private var isHovering = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Text(command.title)
                .font(ConchTypography.font(size: 12.5))
                .foregroundStyle(ConchPalette.textPrimary)
                .lineLimit(1)
            Text(command.detail)
                .font(ConchTypography.font(size: 11))
                .foregroundStyle(ConchPalette.textFaint)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 8)
            if let hint = command.argumentHint {
                Text(hint)
                    .font(ConchTypography.font(size: 10.5))
                    .foregroundStyle(ConchPalette.textFaint)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        // The same ladder the session list uses: selection outranks hover.
        .background(isSelected ? ConchPalette.raised : (isHovering ? ConchPalette.hover : .clear))
        .onHover { isHovering = $0 }
    }
}
