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
        if let hit = hit(key, maxPixelSize: maxPixelSize) { return hit }
        guard let image = decode() else { return nil }
        cache.setObject(Box(image), forKey: name(key, maxPixelSize), cost: image.bytesPerRow * image.height)
        return image
    }

    /// Only what is already decoded under `key`: never a decode.
    public static func hit(_ key: String, maxPixelSize: Int) -> CGImage? {
        cache.object(forKey: name(key, maxPixelSize))?.image
    }

    // MARK: A picture a row draws

    /// A picture as a row names it: what it is cached under, and the shape to reserve for it
    /// while it is decoded, both read without decoding it.
    ///
    /// A row asks for this in `body`, and decodes (`decode`) in a task off the main thread. It
    /// used to decode in `body`: tens of milliseconds for a screenshot, on the main thread, in
    /// the frame the row came into view — and cached under its path alone, so a picture
    /// rewritten where it was kept showing the old one.
    public struct Picture: Equatable, Sendable {
        /// Where it comes from, and the modification time and size a rewrite changes.
        public let key: String
        /// Width over height, upright.
        public let aspect: CGFloat
        let source: Source

        enum Source: Sendable {
            case path(String)
            case data(Data)
        }

        /// The same picture is the same key: comparing the bytes of an inline one would cost
        /// what the key exists to save.
        public static func == (a: Picture, b: Picture) -> Bool { a.key == b.key && a.aspect == b.aspect }
    }

    /// The picture at `path`, or nil when there is no readable picture there.
    public static func picture(atPath path: String) -> Picture? {
        guard let key = key(forPath: path),
              let aspect = aspect(key, {
                  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary)
                  else { return nil }
                  return pixelSize(source)
              })
        else { return nil }
        return Picture(key: key, aspect: aspect, source: .path(path))
    }

    /// A `data:` URL's picture, or nil when it is not one.
    public static func picture(dataURL: String) -> Picture? {
        guard let comma = dataURL.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...]))
        else { return nil }
        // The whole URL's hash: its bytes are the picture, so the same text is the same picture.
        let key = "data:\(dataURL.count):\(dataURL.hashValue)"
        guard let aspect = aspect(key, {
            guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
            else { return nil }
            return pixelSize(source)
        }) else { return nil }
        return Picture(key: key, aspect: aspect, source: .data(data))
    }

    /// Decoded for a row, and remembered under its key. A large picture takes tens of
    /// milliseconds: call it off the main thread.
    public static func decode(_ picture: Picture, maxPixelSize: Int) -> CGImage? {
        cached(picture.key, maxPixelSize: maxPixelSize) {
            switch picture.source {
            case let .path(path): thumbnail(atPath: path, maxPixelSize: maxPixelSize)
            case let .data(data): thumbnail(data: data, maxPixelSize: maxPixelSize)
            }
        }
    }

    /// Already decoded for a row: drawn in the same frame, with nothing to wait for.
    public static func decoded(_ picture: Picture, maxPixelSize: Int) -> CGImage? {
        hit(picture.key, maxPixelSize: maxPixelSize)
    }

    /// What names the file at `path` in the cache: its path, and the modification time and size
    /// that a rewrite changes. Nil when nothing is there. A `stat`, so it follows a symlink to
    /// the file it names.
    ///
    /// Not the path alone: a picture rewritten where it was — a canvas rendered again, a
    /// screenshot taken again under the same name — showed the old one for as long as it was cached.
    public static func key(forPath path: String) -> String? {
        var info = stat()
        guard stat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { return nil }
        let modified = info.st_mtimespec
        return "\(path)|\(modified.tv_sec).\(modified.tv_nsec)|\(info.st_size)"
    }

    // MARK: Storage

    private final class Box {
        let image: CGImage
        init(_ image: CGImage) { self.image = image }
    }

    private static func name(_ key: String, _ maxPixelSize: Int) -> NSString {
        "\(maxPixelSize)|\(key)" as NSString
    }

    private static let cache: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.totalCostLimit = 64 * 1024 * 1024
        return cache
    }()

    /// Each picture's shape, by key: a header read once, not every time a row's body runs.
    private static let aspects: NSCache<NSString, NSNumber> = {
        let cache = NSCache<NSString, NSNumber>()
        cache.countLimit = 512
        return cache
    }()

    private static func aspect(_ key: String, _ size: () -> CGSize?) -> CGFloat? {
        if let known = aspects.object(forKey: key as NSString) { return CGFloat(known.doubleValue) }
        guard let size = size(), size.width > 0, size.height > 0 else { return nil }
        let aspect = size.width / size.height
        aspects.setObject(NSNumber(value: Double(aspect)), forKey: key as NSString)
        return aspect
    }

    /// Its size in pixels, upright, from the header alone.
    private static func pixelSize(_ source: CGImageSource) -> CGSize? {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue
        else { return nil }
        // EXIF orientations 5–8 are a quarter turn: the thumbnail is drawn upright, so is its shape.
        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        return (5...8).contains(orientation) ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
    }

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
