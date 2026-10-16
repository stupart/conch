import Foundation

/// Which sites a conch browser profile is signed in to (2026-10-17), told from its cookies' names, domains and expiry
/// alone. Tyler: "this is a perfect test of our in-conch-browser login / token cache system tho. hillclimb improving
/// this". A profile was a name and "who it's signed in as stays in its cookies"; now Settings › Browser lists the sites
/// with a way to sign out of each, and `conch logins` says which sites a profile has.
///
/// A cookie's value is a secret and is never read here: `Cookie` has no value to read. What leaves the Mac app is the
/// report (`Report`), site names and times, in conch's config folder for the daemon's logins inventory
/// (src/login-inventory.ts reads `browser-sign-ins.json`).
///
/// WebKit can't say which cookies are a sign-in, so it is told by name, the way a person reading the list would:
/// `session`, `auth`, `token`, `login`, `remember`, Google's `SID` family and the like, but never consent, CSRF, analytics
/// or a CDN's bot check. A site counts when one of them is still good. A sign-in kept only in a cookie that ends when the
/// app quits counts too, marked `untilQuit`, so the list says it won't outlast a relaunch; but only by a strong name
/// (`auth`, `token`, …), since a framework gives every visitor a session cookie (`Strength`).
/// A site that keeps its sign-in in local storage rather than a cookie isn't seen.
public enum BrowserSignIns {
    /// A cookie, as much as is needed to tell a sign-in: never its value.
    public struct Cookie: Equatable, Sendable {
        public let name: String
        /// As WebKit has it: `.mobbin.com`, `accounts.google.com`.
        public let domain: String
        /// Nil for a cookie that ends when the app quits.
        public let expires: Date?

        public init(name: String, domain: String, expires: Date?) {
            self.name = name
            self.domain = domain
            self.expires = expires
        }
    }

    /// A site the profile is signed in to.
    public struct Site: Codable, Equatable, Sendable, Identifiable {
        /// The site as a person names it: `mobbin.com`, `google.com`, `bbc.co.uk`.
        public let domain: String
        /// Its sign-in is only in cookies that end when conch quits: gone after a relaunch.
        public let untilQuit: Bool

        public var id: String { domain }

        public init(domain: String, untilQuit: Bool = false) {
            self.domain = domain
            self.untilQuit = untilQuit
        }
    }

    /// The sites, alphabetical, from a profile's cookies.
    public static func sites(from cookies: [Cookie], now: Date) -> [Site] {
        var lasting = Set<String>()
        var untilQuit = Set<String>()
        for cookie in cookies {
            guard let strength = signIn(cookie.name), let site = site(ofCookieDomain: cookie.domain) else { continue }
            if let expires = cookie.expires {
                if expires > now { lasting.insert(site) }
            } else if strength == .strong {
                untilQuit.insert(site)
            }
        }
        return lasting.union(untilQuit).sorted().map { Site(domain: $0, untilQuit: !lasting.contains($0)) }
    }

    // MARK: Telling a sign-in by its name

    /// How surely a cookie's name says sign-in. A `session` cookie that ends when the app quits is as often a visitor's
    /// (a framework's session id, which every visitor gets) as a sign-in, so only a strong name counts for one of those.
    public enum Strength: Equatable, Sendable {
        case strong
        case weak
    }

    /// Words that name a sign-in, anywhere in the name: `sb-xyz-auth-token`, `remember_user_token`,
    /// `wordpress_logged_in_…`, `jwt`.
    private static let strongWords = ["auth", "token", "login", "logged", "remember", "jwt"]
    /// `user_session`, `__session`, `_gh_sess`: a sign-in when it lasts, often a visitor's when it doesn't.
    private static let weakWords = ["session", "sess"]

    /// Names that are a sign-in whole: Google's (`SID`, `HSID`, `SSID`, `APISID`, `SAPISID`; `__Secure-1PSID` and its
    /// kind below), LinkedIn's `li_at`, and a bare `sid`.
    private static let signInNames: Set<String> = ["sid", "hsid", "ssid", "apisid", "sapisid", "li_at"]

    /// Names that look like one and aren't: GitHub's `logged_in` is set to `no` for every visitor.
    private static let notSignInNames: Set<String> = ["logged_in"]

