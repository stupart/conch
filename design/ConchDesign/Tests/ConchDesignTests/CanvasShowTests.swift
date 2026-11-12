import CoreGraphics
import XCTest
@testable import ConchDesign

/// A recording's storyboard (a video's, as the Show's was): which moments are looked at, which frames are kept, and what
/// each frame's line says.
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

    func testClockAndStamp() {
        XCTAssertEqual(CanvasStoryboard.clock(0), "0:00")
        XCTAssertEqual(CanvasStoryboard.clock(83.7), "1:23")
        XCTAssertEqual(CanvasStoryboard.stamp(4.9), "[00:04]")
        XCTAssertEqual(CanvasStoryboard.stamp(75), "[01:15]")
        XCTAssertEqual(CanvasStoryboard.longest, 120)
    }

    /// What happened at a frame, as a video's prompt says it (`VideoStoryboard.prompt`): the start, a change, the end, or
    /// the marks finished there, each where it is and a note with its words on one line.
    func testACaptionSaysWhatHappenedAtAFrame() {
        XCTAssertEqual(CanvasStoryboard.caption(Moment(at: 0.1, kind: .look), first: true), "the start")
        XCTAssertEqual(CanvasStoryboard.caption(Moment(at: 15.1, kind: .look), first: false), "the screen changed")
        XCTAssertEqual(CanvasStoryboard.caption(Moment(at: 6, kind: .said), first: false), "the screen changed")
        XCTAssertEqual(CanvasStoryboard.caption(Moment(at: 23.55, kind: .end), first: false), "the end")
        XCTAssertEqual(CanvasStoryboard.caption(Moment(at: 0.55, kind: .end), first: true), "the screen")
        let marks = Moment(at: 4.3, kind: .marks([mark(.box, 0.5, 0.1), mark(.note, 0.6, 0.12, text: "make this\nbigger")]))
        XCTAssertEqual(CanvasStoryboard.caption(marks, first: false), "box (55%,15%), note (60%,12%): \"make this bigger\"")
    }
}
