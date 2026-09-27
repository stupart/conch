import CoreGraphics
import Foundation
import ImageIO

/// A picture decoded at the size it is drawn at, never whole.
///
/// A 2880 × 1800 screenshot decoded whole is twenty megabytes of pixels to draw a 320-point
/// row; decoded for its row it is under two. `NSImage(contentsOfFile:)` and `UIImage(data:)`
/// both decode the whole thing, and hold it for as long as the view does.
public enum ConchImage {
    /// The picture at `path`, its longest side at most `maxPixelSize`, decoded now.
    public static func thumbnail(atPath path: String, maxPixelSize: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary)
        else { return nil }
        return thumbnail(source, maxPixelSize: maxPixelSize)
    }

    public static func thumbnail(data: Data, maxPixelSize: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
        else { return nil }
        return thumbnail(source, maxPixelSize: maxPixelSize)
    }

    /// The same, remembered: a row rebuilt — its revision moved, or it scrolled away and back —
    /// is not decoded again. `key` names the source; bounded by pixels, let go under pressure.
    public static func cached(_ key: String, maxPixelSize: Int, decode: () -> CGImage?) -> CGImage? {
        let name = "\(maxPixelSize)|\(key)" as NSString
        if let hit = cache.object(forKey: name) { return hit.image }
        guard let image = decode() else { return nil }
        cache.setObject(Box(image), forKey: name, cost: image.bytesPerRow * image.height)
        return image
    }

    private final class Box {
        let image: CGImage
        init(_ image: CGImage) { self.image = image }
    }

    private static let cache: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.totalCostLimit = 64 * 1024 * 1024
        return cache
    }()

    private static func thumbnail(_ source: CGImageSource, maxPixelSize: Int) -> CGImage? {
        CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            // Decoded here, off the main thread where the caller runs this, not lazily at first draw.
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary)
    }
}
