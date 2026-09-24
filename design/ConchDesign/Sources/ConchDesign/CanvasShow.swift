import CoreGraphics
import Foundation
import SwiftUI

// Show: the canvas recorded instead of stilled. Tyler: "or we could also have like a 'show' and that's recording it via
// video instead of only an image." Agents can't watch a video, so what one is sent is its storyboard: frames pulled just
// after each thing Tyler marked, where he finished saying something or paused, and wherever the screen changed,
// near-duplicates dropped, a dozen at most, each with its time, what was marked and what he said there. This is the pure
// part — which moments, which frames, the words — and the pill's record and mic buttons; the recording itself is the Mac
// app's (`CanvasShow.swift` there), and his voice the daemon's (`src/narration.ts`). The research is §3 and §4 of
// ~/Projects/conch-design/canvas-research-2026-09-25.md.

public enum CanvasStoryboard {
    /// How long a Show can run: two minutes, the last fifteen seconds counted down on the pill.
    public static let longest: TimeInterval = 120
    public static let warning: TimeInterval = 15
    /// At most this many frames: enough to follow what happened, few enough for an agent to look at every one.
    public static let most = 12
    /// A frame's long edge, the still's and the phone uploads' rule.
    public static let longEdge: CGFloat = 1568
    /// The recording red (panel-lab's `--rec`): the ring round the screen, the record button, the timer.
    public static let red = ConchRGBA(0xFF3B30)

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

    /// Something Tyler said over a Show, and when, in seconds into the recording: the daemon's transcript of his narration.
    public struct Said: Equatable, Sendable {
        public let start: Double
        public let end: Double
        public let text: String

        public init(start: Double, end: Double, text: String) {
            self.start = start
            self.end = end
            self.text = text
        }
    }

    /// A gap this long between two things said is a pause, and worth a look.
    static let pause = 0.7

    /// Where narration is looked at: the end of each thing said, and the middle of each pause.
    public static func moments(of said: [Said]) -> [Double] {
        let said = said.sorted { $0.start < $1.start }
        let pauses = zip(said, said.dropFirst()).filter { $1.start - $0.end >= pause }.map { ($0.end + $1.start) / 2 }
        return (said.map(\.end) + pauses).sorted()
    }

    /// Where a recording `length` seconds long is looked at: just after each burst of Tyler's marks (`ends`, each mark and
    /// when it was finished, in seconds into the recording); where he finished saying something or paused (`said`, from
    /// `moments(of:)`), where no burst is near; every three seconds from the start, where neither is; and the last frame.
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

    /// A length, as the prompt and the pill say it: 0:23, 1:05.
    public static func clock(_ seconds: Double) -> String {
        let whole = max(0, Int(seconds.rounded(.down)))
        return "\(whole / 60):" + String(format: "%02d", whole % 60)
    }

    /// A frame's time into the recording, as the storyboard writes it: [00:04].
    public static func stamp(_ seconds: Double) -> String {
        let whole = max(0, Int(seconds.rounded(.down)))
        return String(format: "[%02d:%02d]", whole / 60, whole % 60)
    }

