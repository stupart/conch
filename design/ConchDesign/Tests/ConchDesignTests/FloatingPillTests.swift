import XCTest
@testable import ConchDesign

/// The floating pill's rules (2026-11-11): its switch and the old overlays' migration, what it says in each state, what a
/// click opens, where its buttons are, and where it docks.
final class FloatingPillTests: XCTestCase {
    private typealias S = FloatingPill.Session

    // MARK: The switch

    func testTheSwitchIsOnUntilTurnedOff() {
        XCTAssertTrue(FloatingPill.byDefault)
        XCTAssertTrue(FloatingPill.enabled(stored: nil))
        XCTAssertTrue(FloatingPill.enabled(stored: true))
        XCTAssertFalse(FloatingPill.enabled(stored: false))
        // Anything that isn't a bool is never set.
        XCTAssertTrue(FloatingPill.enabled(stored: "no"))
    }

    func testAnExplicitChoiceAboutTheOldOverlaysCarriesOverAndTheirKeysGo() {
        let present: Set<String> = [FloatingPill.legacyKey, "conch.showControlBar", "NSWindow Frame conch.conversation", "conch.other"]
        let on = FloatingPill.migration(pill: nil, legacy: true, present: present)
        XCTAssertEqual(on.set, true)
        XCTAssertEqual(Set(on.remove), [FloatingPill.legacyKey, "conch.showControlBar", "NSWindow Frame conch.conversation"])
        XCTAssertEqual(FloatingPill.migration(pill: nil, legacy: false, present: present).set, false)
        // Never set: the pill's own default, and nothing written.
        XCTAssertNil(FloatingPill.migration(pill: nil, legacy: nil, present: []).set)
        // The pill's own switch, once set, is never overwritten by the old one.
        XCTAssertNil(FloatingPill.migration(pill: true, legacy: false, present: present).set)
        // Nothing but the old overlays' keys is ever removed, and none that isn't there.
        XCTAssertFalse(on.remove.contains("conch.other"))
        XCTAssertEqual(FloatingPill.migration(pill: true, legacy: nil, present: ["conch.other"]).remove, [])
        XCTAssertFalse(FloatingPill.retiredKeys.contains(FloatingPill.key))
        XCTAssertFalse(FloatingPill.retiredKeys.contains(FloatingPill.dockKey))
    }

    // MARK: What it says

    func testNothingHappeningIsTheMarkAlone() {
        let face = FloatingPill.face(.init())
        XCTAssertEqual(face.mark, .conch(manual: false))
        XCTAssertNil(face.label)
        XCTAssertEqual(face.working, 0)
        XCTAssertNil(face.needBehind)
        XCTAssertFalse(face.manual)
        XCTAssertEqual(face.title, "Nothing needs you")
        XCTAssertNil(face.subtitle)
        XCTAssertNil(face.opens)
        // The daemon not answering is said, never shown as nothing to do.
        XCTAssertEqual(FloatingPill.face(.init(daemonNote: "Waiting for conch's daemon")).title, "Waiting for conch's daemon")
    }

    func testManualIsShownAndAutoIsNot() {
        let manual = FloatingPill.face(.init(manual: true))
        XCTAssertEqual(manual.mark, .conch(manual: true))
        XCTAssertTrue(manual.manual)
        XCTAssertTrue(manual.accessibility.hasSuffix("manual"))
        let auto = FloatingPill.face(.init())
        XCTAssertFalse(auto.manual)
        XCTAssertFalse(auto.accessibility.lowercased().contains("auto"))
    }

    func testWorkingIsCountedAndNamed() {
        let face = FloatingPill.face(.init(sessions: [
            S(id: "a", label: "site", working: true), S(id: "b", label: "api", working: true), S(id: "c", label: "notes", working: true),
            S(id: "d", label: "idle"),
        ]))
        XCTAssertEqual(face.mark, .conch(manual: false))
        XCTAssertNil(face.label)
        XCTAssertEqual(face.working, 3)
        XCTAssertEqual(face.title, "3 working")
        XCTAssertEqual(face.subtitle, "site, api and 1 more")
        // The title is the count, so it isn't said twice.
        XCTAssertFalse(face.countsWorking)
    }

