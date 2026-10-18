import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// A session whose conch tools are out of date, drawn and measured (2026-10-19): one quiet line under the session's
/// header, its mark under the title's first letter, Restart ending where the header's ••• ends and centred in the line,
/// on the header's own surface. At the two widths the stage is used at, and at the stage's width in an 860-point window
/// with the sidebar open, light and dark.
///
/// `CONCH_TOOLS_RENDERS=<dir>` writes each picture too. Everything in them is invented: no real session, client or person.
@MainActor
final class SessionToolsRenderTests: XCTestCase {
    private var windows: [NSWindow] = []

    override func tearDown() {
        MainActor.assumeIsolated {
            windows.forEach { $0.orderOut(nil) }
            windows = []
        }
        super.tearDown()
    }

    private func picture(_ content: some View, size: CGSize, dark: Bool, name: String) throws -> ToolsShot {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let view = NSHostingView(rootView: content
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(ConchColor.ground)
            .environment(\.colorScheme, dark ? .dark : .light))
        window.contentView = view
        window.orderFrontRegardless()
        windows.append(window)
        for _ in 0..<10 {
            view.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        if let directory = ProcessInfo.processInfo.environment["CONCH_TOOLS_RENDERS"] {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
            try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
        }
        return ToolsShot(rep: rep)
    }

    /// The stage at the two widths it is used at, and in an 860-point window with the 264-point sidebar open.
    private static let widths: [CGFloat] = [860, 1440, 596]

    static let today = ToolsStale(
        missing: ["conch_fork", "browser_open", "browser_read", "browser_click", "browser_type", "browser_screenshot",
                  "browser_tabs", "browser_ask", "browser_close", "atlas_show"],
        basis: "estimated", serverStartedAt: "2026-10-12T10:46:10.000Z",
        why: "its conch MCP server started 2026-10-12, before a running server could take a newer conch's tools (2026-10-15)"
    )

    /// Before: the header as it is, with nothing said. Written for the comparison; it measures that the stand-in's session
    /// menu draws as conch's window does (measured there, 2026-10-19): dots 12 wide ending 12 from the edge, on the
    /// header's middle.
    func testBefore() throws {
        for dark in [false, true] {
            for width in Self.widths {
                let shot = try picture(HeaderScene(width: width, stale: nil), size: CGSize(width: width, height: HeaderScene.height), dark: dark, name: "before-\(Int(width))")
                let ground = shot.color(width / 2, 4)
                let dots = try XCTUnwrap(shot.inkSpan(x: width - 40, width - 2, y: 18, 34, against: ground, threshold: 40))
                XCTAssertEqual(width - dots.upperBound, 12, accuracy: 0.75, "the ••• ends 12 from the edge")
                XCTAssertEqual(dots.upperBound - dots.lowerBound, 12, accuracy: 0.75, "the ••• is 12 wide")
                let rows = try XCTUnwrap(shot.verticalSpan(x: dots.lowerBound + 1, y: 10, 42, notMatching: ground, tolerance: 40))
                XCTAssertEqual((rows.lowerBound + rows.upperBound) / 2, HeaderScene.bar / 2, accuracy: 0.75, "the ••• on the header's middle")
            }
        }
    }

    /// The line, measured against the header above it. The narrow stage first: with no hint beside Restart, its capsule
    /// is the only ink at that end of the line, so its width is read there and used to find its left end at the wider two.
    func testTheLineSitsOnTheHeadersAxes() throws {
        for dark in [false, true] {
            var capsuleWidth: CGFloat?
            for width in Self.widths.sorted() {
                let label = "\(Int(width)) \(dark ? "dark" : "light")"
                let shot = try picture(HeaderScene(width: width, stale: Self.today), size: CGSize(width: width, height: HeaderScene.height), dark: dark, name: "after-\(Int(width))")
                let ground = shot.color(width / 2, 4)
                let top = HeaderScene.bar
                let middle = top + SessionToolsNotice.height / 2
                // The header's own surface: no band under the header, the line reads as its second line.
                XCTAssertEqual(shot.color(width / 2, top + 2), ground, "the header's surface, \(label)")
                // The mark's ink starts where the title's does.
                let title = try XCTUnwrap(shot.inkSpan(x: 4, 40, y: 16, 36, against: ground, threshold: 60), "the title, \(label)")
                let mark = try XCTUnwrap(shot.inkSpan(x: 4, 30, y: top + 8, top + 22, against: ground, threshold: 40), "the mark, \(label)")
                XCTAssertEqual(mark.lowerBound, title.lowerBound, accuracy: 0.75, "the mark under the title's first letter, \(label)")

                // Restart: its right edge where the •••'s ink ends.
                let end = try XCTUnwrap(shot.span(x: width - 120, width - 2, y: middle, notMatching: ground, tolerance: 4), "Restart, \(label)")
                let dots = try XCTUnwrap(shot.inkSpan(x: width - 40, width - 2, y: 18, 34, against: ground, threshold: 40), label)
                XCTAssertEqual(end.upperBound, dots.upperBound, accuracy: 0.75, "Restart ends where the ••• does, \(label)")
                // Centred top to bottom in the line: as much above its capsule as below.
                let capsule = try XCTUnwrap(shot.verticalSpan(x: end.upperBound - 12, y: top, top + SessionToolsNotice.height, notMatching: ground, tolerance: 4), label)
                XCTAssertEqual(capsule.upperBound - capsule.lowerBound, 20, accuracy: 0.6, "Restart is 20 tall, \(label)")
                XCTAssertEqual(capsule.lowerBound - top, top + SessionToolsNotice.height - capsule.upperBound, accuracy: 0.75, "Restart centred in the line, \(label)")
                // The mark on the same middle.
                let markRows = try XCTUnwrap(shot.verticalSpan(x: (mark.lowerBound + mark.upperBound) / 2, y: top + 2, top + SessionToolsNotice.height - 2, notMatching: ground, tolerance: 40), label)
                XCTAssertEqual((markRows.lowerBound + markRows.upperBound) / 2, (capsule.lowerBound + capsule.upperBound) / 2, accuracy: 0.75, "the mark on Restart's middle, \(label)")

                let words = try XCTUnwrap(shot.inkSpan(x: mark.upperBound + 2, 460, y: top + 9, top + 21, against: ground, threshold: 40), label)
                XCTAssertEqual(words.lowerBound - mark.upperBound, 7.5, accuracy: 0.75, "the words 7 after the mark's ink, and the first letter's bearing, \(label)")
                if let capsuleWidth {
                    // "keeps the conversation" 8 before Restart, while there is room.
                    let left = end.upperBound - capsuleWidth
                    let hint = try XCTUnwrap(shot.inkSpan(x: 470, left - 1, y: top + 9, top + 21, against: ground, threshold: 30), "the hint, \(label)")
                    XCTAssertEqual(left - hint.upperBound, 8, accuracy: 0.5, "the hint 8 before Restart, \(label)")
                    XCTAssertNil(shot.inkSpan(x: left - 7, left - 0.5, y: top + 3, top + SessionToolsNotice.height - 3, against: ground, threshold: 4), "nothing in the gap, \(label)")
                } else {
                    // Narrow: no hint; the words whole and clear of Restart; and Restart's ends draw clean, its fill a
                    // point (the border) in from its outermost ink.
                    XCTAssertGreaterThan(end.lowerBound - words.upperBound, 12, "the words whole, clear of Restart, \(label)")
                    let fill = shot.color(end.lowerBound + 5, middle)
                    let inside = try XCTUnwrap(shot.span(x: end.lowerBound, end.upperBound, y: middle, where: { toolsDiff($0, fill) <= 6 }), label)
                    XCTAssertLessThanOrEqual(inside.lowerBound - end.lowerBound, 1.25, "Restart's left end, \(label)")
                    XCTAssertLessThanOrEqual(end.upperBound - inside.upperBound, 1.25, "Restart's right end, \(label)")
                    capsuleWidth = end.upperBound - end.lowerBound
                }
                // The hairline under it, then the conversation.
                XCTAssertNotEqual(shot.color(width / 2, top + SessionToolsNotice.height), ground, "the hairline under the line, \(label)")
            }
        }
    }

    /// Restarting: the capsule says so and the hint goes; a session conch can't restart says how, with no button.
    func testRestartingAndByHand() throws {
        for dark in [false, true] {
            let width: CGFloat = 860
            _ = try picture(HeaderScene(width: width, stale: Self.today, restarting: true), size: CGSize(width: width, height: HeaderScene.height), dark: dark, name: "after-restarting-860")
            // Under the pointer, Restart's fill steps as a row's does, in light as in dark.
            let hover = try picture(HeaderScene(width: width, stale: Self.today, hovered: true), size: CGSize(width: width, height: HeaderScene.height), dark: dark, name: "after-hover-860")
            let surface = hover.color(width / 2, 4)
            XCTAssertNotEqual(hover.color(width - SessionToolsNotice.trailingInset - 4, HeaderScene.bar + SessionToolsNotice.height / 2), surface, "a hovered Restart is told from the line")
            let shot = try picture(HeaderScene(width: width, stale: Self.today, restartable: false), size: CGSize(width: width, height: HeaderScene.height), dark: dark, name: "after-by-hand-860")
            let ground = shot.color(width / 2, 4)
            let top = HeaderScene.bar
            let hint = try XCTUnwrap(shot.inkSpan(x: width - 200, width - 2, y: top + 9, top + 21, against: ground, threshold: 40))
            let dots = try XCTUnwrap(shot.inkSpan(x: width - 40, width - 2, y: 18, 34, against: ground, threshold: 40))
            XCTAssertEqual(hint.upperBound, dots.upperBound, accuracy: 1, "the words end where Restart would")
            XCTAssertNil(shot.verticalSpan(x: hint.upperBound - 1, y: top + 3, top + 7, notMatching: ground, tolerance: 4), "no capsule")
        }
    }

    /// "What this session carries": the row under Version, its label on the inspector's label column and Restart session
    /// under it; before, the header as it was.
    func testTheInspectorsRow() throws {
        for dark in [false, true] {
            let label = dark ? "dark" : "light"
            _ = try picture(InspectorScene(stale: nil), size: CGSize(width: InspectorScene.width, height: InspectorScene.height), dark: dark, name: "before-inspector")
            let shot = try picture(InspectorScene(stale: Self.today), size: CGSize(width: InspectorScene.width, height: InspectorScene.height), dark: dark, name: "after-inspector")
            let ground = shot.color(InspectorScene.width - 4, 4)
            // Every label of the header starts on its 16-point inset: Model's, Version's, conch tools', and the button's edge.
            let model = try XCTUnwrap(shot.inkSpan(x: 4, 40, y: InspectorScene.modelRow - 5, InspectorScene.modelRow + 5, against: ground, threshold: 40), label)
            let tools = try XCTUnwrap(shot.inkSpan(x: 4, 40, y: InspectorScene.toolsRow - 5, InspectorScene.toolsRow + 5, against: ground, threshold: 40), label)
            XCTAssertEqual(tools.lowerBound, model.lowerBound, accuracy: 0.75, "conch tools on Model's column, \(label)")
            let button = try XCTUnwrap(shot.span(x: 4, 60, y: InspectorScene.buttonRow, notMatching: ground, tolerance: 6), label)
            XCTAssertEqual(button.lowerBound, 16, accuracy: 1, "Restart session on the inset, \(label)")
        }
    }

    /// Settings › General: the card under the daemon's, its mark in the same 7-point column and its words on the same
    /// left edge, its button's right edge on the toggles' right edge above. In the column an 860-point window leaves it,
    /// and at the column's full 720.
    func testTheSettingsRow() throws {
        for dark in [false, true] {
            for width in [SettingsScene.narrow, SettingsScene.wide] {
                let label = "\(Int(width)) \(dark ? "dark" : "light")"
                _ = try picture(SettingsScene(stale: false), size: CGSize(width: width, height: SettingsScene.height), dark: dark, name: "before-settings-\(Int(width))")
                let shot = try picture(SettingsScene(stale: true), size: CGSize(width: width, height: SettingsScene.height), dark: dark, name: "after-settings-\(Int(width))")
                let card = shot.color(width / 2, SettingsScene.staleTop + 3)
                let first = shot.color(width / 2, SettingsScene.firstTop + 3)
                XCTAssertEqual(card, first, "the same card surface, \(label)")
                // The words on the first card's left edge.
                let staleWords = try XCTUnwrap(shot.inkSpan(x: 54, 90, y: SettingsScene.staleTop + 14, SettingsScene.staleTop + 26, against: card, threshold: 60), label)
                let firstWords = try XCTUnwrap(shot.inkSpan(x: 54, 90, y: SettingsScene.firstTop + 13, SettingsScene.firstTop + 24, against: first, threshold: 60), label)
                XCTAssertEqual(staleWords.lowerBound, firstWords.lowerBound, accuracy: 0.75, "the words on one edge, \(label)")
                // Restart Idle Sessions… ends where the switches above do, and sits on its row's middle.
                let staleMiddle = SettingsScene.staleTop + SettingsScene.row / 2
                // Inside the cards, which end 24 in from the page's edge.
                let button = try XCTUnwrap(shot.span(x: width - 200, width - 26, y: staleMiddle, notMatching: card, tolerance: 6), label)
                let toggle = try XCTUnwrap(shot.span(x: width - 120, width - 26, y: SettingsScene.firstTop + SettingsScene.row / 2, notMatching: first, tolerance: 6), label)
                XCTAssertLessThan(button.upperBound, width - 30, "the button inside its card, \(label)")
                XCTAssertEqual(button.upperBound, toggle.upperBound, accuracy: 1, "the button under the switches, \(label)")
                let buttonRows = try XCTUnwrap(shot.verticalSpan(x: button.upperBound - 20, y: SettingsScene.staleTop + 2, SettingsScene.staleTop + 48, notMatching: card, tolerance: 6), label)
                XCTAssertEqual((buttonRows.lowerBound + buttonRows.upperBound) / 2, staleMiddle, accuracy: 0.75, "the button on the row's middle, \(label)")
                // The mark centred on the indicator's column.
                let mark = try XCTUnwrap(shot.inkSpan(x: 24, 52, y: SettingsScene.staleTop + 14, SettingsScene.staleTop + 40, against: card, threshold: 40), label)
                let dot = try XCTUnwrap(shot.inkSpan(x: 24, 52, y: SettingsScene.firstTop + 10, SettingsScene.firstTop + 40, against: first, threshold: 40), label)
                XCTAssertEqual((mark.lowerBound + mark.upperBound) / 2, (dot.lowerBound + dot.upperBound) / 2, accuracy: 0.75, "the mark on the dot's column, \(label)")
            }
        }
    }
}

// MARK: - Measuring

private struct ToolsShot {
    struct RGB: Equatable { let r, g, b: Int }

