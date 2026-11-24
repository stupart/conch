import AVFoundation
import CoreGraphics
import Foundation
import SwiftUI

/// A video's poster: the frame a deliverable's card shows for it, the shape to reserve for it, and how long it runs.
///
/// Tyler, 2026-11-24: "the videos don't have thumbnails os i have to click on every one blind to see the content". A
/// picture a session filed was drawn on its card; a video was a 44 pt square with a play symbol, so a run of them had
/// to be opened one at a time to see which was which. Read off the video itself, with `VideoFrames.swift`'s generator,
/// so the phone can draw the same poster from the same code when it has the file.
public struct VideoPoster: Sendable {
    /// What names the file it was read from: its path, modification time and size (`ConchImage.key(forPath:)`). A video
    /// rewritten where it was is a new poster.
    public let key: String
    /// The frame, upright, its longest side at most the size it was read for.
    public let image: CGImage
    /// Width over height, upright: the video track's natural size through its preferred transform, so a phone's
    /// portrait recording, stored landscape and turned on playback, is tall here too.
    public let aspect: CGFloat
    /// How long it runs, in seconds.
    public let length: Double
    /// Where in it the frame was taken, in seconds (`moment`).
    public let at: Double

    /// How long it runs, as its mark says it: 0:42, to the nearest second, and never 0:00 for a clip under one.
    public var duration: String { CanvasStoryboard.clock(max(1, length.rounded())) }

    public init(key: String, image: CGImage, aspect: CGFloat, length: Double, at: Double) {
        self.key = key
        self.image = image
        self.aspect = aspect
        self.length = length
        self.at = at
    }

    /// The videos a poster is read from, by extension: the ones AVFoundation decodes. Not webm, which it can't; a webm
    /// keeps its symbol.
    public static let extensions: Set<String> = ["mp4", "mov", "m4v"]

    /// Where the poster is taken in a video `length` seconds long: a tenth of the way in, but no sooner than half a
    /// second and no later than three. Not the first frame, which is black, or a fade from it, often enough that a run
    /// of posters taken there would look alike again. A video shorter than half a second is taken at its middle, never
    /// at its very end, where there may be no frame to read. Nil when it has no length.
    public static func moment(length: Double) -> Double? {
        guard length.isFinite, length > 0 else { return nil }
        let wanted = min(max(length / 10, 0.5), 3)
        return wanted < length ? wanted : length / 2
    }

    /// The poster for the video at `path`, its frame no longer than `maxPixelSize`: read now, and remembered under the
    /// file's key, so the card that asks again, scrolled back or drawn anew, gets it without reading the video again.
    /// Nil, and remembered as nil, when there is none to read: not a video, no picture track, no length, or a frame
    /// that can't be decoded (a protected one). Tens of milliseconds for a large video: call it off the main thread.
    public static func poster(atPath path: String, maxPixelSize: Int) async -> VideoPoster? {
        guard let key = ConchImage.key(forPath: path) else { return nil }
        let name = name(key, maxPixelSize)
        if let known = cache.object(forKey: name) { return known.poster }
        let read = await read(URL(fileURLWithPath: path), key: key, maxPixelSize: maxPixelSize)
        cache.setObject(Known(read), forKey: name, cost: read.map { $0.image.bytesPerRow * $0.image.height } ?? 0)
        return read
    }

    /// Only a poster already read for the file at `path` as it is now: never a read. What a card's body asks, so a
    /// poster read once is drawn at its own shape in the first frame the card is drawn again, with nothing to wait for.
    public static func cached(atPath path: String, maxPixelSize: Int) -> VideoPoster? {
        guard let key = ConchImage.key(forPath: path) else { return nil }
        return cache.object(forKey: name(key, maxPixelSize))?.poster
    }

    /// The track's shape and the video's length first, then the frame, from one asset.
    static func read(_ video: URL, key: String, maxPixelSize: Int) async -> VideoPoster? {
        let asset = AVURLAsset(url: video)
        guard let track = try? await asset.loadTracks(withMediaType: .video).first,
              let (natural, transform) = try? await track.load(.naturalSize, .preferredTransform),
              let length = try? await asset.load(.duration).seconds,
              let at = moment(length: length)
        else { return nil }
        let upright = natural.applying(transform)
        let width = abs(upright.width), height = abs(upright.height)
        guard width > 0, height > 0 else { return nil }
        let frames = VideoStoryboard.frames(of: asset, edge: CGFloat(maxPixelSize))
        // Never a frame before the moment: the storyboard's leeway either side is for a contact sheet's speed, and a
        // poster taken half a second in to miss a fade-in shouldn't land 0.2 s back inside it.
        frames.requestedTimeToleranceBefore = .zero
        guard let image = try? await frames.image(at: CMTime(seconds: at, preferredTimescale: 600)).image else { return nil }
        return VideoPoster(key: key, image: image, aspect: width / height, length: length, at: at)
    }

    // MARK: Storage

    /// A read, remembered: a poster, or that there was none.
    private final class Known {
        let poster: VideoPoster?
        init(_ poster: VideoPoster?) { self.poster = poster }
    }

    private static func name(_ key: String, _ maxPixelSize: Int) -> NSString {
        "\(maxPixelSize)|\(key)" as NSString
    }

    /// Bounded by the frames' pixels, as `ConchImage`'s cache is, and let go under pressure.
    private static let cache: NSCache<NSString, Known> = {
        let cache = NSCache<NSString, Known>()
        cache.totalCostLimit = 64 * 1024 * 1024
        return cache
    }()
}

/// A video's poster where a picture would be: the frame at the video's own shape, and in its corner the mark the Mac
/// composer's video tile wears, a play glyph and how long it runs, on the dark glass the compare view's chips read over
/// any picture with (`VersionCompareViews.swift`). Small and quiet: it says this is a video, not a still, and the
/// picture does the rest.
///
/// Its size is the caller's: give it a width, or a box, and it fits the video's shape inside, the mark on the picture's
/// own corner. `cornerRadius` rounds the picture itself, not the box around it.
public struct VideoPosterView: View {
    let poster: VideoPoster
    let cornerRadius: CGFloat

    public init(poster: VideoPoster, cornerRadius: CGFloat = 8) {
        self.poster = poster
        self.cornerRadius = cornerRadius
    }

    public var body: some View {
        // The box is the track's shape; the frame fills it. They are the same shape but for rounding, and where they
        // aren't, a sliver is cropped rather than the picture stretched.
        Color.clear
            .aspectRatio(poster.aspect, contentMode: .fit)
            .overlay {
                Image(decorative: poster.image, scale: 1)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFill()
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(alignment: .bottomLeading) { mark.padding(ConchSpace.x2) }
    }

    private var mark: some View {
        HStack(spacing: 4) {
            Image(systemName: "play.fill")
                .font(.system(size: 8, weight: .bold))
            Text(poster.duration)
                .font(ConchType.meta)
                .monospacedDigit()
        }
        .foregroundStyle(Color.white)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Capsule().fill(Color.black.opacity(0.55)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Video, \(poster.duration)")
    }
}
