import SwiftUI

/// A clock for what says how long ago something was ("3m"): its content is handed the time, and handed it again every
/// `period` seconds while the window can be seen (`conchHidden`), and once more as soon as it can be seen again.
///
/// Not `TimelineView(.periodic)`, which hangs its content off the window's frame clock: every frame of an animation
/// anywhere in the window, a status mark's quarter-second crossfade or a scroll, dirties everything under the timeline,
/// and SwiftUI walks it all again to find that nothing changed. The Mac's sidebar kept its whole session list under
/// one, and the deliverables strip its tabs (2026-11-11): offscreen on the app's own window over Tyler's sessions file, a
/// session's turn ending or starting cost ~115 ms of main thread, ~50 with the two timelines held still. This clock keeps
/// the time in state, moved on by a task, so the frame clock never reaches what it draws (PeriodicClockTests). Its own
/// tick lays what it holds out once more, which a timeline's did not: one pass every ten seconds, against every frame.
public struct PeriodicClock<Content: View>: View {
    private let period: TimeInterval
    private let content: (Date) -> Content
    @State private var now = Date()
    @Environment(\.conchHidden) private var hidden

    public init(every period: TimeInterval, @ViewBuilder content: @escaping (Date) -> Content) {
        self.period = period
        self.content = content
    }

    public var body: some View {
        content(now)
            // Restarted when the window is hidden or shown: hidden, it stops; shown again, it catches up and goes on.
            .task(id: hidden) {
                guard !hidden else { return }
                if Date().timeIntervalSince(now) >= period { now = Date() }
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: UInt64(period * 1_000_000_000))
                    guard !Task.isCancelled else { return }
                    now = Date()
                }
            }
    }
}
