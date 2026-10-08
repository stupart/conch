import XCTest
@testable import ConchDesign

/// The overlays switch (`ConchOverlays`): off by default, and while it is off the menu has no overlay items, the input never
/// leaves conch's window, what the panel would have shown opens in the window, and setup has no Try it.
final class ConchOverlaysTests: XCTestCase {
    // MARK: The switch

    func testTheSwitchIsOffUntilTurnedOn() {
        XCTAssertEqual(ConchOverlays.key, "conch.overlays")
        XCTAssertFalse(ConchOverlays.byDefault)
        XCTAssertFalse(ConchOverlays.enabled(stored: nil), "never set is off")
        XCTAssertFalse(ConchOverlays.enabled(stored: false))
        XCTAssertTrue(ConchOverlays.enabled(stored: true))
        // What `defaults write ai.blueprintstudio.conch conch.overlays -bool YES` leaves, read back as an object.
        XCTAssertTrue(ConchOverlays.enabled(stored: NSNumber(value: true)))
        XCTAssertFalse(ConchOverlays.enabled(stored: NSNumber(value: false)))
        XCTAssertFalse(ConchOverlays.enabled(stored: "maybe"), "anything else is off")
    }

    // MARK: Opening

    /// With the overlays on, the rule is the one it always was: drawn in the panel while it is on, or from anywhere when only
    /// conch can show it; the panel's words for a pick with nothing to open; the rest in its own app.
    func testWithTheOverlaysOnTheOpeningRuleIsUnchanged() {
        func on(draws: Bool, panelOn: Bool, conchOnly: Bool = false, words: Bool = false) -> ConchOverlays.Destination {
            ConchOverlays.destination(overlays: true, panelDraws: draws, panelOn: panelOn, conchOnly: conchOnly, words: words)
        }
        XCTAssertEqual(on(draws: true, panelOn: true), .panel)
        XCTAssertEqual(on(draws: true, panelOn: false), .stage, "the panel off: its own app")
        XCTAssertEqual(on(draws: true, panelOn: false, conchOnly: true), .panel, "marks or a folder turn the panel on")
        XCTAssertEqual(on(draws: false, panelOn: true), .stage, "nothing the panel draws")
        XCTAssertEqual(on(draws: false, panelOn: true, conchOnly: true), .stage)
        XCTAssertEqual(on(draws: false, panelOn: false, words: true), .panel, "a pick in the panel shows the words")
    }

    /// With them off nothing ever opens in the panel: what it would have drawn, marks and a folder included, opens in conch's
    /// window; what it never drew is staged in its own app as before.
    func testWithTheOverlaysOffNothingOpensInThePanel() {
        for draws in [false, true] {
            for panelOn in [false, true] {
                for conchOnly in [false, true] {
                    for words in [false, true] {
                        let destination = ConchOverlays.destination(overlays: false, panelDraws: draws, panelOn: panelOn, conchOnly: conchOnly, words: words)
                        XCTAssertNotEqual(destination, .panel)
                        XCTAssertEqual(destination, draws || conchOnly || words ? .window : .stage, "\(draws) \(panelOn) \(conchOnly) \(words)")
                    }
                }
            }
        }
    }

    // MARK: The input

    /// Off, the input is in conch's window whatever the screen says: conch behind another app, its window gone, the panel
    /// open, held by a picker, and wherever it was.
    func testWithTheOverlaysOffTheInputNeverLeavesTheWindow() {
        for active in [false, true] {
            for shown in [false, true] {
                for panel in [ComposerSituation.Panel.off, .collapsed, .open] {
                    for held in [false, true] {
                        let situation = ComposerSituation(appActive: active, windowShown: shown, panel: panel, replyLine: true, withPanelOff: true,
                                                          held: held, overlays: false)
                        for current in ComposerPlace.allCases {
                            XCTAssertEqual(ComposerPlacement.place(situation, current: current), .window, "\(situation) from \(current)")
                        }
                    }
                }
            }
        }
        // On, leaving conch still takes it with you, as before.
        XCTAssertEqual(ComposerPlacement.place(ComposerSituation(appActive: false, windowShown: true, panel: .open, overlays: true), current: .window), .panel)
        XCTAssertEqual(ComposerPlacement.place(ComposerSituation(appActive: false, windowShown: true, panel: .off, overlays: true), current: .window), .replyLine)
    }

