import SwiftUI

/// The whole app is two ideas: a glanceable ledger, and a talk surface per
/// session. Nothing else earns a place on a phone screen.
struct LedgerView: View {
    @ObservedObject var bridge: BridgeClient
    let onUnpair: () -> Void
    @ObservedObject var speech: SpeechController
    /// Passed through, deliberately NOT observed: the ledger only hands this
    /// to SessionView, and observing it would rebuild the whole list on every
    /// partial word — churning the very view whose teardown used to delete
    /// the transcript. SessionView observes it and updates on its own.
    let talk: TalkController
    @State private var confirmingUnpair = false
    @State private var showingSettings = false
    @State private var showingStartSession = false
    /// What the user just asked for, shown until the daemon's own state agrees.
    @State private var pendingPassive: Bool?
    @State private var sessionActionError: String?
    @State private var showingSessionActionError = false

    /// The running binary's own build time — the only claim about which
    /// build this is that cannot be stale.
    static let buildStamp: String = {
        guard let path = Bundle.main.executablePath,
              let date = try? FileManager.default
                  .attributesOfItem(atPath: path)[.modificationDate] as? Date
        else { return "unknown" }
        let format = DateFormatter()
        format.dateFormat = "d MMM HH:mm"
        return format.string(from: date)
    }()

