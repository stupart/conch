import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// The overlay lab's text (~/Projects/conch-design/overlay-lab.html) held by the fog: pinning, the reveal's pace, the reply
/// line's cap, the layout by corner, wrapping, and cost. The lab's fuzz bugs each have a test here.
final class FogTextTests: XCTestCase {
    static let screen = CGRect(x: 0, y: 0, width: 1728, height: 1117)
    static let dock = EdgeInsets(top: 0, leading: 0, bottom: 65, trailing: 0)
    static let menuBar = EdgeInsets(top: 33, leading: 0, bottom: 0, trailing: 0)

    // MARK: Pinning

    /// Only the reader's own scroll, in the direction it pushed, changes pinned. Layout never does.
    func testPinningChangesOnlyOnAReaderScrollInThePushedDirection() {
        var scroll = FogScroll()
        // Resizes, full screen, typing, streaming and clamps, down to nothing to scroll and back.
        for range: CGFloat in [800, 1200, 300, 0.5, 2000, 40, 900] {
            scroll.layout(range: range)
            XCTAssertTrue(scroll.pinned, "layout to \(range) unpinned it")
            XCTAssertEqual(scroll.offset, 0)
        }
        // A wheel toward the newest line, already there: nothing moves, still pinned.
        scroll.scroll(by: -50, momentum: false)
        XCTAssertTrue(scroll.pinned)
        // Toward the oldest: unpinned, where the wheel took it.
        scroll.scroll(by: 120, momentum: false)
        XCTAssertFalse(scroll.pinned)
        XCTAssertEqual(scroll.offset, 120)
        // Words arrive while away: it keeps the reader's place and says there's a new reply, still unpinned.
        scroll.layout(range: 1000)
        XCTAssertEqual(scroll.offset, 220)
        scroll.arrived()
        XCTAssertFalse(scroll.pinned)
        XCTAssertTrue(scroll.unseen)
        // The box shrinking (the reply line growing) keeps the place too; a clamp to zero doesn't re-pin.
        scroll.layout(range: 1100)
        XCTAssertEqual(scroll.offset, 320)
        scroll.layout(range: 20)
        XCTAssertFalse(scroll.pinned)
        // Scrolled back to within 6 pt of the newest line by the reader, it follows again.
        scroll.layout(range: 1000)
        scroll.scroll(by: -(scroll.offset - 4), momentum: false)
        XCTAssertTrue(scroll.pinned)
        XCTAssertFalse(scroll.unseen)
    }

    /// The lab once unpinned without a scroll (its fuzz: full screen, drags, typing, collapse). Here nothing but a scroll
    /// can: thousands of layouts, arrivals, frames and sends, many while it glides back after the pill, and it is always
    /// pinned.
    @MainActor
    func testNothingButAScrollEverUnpins() {
        var seed: UInt64 = 7
        func random(_ upper: Int) -> Int {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Int(seed >> 33) % upper
        }
        var scroll = FogScroll()
        let state = FogTextState()
        var turns = [ConversationTurn(id: "0", fromYou: false, text: "Hello there.")]
        var now = 0.0
        for step in 0..<5000 {
            now += 1.0 / 120
            switch random(6) {
            case 0:
                let range = CGFloat(random(3000)) - 200
                scroll.layout(range: range)
                state.measured(content: CGFloat(random(3000)), box: CGFloat(random(700)))
            case 1:
                scroll.arrived()
                turns.append(ConversationTurn(id: "\(step)", fromYou: random(2) == 0, text: "more words, and more. " + String(repeating: "x ", count: random(40))))
                state.update(turns: turns, now: now)
            case 2:
                _ = scroll.follow(dt: 1.0 / 120, reduceMotion: random(2) == 0)
                state.step(dt: 1.0 / 120, now: now, reduceMotion: false)
            case 3:
                // The reader scrolls away and takes the pill: from here it glides back, pinned, through whatever comes.
                scroll.layout(range: 2000)
                scroll.scroll(by: 300, momentum: false)
                scroll.toNewest()
                state.measured(content: 3000, box: 300)
                state.scroll(by: 300, momentum: false)
                if random(2) == 0 { state.toNewest() } else { state.send("sent \(step)") }
            case 4:
                state.grow(to: 40 + CGFloat(random(5)) * 31.2)
            default:
                // A glide left over from a swipe before the last send: ignored.
                state.scroll(by: CGFloat(random(80)), momentum: true)
            }
            XCTAssertTrue(scroll.pinned, "unpinned without a scroll at step \(step)")
            XCTAssertTrue(state.scroll.pinned, "the fog unpinned without a scroll at step \(step)")
        }
    }

