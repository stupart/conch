import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// The Workdesk after Tyler clicked through it in his own app (2026-10-16), measured: the strip full and not (its fades,
/// its gutter, the + the same either way, the tab shown kept in view), a tab asleep, the address field's ring while it
/// has the keyboard, when a loaded tab names its profile, and how an agent's marks move. Drawn offscreen as the app draws them (`WorkdeskRenderTests` has the helper's reasons); with
/// `CONCH_WORKDESK_RENDERS=<dir>` each picture is written too. Everything in them is invented.
@MainActor
final class WorkdeskPolishTests: XCTestCase {
    private var windows: [NSWindow] = []

    override func tearDown() {
        MainActor.assumeIsolated {
            windows.forEach { $0.orderOut(nil) }
            windows = []
        }
        super.tearDown()
    }

    // MARK: - Drawing and measuring

    private func picture(_ content: some View, size: CGSize, dark: Bool, name: String) throws -> Picture {
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
        return Picture(rep: rep)
    }

    // MARK: - The strip

    /// Full, the run fades out before a fixed gutter, so no letter is cut there; not full, it is the same +. At the two
    /// widths the pane is used at: about 860 (conch beside another window) and 1440.
    func testTheStripFullAndNotFull() throws {
        for width in [860.0, 1440.0] {
            let size = CGSize(width: width, height: StripScene.height)
            let full = try picture(StripScene(width: width, full: true), size: size, dark: false, name: "after-strip-\(Int(width))-full")
            let roomy = try picture(StripScene(width: width, full: false), size: size, dark: false, name: "after-strip-\(Int(width))-not-full")
            let label = "\(Int(width))"
            let ground = full.color(width - 2, 2)

            let plusBox = CGRect(x: width - 6 - 24, y: 5, width: 24, height: 24)
            XCTAssertEqual(full.color(plusBox.minX + 2, plusBox.midY), roomy.color(plusBox.minX + 2, plusBox.midY), "the + full and not, \(label)")
            XCTAssertEqual(full.color(plusBox.midX, plusBox.midY), roomy.color(plusBox.midX, plusBox.midY), "the + glyph full and not, \(label)")

            // The gutter before it is clear, and the run has faded to nothing by its end: no letter is cut there.
            let runEnd = plusBox.minX - WorkdeskTabRun<EmptyView>.gutter
            XCTAssertLessThanOrEqual(full.strongest(x: runEnd, plusBox.minX, y: 8, 26, against: ground), 2, "the gutter, \(label)")
            XCTAssertLessThanOrEqual(full.strongest(x: runEnd - 3, runEnd, y: 8, 26, against: ground), 12, "the run's last 3 points, faded, \(label)")
            // And it is a fade, not a cut: a little further in the last tab's words are still there, part way.
            XCTAssertGreaterThan(full.strongest(x: runEnd - 24, runEnd - 12, y: 8, 26, against: ground), 20, "the faded tab still shows, \(label)")
        }
    }

    /// The tab shown is scrolled into view, clear of the fade: here the last one, as a tab just opened at the end would
    /// be. Scrolled, the run's leading edge fades too, so the first tab in view doesn't stop mid-letter at the hairline.
    func testTheShownTabIsKeptInViewAndTheLeadingEdgeFades() throws {
        let width = 860.0
        let picture = try picture(StripScene(width: width, full: true, showLast: true), size: CGSize(width: width, height: StripScene.height), dark: false, name: "after-strip-860-full-shown-last")
        let ground = picture.color(width - 2, 2)
        let runEnd = width - 6 - 24 - WorkdeskTabRun<EmptyView>.gutter
        // The selected pill is wholly in view and unfaded: the run scrolled to its end, where nothing is beyond.
        let pill = try XCTUnwrap(picture.span(x: StripScene.runStart, runEnd, y: 6, matching: picture.color(runEnd - 40, 6)))
        XCTAssertLessThanOrEqual(pill.upperBound, runEnd, "the shown tab ends inside the run")
        XCTAssertEqual(picture.color(pill.upperBound - 3, 6), picture.color(pill.lowerBound + 3, 6), "its pill isn't faded at either end")
        // The leading edge: what is under it is faded at the run's start.
        XCTAssertLessThanOrEqual(picture.strongest(x: StripScene.runStart, StripScene.runStart + 3, y: 8, 26, against: ground), 14, "the run's first 3 points")
    }

