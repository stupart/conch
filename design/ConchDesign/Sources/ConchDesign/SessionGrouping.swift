import Foundation

// Which folder each session belongs to — as a rule, rather than as a view.
//
// The session list is the one place a dozen agents are visible at once, and "which project
// is this one in?" was the question it answered worst: a flat list of labels, with the folder
// reachable only through a link the agent happened to print. Every row already carries the
// folder it runs in (`cwd`, A13); this turns that into the list's structure.
//
// The rules live here rather than in either app because both lists ask the same question, and
// because the cases worth getting right are the ones a screenshot of a healthy list never
// shows: two checkouts of the same repo, a subagent whose own folder differs from its
// parent's, and a daemon too old to send `cwd` at all.

/// One folder's worth of sessions, in the order the rows arrived in.
public struct SessionFolder: Equatable, Sendable, Identifiable {
    /// The folder's path. Empty when the folder is unknown — the daemon is older than `cwd`,
    /// or this session has none — and a group with an empty id is drawn without a header.
    public let id: String
    /// What the header shows: the shortest tail of the path no other folder here shares, so
    /// two checkouts of one repo don't both read `conch`.
    public let name: String
    public let sessionIDs: [String]

    public init(id: String, name: String, sessionIDs: [String]) {
        self.id = id
        self.name = name
        self.sessionIDs = sessionIDs
    }
}

public enum SessionGrouping {
    /// One session as the Mac sidebar groups it: the fields of its row the rule reads, and nothing else.
    public struct Session: Equatable, Sendable {
        public var id: String
        public var cwd: String?
        public var workDirs: [String]?
        public var parentSessionId: String?
        public var startedBySessionId: String?

        public init(id: String, cwd: String?, workDirs: [String]?, parentSessionId: String?, startedBySessionId: String?) {
            self.id = id
            self.cwd = cwd
            self.workDirs = workDirs
            self.parentSessionId = parentSessionId
            self.startedBySessionId = startedBySessionId
        }
    }

    /// Where the Mac reader keeps the order Tyler dragged the folders into: their paths, newline-joined.
    public static let orderKey = "conch.folderOrder"

    /// That stored order, as paths.
    public static func storedOrder(_ stored: String) -> [String] {
        stored.split(separator: "\n").map(String.init)
    }

    /// Where a session's work is: the first folder its agent declared (`workDirs`), else where it started (`cwd`).
    public static func workFolder(cwd: String?, workDirs: [String]?) -> String? {
        workDirs?.first ?? cwd
    }

    /// What the Mac sidebar shows, in its order: each session in its work folder, a child (a subagent, or a session
    /// another one started) under its parent's, the home folder named "Home" rather than the account's name, and the
    /// folders in the order the reader dragged them into, then as they arrived. The sidebar draws these, and the lagoon
    /// is sent their names (`LagoonSnapshot.folders`, 2026-10-13), so the two can never group a session differently.
    public static func sidebar(_ sessions: [Session], home: String, order: [String]) -> [SessionFolder] {
        let grouped = folders(for: sessions.map {
            ($0.id, workFolder(cwd: $0.cwd, workDirs: $0.workDirs), $0.parentSessionId ?? $0.startedBySessionId)
        })
        .map { folder in
            // A session started in the home folder headed the list with the account name — "tylerstupart" — which
            // reads like a project and is not one. Seen on the live window, not in any test: every fixture used a
            // project path.
            guard folder.id == home else { return folder }
            return SessionFolder(id: folder.id, name: "Home", sessionIDs: folder.sessionIDs)
        }
        return ordered(grouped, by: order)
    }

    /// The rows, grouped by folder, in the order the daemon sent them.
    ///
    /// Order is first appearance rather than anything cleverer on purpose: the list is read
    /// while it changes, and a group that reorders itself by recency moves the row you were
    /// about to click. The reader can override it by dragging: `ordered(_:by:)`.
    public static func folders(
        for sessions: [(id: String, cwd: String?, parentID: String?)]
    ) -> [SessionFolder] {
        var ownPath: [String: String] = [:]
        var parentOf: [String: String] = [:]
        for session in sessions {
            ownPath[session.id] = normalized(session.cwd)
            if let parentID = session.parentID { parentOf[session.id] = parentID }
        }

        var order: [String] = []
        var members: [String: [String]] = [:]
        for session in sessions {
            let path = folderPath(of: session.id, ownPath: ownPath, parentOf: parentOf)
            if members[path] == nil {
                order.append(path)
                members[path] = []
            }
            members[path]?.append(session.id)
        }

        let names = displayNames(for: order.filter { !$0.isEmpty })
        return order.map { path in
            SessionFolder(id: path, name: names[path] ?? "", sessionIDs: members[path] ?? [])
        }
    }

