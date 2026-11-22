import CoreGraphics
import ImageIO
import SwiftUI
import XCTest
@testable import ConchDesign

/// The Mac sidebar's rows with a working agent's activity line (2026-10-03), drawn offscreen and read back by pixel: the
/// line sits under the name without moving it and stays one line however long it is.
///
/// conch-mac has no XCTest target, so `SidebarRow` below is the Mac's `DashboardRow` layout rebuilt from the pieces it
/// draws with: the 10 pt rail, the 16 pt mark centred on the name's line, the name in `TailFadeText` at 13 pt, and the
/// second line in `SidebarSecondLine` at 11 pt with the row's 5 pt of air. `Pixels` is shared with TeamsRenderTests.
///
/// `CONCH_SIDEBAR_RENDERS=<dir>` also writes each picture as a PNG at 2x, to look at.
@MainActor
final class SidebarActivityRenderTests: XCTestCase {
    /// One row's status mark, as `LedgerVisual` draws it.
    struct Mark {
        let symbol: String
        let size: CGFloat
        let color: ConchColorToken
        static let working = Mark(symbol: "circle.fill", size: 8, color: ConchColor.active)
    }

    struct SidebarRow: View {
        let name: String
        let mark: Mark
        var semibold = false
        var line: SidebarRowText.SecondLine?

        var body: some View {
            HStack(alignment: .nameLine, spacing: 8) {
                Color.clear.frame(width: 10, height: 22)
                Image(systemName: mark.symbol)
                    .font(.system(size: mark.size, weight: .medium))
                    .foregroundStyle(mark.color)
                    .frame(width: 16, height: 16)
                VStack(alignment: .leading, spacing: 2) {
                    TailFadeText(name)
                        .font(.system(size: 13, weight: semibold ? .semibold : .regular))
                        .foregroundStyle(ConchColor.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .alignmentGuide(.nameLine) { $0[VerticalAlignment.center] }
                    if let line {
                        SidebarSecondLine(line, font: .system(size: 11))
                    }
                }
            }
            .padding(.trailing, 4)
            .padding(.vertical, line == nil ? 0 : 5)
            .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
        }
    }

    private static let width: CGFloat = 248

    private func activity(_ text: String) -> SidebarRowText.SecondLine {
        SidebarRowText.secondLine(message: nil, blockedOn: nil, activity: SidebarActivity.line(text, working: true), startedBy: nil)!
    }

    /// `view` drawn at 1x on the sidebar's ground, `width` wide and as tall as it wants; and at 2x to disk when asked.
    private func render(_ view: some View, dark: Bool = false, name: String? = nil) throws -> Pixels {
        let content = view
            .frame(width: Self.width)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 8)
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

    struct Pixels: Equatable {
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

        /// Rows `range` from the top, as bytes, for comparing one band of two pictures.
        func band(_ range: Range<Int>) -> ArraySlice<UInt8> {
            bytes[(range.lowerBound * width * 4)..<(range.upperBound * width * 4)]
        }

        /// Rows `range` are the same picture in both, but for anti-aliasing, which can differ by a level or two from one
        /// render to the next.
        func sameBand(_ range: Range<Int>, as other: Pixels) -> Bool {
            let mine = band(range), theirs = other.band(range)
            return mine.count == theirs.count && !zip(mine, theirs).contains { abs(Int($0) - Int($1)) > 8 }
        }

        /// The darkest luma in rows `range` (light ground), 0…255.
        func darkest(_ range: Range<Int>) -> Int {
            var darkest = 255
            for y in range {
                for x in 0..<width {
                    let offset = (y * width + x) * 4
                    let luma = (Int(bytes[offset]) * 299 + Int(bytes[offset + 1]) * 587 + Int(bytes[offset + 2]) * 114) / 1000
                    darkest = min(darkest, luma)
                }
            }
            return darkest
        }

        /// Whether rows `range` hold anything but the ground.
        func inked(_ range: Range<Int>, ground: Int) -> Bool {
            darkest(range) < ground - 24
        }
    }

    // MARK: - The line

    /// The first line never moves as the activity changes: the band holding the mark and the name is the same picture,
    /// pixel for pixel, whatever the second line says, however long.
    func testTheNameLineDoesNotMoveAsTheActivityChanges() throws {
        let lines = [
            "Running the test suite",
            "Editing src/voice-loop.ts",
            "I'll downscale it into the iOS fixtures folder, write the fixture and then photograph both apps",
        ]
        let pictures = try lines.map { try render(SidebarRow(name: "Live activity line in sidebar", mark: .working, line: activity($0))) }
        XCTAssertEqual(Set(pictures.map(\.height)).count, 1, "a long line is cut, never wrapped: every row is one height")
        let nameBand = 0..<22
        for picture in pictures.dropFirst() {
            XCTAssertTrue(picture.sameBand(nameBand, as: pictures[0]), "the name's line is untouched by the activity")
        }
    }
}

private extension VerticalAlignment {
    /// The Mac row's `.nameLine`: the middle of the name's line, which the mark centres on.
    enum NameLine: AlignmentID {
        static func defaultValue(in dimensions: ViewDimensions) -> CGFloat { dimensions[VerticalAlignment.center] }
    }

    static let nameLine = VerticalAlignment(NameLine.self)
}