    let rep: NSBitmapImageRep
    var scale: CGFloat { CGFloat(rep.pixelsWide) / rep.size.width }

    func color(_ x: CGFloat, _ y: CGFloat) -> RGB { pixel(Int(x * scale), Int(y * scale)) }

    private func pixel(_ x: Int, _ y: Int) -> RGB {
        var values = [Int](repeating: 0, count: max(rep.samplesPerPixel, 4))
        values.withUnsafeMutableBufferPointer { rep.getPixel($0.baseAddress!, atX: x, y: y) }
        return RGB(r: values[0], g: values[1], b: values[2])
    }

    private func pixels(_ a: CGFloat, _ b: CGFloat) -> Range<Int> { Int(a * scale)..<Int(b * scale) }

    func inkSpan(x x0: CGFloat, _ x1: CGFloat, y y0: CGFloat, _ y1: CGFloat, against ground: RGB, threshold: Int) -> ClosedRange<CGFloat>? {
        let columns = pixels(x0, x1).filter { x in pixels(y0, y1).contains { toolsDiff(pixel(x, $0), ground) >= threshold } }
        guard let first = columns.first, let last = columns.last else { return nil }
        return CGFloat(first) / scale...CGFloat(last + 1) / scale
    }

    func span(x x0: CGFloat, _ x1: CGFloat, y: CGFloat, notMatching color: RGB, tolerance: Int) -> ClosedRange<CGFloat>? {
        span(x: x0, x1, y: y) { toolsDiff($0, color) > tolerance }
    }

