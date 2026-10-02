import CoreGraphics
import SwiftUI
import XCTest
@testable import ConchDesign

/// The before/after views, drawn offscreen and read back pixel by pixel: the before shows left of the divider and the
/// after right of it, side by side puts each whole in its half, and the diff tints what changed.
///
/// `CONCH_COMPARE_RENDERS=<dir>` also writes each picture as a PNG, to look at.
@MainActor
final class VersionCompareRenderTests: XCTestCase {
    /// A flat picture of one colour, `width` x `height`.
    private func swatch(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat, width: Int = 400, height: Int = 300) -> CGImage {
        let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.setFillColor(CGColor(srgbRed: red, green: green, blue: blue, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()!
    }

    private func render(_ view: some View, width: CGFloat, height: CGFloat, dark: Bool = false, name: String) throws -> Pixels {
        let content = view
            .frame(width: width, height: height)
            .background(dark ? ConchColor.ground.dark.color : ConchColor.ground.light.color)
            .environment(\.colorScheme, dark ? .dark : .light)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 1
        let image = try XCTUnwrap(renderer.cgImage)
        if let directory = ProcessInfo.processInfo.environment["CONCH_COMPARE_RENDERS"] {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let renderer2x = ImageRenderer(content: content)
            renderer2x.scale = 2
            let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
            let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
            CGImageDestinationAddImage(destination, try XCTUnwrap(renderer2x.cgImage), nil)
            XCTAssertTrue(CGImageDestinationFinalize(destination))
        }
        return Pixels(image)
    }

    struct Pixels {
        let width: Int
        let height: Int
        private let bytes: [UInt8]

        init(_ image: CGImage) {
            width = image.width
            height = image.height
            var bytes = [UInt8](repeating: 0, count: width * height * 4)
            bytes.withUnsafeMutableBytes { buffer in
                let context = CGContext(
                    data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
                    bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                )!
                context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            }
            self.bytes = bytes
        }

        /// The colour at (x, y) from the TOP left, 0…255 each.
        func at(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int) {
            let offset = (y * width + x) * 4
            return (Int(bytes[offset]), Int(bytes[offset + 1]), Int(bytes[offset + 2]))
        }

        func isRed(_ x: Int, _ y: Int) -> Bool { let c = at(x, y); return c.r > 180 && c.g < 80 && c.b < 80 }
        func isBlue(_ x: Int, _ y: Int) -> Bool { let c = at(x, y); return c.b > 180 && c.r < 80 && c.g < 80 }
    }

    // MARK: - Slider

    func testTheSliderShowsTheBeforeLeftOfTheDividerAndTheAfterRightOfIt() throws {
        let before = swatch(0.9, 0.1, 0.1) // red
        let after = swatch(0.1, 0.1, 0.9) // blue
        for (fraction, name) in [(0.3, "slider-30"), (0.7, "slider-70")] {
            let pixels = try render(
                VersionCompareSlider(before: before, after: after, beforeName: "v1", afterName: "v2", fraction: .constant(fraction)),
                width: 400, height: 300, name: name
            )
            let divider = Int(400 * fraction)
            // Well away from the divider, its handle and the chips: the middle row's ends, the bottom row either side.
            XCTAssertTrue(pixels.isRed(divider - 40, 280), "before left of the divider at \(fraction): \(pixels.at(divider - 40, 280))")
            XCTAssertTrue(pixels.isBlue(divider + 40, 280), "after right of it at \(fraction): \(pixels.at(divider + 40, 280))")
            XCTAssertTrue(pixels.isRed(5, 150))
            XCTAssertTrue(pixels.isBlue(394, 150))
            // The divider itself is drawn, white, at the fraction.
            let line = pixels.at(divider, 280)
            XCTAssertTrue(line.r > 200 && line.g > 200 && line.b > 200, "a white divider at \(divider): \(line)")
        }
    }

    func testTheSliderFitsBothVersionsIntoTheAftersFrame() throws {
        // A wide after in a tall box: drawn full width, centred, with the ground above and below.
        let pixels = try render(
            VersionCompareSlider(
                before: swatch(0.9, 0.1, 0.1), after: swatch(0.1, 0.1, 0.9, width: 400, height: 200),
                beforeName: "v1", afterName: "v2", fraction: .constant(0.5)
            ),
            width: 200, height: 400, name: "slider-fitted"
        )
        // 400x200 into 200x400: 200x100 at y 150. The 4:3 before inside that frame is 133 wide, centred at x 33…167.
        XCTAssertFalse(pixels.isBlue(150, 120) || pixels.isRed(50, 120), "ground above the picture")
        XCTAssertTrue(pixels.isBlue(180, 240))
        XCTAssertTrue(pixels.isRed(80, 240))
        // Left of the divider, where the narrower before has nothing, is the ground: never the after showing through.
        XCTAssertFalse(pixels.isBlue(15, 240) || pixels.isRed(15, 240), "\(pixels.at(15, 240))")
        XCTAssertFalse(pixels.isBlue(150, 280) || pixels.isRed(50, 280), "ground below the picture")
    }

    /// The phone fixture's photo edit (mobile/conch-ios/fixtures/deliverables), at a Mac pane's size, light and dark: the
    /// before's flat grey left of the divider, the after's colour right of it.
    func testThePhotoFixtureComparesAtAMacPanesSize() throws {
        let fixtures = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("mobile/conch-ios/fixtures/deliverables")
        guard let before = ConchImage.thumbnail(atPath: fixtures.appendingPathComponent("photo-before.jpg").path, maxPixelSize: 3_000),
              let after = ConchImage.thumbnail(atPath: fixtures.appendingPathComponent("photo-after.jpg").path, maxPixelSize: 3_000)
        else { throw XCTSkip("the phone fixtures aren't beside this package") }
        func saturation(_ c: (r: Int, g: Int, b: Int)) -> Int { max(c.r, c.g, c.b) - min(c.r, c.g, c.b) }
        for dark in [false, true] {
            let slider = try render(
                VersionCompareSlider(before: before, after: after, beforeName: "v1", afterName: "v2",
                                     fraction: .constant(0.42), matte: ConchColor.surface),
                width: 960, height: 640, dark: dark, name: "mac-photo-slider-\(dark ? "dark" : "light")"
            )
            // The sky, a third of the way down: grey on the left, blue on the right.
            XCTAssertLessThan(saturation(slider.at(150, 120)), 60, "the before's sky is flat: \(slider.at(150, 120))")
            XCTAssertGreaterThan(saturation(slider.at(800, 120)), 100, "the after's sky is blue: \(slider.at(800, 120))")
            _ = try render(
                VersionPicturesSideBySide(
                    before: before, after: after,
                    beforeLine: "v1 · 2h ago — The photo as shot: flat and cool",
                    afterLine: "v2 · just now — Warmer grade, lifted shadows, more colour in the sky"
                ),
                width: 960, height: 520, dark: dark, name: "mac-photo-side-\(dark ? "dark" : "light")"
            )
        }
    }

    // MARK: - Side by side

    func testSideBySideShowsEachVersionWholeInItsHalf() throws {
        let before = swatch(0.9, 0.1, 0.1, width: 300, height: 400)
        let after = swatch(0.1, 0.1, 0.9, width: 300, height: 400)
        let wide = try render(
            VersionPicturesSideBySide(before: before, after: after, beforeLine: "v1 · 2h ago — flat grade", afterLine: "v2 · just now — warm grade"),
            width: 800, height: 500, name: "side-by-side-mac"
        )
        XCTAssertTrue(wide.isRed(200, 300))
        XCTAssertTrue(wide.isBlue(600, 300))
        // Two landscape pictures on a phone held upright: stacked, the before on top.
        let tall = try render(
            VersionPicturesSideBySide(
                before: swatch(0.9, 0.1, 0.1, width: 600, height: 400), after: swatch(0.1, 0.1, 0.9, width: 600, height: 400),
                beforeLine: "v1 · 2h ago — flat grade", afterLine: "v2 · just now — warm grade"
            ),
            width: 390, height: 640, name: "side-by-side-phone"
        )
        XCTAssertTrue(tall.isRed(195, 180), "\(tall.at(195, 180))")
        XCTAssertTrue(tall.isBlue(195, 500), "\(tall.at(195, 500))")
    }

    // MARK: - Text

    func testTheDiffTintsWhatChangedAndLeavesTheRestPlain() throws {
        let diff = try XCTUnwrap(TextDiff.between(
            "# Launch notes\n\nShip on Tuesday.\nOwner: Sam\n",
            "# Launch notes\n\nShip on Thursday.\nOwner: Sam\nReviewed by Ana.\n"
        ))
        for dark in [false, true] {
            let pixels = try render(
                VersionTextDiffRows(diff: diff, beforeName: "v1", afterName: "v2", expanded: .constant([])),
                width: 520, height: 200, dark: dark, name: "diff-\(dark ? "dark" : "light")"
            )
            // Some row is tinted red (a removal) and some green (an addition), against the plain ground.
            var red = false
            var green = false
            for y in stride(from: 0, to: pixels.height, by: 2) {
                let c = pixels.at(500, y)
                if c.r > c.g + 8, c.r > c.b + 8 { red = true }
                if c.g > c.r + 8, c.g > c.b { green = true }
            }
            XCTAssertTrue(red, "a removed line is tinted")
            XCTAssertTrue(green, "an added line is tinted")
        }
    }

    func testTheNoticeRenders() throws {
        _ = try render(
            VersionCompareNotice(
                symbol: "doc.on.doc",
                title: "v1 and v2 are the same file",
                detail: "conch keeps a link to each version, not a copy: /tmp/photo.jpg now holds v2."
            ),
            width: 520, height: 240, name: "notice"
        )
    }
}
