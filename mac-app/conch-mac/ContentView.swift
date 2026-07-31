import AppKit
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: StateStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var selectedReviewID: ReviewItem.ID?
    @State private var suppressedReviewIDs: Set<ReviewItem.ID> = []

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
                onOpenReview: openReview
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
