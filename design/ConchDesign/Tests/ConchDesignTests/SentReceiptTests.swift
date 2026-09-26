import XCTest
@testable import ConchDesign

/// A receipt of something Tyler sent through conch, as both apps read it off the wire: decoded tolerantly, since an
/// older daemon sends none and a newer one may send more, and matched to the bubble it replaces by the file it names.
final class SentReceiptTests: XCTestCase {
    private func decode(_ json: String) -> ConchSentReceipt? {
        try? JSONDecoder().decode(ConchSentReceipt.self, from: Data(json.utf8))
    }

    func testTheDaemonsShapeDecodes() {
        let receipt = decode("""
        {"kind":"canvas","title":"Marked up Invite page","detail":"2 marks · 1 note\\n“make this bigger”",
         "thumb":"/u/.cache/conch/canvas/A/flat.png","open":"/u/.cache/conch/canvas/A/flat.png"}
        """)
        XCTAssertEqual(receipt, ConchSentReceipt(
            kind: .canvas,
            title: "Marked up Invite page",
            detail: "2 marks · 1 note\n“make this bigger”",
            thumb: "/u/.cache/conch/canvas/A/flat.png",
            open: "/u/.cache/conch/canvas/A/flat.png"
        ))
    }

    /// A kind this build has never heard of is still a receipt; one with no title is not, and the row stays as it was.
    func testAnUnknownKindIsKeptAndATitlelessReceiptIsDropped() {
        XCTAssertEqual(decode(#"{"kind":"sketch","title":"Sketched it"}"#)?.kind, .unknown)
        XCTAssertNil(decode(#"{"kind":"canvas"}"#))
        XCTAssertNil(decode(#"{"kind":"canvas","title":""}"#))
        let bare = decode(#"{"kind":"video","title":"Sent a video · 0:42","detail":"","thumb":7}"#)
        XCTAssertEqual(bare?.title, "Sent a video · 0:42")
        XCTAssertNil(bare?.detail)
        XCTAssertNil(bare?.thumb)
    }

    /// The bubble a canvas's Send put up is its receipt's once the transcript has it: it names the same file.
    func testAPendingMessageIsTheReceiptThatNamesItsFile() {
        let flat = "/u/.cache/conch/canvas/A/flat.png"
        let receipt = ConchSentReceipt(kind: .canvas, title: "Marked up Safari", thumb: flat, open: flat)
        XCTAssertTrue(receipt.stands(for: "\(flat)\n[canvas] Tyler marked up Safari.\nTo mark your answer …"))
        XCTAssertFalse(receipt.stands(for: "/u/.cache/conch/canvas/B/flat.png\n[canvas] Tyler marked up Safari."))
        XCTAssertFalse(ConchSentReceipt(kind: .canvas, title: "Marked up Safari").stands(for: "anything at all"))
        let video = ConchSentReceipt(kind: .video, title: "Sent a video · 0:09", thumb: "/u/sheet.jpg", open: "/u/video.mp4")
        XCTAssertTrue(video.stands(for: "[video] Tyler sent a video…\nThe video itself, for people: /u/video.mp4"))
    }
}
