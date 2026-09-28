import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import ConchDesign

/// A picture a row draws: named by the file as it is now, and shaped before it is decoded.
///
/// The review of #443 (finding 24): the cache key was the path and the size drawn at, so a picture
/// rewritten where it was — a canvas rendered again, a screenshot retaken under the same name —
/// kept showing the old one; and the decode ran in `body`, on the main thread.
final class ImageDecodeTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("conch-image-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func png(width: Int, height: Int, red: CGFloat, green: CGFloat, blue: CGFloat) throws -> Data {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(red: red, green: green, blue: blue, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    /// The colour in the middle of a decoded picture, as 0–255 red, green and blue.
    private func colour(of image: CGImage) throws -> [Int] {
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = try XCTUnwrap(CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return pixel.prefix(3).map { Int($0) }
    }

    func testAPictureRewrittenWhereItWasIsDrawnAsItIsNow() throws {
        let path = directory.appendingPathComponent("shot.png").path
        try png(width: 40, height: 20, red: 1, green: 0, blue: 0).write(to: URL(fileURLWithPath: path))
        let first = try XCTUnwrap(ConchImage.picture(atPath: path))
        XCTAssertEqual(first.aspect, 2, "its shape, read without decoding it")
        XCTAssertNil(ConchImage.decoded(first, maxPixelSize: 64), "nothing decoded yet: the row reserves the shape and decodes off the main thread")
        let red = try XCTUnwrap(ConchImage.decode(first, maxPixelSize: 64))
        XCTAssertEqual(try colour(of: red), [255, 0, 0])
        XCTAssertNotNil(ConchImage.decoded(first, maxPixelSize: 64), "and once decoded, drawn at once")

        // The same path, rewritten: another picture, another shape.
        try png(width: 20, height: 40, red: 0, green: 0, blue: 1).write(to: URL(fileURLWithPath: path))
        let second = try XCTUnwrap(ConchImage.picture(atPath: path))
        XCTAssertNotEqual(second.key, first.key)
        XCTAssertNotEqual(second, first)
        XCTAssertEqual(second.aspect, 0.5)
        XCTAssertNil(ConchImage.decoded(second, maxPixelSize: 64), "the old decode is not this file's")
        let blue = try XCTUnwrap(ConchImage.decode(second, maxPixelSize: 64))
        XCTAssertEqual(try colour(of: blue), [0, 0, 255])
        XCTAssertEqual([blue.width, blue.height], [20, 40])
    }

    func testTheKeyIsTheFileAsItIsNowItsModificationTimeAndSize() throws {
        let url = directory.appendingPathComponent("canvas.png")
        try Data(repeating: 1, count: 100).write(to: url)
        let modified = Date(timeIntervalSince1970: 1_800_000_000)
        try FileManager.default.setAttributes([.modificationDate: modified], ofItemAtPath: url.path)
        let key = try XCTUnwrap(ConchImage.key(forPath: url.path))
        XCTAssertEqual(ConchImage.key(forPath: url.path), key, "the same file is the same key")
        XCTAssertTrue(key.hasPrefix(url.path))

        // Written again with as many bytes: only the time says so.
        try Data(repeating: 2, count: 100).write(to: url)
        try FileManager.default.setAttributes([.modificationDate: modified.addingTimeInterval(1)], ofItemAtPath: url.path)
        XCTAssertNotEqual(ConchImage.key(forPath: url.path), key)

        // Written again and its time put back: only the size says so.
        try Data(repeating: 2, count: 101).write(to: url)
        try FileManager.default.setAttributes([.modificationDate: modified], ofItemAtPath: url.path)
        XCTAssertNotEqual(ConchImage.key(forPath: url.path), key)

        XCTAssertNil(ConchImage.key(forPath: directory.appendingPathComponent("gone.png").path), "nothing there")
        XCTAssertNil(ConchImage.key(forPath: directory.path), "a folder is not a picture")
        XCTAssertNil(ConchImage.picture(atPath: url.path), "nor are bytes that are not one")
    }

    func testAnInlinePictureIsNamedByItsBytesAndShapedLikeAFile() throws {
        let data = try png(width: 30, height: 10, red: 0, green: 1, blue: 0)
        let url = "data:image/png;base64," + data.base64EncodedString()
        let picture = try XCTUnwrap(ConchImage.picture(dataURL: url))
        XCTAssertEqual(picture.aspect, 3)
        XCTAssertEqual(ConchImage.picture(dataURL: url), picture)
        let decoded = try XCTUnwrap(ConchImage.decode(picture, maxPixelSize: 64))
        XCTAssertEqual(try colour(of: decoded), [0, 255, 0])
        XCTAssertNil(ConchImage.picture(dataURL: "data:image/png;base64,not-base64!"))
    }

    // MARK: A picture drawn at a width

    /// A PNG with a resolution in it, as a Retina screenshot is saved (144 dpi).
    private func png(width: Int, height: Int, dpi: Double) throws -> Data {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()),
                                   [kCGImagePropertyDPIWidth: dpi, kCGImagePropertyDPIHeight: dpi] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    /// Tyler: "some tall vertical images in the deliverable / review area are blurry". A tall picture decoded for the
    /// width it is drawn at is at least that many pixels wide, the height following — never bounded by its long edge,
    /// which is a thumbnail's rule and made a tall capture a sliver drawn magnified.
    func testATallPictureDecodedForItsDrawnWidthIsAtLeastThatWideInPixels() throws {
        for (width, height) in [(1600, 6400), (1440, 2792)] {
            let url = directory.appendingPathComponent("tall-\(width)x\(height).png")
            try png(width: width, height: height, red: 0.2, green: 0.4, blue: 0.6).write(to: url)
            let picture = try XCTUnwrap(ConchImage.picture(atPath: url.path))
            XCTAssertEqual(picture.pixels, CGSize(width: width, height: height))
            // Side by Side, the stage, full screen at 1x, a phone at 3x: points times the backing scale.
            for (points, scale) in [(488.0, 2.0), (700.0, 2.0), (1028.0, 1.0), (390.0, 3.0)] {
                let drawn = CGFloat(points * scale)
                let image = try XCTUnwrap(ConchImage.decode(picture, forWidth: drawn))
                let wanted = min(drawn, CGFloat(width))
                XCTAssertGreaterThanOrEqual(CGFloat(image.width), wanted, "\(width)x\(height) drawn \(points) pt at \(scale)x")
                XCTAssertLessThanOrEqual(CGFloat(image.width), wanted + 1, "no wider than it is drawn: the memory is the point")
                XCTAssertEqual(CGFloat(image.height), CGFloat(image.width) * CGFloat(height) / CGFloat(width), accuracy: 1.5, "the height follows")
            }
            // The long-edge bound it replaces: 2,048 pixels tall is a fraction of the width a pane draws it at.
            let bounded = try XCTUnwrap(ConchImage.thumbnail(atPath: url.path, maxPixelSize: 2_048))
            XCTAssertLessThan(bounded.width, 1_400, "the old rule: \(bounded.width) pixels for a 700-point pane at 2x")
        }
    }

    /// Never wider than the picture is — a narrow one is drawn magnified, not decoded bigger — and never more than the
    /// budget: a capture far longer than any screen is decoded narrower, the only place anything is given up.
    func testADecodeIsNeverWiderThanThePictureNorBiggerThanTheBudget() throws {
        let url = directory.appendingPathComponent("narrow.png")
        try png(width: 576, height: 2400, red: 1, green: 1, blue: 1).write(to: url)
        let narrow = try XCTUnwrap(ConchImage.picture(atPath: url.path))
        let whole = try XCTUnwrap(ConchImage.decode(narrow, forWidth: 2_200))
        XCTAssertEqual([whole.width, whole.height], [576, 2400], "whole, not magnified in the decode")

        let tall = CGSize(width: 2880, height: 30000)
        XCTAssertEqual(ConchImage.decodeWidth(forDrawnWidth: 2056, of: tall), 2056, "a 2x page 30,000 pixels long, a pixel to a pixel")
        XCTAssertLessThanOrEqual(2056 * 2056 * 30000 / 2880, Int(ConchImage.drawnPixelBudget))
        let budget: CGFloat = 10_000_000
        let squeezed = ConchImage.decodeWidth(forDrawnWidth: 2056, of: tall, budget: budget)
        XCTAssertLessThan(squeezed, 2056)
        XCTAssertLessThanOrEqual(CGFloat(squeezed) * CGFloat(squeezed) * 30000 / 2880, budget)
        XCTAssertGreaterThan(CGFloat(squeezed + 2) * CGFloat(squeezed + 2) * 30000 / 2880, budget, "and no narrower than the budget makes it")

        let squeezedFile = directory.appendingPathComponent("long.png")
        try png(width: 400, height: 8000, red: 0, green: 0, blue: 0).write(to: squeezedFile)
        let long = try XCTUnwrap(ConchImage.picture(atPath: squeezedFile.path))
        let small = try XCTUnwrap(ConchImage.decode(long, forWidth: 400, budget: 800_000))
        XCTAssertLessThanOrEqual(small.width * small.height, 800_000 + small.height, "within the budget, give or take a column")
        XCTAssertEqual(small.width, 200, accuracy: 1)
        XCTAssertEqual(ConchImage.decodeWidth(forDrawnWidth: 0, of: tall), 0)
        XCTAssertEqual(ConchImage.decodeWidth(forDrawnWidth: 100, of: .zero), 0)
    }

    /// ImageIO bounds the long edge, so the edge asked for is whichever side the wanted width makes longest.
    func testTheLongEdgeAskedForGivesTheWidthWanted() {
        XCTAssertEqual(ConchImage.longEdge(forWidth: 500, of: CGSize(width: 1000, height: 3000)), 1500, "tall: its height at that width")
        XCTAssertEqual(ConchImage.longEdge(forWidth: 1500, of: CGSize(width: 3000, height: 1000)), 1500, "wide: the width itself")
        XCTAssertEqual(ConchImage.longEdge(forWidth: 976, of: CGSize(width: 1440, height: 2792)), 1893, "rounded up, never a pixel short")
        XCTAssertEqual(ConchImage.longEdge(forWidth: 1000, of: CGSize(width: 1000, height: 3000)), 3000, "its own width: whole")
        XCTAssertEqual(ConchImage.longEdge(forWidth: 4000, of: CGSize(width: 1000, height: 3000)), 3000, "wider than it is: whole")
        XCTAssertEqual(ConchImage.longEdge(forWidth: 0, of: CGSize(width: 1000, height: 3000)), 0)
    }

    /// Its size in points is NSImage's: the resolution it carries, 72 dpi when it says none — the viewer lays out by it,
    /// so a Retina screenshot is drawn at its size on the screen it was taken on.
    func testAPictureMeasuresItsPointsByTheResolutionItCarries() throws {
        let retina = directory.appendingPathComponent("retina.png")
        try png(width: 1200, height: 3000, dpi: 144).write(to: retina)
        let shot = try XCTUnwrap(ConchImage.picture(atPath: retina.path))
        XCTAssertEqual(shot.pixels, CGSize(width: 1200, height: 3000))
        XCTAssertEqual(shot.points.width, 600, accuracy: 0.01)
        XCTAssertEqual(shot.points.height, 1500, accuracy: 0.01)

        let plain = directory.appendingPathComponent("plain.png")
        try png(width: 1200, height: 3000, red: 0, green: 0, blue: 0).write(to: plain)
        XCTAssertEqual(try XCTUnwrap(ConchImage.picture(atPath: plain.path)).points, CGSize(width: 1200, height: 3000))
    }
}
