import SwiftUI
import XCTest
@testable import ConchDesign

/// The overlay lab's look (`render()` in overlay-lab.html) as the Mac overlay draws it. Screen coordinates, y up; the
/// look's own, top left.
final class FogLookTests: XCTestCase {
    static let screen = CGRect(x: 0, y: 0, width: 1728, height: 1117)
    static let size = CGSize(width: 900, height: 640)

    /// Dragged by its middle to `point` and held there until its look lets go of its corner.
    static func held(at point: CGPoint, from motion: FogMotion) -> FogMotion {
        var motion = motion
        motion.press(at: CGPoint(x: motion.frame.midX, y: motion.frame.midY), time: 0)
        motion.drag(to: point, time: 0.05)
        for _ in 0..<240 { motion.step(dt: 1.0 / 120) }
        return motion
    }

    /// Docked, the blob gathers in its corner: centred on it, 115% across and 100% up (the lab's docked shots). Held away
    /// from every edge it is a blob in the middle at 58%, and nearing an edge it eases back toward it, spilling into the gap.
    func testTheMagnetGathersTheBlobInItsCornerAndCentresItAwayFromEdges() {
        let docked = FogMotion(size: Self.size, corner: .bottomLeading, in: Self.screen)
        XCTAssertEqual(docked.magnet, EdgeInsets(top: 0, leading: 1, bottom: 1, trailing: 0))
        XCTAssertEqual(FogLook(docked).blob, CGRect(x: -1035, y: 0, width: 2070, height: 1280))
        XCTAssertEqual(FogLook(docked).margin, EdgeInsets())
        let topRight = FogLook(FogMotion(size: Self.size, corner: .topTrailing, in: Self.screen)).blob
        XCTAssertEqual(topRight.midX, 900, accuracy: 0.001)
        XCTAssertEqual(topRight.midY, 0, accuracy: 0.001)

        let middle = Self.held(at: CGPoint(x: 864, y: 558.5), from: docked)
        XCTAssertEqual(middle.free, 1)
        XCTAssertEqual(middle.magnet, EdgeInsets())
        let blob = FogLook(middle).blob
        XCTAssertEqual(blob.midX, 450, accuracy: 0.001)
        XCTAssertEqual(blob.midY, 320, accuracy: 0.001)
        // 58% of the fog, and a little smaller mid-air.
        XCTAssertEqual(blob.width, 2 * 900 * 0.58 * ConchMotion.flightScale, accuracy: 0.01)
        XCTAssertEqual(FogLook(middle).margin, EdgeInsets())

        // 40 pt from the left edge: pulled most of the way to it, and the window reaches the edge so the blob runs off it.
        let near = Self.held(at: CGPoint(x: 490, y: 500), from: docked)
        XCTAssertEqual(near.gaps.leading, 40, accuracy: 0.001)
        XCTAssertGreaterThan(near.magnet.leading, 0.8)
        XCTAssertLessThan(FogLook(near).blob.midX, 100)
        XCTAssertEqual(FogLook(near).margin, EdgeInsets(top: 0, leading: 40, bottom: 0, trailing: 0))

        // Let go there, it flies home and its look gathers in the corner again.
        var landing = near
        landing.release(at: 10, in: Self.screen, cancelled: true)
        for _ in 0..<600 { landing.step(dt: 1.0 / 120) }
        XCTAssertTrue(landing.isSettled)
        XCTAssertEqual(FogLook(landing).blob, FogLook(docked).blob)
    }

    /// The two edge glows sit 14° either side of the voice's hue; the corner has the pure hue.
    func testTheGlowsEdgesSit14DegreesEitherSideOfTheVoicesHue() {
        let shifted = FogLook.hueShift(SIMD3(1, 0, 0), 120)
        XCTAssertEqual(shifted.x, 0, accuracy: 1e-9)
        XCTAssertEqual(shifted.y, 1, accuracy: 1e-9)
        XCTAssertEqual(shifted.z, 0, accuracy: 1e-9)
        let iris = FogLook.glowColour(ConchColor.idleGlow, darkness: 0)
        for turn in [14.0, -14] {
            XCTAssertEqual(hue(FogLook.hueShift(iris, turn)), (hue(iris) + turn + 360).truncatingRemainder(dividingBy: 360), accuracy: 1e-6)
            XCTAssertEqual(FogLook.hueShift(iris, turn).max() + FogLook.hueShift(iris, turn).min(), iris.max() + iris.min(), accuracy: 1e-9)
        }
        let glows = FogLook(FogMotion(size: Self.size, corner: .bottomLeading, in: Self.screen)).glows(ConchColor.idleGlow, at: 0, reduceMotion: true)
        XCTAssertEqual(glows.map(\.colour), [iris, FogLook.hueShift(iris, -14), FogLook.hueShift(iris, 14)])
    }

