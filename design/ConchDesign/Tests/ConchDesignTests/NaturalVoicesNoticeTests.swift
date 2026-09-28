import XCTest
@testable import ConchDesign

/// The natural voices' one calm line (NaturalVoicesNotice.swift): nothing while healthy, a quiet line while healing, one
/// clear line with one action only when healing really failed, a brief "back" on recovery, and a dismissal remembered.
final class NaturalVoicesNoticeTests: XCTestCase {
    private typealias Report = NaturalVoicesReport

    /// Steps the memory through statuses, returning each notice.
    private func walk(_ reports: [Report?], from memory: NaturalVoicesNoticeMemory = .init(), at start: Double = 1_000, every: Double = 1)
        -> (memory: NaturalVoicesNoticeMemory, notices: [NaturalVoicesNotice?]) {
        var memory = memory
        var notices: [NaturalVoicesNotice?] = []
        for (index, report) in reports.enumerated() {
            let step = NaturalVoicesNotices.step(memory, report: report, now: start + Double(index) * every)
            memory = step.memory
            notices.append(step.notice)
        }
        return (memory, notices)
    }

    func testHiddenWhileHealthy() {
        let (_, notices) = walk([Report(state: "checking"), Report(state: "ready"), Report(state: "ready")])
        XCTAssertEqual(notices, [nil, nil, nil], "a daemon starting on voices that work says nothing, ever")
        // An older daemon, or server mode: no status at all.
        XCTAssertNil(NaturalVoicesNotices.step(.init(), report: nil, now: 0).notice)
        // Opting out is a choice, never a notice: by `off`, and by an older daemon's reason.
        XCTAssertNil(walk([Report(state: "off", reason: "CONCH_TTS=say", off: "choice")]).notices[0])
        XCTAssertNil(walk([Report(state: "off", reason: "CONCH_TTS=say")]).notices[0])
        XCTAssertNil(walk([Report(state: "off", reason: "CONCH_TTS_WORKER_PYTHON not found", off: "choice")]).notices[0])
    }

    func testQuietLineWhileHealing() throws {
        let firstRun = try XCTUnwrap(walk([Report(state: "setting-up", healing: "first-run", percent: 60)]).notices[0])
        XCTAssertEqual(firstRun.tone, .healing)
        XCTAssertEqual(firstRun.text, "Setting up natural voices… 60%")
        XCTAssertEqual(firstRun.short, "Setting up voices… 60%")
        XCTAssertNil(firstRun.action, "healing needs nothing from you")
        XCTAssertFalse(firstRun.dismissible)

        let noPercentYet = try XCTUnwrap(walk([Report(state: "setting-up", healing: "first-run")]).notices[0])
        XCTAssertEqual(noPercentYet.text, "Setting up natural voices…")

        let offline = try XCTUnwrap(walk([Report(state: "setting-up", healing: "first-run", waiting: "network")]).notices[0])
        XCTAssertEqual(offline.text, "Natural voices will finish setting up when you're back online")
        XCTAssertEqual(offline.tone, .healing)

        let repair = try XCTUnwrap(walk([Report(state: "ready"), Report(state: "setting-up", healing: "repair")]).notices[1])
        XCTAssertEqual(repair.text, "Natural voices are coming back…")
        XCTAssertEqual(repair.short, "Voices coming back…")
        XCTAssertNil(repair.action)

        let repairOffline = try XCTUnwrap(walk([Report(state: "setting-up", healing: "repair", waiting: "network")]).notices[0])
        XCTAssertEqual(repairOffline.text, "Natural voices will come back when you're online")

        // A quick retry's wait is still healing: quiet.
        XCTAssertEqual(walk([Report(state: "setting-up", healing: "repair", waiting: "retry")]).notices[0]?.tone, .healing)
    }

