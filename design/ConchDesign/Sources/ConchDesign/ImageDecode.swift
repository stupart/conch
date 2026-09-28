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
        /// Its size in pixels, upright.
        public let pixels: CGSize
        /// Its size in points, upright: pixels at the resolution it carries (72 dpi when it says none), as
        /// `NSImage.size` reads it — a Retina screenshot saved at 144 dpi is half its pixels.
        public let points: CGSize
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
              let shape = shape(key, {
                  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary)
                  else { return nil }
                  return Self.shape(of: source)
              })
        else { return nil }
        return Picture(key: key, aspect: shape.aspect, pixels: shape.pixels, points: shape.points, source: .path(path))
    }

    /// A `data:` URL's picture, or nil when it is not one.
    public static func picture(dataURL: String) -> Picture? {
        guard let comma = dataURL.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...]))
        else { return nil }
        // The whole URL's hash: its bytes are the picture, so the same text is the same picture.
        let key = "data:\(dataURL.count):\(dataURL.hashValue)"
        guard let shape = shape(key, {
            guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
            else { return nil }
            return Self.shape(of: source)
        }) else { return nil }
        return Picture(key: key, aspect: shape.aspect, pixels: shape.pixels, points: shape.points, source: .data(data))
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

    // MARK: A picture drawn at a width

    /// The most a picture decoded for the width it is drawn at may hold, in pixels: 192 MB of them. A page captured
    /// whole at 2x, 2,056 pixels wide for a 1,028-point pane, is still a pixel to a pixel 23,000 pixels down; one
    /// longer is decoded narrower, which is the only place anything is given up. (Decoded whole, as the viewer did, a
    /// 2880 x 30000 capture was 345 MB.)
    public static let drawnPixelBudget: CGFloat = 48_000_000

    /// How many pixels wide to decode a picture of `pixels` (upright) to draw it `width` device pixels wide: that
    /// width, the height following; never wider than the picture is; and never more than `budget` pixels in all.
    ///
    /// Not the long edge. Bounding the long edge is right for a thumbnail sized to a box, and wrong for a picture
    /// fitted to a width: a 1200 x 6000 capture bounded at 2048 comes out 410 pixels wide, and drawn across a
    /// 1,000-point pane on a 2x screen it is five times magnified — the blur this exists to end.
    public static func decodeWidth(forDrawnWidth width: CGFloat, of pixels: CGSize, budget: CGFloat = drawnPixelBudget) -> Int {
        guard pixels.width > 0, pixels.height > 0, width > 0 else { return 0 }
        let wanted = min(width.rounded(.up), pixels.width)
        let affordable = (budget * pixels.width / pixels.height).squareRoot().rounded(.down)
        return max(1, Int(min(wanted, affordable)))
    }

    /// The long edge to ask ImageIO for, which bounds the long edge, so that the picture comes out `width` pixels wide:
    /// for a tall picture that is its height at that width. At its own width or more, the whole picture.
    public static func longEdge(forWidth width: Int, of pixels: CGSize) -> Int {
        guard pixels.width > 0, pixels.height > 0, width > 0 else { return 0 }
        let whole = Int(max(pixels.width, pixels.height).rounded(.up))
        guard CGFloat(width) < pixels.width else { return whole }
        return min(whole, Int((CGFloat(width) * max(pixels.width, pixels.height) / pixels.width).rounded(.up)))
    }

    /// Decoded to be drawn `width` device pixels wide, the height following (`decodeWidth`): as sharp as the screen
    /// can show at that width, and no bigger. Not cached — the view drawing it holds it — and tens of milliseconds for
    /// a large one: call it off the main thread.
    public static func decode(_ picture: Picture, forWidth width: CGFloat, budget: CGFloat = drawnPixelBudget) -> CGImage? {
        let edge = longEdge(forWidth: decodeWidth(forDrawnWidth: width, of: picture.pixels, budget: budget), of: picture.pixels)
        guard edge > 0 else { return nil }
        switch picture.source {
        case let .path(path): return thumbnail(atPath: path, maxPixelSize: edge)
        case let .data(data): return thumbnail(data: data, maxPixelSize: edge)
        }
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

    /// A picture's size in pixels and in points, upright.
    final class Shape {
        let pixels: CGSize
        let points: CGSize
        var aspect: CGFloat { pixels.width / pixels.height }
        init(pixels: CGSize, points: CGSize) {
            self.pixels = pixels
            self.points = points
        }
    }

    /// Each picture's shape, by key: a header read once, not every time a row's body runs.
    private static let shapes: NSCache<NSString, Shape> = {
        let cache = NSCache<NSString, Shape>()
        cache.countLimit = 512
        return cache
    }()

    private static func shape(_ key: String, _ read: () -> Shape?) -> Shape? {
        if let known = shapes.object(forKey: key as NSString) { return known }
        guard let shape = read(), shape.pixels.width > 0, shape.pixels.height > 0 else { return nil }
        shapes.setObject(shape, forKey: key as NSString)
        return shape
    }

    /// Its size in pixels and points, upright, from the header alone.
    static func shape(of source: CGImageSource) -> Shape? {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
              width > 0, height > 0
        else { return nil }
        // No resolution, or a nonsense one, is 72 dpi: a pixel a point, as NSImage reads it.
        func dpi(_ key: CFString) -> Double {
            let value = (properties[key] as? NSNumber)?.doubleValue ?? 72
            return value > 1 ? value : 72
        }
        let points = CGSize(width: width * 72 / dpi(kCGImagePropertyDPIWidth), height: height * 72 / dpi(kCGImagePropertyDPIHeight))
        // EXIF orientations 5–8 are a quarter turn: the thumbnail is drawn upright, so is its shape.
        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        let turned = (5...8).contains(orientation)
        return Shape(
            pixels: turned ? CGSize(width: height, height: width) : CGSize(width: width, height: height),
            points: turned ? CGSize(width: points.height, height: points.width) : points
        )
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
