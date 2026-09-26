import AppKit
import ConchDesign
import SwiftUI

/// Where the Mac keeps what the workspace remembers between launches (`WorkspaceMemory`).
private let conchMacWorkspaceKey = "conch.mac.workspace"

struct ContentView: View {
    @EnvironmentObject private var store: StateStore

    /// Which session is being looked at, which one the voice is on, where a message goes, and
    /// how each session is presented: one owner, read by the pane and the transcript below it
    /// (ConchDesign/Workspace.swift). The window used to hold a selection of its own while the
    /// pane applied fallbacks of its own, and the two drifted.
    @StateObject private var workspace = WorkspaceModel(
        remembering: WorkspaceMemory.decode(UserDefaults.standard.data(forKey: conchMacWorkspaceKey)),
        remember: { UserDefaults.standard.set($0.encoded(), forKey: conchMacWorkspaceKey) }
    )
    @State private var remoteSelection: RemoteSessionID?
    @State private var renamingSessionID: SessionRow.ID?
    @State private var renameDraft = ""
    @State private var isShowingKeyboardShortcuts = false
    @State private var isShowingSessionStart = false
    @State private var isShowingCommandPalette = false
    /// SwiftUI's own way to open the Settings scene. Doing it by sending
    /// showSettingsWindow: to nil is the usual hack and breaks between
    /// releases; this is the supported route on macOS 14+.
    @Environment(\.openSettings) private var openSettings

    /// Wrapped rather than passed through: openSettings is an
    /// OpenSettingsAction, and handing it to a twenty-argument initialiser as
    /// a closure made Swift give up type-checking the whole expression.
    private func connectPhone() {
        openSettings()
    }

    private var reviewItems: [ReviewItem] {
        let indexedItems = store.state?.rows.enumerated().compactMap { index, row in
            ReviewItem(row: row).map { (index: index, item: $0) }
        } ?? []

        return indexedItems.sorted { left, right in
            switch (left.item.reviewedAt, right.item.reviewedAt) {
            case let (leftDate?, rightDate?) where leftDate != rightDate:
                return leftDate < rightDate
            case (nil, _?):
                return true
            case (_?, nil):
                return false
            default:
                return left.index < right.index
            }
        }
        .map(\.item)
    }

    /// Only a deliverable waiting to be looked at announces itself. One filed
    /// mid-turn is announced when the turn ends, once: postOnce keeps a seen set.
    private var readyReviewIDs: Set<ReviewItem.ID> {
        Set(reviewItems.filter(\.isReady).map(\.id))
    }

    private var rowIDs: [SessionRow.ID] {
        store.state?.rows.map(\.id) ?? []
    }

    private var selectedRow: SessionRow? {
        store.state?.row(workspace.viewing)
    }

    /// What a command addresses when nothing was picked — Recite, ⌘K, the arrow keys' anchor.
    /// The same rule the pane types into, so the window and the pane can't name two different
    /// sessions; by identity, never by the live label, which is renameable and duplicable.
    private var actionTarget: SessionRow? {
        workspace.targetRow(in: store.state)
    }

