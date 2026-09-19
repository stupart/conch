import Foundation

// A session's working folder, as a tree you can read — workspace files.
//
// Not a Finder. conch knows something Finder cannot: which of these files the agent just
// touched. That is the whole reason this exists rather than a "reveal in Finder" button, and
// it is why the marking rules below are careful — a tree that marks the WRONG file is worse
// than one that marks nothing, because it is a confident claim about work that never happened.
//
// The rules live here rather than in the view because they are questions about paths and
// lists, not about pixels: they can be tested without a window, a daemon, or a file tree on
// screen, and the phone will ask the same questions if it ever grows this pane.

/// One entry in a working folder: a file, or a directory that can be opened.
public struct ConchFileEntry: Equatable, Sendable, Identifiable {
    /// Absolute, standardized. This is the identity — two entries are the same entry when
    /// they are the same path, which is what lets a tree keep its open folders across a
    /// refresh without matching on names that repeat at every level.
    public let path: String
    public let name: String
    public let isDirectory: Bool

    public var id: String { path }

    public init(path: String, name: String, isDirectory: Bool) {
        self.path = path
        self.name = name
        self.isDirectory = isDirectory
    }
}

public enum ConchFileTree {
    /// Folders that are never the work.
    ///
    /// Not a style preference: `node_modules` in a mid-sized project is tens of thousands of
    /// entries, and a tree that offers to expand it is a tree that hangs. `.git` is worse —
    /// it is the repository's own machinery, and nothing in it is a file anybody opened.
    ///
    /// Matched by exact name at any depth, because these appear nested (a monorepo has one
    /// `node_modules` per package) and a root-only rule would miss every one of them.
    public static let skippedDirectories: Set<String> = [
        ".git", "node_modules", ".build", "build", "DerivedData", ".next", "dist",
        ".venv", "venv", "__pycache__", ".turbo", ".gradle", "Pods", ".swiftpm",
        ".cache", "target", ".pytest_cache", ".mypy_cache", "vendor", ".terraform",
    ]

    /// Files that are noise in every folder they appear in.
    public static let skippedFiles: Set<String> = [".DS_Store"]

    /// Dotfiles are NOT hidden.
    ///
    /// Finder hides them; this must not. `.env`, `.gitignore` and `.claude` are exactly the
    /// files an agent edits and a person then wants to see, and hiding them would make the
    /// tree disagree with the change rows sitting beside it.
    public static func isSkipped(name: String, isDirectory: Bool) -> Bool {
        isDirectory ? skippedDirectories.contains(name) : skippedFiles.contains(name)
    }

    /// Directories first, then by name, case-insensitively.
    ///
    /// Case-insensitive because the volume usually is: `Makefile` and `main.swift` sorting
    /// into separate blocks by ASCII is the ordering nobody expects on a Mac.
    public static func sorted(_ entries: [ConchFileEntry]) -> [ConchFileEntry] {
        entries.sorted { first, second in
            if first.isDirectory != second.isDirectory { return first.isDirectory }
            let byName = first.name.localizedCaseInsensitiveCompare(second.name)
            if byName != .orderedSame { return byName == .orderedAscending }
            return first.path < second.path
        }
    }

    /// One folder's contents, sorted and filtered. Never recursive: the view asks for a
    /// folder when it is opened, so a tree costs one listing per folder actually looked at
    /// rather than a walk of the whole checkout on first draw.
    public static func children(
        of directory: String,
        using fileManager: FileManager = .default
    ) -> [ConchFileEntry] {
        let root = standardized(directory)
        guard let names = try? fileManager.contentsOfDirectory(atPath: root) else { return [] }
        var entries: [ConchFileEntry] = []
        entries.reserveCapacity(names.count)
        for name in names {
            let full = root.hasSuffix("/") ? root + name : root + "/" + name
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: full, isDirectory: &isDirectory) else { continue }
            guard !isSkipped(name: name, isDirectory: isDirectory.boolValue) else { continue }
            entries.append(
                ConchFileEntry(path: full, name: name, isDirectory: isDirectory.boolValue)
            )
        }
        return sorted(entries)
    }

    /// `.` and `..` removed and `~` expanded, with no trailing slash — but symlinks left
    /// alone.
    ///
    /// Resolving them would be actively wrong here: `~/conch` is a symlink to
    /// `~/Projects/Conch` on this machine, and a session whose cwd is the symlink should show
    /// the path the person chose, not the one the disk prefers. Two spellings of one folder is
    /// a smaller problem than a tree whose paths do not match the cwd it was given.
    public static func standardized(_ path: String) -> String {
        let expanded = NSString(string: path).expandingTildeInPath
        let standard = NSString(string: expanded).standardizingPath
        guard standard.count > 1, standard.hasSuffix("/") else { return standard }
        return String(standard.dropLast())
    }
}

