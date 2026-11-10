import Foundation

// Notices: a session telling Tyler something wherever he is (daemon notify-user.ts, 2026-11-10, Tyler: "we should also
// add a way for me to let sessions send me messages on my phone via conch that ping and show notification"). The phone
// gets each one from Apple, the Mac from the sessions file; both apps read them, route a tap and set push up from here.

/// One notice, as the daemon gives the Mac app on the sessions file (`notices`).
public struct ConchNotice: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let body: String
    public let sessionId: String?
    public let link: String?
    /// Where a tap goes that isn't a session: `providers`, Settings › Providers.
    public let target: String?
    /// Epoch milliseconds.
    public let at: Double

    public init(id: String, title: String, body: String, sessionId: String? = nil, link: String? = nil, target: String? = nil, at: Double) {
        self.id = id
        self.title = title
        self.body = body
        self.sessionId = sessionId
        self.link = link
        self.target = target
        self.at = at
    }
}

/// Which notices the Mac app posts: each once, across launches too. A notice stays on the sessions file a few minutes
/// (`MAC_NOTICE_KEEP_MS`) for an app that opens late, so a relaunch would post it twice without the ids it kept.
public enum NoticePosting {
    /// How many posted ids are kept: far more than five minutes of notices.
    public static let remembered = 64

    /// The notices not posted yet, oldest first.
    public static func due(_ notices: [ConchNotice], posted: [String]) -> [ConchNotice] {
        let seen = Set(posted)
        return notices.filter { !seen.contains($0.id) }.sorted { $0.at < $1.at }
    }

    /// The ids kept after posting `notices`: the newest `remembered`.
    public static func remember(_ notices: [ConchNotice], in posted: [String]) -> [String] {
        Array((posted + notices.map(\.id)).suffix(remembered))
    }
}

/// Where a tapped notice goes, read from a notification's `userInfo`: APNs's payload on the phone (its `conch`
/// dictionary, daemon apns.ts `apnsPayload`), and the same shape on the Mac (`userInfo(for:)`).
public enum NoticeRoute: Equatable, Sendable {
    case session(String)
    /// Settings › Providers: an account that needs signing in again.
    case providers
    /// Just the app.
    case app

    /// A notice with a link carries this category, whose action opens it.
    public static let linkCategory = "conch.notice.link"
    public static let openLinkAction = "conch.notice.open-link"

    public static func from(userInfo: [AnyHashable: Any]) -> NoticeRoute {
        let conch = userInfo["conch"] as? [String: Any] ?? [:]
        if let session = conch["session"] as? String, !session.isEmpty, session.count <= 256 { return .session(session) }
        if conch["target"] as? String == "providers" { return .providers }
        return .app
    }

    /// The notice's link, when it has one and it is http(s): the only kind a notice opens.
    public static func link(userInfo: [AnyHashable: Any]) -> URL? {
        guard let conch = userInfo["conch"] as? [String: Any], let text = conch["link"] as? String,
              let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http"
        else { return nil }
        return url
    }

    /// The notice's id, which the Mac answers the daemon with.
    public static func noticeID(userInfo: [AnyHashable: Any]) -> String? {
        (userInfo["conch"] as? [String: Any])?["notice"] as? String
    }

    /// The Mac's own notification for a notice, in the phone's shape, so one reader routes both.
    public static func userInfo(for notice: ConchNotice) -> [String: Any] {
        var conch: [String: Any] = ["notice": notice.id]
        if let session = notice.sessionId { conch["session"] = session }
        if let link = notice.link { conch["link"] = link }
        if let target = notice.target { conch["target"] = target }
        return ["conch": conch]
    }
}

/// What a notify answered with: where it went, in a sentence (daemon `NotifyResult`).
public struct NotifyOutcome: Decodable, Equatable, Sendable {
    public let outcome: String
    public let said: String
}

/// Push as Settings › Phone app shows it: the daemon's `push-status` (notify-user.ts `PushStatus`). The key itself is
/// never in it, and each phone's token only by its tail.
public struct PushSetupStatus: Decodable, Equatable, Sendable {
    public struct Key: Decodable, Equatable, Sendable {
        public let keyId: String
        public let teamId: String
        public let addedAt: Double
    }

    public struct Device: Decodable, Equatable, Sendable {
        public let device: String
        public let environment: String
        public let alerts: Bool
        public let registeredAt: Double
        public let token: String
        public let lastSentAt: Double?
        public let lastError: String?
    }

    public let key: Key?
    public let devices: [Device]
    public let lastError: String?
    public let lastSentAt: Double?
    /// A test's outcome, after Send a test.
    public let test: NotifyOutcome?