    func span(x x0: CGFloat, _ x1: CGFloat, y: CGFloat, where test: (RGB) -> Bool) -> ClosedRange<CGFloat>? {
        let row = Int(y * scale)
        let columns = pixels(x0, x1).filter { test(pixel($0, row)) }
        guard let first = columns.first, let last = columns.last else { return nil }
        return CGFloat(first) / scale...CGFloat(last + 1) / scale
    }

    func verticalSpan(x: CGFloat, y y0: CGFloat, _ y1: CGFloat, notMatching color: RGB, tolerance: Int) -> ClosedRange<CGFloat>? {
        let column = Int(x * scale)
        let rows = pixels(y0, y1).filter { toolsDiff(pixel(column, $0), color) > tolerance }
        guard let first = rows.first, let last = rows.last else { return nil }
        return CGFloat(first) / scale...CGFloat(last + 1) / scale
    }
}

private func toolsDiff(_ a: ToolsShot.RGB, _ b: ToolsShot.RGB) -> Int {
    max(abs(a.r - b.r), abs(a.g - b.g), abs(a.b - b.b))
}

// MARK: - Invented scene

/// A session's page as the app lays it out (DashboardView `sessionBar`, and the stage under it): the 52-point header (the
/// title on 14, the agent's mark, the account, model and effort, the ••• in its 28-point box 8 from the edge), the line
/// when its tools are out of date, a hairline, and the conversation.
private struct HeaderScene: View {
    let width: CGFloat
    let stale: ToolsStale?
    var restartable = true
    var restarting = false
    var hovered = false

