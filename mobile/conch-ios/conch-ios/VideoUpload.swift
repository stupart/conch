import AVFoundation
import ConchDesign
import CoreTransferable
import UIKit
import UniformTypeIdentifiers

// A video from the phone, to the session: Tyler (09-25): "vise versa if possible", the phone's own recordings, to the
// Mac. The model can't watch video, so the video goes for people and, beside it, what the model can read: a contact
// sheet of its frames, as a Show's storyboard does (`VideoStoryboard`, in the shared package).
//
// The phone does the AVFoundation work, since it has the video open anyway: it transcodes, and pulls the frames with
// `VideoFrames.swift` in the shared package, which the Mac's composer runs on a video dropped there too.
//
// Not its words. Its sound was written out for the Mac's whisper (`/transcript`), and the words chose the frames, until
// Tyler, 2026-11-12, after the Mac's test suite beeped at him: "maybe we remove that functionality? its not v useful and
// it feels concerning". With nothing to wait for from the Mac, the sheet is drawn as the video is attached.

/// A video picked in Photos, copied to a file the app owns: Photos' own file is gone once the import returns.
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}

/// A video made ready to send, its contact sheet, and the ids the two upload under: kept across a Retry, so the Mac is
/// asked only for what it hasn't got (`BridgeClient.upload`).
struct PreparedVideo {
    let video: URL
    /// Seconds.
    let length: Double
    let poster: UIImage?
    /// The frames on the sheet, and the sheet as a JPEG (`VideoStoryboard.sheet`).
    let frames: [CanvasStoryboard.Moment]
    let sheet: Data
    let videoId = ImageUpload.newUploadID()
    let sheetId = ImageUpload.newUploadID()

    /// Its file, gone: the transcode (up to 46 MB), in the phone's temp folder, once it leaves the composer. Nothing
    /// else deletes it.
    func discard() {
        try? FileManager.default.removeItem(at: video)
    }
}

enum VideoPrepError: LocalizedError {
    case noVideo
    case unreadable
    case noFrames
    case tooLarge

    var errorDescription: String? {
        switch self {
        case .noVideo: "That file has no video in it."
        case .unreadable: "iPhone couldn't read that video."
        case .noFrames: "iPhone couldn't take frames from that video."
        case .tooLarge: "That video is too large to send, even made smaller."
        }
    }
}

enum VideoPrep {
    /// The short edge a video is sent at: 720p, which keeps a screen recording's text readable. AVFoundation's 1280x720
    /// preset fits the frame inside a landscape box instead, and a portrait recording came out 330 wide.
    static let shortEdge: CGFloat = 720
    /// 2.5 Mbit/s: two minutes at 720p is under 40 MB, inside the Mac's 48 MB (`VIDEO_MAX_BYTES`).
    static let bitRate = 2_500_000
    static let maxBytes = 46 * 1024 * 1024

    static func prepare(_ source: URL) async throws -> PreparedVideo {
        let video = try await transcode(source)
        let length = try await AVURLAsset(url: video).load(.duration).seconds
        guard let sheet = await VideoStoryboard.sheet(of: video, length: length) else {
            try? FileManager.default.removeItem(at: video)
            throw VideoPrepError.noFrames
        }
        let poster = try? await VideoStoryboard.frames(of: video, edge: 192).image(at: .zero).image
        return PreparedVideo(video: video, length: length, poster: poster.map(UIImage.init(cgImage:)), frames: sheet.frames, sheet: sheet.jpeg)
    }

