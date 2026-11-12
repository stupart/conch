import AppKit
import ConchDesign
import SwiftUI

/// Settings › Workflows (2026-11-11). Tyler: "Workflows - making the rest of the app like skills, workflows, etc much more
/// pleasurable to use." conch drew a workflow's run in the conversation (the Workflow tool, src/conversation.ts) and had
/// no notion of the workflows themselves.
///
/// A workflow is Claude Code's saved multi-agent script (src/workflows.ts says what one is and where they live): this page
/// lists the person's, their projects' and their plugins', says what each does, when to use it and its phases, and starts
/// one the way Claude Code does, by typing `/name` into an open session (Run in, Type into) or as a new session's first
/// message (New session…). Runs in open sessions lead the list, each phase with its agents, read again every few seconds
/// while one is running; a run's own detail stays in its session's conversation, a press away.
///
/// Laid out as Settings › Skills is (SkillsLibraryView.swift): the list, and the reader beside it, which shows a workflow
/// as its panel over its script, and a run as its phases.

@MainActor
final class WorkflowsLibraryStore: ObservableObject {
    @Published private(set) var phase: SkillsLibraryStore.Phase = .loading
    @Published private(set) var accounts: [WorkflowAccountInfo] = []
    @Published private(set) var workflows: [WorkflowInfo] = []
    @Published private(set) var runs: [WorkflowRunInfo] = []
    @Published private(set) var problems: [String] = []

    var anyRunning: Bool { runs.contains(where: \.isRunning) }

    /// Every page, in turn; the runs come with the first.
    func load(refresh: Bool = false) async {
        var offset = 0
        var collected: [WorkflowInfo] = []
        while true {
            switch await ConchSocketClient().request(SkillsLibraryRequest.workflows(offset: offset, refresh: refresh && offset == 0), timeout: 20) {
            case .connectFailed:
                phase = workflows.isEmpty ? .unreachable : .failed("conch's daemon isn't running. Turn it on in General.")
                return
            case .timeout:
                phase = .failed("The daemon took too long to answer. Try again.")
                return
            case let .reply(data):
                guard let page = try? JSONDecoder().decode(WorkflowsPage.self, from: data), page.action == "workflows" else {
                    let error = (try? JSONDecoder().decode(SkillsLibraryRefusal.self, from: data))?.error
                    // A daemon from before workflows refuses the action it doesn't know.
                    phase = error.map { $0.contains("Unknown skills library action") || $0.contains("unknown runtime control") ? .needsUpdate : .failed($0) }
                        ?? .failed("The daemon answered in a way this app doesn't know.")
                    return
                }
                collected += page.workflows
                if offset == 0 {
                    accounts = page.accounts
                    runs = page.runs
                    problems = page.problems
                }
                guard let next = page.next, next > offset else {
                    workflows = collected
                    phase = .loaded
                    return
                }
                offset = next
            }
        }
    }
}

/// What the list has picked: a run, or a workflow.
private enum WorkflowPick: Hashable {
    case run(WorkflowRunInfo.ID)
    case workflow(WorkflowInfo.ID)
}

struct ConchWorkflowsSettingsView: View {
    @StateObject private var store = WorkflowsLibraryStore()
    @EnvironmentObject private var stateStore: StateStore
    @AppStorage(PaneSplit.library.key) private var listWidth = Double(PaneSplit.library.standard)
    @State private var query = ""
    @State private var picked: WorkflowPick?
    @State private var readerWide = false
    @State private var compact = false
    @State private var linkFailure: String?
    @State private var starting: WorkflowInfo?

