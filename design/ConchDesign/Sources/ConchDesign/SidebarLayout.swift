import SwiftUI

// Tyler's own groups in the session list, and the order he drags things into (2026-11-12).
//
// Tyler: "would also love to drag and drop for organization." The list grouped sessions by the folder each runs in, and
// only the folders' order was his: rows were never dragged, since a row's place was its folder's (SessionGrouping). Now
// he can make groups of his own (by project, say), put a session in one by dragging it there or with Move to in its
// menu, and order the sessions within any section. A session he hasn't placed is under its folder, as before.
//
// The layout is the daemon's (src/sidebar-groups.ts): the Mac works each change out here and sends the whole of it, and
// the phone draws what is published. What is worth getting right is what a picture of a tidy list never shows: a
// group's sessions all closing (the group stays, a place to drop into), a session that comes back tomorrow (it keeps
// its place, by its id), a subagent or a started session (it goes wherever the session above it goes), and a drop on a
// folder that isn't the session's own (refused: it would say the session runs somewhere it doesn't).

/// The sidebar's arrangement, as `PublishedState.sidebarGroups` carries it and the daemon saves it.
public struct SidebarLayout: Codable, Equatable, Sendable {
    public struct Group: Codable, Equatable, Sendable, Identifiable {
        /// `group:` and an id of its own, never a path: a section's id is a group's or a folder's, and the two can't meet.
        public let id: String
        public var name: String

        public init(id: String, name: String) {
            self.id = id
            self.name = name
        }
    }

    public var v: Int
    public var groups: [Group]
    /// Which group each session was put in, by session id.
    public var placements: [String: String]
    /// Each section's sessions in the order they were dragged into, by section id.
    public var rows: [String: [String]]
    /// The sections' order, group ids and folder paths. Those never placed follow, as they arrive.
    public var sections: [String]

    public init(groups: [Group] = [], placements: [String: String] = [:], rows: [String: [String]] = [:], sections: [String] = []) {
        v = 1
        self.groups = groups
        self.placements = placements
        self.rows = rows
        self.sections = sections
    }

    public static let empty = SidebarLayout()

    /// The daemon's own caps (src/sidebar-groups.ts `SIDEBAR_LIMITS`): a name's length and how many placements are kept.
    public static let maxNameLength = 60
    public static let maxPlacements = 2_000
    public static let maxGroups = 64

    public static func isGroup(_ sectionID: String) -> Bool {
        sectionID.hasPrefix("group:")
    }

    public static func newGroupID() -> String {
        "group:\(UUID().uuidString.lowercased())"
    }

    public func group(_ id: String) -> Group? {
        groups.first { $0.id == id }
    }

