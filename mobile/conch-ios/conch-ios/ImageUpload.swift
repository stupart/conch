import UIKit
import UniformTypeIdentifiers

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
    /// Base64 inflates by a third, and a relay frame caps at 192 KiB.
    static let chunkBytes = 120 * 1024

    struct Prepared {
        let data: Data
        /// One of jpg/png/gif/webp — the four formats Claude reads.
        let ext: String
        let pixels: CGSize
        /// True when the original was already within the model's ceiling.
        let untouched: Bool
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
    static func prepare(data: Data, type: UTType?, backend: String?) -> Prepared? {
        let maxEdge = maxEdge(for: backend)
        let isPNG = type?.conforms(to: .png) ?? false
        if let type, type.conforms(to: .gif) || type.identifier == "org.webmproject.webp" {
            let ext = type.conforms(to: .gif) ? "gif" : "webp"
            return data.count <= maxBytes
                ? Prepared(data: data, ext: ext, pixels: .zero, untouched: true)
                : nil
        }

        guard let image = UIImage(data: data) else { return nil }
        let size = image.size
        let longEdge = max(size.width, size.height)

        // Already within what the model uses: send the original bytes rather
        // than re-encoding, which could only lose quality.
        if longEdge <= maxEdge, data.count <= maxBytes,
           isPNG || (type?.conforms(to: .jpeg) ?? false) {
            return Prepared(
                data: data,
                ext: isPNG ? "png" : "jpg",
                pixels: size,
                untouched: true
            )
        }

        let scale = min(1, maxEdge / longEdge)
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        // 1, not the screen scale: `target` is already in the pixels we want, and
        // a 3x renderer would silently produce a 4704px image.
        format.scale = 1
        format.opaque = !isPNG
        let rendered = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }

        if isPNG, let png = rendered.pngData(), png.count <= maxBytes {
            return Prepared(data: png, ext: "png", pixels: target, untouched: false)
        }
        // 0.92: visually indistinguishable at this size, and well clear of the
        // 5 MB ceiling. Stepping down only if a photograph is unusually dense.
        for quality in [0.92, 0.8, 0.65] as [CGFloat] {
            if let jpeg = rendered.jpegData(compressionQuality: quality), jpeg.count <= maxBytes {
                return Prepared(data: jpeg, ext: "jpg", pixels: target, untouched: false)
            }
        }
        return nil
    }

    /// Split for the wire. Chunked because a relay frame caps at 192 KiB and
    /// base64 adds a third on top.
    static func chunks(_ data: Data) -> [String] {
        stride(from: 0, to: data.count, by: chunkBytes).map { start in
            data[start..<min(start + chunkBytes, data.count)].base64EncodedString()
        }
    }

    static func newUploadID() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(24).lowercased()
    }
}
