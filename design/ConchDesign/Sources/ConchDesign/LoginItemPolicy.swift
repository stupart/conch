import Foundation

// MARK: - Opening conch at login

/// What macOS says about conch as a login item: `SMAppService.Status`, in conch's own type so the rules below are
/// testable without registering anything. The Mac app reads `SMAppService.mainApp` and maps it (`LoginItem`,
/// OnboardingSupport.swift).
public enum LoginItemStatus: String, Equatable, Sendable {
    case enabled, requiresApproval, notRegistered, notFound
}

/// The person's choice, from a switch (You're set, Settings), or conch's first-launch default, which is on.
public enum LoginItemChoice: String, Equatable, Sendable {
    case on, off
}

/// What conch remembers about opening at login. Kept in the app's defaults.
public struct LoginItemRecord: Equatable, Sendable {
    /// Nil until something decided: a switch, or the first launch's registration.
    public var choice: LoginItemChoice?
    /// conch has registered here, tried to, or found itself registered: a launch never registers again. Whatever
    /// happens after that (a switch turned off in conch, or in System Settings) stands.
    public var registeredOnce: Bool
    /// The one line saying so, still to be seen.
    public var announce: Bool
    /// The first launch's registration was refused by macOS: the line says so, with the fix.
    public var refused: Bool

    public init(choice: LoginItemChoice? = nil, registeredOnce: Bool = false, announce: Bool = false, refused: Bool = false) {
        self.choice = choice
        self.registeredOnce = registeredOnce
        self.announce = announce
        self.refused = refused
    }
}

/// One line about opening at login: the first launch's notice, or the note beside a switch. Some carry a button to
/// System Settings › General › Login Items (`SMAppService.openSystemSettingsLoginItems()`).
public enum LoginItemLine: Equatable, Sendable {
    /// Registered at first launch. macOS shows its own notice; this is conch's.
    case added
    /// Registered, and macOS wants it allowed first.
    case needsApproval
    /// macOS refused to add conch.
    case refused
    /// macOS refused to remove conch.
    case refusedOff
    /// conch registers only from Applications: a build run from Xcode or a checkout would register a copy that moves.
    case notInApplications

    public var words: String {
        switch self {
        case .added: "conch opens when you log in, so your agents can reach you. Turn this off in Settings."
        case .needsApproval: "Allow conch in System Settings › General › Login Items."
        case .refused: "macOS didn't add conch. Allow conch in System Settings › General › Login Items."
        case .refusedOff: "macOS didn't remove conch. Turn it off in System Settings › General › Login Items."
        case .notInApplications: "Move conch to your Applications folder, then turn this on."
        }
    }

    /// Whether the line's fix is in System Settings › General › Login Items, so it carries the button that opens it.
    public var opensLoginItems: Bool {
        switch self {
        case .needsApproval, .refused, .refusedOff: true
        case .added, .notInApplications: false
        }
    }

    /// The button's words.
    public static let openLoginItems = "Open Login Items"
}

/// The rules: when a launch registers, what a switch shows, and what conch says.
public enum LoginItemPolicy {
    /// What the switch shows: registered, even while macOS waits for it to be allowed (the note says so).
    public static func isOn(_ status: LoginItemStatus) -> Bool {
        status == .enabled || status == .requiresApproval
    }

    /// Installed: in /Applications or ~/Applications, directly or through a link there (Homebrew links
    /// /Applications/conch.app to the copy in its Cellar). `linkedCopies` are where those links lead, resolved.
    public static func installed(bundlePath: String, home: String, linkedCopies: [String] = []) -> Bool {
        let path = bundlePath.hasSuffix("/") ? String(bundlePath.dropLast()) : bundlePath
        if path.hasPrefix("/Applications/") { return true }
        if !home.isEmpty, path.hasPrefix((home.hasSuffix("/") ? home : home + "/") + "Applications/") { return true }
        return linkedCopies.contains(path)
    }

    /// What a launch does: the record, read against macOS's answer, and whether to register now.
    ///
    /// The first launch of an installed conch that has never registered, and hasn't been told not to, registers. An
    /// older conch's record (`legacyDecided`, #441: the switch was set on You're set) is a decision already made.
    public static func atLaunch(_ record: LoginItemRecord, legacyDecided: Bool, status: LoginItemStatus,
                                installed: Bool) -> (record: LoginItemRecord, register: Bool) {
        // A copy that isn't installed decides nothing, and writes nothing: it shares its defaults with the one that is.
        guard installed else { return (record, false) }
        var next = record
        if next.choice == nil, legacyDecided {
            next.choice = isOn(status) ? .on : .off
            next.registeredOnce = true
        }
        guard !next.registeredOnce, next.choice != .off else { return (next, false) }
        if isOn(status) {
            // Registered already (an older conch registered silently, or the person added it): nothing to do or say.
            next.choice = next.choice ?? .on
            next.registeredOnce = true
            return (next, false)
        }
        return (next, true)
    }

    /// After the launch's registration: once only, and said once, whether macOS took it or not.
    public static func registered(_ record: LoginItemRecord, refused: Bool) -> LoginItemRecord {
        var next = record
        next.choice = next.choice ?? .on
        next.registeredOnce = true
        next.announce = true
        next.refused = refused
        return next
    }

    /// After a switch: the person's choice stands, and the first launch's line has nothing left to say.
    public static func switched(_ record: LoginItemRecord, on: Bool, installed: Bool) -> LoginItemRecord {
        var next = record
        next.choice = on ? .on : .off
        // Only a registration that happened makes a later launch leave it alone; a switch turned on while conch
        // isn't in Applications leaves that to the first launch from there.
        if installed { next.registeredOnce = true }
        next.announce = false
        next.refused = false
        return next
    }

    /// The first launch's line, while it's still to be seen, as things stand now: an approval given since reads as added.
    public static func announcement(_ record: LoginItemRecord, status: LoginItemStatus) -> LoginItemLine? {
        guard record.announce else { return nil }
        switch status {
        case .enabled: return .added
        case .requiresApproval: return .needsApproval
        case .notRegistered, .notFound: return record.refused ? .refused : nil
        }
    }

    /// The note beside a switch, or nil for its usual words. `refusal` is the switch's last press, when macOS refused it.
    public static func note(status: LoginItemStatus, installed: Bool, refusal: LoginItemLine?) -> LoginItemLine? {
        if let refusal { return refusal }
        if status == .requiresApproval { return .needsApproval }
        if !installed, !isOn(status) { return .notInApplications }
        return nil
    }
}
