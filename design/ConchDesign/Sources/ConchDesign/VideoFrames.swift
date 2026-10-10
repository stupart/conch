import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// What a video is made into for an agent, pulled off the video itself: its sound as whisper takes it, and its contact
// sheet (`VideoStoryboard`). One way for both apps: the phone runs it on the video it picked and transcoded
// (`VideoUpload.swift` there), the Mac on the file dropped or picked on its composer (`ComposerVideo.swift` there). The
// daemon transcribes the sound for both, and the words choose where the frames are taken.

extension VideoStoryboard {
    /// Its sound as whisper takes it: 16 kHz mono 16-bit PCM in a WAV, the first `longest` seconds. Nil with no sound.
    public static func speech(of source: URL) async throws -> Data? {
        let asset = AVURLAsset(url: source)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { return nil }
        let duration = try await asset.load(.duration)
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(start: .zero, duration: CMTimeMinimum(duration, CMTime(seconds: longest, preferredTimescale: 600)))
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? CocoaError(.fileReadCorruptFile) }
        var pcm = Data()
        while let sample = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
            let length = CMBlockBufferGetDataLength(block)
            var bytes = Data(count: length)
            let copied = bytes.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
            if copied == kCMBlockBufferNoErr { pcm.append(bytes) }
        }
        guard reader.status == .completed, !pcm.isEmpty else { return nil }
        return wavHeader(pcmBytes: pcm.count) + pcm
    }

    /// A canonical 44-byte WAV header for 16 kHz mono 16-bit PCM: the one shape the daemon takes as a recording
    /// (`isSpeechWav` in `phone-uploads.ts`).
    public static func wavHeader(pcmBytes: Int) -> Data {
        var header = Data()
        func text(_ value: String) { header.append(contentsOf: Array(value.utf8)) }
        func u32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) } }
        func u16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) } }
        text("RIFF"); u32(UInt32(36 + pcmBytes)); text("WAVE")
        text("fmt "); u32(16); u16(1); u16(1); u32(16_000); u32(32_000); u16(2); u16(16)
        text("data"); u32(UInt32(pcmBytes))
        return header
    }

    /// Frames of the video, upright, no longer than `edge`.
    public static func frames(of video: URL, edge: CGFloat) -> AVAssetImageGenerator {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: video))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: edge, height: edge)
        let near = CMTime(seconds: 0.2, preferredTimescale: 600)
        generator.requestedTimeToleranceBefore = near
        generator.requestedTimeToleranceAfter = near
        return generator
    }

    /// The contact sheet (`contactSheet`) of a video's first `length` seconds, as a JPEG, and the moments on it: the
    /// Show's own choice of moments from what he said (`moments`), near-duplicates dropped by the same thumbprints
    /// (`CanvasStoryboard.keep`). Nil when a frame can't be pulled.
    public static func sheet(of video: URL, said: [CanvasStoryboard.Said], length: Double) async -> (frames: [CanvasStoryboard.Moment], jpeg: Data)? {
        func at(_ seconds: Double) -> CMTime { CMTime(seconds: seconds, preferredTimescale: 600) }
        let looks = moments(said: said, length: length)
        let small = frames(of: video, edge: 160)
        var prints: [[UInt8]] = []
        for moment in looks {
            guard let image = try? await small.image(at: at(moment.at)).image else { return nil }
            prints.append(CanvasStoryboard.thumbprint(image))
        }
        let kept = CanvasStoryboard.keep(looks, prints: prints)
        let full = frames(of: video, edge: cellEdge)
        var pulled: [(at: Double, image: CGImage)] = []
        for moment in kept {
            guard let image = try? await full.image(at: at(moment.at)).image else { return nil }
            pulled.append((moment.at, image))
        }
        guard let sheet = contactSheet(pulled), let jpeg = jpeg(sheet) else { return nil }
        return (kept, jpeg)
    }

    static func jpeg(_ image: CGImage) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? output as Data : nil
    }
}
