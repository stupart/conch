import CoreGraphics
import Foundation

// Show: the canvas recorded instead of stilled. Tyler: "or we could also have like a 'show' and that's recording it via
// video instead of only an image." Agents can't watch a video, so what one is sent is its storyboard: frames pulled just
// after each thing Tyler marked, where he finished saying something or paused, and wherever the screen changed,
// near-duplicates dropped, a dozen at most, each with its time and what happened there. The research is §3 and §4 of
// ~/Projects/conch-design/canvas-research-2026-09-25.md.
//
// The Show went with the overlays (2026-11-11), and its pill, narration and message with it. What stays is the part a
// video sent from the phone or the Mac still uses (`VideoStoryboard`): which moments, which frames, their times and what
// happened at each.

public enum CanvasStoryboard {
    /// How long a Show could run: two minutes. A video's frames stop there too (`VideoStoryboard.longest`).
    public static let longest: TimeInterval = 120
    /// At most this many frames: enough to follow what happened, few enough for an agent to look at every one.
    public static let most = 12
    /// A frame's long edge, the still's and the phone uploads' rule.
    public static let longEdge: CGFloat = 1568

    /// A moment in the recording worth a frame.
    public struct Moment: Equatable, Sendable {
        public enum Kind: Equatable, Sendable {
            /// Just after Tyler finished marking: these marks, a burst of them together.
            case marks([CanvasMark])
            /// A regular look, kept only if the screen changed since the last frame kept.
            case look
            /// Where Tyler finished saying something, or paused: kept, as a look is, only if the screen changed.
            case said
            /// The last frame.
            case end
        }

        /// Seconds into the recording.
        public let at: Double
        public let kind: Kind

        public init(at: Double, kind: Kind) {
            self.at = at
            self.kind = kind
        }
    }

    /// A mark's frame is taken this long after it was finished, so its ink is in the picture.
    static let settle = 0.3
    /// Marks finished within this of the one before are one burst, and one frame: after the last of them.
    static let burst = 1.0
    /// A regular look, this often.
    static let every = 3.0

    /// Where a recording `length` seconds long is looked at: just after each burst of Tyler's marks (`ends`, each mark and
    /// when it was finished, in seconds into the recording); where he finished saying something or paused (`said`, the
    /// moments he finished saying something or paused), where no burst is near; every three seconds from the start, where neither is; and the last frame.
    /// Oldest first, the last frame last.
    public static func moments(ends: [(at: Double, mark: CanvasMark)], said: [Double] = [], length: Double) -> [Moment] {
        let last = max(0, length - 0.05)
        var bursts: [(finished: Double, marks: [CanvasMark])] = []
        for end in ends.sorted(by: { $0.at < $1.at }) {
            if let previous = bursts.last, end.at - previous.finished < Self.burst {
                bursts[bursts.count - 1] = (end.at, previous.marks + [end.mark])
            } else {
                bursts.append((end.at, [end.mark]))
            }
        }
        var moments = bursts.map { Moment(at: min($0.finished + settle, last), kind: .marks($0.marks)) }
        let marked = moments.map(\.at)
        for at in said where at > 0 && at < last && !marked.contains(where: { abs($0 - at) < Self.burst }) {
            moments.append(Moment(at: at, kind: .said))
        }
        let looked = moments.map(\.at)
        for at in stride(from: 0.1, to: last - Self.burst, by: every) where !looked.contains(where: { abs($0 - at) < Self.burst }) {
            moments.append(Moment(at: at, kind: .look))
        }
        return moments.sorted { $0.at < $1.at } + [Moment(at: last, kind: .end)]
    }

    // MARK: Near-duplicates

    /// A thumbprint's side, in cells.
    static let printSide = 64
    /// A cell has changed when its grey moves further than this, out of 255: more than a flicker.
    static let cellMoved = 12
    /// Less of the screen changed than this is the same picture: a pointer moving, a caret blinking.
    // ponytail: a fixed share of a 64-cell grid over the whole screen. A small change on a big screen (one line of text
    // typed) can fall under it; compare regions instead if frames that matter are dropped.
    public static let sameBelow = 0.002

    /// A frame, small and grey: what near-duplicates are told apart by.
    public static func thumbprint(_ image: CGImage) -> [UInt8] {
        var cells = [UInt8](repeating: 0, count: printSide * printSide)
        cells.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(data: buffer.baseAddress, width: printSide, height: printSide, bitsPerComponent: 8, bytesPerRow: printSide, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: printSide, height: printSide))
        }
        return cells
    }

    /// How much of the screen changed between two thumbprints, 0 to 1: the share of cells that moved.
    public static func change(_ a: [UInt8], _ b: [UInt8]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return 1 }
        return Double(zip(a, b).filter { abs(Int($0) - Int($1)) > cellMoved }.count) / Double(a.count)
    }

    /// The frames to send, from each moment's thumbprint (`prints`, one each): every burst of marks; a look, a pause or
    /// the end only if the screen changed since the last frame kept. Over `most`, the looks that changed least go first,
    /// then where he spoke, then the marks; the last frame kept always stays.
    public static func keep(_ moments: [Moment], prints: [[UInt8]]) -> [Moment] {
        var kept: [(moment: Moment, change: Double)] = []
        var previous: [UInt8]?
        for (moment, print) in zip(moments, prints) {
            let change = previous.map { self.change($0, print) } ?? 1
            if case .marks = moment.kind {} else if change < sameBelow { continue }
            kept.append((moment, change))
            previous = print
        }
        func rank(_ each: (moment: Moment, change: Double)) -> (Int, Double) {
            switch each.moment.kind {
            case .marks: return (2, each.change)
            case .said: return (1, each.change)
            case .look, .end: return (0, each.change)
            }
        }
        while kept.count > most, let drop = kept.indices.dropLast().min(by: { rank(kept[$0]) < rank(kept[$1]) }) {
            kept.remove(at: drop)
        }
        return kept.map(\.moment)
    }

    // MARK: The words

    /// A length, as a video's prompt and its row say it: 0:23, 1:05.
    public static func clock(_ seconds: Double) -> String {
        let whole = max(0, Int(seconds.rounded(.down)))
        return "\(whole / 60):" + String(format: "%02d", whole % 60)
    }

    /// A frame's time into the recording, as the storyboard writes it: [00:04].
    public static func stamp(_ seconds: Double) -> String {
        let whole = max(0, Int(seconds.rounded(.down)))
        return String(format: "[%02d:%02d]", whole / 60, whole % 60)
    }

    /// What happened at a frame: the marks finished there, each where it is and a note with its words; else the start, a
    /// change, or the end.
    static func caption(_ moment: Moment, first: Bool) -> String {
        switch moment.kind {
        case let .marks(marks):
            return marks.map { mark in
                let words = (mark.text ?? "").split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
                return words.isEmpty ? CanvasPrompt.place(mark) : "\(CanvasPrompt.place(mark)): \"\(words)\""
            }.joined(separator: ", ")
        case .look, .said:
            return first ? "the start" : "the screen changed"
        case .end:
            return first ? "the screen" : "the end"
        }
    }
}
