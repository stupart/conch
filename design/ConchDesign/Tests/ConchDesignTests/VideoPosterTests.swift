import CoreGraphics
@testable import ConchDesign
import XCTest

/// A video deliverable's poster (`VideoPoster`), read off real movies written here (`VideoFramesTests.movie`, a second a
/// shade): where its frame is taken, the shape a card reserves for it, how long it runs, and none for what isn't a
/// video. Pictures only, as every video test here: a movie with sound sent the suite through macOS's audio stack, which
/// checked the microphone and beeped on every gate run (2026-11-12).
final class VideoPosterTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("conch-video-poster-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testThePosterIsATenthInNoSoonerThanHalfASecondAndNoLaterThanThree() {
        XCTAssertEqual(VideoPoster.moment(length: 15), 1.5)
        XCTAssertEqual(VideoPoster.moment(length: 2), 0.5)
        XCTAssertEqual(VideoPoster.moment(length: 600), 3)
        // Shorter than half a second: its middle, not its last instant.
        XCTAssertEqual(VideoPoster.moment(length: 0.4), 0.2)
        XCTAssertNil(VideoPoster.moment(length: 0))
        XCTAssertNil(VideoPoster.moment(length: .nan))
    }

    func testALandscapeVideosPosterIsItsFrameATenthInAtItsOwnShape() async throws {
        let movie = try await VideoFramesTests.movie(at: folder.appendingPathComponent("shades.mov"), seconds: 20)
        let read = await VideoPoster.poster(atPath: movie.path, maxPixelSize: 160)
        let poster = try XCTUnwrap(read)
        XCTAssertEqual(poster.at, 2)
        XCTAssertEqual(poster.length, 20, accuracy: 0.3)
        XCTAssertEqual(poster.aspect, 16.0 / 9.0, accuracy: 0.001)
        XCTAssertEqual([poster.image.width, poster.image.height], [160, 90])
        // The third second's grey, from the moment on, not the first frame's black.
        XCTAssertEqual(try shade(of: poster.image), 106, accuracy: 12)
    }

    func testAPortraitRecordingIsTallByItsTransform() async throws {
        let quarterTurn = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 180, ty: 0)
        let movie = try await VideoFramesTests.movie(at: folder.appendingPathComponent("portrait.mov"), seconds: 3, transform: quarterTurn)
        let read = await VideoPoster.poster(atPath: movie.path, maxPixelSize: 160)
        let poster = try XCTUnwrap(read)
        XCTAssertEqual(poster.aspect, 9.0 / 16.0, accuracy: 0.001)
        XCTAssertEqual([poster.image.width, poster.image.height], [90, 160])
        XCTAssertEqual(poster.length, 3, accuracy: 0.3)
    }

    func testAPosterIsReadOnceUntilTheVideoIsRewritten() async throws {
        let url = folder.appendingPathComponent("render.mp4")
        _ = try await VideoFramesTests.movie(at: url, seconds: 2)
        XCTAssertNil(VideoPoster.cached(atPath: url.path, maxPixelSize: 160), "nothing read yet: the card shows its symbol")
        let first = await VideoPoster.poster(atPath: url.path, maxPixelSize: 160)
        XCTAssertNotNil(first)
        XCTAssertEqual(VideoPoster.cached(atPath: url.path, maxPixelSize: 160)?.key, first?.key, "and once read, drawn at once")

        // Rendered again under the same name, longer: another video, and not the poster it had.
        try FileManager.default.removeItem(at: url)
        _ = try await VideoFramesTests.movie(at: url, seconds: 4)
        XCTAssertNil(VideoPoster.cached(atPath: url.path, maxPixelSize: 160))
        let second = await VideoPoster.poster(atPath: url.path, maxPixelSize: 160)
        XCTAssertEqual(try XCTUnwrap(second).length, 4, accuracy: 0.3)
    }

    func testAFileThatIsNotAVideoHasNoPoster() async throws {
        let notAVideo = folder.appendingPathComponent("notes.mov")
        try Data("not a movie".utf8).write(to: notAVideo)
        let unreadable = await VideoPoster.poster(atPath: notAVideo.path, maxPixelSize: 160)
        XCTAssertNil(unreadable)
        let missing = await VideoPoster.poster(atPath: folder.appendingPathComponent("gone.mp4").path, maxPixelSize: 160)
        XCTAssertNil(missing)
    }

    /// A frame's grey, 0–255: each of the movie's frames is one shade all over.
    private func shade(of image: CGImage) throws -> Double {
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = try XCTUnwrap(CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return Double(pixel[1])
    }
}
