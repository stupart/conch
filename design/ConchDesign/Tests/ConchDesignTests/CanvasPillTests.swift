import CoreGraphics
import SwiftUI
import XCTest
@testable import ConchDesign

/// The canvas's pill after the quality pass: what it is for the canvas's state, what it says, where it goes on screen,
/// where Send goes, and the colours its words are in — measured, as the palette's are.
final class CanvasPillTests: XCTestCase {
    // MARK: What it shows

    /// The tools for the pen, Tyler's ink or a Show; an agent's marks alone, only the chip; a notice keeps it up alone.
    func testAgentMarksAloneRaiseTheChipNeverTheTools() {
        XCTAssertEqual(CanvasToolPill.mode(armed: false, yourInk: false, agentInk: true, show: false, notice: false), .agentChip)
        XCTAssertEqual(CanvasToolPill.mode(armed: false, yourInk: false, agentInk: true, show: false, notice: true), .agentChip)
        // His ink, the pen or a Show: the tools, agent marks or not.
        XCTAssertEqual(CanvasToolPill.mode(armed: false, yourInk: true, agentInk: true, show: false, notice: false), .tools)
        XCTAssertEqual(CanvasToolPill.mode(armed: true, yourInk: false, agentInk: true, show: false, notice: false), .tools)
        XCTAssertEqual(CanvasToolPill.mode(armed: false, yourInk: false, agentInk: false, show: true, notice: false), .tools)
    }

    /// "Show needs Screen Recording" was on a pill that the pen coming up had just hidden: anything said keeps it up.
    func testANoticeKeepsThePillUpWithNothingElseInUse() {
        XCTAssertEqual(CanvasToolPill.mode(armed: false, yourInk: false, agentInk: false, show: false, notice: true), .notice)
        XCTAssertEqual(CanvasToolPill.mode(armed: false, yourInk: false, agentInk: false, show: false, notice: false), .hidden)
    }

    // MARK: What it says

    /// Without the grant a Send asks, and offers the marks alone; a Show, with nothing to send, only the way to Settings.
    func testWithoutScreenRecordingItAsksAndOffersTheMarksAloneOnlyWithInk() {
        let send = CanvasToolPill.Notice.noScreen(marks: true)
        XCTAssertEqual(send.text, "conch can't see your screen yet.")
        XCTAssertEqual(send.actions, [.openSettings, .sendMarksOnly])
        XCTAssertEqual(CanvasToolPill.Notice.noScreen(marks: false).actions, [.openSettings])
        let reopen = CanvasToolPill.Notice.reopen(marks: true)
        XCTAssertTrue(reopen.text.hasSuffix("reopen conch to finish."), reopen.text)
        XCTAssertEqual(reopen.actions, [.reopen, .sendMarksOnly])
        XCTAssertEqual(CanvasToolPill.Notice.reopen(marks: false).actions, [.reopen])
        XCTAssertEqual(CanvasToolPill.Notice.Action.openSettings.title, "Open Settings")
        XCTAssertEqual(CanvasToolPill.Notice.Action.reopen.title, "Reopen conch")
    }

    func testASendThatWentSaysWhereForAMoment() {
        let sent = CanvasToolPill.Notice.sent(to: "Arch brand page")
        XCTAssertEqual(sent.text, "Sent to Arch brand page")
        XCTAssertEqual(sent.tone, .done)
        XCTAssertTrue(sent.actions.isEmpty)
        XCTAssertEqual(CanvasToolPill.Notice.sentFor, .milliseconds(1500))
    }

