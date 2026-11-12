import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// What a video is made into for an agent, pulled off the video itself: its contact sheet (`VideoStoryboard`). One way
// for both apps: the phone runs it on the video it picked and transcoded (`VideoUpload.swift` there), the Mac on the file
// dropped or picked on its composer (`ComposerVideo.swift` there).
//
// Its sound is never read. Until 2026-11-12 it was pulled off as 16 kHz WAV for the daemon's whisper, and the words chose
// where the frames were taken; testing that round trip went through macOS's audio stack, which ran a microphone check
// for the test process, and Tyler heard a beep on every gate run. Tyler: "maybe we remove that functionality? its not v
// useful and it feels concerning". So the frames are chosen without words (`VideoStoryboard.moments`).

extension VideoStoryboard {
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
    /// Show's own choice of moments with no words to go by (`moments`), near-duplicates dropped by the same thumbprints
    /// (`CanvasStoryboard.keep`). Nil when a frame can't be pulled.
    public static func sheet(of video: URL, length: Double) async -> (frames: [CanvasStoryboard.Moment], jpeg: Data)? {
        func at(_ seconds: Double) -> CMTime { CMTime(seconds: seconds, preferredTimescale: 600) }
        let looks = moments(length: length)
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
