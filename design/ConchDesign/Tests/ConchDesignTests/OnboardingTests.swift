import XCTest
@testable import ConchDesign

/// First-run setup's rules: what opens at launch, what Continue and Skip do, the phone handing back to the Mac, and
/// nothing lost when the window closes or conch reopens for a grant.
final class OnboardingTests: XCTestCase {
    private let fresh = OnboardingReadiness.fresh
    /// A fresh Mac with a daemon that runs the practice turn (`features.practice`): the rail has Try it.
    private let freshWithPractice = OnboardingReadiness(practiceAvailable: true)
    /// Claude Code wired, Codex found and not, the microphone allowed, two others off.
    private let partway = OnboardingReadiness(agentsFound: 2, agentsConnected: 1, microphone: true, permissionsMissing: 2)

    private func run(_ events: [OnboardingEvent], from start: OnboardingProgress = .init(), readiness: OnboardingReadiness? = nil) -> OnboardingProgress {
        events.reduce(start) { $0.applying($1, readiness: readiness ?? fresh) }
    }

    // MARK: Launch

    func testAFreshMacGetsTheWholeFlow() {
        XCTAssertEqual(OnboardingProgress.entry(nil, readiness: fresh), .firstRun)
    }

    /// Set up by hand, or by a conch older than setup: only what is still missing, and never the practice round. Agents
    /// are never missing for a returning Mac: one is wired, and leaving a second unwired was its own choice.
    func testSomeoneWhoSetUpBeforeSeesOnlyWhatIsMissing() {
        XCTAssertEqual(OnboardingProgress.entry(nil, readiness: partway), .welcomeBack(missing: [.permissions, .voice, .phone]))
        var practiced = partway
        practiced.practiceAvailable = true
        XCTAssertEqual(OnboardingProgress.entry(nil, readiness: practiced), .welcomeBack(missing: [.permissions, .voice, .phone]))
        let complete = OnboardingReadiness(agentsFound: 2, agentsConnected: 1, microphone: true, permissionsMissing: 0,
                                           engineReady: true, phonePaired: true)
        XCTAssertEqual(OnboardingProgress.entry(nil, readiness: complete), .none, "nothing missing, nothing shown")
        XCTAssertEqual(OnboardingProgress.entry(nil, readiness: OnboardingReadiness(agentsFound: 1, agentsConnected: 0, microphone: true)),
                       .firstRun, "no agent wired: not set up before")
    }

    /// Welcome back opens on the first thing missing, with what is already true ticked in the rail.
    func testWelcomeBackStartsOnWhatIsMissingWithTheRestTicked() {
        // Codex found and not wired: a returning Mac's agents are ticked all the same.
        let readiness = OnboardingReadiness(agentsFound: 2, agentsConnected: 1, microphone: true, permissionsMissing: 1, engineReady: true)
        guard case let .welcomeBack(missing) = OnboardingProgress.entry(nil, readiness: readiness) else { return XCTFail("not welcome back") }
        XCTAssertEqual(missing, [.permissions, .phone])
        let progress = OnboardingProgress.welcomingBack(missing: missing, readiness: readiness)
        XCTAssertEqual(progress.step, .permissions)
        XCTAssertEqual(progress.mark(.agents), .done)
        XCTAssertEqual(progress.mark(.voice), .done)
        XCTAssertEqual(progress.mark(.permissions), .todo)
        XCTAssertEqual(progress.mark(.phone), .todo)
        var practiced = readiness
        practiced.practiceAvailable = true
        XCTAssertEqual(OnboardingProgress.welcomingBack(missing: missing, readiness: practiced).mark(.practice), .todo, "never the practice turn")
        // Done is finished: nothing reminds. Not now puts it away, and the menu counts what is still off.
        let done = progress.applying(.finish, readiness: readiness)
        XCTAssertTrue(done.finished)
        XCTAssertEqual(OnboardingProgress.entry(done, readiness: readiness), .none)
        let notNow = progress.applying(.close, readiness: readiness)
        XCTAssertTrue(notNow.putAway)
        XCTAssertEqual(notNow.remaining(readiness), [.permissions, .phone])
    }

    // MARK: What setup asks for

