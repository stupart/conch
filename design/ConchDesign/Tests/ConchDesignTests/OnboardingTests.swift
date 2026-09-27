import XCTest
@testable import ConchDesign

/// First-run setup's rules: what opens at launch, what Continue and Skip do, the phone handing back to the Mac, and
/// nothing lost when the window closes or conch reopens for a grant.
final class OnboardingTests: XCTestCase {
    private let fresh = OnboardingReadiness.fresh
    /// Claude Code wired, Codex found and not, the microphone allowed, two others off.
    private let partway = OnboardingReadiness(agentsFound: 2, agentsConnected: 1, microphone: true, permissionsMissing: 2)

    private func run(_ events: [OnboardingEvent], from start: OnboardingProgress = .init(), readiness: OnboardingReadiness? = nil) -> OnboardingProgress {
        events.reduce(start) { $0.applying($1, readiness: readiness ?? fresh) }
    }

    // MARK: Launch

    func testAFreshMacGetsTheWholeFlow() {
        XCTAssertEqual(OnboardingProgress.entry(nil, readiness: fresh), .firstRun)
    }

    /// Set up by hand, or by a conch older than setup: only what is still missing, and never the practice round.
    func testSomeoneWhoSetUpBeforeSeesOnlyWhatIsMissing() {
        XCTAssertEqual(OnboardingProgress.entry(nil, readiness: partway), .welcomeBack(missing: [.agents, .permissions, .voice, .phone]))
        let complete = OnboardingReadiness(agentsFound: 1, agentsConnected: 1, microphone: true, permissionsMissing: 0,
                                           engineReady: true, phonePaired: true)
        XCTAssertEqual(OnboardingProgress.entry(nil, readiness: complete), .none, "nothing missing, nothing shown")
    }

    func testAnInterruptedSetupResumesWhereItWas() {
        let progress = run([.begin, .next])
        XCTAssertEqual(progress.step, .permissions)
        XCTAssertEqual(OnboardingProgress.entry(progress, readiness: fresh), .resume(.permissions))
    }

    /// Closing the window part way is "later", not "never": it stays shut, and the menu counts what is left.
    func testClosingPutsItAwayAndTheMenuCountsWhatIsLeft() {
        let progress = run([.begin, .next, .close])
        XCTAssertEqual(OnboardingProgress.entry(progress, readiness: fresh), .none)
        XCTAssertTrue(progress.putAway)
        XCTAssertEqual(progress.left, 4)
        XCTAssertEqual(progress.step, .permissions, "reopening from the menu lands where it was")
        XCTAssertFalse(progress.applying(.open(.permissions), readiness: fresh).putAway)
    }

    /// Screen Recording only reaches a new process: conch quits and reopens, and comes straight back to the step.
    func testReopeningForAGrantComesBackToTheSameStep() {
        let before = run([.begin, .next, .reopenForGrant])
        XCTAssertEqual(OnboardingProgress.entry(before, readiness: fresh), .resume(.permissions))
        let after = before.applying(.launched, readiness: fresh)
        XCTAssertFalse(after.reopening)
        XCTAssertEqual(after.step, .permissions)
    }

    // MARK: Moving through

    func testContinueWalksTheRailToTheEnd() {
        let progress = run([.begin, .next, .next, .next, .next, .next])
        XCTAssertEqual(progress.step, .done)
        XCTAssertTrue(progress.finished)
        XCTAssertEqual(progress.left, 0)
        XCTAssertEqual(OnboardingProgress.entry(progress, readiness: fresh), .none)
    }

    func testSkipLeavesAStepForLaterWithoutBlockingTheEnd() {
        let progress = run([.begin, .next, .skip, .next, .skip, .next])
        XCTAssertEqual(progress.step, .done)
        XCTAssertEqual(progress.mark(.permissions), .later)
        XCTAssertEqual(progress.mark(.phone), .later)
        XCTAssertEqual(progress.left, 2)
    }

    /// A step already true on this Mac is ticked on the way past rather than asked about.
    func testStepsAlreadyTrueAreTickedAndPassed() {
        let paired = OnboardingReadiness(agentsFound: 1, agentsConnected: 1, microphone: false, phonePaired: true)
        let progress = run([.begin], readiness: paired)
        XCTAssertEqual(progress.step, .permissions, "agents are already wired")
        XCTAssertEqual(progress.mark(.agents), .done)
        let later = run([.next, .next], from: progress, readiness: paired)
        XCTAssertEqual(later.step, .practice, "the phone was already paired")
        XCTAssertEqual(later.mark(.phone), .done)
    }

    func testSkippingPastAFinishedStepDoesNotUnfinishIt() {
        var progress = run([.begin, .next, .next])
        progress = run([.open(.agents), .skip], from: progress)
        XCTAssertEqual(progress.mark(.agents), .done)
    }

    // MARK: The phone

    /// The phone finishing its own setup while the Mac waits on the iPhone step moves the Mac on by itself.
    func testThePhoneFinishingMovesTheWaitingMacOn() {
        var progress = run([.begin, .next, .next, .next])
        XCTAssertEqual(progress.step, .phone)
        progress = run([
            .phone(.init(stage: .connecting)),
            .phone(.init(device: "Tyler's iPhone", stage: .paired)),
            .phone(.init(device: "Tyler's iPhone", stage: .microphone, declined: [.notifications])),
        ], from: progress)
        XCTAssertEqual(progress.step, .phone, "still setting up on the phone")
        XCTAssertEqual(progress.phone.declined, [.notifications])
        progress = progress.applying(.phone(.init(device: "Tyler's iPhone", stage: .finished)), readiness: fresh)
        XCTAssertEqual(progress.step, .practice)
        XCTAssertEqual(progress.mark(.phone), .done)
    }

    func testThePhoneFinishingLateOnlyTicksTheStep() {
        var progress = run([.begin, .next, .next, .next, .skip])
        XCTAssertEqual(progress.step, .practice)
        progress = progress.applying(.phone(.init(device: "Tyler's iPhone", stage: .finished)), readiness: fresh)
        XCTAssertEqual(progress.step, .practice, "the Mac stays where the person is")
        XCTAssertEqual(progress.mark(.phone), .done)
    }

    func testALateReportNeverUndoesAStage() {
        var progress = run([.phone(.init(device: "Tyler's iPhone", stage: .tour))])
        progress = progress.applying(.phone(.init(device: "Tyler's iPhone", stage: .paired)), readiness: fresh)
        XCTAssertEqual(progress.phone.stage, .tour)
    }

    // MARK: Again, and on disk

    func testRunningSetupAgainStartsAtAgentsAndKeepsThePhone() {
        let finished = run([.begin, .next, .next, .next, .phone(.init(device: "Tyler's iPhone", stage: .finished)), .next])
        XCTAssertTrue(finished.finished)
        let again = finished.applying(.restart, readiness: fresh)
        XCTAssertEqual(again.step, .agents)
        XCTAssertFalse(again.finished)
        XCTAssertEqual(again.phone.device, "Tyler's iPhone")
    }

    func testItSurvivesARoundTripThroughJSON() throws {
        let progress = run([.begin, .next, .skip, .phone(.init(device: "Tyler's iPhone", stage: .microphone, declined: [.notifications]))])
        let data = try JSONEncoder().encode(progress)
        XCTAssertEqual(try JSONDecoder().decode(OnboardingProgress.self, from: data), progress)
        // Readable on disk: the marks are keyed by step name, not an array of pairs.
        let json = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(json.contains("\"permissions\":\"later\""), json)
    }
}
