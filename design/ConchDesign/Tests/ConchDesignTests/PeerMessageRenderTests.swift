#if os(macOS)
import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// A message between sessions, drawn offscreen at 2x and read from its pixels: on the conversation's own ground, never
/// in the fill Tyler's own bubble wears; a heading that opens the other session when it is live; and a message that
/// never arrived says so in the attention colour.
///
/// `CONCH_PEER_RENDERS=<dir>` also writes each picture as a PNG, to look at.
@MainActor
final class PeerMessageRenderTests: XCTestCase {
    private static let scale: CGFloat = 2
    private static let width: CGFloat = 520

    private func render(_ view: some View, dark: Bool = false, name: String) throws -> CGImage {
        let content = view
            .frame(width: Self.width)
            .background(dark ? ConchColor.ground.dark.color : ConchColor.ground.light.color)
            .environment(\.colorScheme, dark ? .dark : .light)
            .environment(\.conchRendersStatically, true)
        let renderer = ImageRenderer(content: content)
        renderer.scale = Self.scale
        let image = try XCTUnwrap(renderer.cgImage)
        if let directory = ProcessInfo.processInfo.environment["CONCH_PEER_RENDERS"] {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
            let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
            CGImageDestinationAddImage(destination, image, nil)
            XCTAssertTrue(CGImageDestinationFinalize(destination))
        }
        return image
    }

    private func pixels(_ image: CGImage) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        bytes.withUnsafeMutableBytes { buffer in
            let context = CGContext(
                data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
                bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )!
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        return bytes
    }

    private func color(_ bytes: [UInt8], _ image: CGImage, x: Int, y: Int) -> (Int, Int, Int) {
        let offset = (y * image.width + x) * 4
        return (Int(bytes[offset]), Int(bytes[offset + 1]), Int(bytes[offset + 2]))
    }

    private func rgb(_ token: ConchRGBA) -> (Int, Int, Int) {
        (Int(token.hex >> 16 & 0xFF), Int(token.hex >> 8 & 0xFF), Int(token.hex & 0xFF))
    }

    private let at = Date(timeIntervalSince1970: 1_794_700_000)
    private let received = ConchPeerMessage(direction: .received, name: "harbor", session: "row-harbor", label: "harbor", pid: 4242, msgId: "m-1")

    func testAReceivedMessageIsOnTheConversationsGroundNotInTylersFill() throws {
        for dark in [false, true] {
            let image = try render(PeerMessageRow(message: received, body: "Is port 5173 free on your side?", at: at, open: {}), dark: dark, name: "peer-received")
            XCTAssertGreaterThan(image.height, Int(40 * Self.scale))
            let bytes = pixels(image)
            let ground = dark ? ConchColor.ground.dark : ConchColor.ground.light
            // Inside the outline, in the padding left of the words: the ground, not a bubble's fill.
            let inside = color(bytes, image, x: Int(6 * Self.scale), y: image.height / 2)
            let expected = rgb(ground)
            XCTAssertEqual(inside.0, expected.0, accuracy: 3, "dark: \(dark)")
            XCTAssertEqual(inside.1, expected.1, accuracy: 3, "dark: \(dark)")
            XCTAssertEqual(inside.2, expected.2, accuracy: 3, "dark: \(dark)")
            // The outline is drawn at its left edge.
            let edge = color(bytes, image, x: 0, y: image.height / 2)
            XCTAssertNotEqual(edge.0 + edge.1 + edge.2, expected.0 + expected.1 + expected.2, "dark: \(dark)")
        }
    }

    func testAMessageThatNeverArrivedSaysSoInTheAttentionColour() throws {
        let failed = ConchPeerMessage(direction: .sent, name: "tidepool", delivery: .failed, deliveryNote: "no agent named 'tidepool' is reachable.")
        let delivered = ConchPeerMessage(direction: .sent, name: "lantern", viaConch: true, msgId: "1a2b3c4d5e6f", delivery: .sent)
        let attention = ConchColor.attention.light
        let target = rgb(attention)
        func reds(_ image: CGImage) -> Int {
            let bytes = pixels(image)
            var count = 0
            for index in stride(from: 0, to: bytes.count, by: 4)
            where abs(Int(bytes[index]) - target.0) < 12 && abs(Int(bytes[index + 1]) - target.1) < 12 && abs(Int(bytes[index + 2]) - target.2) < 12 {
                count += 1
            }
            return count
        }
        XCTAssertGreaterThan(reds(try render(PeerMessageRow(message: failed, body: "Are you there?", at: at), name: "peer-sent-failed")), 20)
        XCTAssertEqual(reds(try render(PeerMessageRow(message: delivered, body: "Your review is in: two nits.", at: at), name: "peer-sent-delivered")), 0)
    }

    func testAllRowsRenderInBothSchemes() throws {
        let rows: [(ConchPeerMessage, String)] = [
            (ConchPeerMessage(direction: .received, name: "general-purpose", agentId: "a0123456789abcdef", queued: true), "Done: the flaky test was a timing race."),
            (ConchPeerMessage(direction: .received, name: "lantern", viaConch: true, session: "s", msgId: "5e0f3a2b9c71", replyTo: "000000000001"), "**Reviewed.** Two nits:\n\n- rename `x`\n- drop `y`"),
            (ConchPeerMessage(direction: .sent, name: "harbor", summary: "Ask about the port", delivery: .unread), "Is port 5173 free on your side?"),
            (ConchPeerMessage(direction: .sent, name: "uds:/tmp/cc-socks/5151.sock", delivery: .held), "Please pause the migration."),
        ]
        for (index, row) in rows.enumerated() {
            for dark in [false, true] {
                let image = try render(PeerMessageRow(message: row.0, body: row.1, at: at), dark: dark, name: "peer-row-\(index)")
                XCTAssertGreaterThan(image.height, Int(40 * Self.scale))
            }
        }
    }
}
#endif