    /// Setup asks for the three the voice loop needs; Screen Recording and Notifications are asked when first needed, so
    /// they never hold the step open, and an answer macOS can't give yet is not called off.
    func testPermissionsAreSatisfiedByTheThreeSetupAsksAlone() {
        XCTAssertEqual(OnboardingReadiness.setupAsks, [.microphone, .accessibility, .automation])
        XCTAssertEqual(OnboardingPermissionsStep.loop, OnboardingReadiness.setupAsks)
        var statuses: [ConchPermission: ConchPermissionStatus] = [
            .microphone: .granted, .accessibility: .granted, .automation: .granted, .screenRecording: .denied,
        ]
        XCTAssertEqual(OnboardingReadiness.permissionsMissing(statuses), 0, "Screen Recording off is not setup's to ask")
        let allowed = OnboardingReadiness(microphone: true, permissionsMissing: OnboardingReadiness.permissionsMissing(statuses))
        XCTAssertTrue(allowed.satisfies(.permissions))
        statuses[.automation] = .unknown("Terminal isn't open, so macOS can't say yet.")
        XCTAssertEqual(OnboardingReadiness.permissionsMissing(statuses), 0, "macOS can't say: not off")
        statuses[.automation] = nil
        XCTAssertEqual(OnboardingReadiness.permissionsMissing(statuses), 0, "not read yet: not off")
        statuses[.automation] = .restricted
        XCTAssertEqual(OnboardingReadiness.permissionsMissing(statuses), 0, "managed: nothing to ask")
        for off in [ConchPermissionStatus.denied, .notAsked, .needsRelaunch] {
            statuses[.accessibility] = off
            XCTAssertEqual(OnboardingReadiness.permissionsMissing(statuses), 1, "\(off)")
        }
        statuses[.microphone] = .notAsked
        XCTAssertEqual(OnboardingReadiness.permissionsMissing(statuses), 2)
        XCTAssertEqual(OnboardingReadiness.missingAsks(statuses), [.microphone, .accessibility], "in the order setup asks")
        XCTAssertFalse(OnboardingReadiness(microphone: false, permissionsMissing: 0).satisfies(.permissions), "the microphone is one of the three")
    }

    // MARK: Try it, only with a daemon that runs it

    /// With a daemon that can't run the practice turn the rail has no Try it: You're set follows iPhone, and nothing counts
    /// it. With one that can, Try it follows iPhone, and You're set follows Try it.
    func testWithoutThePracticeTurnTheRailEndsAtIPhone() {
        XCTAssertEqual(fresh.rail, [.agents, .permissions, .voice, .phone])
        XCTAssertEqual(freshWithPractice.rail, [.agents, .permissions, .voice, .phone, .practice])
        let atPhone = run([.begin, .next, .next, .next])
        XCTAssertEqual(atPhone.step, .phone)
        XCTAssertEqual(atPhone.applying(.next, readiness: fresh).step, .done, "You're set follows iPhone")
        XCTAssertEqual(atPhone.applying(.next, readiness: freshWithPractice).step, .practice)
        XCTAssertEqual(atPhone.remaining(fresh), [.phone])
        XCTAssertEqual(atPhone.remaining(freshWithPractice), [.phone, .practice])
        // The phone handing back moves a waiting Mac to the end, or to Try it.
        XCTAssertEqual(atPhone.applying(.phone(.init(device: "Tyler's iPhone", stage: .finished)), readiness: fresh).step, .done)
        XCTAssertEqual(atPhone.applying(.phone(.init(device: "Tyler's iPhone", stage: .finished)), readiness: freshWithPractice).step, .practice)
    }

    /// The tour closing is Try it's Continue: done, and You're set. Its own Skip leaves it for later, which the menu counts;
    /// Try it is never already true, so it is never ticked on the way past.
    func testTryItEndsOnYoureSetOrIsLeftForLater() {
        let atTry = run([.begin, .next, .next, .next, .next], readiness: freshWithPractice)
        XCTAssertEqual(atTry.step, .practice)
        let toured = atTry.applying(.next, readiness: freshWithPractice)
        XCTAssertEqual(toured.step, .done)
        XCTAssertEqual(toured.mark(.practice), .done)
        XCTAssertTrue(toured.finished)
        let skipped = atTry.applying(.skip, readiness: freshWithPractice)
        XCTAssertEqual(skipped.step, .done)
        XCTAssertEqual(skipped.mark(.practice), .later)
        XCTAssertEqual(skipped.remaining(freshWithPractice), [.practice])
        let everythingTrue = OnboardingReadiness(agentsFound: 1, agentsConnected: 1, microphone: true, permissionsMissing: 0,
                                                 engineReady: true, phonePaired: true, practiceAvailable: true)
        XCTAssertEqual(run([.begin], readiness: everythingTrue).step, .practice, "the one step a set-up Mac still shows")
        // Help › Take the tour after setup: Try it again, and its Continue ends where it began.
        let again = toured.applying(.open(.practice), readiness: freshWithPractice)
        XCTAssertEqual(again.step, .practice)
        XCTAssertEqual(again.applying(.next, readiness: freshWithPractice).step, .done)
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
        XCTAssertEqual(progress.remaining(fresh), [.permissions, .voice, .phone])
        XCTAssertEqual(progress.step, .permissions, "reopening from the menu lands where it was")
        XCTAssertFalse(progress.applying(.open(.permissions), readiness: fresh).putAway)
        // Something true by now isn't left: the permissions allowed later in System Settings drop off the count.
        let allowedLater = OnboardingReadiness(microphone: true, permissionsMissing: 0)
        XCTAssertEqual(progress.remaining(allowedLater), [.voice, .phone])
    }

