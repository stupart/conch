import CoreGraphics
@testable import ConchDesign
import XCTest

/// A video sent from the phone, as an agent can read it: the Show's moments without ink or words, one contact sheet,
/// and the message in the Show's voice.
final class VideoStoryboardTests: XCTestCase {
    func testMomentsAreTheShowsOwnRuleWithoutInkOrWords() {
        let moments = VideoStoryboard.moments(length: 9)
        XCTAssertEqual(moments, CanvasStoryboard.moments(ends: [], length: 9))
        // Every three seconds, then the end: nothing said chooses a frame (2026-11-12).
        XCTAssertEqual(moments.map { ($0.at * 100).rounded() }, [10, 310, 610, 895])
        XCTAssertEqual(moments.map(\.kind), [.look, .look, .look, .end])
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

    /// Each frame stamped with its time, its sound said not to be sent (an agent told nothing would take a video of someone
    /// talking for a silent one), and a Mac video longer than two minutes says the frames stop before its end.
    func testTheMessageStampsEachFrameAndSaysWhereTheFramesStop() {
        let frames = [
            CanvasStoryboard.Moment(at: 0.1, kind: .look),
            CanvasStoryboard.Moment(at: 3.1, kind: .look),
            CanvasStoryboard.Moment(at: 8.95, kind: .end),
        ]
        let lines = VideoStoryboard.prompt(frames, length: 9, sheet: "/u/sheet.jpg", video: "/u/video.mp4").split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.filter { $0.hasPrefix("[00:") }, ["[00:00] frame 01 — the start", "[00:03] frame 02 — the screen changed", "[00:08] frame 03 — the end"])
        XCTAssertTrue(lines.contains { $0.contains("/u/sheet.jpg") })
        XCTAssertTrue(lines.contains { $0.contains("not its sound") })
        XCTAssertTrue(lines.last?.hasSuffix("/u/video.mp4") == true)
        let cut = [CanvasStoryboard.Moment(at: 0.1, kind: .look), CanvasStoryboard.Moment(at: 119.95, kind: .end)]
        let long = VideoStoryboard.prompt(cut, length: 312.4, sheet: "/u/mac-b.jpg", video: "/v/talk.mp4", from: .mac)
        XCTAssertTrue(long.contains("(5:12). The frames below are its first 2:00."), long)
        XCTAssertTrue(long.contains("[01:59] frame 02 — where the frames stop"), long)
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