    /// A tab asleep is a step quieter than one awake, as Tyler asked of it (2026-11-02, "subtle"): its mark faded, still a
    /// mark's 3:1, since the paused hand is the only word that agents are paused there, and its name in the tertiary text
    /// colour, which still reads at 4.5:1. It takes the very same room, so nothing in the strip moves as a tab sleeps or
    /// wakes; the paused hand fades as the globe does.
    func testATabAsleepIsAStepQuieterInTheSameRoom() throws {
        let awake = NSHostingView(rootView: WorkbenchTabButton(tab: SleepScene.tab, isSelected: false, open: {}, close: {})).fittingSize
        let asleep = NSHostingView(rootView: WorkbenchTabButton(tab: SleepScene.tab, isSelected: false, isAsleep: true, open: {}, close: {})).fittingSize
        XCTAssertEqual(awake, asleep)
        for dark in [false, true] {
            let label = dark ? "dark" : "light"
            let strip = try picture(SleepScene(), size: SleepScene.size, dark: dark, name: "after-strip-tab-asleep")
            let ground = strip.color(2, 2)
            // Each tab: its mark 8 to 18 from its left, its name from 23.
            let tabs = (0..<3).map { SleepScene.inset + CGFloat($0) * (awake.width + SleepScene.gap) }
            let marks = tabs.map { strip.strongestColor(x: $0 + 8, $0 + 18, y: 9, 25, against: ground) }
            let names = tabs.map { strip.strongestColor(x: $0 + 23, $0 + awake.width - 8, y: 9, 25, against: ground) }
            XCTAssertLessThan(contrast(marks[1], ground), contrast(marks[0], ground) * 0.75, "the globe fades, \(label)")
            XCTAssertLessThan(contrast(marks[2], ground), contrast(marks[0], ground) * 0.75, "the hand fades, \(label)")
            XCTAssertGreaterThanOrEqual(contrast(marks[1], ground), 3, "and is still a mark, \(label)")
            XCTAssertGreaterThanOrEqual(contrast(marks[2], ground), 3, "the paused hand too, \(label)")
            XCTAssertLessThan(contrast(names[1], ground), contrast(names[0], ground), "the name is quieter, \(label)")
            XCTAssertGreaterThanOrEqual(contrast(names[1], ground), 4.5, "and still reads, \(label)")
        }
    }

    /// The fade's strength follows how much is out of sight, so it comes and goes as the content reaches an edge.
    func testAnEdgeFadesByHowMuchIsBeyondIt() {
        let fade = WorkdeskTabRun<EmptyView>.fade
        var extent = RunExtent(content: CGRect(x: 0, y: 0, width: 500, height: 24), visible: 600)
        XCTAssertEqual(extent.leadingFade, 0)
        XCTAssertEqual(extent.trailingFade, 0, "it all fits")
        extent.content = CGRect(x: 0, y: 0, width: 900, height: 24)
        XCTAssertEqual(extent.trailingFade, 1, "more than a fade's width beyond the right")
        extent.content.origin.x = -(300 - fade / 2)
        XCTAssertEqual(extent.trailingFade, 0.5, accuracy: 0.001, "half a fade's width left to scroll")
        XCTAssertEqual(extent.leadingFade, 1)
        extent.content.origin.x = -300
        XCTAssertEqual(extent.trailingFade, 0, "scrolled to the end")
    }

    // MARK: - The address bar

    /// A new tab's field with the keyboard is ringed, and nothing moves when it comes.
    func testTheAddressFieldIsRingedWhileItHasTheKeyboard() throws {
        let focused = try picture(BarScene(facts: WorkbenchBar.Facts(canPickProfile: true), draft: "", focused: true), size: BarScene.size, dark: false, name: "after-bar-blank-focused")
        let resting = try picture(BarScene(facts: WorkbenchBar.Facts(canPickProfile: true), draft: "", focused: false), size: BarScene.size, dark: false, name: "after-bar-blank-unfocused")
        let bar = resting.color(300, 4)
        XCTAssertGreaterThanOrEqual(contrast(focused.color(300, 3.25), bar), 2.3, "the ring's top")
        XCTAssertLessThan(diff(resting.color(300, 3.25), bar), 3, "no ring without the keyboard")
        let globe = try XCTUnwrap(focused.inkSpan(x: 86, 101, y: 6, 20, against: focused.color(200, 12), threshold: 50))
        let globeAtRest = try XCTUnwrap(resting.inkSpan(x: 86, 101, y: 6, 20, against: bar, threshold: 50))
        XCTAssertEqual(globe.lowerBound, globeAtRest.lowerBound, accuracy: 0.01, "the globe doesn't move")
        // The placeholder starts at the same point either way (after the globe's slot, so neither ring nor globe counts).
        let words = try XCTUnwrap(focused.inkSpan(x: 101, 300, y: 8, 18, against: focused.color(200, 12), threshold: 50))
        let wordsAtRest = try XCTUnwrap(resting.inkSpan(x: 101, 300, y: 8, 18, against: bar, threshold: 50))
        XCTAssertEqual(words.lowerBound, wordsAtRest.lowerBound, accuracy: 0.01, "nothing moves")
    }