    /// The pill re-pins, and what's left of the swipe's glide can't scroll it straight back up; so does a send.
    @MainActor
    func testThePillAndASendRepinAndCancelTheLeftoverGlide() {
        var scroll = FogScroll()
        scroll.layout(range: 900)
        scroll.scroll(by: 30, momentum: false)
        scroll.scroll(by: 60, momentum: true)
        XCTAssertFalse(scroll.pinned)
        scroll.toNewest()
        XCTAssertTrue(scroll.pinned)
        XCTAssertFalse(scroll.unseen)
        for _ in 0..<20 { scroll.scroll(by: 25, momentum: true) }
        XCTAssertTrue(scroll.pinned, "the leftover glide re-unpinned it")
        // Layout while it glides back doesn't unpin it either.
        scroll.layout(range: 1200)
        scroll.layout(range: 95)
        XCTAssertTrue(scroll.pinned)
        // It glides the rest of the way, quickly.
        var frames = 0
        while !scroll.follow(dt: 1.0 / 120, reduceMotion: false) { frames += 1 }
        XCTAssertEqual(scroll.offset, 0)
        XCTAssertLessThan(frames, 90)
        // A new swipe scrolls again.
        scroll.scroll(by: 40, momentum: false)
        XCTAssertFalse(scroll.pinned)

        let state = FogTextState()
        state.update(turns: [ConversationTurn(id: "1", fromYou: true, text: "Hi"), ConversationTurn(id: "2", fromYou: false, text: "Hello.")], now: 0)
        state.measured(content: 2000, box: 300)
        state.scroll(by: 200, momentum: false)
        XCTAssertFalse(state.scroll.pinned)
        state.send("Ship it")
        XCTAssertTrue(state.scroll.pinned)
        XCTAssertEqual(state.sent, "Ship it")
        XCTAssertEqual(state.flight?.progress, 0)
        state.scroll(by: 50, momentum: true)
        XCTAssertTrue(state.scroll.pinned)
        // It flies in on one spring and the transcript glides back to the newest line.
        var now = 0.0, flights: [CGFloat] = []
        for _ in 0..<120 {
            now += 1.0 / 120
            state.step(dt: 1.0 / 120, now: now, reduceMotion: false)
            flights.append(state.flight?.progress ?? 1)
        }
        XCTAssertNil(state.flight)
        XCTAssertEqual(state.scroll.offset, 0)
        XCTAssertGreaterThan(flights.max() ?? 0, 1, "one spring, with its little overshoot")
        // The daemon's copy takes the place of the one shown at once.
        state.update(turns: [ConversationTurn(id: "1", fromYou: true, text: "Hi"), ConversationTurn(id: "2", fromYou: false, text: "Hello."), ConversationTurn(id: "3", fromYou: true, text: "Ship it")], now: now)
        XCTAssertNil(state.sent)
        state.send("Again")
        state.sendFailed()
        XCTAssertNil(state.sent)
    }

    // MARK: Reveal

