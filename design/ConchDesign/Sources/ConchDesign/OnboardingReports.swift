import Foundation

// What the daemon says, turned into what setup draws. The daemon publishes the speech engine and the natural voices
// (`speechEngine`, `naturalVoices` in the published state) and answers `setup-status` about each agent (src/setup.ts);
// these read them as data and decide the rows, the downloads and the readiness, so the rules are tested here and the Mac
// app only fetches and hosts.

/// The speech engine as published (`SpeechEngineStatus`, src/speech-engine.ts), the parts setup reads.
public struct SpeechEngineReport: Decodable, Equatable, Sendable {
    public struct Progress: Decodable, Equatable, Sendable {
        public let bytes: Double
        public let total: Double

        public init(bytes: Double, total: Double) {
            self.bytes = bytes
            self.total = total
        }
    }

    /// What stopped the last attempt, when it is one a person can act on: `offline`, or `no-space` with its figures.
    public struct Problem: Decodable, Equatable, Sendable {
        public let kind: String
        public let needs: Double?
        public let free: Double?

        public init(kind: String, needs: Double? = nil, free: Double? = nil) {
            self.kind = kind
            self.needs = needs
            self.free = free
        }
    }

    /// "checking" | "downloading" | "ready" | "off"
    public let state: String
    public let reason: String?
    public let progress: Progress?
    public let problem: Problem?
    /// While a failed attempt waits to try again: when, in epoch milliseconds.
    public let retryAt: Double?

    public init(state: String, reason: String? = nil, progress: Progress? = nil, problem: Problem? = nil, retryAt: Double? = nil) {
        self.state = state
        self.reason = reason
        self.progress = progress
        self.problem = problem
        self.retryAt = retryAt
    }
}

/// The natural voices as published (`NaturalVoicesStatus`, src/voice-env.ts), the parts setup reads.
public struct NaturalVoicesReport: Decodable, Equatable, Sendable {
    public struct Space: Decodable, Equatable, Sendable {
        public let needs: Double
        public let free: Double

        public init(needs: Double, free: Double) {
            self.needs = needs
            self.free = free
        }
    }

    /// "checking" | "setting-up" | "ready" | "off"
    public let state: String
    public let reason: String?
    /// The build step it's on, as numbers: never read out of the sentence.
    public let step: Int?
    public let steps: Int?
    /// "prefetch" (Kokoro's own model, after the build) or "elsewhere" (another conch is building them).
    public let stage: String?
    public let space: Space?

    public init(state: String, reason: String? = nil, step: Int? = nil, steps: Int? = nil, stage: String? = nil, space: Space? = nil) {
        self.state = state
        self.reason = reason
        self.step = step
        self.steps = steps
        self.stage = stage
        self.space = space
    }
}

/// One agent as `setup-status` reports it (src/setup.ts, `AgentSetupReport`).
public struct AgentSetupReport: Decodable, Equatable, Sendable {
    public struct Copies: Decodable, Equatable, Sendable {
        public let conch: String
        public let shell: String
    }

    public let agent: String
    public let found: Bool
    public let path: String?
    public let version: String?
    public let source: String?
    public let hooksWired: Bool
    public let pluginInstalled: Bool
    public let signedIn: Bool?
    public let heard: Bool
    public let openBeforeHooks: Int
    public let copies: Copies?

    public init(agent: String, found: Bool, path: String? = nil, version: String? = nil, source: String? = nil, hooksWired: Bool = false,
                pluginInstalled: Bool = false, signedIn: Bool? = nil, heard: Bool = false, openBeforeHooks: Int = 0, copies: Copies? = nil) {
        self.agent = agent
        self.found = found
        self.path = path
        self.version = version
        self.source = source
        self.hooksWired = hooksWired
        self.pluginInstalled = pluginInstalled
        self.signedIn = signedIn
        self.heard = heard
        self.openBeforeHooks = openBeforeHooks
        self.copies = copies
    }

