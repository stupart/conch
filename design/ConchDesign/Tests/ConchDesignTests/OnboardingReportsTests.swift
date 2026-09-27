import XCTest
@testable import ConchDesign

/// What the daemon says, turned into setup's rows: the downloads tray from the published status, each agent's row from
/// `setup-status`, and the readiness the rule reads (OnboardingReports.swift).
final class OnboardingReportsTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000)

    // MARK: Speech recognition

    func testSpeechRecognitionSaysEachStateInItsOwnWords() {
        func state(_ report: SpeechEngineReport?, _ secondsLeft: Int? = nil) -> OnboardingDownload.State {
            OnboardingReports.speechRecognition(report, secondsLeft: secondsLeft, now: now).state
        }
        XCTAssertEqual(state(nil), .installing("Checking"))
        XCTAssertEqual(state(.init(state: "ready")), .ready)
        XCTAssertEqual(state(.init(state: "downloading", progress: .init(bytes: 212e6, total: 574e6)), 70),
                       .downloading(done: 212e6, total: 574e6, secondsLeft: 70))
        // Offline keeps its place; out of room says what it needs.
        XCTAssertEqual(state(.init(state: "downloading", progress: .init(bytes: 212e6, total: 574e6), problem: .init(kind: "offline"), retryAt: 1_060_000)),
                       .offline(done: 212e6, total: 574e6))
        XCTAssertEqual(state(.init(state: "downloading", problem: .init(kind: "no-space", needs: 800e6, free: 300e6), retryAt: 1_060_000)),
                       .noSpace(needs: 800e6, free: 300e6))
        XCTAssertEqual(state(.init(state: "off", reason: "download failed", problem: .init(kind: "no-space", needs: 800e6, free: 300e6))),
                       .noSpace(needs: 800e6, free: 300e6))
        // Any other failure retries by itself, and says when.
        XCTAssertEqual(state(.init(state: "downloading", progress: .init(bytes: 212e6, total: 574e6), retryAt: 1_060_000)),
                       .failed("The download stopped at 212 MB. Trying again in a minute; it carries on from there."))
        XCTAssertEqual(state(.init(state: "downloading", retryAt: 1_300_000)),
                       .failed("The download stopped. Trying again in 5 minutes; it carries on from there."))
        XCTAssertEqual(state(.init(state: "off", reason: "download failed", problem: .init(kind: "offline"))), .failed("Couldn't download it: this Mac is offline."))
        XCTAssertEqual(state(.init(state: "off", reason: "download failed")), .failed("Couldn't download speech recognition."))
        XCTAssertEqual(state(.init(state: "off", reason: "no sox")), .failed("conch's speech engine is missing a part. Reinstall conch to put it back."))
    }

    /// Retry only where a retry helps: a download that gave up. One still retrying by itself, or a missing part, doesn't.
    func testOnlyADownloadThatGaveUpOffersRetry() {
        XCTAssertTrue(OnboardingReports.speechRecognition(.init(state: "off", reason: "download failed")).canRetry)
        XCTAssertFalse(OnboardingReports.speechRecognition(.init(state: "downloading", retryAt: 1)).canRetry)
        XCTAssertFalse(OnboardingReports.speechRecognition(.init(state: "off", reason: "no whisper")).canRetry)
        XCTAssertTrue(OnboardingReports.naturalVoices(.init(state: "off", reason: "setup failed"))!.canRetry)
        XCTAssertFalse(OnboardingReports.naturalVoices(.init(state: "off", reason: "needs Apple silicon"))!.canRetry)
        XCTAssertFalse(OnboardingReports.naturalVoices(.init(state: "setting-up", space: .init(needs: 1.7e9, free: 9e8)))!.canRetry, "still retrying by itself")
        XCTAssertTrue(OnboardingReports.naturalVoices(.init(state: "off", reason: "setup failed", space: .init(needs: 1.7e9, free: 9e8)))!.canRetry)
    }

    // MARK: The natural voices

    /// The step comes from the numbers the daemon publishes, never from "(3/4)" in a sentence.
    func testTheVoicesSayTheirStepFromItsNumbers() {
        func state(_ report: NaturalVoicesReport?) -> OnboardingDownload.State? { OnboardingReports.naturalVoices(report)?.state }
        XCTAssertNil(state(nil), "no natural voices published: none to show")
        XCTAssertEqual(state(.init(state: "setting-up", step: 1, steps: 4)), .installing("Installing Python, step 1 of 4"))
        XCTAssertEqual(state(.init(state: "setting-up", step: 3, steps: 4)), .installing("Installing the voices (1.3 GB), step 3 of 4"))
        XCTAssertEqual(state(.init(state: "setting-up", step: 4, steps: 4)), .installing("Checking the voices, step 4 of 4"))
        XCTAssertEqual(state(.init(state: "setting-up", stage: "prefetch")), .installing("Downloading the voices (360 MB)"))
        XCTAssertEqual(state(.init(state: "setting-up", stage: "elsewhere")), .installing("Another conch is setting them up"))
        XCTAssertEqual(state(.init(state: "setting-up", space: .init(needs: 1.7e9, free: 9e8))), .noSpace(needs: 1.7e9, free: 9e8))
        XCTAssertEqual(state(.init(state: "ready")), .ready)
        XCTAssertEqual(state(.init(state: "off", reason: "needs Apple silicon")), .failed("Natural voices need Apple silicon. conch speaks with the Mac's own voice."))
        XCTAssertEqual(OnboardingReports.ring(.init(state: "setting-up", step: 3, steps: 4), playing: nil), .settingUp("Step 3 of 4"))
        XCTAssertEqual(OnboardingReports.ring(.init(state: "ready"), playing: 2), .ready(playing: 2))
        XCTAssertEqual(OnboardingReports.ring(.init(state: "off", reason: "needs Apple silicon"), playing: nil),
                       .unavailable("Natural voices need Apple silicon. conch speaks with the Mac's own voice."))
    }

    // MARK: Agents

    func testAnAgentsRowGoesGreenOnlyOnceConchHasHeardFromIt() {
        let found = AgentSetupReport(agent: "claude", found: true, version: "2.1.280", source: "Homebrew")
        XCTAssertEqual(OnboardingReports.agent(found)?.state, .found(version: "2.1.280", from: "Homebrew"))
        let wired = AgentSetupReport(agent: "claude", found: true, version: "2.1.280", source: "Homebrew", hooksWired: true, pluginInstalled: true)
        XCTAssertEqual(OnboardingReports.agent(wired)?.state, .connecting(version: "2.1.280", from: "Homebrew"), "written is not heard")
        XCTAssertEqual(OnboardingReports.agent(wired)?.note, "conch shows Connected once Claude Code finishes a turn.")
        let heard = AgentSetupReport(agent: "claude", found: true, version: "2.1.280", source: "Homebrew", hooksWired: true, pluginInstalled: true, heard: true, openBeforeHooks: 3)
        XCTAssertEqual(OnboardingReports.agent(heard)?.state, .connected(version: "2.1.280", from: "Homebrew"))
        XCTAssertEqual(OnboardingReports.agent(heard)?.openSessions, 3)
        // Hooks in but no plugin: Connect finishes it.
        let half = AgentSetupReport(agent: "claude", found: true, version: "2.1.280", hooksWired: true)
        XCTAssertEqual(OnboardingReports.agent(half)?.state, .found(version: "2.1.280", from: ""))
        XCTAssertEqual(OnboardingReports.agent(half)?.note, "Its hooks are in. Connect adds conch's tools too.")
    }

    /// Codex is shown as setup-status finds it: not signed in says so; wired and silent says its hooks haven't reached conch.
    func testCodexIsPresentedAsItIsFound() {
        let unsigned = AgentSetupReport(agent: "codex", found: true, version: "0.156.0", hooksWired: true, pluginInstalled: true, signedIn: false)
        XCTAssertEqual(OnboardingReports.agent(unsigned)?.state, .signIn(version: "0.156.0"))
        let quiet = AgentSetupReport(agent: "codex", found: true, version: "0.156.0", hooksWired: true, pluginInstalled: true, signedIn: true)
        XCTAssertEqual(OnboardingReports.agent(quiet)?.state, .connecting(version: "0.156.0", from: ""))
        XCTAssertEqual(OnboardingReports.agent(quiet)?.note, "conch shows Connected once Codex's hooks reach it. Meanwhile it reads Codex's sessions from Codex itself.")
        XCTAssertEqual(OnboardingReports.agent(AgentSetupReport(agent: "codex", found: false))?.state, .missing)
        XCTAssertNil(OnboardingReports.agent(AgentSetupReport(agent: "gemini", found: true)))
    }

    /// What the window is doing comes first: installing, a failure with its command, connecting.
    func testTheWindowsOwnActivityComesFirst() {
        let missing = AgentSetupReport(agent: "codex", found: false)
        XCTAssertEqual(OnboardingReports.agent(missing, activity: .installing(line: "==> Downloading codex"))?.state, .installing(line: "==> Downloading codex"))
        XCTAssertEqual(OnboardingReports.agent(missing, activity: .failed(reason: "The install stopped.", command: "brew install --cask codex"))?.state,
                       .failed(reason: "The install stopped.", command: "brew install --cask codex"))
        let copies = AgentSetupReport(agent: "claude", found: true, version: "2.1.266", copies: .init(conch: "2.1.266  /opt/x", shell: "2.1.280  ~/.local/bin/claude"))
        let connecting = OnboardingReports.agent(copies, activity: .connecting)
        XCTAssertEqual(connecting?.state, .connecting(version: "2.1.266", from: ""))
        XCTAssertEqual(connecting?.copies, .init(conch: "2.1.266  /opt/x", shell: "2.1.280  ~/.local/bin/claude"))
    }

    // MARK: The iPhone

    /// The phone's reports become the handoff the rule reads; a phone that pairs with nothing more to report is finished,
    /// and no phone at all is nothing to mirror.
    func testThePhonesReportsBecomeTheHandoff() {
        XCTAssertNil(OnboardingReports.phoneHandoff(paired: false, device: nil, stage: "waiting", declined: []))
        XCTAssertNil(OnboardingReports.phoneHandoff(paired: false, device: nil, stage: nil, declined: []))
        XCTAssertEqual(OnboardingReports.phoneHandoff(paired: false, device: nil, stage: "connecting", declined: []), PhoneHandoff(stage: .connecting))
        XCTAssertEqual(OnboardingReports.phoneHandoff(paired: true, device: "Tyler's iPhone", stage: "microphone", declined: ["notifications", "nonsense"]),
                       PhoneHandoff(device: "Tyler's iPhone", stage: .microphone, declined: [.notifications]))
        XCTAssertEqual(OnboardingReports.phoneHandoff(paired: true, device: "Tyler's iPhone", stage: nil, declined: []),
                       PhoneHandoff(device: "Tyler's iPhone", stage: .finished), "paired, nothing to report: finished")
        XCTAssertEqual(OnboardingReports.phoneHandoff(paired: true, device: nil, stage: "waiting", declined: [])?.stage, .finished)
    }

    /// A phone paired for weeks reads `paired: false` until it next connects: the phone setting on with a relay pairing
    /// on disk counts as set up, so Welcome back and the menu never nag about it. Either alone doesn't.
    func testAPhonePairedBeforeTheDaemonKeptARecordIsNotAskedAbout() {
        XCTAssertTrue(OnboardingReports.phoneSetUp(paired: true, enabled: false, pairingOnRecord: false))
        XCTAssertTrue(OnboardingReports.phoneSetUp(paired: false, enabled: true, pairingOnRecord: true))
        XCTAssertFalse(OnboardingReports.phoneSetUp(paired: false, enabled: true, pairingOnRecord: false), "the step turns the setting on")
        XCTAssertFalse(OnboardingReports.phoneSetUp(paired: false, enabled: false, pairingOnRecord: true), "phone off")
        XCTAssertFalse(OnboardingReports.phoneSetUp(paired: nil, enabled: nil, pairingOnRecord: true), "no phone block")
        // Tyler's Mac: set up by hand, phone on, a relay pairing, `paired` still false. Nothing to ask.
        let tylers = OnboardingReports.readiness(
            agents: [AgentSetupReport(agent: "claude", found: true, hooksWired: true, pluginInstalled: true)],
            permissions: [.microphone: .granted, .accessibility: .granted, .automation: .granted],
            speech: .init(state: "ready"), voices: .init(state: "ready"),
            phonePaired: OnboardingReports.phoneSetUp(paired: false, enabled: true, pairingOnRecord: true))
        XCTAssertEqual(OnboardingProgress.entry(nil, readiness: tylers), .none)
    }

    func testTheIPhoneStepShowsThePhoneOnceItHasScanned() {
        XCTAssertEqual(OnboardingReports.phoneStep(handoff: nil, relay: true, failure: nil), .waiting(relay: true))
        XCTAssertEqual(OnboardingReports.phoneStep(handoff: nil, relay: false, failure: nil), .waiting(relay: false))
        XCTAssertEqual(OnboardingReports.phoneStep(handoff: nil, relay: true, failure: "conch's background service isn't answering."),
                       .failed("conch's background service isn't answering."))
        XCTAssertEqual(OnboardingReports.phoneStep(handoff: PhoneHandoff(stage: .connecting), relay: true, failure: nil), .connecting)
        let midway = PhoneHandoff(device: "Tyler's iPhone", stage: .notifications)
        XCTAssertEqual(OnboardingReports.phoneStep(handoff: midway, relay: true, failure: "stale"), .settingUp(midway), "the phone beats a stale failure")
        let done = PhoneHandoff(device: "Tyler's iPhone", stage: .finished)
        XCTAssertEqual(OnboardingReports.phoneStep(handoff: done, relay: false, failure: nil), .finished(done))
    }

    // MARK: Readiness

    /// A Mac set up by hand: hooks in and the microphone allowed is enough to be returning, whatever the plugin; the
    /// engine is ready once speech recognition is, and the voices are ready or can't be (Intel).
    func testReadinessFromWhatTheMacAlreadyHas() {
        let agents = [
            AgentSetupReport(agent: "claude", found: true, hooksWired: true, pluginInstalled: false),
            AgentSetupReport(agent: "codex", found: true),
        ]
        let permissions: [ConchPermission: ConchPermissionStatus] = [.microphone: .granted, .accessibility: .granted, .automation: .unknown("Terminal isn't open"), .screenRecording: .denied]
        let readiness = OnboardingReports.readiness(agents: agents, permissions: permissions, speech: .init(state: "ready"),
                                                    voices: .init(state: "off", reason: "needs Apple silicon"), phonePaired: false)
        XCTAssertEqual(readiness, OnboardingReadiness(agentsFound: 2, agentsConnected: 1, microphone: true, permissionsMissing: 0,
                                                      engineReady: true, phonePaired: false))
        XCTAssertTrue(readiness.isReturning)
        XCTAssertEqual(OnboardingProgress.entry(nil, readiness: readiness), .welcomeBack(missing: [.phone]))
        XCTAssertFalse(OnboardingReports.readiness(agents: agents, permissions: permissions, speech: .init(state: "ready"),
                                                   voices: .init(state: "setting-up", step: 2, steps: 4), phonePaired: true).engineReady)
        XCTAssertFalse(OnboardingReports.readiness(agents: agents, permissions: permissions, speech: .init(state: "downloading"),
                                                   voices: nil, phonePaired: true).engineReady)
        XCTAssertEqual(OnboardingReports.readiness(agents: nil, permissions: [:], speech: nil, voices: nil, phonePaired: false).agentsFound, 0)
    }

    func testTheReportsDecodeAsTheDaemonWritesThem() throws {
        let status = try JSONDecoder().decode(AgentSetupReport.self, from: Data("""
        {"agent":"claude","found":true,"path":"/opt/homebrew/bin/claude","version":"2.1.280","source":"Homebrew","hooksWired":true,
         "pluginInstalled":true,"signedIn":null,"heard":false,"openBeforeHooks":0,"copies":null}
        """.utf8))
        XCTAssertEqual(status.version, "2.1.280")
        XCTAssertNil(status.signedIn)
        let speech = try JSONDecoder().decode(SpeechEngineReport.self, from: Data("""
        {"state":"downloading","detail":"retrying","progress":{"bytes":5,"total":10},"problem":{"kind":"offline"},"retryAt":123,
         "parts":{},"daemon":{"version":"1","path":"/x"}}
        """.utf8))
        XCTAssertEqual(speech.problem, .init(kind: "offline"))
        let voices = try JSONDecoder().decode(NaturalVoicesReport.self, from: Data("""
        {"state":"setting-up","detail":"installing Kokoro (3/4) — speaking with macOS say until it is ready","step":3,"steps":4}
        """.utf8))
        XCTAssertEqual(voices.step, 3)
    }
}
