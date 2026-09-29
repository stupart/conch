import XCTest
@testable import ConchDesign

final class StartAccountsTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let account = StartAccountProfile(id: "work", label: "Work", status: "signed-in", email: "work@example.com")
    private func stamp(_ seconds: Double = 0) -> String { ISO8601DateFormatter().string(from: now.addingTimeInterval(seconds)) }
    private func window(_ pct: Double, reset: Double? = 3600, name: String = "5 hour") -> StartAccountWindow {
        StartAccountWindow(name: name, pct: pct, resetsAt: reset.map(stamp))
    }
    private func reading(_ windows: [StartAccountWindow], age: Double = 0, lastGood: Bool = false,
                         status: String = "ok") -> StartAccountUsage {
        StartAccountUsage(id: "work", status: status, windows: windows, fetchedAt: stamp(-age), lastGood: lastGood)
    }
    private func evaluate(_ usage: StartAccountUsage?) -> StartAccountAvailability {
        .evaluate(account: account, usage: usage, now: now)
    }

    func testFreshExhaustionDisablesAndUsesLatestOfExhaustedResets() {
        let result = evaluate(reading([window(100), window(100, reset: 7200, name: "7 day")]))
        XCTAssertEqual(result, .limitReached(now.addingTimeInterval(7200)))
        XCTAssertTrue(result.blocksStart(allowAtLimit: false))
        XCTAssertFalse(result.blocksStart(allowAtLimit: true))
    }
    func testZeroUsageIsReportedAndDifferentFromNoReading() {
        XCTAssertEqual(evaluate(reading([window(0)])), .reported)
        XCTAssertEqual(evaluate(nil), .unknown)
        XCTAssertEqual(evaluate(reading([])), .unknown)
        XCTAssertFalse(evaluate(nil).blocksStart(allowAtLimit: false))
    }
    func testStaleFullOrLastGoodReadingNeverBlocks() {
        XCTAssertEqual(evaluate(reading([window(100)], age: 301)), .stale)
        XCTAssertEqual(evaluate(reading([window(100)], lastGood: true)), .stale)
        XCTAssertFalse(evaluate(reading([window(100)], age: 301)).blocksStart(allowAtLimit: false))
    }
    func testBoundaryAndFutureClockSkew() {
        XCTAssertTrue(evaluate(reading([window(100)], age: 300)).blocksStart(allowAtLimit: false))
        XCTAssertEqual(evaluate(reading([window(100)], age: -61)), .stale)
    }
    func testExpiredOrMissingResetIsUnknownAndNeverInventsEmptyPlan() {
        for reset: Double? in [nil, 0, -1] {
            XCTAssertEqual(evaluate(reading([window(100, reset: reset)])), .unknown)
        }
    }
    func testTimePassingUnlocksOldReadingWithoutNewNetworkRequest() {
        let usage = reading([window(100, reset: 60)])
        XCTAssertTrue(evaluate(usage).blocksStart(allowAtLimit: false))
        let afterReset = StartAccountAvailability.evaluate(account: account, usage: usage, now: now.addingTimeInterval(61))
        XCTAssertEqual(afterReset, .unknown)
        XCTAssertFalse(afterReset.blocksStart(allowAtLimit: false))
    }
    func testModelSpecificLimitDoesNotDisableEntireAccount() {
        XCTAssertEqual(evaluate(reading([window(15), window(100, name: "Review · 5 hour")])), .reported)
        XCTAssertEqual(evaluate(reading([window(100, name: "Review · 5 hour")])), .unknown)
    }
    func testMalformedPercentagesDoNotEstablishCapacity() {
        for pct in [Double.nan, Double.infinity, -1, 101] {
            XCTAssertEqual(evaluate(reading([window(pct)])), .unknown)
        }
    }
    func testSignInAndMissingAccountCannotBeOverridden() {
        let signedOut = StartAccountProfile(id: "work", label: "Work", status: "signed-out")
        XCTAssertEqual(StartAccountAvailability.evaluate(account: signedOut, usage: reading([window(0)]), now: now), .signIn)
        XCTAssertTrue(StartAccountAvailability.signIn.blocksStart(allowAtLimit: true))
        let catalog = StartAccountCatalog(accounts: [account])
        XCTAssertEqual(catalog.availability(for: "removed", now: now), .missing)
        XCTAssertTrue(catalog.availability(for: "removed", now: now).blocksStart(allowAtLimit: true))
    }
    func testApiBillingDoesNotPretendToHaveSubscriptionCapacity() {
        XCTAssertEqual(evaluate(reading([], status: "api_key")), .apiBilling)
        XCTAssertFalse(evaluate(reading([], status: "api_key")).blocksStart(allowAtLimit: false))
    }
    func testHandoffRequiresConfirmedSignInButOriginalMayUseUnknownStatus() {
        let unchecked = StartAccountProfile(id: "work", label: "Work", status: "unchecked")
        let catalog = StartAccountCatalog(accounts: [unchecked])
        XCTAssertEqual(catalog.availability(for: "work", now: now, sourceAccountId: "default"), .signIn)
        XCTAssertEqual(catalog.availability(for: "work", now: now, sourceAccountId: "work"), .unknown)
        XCTAssertEqual(catalog.availability(for: "work", now: now), .unknown)
    }
    func testCatalogJoinsUsageByAccountIdNotPositionAndAcceptsMissingUsage() throws {
        let data = Data("""
        {"accounts":[{"id":"work","label":"Work","status":"signed-in","email":"work@example.com","configDir":"/not/needed/on/phone"}],
         "usage":{"accounts":[{"id":"personal","status":"ok","windows":[],"lastGood":false}]}}
        """.utf8)
        let catalog = try JSONDecoder().decode(StartAccountCatalog.self, from: data)
        XCTAssertEqual(catalog.accounts.first?.email, "work@example.com")
        XCTAssertNil(catalog.usage(for: "work"))
        XCTAssertEqual(catalog.availability(for: "work", now: now), .unknown)
        let oldReply = try JSONDecoder().decode(StartAccountCatalog.self, from: Data("{\"accounts\":[]}".utf8))
        XCTAssertNil(oldReply.usage)
    }
}
