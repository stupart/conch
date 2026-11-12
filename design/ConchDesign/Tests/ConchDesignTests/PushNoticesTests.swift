import XCTest
@testable import ConchDesign

/// Notices (daemon notify-user.ts, 2026-11-10): what both apps read of one, where a tap goes, which the Mac posts, and
/// what Settings › Phone app says of push. The key and tokens here are made up.
final class PushNoticesTests: XCTestCase {
    private func notice(_ id: String, at: Double, session: String? = nil, link: String? = nil, target: String? = nil) -> ConchNotice {
        ConchNotice(id: id, title: "Deploy", body: "It's live.", sessionId: session, link: link, target: target, at: at)
    }

    func testTheSessionsFilesNoticesDecode() throws {
        let json = #"{"id":"n1","title":"Deploy","body":"It's live.","sessionId":"s1","link":"https://example.com/pr/1","at":1793000000000,"source":"agent"}"#
        let decoded = try JSONDecoder().decode(ConchNotice.self, from: Data(json.utf8))
        XCTAssertEqual(decoded, notice("n1", at: 1_793_000_000_000, session: "s1", link: "https://example.com/pr/1"))
    }

    func testEachNoticeIsPostedOnceAcrossLaunches() {
        let first = notice("a", at: 2)
        let second = notice("b", at: 1)
        XCTAssertEqual(NoticePosting.due([first, second], posted: []), [second, first])
        let posted = NoticePosting.remember([second, first], in: [])
        XCTAssertEqual(NoticePosting.due([first, second], posted: posted), [])
        XCTAssertEqual(NoticePosting.due([first, notice("c", at: 3)], posted: posted).map(\.id), ["c"])
        // Kept to the newest few dozen.
        let many = (0..<100).map { notice("n\($0)", at: Double($0)) }
        let kept = NoticePosting.remember(many, in: posted)
        XCTAssertEqual(kept.count, NoticePosting.remembered)
        XCTAssertEqual(kept.last, "n99")
    }

    func testATapGoesToTheSessionThenSettingsThenTheApp() {
        XCTAssertEqual(NoticeRoute.from(userInfo: ["aps": ["alert": "x"], "conch": ["notice": "n1", "session": "s1"]]), .session("s1"))
        XCTAssertEqual(NoticeRoute.from(userInfo: ["conch": ["notice": "n1", "target": "providers"]]), .providers)
        XCTAssertEqual(NoticeRoute.from(userInfo: ["conch": ["notice": "n1"]]), .app)
        XCTAssertEqual(NoticeRoute.from(userInfo: [:]), .app)
        XCTAssertEqual(NoticeRoute.from(userInfo: ["conch": ["session": ""]]), .app)
        XCTAssertEqual(NoticeRoute.noticeID(userInfo: ["conch": ["notice": "n1"]]), "n1")
    }

    func testOnlyAnHTTPLinkIsOpened() {
        XCTAssertEqual(NoticeRoute.link(userInfo: ["conch": ["link": "https://example.com/pr/1"]]), URL(string: "https://example.com/pr/1"))
        XCTAssertEqual(NoticeRoute.link(userInfo: ["conch": ["link": "http://localhost:3000"]]), URL(string: "http://localhost:3000"))
        XCTAssertNil(NoticeRoute.link(userInfo: ["conch": ["link": "file:///etc/hosts"]]))
        XCTAssertNil(NoticeRoute.link(userInfo: ["conch": ["link": "conch://evil"]]))
        XCTAssertNil(NoticeRoute.link(userInfo: [:]))
    }

    func testTheMacsNotificationIsInThePhonesShape() {
        let mac = NoticeRoute.userInfo(for: notice("n1", at: 1, session: "s1", link: "https://example.com"))
        XCTAssertEqual(NoticeRoute.from(userInfo: mac), .session("s1"))
        XCTAssertEqual(NoticeRoute.link(userInfo: mac), URL(string: "https://example.com"))
        XCTAssertEqual(NoticeRoute.noticeID(userInfo: mac), "n1")
        XCTAssertEqual(NoticeRoute.from(userInfo: NoticeRoute.userInfo(for: notice("n2", at: 1, target: "providers"))), .providers)
    }

