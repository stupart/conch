import XCTest
@testable import ConchDesign

/// A message between agent sessions (2026-11-12), as the daemon publishes it and as the record store keeps it.
final class PeerMessageTests: XCTestCase {
    private func decode(_ json: String) -> ConchPeerMessage? {
        try? JSONDecoder().decode(ConchPeerMessage.self, from: Data(json.utf8))
    }

    func testTheDaemonsShapesDecode() {
        XCTAssertEqual(
            decode(#"{"direction":"received","name":"harbor","via":"claude","pid":4242,"msgId":"m-1","session":"row-harbor","label":"Harbor"}"#),
            ConchPeerMessage(direction: .received, name: "harbor", session: "row-harbor", label: "Harbor", pid: 4242, msgId: "m-1")
        )
        XCTAssertEqual(
            decode(#"{"direction":"sent","name":"lantern","via":"conch","replyTo":"0a1b2c3d4e5f","delivery":"failed","deliveryNote":"no agent named 'lantern' is reachable.","summary":"Ask"}"#),
            ConchPeerMessage(direction: .sent, name: "lantern", viaConch: true, replyTo: "0a1b2c3d4e5f", summary: "Ask", delivery: .failed, deliveryNote: "no agent named 'lantern' is reachable.")
        )
        XCTAssertEqual(decode(#"{"direction":"received","name":"harbor","via":"claude","queued":true}"#)?.queued, true)
    }

    func testANamelessOrDirectionlessOneIsDroppedAndAnUnknownDeliveryIsNoWord() {
        XCTAssertNil(decode(#"{"direction":"received","name":""}"#))
        XCTAssertNil(decode(#"{"direction":"sideways","name":"harbor"}"#))
        XCTAssertNil(decode(#"{"name":"harbor"}"#))
        let newer = decode(#"{"direction":"sent","name":"harbor","delivery":"teleported"}"#)
        XCTAssertNotNil(newer)
        XCTAssertNil(newer?.delivery)
        XCTAssertNil(newer?.deliveryWords)
    }

    func testTheOtherEndIsNamedByTheLiveRowFirst() {
        let message = ConchPeerMessage(direction: .received, name: "harbor", label: "Harbor (renamed)")
        XCTAssertEqual(message.shownName(), "Harbor (renamed)")
        XCTAssertEqual(message.shownName(live: "Harbor today"), "Harbor today")
        XCTAssertEqual(message.heading(), "From Harbor (renamed)")
        XCTAssertEqual(ConchPeerMessage(direction: .received, name: "harbor").heading(), "From harbor")
        XCTAssertEqual(ConchPeerMessage(direction: .sent, name: "lantern").heading(), "Sent to lantern")
        // Claude Code's socket address is not a name anyone reads.
        XCTAssertEqual(ConchPeerMessage(direction: .sent, name: "uds:/tmp/cc-socks/5151.sock").shownName(), "another Claude session")
    }

    func testHowFarASentOneGotAndWhichOnesNeverArrived() {
        let words = ConchPeerMessage.Delivery.allWords
        XCTAssertEqual(words, [
            "Delivered", "In its inbox, unread", "Queued until it's free",
            "Held there, not delivered", "Expired, not delivered", "Not sent",
        ])
        let failed = [ConchPeerMessage.Delivery.held, .expired, .failed]
        for delivery in [ConchPeerMessage.Delivery.sent, .unread, .queued, .held, .expired, .failed] {
            XCTAssertEqual(ConchPeerMessage(direction: .sent, name: "x", delivery: delivery).notDelivered, failed.contains(delivery))
        }
        // A received one has no delivery to speak of.
        XCTAssertNil(ConchPeerMessage(direction: .received, name: "x", delivery: .sent).deliveryWords)
        XCTAssertFalse(ConchPeerMessage(direction: .received, name: "x", delivery: .failed).notDelivered)
    }

    /// The tag `peerRecordText` writes, read back on both apps from a recorded `inter_agent` row.
    func testARecordedRowReadsBackAsTheMessageItKeeps() throws {
        let native = try XCTUnwrap(ConchPeerMessage.recorded("<cross-session-message from=\"uds:/tmp/cc-socks/4242.sock\" from-name=\"harbor\" via=\"claude\" msg-id=\"9b2f6e0c-1d3a-4c5e-8f70-a1b2c3d4e5f6\">\nIs port 5173 free on your side?\n</cross-session-message>"))
        XCTAssertEqual(native.body, "Is port 5173 free on your side?")
        XCTAssertEqual(native.peer, ConchPeerMessage(direction: .received, name: "harbor", pid: 4242, msgId: "9b2f6e0c-1d3a-4c5e-8f70-a1b2c3d4e5f6"))

        let conch = try XCTUnwrap(ConchPeerMessage.recorded("<cross-session-message from=\"conch:22222222-3333-4444-8555-666666666666\" from-name=\"say &quot;hi&quot; &amp; &lt;go&gt;\" via=\"conch\" msg-id=\"5e0f3a2b9c71\" reply-to=\"000000000001\">\nTwo lines\nof words\n</cross-session-message>"))
        XCTAssertEqual(conch.body, "Two lines\nof words")
        XCTAssertEqual(conch.peer, ConchPeerMessage(direction: .received, name: "say \"hi\" & <go>", viaConch: true, session: "22222222-3333-4444-8555-666666666666", msgId: "5e0f3a2b9c71", replyTo: "000000000001"))

        let agent = try XCTUnwrap(ConchPeerMessage.recorded("<cross-session-message from=\"a0123456789abcdef\" from-name=\"general-purpose\" via=\"claude\">\nDone.\n</cross-session-message>"))
        XCTAssertEqual(agent.peer.agentId, "a0123456789abcdef")
        XCTAssertEqual(agent.peer.name, "general-purpose")
    }

    func testAPreviewCutBeforeItsClosingTagStillReads() throws {
        let cut = try XCTUnwrap(ConchPeerMessage.recorded("<cross-session-message from=\"uds:/tmp/cc-socks/4242.sock\" from-name=\"harbor\" via=\"claude\">\nThe first two hundred characters of a long"))
        XCTAssertEqual(cut.body, "The first two hundred characters of a long")
        XCTAssertEqual(cut.peer.name, "harbor")
    }

    func testAnythingElseRecordedIsNotOne() {
        XCTAssertNil(ConchPeerMessage.recorded("Message Type: NEW_TASK\nSender: /root\nDo the thing."))
        XCTAssertNil(ConchPeerMessage.recorded("<cross-session-messages>nope</cross-session-messages>"))
        XCTAssertNil(ConchPeerMessage.recorded("plain words"))
        XCTAssertNil(ConchPeerMessage.recorded("<cross-session-message from-name=\"x\""))
    }
}

extension ConchPeerMessage.Delivery {
    static var allWords: [String] {
        [Self.sent, .unread, .queued, .held, .expired, .failed].compactMap {
            ConchPeerMessage(direction: .sent, name: "x", delivery: $0).deliveryWords
        }
    }
}