    /// A Send that didn't land says why in the daemon's own reason table, the one both apps read — #426's "resume it"
    /// included — and that the marks are back, with the picture a click away; never a path.
    func testASendThatDidntLandSaysWhyInTheSharedReasonTable() throws {
        for reason in ["session-stopped", "session-ended", "system-dialog-blocking", "automation-permission-denied", "session-awaiting-answer", "delivery-unconfirmed"] {
            let clause = try XCTUnwrap(ConchSendFailure.clause(for: reason))
            let notice = CanvasToolPill.Notice.notSent(to: "Arch", sentence: ConchSendFailure.sentence(reason: reason))
            XCTAssertEqual(notice.text, "Not sent to Arch: \(clause) Your marks are still here.", reason)
            XCTAssertEqual(notice.actions, [.showInFinder])
        }
        XCTAssertTrue(CanvasToolPill.Notice.notSent(to: "Arch", sentence: ConchSendFailure.sentence(reason: "session-stopped")).text.contains("Resume it"))
        // The clipboard's line is the prompt's, not the marks': it goes.
        XCTAssertEqual(
            CanvasToolPill.Notice.notSent(to: "Arch", sentence: ConchSendFailure.sentence(reason: "window-not-focusable", onClipboard: true)).text,
            "Not sent to Arch: couldn't reach that session's window. Your marks are still here."
        )
        // A reason conch has no words for, and the daemon not answering at all.
        XCTAssertEqual(CanvasToolPill.Notice.notSent(to: "Arch", sentence: ConchSendFailure.sentence(reason: "something-new")).text, "Not sent to Arch. Your marks are still here.")
        XCTAssertEqual(CanvasToolPill.Notice.notSent(to: "Arch", sentence: nil).text, "Not sent to Arch: conch isn't answering. Your marks are still here.")
        XCTAssertEqual(CanvasToolPill.Notice.notSent(to: "Arch", sentence: nil, kept: "The recording is kept.").text, "Not sent to Arch: conch isn't answering. The recording is kept.")
    }

    /// A Show stopped under it says so in conch's words, with where it got to; frames that couldn't be made, the same.
    func testAShowStoppedByMacOSOrUnreadableSaysSoWithoutTheSystemsWords() {
        XCTAssertEqual(CanvasToolPill.Notice.stoppedByMacOS(at: 31.6).text, "macOS stopped the recording at 0:31. Send it, or × to delete it.")
        XCTAssertEqual(CanvasToolPill.Notice.stopped(at: 120).text, "Stopped at 2:00. Send it, or × to delete it.")
        XCTAssertEqual(CanvasToolPill.Notice.noFrames.text, "Couldn't turn the recording into frames.")
        XCTAssertEqual(CanvasToolPill.Notice.noFrames.actions, [.showInFinder])
        XCTAssertEqual(CanvasToolPill.Notice.deleted.text, "Recording deleted. Nothing was sent.")
        for notice in [CanvasToolPill.Notice.noScreen(marks: true), .reopen(marks: true), .nowhere, .noPicture, .noRecording, .noFrames, .deleted, .reopenFailed, .stoppedByMacOS(at: 3)] {
            XCTAssertFalse(notice.text.contains("/"), notice.text)
            XCTAssertFalse(notice.text.contains("error"), notice.text)
        }
    }

    // MARK: Where it goes on screen

    /// A 1440 × 900 screen: a 25 pt menu bar over it, a 70 pt Dock under it.
    private let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
    private let visible = CGRect(x: 0, y: 70, width: 1440, height: 805)
    private let pill = CGSize(width: 520, height: 42)
    /// The control bar's glass, top centre under the menu bar, the Ready pill in it.
    private let bar = CGRect(x: 520, y: 815, width: 400, height: 48)

    private func assertClear(_ spot: CanvasPillPlacement.Spot, of bar: CGRect?, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(visible.contains(spot.frame), "off the visible frame, over the Dock or the menu bar: \(spot.frame)", file: file, line: line)
        if let bar { XCTAssertFalse(spot.frame.intersects(bar), "on the control bar: \(spot.frame)", file: file, line: line) }
    }

    /// The default layout, panel off and control bar on: it sat exactly on the Ready pill. Now it hangs under the bar.
    func testWithThePanelHiddenItHangsUnderTheControlBarNeverOnIt() {
        let spot = CanvasPillPlacement.spot(size: pill, visible: visible, panel: .hidden, controlBar: bar)
        assertClear(spot, of: bar)
        XCTAssertTrue(spot.hangs)
        XCTAssertEqual(spot.frame.maxY, bar.minY - CanvasPillPlacement.gap, accuracy: 0.01)
        XCTAssertEqual(spot.frame.midX, visible.midX, accuracy: 0.01)
        // No bar: under the menu bar.
        let top = CanvasPillPlacement.spot(size: pill, visible: visible, panel: .hidden, controlBar: nil)
        XCTAssertEqual(top.frame.maxY, visible.maxY - ConchSpace.x3, accuracy: 0.01)
    }