    /// What is wrong with a name for a group, or nil: something to call it, short enough, and no other group's
    /// (`renaming` passes its own id, so a group can keep its name).
    public func nameProblem(_ name: String, renaming id: String? = nil) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "Give the group a name." }
        if trimmed.count > Self.maxNameLength { return "A group's name is at most \(Self.maxNameLength) characters." }
        if trimmed.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) { return "A group's name is one line of text." }
        if groups.contains(where: { $0.id != id && $0.name.lowercased() == trimmed.lowercased() }) {
            return "There's already a group called \(trimmed)."
        }
        if id == nil, groups.count >= Self.maxGroups { return "That's as many groups as conch keeps." }
        return nil
    }

    // MARK: changes

    /// A new group, at the top of the list, or just above the section `session` is in when it is made from a row's
    /// menu, with that session in it. `shown` is the list as it is drawn now, whose order the change keeps.
    public func creatingGroup(
        named name: String,
        id: String = SidebarLayout.newGroupID(),
        placing session: String? = nil,
        shown: [SessionFolder],
        fallbackOrder: [String] = []
    ) -> SidebarLayout {
        guard nameProblem(name) == nil else { return self }
        var next = self
        next.groups.append(Group(id: id, name: name.trimmingCharacters(in: .whitespacesAndNewlines)))
        var order = frozen(shown: shown, fallback: fallbackOrder)
        let from = session.flatMap { session in shown.first { $0.sessionIDs.contains(session) }?.id }
        order.insert(id, at: from.flatMap { order.firstIndex(of: $0) } ?? 0)
        next.sections = order
        guard let session else { return next }
        return next.moving(session, into: id, before: nil, shown: shown, fallbackOrder: fallbackOrder)
    }

    public func renamingGroup(_ id: String, to name: String) -> SidebarLayout {
        guard let index = groups.firstIndex(where: { $0.id == id }), nameProblem(name, renaming: id) == nil else { return self }
        var next = self
        next.groups[index].name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return next
    }

    /// The group gone, and its sessions back under their folders. Nothing else changes: a session was only ever placed.
    public func deletingGroup(_ id: String) -> SidebarLayout {
        var next = self
        next.groups.removeAll { $0.id == id }
        next.placements = placements.filter { $0.value != id }
        next.rows[id] = nil
        next.sections.removeAll { $0 == id }
        return next
    }

    /// Whether `session` may be dropped into `section`: any group, or the folder it runs in (out of a group, or to a new
    /// place in its folder). Another folder would say it runs somewhere it doesn't.
    public func accepts(_ session: String, into section: String, folder: String?) -> Bool {
        Self.isGroup(section) ? group(section) != nil : section == folder
    }

    /// `session` into `section`, just before the session `before` (at the end when nil or not there). `shown` is the
    /// list as drawn, whose order within the section, and of the sections, the change keeps: what Tyler sees is what he
    /// moved one thing within. Only a session at the top of its family moves; its agents and the sessions it started go
    /// with it (`SessionGrouping.sidebar`).
    public func moving(
        _ session: String,
        into section: String,
        before: String?,
        shown: [SessionFolder],
        topLevel: Set<String>? = nil,
        fallbackOrder: [String] = []
    ) -> SidebarLayout {
        var next = self
        if Self.isGroup(section) {
            guard group(section) != nil else { return self }
            next.placements[session] = section
        } else {
            next.placements[session] = nil
        }
        let family = topLevel ?? Set(shown.flatMap(\.sessionIDs))
        var order = (shown.first { $0.id == section }?.sessionIDs ?? []).filter { family.contains($0) && $0 != session }
        if let before, let index = order.firstIndex(of: before) {
            order.insert(session, at: index)
        } else {
            order.append(session)
        }
        next.rows[section] = order
        for (key, sessions) in next.rows where key != section && sessions.contains(session) {
            next.rows[key] = sessions.filter { $0 != session }
        }
        next.sections = frozen(shown: shown, fallback: fallbackOrder)
        if !next.sections.contains(section) { next.sections.append(section) }
        return next.capped(keeping: Set(shown.flatMap(\.sessionIDs)))
    }

    /// One place up or down within its section: Move Up and Move Down, for the keyboard and VoiceOver.
    public func nudging(_ session: String, by offset: Int, shown: [SessionFolder], topLevel: Set<String>? = nil, fallbackOrder: [String] = []) -> SidebarLayout {
        guard let section = shown.first(where: { $0.sessionIDs.contains(session) }) else { return self }
        let family = topLevel ?? Set(section.sessionIDs)
        let order = section.sessionIDs.filter { family.contains($0) }
        guard let index = order.firstIndex(of: session) else { return self }
        let target = index + offset
        guard target >= 0, target < order.count else { return self }
        // Before the one now `offset` away, or before the one after it when moving down.
        let before = offset < 0 ? order[target] : order.indices.contains(target + 1) ? order[target + 1] : nil
        return moving(session, into: section.id, before: before, shown: shown, topLevel: family, fallbackOrder: fallbackOrder)
    }

    /// A section's header dropped on another's: it takes that slot (`SessionGrouping.order`).
    public func movingSection(_ id: String, onto target: String, shown: [SessionFolder], fallbackOrder: [String] = []) -> SidebarLayout {
        var next = self
        next.sections = SessionGrouping.order(sections.isEmpty ? fallbackOrder : sections, moving: id, onto: target, visible: shown.map(\.id))
        return next
    }

    /// The order the sections are drawn in now, every one on screen in it: so the next change applies to what Tyler is
    /// looking at, not to the subset he happened to move before. The Mac's own folder order (`SessionGrouping.orderKey`)
    /// stands in until the layout has one.
    func frozen(shown: [SessionFolder], fallback: [String]) -> [String] {
        let base = sections.isEmpty ? fallback : sections
        return base + shown.map(\.id).filter { !$0.isEmpty && !base.contains($0) }
    }

    /// At most `maxPlacements`: the ones for sessions on screen first, then the rest. ponytail: a placement outlives
    /// its session on purpose (one resumed tomorrow keeps its place), and nothing says which of the rest is oldest.
    func capped(keeping shown: Set<String>) -> SidebarLayout {
        guard placements.count > Self.maxPlacements else { return self }
        var next = self
        let kept = Set(placements.keys.sorted { (shown.contains($0) ? 0 : 1, $0) < (shown.contains($1) ? 0 : 1, $1) }.prefix(Self.maxPlacements))
        next.placements = placements.filter { kept.contains($0.key) }
        return next
    }

    // MARK: decoding

    private enum CodingKeys: String, CodingKey { case v, groups, placements, rows, sections }

    /// Lossy: a field this build can't read is an empty one, never a list that fails to draw.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        v = (try? container.decodeIfPresent(Int.self, forKey: .v)) ?? 1
        groups = (try? container.decodeIfPresent([Group].self, forKey: .groups)) ?? []
        placements = (try? container.decodeIfPresent([String: String].self, forKey: .placements)) ?? [:]
        rows = (try? container.decodeIfPresent([String: [String]].self, forKey: .rows)) ?? [:]
        sections = (try? container.decodeIfPresent([String].self, forKey: .sections)) ?? []
    }
}

