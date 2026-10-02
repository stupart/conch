import Foundation
import XCTest
@testable import ConchDesign

/// A live page's login wall as the apps say it (PageAccess.swift): the phone's caption under the Mac's picture, its note
/// when the live page needs a sign-in it doesn't have, and the Mac's banner when conch itself was asked to sign in.
final class PageAccessTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!
    private let posix = Locale(identifier: "en_US_POSIX")

    func testTheCaptionSaysWhoseViewItIsAndWhenItWasDrawn() {
        let drawn = Date(timeIntervalSince1970: 1_790_000_000) // 2026-09-21 14:13 UTC
        // ICU puts a narrow no-break space before the day period; the words are what is checked.
        let today = PageAccess.snapshotCaption(capturedAt: drawn, now: drawn.addingTimeInterval(600), locale: posix, timeZone: utc)
        XCTAssertEqual(today.replacingOccurrences(of: "\u{202F}", with: " "), "conch's view on your Mac at 2:13 PM")
        let yesterday = PageAccess.snapshotCaption(capturedAt: drawn, now: drawn.addingTimeInterval(86_400), locale: posix, timeZone: utc)
        XCTAssertTrue(yesterday.hasPrefix("conch's view on your Mac, Sep 21"), yesterday)
    }

    func testThePhoneSaysTheLivePageNeedsSignInOnlyWhenTheLookWithoutCookiesWasAskedTo() {
        XCTAssertEqual(PageAccess.phoneNote(.init(mac: .page, anonymous: .signIn)), PageAccess.phoneSignInNote)
        XCTAssertNil(PageAccess.phoneNote(.init(mac: .page, anonymous: .page)))
        XCTAssertNil(PageAccess.phoneNote(.init(mac: .signIn, anonymous: .unchecked)))
        XCTAssertNil(PageAccess.phoneNote(nil))
    }

    func testTheMacSaysSignInHereOnlyWhenItsOwnLookWasAskedTo() {
        XCTAssertEqual(PageAccess.macBanner(.init(mac: .signIn, anonymous: .signIn)), PageAccess.macSignInBanner)
        XCTAssertNil(PageAccess.macBanner(.init(mac: .page, anonymous: .signIn)))
        XCTAssertNil(PageAccess.macBanner(nil))
        XCTAssertTrue(PageAccess.macSignInBanner.contains("Sign in here once"))
    }

    func testWhatADeliverableCarriesIsReadAndAStateThisBuildDoesntKnowIsUnchecked() throws {
        let found = try JSONDecoder().decode(PageAccess.Found.self, from: Data(#"{"mac":"page","anonymous":"sign-in"}"#.utf8))
        XCTAssertEqual(found, .init(mac: .page, anonymous: .signIn))
        let newer = try JSONDecoder().decode(PageAccess.Found.self, from: Data(#"{"mac":"captcha","anonymous":"page"}"#.utf8))
        XCTAssertEqual(newer, .init(mac: .unchecked, anonymous: .page))
    }
}