    func testTheVoiceLeadsAndWhatNeedsTylerIsStillSaid() {
        let input = FloatingPill.Input(
            sessions: [S(id: "a", label: "site"), S(id: "b", label: "api", need: .permission, detail: "Bash"), S(id: "c", label: "x", working: true)],
            voice: .speaking, voiceSession: "a", voiceLabel: "site", caption: "I pushed the hero", exchangeActive: true
        )
        let face = FloatingPill.face(input)
        XCTAssertEqual(face.mark, .speaking)
        XCTAssertEqual(face.label, "site")
        XCTAssertEqual(face.needBehind, .permission)
        XCTAssertEqual(face.working, 1)
        XCTAssertTrue(face.countsWorking)
        XCTAssertEqual(face.title, "site")
        // What needs him before the words going by: a session talking never hides it, and its line carries its mark and the
        // chevron, since that is where a click goes.
        XCTAssertEqual(face.subtitle, "api wants to run Bash")
        XCTAssertEqual(face.subtitleNeed, .permission)
        XCTAssertEqual(face.opens, .permission)
        XCTAssertEqual(face.talk, .stop(listening: false))
        var listening = input
        listening.voice = .listening
        XCTAssertEqual(FloatingPill.face(listening).mark, .listening)
        XCTAssertEqual(FloatingPill.face(listening).talk, .stop(listening: true))
        // Nothing needs him: the words going by, else what the voice is doing.
        var calm = input
        calm.sessions = [S(id: "a", label: "site")]
        XCTAssertEqual(FloatingPill.face(calm).subtitle, "I pushed the hero")
        XCTAssertNil(FloatingPill.face(calm).subtitleNeed)
        // Before the first words: one line, not "Speaking" under the orb that already says so.
        calm.caption = nil
        XCTAssertNil(FloatingPill.face(calm).subtitle)
        XCTAssertNil(FloatingPill.face(calm).needBehind)
    }

    func testTheMostPressingNeedLeadsThenTheLongestWaiting() {
        let face = FloatingPill.face(.init(sessions: [
            S(id: "r", label: "landing", need: .ready, detail: "Hero", at: 1),
            S(id: "q2", label: "late question", need: .question, at: 9),
            S(id: "q1", label: "early question", need: .question, at: 5),
        ]))
        XCTAssertEqual(face.mark, .need(.question))
        XCTAssertEqual(face.label, "early question")
        XCTAssertEqual(face.more, 2)
        XCTAssertNil(face.needBehind)
        // The disc behind the mark says there are more; the line says only what this one asks.
        XCTAssertEqual(face.subtitle, "Has a question")
        XCTAssertTrue(face.accessibility.contains("2 more need you"))
        XCTAssertEqual(face.opens, .question)
        let permission = FloatingPill.face(.init(sessions: [S(id: "q", label: "q", need: .question, at: 1), S(id: "p", label: "p", need: .permission, detail: "Bash", at: 2)]))
        XCTAssertEqual(permission.label, "p")
        XCTAssertEqual(permission.subtitle, "Wants to run Bash")
        XCTAssertEqual(FloatingPill.face(.init(sessions: [S(id: "p", label: "p", need: .permission)])).subtitle, "Asks permission")
        // A ready deliverable is its own summary: the check already says it is ready.
        XCTAssertEqual(FloatingPill.face(.init(sessions: [S(id: "r", label: "landing", need: .ready, detail: "Hero")])).subtitle, "Hero")
        XCTAssertEqual(FloatingPill.face(.init(sessions: [S(id: "r", label: "landing", need: .ready)])).subtitle, "Ready for you")
    }