/// One entry in a row's Move to menu, and the VoiceOver action of the same name.
public struct SidebarMove: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable {
        /// Into one of Tyler's groups.
        case group(String)
        /// Out of its group, back under the folder it runs in.
        case folder(String)
        /// A new group with this session in it: the app asks for its name.
        case newGroup
        case up
        case down
    }

    public let kind: Kind
    public let title: String

    /// What VoiceOver calls it among a row's actions: where it goes, not just the group's name.
    public var accessibilityName: String {
        switch kind {
        case .group: return "Move to \(title)"
        case .newGroup: return "Move to a New Group"
        case .folder, .up, .down: return title
        }
    }

    public var id: String {
        switch kind {
        case .group(let id): return id
        case .folder(let id): return "folder:\(id)"
        case .newGroup: return "new"
        case .up: return "up"
        case .down: return "down"
        }
    }

    /// The menu's entries for a session: every group it isn't in, back to its folder when it is in one, a new group,
    /// then up and down within its section where there is room. A session that isn't at the top of its family moves
    /// with the one it belongs to and has none.
    public static func moves(
        for session: String,
        layout: SidebarLayout,
        shown: [SessionFolder],
        topLevel: Set<String>,
        folder: SessionFolder?
    ) -> [SidebarMove] {
        guard topLevel.contains(session) else { return [] }
        // A running team's member stays under its team while the team runs: nothing to move it to.
        guard shown.first(where: { $0.sessionIDs.contains(session) })?.team == nil else { return [] }
        let current = shown.first { $0.sessionIDs.contains(session) }?.id
        var moves = layout.groups.filter { $0.id != current }.map { SidebarMove(kind: .group($0.id), title: $0.name) }
        if let current, SidebarLayout.isGroup(current), let folder, !folder.id.isEmpty {
            moves.append(SidebarMove(kind: .folder(folder.id), title: "Back to \(folder.name)"))
        }
        if layout.groups.count < SidebarLayout.maxGroups { moves.append(SidebarMove(kind: .newGroup, title: "New Group…")) }
        let siblings = shown.first { $0.id == current }?.sessionIDs.filter(topLevel.contains) ?? []
        if let index = siblings.firstIndex(of: session) {
            if index > 0 { moves.append(SidebarMove(kind: .up, title: "Move Up")) }
            if index < siblings.count - 1 { moves.append(SidebarMove(kind: .down, title: "Move Down")) }
        }
        return moves
    }
}

