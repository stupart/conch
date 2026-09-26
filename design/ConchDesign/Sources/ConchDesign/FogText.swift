import Combine
import CoreGraphics
import Foundation
#if canImport(AppKit)
import AppKit
private typealias PlatformFont = NSFont
#else
import UIKit
private typealias PlatformFont = UIFont
#endif

/// The overlay's words, the overlay lab's (~/Projects/conch-design/overlay-lab.html): where the transcript is scrolled,
/// how fast a reply's words come in, and how tall the reply line grows. Pure, so the lab's fuzz bugs stay fixed by test.

/// Where the transcript is scrolled, and whether it follows the newest line. Only the reader's own wheel or trackpad
/// scrolling unpins it; layout (a resize, full screen, typing, streaming, a clamp) never does. The lab could unpin on a
/// scroll event a layout clamp fired just after a wheel; here nothing but `scroll(by:momentum:)` can.
public struct FogScroll: Equatable, Sendable {
    /// How far the transcript is scrolled back from its newest end, in points: 0 shows the newest line.
    public private(set) var offset: CGFloat = 0
    /// It follows the newest line.
    public private(set) var pinned = true
    /// Words arrived while scrolled away: the pill says "New reply" rather than "Newest".
    public private(set) var unseen = false
    /// How far it can scroll: how much taller the transcript is than its box.
    public private(set) var range: CGFloat = 0
    /// After the pill or a send, the rest of the last swipe's glide is ignored until a new swipe begins, so it can't
    /// scroll the reader straight back up.
    private var ignoresGlide = false

    public init() {}

    /// The reader's wheel or trackpad moved it `delta` points toward the oldest line (negative, toward the newest);
    /// `momentum` for the glide after a swipe. It unpins only when that moved it away from the newest line.
    public mutating func scroll(by delta: CGFloat, momentum: Bool) {
        if !momentum { ignoresGlide = false }
        guard !(momentum && ignoresGlide) else { return }
        let before = offset
        offset = min(max(offset + delta, 0), range)
        guard offset != before else { return }
        pinned = offset < 6
        if pinned { unseen = false }
    }

    /// The transcript or its box changed size. Pinned, it stays on the newest line; scrolled away, the reader keeps their
    /// place (the same distance from the oldest line). Never unpins; with nothing left to scroll it is at the newest.
    public mutating func layout(range next: CGFloat) {
        let next = max(0, next)
        offset = pinned ? min(offset, next) : min(max(next - (range - offset), 0), next)
        range = next
        if range < 1 {
            offset = 0
            pinned = true
            unseen = false
        }
    }

    /// The pill, or a send: back to the newest line.
    public mutating func toNewest() {
        pinned = true
        unseen = false
        ignoresGlide = true
    }

    /// New words came in.
    public mutating func arrived() {
        if !pinned { unseen = true }
    }

    /// One frame of `dt` seconds: pinned, it glides the rest of the way to the newest line. True once there.
    public mutating func follow(dt: Double, reduceMotion: Bool) -> Bool {
        guard pinned, offset > 0 else { return true }
        offset = offset <= 1 || reduceMotion ? 0 : max(0, offset - max(offset * CGFloat(1 - exp(-dt / 0.07)), 1))
        return offset == 0
    }
}

/// When each word of the newest reply fades in. The daemon sends a reply in chunks, not words, so a chunk's words are
/// let in one after another at `ConchMotion.wordsPerSecond`, a little slower after punctuation, each fading up over
/// `ConchMotion.wordReveal`. However big a chunk, it is all in within `longest` seconds.
public struct WordReveal: Equatable, Sendable {
    /// The turn it is revealing.
    public private(set) var id: String?
    /// When each of its words starts to fade in, on the caller's clock.
    public private(set) var starts: [Double] = []
    /// Any backlog is in within 3 s: a 500-word chunk would otherwise take 45 s at a talking pace.
    public static let longest: Double = 3

    public init() {}

    /// The words of `text`, as the reveal counts them.
    public static func words(_ text: String) -> [Substring] {
        text.split(whereSeparator: \.isWhitespace)
    }

    /// The gap after `word`: a talking pace, with a breath at the end of a sentence and a shorter one at a comma.
    public static func gap(after word: Substring) -> Double {
        let pause: Double = switch word.last {
        case ".", "!", "?": 0.24
        case ",", ";", ":": 0.1
        default: 0
        }
        return 1 / ConchMotion.wordsPerSecond + pause
    }

