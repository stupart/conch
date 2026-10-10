import CoreGraphics
@testable import ConchDesign
import XCTest

/// A video sent from the phone, as an agent can read it: the Show's moments without ink, one contact sheet, and the
/// message in the Show's voice.
final class VideoStoryboardTests: XCTestCase {
    private typealias Said = CanvasStoryboard.Said

    func testMomentsAreTheShowsOwnRuleWithoutInk() {
        let said = [Said(start: 1, end: 2.4, text: "this button"), Said(start: 4, end: 5, text: "should be blue")]
        let moments = VideoStoryboard.moments(said: said, length: 9)
        XCTAssertEqual(moments, CanvasStoryboard.moments(ends: [], said: CanvasStoryboard.moments(of: said), length: 9))
        XCTAssertEqual(moments.last?.kind, .end)
        XCTAssertFalse(moments.contains { if case .marks = $0.kind { true } else { false } })
    }

    func testTheSheetIsAGridNoLongerThanTheLongEdge() throws {
        XCTAssertEqual(VideoStoryboard.grid(1).columns, 1)
        XCTAssertEqual(VideoStoryboard.grid(4).columns, 3)
        XCTAssertEqual(VideoStoryboard.grid(4).rows, 2)
        XCTAssertEqual(VideoStoryboard.grid(12).rows, 4)
        let phone = try XCTUnwrap(Self.frame(width: 720, height: 1280))
        let sheet = try XCTUnwrap(VideoStoryboard.contactSheet((0..<12).map { (at: Double($0) * 3, image: phone) }))
        XCTAssertLessThanOrEqual(max(sheet.width, sheet.height), Int(VideoStoryboard.longEdge))
        // Four rows of tall phone frames: taller than wide.
        XCTAssertGreaterThan(sheet.height, sheet.width)
        let wide = try XCTUnwrap(Self.frame(width: 1280, height: 720))
        let one = try XCTUnwrap(VideoStoryboard.contactSheet([(at: 0, image: wide)]))
        XCTAssertGreaterThan(one.width, one.height)
        XCTAssertNil(VideoStoryboard.contactSheet([]))
    }

    func testTheMessageReadsLikeAShows() {
        let frames = [
            CanvasStoryboard.Moment(at: 0.1, kind: .look),
            CanvasStoryboard.Moment(at: 2.4, kind: .said),
            CanvasStoryboard.Moment(at: 8.95, kind: .end),
        ]
        let said = [Said(start: 1, end: 2.4, text: "this button\nshould be blue")]
        let prompt = VideoStoryboard.prompt(frames, said: said, length: 9, sheet: "/u/sheet.jpg", video: "/u/video.mp4")
        XCTAssertEqual(prompt.split(separator: "\n").map(String.init), [
            "[video] Tyler sent a video from his phone (0:09).",
            "Contact sheet: /u/sheet.jpg — 3 frames, left to right and down, each stamped with its time:",
            "[00:00] frame 01 — the start",
            "[00:02] frame 02 — \"this button should be blue\" · the screen changed",
            "[00:08] frame 03 — the end",
            "What he said:",
            "[00:01] this button should be blue",
            "The video itself, for people (agents can't watch video): /u/video.mp4",
        ])
        // No sound: no "what he said", and nothing invented.
        XCTAssertFalse(VideoStoryboard.prompt(frames, said: [], length: 9, sheet: "s", video: "v").contains("What he said"))
    }

    /// A video dropped on the Mac's composer says so, and, longer than two minutes, how much of it the agent reads: its
    /// last frame is where the frames stop, not the end.
    func testTheMacsMessageSaysWhereItCameFromAndHowMuchWasRead() {
        let frames = [CanvasStoryboard.Moment(at: 0.1, kind: .look), CanvasStoryboard.Moment(at: 8.95, kind: .end)]
        let short = VideoStoryboard.prompt(frames, said: [], length: 9, sheet: "/u/mac-a.jpg", video: "/Users/t/Desktop/clip.mov", from: .mac)
        XCTAssertEqual(short.split(separator: "\n").map(String.init), [
            "[video] Tyler sent a video from his Mac (0:09).",
            "Contact sheet: /u/mac-a.jpg — 2 frames, left to right and down, each stamped with its time:",
            "[00:00] frame 01 — the start",
            "[00:08] frame 02 — the end",
            "The video itself, for people (agents can't watch video): /Users/t/Desktop/clip.mov",
        ])
        let cut = [CanvasStoryboard.Moment(at: 0.1, kind: .look), CanvasStoryboard.Moment(at: 119.95, kind: .end)]
        let long = VideoStoryboard.prompt(cut, said: [], length: 312.4, sheet: "/u/mac-b.jpg", video: "/v/talk.mp4", from: .mac)
        XCTAssertEqual(long.split(separator: "\n").map(String.init), [
            "[video] Tyler sent a video from his Mac (5:12). The frames and words below are its first 2:00.",
            "Contact sheet: /u/mac-b.jpg — 2 frames, left to right and down, each stamped with its time:",
            "[00:00] frame 01 — the start",
            "[01:59] frame 02 — where the frames stop",
            "The video itself, for people (agents can't watch video): /v/talk.mp4",
        ])
        // The phone's message is as it was: it never sends more than two minutes.
        XCTAssertTrue(VideoStoryboard.prompt(frames, said: [], length: 120.2, sheet: "s", video: "v").hasPrefix("[video] Tyler sent a video from his phone (2:00).\n"))
        XCTAssertFalse(VideoStoryboard.isCut(VideoStoryboard.longest))
        XCTAssertTrue(VideoStoryboard.isCut(VideoStoryboard.longest + 1))
    }

    private static func frame(width: Int, height: Int) -> CGImage? {
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        context?.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.9, alpha: 1))
        context?.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return context?.makeImage()
    }
}
