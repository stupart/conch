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
public struct SessionPresentation: Codable, Equatable, Sendable {
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

// MARK: - Which deliverables are one artifact

/// One filing of a deliverable, reduced to the facts grouping reads.
public struct DeliverableVersion: Equatable, Sendable {
    public let id: String
    public let link: String?
    /// The artifact the daemon filed it as a version of (`features.deliverables` 2). Absent from
    /// an older daemon, which is why the link still decides there.
    public let artifact: String?

    public init(id: String, link: String?, artifact: String? = nil) {
        self.id = id
        self.link = link
        self.artifact = artifact
    }
}

/// One ARTIFACT, and every filing of it the session still holds.
///
/// Measured on 2026-09-20, from the live published state: one session held six deliverables
/// and every one of them was the same link. Six tabs, one artifact — each `review_to_front`
/// about the same page had become a competing tab, when to the reader it is the same page,
/// newer. Two other sessions held six that were four things each; a fourth held two that were
/// two. Grouping has to collapse the first and leave the last exactly as it is.
public struct DeliverableGroup: Equatable, Sendable, Identifiable {
    /// The artifact the versions share: the daemon's `artifact`, else the link they share, else
    /// the lone version's own id when it has neither.
    public let id: String
    /// Every filing of this artifact, NEWEST FIRST: `versions[0]` is what the tab stands for
    /// until the reader picks an older one.
    public let versions: [String]

    public init(id: String, versions: [String]) {
        self.id = id
        self.versions = versions
    }

    public var newest: String { versions[0] }
    public var hasOlderVersions: Bool { versions.count > 1 }

    /// The version this group's tab stands for: the reader's pick while it is one of these,
    /// else the newest. A pick that fell off the per-session cap, or belongs to another group,
    /// is no pick here — the same rule `SessionPresentation.shown` applies to the pane.
    public func shown(picked: String?) -> String {
        if let picked, versions.contains(picked) { return picked }
        return newest
    }
}

public enum DeliverableGroups {
    /// The held deliverables as artifacts, from `held` OLDEST FIRST as the daemon keeps them.
    ///
    /// The key is the link, and only the link. The identity the daemon mints folds in the filing
    /// time on purpose (#268 fixed two filings in one millisecond colliding), so it can never say
    /// that two filings are one artifact. The summary changes from version to version — that is
    /// what a summary is for — so similarity would either split versions or merge strangers. The
    /// link is what the reader lands on when they click; the same link is the same thing to them.
    /// A filing with no link has nothing to say it is the same as another, so it stands alone.
    ///
    /// Groups come back oldest first BY THEIR NEWEST VERSION, so a republished artifact moves to
    /// the new end. Ordered by first filing instead, the strip's ages would run out of order — a
    /// tab reading "2m" beside one reading "3h" on its right — which is exactly the "which is
    /// older" question the strip exists to answer at a glance.
    ///
    /// The daemon's `artifact` decides first, when it sends one: it knows what the agent meant —
    /// an agent's own `key`, a file's real path, a URL without its fragment — so a path the
    /// agent rewrites each run (`hero-v3.png`, `hero-v4.png`) under one key is one artifact, and a
    /// Simulator with no link at all can have versions. The link is the fallback for an older
    /// daemon, byte for byte after trimming, and it is also what the daemon's own fallback for a
    /// record from before artifacts is (`artifactOf`), so the two agree on what to remove.
    public static func grouped(_ held: [DeliverableVersion]) -> [DeliverableGroup] {
        var versions: [String: [String]] = [:]
        var order: [String] = []
        for version in held {
            let link = version.link?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let key = version.artifact ?? (link.isEmpty ? version.id : link)
            versions[key, default: []].insert(version.id, at: 0)
            order.removeAll { $0 == key }
            order.append(key)
        }
        return order.map { DeliverableGroup(id: $0, versions: versions[$0]!) }
    }
}

/// What the workspace writes down between launches: the session in view and how each one is
/// presented. The model encodes it; the app keeps it (UserDefaults on the Mac) and hands it back.
///
/// Tyler: the deliverables tabs "get lost when the app re-installs or restarts". The daemon's
/// ledger had kept every deliverable; what was lost was THIS — the page, the pane, the tab —
/// which nothing wrote down.
public struct WorkspaceMemory: Codable, Equatable, Sendable {
    public var viewing: String?
    public var presentations: [String: SessionPresentation]

    public init(viewing: String? = nil, presentations: [String: SessionPresentation] = [:]) {
        self.viewing = viewing
        self.presentations = presentations
    }

    /// Nothing, for no data or data this build can't read: a fresh start, never a crash.
    public static func decode(_ data: Data?) -> WorkspaceMemory? {
        guard let data else { return nil }
        return try? JSONDecoder().decode(WorkspaceMemory.self, from: data)
    }

    public func encoded() -> Data? {
        try? JSONEncoder().encode(self)
    }
}

/// The one owner of "which session", for every surface that has an opinion about it.
///
/// Drafts are NOT here: a session's draft already has exactly one owner that persists it
/// (`ComposerDraftStore`, keyed by session id), and a second copy is how they diverge.
@MainActor
public final class WorkspaceModel: ObservableObject {
    /// The session the reader PICKED, by id. Nil means "follow the work".
    @Published public var viewing: String? {
        didSet {
            carryPresentation(from: oldValue)
            remember?(memory)
        }
    }
    // ponytail: never pruned — a few enum values per session ever presented; cap it if a
    // profile ever notices. Pruning on `forget(missing:)` would wipe it on a daemon restart,
    // when the rows are briefly nobody.
    @Published private var presentations: [String: SessionPresentation] = [:]
    /// Told after every change. Nil forgets on relaunch, as before.
    private let remember: ((WorkspaceMemory) -> Void)?

    public init(viewing: String? = nil) {
        self.viewing = viewing
        self.remember = nil
    }

    /// Pick up where the last launch left off.
    public init(remembering memory: WorkspaceMemory?, remember: @escaping (WorkspaceMemory) -> Void) {
        self.viewing = memory?.viewing
        self.presentations = memory?.presentations ?? [:]
        self.remember = remember
    }

    public var memory: WorkspaceMemory {
        WorkspaceMemory(viewing: viewing, presentations: presentations)
    }

    // MARK: Which session

    /// The page follows you between conversations.
    ///
    /// Each session still STORES its own page — nothing here changes that — but arriving at a
    /// session seeds it from the one you just left. Tyler: "we should also preserve the view
    /// your on when you go between conversations". Without it, reading side by side and
    /// clicking the next session dropped you back to whatever that session was last left on,
    /// which is a page you did not ask for in the middle of a comparison.
    ///
    /// Done on `viewing` rather than at the call sites because there are five of them — a
    /// click, a rename, two cycles and a clear — and a rule that has to be remembered at five
    /// call sites is a rule that will be forgotten at one.
    ///
    /// The work half carries too, and is safe to: `workPane(for:)` already refuses a pane the
    /// session cannot fill, so arriving on Files at a session with no folder falls back rather
    /// than showing an empty tree.
    private func carryPresentation(from previous: String?) {
        guard let previous, let arriving = viewing, previous != arriving else { return }
        let leaving = presentation(for: previous)
        update(arriving) {
            $0.stage = leaving.stage
            $0.work = leaving.work
        }
    }

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
        remember?(memory)
    }
}