    /// The folders in the order the reader chose, then the rest as they arrived.
    ///
    /// Grouping stays derived from the folder each session runs in — a row's place is its
    /// folder's place, always. What the reader owns is the order of the FOLDERS. That is the
    /// whole answer to "what happens to a dragged thing when its folder changes": nothing can,
    /// because rows are never dragged. A session restarted elsewhere, or a child re-parented,
    /// simply appears under its new folder, and a folder keeps its slot as sessions come and
    /// go in it — including across days when it is not on screen at all, since `preferred`
    /// is never pruned to what is visible.
    public static func ordered(_ folders: [SessionFolder], by preferred: [String]) -> [SessionFolder] {
        let rank = Dictionary(preferred.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        let chosen = folders.filter { rank[$0.id] != nil }.sorted { rank[$0.id]! < rank[$1.id]! }
        return chosen + folders.filter { rank[$0.id] == nil }
    }

    /// The stored order after dragging folder `id` onto folder `target`: `id` takes `target`'s
    /// slot and everything between shifts one toward the gap, so a drop on the last header
    /// reaches the end and a drop on the first reaches the top without an insertion line.
    ///
    /// Folders on screen that were never dragged join `preferred` first, in screen order, so
    /// the move is applied to the list the reader is looking at rather than to the subset
    /// they happened to drag before. An unnamed folder (empty id) has no header to drag or
    /// drop on and is left out.
    public static func order(
        _ preferred: [String],
        moving id: String,
        onto target: String,
        visible: [String]
    ) -> [String] {
        var order = preferred + visible.filter { !$0.isEmpty && !preferred.contains($0) }
        guard id != target, let from = order.firstIndex(of: id), let to = order.firstIndex(of: target) else {
            return order
        }
        order.remove(at: from)
        order.insert(id, at: to)
        return order
    }

    /// A child belongs where its parent belongs.
    ///
    /// A subagent (C4) or a session another one started (C15) is drawn indented under it, so
    /// grouping it by its OWN folder would tear it out from under the row it belongs to — and
    /// a `codex` run started from Claude's Bash tool genuinely can sit in another directory.
    /// The walk is bounded by the set of ids already seen: a daemon that ever sent a parent
    /// cycle would otherwise hang the list rather than draw it.
    private static func folderPath(
        of id: String,
        ownPath: [String: String],
        parentOf: [String: String]
    ) -> String {
        var current = id
        var seen: Set<String> = [id]
        while let parent = parentOf[current], ownPath[parent] != nil, !seen.contains(parent) {
            seen.insert(parent)
            current = parent
        }
        return ownPath[current] ?? ""
    }

    private static func normalized(_ cwd: String?) -> String {
        guard var path = cwd?.trimmingCharacters(in: .whitespaces), !path.isEmpty else { return "" }
        while path.count > 1, path.hasSuffix("/") { path.removeLast() }
        return path
    }

    /// The shortest tail of each path that tells it apart from every other folder on screen,
    /// falling back to the whole path when even that is shared (one path ending in another).
    private static func displayNames(for paths: [String]) -> [String: String] {
        let parts = Dictionary(
            uniqueKeysWithValues: paths.map { ($0, $0.split(separator: "/").map(String.init)) }
        )
        var names: [String: String] = [:]
        for path in paths {
            guard let own = parts[path], !own.isEmpty else {
                names[path] = path  // the root folder has no last component to show
                continue
            }
            names[path] = path
            for depth in 1...own.count {
                let candidate = own.suffix(depth).joined(separator: "/")
                let shared = paths.contains { other in
                    other != path && parts[other]?.suffix(depth).joined(separator: "/") == candidate
                }
                if !shared {
                    names[path] = candidate
                    break
                }
            }
        }
        return names
    }
}
