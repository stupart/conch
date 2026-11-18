#if os(macOS)
import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// The zoom control and the resizable dividers, drawn offscreen at 2x and measured from their pixels: the control hides
/// at rest, a dragged split moves the panes, and a text that zooms rewraps to the pane at every scale.
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
    }

    private static func isGround(_ c: (r: Int, g: Int, b: Int), dark: Bool) -> Bool {
        let ground = dark ? (0x16, 0x16, 0x15) : (0xF2, 0xF1, 0xEF)
        return abs(c.r - ground.0) <= 2 && abs(c.g - ground.1) <= 2 && abs(c.b - ground.2) <= 2
    }

    // MARK: The control

    func testAtRestTheControlIsHiddenUntilThePointerIsOverTheDeliverable() throws {
        func drawn(_ readout: ZoomReadout) throws -> CGRect? {
            let target = ZoomTarget()
            target.report(readout)
            // Published on the next turn of the main queue.
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            let pane = Rectangle().fill(ConchColor.ground).overlay(alignment: .bottomTrailing) { ZoomOverlay(target: target) }
            let pixels = try render(pane, width: 400, height: 300, name: "zoom-overlay")
            return pixels.bounds(in: (0..<800, 0..<600)) { !Self.isGround($0, dark: false) }
        }
        let rest = try drawn(ContentZoom.picture.readout(.rest, resting: 0.53))
        let zoomed = try drawn(ContentZoom.picture.readout(.scale(2.5), resting: 0.53))
        XCTAssertNil(rest, "nothing drawn at rest")
        XCTAssertNotNil(zoomed, "zoomed, the control shows")
    }

    // MARK: The dividers

    func testADraggedSplitWidensTheBeforePane() throws {
        let panes = VersionPanes(beforeLine: "v1", afterLine: "v2", spacing: 12, split: .constant(0.6)) {
            Color(red: 1, green: 0, blue: 0)
        } after: {
            Color(red: 0, green: 0, blue: 1)
        }
        // Dragged wider, the before is 0.6 of the 588 they share.
        let wider = try render(panes, width: 600, height: 300, name: "split-compare-60")
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
