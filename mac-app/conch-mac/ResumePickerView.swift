import SwiftUI

/// One past session you could pick up again.
struct ResumableSession: Decodable, Identifiable, Hashable, Sendable {
    let sessionId: String
    let backend: String
    let label: String
    let cwd: String
    /// Epoch milliseconds. Used for "3h" and for ordering.
    let updatedAt: Double

    var id: String { sessionId }

    /// "3h", "2d" — the same shorthand the session list already uses, because
    /// this is the same question asked of older rows.
    var age: String {
        let seconds = max(0, Date().timeIntervalSince1970 - updatedAt / 1000)
        if seconds < 90 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
        return "\(Int(seconds / 86_400))d"
    }

    /// `/Users/me/conch` reads as `~/conch`. The home prefix is the same on
    /// every row, so it is noise in a list whose job is to tell rows apart.
    ///
    /// Home itself is spelled out. A bare "~" on its own line read as missing
    /// data rather than as a place — and with real history several rows are
    /// home, so the list had three apparent glitches in it.
    var shortCwd: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if cwd == home { return "Home" }
        if cwd.hasPrefix(home + "/") { return "~" + cwd.dropFirst(home.count) }
        return cwd
    }
}

/// Pick a past session to restart.
///
/// conch could already restart one — `resumeSessionId` runs all the way to
/// `claude --resume <id>` — but the only way to fill that field was to know the
/// id, so Tyler had to open Codex to find it and copy it back. The machinery
/// was there; the list was missing.
///
/// Two things this deliberately does NOT ask you:
///
/// The agent. A past session already IS a Claude one or a Codex one, so asking
/// again is a question with a known answer and a wrong setting. Picking a row
/// sets it.
///
/// The folder. `claude --resume` in the wrong directory resumes a conversation
/// about files that are not there. The session knows where it ran, so that
/// travels with the row rather than being re-typed.
struct ResumePickerView: View {
    let sessions: [ResumableSession]
    let isLoading: Bool
    @Binding var query: String
    @Binding var selection: ResumableSession?
    /// Return on a selected row starts it, so the whole picker is reachable
    /// without the mouse: type, arrow, enter.
    var onConfirm: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            searchField
                // The field holds focus while you type, so the arrows have to
                // be caught here rather than on the list.
                .onKeyPress(keys: [.upArrow, .downArrow]) { press in
                    move(press.key == .downArrow ? 1 : -1)
                    return .handled
                }
                .onKeyPress(.return) {
                    guard selection != nil else { return .ignored }
                    onConfirm()
                    return .handled
                }
            listBody
                .frame(height: 208)
                // The ground has to be `bg`, because that is what the surface
                // ladder was measured against: selection 1.56:1, hover 1.22:1.
                // Sitting the list on a lifted surface instead ate most of that
                // step and left a selected row barely distinguishable from an
                // unselected one.
                .background(ConchPalette.bg)
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .strokeBorder(ConchPalette.textDim.opacity(0.14), lineWidth: 1)
                )
        }
    }

    private var searchField: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.textFaint)
            TextField(searchPrompt, text: $query)
                .textFieldStyle(.plain)
                .font(ConchTypography.font(size: 12.5))
                .foregroundStyle(ConchPalette.textPrimary)
                .accessibilityLabel("Search past sessions")
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(ConchPalette.textFaint)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
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

    /// Step through the visible rows, starting at the top from nothing.
    private func move(_ delta: Int) {
        guard !sessions.isEmpty else { return }
        guard let current = selection,
              let index = sessions.firstIndex(where: { $0.sessionId == current.sessionId })
        else {
            selection = sessions.first
            return
        }
        let next = index + delta
        guard sessions.indices.contains(next) else { return }
        selection = sessions[next]
    }

    private var searchPrompt: String {
        // The count is the reassurance: it says the history is there before you
        // have typed anything that proves it.
        sessions.isEmpty ? "Search past sessions" : "Search \(sessions.count) past sessions"
    }

    @ViewBuilder
    private var listBody: some View {
        if isLoading {
            centered("Reading your history…")
        } else if sessions.isEmpty {
            centered(query.isEmpty ? "No past sessions found" : "Nothing matches “\(query)”")
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(sessions) { session in
                        ResumeRow(
                            session: session,
                            isSelected: selection?.sessionId == session.sessionId
                        )
                        .contentShape(Rectangle())
                        .onTapGesture(count: 2) {
                            selection = session
                            onConfirm()
                        }
                        .onTapGesture { selection = session }
                    }
                }
            }
        }
    }

    private func centered(_ text: String) -> some View {
        VStack {
            Spacer()
            Text(text)
                .font(ConchTypography.font(size: 12))
                .foregroundStyle(ConchPalette.textFaint)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}

private struct ResumeRow: View {
    let session: ResumableSession
    let isSelected: Bool
    @State private var isHovering = false

    var body: some View {
        HStack(spacing: 9) {
            Image(session.backend.lowercased() == "codex" ? "AgentCodex" : "AgentClaude")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .foregroundStyle(ConchPalette.textFaint)
                .frame(width: 11, height: 11)

            VStack(alignment: .leading, spacing: 1) {
                Text(session.label)
                    .font(ConchTypography.font(size: 12.5))
                    .foregroundStyle(ConchPalette.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(session.shortCwd)
                    .font(ConchTypography.font(size: 10.5))
                    .foregroundStyle(ConchPalette.textFaint)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: 8)

            Text(session.age)
                .font(ConchTypography.font(size: 10.5))
                .foregroundStyle(ConchPalette.textFaint)
                .monospacedDigit()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(background)
        .onHover { isHovering = $0 }
    }

    private var background: Color {
        // The same ladder the session list uses, and for the same reason it was
        // measured there: selection has to outrank hover. `raised` is the
        // surface step that does it (1.56:1 against the ground, hover 1.22:1).
        //
        // NOT the accent — that is orange, and tinting a row with it put a warm
        // brown band across a sheet whose only other colours are the blue of
        // the segmented control and the Start button.
        if isSelected { return ConchPalette.raised }
        return isHovering ? ConchPalette.hover : .clear
    }
}