    /// Words come in at 13 a second, a breath longer after a sentence or a comma; a big chunk is all in within 3 s.
    func testTheRevealKeepsATalkingPaceAndCapsABigChunk() {
        var reveal = WordReveal()
        // What was there before anyone watched shows whole.
        reveal.update(id: "old", words: WordReveal.words("Earlier reply stays whole."), now: 0)
        XCTAssertEqual(reveal.shown(at: 0), 4)
        XCTAssertFalse(reveal.isRevealing(at: 0))

        let plain = WordReveal.words("one two three four five six seven eight nine ten eleven twelve thirteen")
        reveal.update(id: "new", words: plain, now: 10)
        XCTAssertEqual(reveal.starts[0], 10)
        XCTAssertEqual(reveal.starts[1] - reveal.starts[0], 1 / ConchMotion.wordsPerSecond, accuracy: 1e-9)
        XCTAssertEqual(reveal.starts[12] - reveal.starts[0], 12 / 13, accuracy: 1e-9)
        XCTAssertEqual(reveal.shown(at: 10.5), 7)
        // Each fades up over 0.36 s.
        XCTAssertEqual(reveal.progress(ofWord: 0, at: 10), 0)
        XCTAssertEqual(reveal.progress(ofWord: 0, at: 10 + ConchMotion.wordReveal), 1)
        XCTAssertTrue((0.3...0.99).contains(reveal.progress(ofWord: 0, at: 10.12)))
        XCTAssertEqual(ConchMotion.wordReveal, 0.36)
        XCTAssertEqual(ConchMotion.wordRevealBlur, 4)

        let sentence = WordReveal.words("Done. It is live, and tests pass.")
        reveal.update(id: "punctuated", words: sentence, now: 20)
        XCTAssertEqual(reveal.starts[1] - reveal.starts[0], 1 / 13 + 0.24, accuracy: 1e-9, "after a full stop")
        XCTAssertEqual(reveal.starts[4] - reveal.starts[3], 1 / 13 + 0.1, accuracy: 1e-9, "after a comma")
        XCTAssertEqual(reveal.starts[2] - reveal.starts[1], 1 / 13, accuracy: 1e-9)
        // The next chunk of the same reply queues behind the words still coming.
        reveal.update(id: "punctuated", words: WordReveal.words("Done. It is live, and tests pass. Next up"), now: 20.1)
        XCTAssertEqual(reveal.starts[7] - reveal.starts[6], 1 / 13 + 0.24, accuracy: 1e-9)

        // 500 words in one chunk: in order, spread out, and all in within 3 s rather than 45.
        let long = (0..<500).map { $0 % 12 == 11 ? "end." : "word" }.map { Substring($0) }
        reveal.update(id: "long", words: long, now: 30)
        XCTAssertEqual(reveal.starts.count, 500)
        XCTAssertLessThanOrEqual(reveal.starts.last! - 30, WordReveal.longest + 1e-9)
        XCTAssertEqual(reveal.starts, reveal.starts.sorted())
        XCTAssertGreaterThan(reveal.starts[250] - 30, 1)
        XCTAssertEqual(reveal.shown(at: 33), 500)
        XCTAssertFalse(reveal.isRevealing(at: 33 + ConchMotion.wordReveal))
    }

    // MARK: Reply line

    /// Up to five lines, fewer when more would leave the transcript unreadable: the lab's 5-line reply at the smallest fog
    /// left 29 px of transcript.
    func testTheReplyLineCapsAtFiveLinesAndKeepsTheTranscriptReadableAtTheSmallestFog() {
        XCTAssertEqual(FogReply.height(lines: 1, fontSize: 24, in: 600), 40, accuracy: 0.01)
        XCTAssertEqual(FogReply.height(lines: 3, fontSize: 24, in: 600), 3 * 31.2 + 8.8, accuracy: 0.01)
        XCTAssertEqual(FogReply.height(lines: 50, fontSize: 24, in: 600), 5 * 31.2 + 8.8, accuracy: 0.01)
        let least = FogDock.minSize(in: Self.screen)
        for corner in [FogCorner.bottomLeading, .bottomTrailing, .topLeading, .topTrailing] {
            let insets = corner.bottom ? Self.dock : Self.menuBar
            let frame = ConversationFog.textFrame(in: least, corner: corner, insets: insets, fullScreen: false)
            let reply = FogReply.height(lines: 50, fontSize: 24, in: frame.height)
            let transcript = frame.height - FogReply.gap - reply
            XCTAssertGreaterThanOrEqual(transcript, FogReply.transcriptKept, "\(corner): \(transcript) pt of transcript")
            XCTAssertGreaterThanOrEqual(reply, 40)
        }
        // Full screen keeps its five.
        let full = ConversationFog.textFrame(in: Self.screen.size, corner: .bottomLeading, insets: Self.dock, fullScreen: true)
        XCTAssertEqual(FogReply.height(lines: 9, fontSize: 36, in: full.height), 5 * 46.8 + 1, accuracy: 0.01)
    }

