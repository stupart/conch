import ConchDesign
import SwiftUI

// The daemon's rows, read through the workspace rules (ConchDesign/Workspace.swift).
//
// One translation, used by the window, the conversation pane and the overlay, so all three
// answer "which session" the same way instead of each keeping a fallback chain of its own —
// and so none of them can answer it with a label.

extension Workspace {
    // ponytail: rebuilt per read rather than cached. It is a map over at most a couple of
    // dozen rows; cache it on StateStore if a profile ever says so.
    init(_ state: PublishedState?) {
        let replyID = state?.reply?.sessionId
        self.init(
            sessions: (state?.rows ?? []).map { row in
                WorkspaceSession(
                    id: row.id,
                    parentID: row.parentSessionId,
                    // The state the daemon published ON THIS ROW, which is how it says which
                    // session the microphone and the speech are on.
                    isLive: LiveState.isExchangeActive(row.live ?? ""),
                    isActive: row.active,
                    isReplying: replyID?.isEmpty == false && row.id == replyID,
                    isNavSelected: row.navSelected
                )
            },
            voiceIsActive: state?.live.isExchangeActive ?? false
        )
    }
}

extension PublishedState {
    func row(_ id: String?) -> SessionRow? {
        guard let id else { return nil }
        return rows.first { $0.id == id }
    }
}

@MainActor
extension WorkspaceModel {
    /// The session in front of the reader.
    func viewedRow(in state: PublishedState?) -> SessionRow? {
        state?.row(viewed(in: Workspace(state)))
    }

    /// The session the voice is on, which is not necessarily the one being read.
    func addressedRow(in state: PublishedState?) -> SessionRow? {
        state?.row(addressed(in: Workspace(state)))
    }

    /// Where a message typed now would go; nil when there is nothing to type into.
    func targetRow(in state: PublishedState?) -> SessionRow? {
        state?.row(target(in: Workspace(state)))
    }

    /// What the mic is doing FOR THIS ROW.
    ///
    /// The composer is built per row and its mic both draws from this and acts on it, so a
    /// row the voice is not on must report nothing: otherwise every open composer mirrors
    /// the same words, which reads as though conch is about to send them everywhere.
    func voiceState(of row: SessionRow, in state: PublishedState?) -> String {
        guard let state, WorkspaceFocus.isAddressed(row.id, in: Workspace(state)) else { return "" }
        return state.live.state
    }

    func voiceLevel(of row: SessionRow, in state: PublishedState?) -> Double {
        guard let state, WorkspaceFocus.isAddressed(row.id, in: Workspace(state)) else { return 0 }
        return state.live.level
    }

    /// The words being transcribed, shown only in the composer they were spoken into.
    func dictation(of row: SessionRow?, in state: PublishedState?) -> String {
        guard let row, let state,
              WorkspaceFocus.isAddressed(row.id, in: Workspace(state)) else { return "" }
        return state.live.partial
    }

    /// Is the session in front of the reader the one the voice is on?
    func isAddressed(_ row: SessionRow?, in state: PublishedState?) -> Bool {
        guard let row, let state else { return false }
        return WorkspaceFocus.isAddressed(row.id, in: Workspace(state))
    }
}
