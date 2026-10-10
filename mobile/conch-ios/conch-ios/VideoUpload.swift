import AVFoundation
import ConchDesign
import CoreTransferable
import UIKit
import UniformTypeIdentifiers

// A video from the phone, to the session: Tyler (09-25): "vise versa if possible", the phone's own recordings, to the
// Mac. The model can't watch video, so the video goes for people and, beside it, what the model can read: a contact
// sheet of its frames and its words, timed, as a Show's storyboard does (`VideoStoryboard`, in the shared package).
//
// The phone does the AVFoundation work, since it has the video open anyway: it transcodes, writes the sound as whisper
// takes it, and pulls the frames, the last two by `VideoFrames.swift` in the shared package, which the Mac's composer
// runs on a video dropped there too. The Mac transcribes (`/transcript`), because whisper is there. The words come back
// before the frames are chosen, since where he finished saying something is where a frame is worth taking.

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

/// A video made ready to send, and the ids its video and its sound upload under: kept across a Retry, so the Mac is
/// asked only for what it hasn't got (`BridgeClient.upload`). Not its contact sheet's, which is drawn again each time
/// (`VideoMessage.send`).
struct PreparedVideo {
    let video: URL
    /// Its sound as whisper takes it; nil for a video with none.
    let recording: URL?
    /// Seconds.
    let length: Double
    let poster: UIImage?
    let videoId = ImageUpload.newUploadID()
    let recordingId = ImageUpload.newUploadID()

    /// Its files, gone: the transcode (up to 46 MB) and its sound, in the phone's temp folder, once it leaves the
    /// composer. Nothing else deletes them.
    func discard() {
        for file in [video, recording].compactMap({ $0 }) { try? FileManager.default.removeItem(at: file) }
    }
}

enum VideoPrepError: LocalizedError {
    case noVideo
    case unreadable
    case tooLarge

    var errorDescription: String? {
        switch self {
        case .noVideo: "That file has no video in it."
        case .unreadable: "iPhone couldn't read that video."
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
        let recording = try? await recording(of: source)
        let poster = try? await VideoStoryboard.frames(of: video, edge: 192).image(at: .zero).image
        return PreparedVideo(video: video, recording: recording, length: length, poster: poster.map(UIImage.init(cgImage:)))
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

    /// Its sound as whisper takes it, in a WAV in the phone's temp folder (`VideoStoryboard.speech`, the Mac's code too).
    /// Nil with no sound.
    static func recording(of source: URL) async throws -> URL? {
        guard let wav = try await VideoStoryboard.speech(of: source) else { return nil }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("wav")
        try wav.write(to: out)
        return out
    }
}

enum VideoMessage {
    /// Everything a video sends, in order: its sound (its words choose the frames), then the contact sheet, then the
    /// video; and the message they make (`VideoStoryboard.prompt`). Nil when the sheet or the video doesn't go: half a
    /// video is worse than none, and the attachment stays for the Retry. The words are the one piece it goes without:
    /// with none, the frames are taken every three seconds.
    @MainActor
    static func send(_ video: PreparedVideo, bridge: BridgeClient) async -> String? {
        var said: [CanvasStoryboard.Said] = []
        if let recording = video.recording, let data = try? Data(contentsOf: recording),
           let path = await bridge.upload(data: data, ext: "wav", id: video.recordingId) {
            said = await bridge.transcript(of: path) ?? []
        }
        guard let sheet = await VideoStoryboard.sheet(of: video.video, said: said, length: video.length),
              // A new id each time: the sheet is drawn again from the words this attempt has, which a Retry can have
              // when the last one didn't. Under the last one's id the Mac joined the two, or handed back the old sheet.
              let sheetPath = await bridge.upload(data: sheet.jpeg, ext: "jpg", id: ImageUpload.newUploadID()),
              let data = try? Data(contentsOf: video.video, options: .mappedIfSafe),
              let videoPath = await bridge.upload(data: data, ext: "mp4", id: video.videoId)
        else { return nil }
        return VideoStoryboard.prompt(sheet.frames, said: said, length: video.length, sheet: sheetPath, video: videoPath)
    }
}
