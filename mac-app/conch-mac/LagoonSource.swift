import Foundation
// test/lagoon-page.test.ts compiles this file with Models.swift, ExecutionModels.swift and ConchDesign's sources as one
// module, and checks what it makes of a fixture against the brand repo's sanitize.mjs.
#if canImport(ConchDesign)
import ConchDesign
#endif

/// The lagoon's reading of the app's own state (spec §4): `PublishedState` copied field for field into
/// `LagoonSnapshot.Source`, which does the stripping. Nothing is decided here; a field the lagoon may not see is never
/// copied, and one it may is copied as the daemon published it.
extension LagoonSnapshot.Source {
    init(_ state: PublishedState) {
        self.init(
            ts: state.ts,
            paused: state.mode.paused,
            holding: state.mode.holding,
            liveState: state.live.state,
            rows: state.rows.map(Row.init),
            // `conversations` only, as sanitize.mjs reads it: the single `conversation` of an older daemon isn't sent.
            conversations: (state.conversations ?? [:]).mapValues { $0.items.map(Item.init) },
            dismissed: state.dismissed + state.dismissedRows.map(\.id)
        )
    }
}

extension LagoonSnapshot.Source.Row {
    init(_ row: SessionRow) {
        let status: String? = switch row.status {
        case .working: "working"
        case .waiting: "waiting"
        case .needs: "needs"
        case .review: "review"
        case .unknown, nil: nil
        }
        self.init(
            id: row.id,
            label: row.label,
            status: status,
            needsResponse: row.needsResponse,
            detail: row.detail,
            snippet: row.snippet,
            cwd: row.cwd,
            workDirs: row.workDirs,
            backend: row.backend,
            providerId: row.execution?.providerId,
            parentSessionId: row.parentSessionId,
            startedBySessionId: row.startedBySessionId,
            usedTokens: row.context?.usedTokens,
            limitTokens: row.context?.limitTokens,
            modelLabel: row.settings?.modelLabel,
            effort: row.settings?.effort,
            paused: row.paused,
            pauseExempt: row.pauseExempt,
            live: row.live,
            active: row.active,
            waitingOnAgents: row.waitingOnAgents,
            usageLimit: row.usageLimit,
            at: row.at,
            activity: row.activity.map { .init(text: $0.text, kind: $0.kind, at: $0.at) },
            approval: row.approval.map { .init(id: $0.id, name: $0.name, summary: $0.summary, answerable: $0.answerable) },
            reviews: LagoonSnapshot.held(reviews: row.reviews, review: row.review).map(LagoonSnapshot.Source.Review.init)
        )
    }
}

extension LagoonSnapshot.Source.Review {
    init(_ review: ReviewInfo) {
        self.init(
            id: review.id,
            artifact: review.artifact,
            summary: review.summary,
            kind: review.kind,
            at: review.at,
            viewedAt: review.viewedAt,
            version: review.version,
            hasScene: review.hasScene,
            targetKind: review.sceneKind,
            inspect: review.inspect,
            link: review.link
        )
    }
}

extension LagoonSnapshot.Source.Item {
    init(_ item: ConversationItem) {
        self.init(id: item.id, kind: item.kind.rawValue, text: item.text, at: item.at)
    }
}

extension LagoonSnapshot.Source {
    /// The sessions a message from the page may name, and the reviews each holds, by the lagoon's review key.
    var sessions: LagoonIntent.Sessions {
        Dictionary(rows.map { row in
            (row.id, Set(row.reviews.enumerated().map { LagoonSnapshot.reviewKey(id: $1.id, artifact: $1.artifact, index: $0) }))
        }, uniquingKeysWith: { first, _ in first })
    }
}
