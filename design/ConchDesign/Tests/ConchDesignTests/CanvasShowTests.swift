import CoreGraphics
import XCTest
@testable import ConchDesign

/// Show's storyboard: which moments of a recording are looked at, which frames are kept, and the words an agent is sent.
final class CanvasShowTests: XCTestCase {
    private typealias Moment = CanvasStoryboard.Moment

    private func mark(_ kind: CanvasMark.Kind, _ x: Double, _ y: Double, text: String? = nil) -> CanvasMark {
        CanvasMark(kind: kind, points: [CanvasPoint(x: x, y: y), CanvasPoint(x: x + 0.1, y: y + 0.1)], text: text, id: "\(kind)-\(x)")
    }

    /// Each moment's time, and what it is for.
    private func summary(_ moments: [Moment]) -> [String] {
        moments.map { moment in
            let at = String(format: "%.2f", moment.at)
            switch moment.kind {
            case let .marks(marks): return "\(at) marks×\(marks.count)"
            case .look: return "\(at) look"
            case .said: return "\(at) said"
            case .end: return "\(at) end"
            }
        }
    }

    // MARK: Moments

    func testMomentsAreJustAfterEachBurstOfMarksEveryThreeSecondsElseAndTheEnd() {
        let ends = [(at: 7.0, mark: mark(.box, 0.5, 0.5)), (at: 2.0, mark: mark(.pen, 0.1, 0.1)), (at: 2.4, mark: mark(.arrow, 0.2, 0.2))]
        // 2.0 and 2.4 are one burst, taken after the last of them; the look at 3.1 is too near it, the one at 6.1 isn't.
        XCTAssertEqual(summary(CanvasStoryboard.moments(ends: ends, length: 12)), [
            "0.10 look", "2.70 marks×2", "6.10 look", "7.30 marks×1", "9.10 look", "11.95 end",
        ])
    }

    func testAMarkFinishedAtTheVeryEndIsTakenAtTheLastFrameAndTheEndStaysLast() {
        let moments = CanvasStoryboard.moments(ends: [(at: 4.9, mark: mark(.pen, 0.1, 0.1))], length: 5)
        XCTAssertEqual(summary(moments), ["0.10 look", "3.10 look", "4.95 marks×1", "4.95 end"])
    }

    func testAMomentaryRecordingIsItsLastFrame() {
        XCTAssertEqual(summary(CanvasStoryboard.moments(ends: [], length: 0.6)), ["0.55 end"])
    }

    // MARK: Narration

    private typealias Said = CanvasStoryboard.Said

    func testNarrationIsLookedAtWhereEachThingSaidEndsAndInTheMiddleOfEachPause() {
        let said = [
            Said(start: 4.5, end: 6.0, text: "and this footer"),
            Said(start: 0.4, end: 1.9, text: "okay so this page"),
            // 0.3 s after the last: a breath, not a pause.
            Said(start: 2.2, end: 3.0, text: "this one, bigger"),
        ]
        // 3.0 to 4.5 is a pause of 1.5 s, looked at in its middle.
        XCTAssertEqual(CanvasStoryboard.moments(of: said), [1.9, 3.0, 3.75, 6.0])
        XCTAssertEqual(CanvasStoryboard.moments(of: [Said(start: 1, end: 2, text: "a"), Said(start: 2.7, end: 3, text: "b")]), [2, 2.35, 3])
        XCTAssertEqual(CanvasStoryboard.moments(of: []), [])
    }

    func testNarrationMomentsJoinTheMarksAndTheLooksAvoidThem() {
        let ends = [(at: 7.0, mark: mark(.box, 0.5, 0.5))]
        // 7.1 is the burst's (7.3) already; 30 is past the end. The looks at 3.1 and 6.1 give way to what was said there.
        XCTAssertEqual(summary(CanvasStoryboard.moments(ends: ends, said: [1.9, 3.0, 3.75, 6.0, 7.1, 30], length: 12)), [
            "0.10 look", "1.90 said", "3.00 said", "3.75 said", "6.00 said", "7.30 marks×1", "9.10 look", "11.95 end",
        ])
        // Without narration, as before.
        XCTAssertEqual(summary(CanvasStoryboard.moments(ends: ends, length: 12)), summary(CanvasStoryboard.moments(ends: ends, said: [], length: 12)))
    }

