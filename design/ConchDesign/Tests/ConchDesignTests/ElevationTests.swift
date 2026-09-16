import SwiftUI
import XCTest
@testable import ConchDesign

/// The four shadows, against the lab's own variables.
///
/// `workspace-lab.html` defines each one twice — in `body{}` and again in
/// `body[data-theme=dark]{}` — and CSS blur is twice SwiftUI's shadow radius:
///
///     --shPanel   light  0 1px 3px  rgba(0,0,0,.04)    dark  (ring only, no drop)
///     --shRaised  light  0 1px 2px  rgba(0,0,0,.14)    dark  0 1px 2px  rgba(0,0,0,.4)
///     --shFloat   light  0 10px 28px rgba(0,0,0,.24)   dark  0 10px 28px rgba(0,0,0,.7)
///     --shOver    light  0 24px 64px rgba(0,0,0,.32)   dark  0 24px 64px rgba(0,0,0,.75)
///
/// These went untested while one rule — "dark grounds swallow a shadow, so it doubles there"
/// — stood in for all eight values, and the rule was wrong in both directions: it invented a
/// shadow on dark where the lab draws none, and undershot every one the lab keeps.
final class ElevationTests: XCTestCase {
    func testEachLevelCarriesTheLabsGeometry() {
        XCTAssertEqual(ConchElevation.flat.radius, 0)
        XCTAssertEqual(ConchElevation.flat.y, 0)
        XCTAssertEqual(ConchElevation.panel.radius, 1.5)
        XCTAssertEqual(ConchElevation.panel.y, 1)
        XCTAssertEqual(ConchElevation.raised.radius, 1)
        XCTAssertEqual(ConchElevation.raised.y, 1)
        XCTAssertEqual(ConchElevation.floating.radius, 14)
        XCTAssertEqual(ConchElevation.floating.y, 10)
        XCTAssertEqual(ConchElevation.overlay.radius, 32)
        XCTAssertEqual(ConchElevation.overlay.y, 24)
    }

    func testEachLevelCarriesTheLabsLightOpacity() {
        XCTAssertEqual(ConchElevation.flat.opacity, 0, accuracy: 0.0001)
        XCTAssertEqual(ConchElevation.panel.opacity, 0.04, accuracy: 0.0001)
        XCTAssertEqual(ConchElevation.raised.opacity, 0.14, accuracy: 0.0001)
        XCTAssertEqual(ConchElevation.floating.opacity, 0.24, accuracy: 0.0001)
        XCTAssertEqual(ConchElevation.overlay.opacity, 0.32, accuracy: 0.0001)
    }

    func testEachLevelCarriesTheLabsDarkOpacity() {
        XCTAssertEqual(ConchElevation.raised.darkOpacity, 0.4, accuracy: 0.0001)
        XCTAssertEqual(ConchElevation.floating.darkOpacity, 0.7, accuracy: 0.0001)
        XCTAssertEqual(ConchElevation.overlay.darkOpacity, 0.75, accuracy: 0.0001)
    }

    /// The one a single rule could never express: on dark the lab's panel is
    /// `0 0 0 .5px rgba(255,255,255,.07)` — the ring, and nothing else.
    func testThePanelDropsItsShadowEntirelyOnDark() {
        XCTAssertEqual(ConchElevation.panel.darkOpacity, 0)
    }

    /// Values from the lab, not a rule wearing their clothes: no level's dark opacity is its
    /// light one doubled, which is exactly what the app used to compute for all of them.
    func testNoLevelIsMerelyTwiceItsLightValue() {
        for level in [ConchElevation.panel, .raised, .floating, .overlay] {
            XCTAssertNotEqual(level.darkOpacity, level.opacity * 2, accuracy: 0.0001, "\(level)")
        }
    }

    /// The values above are only half of it: `ElevationModifier` decides which one it reads,
    /// and every test in this file passes with the rule it replaced ("dark doubles the light
    /// opacity") still in place. So this one measures the pixels.
    ///
    /// `.panel` on dark is the sharpest case — the lab draws NO drop there, while the old
    /// doubling rule would paint one at .08 — and `.floating` on light is the control: if the
    /// harness renders no shadows at all, that assertion fails and this test cannot pass by
    /// measuring nothing.
    @MainActor
    func testTheModifierReadsEachLevelsOwnDarkValue() throws {
        /// How dark the ground is at (x, y), composited over white, with a 40×40 square
        /// carrying `level` at the centre of a 100×100 frame. 1.0 is untouched white.
        func ground(_ level: ConchElevation, _ scheme: ColorScheme, x: Int, y: Int) throws -> Double {
            let content = Rectangle()
                .fill(.white)
                .frame(width: 40, height: 40)
                .conchElevation(level)
                .padding(30)
                .environment(\.colorScheme, scheme)
            let renderer = ImageRenderer(content: content)
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
            return Double(rgba[0]) / 255
        }

        // The control: `--shFloat` in light (radius 14, y 10 at .24) must visibly darken the
        // ground below the square. If this fails, the measurements below mean nothing.
        let floatingLight = try ground(.floating, .light, x: 50, y: 82)
        XCTAssertLessThan(floatingLight, 0.98, "no shadow rendered at all; the rest of this test is vacuous")

        // `--shFloat` dark is .7 against light's .24 — heavier, not merely doubled.
        let floatingDark = try ground(.floating, .dark, x: 50, y: 82)
        XCTAssertLessThan(floatingDark, floatingLight, "dark floating (\(floatingDark)) should be heavier than light (\(floatingLight))")

        // `--shPanel` dark is the ring alone. The ground beside the panel keeps its colour.
        let panelDark = try ground(.panel, .dark, x: 50, y: 72)
        XCTAssertEqual(panelDark, 1.0, accuracy: 0.004, "the panel casts a shadow on dark, which the lab does not")
    }

    /// Ordering is load-bearing: `radius`, `y`, `opacity` and `darkOpacity` are parallel
    /// arrays indexed by `allCases`, so a case inserted without extending all four silently
    /// hands every level below it the wrong shadow.
    func testEveryCaseHasAValueInEveryTable() {
        XCTAssertEqual(ConchElevation.allCases.count, 5)
        for level in ConchElevation.allCases {
            XCTAssertGreaterThanOrEqual(level.radius, 0, "\(level)")
            XCTAssertGreaterThanOrEqual(level.opacity, 0, "\(level)")
            XCTAssertLessThanOrEqual(level.opacity, 1, "\(level)")
            XCTAssertGreaterThanOrEqual(level.darkOpacity, 0, "\(level)")
            XCTAssertLessThanOrEqual(level.darkOpacity, 1, "\(level)")
        }
    }
}
