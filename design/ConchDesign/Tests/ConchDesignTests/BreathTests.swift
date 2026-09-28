import AppKit
import QuartzCore
import SwiftUI
import XCTest
@testable import ConchDesign

/// Working's breath, played by Core Animation rather than a SwiftUI clock.
///
/// Measured 28 Sep on the Mac app's own views over Tyler's published state (eleven working rows): the halo's
/// `TimelineView`, one per working row at 30 frames a second, cost 11.9% of a core with nothing else happening, and
/// kept ticking in a window that was hidden. These pin what replaced it: the same breath, handed to a layer once.
final class BreathTests: XCTestCase {
    private let period = ConchMotion.activeBreathPeriod

    /// The keyframes are the breath the XCTest in ActiveMarkTests already pins, sampled evenly through one period.
    func testTheKeyframesAreTheBreathSampled() {
        let frames = ActiveHalo.keyframes(samples: 48)
        XCTAssertEqual(frames.count, 49, "both ends of the period")
        for (index, value) in frames.enumerated() {
            let time = Double(index) * period / 48
            XCTAssertEqual(value, ActiveHalo.opacity(at: time, reduceMotion: false), accuracy: 1e-12, "sample \(index)")
        }
        XCTAssertEqual(frames.first ?? -1, 0, accuracy: 1e-12)
        XCTAssertEqual(frames.last ?? -1, 0, accuracy: 1e-12)
        XCTAssertEqual(frames[24], ActiveHalo.peak, accuracy: 1e-12, "the peak halfway through")
        // Joined by straight lines, the sine is never more than 0.0005 away: no visible step.
        for step in 0..<48 {
            let midpoint = (frames[step] + frames[step + 1]) / 2
            let truth = ActiveHalo.opacity(at: (Double(step) + 0.5) * period / 48, reduceMotion: false)
            XCTAssertLessThan(abs(midpoint - truth), 0.0005, "between samples \(step) and \(step + 1)")
        }
    }

    /// Every halo breathes on the same clock: one added at any moment reads, at any later moment, the breath every
    /// other halo reads then.
    func testHalosAddedAtDifferentMomentsBreatheTogether() {
        for added in [812_000_000.25, 812_000_001.9, 812_000_003.7, -3.5] {
            for elapsed in [0.0, 0.4, 1.7, 3.99, 9.2] {
                let now = added + elapsed
                let local = (elapsed + ActiveHalo.clockOffset(at: added)).truncatingRemainder(dividingBy: period)
                XCTAssertEqual(local, ActiveHalo.clockOffset(at: now), accuracy: 1e-6, "added \(added), \(elapsed) s later")
            }
        }
        for time in [-9.0, -0.1, 0, 3.999, 4, 812_000_000.25] {
            let offset = ActiveHalo.clockOffset(at: time)
            XCTAssertGreaterThanOrEqual(offset, 0)
            XCTAssertLessThan(offset, period)
        }
    }

    /// The animation handed to the layer: the keyframes, once per period, forever, from where the clock is, and never
    /// asking the window server for more than 30 frames a second.
    func testTheLayerIsHandedTheBreathOnce() {
        let now = 812_000_002.5
        let breath = BreathingLayer.animation(now: now)
        XCTAssertEqual(breath.keyPath, "opacity")
        XCTAssertEqual(breath.values as? [NSNumber], ActiveHalo.keyframes().map { NSNumber(value: $0) })
        XCTAssertEqual(breath.calculationMode, .linear)
        XCTAssertEqual(breath.duration, period)
        XCTAssertEqual(breath.repeatCount, .infinity)
        XCTAssertEqual(breath.timeOffset, ActiveHalo.clockOffset(at: now), accuracy: 1e-9)
        XCTAssertFalse(breath.isRemovedOnCompletion)
        XCTAssertLessThanOrEqual(breath.preferredFrameRateRange.maximum, 30)

        let layer = BreathingLayer()
        XCTAssertEqual(layer.disc.opacity, 0, "with no breath, no halo: the dot alone")
        layer.breathe(now: now)
        let first = layer.disc.animation(forKey: BreathingLayer.key)
        XCTAssertNotNil(first)
        layer.breathe(now: now + 1)
        XCTAssertTrue(layer.disc.animation(forKey: BreathingLayer.key) === first, "breathing already: not started again")
        XCTAssertEqual(layer.disc.animationKeys()?.count, 1)
    }