    /// H.264 in an MP4, the short edge at most 720, the first two minutes at most (a Show's longest), its sound AAC mono.
    static func transcode(_ source: URL) async throws -> URL {
        let asset = AVURLAsset(url: source)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw VideoPrepError.noVideo }
        let (natural, transform) = try await track.load(.naturalSize, .preferredTransform)
        let upright = natural.applying(transform)
        let scale = min(1, shortEdge / max(1, min(abs(upright.width), abs(upright.height))))
        // Before the rotation, which the file keeps as its own and a player applies; even, as H.264 wants.
        let width = Int((natural.width * scale / 2).rounded()) * 2
        let height = Int((natural.height * scale / 2).rounded()) * 2
        let duration = try await asset.load(.duration)
        let range = CMTimeRange(start: .zero, duration: CMTimeMinimum(duration, CMTime(seconds: VideoStoryboard.longest, preferredTimescale: 600)))

        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = range
        let frames = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ])
        frames.alwaysCopiesSampleData = false
        reader.add(frames)
        let out = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("mp4")
        let writer = try AVAssetWriter(outputURL: out, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        let picture = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoScalingModeKey: AVVideoScalingModeResizeAspect,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitRate,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ])
        picture.transform = transform
        picture.expectsMediaDataInRealTime = false
        writer.add(picture)
        var sound: (from: AVAssetReaderTrackOutput, to: AVAssetWriterInput)?
        if let audio = try await asset.loadTracks(withMediaType: .audio).first {
            let pcm = AVAssetReaderTrackOutput(track: audio, outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ])
            reader.add(pcm)
            let aac = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64_000,
            ])
            aac.expectsMediaDataInRealTime = false
            writer.add(aac)
            sound = (pcm, aac)
        }
        guard writer.startWriting(), reader.startReading() else { throw writer.error ?? reader.error ?? VideoPrepError.unreadable }
        writer.startSession(atSourceTime: range.start)
        // Each track on its own queue: a reader hands both out together, and one input waiting must not stop the other.
        async let pictures: Void = pump(frames, into: picture, on: DispatchQueue(label: "conch.video.picture"))
        if let sound { await pump(sound.from, into: sound.to, on: DispatchQueue(label: "conch.video.sound")) }
        await pictures
        guard reader.status == .completed else {
            writer.cancelWriting()
            throw reader.error ?? VideoPrepError.unreadable
        }
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? VideoPrepError.unreadable }
        let bytes = (try? out.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? .max
        guard bytes <= maxBytes else {
            try? FileManager.default.removeItem(at: out)
            throw VideoPrepError.tooLarge
        }
        return out
    }

    /// One track's reader output and writer input: touched only on the queue that pumps them.
    private final class Track: @unchecked Sendable {
        let output: AVAssetReaderOutput
        let input: AVAssetWriterInput

        init(_ output: AVAssetReaderOutput, _ input: AVAssetWriterInput) {
            self.output = output
            self.input = input
        }
    }

    /// One track's samples, from the reader into the writer, as fast as the writer takes them.
    private static func pump(_ output: AVAssetReaderOutput, into input: AVAssetWriterInput, on queue: DispatchQueue) async {
        let track = Track(output, input)
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            track.input.requestMediaDataWhenReady(on: queue) {
                while track.input.isReadyForMoreMediaData {
                    guard let sample = track.output.copyNextSampleBuffer(), track.input.append(sample) else {
                        // Finished, it is never asked for more: this runs once.
                        track.input.markAsFinished()
                        done.resume()
                        return
                    }
                }
            }
        }
    }
}

enum VideoMessage {
    /// Everything a video sends, in order: the contact sheet, then the video; and the message they make
    /// (`VideoStoryboard.prompt`). Nil when either doesn't go: half a video is worse than none, and the attachment stays
    /// for the Retry, which sends the same sheet and video under the same ids.
    @MainActor
    static func send(_ video: PreparedVideo, bridge: BridgeClient) async -> String? {
        guard let sheetPath = await bridge.upload(data: video.sheet, ext: "jpg", id: video.sheetId),
              let data = try? Data(contentsOf: video.video, options: .mappedIfSafe),
              let videoPath = await bridge.upload(data: data, ext: "mp4", id: video.videoId)
        else { return nil }
        return VideoStoryboard.prompt(video.frames, length: video.length, sheet: sheetPath, video: videoPath)
    }
}