    func testOneClearLineOnlyWhenHealingReallyFailed() throws {
        let failed = try XCTUnwrap(walk([Report(state: "off", reason: "setup failed", off: "failed", problem: "gpu")]).notices[0])
        XCTAssertEqual(failed.tone, .needsYou)
        XCTAssertEqual(failed.text, "Natural voices stopped: the graphics chip kept failing. conch is using the Mac's own voice for now.")
        XCTAssertEqual(failed.action, .tryAgain)
        XCTAssertEqual(failed.action?.title, "Try again")
        XCTAssertTrue(failed.dismissible)

        // An older daemon's failure, with no `off`: still said.
        XCTAssertEqual(walk([Report(state: "off", reason: "setup failed")]).notices[0]?.action, .tryAgain)

        // A limit of this Mac: said plainly, with Why? (Try again can't change the hardware).
        let intel = try XCTUnwrap(walk([Report(state: "off", reason: "needs Apple silicon", off: "unsupported")]).notices[0])
        XCTAssertEqual(intel.text, "Natural voices can't run here: they need Apple silicon. conch uses the Mac's own voice.")
        XCTAssertEqual(intel.action, .why)
        let noMetal = try XCTUnwrap(walk([Report(state: "off", reason: "no Metal GPU", off: "unsupported")]).notices[0])
        XCTAssertEqual(noMetal.text, "Natural voices can't run here: this Mac's graphics can't run them. conch uses the Mac's own voice.")

        // A missing installer: Try again can't help, so Why?.
        let noUv = try XCTUnwrap(walk([Report(state: "off", reason: "no uv", off: "failed")]).notices[0])
        XCTAssertEqual(noUv.action, .why)
        XCTAssertTrue(noUv.text.contains("conch is missing its installer"))
    }

    func testOutOfRoomSaysSoOnceAndCarriesOn() throws {
        let space = try XCTUnwrap(walk([
            Report(state: "setting-up", space: .init(needs: 1.7e9, free: 9e8), healing: "first-run", waiting: "space"),
        ]).notices[0])
        XCTAssertEqual(space.tone, .needsYou)
        XCTAssertEqual(space.text, "Natural voices need 1.7 GB free to finish setting up. This Mac has 900 MB; they'll carry on once there's room.")
        XCTAssertEqual(space.action, .why)
        XCTAssertEqual(space.key, "space")
    }

    func testRecoveryIsShownOnceAndFades() throws {
        let failed = Report(state: "off", reason: "setup failed", off: "failed", problem: "other")
        var (memory, notices) = walk([failed, Report(state: "ready")], at: 1_000)
        let back = try XCTUnwrap(notices[1])
        XCTAssertEqual(back.tone, .back)
        XCTAssertEqual(back.text, "Natural voices are back")
        XCTAssertNil(back.action)
        XCTAssertFalse(back.dismissible, "it goes by itself")
        XCTAssertEqual(NaturalVoicesNotices.nextChange(memory, now: 1_001), 1_001 + NaturalVoicesNotices.backSeconds)

        // Still there a moment later, gone after its few seconds, and not said again on the next ready.
        XCTAssertEqual(NaturalVoicesNotices.step(memory, report: Report(state: "ready"), now: 1_002).notice?.tone, .back)
        let later = NaturalVoicesNotices.step(memory, report: Report(state: "ready"), now: 1_001 + NaturalVoicesNotices.backSeconds + 0.1)
        XCTAssertNil(later.notice)
        XCTAssertNil(NaturalVoicesNotices.nextChange(later.memory, now: 1_010))
        memory = later.memory
        XCTAssertNil(NaturalVoicesNotices.step(memory, report: Report(state: "ready"), now: 2_000).notice)

        // A first setup finishing says ready, not back; a repair says back.
        (memory, notices) = walk([Report(state: "setting-up", healing: "first-run", percent: 10), Report(state: "ready")])
        XCTAssertEqual(notices[1]?.text, "Natural voices are ready")
        (memory, notices) = walk([Report(state: "ready"), Report(state: "setting-up", healing: "repair"), Report(state: "ready")])
        XCTAssertEqual(notices[2]?.text, "Natural voices are back")
        // The daemon restarting on voices that work (checking, then ready) is not a recovery.
        XCTAssertEqual(walk([Report(state: "ready"), Report(state: "checking"), Report(state: "ready")]).notices, [nil, nil, nil])
    }