    /// The newest reply, `id`, has `words` now. The first reply ever seen shows whole: it was there before anyone watched.
    public mutating func update(id: String, words: [Substring], now: Double) {
        if id != self.id {
            let first = self.id == nil
            self.id = id
            starts = first ? Array(repeating: -.infinity, count: words.count) : []
        }
        if words.count < starts.count { starts.removeLast(starts.count - words.count) }
        guard words.count > starts.count else { return }
        var next = starts.last.map { max(now, $0 + Self.gap(after: words[starts.count - 1])) } ?? now
        for index in starts.count..<words.count {
            starts.append(next)
            next += Self.gap(after: words[index])
        }
        // Squeeze whatever hasn't started into `longest`, keeping its rhythm.
        guard let last = starts.last, last - now > Self.longest else { return }
        let squeeze = Self.longest / (last - now)
        for index in starts.indices where starts[index] > now {
            starts[index] = now + (starts[index] - now) * squeeze
        }
    }

    /// How many words have begun to show by `now`.
    public func shown(at now: Double) -> Int {
        starts.lastIndex { $0 <= now }.map { $0 + 1 } ?? 0
    }

    /// Word `index` at `now`: 0 not yet, to 1 whole, eased out.
    public func progress(ofWord index: Int, at now: Double) -> Double {
        guard starts.indices.contains(index) else { return 1 }
        let u = min(max((now - starts[index]) / ConchMotion.wordReveal, 0), 1)
        return 1 - pow(1 - u, 3)
    }

    /// Some word is still coming in.
    public func isRevealing(at now: Double) -> Bool {
        starts.last.map { now < $0 + ConchMotion.wordReveal } ?? false
    }
}

/// The reply line: the conversation's own type, growing from one line to five, then scrolling inside itself.
public enum FogReply {
    /// The lab's reply type: 1.3 line height, in a row at least 40 pt tall.
    public static func lineHeight(_ fontSize: CGFloat) -> CGFloat { fontSize * 1.3 }
    public static func padding(_ fontSize: CGFloat) -> CGFloat { max(0.5, (40 - lineHeight(fontSize)) / 2) }
    /// Between the transcript and the reply line.
    public static let gap: CGFloat = 16
    /// The newest transcript lines the reply line never covers, however long it grows.
    public static let transcriptKept: CGFloat = 90

    /// The reply line's height for `lines` of text when the words have `height` in all: up to five lines, fewer when more
    /// would leave the transcript less than `transcriptKept`.
    public static func height(lines: Int, fontSize: CGFloat, in height: CGFloat) -> CGFloat {
        let line = lineHeight(fontSize), pad = padding(fontSize)
        let cap = min(max(Int(((height - gap - transcriptKept - 2 * pad) / line).rounded(.down)), 1), 5)
        return CGFloat(min(max(lines, 1), cap)) * line + 2 * pad
    }

    /// The reply's line count at `width`, counted to six at most: all the height needs. Only the first 2,000 characters
    /// are laid out, which at these sizes always fill six lines, so a 50 KB draft costs what a short one does.
    public static func lines(of text: String, width: CGFloat, fontSize: CGFloat) -> Int {
        guard !text.isEmpty, width > 0 else { return 1 }
        let storage = NSTextStorage(string: String(text.prefix(2000)), attributes: attributes(fontSize: fontSize))
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        var lines = 0
        layout.enumerateLineFragments(forGlyphRange: layout.glyphRange(for: container)) { _, _, _, _, stop in
            lines += 1
            if lines >= 6 { stop.pointee = true }
        }
        if text.hasSuffix("\n") { lines += 1 }
        return min(max(lines, 1), 6)
    }

    /// The reply's type, as the field draws it and `lines` measures it.
    public static func attributes(fontSize: CGFloat) -> [NSAttributedString.Key: Any] {
        let line = lineHeight(fontSize), font = PlatformFont.systemFont(ofSize: fontSize, weight: .medium)
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = line
        paragraph.maximumLineHeight = line
        return [.font: font, .paragraphStyle: paragraph, .kern: -0.014 * fontSize,
                .baselineOffset: (line - (font.ascender - font.descender)) / 2]
    }

    public enum Key: Equatable, Sendable {
        case send, newline, leave
    }

    /// Return sends; Shift- or Option-Return starts a new line; Esc leaves the field.
    public static func key(returnKey: Bool, shift: Bool, option: Bool) -> Key {
        guard returnKey else { return .leave }
        return shift || option ? .newline : .send
    }
}

/// The overlay's words as they move, drawn by `ConversationFog` and stepped by its host on the display's frames: the
/// transcript's scroll, the newest reply's words coming in, the reply line growing, and a sent message flying in. The
/// host feeds it the store (`update`), the reader's scrolling and sends; the fog feeds it what it measured.
@MainActor
public final class FogTextState: ObservableObject {
    public private(set) var scroll = FogScroll()
    public private(set) var reveal = WordReveal()
    /// The reveal's clock: the host's frame time.
    public private(set) var now: Double = 0
    /// The reply line's height, on the grow spring toward the height its lines want.
    public private(set) var replyHeight: CGFloat = 40
    /// A message sent and not yet in the daemon's transcript: shown at once.
    public private(set) var sent: String?
    /// A sent message on its way from the reply line into the transcript: 0 leaving to 1 landed, one spring; and the
    /// reply line's height when it left.
    public private(set) var flight: (progress: CGFloat, replyHeight: CGFloat)?
    /// Starts the host's frames; `step` then redraws.
    public var wake: () -> Void = {}