    static let height: CGFloat = 330
    static let bar: CGFloat = 52

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("Pricing page, second pass")
                    .font(.system(size: 14, weight: .semibold))
                    .tracking(-0.14)
                    .foregroundStyle(ConchColor.textPrimary)
                    .lineLimit(1)
                Image(systemName: "macwindow")
                    .font(.system(size: 12))
                    .foregroundStyle(ConchColor.textSecondary)
                    .frame(width: 26, height: 26)
                Image(systemName: "asterisk")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(ConchColor.textTertiary)
                    .frame(width: 11, height: 11)
                Text("Studio")
                    .font(.system(size: 11))
                    .foregroundStyle(ConchColor.textSecondary)
                HStack(spacing: 4) {
                    Text("Opus 5.5 · high")
                        .font(.system(size: 11))
                        .foregroundStyle(ConchColor.textSecondary)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(ConchColor.textTertiary)
                }
                .padding(.horizontal, 7)
                .frame(minHeight: 24)
                Spacer(minLength: 8)
                // The session menu exactly as the header builds it: a borderless-button menu redraws its label the way
                // an NSMenuItem is built, so a plain image here would put the dots where the app doesn't.
                Menu {
                    Button("Restart session…") {}
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(ConchColor.textSecondary)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
            }
            .padding(.leading, 14)
            .padding(.trailing, 8)
            .frame(height: Self.bar)
            .background(ConchColor.surface)

