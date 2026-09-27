import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// Quiet, not paused: the rule every surface reads a session's voice by, the mark that says so, and the words.
final class SessionVoiceTests: XCTestCase {
    private func voice(_ sessionQuiet: Bool, _ exempt: Bool, _ everythingQuiet: Bool) -> SessionVoice {
        SessionVoice(sessionQuiet: sessionQuiet, exempt: exempt, everythingQuiet: everythingQuiet)
    }

    // MARK: The rule

    /// The daemon's gate, in its order. `paused` and `pauseExempt` are never both true on the wire; the table covers
    /// the combination anyway, and quieted by name wins, as it does in `gateTurnForControls`.
    func testQuietIsTheDaemonsGate() {
        XCTAssertFalse(voice(false, false, false).isQuiet, "auto, nothing by name: read aloud")
        XCTAssertTrue(voice(true, false, false).isQuiet, "quieted by name")
        XCTAssertTrue(voice(false, false, true).isQuiet, "everything quiet")
        XCTAssertTrue(voice(true, false, true).isQuiet, "both")
        XCTAssertFalse(voice(false, true, true).isQuiet, "let speak by name through a global quiet")
        XCTAssertTrue(voice(true, true, true).isQuiet, "quieted by name outranks an exemption")
    }

    /// A press always moves it the other way: the button's label and what it sends must agree. The Mac's `isManual`
    /// once read `global || row.paused`, so an exempt session said Manual and every press re-sent the same resume.
    func testAPressAlwaysMovesItTheOtherWay() {
        for sessionQuiet in [false, true] {
            for exempt in [false, true] {
                for everythingQuiet in [false, true] {
                    let v = voice(sessionQuiet, exempt, everythingQuiet)
                    XCTAssertEqual(v.togglesToQuiet, !v.isQuiet, "\(v)")
                }
            }
        }
        XCTAssertTrue(voice(false, true, true).togglesToQuiet, "an exempt session goes back to quiet")
        XCTAssertFalse(voice(false, false, true).togglesToQuiet, "a session in a global quiet is let speak")
    }

    // MARK: The mark

    /// Quieted by name, with everything else speaking: the quiet mark.
    func testQuietByNameIsMarked() {
        XCTAssertEqual(voice(true, false, false).mark, .quiet)
        XCTAssertNil(voice(false, false, false).mark, "an ordinary session carries no mark")
    }

    /// Everything quiet subsumes one quiet session: no row says it on its own, because every row would.
    func testEverythingQuietHidesTheIndividualMark() {
        XCTAssertNil(voice(true, false, true).mark, "quieted by name inside a global quiet")
        XCTAssertNil(voice(false, false, true).mark, "quiet with the rest")
    }

    /// The exception is what gets marked while everything is quiet.
    func testTheOneLetSpeakIsMarkedWhileEverythingIsQuiet() {
        XCTAssertEqual(voice(false, true, true).mark, .speaks)
        // The daemon clears exemptions on any global edge, so outside a global quiet one means nothing.
        XCTAssertNil(voice(false, true, false).mark)
    }

    /// A speaker, never a pause glyph: nothing has stopped.
    func testTheMarkIsASpeakerNotAPause() {
        XCTAssertEqual(SessionVoice.Mark.quiet.symbol, "speaker.slash.fill")
        XCTAssertEqual(SessionVoice.Mark.speaks.symbol, "speaker.wave.2.fill")
        for mark in SessionVoice.Mark.allCases {
            XCTAssertFalse(mark.symbol.contains("pause"), mark.symbol)
            XCTAssertNotNil(NSImage(systemSymbolName: mark.symbol, accessibilityDescription: nil), "\(mark.symbol) is an SF Symbol")
        }
    }

    /// Secondary ink, 3:1 on every ground: the mark answers "why is this one silent?" and must be legible.
    func testTheMarkClearsThreeToOne() {
        for scheme in [ColorScheme.light, .dark] {
            for ground in ConchColor.grounds {
                let ratio = ConchColor.textSecondary.rgba(scheme).contrast(on: ground.rgba(scheme))
                XCTAssertGreaterThanOrEqual(ratio, 3, "\(ground.name) in \(scheme): \(ratio)")
            }
        }
    }

    // MARK: The words