    var body: some View {
        GeometryReader { proxy in
            Group {
                if readerWide {
                    reader
                } else if compact {
                    listColumn
                } else {
                    ConchSplitView(split: .library, width: $listWidth, label: "Resize the workflows list") {
                        listColumn
                    } trailing: {
                        reader
                    }
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .clipped()
            .environment(\.libraryCompact, compact)
            .onChange(of: proxy.size.width, initial: true) { _, width in compact = LibraryLayout.isCompact(width: width) }
        }
        .background(ConchPalette.bg)
        .overlay(alignment: .bottom) { LinkFailureLine(message: $linkFailure) }
        .task {
            await store.load()
            // A run's phases move while it runs: read again every four seconds while one is, every thirty otherwise.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(store.anyRunning ? 4 : 30))
                guard !Task.isCancelled else { return }
                await store.load()
            }
        }
        .sheet(item: $starting) { workflow in
            WorkflowStartSheet(workflow: workflow, accounts: store.accounts) { starting = nil }
        }
    }

    private var sessions: [LibrarySession] { LibrarySessions.all(stateStore) }

    private var visible: [WorkflowInfo] { WorkflowsLibrary.filter(store.workflows, query: query) }

    /// What the reader shows while nothing is picked: the first run, else the first workflow, as the list lays them out.
    private var current: WorkflowPick? {
        if let picked { return picked }
        if compact { return nil }
        if let run = store.runs.first { return .run(run.id) }
        return WorkflowsLibrary.groups(visible).first?.workflows.first.map { .workflow($0.id) }
    }

    private var listColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: SettingsLayout.headerGap) {
                SettingsSectionHeader(title: "Workflows", subtitle: "Claude Code's saved multi-agent scripts. Each is typed as /name in a session.") {
                    Button {
                        Task { await store.load(refresh: true) }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .help("Read every account's and project's workflows again")
                }
                LibrarySearchField(text: $query, prompt: "Filter workflows")
            }
            .padding([.top, .horizontal], SettingsLayout.inset)
            .padding(.bottom, ConchSpace.x3)

            Rectangle().fill(ConchPalette.divider).frame(height: 1)

            ScrollView {
                VStack(alignment: .leading, spacing: SettingsLayout.headerGap) {
                    list
                }
                .font(ConchTypography.font(size: 12))
                .padding(SettingsLayout.inset)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(ConchPalette.bg)
    }

    @ViewBuilder
    private var list: some View {
        switch store.phase {
        case .loading:
            LibraryStatus(spinning: true, text: "Reading every account's and project's workflows…")
        case .needsUpdate:
            LibraryStatus(text: "Needs an updated conch daemon", isProblem: true)
        case .unreachable:
            LibraryStatus(text: "conch's daemon isn't running, so your workflows can't be read. Turn it on in General.")
        case let .failed(message) where store.workflows.isEmpty && store.runs.isEmpty:
            LibraryStatus(text: message, isProblem: true)
        default:
            if let off = WorkflowsLibrary.featureOffLine(store.accounts) {
                LibraryStatus(text: off)
            }
            ForEach(store.problems, id: \.self) { LibraryStatus(text: $0, isProblem: true) }
            if !store.runs.isEmpty, query.isEmpty {
                group(title: "Runs · \(store.runs.count)", symbol: "play.circle") {
                    ForEach(Array(store.runs.enumerated()), id: \.element.id) { offset, run in
                        if offset > 0 { SettingsHairline() }
                        TimelineView(.periodic(from: .now, by: 30)) { context in
                            WorkflowRunRow(run: run, now: context.date, isSelected: current == .run(run.id)) { pick(.run(run.id)) }
                        }
                        .contextMenu {
                            Button("Open \(run.sessionLabel)") { openSession(run.sessionId) }
                        }
                    }
                }
            }
            let groups = WorkflowsLibrary.groups(visible)
            if groups.isEmpty {
                if query.isEmpty { empty } else { LibraryStatus(text: "Nothing matches “\(query)”.") }
            }
            ForEach(groups) { group in
                self.group(title: "\(group.title) · \(group.workflows.count)", symbol: group.symbol) {
                    ForEach(Array(group.workflows.enumerated()), id: \.element.id) { offset, workflow in
                        if offset > 0 { SettingsHairline() }
                        WorkflowRow(workflow: workflow, isSelected: current == .workflow(workflow.id)) { pick(.workflow(workflow.id)) }
                            .contextMenu { menu(workflow) }
                    }
                }
            }
        }
    }

    /// No saved workflows anywhere: what one is, and where saving one puts it.
    private var empty: some View {
        VStack(alignment: .leading, spacing: ConchSpace.x2) {
            Text("No saved workflows yet.")
                .font(ConchTypography.font(size: 12.5, weight: .medium))
                .foregroundStyle(ConchPalette.textPrimary)
            Text("A workflow is a script that runs many agents in phases. A session writes one when you ask for work across many files or angles; ask it to save the workflow, and it lands in ~/.claude/workflows (yours) or a project's .claude/workflows, where it shows here and runs as /name.")
                .foregroundStyle(ConchPalette.textDim)
                .fixedSize(horizontal: false, vertical: true)
            if let folder = store.accounts.first.map({ ($0.configDir as NSString).appendingPathComponent("workflows") }),
               FileManager.default.fileExists(atPath: folder) {
                Button("Show \((folder as NSString).abbreviatingWithTildeInPath) in Finder") { libraryOpen(stateStore, folder, reveal: true) { linkFailure = $0 } }
                    .controlSize(.small)
            }
        }
    }

    private func group<Content: View>(title: String, symbol: String, @ViewBuilder content: () -> Content) -> some View {
        // Skills' groups: 12 under the subheading, a 13-point mark.
        VStack(alignment: .leading, spacing: ConchSpace.x3) {
            SettingsSubheading(title: title) {
                Image(systemName: symbol).font(.system(size: 13, weight: .regular))
            }
            OnboardingCard { content() }
                .clipShape(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous))
        }
    }

