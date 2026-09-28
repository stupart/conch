import Foundation

/// The one calm line about the natural voices, for the Mac's window and control bar and the iPhone's list.
///
/// Tyler, 2026-09-28: "Please add the visible thing but also it should 'just work'." The voices heal themselves
/// (src/voice-heal.ts), so the brand rule, speak when it matters, decides what shows:
///
/// - healthy: nothing, ever;
/// - healing (a first setup, or a background repair): a quiet line, no action, gone when it's done;
/// - really failed (its retries ran out, or a limit of this Mac): one clear line with the reason in plain words and one
///   action, shown once, dismissible, and not shown again for that failure once dismissed;
/// - out of room: said the same way, since only freeing space helps, though it carries on by itself when there is some;
/// - recovered: a brief "Natural voices are back" that goes by itself.
///
/// Pure, so the rules are tested here (NaturalVoicesNoticeTests) and both apps only host the words.
public struct NaturalVoicesNotice: Equatable, Sendable {
    public enum Tone: String, Equatable, Sendable {
        /// Setting up or coming back: quiet, nothing to do.
        case healing
        /// It can't carry on without you, or has stopped: one clear line, one action.
        case needsYou
        /// Recovered: brief, then gone.
        case back
    }

    public enum Action: String, Equatable, Sendable {
        /// Setup's Retry for the voices (`setup-retry`, src/setup.ts).
        case tryAgain
        /// The detail: Settings on the Mac, the daemon's sentence on the phone.
        case why

        public var title: String {
            switch self {
            case .tryAgain: return "Try again"
            case .why: return "Why?"
            }
        }
    }

    public let tone: Tone
    /// The line.
    public let text: String
    /// The control bar's second line, which has room for about twenty-five characters.
    public let short: String
    public let action: Action?
    /// What a dismissal remembers. Nil for lines that go by themselves.
    public let key: String?

    public var dismissible: Bool { key != nil }

    public init(tone: Tone, text: String, short: String, action: Action? = nil, key: String? = nil) {
        self.tone = tone
        self.text = text
        self.short = short
        self.action = action
        self.key = key
    }
}

/// What the notice remembers between one published status and the next, and across launches (the apps keep it in
/// UserDefaults): where the voices were, the back line's clock, and what has been dismissed.
public struct NaturalVoicesNoticeMemory: Codable, Equatable, Sendable {
    /// "", "ready", "off", "healing:first-run", "healing:repair", "blocked:<key>" or "failed:<key>".
    public var phase: String
    /// The back line shows until then (seconds since 1970).
    public var backUntil: Double?
    public var backText: String?
    /// Keys of lines dismissed since the voices last worked.
    public var dismissed: [String]

    public init(phase: String = "", backUntil: Double? = nil, backText: String? = nil, dismissed: [String] = []) {
        self.phase = phase
        self.backUntil = backUntil
        self.backText = backText
        self.dismissed = dismissed
    }
}

public enum NaturalVoicesNotices {
    /// How long "Natural voices are back" stays.
    public static let backSeconds: Double = 4

    /// The next memory, and what to show, from the latest published status. `now` is seconds since 1970.
    public static func step(
        _ memory: NaturalVoicesNoticeMemory,
        report: NaturalVoicesReport?,
        now: Double
    ) -> (memory: NaturalVoicesNoticeMemory, notice: NaturalVoicesNotice?) {
        guard let report else { return (memory, backLine(memory, now: now)) }
        var next = memory
        switch report.state {
        case "ready":
            let wasHealing = memory.phase.hasPrefix("healing") || memory.phase.hasPrefix("failed") || memory.phase.hasPrefix("blocked")
            next.phase = "ready"
            if wasHealing {
                // Back: said once, briefly. What was dismissed was for a failure that is over.
                next.backText = memory.phase == "healing:first-run" ? "Natural voices are ready" : "Natural voices are back"
                next.backUntil = now + backSeconds
                next.dismissed = []
            }
            return (next, backLine(next, now: now))

        case "setting-up":
            if report.waiting == "space" {
                let key = "space"
                next.phase = "blocked:\(key)"
                guard !memory.dismissed.contains(key) else { return (next, nil) }
                return (next, spaceLine(report, key: key))
            }
            // A try after a failure that was already said (a cool-down's attempt): no flash of "coming back" each time.
            if memory.phase.hasPrefix("failed") { return (next, nil) }
            let firstRun = report.healing == "first-run" && memory.phase != "healing:repair"
            next.phase = firstRun ? "healing:first-run" : "healing:repair"
            next.backUntil = nil
            return (next, healingLine(report, firstRun: firstRun))

        case "off":
            if isChoice(report) {
                next.phase = "off"
                return (next, nil)
            }
            let line = report.off == "unsupported" || report.reason == "needs Apple silicon"
                ? unsupportedNotice(report)
                : failedNotice(report)
            next.phase = "failed:\(line.key ?? "")"
            next.backUntil = nil
            guard let key = line.key, !memory.dismissed.contains(key) else { return (next, nil) }
            return (next, line)

        default:
            // "checking": the daemon starting; nothing to say, and nothing forgotten.
            return (next, backLine(next, now: now))
        }
    }

