import SwiftUI

/// The whole app is two ideas: a glanceable ledger, and a talk surface per
/// session. Nothing else earns a place on a phone screen.
struct LedgerView: View {
    @ObservedObject var bridge: BridgeClient
    let onUnpair: () -> Void
    @State private var confirmingUnpair = false

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
            .navigationTitle("conch")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    connectionDot
                }
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        // The app's only destructive action: one stray tap
                        // otherwise discards the pairing and demands the Mac's
                        // code again.
                        Button("Unpair from this Mac…", role: .destructive) {
                            confirmingUnpair = true
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .foregroundStyle(Palette.textDim)
                    }
                }
            }
        }
        .tint(Palette.micOpen)
        .preferredColorScheme(.dark)
        .confirmationDialog(
            "Unpair from this Mac?",
            isPresented: $confirmingUnpair,
            titleVisibility: .visible
        ) {
            Button("Unpair", role: .destructive, action: onUnpair)
        } message: {
            Text("You'll need to run `conch pair` on the Mac again to reconnect.")
        }
    }

    /// Liveness, stated without words: the same cyan/dim vocabulary as rows.
    private var connectionDot: some View {
        // Deliberately NOT the working-cyan: that hue means "machine busy" one
        // point away in the rows, and liveness is a different statement.
        Circle()
            .fill(bridge.isConnected ? Palette.textDim : Palette.needs)
            .frame(width: 8, height: 8)
            .accessibilityLabel(bridge.isConnected ? "Connected" : "Disconnected")
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