    /// Lines are counted by the text system the field draws with, to six, and a 50 KB draft costs no more than a short one.
    func testTheReplysLinesAreCountedCheaply() {
        let width = 540 - ConversationFog.micSpace
        XCTAssertEqual(FogReply.lines(of: "", width: width, fontSize: 24), 1)
        XCTAssertEqual(FogReply.lines(of: "Looks good.", width: width, fontSize: 24), 1)
        XCTAssertEqual(FogReply.lines(of: "a\nb\nc", width: width, fontSize: 24), 3)
        XCTAssertEqual(FogReply.lines(of: "a\n", width: width, fontSize: 24), 2)
        let three = "Looks good. Ship it, then do the same for the Dayloop invite, and keep its heading on one line on phones."
        XCTAssertEqual(FogReply.lines(of: three, width: width, fontSize: 24), 3)
        let huge = String(repeating: "The quick brown fox jumps over the lazy dog. ", count: 1140)
        XCTAssertGreaterThan(huge.utf8.count, 50_000)
        let start = DispatchTime.now().uptimeNanoseconds
        XCTAssertEqual(FogReply.lines(of: huge, width: width, fontSize: 24), 6)
        let ms = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6
        print("reply lines of a 50 KB draft: \(String(format: "%.2f", ms)) ms")
        XCTAssertLessThan(ms, 50)
    }

    /// Return sends; Shift- or Option-Return starts a new line; Esc leaves.
    func testReturnSendsShiftReturnStartsALineEscLeaves() {
        XCTAssertEqual(FogReply.key(returnKey: true, shift: false, option: false), .send)
        XCTAssertEqual(FogReply.key(returnKey: true, shift: true, option: false), .newline)
        XCTAssertEqual(FogReply.key(returnKey: true, shift: false, option: true), .newline)
        XCTAssertEqual(FogReply.key(returnKey: false, shift: false, option: false), .leave)
    }

    /// A press on the reply line is its own, not a drag of the fog: its frame is one of the fog's controls.
    @MainActor
    func testTheReplyLineKeepsItsClicks() throws {
        final class Frames { var value: [CGRect] = [] }
        let frames = Frames(), size = CGSize(width: 900, height: 640)
        let fog = ConversationFog(turns: Self.turns(4), draft: .constant(""), text: FogTextState(), isListening: false, isFullScreen: false, insets: Self.dock, showsButtons: false, onMic: {}, onSend: {}, onCollapse: {}, onFullScreen: {})
            .frame(width: size.width, height: size.height)
            .coordinateSpace(name: FogControls.space)
            .onPreferenceChange(FogControls.self) { value in MainActor.assumeIsolated { frames.value = value } }
        let host = NSHostingView(rootView: fog)
        host.frame = CGRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        let text = ConversationFog.textFrame(in: size, corner: .bottomLeading, insets: Self.dock, fullScreen: false)
        for point in [CGPoint(x: text.minX + 20, y: text.maxY - 20), CGPoint(x: text.minX + 200, y: text.maxY - 20)] {
            XCTAssertTrue(frames.value.contains { $0.contains(point) }, "a press at \(point) on the reply line would drag the fog: \(frames.value)")
        }
        XCTAssertFalse(frames.value.contains { $0.contains(CGPoint(x: text.midX, y: text.minY + 100)) }, "the transcript should drag")
    }

    // MARK: Layout