    /// Never a sign-in, wherever they appear in a name: consent, CSRF, analytics and chat widgets, preferences.
    private static let notSignInWords = [
        "csrf", "xsrf", "consent", "gdpr", "cookieyes", "optanon", "anon", "visitor", "guest", "intercom", "optimizely",
        "segment", "analytics", "amplitude", "mixpanel", "hubspot", "utm", "datadome", "recaptcha", "captcha", "locale",
        "language", "theme", "timezone", "tracking",
    ]

    /// Never a sign-in, at the start of a name: analytics ids, and a CDN's or payment widget's bot checks.
    private static let notSignInPrefixes = [
        "_ga", "_gid", "_gcl", "_fbp", "_fbc", "ajs_", "amp_", "mp_", "_hj", "ph_", "__hs", "_uet", "_clck", "_clsk",
        "__cf", "cf_", "_cfuvid", "__stripe", "_pk_", "_dd_s",
    ]

    /// Whether a cookie's name says sign-in, and how surely; nil when it doesn't.
    public static func signIn(_ name: String) -> Strength? {
        let name = name.lowercased()
        if signInNames.contains(name) { return .strong }
        // Google's secure variants: __Secure-1PSID, __Secure-3PSID, __Secure-1PAPISID, __Secure-3PAPISID.
        if name.hasPrefix("__secure-"), name.hasSuffix("psid") || name.hasSuffix("papisid") { return .strong }
        if notSignInNames.contains(name) || notSignInPrefixes.contains(where: name.hasPrefix) || notSignInWords.contains(where: name.contains) {
            return nil
        }
        if strongWords.contains(where: name.contains) { return .strong }
        if weakWords.contains(where: name.contains) { return .weak }
        return nil
    }

    // MARK: Sites

    /// Second-level names under a country's domain that are a registry, not a site: `co.uk`, `com.au`, `ac.jp`.
    private static let registrySecondLevels: Set<String> = ["co", "com", "net", "org", "gov", "edu", "ac", "ne", "or", "go", "gv", "ltd", "plc", "nhs", "sch"]

    /// The site a cookie's domain belongs to: its last two labels, or three under a country's registry (`bbc.co.uk`).
    /// Nil for an IP address, a single label (`localhost`) or anything that isn't a host name.
    public static func site(ofCookieDomain domain: String) -> String? {
        var host = domain.lowercased().trimmingCharacters(in: .whitespaces)
        while host.hasPrefix(".") { host.removeFirst() }
        while host.hasSuffix(".") { host.removeLast() }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard labels.count >= 2, labels.allSatisfy(isLabel) else { return nil }
        // An IPv4 address is four numbers; a site's top-level domain is never one.
        if labels.last!.allSatisfy(\.isNumber) { return nil }
        let count = labels.count >= 3 && labels.last!.count == 2 && registrySecondLevels.contains(labels[labels.count - 2]) ? 3 : 2
        return labels.suffix(count).joined(separator: ".")
    }

    private static func isLabel(_ label: String) -> Bool {
        !label.isEmpty && label.count <= 63 && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// Whether a website-data record WebKit names (`fetchDataRecords`, its `displayName`) is the site's: the site itself
    /// or a host under it. Signing out of a site removes these.
    public static func record(_ displayName: String, belongsTo site: String) -> Bool {
        let name = displayName.lowercased()
        let site = site.lowercased()
        return name == site || name.hasSuffix("." + site)
    }

    // MARK: The report

    /// What the Mac app writes for the daemon (`browser-sign-ins.json`): each profile's sites and when they were read.
    public struct Report: Codable, Equatable, Sendable {
        public struct Profile: Codable, Equatable, Sendable {
            public let sites: [Site]
            /// Epoch ms.
            public let checkedAt: Double

            public init(sites: [Site], checkedAt: Double) {
                self.sites = sites
                self.checkedAt = checkedAt
            }
        }

        public var version = 1
        /// By profile id: `default`, or a profile's UUID.
        public var profiles: [String: Profile]

        public init(profiles: [String: Profile] = [:]) {
            self.profiles = profiles
        }
    }

    /// The report's name in conch's config folder (`~/.config/conch`, or `CONCH_CONFIG_DIR`).
    public static let reportFileName = "browser-sign-ins.json"
}
