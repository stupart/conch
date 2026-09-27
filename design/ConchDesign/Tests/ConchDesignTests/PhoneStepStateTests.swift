import XCTest
@testable import ConchDesign

/// The Mac's iPhone step for a phone that pairs and reports nothing (review 2026-09-28, #28): a phone paired before setup
/// existed, or its app reinstalled without its setup. The daemon publishes it paired, with no name, `paired` while it
/// may still report and `finished` once it hasn't (src/phone-setup.ts); the Mac shows it paired, with nothing to mirror,
/// and moves on, never "Setting itself up" for good.
final class PhoneStepStateTests: XCTestCase {
    /// What the daemon publishes for a phone that connected and stayed quiet.
    private let quiet = OnboardingReports.phoneHandoff(paired: true, device: nil, stage: "finished", declined: [])

    func testAQuietPhoneIsPairedWithNothingToMirrorAndDone() throws {
        let handoff = try XCTUnwrap(quiet)
        XCTAssertEqual(handoff, PhoneHandoff(device: nil, stage: .finished))
        XCTAssertTrue(OnboardingReports.phoneHasNothingToMirror(handoff))
        XCTAssertEqual(OnboardingReports.phoneStep(handoff: handoff, relay: true, failure: nil), .finished(handoff))
    }

    /// The Mac waiting on the iPhone step moves on by itself, as it does when a phone finishes its own setup.
    func testTheMacsStepMovesOnFromAQuietPhone() throws {
        let handoff = try XCTUnwrap(quiet)
        let atPhone = OnboardingProgress(step: .phone)
        let next = atPhone.applying(.phone(handoff), readiness: .fresh)
        XCTAssertNotEqual(next.step, .phone)
        XCTAssertEqual(next.marks[.phone], .done)
    }

    /// Just connected, it may still report: followed, with its rows, not yet done.
    func testAPhoneThatMayStillReportIsSettingItselfUp() throws {
        let handoff = try XCTUnwrap(OnboardingReports.phoneHandoff(paired: true, device: nil, stage: "paired", declined: []))
        XCTAssertFalse(OnboardingReports.phoneHasNothingToMirror(handoff))
        XCTAssertEqual(OnboardingReports.phoneStep(handoff: handoff, relay: true, failure: nil), .settingUp(handoff))
        XCTAssertEqual(OnboardingProgress(step: .phone).applying(.phone(handoff), readiness: .fresh).step, .phone)
    }

    /// A phone that reported is mirrored as before, finished or not.
    func testAPhoneThatReportedIsMirrored() throws {
        let finished = try XCTUnwrap(OnboardingReports.phoneHandoff(paired: true, device: "iPhone", stage: "finished", declined: ["microphone"]))
        XCTAssertFalse(OnboardingReports.phoneHasNothingToMirror(finished))
        let partway = try XCTUnwrap(OnboardingReports.phoneHandoff(paired: true, device: "iPhone", stage: "tour", declined: []))
        XCTAssertFalse(OnboardingReports.phoneHasNothingToMirror(partway))
        XCTAssertEqual(OnboardingReports.phoneStep(handoff: partway, relay: true, failure: nil), .settingUp(partway))
    }
}

/// The iPhone's own side: where its setup is, said again on each link (#28), and the scanner's words for a code it can't
/// read (#31).
final class PhoneSetupReportingTests: XCTestCase {
    func testWhereItIsIsItsScreensStageOrFinished() {
        XCTAssertNil(PhoneSetupFlow().reportable, "Connecting: the Mac sees that for itself")
        var flow = PhoneSetupFlow()
        flow.linked()
        XCTAssertEqual(flow.reportable, .paired)
        flow.acknowledge(.paired, mac: nil)
        XCTAssertNil(flow.unreported)
        XCTAssertEqual(flow.reportable, .paired, "said again on the next link, though the Mac has answered it")
        flow.next()
        XCTAssertEqual(flow.reportable, .microphone)
        let done = PhoneSetupFlow(screen: .done, finished: true, acknowledged: .finished)
        XCTAssertEqual(done.reportable, .finished)
        XCTAssertNil(done.unreported)
        // "Open conch" was tapped: finished, whatever screen the saved flow was left on.
        XCTAssertEqual(PhoneSetupFlow(screen: .tour, finished: true).reportable, .finished)
        XCTAssertEqual(PhoneSetupFlow(screen: .connecting, finished: true).reportable, .finished)
    }

    func testAnUnreadableCodeIsSaidPlainly() {
        let words = PhoneScanner.unreadableCode
        XCTAssertFalse(words.isEmpty)
        for jargon in ["relay", "base64", "JSON", "payload", "decode", "error"] {
            XCTAssertFalse(words.localizedCaseInsensitiveContains(jargon), jargon)
        }
    }
}