    /// Hanging from a top corner the transcript runs top-down, newest nearest the top; otherwise and full screen, bottom-up.
    /// Docked, the words keep 52 pt from their side in a column up to 540 wide; off the corner they centre.
    func testTopCornersRunTopDownAndFloatingWordsCentre() {
        XCTAssertTrue(ConversationFog.newestAtTop(corner: .topLeading, fullScreen: false))
        XCTAssertTrue(ConversationFog.newestAtTop(corner: .topTrailing, fullScreen: false))
        XCTAssertFalse(ConversationFog.newestAtTop(corner: .bottomLeading, fullScreen: false))
        XCTAssertFalse(ConversationFog.newestAtTop(corner: .bottomTrailing, fullScreen: false))
        XCTAssertFalse(ConversationFog.newestAtTop(corner: .topTrailing, fullScreen: true))

        let size = CGSize(width: 900, height: 640)
        let bl = ConversationFog.textFrame(in: size, corner: .bottomLeading, insets: Self.dock, fullScreen: false)
        XCTAssertEqual(bl.minX, 52)
        XCTAssertEqual(bl.width, 540)
        let tr = ConversationFog.textFrame(in: size, corner: .topTrailing, insets: Self.menuBar, fullScreen: false)
        XCTAssertEqual(tr.maxX, 900 - 52)
        XCTAssertEqual(ConversationFog.textFrame(in: CGSize(width: 480, height: 360), corner: .bottomLeading, insets: Self.dock, fullScreen: false).width, 376)

        // Held in the middle of the screen: centred both ways.
        var motion = FogMotion(size: size, corner: .bottomLeading, in: Self.screen)
        motion.press(at: CGPoint(x: 450, y: 320), time: 0)
        motion.drag(to: CGPoint(x: Self.screen.midX, y: Self.screen.midY), time: 0.05)
        for _ in 0..<240 { motion.step(dt: 1.0 / 120) }
        let floating = ConversationFog.textFrame(in: size, corner: motion.corner, insets: Self.dock, fullScreen: false, magnet: motion.magnet)
        XCTAssertEqual(floating.midX, size.width / 2, accuracy: 0.5)
        XCTAssertEqual(floating.midY, size.height / 2, accuracy: 0.5)
        // Docked, the magnet puts it where the corner does.
        let docked = FogMotion(size: size, corner: .topTrailing, in: Self.screen)
        XCTAssertEqual(ConversationFog.textFrame(in: size, corner: .topTrailing, insets: Self.menuBar, fullScreen: false, magnet: docked.magnet), tr)

        // The scrim sits behind the newest lines: at the top when they are, and it follows a reply line that grows.
        var top = FogLook(docked, insets: Self.menuBar)
        XCTAssertLessThan(top.scrimArea.midY, size.height / 2)
        var bottom = FogLook(FogMotion(size: size, corner: .bottomLeading, in: Self.screen), insets: Self.dock)
        let one = bottom.scrimArea.midY
        bottom.replyHeight = 5 * 31.2 + 8.8
        XCTAssertEqual(one - bottom.scrimArea.midY, 5 * 31.2 + 8.8 - 40, accuracy: 0.5)
        let oneTop = top.scrimArea.midY
        top.replyHeight = 5 * 31.2 + 8.8
        XCTAssertEqual(top.scrimArea.midY - oneTop, 5 * 31.2 + 8.8 - 40, accuracy: 0.5)
    }

    /// A long path or link wraps at the column instead of running out of it (and out of the blur).
    @MainActor
    func testLongUnbrokenStringsWrapInsideTheColumn() throws {
        let size = CGSize(width: 900, height: 640)
        let path = "/Users/tylerstupart/Projects/conch-design/lab-shots/native-1d-a-really-long-file-name-with-no-breaks-at-all-anywhere.png?query=abcdefghijklmnopqrstuvwxyz0123456789"
        // Only the path, so every bit of ink above the reply line is its.
        let turns = [ConversationTurn(id: "2", fromYou: false, text: path)]
        let renderer = ImageRenderer(content: ConversationFog(turns: turns, draft: .constant(""), text: FogTextState(), isListening: false, isFullScreen: false, insets: Self.dock, showsButtons: false, onMic: {}, onSend: {}, onCollapse: {}, onFullScreen: {})
            .frame(width: size.width, height: size.height)
            .environment(\.conchRendersStatically, true)
            .environment(\.colorScheme, .light))
        renderer.scale = 1
        let image = try XCTUnwrap(renderer.cgImage)
        let text = ConversationFog.textFrame(in: size, corner: .bottomLeading, insets: Self.dock, fullScreen: false)
        // Ink above the reply line: the newest reply is its lowest part.
        let ink = Self.ink(image, in: CGRect(x: 0, y: text.minY, width: size.width, height: text.height - 40 - FogReply.gap))
        let box = try XCTUnwrap(ink)
        XCTAssertLessThanOrEqual(box.maxX, text.maxX + 1, "ran past the column: \(box)")
        // 150-odd characters at 24 pt in 540 pt take several lines.
        XCTAssertGreaterThan(box.height, 3 * 24, "did not wrap: \(box)")
    }

    // MARK: Cost

