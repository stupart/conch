import SwiftUI

/// The whole app is two ideas: a glanceable ledger, and a talk surface per
/// session. Nothing else earns a place on a phone screen.
struct LedgerView: View {
    @ObservedObject var bridge: BridgeClient
    let onUnpair: () -> Void
    @State private var confirmingUnpair = false
    @State private var showingSettings = false

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
                        SessionView(bridge: bridge, sessionId: id)
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
                        }
                        Button("Reconnect now") { bridge.reconnectNow() }
                        Divider()
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
    /// purpose; it just stops the machine speaking first. That distinction is
    /// the one you change constantly and the only one worth a permanent button.
    ///
    /// A dot rather than a glyph: iOS's glass button already reads as pressable,
    /// so the button chrome carries the affordance and the dot carries only the
    /// state — live red, or grey when it isn't listening for you.
    private var modeToggle: some View {
        let passive = bridge.state?.mode.muted ?? false
        return Button {
            Task { await bridge.send(mode: passive ? "unmute" : "mute") }
        } label: {
            Circle()
                .fill(passive ? Palette.textDim : Palette.needs)
                .frame(width: 10, height: 10)
                .animation(.easeOut(duration: 0.18), value: passive)
        }
        .accessibilityLabel(
            passive
                ? "Passive — nothing is announced. Activate."
                : "Active — announcing finished turns. Go passive."
        )
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

            if let age = relativeAge(epochMilliseconds: row.review?.at ?? row.at) {
                Text(age)
                    .font(Type.caption.monospacedDigit())
                    .foregroundStyle(Palette.textFaint)
            }
        }
        .padding(.vertical, 8)
        .opacity(row.muted || row.paused ? 0.72 : 1)
    }
}
