import Foundation

/// What kind of thing an app shows, by its bundle id: the Mac's front-window observer
/// (docs/screen-context.md) decides from this what it can say about the app and what it has to
/// read. Some kinds say enough by themselves; a browser's page has to be read, and where a browser
/// keeps its page's address decides how.
public enum ScreenAppKind: Equatable, Sendable {
    /// A terminal: which session it shows is its tab's tty, which only Terminal's AppleScript tells.
    case terminal
    case simulator
    /// A design tool's canvas (Figma).
    case design
    /// A browser whose page carries its own address (`AXURL` on the web area): Safari.
    case pageAddressBrowser
    /// A browser whose page's address is only in its address field: Chrome and its kin.
    case addressFieldBrowser
    /// Anything else: its front window's document, when it has one, else the app.
    case app

    public init(bundleId: String) {
        switch bundleId {
        case "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty": self = .terminal
        case "com.apple.iphonesimulator": self = .simulator
        case "com.figma.Desktop": self = .design
        case "com.apple.Safari", "com.apple.SafariTechnologyPreview": self = .pageAddressBrowser
        case "com.google.Chrome", "com.google.Chrome.canary", "com.brave.Browser", "com.microsoft.edgemac": self = .addressFieldBrowser
        default: self = .app
        }
    }

    /// The page an address field shows. Chrome hides the scheme (and `www.`) of what it displays,
    /// so a bare address gets one back: http for this Mac's own servers, which is what they speak,
    /// https for anywhere else. Text that is not an address, such as a search being typed, is nil.
    ///
    /// ponytail: a hidden `www.` stays hidden, so a live site's page may not match its deliverable's
    /// link exactly; localhost pages, the ones agents show, lose nothing.
    public static func addressFieldURL(_ text: String) -> URL? {
        let address = text.trimmingCharacters(in: .whitespaces)
        guard !address.isEmpty, !address.contains(where: \.isWhitespace) else { return nil }
        let lowered = address.lowercased()
        if lowered.hasPrefix("http://") || lowered.hasPrefix("https://") {
            return URL(string: address).flatMap { $0.host?.isEmpty == false ? $0 : nil }
        }
        guard let bare = URL(string: "http://\(address)"), let host = bare.host?.lowercased() else { return nil }
        if ["localhost", "127.0.0.1", "::1"].contains(host) { return bare }
        return host.contains(".") ? URL(string: "https://\(address)") : nil
    }
}

/// Which screen reports reach the daemon, so that neither of the Mac's observers undoes the other.
///
/// Two rules. A report that repeats the last one said is not said again: the front-window
/// observer re-reads every few seconds, and an app coming forward is often seen twice. And for
/// `grace` after conch stages something into an app, that app's own reports are held: it is still
/// getting there (Chrome shows the old tab, then the new one), and the staged report, which knows
/// the session and the deliverable, is the better answer. conch's own window (no app) is never
/// held, since a pick there is Tyler's.
///
/// A held report is not remembered as said, so the next reading after the grace says it.
public struct ScreenReportGate<Surface: Equatable> {
    public static var grace: TimeInterval { 3 }

    private var last: Surface?
    private var staging: (app: String, at: Date)?

    public init() {}

    /// conch put `surface` on screen, in `app` (nil: its own window). Always said.
    public mutating func staged(_ surface: Surface, in app: String?, at now: Date) {
        last = surface
        staging = app.map { ($0, now) }
    }

    /// Something noticed rather than done by conch: true when it should be said.
    public mutating func noticed(_ surface: Surface, in app: String?, at now: Date) -> Bool {
        if surface == last { return false }
        if let staging, staging.app == app, now.timeIntervalSince(staging.at) < Self.grace { return false }
        last = surface
        return true
    }
}