    func testTheMarkSaysWhatItMeansAndTheWayBack() {
        XCTAssertEqual(SessionVoice.Mark.quiet.help(on: .mac), "Quiet: conch won't read this one aloud. Press P or click to let it speak.")
        XCTAssertEqual(SessionVoice.Mark.quiet.help(on: .phone), "Quiet: conch won't read this one aloud. Tap to let it speak.")
        XCTAssertEqual(SessionVoice.Mark.speaks.help(on: .mac), "Speaks: conch reads this one aloud while the rest are quiet. Press P or click to make it quiet.")
        XCTAssertEqual(SessionVoice.Mark.speaks.help(on: .phone), "Speaks: conch reads this one aloud while the rest are quiet. Tap to make it quiet.")
        XCTAssertEqual(SessionVoice.Mark.quiet.meaning, "Quiet — won't be read aloud")
        XCTAssertEqual(SessionVoice.Mark.speaks.meaning, "Speaks — read aloud while the rest are quiet")
        for mark in SessionVoice.Mark.allCases {
            for words in [mark.meaning, mark.help(on: .mac), mark.help(on: .phone)] {
                XCTAssertFalse(words.lowercased().contains("pause"), words)
                XCTAssertFalse(words.lowercased().contains("manual"), words)
            }
        }
    }

    /// Read from the state before the press, and always says how to undo it.
    func testTheToastSaysWhatPDidAndHowToUndoIt() {
        let label = "Conch brand identity and strategy"
        XCTAssertEqual(voice(false, false, false).toggledToast(label: label), "Conch brand identity and strategy is quiet: P to undo")
        XCTAssertEqual(voice(true, false, false).toggledToast(label: label), "Conch brand identity and strategy speaks again: P to undo")
        XCTAssertEqual(voice(false, false, true).toggledToast(label: label), "Conch brand identity and strategy speaks; the rest stay quiet: P to undo")
        XCTAssertEqual(voice(false, true, true).toggledToast(label: label), "Conch brand identity and strategy is quiet: P to undo")
        XCTAssertEqual(SessionVoice.toggledAllToast(nowQuiet: true, stillQuiet: 0), "Every session is quiet: P to undo")
        XCTAssertEqual(SessionVoice.toggledAllToast(nowQuiet: false, stillQuiet: 0), "Every session speaks again: P to undo")
        XCTAssertEqual(SessionVoice.toggledAllToast(nowQuiet: false, stillQuiet: 1), "Sessions speak again, except the one you made quiet: P to undo")
        XCTAssertEqual(SessionVoice.toggledAllToast(nowQuiet: false, stillQuiet: 3), "Sessions speak again, except the 3 you made quiet: P to undo")
    }

    /// The header button says which scope a click reaches: this session, or every session.
    func testTheModeButtonNamesItsScope() {
        let label = "Docs pass"
        XCTAssertEqual(
            voice(false, false, false).modeHelp(label: label),
            "Auto for Docs pass: its finished turns are read aloud. Click to make just this session quiet; the rest keep speaking. To switch every session, select All sessions."
        )
        XCTAssertEqual(
            voice(true, false, false).modeHelp(label: label),
            "Docs pass is quiet: conch won't read it aloud. Click to let it speak. To switch every session, select All sessions."
        )
        XCTAssertEqual(
            voice(false, false, true).modeHelp(label: label),
            "Manual: every session is quiet. Click to let just Docs pass speak; the rest stay quiet. To switch every session, select All sessions."
        )
        XCTAssertEqual(
            voice(false, true, true).modeHelp(label: label),
            "Docs pass speaks while every other session is quiet. Click to make it quiet again. To switch every session, select All sessions."
        )
        XCTAssertEqual(
            SessionVoice.modeHelp(everythingQuiet: false, on: .mac),
            "Auto: conch reads finished turns aloud and opens the mic itself. Click to switch every session to manual. To quiet just one, select it and press P."
        )
        XCTAssertEqual(
            SessionVoice.modeHelp(everythingQuiet: true, on: .mac),
            "Manual: every session is quiet; finished turns wait for you. Click to switch every session to auto."
        )
        XCTAssertFalse(SessionVoice.modeHelp(everythingQuiet: true, on: .phone).contains("Click"))
        XCTAssertFalse(SessionVoice.modeHelp(everythingQuiet: false, on: .phone).contains("Click"))
    }
}