/// One line of the tree as it is drawn: an entry, and how far in it sits.
public struct ConchFileRow: Equatable, Sendable, Identifiable {
    public let entry: ConchFileEntry
    /// 0 for the root's own children, 1 for theirs, and so on.
    public let depth: Int

    public var id: String { entry.path }

    public init(entry: ConchFileEntry, depth: Int) {
        self.entry = entry
        self.depth = depth
    }
}

extension ConchFileTree {
    /// The tree flattened to the lines actually on screen.
    ///
    /// Pure, over listings the caller has ALREADY loaded — which is the point. Reading the
    /// disk inside a SwiftUI body would put an IO call in the render path, where it runs again
    /// on every unrelated state change and stutters exactly the scroll it is drawing. The view
    /// loads a folder once when it is opened and keeps it; this turns that cache into rows.
    ///
    /// A folder that is open but not yet loaded contributes no children rather than blocking:
    /// its rows appear when the listing arrives, which is one extra frame, not a stall.
    public static func rows(
        root: String,
        listings: [String: [ConchFileEntry]],
        expanded: Set<String>
    ) -> [ConchFileRow] {
        var rows: [ConchFileRow] = []
        func walk(_ directory: String, depth: Int) {
            for entry in listings[directory] ?? [] {
                rows.append(ConchFileRow(entry: entry, depth: depth))
                guard entry.isDirectory, expanded.contains(entry.path) else { continue }
                walk(entry.path, depth: depth + 1)
            }
        }
        walk(standardized(root), depth: 0)
        return rows
    }
}

/// The files this session changed, ready to be asked about one tree row at a time.
///
/// The daemon sends the path the tool was given, which is usually absolute and occasionally
/// relative — it does not know the agent's working directory, so it never resolves one. That
/// is this type's job, against the session's own cwd.
public struct ConchFileChanges: Equatable, Sendable {
    /// Absolute, standardized paths of every file the session changed.
    public let paths: Set<String>

    public init(changed: [String], relativeTo root: String) {
        let base = ConchFileTree.standardized(root)
        var resolved: Set<String> = []
        for raw in changed {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            // A bare basename is NOT resolvable and must never be guessed at. An older daemon
            // sends no path at all and the caller passes nothing; but a caller that passes the
            // basename by mistake would otherwise have every `card.tsx` in the checkout
            // resolve to the one at the root, marking a file the agent never touched.
            if trimmed.hasPrefix("/") || trimmed.hasPrefix("~") {
                resolved.insert(ConchFileTree.standardized(trimmed))
            } else if trimmed.contains("/") {
                resolved.insert(ConchFileTree.standardized(base + "/" + trimmed))
            }
        }
        paths = resolved
    }

    public var isEmpty: Bool { paths.isEmpty }

    /// Did the session change this exact file?
    public func changed(_ entry: ConchFileEntry) -> Bool {
        !entry.isDirectory && paths.contains(entry.path)
    }

    /// Does this folder hold any of the changed files, at any depth?
    ///
    /// What makes the tree readable without opening anything: the folders the work happened
    /// in are marked on first draw, so the path to it is visible rather than hunted for. The
    /// separator matters — without it `/src/app` would claim `/src/application.ts`.
    public func contains(_ entry: ConchFileEntry) -> Bool {
        guard entry.isDirectory else { return false }
        let prefix = entry.path + "/"
        return paths.contains { $0.hasPrefix(prefix) }
    }
}