    /// conch's hooks and its plugin are both in the agent's own settings.
    public var connected: Bool { hooksWired && pluginInstalled }
}

/// Setup's practice turn as published (`PublishedPractice`, src/practice.ts), while one runs.
public struct PracticeReport: Decodable, Equatable, Sendable {
    public struct Problem: Decodable, Equatable, Sendable {
        /// "phone" | "another-mac" | "recognition" | "busy" | "mic-open" | "closing" | "none" | "unavailable"
        public let reason: String
        /// The daemon's own words, shown as they are.
        public let words: String

        public init(reason: String, words: String) {
            self.reason = reason
            self.words = words
        }
    }

    public let sessionId: String
    /// "speaking" | "listening" | "ready" | "viewed"
    public let stage: String
    public let heard: String?
    public let silent: Bool?
    public let listening: Bool?
    public let problem: Problem?
    public let systemVoice: Bool?

    public init(sessionId: String = "conch-practice", stage: String, heard: String? = nil, silent: Bool? = nil, listening: Bool? = nil,
                problem: Problem? = nil, systemVoice: Bool? = nil) {
        self.sessionId = sessionId
        self.stage = stage
        self.heard = heard
        self.silent = silent
        self.listening = listening
        self.problem = problem
        self.systemVoice = systemVoice
    }

    /// What the tour learns from it: every fact it states, each harmless to hear twice (`TourProgress.applying`).
    public var tourEvents: [TourEvent] {
        var events: [TourEvent] = []
        if stage != "speaking" { events.append(.spoken) }
        if let heard, !heard.isEmpty { events.append(.heard(heard)) }
        if silent == true, listening != true { events.append(.silent) }
        // Always said, so a go that's under way again clears what the last one couldn't do.
        events.append(.problem(problem?.words))
        if stage == "viewed" { events.append(.readyOpened) }
        return events
    }
}

/// What the setup window is doing with an agent right now, which the daemon's report can't know.
public enum AgentActivity: Equatable, Sendable {
    case connecting
    case installing(line: String)
    case failed(reason: String, command: String)
}

public enum OnboardingReports {
    // MARK: Downloads

    public static let speechTitle = "Speech recognition"
    public static let voicesTitle = "Natural voices"

    /// Speech recognition's line in the tray. `secondsLeft` is the app's own estimate from the bytes it has seen move.
    public static func speechRecognition(_ report: SpeechEngineReport?, secondsLeft: Int? = nil, now: Date = Date()) -> OnboardingDownload {
        OnboardingDownload(id: "stt", title: speechTitle, purpose: "Hears your replies", state: speechState(report, secondsLeft: secondsLeft, now: now),
                           canRetry: report?.state == "off" && (report?.reason == "download failed"))
    }

    static func speechState(_ report: SpeechEngineReport?, secondsLeft: Int?, now: Date) -> OnboardingDownload.State {
        guard let report else { return .installing("Checking") }
        let done = report.progress?.bytes ?? 0
        let total = report.progress?.total ?? 0
        if report.problem?.kind == "no-space", let needs = report.problem?.needs, let free = report.problem?.free {
            return .noSpace(needs: needs, free: free)
        }
        switch report.state {
        case "ready":
            return .ready
        case "downloading":
            if report.problem?.kind == "offline" { return .offline(done: done, total: total) }
            if let retryAt = report.retryAt {
                let wait = max(0, retryAt / 1000 - now.timeIntervalSince1970)
                let when = wait < 90 ? "in a minute" : "in \(Int((wait / 60).rounded())) minutes"
                let at = done > 0 ? " at \(OnboardingDownload.size(done))" : ""
                return .failed("The download stopped\(at). Trying again \(when); it carries on from there.")
            }
            return .downloading(done: done, total: total, secondsLeft: secondsLeft)
        case "off":
            if report.problem?.kind == "offline" { return .failed("Couldn't download it: this Mac is offline.") }
            if report.reason == "download failed" { return .failed("Couldn't download speech recognition.") }
            return .failed("conch's speech engine is missing a part. Reinstall conch to put it back.")
        default:
            return .installing("Checking")
        }
    }