    var body: some View {
        NavigationStack {
            Group {
                if let state = bridge.state,
                   !state.rows.isEmpty || !state.dismissedRows.isEmpty {
                    List {
                        // A dead connection must be LEGIBLE, not a private 8px
                        // dot: these rows are a snapshot, and their ages keep
                        // counting as if live. Say so, and dim what's stale.
                        if !bridge.isConnected {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small)
                                Text("Reconnecting to your Mac — showing the last known state.")
                                    .font(Type.caption)
                                    .foregroundStyle(Palette.waiting)
                            }
                            .listRowBackground(Palette.bg)
                            .listRowSeparator(.hidden)
                        }
                        ForEach(state.rows) { row in
                            NavigationLink(value: row.id) {
                                SessionRowView(row: row)
                            }
                            .listRowBackground(Palette.bg)
                            .listRowSeparatorTint(Palette.divider)
                            .opacity(bridge.isConnected ? 1 : 0.55)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) {
                                    runSessionCommand(.dismiss, id: row.id, label: row.label)
                                } label: {
                                    Label("Dismiss", systemImage: "eye.slash")
                                }
                                .disabled(!bridge.isConnected)
                                .accessibilityLabel("Dismiss \(row.label)")
                            }
                        }

                        if !state.dismissedRows.isEmpty {
                            Section {
                                ForEach(state.dismissedRows) { row in
                                    HStack(spacing: 12) {
                                        Image(systemName: "eye.slash")
                                            .font(.system(size: 14))
                                            .foregroundStyle(Palette.textFaint)
                                            .frame(width: 22)
                                            .accessibilityHidden(true)
                                        Text(row.label)
                                            .font(Type.sessionName)
                                            .foregroundStyle(Palette.textDim)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                        Spacer(minLength: 8)
                                        Button("Restore") {
                                            runSessionCommand(.restore, id: row.id, label: row.label)
                                        }
                                        .font(Type.caption.weight(.medium))
                                        .foregroundStyle(Palette.micOpen)
                                        .buttonStyle(.borderless)
                                        .disabled(!bridge.isConnected)
                                        .accessibilityLabel("Restore \(row.label)")
                                    }
                                    .listRowBackground(Palette.bg)
                                    .listRowSeparatorTint(Palette.divider)
                                }
                            } header: {
                                Text("Dismissed")
                                    .foregroundStyle(Palette.textFaint)
                            } footer: {
                                Text("Dismissed sessions keep running on your Mac.")
                                    .foregroundStyle(Palette.textFaint)
                            }
                        }
                    }
                    .listStyle(.plain)
                    .navigationDestination(for: String.self) { id in
                        SessionView(bridge: bridge, speech: speech, talk: talk, sessionId: id)
                    }
                } else {
                    emptyState
                }
            }
            .background(Palette.bg)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // The Mac dashboard has carried the shell in its header since
                // the beginning; the phone's ledger was the one surface without
                // it. Same wordmark, same mark, wherever you look at conch.
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 5) {
                        Text("\u{1F41A}")
                            .font(.system(size: 13))
                            .accessibilityHidden(true)
                        Text("conch")
                            .font(Type.label(17, weight: .semibold))
                            .foregroundStyle(Palette.textPrimary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("conch")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    modeToggle
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingStartSession = true } label: {
                        Image(systemName: "plus")
                    }
                    .disabled(!bridge.isConnected)
                    .accessibilityLabel("Start a session")
                }
                ToolbarItem(placement: .topBarLeading) {
                    // Everything about THIS Mac lives here: whether we are
                    // connected, to what, how to retry, and how to forget it.
                    // The right-hand button is conch's own settings, so neither
                    // button is a grab-bag.
                    Menu {
                        Section(bridge.isConnected ? "Connected" : "Not connected") {
                            Text(bridge.pairedHost)
                            // Installing over a running app leaves the OLD
                            // process running, so "is the fix on the phone?"
                            // was guesswork three separate times. The binary's
                            // own timestamp cannot lie about which build this
                            // is — read it out and the question is settled.
                            Text("Build \(Self.buildStamp)")
                        }
                        Button("Reconnect now") { bridge.reconnectNow() }
                        Divider()
                        if speech.isSpeaking {
                            Button("Stop reading") { speech.stop() }
                            Divider()
                        }
                        Button("conch settings…") { showingSettings = true }
                        Divider()
                        Button("Unpair from this Mac…", role: .destructive) {
                            confirmingUnpair = true
                        }
                    } label: {
                        Image(systemName: bridge.isConnected ? "laptopcomputer" : "laptopcomputer.slash")
                            .foregroundStyle(bridge.isConnected ? Palette.textDim : Palette.needs)
                    }
                    .accessibilityLabel(
                        bridge.isConnected
                            ? "Connected to \(bridge.pairedHost)"
                            : "Not connected to \(bridge.pairedHost)"
                    )
                }
            }
        }
        .tint(Palette.micOpen)
        .preferredColorScheme(.dark)
        .onChange(of: bridge.state) { _, next in
            speech.consider(state: next)
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView(bridge: bridge)
        }
        .sheet(isPresented: $showingStartSession) {
            StartSessionSheet(bridge: bridge)
        }
        .confirmationDialog(
            "Unpair from this Mac?",
            isPresented: $confirmingUnpair,
            titleVisibility: .visible
        ) {
            Button("Unpair", role: .destructive, action: onUnpair)
        } message: {
            Text("You'll need to run conch pair on the Mac again to reconnect.")
        }
        .alert("Couldn't update that session", isPresented: $showingSessionActionError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(sessionActionError ?? "Your Mac may have gone away.")
        }
    }

    private func runSessionCommand(
        _ command: BridgeClient.SessionCommand,
        id: String,
        label: String
    ) {
        Task {
            guard await bridge.send(sessionCommand: command, sessionId: id) else {
                let verb = command == .dismiss ? "dismiss" : "restore"
                sessionActionError = bridge.lastError
                    ?? "Couldn't \(verb) \(label). Your Mac may have gone away."
                showingSessionActionError = true
                return
            }
        }
    }

    /// Active or passive, in one tap.
    ///
    /// Active is the loop: finished turns announce themselves, get read aloud,
    /// and the mic opens for your reply — the Mac and terminal behaviour.
    /// Passive keeps every session visible and still lets you talk to one on
    /// purpose; it just stops the machine speaking first.
    ///
    /// A dot rather than a glyph: iOS's glass button already reads as pressable,
    /// so the chrome carries the affordance and the dot carries only the state.
    ///
    /// It flips IMMEDIATELY. Waiting for the daemon meant a POST, a 10Hz publish
    /// and a socket round trip before anything moved — perhaps a fifth of a
    /// second, which on a control this simple reads as broken. The optimistic
    /// state is held only until the daemon's own state agrees, so the truth
    /// still comes from one place; a failed request snaps back.
    private var modeToggle: some View {
        let passive = pendingPassive ?? (bridge.state?.mode.paused ?? false)
        return Button {
            let next = !passive
            pendingPassive = next
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            Task {
                // And it does NOT hand the Mac back: which machine is primary
                // is decided by whether this app is open, not by a button that
                // would then mean two things at once.
                let sent = await bridge.send(mode: next ? "pause" : "resume")
                if !sent { pendingPassive = nil }
                if next { speech.stop() }
                // If the daemon never agrees — command lost, relay blip — the
                // guess would otherwise show the wrong state indefinitely and
                // every further tap would fight it. Let the truth win back.
                try? await Task.sleep(for: .seconds(3))
                if pendingPassive == next, bridge.state?.mode.paused != next {
                    pendingPassive = nil
                }
            }
        } label: {
            // An Image, not a Circle. A Button's hit area is its label's
            // frame: a shape given .frame(10) is a 10pt target, so four of
            // Tyler's five taps landed on nothing. Padding it out to 44 fixed
            // the aiming and inflated the glass capsule with it — "bruh u just
            // made the button ugly".
            //
            // A toolbar Image gets the platform's own button metrics, which is
            // why the laptop menu opposite has always worked first try. Same
            // 10pt dot on screen, full glass tappable, nothing added.
            // Auto or manual, not paused or playing. These were never two
            // features: auto reads finished turns aloud and opens the mic on
            // its own, manual does neither while everything else keeps working
            // — you read, and press recite on what you want to hear. A dot
            // said neither of those things; a word says both.
            Image(systemName: passive ? "hand.raised.fill" : "waveform.circle.fill")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(passive ? Palette.textDim : Palette.micOpen)
                .animation(.easeOut(duration: 0.12), value: passive)
        }
        .accessibilityLabel(
            passive
                ? "Manual — conch stays quiet and waits. Switch to auto."
                : "Auto — finished turns read aloud and the mic opens itself. Switch to manual."
        )
        .onChange(of: bridge.state?.mode.paused) { _, actual in
            // The daemon has caught up (or something else changed it); stop
            // holding the local guess so the two can never disagree for long.
            if let pendingPassive, pendingPassive == actual { self.pendingPassive = nil }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            // Not wifi.slash: this shows for BOTH transports, and over the
            // relay the Wi-Fi is fine — it is the Mac that cannot be reached.
            // Naming the wrong culprit in a glyph is the same mistake as
            // naming it in a sentence, just harder to notice.
            Image(systemName: bridge.isConnected ? "terminal" : "laptopcomputer.slash")
                .font(.system(size: 22))
                .foregroundStyle(Palette.textFaint)
            Text(bridge.isConnected
                ? "Nothing running yet"
                : bridge.hasEverConnected ? "Reconnecting…" : "Looking for your Mac…")
                .font(Type.label(16, weight: .medium))
                .foregroundStyle(Palette.textDim)
            Text(
                bridge.isConnected
                    ? "Start a Claude Code or Codex session here and it opens in Terminal on your Mac."
                    // Over the relay, Wi-Fi is irrelevant advice — Tyler was on
                    // cellular, correctly, and being told to check the thing
                    // that could not be the cause. What actually has to be true
                    // is that the Mac is awake with conch running.
                    // Three different situations, three different fixes. Lumping
                    // them under one sentence is what left Tyler checking Wi-Fi
                    // that was fine, for a pairing that was correct.
                    : bridge.hasEverConnected
                        ? "This usually clears on its own. If it doesn't, your Mac may be asleep or conch stopped."
                        : bridge.isRelayPaired
                            ? "Your Mac needs to be awake with conch running — it reconnects on its own."
                            : "Same Wi-Fi as the Mac, and conch running there — it reconnects on its own."
            )
            .font(Type.caption)
            .foregroundStyle(Palette.textFaint)
            .multilineTextAlignment(.center)
            .frame(maxWidth: 260)

            if bridge.isConnected {
                Button("Start a session") { showingStartSession = true }
                    .buttonStyle(.borderedProminent)
                    .tint(Palette.micOpen)
                    .foregroundStyle(Palette.bg)
                    .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Geometric centre reads low; optical centre sits a little above it.
        .offset(y: -28)
    }
}

struct SessionRowView: View {
    let row: PublishedState.Row

    private var mark: StatusMark { StatusMark(row: row) }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: mark.symbol)
                .font(.system(size: 15))
                .foregroundStyle(mark.color)
                .frame(width: 22)
                .accessibilityLabel(mark.meaning)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Text(row.label)
                        .font(Type.sessionName)
                        .foregroundStyle(Palette.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    AgentBadge(backend: row.backend)
                }

                if let summary = row.review?.summary ?? row.detail, !summary.isEmpty {
                    Text(summary)
                        .font(Type.summary)
                        .foregroundStyle(Palette.textDim)
                        .lineLimit(2)
                }

                if let context = row.context, context.limitTokens > 0 {
                    ContextMeter(usage: context, compact: true)
                        .padding(.top, 2)
                }
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 2) {
                if let age = relativeAge(epochMilliseconds: row.review?.at ?? row.at) {
                    Text(age)
                        .font(Type.caption.monospacedDigit())
                        .foregroundStyle(Palette.textFaint)
                }
                // Say what the glyph MEANS, so the ledger answers "which one
                // wants me?" without opening three sessions to find out.
                //
                // Only when it is not the resting state. "Working" on every
                // quiet row is noise that trains you to stop reading the
                // column, which costs you the one row that did need you.
                if mark.showsMeaningInLedger {
                    Text(mark.meaning)
                        .font(Type.caption)
                        .foregroundStyle(mark.color)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 8)
        .opacity(row.paused ? 0.72 : 1)
    }
}