    /// Docked with room over it, it rises out of the panel's top edge, centred on it.
    func testDockedItRisesOutOfThePanelsTopEdge() {
        let glass = CGRect(x: 24, y: 94, width: 760, height: 520)
        let spot = CanvasPillPlacement.spot(size: pill, visible: visible, panel: .docked(glass), controlBar: bar)
        assertClear(spot, of: bar)
        XCTAssertFalse(spot.hangs)
        XCTAssertEqual(spot.frame.minY, glass.maxY + CanvasPillPlacement.gap, accuracy: 0.01)
        XCTAssertEqual(spot.frame.midX, glass.midX, accuracy: 0.01)
    }

    /// A panel docked bottom left and reaching the top had no room over it, so the pill went under the panel's foot: onto
    /// the Dock. Now it goes beside the panel's top edge, level with it, on the side with room.
    func testATallPanelPutsItBesideItsTopEdgeNeverOverTheDock() {
        let glass = CGRect(x: 24, y: 94, width: 700, height: 760)
        let spot = CanvasPillPlacement.spot(size: pill, visible: visible, panel: .docked(glass), controlBar: nil)
        assertClear(spot, of: nil)
        XCTAssertTrue(spot.hangs)
        XCTAssertEqual(spot.frame.maxY, glass.maxY, accuracy: 0.01)
        XCTAssertEqual(spot.frame.minX, glass.maxX + CanvasPillPlacement.gap, accuracy: 0.01)
        XCTAssertFalse(spot.frame.intersects(glass))
        // Docked on the right, it goes on the left.
        let right = CGRect(x: 716, y: 94, width: 700, height: 760)
        XCTAssertEqual(CanvasPillPlacement.spot(size: pill, visible: visible, panel: .docked(right), controlBar: nil).frame.maxX, right.minX - CanvasPillPlacement.gap, accuracy: 0.01)
    }

    /// Too wide to sit beside: kept on the screen, either side would land half over the panel, so it goes to the top
    /// centre instead.
    func testAPanelTooWideToSitBesideSendsItToTheTopNotHalfOverIt() {
        let glass = CGRect(x: 24, y: 94, width: 1076, height: 760)
        let spot = CanvasPillPlacement.spot(size: pill, visible: visible, panel: .docked(glass), controlBar: nil)
        assertClear(spot, of: nil)
        XCTAssertTrue(spot.hangs)
        XCTAssertEqual(spot.frame.midX, visible.midX, accuracy: 0.01)
        XCTAssertEqual(spot.frame.maxY, visible.maxY - ConchSpace.x3, accuracy: 0.01)
    }

    /// Room over the panel, but the control bar is there: beside it instead, never on the bar.
    func testOverThePanelButUnderTheControlBarGoesBeside() {
        let glass = CGRect(x: 360, y: 94, width: 720, height: 700)
        let spot = CanvasPillPlacement.spot(size: CGSize(width: 300, height: 42), visible: visible, panel: .docked(glass), controlBar: bar)
        assertClear(spot, of: bar)
        XCTAssertFalse(spot.frame.intersects(glass))
    }

    /// Full screen, top centre under the header row; the Dock's corner no longer.
    func testFullScreenItHangsTopCentreUnderTheHeaderRow() {
        let header: CGFloat = 900 - 97
        let spot = CanvasPillPlacement.spot(size: pill, visible: visible, panel: .fullScreen(headerBottom: header), controlBar: nil)
        assertClear(spot, of: nil)
        XCTAssertTrue(spot.hangs)
        XCTAssertEqual(spot.frame.maxY, header - CanvasPillPlacement.gap, accuracy: 0.01)
        XCTAssertEqual(spot.frame.midX, visible.midX, accuracy: 0.01)
        // With the control bar over it too, under the bar.
        let under = CanvasPillPlacement.spot(size: pill, visible: visible, panel: .fullScreen(headerBottom: 870), controlBar: bar)
        assertClear(under, of: bar)
    }

