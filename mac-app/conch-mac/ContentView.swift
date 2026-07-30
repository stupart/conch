import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: StateStore

    @State private var selectedReviewID: ReviewItem.ID?
    @State private var suppressedReviewIDs: Set<ReviewItem.ID> = []

    private var reviewItems: [ReviewItem] {
        let indexedItems = store.state?.rows.enumerated().compactMap { index, row in
            ReviewItem(row: row).map { (index: index, item: $0) }
        } ?? []

        return indexedItems.sorted { left, right in
            if left.item.reviewedAt != nil || right.item.reviewedAt != nil {
                return (left.item.reviewedAt ?? -.greatestFiniteMagnitude)
                    < (right.item.reviewedAt ?? -.greatestFiniteMagnitude)
            }
            return left.index < right.index
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

    var body: some View {
        ZStack {
            DashboardView(
                state: store.state,
                onOpenReview: openReview
            )

            if let activeReview {
                ReviewTakeover(
                    item: activeReview,
                    items: reviewItems,
                    onSelect: selectReview,
                    onClose: returnToDashboard
                )
                .transition(
                    .asymmetric(
                        insertion: .opacity.combined(with: .scale(scale: 0.995, anchor: .top)),
                        removal: .opacity.combined(with: .offset(y: -12))
                    )
                )
            }
        }
        .background(ConchPalette.background)
        .animation(.easeOut(duration: 0.18), value: activeReview != nil)
        .onChange(of: reviewIDs) { previousIDs, currentIDs in
            suppressedReviewIDs.formIntersection(currentIDs)

            let addedIDs = currentIDs.subtracting(previousIDs)
            if let newest = reviewItems.last(where: { addedIDs.contains($0.id) }) {
                suppressedReviewIDs.remove(newest.id)
                selectedReviewID = newest.id
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

    private func returnToDashboard() {
        suppressedReviewIDs.formUnion(reviewIDs)
        selectedReviewID = nil
    }
}