    /// A loaded tab names its profile whenever there is more than one profile; with Default alone it says nothing, since
    /// every tab signs in the same way.
    func testALoadedTabNamesItsProfileWhenThereIsAChoice() {
        XCTAssertFalse(WorkbenchBar.Facts(hasPage: true).namesProfile, "Default alone")
        XCTAssertTrue(WorkbenchBar.Facts(hasPage: true, profileCount: 2).namesProfile, "Default, with another to choose from")
        XCTAssertTrue(WorkbenchBar.Facts(hasPage: true, profileName: "Work", isDefaultProfile: false, profileCount: 2).namesProfile)
        XCTAssertTrue(WorkbenchBar.Facts(hasPage: true, profileName: "Work", isDefaultProfile: false).namesProfile, "an older daemon that lists no profiles")
        XCTAssertFalse(WorkbenchBar.Facts(profileCount: 3, canPickProfile: true).namesProfile, "a blank tab has its picker instead")
    }

    // MARK: - An agent's marks

    /// A click: the mark comes in, holds while the eye gets there, and the ripple starts as the click is sent, not before. A type: in, held while the field fills and a moment after, then faded.
    func testHowAnAgentsMarksMove() {
        typealias M = WorkbenchMarkMotion
        XCTAssertFalse(M.look(.click, since: -0.01).isVisible)
        XCTAssertEqual(M.look(.click, since: M.fadeIn).outline, 1, accuracy: 0.001, "in over 80 ms")
        XCTAssertLessThan(M.look(.click, since: 0.02).outline, 0.5, "not at once")
        XCTAssertEqual(M.look(.click, since: M.clickLead - 0.01).ringOpacity, 0, "no ripple before the click")
        let landing = M.look(.click, since: M.clickLead)
        XCTAssertEqual(landing.ring, M.ringStart, accuracy: 0.5, "the ripple starts as the click lands")
        XCTAssertEqual(landing.ringOpacity, 1, accuracy: 0.01)
        XCTAssertEqual(landing.outline, 1, accuracy: 0.001, "the outline holds through the click")
        XCTAssertGreaterThan(M.look(.click, since: M.clickLead + 0.2).ring, 40, "most of the way out")
        XCTAssertFalse(M.look(.click, since: M.clickLead + M.ripple).isVisible, "gone")
        XCTAssertEqual(M.look(.click, since: M.clickLead + 0.1, reduceMotion: true).ringOpacity, 0, "no ripple with Reduce Motion")
        XCTAssertTrue(M.look(.click, since: M.clickLead + 0.1, reduceMotion: true).isVisible)

        XCTAssertEqual(M.look(.type, since: 2, ended: nil).outline, 1, "held while the field fills")
        XCTAssertEqual(M.look(.type, since: 0.9, ended: 0.9).outline, 1, accuracy: 0.001)
        XCTAssertEqual(M.look(.type, since: 0.9 + M.fadeOut / 2, ended: 0.9).outline, 0.5, accuracy: 0.01, "fading")
        XCTAssertFalse(M.look(.type, since: 0.9 + M.fadeOut, ended: 0.9).isVisible, "gone")
        XCTAssertFalse(M.look(.type, since: M.typeLimit + M.fadeOut, ended: nil).isVisible, "a type whose end never came goes anyway")

        // A mark's end is when nothing of it is left: the live view's clock stops there.
        let at = Date(timeIntervalSince1970: 1_000)
        for mark in [WorkbenchMark(kind: .click, rect: .zero, serial: 1, at: at), WorkbenchMark(kind: .type, rect: .zero, serial: 2, at: at, endedAt: at.addingTimeInterval(0.6)),
                     WorkbenchMark(kind: .type, rect: .zero, serial: 3, at: at)] {
            let end = M.end(of: mark)
            XCTAssertTrue(M.look(mark, at: end.addingTimeInterval(-0.03)).isVisible, "\(mark.serial) just before its end")
            XCTAssertFalse(M.look(mark, at: end).isVisible, "\(mark.serial) at its end")
        }
    }
}