    /// Dismissed: that line is not shown again until the voices have worked again.
    public static func dismiss(_ memory: NaturalVoicesNoticeMemory, key: String) -> NaturalVoicesNoticeMemory {
        var next = memory
        if !next.dismissed.contains(key) { next.dismissed.append(key) }
        // Bounded: only ever a handful of kinds of failure.
        if next.dismissed.count > 16 { next.dismissed.removeFirst(next.dismissed.count - 16) }
        return next
    }

    /// When the line changes by itself (the back line fading), so the host can look again then. Nil: nothing timed.
    public static func nextChange(_ memory: NaturalVoicesNoticeMemory, now: Double) -> Double? {
        guard let until = memory.backUntil, until > now else { return nil }
        return until
    }

    /// The control bar's second line (its `news`), beside how many sessions are working: a line that needs you, or
    /// the voices coming back, before the count; the quiet healing line only when there is no count to show.
    public static func barNews(working: String?, notice: NaturalVoicesNotice?) -> String? {
        guard let notice else { return working }
        switch notice.tone {
        case .needsYou, .back: return notice.short
        case .healing: return working ?? notice.short
        }
    }

    // MARK: The words

    /// "Natural voices can't run here: they need Apple silicon. conch uses the Mac's own voice."
    public static func unsupportedLine(_ reason: String?) -> String {
        "Natural voices can't run here: \(plainLimit(reason)). conch uses the Mac's own voice."
    }

    static func isChoice(_ report: NaturalVoicesReport) -> Bool {
        if report.off == "choice" { return true }
        if report.off != nil { return false }
        // A daemon from before `off`: its opt-outs by their reasons.
        return report.reason?.hasPrefix("CONCH_TTS") == true
    }

    static func plainLimit(_ reason: String?) -> String {
        switch reason {
        case "needs Apple silicon": return "they need Apple silicon"
        case "needs a newer macOS": return "they need a newer macOS"
        case "no Metal GPU": return "this Mac's graphics can't run them"
        default: return reason.map { "\($0)" } ?? "this Mac can't run them"
        }
    }

    static func plainProblem(_ report: NaturalVoicesReport) -> String {
        if report.reason == "no uv" { return "conch is missing its installer" }
        switch report.problem {
        case "offline": return "they couldn't download"
        case "no-space": return "the disk is full"
        case "gpu": return "the graphics chip kept failing"
        case "env": return "their setup kept breaking"
        case "model": return "the voice files kept arriving damaged"
        default: return "setup kept failing"
        }
    }

    static func percentSuffix(_ report: NaturalVoicesReport) -> String {
        guard let percent = report.percent, percent > 0 else { return "" }
        return " \(percent)%"
    }

    static func healingLine(_ report: NaturalVoicesReport, firstRun: Bool) -> NaturalVoicesNotice {
        let offline = report.waiting == "network"
        if firstRun {
            return offline
                ? NaturalVoicesNotice(tone: .healing, text: "Natural voices will finish setting up when you're back online", short: "Voices wait for the network")
                : NaturalVoicesNotice(tone: .healing, text: "Setting up natural voices…\(percentSuffix(report))", short: "Setting up voices…\(percentSuffix(report))")
        }
        return offline
            ? NaturalVoicesNotice(tone: .healing, text: "Natural voices will come back when you're online", short: "Voices wait for the network")
            : NaturalVoicesNotice(tone: .healing, text: "Natural voices are coming back…\(percentSuffix(report))", short: "Voices coming back…")
    }

    static func spaceLine(_ report: NaturalVoicesReport, key: String) -> NaturalVoicesNotice {
        let needs = report.space.map { OnboardingDownload.size($0.needs) } ?? "more space"
        let free = report.space.map { OnboardingDownload.size($0.free) } ?? "less"
        return NaturalVoicesNotice(
            tone: .needsYou,
            text: "Natural voices need \(needs) free to finish setting up. This Mac has \(free); they'll carry on once there's room.",
            short: "Voices need disk space",
            action: .why,
            key: key
        )
    }

    static func unsupportedNotice(_ report: NaturalVoicesReport) -> NaturalVoicesNotice {
        NaturalVoicesNotice(
            tone: .needsYou,
            text: unsupportedLine(report.reason),
            short: "Natural voices can't run here",
            action: .why,
            key: "unsupported:\(report.reason ?? "")"
        )
    }

    static func failedNotice(_ report: NaturalVoicesReport) -> NaturalVoicesNotice {
        // Try again can't bring back a missing installer: that one says why instead.
        let missingInstaller = report.reason == "no uv"
        return NaturalVoicesNotice(
            tone: .needsYou,
            text: "Natural voices stopped: \(plainProblem(report)). conch is using the Mac's own voice for now.",
            short: "Natural voices stopped",
            action: missingInstaller ? .why : .tryAgain,
            key: "failed:\(report.reason ?? ""):\(report.problem ?? "")"
        )
    }

    static func backLine(_ memory: NaturalVoicesNoticeMemory, now: Double) -> NaturalVoicesNotice? {
        guard let until = memory.backUntil, now < until else { return nil }
        let text = memory.backText ?? "Natural voices are back"
        return NaturalVoicesNotice(tone: .back, text: text, short: text)
    }
}