    var body: some View {
        ZStack {
            DashboardView(
                onSelectRemote: { remoteSelection = $0 },
                state: store.state,
                selectedSessionID: workspace.viewing,
                renamingSessionID: renamingSessionID,
                renameDraft: $renameDraft,
                actions: DashboardActions(
                    onStartSession: { isShowingSessionStart = true },
                    onSelectSession: selectSession,
                    onBeginRename: beginRename,
                    onCommitRename: commitRename,
                    onCancelRename: cancelRename,
                    onDismiss: dismissSession,
                    onRestore: restoreSession,
                    onUndoDismiss: store.undoLastDismissal,
                    onDismissNewerDaemonWarning: store.dismissNewerDaemonWarning,
                    onToggleLogs: store.toggleLogDrawer,
                    onConnectPhone: connectPhone,
                    onShowKeyboardShortcuts: showKeyboardShortcuts,
                    onShowCommandPalette: showCommandPalette,
                    onTalkOrStop: talkOrStop,
                    onPauseOrResume: pauseOrResume,
                    onRecite: recite,
                    onMoveUp: { moveSelection(by: -1) },
                    onMoveDown: { moveSelection(by: 1) },
                    onReleaseSelection: releaseSelection
                )
            )
        }
        .background(ConchPalette.bg)
        .environmentObject(workspace)
        .background(
            DashboardInputMonitor(
                isEnabled: remoteSelection == nil && !isShowingKeyboardShortcuts && !isShowingCommandPalette,
                onKey: handleDashboardKey
            )
        )
        .sheet(item: $remoteSelection) { target in
            RemoteSessionView(target: target)
        }
        .sheet(isPresented: $isShowingKeyboardShortcuts) {
            KeyboardShortcutsSheet()
        }
        .sheet(isPresented: $isShowingSessionStart) {
            StartSessionSheet(onStarted: showStarted)
        }
        // ⌘K (B4): scoped to the selected session, or the one conch is
        // speaking for — the same fallback Recite uses.
        .sheet(isPresented: $isShowingCommandPalette) {
            CommandPaletteSheet(row: actionTarget, onSelect: selectSession) {
                isShowingCommandPalette = false
            }
        }
        .onReceive(
            NotificationCenter.default.publisher(for: .showCommandPalette)
        ) { _ in
            showCommandPalette()
        }
        .onReceive(
            NotificationCenter.default.publisher(for: .showKeyboardShortcuts)
        ) { _ in
            showKeyboardShortcuts()
        }
        .onReceive(
            NotificationCenter.default.publisher(for: .selectSessionFromStatusItem)
        ) { note in
            // A session chosen in the menu bar menu: the same as clicking its row.
            guard let id = note.object as? String,
                  let row = store.state?.rows.first(where: { $0.id == id }) else { return }
            selectSession(row)
        }
        // A session picked here takes the overlay's conversation off the Ready pill's scene, unless it is that one.
        .onChange(of: workspace.viewing) { _, id in
            guard let id else { return }
            FloatingPanels.picked(id)
            // conch's own window now shows this session: the screen context's conch-staged observer.
            store.reportShowing(.conch(sessionId: id, view: "main"))
        }
        // Back to conch from another app: its window shows its session again. The front-window
        // observer leaves conch's own windows to this, so what was in front before stops counting.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            guard let id = workspace.viewing else { return }
            store.reportShowing(.conch(sessionId: id, view: "main"))
        }
        .onChange(of: rowIDs) { _, currentIDs in
            // A pick for a session that has ended is no pick: the fallbacks take over rather
            // than the pane staying pinned to something that is gone.
            workspace.forget(missing: Set(currentIDs))
            if let renamingSessionID, !currentIDs.contains(renamingSessionID) {
                cancelRename()
            }
        }
        .onChange(of: readyReviewIDs) { previousIDs, currentIDs in
            let addedIDs = currentIDs.subtracting(previousIDs)
            for review in reviewItems where addedIDs.contains(review.id) {
                ReviewNotifications.shared.postOnce(for: review)
            }
        }
    }

    private func selectSession(_ row: SessionRow) {
        workspace.viewing = row.id
    }

    /// A session started from here has checked in: show it. Tyler: "When a session starts successfully it should then
    /// show the session back in the conch app." Starting one raised Terminal, so conch takes the front back, but only
    /// from Terminal, the rule `refocusAfterDelivery` keeps: anywhere else Tyler went meanwhile, he stays.
    private func showStarted(_ id: SessionRow.ID) {
        workspace.viewing = id
        guard !NSApp.isActive, NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.Terminal" else { return }
        NSApp.activate(ignoringOtherApps: true)
    }

    private func beginRename(_ row: SessionRow) {
        workspace.viewing = row.id
        renamingSessionID = row.id
        renameDraft = row.label
    }

    private func commitRename(_ row: SessionRow) {
        guard renamingSessionID == row.id else { return }
        let requestedLabel = renameDraft
        cancelRename()
        store.renameSession(id: row.id, label: requestedLabel)
    }

    private func cancelRename() {
        renamingSessionID = nil
        renameDraft = ""
    }

    private func dismissSession(_ row: SessionRow) {
        if renamingSessionID == row.id {
            cancelRename()
        }
        store.dismissSession(row)
    }

    private func restoreSession(_ row: DismissedSessionRow) {
        store.restoreSession(id: row.id, label: row.label)
    }

    /// The spacebar STOPS. It never starts.
    ///
    /// It used to do both, and opening the microphone is not something a
    /// spacebar should be able to do by accident. Space scrolls or types in
    /// every other Mac app, so a stray press with the window focused and the
    /// composer not focused opened the mic on a Mac explicitly set to manual —
    /// Tyler: "the mic just opened for some reason even tho im in manual mode".
    /// The wake was tagged `user` and the manual gate correctly let it through,
    /// because a person really had pressed a key. The gate was right; this
    /// binding was wrong.
    ///
    /// The app's own hint has always said "space to cancel", never "space to
    /// talk", and there is a visible microphone button in the composer for
    /// starting. This makes the hint true.
    private func talkOrStop() {
        guard store.state?.live.isExchangeActive == true else { return }
        store.send(.stop())
    }

    private func pauseOrResume() {
        let globallyPaused = store.state?.mode.paused ?? false
        // While conch is paused globally, a per-session resume cannot lift it:
        // the daemon holds every turn behind the global gate, so scoping the
        // command to one session did nothing visible. Worse, it read
        // `selectedRow.paused` — false, because that row was not individually
        // paused — and sent PAUSE from a button labelled Resume. Tyler: "i just
        // tried clicking the resume button and nothing happened."
        //
        // So while globally paused with NO session selected, the press stays
        // global and says "all" (modeScope) — resuming one session out of a
        // global pause is a distinct scoped action below, never what an
        // unscoped press means.
        if globallyPaused, selectedRow == nil {
            store.send(.global(.resume))
            return
        }

        if let selectedRow {
            // The daemon has supported a scoped exemption from a global pause
            // for a while (`resumedSessionIds`, checked ahead of the global
            // gate) — but until `SessionRow.pauseExempt` existed on the wire,
            // this app could not tell an exempted row apart from a plain one:
            // both read `paused == false`. So this unconditionally computed
            // `rowEffectivelyPaused = true` whenever the conch was globally
            // paused and kept sending .resume on every press — the daemon
            // dutifully re-granted an exemption the row already held, logging
            // a fresh "▶ auto for ..." each time and never once sending
            // .pause. Four presses 25 seconds apart in the daemon log, same
            // session, all "auto": a button that only ever moved one way, and
            // whose label never changed because `isManual` had the same blind
            // spot (see above).
            //
            // Same rule as `isManual`: manual toggles to auto, auto (whether
            // by exemption or an un-paused conch) toggles to manual.
            let sessionIsManual = selectedRow.paused || (globallyPaused && !selectedRow.pauseExempt)
            store.send(
                .scoped(
                    sessionIsManual ? .resume : .pause,
                    sessionId: selectedRow.id,
                    label: selectedRow.label
                )
            )
            return
        }
        store.send(.global(.pause))
    }

    private func recite() {
        guard let actionTarget else { return }
        store.send(
            .recite(
                sessionId: actionTarget.id,
                label: actionTarget.label
            )
        )
    }

    private func moveSelection(by delta: Int) {
        guard delta == -1 || delta == 1,
              let rows = store.state?.rows,
              !rows.isEmpty else {
            return
        }

        let anchorID = actionTarget?.id
        let anchorIndex = anchorID.flatMap { id in
            rows.firstIndex { $0.id == id }
        }
        let currentIndex = anchorIndex ?? (delta > 0 ? -1 : rows.count)
        let nextIndex = currentIndex + delta
        guard rows.indices.contains(nextIndex) else {
            workspace.viewing = nil
            return
        }
        workspace.viewing = rows[nextIndex].id
    }

    private func releaseSelection() {
        if renamingSessionID != nil {
            cancelRename()
            return
        }
        // Esc steps back before it lets go (§3 line 234). On the deliverable or side by side
        // there is a page behind you; releasing the session there would answer a smaller
        // question by throwing away the bigger one.
        if let id = workspace.viewing, workspace.presentation(for: id).stage != .conversation {
            workspace.show(stage: .conversation, for: id)
            return
        }
        workspace.viewing = nil
    }

    private func showKeyboardShortcuts() {
        isShowingKeyboardShortcuts = true
    }

    private func showCommandPalette() {
        isShowingCommandPalette = true
    }

    private func handleDashboardKey(_ key: DashboardKey) -> Bool {
        switch key {
        case .talkOrStop:
            talkOrStop()
        case .pauseOrResume:
            pauseOrResume()
        case .recite:
            recite()
        case .showKeyboardShortcuts:
            showKeyboardShortcuts()
        case .moveUp:
            moveSelection(by: -1)
        case .moveDown:
            moveSelection(by: 1)
        case .releaseSelection:
            releaseSelection()
        }
        return true
    }
}