    /// The natural voices' line in the tray; nil when this conch speaks without them by setting (`CONCH_TTS=say`).
    public static func naturalVoices(_ report: NaturalVoicesReport?) -> OnboardingDownload? {
        guard let report else { return nil }
        var canRetry = false
        let state: OnboardingDownload.State
        if let space = report.space {
            state = .noSpace(needs: space.needs, free: space.free)
            canRetry = report.state == "off"
        } else {
            switch report.state {
            case "ready":
                state = .ready
            case "setting-up", "checking":
                state = .installing(voicesStep(report))
            default:
                if report.reason == "needs Apple silicon" {
                    state = .failed("Natural voices need Apple silicon. conch speaks with the Mac's own voice.")
                } else if report.reason?.hasPrefix("CONCH_TTS") == true {
                    state = .failed("Off in Settings. conch speaks with the Mac's own voice.")
                } else if report.reason == "no uv" {
                    state = .failed("conch is missing its voice installer. Reinstall conch to put it back.")
                } else {
                    state = .failed("Couldn't set up the voices. conch speaks with the Mac's own voice meanwhile.")
                    canRetry = true
                }
            }
        }
        return OnboardingDownload(id: "voices", title: voicesTitle, purpose: "Reads turns aloud", state: state, canRetry: canRetry)
    }

    /// "Installing the voices (1.3 GB), step 3 of 4": which step, from the numbers the daemon publishes.
    public static func voicesStep(_ report: NaturalVoicesReport) -> String {
        if report.state == "checking" { return "Checking the voices" }
        if let step = report.step, let steps = report.steps {
            let doing = ["Installing Python", "Preparing the voices", "Installing the voices (1.3 GB)", "Checking the voices"]
            let words = (1...doing.count).contains(step) ? doing[step - 1] : "Setting up the voices"
            return "\(words), step \(step) of \(steps)"
        }
        switch report.stage {
        case "prefetch": return "Downloading the voices (360 MB)"
        case "elsewhere": return "Another conch is setting them up"
        default: return "Getting the voices ready"
        }
    }

    /// The voice step's ring, from the same report: ready plays, building says where it is, off says why.
    public static func ring(_ report: NaturalVoicesReport?, playing: Int?) -> VoiceRing {
        guard let report else { return .ready(playing: playing) }
        switch report.state {
        case "ready":
            return .ready(playing: playing)
        case "off":
            return .unavailable(report.reason == "needs Apple silicon"
                ? "Natural voices need Apple silicon. conch speaks with the Mac's own voice."
                : "The natural voices aren't set up. conch speaks with the Mac's own voice.")
        default:
            if let step = report.step, let steps = report.steps { return .settingUp("Step \(step) of \(steps)") }
            return .settingUp(report.stage == "prefetch" ? "Downloading the voices" : "Getting ready")
        }
    }

    /// The voices are done with: ready, or off for a reason nothing in setup changes (an Intel Mac, `CONCH_TTS=say`).
    public static func voicesSettled(_ report: NaturalVoicesReport?) -> Bool {
        guard let report else { return true }
        if report.state == "ready" { return true }
        return report.state == "off" && (report.reason == "needs Apple silicon" || report.reason?.hasPrefix("CONCH_TTS") == true)
    }

    // MARK: Agents