            if let stale {
                SessionToolsNotice(stale, isRestarting: restarting, isHovered: hovered, restart: restartable ? {} : nil)
                Rectangle().fill(ConchColor.hairline).frame(height: 1)
            }

            Conversation()
        }
        .frame(width: width)
        .background(ConchColor.surface)
    }
}

/// An invented exchange in the reading column.
private struct Conversation: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Spacer(minLength: 60)
                Text("Check the new pricing table against last week's draft and tell me what moved.")
                    .font(.system(size: 13))
                    .foregroundStyle(ConchColor.textPrimary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(ConchColor.fill))
            }
            VStack(alignment: .leading, spacing: 10) {
                Text("Worked 2m · 6 steps")
                    .font(.system(size: 11))
                    .foregroundStyle(ConchColor.textTertiary)
                Text("Three things moved. The Team tier dropped from $24 to $19 a seat, the annual discount is now shown on every tier, and the comparison table lost its storage row. Everything else matches last week's draft.")
                    .font(.system(size: 13))
                    .foregroundStyle(ConchColor.textPrimary)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: ConchReading.measure(15) + 40)
        .padding(.horizontal, 24)
        .padding(.top, 22)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

/// The capability inspector's header as the app lays it out (CapabilityInspectorView `header`): 16 in, 12 down, lines 6
/// apart; the session's name, the agent, Model and Version, and the tools row when it is out of date; then the groups.
private struct InspectorScene: View {
    let stale: ToolsStale?

