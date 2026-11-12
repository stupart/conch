import CoreGraphics
import ImageIO
import SwiftUI
import XCTest
@testable import ConchDesign

/// Not in conch's rows (2026-11-12), drawn offscreen and read back by pixel at the sidebar's width: a row is two lines
/// however long its name, its one button stays on the row (a long name fades, never pushes it off), and a row with
/// nothing to press draws no button.
///
/// `CONCH_SIDEBAR_RENDERS=<dir>` also writes each picture as a PNG at 2x, to look at.
@MainActor
final class SidebarOrganiseRenderTests: XCTestCase {
    private static let width: CGFloat = 248

    private let profile = ElsewhereAgent(id: "claude:4927", backend: "claude", pid: 4927, host: "tmux", reason: "profile",
        remedy: "add-account", label: "harbor-12", cwd: "/Users/t/Projects/Harbor", account: "~/.claude-work",
        conversationId: "5f1c2a7e-3b9d-4c60-9e21-7a8b4d6c0f13")

    private func render(_ view: some View, dark: Bool = false, name: String? = nil) throws -> Pixels {
        let content = view
            .frame(width: Self.width)
            .fixedSize(horizontal: false, vertical: true)
            .background(dark ? ConchColor.ground.dark.color : ConchColor.ground.light.color)
            .environment(\.colorScheme, dark ? .dark : .light)
        if let name, let directory = ProcessInfo.processInfo.environment["CONCH_SIDEBAR_RENDERS"] {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
            let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
            CGImageDestinationAddImage(destination, try XCTUnwrap(renderer.cgImage), nil)
            XCTAssertTrue(CGImageDestinationFinalize(destination))
        }
        let renderer = ImageRenderer(content: content)
        renderer.scale = 1
        return Pixels(try XCTUnwrap(renderer.cgImage))
    }

    struct Pixels {
        let width: Int
        let height: Int
        let bytes: [UInt8]

        init(_ image: CGImage) {
            width = image.width
            height = image.height
            var bytes = [UInt8](repeating: 0, count: width * height * 4)
            bytes.withUnsafeMutableBytes { buffer in
                let context = CGContext(
                    data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
                    bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                )!
                context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            }
            self.bytes = bytes
        }

        /// How many pixels in columns `columns` are the active blue: blue well above red and green.
        func blue(columns: Range<Int>) -> Int {
            var count = 0
            for y in 0..<height {
                for x in columns where x < width {
                    let offset = (y * width + x) * 4
                    let (r, g, b) = (Int(bytes[offset]), Int(bytes[offset + 1]), Int(bytes[offset + 2]))
                    if b > r + 80, b > g + 30 { count += 1 }
                }
            }
            return count
        }
    }

    func testARowIsTwoLinesAndItsButtonStaysOnItHoweverLongItsName() throws {
        let short = try render(ElsewhereRow(profile, onAction: {}), name: "elsewhere-row")
        let long = try render(ElsewhereRow(ElsewhereAgent(id: profile.id, backend: "claude", pid: 1, host: "iterm", reason: "profile",
            remedy: "resume", label: "A session whose name goes on far longer than any sidebar is wide",
            conversationId: profile.conversationId), onAction: {}), name: "elsewhere-row-long")
        XCTAssertEqual(short.height, long.height, "a long name is faded on its line, never wrapped")
        XCTAssertGreaterThanOrEqual(short.height, 30)
        XCTAssertLessThan(short.height, 46, "two lines, as a session row with a second line is")
        let rightEdge = (Int(Self.width) - 64)..<Int(Self.width)
        XCTAssertGreaterThan(short.blue(columns: rightEdge), 20, "the button is drawn at the row's end")
        XCTAssertGreaterThan(long.blue(columns: rightEdge), 20, "a long name doesn't push the button off the row")
    }

    func testARowWithNothingToPressHasNoButton() throws {
        let none = ElsewhereAgent(id: "claude:9", backend: "claude", pid: 9, host: "vscode", reason: "no-registry", remedy: "none")
        let picture = try render(ElsewhereRow(none, onAction: {}), name: "elsewhere-row-none")
        XCTAssertEqual(picture.blue(columns: 0..<Int(Self.width)), 0)
        // The phone's rows, which only show, have none either.
        XCTAssertEqual(try render(ElsewhereRow(profile)).blue(columns: 0..<Int(Self.width)), 0)
    }

    func testAMessageTakesTheSecondLineWithoutChangingTheRowsHeight() throws {
        let plain = try render(ElsewhereRow(profile, onAction: {}))
        let said = try render(ElsewhereRow(profile, message: "Resuming in conch…", onAction: {}), dark: true, name: "elsewhere-row-message-dark")
        XCTAssertEqual(plain.height, said.height)
    }
}
