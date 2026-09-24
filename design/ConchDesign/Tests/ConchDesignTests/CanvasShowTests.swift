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