// MARK: - Measuring a picture

private func diff(_ a: Picture.RGB, _ b: Picture.RGB) -> Int {
    max(abs(a.r - b.r), abs(a.g - b.g), abs(a.b - b.b))
}

private func contrast(_ a: Picture.RGB, _ b: Picture.RGB) -> Double {
    func luminance(_ c: Picture.RGB) -> Double {
        func channel(_ v: Int) -> Double {
            let x = Double(v) / 255
            return x <= 0.03928 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
    }
    let (la, lb) = (luminance(a), luminance(b))
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
}

/// A picture, read in its own points from the top left; its pixels are at the backing scale.
private struct Picture {
    struct RGB: Equatable { let r, g, b: Int }

    let rep: NSBitmapImageRep
    var scale: CGFloat { CGFloat(rep.pixelsWide) / rep.size.width }

    func color(_ x: CGFloat, _ y: CGFloat) -> RGB {
        pixel(Int(x * scale), Int(y * scale))
    }

    /// As stored: the picture's space is the display's (Display P3), whose greys are sRGB's own, and every measurement
    /// here is of greys, or of a grey against a grey. Converting through `NSColor` went by way of the device's profile and
    /// shifted them, so the numbers here are the ones in the written PNG.
    private func pixel(_ x: Int, _ y: Int) -> RGB {
        var values = [Int](repeating: 0, count: max(rep.samplesPerPixel, 4))
        values.withUnsafeMutableBufferPointer { rep.getPixel($0.baseAddress!, atX: x, y: y) }
        return RGB(r: values[0], g: values[1], b: values[2])
    }

    private func pixels(_ x0: CGFloat, _ x1: CGFloat) -> Range<Int> { Int(x0 * scale)..<Int(x1 * scale) }

    /// The most any pixel in the box differs from `ground`.
    func strongest(x x0: CGFloat, _ x1: CGFloat, y y0: CGFloat, _ y1: CGFloat, against ground: RGB) -> Int {
        diff(strongestColor(x: x0, x1, y: y0, y1, against: ground), ground)
    }

    func strongestColor(x x0: CGFloat, _ x1: CGFloat, y y0: CGFloat, _ y1: CGFloat, against ground: RGB) -> RGB {
        var best = ground
        for y in pixels(y0, y1) {
            for x in pixels(x0, x1) {
                let c = pixel(x, y)
                if diff(c, ground) > diff(best, ground) { best = c }
            }
        }
        return best
    }

    /// From the first column to the end of the last holding a pixel at least `threshold` off `ground`, in points.
    func inkSpan(x x0: CGFloat, _ x1: CGFloat, y y0: CGFloat, _ y1: CGFloat, against ground: RGB, threshold: Int) -> ClosedRange<CGFloat>? {
        let columns = pixels(x0, x1).filter { x in pixels(y0, y1).contains { diff(pixel(x, $0), ground) >= threshold } }
        guard let first = columns.first, let last = columns.last else { return nil }
        return CGFloat(first) / scale...CGFloat(last + 1) / scale
    }

    /// Along one row, the run of pixels within 2 levels of `color`.
    func span(x x0: CGFloat, _ x1: CGFloat, y: CGFloat, matching color: RGB) -> ClosedRange<CGFloat>? {
        let row = Int(y * scale)
        let columns = pixels(x0, x1).filter { diff(pixel($0, row), color) <= 2 }
        guard let first = columns.first, let last = columns.last else { return nil }
        return CGFloat(first) / scale...CGFloat(last + 1) / scale
    }
}

// MARK: - Invented scenes

/// The Workdesk's strip as the app lays it out (DashboardView `deliverableTabs`): Files and Shell, a hairline, then the
/// run of browser tabs and filed work, and the +.
private struct StripScene: View {
    static let height: CGFloat = 34
    /// Where the run starts: 6 in, Files (50) and Shell (54) and their gap, the hairline and its padding.
    static let runStart: CGFloat = 6 + 50 + 2 + 54 + 2 + 5 + 2

    let width: CGFloat
    let full: Bool
    var showLast = false

    static let dashboard = Workbench.Tab(id: "tab-1", sessionId: "s1", url: "https://analytics.northwind.example/dashboard", title: "Dashboard · Northwind Analytics", openedAt: 1)
    static let billing = Workbench.Tab(id: "tab-2", sessionId: "s1", url: "https://billing.northwind.example/invoices", title: "Invoices", openedAt: 2)
    static let blank = Workbench.Tab(id: "tab-4", sessionId: "s1", url: "", openedAt: 4, openedByUser: true)

    var filed: [(String, String)] {
        let few = [("Pricing page, second pass", "4m")]
        let many = few + [("Settings screens in light and dark", "12m"), ("Release notes, October", "1h"), ("Onboarding copy review", "2h")]
        let more = many + [("Changelog for the next release", "3h"), ("Menu bar states, all five", "5h"), ("Support replies, first drafts", "1d")]
        return full ? (width > 1000 ? more : many) : few
    }

    var shown: AnyHashable? {
        if showLast, let last = filed.last { return AnyHashable("filed:" + last.0) }
        return AnyHashable(full ? Self.blank.id : Self.dashboard.id)
    }

    var body: some View {
        HStack(spacing: 2) {
            PlaceTab(symbol: "folder", name: "Files")
            PlaceTab(symbol: "chevron.left.forwardslash.chevron.right", name: "Shell")
            Rectangle().fill(ConchColor.hairline).frame(width: 1, height: 14).padding(.horizontal, 2)
            WorkdeskTabRun(shown: shown, newTab: {}) {
                WorkbenchTabButton(tab: Self.dashboard, isSelected: !full, open: {}, close: {}).workdeskTab(Self.dashboard.id)
                WorkbenchTabButton(tab: Self.billing, isSelected: false, agentWorking: full, open: {}, close: {}).workdeskTab(Self.billing.id)
                if full { WorkbenchTabButton(tab: Self.blank, isSelected: !showLast, open: {}, close: {}).workdeskTab(Self.blank.id) }
                ForEach(filed, id: \.0) { summary, age in
                    FiledTab(summary: summary, age: age, isSelected: showLast && summary == filed.last?.0).workdeskTab("filed:" + summary)
                }
            }
        }
        .padding(.leading, 6)
        .padding(.trailing, 6)
        .padding(.vertical, 5)
        .background(ConchColor.surface)
    }
}

/// Files and Shell, as the app's strip draws them (DashboardView `FilesTab`, `ShellTab`).
private struct PlaceTab: View {
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

/// A filed deliverable's tab, as DashboardView's `DeliverableTab` draws one looked at: its summary capped at 220, its age.
private struct FiledTab: View {
    let summary: String
    let age: String
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 5) {
            Text(summary).font(.system(size: 11)).lineLimit(1).truncationMode(.middle).frame(maxWidth: 220, alignment: .leading)
            Text(age).font(.system(size: 10.5)).foregroundStyle(ConchColor.textTertiary).monospacedDigit().fixedSize()
        }
        .foregroundStyle(isSelected ? ConchColor.textPrimary : ConchColor.textSecondary)
        .padding(.horizontal, 8)
        .frame(height: 24)
        .background(RoundedRectangle(cornerRadius: 6).fill(isSelected ? AnyShapeStyle(ConchColor.rowSelected) : AnyShapeStyle(Color.clear)))
    }
}