    // MARK: Near-duplicates

    /// A grey screen, 320 × 180, with `noise` added to every other pixel and a black box over `box` of it (0 to 1).
    private func screen(noise: UInt8 = 0, box: CGRect? = nil) -> CGImage {
        let width = 320, height = 180
        var pixels = [UInt8](repeating: 128, count: width * height)
        for index in pixels.indices where index % 2 == 0 { pixels[index] &+= noise }
        if let box {
            for y in Int(box.minY * CGFloat(height))..<Int(box.maxY * CGFloat(height)) {
                for x in Int(box.minX * CGFloat(width))..<Int(box.maxX * CGFloat(width)) { pixels[y * width + x] = 0 }
            }
        }
        return pixels.withUnsafeMutableBytes { buffer in
            CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!.makeImage()!
        }
    }

    func testChangeIsTheShareOfTheScreenThatMoved() {
        let plain = CanvasStoryboard.thumbprint(screen())
        XCTAssertEqual(CanvasStoryboard.change(plain, plain), 0)
        // A flicker is no change.
        XCTAssertEqual(CanvasStoryboard.change(plain, CanvasStoryboard.thumbprint(screen(noise: 6))), 0)
        // A box over a quarter of the screen is about a quarter of it.
        let boxed = CanvasStoryboard.change(plain, CanvasStoryboard.thumbprint(screen(box: CGRect(x: 0, y: 0, width: 0.5, height: 0.5))))
        XCTAssertEqual(boxed, 0.25, accuracy: 0.03)
        // Thumbprints that can't be compared are all change.
        XCTAssertEqual(CanvasStoryboard.change(plain, []), 1)
    }

    func testALookOrTheEndOnlyStaysIfTheScreenChangedButMarksAlwaysDo() {
        let plain = CanvasStoryboard.thumbprint(screen())
        let flicker = CanvasStoryboard.thumbprint(screen(noise: 6))
        let boxed = CanvasStoryboard.thumbprint(screen(box: CGRect(x: 0.2, y: 0.2, width: 0.3, height: 0.3)))
        let moments = [
            Moment(at: 0.1, kind: .look),
            Moment(at: 3.1, kind: .look),
            Moment(at: 4.3, kind: .marks([mark(.pen, 0.1, 0.1)])),
            Moment(at: 6.1, kind: .look),
            Moment(at: 9.1, kind: .look),
            Moment(at: 11.95, kind: .end),
        ]
        let kept = CanvasStoryboard.keep(moments, prints: [plain, flicker, flicker, boxed, boxed, boxed])
        // The flicker at 3.1 is the start again; the mark stays though nothing moved (a thin stroke hardly does); the box
        // at 6.1 is new, and 9.1 and the end are it again.
        XCTAssertEqual(kept.map(\.at), [0.1, 4.3, 6.1])
    }

    func testOverADozenTheLeastChangedLooksGoFirstThenMarksAndTheLastFrameStays() {
        // Twenty looks, each changing more of the screen than the one before; four marks over the last; the end.
        var moments: [Moment] = [], prints: [[UInt8]] = []
        var cells = [UInt8](repeating: 0, count: 4096), filled = 0
        for index in 0..<20 {
            for cell in filled..<filled + 20 + 10 * index { cells[cell] = 255 }
            filled += 20 + 10 * index
            moments.append(Moment(at: Double(index), kind: .look))
            prints.append(cells)
        }
        for index in 0..<4 {
            moments.append(Moment(at: 20.5 + Double(index), kind: .marks([mark(.pen, 0.1 * Double(index), 0.1)])))
            prints.append(cells)
        }
        // The end changed least of all, but is the last frame.
        moments.append(Moment(at: 30, kind: .end))
        var last = cells
        for cell in 0..<10 { last[cell] = 0 }
        prints.append(last)
        let kept = CanvasStoryboard.keep(moments, prints: prints)
        XCTAssertEqual(kept.count, CanvasStoryboard.most)
        XCTAssertEqual(kept.filter { if case .marks = $0.kind { return true } else { return false } }.count, 4)
        XCTAssertEqual(kept.last?.kind, .end)
        // The first look is all new; of the rest, the six that changed most.
        XCTAssertEqual(kept.filter { $0.kind == .look }.map(\.at), [0, 14, 15, 16, 17, 18, 19])
    }