    /// Wherever it is asked to go, it stays inside the visible frame.
    func testItNeverLeavesTheVisibleFrame() {
        for glass in [CGRect(x: -300, y: 70, width: 500, height: 300), CGRect(x: 1300, y: 600, width: 500, height: 260), CGRect(x: 0, y: 0, width: 1440, height: 900)] {
            for bar in [bar, nil] as [CGRect?] {
                assertClear(CanvasPillPlacement.spot(size: pill, visible: visible, panel: .docked(glass), controlBar: bar), of: bar)
            }
        }
    }

    // MARK: Where Send goes

    private let sessions = ["arch", "dev", "api", "docs"]

    /// Tyler's pick first; the screen's owner when sure; the panel's, as a guess Send asks about.
    func testOnlyAPickOrASureOwnerIsSureThePanelsIsAGuess() {
        XCTAssertEqual(CanvasRouting.choice(picked: nil, onScreen: "dev", confidence: 0.9, panel: "arch", sessions: sessions), .init(id: "dev", sure: true))
        XCTAssertEqual(CanvasRouting.choice(picked: nil, onScreen: "dev", confidence: 0.8, panel: "arch", sessions: sessions), .init(id: "dev", sure: true))
        // A localhost page at 0.7 fell to the panel's session without a word: a guess.
        XCTAssertEqual(CanvasRouting.choice(picked: nil, onScreen: "dev", confidence: 0.7, panel: "arch", sessions: sessions), .init(id: "arch", sure: false))
        XCTAssertEqual(CanvasRouting.choice(picked: "api", onScreen: "dev", confidence: 0.9, panel: "arch", sessions: sessions), .init(id: "api", sure: true))
        // A pick or an owner that isn't a session any more doesn't count.
        XCTAssertEqual(CanvasRouting.choice(picked: "gone", onScreen: "gone", confidence: 1, panel: "arch", sessions: sessions), .init(id: "arch", sure: false))
        XCTAssertNil(CanvasRouting.choice(picked: nil, onScreen: nil, confidence: 0, panel: nil, sessions: sessions))
    }

    /// The menu, most likely first: where it goes now, the screen's owner however unsure, the panel's, then the rest.
    func testTheMenuIsMostLikelyFirstEachOnce() {
        XCTAssertEqual(CanvasRouting.ranked(picked: nil, onScreen: "dev", confidence: 0.7, panel: "api", sessions: sessions), ["api", "dev", "arch", "docs"])
        XCTAssertEqual(CanvasRouting.ranked(picked: nil, onScreen: "dev", confidence: 0.9, panel: "api", sessions: sessions), ["dev", "api", "arch", "docs"])
        XCTAssertEqual(CanvasRouting.ranked(picked: "docs", onScreen: "gone", confidence: 0.9, panel: "arch", sessions: sessions), ["docs", "arch", "dev", "api"])
    }

    // MARK: Ink

    private let display = CGSize(width: 1000, height: 500)
    private func at(_ x: CGFloat, _ y: CGFloat) -> CanvasPoint { CanvasPoint(x: x / display.width, y: y / display.height) }

    /// A click that never moved is not ink: aimed at the panel's pen button under the glass, it left a dot there.
    func testAClickDrawsNothingWithAnyTool() {
        XCTAssertFalse(CanvasMark(kind: .pen, points: [at(100, 100)]).drew(in: display))
        XCTAssertFalse(CanvasMark(kind: .highlight, points: [at(100, 100), at(100.4, 100.3)]).drew(in: display), "a point's jitter is a click")
        XCTAssertTrue(CanvasMark(kind: .pen, points: [at(100, 100), at(103, 100)]).drew(in: display))
        // A loop back to where it began moved.
        XCTAssertTrue(CanvasMark(kind: .pen, points: [at(100, 100), at(160, 130), at(100, 100)]).drew(in: display))
        XCTAssertFalse(CanvasMark(kind: .arrow, points: [at(100, 100), at(103, 100)]).drew(in: display))
        XCTAssertTrue(CanvasMark(kind: .box, points: [at(100, 100), at(105, 100)]).drew(in: display))
        XCTAssertTrue(CanvasMark(kind: .note, points: [at(100, 100)]).drew(in: display))
    }

