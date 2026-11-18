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
/// One rule — "dark grounds swallow a shadow, so it doubles there" — used to stand in for all
/// eight values, and was wrong in both directions: it invented a shadow on dark where the lab
/// draws none, and undershot every one the lab keeps.
final class ElevationTests: XCTestCase {
    /// `ElevationModifier` reads each level's own dark value, not the light one doubled; measured in pixels.
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
}
