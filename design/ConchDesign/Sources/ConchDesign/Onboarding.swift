import Foundation

// First-run setup, as data: the steps, where a person is in them, and the rule for what happens next. The Mac window
// and the iPhone screens (OnboardingMac.swift, OnboardingPhone.swift) draw this; neither decides it. It is persisted as
// JSON, so closing the window, a relaunch for a permission, or a crash all come back to the same place.

/// One screen of the Mac's setup.
public enum OnboardingStep: String, CaseIterable, Codable, Sendable {
    case welcome
    case agents
    case permissions
    case voice
    case phone
    case practice
    case done

    /// Every step the rail can list, in order. Welcome and the end are not steps a person does. Which of them a Mac shows
    /// is `OnboardingReadiness.rail`: Try it only with a daemon that can run the practice turn.
    public static let rail: [OnboardingStep] = [.agents, .permissions, .voice, .phone, .practice]

    public var title: String {
        switch self {
        case .welcome: "Welcome"
        case .agents: "Agents"
        case .permissions: "Permissions"
        case .voice: "Voice"
        case .phone: "iPhone"
        case .practice: "Try it"
        case .done: "Done"
        }
    }
}

/// Where a rail step stands.
public enum OnboardingMark: String, Codable, Sendable {
    /// Not reached, or reached and not finished.
    case todo
    case done
    /// Skipped: left for later, and counted by the menu's "Finish setting up".
    case later
}

/// How far the phone has got through its own setup, as the phone reports it through the pairing. The Mac mirrors it
/// while it waits, so the person can see the phone is moving without looking back and forth.
public enum PhoneSetupStage: String, CaseIterable, Codable, Sendable, Comparable {
    /// The Mac shows its code; no phone has scanned it.
    case waiting
    /// A phone scanned the code and the two are exchanging keys.
    case connecting
    case paired
    case notifications
    case microphone
    case tour
    case finished

    /// The rows the Mac shows while the phone sets itself up. No notifications row: the iPhone app sends none yet, so its
    /// setup doesn't ask for them (decision 11); `notifications` stays in the enum for when it does.
    public static let mirrored: [PhoneSetupStage] = [.paired, .microphone, .tour]

    public var title: String {
        switch self {
        case .waiting: "Waiting for your iPhone"
        case .connecting: "Connecting"
        case .paired: "Paired"
        case .notifications: "Notifications"
        case .microphone: "Microphone"
        case .tour: "Quick tour"
        case .finished: "All set"
        }
    }

    public static func < (lhs: Self, rhs: Self) -> Bool {
        allCases.firstIndex(of: lhs)! < allCases.firstIndex(of: rhs)!
    }
}

/// The phone's half of setup, as the Mac holds it.
public struct PhoneHandoff: Codable, Equatable, Sendable {
    /// The phone's own name, once it has said it ("Tyler's iPhone").
    public var device: String?
    /// The furthest stage the phone has reported.
    public var stage: PhoneSetupStage
    /// Permissions the person said no to on the phone, so the Mac can say so rather than tick them.
    public var declined: Set<PhoneSetupStage>

    public init(device: String? = nil, stage: PhoneSetupStage = .waiting, declined: Set<PhoneSetupStage> = []) {
        self.device = device
        self.stage = stage
        self.declined = declined
    }
}

/// What the Mac can see for itself right now, whatever setup has recorded: agents wired, permissions granted, the phone
/// paired. A step that is already true is not asked about again, and a person who set conch up before setup existed
/// is not walked through it from the start.
public struct OnboardingReadiness: Equatable, Sendable {
    /// Agents found on this Mac, and how many of them have conch's hooks and plugin.
    public var agentsFound: Int
    public var agentsConnected: Int
    /// The one permission voice can't work without.
    public var microphone: Bool
    /// Of the three setup asks for (`setupAsks`), how many still want the person. Screen Recording and Notifications are
    /// asked the first time something needs them, never in setup, so they never count here.
    public var permissionsMissing: Int
    /// Speech recognition and the natural voices are on this Mac and working.
    public var engineReady: Bool
    public var phonePaired: Bool
    /// The daemon can run the practice turn (it publishes `features.practice`, `OnboardingReports.practiceAvailable`).
    /// With one that can't (an older daemon, or none answering), the rail has no Try it and You're set follows iPhone:
    /// setup never shows a step that does nothing.
    public var practiceAvailable: Bool

    public init(agentsFound: Int = 0, agentsConnected: Int = 0, microphone: Bool = false, permissionsMissing: Int = 3,
                engineReady: Bool = false, phonePaired: Bool = false, practiceAvailable: Bool = false) {
        self.agentsFound = agentsFound
        self.agentsConnected = agentsConnected
        self.microphone = microphone
        self.permissionsMissing = permissionsMissing
        self.engineReady = engineReady
        self.phonePaired = phonePaired
        self.practiceAvailable = practiceAvailable
    }

