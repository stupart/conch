import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// A session whose conch tools are out of date, drawn and measured (2026-10-19): one quiet line under the session's
/// header with Restart, which shows the pointer over it, and no button for a session conch can't restart.
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

    static let today = ToolsStale(
        missing: ["conch_fork", "browser_open", "browser_read", "browser_click", "browser_type", "browser_screenshot",
                  "browser_tabs", "browser_ask", "browser_close", "atlas_show"],
        basis: "estimated", serverStartedAt: "2026-10-12T10:46:10.000Z",
        why: "its conch MCP server started 2026-10-12, before a running server could take a newer conch's tools (2026-10-15)"
    )

    /// Under the pointer, Restart's fill steps as a row's does; a session conch can't restart says how, with no button.
    func testAHoveredRestartShowsAndOneByHandHasNoButton() throws {
        let width: CGFloat = 860
        let hover = try picture(HeaderScene(width: width, stale: Self.today, hovered: true), size: CGSize(width: width, height: HeaderScene.height), dark: false, name: "after-hover-860")
        let surface = hover.color(width / 2, 4)
        XCTAssertNotEqual(hover.color(width - SessionToolsNotice.trailingInset - 4, HeaderScene.bar + SessionToolsNotice.height / 2), surface, "a hovered Restart is told from the line")
        let shot = try picture(HeaderScene(width: width, stale: Self.today, restartable: false), size: CGSize(width: width, height: HeaderScene.height), dark: false, name: "after-by-hand-860")
        let ground = shot.color(width / 2, 4)
        let top = HeaderScene.bar
        let hint = try XCTUnwrap(shot.inkSpan(x: width - 200, width - 2, y: top + 9, top + 21, against: ground, threshold: 40))
        XCTAssertNil(shot.verticalSpan(x: hint.upperBound - 1, y: top + 3, top + 7, notMatching: ground, tolerance: 4), "no capsule")
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
