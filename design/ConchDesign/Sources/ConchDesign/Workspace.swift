import SwiftUI

// Which session the workspace is on — as state and rules, rather than as a view.
//
// The Mac workspace used to answer that question in three places: the window held a
// selection, the conversation pane applied further fallbacks of its own, and the overlay
// resolved a fourth chain. They drifted, and some of the matching was done by LABEL — a
// name the user can change, and two sessions can share.
//
// There are really four questions, and they are allowed to have different answers:
//
//   1. What am I LOOKING at?            `viewed`
//   2. Which session is the VOICE on?   `addressed`
//   3. Where does a message I send GO?  `target`
//   4. How is each session presented?   `SessionPresentation`
//
// They may legitimately differ — dictating to one session while reading another is the
// normal case — but they must differ deliberately, not by falling through unrelated
// chains. Everything here is by `id`; no rule in this file can see a label.

// MARK: - What the rules read

/// One session, reduced to the facts the focus rules actually read.
///
/// Deliberately not the daemon's row: the rules are the same on any surface, and this way
/// they can be tested without a window, a daemon, or a provider.
public struct WorkspaceSession: Equatable, Sendable, Identifiable {
    public let id: String
    /// The session a subagent runs inside (C4). A subagent is something you can look at;
    /// it is never what the voice addresses and never what a message is typed into.
    public let parentID: String?
    /// The daemon published an exchange-active state ON THIS ROW: this is the session the
    /// microphone and the speech are on, said by identity rather than inferred from a name.
    public let isLive: Bool
    /// The daemon's own "this one is current".
    public let isActive: Bool
    /// The last published reply belongs to this session.
    public let isReplying: Bool
    /// The terminal dashboard's cursor is on this row.
    public let isNavSelected: Bool

    public init(
        id: String,
        parentID: String? = nil,
        isLive: Bool = false,
        isActive: Bool = false,
        isReplying: Bool = false,
        isNavSelected: Bool = false
    ) {
        self.id = id
        self.parentID = parentID
        self.isLive = isLive
        self.isActive = isActive
        self.isReplying = isReplying
        self.isNavSelected = isNavSelected
    }

    public var isSubagent: Bool { parentID != nil }
}

/// The sessions as they stand right now, plus whether the voice is doing anything at all.
public struct Workspace: Equatable, Sendable {
    public let sessions: [WorkspaceSession]
    /// The voice loop is mid-exchange (speaking, listening, recording, transcribing).
    /// When it is not, nothing is being "addressed" and the reader's own choice decides.
    public let voiceIsActive: Bool

    public init(sessions: [WorkspaceSession] = [], voiceIsActive: Bool = false) {
        self.sessions = sessions
        self.voiceIsActive = voiceIsActive
    }

    public func session(_ id: String?) -> WorkspaceSession? {
        guard let id else { return nil }
        return sessions.first { $0.id == id }
    }
}

// MARK: - The rules

public enum WorkspaceFocus {
    /// The session the VOICE is on, or nil when the voice is doing nothing.
    ///
    /// By identity, in the order the daemon's own knowledge is trustworthy: the row that
    /// published a live state, then the one being replied to, then the active one. The
    /// label match this replaces could pick the wrong session outright — labels are
    /// renameable and duplicable — and picked one at all only because the published live
    /// state was missing, which is exactly when guessing is least safe.
    public static func addressed(in workspace: Workspace) -> String? {
        guard workspace.voiceIsActive else { return nil }
        let speakable = workspace.sessions.filter { !$0.isSubagent }
        return (speakable.first(where: \.isLive)
            ?? speakable.first(where: \.isReplying)
            ?? speakable.first(where: \.isActive))?.id
    }

    /// Where a message typed (or dictated) now would GO: the pin, else the voice's session,
    /// else the work. Nil when there is nothing to type into — including when the pin is a
    /// subagent, which has no composer of its own.
    public static func target(in workspace: Workspace, pinned: String?) -> String? {
        if let pinnedSession = workspace.session(pinned) {
            return pinnedSession.isSubagent ? nil : pinnedSession.id
        }
        if let addressed = addressed(in: workspace) { return addressed }
        let speakable = workspace.sessions.filter { !$0.isSubagent }
        return (speakable.first(where: \.isActive) ?? speakable.first(where: \.isReplying))?.id
    }

    /// What the reader is LOOKING at: their own pick if they made one — a subagent included —
    /// and otherwise the same session a message would go to, then the terminal's cursor, then
    /// whatever is first. The fallbacks exist so an opened window is never blank.
    public static func viewed(in workspace: Workspace, pinned: String?) -> String? {
        if let pinnedSession = workspace.session(pinned) { return pinnedSession.id }
        if let target = target(in: workspace, pinned: nil) { return target }
        let speakable = workspace.sessions.filter { !$0.isSubagent }
        return (speakable.first(where: \.isNavSelected) ?? speakable.first)?.id
    }

    /// What the live voice state means FOR ONE SESSION: its own state when the voice is on
    /// it, and nothing otherwise. Every composer is built per row, so a row that is not
    /// being spoken to must not mirror another's microphone.
    public static func isAddressed(_ id: String, in workspace: Workspace) -> Bool {
        addressed(in: workspace) == id
    }
}

// MARK: - How each session is presented

/// The stage's three pages: the exchange, both, or the work.
///
/// workspace-v1 §3 — side by side takes half the stage, deliverable takes all of it. It is an
/// enum rather than the Bool it replaces because "conversation or not" cannot say which of the
/// two ways of showing the work you asked for, and a third arm bolted onto a Bool is how a
/// pane ends up with two sources of truth about what it is drawing.
public enum StageMode: String, Equatable, Sendable, Codable {
    case conversation
    case sideBySide
    case deliverable
}