    @ViewBuilder
    private func menu(_ workflow: WorkflowInfo) -> some View {
        let uses = LibraryUses.workflow(workflow, among: sessions).filter(\.session.canType)
        if !uses.isEmpty {
            Menu("Run In") {
                ForEach(uses) { use in Button("Run \(use.line) in \(use.session.label)") { LibrarySessions.run(use, store: stateStore) } }
            }
            Menu("Type Into") {
                ForEach(uses) { use in Button("Type \(use.line) into \(use.session.label)") { LibrarySessions.type(use) } }
            }
        }
        if workflow.problem == nil {
            Button("Run in a New Session…") { starting = workflow }
        }
        if let location = workflow.locations.first {
            Divider()
            Button("Reveal in Finder") { libraryOpen(stateStore, location.path, reveal: true) { linkFailure = $0 } }
        }
    }

    private func pick(_ pick: WorkflowPick) {
        picked = pick
        if compact { readerWide = true }
    }

    private func openSession(_ id: String) {
        SettingsRouter.shared.close()
        NotificationCenter.default.post(name: .selectSessionFromStatusItem, object: id)
    }

    // MARK: The reader

    @ViewBuilder
    private var reader: some View {
        Group {
            switch current {
            case let .run(id)?:
                if let run = store.runs.first(where: { $0.id == id }) {
                    VStack(spacing: 0) {
                        ReaderBar(title: run.name, subtitle: run.isRunning ? "Running in \(run.sessionLabel)" : "Ran in \(run.sessionLabel)", isWide: $readerWide) {
                            EmptyView()
                        }
                        ScrollView {
                            TimelineView(.periodic(from: .now, by: 30)) { context in
                                WorkflowRunPanel(run: run, now: context.date) { openSession(run.sessionId) }
                            }
                        }
                    }
                } else {
                    ReaderPlaceholder(text: "That run is no longer listed. Runs show while they go, and for twelve hours after.")
                }
            case let .workflow(id)?:
                if let workflow = store.workflows.first(where: { $0.id == id }) {
                    WorkflowReader(workflow: workflow, isWide: $readerWide,
                                   uses: LibraryUses.workflow(workflow, among: sessions),
                                   featureOff: featureOff(for: workflow),
                                   actions: WorkflowDetailActions(
                                       run: { LibrarySessions.run($0, store: stateStore) },
                                       type: { LibrarySessions.type($0) },
                                       newSession: { starting = workflow },
                                       openSession: { LibrarySessions.show($0) },
                                       reveal: { location in libraryOpen(stateStore, location.path, reveal: true) { linkFailure = $0 } },
                                       openPlugins: { SettingsRouter.shared.select(.tools) },
                                       revealSettings: { revealSettings(for: workflow) }))
                        .id(workflow.id)
                } else {
                    ReaderPlaceholder(text: "Pick a workflow to read what it does and its script.")
                }
            case nil:
                ReaderPlaceholder(text: "Pick a workflow to read what it does and its script, or a run to see how far it is.")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ConchPalette.surface)
        .clipped()
    }

    /// The settings file of the first account that has it with the feature off, where `enableWorkflows` turns it on.
    private func revealSettings(for workflow: WorkflowInfo) {
        guard let account = store.accounts.first(where: { account in
            account.feature == "off" && workflow.locations.contains { $0.accountId == account.id }
        }) else { return }
        libraryOpen(stateStore, (account.configDir as NSString).appendingPathComponent("settings.json"), reveal: true) { linkFailure = $0 }
    }

    /// Said on a workflow an account has while the feature is off for that account.
    private func featureOff(for workflow: WorkflowInfo) -> String? {
        let off = store.accounts.filter { account in account.feature == "off" && workflow.locations.contains { $0.accountId == account.id } }
        return off.isEmpty ? nil : WorkflowsLibrary.featureOffLine(off)
    }
}

/// A saved workflow: its panel over its script, as a folder deliverable shows a file.
private struct WorkflowReader: View {
    let workflow: WorkflowInfo
    @Binding var isWide: Bool
    let uses: [LibraryUse]
    let featureOff: String?
    let actions: WorkflowDetailActions

