import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// The Workdesk after Tyler clicked through it in his own app (2026-10-16), measured: the strip full and not (its fades,
/// its gutter, the + the same either way, the tab shown kept in view), the address field's ring while it has the
/// keyboard, a loaded tab's profile, back and forward when they can't act, the new-profile field's edges, and how an
/// agent's marks move. Drawn offscreen as the app draws them (`WorkdeskRenderTests` has the helper's reasons); with
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

    /// Full, the run fades out before a fixed gutter, and the + keeps its look; not full, it is the same +, in the same
    /// place. At the two widths the pane is used at: about 860 (conch beside another window) and 1440.
    func testTheStripFullAndNotFull() throws {
        for dark in [false, true] {
            for width in [860.0, 1440.0] {
                let size = CGSize(width: width, height: StripScene.height)
                let full = try picture(StripScene(width: width, full: true), size: size, dark: dark, name: "after-strip-\(Int(width))-full")
                let roomy = try picture(StripScene(width: width, full: false), size: size, dark: dark, name: "after-strip-\(Int(width))-not-full")
                let label = "\(Int(width)) \(dark ? "dark" : "light")"
                let ground = full.color(width - 2, 2)

                // The + is a 24-point square 6 in from the edge, its glyph centred 18 from it (the bar's close button's
                // axis), its capsule drawn at rest, and drawn the same full or not.
                let plusBox = CGRect(x: width - 6 - 24, y: 5, width: 24, height: 24)
                for picture in [full, roomy] {
                    let glyph = try XCTUnwrap(picture.inkSpan(x: plusBox.minX + 3, plusBox.maxX - 3, y: plusBox.minY + 3, plusBox.maxY - 3, against: picture.color(plusBox.minX + 2, plusBox.midY), threshold: 40), label)
                    XCTAssertEqual(width - (glyph.lowerBound + glyph.upperBound) / 2, 18, accuracy: 0.5, "the +'s axis, \(label)")
                    XCTAssertGreaterThan(diff(picture.color(plusBox.minX + 2, plusBox.midY), ground), 6, "the +'s capsule at rest, \(label)")
                }
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
    }

    /// The tab shown is scrolled into view, clear of the fade: here the last one, as a tab just opened at the end would
    /// be. Scrolled, the run's leading edge fades too, so the first tab in view doesn't stop mid-letter at the hairline.
    func testTheShownTabIsKeptInViewAndTheLeadingEdgeFades() throws {
        for dark in [false, true] {
            let width = 860.0
            let picture = try picture(StripScene(width: width, full: true, showLast: true), size: CGSize(width: width, height: StripScene.height), dark: dark, name: "after-strip-860-full-shown-last")
            let label = dark ? "dark" : "light"
            let ground = picture.color(width - 2, 2)
            let runEnd = width - 6 - 24 - WorkdeskTabRun<EmptyView>.gutter
            // The selected pill is wholly in view and unfaded: the run scrolled to its end, where nothing is beyond.
            let pill = try XCTUnwrap(picture.span(x: StripScene.runStart, runEnd, y: 6, matching: picture.color(runEnd - 40, 6)), label)
            XCTAssertLessThanOrEqual(pill.upperBound, runEnd, "the shown tab ends inside the run, \(label)")
            XCTAssertEqual(picture.color(pill.upperBound - 3, 6), picture.color(pill.lowerBound + 3, 6), "its pill isn't faded at either end, \(label)")
            // The leading edge: what is under it is faded at the run's start and stronger a little further in.
            XCTAssertLessThanOrEqual(picture.strongest(x: StripScene.runStart, StripScene.runStart + 3, y: 8, 26, against: ground), 14, "the run's first 3 points, \(label)")
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

    /// A new tab's field with the keyboard is ringed, a point inside the bar's row, and nothing moves when it comes.
    func testTheAddressFieldIsRingedWhileItHasTheKeyboard() throws {
        for dark in [false, true] {
            let label = dark ? "dark" : "light"
            let focused = try picture(BarScene(facts: WorkbenchBar.Facts(canPickProfile: true), draft: "", focused: true), size: BarScene.size, dark: dark, name: "after-bar-blank-focused")
            let resting = try picture(BarScene(facts: WorkbenchBar.Facts(canPickProfile: true), draft: "", focused: false), size: BarScene.size, dark: dark, name: "after-bar-blank-unfocused")
            let bar = resting.color(300, 4)
            // The ring's top and bottom edges: at 3 and 22 in the 26-point bar (2 of padding, a point inside the row).
            // Its left edge 2 before the field's group, which starts 4 after reload's 22-point target.
            let top = focused.color(300, 3.25)
            let bottom = focused.color(300, 22.75)
            XCTAssertGreaterThanOrEqual(contrast(top, bar), 2.3, "the ring's top, \(label)")
            XCTAssertGreaterThanOrEqual(contrast(bottom, bar), 2.3, "the ring's bottom, \(label)")
            XCTAssertLessThan(diff(resting.color(300, 3.25), bar), 3, "no ring without the keyboard, \(label)")
            let ring = try XCTUnwrap(focused.span(x: 78, 90, y: 13, notMatching: bar, tolerance: 3), label)
            XCTAssertEqual(ring.lowerBound, 83, accuracy: 0.01, "the ring's left edge, \(label)")
            let globe = try XCTUnwrap(focused.inkSpan(x: 86, 101, y: 6, 20, against: focused.color(200, 12), threshold: 50))
            let globeAtRest = try XCTUnwrap(resting.inkSpan(x: 86, 101, y: 6, 20, against: bar, threshold: 50))
            XCTAssertEqual(globe.lowerBound - ring.lowerBound, 6.5, accuracy: 0.5, "the globe a field's inset inside the ring, \(label)")
            XCTAssertEqual(globe.lowerBound, globeAtRest.lowerBound, accuracy: 0.01, "the globe doesn't move, \(label)")
            // The placeholder starts at the same point either way.
            // After the globe (whose slot ends at 85 + 4 + 11 = 100), so neither the ring nor the globe is counted.
            let words = try XCTUnwrap(focused.inkSpan(x: 101, 300, y: 8, 18, against: focused.color(200, 12), threshold: 50))
            let wordsAtRest = try XCTUnwrap(resting.inkSpan(x: 101, 300, y: 8, 18, against: bar, threshold: 50))
            XCTAssertEqual(words.lowerBound, wordsAtRest.lowerBound, accuracy: 0.01, "nothing moves, \(label)")
        }
    }

    /// A loaded tab names its profile, quietly, beside Pause agents, whenever there is more than one profile; with Default
    /// alone it says nothing, since every tab signs in the same way.
    func testALoadedTabNamesItsProfileWhenThereIsAChoice() throws {
        XCTAssertFalse(WorkbenchBar.Facts(hasPage: true).namesProfile, "Default alone")
        XCTAssertTrue(WorkbenchBar.Facts(hasPage: true, profileCount: 2).namesProfile, "Default, with another to choose from")
        XCTAssertTrue(WorkbenchBar.Facts(hasPage: true, profileName: "Work", isDefaultProfile: false, profileCount: 2).namesProfile)
        XCTAssertTrue(WorkbenchBar.Facts(hasPage: true, profileName: "Work", isDefaultProfile: false).namesProfile, "an older daemon that lists no profiles")
        XCTAssertFalse(WorkbenchBar.Facts(profileCount: 3, canPickProfile: true).namesProfile, "a blank tab has its picker instead")

        for dark in [false, true] {
            let label = dark ? "dark" : "light"
            let loaded = WorkbenchBar.Facts(canGoBack: true, isSecure: true, hasPage: true, profileCount: 2)
            let named = try picture(BarScene(facts: loaded, draft: "https://docs.example/guide/start", focused: false), size: BarScene.size, dark: dark, name: "after-bar-loaded-default-of-two")
            var alone = loaded
            alone.profileCount = 1
            let unnamed = try picture(BarScene(facts: alone, draft: "https://docs.example/guide/start", focused: false), size: BarScene.size, dark: dark, name: "after-bar-loaded-default-alone")
            var work = loaded
            work.profileName = "Work"
            work.isDefaultProfile = false
            _ = try picture(BarScene(facts: work, draft: "https://docs.example/guide/start", focused: false), size: BarScene.size, dark: dark, name: "after-bar-loaded-work")
            let bar = named.color(400, 4)
            // Pause agents' hand is centred in its 22-point target, 85 + 11 from the right edge (close, open, their gaps).
            let hand = BarScene.size.width - 7 - 22 - 4 - 22 - 4 - 11
            let span = try XCTUnwrap(named.inkSpan(x: hand - 90, hand - 8, y: 6, 20, against: bar, threshold: 30), "the label, \(label)")
            let handInk = try XCTUnwrap(named.inkSpan(x: hand - 8, hand + 8, y: 6, 20, against: bar, threshold: 30))
            let open = try XCTUnwrap(named.inkSpan(x: hand + 15, hand + 37, y: 6, 20, against: bar, threshold: 30))
            // On the row's rhythm: as far from the hand as the hand is from Open in Browser.
            XCTAssertEqual(handInk.lowerBound - span.upperBound, open.lowerBound - handInk.upperBound, accuracy: 0.5, "the label beside the hand, \(label)")
            // Quiet: tertiary text, no capsule behind it.
            XCTAssertLessThan(diff(named.color(span.lowerBound - 3, 13), bar), 3, "no capsule, \(label)")
            XCTAssertNil(unnamed.inkSpan(x: hand - 90, hand - 8, y: 6, 20, against: bar, threshold: 40), "Default alone says nothing, \(label)")
        }
    }

    /// Back and forward that can't act are dimmed once, as the app's other plain buttons are: readable as controls.
    func testBackAndForwardThatCantActStillReadAsControls() throws {
        for dark in [false, true] {
            let label = dark ? "dark" : "light"
            let bar = try picture(BarScene(facts: WorkbenchBar.Facts(isSecure: true, hasPage: true), draft: "https://docs.example/guide/start", focused: false), size: BarScene.size, dark: dark, name: "after-bar-back-forward-disabled")
            let ground = bar.color(400, 4)
            let back = bar.strongestColor(x: 7, 29, y: 2, 24, against: ground)
            let forward = bar.strongestColor(x: 33, 55, y: 2, 24, against: ground)
            let reload = bar.strongestColor(x: 59, 81, y: 2, 24, against: ground)
            for (name, color) in [("back", back), ("forward", forward)] {
                XCTAssertGreaterThanOrEqual(contrast(color, ground), 2.1, "\(name) when it can't act, \(label)")
                XCTAssertLessThan(contrast(color, ground), contrast(reload, ground) / 2, "\(name) still looks unable, \(label)")
            }
        }
    }

    // MARK: - The new profile's name

    /// The field's edges sit on the popover's column (the words above and the buttons below), and its border reads.
    func testTheNewProfileFieldSitsOnItsColumn() throws {
        for dark in [false, true] {
            let label = dark ? "dark" : "light"
            let card = try picture(NamingScene(focused: false), size: NamingScene.size, dark: dark, name: "after-new-profile")
            let focusedCard = try picture(NamingScene(focused: true), size: NamingScene.size, dark: dark, name: "after-new-profile-focused")
            let surface = card.color(40, 60)
            // The column: the card is 20 in, the list's rows 12 inside it, 240 wide.
            let left = NamingScene.inset + 12
            let right = NamingScene.inset + 240 - 12
            let row = NamingScene.fieldMidY
            let edges = try XCTUnwrap(card.span(x: left - 4, right + 4, y: row, notMatching: surface, tolerance: 3), label)
            XCTAssertEqual(edges.lowerBound, left, accuracy: 0.01, "the field's left edge, \(label)")
            XCTAssertEqual(edges.upperBound, right, accuracy: 0.01, "the field's right edge, \(label)")
            XCTAssertGreaterThanOrEqual(contrast(card.color(left + 0.25, row), surface), 1.5, "its border at rest, \(label)")
            XCTAssertGreaterThanOrEqual(contrast(focusedCard.color(left + 0.25, row), surface), 2.3, "its border with the keyboard, \(label)")
        }
    }

    // MARK: - An agent's marks

    /// A click: the mark comes in, holds while the eye gets there, and the ripple starts as the click is sent, not before;
    /// all of it gone within 0.7 s. A type: in, held while the field fills and a moment after, then faded.
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
        XCTAssertLessThan(M.clickLead + M.ripple, 0.7)
        XCTAssertGreaterThanOrEqual(M.clickLead, 0.2, "time for the eye to get there")
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
        let typed = WorkbenchMark(kind: .type, rect: .zero, serial: 4, at: at).ended(at: at.addingTimeInterval(1))
        XCTAssertEqual(typed.serial, 4, "ending keeps the mark")
        XCTAssertEqual(typed.endedAt, at.addingTimeInterval(1))
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

    /// Along one row, from the first to the end of the last pixel more than `tolerance` off `color`.
    func span(x x0: CGFloat, _ x1: CGFloat, y: CGFloat, notMatching color: RGB, tolerance: Int) -> ClosedRange<CGFloat>? {
        let row = Int(y * scale)
        let columns = pixels(x0, x1).filter { diff(pixel($0, row), color) > tolerance }
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

/// The profile picker naming a new profile, in a popover's card.
private struct NamingScene: View {
    static let size = CGSize(width: 280, height: 250)
    static let inset: CGFloat = 20
    /// The name field's middle: its row under the two profiles and the hairline.
    static let fieldMidY: CGFloat = 123

    let focused: Bool

    private var list: WorkbenchProfileList {
        var list = WorkbenchProfileList(
            profiles: [.init(id: "default", name: "Default"), .init(id: "7d4e1c2a-9b3f-4a5e-8c6d-0f1e2d3c4b5a", name: "Work")],
            selected: "default", naming: true, draft: "Client work", pick: { _ in }, create: { _ in nil }
        )
        list.focusesName = focused
        return list
    }

    var body: some View {
        list
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(ConchColor.surfaceRaised))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
        .padding(Self.inset)
    }
}
