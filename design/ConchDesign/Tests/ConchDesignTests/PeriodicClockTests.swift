import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// The ten-second clock the Mac's session list and deliverables strip age their rows on (2026-11-11).
///
/// They were `TimelineView(.periodic(by: 10))`s, and a timeline's content hangs off the window's frame clock: every frame
/// of an animation anywhere in the window, a status mark's quarter-second crossfade or a scroll, dirtied the whole list
/// under it and SwiftUI walked it all again to find nothing had moved. Offscreen on the app's own window over Tyler's
/// sessions file, a session's turn ending or starting cost ~115 ms of main thread, ~50 on this clock (the PR's numbers;
/// the frame clock's share is too timing-bound to hold here). These hold it to ticking, and to stopping where it can't be
/// seen; test/app-cpu.test.ts holds the window to it.
@MainActor
final class PeriodicClockTests: XCTestCase {
    private final class Seen {
        var dates: [Date] = []
    }

    private struct Ages: View {
        let now: Date
        let seen: Seen
        var body: some View {
            let _ = seen.dates.append(now)
            VStack {
                ForEach(0..<12, id: \.self) { row in
                    Text("Row \(row), \(Int(now.timeIntervalSince1970) % 60)")
                }
            }
        }
    }

    private func host<V: View>(_ view: V) -> (NSWindow, NSHostingView<V>) {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: 300, height: 420), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(x: 0, y: 0, width: 300, height: 420)
        window.contentView = host
        window.orderFrontRegardless()
        host.layoutSubtreeIfNeeded()
        return (window, host)
    }

    private func run(_ seconds: Double) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    func testItHandsItsContentTheTimeAgainEveryPeriod() {
        let seen = Seen()
        let (window, _) = host(PeriodicClock(every: 0.05) { now in Ages(now: now, seen: seen) })
        defer { window.orderOut(nil); window.contentView = nil }
        run(0.6)
        let distinct = Set(seen.dates)
        XCTAssertGreaterThanOrEqual(distinct.count, 4, "a new time each period: \(distinct.count) in 0.6 s at 0.05")
        XCTAssertEqual(seen.dates, seen.dates.sorted(), "and only ever forward")
    }

    /// Hidden (`conchHidden`, the window ordered out, minimised or covered), nobody reads the ages: the clock stops.
    func testItStopsWhereItCannotBeSeen() {
        let seen = Seen()
        let (window, _) = host(PeriodicClock(every: 0.05) { now in Ages(now: now, seen: seen) }.environment(\.conchHidden, true))
        defer { window.orderOut(nil); window.contentView = nil }
        run(0.6)
        XCTAssertEqual(Set(seen.dates).count, 1, "drawn once, at the time it was made, and not again")
    }

    private final class Visibility: ObservableObject {
        @Published var hidden = true
    }

    private struct Shown: View {
        @ObservedObject var visibility: Visibility
        let seen: Seen
        var body: some View {
            PeriodicClock(every: 0.3) { now in Ages(now: now, seen: seen) }
                .environment(\.conchHidden, visibility.hidden)
        }
    }

    /// Seen again after longer than a period, it says the time at once rather than a period later.
    func testShownAgainItCatchesUpAtOnce() {
        let seen = Seen()
        let visibility = Visibility()
        let (window, _) = host(Shown(visibility: visibility, seen: seen))
        defer { window.orderOut(nil); window.contentView = nil }
        run(0.5)
        XCTAssertEqual(Set(seen.dates).count, 1)
        let shown = Date()
        visibility.hidden = false
        run(0.1)
        XCTAssertEqual(Set(seen.dates).count, 2, "a new time as it is shown, not 0.3 s later")
        XCTAssertGreaterThanOrEqual(seen.dates.last ?? .distantPast, shown)
    }
}