    private static let panelCap: CGFloat = 340

    var body: some View {
        let location = workflow.locations.first
        VStack(spacing: 0) {
            ReaderBar(title: workflow.name, subtitle: location.map(subtitle) ?? "", isWide: $isWide) {
                if let location {
                    ReaderIconButton(symbol: "folder", help: "Reveal its script in Finder") { actions.reveal(location) }
                }
            }
            ScrollView(.vertical) {
                WorkflowDetailPanel(workflow: workflow, uses: uses, featureOff: featureOff, actions: actions)
            }
            .frame(maxHeight: Self.panelCap)
            .fixedSize(horizontal: false, vertical: true)
            Rectangle().fill(ConchPalette.divider).frame(height: 1)
            if let location {
                WorkspaceFilesView(root: location.folder, rowID: "", changed: ConchFileChanges(changed: [], relativeTo: ""),
                                   focus: [location.file], marksFocus: false)
                    .id(location.id)
            }
        }
    }

    private func subtitle(_ location: WorkflowLocationInfo) -> String {
        [WorkflowsLibrary.locationTitle(location), workflow.problem == nil ? location.invocation : nil, (location.path as NSString).abbreviatingWithTildeInPath]
            .compactMap { $0 }.joined(separator: " · ")
    }
}

// MARK: - New session

/// A new Claude session that runs a workflow as its first message, `/name`, as typing it would: the account (one that
/// has it), the folder (its project's, for a project's workflow, else one you pick), Terminal or the background, and
/// Start. The start is the New session sheet's own `session-start`, and a folder Claude Code hasn't been trusted in asks
/// first, as Try's does.
struct WorkflowStartSheet: View {
    let workflow: WorkflowInfo
    let accounts: [WorkflowAccountInfo]
    let onDone: () -> Void
    @EnvironmentObject private var stateStore: StateStore
    @AppStorage("conch.session.host") private var host = "terminal"
    @State private var accountId: String
    @State private var folder: String?
    @State private var message: String?
    @State private var busy = false
    @State private var pendingTrust: String?

    init(workflow: WorkflowInfo, accounts: [WorkflowAccountInfo], onDone: @escaping () -> Void) {
        self.workflow = workflow
        self.accounts = accounts
        self.onDone = onDone
        let owners = workflow.locations.compactMap(\.accountId)
        _accountId = State(initialValue: owners.first ?? accounts.first?.id ?? "default")
        _folder = State(initialValue: workflow.locations.compactMap(\.projectPath).first)
    }

