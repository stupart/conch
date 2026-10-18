import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// A tab that needs the user, drawn and measured (2026-10-18). Tyler, after an agent asked him in words to sign in in a
/// tab: "the tab didn't get any sort of emphasis and it was all the way on the left so i missed it". Now its agent asks in
/// the tab (`browser_ask`): it comes to the front with "Needs you" on it and a strip under its address bar with Done; one
/// that waits for the user to stop reading is scrolled into view in the strip all the same; and a page whose passkey
/// conch's browser can't give says so in the same strip. At the two widths the Workdesk is used at, light and dark.
///
/// `CONCH_WORKDESK_RENDERS=<dir>` writes each picture too. Everything in them is invented: no real page, session or person.
@MainActor
final class WorkdeskAttentionRenderTests: XCTestCase {
    private var windows: [NSWindow] = []

    override func tearDown() {
        MainActor.assumeIsolated {
            windows.forEach { $0.orderOut(nil) }
            windows = []
        }
        super.tearDown()
    }

    private func picture(_ content: some View, size: CGSize, dark: Bool, name: String) throws -> Shot {
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
        // Long enough for a reveal's scroll (posted to the next turn of the run loop, then animated 0.22 s) to finish.
        for _ in 0..<30 {
            view.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        if let directory = ProcessInfo.processInfo.environment["CONCH_WORKDESK_RENDERS"] {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
            try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
        }
        return Shot(rep: rep)
    }

    private static let widths: [CGFloat] = [860, 1440]

    // MARK: - The tab that needs the user, in front

    /// In front: the strip scrolled to it at the far left, its pill in the attention colour; under the bar, the strip's
    /// mark starting on the pane's left axis (15 in), Done's right edge on the close ×'s (14 from the edge), Done centred
    /// top to bottom.
    func testATabThatNeedsYouInFront() throws {
        for dark in [false, true] {
            for width in Self.widths {
                let label = "\(Int(width)) \(dark ? "dark" : "light")"
                let shot = try picture(AskScene(width: width, front: true), size: CGSize(width: width, height: AskScene.height), dark: dark, name: "after-ask-\(Int(width))")
                // The pill: a run of the attention colour on the strip's row, in view, and wholly inside the run.
                let pill = try XCTUnwrap(shot.span(x: AskScene.runStart, width - 36, y: 17, where: { isAttention($0, dark: dark) }), "the pill, \(label)")
                XCTAssertGreaterThanOrEqual(pill.upperBound - pill.lowerBound, 40, "the pill is a word wide, \(label)")

                // The notice: its row starts under the bar's hairline.
                let top = AskScene.noticeTop
                let wash = shot.color(width / 2, top + 3)
                XCTAssertNotEqual(wash, shot.color(width / 2, AskScene.barTop + 3), "the strip is told from the bar, \(label)")
                // Its mark starts on the pane's left axis, 15 in, as the back arrow above it and the strip's first mark do.
                let mark = try XCTUnwrap(shot.inkSpan(x: 4, 32, y: top + 8, top + 22, against: wash, threshold: 60), "the mark, \(label)")
                let chevron = try XCTUnwrap(shot.inkSpan(x: 4, 29, y: AskScene.barTop + 6, AskScene.barTop + 20, against: shot.color(4, AskScene.barTop + 3), threshold: 40), label)
                let folder = try XCTUnwrap(shot.inkSpan(x: 4, 29, y: 10, 24, against: shot.color(3, 3), threshold: 40), label)
                XCTAssertEqual(mark.lowerBound, 15, accuracy: 0.6, "the mark on the left axis, \(label)")
                XCTAssertEqual(mark.lowerBound, chevron.lowerBound, accuracy: 0.75, "the mark under the back arrow, \(label)")
                XCTAssertEqual(mark.lowerBound, folder.lowerBound, accuracy: 0.75, "the mark under the strip's first, \(label)")
                // Done's capsule: its right edge 14 from the pane's edge, where the close × above ends.
                let done = try XCTUnwrap(shot.span(x: width - 90, width - 2, y: top + 15, notMatching: wash, tolerance: 6), "Done, \(label)")
                XCTAssertEqual(width - done.upperBound, 14, accuracy: 0.75, "Done's right edge, \(label)")
                let close = try XCTUnwrap(shot.inkSpan(x: width - 29, width - 7, y: AskScene.barTop + 6, AskScene.barTop + 20, against: shot.color(width - 3, AskScene.barTop + 3), threshold: 40), label)
                XCTAssertEqual(done.upperBound, close.upperBound, accuracy: 1, "Done ends where the close × does, \(label)")
                // Centred top to bottom in its 30 points: as much above Done's capsule as below.
                let capsule = try XCTUnwrap(shot.verticalSpan(x: done.upperBound - 12, y: top, top + AskScene.notice, notMatching: wash, tolerance: 6), label)
                XCTAssertEqual(capsule.lowerBound - top, top + AskScene.notice - capsule.upperBound, accuracy: 0.75, "Done centred in the strip, \(label)")
            }
        }
    }

    /// Waiting (the user was reading the deliverable a moment ago): the deliverable stays, and the tab that needs him is
    /// scrolled into view at the far end of a full strip, its pill clear of the fade.
    func testATabThatNeedsYouIsScrolledIntoViewWhileItWaits() throws {
        for dark in [false, true] {
            for width in Self.widths {
                let label = "\(Int(width)) \(dark ? "dark" : "light")"
                let shot = try picture(AskScene(width: width, front: false), size: CGSize(width: width, height: AskScene.height), dark: dark, name: "after-ask-waiting-\(Int(width))")
                let pill = try XCTUnwrap(shot.span(x: AskScene.runStart, width - 36, y: 17, where: { isAttention($0, dark: dark) }), "the pill in view, \(label)")
                // Clear of the leading fade: the attention colour at full strength across it.
                XCTAssertGreaterThanOrEqual(pill.lowerBound, AskScene.runStart + WorkdeskTabRun<EmptyView>.fade - 1, "clear of the fade, \(label)")
            }
        }
    }

    // MARK: - Passkeys

    /// The passkey line: the same strip, the bar's surface without the wash, its key on the left axis and its × the bar's
    /// close × exactly, under it.
    func testAPasskeyThePageAskedForIsSaidUnderTheBar() throws {
        for dark in [false, true] {
            for width in Self.widths {
                let label = "\(Int(width)) \(dark ? "dark" : "light")"
                let shot = try picture(PasskeyScene(width: width), size: CGSize(width: width, height: AskScene.height), dark: dark, name: "after-passkeys-\(Int(width))")
                let top = AskScene.noticeTop
                let ground = shot.color(width / 2, top + 3)
                XCTAssertEqual(ground, shot.color(width / 2, AskScene.barTop + 3), "the bar's own surface, \(label)")
                let mark = try XCTUnwrap(shot.inkSpan(x: 4, 34, y: top + 8, top + 22, against: ground, threshold: 40), label)
                XCTAssertEqual(mark.lowerBound, 15, accuracy: 0.6, "the key on the left axis, \(label)")
                let x = try XCTUnwrap(shot.inkSpan(x: width - 29, width - 7, y: top + 8, top + 22, against: ground, threshold: 40), label)
                let close = try XCTUnwrap(shot.inkSpan(x: width - 29, width - 7, y: AskScene.barTop + 6, AskScene.barTop + 20, against: shot.color(width - 3, AskScene.barTop + 3), threshold: 40), label)
                XCTAssertEqual(x.lowerBound, close.lowerBound, accuracy: 0.6, "the × under the close ×, \(label)")
                XCTAssertEqual(x.upperBound, close.upperBound, accuracy: 0.6, "the × the close ×'s size, \(label)")
            }
        }
    }

    /// Stacked (an agent asking in a tab whose page just asked for a passkey), the two strips' marks and words start on
    /// the same columns.
    func testTheTwoStripsLineUpStacked() throws {
        for dark in [false, true] {
            let label = dark ? "dark" : "light"
            let shot = try picture(
                VStack(spacing: 0) {
                    WorkbenchNotice(.needsYou(agent: "Claude", reason: "Pick the Fieldnotes workspace"), action: {})
                    WorkbenchNotice(.passkeys, action: {})
                },
                size: CGSize(width: 860, height: WorkbenchNotice.height * 2), dark: dark, name: "after-strips-stacked-860"
            )
            func starts(_ y: CGFloat) throws -> [CGFloat] {
                let ground = shot.color(700, y - 12)
                let mark = try XCTUnwrap(shot.inkSpan(x: 4, 30, y: y - 6, y + 6, against: ground, threshold: 40), label)
                // The first letter: "P" in Pick and in Passkeys.
                let word = try XCTUnwrap(shot.inkSpan(x: 30, 50, y: y - 6, y + 6, against: ground, threshold: 60), label)
                return [mark.lowerBound, mark.upperBound, word.lowerBound]
            }
            let top = try starts(WorkbenchNotice.height / 2)
            let bottom = try starts(WorkbenchNotice.height * 1.5)
            for (a, b) in zip(top, bottom) { XCTAssertEqual(a, b, accuracy: 0.6, "stacked, \(label): \(top) and \(bottom)") }
        }
    }

    // MARK: - The session's row

    /// The session whose tab needs the user, in the sidebar: before, a row whose turn was over (the agent asked in words);
    /// now the row every session that asks something of him gets (the Mac's `SessionRow.needingYou`): the needs mark, the
    /// bold name, and the ask as what it is blocked on. Drawn with `SidebarActivityRenderTests`' rebuild of the Mac row.
    func testTheSessionsRowSaysItNeedsYou() throws {
        typealias Row = SidebarActivityRenderTests.SidebarRow
        typealias Mark = SidebarActivityRenderTests.Mark
        for dark in [false, true] {
            for (name, asking) in [("before-sidebar", false), ("after-sidebar", true)] {
                let list = VStack(spacing: 0) {
                    Row(name: "Pricing page refresh", mark: .working, line: SidebarRowText.SecondLine(text: "Editing src/pricing/plans.ts", kind: .activity))
                    if asking {
                        Row(name: "Mood board research", mark: .needs, semibold: true, line: SidebarRowText.SecondLine(text: Workbench.rowAskLine(reason: "Sign in to Swatchbook"), kind: .question))
                    } else {
                        Row(name: "Mood board research", mark: .waiting, semibold: true)
                    }
                    Row(name: "Onboarding flow audit", mark: .idle)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(ConchColor.ground)
                _ = try picture(list, size: CGSize(width: 280, height: 130), dark: dark, name: name)
            }
        }
    }

    // MARK: - Colour

    /// The pill's words on the pill, and the strip's words on its wash, measured: text at 4.5:1 or better.
    func testThePillAndTheStripRead() {
        for scheme in [ColorScheme.light, .dark] {
            let pill = WorkdeskInk.needsYou.rgba(scheme)
            let words = WorkdeskInk.needsYouWords.rgba(scheme).contrast(on: pill)
            XCTAssertGreaterThanOrEqual(words, 4.5, "the pill's words in \(scheme): \(String(format: "%.2f", words)):1")
            let wash = WorkdeskInk.noticeWash.rgba(scheme).over(ConchColor.surfaceRaised.rgba(scheme))
            for token in [ConchColor.textPrimary, ConchColor.textSecondary] {
                let ratio = token.rgba(scheme).contrast(on: wash)
                XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(token.name) on the strip in \(scheme): \(String(format: "%.2f", ratio)):1")
            }
            // The mark, a mark: 3:1 on the wash.
            let mark = ConchColor.attention.rgba(scheme).contrast(on: wash)
            XCTAssertGreaterThanOrEqual(mark, 3, "the strip's mark in \(scheme): \(String(format: "%.2f", mark)):1")
            // And the pill against the strip it sits in, as a mark.
            let onStrip = pill.contrast(on: ConchColor.surface.rgba(scheme))
            XCTAssertGreaterThanOrEqual(onStrip, 3, "the pill on the strip in \(scheme): \(String(format: "%.2f", onStrip)):1")
        }
    }

    private func isAttention(_ c: Shot.RGB, dark: Bool) -> Bool {
        dark ? (c.r > 230 && c.g > 80 && c.g < 130 && c.b > 60 && c.b < 110) : (c.r > 180 && c.g < 80 && c.b < 60)
    }
}

// MARK: - Measuring

/// A picture, read in its own points from the top left; its pixels at the backing scale, as stored.
private struct Shot {
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
        let columns = pixels(x0, x1).filter { x in pixels(y0, y1).contains { diff(pixel(x, $0), ground) >= threshold } }
        guard let first = columns.first, let last = columns.last else { return nil }
        return CGFloat(first) / scale...CGFloat(last + 1) / scale
    }

    func span(x x0: CGFloat, _ x1: CGFloat, y: CGFloat, notMatching color: RGB, tolerance: Int) -> ClosedRange<CGFloat>? {
        span(x: x0, x1, y: y) { diff($0, color) > tolerance }
    }

    func span(x x0: CGFloat, _ x1: CGFloat, y: CGFloat, where test: (RGB) -> Bool) -> ClosedRange<CGFloat>? {
        let row = Int(y * scale)
        let columns = pixels(x0, x1).filter { test(pixel($0, row)) }
        guard let first = columns.first, let last = columns.last else { return nil }
        return CGFloat(first) / scale...CGFloat(last + 1) / scale
    }

    func verticalSpan(x: CGFloat, y y0: CGFloat, _ y1: CGFloat, notMatching color: RGB, tolerance: Int) -> ClosedRange<CGFloat>? {
        let column = Int(x * scale)
        let rows = pixels(y0, y1).filter { diff(pixel(column, $0), color) > tolerance }
        guard let first = rows.first, let last = rows.last else { return nil }
        return CGFloat(first) / scale...CGFloat(last + 1) / scale
    }
}

private func diff(_ a: Shot.RGB, _ b: Shot.RGB) -> Int {
    max(abs(a.r - b.r), abs(a.g - b.g), abs(a.b - b.b))
}

// MARK: - Invented scenes

/// The Workdesk as the app lays it out: the strip (Files, Shell, a hairline, the run of browser tabs and filed work, the
/// +), and under it either the tab that needs the user (its bar, the strip under it, its page) or the deliverable he was
/// reading while it waits.
private struct AskScene: View {
    let width: CGFloat
    /// In front, or waiting behind the deliverable.
    let front: Bool