struct AgentBadge: View {
    let backend: String?

    var body: some View {
        if let name = backendName {
            Text(name)
                .font(Type.caption.weight(.medium))
                .foregroundStyle(Palette.textFaint)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.white.opacity(0.045), in: Capsule())
                .accessibilityLabel("\(name) session")
        }
    }

    private var backendName: String? {
        switch backend?.lowercased() {
        // Legacy Claude registry rows omit the field; absence has always been
        // the wire-level Claude value, not an unknown agent.
        case nil, "claude": "Claude"
        case "codex": "Codex"
        default: nil
        }
    }
}

struct ContextMeter: View {
    let usage: PublishedState.Row.ContextUsage
    var compact = false

    private var tint: Color {
        if usage.proportion >= 0.95 { return Palette.needs }
        if usage.proportion >= 0.80 { return Palette.waiting }
        return Palette.textFaint
    }

    private var tokenLabel: String {
        "\(abbreviate(usage.usedTokens)) / \(abbreviate(usage.limitTokens)) tokens"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 3 : 5) {
            HStack(spacing: 6) {
                if !compact {
                    Text("Context")
                        .font(Type.caption.weight(.medium))
                        .foregroundStyle(Palette.textDim)
                }
                Spacer(minLength: 0)
                Text("\(Int((usage.proportion * 100).rounded()))%")
                    .font(Type.caption.monospacedDigit())
                    .foregroundStyle(tint)
                if !compact {
                    Text(tokenLabel)
                        .font(Type.caption.monospacedDigit())
                        .foregroundStyle(Palette.textFaint)
                }
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.07))
                    Capsule()
                        .fill(tint)
                        .frame(width: geometry.size.width * usage.proportion)
                }
            }
            .frame(height: compact ? 3 : 5)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Context \(Int((usage.proportion * 100).rounded())) percent, \(tokenLabel)")
    }

    private func abbreviate(_ value: Int) -> String {
        guard value >= 1_000 else { return "\(value)" }
        let thousands = Double(value) / 1_000
        return thousands >= 100
            ? "\(Int(thousands.rounded()))k"
            : String(format: "%.1fk", thousands)
    }
}