    func testPushStatusSaysWhereItStandsInOneLine() throws {
        XCTAssertEqual(PushSetupStatus().statusLine, "Push: not set up")
        let key = PushSetupStatus.Key(keyId: "ABCDE12345", teamId: "FGHIJ67890", addedAt: 1)
        XCTAssertEqual(PushSetupStatus(key: key).statusLine, "Push: ready · waiting for the iPhone to turn notifications on")
        let phone = PushSetupStatus.Device(device: "iPhone", environment: "production", alerts: true, registeredAt: 1, token: "…c0ffee", lastSentAt: nil, lastError: nil)
        XCTAssertEqual(PushSetupStatus(key: key, devices: [phone]).statusLine, "Push: ready · iPhone")
        let off = PushSetupStatus.Device(device: "iPhone", environment: "production", alerts: false, registeredAt: 1, token: "…c0ffee", lastSentAt: nil, lastError: nil)
        XCTAssertEqual(PushSetupStatus(key: key, devices: [off]).statusLine, "Push: ready · notifications are off on the iPhone")
        let refused = PushSetupStatus(key: key, devices: [phone], lastError: "Apple refused the key (InvalidProviderToken)")
        XCTAssertEqual(refused.statusLine, "Push: last error · Apple refused the key (InvalidProviderToken)")
        XCTAssertTrue(refused.troubled)
        XCTAssertFalse(PushSetupStatus(key: key, devices: [phone]).troubled)

        let json = #"{"kind":"push-status","key":{"keyId":"ABCDE12345","teamId":"FGHIJ67890","addedAt":1},"devices":[{"device":"iPhone","environment":"development","alerts":true,"registeredAt":2,"token":"…c0ffee","lastSentAt":3}],"test":{"kind":"notify-result","outcome":"sent","said":"Pushed to the phone (iPhone)."}}"#
        let decoded = try JSONDecoder().decode(PushSetupStatus.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.key, key)
        XCTAssertEqual(decoded.devices.first?.lastSentAt, 3)
        XCTAssertEqual(decoded.test, NotifyOutcome(outcome: "sent", said: "Pushed to the phone (iPhone)."))
    }

    func testTheKeysIdsAndTheKeyAreCheckedAsTheDaemonChecksThem() {
        XCTAssertEqual(PushKeyInput.appleID(" abcde12345\n"), "ABCDE12345")
        XCTAssertNil(PushKeyInput.appleID("ABCDE1234"))
        XCTAssertNil(PushKeyInput.appleID("ABCDE-1234"))
        XCTAssertEqual(PushKeyInput.keyID(fromFileName: "AuthKey_ABCDE12345.p8"), "ABCDE12345")
        XCTAssertNil(PushKeyInput.keyID(fromFileName: "key.p8"))
        // A made-up P-256 key's shape: 184 base64 characters, wrapped as a PEM.
        let body = String(repeating: "MIGHAgEAMBMGByqGSM49", count: 9) + "AgEGCA=="
        let pem = "-----BEGIN PRIVATE KEY-----\n\(body.prefix(64))\n\(body.dropFirst(64).prefix(64))\n\(body.dropFirst(128))\n-----END PRIVATE KEY-----\n"
        XCTAssertEqual(PushKeyInput.key(pem), pem.trimmingCharacters(in: .whitespacesAndNewlines))
        XCTAssertEqual(PushKeyInput.key(body), body)
        for bad in ["", "hello", "-----BEGIN PRIVATE KEY-----\nnot base64!\n-----END PRIVATE KEY-----", String(repeating: "A", count: 500)] {
            XCTAssertNil(PushKeyInput.key(bad), bad)
        }
        XCTAssertFalse(PushKeyInput.keyProblem.contains("MIG"))
    }

    func testTheEnvironmentIsTheProfiles() {
        func profile(_ environment: String?) -> Data {
            let entitlements = environment.map { "<key>aps-environment</key><string>\($0)</string>" } ?? ""
            let plist = #"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Entitlements</key><dict>"# + entitlements + "</dict></dict></plist>"
            // The CMS envelope's bytes either side, as a real profile has.
            return Data([0x30, 0x82, 0x0f, 0x00]) + Data(plist.utf8) + Data([0xa0, 0x82, 0x00])
        }
        XCTAssertEqual(PushEnvironment.from(provisioningProfile: profile("development"), debugBuild: false), "development")
        XCTAssertEqual(PushEnvironment.from(provisioningProfile: profile("production"), debugBuild: true), "production")
        // No push in the profile: the build's kind decides.
        XCTAssertEqual(PushEnvironment.from(provisioningProfile: profile(nil), debugBuild: true), "development")
        // No profile at all: an App Store or TestFlight build.
        XCTAssertEqual(PushEnvironment.from(provisioningProfile: nil, debugBuild: false), "production")
        XCTAssertEqual(PushEnvironment.from(provisioningProfile: Data("garbage".utf8), debugBuild: false), "production")
    }

    func testThePhoneOffersOnlyWhenTheMacCanPushAndIOSHasntBeenAsked() {
        XCTAssertTrue(PushOffer.shows(macReady: true, authorization: .notAsked, dismissed: false))
        XCTAssertFalse(PushOffer.shows(macReady: false, authorization: .notAsked, dismissed: false))
        XCTAssertFalse(PushOffer.shows(macReady: true, authorization: .allowed, dismissed: false))
        XCTAssertFalse(PushOffer.shows(macReady: true, authorization: .denied, dismissed: false))
        XCTAssertFalse(PushOffer.shows(macReady: true, authorization: .notAsked, dismissed: true))
    }
}