    static let height: CGFloat = 420
    static let strip: CGFloat = 34
    static let barTop: CGFloat = strip + 1
    static let bar: CGFloat = 26
    static let noticeTop: CGFloat = barTop + bar + 1
    static let notice: CGFloat = WorkbenchNotice.height
    /// Where the run starts: 6 in, Files and Shell and their gap, the hairline and its padding.
    static let runStart: CGFloat = 6 + 50 + 2 + 54 + 2 + 5 + 2

    static let signIn = Workbench.Tab(
        id: "tab-1", sessionId: "s1", url: "https://swatchbook.example/login", title: "Log in · Swatchbook", openedAt: 1,
        ask: Workbench.Tab.Ask(reason: "Sign in to Swatchbook", at: 1)
    )
    static let dashboard = Workbench.Tab(id: "tab-2", sessionId: "s1", url: "https://analytics.northwind.example/dashboard", title: "Dashboard · Northwind Analytics", openedAt: 2)
    static let invoices = Workbench.Tab(id: "tab-3", sessionId: "s1", url: "https://billing.northwind.example/invoices", title: "Invoices", openedAt: 3)

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                StandInTab(symbol: "folder", name: "Files")
                StandInTab(symbol: "chevron.left.forwardslash.chevron.right", name: "Shell")
                Rectangle().fill(ConchColor.hairline).frame(width: 1, height: 14).padding(.horizontal, 2)
                WorkdeskTabRun(shown: AnyHashable(front ? "tab-1" : "d3"), attention: AnyHashable("tab-1"), newTab: {}) {
                    WorkbenchTabButton(tab: Self.signIn, isSelected: front, open: {}, close: {}).workdeskTab("tab-1")
                    WorkbenchTabButton(tab: Self.dashboard, isSelected: false, open: {}, close: {}).workdeskTab("tab-2")
                    WorkbenchTabButton(tab: Self.invoices, isSelected: false, open: {}, close: {}).workdeskTab("tab-3")
                    StandInDeliverable(summary: "Pricing page, second pass", age: "9m", selected: false).workdeskTab("d1")
                    StandInDeliverable(summary: "Onboarding flow audit", age: "4m", selected: false).workdeskTab("d2")
                    StandInDeliverable(summary: "Mood board, round two", age: "1m", selected: !front).workdeskTab("d3")
                }
            }
            .padding(.leading, 6)
            .padding(.trailing, 6)
            .padding(.vertical, 5)
            .frame(height: Self.strip)
            .background(ConchColor.surface)
            Rectangle().fill(ConchColor.hairline).frame(height: 1)
            if front {
                BarStandIn(address: Self.signIn.url)
                Rectangle().fill(ConchColor.hairline).frame(height: 1)
                WorkbenchNotice(.needsYou(agent: "Claude", reason: "Sign in to Swatchbook"), action: {})
                Rectangle().fill(ConchColor.hairline).frame(height: 1)
                SignInPage()
            } else {
                MoodBoardPage()
            }
        }
        .background(ConchColor.surface)
    }
}

