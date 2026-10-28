import ConchDesign
import SwiftUI

/// Settings › Failures' rows, every state, and one opened to its evidence, light and dark: the Mac's own shots
/// (scripts/failure-tickets-e2e.ts --shots) can show the page but can't click a row open. Names are made up.
func renderFailureTickets() throws {
    let now = Date()
    let ms = now.timeIntervalSince1970 * 1_000
    let minute = 60_000.0
    func ticket(_ id: String, _ number: Int, _ origin: String, _ operation: String, _ title: String, _ status: FailureTicketStatus,
                ago: Double, count: Int, sessions: Int, unseen: Bool = false, note: String? = nil, fix: FailureTicketFix? = nil) -> FailureTicketSummary {
        FailureTicketSummary(id: id, number: number, origin: origin, operation: operation, title: title, status: status, statusAt: ms,
                             note: note, firstSeen: ms - 3 * 86_400_000, lastSeen: ms - ago * minute, count: count, sessionCount: sessions,
                             unseen: unseen, fix: fix)
    }
    let pr = FailureTicketPR(url: "https://github.com/example/conch/pull/580", number: 580, state: "open")
    let rows: [(FailureTicketSummary, Bool, FailureTicketDetail??)] = [
        (ticket("a", 19, "daemon", "inject", "Account profiles must have separate directories", .open, ago: 3, count: 4, sessions: 2, unseen: true), true, nil),
        (ticket("b", 12, "mac", "open-deliverable", "Couldn't find <file>", .open, ago: 120, count: 30, sessions: 9), false, nil),
        (ticket("c", 8, "daemon", "inject", "Typed, but the session never took it.", .open, ago: 9 * 60, count: 9, sessions: 8,
                note: "Came back after #561 was merged."), true, nil),
        (ticket("d", 6, "mcp", "conch_capture failed", "the target is on the page but conch couldn't bring it into view.", .fixing, ago: 40, count: 1, sessions: 1,
                fix: .init(by: "you", startedAt: ms - 6 * minute, backgroundId: "conch-1", branch: "fix/ticket-6", pr: pr)), false,
         .some(FailureTicketDetail(id: "d", example: .init(at: ms - 40 * minute, message: "failed: the target is on the page but conch couldn't bring it into view. What conch got: \"Example\" at <url>.",
                                                            sessionId: "s-1", label: "Landing page review",
                                                            state: #"{"args":["target","url","viewport"],"backend":"claude","ms":4167}"#),
                                   sessions: [.init(id: "s-1", label: "Landing page review")]))),
        (ticket("e", 4, "daemon", "permission-answer", "Could not answer the permission: that permission is no longer waiting", .fixing, ago: 30, count: 3, sessions: 3,
                fix: .init(by: "auto", startedAt: ms - 2 * minute, backgroundId: "conch-2", branch: "fix/ticket-4")), false, nil),
        (ticket("f", 3, "mac", "session-close", "Ctrl-D was sent, but the session is still running after <n> s.", .fixed, ago: 6 * 1_440, count: 4, sessions: 1,
                fix: .init(by: "you", startedAt: ms - 86_400_000, branch: "fix/ticket-3", pr: .init(url: "https://github.com/example/conch/pull/570", number: 570, state: "merged"))), false, nil),
    ]
    try render("failure-tickets-rows", width: 760) {
        Heading(title: "Failure tickets", note: "Settings › Failures: new (the dot), noted, being fixed with and without a PR, opened, fixed")
        OnboardingCard {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                if index > 0 { Rectangle().fill(ConchColor.hairline).frame(height: 1) }
                FailureTicketRow(ticket: row.0, now: now, isNew: row.1, canFix: true, detail: row.2, openTerminal: { _ in })
            }
        }
    }
}
