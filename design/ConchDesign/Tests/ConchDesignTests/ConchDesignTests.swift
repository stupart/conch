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

    /// Ready used to be drawn as Talk's grey mic. It is the ready colour now, with a white checkmark.
    @MainActor
    func testTheReadyOrbIsTheReadyColourNotTalksGrey() throws {
        /// The orb's colour at (x, y) from its top left, over white, at 1x.
        func pixel(_ state: VoiceState, x: Int, y: Int) throws -> [Double] {
            let renderer = ImageRenderer(content: VoiceOrb(state: state, size: 36).environment(\.colorScheme, .light))
            renderer.scale = 1
            let image = try XCTUnwrap(renderer.cgImage)
            var rgba: [UInt8] = [0, 0, 0, 0]
            rgba.withUnsafeMutableBytes { buffer in
                let context = CGContext(
                    data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                )!
                context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
                context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
                context.draw(image, in: CGRect(x: -x, y: y - image.height + 1, width: image.width, height: image.height))
            }
            return rgba.prefix(3).map { Double($0) / 255 }
        }
        // Inside the circle, clear of the glyph.
        let ready = try pixel(.ready, x: 4, y: 18)
        let green = ConchColor.ready.light
        XCTAssertEqual(ready[0], green.red, accuracy: 0.04)
        XCTAssertEqual(ready[1], green.green, accuracy: 0.04)
        XCTAssertEqual(ready[2], green.blue, accuracy: 0.04)
        // Talk keeps its quiet grey fill.
        let talk = try pixel(.talk, x: 4, y: 18)
        XCTAssertGreaterThan(talk[0], 0.85)
        // And the ready mark in the middle is white, not a grey mic.
        let check = try (8...28).flatMap { y in try (8...28).map { x in try pixel(.ready, x: x, y: y) } }
        XCTAssertTrue(check.contains { $0.allSatisfy { $0 > 0.95 } }, "no white checkmark in the ready orb")
    }

    /// Pushed against an edge the fog gets smaller rather than leaving the screen, and it faces its nearest corner.
    @MainActor
    func testTheFogFitsItsScreenAndFacesItsNearestCorner() {
        let screen = CGRect(x: 0, y: 0, width: 1728, height: 1000)
        let least = CGSize(width: 480, height: 360)
        let inside = CGRect(x: 100, y: 100, width: 760, height: 560)
        XCTAssertEqual(FogPlacement.fit(inside, in: screen, minSize: least), inside)
        // 200 pt past the left edge: pinned to it, 200 pt narrower.
        XCTAssertEqual(FogPlacement.fit(CGRect(x: -200, y: 100, width: 760, height: 560), in: screen, minSize: least), CGRect(x: 0, y: 100, width: 560, height: 560))
        // Past the top-right corner: cut back on both.
        XCTAssertEqual(FogPlacement.fit(CGRect(x: 1100, y: 600, width: 760, height: 560), in: screen, minSize: least), CGRect(x: 1100, y: 600, width: 628, height: 400))
        // Never below its minimum: it stops at the edge instead.
        XCTAssertEqual(FogPlacement.fit(CGRect(x: -500, y: 100, width: 760, height: 560), in: screen, minSize: least), CGRect(x: 0, y: 100, width: 480, height: 560))
        XCTAssertEqual(FogPlacement.fit(CGRect(x: 1600, y: 100, width: 760, height: 560), in: screen, minSize: least), CGRect(x: 1248, y: 100, width: 480, height: 560))
        // Nearest corner, y up; near a middle line it keeps the one it has.
        XCTAssertEqual(FogCorner.nearest(to: CGRect(x: 1200, y: 700, width: 400, height: 200), in: screen, current: .bottomLeading), .topTrailing)
        XCTAssertEqual(FogCorner.nearest(to: CGRect(x: 0, y: 0, width: 400, height: 300), in: screen, current: .topTrailing), .bottomLeading)
        XCTAssertEqual(FogCorner.nearest(to: CGRect(x: 704, y: 0, width: 400, height: 300), in: screen, current: .bottomLeading), .bottomLeading)
        XCTAssertEqual(FogCorner.nearest(to: CGRect(x: 704, y: 0, width: 400, height: 300), in: screen, current: .bottomTrailing), .bottomTrailing)
        // The words sit in the fog's corner; the default keeps its 560 pt column, and a bigger panel gives them room.
        let topRight = ConversationFog.textFrame(in: CGSize(width: 760, height: 560), corner: .topTrailing, fullScreen: false)
        XCTAssertEqual(topRight.maxX, 760 - ConchSpace.x12, accuracy: 0.01)
        XCTAssertEqual(topRight.minY, ConchSpace.x12 + ConversationFog.buttonRoom, accuracy: 0.01)
        XCTAssertEqual(ConversationFog.textFrame(in: CGSize(width: 760, height: 560), corner: .bottomLeading, fullScreen: false).width, 560, accuracy: 0.01)
        let big = ConversationFog.textFrame(in: CGSize(width: 1400, height: 1000), corner: .bottomLeading, fullScreen: false)
        XCTAssertGreaterThan(big.width, 800)
        XCTAssertGreaterThan(big.height, 700)
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