    private var replyTarget: CGFloat = 40
    private var replyVelocity: CGFloat = 0
    private var flightVelocity: CGFloat = 0
    /// Your newest turn in the daemon's transcript, and what it was when `sent` went.
    private var yours: String?
    private var yoursAtSend: String?
    private var transcript: (content: CGFloat, box: CGFloat) = (0, 0)
    private var lines: (text: String, width: CGFloat, fontSize: CGFloat, count: Int)?
    private var dirty = false

    public init() {}

    /// Another session: its transcript from the newest line, and its newest reply whole.
    public func session() {
        scroll = FogScroll()
        reveal = WordReveal()
        sent = nil
        flight = nil
        yours = nil
        changed()
    }

    /// The daemon's transcript now. New words in the newest reply queue to come in; your sent message gives way to the
    /// daemon's copy of it.
    public func update(turns: [ConversationTurn], now: Double) {
        yours = turns.last(where: \.fromYou)?.id
        if sent != nil, yours != yoursAtSend { sent = nil }
        if let reply = turns.last(where: { !$0.fromYou }) {
            let id = reveal.id, count = reveal.starts.count
            reveal.update(id: reply.id, words: WordReveal.words(ConversationFog.plain(reply.text)), now: now)
            if (id != nil && reveal.id != id) || reveal.starts.count > count { scroll.arrived() }
        }
        changed()
    }

    /// Return in the reply line: the message shows at once, flies in, and the transcript goes back to the newest line.
    public func send(_ message: String) {
        sent = message
        yoursAtSend = yours
        flight = (0, replyHeight)
        flightVelocity = 0
        scroll.toNewest()
        changed()
    }

    /// The daemon couldn't deliver it.
    public func sendFailed() {
        sent = nil
        flight = nil
        changed()
    }

    /// The reader's wheel or trackpad (`FogScroll.scroll(by:momentum:)`).
    public func scroll(by delta: CGFloat, momentum: Bool) {
        scroll.scroll(by: delta, momentum: momentum)
        changed()
    }

    /// The pill.
    public func toNewest() {
        scroll.toNewest()
        changed()
    }

    /// How tall the reply line wants to be for `draft` at `width`, when the words have `height` in all. Counted again only
    /// when the draft, its width or its size changes.
    public func replyTarget(for draft: String, width: CGFloat, fontSize: CGFloat, in height: CGFloat) -> CGFloat {
        if let lines, lines.text == draft, lines.width == width, lines.fontSize == fontSize {
            return FogReply.height(lines: lines.count, fontSize: fontSize, in: height)
        }
        let count = FogReply.lines(of: draft, width: width, fontSize: fontSize)
        lines = (draft, width, fontSize, count)
        return FogReply.height(lines: count, fontSize: fontSize, in: height)
    }

    /// The reply's line count, as last measured, to six.
    public var replyLines: Int { lines?.count ?? 1 }

    /// The reply line grows or shrinks toward `target`, on the grow spring.
    public func grow(to target: CGFloat) {
        guard target != replyTarget else { return }
        replyTarget = target
        changed()
    }

    /// The fog measured the transcript's height or its box's.
    public func measured(content: CGFloat? = nil, box: CGFloat? = nil) {
        if let content { transcript.content = content }
        if let box { transcript.box = box }
        scroll.layout(range: transcript.content - transcript.box)
        changed()
    }

    /// One display frame. True while something is still moving.
    @discardableResult
    public func step(dt: Double, now: Double, reduceMotion: Bool) -> Bool {
        self.now = now
        var moving = !scroll.follow(dt: dt, reduceMotion: reduceMotion)
        if replyHeight != replyTarget {
            if ConchMotion.grow.resolved(reduceMotion: reduceMotion).step(&replyHeight, velocity: &replyVelocity, to: replyTarget, dt: dt, epsilon: 0.05) {
                replyHeight = replyTarget
                replyVelocity = 0
            } else {
                moving = true
            }
        }
        if var flight {
            if ConchMotion.sent.resolved(reduceMotion: reduceMotion).step(&flight.progress, velocity: &flightVelocity, to: 1, dt: dt, epsilon: 0.002) {
                self.flight = nil
            } else {
                self.flight = flight
                moving = true
            }
        }
        let revealing = reveal.isRevealing(at: now)
        if moving || revealing || dirty { objectWillChange.send() }
        dirty = false
        return moving || revealing
    }

    private func changed() {
        dirty = true
        wake()
    }
}
