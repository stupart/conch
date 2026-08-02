import AppKit
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: StateStore

    @State private var expandedReviewID: ReviewItem.ID?
    @State private var selectedSessionID: SessionRow.ID?
    @State private var renamingSessionID: SessionRow.ID?
    @State private var renameDraft = ""

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
                isEnabled: expandedReview == nil,
                onKey: handleDashboardKey
            )
        )
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
