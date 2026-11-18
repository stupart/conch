import AppKit
import XCTest
@testable import ConchDesign

/// Quiet, not paused: the rule every surface reads a session's voice by, and the mark that says so.
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
        for mark in SessionVoice.Mark.allCases {
            XCTAssertFalse(mark.symbol.contains("pause"), mark.symbol)
            XCTAssertNotNil(NSImage(systemSymbolName: mark.symbol, accessibilityDescription: nil), "\(mark.symbol) is an SF Symbol")
        }
    }
}
