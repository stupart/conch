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

    /// Set up by hand, or by a conch older than setup: only what is still missing. Agents are never missing for a
    /// returning Mac: one is wired, and leaving a second unwired was its own choice.
    func testSomeoneWhoSetUpBeforeSeesOnlyWhatIsMissing() {
        XCTAssertEqual(OnboardingProgress.entry(nil, readiness: partway), .welcomeBack(missing: [.permissions, .voice, .phone]))
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
        // Done is finished: nothing reminds. Not now puts it away, and the menu counts what is still off.
        let done = progress.applying(.finish, readiness: readiness)
        XCTAssertTrue(done.finished)
        XCTAssertEqual(OnboardingProgress.entry(done, readiness: readiness), .none)
        let notNow = progress.applying(.close, readiness: readiness)
        XCTAssertTrue(notNow.putAway)
        XCTAssertEqual(notNow.remaining(readiness), [.permissions, .phone])
    }

    /// Put away, a returning Mac is reminded of what is off, and once that's on, of nothing. (It was never reminded of
    /// Try it either; Try it went with the overlays, 2026-11-11.)
    func testAReturningMacIsRemindedOnlyOfWhatIsOff() {
        var readiness = OnboardingReadiness(agentsFound: 1, agentsConnected: 1, microphone: true, permissionsMissing: 0, engineReady: true)
        guard case let .welcomeBack(missing) = OnboardingProgress.entry(nil, readiness: readiness) else { return XCTFail("not welcome back") }
        XCTAssertEqual(missing, [.phone])
        let notNow = OnboardingProgress.welcomingBack(missing: missing, readiness: readiness).applying(.close, readiness: readiness)
        XCTAssertTrue(notNow.putAway)
        XCTAssertEqual(notNow.remaining(readiness), [.phone])
        readiness.phonePaired = true
        XCTAssertEqual(notNow.remaining(readiness), [], "the phone paired since: nothing left, nothing reminds")
        // It still reads as returning after a round trip to disk.
        let data = try! JSONEncoder().encode(notNow)
        XCTAssertEqual(try! JSONDecoder().decode(OnboardingProgress.self, from: data).remaining(readiness), [])
        // A Mac setting up for the first time is reminded of what it left, as before.
        let firstRun = run([.begin, .next, .next, .next, .close])
        XCTAssertEqual(firstRun.remaining(fresh), [.phone])
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

    // MARK: The rail, which ends at iPhone

    /// The rail ends at iPhone, and You're set follows it, the phone handing back included. Try it, which followed iPhone
    /// with a daemon that could run the practice turn, went with the overlays (2026-11-11): nothing shows it or counts it.
    func testTheRailEndsAtIPhone() {
        XCTAssertEqual(OnboardingStep.rail, [.agents, .permissions, .voice, .phone])
        XCTAssertEqual(fresh.rail, OnboardingStep.rail)
        let atPhone = run([.begin, .next, .next, .next])
        XCTAssertEqual(atPhone.step, .phone)
        XCTAssertEqual(atPhone.applying(.next, readiness: fresh).step, .done, "You're set follows iPhone")
        XCTAssertEqual(atPhone.remaining(fresh), [.phone])
        XCTAssertEqual(atPhone.applying(.phone(.init(device: "Tyler's iPhone", stage: .finished)), readiness: fresh).step, .done)
        let everythingTrue = OnboardingReadiness(agentsFound: 1, agentsConnected: 1, microphone: true, permissionsMissing: 0,
                                                 engineReady: true, phonePaired: true)
        XCTAssertEqual(run([.begin], readiness: everythingTrue).step, .done, "a set-up Mac has no step left to show")
    }

    /// Progress an older conch saved on Try it, or with Try it left for later, reads back on You're set owing nothing for
    /// it (2026-11-11), rather than failing to read, which would walk a set-up Mac through setup again. The rest of what
    /// it says is kept, and the step it named is gone from disk once it is written again.
    func testProgressSavedOnTryItReadsBackOnYoureSet() throws {
        let old = #"{"version":1,"step":"practice","marks":{"agents":"done","permissions":"later","voice":"done","phone":"done","practice":"later"},"phone":{"stage":"finished","declined":[]},"finished":false,"putAway":true,"reopening":false}"#
        let progress = try JSONDecoder().decode(OnboardingProgress.self, from: Data(old.utf8))
        XCTAssertEqual(progress.step, .done)
        XCTAssertNil(progress.marks[.practice], "nothing owed for Try it")
        XCTAssertEqual(progress.mark(.permissions), .later)
        XCTAssertEqual(progress.mark(.phone), .done)
        XCTAssertEqual(progress.phone.stage, .finished)
        XCTAssertEqual(progress.remaining(fresh), [.permissions])
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(progress), as: UTF8.self).contains("practice"))
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
        let progress = run([.begin, .next, .next, .next, .next])
        XCTAssertEqual(progress.step, .done)
        XCTAssertTrue(progress.finished)
        XCTAssertEqual(progress.remaining(fresh), [])
        XCTAssertEqual(OnboardingProgress.entry(progress, readiness: fresh), .none)
    }

    func testSkipLeavesAStepForLaterWithoutBlockingTheEnd() {
        let progress = run([.begin, .next, .skip, .next, .skip])
        XCTAssertEqual(progress.step, .done)
        XCTAssertEqual(progress.mark(.permissions), .later)
        XCTAssertEqual(progress.mark(.phone), .later)
        XCTAssertEqual(progress.remaining(fresh), [.permissions, .phone])
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
        let later = run([.next, .next], from: progress, readiness: paired)
        XCTAssertEqual(later.step, .done, "the phone was already paired: straight to the end")
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
            .phone(.init(device: "Tyler's iPhone", stage: .tour, declined: [.microphone])),
        ], from: progress)
        XCTAssertEqual(progress.step, .phone, "still setting up on the phone")
        XCTAssertEqual(progress.phone.declined, [.microphone])
        progress = progress.applying(.phone(.init(device: "Tyler's iPhone", stage: .finished)), readiness: fresh)
        XCTAssertEqual(progress.step, .done)
        XCTAssertEqual(progress.mark(.phone), .done)
    }

    /// Past the iPhone step is the end now Try it has gone (2026-11-11), so the phone finishing late finds the Mac there.
    func testThePhoneFinishingLateOnlyTicksTheStep() {
        var progress = run([.begin, .next, .next, .next, .skip])
        XCTAssertEqual(progress.step, .done)
        progress = progress.applying(.phone(.init(device: "Tyler's iPhone", stage: .finished)), readiness: fresh)
        XCTAssertEqual(progress.step, .done, "the Mac stays where the person is")
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
            StatusMenu.rows(StatusMenu.Input(voice: .talk, quiet: false, exchangeActive: false, ready: [], working: [], setupLeft: left))
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

    /// Help › Set up conch… or Settings › Run setup again, on a Mac that finished: from Agents, keeping the phone and
    /// "reached the end at least once". Put away part way, it reminds about nothing: this Mac is set up.
    func testRunningSetupAgainStartsAtAgentsAndKeepsThePhone() {
        let finished = run([.begin, .next, .next, .next, .phone(.init(device: "Tyler's iPhone", stage: .finished)), .next])
        XCTAssertTrue(finished.finished)
        let again = finished.applying(.restart, readiness: fresh)
        XCTAssertEqual(again.step, .agents)
        XCTAssertTrue(again.finished, "reached the end at least once, still")
        XCTAssertTrue(again.marks.isEmpty)
        XCTAssertEqual(again.phone.device, "Tyler's iPhone")
        let set = OnboardingReadiness(agentsFound: 1, agentsConnected: 1, microphone: true, permissionsMissing: 0, engineReady: true,
                                      phonePaired: true)
        let putAway = again.applying(.close, readiness: set)
        XCTAssertFalse(putAway.putAway, "no \"Finish setting up conch\" for a Mac set up already")
        XCTAssertEqual(OnboardingProgress.entry(putAway, readiness: set), .none)
        // A returning Mac run again is still returning.
        let returning = OnboardingProgress.welcomingBack(missing: [.phone], readiness: set).applying(.restart, readiness: set)
        XCTAssertTrue(returning.returning)
    }

    /// Progress an older conch wrote has no `returning`: it must still read back (unreadable progress is none, and a
    /// set-up Mac would be walked through setup again), as not returning.
    func testProgressWrittenBeforeReturningWasKeptStillReads() throws {
        let old = #"{"version":1,"step":"phone","marks":{"agents":"done","permissions":"later"},"phone":{"stage":"waiting","declined":[]},"finished":false,"putAway":true,"reopening":false}"#
        let progress = try JSONDecoder().decode(OnboardingProgress.self, from: Data(old.utf8))
        XCTAssertEqual(progress.step, .phone)
        XCTAssertEqual(progress.mark(.permissions), .later)
        XCTAssertTrue(progress.putAway)
        XCTAssertFalse(progress.returning)
    }

    /// The published state is read every second while setup's window or Settings › Setup shows the downloads, every five
    /// while setup is unfinished, and not at all otherwise: Settings › Setup on a finished Mac keeps reading.
    func testTheDownloadsAreWatchedWhileAnythingShowsThem() {
        XCTAssertEqual(OnboardingWatch.interval(windowShown: true, settingsShown: false, unfinished: false), 1)
        XCTAssertEqual(OnboardingWatch.interval(windowShown: false, settingsShown: true, unfinished: false), 1, "Settings › Setup, finished")
        XCTAssertEqual(OnboardingWatch.interval(windowShown: false, settingsShown: true, unfinished: true), 1)
        XCTAssertEqual(OnboardingWatch.interval(windowShown: false, settingsShown: false, unfinished: true), 5)
        XCTAssertNil(OnboardingWatch.interval(windowShown: false, settingsShown: false, unfinished: false))
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
