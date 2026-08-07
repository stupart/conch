import AppKit
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: StateStore

    @State private var expandedReviewID: ReviewItem.ID?
    @State private var selectedSessionID: SessionRow.ID?
    @State private var renamingSessionID: SessionRow.ID?
    @State private var renameDraft = ""
    @State private var isShowingKeyboardShortcuts = false
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

    private var expandedReview: ReviewItem? {
        guard let expandedReviewID else { return nil }
        return reviewItems.first { $0.id == expandedReviewID }
    }

    private var reviewIDs: Set<ReviewItem.ID> {
        Set(reviewItems.map(\.id))
    }

    private var rowIDs: [SessionRow.ID] {
        store.state?.rows.map(\.id) ?? []
    }

    private var selectedRow: SessionRow? {
        guard let selectedSessionID else { return nil }
        return store.state?.rows.first { $0.id == selectedSessionID }
    }

    private var activeRow: SessionRow? {
        guard let state = store.state else { return nil }
        if let active = state.rows.first(where: \.active) {
            return active
        }
        if let replyID = state.reply?.sessionId,
           !replyID.isEmpty,
           let replied = state.rows.first(where: { $0.id == replyID }) {
            return replied
        }
        return state.rows.first { $0.label == state.live.label && !state.live.label.isEmpty }
    }

    private var actionTarget: SessionRow? {
        selectedRow ?? activeRow
    }

    var body: some View {
        ZStack {
            DashboardView(
                state: store.state,
                selectedSessionID: selectedSessionID,
                renamingSessionID: renamingSessionID,
                renameDraft: $renameDraft,
                actions: DashboardActions(
                    onSelectSession: selectSession,
                    onExpandReview: expandReview,
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
                    onTalkOrStop: talkOrStop,
                    onPauseOrResume: pauseOrResume,
                    onMuteOrUnmute: muteOrUnmute,
                    onRecite: recite,
                    onMoveUp: { moveSelection(by: -1) },
                    onMoveDown: { moveSelection(by: 1) },
                    onReleaseSelection: releaseSelection
                )
            )
            // Review arrival never changes dashboard interactivity. Only an
            // explicit full-window expansion isolates focus from covered controls.
            .allowsHitTesting(expandedReview == nil)
            .accessibilityHidden(expandedReview != nil)

            if let expandedReview {
                ExpandedReviewView(
                    item: expandedReview,
                    onCollapse: { expandedReviewID = nil }
                )
                .zIndex(1)
            }
        }
        .background(ConchPalette.bg)
        .background(
            DashboardInputMonitor(
                isEnabled: expandedReview == nil && !isShowingKeyboardShortcuts,
                onKey: handleDashboardKey
            )
        )
        .sheet(isPresented: $isShowingKeyboardShortcuts) {
            KeyboardShortcutsSheet()
        }
        .onReceive(
            NotificationCenter.default.publisher(for: .showKeyboardShortcuts)
        ) { _ in
            showKeyboardShortcuts()
        }
        .onChange(of: rowIDs) { _, currentIDs in
            if let selectedSessionID, !currentIDs.contains(selectedSessionID) {
                self.selectedSessionID = nil
            }
            if let renamingSessionID, !currentIDs.contains(renamingSessionID) {
                cancelRename()
            }
        }
        .onChange(of: reviewIDs) { previousIDs, currentIDs in
            let addedIDs = currentIDs.subtracting(previousIDs)
            let addedReviews = reviewItems.filter { addedIDs.contains($0.id) }
            for review in addedReviews {
                ReviewNotifications.shared.postOnce(for: review)
            }

            if let expandedReviewID, !currentIDs.contains(expandedReviewID) {
                self.expandedReviewID = nil
            }
        }
    }

    private func expandReview(_ row: SessionRow) {
        guard let item = ReviewItem(row: row) else { return }
        selectedSessionID = row.id
        expandedReviewID = item.id
    }

    private func selectSession(_ row: SessionRow) {
        selectedSessionID = row.id
    }

    private func beginRename(_ row: SessionRow) {
        selectedSessionID = row.id
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

    private func talkOrStop() {
        if store.state?.live.isExchangeActive == true {
            store.send(.stop())
            return
        }

        store.send(
            .wake(
                sessionId: actionTarget?.id ?? "",
                label: actionTarget?.label ?? ""
            )
        )
    }

    private func pauseOrResume() {
        if let selectedRow {
            store.send(
                .scoped(
                    selectedRow.paused ? .resume : .pause,
                    sessionId: selectedRow.id,
                    label: selectedRow.label
                )
            )
            return
        }

        let paused = store.state?.mode.paused ?? false
        store.send(.global(paused ? .resume : .pause))
    }

    private func muteOrUnmute() {
        if let selectedRow {
            store.send(
                .scoped(
                    selectedRow.muted ? .unmute : .mute,
                    sessionId: selectedRow.id,
                    label: selectedRow.label
                )
            )
            return
        }

        let muted = store.state?.mode.muted ?? false
        store.send(.global(muted ? .unmute : .mute))
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

        let anchorID = selectedSessionID ?? activeRow?.id
        let anchorIndex = anchorID.flatMap { id in
            rows.firstIndex { $0.id == id }
        }
        let currentIndex = anchorIndex ?? (delta > 0 ? -1 : rows.count)
        let nextIndex = currentIndex + delta
        guard rows.indices.contains(nextIndex) else {
            selectedSessionID = nil
            return
        }
        selectedSessionID = rows[nextIndex].id
    }

    private func releaseSelection() {
        if renamingSessionID != nil {
            cancelRename()
            return
        }
        selectedSessionID = nil
    }

    private func showKeyboardShortcuts() {
        isShowingKeyboardShortcuts = true
    }

    private func handleDashboardKey(_ key: DashboardKey) -> Bool {
        switch key {
        case .talkOrStop:
            talkOrStop()
        case .pauseOrResume:
            pauseOrResume()
        case .muteOrUnmute:
            muteOrUnmute()
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

extension Notification.Name {
    static let showKeyboardShortcuts = Notification.Name(
        "com.conch.mac.show-keyboard-shortcuts"
    )
}

private struct KeyboardShortcutsSheet: View {
    @Environment(\.dismiss) private var dismiss

    private let keyRows = [
        ShortcutHelpRow(command: "Space", result: "Talk / stop"),
        ShortcutHelpRow(command: "P", result: "Pause"),
        ShortcutHelpRow(command: "M", result: "Mute"),
        ShortcutHelpRow(command: "R", result: "Recite"),
        ShortcutHelpRow(command: "↑ / ↓", result: "Select"),
        ShortcutHelpRow(command: "Esc", result: "Release selection / close"),
        ShortcutHelpRow(command: "Right-click a row", result: "Rename, dismiss"),
        ShortcutHelpRow(command: "⌘,", result: "Settings"),
        ShortcutHelpRow(command: "?", result: "This list"),
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

            ShortcutHelpSection(title: "Spoken commands", rows: spokenRows)

            // The entire ledger language is coloured glyphs, and this was the
            // only help surface — documenting keys and speech but never saying
            // what a gold star or a cyan mic actually means.
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

    private let entries: [Entry] = [
        Entry(symbol: "circle.fill", color: ConchPalette.statusWorking, meaning: "Working — nothing needed"),
        Entry(symbol: "mic.fill", color: ConchPalette.statusMicOpen, meaning: "Mic open — it is hearing you"),
        Entry(symbol: "circle.inset.filled", color: ConchPalette.statusWaiting, meaning: "Finished — waiting on you"),
        Entry(symbol: "exclamationmark.circle.fill", color: ConchPalette.statusNeeds, meaning: "Blocked — needs an answer"),
        Entry(symbol: "star.fill", color: ConchPalette.statusReview, meaning: "Has work for you to look at"),
        Entry(symbol: "speaker.slash.fill", color: ConchPalette.textDim, meaning: "Muted — announcements dropped"),
        Entry(symbol: "pause.fill", color: ConchPalette.textDim, meaning: "Paused — turns held for later"),
        Entry(symbol: "record.circle.fill", color: ConchPalette.statusMicOpen, meaning: "Recording your reply"),
        Entry(symbol: "play.fill", color: ConchPalette.statusWorking, meaning: "Reading a reply aloud"),
        Entry(symbol: "ellipsis", color: ConchPalette.statusWorking, meaning: "Transcribing what you said"),
        Entry(symbol: "diamond.fill", color: ConchPalette.textDim, meaning: "Prioritised — jumps the queue"),
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

    var id: String { command }
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