    /// Each voice state glows in its own colour, and nothing else does.
    func testTheGlowFollowsTheVoice() {
        XCTAssertEqual(FogLook.glowToken(.listening).name, ConchColor.listening.name)
        XCTAssertEqual(FogLook.glowToken(.speaking).name, ConchColor.speaking.name)
        for quiet in [VoiceState.talk, .quiet, .ready] {
            XCTAssertEqual(FogLook.glowToken(quiet).name, ConchColor.idleGlow.name)
        }
    }

    /// On dark the glow is lightened 15% toward white, so it reads as light.
    func testOnDarkTheGlowIsLightenedTowardWhite() {
        let light = FogLook.glowColour(ConchColor.listening, darkness: 0), dark = FogLook.glowColour(ConchColor.listening, darkness: 1)
        XCTAssertEqual(light, SIMD3(1, 159.0 / 255, 10.0 / 255))
        XCTAssertEqual(dark.y, light.y + (1 - light.y) * 0.15, accuracy: 1e-9)
        XCTAssertEqual(dark.z, light.z + (1 - light.z) * 0.15, accuracy: 1e-9)
    }

    /// The glows drift a few points over seconds; under Reduce Motion they hold still.
    func testTheGlowsDriftSlowlyAndHoldStillUnderReduceMotion() {
        let look = FogLook(FogMotion(size: Self.size, corner: .bottomLeading, in: Self.screen))
        let still = look.glows(ConchColor.idleGlow, at: 0, reduceMotion: true)
        XCTAssertEqual(look.glows(ConchColor.idleGlow, at: 3.7, reduceMotion: true), still)
        XCTAssertNotEqual(look.glows(ConchColor.idleGlow, at: 3.7, reduceMotion: false), look.glows(ConchColor.idleGlow, at: 0, reduceMotion: false))
        for time in stride(from: 0.0, through: 30, by: 0.25) {
            let glow = look.glows(ConchColor.idleGlow, at: time, reduceMotion: false)[2]
            XCTAssertLessThanOrEqual(abs(glow.area.midX - still[2].area.midX), 20)
        }
    }

    /// The palette crossfades light to dark, and a token in a view follows the overlay's darkness over its colour scheme.
    @MainActor
    func testThePaletteCrossfadesFromLightToDark() throws {
        for token in ConchColor.overlay + [ConchColor.fog] {
            XCTAssertEqual(token.rgba(darkness: 0), token.light, token.name)
            XCTAssertEqual(token.rgba(darkness: 1), token.dark, token.name)
        }
        XCTAssertEqual(ConchColor.fog.rgba(darkness: 0.5).hex, 0x888888)
        let look = FogLook(FogMotion(size: Self.size, corner: .bottomLeading, in: Self.screen))
        XCTAssertEqual([look.tint.at(0), look.colour.at(0), look.scrim.at(0)], [0.78, 0.75, 0.3])
        XCTAssertEqual([look.tint.at(1), look.colour.at(1), look.scrim.at(1)], [0.8, 0.55, 0.25])

        let renderer = ImageRenderer(content: Rectangle().fill(ConchColor.overlayText).frame(width: 4, height: 4)
            .environment(\.colorScheme, .light).environment(\.conchDarkness, 1))
        renderer.scale = 1
        let pixel = try XCTUnwrap(alphaAndColour(try XCTUnwrap(renderer.cgImage), at: CGPoint(x: 0.5, y: 0.5)))
        XCTAssertEqual(pixel.red, ConchColor.overlayText.dark.red, accuracy: 0.03)
    }

    func testTheAppearanceIsTheSystemsUnlessSetToLightOrDark() {
        XCTAssertTrue(FogLook.isDark("dark", systemDark: false))
        XCTAssertFalse(FogLook.isDark("light", systemDark: true))
        for auto in ["auto", nil, "anything"] {
            XCTAssertTrue(FogLook.isDark(auto, systemDark: true))
            XCTAssertFalse(FogLook.isDark(auto, systemDark: false))
        }
    }

