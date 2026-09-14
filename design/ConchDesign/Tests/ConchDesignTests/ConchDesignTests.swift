import SwiftUI
import XCTest
@testable import ConchDesign

final class ConchDesignTests: XCTestCase {
    func testTheLiveVoiceOutranksEverything() {
        XCTAssertEqual(VoiceState.resolve(live: "speaking", paused: true, readyCount: 2), .speaking)
        XCTAssertEqual(VoiceState.resolve(live: "listening", paused: false, readyCount: 1), .listening)
        XCTAssertEqual(VoiceState.resolve(live: "recording", paused: true, readyCount: 0), .listening)
    }

    func testReadyOutranksTheModeAndTheModeDecidesTheRest() {
        XCTAssertEqual(VoiceState.resolve(live: "paused", paused: true, readyCount: 1), .ready)
        XCTAssertEqual(VoiceState.resolve(live: "idle", paused: true, readyCount: 0), .quiet)
        XCTAssertEqual(VoiceState.resolve(live: "muted", paused: false, readyCount: 0), .quiet)
        XCTAssertEqual(VoiceState.resolve(live: "idle", paused: false, readyCount: 0), .talk)
        // Transcribing has shut the mic: not Listening.
        XCTAssertEqual(VoiceState.resolve(live: "transcribing", paused: false, readyCount: 0), .talk)
    }

    func testEveryTextLevelReadsAtFourPointFiveOnEveryGround() {
        for scheme in [ColorScheme.light, .dark] {
            for text in ConchColor.text {
                for ground in ConchColor.grounds {
                    let ratio = text.rgba(scheme).contrast(on: ground.rgba(scheme))
                    XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(text.name) on \(ground.name), \(scheme): \(ratio)")
                }
            }
            let onAccent = ConchColor.onAccent.rgba(scheme).contrast(on: ConchColor.accent.rgba(scheme))
            XCTAssertGreaterThanOrEqual(onAccent, 4.5, "onAccent on accent, \(scheme)")
        }
    }

    func testHairlinesStayAtTenPercentOrLess() {
        for line in [ConchColor.hairline, ConchColor.hairlineStrong] {
            XCTAssertLessThanOrEqual(line.light.alpha, 0.1)
            XCTAssertLessThanOrEqual(line.dark.alpha, 0.1)
        }
    }

    func testTheMarkIsTheApprovedSVG() {
        let points = ConchMark.unitPoints
        XCTAssertEqual(points.count, 1201)
        // Starts one unit above the centre, ends at the top of the crown, crests at 90 degrees.
        XCTAssertEqual(points[0].x, 12, accuracy: 0.001)
        XCTAssertEqual(points[0].y, 11, accuracy: 0.001)
        XCTAssertEqual(points[1200].y, 5.8, accuracy: 0.001)
        XCTAssertEqual(points[750].x, 20.2, accuracy: 0.001)
        // Two points from conch-mark.svg, one on each segment: "L13.683 10.051" (step 68), "L9.956 4.966" (step 1173).
        XCTAssertEqual(points[68].x, 13.683, accuracy: 0.001)
        XCTAssertEqual(points[68].y, 10.051, accuracy: 0.001)
        XCTAssertEqual(points[1173].x, 9.956, accuracy: 0.001)
        XCTAssertEqual(points[1173].y, 4.966, accuracy: 0.001)
        XCTAssertEqual(ConchMark.lineWidth(forSide: 16), 1.15, accuracy: 0.001)
    }
}
