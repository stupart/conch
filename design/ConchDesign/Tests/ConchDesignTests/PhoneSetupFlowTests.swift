import XCTest
@testable import ConchDesign

/// The iPhone's own setup: the screens in order, what each tells the Mac, a no that doesn't stop it, and a dropped link
/// or a relaunch coming back to the same place with the Mac caught up.
final class PhoneSetupFlowTests: XCTestCase {
    func testTheScreensRunConnectedMicrophoneTourDoneWithNoNotifications() {
        var flow = PhoneSetupFlow()
        var seen: [PhoneSetupScreen] = [flow.screen]
        flow.linked()
        seen.append(flow.screen)
        for _ in 0..<5 {
            flow.next()
            if seen.last != flow.screen { seen.append(flow.screen) }
        }
        XCTAssertEqual(seen, [.connecting, .connected, .microphone, .tour, .done])
        XCTAssertFalse(flow.finished, "the done screen waits for Open conch")
        flow.next()
        XCTAssertTrue(flow.finished)
        XCTAssertFalse(flow.showing)
    }

    /// What the phone reports is what the Mac mirrors, then finished: never notifications, never connecting.
    func testEachScreenReportsTheStageTheMacMirrors() {
        XCTAssertEqual(PhoneSetupScreen.allCases.compactMap(\.reports), PhoneSetupStage.mirrored + [.finished])
        XCTAssertNil(PhoneSetupScreen.connecting.reports)
        XCTAssertFalse(PhoneSetupScreen.allCases.compactMap(\.reports).contains(.notifications))
    }

    func testConnectingWaitsForTheLinkAndContinueCannotSkipIt() {
        var flow = PhoneSetupFlow()
        flow.next()
        XCTAssertEqual(flow.screen, .connecting)
        XCTAssertNil(flow.unreported, "nothing to tell a Mac there is no link to")
        flow.linked()
        XCTAssertEqual(flow.screen, .connected)
        flow.next()
        flow.linked()
        XCTAssertEqual(flow.screen, .microphone, "a link coming back later never moves the screen")
    }

    func testTheTourPagesThroughOrSkipsFromAnyPage() {
        var flow = PhoneSetupFlow(screen: .tour)
        flow.next()
        XCTAssertEqual(flow.tourPage, 1)
        flow.skipTour()
        XCTAssertEqual(flow.screen, .done)
        var paged = PhoneSetupFlow(screen: .tour)
        paged.next(); paged.next()
        XCTAssertEqual(paged.screen, .tour)
        XCTAssertEqual(paged.tourPage, 2)
        paged.next()
        XCTAssertEqual(paged.screen, .done)
        var elsewhere = PhoneSetupFlow(screen: .microphone)
        elsewhere.skipTour()
        XCTAssertEqual(elsewhere.screen, .microphone)
    }

    /// Saying no carries on, and is reported, and named on the done screen.
    func testTurningDownTheMicrophoneCarriesOnAndIsSaid() {
        var flow = PhoneSetupFlow(screen: .microphone)
        flow.answeredMicrophone(microphone: false, speech: false)
        XCTAssertEqual(flow.screen, .tour)
        XCTAssertEqual(flow.declined, [.microphone])
        XCTAssertEqual(flow.declinedSentences, ["The microphone is off."])

        var speechOnly = PhoneSetupFlow(screen: .microphone)
        speechOnly.answeredMicrophone(microphone: true, speech: false)
        XCTAssertEqual(speechOnly.declined, [.microphone], "Talk needs both")
        XCTAssertEqual(speechOnly.declinedSentences, ["Speech recognition is off, so Talk is too."])

        var allowed = PhoneSetupFlow(screen: .microphone)
        allowed.answeredMicrophone(microphone: true, speech: true)
        XCTAssertEqual(allowed.declined, [])
        XCTAssertEqual(allowed.declinedSentences, [])
    }

    /// Each stage is told once the link is up, and told again after a drop until the Mac has answered it.
    func testTheMacIsToldEachStageUntilItAnswers() {
        var flow = PhoneSetupFlow()
        flow.linked()
        XCTAssertEqual(flow.unreported, .paired)
        flow.acknowledge(.paired, mac: "Tyler's MacBook Pro")
        XCTAssertNil(flow.unreported)
        XCTAssertEqual(flow.macName, "Tyler's MacBook Pro")
        flow.next()
        flow.next()
        XCTAssertEqual(flow.unreported, .tour, "the microphone screen went by while the link was down; the Mac hears where the phone is now")
        flow.acknowledge(.microphone, mac: nil)
        XCTAssertEqual(flow.unreported, .tour)
        flow.acknowledge(.tour, mac: nil)
        flow.skipTour()
        XCTAssertEqual(flow.unreported, .finished)
        flow.acknowledge(.finished, mac: nil)
        flow.next()
        XCTAssertNil(flow.unreported)
        flow.acknowledge(.paired, mac: nil)
        XCTAssertEqual(flow.acknowledged, .finished, "a late answer never lowers what the Mac has heard")
    }

    func testBeforeTheMacSaysItsNameItIsYourMac() {
        XCTAssertEqual(PhoneSetupFlow().macName, "your Mac")
        XCTAssertEqual(PhoneSetupFlow().macNameStartingASentence, "Your Mac")
        XCTAssertEqual(PhoneSetupFlow(mac: "Tyler's MacBook Pro").macNameStartingASentence, "Tyler's MacBook Pro")
        var flow = PhoneSetupFlow()
        flow.acknowledge(.paired, mac: "")
        XCTAssertEqual(flow.macName, "your Mac")
    }

    /// Pairing again part way starts over; a phone that finished only tells the new Mac it's done.
    func testPairingAgain() {
        var partway = PhoneSetupFlow(screen: .tour, tourPage: 1, declined: [.microphone], mac: "Old Mac", acknowledged: .tour)
        partway.paired()
        XCTAssertEqual(partway, PhoneSetupFlow())
        XCTAssertTrue(partway.showing)

        var done = PhoneSetupFlow(screen: .done, declined: [.microphone], finished: true, mac: "Old Mac", acknowledged: .finished)
        done.paired()
        XCTAssertFalse(done.showing, "straight to the app")
        XCTAssertNil(done.mac)
        XCTAssertEqual(done.unreported, .finished, "the new Mac hears it's done, once")
        XCTAssertEqual(done.declined, [.microphone])
    }

    func testItSurvivesARoundTripThroughJSON() throws {
        var flow = PhoneSetupFlow()
        flow.linked()
        flow.acknowledge(.paired, mac: "Tyler's MacBook Pro")
        flow.next()
        flow.answeredMicrophone(microphone: true, speech: false)
        let data = try JSONEncoder().encode(flow)
        XCTAssertEqual(try JSONDecoder().decode(PhoneSetupFlow.self, from: data), flow)
    }
}