    func testWhereHeSpokeIsKeptOnlyIfTheScreenChangedAndOverADozenOutlastsTheLooks() {
        // A look, then alternately a look that changes much of the screen and where he spoke, changing a little; the end.
        var moments: [Moment] = [], prints: [[UInt8]] = []
        var cells = [UInt8](repeating: 0, count: 4096), filled = 0
        func change(_ count: Int) {
            for cell in filled..<filled + count { cells[cell] = 255 }
            filled += count
        }
        for index in 0..<12 {
            let spoke = index % 2 == 1
            change(spoke ? 20 : 200)
            moments.append(Moment(at: Double(index), kind: spoke ? .said : .look))
            prints.append(cells)
        }
        // Where he spoke over a screen that didn't move is the frame before it, and is dropped.
        moments.append(Moment(at: 12, kind: .said))
        prints.append(cells)
        change(20)
        moments.append(Moment(at: 13, kind: .end))
        prints.append(cells)
        let kept = CanvasStoryboard.keep(moments, prints: prints)
        XCTAssertFalse(kept.map(\.at).contains(12))
        XCTAssertEqual(kept.count, CanvasStoryboard.most)
        // Thirteen changed; the one to go is a look, though it changed ten times more than where he spoke.
        XCTAssertEqual(kept.filter { $0.kind == .said }.count, 6)
        XCTAssertEqual(kept.filter { $0.kind == .look }.map(\.at), [0, 4, 6, 8, 10])
        XCTAssertEqual(kept.last?.kind, .end)
    }

    // MARK: The words

    func testClockStampAndTheTimerCountingDownNearTheCap() {
        XCTAssertEqual(CanvasStoryboard.clock(0), "0:00")
        XCTAssertEqual(CanvasStoryboard.clock(83.7), "1:23")
        XCTAssertEqual(CanvasStoryboard.stamp(4.9), "[00:04]")
        XCTAssertEqual(CanvasStoryboard.stamp(75), "[01:15]")
        XCTAssertEqual(CanvasStoryboard.longest, 120)
        XCTAssertEqual(CanvasStoryboard.timer(23.4), "0:23")
        XCTAssertEqual(CanvasStoryboard.timer(104.9), "1:44")
        XCTAssertEqual(CanvasStoryboard.timer(105), "0:15 left")
        XCTAssertEqual(CanvasStoryboard.timer(119.2), "0:01 left")
        XCTAssertEqual(CanvasStoryboard.timer(130), "0:00 left")
    }

    private var frames: [(moment: Moment, name: String)] {
        [
            (Moment(at: 0.1, kind: .look), "frame-01.png"),
            (Moment(at: 4.3, kind: .marks([mark(.box, 0.5, 0.1), mark(.note, 0.6, 0.12, text: "make this\nbigger")])), "frame-02.png"),
            (Moment(at: 15.1, kind: .look), "frame-03.png"),
            (Moment(at: 23.55, kind: .end), "frame-04.png"),
        ]
    }

    func testTheStoryboardIsALineAFrame() {
        let text = CanvasStoryboard.storyboard(frames.map { ($0.moment, $0.name) }, about: "Arch brand page (http://localhost:3000)", length: 23.6)
        XCTAssertEqual(text, """
        # Tyler showed Arch brand page (http://localhost:3000) (0:23)

        A recording of his screen with his ink over it (his is orange). Agents can't watch video, so these are its frames: one just after each thing he marked, and one wherever the screen changed.

        [00:00] frame 01 — the start (frame-01.png)
        [00:04] frame 02 — box (55%,15%), note (60%,12%): "make this bigger" (frame-02.png)
        [00:15] frame 03 — the screen changed (frame-03.png)
        [00:23] frame 04 — the end (frame-04.png)

        The recording itself, for people: show.mp4

        """)
    }

    private let said = [
        Said(start: 0.5, end: 1.2, text: "okay so this page"),
        Said(start: 3.0, end: 4.1, text: "this one, bigger"),
        Said(start: 16.0, end: 17.5, text: "and this\nfooter"),
        Said(start: 22.0, end: 23.0, text: "that's it"),
    ]

