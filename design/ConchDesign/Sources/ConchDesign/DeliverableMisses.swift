import Foundation

/// Which deliverables the review pane couldn't show are filed as a failure (`open-deliverable`, A13), and how often.
///
/// 2026-11-11: "Couldn't find <file>" was the busiest of conch's own failure tickets, and two different things. Half
/// were conch's own copies (`~/Library/Application Support/conch/deliverables`), deleted before the pane heard their
/// deliverable was dropped: a conch bug, which the daemon now waits out (session-ledger.ts `COPY_GRACE_MS`). The rest
/// were files in a project folder that had since gone, most often a worktree removed after its branch merged, and one
/// of those was filed sixteen times in three days: once each time the pane showed it again. The pane says plainly that
/// the file was moved or deleted, which is all there is to say about a folder that isn't conch's.
///
/// So a missing file is filed only when it is one of conch's copies, and anything (missing, or a load that failed) once
/// for each session, file and reason while the app runs.
public struct DeliverableMisses: Sendable {
    /// conch's store of copies under the home folder, as the daemon makes it (deliverable-store.ts `deliverableStoreDir`).
    public static let storeParts = ["Library", "Application Support", "conch", "deliverables"]

    private var filed: Set<String> = []

    public init() {}

    /// Whether `path` is one of conch's own copies: under its store, never the store itself.
    public static func isConchCopy(_ path: String, home: String = NSHomeDirectory()) -> Bool {
        let store = storeParts.reduce(home) { ($0 as NSString).appendingPathComponent($1) }
        let standard = (path as NSString).standardizingPath
        return standard.hasPrefix(store + "/") && standard.count > store.count + 1
    }

    /// A file the pane found missing: filed when it is one of conch's copies, once.
    public mutating func fileMissing(sessionId: String?, path: String, home: String = NSHomeDirectory()) -> Bool {
        guard Self.isConchCopy(path, home: home) else { return false }
        return once(sessionId, path, "missing")
    }

    /// A file that is there and wouldn't load (an image, a video, a PDF): filed wherever it is, once for each reason.
    public mutating func fileLoadFailure(sessionId: String?, path: String, reason: String) -> Bool {
        once(sessionId, path, reason)
    }

    private mutating func once(_ sessionId: String?, _ path: String, _ reason: String) -> Bool {
        filed.insert("\(sessionId ?? "")\u{0}\(path)\u{0}\(reason)").inserted
    }
}