    /// A fresh Mac: nothing found, nothing granted.
    public static let fresh = OnboardingReadiness()

    /// What setup asks for: the three the voice loop needs, in the order it needs them (hearing you, then typing your
    /// reply into Terminal). The two people skip are asked in context instead.
    public static let setupAsks: [ConchPermission] = [.microphone, .accessibility, .automation]

    /// How many of `setupAsks` still want the person: off, never asked, or on but a reopen away. Allowed is done; set by
    /// whoever manages the Mac is nothing the person can do; and an answer macOS can't give yet (Automation while Terminal
    /// is closed, or not read yet) is not called off.
    public static func permissionsMissing(_ statuses: [ConchPermission: ConchPermissionStatus]) -> Int {
        missingAsks(statuses).count
    }

    /// Which of `setupAsks` still want the person, in order: what Welcome back lists.
    public static func missingAsks(_ statuses: [ConchPermission: ConchPermissionStatus]) -> [ConchPermission] {
        setupAsks.filter { permission in
            switch statuses[permission] {
            case .denied?, .notAsked?, .needsRelaunch?: true
            case .granted?, .restricted?, .unknown?, nil: false
            }
        }
    }

    /// The steps this Mac's rail lists.
    public var rail: [OnboardingStep] {
        OnboardingStep.rail.filter { $0 != .practice || practiceAvailable }
    }

    /// Whether a step needs nothing more from the person. Trying it is never already done: it is the part that shows.
    public func satisfies(_ step: OnboardingStep) -> Bool {
        switch step {
        case .agents: agentsConnected > 0 && agentsConnected == agentsFound
        case .permissions: microphone && permissionsMissing == 0
        case .voice: microphone && engineReady
        case .phone: phonePaired
        case .welcome, .practice, .done: false
        }
    }

    /// conch has been set up on this Mac before, by hand or by an older version: an agent is wired and the microphone
    /// allowed. Someone like that gets "Welcome back" and only what is missing.
    public var isReturning: Bool { agentsConnected > 0 && microphone }

    /// What "Welcome back" asks about. A returning Mac already has an agent wired, and which others it wires was its own
    /// choice, so agents are never missing; the practice turn is never missing either.
    public var missingForReturning: [OnboardingStep] {
        rail.filter { $0 != .agents && $0 != .practice && !satisfies($0) }
    }
}

/// What opens when conch launches.
public enum OnboardingEntry: Equatable, Sendable {
    /// Nothing: setup is finished, or was put away and the menu reminds instead.
    case none
    /// The whole flow, from Welcome.
    case firstRun
    /// Back where the person left off: after a relaunch for a permission, or a launch that interrupted setup.
    case resume(OnboardingStep)
    /// Set up before, by hand or by an older conch: only the steps still missing.
    case welcomeBack(missing: [OnboardingStep])
}

/// Everything that moves setup on.
public enum OnboardingEvent: Equatable, Sendable {
    /// Welcome's Set up conch: the first rail step, and the downloads begin.
    case begin
    /// The step is done (its Continue).
    case next
    /// The step is left for later (its Skip for now).
    case skip
    /// A step picked in the rail.
    case open(OnboardingStep)
    /// The phone reported a stage through the pairing.
    case phone(PhoneHandoff)
    /// conch is about to reopen itself for a grant that only reaches a new process (Screen Recording).
    case reopenForGrant
    /// The app launched: a reopen for a grant is used up.
    case launched
    /// The window was closed before the end: nothing is lost, and it doesn't reopen by itself.
    case close
    /// Settings › Setup › Run setup again.
    case restart
    /// Welcome back's Done: finished with what it asked. What is still off stays in Settings › Setup, and nothing
    /// reminds.
    case finish
}

/// Where a person is in setup. Persisted as JSON (`~/.config/conch/onboarding.json`), and read back at launch.
public struct OnboardingProgress: Codable, Equatable, Sendable {
    public static let currentVersion = 1

    public var version: Int
    public var step: OnboardingStep
    public var marks: [OnboardingStep: OnboardingMark]
    public var phone: PhoneHandoff
    /// Reached the end at least once.
    public var finished: Bool
    /// The window was closed part way: the menu says "Finish setting up" instead of the window coming back.
    public var putAway: Bool
    /// conch quit to reopen for a grant, and should come straight back to this step.
    public var reopening: Bool