    func testNarratedEachFrameHasTheWordsSaidNearestItAndTheWholeTranscriptFollows() {
        let text = CanvasStoryboard.storyboard(frames.map { ($0.moment, $0.name) }, said: said, about: "Safari", length: 23.6)
        XCTAssertEqual(text, """
        # Tyler showed Safari (0:23)

        A recording of his screen with his ink over it (his is orange), and what he said over it. Agents can't watch video, so these are its frames: one just after each thing he marked, where he finished saying something or paused, and wherever the screen changed; each with the words he said there.

        [00:00] frame 01 — "okay so this page" · the start (frame-01.png)
        [00:04] frame 02 — "this one, bigger" · box (55%,15%), note (60%,12%): "make this bigger" (frame-02.png)
        [00:15] frame 03 — "and this footer" · the screen changed (frame-03.png)
        [00:23] frame 04 — "that's it" · the end (frame-04.png)

        ## What he said

        [00:00] okay so this page
        [00:03] this one, bigger
        [00:16] and this footer
        [00:22] that's it

        The recording itself, for people: show.mp4

        """)
        // Every word on exactly one frame; two things said nearest one frame share its line, in order.
        XCTAssertEqual(CanvasStoryboard.words(said, at: [0.1, 23.55]), ["okay so this page this one, bigger", "and this footer that's it"])
        XCTAssertEqual(CanvasStoryboard.words([], at: [0.1, 4.3]), ["", ""])
        // Where he FINISHED: a long thought begun at the start goes with the picture he ended it on.
        XCTAssertEqual(CanvasStoryboard.words([Said(start: 1, end: 9, text: "a long thought")], at: [0.1, 10]), ["", "a long thought"])
    }

    func testANarratedPromptCarriesTheWordsOnEachFrameLine() {
        let canvas = CanvasDocument(anchor: CanvasAnchor(id: 7, frame: CGRect(x: 0, y: 0, width: 1000, height: 500)), id: "5B3F0D2E-9C41-4E7A-8F10-2D6B7A1C9E44")
        let lines = CanvasStoryboard.prompt(frames.map { ($0.moment, "/c/\($0.name)") }, said: said, about: "Safari", length: 23.6, storyboard: "/c/storyboard.md", video: "/c/show.mp4", canvas: canvas).split(separator: "\n").map(String.init)
        XCTAssertEqual(lines[2...5], [
            "[00:00] /c/frame-01.png — \"okay so this page\" · the start",
            "[00:04] /c/frame-02.png — \"this one, bigger\" · box (55%,15%), note (60%,12%): \"make this bigger\"",
            "[00:15] /c/frame-03.png — \"and this footer\" · the screen changed",
            "[00:23] /c/frame-04.png — \"that's it\" · the end",
        ])
    }

    func testThePromptSaysWhatWasShownThenTheStoryboardEachFrameTheVideoForPeopleAndHowToAnswerOnTheCanvas() {
        let canvas = CanvasDocument(anchor: CanvasAnchor(id: 7, frame: CGRect(x: 0, y: 0, width: 1000, height: 500)), id: "5B3F0D2E-9C41-4E7A-8F10-2D6B7A1C9E44")
        let text = CanvasStoryboard.prompt(frames.map { ($0.moment, "/c/\($0.name)") }, about: "Safari", length: 23.6, storyboard: "/c/storyboard.md", video: "/c/show.mp4", canvas: canvas)
        XCTAssertEqual(text, """
        [canvas] Tyler showed Safari (0:23).
        Storyboard: /c/storyboard.md
        [00:00] /c/frame-01.png — the start
        [00:04] /c/frame-02.png — box (55%,15%), note (60%,12%): "make this bigger"
        [00:15] /c/frame-03.png — the screen changed
        [00:23] /c/frame-04.png — the end
        The recording, for people (agents can't watch video): /c/show.mp4
        To mark your answer on this canvas, frame your marks {canvas: "5B3F0D2E-9C41-4E7A-8F10-2D6B7A1C9E44"}.
        """)
        // The same line the still ends with, so an agent answers either the same way.
        XCTAssertEqual(text.split(separator: "\n").last.map(String.init), CanvasPrompt.answer(canvas))
    }
}
