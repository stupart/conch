import XCTest
@testable import ConchDesign

/// Telling which sites a conch browser profile is signed in to from its cookies' names, domains and expiry
/// (BrowserSignIns.swift). The names are real ones, from the sites they're named after.
final class BrowserSignInsTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_792_195_200) // 2026-10-16
    private var later: Date { now.addingTimeInterval(14 * 86_400) }
    private var earlier: Date { now.addingTimeInterval(-60) }

    private func cookie(_ name: String, _ domain: String, expires: Date?) -> BrowserSignIns.Cookie {
        BrowserSignIns.Cookie(name: name, domain: domain, expires: expires)
    }

    func testSignInNames() {
        for name in ["sb-abcdefgh-auth-token", "sb-abcdefgh-auth-token.0", "__Secure-next-auth.session-token", "remember_user_token",
                     "wordpress_logged_in_5f1c", "jwt", "SID", "SAPISID", "__Secure-1PSID", "__Secure-3PAPISID", "li_at",
                     "authToken", "AUTH_SESSION_ID"] {
            XCTAssertEqual(BrowserSignIns.signIn(name), .strong, name)
        }
        for name in ["user_session", "__session", "_gh_sess", "_myapp_session"] {
            XCTAssertEqual(BrowserSignIns.signIn(name), .weak, name)
        }
    }

    func testNamesThatAreNeverSignIns() {
        for name in ["csrftoken", "XSRF-TOKEN", "__Host-next-auth.csrf-token", "_ga", "_ga_ABC123", "_gid", "ajs_anonymous_id",
                     "intercom-session-abc", "__cf_bm", "cf_clearance", "_cfuvid", "__stripe_sid", "__stripe_mid",
                     "OptanonConsent", "logged_in", "mp_abc_mixpanel", "ph_phc_abc_posthog", "theme", "locale", "_hjSessionUser_1",
                     "anonymous_session", "visitor_token", "AWSALB", "conchprobe", "NID", "1P_JAR"] {
            XCTAssertNil(BrowserSignIns.signIn(name), name)
        }
    }

    func testSitesFromCookies() {
        let cookies = [
            cookie("sb-abc-auth-token", ".mobbin.com", expires: later),
            cookie("_ga", ".mobbin.com", expires: later),
            cookie("SID", ".google.com", expires: later),
            cookie("__Secure-1PSID", ".google.com", expires: later),
            cookie("user_session", "github.com", expires: later),
            cookie("logged_in", ".github.com", expires: later),
            // Only consent and analytics: not signed in.
            cookie("OptanonConsent", ".example.com", expires: later),
            cookie("_gid", ".example.com", expires: later),
        ]
        XCTAssertEqual(BrowserSignIns.sites(from: cookies, now: now).map(\.domain), ["github.com", "google.com", "mobbin.com"])
        XCTAssertTrue(BrowserSignIns.sites(from: cookies, now: now).allSatisfy { !$0.untilQuit })
    }

    func testAnExpiredSignInDoesntCount() {
        let cookies = [cookie("remember_token", ".old.example", expires: earlier)]
        XCTAssertEqual(BrowserSignIns.sites(from: cookies, now: now), [])
    }

    func testASignInUntilQuitIsMarked() {
        let cookies = [
            // A bank's sign-in that ends with the app: strong name, no expiry.
            cookie("auth_token", "secure.bank.example", expires: nil),
            // A framework's session cookie every visitor gets: not a sign-in on its own.
            cookie("_store_session", "shop.example", expires: nil),
            cookie("PHPSESSID", "forum.example", expires: nil),
        ]
        XCTAssertEqual(BrowserSignIns.sites(from: cookies, now: now), [BrowserSignIns.Site(domain: "bank.example", untilQuit: true)])
    }

    func testALastingCookieOutranksOneUntilQuit() {
        let cookies = [
            cookie("auth_token", "app.example.com", expires: nil),
            cookie("remember_me", ".example.com", expires: later),
        ]
        XCTAssertEqual(BrowserSignIns.sites(from: cookies, now: now), [BrowserSignIns.Site(domain: "example.com", untilQuit: false)])
    }

    func testSiteOfACookieDomain() {
        XCTAssertEqual(BrowserSignIns.site(ofCookieDomain: ".mobbin.com"), "mobbin.com")
        XCTAssertEqual(BrowserSignIns.site(ofCookieDomain: "accounts.google.com"), "google.com")
        XCTAssertEqual(BrowserSignIns.site(ofCookieDomain: "WWW.GitHub.com."), "github.com")
        XCTAssertEqual(BrowserSignIns.site(ofCookieDomain: ".bbc.co.uk"), "bbc.co.uk")
        XCTAssertEqual(BrowserSignIns.site(ofCookieDomain: "my.bank.com.au"), "bank.com.au")
        XCTAssertEqual(BrowserSignIns.site(ofCookieDomain: "app.vercel.app"), "vercel.app")
        XCTAssertNil(BrowserSignIns.site(ofCookieDomain: "localhost"))
        XCTAssertNil(BrowserSignIns.site(ofCookieDomain: "127.0.0.1"))
        XCTAssertNil(BrowserSignIns.site(ofCookieDomain: ""))
        XCTAssertNil(BrowserSignIns.site(ofCookieDomain: "a..b.com"))
        XCTAssertNil(BrowserSignIns.site(ofCookieDomain: "evil.com/path"))
    }

    func testRecordsThatBelongToASite() {
        XCTAssertTrue(BrowserSignIns.record("mobbin.com", belongsTo: "mobbin.com"))
        XCTAssertTrue(BrowserSignIns.record("api.mobbin.com", belongsTo: "mobbin.com"))
        XCTAssertFalse(BrowserSignIns.record("notmobbin.com", belongsTo: "mobbin.com"))
        XCTAssertFalse(BrowserSignIns.record("mobbin.com.evil.example", belongsTo: "mobbin.com"))
    }

    func testTheReportRoundTrips() throws {
        let report = BrowserSignIns.Report(profiles: [
            "default": .init(sites: [.init(domain: "mobbin.com"), .init(domain: "bank.example", untilQuit: true)], checkedAt: 1_792_195_200_000),
        ])
        let data = try JSONEncoder().encode(report)
        XCTAssertEqual(try JSONDecoder().decode(BrowserSignIns.Report.self, from: data), report)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["version"] as? Int, 1)
    }
}

final class SafariUserAgentTests: XCTestCase {
    func testTheVersionIsSafarisMajorAndMinor() {
        XCTAssertEqual(SafariUserAgent.version("26.6.2"), "26.6")
        XCTAssertEqual(SafariUserAgent.version("26"), "26.0")
        XCTAssertEqual(SafariUserAgent.version("18.3"), "18.3")
        XCTAssertEqual(SafariUserAgent.version(nil), "18.0")
        XCTAssertEqual(SafariUserAgent.version(""), "18.0")
        XCTAssertEqual(SafariUserAgent.version("beta"), "18.0")
        XCTAssertEqual(SafariUserAgent.version("26.x"), "26.0")
    }

    func testTheAgentIsSafarisShape() {
        XCTAssertEqual(
            SafariUserAgent.string(safariVersion: "26.6.2"),
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15"
        )
        XCTAssertTrue(SafariUserAgent.current.hasSuffix("Safari/605.1.15"))
    }
}