/// What a reload depends on. Two values, so `task(id:)` re-runs when either
/// changes without needing a separate observer for each.
private struct TaskKey: Equatable {
    let mode: StartSessionSheet.StartMode
    let query: String
}

/// The daemon's per-agent start options — `startOptions` in `agent-adapter.ts`,
/// each from the agent's own `--help` — mirrored so the sheet can draw them.
/// A test pins every entry here to that table; the daemon validates what is
/// sent, so this list decides only what is shown.
struct StartOption: Identifiable {
    enum Kind {
        case toggle
        case choice([String])
        case text
    }

    let name: String
    let kind: Kind
    let help: String
    var resumeOnly = false
    var id: String { name }

    static let claude: [StartOption] = [
        StartOption(name: "model", kind: .text, help: "Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5')."),
        StartOption(name: "permission-mode", kind: .choice(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]), help: "Permission mode to use for the session"),
        StartOption(name: "bypass-permissions", kind: .toggle, help: "Bypass all permission checks. Recommended only for sandboxes with no internet access."),
        StartOption(name: "effort", kind: .choice(["low", "medium", "high", "xhigh", "max"]), help: "Effort level for the current session (low, medium, high, xhigh, max)"),
        StartOption(name: "fork-session", kind: .toggle, help: "When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)", resumeOnly: true),
    ]

    static let codex: [StartOption] = [
        StartOption(name: "sandbox", kind: .choice(["read-only", "workspace-write", "danger-full-access"]), help: "Select the sandbox policy to use when executing model-generated shell commands"),
        StartOption(name: "ask-for-approval", kind: .choice(["on-request", "never"]), help: "Configure when the model requires human approval before executing a command"),
        StartOption(name: "bypass-permissions", kind: .toggle, help: "Skip all confirmation prompts and execute commands without sandboxing. EXTREMELY DANGEROUS. Intended solely for running in environments that are externally sandboxed"),
        StartOption(name: "profile", kind: .text, help: "Layer $CODEX_HOME/<name>.config.toml on top of the base user config"),
    ]

    static func table(for backend: ConchAgentBackend) -> [StartOption] {
        backend == .codex ? codex : claude
    }
}