    /// A 50 KB draft and a 2,000-turn transcript lay out without a hang; typing a character into it and streaming a reply
    /// stay cheap.
    @MainActor
    func testA50KBDraftAndA2000TurnTranscriptLayOutWithoutAHang() throws {
        final class Draft { var text = String(repeating: "The quick brown fox jumps over the lazy dog. ", count: 1140) }
        let draft = Draft()
        XCTAssertGreaterThan(draft.text.utf8.count, 50_000)
        var turns = Self.turns(2000)
        let state = FogTextState()
        func fog() -> AnyView {
            AnyView(ConversationFog(turns: turns, draft: Binding(get: { draft.text }, set: { draft.text = $0 }), text: state, isListening: false, isFullScreen: false, insets: Self.dock, onMic: {}, onSend: {}, onCollapse: {}, onFullScreen: {})
                .frame(width: 900, height: 640))
        }
        func ms(_ work: () -> Void) -> Double {
            let start = DispatchTime.now().uptimeNanoseconds
            work()
            return Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6
        }
        let host = NSHostingView(rootView: fog())
        host.frame = CGRect(x: 0, y: 0, width: 900, height: 640)
        let first = ms {
            state.update(turns: turns, now: 0)
            host.layoutSubtreeIfNeeded()
            _ = host.bitmapImageRepForCachingDisplay(in: host.bounds).map { host.cacheDisplay(in: host.bounds, to: $0) }
        }
        // Typing into the reply's own text view, as a keystroke does: the draft store hears it and the fog draws again.
        let field = try XCTUnwrap(Self.textView(in: host))
        var typing: [Double] = []
        for _ in 0..<30 {
            typing.append(ms {
                field.insertText("x", replacementRange: NSRange(location: (field.string as NSString).length, length: 0))
                host.rootView = fog()
                host.layoutSubtreeIfNeeded()
            })
        }
        XCTAssertTrue(draft.text.hasSuffix(String(repeating: "x", count: 30)))
        // The whole draft replaced from outside, as a dictation or a send does.
        let replaced = ms {
            draft.text += " and then some more."
            host.rootView = fog()
            host.layoutSubtreeIfNeeded()
        }
        // A reply streaming in: a chunk a second, a second of frames each.
        var frames: [Double] = []
        var now = 1.0
        for chunk in 0..<3 {
            turns.append(ConversationTurn(id: "reply", fromYou: false, text: String(repeating: "streamed words, and more words. ", count: 20 * (chunk + 1))))
            state.update(turns: turns, now: now)
            for _ in 0..<120 {
                now += 1.0 / 120
                frames.append(ms {
                    state.step(dt: 1.0 / 120, now: now, reduceMotion: false)
                    host.rootView = fog()
                    host.layoutSubtreeIfNeeded()
                })
            }
        }
        func summary(_ times: [Double]) -> String {
            let sorted = times.sorted()
            return "mean \(String(format: "%.2f", times.reduce(0, +) / Double(times.count))) ms, p95 \(String(format: "%.2f", sorted[sorted.count * 95 / 100])) ms, max \(String(format: "%.2f", sorted.last!)) ms"
        }
        print("fog text cost: first layout \(String(format: "%.1f", first)) ms; typing \(summary(typing)); draft replaced \(String(format: "%.1f", replaced)) ms; streaming frames \(summary(frames))")
        // A Mac's debug build: first layout about 190 ms, frames about 7 ms. CI's shared virtual Macs ran the same work
        // up to ten times slower (a 2.2 s first layout, 44 ms typing), so there the budgets only catch a hang, like
        // the #210 freeze that took seconds per keystroke.
        let slack = ProcessInfo.processInfo.environment["CI"] == nil ? 1.0 : 10.0
        XCTAssertLessThan(first, 2000 * slack)
        XCTAssertLessThan(replaced, 500 * slack)
        XCTAssertLessThan(typing.reduce(0, +) / Double(typing.count), 16 * slack)
        XCTAssertLessThan(frames.reduce(0, +) / Double(frames.count), 16 * slack)
    }

    // MARK: Helpers

    static func turns(_ count: Int) -> [ConversationTurn] {
        (0..<count).map { ConversationTurn(id: "\($0)", fromYou: $0 % 2 == 0, text: "Turn \($0): " + String(repeating: "a few words in a line ", count: 1 + $0 % 7)) }
    }

    static func textView(in view: NSView) -> NSTextView? {
        if let text = view as? NSTextView { return text }
        for subview in view.subviews { if let text = textView(in: subview) { return text } }
        return nil
    }

    /// The bounding box of pixels with any real ink in `rect` (top left, points at scale 1).
    static func ink(_ image: CGImage, in rect: CGRect) -> CGRect? {
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        pixels.withUnsafeMutableBytes { buffer in
            let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        var box: CGRect?
        for y in max(0, Int(rect.minY))..<min(height, Int(rect.maxY)) {
            for x in max(0, Int(rect.minX))..<min(width, Int(rect.maxX)) where pixels[(y * width + x) * 4 + 3] > 40 {
                box = (box ?? CGRect(x: x, y: y, width: 1, height: 1)).union(CGRect(x: x, y: y, width: 1, height: 1))
            }
        }
        return box
    }
}