    /// One agent's row: what the window is doing with it first, then what the daemon found. Green only once conch has
    /// heard from it.
    public static func agent(_ report: AgentSetupReport, activity: AgentActivity? = nil) -> OnboardingAgent? {
        guard let kind = OnboardingAgent.Kind(rawValue: report.agent) else { return nil }
        let version = report.version ?? "unknown"
        let from = report.source ?? ""
        let copies = report.copies.map { OnboardingAgent.Copies(conch: $0.conch, shell: $0.shell) }
        switch activity {
        case let .installing(line)?:
            return OnboardingAgent(kind, .installing(line: line))
        case let .failed(reason, command)?:
            return OnboardingAgent(kind, .failed(reason: reason, command: command))
        case .connecting?:
            return OnboardingAgent(kind, .connecting(version: version, from: from), copies: copies)
        case nil:
            break
        }
        guard report.found else { return OnboardingAgent(kind, .missing) }
        guard report.connected else {
            return OnboardingAgent(kind, .found(version: version, from: from),
                                   note: report.hooksWired ? "Its hooks are in. Connect adds conch's tools too." : nil, copies: copies)
        }
        if kind == .codex, report.signedIn == false { return OnboardingAgent(kind, .signIn(version: version), copies: copies) }
        guard report.heard else {
            // Wired, and not heard from yet: the file write isn't the proof, a turn reaching conch is.
            let note = kind == .claude
                ? (report.openBeforeHooks > 0 ? nil : "conch shows Connected once Claude Code finishes a turn.")
                : "conch shows Connected once Codex's hooks reach it. Meanwhile it reads Codex's sessions from Codex itself."
            return OnboardingAgent(kind, .connecting(version: version, from: from), openSessions: report.openBeforeHooks, note: note, copies: copies)
        }
        return OnboardingAgent(kind, .connected(version: version, from: from), openSessions: report.openBeforeHooks, copies: copies)
    }

    // MARK: The iPhone

    /// The phone's half of setup, from the published `phone` block's parts (Wave B's contract): nil while no phone is
    /// paired. A phone paired without a setup to report (paired before setup existed, or an app without one) has nothing
    /// more to do, so it is finished.
    public static func phoneHandoff(paired: Bool, device: String?, stage: String?, declined: [String]) -> PhoneHandoff? {
        let reported = stage.flatMap(PhoneSetupStage.init(rawValue:))
        guard paired || (reported ?? .waiting) > .waiting else { return nil }
        let refused = Set(declined.compactMap(PhoneSetupStage.init(rawValue:)))
        guard let reported, reported > .waiting else {
            return PhoneHandoff(device: device, stage: .finished, declined: refused)
        }
        return PhoneHandoff(device: device, stage: reported, declined: refused)
    }

    /// Whether this Mac has a phone set up, for setup's readiness (Welcome back, the menu's count, the rail). The daemon's
    /// `paired` is set only by a fresh key exchange or a setup report, so a phone paired for weeks reads false until it
    /// next connects; a Mac with the phone setting on and a relay pairing on disk was set up for one, and isn't asked
    /// again. Neither alone is enough: the setting is turned on by reaching the iPhone step, and a pairing is minted
    /// whenever the relay is on.
    public static func phoneSetUp(paired: Bool?, enabled: Bool?, pairingOnRecord: Bool) -> Bool {
        paired == true || (enabled == true && pairingOnRecord)
    }

    /// What the iPhone step shows: the phone's own progress once it has scanned, else the code, else why there's none.
    public static func phoneStep(handoff: PhoneHandoff?, relay: Bool, failure: String?) -> PhoneStepState {
        if let handoff {
            switch handoff.stage {
            case .finished: return .finished(handoff)
            case .waiting: break
            case .connecting: return .connecting
            default: return .settingUp(handoff)
            }
        }
        if let failure { return .failed(failure) }
        return .waiting(relay: relay)
    }

    // MARK: Try it

    /// The daemon can run the practice turn: it publishes `features.practice` (src/practice.ts). An older daemon doesn't,
    /// and neither does one that isn't answering: Try it stays off the rail.
    public static func practiceAvailable(feature: Int?) -> Bool {
        (feature ?? 0) >= 1
    }

    /// The same, with unknown kept apart from no: nil until the daemon has published its state at all this launch (after
    /// a reboot `/tmp` is empty until it has), when Try it waits rather than skipping itself on a guess.
    public static func practiceAvailability(feature: Int?, published: Bool) -> Bool? {
        published ? practiceAvailable(feature: feature) : nil
    }