    func testTalkGoesToTheVoicesSessionOrTheLastOneItWasWith() {
        let sessions = [S(id: "a", label: "site"), S(id: "b", label: "api")]
        XCTAssertEqual(FloatingPill.Input(sessions: sessions, voiceSession: "b", voiceLabel: "api").talkTarget?.id, "b")
        // Idle: the daemon's live label is the session it was last with.
        XCTAssertEqual(FloatingPill.Input(sessions: sessions, voiceLabel: "site").talkTarget?.id, "a")
        XCTAssertEqual(FloatingPill.face(.init(sessions: sessions, voiceLabel: "site")).talk, .talk(to: "site"))
        // A question waiting: the one to answer, out loud.
        let asking = sessions + [S(id: "q", label: "asks", need: .question)]
        XCTAssertEqual(FloatingPill.Input(sessions: asking, voiceLabel: "site").talkTarget?.id, "q")
        // Nobody yet: never a guess, and no Talk to press.
        XCTAssertNil(FloatingPill.Input(sessions: sessions).talkTarget)
        XCTAssertEqual(FloatingPill.face(.init(sessions: sessions)).talk, .unavailable(FloatingPill.Face.nobody))
        XCTAssertEqual(FloatingPill.face(.init(sessions: sessions)).actions, [.mode])
        XCTAssertEqual(FloatingPill.face(.init(sessions: sessions, voiceLabel: "site")).actions, [.talk, .mode])
        // The audio on another device: Talk can't open a mic here.
        let elsewhere = FloatingPill.face(.init(sessions: sessions, voiceLabel: "site", audioElsewhere: true))
        guard case .unavailable = elsewhere.talk else { return XCTFail("Talk while the audio is elsewhere") }
        XCTAssertEqual(elsewhere.subtitle, "The voice is on another device")
        // Off, it isn't there; the line says why.
        XCTAssertEqual(elsewhere.actions, [.mode])
    }

    func testACaptionIsItsEndCutAtAWord() {
        XCTAssertEqual(FloatingPill.tail("I pushed the hero"), "I pushed the hero")
        XCTAssertEqual(FloatingPill.tail("I pushed version three of the hero and the build is green, so", limit: 34),
                       "…hero and the build is green, so")
        XCTAssertNil(FloatingPill.tail("   "))
        // One word longer than the limit is still said, whole.
        XCTAssertEqual(FloatingPill.tail("Supercalifragilistic", limit: 5), "Supercalifragilistic")
    }

    // MARK: A click

    func testAClickOpensWhatNeedsTylerElseTheVoicesSessionElseConch() {
        let needs = FloatingPill.Input(sessions: [S(id: "r", label: "r", need: .ready), S(id: "p", label: "p", need: .permission)],
                                       voiceSession: "x", voiceLabel: "x")
        XCTAssertEqual(FloatingPill.open(needs), .session("p"))
        XCTAssertEqual(FloatingPill.open(.init(sessions: [S(id: "r", label: "r", need: .ready)])), .ready("r"))
        XCTAssertEqual(FloatingPill.open(.init(sessions: [S(id: "a", label: "a")], voiceSession: "a", voiceLabel: "a")), .session("a"))
        XCTAssertEqual(FloatingPill.open(.init(sessions: [S(id: "a", label: "a")], voiceLabel: "a")), .session("a"))
        XCTAssertEqual(FloatingPill.open(.init()), .conch)
    }

    // MARK: Its buttons

    func testTheButtonsSitAtTheEndInOrderAndAPressFindsThem() {
        let size = CGSize(width: 300, height: FloatingPill.Metrics.expandedHeight)
        let frames = FloatingPill.actionFrames(in: size)
        XCTAssertEqual(frames.map(\.action), [.talk, .mode])
        let inset = FloatingPill.Metrics.buttonInset
        XCTAssertEqual(frames.last!.frame.maxX, 300 - inset, accuracy: 0.001)
        XCTAssertEqual(frames.last!.frame.midY, size.height / 2, accuracy: 0.001)
        XCTAssertEqual(frames[1].frame.width, FloatingPill.Metrics.modeButton)
        XCTAssertEqual(frames[1].frame.height, FloatingPill.Metrics.modeHeight)
        XCTAssertEqual(frames[1].frame.midY, size.height / 2, accuracy: 0.001)
        // Without Talk, the switch keeps its place at the end.
        XCTAssertEqual(FloatingPill.actionFrames([.mode], in: size).map(\.frame), [frames[1].frame])
        XCTAssertNil(FloatingPill.action(at: CGPoint(x: frames[0].frame.midX, y: frames[0].frame.midY), in: size, actions: [.mode]))
        for (a, b) in zip(frames, frames.dropFirst()) {
            XCTAssertEqual(b.frame.minX - a.frame.maxX, FloatingPill.Metrics.buttonGap, accuracy: 0.001)
        }
        for entry in frames {
            XCTAssertEqual(FloatingPill.action(at: CGPoint(x: entry.frame.midX, y: entry.frame.midY), in: size), entry.action)
        }
        // The pill's own body, and the corner outside a capsule's round end, are nobody's button.
        XCTAssertNil(FloatingPill.action(at: CGPoint(x: 40, y: size.height / 2), in: size))
        let mode = frames[1].frame
        XCTAssertNil(FloatingPill.action(at: CGPoint(x: mode.minX + 1, y: mode.minY + 1), in: size))
    }