/// A Google-like account chooser after a passkey failed: invented, with the passkey line under the bar.
private struct PasskeyScene: View {
    let width: CGFloat

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                StandInTab(symbol: "folder", name: "Files")
                StandInTab(symbol: "chevron.left.forwardslash.chevron.right", name: "Shell")
                Rectangle().fill(ConchColor.hairline).frame(width: 1, height: 14).padding(.horizontal, 2)
                WorkdeskTabRun(shown: AnyHashable("tab-1"), newTab: {}) {
                    WorkbenchTabButton(tab: Workbench.Tab(id: "tab-1", sessionId: "s1", url: "https://accounts.example/signin", title: "Sign in · Example Accounts", openedAt: 1, openedByUser: true), isSelected: true, open: {}, close: {})
                        .workdeskTab("tab-1")
                    StandInDeliverable(summary: "Pricing page, second pass", age: "9m", selected: false)
                }
            }
            .padding(.leading, 6)
            .padding(.trailing, 6)
            .padding(.vertical, 5)
            .frame(height: AskScene.strip)
            .background(ConchColor.surface)
            Rectangle().fill(ConchColor.hairline).frame(height: 1)
            BarStandIn(address: "https://accounts.example/signin/challenge")
            Rectangle().fill(ConchColor.hairline).frame(height: 1)
            WorkbenchNotice(.passkeys, action: {})
            Rectangle().fill(ConchColor.hairline).frame(height: 1)
            ChooserPage()
        }
        .background(ConchColor.surface)
    }
}

