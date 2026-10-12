import Foundation

/// The Workbench's decisions, pure: which WebKit data store a profile's pages use, which tab a session is showing, which
/// newly opened tab comes to the front, what a tab is called in the strip, and what the address field takes. The daemon's
/// half is src/browser-workbench.ts; the Mac app's pages and pane are Workbench.swift there, and the script it runs in
/// a page is `WorkbenchScript`.
///
/// Tyler, 2026-10-09: "Agents's pages should live as tabs in the deliverables plane just like the deliverables."
public enum Workbench {
    /// The built-in profile: `WKWebsiteDataStore.default()`, the store the review pane and `conch_capture` draw with,
    /// so a sign-in made in either is a sign-in here.
    public static let defaultProfile = "default"

    /// Which data store a profile's pages live in.
    public enum DataStore: Equatable, Sendable {
        case `default`
        /// `WKWebsiteDataStore(forIdentifier:)`: a store of the profile's own, kept by WebKit across launches.
        case identified(UUID)
    }

    /// The store for a profile id: the default for `default`, the UUID's own for a UUID, and nil for anything else,
    /// which is never opened.
    public static func dataStore(forProfile id: String) -> DataStore? {
        if id == defaultProfile { return .default }
        guard id.count == 36, let uuid = UUID(uuidString: id) else { return nil }
        return .identified(uuid)
    }

    /// A tab as the daemon publishes it (src/browser-workbench.ts `BrowserTab`).
    public struct Tab: Equatable, Sendable, Identifiable {
        public let id: String
        public let sessionId: String
        public let url: String
        public let title: String?
        public let profile: String
        /// Epoch-ms it was opened.
        public let openedAt: Double

        public init(id: String, sessionId: String, url: String, title: String? = nil, profile: String = Workbench.defaultProfile, openedAt: Double = 0) {
            self.id = id
            self.sessionId = sessionId
            self.url = url
            self.title = title
            self.profile = profile
            self.openedAt = openedAt
        }
    }

    /// The tab a session is showing, among its own (oldest first): the reader's pick while it is still open, else the
    /// newest. A pick that closed is no pick, rather than an empty pane where a page used to be.
    public static func shown(in tabs: [Tab], picked: String?) -> Tab? {
        if let picked, let tab = tabs.first(where: { $0.id == picked }) { return tab }
        return tabs.max { $0.openedAt < $1.openedAt }
    }

    /// How new a tab may be and still come to the front when it first appears: past this it was opened while the app
    /// wasn't looking (a relaunch, a daemon that kept its tabs), and is left where it is.
    public static let arrivalWindow: TimeInterval = 20

    /// The tabs that have just arrived: not among those already `known`, and opened within `arrivalWindow` of `now`.
    public static func arrivals(_ tabs: [Tab], known: Set<String>, now: Date) -> [Tab] {
        let since = (now.timeIntervalSince1970 - arrivalWindow) * 1000
        return tabs.filter { !known.contains($0.id) && $0.openedAt >= since }
    }

    /// The arrival to bring to the front: the newest of the session in view. Another session's tab arrives quietly, on
    /// its row, as a new deliverable does.
    public static func front(of arrivals: [Tab], viewing: String?) -> Tab? {
        guard let viewing else { return nil }
        return arrivals.filter { $0.sessionId == viewing }.max { $0.openedAt < $1.openedAt }
    }

    /// The tab's name in the strip: its title, else its host, else its address.
    public static func label(title: String?, url: String) -> String {
        if let title = title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        if let host = URL(string: url)?.host, !host.isEmpty {
            return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        }
        return url.isEmpty ? "New tab" : url
    }

    /// Whether an address may be opened in a tab: http or https, with a host.
    public static func isWeb(_ url: URL?) -> Bool {
        guard let url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        return url.host?.isEmpty == false
    }

    /// What was typed in the address field, as an address: an http(s) URL as typed; a host (with a port or a path) as
    /// https, or http for this Mac's own servers (localhost, 127.0.0.1, a `.local` name); anything else as a search.
    /// Nil for nothing, and for an address of another kind (`file:`, `javascript:`), which a tab never opens.
    public static func address(typed: String) -> URL? {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if let url = URL(string: text), let scheme = url.scheme?.lowercased(), text.contains("://") || scheme == "javascript" || scheme == "file" || scheme == "about" || scheme == "data" {
            return isWeb(url) ? url : nil
        }
        if !text.contains(where: \.isWhitespace) {
            let host = text.split(separator: "/", maxSplits: 1).first.map(String.init) ?? text
            let name = (host.split(separator: ":").first.map(String.init) ?? host).lowercased()
            let local = name == "localhost" || name == "127.0.0.1" || name == "0.0.0.0" || name.hasSuffix(".local")
            let hostLike = local || (name.contains(".") && !name.hasPrefix(".") && !name.hasSuffix("."))
            if hostLike, let url = URL(string: "\(local ? "http" : "https")://\(text)"), isWeb(url) { return url }
        }
        var search = URLComponents(string: "https://www.google.com/search")!
        search.queryItems = [URLQueryItem(name: "q", value: text)]
        return search.url
    }
}