    /// Where Try it stands before Start does anything: the microphone, speech recognition, then what the daemon last said
    /// about starting. Unknown is never a no: a microphone macOS hasn't answered for yet doesn't hold Start.
    public static func practiceStart(microphone: ConchPermissionStatus?, speech: SpeechEngineReport?, refusal: PracticeReport.Problem? = nil,
                                     starting: Bool = false) -> PracticeStartState {
        if starting { return .starting }
        switch microphone {
        case .denied?, .notAsked?, .needsRelaunch?:
            return .needsMicrophone(action: (microphone?.action ?? .ask).title)
        case .restricted?:
            return .problem("Whoever manages this Mac has turned the microphone off for conch.")
        case .granted?, .unknown?, nil:
            break
        }
        switch speech?.state {
        case "ready"?:
            break
        case "off"?:
            return .problem("Speech recognition isn't working, so conch can't hear you. Settings › Setup says why.")
        default:
            let fraction = speech?.progress.map { $0.total > 0 ? $0.bytes / $0.total : 0 } ?? 0
            return .waitingForRecognition(fraction)
        }
        guard let refusal else { return .ready }
        switch refusal.reason {
        case "phone", "another-mac": return .audioElsewhere(refusal.words)
        default: return .problem(refusal.words)
        }
    }

    // MARK: Streamed requests

    /// The kinds a streamed setup request sends before its reply (src/setup.ts `SetupLine`): the microphone's
    /// levels and an installer's lines. Any other kind is the reply, the daemon's last word on the connection.
    public static let streamedKinds: Set<String> = ["mic-level", "setup-install-line"]

    /// Whether one line of a streamed request is its reply, by its kind: never by being the last line read. A line
    /// with no kind this app can read is a reply too (and read as one it can't). A connection that ends after only
    /// streamed lines had no reply: the daemon went away part way, restarted or quit, which is not an older daemon's
    /// answer.
    public static func isStreamReply(kind: String?) -> Bool {
        guard let kind else { return true }
        return !streamedKinds.contains(kind)
    }

    // MARK: Readiness

    /// At launch, for a Mac with no setup on record: whether speech recognition and the voices count as there, for
    /// Welcome back. Only a report that says one can't work counts against it: speech recognition off, or the voices off
    /// for a reason setup can change. Unknown, still checking, downloading, or being built (a model fetched again, the
    /// voices' environment rebuilt after an update) is conch getting on with it by itself, which no step asks the person
    /// to do: a set-up Mac is never welcomed back for it.
    public static func engineReadyAtLaunch(speech: SpeechEngineReport?, voices: NaturalVoicesReport?) -> Bool {
        if speech?.state == "off" { return false }
        guard let voices, voices.state == "off" else { return true }
        return voicesSettled(voices)
    }

    /// What the Mac can see for itself, from the agents' report (nil: the daemon hasn't answered), the permissions, the
    /// downloads and the phone.
    public static func readiness(agents: [AgentSetupReport]?, permissions: [ConchPermission: ConchPermissionStatus],
                                 speech: SpeechEngineReport?, voices: NaturalVoicesReport?, phonePaired: Bool,
                                 practiceAvailable: Bool = false) -> OnboardingReadiness {
        let found = agents?.filter(\.found) ?? []
        return OnboardingReadiness(
            agentsFound: found.count,
            // Hooks in is what a Mac set up by hand has: the loop works, whatever the plugin.
            agentsConnected: found.filter(\.hooksWired).count,
            microphone: permissions[.microphone] == .granted,
            permissionsMissing: OnboardingReadiness.permissionsMissing(permissions),
            engineReady: speech?.state == "ready" && voicesSettled(voices),
            phonePaired: phonePaired,
            practiceAvailable: practiceAvailable
        )
    }
}