    /// Screen Recording only reaches a new process: conch quits and reopens, and comes straight back to the step.
    func testReopeningForAGrantComesBackToTheSameStep() {
        let before = run([.begin, .next, .reopenForGrant])
        XCTAssertEqual(OnboardingProgress.entry(before, readiness: fresh), .resume(.permissions))
        let after = before.applying(.launched, readiness: fresh)
        XCTAssertFalse(after.reopening)
        XCTAssertEqual(after.step, .permissions)
    }

    /// Quitting to reopen closes the window on the way out: that close must not put setup away before it comes back.
    func testTheWindowClosingAsConchQuitsForAGrantStillComesBack() {
        let quitting = run([.begin, .next, .reopenForGrant, .close])
        XCTAssertEqual(OnboardingProgress.entry(quitting, readiness: fresh), .resume(.permissions))
    }

    // MARK: Moving through

    func testContinueWalksTheRailToTheEnd() {
        let progress = run([.begin, .next, .next, .next, .next, .next], readiness: freshWithPractice)
        XCTAssertEqual(progress.step, .done)
        XCTAssertTrue(progress.finished)
        XCTAssertEqual(progress.remaining(freshWithPractice), [])
        XCTAssertEqual(OnboardingProgress.entry(progress, readiness: freshWithPractice), .none)
    }

    func testSkipLeavesAStepForLaterWithoutBlockingTheEnd() {
        let progress = run([.begin, .next, .skip, .next, .skip, .next], readiness: freshWithPractice)
        XCTAssertEqual(progress.step, .done)
        XCTAssertEqual(progress.mark(.permissions), .later)
        XCTAssertEqual(progress.mark(.phone), .later)
        XCTAssertEqual(progress.remaining(freshWithPractice), [.permissions, .phone])
    }

    /// A stray Continue or Skip at the end (a double press) must not wind setup back to a step left for later.
    func testContinueAtTheEndStaysAtTheEnd() {
        let end = run([.begin, .next, .skip, .next, .next])
        XCTAssertEqual(end.step, .done)
        XCTAssertEqual(end.mark(.permissions), .later)
        XCTAssertEqual(end.applying(.next, readiness: fresh).step, .done)
        XCTAssertEqual(end.applying(.skip, readiness: fresh).step, .done)
        XCTAssertEqual(end.applying(.skip, readiness: fresh).marks, end.marks)
    }

    /// A step already true on this Mac is ticked on the way past rather than asked about.
    func testStepsAlreadyTrueAreTickedAndPassed() {
        let paired = OnboardingReadiness(agentsFound: 1, agentsConnected: 1, microphone: false, phonePaired: true)
        let progress = run([.begin], readiness: paired)
        XCTAssertEqual(progress.step, .permissions, "agents are already wired")
        XCTAssertEqual(progress.mark(.agents), .done)
        var withPractice = paired
        withPractice.practiceAvailable = true
        let later = run([.next, .next], from: progress, readiness: withPractice)
        XCTAssertEqual(later.step, .practice, "the phone was already paired")
        XCTAssertEqual(later.mark(.phone), .done)
        let withoutPractice = run([.next, .next], from: progress, readiness: paired)
        XCTAssertEqual(withoutPractice.step, .done, "and with no Try it yet, straight to the end")
        XCTAssertEqual(withoutPractice.mark(.phone), .done)
    }