/// A segmented control for a short list of choices, a menu for a long one.
private struct ChoiceStyle: ViewModifier {
    let segmented: Bool

    func body(content: Content) -> some View {
        if segmented {
            content.pickerStyle(.segmented)
        } else {
            content.pickerStyle(.menu)
        }
    }
}

private struct StartSessionSheet: View {
    fileprivate enum StartMode: String, CaseIterable, Identifiable {
        case new = "New"
        case resume = "Resume"
        case teleport = "Teleport by ID…"
        case help = "Help with conch"
        var id: String { rawValue }
    }

    /// conch's own folder. The daemon creates it and writes its CLAUDE.md when
    /// the session starts (`session-lifecycle.ts`); the app only names it.
    private static let helpSessionDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".config/conch/help", isDirectory: true).path

    @EnvironmentObject private var store: StateStore
    @Environment(\.dismiss) private var dismiss
    /// The session this sheet started, once it has checked in.
    let onStarted: (SessionRow.ID) -> Void

    @State private var backend = ConchAgentBackend.claude
    @State private var mode = StartMode.new
    @State private var cwd = FileManager.default.homeDirectoryForCurrentUser.path
    @State private var isStarting = false
    @State private var error: String?
    @State private var teleportSessionId = ""
    @State private var openedTeleport = false
    /// The directory Codex will not run in until it is told to, if any.
    @State private var pendingTrust: String?
    /// Directories answered "yes" in this sheet. Deliberately not persisted:
    /// the person answered about one launch, and conch does not quietly decide
    /// on their behalf next time.
    @State private var trustedFolders: Set<String> = []
    /// What the person chose this time, by option name. Unset means the
    /// agent's own default, and is not sent; `bypass-permissions` is seeded
    /// from the persisted setting once the daemon says what it is.
    @State private var optionValues: [String: ConchStartOptionValue] = [:]

    // Resume
    @State private var resumable: [ResumableSession] = []
    @State private var resumeQuery = ""
    @State private var resumeSelection: ResumableSession?
    @State private var isLoadingResumable = false

    private var canStart: Bool {
        guard !isStarting, !openedTeleport else { return false }
        switch mode {
        case .new, .help: return true
        case .resume: return resumeSelection != nil
        case .teleport:
            return !teleportSessionId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && cwd.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/")
        }
    }

    /// A resumed session brings its own agent and its own folder. Asking again
    /// is a question with a known answer and a wrong setting available.
    private var effectiveBackend: ConchAgentBackend {
        if mode == .teleport { return .claude }
        if mode == .help { return .claude }
        guard mode == .resume, let picked = resumeSelection else { return backend }
        return picked.backend.lowercased() == "codex" ? .codex : .claude
    }

    private var effectiveCwd: String {
        switch mode {
        case .resume: return resumeSelection?.cwd ?? cwd
        case .help: return Self.helpSessionDir
        case .new, .teleport: return cwd
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Start a session")
                .font(ConchTypography.font(size: 19, weight: .medium))
                .foregroundStyle(ConchPalette.textPrimary)

            // Mode first: it decides which of the questions below are even
            // worth asking.
            Picker("Session", selection: $mode) {
                ForEach(StartMode.allCases) { mode in
                    Text(mode.rawValue).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(isStarting)

            if mode == .help {
                Text("Help with conch — a Claude session that knows the app.")
                    .font(ConchTypography.font(size: 11.5, weight: .semibold))
                Text("Ask it how to do something in conch, or why it has gone quiet: it reads the daemon log, settings and errors on this Mac, runs `conch doctor`, and can see and steer your other sessions. It opens in Terminal, in conch\u{2019}s own folder, and shows here as \u{201C}conch help\u{201D}.")
                    .font(ConchTypography.font(size: 11.5))
                    .foregroundStyle(ConchPalette.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            } else if mode != .resume {
                if mode == .new {
                    Picker("Agent", selection: $backend) {
                        ForEach(ConchAgentBackend.allCases) { backend in
                            Text(backend.label).tag(backend)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                } else {
                    TextField("Claude cloud session ID", text: $teleportSessionId)
                        .textFieldStyle(.roundedBorder)
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Working folder")
                        .font(ConchTypography.font(size: 10.5, weight: .medium))
                        .foregroundStyle(ConchPalette.textDim)
                        .textCase(.uppercase)
                        .tracking(0.5)
                    HStack(spacing: 8) {
                        TextField("Working folder", text: $cwd)
                            .textFieldStyle(.roundedBorder)
                        Button("Choose…", action: chooseFolder)
                    }
                }
            } else {
                ResumePickerView(
                    sessions: resumable,
                    isLoading: isLoadingResumable,
                    query: $resumeQuery,
                    selection: $resumeSelection,
                    onConfirm: start
                )
            }

            // The agent's own start-time choices, from its --help, for the
            // agent this launch will actually run. Help is a fixed recipe.
            if mode != .help {
                startOptionsView
            }

            if mode == .teleport {
                Text("Teleport — create a local copy.")
                    .font(ConchTypography.font(size: 11.5, weight: .semibold))
                Text("Opens this Claude session in Terminal on this Mac, in \(effectiveCwd.trimmingCharacters(in: .whitespacesAndNewlines)). New work stays on this Mac and does not update the original Claude app session. Requires internet access and the same Claude.ai account. Claude may switch Git branches and ask to stash local changes, including untracked files.")
                    .font(ConchTypography.font(size: 11.5))
                    .foregroundStyle(ConchPalette.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            } else if mode != .help {
                Text(footnote)
                    .font(ConchTypography.font(size: 11.5))
                    .foregroundStyle(ConchPalette.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let error {
                Text(error)
                    .font(ConchTypography.font(size: 11.5))
                    .foregroundStyle(ConchPalette.statusNeeds)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(isStarting ? "Opening…" : (mode == .teleport ? "Open in Terminal" : "Start")) {
                    start()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canStart)
            }
        }
        .padding(24)
        .frame(width: 430)
        .background(ConchPalette.bg)
        .alert("Opened in Terminal on this Mac", isPresented: $openedTeleport) {
            Button("Done") { dismiss() }
        } message: {
            Text("Continue in Terminal to open your local copy. Claude may ask you to sign in or trust the folder. This does not confirm that the session downloaded or the workspace is ready.")
        }
        .alert(
            "Do you trust this folder?",
            isPresented: Binding(
                get: { pendingTrust != nil },
                set: { if !$0 { pendingTrust = nil } }
            )
        ) {
            // The agent's own options, in its own words. Not conch inventing a phrasing for
            // someone else's security question.
            Button(effectiveBackend == .codex ? "Yes, continue" : "Yes, I trust this folder") {
                guard let cwd = pendingTrust else { return }
                pendingTrust = nil
                trustedFolders.insert(cwd)
                start()
            }
            Button(effectiveBackend == .codex ? "No, cancel" : "No, exit", role: .cancel) { pendingTrust = nil }
        } message: {
            // The agent's own words about the risk, because softening someone else's
            // security warning is not conch's call to make.
            Text(effectiveBackend == .codex
                ? "\(pendingTrust ?? "")\n\nWorking with untrusted contents comes with "
                    + "higher risk of prompt injection. Trusting the directory allows "
                    + "project-local config, hooks, and exec policies to load.\n\n"
                    + "conch will tell Codex this for this session only, and will not "
                    + "change your Codex configuration."
                : "\(pendingTrust ?? "")\n\nQuick safety check: Is this a project you created "
                    + "or one you trust? (Like your own code, a well-known open source project, "
                    + "or work from your team). If not, take a moment to review what's in this "
                    + "folder first.\n\nClaude Code'll be able to read, edit, and execute files "
                    + "here.\n\nconch will give Claude Code this answer in Terminal, where "
                    + "Claude Code remembers it for this folder."
            )
        }
        // `task(id:)` rather than `onChange`, so this fires when the sheet
        // APPEARS already in resume mode as well as when you switch into it.
        // Keyed on the query too, because searching is a re-read: the daemon
        // filters next to the history rather than shipping all of it, and a
        // full read measures 18ms against 1229 transcripts and 58 threads —
        // cheap enough that a keystroke can simply ask again.
        .task(id: TaskKey(mode: mode, query: resumeQuery)) {
            guard mode == .resume else { return }
            loadResumable()
        }
        // The toggle starts from the persisted `bypass-permissions` setting —
        // the same default the daemon applies when nothing is sent — and only
        // seeds an untouched toggle, never one the person already flipped.
        .task {
            if let value = await store.bypassPermissionsDefault(),
               optionValues["bypass-permissions"] == nil {
                optionValues["bypass-permissions"] = .bool(value)
            }
        }
    }

    /// Say where it will actually land, since that is the thing a resume can
    /// silently get wrong: the same conversation reopened in the wrong folder
    /// is a conversation about files that are not there.
    private var footnote: String {
        if mode == .new {
            return "Opens \(backend.label) in Terminal, outside conch\u{2019}s own tmux session."
        }
        guard let picked = resumeSelection else {
            return "Pick a session to restart. It reopens with its own agent, in its own folder."
        }
        let agent = picked.backend.lowercased() == "codex" ? "Codex" : "Claude"
        return "Restarts \(agent) in \(picked.shortCwd), in Terminal."
    }

    /// The table for the agent this launch will run; a resume-only entry only
    /// while resuming, so the sheet never shows a switch that does nothing.
    private var shownOptions: [StartOption] {
        StartOption.table(for: effectiveBackend).filter { !$0.resumeOnly || mode == .resume }
    }

    /// Exactly the shown options the person set. The daemon validates them.
    private var sentOptions: [String: ConchStartOptionValue] {
        guard mode != .help else { return [:] }
        var sent: [String: ConchStartOptionValue] = [:]
        for option in shownOptions {
            if let value = optionValues[option.name] { sent[option.name] = value }
        }
        return sent
    }

    private var startOptionsView: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(shownOptions) { option in
                VStack(alignment: .leading, spacing: 3) {
                    switch option.kind {
                    case .toggle:
                        // Unset until the daemon says what the persisted
                        // default is, and if it never does the daemon applies
                        // that default: say so, rather than show a switch that
                        // is off — as the phone's sheet does.
                        if option.name == "bypass-permissions", optionValues[option.name] == nil {
                            HStack {
                                Text(option.name)
                                    .font(ConchTypography.font(size: 11.5))
                                Spacer()
                                Menu("uses your Mac's default") {
                                    Button("On") { optionValues[option.name] = .bool(true) }
                                    Button("Off") { optionValues[option.name] = .bool(false) }
                                }
                                .fixedSize()
                            }
                        } else {
                            Toggle(option.name, isOn: toggleBinding(option.name))
                                .font(ConchTypography.font(size: 11.5))
                        }
                    case let .choice(choices):
                        Text(option.name)
                            .font(ConchTypography.font(size: 11.5))
                        // Segmented while the words fit the sheet; a menu for
                        // the longer lists (Claude's permission modes).
                        Picker(option.name, selection: textBinding(option.name)) {
                            Text("Default").tag("")
                            ForEach(choices, id: \.self) { choice in
                                Text(choice).tag(choice)
                            }
                        }
                        .modifier(ChoiceStyle(segmented: choices.count <= 3))
                        .labelsHidden()
                    case .text:
                        TextField(option.name, text: textBinding(option.name), prompt: Text("default"))
                            .textFieldStyle(.roundedBorder)
                    }
                    Text(option.help)
                        .font(ConchTypography.font(size: 10.5))
                        .foregroundStyle(ConchPalette.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .disabled(isStarting)
    }

    private func toggleBinding(_ name: String) -> Binding<Bool> {
        Binding(
            get: {
                if case let .bool(on)? = optionValues[name] { return on }
                return false
            },
            set: { optionValues[name] = .bool($0) }
        )
    }

    /// Empty is the agent's default, and is not sent.
    private func textBinding(_ name: String) -> Binding<String> {
        Binding(
            get: {
                if case let .string(text)? = optionValues[name] { return text }
                return ""
            },
            set: { optionValues[name] = $0.isEmpty ? nil : .string($0) }
        )
    }

    private func loadResumable() {
        isLoadingResumable = true
        Task { @MainActor in
            resumable = await store.resumableSessions(query: resumeQuery)
            isLoadingResumable = false
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: cwd, isDirectory: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        cwd = url.path
    }

    private func start() {
        guard canStart else { return }
        isStarting = true
        error = nil
        Task { @MainActor in
            let outcome = await store.startSession(
                backend: effectiveBackend,
                resumeSessionId: mode == .resume ? resumeSelection?.sessionId : nil,
                teleportSessionId: mode == .teleport ? teleportSessionId : nil,
                cwd: effectiveCwd,
                trustFolder: trustedFolders.contains(effectiveCwd),
                options: sentOptions
            )
            switch outcome {
            case let .failed(message):
                isStarting = false
                error = message
                return
            case let .needsTrust(cwd):
                // Nothing was started. Codex's own question, asked here, with
                // its own options — rather than a session left sitting on a
                // full-screen prompt in a Terminal nobody is looking at.
                isStarting = false
                pendingTrust = cwd
                return
            case .started:
                break
            }
            if mode == .teleport {
                isStarting = false
                openedTeleport = true
                return
            }
            // Started is not the same as running.
            //
            // conch launches the agent in Terminal and, until now, called that
            // done. But an agent can sit on a prompt before it does anything —
            // Claude Code asks whether it trusts a folder, and Codex has
            // several, including "Continuing startup with a fresh local
            // database... Press Enter to continue." Tyler hit exactly that
            // resuming a Codex session: conch said it started, and it was
            // waiting for a keypress nobody could see.
            //
            // So wait for it to CHECK IN. A session that appears in the ledger
            // has really started; one that does not is being held by something,
            // and saying so beats a sheet that closed on a promise.
            let appeared = await waitForSession()
            isStarting = false
            if let appeared {
                onStarted(appeared)
                dismiss()
                return
            }
            let notice = "Started, but it hasn\u{2019}t checked in. Terminal may be "
                + "waiting for you to answer something \u{2014} take a look there."
            error = notice
            // And keep watching: answered in Terminal, it checks in a minute later, and the
            // sheet sat on this notice for a session that was already running. Tyler: "conch
            // app is still in creation model even tho sessions has been made".
            if let id = await waitForSession(rounds: 225), error == notice {
                onStarted(id)
                dismiss()
            }
        }
    }

    /// Poll the ledger for the session to show up.
    ///
    /// Resume knows exactly which id to expect. A fresh session does not, so it
    /// watches for the row COUNT to grow instead — cruder, but it answers the
    /// same question: did anything actually start?
    /// `rounds` of 0.8 s: 25 is long enough for a cold agent on a busy machine and short
    /// enough that a stuck one is noticed while you still remember starting it.
    private func waitForSession(rounds: Int = 25) async -> SessionRow.ID? {
        let expected = mode == .resume ? resumeSelection?.sessionId : nil
        // Sessions only: a session's agents are rows too, and one appearing elsewhere is
        // not the session you just started.
        let sessions = { (rows: [SessionRow]) in rows.filter { $0.parentSessionId == nil } }
        let before = Set(sessions(store.state?.rows ?? []).map(\.id))
        for _ in 0..<rounds {
            try? await Task.sleep(nanoseconds: 800_000_000)
            guard let rows = store.state?.rows else { continue }
            if let expected {
                if rows.contains(where: { $0.id == expected }) { return expected }
            } else if let fresh = sessions(rows).first(where: { !before.contains($0.id) }) {
                return fresh.id
            }
        }
        return nil
    }
}

extension Notification.Name {
    static let showKeyboardShortcuts = Notification.Name(
        "com.conch.mac.show-keyboard-shortcuts"
    )
}

private struct KeyboardShortcutsSheet: View {
    @Environment(\.dismiss) private var dismiss

    private let keyRows = [
        // Space stops and never starts (`talkOrStop`); P is Talk and Quiet, as the menu bar and the control bar name them.
        ShortcutHelpRow(command: "Space", result: "Stop speaking or listening"),
        ShortcutHelpRow(command: "P", result: "Talk / Quiet"),
        ShortcutHelpRow(command: "R", result: "Recite"),
        ShortcutHelpRow(command: "↑ / ↓", result: "Select"),
        ShortcutHelpRow(command: "Esc", result: "Release selection / close"),
        ShortcutHelpRow(command: "Right-click a row", result: "Rename, dismiss"),
        ShortcutHelpRow(command: "⌘K", result: "Command palette"),
        ShortcutHelpRow(command: "⌘,", result: "Settings"),
        ShortcutHelpRow(command: "?", result: "This list"),
    ]

    /// The keys of what floats over other apps: the pen (Canvas.swift's glass, panel-lab's keys) and the conversation
    /// panel. Here, in the one list, rather than as hints on the surfaces themselves.
    private let drawRows = [
        ShortcutHelpRow(command: "⌃⌥⌘P", result: "Draw on screen"),
        ShortcutHelpRow(command: "1 – 5", result: "Pick a pen tool"),
        ShortcutHelpRow(command: "⇧R", result: "Show: record the screen"),
        ShortcutHelpRow(command: "Return", result: "Send"),
        ShortcutHelpRow(command: "⌘Z", result: "Undo the last mark"),
        ShortcutHelpRow(command: "Esc", result: "Put the pen down"),
    ]

    private let panelRows = [
        ShortcutHelpRow(command: "⌥⌘← / ⌥⌘→", result: "Previous / next item"),
        ShortcutHelpRow(command: "⌘Return", result: "Full screen"),
        ShortcutHelpRow(command: "⌘.", result: "Collapse"),
        ShortcutHelpRow(command: "Esc", result: "Leave full screen"),
        ShortcutHelpRow(command: "Return", result: "Send the reply"),
        // The switcher, open (`PanelKeys`): Esc closes it before it leaves full screen.
        ShortcutHelpRow(command: "↑ / ↓, Return", result: "Pick a session in the switcher"),
    ]

    private let spokenRows = [
        ShortcutHelpRow(command: "“send”", result: "Submit now"),
        ShortcutHelpRow(command: "“continue”", result: "Read more"),
        ShortcutHelpRow(command: "“stop”", result: "End reading"),
        ShortcutHelpRow(command: "“no response needed”", result: "Close the mic"),
    ]

    var body: some View {
        // Scrolls, and stops growing. This was a fixed WIDTH with an unbounded
        // height, and the content is long — nine key rows, four spoken ones, a
        // legend and two paragraphs — so on a laptop the sheet ran off the
        // screen and there was no way to reach the bottom. Close is pinned
        // outside the scroll so it cannot be the part that goes missing.
        VStack(spacing: 0) {
            ScrollView {
                content
            }
            Divider().background(ConchPalette.divider)
            HStack {
                Spacer()
                Button("Close") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 14)
        }
        .frame(width: 440)
        // 620 keeps it inside a 13" screen once the title bar is counted.
        .frame(maxHeight: 620)
        .background(ConchPalette.bg)
        .onExitCommand {
            dismiss()
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 22) {
            Text("Keyboard Shortcuts")
                .font(ConchTypography.font(size: 19, weight: .medium))
                .foregroundStyle(ConchPalette.textPrimary)
                .accessibilityAddTraits(.isHeader)

            ShortcutHelpSection(title: "Keys", rows: keyRows)

            ShortcutHelpSection(title: "Drawing on screen", rows: drawRows)

            ShortcutHelpSection(title: "Conversation panel", rows: panelRows)

            ShortcutHelpSection(title: "Spoken commands", rows: spokenRows)

            // The entire ledger language is coloured glyphs, and this was the
            // only help surface — documenting keys and speech but never saying
            // what a green check or a cyan mic actually means.
            LedgerLegendSection()

            Text("The conch plugin adds these tools inside Claude Code and Codex: /plugin marketplace add Blueprint-Studio-AI/claude-code-marketplace")
                .font(ConchTypography.font(size: 12))
                .foregroundStyle(ConchPalette.textDim)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)

            Text("Saying a session’s name addresses it.")
                .font(ConchTypography.font(size: 12.5))
                .foregroundStyle(ConchPalette.textDim)

        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

}

/// What the ledger's glyphs mean, in the calm -> act-now order they escalate in.
private struct LedgerLegendSection: View {
    private struct Entry: Identifiable {
        let symbol: String
        let color: Color
        let meaning: String
        var id: String { meaning }
    }

    // Every line says what the state means for you, not only what it is called.
    private let entries: [Entry] = [
        Entry(symbol: "circle.fill", color: ConchPalette.statusActive, meaning: "Working — an agent is running, nothing needed from you"),
        Entry(symbol: "person.2.fill", color: ConchPalette.statusWaiting, meaning: "Its agents are working — you can talk to it"),
        Entry(symbol: "mic.fill", color: ConchPalette.statusMicOpen, meaning: "Mic open — it is hearing you"),
        // Ready for you is one state with one name, in the menu, on the pill and here; the check says which kind.
        Entry(symbol: "circle.inset.filled", color: ConchPalette.statusWaiting, meaning: "Ready for you — its turn is over"),
        Entry(symbol: "exclamationmark.circle.fill", color: ConchPalette.statusNeeds, meaning: "Blocked — needs an answer"),
        Entry(symbol: "checkmark.circle.fill", color: ConchPalette.statusReview, meaning: "Ready for you — work to look at"),
        Entry(symbol: "pause.fill", color: ConchPalette.textDim, meaning: "Manual — turns held for later"),
        Entry(symbol: "record.circle.fill", color: ConchPalette.statusMicOpen, meaning: "Recording your reply"),
        Entry(symbol: "play.fill", color: ConchPalette.statusQuiet, meaning: "Reading a reply aloud"),
        Entry(symbol: "ellipsis", color: ConchPalette.statusActive, meaning: "Transcribing what you said — it goes in next"),
        Entry(symbol: "diamond.fill", color: ConchPalette.textDim, meaning: "Prioritised — jumps the queue"),
        Entry(symbol: "circle", color: ConchPalette.textFaint, meaning: "Paused — a sub-agent that isn't running"),
        Entry(symbol: "circle.dotted", color: ConchPalette.textFaint, meaning: "Idle — nothing happening"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("What the marks mean")
                .font(ConchTypography.font(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.textDim)
                .textCase(.uppercase)
                .tracking(0.6)

            ForEach(entries) { entry in
                HStack(spacing: 10) {
                    Image(systemName: entry.symbol)
                        .font(.system(size: 10.5))
                        .foregroundStyle(entry.color)
                        .frame(width: 16)
                    Text(entry.meaning)
                        .font(ConchTypography.font(size: 12.5))
                        .foregroundStyle(ConchPalette.textPrimary)
                }
            }
        }
    }
}

private struct ShortcutHelpRow: Identifiable {
    let command: String
    let result: String

    /// Both: one key can mean two things in one list (Esc, Return).
    var id: String { command + "\u{1F}" + result }
}

private struct ShortcutHelpSection: View {
    let title: String
    let rows: [ShortcutHelpRow]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(ConchTypography.font(size: 11.5, weight: .medium))
                .foregroundStyle(ConchPalette.textDim)
                .textCase(.uppercase)
                .tracking(0.7)
                .accessibilityAddTraits(.isHeader)

            Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 9) {
                ForEach(rows) { row in
                    GridRow {
                        // You scan for the ACTION and then find its key, so the
                        // meaning is the column that has to be scannable. It was
                        // the dim one while the key carried the emphasis.
                        Text(row.command)
                            .font(ConchTypography.font(size: 12.5))
                            .foregroundStyle(ConchPalette.textDim)
                            .frame(width: 144, alignment: .leading)

                        Text(row.result)
                            .font(ConchTypography.font(size: 12.5, weight: .medium))
                            .foregroundStyle(ConchPalette.textPrimary)
                    }
                }
            }
        }
    }
}