    func testDismissalIsRemembered() throws {
        let failed = Report(state: "off", reason: "setup failed", off: "failed", problem: "gpu")
        var (memory, notices) = walk([failed])
        let key = try XCTUnwrap(notices[0]?.key)
        memory = NaturalVoicesNotices.dismiss(memory, key: key)
        // Not again: the next status, a restart of the daemon (checking), a cool-down's try, the same failure again.
        (memory, notices) = walk([failed, Report(state: "checking"), Report(state: "setting-up", healing: "repair"), failed], from: memory)
        XCTAssertEqual(notices, [nil, nil, nil, nil], "dismissed stays dismissed, and a cool-down's attempt doesn't flash")
        // Across launches: the memory is what the apps keep.
        let kept = try JSONDecoder().decode(NaturalVoicesNoticeMemory.self, from: JSONEncoder().encode(memory))
        XCTAssertEqual(kept, memory)
        XCTAssertNil(NaturalVoicesNotices.step(kept, report: failed, now: 5_000).notice)

        // A different failure is news.
        let other = Report(state: "off", reason: "setup failed", off: "failed", problem: "model")
        XCTAssertNotNil(NaturalVoicesNotices.step(kept, report: other, now: 5_000).notice)

        // Once the voices work again the slate is clean: the same failure another day is said again.
        (memory, notices) = walk([Report(state: "ready"), failed], from: kept, at: 6_000)
        XCTAssertEqual(notices[0]?.tone, .back)
        XCTAssertEqual(notices[1]?.key, key)

        // The out-of-room line is dismissible too.
        let space = Report(state: "setting-up", space: .init(needs: 1.7e9, free: 9e8), healing: "first-run", waiting: "space")
        memory = NaturalVoicesNotices.dismiss(.init(), key: "space")
        XCTAssertNil(NaturalVoicesNotices.step(memory, report: space, now: 0).notice)
    }

    func testTheControlBarCarriesTheShortLine() {
        let healing = NaturalVoicesNotice(tone: .healing, text: "Setting up natural voices… 60%", short: "Setting up voices… 60%")
        let failed = NaturalVoicesNotice(tone: .needsYou, text: "…", short: "Natural voices stopped", action: .tryAgain, key: "failed::gpu")
        let back = NaturalVoicesNotice(tone: .back, text: "Natural voices are back", short: "Natural voices are back")
        XCTAssertNil(NaturalVoicesNotices.barNews(working: nil, notice: nil), "healthy and idle: the bar says nothing new")
        XCTAssertEqual(NaturalVoicesNotices.barNews(working: "2 working", notice: nil), "2 working")
        XCTAssertEqual(NaturalVoicesNotices.barNews(working: nil, notice: healing), "Setting up voices… 60%")
        XCTAssertEqual(NaturalVoicesNotices.barNews(working: "2 working", notice: healing), "2 working", "healing is quiet: the count first")
        XCTAssertEqual(NaturalVoicesNotices.barNews(working: "2 working", notice: failed), "Natural voices stopped")
        XCTAssertEqual(NaturalVoicesNotices.barNews(working: "2 working", notice: back), "Natural voices are back")
    }

    func testOnboardingSaysARuntimeLimitPlainly() {
        let download = OnboardingReports.naturalVoices(Report(state: "off", reason: "no Metal GPU", off: "unsupported"))
        XCTAssertEqual(download?.canRetry, false)
        if case let .failed(words)? = download?.state {
            XCTAssertEqual(words, "Natural voices can't run here: this Mac's graphics can't run them. conch uses the Mac's own voice.")
        } else {
            XCTFail("a limit of this Mac is a failure setup names, not one it retries")
        }
    }
}