    static let width: CGFloat = 620
    static let height: CGFloat = 270
    /// The rows' middles, for measuring: Model's, the tools row's, and Restart session's.
    static let modelRow: CGFloat = 67
    static let toolsRow: CGFloat = 110
    static let buttonRow: CGFloat = 133

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Pricing page, second pass")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(ConchColor.textPrimary)
                Text("Claude")
                    .font(.system(size: 11))
                    .foregroundStyle(ConchColor.textSecondary)
                HStack(spacing: 8) {
                    Text("Model").font(.system(size: 11)).foregroundStyle(ConchColor.textTertiary)
                    Text("Opus 5.5 · high").font(.system(size: 11)).foregroundStyle(ConchColor.textSecondary)
                    Spacer(minLength: 8)
                }
                .frame(height: 20)
                HStack(spacing: 8) {
                    Text("Version").font(.system(size: 11)).foregroundStyle(ConchColor.textTertiary)
                    Text("2.1.280 · ~/.local/bin/claude").font(.system(size: 11)).foregroundStyle(ConchColor.textSecondary)
                }
                if let stale {
                    InspectorToolsRow(stale, restart: {})
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            Rectangle().fill(ConchColor.textSecondary.opacity(0.14)).frame(height: 1)
            HStack {
                Text("MCP servers")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(ConchColor.textSecondary)
                    .textCase(.uppercase)
                    .tracking(0.5)
                Spacer()
                Text("3").font(.system(size: 10.5)).foregroundStyle(ConchColor.textTertiary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 7)
            ForEach(["conch", "tracker", "docs-search"], id: \.self) { name in
                Text(name)
                    .font(.system(size: 12.5))
                    .foregroundStyle(ConchColor.textPrimary)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
            }
            Spacer(minLength: 0)
        }
        .background(ConchColor.ground)
    }
}

/// Settings › General's top as the app lays it out (SettingsView `ConchSettingsView`): its 24-point inset, the card with
/// the daemon's switch and open at login, and the out-of-date card 12 under it.
private struct SettingsScene: View {
    let stale: Bool

    /// The column an 860-point window leaves (860, less the 220-point section list and its rule), and the column's 720.
    static let narrow: CGFloat = 639
    static let wide: CGFloat = 720
    static let height: CGFloat = 230
    static let firstTop: CGFloat = 24
    /// The first card's two rows, 11 above and below their pair of lines (53 with the card's border), the rule between.
    static let row: CGFloat = 53
    static let staleTop: CGFloat = firstTop + 2 * row + 1 + 12

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            OnboardingCard {
                row(mark: AnyView(Circle().fill(ConchColor.speaking).frame(width: 7, height: 7)), title: "conch", detail: "Running · started by this app")
                Rectangle().fill(ConchColor.hairline).frame(height: 1)
                row(mark: AnyView(Image(systemName: "power").font(.system(size: 10, weight: .semibold)).foregroundStyle(ConchColor.textSecondary).frame(width: 7)),
                    title: "Open conch when you log in", detail: "So your agents can reach you. macOS lists it in System Settings › General › Login Items.")
            }
            if stale {
                OnboardingCard {
                    StaleToolsSettingsRow(idle: 7, other: 2, action: {})
                }
                .padding(.top, 12)
            }
            Spacer(minLength: 0)
        }
        .padding(24)
        .background(ConchColor.ground)
    }

    private func row(mark: AnyView, title: String, detail: String) -> some View {
        HStack(spacing: 12) {
            mark
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 12.5, weight: .medium)).foregroundStyle(ConchColor.textPrimary)
                Text(detail).font(.system(size: 11)).foregroundStyle(ConchColor.textSecondary).lineLimit(1)
            }
            Spacer(minLength: 12)
            Toggle("", isOn: .constant(true)).labelsHidden().toggleStyle(.switch)
        }
        .padding(.horizontal, ConchSpace.x4)
        .padding(.vertical, 11)
    }
}