    /// The pill's timer: how long Show has run; in its last fifteen seconds, how long is left.
    public static func timer(_ elapsed: TimeInterval) -> String {
        let left = longest - elapsed
        return left <= warning ? "\(clock(max(0, left).rounded(.up))) left" : clock(elapsed)
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

    /// What Tyler said at each frame of `frames` (their times): each thing said goes to the frame nearest where he finished
    /// saying it, so every word is on one line, with the picture of what he was looking at.
    static func words(_ said: [Said], at frames: [Double]) -> [String] {
        var words = [[String]](repeating: [], count: frames.count)
        for each in said.sorted(by: { $0.start < $1.start }) {
            guard let nearest = frames.indices.min(by: { abs(frames[$0] - each.end) < abs(frames[$1] - each.end) }) else { break }
            words[nearest].append(flat(each.text))
        }
        return words.map { $0.filter { !$0.isEmpty }.joined(separator: " ") }
    }

    private static func flat(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
    }

    /// A frame's line: what he said there, quoted, then what happened.
    private static func happened(_ moment: Moment, first: Bool, words: String) -> String {
        (words.isEmpty ? "" : "\"\(words)\" · ") + caption(moment, first: first)
    }

    /// `storyboard.md`, beside the frames: what the recording was, then a line a frame — its time, its number, what he said
    /// there, what happened, its file — and, when he narrated, everything he said, as he said it.
    public static func storyboard(_ frames: [(moment: Moment, file: String)], said: [Said] = [], about label: String, length: Double) -> String {
        var lines = [
            "# Tyler showed \(label) (\(clock(length)))",
            "",
            said.isEmpty
                ? "A recording of his screen with his ink over it (his is orange). Agents can't watch video, so these are its frames: one just after each thing he marked, and one wherever the screen changed."
                : "A recording of his screen with his ink over it (his is orange), and what he said over it. Agents can't watch video, so these are its frames: one just after each thing he marked, where he finished saying something or paused, and wherever the screen changed; each with the words he said there.",
            "",
        ]
        let words = words(said, at: frames.map(\.moment.at))
        lines += frames.enumerated().map { index, frame in
            "\(stamp(frame.moment.at)) frame \(String(format: "%02d", index + 1)) — \(happened(frame.moment, first: index == 0, words: words[index])) (\(frame.file))"
        }
        if !said.isEmpty {
            lines += ["", "## What he said", ""]
            lines += said.sorted { $0.start < $1.start }.map { "\(stamp($0.start)) \(flat($0.text))" }
        }
        lines += ["", "The recording itself, for people: show.mp4"]
        return lines.joined(separator: "\n") + "\n"
    }

    /// The one message a Show sends, through the composer's path as the still's is: what was shown and how long, the
    /// storyboard, each frame's path with its time, what he said there and what happened, the recording, for people, and
    /// — as the still's ends — how to mark an answer on `canvas`.
    public static func prompt(_ frames: [(moment: Moment, path: String)], said: [Said] = [], about label: String, length: Double, storyboard: String, video: String, canvas: CanvasDocument) -> String {
        var lines = ["[canvas] Tyler showed \(label) (\(clock(length))).", "Storyboard: \(storyboard)"]
        let words = words(said, at: frames.map(\.moment.at))
        lines += frames.enumerated().map { index, frame in "\(stamp(frame.moment.at)) \(frame.path) — \(happened(frame.moment, first: index == 0, words: words[index]))" }
        lines.append("The recording, for people (agents can't watch video): \(video)")
        lines.append(CanvasPrompt.answer(canvas))
        return lines.joined(separator: "\n")
    }
}

// MARK: - On the pill

extension CanvasToolPill {
    /// Show on the pill: recording since a moment, or stopped at a length and waiting for Send or the ×.
    public enum Recording: Equatable {
        case since(Date)
        case stopped(TimeInterval)
    }

    /// The mic (narration: off unless Tyler turns it on, and fixed once a Show starts), the record button (panel-lab's
    /// `#bShow`), red while recording, and beside it the time; none where Show isn't.
    @ViewBuilder var showControl: some View {
        if let onShow {
            let on = { if case .since = recording { return true } else { return false } }()
            if let onNarrate {
                Button(action: onNarrate) {
                    Image(systemName: narrate ? "mic.fill" : "mic.slash")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(narrate ? ConchColor.onAccent : ConchColor.overlayGlassIcon)
                        .frame(width: Self.buttonSize, height: Self.buttonSize)
                        .background { if narrate { Circle().fill(ConchColor.accent) } }
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(recording != nil)
                .opacity(recording != nil && !narrate ? 0.4 : 1)
                .help(narrate ? "Narration on: Show records what you say too" : "Narration off: Show records the screen alone")
                .accessibilityLabel("Narrate")
                .accessibilityValue(narrate ? "On" : "Off")
                .accessibilityAddTraits(narrate ? .isSelected : [])
            }
            Button(action: onShow) {
                Image(systemName: "record.circle")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(on ? ConchColor.onVoice : ConchColor.overlayGlassIcon)
                    .frame(width: Self.buttonSize, height: Self.buttonSize)
                    .background { if on { Circle().fill(CanvasStoryboard.red.color) } }
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            // Stopped, it waits for Send or the ×.
            .disabled(sending || !(recording == nil || on))
            .opacity(sending || !(recording == nil || on) ? 0.4 : 1)
            .help(on ? "Stop recording: Send sends it, Esc throws it away" : "Show: record the screen, ink and all (R)")
            .accessibilityLabel(on ? "Stop recording" : "Show")
            switch recording {
            case let .since(start)?:
                // A second at a time from when it started; nothing moves under Reduce Motion but the digits.
                TimelineView(.periodic(from: start, by: 1)) { context in
                    showTime(CanvasStoryboard.timer(context.date.timeIntervalSince(start)))
                }
            case let .stopped(length)?:
                showTime(CanvasStoryboard.clock(length))
            case nil:
                EmptyView()
            }
        }
    }

    private func showTime(_ text: String) -> some View {
        Text(text)
            .font(ConchType.code.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(CanvasStoryboard.red.color)
            .padding(.horizontal, 6)
            .accessibilityLabel("Recording, \(text)")
    }
}
