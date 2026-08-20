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
                // Hidden rather than disabled while disconnected. A greyed-out
                // control still says "this is a thing you do here", which is
                // the wrong message when nothing can reach the Mac — Tyler:
                // "should remove the top right speach and + (new session)
                // button when not connected". The card below is what should
                // hold attention instead.
                if bridge.isConnected {
                    ToolbarItem(placement: .topBarTrailing) {
                        modeToggle
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showingStartSession = true } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityLabel("Start a session")
                    }
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
            // Connected is a different SHAPE of message from disconnected, not
            // a different sentence in the same one. When it is working, this is
            // a nudge to start something. When it is not, it is the only screen
            // that matters, and it needs to say what is wrong and offer the
            // thing that fixes it — Tyler: "theres nothing one can do if it
            // doesnt (like press a button or what not)".
            if bridge.isConnected {
                Image(systemName: "terminal")
                    .font(.system(size: 22))
                    .foregroundStyle(Palette.textFaint)
                Text("Nothing running yet")
                    .font(Type.label(16, weight: .medium))
                    .foregroundStyle(Palette.textDim)
                Text("Start a Claude Code or Codex session here and it opens in Terminal on your Mac.")
                    .font(Type.caption)
                    .foregroundStyle(Palette.textFaint)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 260)
                Button("Start a session") { showingStartSession = true }
                    .buttonStyle(.borderedProminent)
                    .tint(Palette.micOpen)
                    .foregroundStyle(Palette.bg)
                    .padding(.top, 6)
            } else {
                DisconnectedCard(
                    hasEverConnected: bridge.hasEverConnected,
                    isRelayPaired: bridge.isRelayPaired,
                    host: bridge.pairedHost,
                    onReconnect: { bridge.reconnectNow() },
                    onSettings: { showingSettings = true }
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Geometric centre reads low; optical centre sits a little above it.
        .offset(y: -28)
    }
}

/// What to do when the phone cannot reach the Mac.
///
/// This used to be one centred sentence saying it reconnects on its own, with
/// no way to make it try — true, and useless at the moment it is wrong. The
/// three situations already had three different explanations, which was the
/// hard-won part; what they lacked was an action each.
private struct DisconnectedCard: View {
    let hasEverConnected: Bool
    let isRelayPaired: Bool
    let host: String
    let onReconnect: () -> Void
    let onSettings: () -> Void
    @State private var retrying = false

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 10) {
                Image(systemName: "laptopcomputer.slash")
                    .font(.system(size: 26))
                    .foregroundStyle(Palette.textFaint)
                Text(title)
                    .font(Type.label(16, weight: .medium))
                    .foregroundStyle(Palette.textDim)
                Text(explanation)
                    .font(Type.caption)
                    .foregroundStyle(Palette.textFaint)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                if !host.isEmpty {
                    Text(host)
                        .font(Type.caption.monospaced())
                        .foregroundStyle(Palette.textFaint)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 18)

            Divider().overlay(Palette.textFaint.opacity(0.16))

            // The action IS the point of the card. Retrying is safe, cheap and
            // the thing a person reaches for first, so it is the primary one
            // even though the connection also retries by itself.
            Button {
                retrying = true
                onReconnect()
                // The reconnect is fire-and-forget; the delay exists so the
                // button acknowledges the press rather than appearing dead.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { retrying = false }
            } label: {
                HStack(spacing: 7) {
                    if retrying { ProgressView().controlSize(.small) }
                    Text(retrying ? "Trying…" : "Try again now")
                        .font(Type.label(14, weight: .medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Palette.micOpen)
            .disabled(retrying)

            Divider().overlay(Palette.textFaint.opacity(0.16))

            Button(action: onSettings) {
                Text("Pairing and settings")
                    .font(Type.caption)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Palette.textDim)
        }
        .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(Palette.textFaint.opacity(0.14), lineWidth: 1)
        )
        .frame(maxWidth: 320)
    }

    private var title: String {
        hasEverConnected ? "Can\u{2019}t reach your Mac" : "Looking for your Mac"
    }

    /// Three situations, three fixes. Naming the wrong culprit is what left
    /// Tyler checking Wi-Fi that was fine, for a pairing that was correct.
    private var explanation: String {
        if hasEverConnected {
            return "This usually clears on its own. If it doesn\u{2019}t, your Mac may be asleep, or conch may have stopped running on it."
        }
        return isRelayPaired
            ? "Your Mac needs to be awake with conch running. It will connect from anywhere once it is."
            : "Your Mac needs to be on the same Wi-Fi, awake, with conch running."
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

                // Deliberately NOT here. A bar plus a percentage under every
                // row made the most incidental number on screen the most
                // visually loud thing in the list, competing with the labels
                // you are actually scanning. Tyler: "its a nice to have when u
                // need it feature but not something thats like primary form of
                // data". It lives on the session view, which is where the Mac
                // puts it and where you go when you want to know.
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

    /// The mark, not the word.
    ///
    /// This was a text pill because the iOS asset catalog had no agent art —
    /// so the phone said "Claude" and "Codex" in capsules while the Mac showed
    /// the actual marks. Tyler: "looks like the iphone app is missing the icons
    /// for codex and claude code and has names instead." The assets are
    /// universal and template-rendered, so they came straight across.
    ///
    /// A mark also costs a fraction of the width, which matters in a list where
    /// the label is the thing you are reading and the badge was eating it.
    var body: some View {
        if let name = backendName {
            Image(name == "Codex" ? "AgentCodex" : "AgentClaude")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .foregroundStyle(Palette.textFaint)
                .frame(width: 11, height: 11)
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

    private var tint: Color {
        // A routine session stays quiet. Colour starts carrying urgency only
        // once context pressure can plausibly change the next decision.
        if usage.proportion >= 0.95 { return Palette.needs }
        if usage.proportion >= 0.80 { return Palette.waiting }
        return Palette.textFaint
    }

    /// A number, not a bar, and only where you have already committed to
    /// looking at one session — the same call the Mac made.
    ///
    /// A filled capsule under every ledger row gave context pressure the same
    /// visual weight as the session itself, on the one surface you scan
    /// constantly. Tyler: "its a nice to have when u need it feature but not
    /// something thats like primary form of data". Colour still carries the
    /// warning; it just stops shouting when there is nothing to warn about.
    var body: some View {
        HStack(spacing: 6) {
            Text("Context")
                .font(Type.caption.weight(.medium))
                .foregroundStyle(Palette.textDim)
            Text("\(Int((usage.proportion * 100).rounded()))%")
                .font(Type.caption.monospacedDigit())
                .foregroundStyle(tint)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "Context \(Int((usage.proportion * 100).rounded())) percent used"
        )
    }
}

private struct StartSessionSheet: View {
    @ObservedObject var bridge: BridgeClient
    @Environment(\.dismiss) private var dismiss
    @State private var backend = BridgeClient.AgentBackend.claude
    @State private var resuming = false
    @State private var workingFolder = ""
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

                    Section {
                        TextField("/Users/you/project", text: $workingFolder)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } header: {
                        Text("Working folder")
                    } footer: {
                        Text("An absolute folder on your Mac. Leave blank to start in your Mac home folder.")
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
                cwd: resuming ? resumeSelection?.cwd : freshWorkingFolder
            )
            starting = false
            if started { dismiss() }
            else { error = bridge.lastError ?? "Couldn't start that session." }
        }
    }

    private var freshWorkingFolder: String? {
        let trimmed = workingFolder.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
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