    // MARK: The menu

    private func menu(overlays: Bool, ready: [StatusMenu.Session] = [], working: [StatusMenu.Session] = []) -> [StatusMenu.Row] {
        StatusMenu.rows(StatusMenu.Input(voice: .talk, quiet: false, exchangeActive: false, controlBar: true, conversation: true,
                                         collapsed: false, replyLine: true, drawing: false, ready: ready, working: working, overlays: overlays))
    }

    private func items(_ rows: [StatusMenu.Row]) -> [StatusMenu.Item] {
        rows.compactMap { row -> StatusMenu.Item? in
            if case let .item(item) = row { return item }
            return nil
        }
    }

    /// Off, Control Bar, Conversation Panel, Reply Line, With Panel Off and Draw on Screen are gone; Talk, Quiet, Stop, the
    /// sessions and Open conch stay, and no two separators meet.
    func testWithTheOverlaysOffTheMenuHasNoOverlayItems() {
        let overlayCommands: [StatusMenu.Command] = [.controlBar, .conversation, .replyLine, .replyLineAlone, .draw]
        let ready = [StatusMenu.Session(id: "r", label: "Ready one")]
        let working = [StatusMenu.Session(id: "w", label: "Working one")]
        let cases: [([StatusMenu.Session], [StatusMenu.Session])] = [([], []), (ready, []), ([], working), (ready, working)]
        for (ready, working) in cases {
            let off = menu(overlays: false, ready: ready, working: working)
            let commands = items(off).map(\.command)
            for command in overlayCommands { XCTAssertFalse(commands.contains(command), "\(command)") }
            for command in [StatusMenu.Command.talk, .quiet, .stop, .openConch] { XCTAssertTrue(commands.contains(command), "\(command)") }
            for session in ready { XCTAssertTrue(commands.contains(.openItem(session: session.id))) }
            for session in working { XCTAssertTrue(commands.contains(.openSession(session.id))) }
            for (row, next) in zip(off, off.dropFirst()) { XCTAssertFalse(row == .separator && next == .separator, "two separators meet") }
            // On, they are all there, as before.
            let on = items(menu(overlays: true, ready: ready, working: working)).map(\.command)
            for command in overlayCommands { XCTAssertTrue(on.contains(command), "\(command)") }
        }
        XCTAssertEqual(items(menu(overlays: false)).map(\.title), ["Talk", "Quiet", "Read Replies Aloud", "Stop Speaking", "Open conch"])
    }

    // MARK: Setup

    /// Off, setup has no Try it, whatever the daemon can do, and You're set follows iPhone. Unknown is still unknown only
    /// with the overlays on.
    func testWithTheOverlaysOffSetupHasNoTryIt() {
        XCTAssertEqual(OnboardingReports.practiceAvailability(feature: 1, published: true, overlays: false), false)
        XCTAssertEqual(OnboardingReports.practiceAvailability(feature: 1, published: false, overlays: false), false, "not even waiting")
        XCTAssertEqual(OnboardingReports.practiceAvailability(feature: nil, published: true, overlays: false), false)
        XCTAssertEqual(OnboardingReports.practiceAvailability(feature: 1, published: true, overlays: true), true)
        XCTAssertNil(OnboardingReports.practiceAvailability(feature: 1, published: false, overlays: true))

        let off = OnboardingReports.practiceAvailability(feature: 1, published: true, overlays: false) ?? true
        let readiness = OnboardingReports.readiness(agents: [], permissions: [:], speech: nil, voices: nil, phonePaired: false, practiceAvailable: off)
        XCTAssertEqual(readiness.rail, [.agents, .permissions, .voice, .phone])
        let atPhone = [OnboardingEvent.begin, .next, .next, .next].reduce(OnboardingProgress()) { $0.applying($1, readiness: readiness) }
        XCTAssertEqual(atPhone.step, .phone)
        XCTAssertEqual(atPhone.applying(.next, readiness: readiness).step, .done, "You're set follows iPhone")
        XCTAssertEqual(atPhone.remaining(readiness), [.phone], "Try it is never owed")
    }
}
