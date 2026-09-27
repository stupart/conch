import XCTest
@testable import ConchDesign

/// The tour's rule (Tour.swift): five beats, each moving on when the person does the thing, Next the fallback, Skip at
/// every beat; the practice turn's published state as the tour's events; Try it's start states; and the one tip.
final class TourTests: XCTestCase {
    private func run(_ events: [TourEvent], from start: TourProgress = TourProgress()) -> TourProgress {
        events.reduce(start) { $0.applying($1) }
    }

    // MARK: Each beat moves on when the thing is done

    func testTheTourWalksItsFiveBeatsOnRealEvents() {
        var tour = TourProgress()
        XCTAssertEqual(tour.beat, .pill)
        tour = tour.applying(.spoken)
        XCTAssertEqual(tour.beat, .answer, "conch has read the practice turn")
        tour = tour.applying(.heard("show me what you made"))
        XCTAssertEqual(tour.beat, .answer, "the card shows what was sent, with Sent")
        XCTAssertTrue(tour.showingSent)
        XCTAssertEqual(tour.card?.heard, "show me what you made")
        tour = tour.applying(.settle)
        XCTAssertEqual(tour.beat, .ready)
        XCTAssertEqual(tour.heard, "show me what you made")
        tour = tour.applying(.readyOpened)
        XCTAssertEqual(tour.beat, .panel)
        tour = tour.applying(.panelMoved)
        XCTAssertEqual(tour.beat, .canvas)
        tour = tour.applying(.hotKey)
        XCTAssertEqual(tour.beat, .canvas, "the keys light; a mark is still to draw")
        XCTAssertTrue(tour.chordLit)
        XCTAssertEqual(tour.card?.chordLit, true)
        tour = tour.applying(.stroke)
        XCTAssertNil(tour.beat)
        XCTAssertEqual(tour.outcome, .finished)
        XCTAssertTrue(tour.isOver)
    }

    func testABeatWaitsForItsOwnThing() {
        let atPill = TourProgress()
        XCTAssertEqual(atPill.applying(.panelMoved).beat, .pill, "moving the panel doesn't pass the pill")
        XCTAssertEqual(atPill.applying(.hotKey).beat, .pill)
        XCTAssertEqual(atPill.applying(.stroke).beat, .pill)
        XCTAssertEqual(atPill.applying(.silent).beat, .pill)
        let atAnswer = run([.spoken])
        XCTAssertEqual(atAnswer.applying(.silent).beat, .answer, "nothing heard doesn't move it on")
        XCTAssertEqual(atAnswer.applying(.spoken).beat, .answer, "the same fact twice changes nothing")
    }

    /// Opening the card from the pill brings the panel out by itself: that isn't the panel's beat done.
    func testThePanelAndTheCanvasCountOnlyOnTheirOwnBeat() {
        let atReady = run([.spoken, .heard("hi"), .settle])
        XCTAssertEqual(atReady.beat, .ready)
        let early = run([.panelMoved, .hotKey, .stroke], from: atReady)
        XCTAssertEqual(early.beat, .ready)
        XCTAssertFalse(early.chordLit)
        let atPanel = early.applying(.readyOpened)
        XCTAssertEqual(atPanel.beat, .panel, "moves made before its turn don't count")
        XCTAssertEqual(atPanel.applying(.panelMoved).beat, .canvas)
    }

    /// The canvas's beat wants both: the chord and a mark, in either order.
    func testTheCanvasBeatWantsTheChordAndAMark() {
        let atCanvas = run([.spoken, .heard("hi"), .settle, .readyOpened, .panelMoved])
        XCTAssertEqual(atCanvas.beat, .canvas)
        XCTAssertEqual(atCanvas.applying(.stroke).beat, .canvas, "drawn with the pill's pen: still waits for the keys")
        XCTAssertEqual(atCanvas.applying(.stroke).applying(.hotKey).outcome, .finished)
        XCTAssertEqual(atCanvas.applying(.hotKey).applying(.stroke).outcome, .finished)
    }

