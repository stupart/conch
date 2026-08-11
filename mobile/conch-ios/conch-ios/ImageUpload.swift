import ImageIO
import UIKit
import UniformTypeIdentifiers

/// ImageIO's thumbnail path is the important primitive here: it asks the image
/// decoder for a bounded bitmap instead of creating the source-sized bitmap and
/// drawing that down afterwards. A 48 MP source can otherwise exist as roughly
/// 192 MB of pixels before the smaller image even begins to render.
enum ImageDownsampler {
    enum FilePreview: @unchecked Sendable {
        case image(CGImage)
        case tooLarge
        case unreadable
    }

    static func source(data: Data) -> CGImageSource? {
        CGImageSourceCreateWithData(data as CFData, [
            kCGImageSourceShouldCache: false,
        ] as CFDictionary)
    }

    static func thumbnail(source: CGImageSource, maxPixelSize: Int) -> CGImage? {
        CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            // Decode now, on the worker running this function. Leaving the
            // thumbnail lazy merely moves its bounded decode back to SwiftUI.
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary)
    }

    static func pixelSize(source: CGImageSource) -> CGSize? {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber
        else { return nil }
        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        // UIImage.size reflected EXIF rotation. Keep that behaviour without
        // constructing UIImage's source-sized backing image just to learn it.
        if (5...8).contains(orientation) {
            return CGSize(width: height.doubleValue, height: width.doubleValue)
        }
        return CGSize(width: width.doubleValue, height: height.doubleValue)
    }

    /// Decode a disk-backed deliverable away from SwiftUI and within fixed
    /// compressed and decoded bounds. Opening the URL directly also avoids an
    /// otherwise redundant full-file Data allocation.
    static func filePreview(
        at url: URL,
        maxBytes: Int,
        maxPixelSize: Int
    ) async -> FilePreview {
        let worker = Task.detached(priority: .userInitiated) { () -> FilePreview in
            autoreleasepool {
                guard !Task.isCancelled else { return .unreadable }
                guard let bytes = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize
                else { return .unreadable }
                guard bytes <= maxBytes else { return .tooLarge }
                guard let source = CGImageSourceCreateWithURL(url as CFURL, [
                    kCGImageSourceShouldCache: false,
                ] as CFDictionary), !Task.isCancelled,
                      let image = thumbnail(source: source, maxPixelSize: maxPixelSize)
                else { return .unreadable }
                return .image(image)
            }
        }
        // SwiftUI cancels the view task when the sheet closes. Propagating that
        // cancellation prevents queued work from opening a file the sheet has
        // already removed; an ImageIO decode already in flight remains bounded.
        return await withTaskCancellationHandler {
            await worker.value
        } onCancel: {
            worker.cancel()
        }
    }
}

/// Getting a picture from your phone to an agent on your Mac, at the best
/// quality that actually survives the trip.
///
/// Tyler's concern was that resizing defeats the point: "the point of sending
/// the images is that they're nice high resolution images". He then landed on
/// the right rule himself — "scaling down to whatever the maximum that the AI
/// accepts... obviously wouldn't make sense to transfer more bytes than the AI
/// would accept".
///
/// Anthropic's docs make that exact number available, so this is not a bandwidth
/// compromise: an image whose long edge exceeds 1568px "will first be scaled
/// down, preserving aspect ratio", and sending a larger one "will increase
/// latency of time-to-first-token, without giving you any additional model
/// performance". Downscaling to 1568 therefore loses nothing the model would
/// have seen, and arrives sooner. Anything already smaller is sent untouched.
enum ImageUpload {
    /// The long edge each agent actually uses.
    ///
    /// They are NOT the same, which Tyler thought to ask about before this
    /// shipped one number for both. Anthropic scales anything past 1568px on
    /// the long edge; OpenAI's tile models fit within 2048x2048 and then take
    /// the shortest side to 768 for high detail. Sizing everything to 1568
    /// would quietly throw away detail a Codex session would have used, and
    /// sizing everything to 2048 would send Claude a third more pixels than it
    /// keeps.
    static func maxEdge(for backend: String?) -> CGFloat {
        backend == "codex" ? 2048 : 1568
    }
    /// Per-image API limit; a 1568px image lands well under it.
    static let maxBytes = 5 * 1024 * 1024
    /// Raw bytes per chunk, sized against the PLAINTEXT limit after base64.
    ///
    /// The relay allows 128 KiB of plaintext body (192 KiB is the *encrypted*
    /// frame, which is not the constraint). Base64 inflates by 4/3 and the JSON
    /// envelope adds a little, so 120 KiB raw became ~160 KB and every frame was
    /// rejected as too large — the upload failed, and the disrupted session then
    /// failed the NEXT send too, which is why a text message that arrived fine
    /// still reported "couldn't reach the Mac".
    ///
    /// 64 KiB raw is ~87 KB encoded: comfortably inside the limit with room for
    /// the envelope, at the cost of a few more round trips.
    static let chunkBytes = 64 * 1024
    /// 64 pt at a 3x phone scale. The composer never draws more detail than
    /// this, so retaining a model-sized image for its thumbnail only wastes RAM.
    private static let previewPixels = 192

    struct Prepared: Sendable {
        let data: Data
        /// One of jpg/png/gif/webp — the four formats Claude reads.
        let ext: String
        let pixels: CGSize
        /// True when the original was already within the model's ceiling.
        let untouched: Bool
        /// A separately downsampled first frame for the 64 pt composer tile.
        let previewData: Data?
    }