    /// Behind the newest lines the blur thickens (the scrim), and it never reaches a free side of the window.
    func testTheScrimThickensTheBlurBehindTheNewestWords() throws {
        let insets = EdgeInsets(top: 0, leading: 0, bottom: 65, trailing: 0)
        let look = FogLook(FogMotion(size: Self.size, corner: .bottomLeading, in: Self.screen), insets: insets)
        var bare = look
        bare.scrim = LightDark(0, 0)
        let scrim = look.scrimArea
        XCTAssertGreaterThan(scrim.width, 0)
        XCTAssertLessThanOrEqual(scrim.maxX, Self.size.width)
        // Out to its right and up a little, inside its solid middle but clear of the blob's solid core.
        let point = CGPoint(x: scrim.midX + scrim.width / 2 * 0.45, y: scrim.midY - scrim.height / 2 * 0.3)
        let window = look.window
        let at = CGPoint(x: (point.x - window.minX) / window.width, y: (point.y - window.minY) / window.height)
        let thick = try XCTUnwrap(alphaAndColour(try XCTUnwrap(look.mask()), at: at)).alpha
        let thin = try XCTUnwrap(alphaAndColour(try XCTUnwrap(bare.mask()), at: at)).alpha
        XCTAssertGreaterThan(thick, thin + 0.2)
        // Held in the middle of the screen, every side is free: the scrim stays inside the fog.
        let middle = FogLook(Self.held(at: CGPoint(x: 864, y: 558.5), from: FogMotion(size: Self.size, corner: .bottomLeading, in: Self.screen)), insets: insets)
        XCTAssertTrue(CGRect(origin: .zero, size: Self.size).contains(middle.scrimArea.insetBy(dx: 0.01, dy: 0.01)), "\(middle.scrimArea)")
    }

    /// The mask is drawn again on every frame it changes: dragged along an edge (the magnet moving) and resized from the
    /// corner. It has to fit well inside a 120 Hz frame (8.3 ms).
    func testTheMaskIsCheapEnoughToDrawEveryFrameOfADrag() throws {
        var motion = FogMotion(size: Self.size, corner: .bottomLeading, in: Self.screen)
        var times: [Double] = []
        func frame() {
            motion.step(dt: 1.0 / 120)
            let start = DispatchTime.now().uptimeNanoseconds
            _ = FogLook(motion).mask()
            times.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6)
        }
        // Off the corner and along the bottom edge, in and out of the magnet's reach.
        motion.press(at: CGPoint(x: 450, y: 320), time: 0)
        for n in 0..<240 {
            motion.drag(to: CGPoint(x: 450 + CGFloat(n) * 3, y: 320 + 200 * sin(CGFloat(n) / 20)), time: Double(n) / 120)
            frame()
        }
        motion.release(at: 3, in: Self.screen, cancelled: true)
        for _ in 0..<120 { frame() }
        // Resized from its free corner.
        let docked = motion.frame
        motion.press(at: CGPoint(x: docked.maxX - 20, y: docked.maxY - 20), time: 10)
        for n in 0..<240 {
            motion.drag(to: CGPoint(x: docked.maxX - 20 + CGFloat(n), y: docked.maxY - 20 - CGFloat(n)), time: 10 + Double(n) / 120)
            frame()
        }
        let sorted = times.sorted(), mean = times.reduce(0, +) / Double(times.count)
        print("mask: \(times.count) frames, mean \(String(format: "%.3f", mean)) ms, p95 \(String(format: "%.3f", sorted[sorted.count * 95 / 100])) ms, max \(String(format: "%.3f", sorted.last!)) ms")
        XCTAssertLessThan(mean, 2)
    }

    private func hue(_ rgb: SIMD3<Double>) -> Double {
        let hi = rgb.max(), lo = rgb.min(), d = hi - lo
        let h = hi == rgb.x ? (rgb.y - rgb.z) / d : hi == rgb.y ? (rgb.z - rgb.x) / d + 2 : (rgb.x - rgb.y) / d + 4
        return (h * 60 + 360).truncatingRemainder(dividingBy: 360)
    }

    /// The pixel at `point` (0 to 1, top left), un-premultiplied.
    private func alphaAndColour(_ image: CGImage, at point: CGPoint) -> (alpha: Double, red: Double)? {
        var rgba: [UInt8] = [0, 0, 0, 0]
        let x = min(image.width - 1, Int(point.x * CGFloat(image.width))), y = min(image.height - 1, Int(point.y * CGFloat(image.height)))
        rgba.withUnsafeMutableBytes { buffer in
            let context = CGContext(data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(image, in: CGRect(x: -x, y: y - image.height + 1, width: image.width, height: image.height))
        }
        let alpha = Double(rgba[3]) / 255
        return (alpha, alpha > 0 ? Double(rgba[0]) / 255 / alpha : 0)
    }
}