    /// The practice's facts can arrive early or be missed: the Ready pill clicked while it still listens is remembered and
    /// passed over; words heard mean it was spoken, whether or not that was seen.
    func testPracticeFactsArrivingEarlyOrMissedStillAddUp() {
        let clickedEarly = run([.readyOpened, .spoken])
        XCTAssertEqual(clickedEarly.beat, .answer)
        XCTAssertEqual(clickedEarly.applying(.heard("hi")).applying(.settle).beat, .panel, "Ready was already opened")
        let spokenMissed = TourProgress().applying(.heard("hi"))
        XCTAssertEqual(spokenMissed.beat, .answer, "straight to the card that shows what was sent")
        XCTAssertEqual(spokenMissed.done, [.pill, .answer])
        XCTAssertEqual(spokenMissed.applying(.settle).beat, .ready)
        // Next while it shows them moves on at once; settle at any other time changes nothing.
        XCTAssertEqual(spokenMissed.applying(.next).beat, .ready)
        XCTAssertEqual(TourProgress().applying(.settle).beat, .pill)
        // Words typed later, on another beat, are only remembered.
        let later = run([.spoken, .heard("hi"), .settle, .readyOpened])
        XCTAssertEqual(later.applying(.heard("more")).beat, .panel)
    }

    // MARK: The fallback and the way out

    func testNextIsTheFallbackAtEveryBeat() {
        var tour = TourProgress()
        for beat in TourBeat.allCases {
            XCTAssertEqual(tour.beat, beat)
            tour = tour.applying(.next)
        }
        XCTAssertEqual(tour.outcome, .finished)
        XCTAssertNil(tour.card)
    }

    func testSkipEndsItAtAnyBeat() {
        var tour = TourProgress()
        for _ in TourBeat.allCases {
            let skipped = tour.applying(.skip)
            XCTAssertNil(skipped.beat)
            XCTAssertEqual(skipped.outcome, .skipped)
            tour = tour.applying(.next)
        }
    }

    func testAnEndedTourTakesNoMoreEvents() {
        let skipped = TourProgress().applying(.skip)
        for event in [TourEvent.spoken, .heard("x"), .settle, .readyOpened, .panelMoved, .hotKey, .stroke, .next, .practiceEnded] {
            XCTAssertEqual(skipped.applying(event), skipped)
        }
    }

    /// The practice turn going away ends the beats that stand on it; the panel and the canvas carry on without it.
    func testThePracticeEndingEndsOnlyTheBeatsThatNeedIt() {
        for events in [[TourEvent](), [.spoken], [.spoken, .heard("hi")], [.spoken, .heard("hi"), .settle]] {
            XCTAssertEqual(run(events + [.practiceEnded]).outcome, .ended, "\(events)")
        }
        let atPanel = run([.spoken, .heard("hi"), .settle, .readyOpened])
        XCTAssertEqual(atPanel.applying(.practiceEnded).beat, .panel)
        XCTAssertNil(atPanel.applying(.practiceEnded).outcome)
    }

    // MARK: The cards, as designed

    func testEachCardSaysWhatTheDesignSaysAndHangsWhereItIsAbout() {
        let cards = TourBeat.allCases.map { TourCard($0) }
        XCTAssertEqual(cards.map(\.title), ["This is the pill", "Answer out loud", "Green means ready", "The panel", "Draw on anything"])
        XCTAssertEqual(cards.map(\.primary), ["Next", "Next", "Open it", "Next", "Finish"])
        XCTAssertEqual(cards.map(\.anchor), [.controlBar, .controlBar, .controlBar, .panel, .canvasPill])
        XCTAssertEqual(cards.map(\.pointer), [.up, .up, .up, .left, .left])
        XCTAssertEqual(cards.map(\.chord), [nil, nil, nil, "⌘↩", "⌃⌥⌘P"])
        XCTAssertEqual(cards[0].text, "It sits at the top of your screen and says who's talking and what's ready. Talk reads each finished turn aloud; Quiet holds them until you ask.")
        XCTAssertEqual(cards[1].text, "conch read the practice turn, then opened the mic. Say anything, then pause. Your words go to whoever just spoke.")
        XCTAssertEqual(cards[2].text, "An agent finished something for you. Click the pill and conch opens it where it lives: the page, the app, the file.")
        XCTAssertEqual(cards[3].text, "The conversation, and a line to answer in. Drag it to any corner. ⌘↩ fills the screen, and ⌘. folds it away.")
        XCTAssertEqual(cards[4].text, "Mark up whatever's on screen and Send it to the agent. With the pen down, ⇧R records a Show instead. Agents draw too; theirs are violet.")
        XCTAssertEqual(TourCard.count, 5)
        XCTAssertEqual(cards[1].announcement, "Tour, 2 of 5. Answer out loud. \(cards[1].text)")
    }