extension SessionGrouping {
    /// `sidebar(_:home:order:)` with Tyler's arrangement on top (2026-11-12): his groups, each with the sessions he put
    /// in it and an empty one still drawn, as a place to drop into; then every folder with what is left in it; each
    /// section's sessions in the order he dragged them into, the rest after them as they arrived; and the sections in
    /// his order, or the Mac's own folder order (`order`) until he has one. A session's agents, and the sessions it
    /// started, go wherever it goes. An empty layout is the folder list exactly as before.
    ///
    /// A running team (`teams`, Teams.swift) is one more kind of section beside his groups and the folders: its members
    /// stay under its header, lead first, whatever group one was put in before, and take that place again once the team
    /// ends. Its header is dragged into his order as any section's is; its rows aren't moved (`SidebarMove.moves`).
    public static func sidebar(_ sessions: [Session], home: String, order: [String], layout: SidebarLayout, teams: [Team] = []) -> [SessionFolder] {
        guard layout != .empty else { return sidebar(sessions, home: home, order: order, teams: teams) }
        let natural = sidebar(sessions, home: home, order: [], teams: teams)
        let root = roots(of: sessions)
        let groupIDs = Set(layout.groups.map(\.id))
        var members: [String: [String]] = [:]
        var folders: [SessionFolder] = []
        for folder in natural {
            if folder.team != nil {
                folders.append(folder)
                continue
            }
            var kept: [String] = []
            for id in folder.sessionIDs {
                if let group = layout.placements[root[id] ?? id], groupIDs.contains(group) {
                    members[group, default: []].append(id)
                } else {
                    kept.append(id)
                }
            }
            if !kept.isEmpty { folders.append(SessionFolder(id: folder.id, name: folder.name, sessionIDs: kept)) }
        }
        let groups = layout.groups.map { SessionFolder(id: $0.id, name: $0.name, sessionIDs: members[$0.id] ?? []) }
        let sections = (groups + folders).map { $0.team != nil ? $0 : ranked($0, by: layout.rows[$0.id], root: root) }
        return ordered(sections, by: layout.sections.isEmpty ? order : layout.sections)
    }

    /// The folder each session runs in, whatever group it was put in: where Back to sends it, and the one folder it may
    /// be dropped into.
    public static func homeFolders(_ sessions: [Session], home: String) -> [String: SessionFolder] {
        var folders: [String: SessionFolder] = [:]
        for folder in sidebar(sessions, home: home, order: []) {
            for id in folder.sessionIDs { folders[id] = folder }
        }
        return folders
    }

    /// The sessions at the top of their family: not a subagent, and not started by another session on the list. Only
    /// these are dragged or moved; the rest are drawn under them.
    public static func topLevel(_ sessions: [Session]) -> Set<String> {
        let root = roots(of: sessions)
        return Set(sessions.map(\.id).filter { root[$0] == $0 })
    }

    /// Each session's family head: itself, or the session above it, followed up while that one is on the list. A cycle
    /// a daemon once sent stops at the first id seen twice.
    static func roots(of sessions: [Session]) -> [String: String] {
        let ids = Set(sessions.map(\.id))
        var parent: [String: String] = [:]
        for session in sessions {
            if let above = session.parentSessionId ?? session.startedBySessionId, ids.contains(above) { parent[session.id] = above }
        }
        var roots: [String: String] = [:]
        for session in sessions {
            var current = session.id
            var seen: Set<String> = [current]
            while let above = parent[current], !seen.contains(above) {
                seen.insert(above)
                current = above
            }
            roots[session.id] = current
        }
        return roots
    }

    /// A section's sessions in the order dragged: families by their head's place in `order` (the unplaced after, as
    /// they arrived), each head first and its own after it as they arrived.
    static func ranked(_ section: SessionFolder, by order: [String]?, root: [String: String]) -> SessionFolder {
        guard let order, !order.isEmpty else { return section }
        let rank = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        let arrival = Dictionary(section.sessionIDs.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        func key(_ id: String) -> (Int, Int, Int, Int) {
            let head = root[id] ?? id
            return (rank[head] ?? Int.max, arrival[head] ?? arrival[id] ?? 0, head == id ? 0 : 1, arrival[id] ?? 0)
        }
        return SessionFolder(id: section.id, name: section.name, sessionIDs: section.sessionIDs.sorted { key($0) < key($1) })
    }
}

extension SessionFolder {
    /// One of Tyler's groups rather than a folder.
    public var isGroup: Bool { SidebarLayout.isGroup(id) }
}

/// Where a dragged session will land: a short line across the list, in the drop colour, above the row it is over or
/// at the end of the section whose header it is over.
public struct SidebarDropLine: View {
    let color: AnyShapeStyle

    /// `color`: the window's drop colour; ConchColor.active, the same blue, where a host has none of its own.
    public init<S: ShapeStyle>(color: S) {
        self.color = AnyShapeStyle(color)
    }

    public init() {
        self.init(color: ConchColor.active)
    }

    public var body: some View {
        HStack(spacing: 0) {
            Circle().strokeBorder(color, lineWidth: 1.5).frame(width: 6, height: 6)
            Capsule(style: .continuous).fill(color).frame(height: 2)
        }
        .frame(height: 6)
        .padding(.leading, 4)
        .accessibilityHidden(true)
    }
}