/// The bar, with the focus it needs.
private struct BarStandIn: View {
    @State var address: String
    @FocusState private var editing: Bool

    var body: some View {
        WorkbenchBar(facts: WorkbenchBar.Facts(canGoBack: true, isSecure: true, hasPage: true), draft: $address, editing: $editing, actions: .init())
            .frame(height: AskScene.bar)
    }
}

private struct StandInTab: View {
    let symbol: String
    let name: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).font(.system(size: 10))
            Text(name).font(.system(size: 11))
        }
        .foregroundStyle(ConchColor.textSecondary)
        .padding(.horizontal, 8)
        .frame(height: 24)
    }
}

private struct StandInDeliverable: View {
    let summary: String
    let age: String
    let selected: Bool

    var body: some View {
        HStack(spacing: 5) {
            Text(summary).font(.system(size: 11)).lineLimit(1)
            Text(age).font(.system(size: 10.5)).foregroundStyle(ConchColor.textTertiary).monospacedDigit()
        }
        .foregroundStyle(selected ? ConchColor.textPrimary : ConchColor.textSecondary)
        .padding(.horizontal, 8)
        .frame(height: 24)
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? AnyShapeStyle(ConchColor.rowSelected) : AnyShapeStyle(Color.clear)))
    }
}

/// An invented sign-in page.
private struct SignInPage: View {
    var body: some View {
        ZStack(alignment: .top) {
            Color(white: 0.985)
            VStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 7).fill(Color(red: 0.93, green: 0.62, blue: 0.48)).frame(width: 30, height: 30)
                Text("Log in to Swatchbook").font(.system(size: 20, weight: .semibold)).foregroundStyle(Color(white: 0.1))
                Text("Palettes and type for your whole team").font(.system(size: 12)).foregroundStyle(Color(white: 0.45))
                VStack(spacing: 10) {
                    field("Email")
                    field("Password")
                    Text("Log in")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white)
                        .frame(width: 300, height: 34)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color(white: 0.15)))
                    Text("Continue with Google")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color(white: 0.15))
                        .frame(width: 300, height: 34)
                        .background(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(white: 0.8)))
                }
                .padding(.top, 8)
            }
            .padding(.top, 34)
        }
    }

    private func field(_ label: String) -> some View {
        Text(label)
            .font(.system(size: 13))
            .foregroundStyle(Color(white: 0.55))
            .padding(.horizontal, 10)
            .frame(width: 300, height: 32, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(.white))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(white: 0.8)))
    }
}

