import CoreGraphics
import CoreText
import Foundation

// A video Tyler sends from his phone, as an agent can read it: the model can't watch video, so, as for a Show
// (`CanvasStoryboard`), it gets frames with their times, what he said at each, and everything he said, timed. Tyler
// (09-25): "vise versa if possible": the phone's own recordings, to the Mac. The frames go as one contact sheet, a
// picture the model reads at once, rather than a dozen files to open. Pure: the phone pulls the frames and the Mac
// transcribes the sound.

public enum VideoStoryboard {
    /// The longest a video sent this way runs: Show's two minutes.
    public static let longest = CanvasStoryboard.longest
    /// A contact sheet's long edge: the frames' and the stills' rule.
    public static let longEdge = CanvasStoryboard.longEdge
    /// A frame's long edge when it is pulled for the sheet, before the sheet is fitted to `longEdge`.
    public static let cellEdge: CGFloat = 800

    /// Where the video is looked at: where he finished saying something or paused, every three seconds where he didn't,
    /// and the end. The Show's own rule (`CanvasStoryboard.moments`), with no ink to mark moments of its own.
    public static func moments(said: [CanvasStoryboard.Said], length: Double) -> [CanvasStoryboard.Moment] {
        CanvasStoryboard.moments(ends: [], said: CanvasStoryboard.moments(of: said), length: length)
    }

    /// Columns and rows for `count` frames: up to three across, as square as that allows.
    static func grid(_ count: Int) -> (columns: Int, rows: Int) {
        guard count > 0 else { return (0, 0) }
        let columns = min(3, count)
        return (columns, (count + columns - 1) / columns)
    }

    /// The contact sheet: the frames, left to right and down, each stamped with its time in its corner, the whole no
    /// longer than `longEdge`. Every cell the first frame's shape; a frame of another shape fits inside its cell.
    public static func contactSheet(_ frames: [(at: Double, image: CGImage)], longEdge: CGFloat = longEdge) -> CGImage? {
        guard let first = frames.first?.image, first.width > 0, first.height > 0 else { return nil }
        let (columns, rows) = grid(frames.count)
        let gap: CGFloat = 6
        let aspect = CGFloat(first.height) / CGFloat(first.width)
        let unscaledWidth = CGFloat(columns) * cellEdge + CGFloat(columns + 1) * gap
        let unscaledHeight = CGFloat(rows) * cellEdge * aspect + CGFloat(rows + 1) * gap
        let scale = min(1, longEdge / max(unscaledWidth, unscaledHeight))
        let cell = CGSize(width: cellEdge * scale, height: cellEdge * aspect * scale)
        let space = gap * scale
        let size = CGSize(width: (unscaledWidth * scale).rounded(), height: (unscaledHeight * scale).rounded())
        guard let context = CGContext(
            data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        context.setFillColor(CGColor(srgbRed: 0.08, green: 0.08, blue: 0.09, alpha: 1))
        context.fill(CGRect(origin: .zero, size: size))
        let stampPoints = max(11, 16 * scale)
        let font = CTFontCreateUIFontForLanguage(.system, stampPoints, nil) ?? CTFontCreateWithName("Helvetica" as CFString, stampPoints, nil)
        for (index, frame) in frames.enumerated() {
            let column = index % columns, row = index / columns
            // Core Graphics counts up from the bottom: the first row is the top one.
            let slot = CGRect(
                x: space + CGFloat(column) * (cell.width + space),
                y: size.height - space - CGFloat(row + 1) * cell.height - CGFloat(row) * space,
                width: cell.width, height: cell.height
            )
            let fit = min(slot.width / CGFloat(frame.image.width), slot.height / CGFloat(frame.image.height))
            let drawn = CGSize(width: CGFloat(frame.image.width) * fit, height: CGFloat(frame.image.height) * fit)
            context.draw(frame.image, in: CGRect(x: slot.midX - drawn.width / 2, y: slot.midY - drawn.height / 2, width: drawn.width, height: drawn.height))
            stamp(CanvasStoryboard.stamp(frame.at), at: CGPoint(x: slot.minX + 6 * scale, y: slot.minY + 6 * scale), font: font, in: context)
        }
        return context.makeImage()
    }

    /// A frame's time on a dark pill, white, in its bottom left corner.
    private static func stamp(_ text: String, at origin: CGPoint, font: CTFont, in context: CGContext) {
        let words = NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1),
        ])
        let line = CTLineCreateWithAttributedString(words)
        let bounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
        let pad = CTFontGetSize(font) * 0.35
        let pill = CGRect(x: origin.x, y: origin.y, width: bounds.width + 2 * pad, height: bounds.height + 2 * pad)
        context.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.72))
        context.addPath(CGPath(roundedRect: pill, cornerWidth: pad, cornerHeight: pad, transform: nil))
        context.fillPath()
        context.textPosition = CGPoint(x: pill.minX + pad - bounds.minX, y: pill.minY + pad - bounds.minY)
        CTLineDraw(line, context)
    }

    /// The one message a video sends, in the Show's voice: how long, the contact sheet and a line a frame (its time, its
    /// number, what he said there, what happened), then everything he said, timed, and the video itself, for people.
    public static func prompt(_ frames: [CanvasStoryboard.Moment], said: [CanvasStoryboard.Said], length: Double, sheet: String, video: String) -> String {
        var lines = [
            "[video] Tyler sent a video from his phone (\(CanvasStoryboard.clock(length))).",
            "Contact sheet: \(sheet) — \(frames.count) frame\(frames.count == 1 ? "" : "s"), left to right and down, each stamped with its time:",
        ]
        let words = CanvasStoryboard.words(said, at: frames.map(\.at))
        lines += frames.enumerated().map { index, frame in
            let heard = words[index].isEmpty ? "" : "\"\(words[index])\" · "
            return "\(CanvasStoryboard.stamp(frame.at)) frame \(String(format: "%02d", index + 1)) — \(heard)\(CanvasStoryboard.caption(frame, first: index == 0))"
        }
        let spoken = said.sorted { $0.start < $1.start }.map { "\(CanvasStoryboard.stamp($0.start)) \($0.text.split(whereSeparator: \.isNewline).joined(separator: " "))" }
        if !spoken.isEmpty { lines += ["What he said:"] + spoken }
        lines.append("The video itself, for people (agents can't watch video): \(video)")
        return lines.joined(separator: "\n")
    }
}
