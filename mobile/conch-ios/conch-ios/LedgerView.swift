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
    /// What the user just asked for, shown until the daemon's own state agrees.
    @State private var pendingPassive: Bool?

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
                if let state = bridge.state, !state.rows.isEmpty {
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
        .confirmationDialog(
            "Unpair from this Mac?",
            isPresented: $confirmingUnpair,
            titleVisibility: .visible
        ) {
            Button("Unpair", role: .destructive, action: onUnpair)
        } message: {
            Text("You'll need to run conch pair on the Mac again to reconnect.")
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
                // PAUSE, not mute. Mute FORGETS finished turns — Tyler pressed
                // this and lost two. Pause holds them and replays on resume,
                // which is what "not right now" should ever mean.
                //
                // And it does NOT hand the Mac back: which machine is primary
                // is decided by whether this app is open, not by a button that
                // would then mean two things at once.
                let sent = await bridge.send(mode: next ? "pause" : "resume")
                if !sent { pendingPassive = nil }
                if next { speech.stop() }
            }
        } label: {
            Circle()
                .fill(passive ? Palette.textDim : Palette.needs)
                .frame(width: 10, height: 10)
                .animation(.easeOut(duration: 0.12), value: passive)
        }
        .accessibilityLabel(
            passive
                ? "Paused — finished turns are being held. Resume."
                : "Active — announcing finished turns. Pause."
        )
        .onChange(of: bridge.state?.mode.paused) { _, actual in
            // The daemon has caught up (or something else changed it); stop
            // holding the local guess so the two can never disagree for long.
            if let pendingPassive, pendingPassive == actual { self.pendingPassive = nil }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: bridge.isConnected ? "terminal" : "wifi.slash")
                .font(.system(size: 22))
                .foregroundStyle(Palette.textFaint)
            Text(bridge.isConnected ? "Nothing running yet" : "Looking for your Mac…")
                .font(Type.label(16, weight: .medium))
                .foregroundStyle(Palette.textDim)
            Text(
                bridge.isConnected
                    ? "Start a Claude Code or Codex session on your Mac and it appears here."
                    : "Same Wi-Fi as the Mac, and conch running there — it reconnects on its own."
            )
            .font(Type.caption)
            .foregroundStyle(Palette.textFaint)
            .multilineTextAlignment(.center)
            .frame(maxWidth: 260)
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
                Text(row.label)
                    .font(Type.sessionName)
                    .foregroundStyle(Palette.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                if let summary = row.review?.summary ?? row.detail, !summary.isEmpty {
                    Text(summary)
                        .font(Type.summary)
                        .foregroundStyle(Palette.textDim)
                        .lineLimit(2)
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
        .opacity(row.muted || row.paused ? 0.72 : 1)
    }
}