    public init(key: Key? = nil, devices: [Device] = [], lastError: String? = nil, lastSentAt: Double? = nil, test: NotifyOutcome? = nil) {
        self.key = key
        self.devices = devices
        self.lastError = lastError
        self.lastSentAt = lastSentAt
        self.test = test
    }

    /// The phones that will show a notice: registered, with notifications on.
    public var listening: [Device] { devices.filter(\.alerts) }

    /// One line: "Push: not set up", "Push: ready · iPhone", or what last went wrong.
    public var statusLine: String {
        guard key != nil else { return "Push: not set up" }
        if let lastError { return "Push: last error · \(lastError)" }
        if let failing = listening.first(where: { $0.lastError != nil }), let error = failing.lastError {
            return "Push: last error · \(failing.device): \(error)"
        }
        let names = listening.map(\.device)
        if names.isEmpty {
            return devices.isEmpty
                ? "Push: ready · waiting for the iPhone to turn notifications on"
                : "Push: ready · notifications are off on the iPhone"
        }
        return "Push: ready · \(Set(names).count == names.count ? names.joined(separator: ", ") : "\(names.count) phones")"
    }

    /// Whether the line is a problem to show in the warning colour.
    public var troubled: Bool { key != nil && (lastError != nil || listening.contains { $0.lastError != nil }) }
}

/// What Settings takes for the key's ids and the key, checked as the daemon checks them (push-key.ts), so a typo is
/// said before anything is sent. Nothing here ever repeats a key.
public enum PushKeyInput {
    /// A Key ID or Team ID: ten capitals and digits, as Apple shows them. Lower case and spaces are forgiven.
    public static func appleID(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard trimmed.count == 10, trimmed.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
        return trimmed
    }

    /// The Key ID in Apple's file name, `AuthKey_<Key ID>.p8`, to fill the field for you.
    public static func keyID(fromFileName name: String) -> String? {
        guard name.hasPrefix("AuthKey_"), name.hasSuffix(".p8") else { return nil }
        return appleID(String(name.dropFirst("AuthKey_".count).dropLast(".p8".count)))
    }

    /// A `.p8`'s text, as the daemon takes it: its PEM lines, or its base64 alone. Nil for anything that can't be one.
    public static func key(_ text: String) -> String? {
        let body = text
            .replacingOccurrences(of: "-----BEGIN PRIVATE KEY-----", with: "")
            .replacingOccurrences(of: "-----END PRIVATE KEY-----", with: "")
            .filter { !$0.isWhitespace }
        let base64 = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=")
        guard (80...400).contains(body.count), body.allSatisfy(base64.contains), Data(base64Encoded: body) != nil else { return nil }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static let keyProblem = "That isn't an APNs auth key. Choose the .p8 file Apple gave you (AuthKey_<Key ID>.p8), or paste all of it."
    public static let keyIDProblem = "The Key ID is the ten letters and digits Apple shows beside the key, and in the file's name."
    public static let teamIDProblem = "The Team ID is the ten letters and digits in Membership details of your Apple Developer account."
}

/// Which APNs environment this build's notifications come through: what its provisioning profile says (a build Xcode
/// installs is signed for development, an App Store or TestFlight build for production), or, with no profile (the App
/// Store strips it), production. The daemon tries the other once if Apple refuses the token (notify-user.ts).
public enum PushEnvironment {
    public static func from(provisioningProfile data: Data?, debugBuild: Bool) -> String {
        guard let data else { return debugBuild ? "development" : "production" }
        // A CMS envelope round an XML plist: the plist is the part from `<?xml` to `</plist>`.
        guard let text = String(data: data, encoding: .isoLatin1),
              let start = text.range(of: "<?xml"), let end = text.range(of: "</plist>", range: start.upperBound..<text.endIndex),
              let plist = String(text[start.lowerBound..<end.upperBound]).data(using: .isoLatin1),
              let parsed = try? PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any],
              let entitlements = parsed["Entitlements"] as? [String: Any],
              let environment = entitlements["aps-environment"] as? String,
              environment == "development" || environment == "production"
        else { return debugBuild ? "development" : "production" }
        return environment
    }
}

/// When the phone offers to turn notifications on: once the Mac can push (`/push` says ready), while iOS hasn't been
/// asked, and until it's turned on or put off. Never at launch, and never before the Mac could send one: asking for
/// what can't come would be dishonest (decision 11, which kept the ask out of setup).
public enum PushOffer {
    public static func shows(macReady: Bool, authorization: PushAuthorization, dismissed: Bool) -> Bool {
        macReady && authorization == .notAsked && !dismissed
    }
}

/// iOS's answer for conch's notifications, in the three ways the app acts on.
public enum PushAuthorization: Equatable, Sendable {
    case notAsked
    case allowed
    case denied
}
