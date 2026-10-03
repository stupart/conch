import Foundation

/// When the lagoon is handed a snapshot (spec §4, §6), decided without a clock of its own so a test can step it:
/// - never before the page has said `ready` (anything earlier is dropped by the page);
/// - only a snapshot whose `ts` moved past the last one this page was given;
/// - at most 4 a second, the latest winning: one that arrives inside the quarter second is held, and replaced by any newer
///   one, until the quarter is up;
/// - never while the page can't be seen. It has stopped drawing then; on being seen again it is given the latest, if it
///   hasn't got it.
/// A new page (the web view rebuilt, or reloaded) says `ready` again and starts from nothing.
public struct LagoonPacer<Snapshot>: Sendable where Snapshot: Sendable {
    public static var interval: TimeInterval { 0.25 }

    /// What to do now.
    public enum Step {
        case none
        case send(Snapshot)
        /// Nothing yet: ask again (`tick`) after this many seconds.
        case later(TimeInterval)
    }

    public private(set) var isReady = false
    public private(set) var isVisible = false
    private var latest: (ts: Double, snapshot: Snapshot)?
    /// What this page was last given, and when.
    private var sentTs: Double?
    private var sentAt: Date?

    public init() {}

    /// The store's newest snapshot. Ignored unless its `ts` moved past the newest already offered.
    public mutating func offer(_ snapshot: Snapshot, ts: Double, now: Date) -> Step {
        if let latest, ts <= latest.ts { return .none }
        latest = (ts, snapshot)
        return due(now)
    }

    /// The page booted (its `ready` message): it has nothing yet.
    public mutating func ready(now: Date) -> Step {
        isReady = true
        sentTs = nil
        sentAt = nil
        return due(now)
    }

    /// Whether the page can be seen (`LagoonVisibility`).
    public mutating func visible(_ visible: Bool, now: Date) -> Step {
        isVisible = visible
        return due(now)
    }

    /// A `later` came due.
    public mutating func tick(now: Date) -> Step {
        due(now)
    }

    /// The page is gone (the web view was dropped): the next one says `ready` for itself.
    public mutating func pageGone() {
        isReady = false
        sentTs = nil
        sentAt = nil
    }

    private mutating func due(_ now: Date) -> Step {
        guard isReady, isVisible, let latest else { return .none }
        if let sentTs, latest.ts <= sentTs { return .none }
        if let sentAt {
            let wait = Self.interval - now.timeIntervalSince(sentAt)
            if wait > 0 { return .later(wait) }
        }
        sentTs = latest.ts
        sentAt = now
        return .send(latest.snapshot)
    }
}

/// Whether the lagoon can be seen, and so whether it draws at all (spec §6): it is the page in front, its window can be
/// seen (`conchHidden`, from the window's occlusion: ordered out, minimised, another Space, wholly covered), and conch
/// isn't hidden. And how long it may stay unseen before its web view is let go to free the GPU's memory.
public struct LagoonVisibility: Equatable, Sendable {
    /// Ten minutes: a cold start is 3.5–4 s, which the page's fade-in covers.
    public static let dropAfter: TimeInterval = 600

    public var pageCurrent: Bool
    public var windowVisible: Bool
    public var appHidden: Bool

    public init(pageCurrent: Bool, windowVisible: Bool, appHidden: Bool) {
        self.pageCurrent = pageCurrent
        self.windowVisible = windowVisible
        self.appHidden = appHidden
    }

    public var visible: Bool { pageCurrent && windowVisible && !appHidden }

    /// Unseen since `since`: drop the web view now?
    public static func shouldDrop(hiddenSince since: Date?, now: Date) -> Bool {
        guard let since else { return false }
        return now.timeIntervalSince(since) >= dropAfter
    }
}