    /// Answer out loud shows what was heard with Sent; nothing heard says so and offers another go.
    func testTheAnswerCardShowsWhatWasHeardOrThatNothingWas() {
        let atAnswer = run([.spoken])
        XCTAssertNil(atAnswer.card?.heard)
        XCTAssertNil(atAnswer.card?.note)
        let silent = atAnswer.applying(.silent)
        XCTAssertEqual(silent.card?.note, "conch didn't catch anything. Say something, then pause.")
        XCTAssertEqual(silent.card?.retry, "Listen again")
        let heard = silent.applying(.heard("hello"))
        XCTAssertFalse(heard.silent)
        XCTAssertEqual(heard.card?.heard, "hello")
        XCTAssertNil(heard.card?.note)
        // Then on to Ready; the card there doesn't carry the words.
        XCTAssertEqual(heard.applying(.settle).beat, .ready)
        XCTAssertNil(heard.applying(.settle).card?.heard)
        XCTAssertEqual(TourCard(.answer, heard: "hello").heard, "hello")
        XCTAssertNil(TourCard(.answer, heard: "hello", silent: true).note, "words heard: nothing to say about silence")
    }

    /// The practice refused (another session being read, the phone taking the audio): the beat that waits on it says why,
    /// with Try again, and the next thing it does clears it.
    func testAPracticeThatCouldntGoSaysSoOnTheBeatThatWaits() {
        let busy = "conch is still reading something aloud. Try again once it's done."
        let stuck = TourProgress().applying(.problem(busy))
        XCTAssertEqual(stuck.beat, .pill)
        XCTAssertEqual(stuck.card?.note, busy)
        XCTAssertEqual(stuck.card?.retry, "Try again")
        XCTAssertNil(stuck.applying(.spoken).card?.note, "spoken: the problem is past")
        XCTAssertNil(stuck.applying(.problem(nil)).card?.note, "going again: said no more")
        let phone = "Your iPhone has conch's audio right now. Hand it back to this Mac to try it here."
        let atAnswer = run([.spoken, .silent, .problem(phone)])
        XCTAssertEqual(atAnswer.card?.note, phone, "the problem, over nothing heard")
        XCTAssertEqual(atAnswer.card?.retry, "Try again")
        XCTAssertNil(atAnswer.applying(.heard("hi")).card?.note)
        // Past the practice's beats, a problem is nothing to the tour.
        let atPanel = run([.spoken, .heard("hi"), .settle, .readyOpened, .problem(phone)])
        XCTAssertNil(atPanel.problem)
        XCTAssertNil(atPanel.card?.note)
    }

    // MARK: The practice's published state, as the tour's events

    func testThePublishedPracticeBecomesTheToursEvents() {
        XCTAssertEqual(PracticeReport(stage: "speaking").tourEvents, [.problem(nil)])
        XCTAssertEqual(PracticeReport(stage: "listening", listening: true).tourEvents, [.spoken, .problem(nil)])
        XCTAssertEqual(PracticeReport(stage: "ready", silent: true).tourEvents, [.spoken, .silent, .problem(nil)])
        XCTAssertEqual(PracticeReport(stage: "ready", silent: true, listening: true).tourEvents, [.spoken, .problem(nil)], "listening again: not silent yet")
        XCTAssertEqual(PracticeReport(stage: "ready", heard: "hi").tourEvents, [.spoken, .heard("hi"), .problem(nil)])
        XCTAssertEqual(PracticeReport(stage: "viewed", heard: "hi").tourEvents, [.spoken, .heard("hi"), .problem(nil), .readyOpened])
        let refused = PracticeReport(stage: "speaking", problem: .init(reason: "busy", words: "conch is still reading something aloud."))
        XCTAssertEqual(refused.tourEvents, [.problem("conch is still reading something aloud.")])
        // Applied as the coach applies them, a report with nothing wrong leaves the tour where it was.
        XCTAssertEqual(PracticeReport(stage: "speaking").tourEvents.reduce(TourProgress()) { $0.applying($1) }, TourProgress())
        let json = #"{"sessionId":"conch-practice","stage":"ready","heard":"hi","problem":{"reason":"busy","words":"conch is still reading something aloud."},"future":1}"#
        let decoded = try? JSONDecoder().decode(PracticeReport.self, from: Data(json.utf8))
        XCTAssertEqual(decoded?.problem?.reason, "busy")
        XCTAssertEqual(decoded?.heard, "hi")
    }

    // MARK: Try it, before Start

