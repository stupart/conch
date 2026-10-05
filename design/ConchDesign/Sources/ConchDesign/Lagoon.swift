import Foundation

/// The lagoon: conch's sessions as hermit crabs on a three.js beach, a page in the Mac app in place of the conversation.
/// The contract is the brand repo's `experiments/bridge/MAC-APP-SPEC.md` (~/Projects/conch-design/brand); the page and its
/// `window.conchWorld` API are built there, and the Mac app carries a copy of them (`Contents/Resources/Lagoon`, put there
/// by scripts/build-app.sh, never committed here). This file is the app's half that needs no window: names, the page's
/// address, what a file is served as, and where the page may go. LagoonFiles, LagoonSnapshot, LagoonIntents and
/// LagoonPacer are the rest, each tested on its own (Tests/ConchDesignTests/Lagoon*Tests.swift).
///
/// 2026-10-04, phase A of the rollout (spec §8): read-only. The page shows what conch publishes, and every intent it sends
/// back is checked and logged and acted on by nothing.
public enum Lagoon {
    /// `conch-lagoon://lagoon/…`: one scheme serves the page, its files and the deliverables on its glass (spec §3). Not
    /// `file:`, because WebKit's `fetch` refuses `file:` URLs and the page reads its JSON and its sky with `fetch`.
    public static let scheme = "conch-lagoon"
    public static let host = "lagoon"
    /// The folder in the app's Resources (`Bundle.main.url(forResource: "Lagoon", withExtension: nil)`).
    public static let bundleName = "Lagoon"
    /// The `os_log` category every intent is logged under.
    public static let logCategory = "lagoon"
    /// The `WKScriptMessageHandler` the page posts its intents to (`webkit.messageHandlers.conchWorld`).
    public static let messageHandlerName = "conchWorld"

    /// The hidden setting (a UserDefaults bool, off by default; Debug ▸ Show Lagoon): with it off the page, ⌘0 and the
    /// header's shell are not there at all.
    public static let enabledKey = "conch.lagoon.enabled"
    /// Which page the window shows (`Page`), remembered so the lagoon survives a relaunch.
    public static let pageKey = "conch.page"
    /// Which intents the app acts on, by name (`LagoonActionFlags`). Absent: none, which is phase A.
    public static let actionsKey = "conch.lagoon.actions"

    /// The window's two pages: the sidebar's conversations, or the beach.
    public enum Page: String, Equatable, Sendable, CaseIterable {
        case sessions
        case lagoon
    }

    /// `index.html?app=1&readonly=1&act=approve,unapprove`: the app hosts it (`?app=1`), and while `readOnly` the page shows
    /// a "would do: …" toast for each intent and marks every message `readOnly: true`. Phase C (any of reply, answer or
    /// pause switched on) drops `readonly=1`, as spec §8 says; nothing else about the page changes between phases.
    ///
    /// `act` names the intents the app acts on whatever the phase (`LagoonIntent.byDefault`), so the page treats them as
    /// live rather than "would do": Approve and its Undo (2026-10-05, Tyler's decision; the brand side asked for this
    /// parameter), and, later that day, the reply bar (Tyler's go, replies only). A page that doesn't read it still sends
    /// them, and the app still acts.
    public static func pageURL(readOnly: Bool) -> URL {
        URL(string: "\(scheme)://\(host)/index.html?app=1\(readOnly ? "&readonly=1" : "")&act=\(actsByDefault)")!
    }

    /// `approve,unapprove,reply`: `LagoonIntent.byDefault`, in the order the lagoon names them.
    public static var actsByDefault: String {
        LagoonIntent.byDefaultInOrder.map(\.rawValue).joined(separator: ",")
    }

    /// Where the page opens a deliverable a session holds: `conch-lagoon://lagoon/review/<session>/<review>`, both ids encoded
    /// as `encodeURIComponent` encodes them, so this is the bridge's `/review` URL byte for byte but for the origin
    /// (experiments/bridge/serve.mjs) and the cross-check against sanitize.mjs compares like with like.
    public static func reviewURL(sessionId: String, reviewKey: String) -> String {
        "\(scheme)://\(host)/review/\(encodeComponent(sessionId))/\(encodeComponent(reviewKey))"
    }

    /// JavaScript's `encodeURIComponent`: everything but `A–Z a–z 0–9 - _ . ! ~ * ' ( )` percent-encoded as UTF-8.
    public static func encodeComponent(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? text
    }

    private static let unreserved: CharacterSet = {
        var set = CharacterSet()
        set.insert(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        return set
    }()

    // MARK: What a file is served as

    /// The bridge's table (serve.mjs `TYPES`), plus the HDRI. `.js` is `text/javascript`: a module script served as anything
    /// else is refused by WebKit, and the whole lagoon is modules.
    public static func mimeType(forPathExtension pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html", "htm": "text/html; charset=utf-8"
        case "css": "text/css; charset=utf-8"
        case "js", "mjs": "text/javascript; charset=utf-8"
        case "json": "application/json"
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "gif": "image/gif"
        case "webp": "image/webp"
        case "svg": "image/svg+xml"
        case "avif": "image/avif"
        case "mp4", "m4v": "video/mp4"
        case "mov": "video/quicktime"
        case "webm": "video/webm"
        case "mp3": "audio/mpeg"
        case "wav": "audio/wav"
        case "m4a": "audio/mp4"
        case "pdf": "application/pdf"
        case "md", "txt": "text/plain; charset=utf-8"
        case "woff2": "font/woff2"
        case "woff": "font/woff"
        default: "application/octet-stream"
        }
    }

    // MARK: Where the page may go

    public enum Navigation: Equatable, Sendable {
        case allow
        case refuse(String)
    }

    /// The navigation policy (spec §3), in the spirit of the review pane's (`DeliverableWebView`):
    /// - the page itself only ever on `conch-lagoon:`;
    /// - a frame inside it, which is a deliverable on the glass: `conch-lagoon:`, the web, `about:blank`/`about:srcdoc`, and
    ///   `blob:`/`data:` (bytes the page made, under its own origin);
    /// - never a new window: in the app "Open ↗" is a message, not `window.open`.
    public static func navigation(to url: URL?, mainFrame: Bool, newWindow: Bool) -> Navigation {
        if newWindow { return .refuse("the lagoon never opens a window") }
        guard let url, let scheme = url.scheme?.lowercased() else { return .refuse("no address") }
        if scheme == self.scheme {
            return url.host?.lowercased() == host ? .allow : .refuse("not the lagoon's host")
        }
        guard !mainFrame else { return .refuse("the lagoon's page is only ever its own") }
        switch scheme {
        case "http", "https", "blob", "data":
            return .allow
        case "about" where ["about:blank", "about:srcdoc"].contains(url.absoluteString.lowercased()):
            return .allow
        default:
            return .refuse("\(scheme): isn't allowed in the lagoon")
        }
    }
}
