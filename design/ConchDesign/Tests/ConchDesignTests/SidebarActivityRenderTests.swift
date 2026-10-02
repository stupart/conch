import CoreGraphics
import ImageIO
import SwiftUI
import XCTest
@testable import ConchDesign

/// The Mac sidebar's rows with a working agent's activity line (2026-10-03), drawn offscreen and read back by pixel: the
/// line sits under the name without moving it, stays one line however long it is, is fainter than the name, and an idle
/// row stays one line.
///
/// conch-mac has no XCTest target, so `SidebarRow` below is the Mac's `DashboardRow` layout rebuilt from the pieces it
/// draws with: the 10 pt rail, the 16 pt mark centred on the name's line, the name in `TailFadeText` at 13 pt, and the
/// second line in `SidebarSecondLine` at 11 pt with the row's 5 pt of air; the agent rows are `AgentGroup`'s. How the
/// Mac wires those pieces is pinned as source (test/live-activity-apps-source.test.ts).
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
        static let waiting = Mark(symbol: "circle.inset.filled", size: 8, color: ConchColor.ready)
        static let idle = Mark(symbol: "circle.dotted", size: 8, color: ConchColor.textTertiary)
        static let needs = Mark(symbol: "exclamationmark.circle.fill", size: 10.5, color: ConchColor.attention)
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

    /// `AgentGroup`'s agents under a session: a smaller mark and name, their line a size down past the mark.
    struct AgentRows: View {
        let agents: [(name: String, activity: String?)]

        var body: some View {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(agents, id: \.name) { agent in
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 7) {
                            Image(systemName: agent.activity == nil ? "circle" : "circle.fill")
                                .font(.system(size: 8, weight: .medium))
                                .foregroundStyle(agent.activity == nil ? ConchColor.textTertiary : ConchColor.active)
                                .scaleEffect(0.75)
                                .frame(width: 12, height: 12)
                            TailFadeText(agent.name, fade: 24)
                                .font(.system(size: 11.5))
                                .foregroundStyle(ConchColor.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if let activity = SidebarActivity.line(agent.activity, working: agent.activity != nil) {
                            SidebarSecondLine(SidebarRowText.SecondLine(text: activity, kind: .activity), font: .system(size: 10.5))
                                .padding(.leading, 19)
                        }
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                }
            }
            .padding(.leading, 30)
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

    func testAWorkingRowGrowsOneFaintLineUnderItsNameAndAnIdleRowStaysOneLine() throws {
        let idle = try render(SidebarRow(name: "seashell", mark: .idle))
        let working = try render(SidebarRow(name: "conch brand", mark: .working, line: activity("Running the test suite")))
        XCTAssertEqual(idle.height, 30, "an idle row is the one-line row it always was")
        XCTAssertGreaterThan(working.height, 40, "a working row with a line is two lines tall")
        XCTAssertLessThan(working.height, 50)
        let ground = idle.darkest(0..<1)
        // Ink where the second line is, none below it.
        let secondLine = (working.height - 18)..<(working.height - 4)
        XCTAssertTrue(working.inked(secondLine, ground: ground), "the activity is drawn under the name")
        // Fainter than the name: its darkest pixel is lighter than the name's.
        let nameLine = 4..<20
        XCTAssertGreaterThan(working.darkest(secondLine), working.darkest(nameLine) + 30, "the line is faint beside the name")
    }

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
            XCTAssertEqual(picture.band(nameBand), pictures[0].band(nameBand), "the name's line is untouched by the activity")
        }
    }

    func testABlockedRowKeepsItsQuestionAndAQuietOneKeepsItsLine() throws {
        let question = SidebarRowText.secondLine(
            message: nil, blockedOn: "Claude is asking what to do with three legacy settings",
            activity: SidebarActivity.line("Running the test suite", working: false), startedBy: nil
        )
        XCTAssertEqual(question?.kind, .question)
        let blocked = try render(SidebarRow(name: "settings migration", mark: .needs, semibold: true, line: question))
        XCTAssertGreaterThan(blocked.height, 40)
    }

    // MARK: - Pictures to look at

    /// A sidebar's worth of rows, light and dark: two working sessions with their lines, a session whose agents work
    /// under it, and waiting, idle and blocked rows as they always were.
    func testTheSidebarRendersInLightAndDark() throws {
        let sidebar = VStack(alignment: .leading, spacing: 2) {
            SidebarRow(name: "conch brand", mark: .working, line: activity("Running the test suite"))
            SidebarRow(name: "Login-walled URL handling", mark: .working,
                       line: activity("I'll downscale it into the iOS fixtures folder and write the fixture."))
            SidebarRow(name: "Conch session modal bug and mobile feature parity", mark: Mark(symbol: "person.2.fill", size: 9, color: ConchColor.ready))
            AgentRows(agents: [
                (name: "Live activity line in sidebar", activity: "Editing src/live-activity.ts"),
                (name: "Map building blocks for big ideas", activity: "Searching for “liveBackgroundAgents”"),
                (name: "Adversarial review of PR #301", activity: nil),
            ])
            SidebarRow(name: "atals and nura", mark: .working, line: activity("Reading server/oauth/owner-consent.ts"))
            SidebarRow(name: "seashell", mark: .waiting, semibold: true)
            SidebarRow(name: "Cobra doc in documents/healthcare", mark: .idle)
            SidebarRow(name: "settings migration", mark: .needs, semibold: true,
                       line: SidebarRowText.secondLine(message: nil, blockedOn: "Claude is asking what to do with three legacy settings", activity: nil, startedBy: nil))
        }
        .padding(.vertical, 8)
        for dark in [false, true] {
            let picture = try render(sidebar, dark: dark, name: "mac-sidebar-activity-\(dark ? "dark" : "light")")
            XCTAssertGreaterThan(picture.height, 30 * 8)
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
