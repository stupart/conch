import Foundation

/// A runaway guard that tripped (src/runaway.ts `GuardTrip`, published as `guards`): conch stopped doing more of
/// something that kept failing, a worker it stopped restarting, the ceiling on its processes, sessions it stopped
/// bringing back on its own.
///
/// Tyler, 2026-10-28: "do we have protections in place to stop the daemon from going out of control and infinite
/// looping making processes until my computer is bricked if an error is going off over and over or something?" The
/// guards are the protection; this is how he hears that one held, in plain words, instead of finding out from a fan.
public struct RunawayGuardTrip: Decodable, Equatable, Sendable, Identifiable {
    /// Stable key: `whisper-server`, `kokoro`, `processes`, `session-relaunch`.
    public let name: String
    /// What stopped, finishing "conch stopped …": "restarting the speech engine (whisper-server)".
    public let what: String
    /// Why, finishing "because it …": "failed 5 times in 10 min".
    public let why: String
    /// The last thing it said, cut short by the daemon.
    public let detail: String?
    /// Epoch ms.
    public let trippedAt: Double
    /// Epoch ms it tries again; nil for a guard that isn't timed.
    public let retryAt: Double?
    /// Trips in a row: 1 the first time.
    public let trips: Int

    /// One trip, once: a new trip of the same guard is a new notice.
    public var id: String { "\(name)@\(Int(trippedAt))" }

    public init(name: String, what: String, why: String, detail: String? = nil, trippedAt: Double, retryAt: Double? = nil, trips: Int = 1) {
        self.name = name
        self.what = what
        self.why = why
        self.detail = detail
        self.trippedAt = trippedAt
        self.retryAt = retryAt
        self.trips = trips
    }
}

public enum RunawayGuardNotice {
    /// The line the window shows for the newest trip not yet OK'd, and how many more there are.
    ///
    /// "conch stopped restarting the speech engine (whisper-server): it failed 5 times in 10 min. It tries again at
    /// 7:45 PM." A guard that isn't timed says nothing about trying again; more than one trip says how many more.
    public static func sentence(
        _ trip: RunawayGuardTrip,
        more: Int = 0,
        timeZone: TimeZone = .current,
        locale: Locale = .current
    ) -> String {
        var line = "conch stopped \(trip.what): it \(trip.why)."
        if let retryAt = trip.retryAt {
            let formatter = DateFormatter()
            formatter.timeZone = timeZone
            formatter.locale = locale
            formatter.dateStyle = .none
            formatter.timeStyle = .short
            line += " It tries again at \(formatter.string(from: Date(timeIntervalSince1970: retryAt / 1_000)))."
        }
        if more > 0 { line += " (\(more) more)" }
        return line
    }

    /// The trips to say, newest first, without the ones OK'd.
    public static func showing(_ trips: [RunawayGuardTrip], dismissed: Set<String>) -> [RunawayGuardTrip] {
        trips.filter { !dismissed.contains($0.id) }.sorted { $0.trippedAt > $1.trippedAt }
    }
}
