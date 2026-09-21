import Foundation

// Consecutive tool steps, folded into one quiet line — workspace-v1 §3.
//
// The transcript is the one thing on screen that is READ rather than scanned, and a session
// that reads six files in a row spends six lines saying so, between the two sentences that are
// the actual exchange. §3 folds a run of steps into "Worked 1m 50s · 5 steps", which opens to
// the steps themselves.
//
// The rule lives here rather than in the view because it is a question about a list, not about
// pixels, and because the phone's transcript will ask it too. The cases worth getting right are
// the ones a healthy screenshot never shows: a single step (which must NOT fold — "· 1 step" is
// longer than the step it hides), a run broken by one sentence, and a daemon that omits `at`.

/// A run of consecutive tool steps long enough to be worth folding.
public struct ToolRun: Equatable, Sendable, Identifiable {
    /// The run is named by the step it starts with, so the view can key a fold on it without
    /// inventing an identity that changes as the run grows.
    public var id: String { itemIDs.first ?? "" }
    public let itemIDs: [String]

    /// Seconds from the FIRST step starting to the LAST step starting, when the run is
    /// plausibly one continuous stretch of work.
    ///
    /// Not the run's true elapsed time: the wire carries when each step began and never when it
    /// ended, so the last step's own duration is invisible here. It is nil when either end has
    /// no `at` — an older daemon omits it — because an invented duration is worse than none.
    ///
    /// It is also nil when any GAP between consecutive steps exceeds `idleCeiling`. Found by
    /// looking at the shipped fold: two adjacent steps four hours apart, because the session
    /// sat waiting on a person in between, rendered as "Worked 4h 40m". The word claims effort
    /// the data cannot support. Every test agreed with it — the fixtures all used timestamps
    /// seconds apart, which is what a run was imagined to look like.
    ///
    /// ponytail: a ceiling, not a real rule. With per-step END times a run could report the
    /// time actually spent; without them a ten-minute build is indistinguishable from ten
    /// minutes of idleness, and the ceiling picks the reading that cannot overclaim.
    public let seconds: Double?

    public var count: Int { itemIDs.count }

    /// The line §3 puts in place of the run: "Worked 1m 50s · 5 steps".
    ///
    /// Without a duration it is only the count. The count is always true; a line that says
    /// nothing about time beats one that invents it, and a run is never fewer than two steps
    /// so the plural always reads.
    public var summary: String {
        let steps = "\(count) steps"
        guard let seconds, seconds >= 1 else { return steps }
        return "Worked \(Self.elapsed(seconds)) · \(steps)"
    }

    /// Coarse on purpose: nobody reads a transcript to learn something took 1m 50.4s.
    static func elapsed(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        let hours = total / 3600, minutes = (total % 3600) / 60, rest = total % 60
        if hours > 0 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
        if minutes > 0 { return rest > 0 ? "\(minutes)m \(rest)s" : "\(minutes)m" }
        return "\(rest)s"
    }

    public init(itemIDs: [String], seconds: Double?) {
        self.itemIDs = itemIDs
        self.seconds = seconds
    }
}

public enum ToolFolding {
    /// Longer than this between two steps and the run is not one stretch of work. Generous on
    /// purpose: a slow build or a long search is real work, and only a gap this size is more
    /// likely to be a person than a process.
    public static let idleCeiling: Double = 600

    /// The run's span in seconds, or nil when it cannot be stated honestly.
    ///
    /// The stamps arrive in epoch MILLISECONDS — the unit of every `at` on the wire, from
    /// `Date.parse` in the daemon — and the summary reads in seconds. The Mac fed this raw
    /// stamps: every real run (steps a second or more apart) tripped the 600 "second" ceiling
    /// and lost its time, and a burst of parallel calls 300 ms apart read "Worked 5m".
    /// Converting here, once, keeps every caller honest instead of each remembering to.
    static func span(of stamps: [Double?]) -> Double? {
        let times = stamps.compactMap { $0.map { $0 / 1_000 } }
        // Every step must be stamped: a run with a hole in it has no span anyone can defend.
        // No `last >= first` here: the loop below rejects any pair that goes backwards, which
        // implies it. A mutation proved that clause unreachable rather than untested.
        guard times.count == stamps.count, let first = times.first, let last = times.last
        else { return nil }
        for (earlier, later) in zip(times, times.dropFirst()) {
            if later < earlier || later - earlier > idleCeiling { return nil }
        }
        return last - first
    }

    /// The runs of consecutive tool steps in a transcript, in the order they appear.
    ///
    /// Anything that is not a tool step breaks a run — that is the whole point, since the
    /// sentences either side are what the run sits between. Runs shorter than `foldingFrom`
    /// are not returned at all: a lone step folded into a summary of itself hides one line
    /// behind another line, and costs a click to get back.
    ///
    /// `at` is epoch milliseconds, exactly as the daemon publishes it — never convert first.
    public static func runs(
        for items: [(id: String, isTool: Bool, at: Double?)],
        foldingFrom minimum: Int = 2
    ) -> [ToolRun] {
        var runs: [ToolRun] = []
        var current: [(id: String, at: Double?)] = []

        func close() {
            defer { current = [] }
            guard current.count >= max(2, minimum) else { return }
            let span = Self.span(of: current.map(\.at))
            runs.append(ToolRun(itemIDs: current.map(\.id), seconds: span))
        }

        for item in items {
            if item.isTool {
                current.append((item.id, item.at))
            } else {
                close()
            }
        }
        close()
        return runs
    }
}