private struct StartSessionSheet: View {
    @ObservedObject var bridge: BridgeClient
    @Environment(\.dismiss) private var dismiss
    @State private var backend = BridgeClient.AgentBackend.claude
    @State private var resuming = false
    @State private var starting = false
    @State private var error: String?

    // Resume
    @State private var resumeQuery = ""
    @State private var resumeSelection: ResumableSession?
    @State private var resumable: [ResumableSession] = []
    @State private var isLoadingResumable = false

    var body: some View {
        NavigationStack {
            Form {
                // A resumed session brings its own agent — asking again is a
                // question with a known answer and a wrong setting available.
                if !resuming {
                    Section("Agent") {
                        Picker("Agent", selection: $backend) {
                            ForEach(BridgeClient.AgentBackend.allCases) { backend in
                                Text(backend.title).tag(backend)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                }

                Section {
                    Toggle("Resume an existing session", isOn: $resuming)
                } footer: {
                    if !resuming {
                        Text("The agent starts in a new Terminal window on your Mac.")
                    }
                }

                if resuming {
                    resumeSection
                }

                if let error {
                    Section {
                        Text(error)
                            .foregroundStyle(Palette.needs)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.bg)
            .navigationTitle(resuming ? "Resume session" : "New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(starting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(resuming ? "Resume" : "Start") { start() }
                        .disabled(starting || (resuming && resumeSelection == nil))
                }
            }
        }
        .preferredColorScheme(.dark)
        // `task(id:)` rather than `onChange`, so this fires when the sheet
        // APPEARS already in resume mode as well as when the toggle flips —
        // keying it to the toggle alone left a sheet opened straight into
        // resume mode with nothing loaded. Keyed on the query too: the daemon
        // filters server-side and answers in milliseconds, so a keystroke can
        // simply ask again rather than filtering a stale local copy.
        .task(id: "\(resuming):\(resumeQuery)") {
            guard resuming else { return }
            isLoadingResumable = true
            resumable = await bridge.resumableSessions(query: resumeQuery)
            isLoadingResumable = false
        }
    }

    @ViewBuilder
    private var resumeSection: some View {
        Section {
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Palette.textFaint)
                TextField(searchPrompt, text: $resumeQuery)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .listRowBackground(Palette.bg)

            if isLoadingResumable {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Reading your history…")
                        .foregroundStyle(Palette.textFaint)
                }
                .listRowBackground(Palette.bg)
            } else if resumable.isEmpty {
                Text(resumeQuery.isEmpty
                    ? "No past sessions found"
                    : "Nothing matches \u{201C}\(resumeQuery)\u{201D}")
                    .foregroundStyle(Palette.textFaint)
                    .listRowBackground(Palette.bg)
            } else {
                ForEach(resumable) { session in
                    Button {
                        resumeSelection = session
                    } label: {
                        ResumableRow(session: session, isSelected: resumeSelection?.id == session.id)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(
                        resumeSelection?.id == session.id ? Palette.raised : Palette.bg
                    )
                }
            }
        } footer: {
            Text(footnote)
        }
    }

    /// The count is reassurance: it says the history is there before you've
    /// typed anything that proves it.
    private var searchPrompt: String {
        resumable.isEmpty ? "Search past sessions" : "Search \(resumable.count) past sessions"
    }

    /// Say where it will actually land — the thing a resume can silently get
    /// wrong: the same conversation reopened in the wrong folder is a
    /// conversation about files that are not there.
    private var footnote: String {
        guard let picked = resumeSelection else {
            return "Pick a session to restart. It reopens with its own agent, in its own folder."
        }
        let agent = picked.backend.lowercased() == "codex" ? "Codex" : "Claude"
        return "Restarts \(agent) in \(picked.shortCwd), in a new Terminal window on your Mac."
    }

    private func start() {
        starting = true
        error = nil
        Task {
            let started = await bridge.startSession(
                backend: resuming
                    ? (resumeSelection?.backend.lowercased() == "codex" ? .codex : .claude)
                    : backend,
                resumeSessionId: resuming ? resumeSelection?.sessionId : nil,
                cwd: resuming ? resumeSelection?.cwd : nil
            )
            starting = false
            if started { dismiss() }
            else { error = bridge.lastError ?? "Couldn't start that session." }
        }
    }
}

/// One row in the resume picker: agent mark, label, location under it, and
/// how long ago the session was left — the same fields the Mac's picker
/// shows, laid out with this app's own row idioms (`AgentBadge`, `Type`,
/// `Palette`) instead of transplanted AppKit chrome.
private struct ResumableRow: View {
    let session: ResumableSession
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Text(session.label)
                        .font(Type.sessionName)
                        .foregroundStyle(Palette.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    AgentBadge(backend: session.backend)
                }
                Text(session.shortCwd)
                    .font(Type.caption)
                    .foregroundStyle(Palette.textFaint)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: 8)

            Text(session.age)
                .font(Type.caption.monospacedDigit())
                .foregroundStyle(Palette.textFaint)

            if isSelected {
                Image(systemName: "checkmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.micOpen)
            }
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
    }
}
