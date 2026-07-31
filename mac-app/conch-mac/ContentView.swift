import AppKit
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: StateStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var selectedReviewID: ReviewItem.ID?
    @State private var suppressedReviewIDs: Set<ReviewItem.ID> = []
    @State private var selectedSessionID: SessionRow.ID?

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

    private var visibleReviewItems: [ReviewItem] {
        reviewItems.filter { !suppressedReviewIDs.contains($0.id) }
    }

    private var activeReview: ReviewItem? {
        if let selectedReviewID,
           let selected = visibleReviewItems.first(where: { $0.id == selectedReviewID }) {
            return selected
        }
        return visibleReviewItems.last
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

    private var reviewTransition: AnyTransition {
        if reduceMotion {
            return .asymmetric(
                insertion: .opacity.animation(.easeOut(duration: 0.18)),
                removal: .opacity.animation(.easeOut(duration: 0.15))
            )
        }

        return .asymmetric(
            insertion: .opacity
                .combined(with: .scale(scale: 0.98))
                .animation(.easeOut(duration: 0.28)),
            removal: .opacity
                .animation(.easeOut(duration: 0.20))
        )
    }

    var body: some View {
        ZStack {
            DashboardView(
                state: store.state,
                selectedSessionID: selectedSessionID,
                daemonMessage: store.daemonMessage,
                actions: DashboardActions(
                    onSelectSession: selectSession,
                    onOpenReview: openReview,
                    onTalkOrStop: talkOrStop,
                    onPauseOrResume: pauseOrResume,
                    onMuteOrUnmute: muteOrUnmute,
                    onRecite: recite,
                    onMoveUp: { moveSelection(by: -1) },
                    onMoveDown: { moveSelection(by: 1) },
                    onReleaseSelection: releaseSelection,
                    onWakeNumber: wakeSession,
                    onQuit: quit
                )
            )
            .opacity(activeReview == nil ? 1 : 0.72)
            .allowsHitTesting(activeReview == nil)
            .accessibilityHidden(activeReview != nil)
            .animation(
                .easeOut(
                    duration: reduceMotion
                        ? 0.16
                        : activeReview == nil ? 0.20 : 0.28
                ),
                value: activeReview != nil
            )

            if let activeReview {
                ReviewTakeover(
                    item: activeReview,
                    items: visibleReviewItems,
                    onSelect: selectReview,
                    onClose: { dismissReview(activeReview) }
                )
                .transition(reviewTransition)
                .zIndex(1)
            }
        }
        .background(ConchPalette.bg)
        .background(
            DashboardInputMonitor(
                isEnabled: activeReview == nil,
                onKey: handleDashboardKey
            )
        )
        .onChange(of: rowIDs) { _, currentIDs in
            if let selectedSessionID, !currentIDs.contains(selectedSessionID) {
                self.selectedSessionID = nil
            }
        }
        .onChange(of: reviewIDs) { previousIDs, currentIDs in
            suppressedReviewIDs.formIntersection(currentIDs)

            let addedIDs = currentIDs.subtracting(previousIDs)
            let addedReviews = reviewItems.filter { addedIDs.contains($0.id) }
            for review in addedReviews {
                ReviewNotifications.shared.postOnce(for: review)
            }

            if let newest = addedReviews.last {
                suppressedReviewIDs.remove(newest.id)
                selectedReviewID = newest.id
                bringReviewToFront()
                return
            }

            if let selectedReviewID, !currentIDs.contains(selectedReviewID) {
                self.selectedReviewID = nil
            }
        }
    }

    private func openReview(_ row: SessionRow) {
        guard let item = ReviewItem(row: row) else { return }
        suppressedReviewIDs.remove(item.id)
        selectedReviewID = item.id
    }

    private func selectSession(_ row: SessionRow) {
        selectedSessionID = row.id
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

    private func wakeSession(at visiblePosition: Int) {
        guard visiblePosition >= 1,
              let rows = store.state?.rows,
              visiblePosition <= rows.count else {
            return
        }
        let row = rows[visiblePosition - 1]
        store.send(.wake(sessionId: row.id, label: row.label))
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
        selectedSessionID = nil
    }

    private func quit() {
        NSApp.terminate(nil)
    }

    private func handleDashboardKey(_ key: DashboardKey) -> Bool {
        if activeReview != nil {
            return false
        }

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
        case let .wakeNumber(number):
            wakeSession(at: number)
        case .quit:
            quit()
        }
        return true
    }

    private func selectReview(_ item: ReviewItem) {
        suppressedReviewIDs.remove(item.id)
        selectedReviewID = item.id
    }

    private func dismissReview(_ item: ReviewItem) {
        suppressedReviewIDs.insert(item.id)
        selectedReviewID = nil
    }

    private func bringReviewToFront() {
        let window = NSApp.keyWindow
            ?? NSApp.mainWindow
            ?? NSApp.windows.first(where: { $0.isVisible && $0.canBecomeKey })
            ?? NSApp.windows.first(where: \.canBecomeKey)

        NSApp.activate(ignoringOtherApps: true)
        if window?.isMiniaturized == true {
            window?.deminiaturize(nil)
        }
        window?.orderFrontRegardless()
        window?.makeKey()
    }
}
