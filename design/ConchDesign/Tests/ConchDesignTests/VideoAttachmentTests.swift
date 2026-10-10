@testable import ConchDesign
import XCTest

/// A video on the Mac's composer (`VideoAttachment`): which attachments are videos, the message they make, and when the
/// composer can send.
final class VideoAttachmentTests: XCTestCase {
    private let brief = VideoAttachment.Brief(
        frames: [CanvasStoryboard.Moment(at: 0.1, kind: .look), CanvasStoryboard.Moment(at: 3.95, kind: .end)],
        said: [CanvasStoryboard.Said(start: 0.5, end: 1.5, text: "watch this")],
        length: 4,
        sheet: "/c/uploads/mac-1.jpg"
    )

    func testAVideoIsAnyMovieByItsTypeOrItsName() {
        for name in ["clip.mov", "CLIP.MOV", "Screen Recording 2026-10-11 at 1.12.58\u{202F}AM.mov", "a.mp4", "b.m4v", "c.avi"] {
            XCTAssertTrue(VideoAttachment.isVideo(URL(fileURLWithPath: "/nowhere/\(name)")), name)
        }
        for name in ["shot.png", "loop.gif", "voice.mp3", "notes.pdf", "plain"] {
            XCTAssertFalse(VideoAttachment.isVideo(URL(fileURLWithPath: "/nowhere/\(name)")), name)
        }
    }

    func testTheMessageIsPathsThenVideosThenWords() {
        let picture = URL(fileURLWithPath: "/Users/t/Desktop/shot.png")
        let video = URL(fileURLWithPath: "/Users/t/Desktop/clip.mov")
        let message = VideoAttachment.message(text: "  what broke?\n", attachments: [video, picture]) { $0 == video ? self.brief.block(video: $0.path) : nil }
        let lines = message.split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.first, picture.path)
        XCTAssertEqual(lines[1], "[video] Tyler sent a video from his Mac (0:04).")
        XCTAssertEqual(lines.last, "what broke?")
        XCTAssertTrue(message.contains("The video itself, for people (agents can't watch video): \(video.path)\nwhat broke?"))
        // No words, no trailing line; no attachments, the words alone.
        XCTAssertTrue(VideoAttachment.message(text: "", attachments: [video]) { _ in "BLOCK" } == "BLOCK")
        XCTAssertEqual(VideoAttachment.message(text: " hi ", attachments: []) { _ in nil }, "hi")
        XCTAssertEqual(VideoAttachment.message(text: "", attachments: []) { _ in nil }, "")
    }

    func testItSendsOnlyOnceEveryVideoIsReady() {
        XCTAssertNil(VideoAttachment.readiness([]))
        XCTAssertNil(VideoAttachment.readiness([.ready(brief), .ready(brief)]))
        XCTAssertEqual(VideoAttachment.readiness([.ready(brief), .preparing]), "Getting the video ready for the agent…")
        XCTAssertEqual(VideoAttachment.readiness([nil]), "Getting the video ready for the agent…")
        XCTAssertEqual(VideoAttachment.readiness([.preparing, .failed("no video in it")]), "Remove the video conch couldn't read to send")
    }

    func testItsTileSaysHowLongAndHowMuchIsRead() {
        XCTAssertEqual(VideoAttachment.caption(length: 42), "0:42")
        XCTAssertEqual(VideoAttachment.caption(length: 312), "first 2:00 of 5:12")
    }
}
