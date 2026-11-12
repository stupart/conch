import AVFoundation
import CoreGraphics
@testable import ConchDesign
import XCTest

/// The contact sheet pulled off a real video, as the phone and the Mac's composer both pull it (`VideoFrames.swift`): a
/// movie written here, a second a shade. Pictures only: a video's sound is never read (2026-11-12), and a movie with
/// sound in it sent this test through macOS's audio stack, which checked the microphone and beeped on every gate run
/// (test/conch-design-silent.test.ts keeps it out).
final class VideoFramesTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("conch-video-frames-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testTheSheetIsAJpegOfItsMomentsEndingAtTheEnd() async throws {
        let movie = try await Self.movie(at: folder.appendingPathComponent("shades.mov"), seconds: 7)
        let pulled = await VideoStoryboard.sheet(of: movie, length: 7)
        let sheet = try XCTUnwrap(pulled)
        XCTAssertEqual(Array(sheet.jpeg.prefix(3)), [0xFF, 0xD8, 0xFF])
        XCTAssertGreaterThanOrEqual(sheet.frames.count, 2)
        XCTAssertLessThanOrEqual(sheet.frames.count, CanvasStoryboard.most)
        XCTAssertEqual(sheet.frames.last?.kind, .end)
        // Looked at every three seconds, by nothing anyone said.
        XCTAssertEqual(sheet.frames.first?.at ?? -1, 0.1, accuracy: 0.01)
        XCTAssertTrue(sheet.frames.allSatisfy { $0.kind == .look || $0.kind == .end })
        let image = try XCTUnwrap(CGImageSourceCreateWithData(sheet.jpeg as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) })
        XCTAssertLessThanOrEqual(max(image.width, image.height), Int(VideoStoryboard.longEdge))
    }

    func testAFileWithNoPicturesHasNoSheet() async throws {
        let notAVideo = folder.appendingPathComponent("notes.mov")
        try Data("not a movie".utf8).write(to: notAVideo)
        let sheet = await VideoStoryboard.sheet(of: notAVideo, length: 3)
        XCTAssertNil(sheet)
    }

    // MARK: A movie to read

    /// `seconds` long, 320x180, each second a different shade. No sound track.
    static func movie(at url: URL, seconds: Int, fps: Int32 = 4) async throws -> URL {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let picture = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 320, AVVideoHeightKey: 180,
        ])
        picture.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: picture, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: 320,
            kCVPixelBufferHeightKey as String: 180,
        ])
        writer.add(picture)
        guard writer.startWriting() else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        writer.startSession(atSourceTime: .zero)
        let frames = seconds * Int(fps)
        var frame = 0, idle = 0
        while frame < frames {
            guard picture.isReadyForMoreMediaData else {
                idle += 1
                guard idle < 2_000 else { throw CocoaError(.fileWriteUnknown) }
                try await Task.sleep(for: .milliseconds(5))
                continue
            }
            idle = 0
            let buffer = try pixels(shade: UInt8((frame / Int(fps) * 53) % 256))
            guard adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: fps)) else {
                throw writer.error ?? CocoaError(.fileWriteUnknown)
            }
            frame += 1
        }
        picture.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        return url
    }

    private static func pixels(shade: UInt8) throws -> CVPixelBuffer {
        var made: CVPixelBuffer?
        CVPixelBufferCreate(nil, 320, 180, kCVPixelFormatType_32BGRA, nil, &made)
        let buffer = try XCTUnwrap(made)
        CVPixelBufferLockBaseAddress(buffer, [])
        memset(CVPixelBufferGetBaseAddress(buffer), Int32(shade), CVPixelBufferGetDataSize(buffer))
        CVPixelBufferUnlockBaseAddress(buffer, [])
        return buffer
    }
}
