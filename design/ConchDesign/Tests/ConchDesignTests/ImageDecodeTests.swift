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
}
