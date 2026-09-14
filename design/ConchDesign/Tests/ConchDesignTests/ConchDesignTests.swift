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

    /// The fog always sits in a screen corner: let go, it docks in the corner its momentum carries it to, and dragging
    /// a free edge resizes it from that corner.
    @MainActor
    func testTheFogDocksInACornerAndResizesFromItsFreeEdges() {
        let screen = CGRect(x: 0, y: 0, width: 1728, height: 1117)
        let least = CGSize(width: 480, height: 360)
        let size = CGSize(width: 760, height: 560)
        XCTAssertEqual(FogDock.frame(size: size, corner: .bottomLeading, in: screen), CGRect(x: 0, y: 0, width: 760, height: 560))
        XCTAssertEqual(FogDock.frame(size: size, corner: .topTrailing, in: screen), CGRect(x: 968, y: 557, width: 760, height: 560))
        XCTAssertEqual(FogDock.frame(size: CGSize(width: 3000, height: 3000), corner: .topLeading, in: screen), screen)
        // At rest it docks in the nearest corner; thrown, in the corner it was heading for.
        XCTAssertEqual(FogDock.corner(releasedAt: CGPoint(x: 400, y: 300), velocity: .zero, in: screen), .bottomLeading)
        XCTAssertEqual(FogDock.corner(releasedAt: CGPoint(x: 700, y: 300), velocity: CGVector(dx: 2000, dy: 0), in: screen), .bottomTrailing)
        XCTAssertEqual(FogDock.corner(releasedAt: CGPoint(x: 400, y: 500), velocity: CGVector(dx: 0, dy: 1500), in: screen), .topLeading)
        // Dragging the top edge up makes a bottom-docked fog taller, and it stays in its corner.
        let bottomLeft = FogDock.frame(size: size, corner: .bottomLeading, in: screen)
        XCTAssertEqual(
            FogDock.resize(bottomLeft, corner: .bottomLeading, edges: .top, by: CGVector(dx: 50, dy: 200), in: screen, minSize: least),
            CGRect(x: 0, y: 0, width: 760, height: 760)
        )
        // A top-right fog grows left and down from its corner, and never below its minimum.
        let topRight = FogDock.frame(size: size, corner: .topTrailing, in: screen)
        XCTAssertEqual(
            FogDock.resize(topRight, corner: .topTrailing, edges: [.leading, .bottom], by: CGVector(dx: -100, dy: -100), in: screen, minSize: least),
            CGRect(x: 868, y: 457, width: 860, height: 660)
        )
        XCTAssertEqual(FogDock.resize(topRight, corner: .topTrailing, edges: .leading, by: CGVector(dx: 600, dy: 0), in: screen, minSize: least).width, 480)
        XCTAssertEqual(FogDock.freeEdges(.bottomLeading), [.trailing, .top])
        // The words fill the fog less its padding, the Dock and the button row.
        let text = ConversationFog.textFrame(in: size, corner: .bottomLeading, insets: EdgeInsets(top: 0, leading: 0, bottom: 70, trailing: 0), fullScreen: false)
        // On the bottom, the button row is below the reply, in the docked corner; hanging from the top, above the words.
        // The words stay above the Dock's inset; the button row sits in the corner itself, below the Dock's top.
        XCTAssertEqual(text.maxY, 560 - 70 - ConversationFog.padding, accuracy: 0.01)
        XCTAssertEqual(text.minY, ConversationFog.padding, accuracy: 0.01)
        let dock = EdgeInsets(top: 0, leading: 0, bottom: 70, trailing: 0)
        XCTAssertEqual(ConversationFog.buttonsY(in: size, corner: .bottomLeading, insets: ConversationFog.buttonInsets(dock), fullScreen: false), 560 - ConversationFog.padding - ConversationFog.buttonSize, accuracy: 0.01)
        // With no Dock inset, the words still keep clear of the corner's button row.
        let bare = ConversationFog.textFrame(in: size, corner: .bottomLeading, insets: EdgeInsets(), fullScreen: false)
        XCTAssertLessThanOrEqual(bare.maxY, ConversationFog.buttonsY(in: size, corner: .bottomLeading, insets: EdgeInsets(), fullScreen: false) - ConchSpace.x3 + 0.01)
        XCTAssertEqual(ConversationFog.buttonsY(in: size, corner: .topTrailing, insets: ConversationFog.buttonInsets(EdgeInsets(top: 33, leading: 0, bottom: 70, trailing: 0)), fullScreen: false), 33 + ConversationFog.padding, accuracy: 0.01)
        XCTAssertEqual(ConversationFog.buttonsAlignment(corner: .bottomTrailing, fullScreen: false), .trailing)
        XCTAssertEqual(ConversationFog.buttonsAlignment(corner: .bottomLeading, fullScreen: false), .leading)
        XCTAssertEqual(text.width, 760 - 2 * ConversationFog.padding, accuracy: 0.01)
    }

    /// The springs are the overlay lab's, in SwiftUI's own terms, so the apps move the way the lab felt.
    func testTheSpringsAreTheOverlayLabsAndStepLikeSwiftUI() {
        XCTAssertEqual(ConchMotion.dock, ConchSpring(bounce: 0.2, response: 0.45))
        XCTAssertEqual(ConchMotion.morph, ConchSpring(bounce: 0.12, response: 0.46))
        XCTAssertEqual(ConchMotion.pop, ConchSpring(bounce: 0.34, response: 0.36))
        XCTAssertEqual(ConchMotion.grow, ConchSpring(bounce: 0.12, response: 0.34))
        // Stepped by hand, a spring follows the same curve SwiftUI animates.
        for (name, spring) in ConchMotion.springs {
            let swiftUI = Spring(duration: spring.response, bounce: spring.bounce)
            XCTAssertEqual(spring.stiffness, swiftUI.stiffness, accuracy: 0.01, name)
            XCTAssertEqual(spring.damping, swiftUI.damping, accuracy: 0.01, name)
        }
        // Reduce Motion keeps the timing and drops the overshoot.
        XCTAssertEqual(ConchMotion.dock.resolved(reduceMotion: true), ConchSpring(bounce: 0, response: 0.45))
        XCTAssertEqual(ConchMotion.dock.resolved(reduceMotion: false), ConchMotion.dock)
        // A 1000 pt/s flick carries about 500 pt.
        XCTAssertEqual(ConchMotion.projectedDistance(1000), 499, accuracy: 0.01)
    }

    /// The overlay's words read at 4.5:1 on its own wash, in light and in dark.
    func testTheOverlaysWordsReadOnItsWash() {
        for scheme in [ColorScheme.light, .dark] {
            for text in [ConchColor.overlayText, ConchColor.overlayTextSecondary] {
                let ratio = text.rgba(scheme).contrast(on: ConchColor.fog.rgba(scheme))
                XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(text.name) on the wash, \(scheme): \(ratio)")
            }
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