/// The deliverable the user was reading.
private struct MoodBoardPage: View {
    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.white
            VStack(alignment: .leading, spacing: 14) {
                Text("Mood board, round two").font(.system(size: 20, weight: .semibold)).foregroundStyle(Color(white: 0.1))
                Text("Six directions for the Fieldnotes landing page").font(.system(size: 12)).foregroundStyle(Color(white: 0.45))
                HStack(spacing: 12) {
                    ForEach(0..<4, id: \.self) { index in
                        RoundedRectangle(cornerRadius: 8)
                            .fill([Color(red: 0.86, green: 0.82, blue: 0.74), Color(red: 0.62, green: 0.70, blue: 0.66), Color(red: 0.30, green: 0.36, blue: 0.44), Color(red: 0.93, green: 0.62, blue: 0.48)][index])
                            .frame(width: 150, height: 110)
                    }
                }
            }
            .padding(28)
        }
    }
}

/// An invented account chooser, the way a sign-in falls back after a passkey fails.
private struct ChooserPage: View {
    var body: some View {
        ZStack(alignment: .top) {
            Color.white
            VStack(alignment: .leading, spacing: 10) {
                Text("Choose how you want to sign in").font(.system(size: 20, weight: .regular)).foregroundStyle(Color(white: 0.1))
                Text(verbatim: "jordan@fieldnotes.example").font(.system(size: 12)).foregroundStyle(Color(white: 0.4))
                ForEach(["Enter your password", "Get a verification code", "Use another phone or computer"], id: \.self) { option in
                    Text(option)
                        .font(.system(size: 13))
                        .foregroundStyle(Color(white: 0.15))
                        .padding(.horizontal, 12)
                        .frame(width: 360, height: 40, alignment: .leading)
                        .overlay(alignment: .bottom) { Rectangle().fill(Color(white: 0.9)).frame(height: 1) }
                }
            }
            .padding(.top, 30)
        }
    }
}