    func testTryItOnlyWithADaemonThatSaysItCan() {
        XCTAssertFalse(OnboardingReports.practiceAvailable(feature: nil), "an older daemon, or none answering")
        XCTAssertFalse(OnboardingReports.practiceAvailable(feature: 0))
        XCTAssertTrue(OnboardingReports.practiceAvailable(feature: 1))
        let readiness = OnboardingReports.readiness(agents: [], permissions: [:], speech: nil, voices: nil, phonePaired: false,
                                                    practiceAvailable: OnboardingReports.practiceAvailable(feature: 1))
        XCTAssertEqual(readiness.rail.last, .practice)
        XCTAssertFalse(OnboardingReports.readiness(agents: [], permissions: [:], speech: nil, voices: nil, phonePaired: false).rail.contains(.practice))
    }

    func testStartWaitsOnTheMicrophoneAndSpeechRecognitionAndSaysWhy() {
        let ready = SpeechEngineReport(state: "ready")
        XCTAssertEqual(OnboardingReports.practiceStart(microphone: .granted, speech: ready), .ready)
        XCTAssertEqual(OnboardingReports.practiceStart(microphone: nil, speech: ready), .ready, "not read yet is not a no")
        XCTAssertEqual(OnboardingReports.practiceStart(microphone: .unknown("reading"), speech: ready), .ready)
        XCTAssertEqual(OnboardingReports.practiceStart(microphone: .notAsked, speech: ready), .needsMicrophone(action: "Allow…"))
        XCTAssertEqual(OnboardingReports.practiceStart(microphone: .denied, speech: ready), .needsMicrophone(action: "Open Settings"))
        XCTAssertEqual(OnboardingReports.practiceStart(microphone: .needsRelaunch, speech: ready), .needsMicrophone(action: "Reopen conch"))
        guard case .problem = OnboardingReports.practiceStart(microphone: .restricted, speech: ready) else { return XCTFail("managed Mac") }
        let downloading = SpeechEngineReport(state: "downloading", progress: .init(bytes: 740, total: 1000))
        XCTAssertEqual(OnboardingReports.practiceStart(microphone: .granted, speech: downloading), .waitingForRecognition(0.74))
        XCTAssertEqual(OnboardingReports.practiceStart(microphone: .granted, speech: nil), .waitingForRecognition(0))
        guard case .problem = OnboardingReports.practiceStart(microphone: .granted, speech: SpeechEngineReport(state: "off", reason: "no whisper")) else {
            return XCTFail("speech off")
        }
        XCTAssertEqual(OnboardingReports.practiceStart(microphone: .granted, speech: ready, starting: true), .starting)
    }

    /// The phone holding the audio is said plainly, with Hand it back; the rest of what the daemon says, as it says it.
    func testWhatTheDaemonRefusedWithIsShownAsItSaidIt() {
        let ready = SpeechEngineReport(state: "ready")
        let phone = PracticeReport.Problem(reason: "phone", words: "Your iPhone has conch's audio right now. Hand it back to this Mac to try it here.")
        XCTAssertEqual(OnboardingReports.practiceStart(microphone: .granted, speech: ready, refusal: phone), .audioElsewhere(phone.words))
        let mac = PracticeReport.Problem(reason: "another-mac", words: "Another Mac has conch's audio right now.")
        XCTAssertEqual(OnboardingReports.practiceStart(microphone: .granted, speech: ready, refusal: mac), .audioElsewhere(mac.words))
        let busy = PracticeReport.Problem(reason: "busy", words: "conch is still reading something aloud. Try again once it's done.")
        XCTAssertEqual(OnboardingReports.practiceStart(microphone: .granted, speech: ready, refusal: busy), .problem(busy.words))
        // The microphone comes first: Hand it back would do nothing for a microphone that's off.
        XCTAssertEqual(OnboardingReports.practiceStart(microphone: .denied, speech: ready, refusal: phone), .needsMicrophone(action: "Open Settings"))
    }

    // MARK: The one tip

    func testOneTipAfterTheTourUntilThePillIsUsedThenNeverAgain() {
        XCTAssertEqual(PillTip.after(.none, pillUsed: true), .none, "no tour, no tip, whatever the pill does")
        XCTAssertEqual(PillTip.after(.none, tourClosed: true), .pending)
        XCTAssertEqual(PillTip.after(.pending), .pending, "it stays, across launches")
        XCTAssertEqual(PillTip.after(.pending, pillUsed: true), .done)
        XCTAssertEqual(PillTip.after(.pending, dismissed: true), .done)
        XCTAssertEqual(PillTip.after(.done, tourClosed: true), .done, "never again, even after another tour")
        XCTAssertLessThanOrEqual(PillTip.text.count, 75, "a Mac tip is 60 to 75 characters at most (research.md)")
    }
}
