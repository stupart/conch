#if os(macOS)
import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// The zoom control and the resizable dividers, drawn offscreen at 2x and measured from their pixels: the control is
/// 100 x 28 with its −, its label and its + each centred in their part, it sits 10 in from the pane's bottom right
/// corner with its right edge on the corner buttons' right edge, and each divider's handle is centred on its hairline or
/// gap. A text that zooms rewraps to the pane at every scale.
///
/// `CONCH_ZOOM_RENDERS=<dir>` also writes each picture as a PNG, to look at.
@MainActor
final class ZoomRenderTests: XCTestCase {
    private static let scale: CGFloat = 2

    private func render(_ view: some View, width: CGFloat, height: CGFloat, dark: Bool = false, name: String) throws -> Pixels {
        let content = view
            .frame(width: width, height: height)
            .background(dark ? ConchColor.ground.dark.color : ConchColor.ground.light.color)
            .environment(\.colorScheme, dark ? .dark : .light)
        let renderer = ImageRenderer(content: content)
        renderer.scale = Self.scale
        let image = try XCTUnwrap(renderer.cgImage)
        if let directory = ProcessInfo.processInfo.environment["CONCH_ZOOM_RENDERS"] {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
            let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
            CGImageDestinationAddImage(destination, image, nil)
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

        /// The smallest rect, in pixels, holding every pixel in `region` that `matches`; nil when none do.
        func bounds(in region: (x: Range<Int>, y: Range<Int>), where matches: ((r: Int, g: Int, b: Int)) -> Bool) -> CGRect? {
            var minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
            for y in region.y where y >= 0 && y < height {
                for x in region.x where x >= 0 && x < width && matches(at(x, y)) {
                    minX = min(minX, x); maxX = max(maxX, x)
                    minY = min(minY, y); maxY = max(maxY, y)
                }
            }
            guard maxX >= 0 else { return nil }
            return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
        }

        /// Pixels that differ from `other` by more than `tolerance` in any channel.
        func differs(from other: Pixels, at x: Int, _ y: Int, tolerance: Int = 6) -> Bool {
            let a = at(x, y), b = other.at(x, y)
            return abs(a.r - b.r) > tolerance || abs(a.g - b.g) > tolerance || abs(a.b - b.b) > tolerance
        }
    }

    private static func isGround(_ c: (r: Int, g: Int, b: Int), dark: Bool) -> Bool {
        let ground = dark ? (0x16, 0x16, 0x15) : (0xF2, 0xF1, 0xEF)
        return abs(c.r - ground.0) <= 2 && abs(c.g - ground.1) <= 2 && abs(c.b - ground.2) <= 2
    }

    /// The glyphs' ink, light or dark: well away from the capsule's own fill.
    private static func isInk(_ c: (r: Int, g: Int, b: Int), dark: Bool) -> Bool {
        dark ? c.r > 110 : c.r < 170
    }

    private let fitted = ContentZoom.picture.readout(.rest, resting: 0.53)
    private let zoomed = ContentZoom.picture.readout(.scale(2.5), resting: 0.53)

    // MARK: The control

    func testTheControlIs100By28WithEachPartCentredInItsSlot() throws {
        for dark in [false, true] {
            for (readout, name) in [(fitted, "fit"), (zoomed, "250")] {
                let pixels = try render(
                    ZoomControl(readout: readout) { _ in }, width: ZoomControl.width, height: ZoomControl.height,
                    dark: dark, name: "zoom-control-\(name)-\(dark ? "dark" : "light")"
                )
                let s = Self.scale
                XCTAssertEqual(CGFloat(pixels.width), ZoomControl.width * s)
                XCTAssertEqual(ZoomControl.width, 100)
                // The capsule fills the frame: its hairline reaches every edge's middle.
                XCTAssertFalse(Self.isGround(pixels.at(0, 28), dark: dark), "left edge")
                XCTAssertFalse(Self.isGround(pixels.at(199, 28), dark: dark), "right edge")
                XCTAssertFalse(Self.isGround(pixels.at(100, 0), dark: dark), "top edge")
                XCTAssertFalse(Self.isGround(pixels.at(100, 55), dark: dark), "bottom edge")
                // And it is a capsule: the corners are the ground.
                XCTAssertTrue(Self.isGround(pixels.at(0, 0), dark: dark), "top left corner \(pixels.at(0, 0))")

                // −, the label and + each centred in their part: 0–28, 28–72, 72–100.
                let rows = 4..<52
                let minus = try XCTUnwrap(pixels.bounds(in: (6..<50, rows)) { Self.isInk($0, dark: dark) })
                let label = try XCTUnwrap(pixels.bounds(in: (58..<142, rows)) { Self.isInk($0, dark: dark) })
                let plus = try XCTUnwrap(pixels.bounds(in: (150..<194, rows)) { Self.isInk($0, dark: dark) })
                XCTAssertEqual(minus.midX, 28, accuracy: 1, "− centred in 0–28: \(minus)")
                XCTAssertEqual(label.midX, 100, accuracy: 1, "label centred in 28–72: \(label)")
                XCTAssertEqual(plus.midX, 172, accuracy: 1, "+ centred in 72–100: \(plus)")
                XCTAssertEqual(minus.midY, 28, accuracy: 1, "− centred top to bottom: \(minus)")
                XCTAssertEqual(plus.midY, 28, accuracy: 1, "+ centred top to bottom: \(plus)")
                XCTAssertEqual(label.midY, 28, accuracy: 1.5, "label centred top to bottom: \(label)")
                // − and + the same height, on one line.
                XCTAssertEqual(minus.midY, plus.midY, accuracy: 0.5)
            }
        }
    }

    func testTheControlSitsTenInFromThePanesCornerAlignedWithTheCornerButtons() throws {
        let target = ZoomTarget()
        target.report(zoomed)
        // Published on the next turn of the main queue.
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(target.readout, zoomed)
        let pane = Rectangle()
            .fill(ConchColor.ground)
            // The corner button, as ReviewView draws it: 28 round, 10 in from the top right.
            .overlay(alignment: .topTrailing) {
                Circle().fill(Color.red).frame(width: 28, height: 28).padding(10)
            }
            .overlay(alignment: .bottomTrailing) { ZoomOverlay(target: target) }
        let pixels = try render(pane, width: 400, height: 300, name: "zoom-overlay-zoomed")
        let control = try XCTUnwrap(pixels.bounds(in: (400..<800, 300..<600)) { !Self.isGround($0, dark: false) })
        let corner = try XCTUnwrap(pixels.bounds(in: (600..<800, 0..<200)) { $0.r > 200 && $0.g < 80 })
        // In points: x 290–390, y 262–290.
        XCTAssertEqual(control.minX / 2, 290, accuracy: 0.5, "\(control)")
        XCTAssertEqual(control.maxX / 2, 390, accuracy: 0.5, "\(control)")
        XCTAssertEqual(control.minY / 2, 262, accuracy: 0.5, "\(control)")
        XCTAssertEqual(control.maxY / 2, 290, accuracy: 0.5, "\(control)")
        // Its right edge on the corner button's.
        XCTAssertEqual(control.maxX, corner.maxX, accuracy: 1, "control \(control), corner button \(corner)")
    }

    func testAtRestTheControlIsHiddenUntilThePointerIsOverTheDeliverable() throws {
        let target = ZoomTarget()
        target.report(fitted)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        let pane = Rectangle().fill(ConchColor.ground).overlay(alignment: .bottomTrailing) { ZoomOverlay(target: target) }
        let pixels = try render(pane, width: 400, height: 300, name: "zoom-overlay-rest")
        XCTAssertNil(pixels.bounds(in: (0..<800, 0..<600)) { !Self.isGround($0, dark: false) }, "nothing drawn at rest")
    }

    // MARK: The dividers

    func testTheTreesHandleIsCentredOnItsHairline() throws {
        func split(grip: Bool) -> some View {
            ConchSplitView(split: .fileTree, width: .constant(232), label: "Resize", showsGrip: grip) {
                Color(red: 1, green: 0, blue: 0)
            } trailing: {
                Color(red: 0, green: 0, blue: 1)
            }
        }
        let plain = try render(split(grip: false), width: 600, height: 200, name: "split-tree")
        let gripped = try render(split(grip: true), width: 600, height: 200, name: "split-tree-grip")
        // The tree 232 wide, the hairline its own point (464–465 px), the file the rest: no seam either side.
        let y = 20
        XCTAssertTrue(plain.at(463, y).r > 240 && plain.at(463, y).b < 15, "tree to 232: \(plain.at(463, y))")
        XCTAssertFalse(plain.at(464, y).r > 240, "the hairline at 232: \(plain.at(464, y))")
        XCTAssertFalse(plain.at(465, y).b > 240, "the hairline to 233: \(plain.at(465, y))")
        XCTAssertTrue(plain.at(466, y).b > 240 && plain.at(466, y).r < 15, "the file from 233: \(plain.at(466, y))")
        // The handle, found by its grip, centred on the hairline's middle (232.5 pt, 465 px) and up and down.
        var grip = CGRect.null
        for x in 440..<490 {
            for y in 0..<400 where gripped.differs(from: plain, at: x, y) {
                grip = grip.union(CGRect(x: x, y: y, width: 1, height: 1))
            }
        }
        XCTAssertFalse(grip.isNull)
        XCTAssertEqual(grip.midX, 465, accuracy: 0.5, "grip \(grip)")
        XCTAssertEqual(grip.midY, 200, accuracy: 0.5, "grip \(grip)")
        // The grip on a line, 5 wide so it lands on whole points either side of the line's middle, and 28 tall.
        XCTAssertEqual(grip.width, PaneDividerHandle.lineGrip.width * 2, accuracy: 1)
        XCTAssertEqual(grip.height, PaneDividerHandle.lineGrip.height * 2, accuracy: 1)
        XCTAssertEqual(grip.minX, 460, accuracy: 0.5, "grip \(grip)")
        XCTAssertEqual(ConchSplitView<Color, Color>.handleOffset(leading: 232), 224.5)
    }

    func testTwoVersionsGripIsCentredInTheGapBetweenThem() throws {
        func panes(_ split: Binding<Double>?) -> some View {
            VersionPanes(beforeLine: "v1", afterLine: "v2", spacing: 12, split: split) {
                Color(red: 1, green: 0, blue: 0)
            } after: {
                Color(red: 0, green: 0, blue: 1)
            }
        }
        let equal = try render(panes(nil), width: 600, height: 300, name: "split-compare-equal")
        let resizable = try render(panes(.constant(0.5)), width: 600, height: 300, name: "split-compare")
        // Halved, the resizable panes are where the equal ones were: before 0–294, the gap 294–306, after 306–600.
        XCTAssertTrue(resizable.at(587, 200).r > 240, "\(resizable.at(587, 200))")
        XCTAssertTrue(resizable.at(613, 200).b > 240, "\(resizable.at(613, 200))")
        var grip = CGRect.null
        for x in 560..<640 {
            for y in 0..<600 where resizable.differs(from: equal, at: x, y) {
                grip = grip.union(CGRect(x: x, y: y, width: 1, height: 1))
            }
        }
        XCTAssertFalse(grip.isNull)
        // The grip, and so the handle, in the gap's middle (300 pt) and halfway down.
        XCTAssertEqual(grip.midX, 600, accuracy: 0.5, "grip \(grip)")
        XCTAssertEqual(grip.midY, 300, accuracy: 0.5, "grip \(grip)")
        XCTAssertEqual(VersionPanes<Color, Color>.handleOffset(leading: 294, spacing: 12), 292)

        // Dragged wider, the before is: 0.6 of the 588 they share.
        let wider = try render(panes(.constant(0.6)), width: 600, height: 300, name: "split-compare-60")
        let before = try XCTUnwrap(wider.bounds(in: (0..<1200, 100..<500)) { $0.r > 240 && $0.b < 15 })
        XCTAssertEqual(before.width / 2, PaneFraction.compare.leadingWidth(0.6, in: 588), accuracy: 0.5)
    }

    // MARK: A text that zooms

    func testATextZoomedRewrapsToThePaneAndComesBack() throws {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: true)
        let scroll = ZoomingTextScrollView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
        scroll.hasVerticalScroller = true
        let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
        _ = text.layoutManager
        text.isVerticallyResizable = true
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        // In the scroll view first, as the pane does: grown with no flipped superview, a text view grows upwards.
        scroll.documentView = text
        text.string = (1...400).map { "Line \($0) of a deliverable that wraps when it is narrow enough to." }.joined(separator: "\n")
        window.contentView = scroll
        scroll.layoutSubtreeIfNeeded()
        let whole = scroll.contentView.bounds.width
        XCTAssertEqual(text.frame.width, whole, accuracy: 0.5)
        XCTAssertEqual(scroll.readout.label, "100%")
        XCTAssertFalse(scroll.readout.canToggle)

        // Line 120 at the top, then in a step: 110%, the text as wide as what shows at that scale, line 120 still on top.
        let layout = try XCTUnwrap(text.layoutManager)
        let lineStart = (text.string as NSString).range(of: "Line 120 ").location
        layout.ensureLayout(forCharacterRange: NSRange(location: 0, length: lineStart + 1))
        let lineTop = layout.lineFragmentRect(forGlyphAt: layout.glyphIndexForCharacter(at: lineStart), effectiveRange: nil).minY
        scroll.contentView.scroll(to: NSPoint(x: 0, y: lineTop + text.textContainerOrigin.y))
        scroll.zoom(.zoomIn)
        XCTAssertEqual(scroll.magnification, 1.1, accuracy: 0.001)
        XCTAssertEqual(scroll.readout.label, "110%")
        XCTAssertEqual(text.frame.width, scroll.contentView.bounds.width, accuracy: 0.5)
        XCTAssertEqual(text.frame.width, whole / 1.1, accuracy: 1)
        let top = scroll.documentVisibleRect.minY - text.textContainerOrigin.y + 1
        let glyph = layout.glyphIndex(for: NSPoint(x: 1, y: top), in: try XCTUnwrap(text.textContainer))
        let shown = (text.string as NSString).substring(from: layout.characterIndexForGlyph(at: glyph))
        XCTAssertTrue(shown.hasPrefix("Line 120 "), "the top line after zooming: \(shown.prefix(20))")

        // ⌘0 back to 100%, as wide as the pane.
        scroll.zoom(.reset)
        XCTAssertEqual(scroll.magnification, 1, accuracy: 0.001)
        XCTAssertEqual(text.frame.width, whole, accuracy: 0.5)
        XCTAssertTrue(scroll.readout.isAtRest)
        _ = window
    }
}
#endif