/// What the work half of the stage is SHOWING — a second axis, not a fourth page.
///
/// `StageMode` answers how the conversation and the work share the stage. What sits in the
/// work half is a different question, and folding it into the same enum would give the pane
/// two sources of truth about what it is drawing: `showsConversation` would have to guess, and
/// "side by side with the files" could not be expressed at all.
///
/// Kept apart, every stage works on either content for free — the files beside the
/// conversation, or filling the stage, with no new page and no new shortcut.
public enum WorkPane: String, Equatable, Sendable, Codable {
    /// What the session filed for you to look at.
    case deliverable
    /// The session's working folder, and what it changed in there.
    case files
    /// Commands run in that folder, and what they printed.
    case terminal
}

/// What the workspace remembers about ONE session, so leaving it and coming back returns
/// you to the page you were on rather than to a default.
public struct SessionPresentation: Equatable, Sendable {
    /// Which of the stage's three pages this session is on.
    ///
    /// Only an explicit choice moves it: a newly filed artifact must not take the stage from
    /// someone reading (the review's continuity point), which is why nothing here is derived
    /// from what the daemon just published.
    public var stage: StageMode

    /// Which of the two things the work half is showing.
    ///
    /// Deliberately NOT derived from whether a deliverable exists: a session with no
    /// deliverable still has a working folder, and one with both must stay where it was put.
    public var work: WorkPane = .deliverable

    /// Whether the conversation is on screen at all — true for `sideBySide`, because it is.
    ///
    /// Kept as a name so every existing reader goes on working while the stage grows a third
    /// page: the pane, the perspective control and the guards that pin them all ask this.
    public var showsConversation: Bool { stage != .deliverable }
    /// The tool rows opened in this session's transcript.
    public var expandedToolIDs: Set<String> = []
    /// Which of the deliverables this session holds the reader picked, by the identity the
    /// daemon minted when it filed it. Nil means the newest — which is what every surface
    /// meant back when a session could only hold one.
    public var selectedDeliverable: String?

    public init(
        stage: StageMode = .conversation,
        work: WorkPane = .deliverable,
        expandedToolIDs: Set<String> = [],
        selectedDeliverable: String? = nil
    ) {
        self.stage = stage
        self.work = work
        self.expandedToolIDs = expandedToolIDs
        self.selectedDeliverable = selectedDeliverable
    }

    /// Which deliverable a session is SHOWING, given the ones it holds and the reader's pick.
    ///
    /// `held` is oldest first, as the daemon keeps them. The pick wins while it is still held;
    /// otherwise the newest does. A pick that has fallen off the end — the per-session cap, or
    /// a session that moved on — is no pick at all, rather than an empty pane where a
    /// deliverable used to be.
    public static func shown(in held: [String], picked: String?) -> String? {
        if let picked, held.contains(picked) { return picked }
        return held.last
    }
}

/// The one owner of "which session", for every surface that has an opinion about it.
///
/// Drafts are NOT here: a session's draft already has exactly one owner that persists it
/// (`ComposerDraftStore`, keyed by session id), and a second copy is how they diverge.
@MainActor
public final class WorkspaceModel: ObservableObject {
    /// The session the reader PICKED, by id. Nil means "follow the work".
    @Published public var viewing: String?
    @Published private var presentations: [String: SessionPresentation] = [:]

    public init(viewing: String? = nil) {
        self.viewing = viewing
    }

    // MARK: Which session

    public func viewed(in workspace: Workspace) -> String? {
        WorkspaceFocus.viewed(in: workspace, pinned: viewing)
    }

    public func addressed(in workspace: Workspace) -> String? {
        WorkspaceFocus.addressed(in: workspace)
    }

    public func target(in workspace: Workspace) -> String? {
        WorkspaceFocus.target(in: workspace, pinned: viewing)
    }

    /// A pick that no longer exists is no pick: the fallbacks take over rather than the
    /// pane going blank on a session that ended.
    public func forget(missing ids: Set<String>) {
        if let viewing, !ids.contains(viewing) { self.viewing = nil }
    }

    // MARK: How it is presented

    public func presentation(for id: String?) -> SessionPresentation {
        guard let id else { return SessionPresentation() }
        return presentations[id] ?? SessionPresentation()
    }

    /// Both perspectives, one door. Called only from an explicit choice — the perspective
    /// control, or opening the artifact from its inline preview.
    public func show(stage: StageMode, for id: String?) {
        update(id) { $0.stage = stage }
    }

    /// Put the files, or a deliverable, in the work half. The other axis is untouched: asking
    /// for the files while reading side by side keeps you side by side.
    public func show(work: WorkPane, for id: String?) {
        update(id) { $0.work = work }
    }

    /// Pick one of the deliverables a session holds. Only an explicit choice moves this: a
    /// newly filed deliverable must not take the tab from someone reading one, the same rule
    /// the page already follows.
    public func select(deliverable: String?, for id: String?) {
        update(id) { $0.selectedDeliverable = deliverable }
    }

    public func toggleTool(_ toolID: String, for id: String?) {
        update(id) {
            if $0.expandedToolIDs.contains(toolID) {
                $0.expandedToolIDs.remove(toolID)
            } else {
                $0.expandedToolIDs.insert(toolID)
            }
        }
    }

    public func isToolExpanded(_ toolID: String, for id: String?) -> Bool {
        presentation(for: id).expandedToolIDs.contains(toolID)
    }

    private func update(_ id: String?, _ mutate: (inout SessionPresentation) -> Void) {
        guard let id else { return }
        var presentation = presentations[id] ?? SessionPresentation()
        mutate(&presentation)
        guard presentation != presentations[id] else { return }
        presentations[id] = presentation
    }
}
