import SwiftUI

/// The whole app is two ideas: a glanceable ledger, and a talk surface per
/// session. Nothing else earns a place on a phone screen.
struct LedgerView: View {
    @ObservedObject var bridge: BridgeClient
    let onUnpair: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                if let state = bridge.state, !state.rows.isEmpty {
                    List {
                        ForEach(state.rows) { row in
                            NavigationLink(value: row.id) {
                                SessionRowView(row: row)
                            }
                            .listRowBackground(Palette.bg)
                            .listRowSeparatorTint(Palette.divider)
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
                        Button("Unpair from this Mac", role: .destructive, action: onUnpair)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .foregroundStyle(Palette.textDim)
                    }
                }
            }
        }
        .tint(Palette.micOpen)
        .preferredColorScheme(.dark)
    }

    /// Liveness, stated without words: the same cyan/dim vocabulary as rows.
    private var connectionDot: some View {
        Circle()
            .fill(bridge.isConnected ? Palette.working : Palette.needs)
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
    }
}

struct SessionRowView: View {
    let row: PublishedState.Row

    private var mark: StatusMark { StatusMark(row: row) }

    var body: some View {
        HStack(spacing: 12) {
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