    public init(step: OnboardingStep = .welcome, marks: [OnboardingStep: OnboardingMark] = [:], phone: PhoneHandoff = .init(),
                finished: Bool = false, putAway: Bool = false, reopening: Bool = false) {
        self.version = Self.currentVersion
        self.step = step
        self.marks = marks
        self.phone = phone
        self.finished = finished
        self.putAway = putAway
        self.reopening = reopening
    }

    public func mark(_ step: OnboardingStep) -> OnboardingMark { marks[step] ?? .todo }

    /// Rail steps left for later or not yet done, and not true on this Mac by now: the menu's "Finish setting up conch ·
    /// 2 left: Permissions, iPhone". A permission skipped here and allowed later in System Settings is not left.
    public func remaining(_ readiness: OnboardingReadiness) -> [OnboardingStep] {
        readiness.rail.filter { mark($0) != .done && !readiness.satisfies($0) }
    }

    /// Where Welcome back starts: on the first thing missing, with everything it isn't asking about ticked (a returning
    /// Mac's agents among them: one is wired, which is what set up means). Never the practice turn.
    public static func welcomingBack(missing: [OnboardingStep], readiness: OnboardingReadiness) -> OnboardingProgress {
        var progress = OnboardingProgress(step: missing.first ?? .done)
        for step in readiness.rail where !missing.contains(step) && step != .practice {
            progress.marks[step] = .done
        }
        return progress
    }

    /// What to open at launch, from what setup recorded (nil: never started) and what the Mac can see now.
    public static func entry(_ progress: OnboardingProgress?, readiness: OnboardingReadiness) -> OnboardingEntry {
        guard let progress else {
            guard readiness.isReturning else { return .firstRun }
            let missing = readiness.missingForReturning
            return missing.isEmpty ? .none : .welcomeBack(missing: missing)
        }
        if progress.reopening { return .resume(progress.step) }
        if progress.finished || progress.putAway { return .none }
        return progress.step == .welcome ? .firstRun : .resume(progress.step)
    }

    /// Setup after `event`. Pure: the window, the daemon and the phone all feed this, and draw what it returns.
    public func applying(_ event: OnboardingEvent, readiness: OnboardingReadiness) -> OnboardingProgress {
        var next = self
        switch event {
        case .begin:
            next.putAway = false
            next.step = next.firstOpen(after: nil, readiness: readiness)
        case .next:
            // Only a rail step moves on: a stray Continue at the end must not wind setup back to something left for later.
            guard OnboardingStep.rail.contains(step) else { break }
            next.settle(step, as: .done)
            next.step = next.firstOpen(after: step, readiness: readiness)
        case .skip:
            guard OnboardingStep.rail.contains(step) else { break }
            next.settle(step, as: .later)
            next.step = next.firstOpen(after: step, readiness: readiness)
        case let .open(target):
            next.putAway = false
            next.step = target
        case let .phone(report):
            // Stages only move forward: a late report from a slow link never undoes one already seen.
            guard report.stage >= next.phone.stage || report.device != next.phone.device else { break }
            next.phone = report
            if report.stage == .finished {
                next.marks[.phone] = .done
                // The phone hands back: a Mac still waiting on the iPhone step moves on by itself, and one that has
                // moved on already just ticks the step.
                if next.step == .phone { next.step = next.firstOpen(after: .phone, readiness: readiness) }
            }
        case .reopenForGrant:
            next.reopening = true
        case .launched:
            next.reopening = false
        case .close:
            if !next.finished { next.putAway = true }
        case .restart:
            next = OnboardingProgress(phone: phone)
            next.step = .agents
        case .finish:
            next.putAway = false
            next.step = .done
        }
        if next.step == .done { next.finished = true }
        return next
    }

    private mutating func settle(_ step: OnboardingStep, as mark: OnboardingMark) {
        guard OnboardingStep.rail.contains(step) else { return }
        // Done beats later: skipping past a step that was finished earlier doesn't unfinish it.
        if marks[step] != .done { marks[step] = mark }
    }

    /// The next rail step after `step` that still wants the person: not done, and not already true on this Mac.
    /// Already-true steps are ticked on the way past. Nothing left is the end.
    private mutating func firstOpen(after step: OnboardingStep?, readiness: OnboardingReadiness) -> OnboardingStep {
        let rail = readiness.rail
        let start = step.flatMap { rail.firstIndex(of: $0) }.map { $0 + 1 } ?? 0
        for candidate in rail[min(start, rail.count)...] {
            if mark(candidate) == .done { continue }
            if readiness.satisfies(candidate), mark(candidate) != .later {
                marks[candidate] = .done
                continue
            }
            return candidate
        }
        return .done
    }
}

// Marks keyed by step name on disk (`"permissions": "later"`), not an array of pairs.
extension OnboardingStep: CodingKeyRepresentable {}