    /// Back on a review, its marks are there as they were: each draws on the first time only.
    func testAnAgentsMarkDrawsOnOnceALaunch() {
        var memory = AgentInkMemory()
        XCTAssertTrue(memory.drawsOn("review-1/a"))
        XCTAssertTrue(memory.drawsOn("review-1/b"))
        XCTAssertFalse(memory.drawsOn("review-1/a"))
        XCTAssertTrue(memory.drawsOn("review-2/a"), "another review's mark is a new mark")
    }

    /// Marks that couldn't be placed are counted on the chip, their labels on hover.
    func testMarksThatCouldntBeShownAreCountedWithTheirLabels() throws {
        XCTAssertNil(AgentInk.Missed([]))
        let one = try XCTUnwrap(AgentInk.Missed([(kind: "box", label: "Join, as you asked")]))
        XCTAssertEqual(one.text, "1 mark couldn't be shown here")
        XCTAssertEqual(one.help, "“Join, as you asked”")
        let two = try XCTUnwrap(AgentInk.Missed([(kind: "box", label: "Join"), (kind: "arrow", label: "  ")]))
        XCTAssertEqual(two.text, "2 marks couldn't be shown here")
        XCTAssertEqual(two.help, "“Join”\na arrow with no label")
    }

    // MARK: Contrast

    private func composited(_ token: ConchColorToken, over ground: ConchRGBA, _ scheme: ColorScheme) -> ConchRGBA {
        let fill = token.rgba(scheme)
        func mix(_ fore: Double, _ back: Double) -> UInt32 {
            UInt32(((fore * fill.alpha + back * (1 - fill.alpha)) * 255).rounded())
        }
        return ConchRGBA(mix(fill.red, ground.red) << 16 | mix(fill.green, ground.green) << 8 | mix(fill.blue, ground.blue))
    }

    /// Send's words and a note's number on Tyler's orange: white was 2.85:1, the route at 85% 2.44.
    func testSendsWordsClearFourAndAHalfOnTheOrange() {
        XCTAssertGreaterThanOrEqual(CanvasInk.onYou.contrast(on: CanvasInk.you), 4.5)
        let route = ConchRGBA(CanvasInk.onYou.hex, alpha: CanvasToolPill.routeOpacity)
        XCTAssertGreaterThanOrEqual(route.contrast(on: CanvasInk.you), 4.5)
        XCTAssertEqual(CanvasInk.on(.you), CanvasInk.onYou)
        XCTAssertLessThan(ConchRGBA(0xFFFFFF).contrast(on: CanvasInk.you), 3, "why white went")
        // The agent's badge carries a ✦, a mark: 3:1.
        XCTAssertGreaterThanOrEqual(CanvasInk.on(.agent).contrast(on: CanvasInk.agent), 3)
    }

    /// The Show timer, as words, on the pill's glass (overlayGlassStrong over the fog): #FF3B30 was 3.52 light, 2.40 dark.
    func testTheTimerClearsFourAndAHalfOnThePillsGlass() {
        for scheme in [ColorScheme.light, .dark] {
            let glass = composited(ConchColor.overlayGlassStrong, over: ConchColor.fog.rgba(scheme), scheme)
            let ratio = CanvasStoryboard.redText.rgba(scheme).contrast(on: glass)
            XCTAssertGreaterThanOrEqual(ratio, 4.5, "the timer in \(scheme) is \(String(format: "%.2f", ratio)):1")
            XCTAssertLessThan(CanvasStoryboard.red.contrast(on: glass), 4.5, "the ring's red, as words, in \(scheme)")
        }
        // The ring and the disc keep the recording red.
        XCTAssertEqual(CanvasStoryboard.red, ConchRGBA(0xFF3B30))
    }

    /// An agent's name as words ("Claude ·"): the violet read 3.9 light and 3.2 dark on its label.
    func testTheAgentsNameClearsFourAndAHalfOnEveryGround() {
        for scheme in [ColorScheme.light, .dark] {
            for ground in ConchColor.grounds {
                let ratio = CanvasInk.agentText.rgba(scheme).contrast(on: ground.rgba(scheme))
                XCTAssertGreaterThanOrEqual(ratio, 4.5, "agent text on \(ground.name) in \(scheme) is \(String(format: "%.2f", ratio)):1")
            }
        }
        XCTAssertLessThan(CanvasInk.agent.contrast(on: ConchColor.surfaceRaised.dark), 4.5, "why the mark's violet isn't the words'")
    }
}
