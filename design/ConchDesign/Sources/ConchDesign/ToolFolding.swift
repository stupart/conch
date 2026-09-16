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

    /// Seconds from the FIRST step starting to the LAST step starting.
    ///
    /// Not the run's true elapsed time: the wire carries when each step began and never when it
    /// ended, so the last step's own duration is invisible here. It is nil when either end has
    /// no `at` — an older daemon omits it — because an invented duration is worse than none.
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
    /// The runs of consecutive tool steps in a transcript, in the order they appear.
    ///
    /// Anything that is not a tool step breaks a run — that is the whole point, since the
    /// sentences either side are what the run sits between. Runs shorter than `foldingFrom`
    /// are not returned at all: a lone step folded into a summary of itself hides one line
    /// behind another line, and costs a click to get back.
    public static func runs(
        for items: [(id: String, isTool: Bool, at: Double?)],
        foldingFrom minimum: Int = 2
    ) -> [ToolRun] {
        var runs: [ToolRun] = []
        var current: [(id: String, at: Double?)] = []

        func close() {
            defer { current = [] }
            guard current.count >= max(2, minimum) else { return }
            let span: Double?
            if let first = current.first?.at, let last = current.last?.at, last >= first {
                span = last - first
            } else {
                span = nil
            }
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