    private enum SourceFormat: Sendable {
        case png
        case jpeg
        case gif
        case webp
        case other

        init(_ type: UTType?) {
            if type?.conforms(to: .png) == true { self = .png }
            else if type?.conforms(to: .jpeg) == true { self = .jpeg }
            else if type?.conforms(to: .gif) == true { self = .gif }
            else if type?.identifier == "org.webmproject.webp" { self = .webp }
            else { self = .other }
        }
    }

    /// Convert and size a picked image for an agent to read.
    ///
    /// Format choice matters as much as size:
    ///  - HEIC, which is what an iPhone shoots by DEFAULT, is not a format
    ///    Claude accepts at all. It must become JPEG or the agent sees nothing.
    ///  - PNG stays PNG. Screenshots and UI are where phone-to-agent images are
    ///    most useful, and JPEG artefacts land hardest on text and flat colour.
    ///  - GIF and WebP pass through untouched; re-encoding a GIF would drop its
    ///    animation, which is the only reason to send one.
    static func prepare(data: Data, type: UTType?, backend: String?) async -> Prepared? {
        let format = SourceFormat(type)
        let maxPixelSize = Int(maxEdge(for: backend))
        // PhotosPicker resumes its caller on MainActor. The entire ImageIO and
        // encoding path therefore has to cross an explicit executor boundary;
        // making this function async alone would still freeze the composer.
        return await Task.detached(priority: .userInitiated) {
            autoreleasepool {
                prepare(data: data, format: format, maxPixelSize: maxPixelSize)
            }
        }.value
    }

    private static func prepare(
        data: Data,
        format: SourceFormat,
        maxPixelSize: Int
    ) -> Prepared? {
        let passthroughExtension: String?
        switch format {
        case .gif: passthroughExtension = "gif"
        case .webp: passthroughExtension = "webp"
        default: passthroughExtension = nil
        }
        if let ext = passthroughExtension {
            guard data.count <= maxBytes else { return nil }
            let preview = ImageDownsampler.source(data: data).flatMap {
                previewData(source: $0, preserveAlpha: true)
            }
            return Prepared(
                data: data,
                ext: ext,
                pixels: .zero,
                untouched: true,
                previewData: preview
            )
        }

        guard let source = ImageDownsampler.source(data: data),
              let size = ImageDownsampler.pixelSize(source: source)
        else { return nil }
        let longEdge = max(size.width, size.height)

        // Already within what the model uses: send the original bytes rather
        // than re-encoding, which could only lose quality.
        if longEdge <= CGFloat(maxPixelSize), data.count <= maxBytes,
           format == .png || format == .jpeg {
            return Prepared(
                data: data,
                ext: format == .png ? "png" : "jpg",
                pixels: size,
                untouched: true,
                previewData: previewData(source: source, preserveAlpha: format == .png)
            )
        }

        guard let image = ImageDownsampler.thumbnail(
            source: source,
            maxPixelSize: maxPixelSize
        ) else { return nil }
        let pixels = CGSize(width: image.width, height: image.height)

        if format == .png {
            guard let png = encode(image, type: UTType.png.identifier as CFString),
                  png.count <= maxBytes else { return nil }
            return Prepared(
                data: png,
                ext: "png",
                pixels: pixels,
                untouched: false,
                previewData: previewData(source: source, preserveAlpha: true)
            )
        }

        // 0.92: visually indistinguishable at this size, and well clear of the
        // 5 MB ceiling. Stepping down only if a photograph is unusually dense.
        for quality in [0.92, 0.8, 0.65] as [CGFloat] {
            if let jpeg = encode(
                image,
                type: UTType.jpeg.identifier as CFString,
                quality: quality
            ), jpeg.count <= maxBytes {
                return Prepared(
                    data: jpeg,
                    ext: "jpg",
                    pixels: pixels,
                    untouched: false,
                    previewData: previewData(source: source, preserveAlpha: false)
                )
            }
        }
        return nil
    }

    private static func previewData(source: CGImageSource, preserveAlpha: Bool) -> Data? {
        guard let image = ImageDownsampler.thumbnail(
            source: source,
            maxPixelSize: previewPixels
        ) else { return nil }
        return encode(
            image,
            type: (preserveAlpha ? UTType.png.identifier : UTType.jpeg.identifier) as CFString,
            quality: preserveAlpha ? nil : 0.75
        )
    }

    private static func encode(
        _ image: CGImage,
        type: CFString,
        quality: CGFloat? = nil
    ) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, type, 1, nil)
        else { return nil }
        let properties: [CFString: Any] = quality.map {
            [kCGImageDestinationLossyCompressionQuality: $0]
        } ?? [:]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }

    /// Split for the wire without retaining the base64 form of every piece.
    /// The iterator owns the original Data by copy-on-write reference and
    /// materialises only the string the current request is about to send.
    struct Chunks: Sequence {
        let data: Data

        var count: Int {
            guard !data.isEmpty else { return 0 }
            return (data.count + chunkBytes - 1) / chunkBytes
        }

        struct Iterator: IteratorProtocol {
            let data: Data
            var offset = 0

            mutating func next() -> String? {
                guard offset < data.count else { return nil }
                let end = Swift.min(offset + chunkBytes, data.count)
                defer { offset = end }
                return data[offset..<end].base64EncodedString()
            }
        }

        func makeIterator() -> Iterator {
            Iterator(data: data)
        }
    }

    static func chunks(_ data: Data) -> Chunks {
        Chunks(data: data)
    }

    static func newUploadID() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(24).lowercased()
    }
}
