import Foundation

/// Where a deliverable is, for its tab's right-click menu: a web link to copy as it is, or a file on this Mac to copy as
/// its absolute path and show in Finder (2026-10-16, Tyler: "we should prob add a right click option to the tabs to like
/// copy path"). A link an agent filed relative to its session's folder is resolved against that folder, as opening it is.
public enum DeliverableLocation: Equatable, Sendable {
    case web(String)
    case file(String)

    /// What the menu's Copy puts on the clipboard.
    public var text: String {
        switch self {
        case let .web(link): link
        case let .file(path): path
        }
    }

    public var isFile: Bool {
        if case .file = self { return true }
        return false
    }

    /// `link` as filed, against the session's `cwd` when it is relative; nil when there is nothing to copy.
    public static func of(_ link: String?, cwd: String?, home: String = NSHomeDirectory()) -> DeliverableLocation? {
        guard let link = link?.trimmingCharacters(in: .whitespacesAndNewlines), !link.isEmpty else { return nil }
        let lower = link.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") { return .web(link) }
        if lower.hasPrefix("file://") {
            guard let path = URL(string: link)?.path, !path.isEmpty else { return nil }
            return .file(path)
        }
        if link.hasPrefix("/") { return .file((link as NSString).standardizingPath) }
        if link == "~" || link.hasPrefix("~/") { return .file((home + link.dropFirst()) as String) }
        // Some other scheme (`conch:`, `figma:`): copied as it is, not taken for a path.
        if let colon = link.firstIndex(of: ":"), link[..<colon].allSatisfy({ $0.isLetter || $0 == "+" || $0 == "-" || $0 == "." }) {
            return .web(link)
        }
        guard let cwd, cwd.hasPrefix("/") else { return nil }
        return .file(((cwd as NSString).appendingPathComponent(link) as NSString).standardizingPath)
    }
}
