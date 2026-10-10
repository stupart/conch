import AVFoundation
import CoreGraphics
@testable import ConchDesign
import XCTest

/// The sound and the contact sheet pulled off a real video, as the phone and the Mac's composer both pull them
/// (`VideoFrames.swift`): a movie written here, a second a shade, with a tone under it, or none.
final class VideoFramesTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("conch-video-frames-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testItsSoundIsTheWavTheDaemonTakes() async throws {
        let movie = try await Self.movie(at: folder.appendingPathComponent("tone.mov"), seconds: 4, sound: true)
        let heard = try await VideoStoryboard.speech(of: movie)
        let wav = try XCTUnwrap(heard)
        XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(String(decoding: wav[8..<16], as: UTF8.self), "WAVEfmt ")
        let field = { (offset: Int, size: Int) -> Int in wav[offset..<offset + size].reversed().reduce(0) { $0 << 8 | Int($1) } }
        XCTAssertEqual(field(20, 2), 1, "PCM")
        XCTAssertEqual(field(22, 2), 1, "mono")
        XCTAssertEqual(field(24, 4), 16_000, "16 kHz")
        XCTAssertEqual(field(34, 2), 16, "16-bit")
        XCTAssertEqual(field(40, 4), wav.count - 44, "the data chunk is the rest of the file")
        // Four seconds of 16 kHz 16-bit mono is 128,000 bytes; AAC's priming can move it a little.
        XCTAssertEqual(Double(wav.count - 44), 128_000, accuracy: 128_000 * 0.1)
    }

    func testASilentVideoHasNoSound() async throws {
        let movie = try await Self.movie(at: folder.appendingPathComponent("silent.mov"), seconds: 3, sound: false)
        let wav = try await VideoStoryboard.speech(of: movie)
        XCTAssertNil(wav)
    }

    func testOnlyItsFirstTwoMinutesAreHeard() async throws {
        let movie = try await Self.movie(at: folder.appendingPathComponent("long.mov"), seconds: 126, sound: true, fps: 1)
        let heard = try await VideoStoryboard.speech(of: movie)
        let wav = try XCTUnwrap(heard)
        XCTAssertLessThanOrEqual(wav.count - 44, Int(VideoStoryboard.longest) * 32_000 + 32_000)
        XCTAssertGreaterThan(wav.count - 44, Int(VideoStoryboard.longest - 5) * 32_000)
    }

    func testTheSheetIsAJpegOfItsMomentsEndingAtTheEnd() async throws {
        let movie = try await Self.movie(at: folder.appendingPathComponent("shades.mov"), seconds: 7, sound: false)
        let said = [CanvasStoryboard.Said(start: 1, end: 2.2, text: "this one")]
        let pulled = await VideoStoryboard.sheet(of: movie, said: said, length: 7)
        let sheet = try XCTUnwrap(pulled)
        XCTAssertEqual(Array(sheet.jpeg.prefix(3)), [0xFF, 0xD8, 0xFF])
        XCTAssertGreaterThanOrEqual(sheet.frames.count, 2)
        XCTAssertLessThanOrEqual(sheet.frames.count, CanvasStoryboard.most)
        XCTAssertEqual(sheet.frames.last?.kind, .end)
        // Where he finished saying something is looked at.
        XCTAssertTrue(sheet.frames.contains { $0.kind == .said && abs($0.at - 2.2) < 0.01 })
        let image = try XCTUnwrap(CGImageSourceCreateWithData(sheet.jpeg as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) })
        XCTAssertLessThanOrEqual(max(image.width, image.height), Int(VideoStoryboard.longEdge))
    }

    func testAFileWithNoPicturesHasNoSheet() async throws {
        let notAVideo = folder.appendingPathComponent("notes.mov")
        try Data("not a movie".utf8).write(to: notAVideo)
        let sheet = await VideoStoryboard.sheet(of: notAVideo, said: [], length: 3)
        XCTAssertNil(sheet)
    }

    // MARK: A movie to read

    /// `seconds` long, 320x180, each second a different shade; with a 440 Hz tone under it when `sound`.
    static func movie(at url: URL, seconds: Int, sound: Bool, fps: Int32 = 4) async throws -> URL {
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
        var tone: AVAssetWriterInput?
        if sound {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000,
            ])
            input.expectsMediaDataInRealTime = false
            writer.add(input)
            tone = input
        }
        guard writer.startWriting() else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        writer.startSession(atSourceTime: .zero)
        // Whichever input the writer is ready for, until both are done: it interleaves them, and holds back the one
        // that is ahead.
        let frames = seconds * Int(fps), chunks = sound ? seconds * 4 : 0
        var frame = 0, chunk = 0, idle = 0
        while frame < frames || chunk < chunks {
            var moved = false
            if frame < frames, picture.isReadyForMoreMediaData {
                let buffer = try pixels(shade: UInt8((frame / Int(fps) * 53) % 256))
                guard adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: fps)) else {
                    throw writer.error ?? CocoaError(.fileWriteUnknown)
                }
                frame += 1
                moved = true
            }
            if let tone, chunk < chunks, tone.isReadyForMoreMediaData {
                guard tone.append(try toneQuarter(chunk)) else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
                chunk += 1
                moved = true
            }
            if moved { idle = 0 } else {
                idle += 1
                guard idle < 2_000 else { throw CocoaError(.fileWriteUnknown) }
                try await Task.sleep(for: .milliseconds(5))
            }
        }
        picture.markAsFinished()
        tone?.markAsFinished()
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

    /// A quarter of a second of a 440 Hz tone, the `index`th, 44.1 kHz mono 16-bit.
    private static func toneQuarter(_ index: Int) throws -> CMSampleBuffer {
        let rate = 44_100, count = 44_100 / 4, first = index * count
        var description = AudioStreamBasicDescription(
            mSampleRate: Double(rate), mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
            mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0
        )
        var format: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: nil, asbd: &description, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                       magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
        let samples = (first..<first + count).map { Int16(8_000 * sin(2 * Double.pi * 440 * Double($0) / Double(rate))) }
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: count * 2, blockAllocator: nil,
                                           customBlockSource: nil, offsetToData: 0, dataLength: count * 2, flags: 0, blockBufferOut: &block)
        let data = try XCTUnwrap(block)
        samples.withUnsafeBytes { _ = CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: data, offsetIntoDestination: 0, dataLength: count * 2) }
        var sample: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: nil, dataBuffer: data, formatDescription: try XCTUnwrap(format), sampleCount: count,
            presentationTimeStamp: CMTime(value: Int64(first), timescale: CMTimeScale(rate)),
            packetDescriptions: nil, sampleBufferOut: &sample
        )
        return try XCTUnwrap(sample)
    }
}