    /// The accounts it can run as: those with a copy, or every one for a project's.
    private var choices: [WorkflowAccountInfo] {
        let owners = Set(workflow.locations.compactMap(\.accountId))
        return owners.isEmpty ? accounts : accounts.filter { owners.contains($0.id) }
    }

    private var line: String { workflow.locations.first?.invocation ?? "/\(workflow.name)" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Run \(workflow.name) in a new session")
                .font(ConchTypography.font(size: 15, weight: .semibold))
                .foregroundStyle(ConchPalette.textPrimary)
            Text("conch starts Claude Code in the folder below and sends \(line) as its first message, which runs the workflow there. Its agents work in that folder.")
                .font(ConchTypography.font(size: 11.5))
                .foregroundStyle(ConchPalette.textDim)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x2) {
                Text("As").font(ConchTypography.font(size: 12)).foregroundStyle(ConchPalette.textDim).frame(width: 44, alignment: .leading)
                Picker("As", selection: $accountId) {
                    ForEach(choices) { Text("Claude · \($0.label)").tag($0.id) }
                }
                .labelsHidden()
                .fixedSize()
                Spacer(minLength: ConchSpace.x2)
                Picker("", selection: $host) {
                    Text("Terminal").tag("terminal")
                    Text("Background").tag("background")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 180)
                .disabled(stateStore.state?.features?.sessionHosts != 1)
            }
            HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x2) {
                Text("In").font(ConchTypography.font(size: 12)).foregroundStyle(ConchPalette.textDim).frame(width: 44, alignment: .leading)
                Text(folder.map { ($0 as NSString).abbreviatingWithTildeInPath } ?? "Choose a folder")
                    .font(ConchTypography.font(size: 12))
                    .foregroundStyle(folder == nil ? ConchPalette.textFaint : ConchPalette.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: ConchSpace.x2)
                Button("Choose…") { choose() }
                    .controlSize(.small)
                    .help("Pick the folder the session works in")
            }
            .disabled(busy || pendingTrust != nil)
            if let pendingTrust {
                Text("Claude Code asks whether you trust \((pendingTrust as NSString).abbreviatingWithTildeInPath) before it starts there.")
                    .font(ConchTypography.font(size: 11.5))
                    .foregroundStyle(ConchPalette.statusWaiting)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let message {
                Text(message)
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.statusNeeds)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel, action: onDone)
                    .keyboardShortcut(.cancelAction)
                Button(pendingTrust == nil ? "Start session" : "Trust and start") { start() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || folder == nil)
            }
        }
        .padding(16)
        .frame(width: 560)
        .background(ConchPalette.bg)
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Run Here"
        panel.message = "The folder \(workflow.name)'s session works in"
        if let folder { panel.directoryURL = URL(fileURLWithPath: folder) }
        if panel.runModal() == .OK, let url = panel.url { folder = url.path }
    }

    private func start() {
        guard let folder else { return }
        busy = true
        message = nil
        Task { @MainActor in
            defer { busy = false }
            let before = Set((stateStore.state?.rows ?? []).map(\.id))
            let outcome = await stateStore.startSession(
                backend: .claude,
                host: stateStore.state?.features?.sessionHosts == 1 ? host : "terminal",
                resumeSessionId: nil,
                claudeAccountId: accountId,
                cwd: folder,
                trustFolder: pendingTrust != nil,
                prompt: line
            )
            switch outcome {
            case let .failed(error):
                message = error
            case let .needsTrust(cwd):
                pendingTrust = cwd
            case let .started(sessionId, _):
                onDone()
                SettingsRouter.shared.close()
                for _ in 0..<60 {
                    let rows = stateStore.state?.rows ?? []
                    if let row = rows.first(where: { sessionId != nil ? $0.id == sessionId : !before.contains($0.id) }) {
                        NotificationCenter.default.post(name: .selectSessionFromStatusItem, object: row.id)
                        return
                    }
                    try? await Task.sleep(for: .milliseconds(500))
                }
            }
        }
    }
}