    func testSkippingPastAFinishedStepDoesNotUnfinishIt() {
        var progress = run([.begin, .next, .next])
        progress = run([.open(.agents), .skip], from: progress)
        XCTAssertEqual(progress.mark(.agents), .done)
    }

    // MARK: The phone

    /// The phone finishing its own setup while the Mac waits on the iPhone step moves the Mac on by itself.
    func testThePhoneFinishingMovesTheWaitingMacOn() {
        var progress = run([.begin, .next, .next, .next], readiness: freshWithPractice)
        XCTAssertEqual(progress.step, .phone)
        progress = run([
            .phone(.init(stage: .connecting)),
            .phone(.init(device: "Tyler's iPhone", stage: .paired)),
            .phone(.init(device: "Tyler's iPhone", stage: .tour, declined: [.microphone])),
        ], from: progress, readiness: freshWithPractice)
        XCTAssertEqual(progress.step, .phone, "still setting up on the phone")
        XCTAssertEqual(progress.phone.declined, [.microphone])
        progress = progress.applying(.phone(.init(device: "Tyler's iPhone", stage: .finished)), readiness: freshWithPractice)
        XCTAssertEqual(progress.step, .practice)
        XCTAssertEqual(progress.mark(.phone), .done)
    }

    func testThePhoneFinishingLateOnlyTicksTheStep() {
        var progress = run([.begin, .next, .next, .next, .skip], readiness: freshWithPractice)
        XCTAssertEqual(progress.step, .practice)
        progress = progress.applying(.phone(.init(device: "Tyler's iPhone", stage: .finished)), readiness: freshWithPractice)
        XCTAssertEqual(progress.step, .practice, "the Mac stays where the person is")
        XCTAssertEqual(progress.mark(.phone), .done)
    }

    /// The phone asks for no notifications until it has some to send (decision 11), so the Mac shows no row for them.
    /// The stage itself stays, in its place, so the ask can come back without moving what's on disk.
    func testTheMacMirrorsNoNotificationsRow() {
        XCTAssertEqual(PhoneSetupStage.mirrored, [.paired, .microphone, .tour])
        XCTAssertFalse(PhoneSetupStage.mirrored.contains(.notifications))
        XCTAssertEqual(PhoneSetupStage.allCases, [.waiting, .connecting, .paired, .notifications, .microphone, .tour, .finished])
        XCTAssertEqual(PhoneSetupStage(rawValue: "notifications"), .notifications)
    }

    func testALateReportNeverUndoesAStage() {
        var progress = run([.phone(.init(device: "Tyler's iPhone", stage: .tour))])
        progress = progress.applying(.phone(.init(device: "Tyler's iPhone", stage: .paired)), readiness: fresh)
        XCTAssertEqual(progress.phone.stage, .tour)
    }

    // MARK: The menu, while it's put away

    /// Put away with steps left, the menu bar menu's top row says so and names them; with nothing left it's gone.
    func testTheMenuRemindsWhileSetupIsPutAwayWithStepsLeft() {
        let menu = { (left: [String]) in
            StatusMenu.rows(StatusMenu.Input(voice: .talk, quiet: false, exchangeActive: false, controlBar: true, conversation: false,
                                             collapsed: false, replyLine: true, drawing: false, ready: [], working: [], setupLeft: left))
        }
        let putAway = run([.begin, .next, .skip, .close])
        let left = putAway.remaining(fresh).map(\.title)
        XCTAssertEqual(left, ["Permissions", "Voice", "iPhone"])
        let rows = menu(left)
        guard case let .item(first) = rows.first else { return XCTFail("no reminder at the top") }
        XCTAssertEqual(first.title, "Finish setting up conch")
        XCTAssertEqual(first.detail, "3 left: Permissions, Voice, iPhone")
        XCTAssertEqual(first.command, .finishSetup)
        XCTAssertEqual(rows[1], .separator)
        XCTAssertEqual(rows[2], .header)
        XCTAssertEqual(menu([]).first, .header, "nothing left: the menu as it always is")
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
        let progress = run([.begin, .next, .skip, .phone(.init(device: "Tyler's iPhone", stage: .tour, declined: [.microphone]))])
        let data = try JSONEncoder().encode(progress)
        XCTAssertEqual(try JSONDecoder().decode(OnboardingProgress.self, from: data), progress)
        // Readable on disk: the marks are keyed by step name, not an array of pairs.
        let json = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(json.contains("\"permissions\":\"later\""), json)
    }
}