    // MARK: Where it sits

    private let visible = CGRect(x: 0, y: 0, width: 1728, height: 1084)

    func testDockedItSitsAGapInFromItsEdgeCentredWhereItWasLeft() {
        let size = CGSize(width: 100, height: 30)
        let gap = FloatingPill.Metrics.edgeGap
        let top = FloatingPill.frame(size: size, dock: .init(edge: .top, along: 0.5), in: visible)
        XCTAssertEqual(top, CGRect(x: 814, y: 1084 - gap - 30, width: 100, height: 30))
        XCTAssertEqual(FloatingPill.frame(size: size, dock: .init(edge: .bottom, along: 0.25), in: visible).minY, gap)
        XCTAssertEqual(FloatingPill.frame(size: size, dock: .init(edge: .left, along: 0.5), in: visible).minX, gap)
        XCTAssertEqual(FloatingPill.frame(size: size, dock: .init(edge: .right, along: 0.5), in: visible).maxX, 1728 - gap)
        // Never past an end, however far along it was left, and growing keeps its middle where it was.
        XCTAssertEqual(FloatingPill.frame(size: size, dock: .init(edge: .top, along: 1), in: visible).maxX, 1728 - gap)
        let wide = FloatingPill.frame(size: CGSize(width: 300, height: 46), dock: .init(edge: .top, along: 0.5), in: visible)
        XCTAssertEqual(wide.midX, top.midX, accuracy: 0.001)
        XCTAssertEqual(wide.maxY, top.maxY, accuracy: 0.001)
        // Along is kept between its ends.
        XCTAssertEqual(FloatingPill.Dock(edge: .top, along: 3).along, 1)
    }

    func testLetGoItDocksToTheNearestEdgeWhereItIs() {
        let size = CGSize(width: 100, height: 30)
        func at(_ x: CGFloat, _ y: CGFloat) -> CGRect { CGRect(x: x - 50, y: y - 15, width: 100, height: 30) }
        XCTAssertEqual(FloatingPill.dock(droppedAt: at(1700, 540), in: visible).edge, .right)
        XCTAssertEqual(FloatingPill.dock(droppedAt: at(30, 540), in: visible).edge, .left)
        XCTAssertEqual(FloatingPill.dock(droppedAt: at(400, 20), in: visible).edge, .bottom)
        let top = FloatingPill.dock(droppedAt: at(432, 1070), in: visible, display: "2")
        XCTAssertEqual(top, FloatingPill.Dock(edge: .top, along: 0.25, display: "2"))
        // And sits where it was let go along that edge.
        XCTAssertEqual(FloatingPill.frame(size: size, dock: top, in: visible).midX, 432, accuracy: 0.001)
        let right = FloatingPill.dock(droppedAt: at(1700, 271), in: visible)
        XCTAssertEqual(FloatingPill.frame(size: size, dock: right, in: visible).midY, 271, accuracy: 0.001)
    }

    func testAChangeOfSizeGrowsOutOfWhereItIs() {
        let from = CGRect(x: 800, y: 1048, width: 30, height: 30)
        let to = CGRect(x: 700, y: 1032, width: 230, height: 46)
        let step = FloatingPill.transition(from: from, to: to)
        let room = FloatingPill.Metrics.shadowRoom
        XCTAssertEqual(step.window, from.union(to).insetBy(dx: -room, dy: -room))
        // In the window, y down: each pill where it is on screen.
        XCTAssertEqual(step.from, CGRect(x: 100 + room, y: room, width: 30, height: 30))
        XCTAssertEqual(step.to, CGRect(x: room, y: room, width: 230, height: 46))
    }
}