    /// A working row on screen: its halo is a layer animation, painted in `active`, breathing once it is in a window;
    /// a gallery frame (`phase`) is a still SwiftUI disc. (Reduce Motion, which draws none, is read-only here: the
    /// source guard in test/active-blue-source.test.ts pins that branch.)
    @MainActor
    func testTheLiveHaloIsALayerAnimationAndTheStillOnesAreNot() throws {
        func discs(_ halo: some View) -> [BreathingDiscView] {
            let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: 40, height: 40), styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            let host = NSHostingView(rootView: AnyView(halo.environment(\.colorScheme, .light)))
            host.frame = NSRect(x: 0, y: 0, width: 40, height: 40)
            window.contentView = host
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            host.layoutSubtreeIfNeeded()
            defer { window.contentView = nil }
            return Self.subviews(of: host)
        }
        let live = discs(ActiveHalo(diameter: 14))
        XCTAssertEqual(live.count, 1, "one layer-driven halo")
        let disc = try XCTUnwrap(live.first)
        XCTAssertNotNil(disc.breath.disc.animation(forKey: BreathingLayer.key), "breathing once it reached a window")
        XCTAssertEqual(disc.colour, ConchColor.active.light)
        XCTAssertEqual(disc.breath.disc.backgroundColor, CGColor(srgbRed: ConchColor.active.light.red, green: ConchColor.active.light.green, blue: ConchColor.active.light.blue, alpha: 1))
        XCTAssertEqual(disc.breath.disc.frame.size, CGSize(width: 14, height: 14))
        XCTAssertEqual(disc.breath.disc.cornerRadius, 7)

        XCTAssertTrue(discs(ActiveHalo(diameter: 14, phase: 0.5)).isEmpty, "a gallery frame is drawn still, by SwiftUI")
        XCTAssertTrue(discs(ActiveHalo(diameter: 14).environment(\.conchRendersStatically, true)).isEmpty)
        XCTAssertEqual(discs(Text("x").activeBreath(pointSize: 8)).count, 1)
        XCTAssertTrue(discs(Text("x").activeBreath(pointSize: 8, breathes: false)).isEmpty)
    }

    static func subviews<T: NSView>(of view: NSView) -> [T] {
        var found: [T] = []
        if let match = view as? T { found.append(match) }
        for sub in view.subviews { found += subviews(of: sub) }
        return found
    }
}

/// The window's own "can it be seen", carried to every clock in it (`conchHidden`).
final class WindowVisibilityTests: XCTestCase {
    private final class Seen: @unchecked Sendable { var hidden: [Bool] = [] }

    private struct Reads: View {
        let seen: Seen
        @Environment(\.conchHidden) private var hidden
        var body: some View {
            let _ = seen.hidden.append(hidden)
            Color.clear.frame(width: 10, height: 10)
        }
    }

    /// A window that is not on screen is not visible, and nothing is visible without a window.
    @MainActor
    func testAWindowOffEveryScreenIsNotVisible() {
        XCTAssertFalse(WindowVisibilityView.isVisible(nil))
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: 20, height: 20), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        XCTAssertFalse(WindowVisibilityView.isVisible(window), "never ordered in")
    }

    /// The modifier reads the window it lands in and tells its content: in a window nobody can see, `conchHidden` turns
    /// true, so the clocks under it stop.
    @MainActor
    func testContentInAWindowNobodyCanSeeIsToldItIsHidden() {
        let seen = Seen()
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: 20, height: 20), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: Reads(seen: seen).conchPausesWhenHidden())
        host.frame = NSRect(x: 0, y: 0, width: 20, height: 20)
        window.contentView = host
        for _ in 0..<10 {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        }
        XCTAssertEqual(seen.hidden.first, false, "it starts running, as it always did")
        XCTAssertEqual(seen.hidden.last, true, "then learns its window can't be seen")
        window.contentView = nil
    }

    /// Only a change is reported, and after the update that caused it.
    @MainActor
    func testTheReaderReportsChangesOnly() {
        var reports: [Bool] = []
        let view = WindowVisibilityView()
        view.onChange = { reports.append($0) }
        view.check()
        view.check()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(reports, [false], "no window: hidden, said once")
        XCTAssertEqual(view.visible, false)
    }
}