/// The strip's tabs alone, on its surface: one awake, the same asleep, and one the user paused agents in, asleep.
private struct SleepScene: View {
    static let tab = Workbench.Tab(id: "tab-2", sessionId: "s1", url: "https://billing.northwind.example/invoices", title: "Invoices · Northwind", openedAt: 2)
    static let inset: CGFloat = 6
    static let gap: CGFloat = 2
    static let size = CGSize(width: 520, height: 34)

    var body: some View {
        // Each at its own width, as the strip's scroller lays them out.
        HStack(spacing: Self.gap) {
            WorkbenchTabButton(tab: Self.tab, isSelected: false, open: {}, close: {})
            WorkbenchTabButton(tab: Self.tab, isSelected: false, isAsleep: true, open: {}, close: {})
            WorkbenchTabButton(tab: Self.tab.with(paused: true), isSelected: false, isAsleep: true, open: {}, close: {})
        }
        .fixedSize()
        .padding(.leading, Self.inset)
        .padding(.vertical, 5)
        .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
        .background(ConchColor.surface)
    }
}

/// The bar alone, the keyboard in its field or not.
private struct BarScene: View {
    static let size = CGSize(width: 860, height: 26)

    let facts: WorkbenchBar.Facts
    @State var draft: String
    let focused: Bool
    @FocusState private var editing: Bool

    var body: some View {
        WorkbenchBar(facts: facts, draft: $draft, editing: $editing, actions: .init())
            .onAppear {
                guard focused else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { editing = true }
            }
    }
}
