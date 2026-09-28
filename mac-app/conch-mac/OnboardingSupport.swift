import AppKit
import ConchDesign
import CoreAudio
import Foundation
import ServiceManagement

// What setup's window needs from outside itself: the daemon's setup requests (src/setup.ts), the published state's
// downloads and phone, the Mac's audio inputs, the login item, and where System Settings' window is. The window and its
// rules are OnboardingController.swift and ConchDesign's Onboarding*.swift.

// MARK: - The daemon's setup requests

/// One of setup's requests, as src/setup.ts decodes it. Nil fields are left out.
struct SetupDaemonRequest: Encodable, Sendable {
    let kind: String
    var agent: String?
    var via: String?
    var voice: String?
    var seconds: Double?
    var what: String?
}

/// A reply or a streamed line, by its kind. Decoded loosely, so a field a newer daemon adds never breaks this app.
struct SetupDaemonMessage: Decodable, Sendable {
    let kind: String
    let agents: [AgentSetupReport]?
    let error: String?
    let reason: String?
    let command: String?
    let line: String?
    let level: Double?
    let heard: String?
    let silent: Bool?
    let recognition: String?
    let voice: String?
    let retried: Bool?
}

/// `audio-sink`, as the phone sends it to hand the audio back: Try it's "Hand it back", pressed by the person.
struct AudioSinkRequest: Encodable, Sendable {
    let kind = "audio-sink"
    let sink: String
}

/// setup's side of the daemon's socket. Every failure comes back as words the window can show.
enum SetupDaemon {
    static let client = ConchSocketClient()

    /// The window's words for the daemon not answering: never a socket error.
    static let notAnswering = "conch's background service isn't answering. It may still be starting."

    static func decode(_ data: Data) -> SetupDaemonMessage? {
        try? JSONDecoder().decode(SetupDaemonMessage.self, from: data)
    }

    /// A reply is the answer only when it is the kind asked for: an older daemon answers setup's questions with an
    /// error of its own, which must never read as "nothing found".
    static func verdict(_ data: Data, expecting: String) -> Result<SetupDaemonMessage, SetupDaemonFailure> {
        guard let message = decode(data) else { return .failure(.unreadable) }
        if message.kind == "setup-error" { return .failure(.said(message.error ?? "Something went wrong.", reason: message.reason, command: message.command)) }
        guard message.kind == expecting else { return .failure(.olderDaemon) }
        return .success(message)
    }

    /// One request, one reply. `timeout` is how long the daemon may take: a connect installs a plugin, which runs the
    /// agent's own CLI.
    static func ask(_ request: SetupDaemonRequest, timeout: TimeInterval, expecting: String) async -> Result<SetupDaemonMessage, SetupDaemonFailure> {
        switch await client.request(request, timeout: timeout) {
        case let .reply(data):
            return verdict(data, expecting: expecting)
        case .connectFailed:
            return .failure(.notAnswering)
        case .timeout:
            return .failure(.timedOut)
        }
    }

    /// A request whose lines stream before its reply (`mic-check`, `setup-install`). Cancelling the task ends it. The
    /// reply is told from the lines by its kind (`OnboardingReports.isStreamReply`): a stream the daemon drops part way,
    /// restarting, is "try again", never an older daemon.
    static func stream(_ request: SetupDaemonRequest, timeout: TimeInterval, expecting: String,
                       onLine: @escaping @Sendable (SetupDaemonMessage) -> Void) async -> Result<SetupDaemonMessage, SetupDaemonFailure> {
        let outcome = await client.stream(request, timeout: timeout, isReply: { OnboardingReports.isStreamReply(kind: decode($0)?.kind) }) { data in
            if let message = decode(data) { onLine(message) }
        }
        switch outcome {
        case let .reply(data):
            return verdict(data, expecting: expecting)
        case .dropped:
            return .failure(.dropped)
        case .connectFailed:
            return .failure(.notAnswering)
        case .timeout:
            return .failure(.timedOut)
        }
    }
}

enum SetupDaemonFailure: Error, Equatable {
    case notAnswering
    case timedOut
    case unreadable
    /// A daemon from before setup, which doesn't know the question.
    case olderDaemon
    /// The daemon ended a streamed request before its reply: it restarted part way, or quit.
    case dropped
    /// The daemon's own words, a reason code for the window to act on, and a command to copy when there is one.
    case said(String, reason: String?, command: String?)

    /// What the window says.
    var words: String {
        switch self {
        case .notAnswering: SetupDaemon.notAnswering
        case .timedOut: "conch's background service took too long to answer. Try again."
        case .unreadable: "conch's background service gave an answer this version of conch can't read. Update conch."
        case .olderDaemon: "conch's background service is an older version. Quit conch and open it again to update it."
        case .dropped: "conch's background service restarted part way through. Try again."
        case let .said(words, _, _): words
        }
    }

    var reason: String? {
        if case let .said(_, reason, _) = self { return reason }
        return nil
    }

    var command: String? {
        if case let .said(_, _, command) = self { return command }
        return nil
    }
}

// MARK: - The published state's blocks

/// The phone as the daemon publishes it (Wave B's contract):
/// `{ enabled, paired, device, setup: { stage, declined } }`. No block means no phone is paired.
struct PublishedPhone: Decodable, Equatable, Sendable {
    struct Setup: Decodable, Equatable, Sendable {
        let stage: String?
        let declined: [String]?
    }

    let enabled: Bool?
    let paired: Bool?
    let device: String?
    let setup: Setup?

    var handoff: PhoneHandoff? {
        OnboardingReports.phoneHandoff(paired: paired == true, device: device, stage: setup?.stage, declined: setup?.declined ?? [])
    }
}

/// The three blocks setup reads from the published state, each decoded on its own so one a newer or older daemon shapes
/// differently never hides the others.
struct SetupPublished: Equatable, Sendable {
    var speech: SpeechEngineReport?
    var voices: NaturalVoicesReport?
    var phone: PublishedPhone?
    /// The daemon publishes a `phone` block at all: without one, whether a phone is paired is unknown.
    var phoneKnown: Bool
    /// The daemon can run the practice turn (`features.practice`, src/practice.ts): Try it goes on the rail. Absent from
    /// an older daemon, and from none at all.
    var practiceFeature: Int? = nil

    /// Where the daemon publishes its state (status.ts `SESSIONS_FILE`).
    static var fileURL: URL {
        let environment = ProcessInfo.processInfo.environment
        return URL(fileURLWithPath: environment["CONCH_SESSIONS_FILE"] ?? environment["CONCH_STATE_FILE"] ?? "/tmp/conch-sessions.json")
    }

    static func read(from url: URL = fileURL) -> SetupPublished? {
        guard let data = try? Data(contentsOf: url),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        func block<T: Decodable>(_ key: String, as: T.Type) -> T? {
            guard let value = object[key], !(value is NSNull),
                  let json = try? JSONSerialization.data(withJSONObject: value) else { return nil }
            return try? JSONDecoder().decode(T.self, from: json)
        }
        return SetupPublished(
            speech: block("speechEngine", as: SpeechEngineReport.self),
            voices: block("naturalVoices", as: NaturalVoicesReport.self),
            phone: block("phone", as: PublishedPhone.self),
            phoneKnown: object["phone"] != nil,
            practiceFeature: (object["features"] as? [String: Any])?["practice"] as? Int
        )
    }
}

/// How long the speech-recognition download has left, from the bytes seen move across the window's reads.
struct DownloadClock {
    private var samples: [(at: Date, bytes: Double)] = []

    mutating func secondsLeft(bytes: Double, total: Double, now: Date = Date()) -> Int? {
        if let last = samples.last, bytes < last.bytes { samples.removeAll() }
        samples.append((now, bytes))
        samples.removeAll { now.timeIntervalSince($0.at) > 20 }
        guard let first = samples.first, now.timeIntervalSince(first.at) >= 2, bytes > first.bytes, total > bytes else { return nil }
        let rate = (bytes - first.bytes) / now.timeIntervalSince(first.at)
        return Int(((total - bytes) / rate).rounded())
    }
}

// MARK: - The Mac's audio inputs

/// The Mac's microphones, from Core Audio: which there are, which one is the Mac's input now, and making another the
/// input. The daemon records from the Mac's input, so choosing here is choosing for conch.
enum AudioInputs {
    static func names() -> [String] {
        devices().map(\.name)
    }

    static func current() -> String? {
        guard let id = defaultInput() else { return nil }
        return name(of: id)
    }

    /// Makes the named input the Mac's. False when it couldn't.
    @discardableResult
    static func choose(_ name: String) -> Bool {
        guard var id = devices().first(where: { $0.name == name })?.id else { return false }
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice,
                                                 mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        return AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &id) == noErr
    }

    private static func devices() -> [(id: AudioDeviceID, name: String)] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids.compactMap { id in
            guard hasInput(id), let name = name(of: id) else { return nil }
            return (id, name)
        }
    }

    private static func defaultInput() -> AudioDeviceID? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice,
                                                 mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr, id != 0 else { return nil }
        return id
    }

    private static func hasInput(_ id: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput,
                                                 mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        return AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr && size > 0
    }

    private static func name(of id: AudioDeviceID) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var name: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &name) == noErr, let value = name?.takeRetainedValue() else { return nil }
        return value as String
    }
}

// MARK: - Opening at login

/// "Open conch when you log in": registered at the first launch, visibly, and a switch on You're set and in Settings.
///
/// The first launch of an installed conch that has never registered, and hasn't been told not to, registers
/// (`LoginItemPolicy.atLaunch`). macOS shows its own notice; conch says it too, once: on setup's welcome when that is
/// what opens, otherwise in the window's notices (`announcement`). A launch never registers again, so a switch turned
/// off, here or in System Settings, stays off. The switches show macOS's own answer, read again whenever conch comes
/// forward. The rules are ConchDesign's (LoginItemPolicy.swift); this is the one place conch talks to `SMAppService`.
@MainActor
final class LoginItem: ObservableObject {
    static let shared = LoginItem()

    /// macOS's answer for this conch.
    @Published private(set) var status: LoginItemStatus
    @Published private(set) var record: LoginItemRecord
    /// Why the switch's last press didn't take, until the next press.
    @Published private(set) var refusal: LoginItemLine?
    /// Where the first launch's line goes: the window's notices once setup's launch has settled without its welcome.
    @Published private(set) var announceInWindow = false
    /// The line setup's welcome says, this launch, when the welcome is what opened.
    @Published private(set) var welcomeLine: LoginItemLine?

    private static let choiceKey = "conch.loginItem.choice"
    private static let registeredOnceKey = "conch.loginItem.registeredOnce"
    private static let announceKey = "conch.loginItem.announce"
    private static let refusedKey = "conch.loginItem.refused"
    /// #441's record: the switch was set on You're set. Read as a decision already made.
    private static let legacyDecidedKey = "conch.loginItemDecided"

    private var activation: NSObjectProtocol?

    private init() {
        status = Self.read()
        record = Self.load()
        // Turned on or off in System Settings while conch was open: the switches follow when conch comes forward.
        activation = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil,
                                                            queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    /// Only an installed conch registers: a build run from Xcode or a checkout would register a copy that moves.
    static var installed: Bool {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let links = ["/Applications/conch.app", home + "/Applications/conch.app"].compactMap { path -> String? in
            guard (try? FileManager.default.destinationOfSymbolicLink(atPath: path)) != nil else { return nil }
            return URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        }
        return LoginItemPolicy.installed(bundlePath: Bundle.main.bundleURL.resolvingSymlinksInPath().path, home: home, linkedCopies: links)
    }

    /// What the switches show.
    var isOn: Bool { LoginItemPolicy.isOn(status) }

    /// The note beside a switch, or nil for its usual words.
    var note: LoginItemLine? { LoginItemPolicy.note(status: status, installed: Self.installed, refusal: refusal) }

    /// The first launch's line, while it's still to be seen.
    var announcement: LoginItemLine? { LoginItemPolicy.announcement(record, status: status) }

    // MARK: Launch

    /// `applicationDidFinishLaunching`: the first launch registers, and only the first.
    func registerAtLaunch() {
        status = Self.read()
        let installed = Self.installed
        let step = LoginItemPolicy.atLaunch(record, legacyDecided: UserDefaults.standard.bool(forKey: Self.legacyDecidedKey),
                                            status: status, installed: installed)
        var next = step.record
        if step.register {
            let refused = !register(on: true)
            status = Self.read()
            next = LoginItemPolicy.registered(next, refused: refused)
        }
        if next != record { save(next) }
    }

    /// Setup's launch has decided what opens (OnboardingController). When that is its welcome, the welcome says the
    /// line, and it has been seen; otherwise the window's notices say it, until OK.
    func setupSettled(welcomeOnScreen: Bool) {
        guard let line = announcement else { return }
        if welcomeOnScreen {
            welcomeLine = line
            dismissAnnouncement()
        } else {
            announceInWindow = true
        }
    }

    /// The window's notice, OK'd, or the line seen on setup's welcome: not said again.
    func dismissAnnouncement() {
        var next = record
        next.announce = false
        announceInWindow = false
        save(next)
    }

    // MARK: The switches

    /// You're set's and Settings' switch, pressed.
    func set(_ on: Bool) {
        let installed = Self.installed
        save(LoginItemPolicy.switched(record, on: on, installed: installed))
        announceInWindow = false
        guard installed else {
            refusal = nil
            status = Self.read()
            return
        }
        refusal = register(on: on) ? nil : (on ? .refused : .refusedOff)
        status = Self.read()
    }

    /// macOS's answer, read again: a switch coming on screen, and conch coming forward.
    func refresh() {
        status = Self.read()
    }

    /// The fix for a line that needs one: System Settings › General › Login Items.
    func openLoginItems() {
        SMAppService.openSystemSettingsLoginItems()
    }

    // MARK: macOS

    /// Registers or unregisters conch, and says whether macOS took it; a refusal goes to the daemon's error log.
    private func register(on: Bool) -> Bool {
        let service = SMAppService.mainApp
        do {
            if on {
                if service.status != .enabled { try service.register() }
            } else if service.status == .enabled || service.status == .requiresApproval {
                try service.unregister()
            }
            return true
        } catch {
            let message = error.localizedDescription
            Task {
                await ConchSocketClient().reportAppError(operation: on ? "login-item.register" : "login-item.unregister", message: message,
                                                         state: ["bundlePath": Bundle.main.bundlePath])
            }
            return false
        }
    }

    private static func read() -> LoginItemStatus {
        switch SMAppService.mainApp.status {
        case .enabled: .enabled
        case .requiresApproval: .requiresApproval
        case .notRegistered: .notRegistered
        case .notFound: .notFound
        @unknown default: .notFound
        }
    }

    // MARK: The record

    private static func load() -> LoginItemRecord {
        let defaults = UserDefaults.standard
        return LoginItemRecord(choice: defaults.string(forKey: choiceKey).flatMap(LoginItemChoice.init(rawValue:)),
                               registeredOnce: defaults.bool(forKey: registeredOnceKey),
                               announce: defaults.bool(forKey: announceKey),
                               refused: defaults.bool(forKey: refusedKey))
    }

    private func save(_ next: LoginItemRecord) {
        let defaults = UserDefaults.standard
        if let choice = next.choice { defaults.set(choice.rawValue, forKey: Self.choiceKey) } else { defaults.removeObject(forKey: Self.choiceKey) }
        defaults.set(next.registeredOnce, forKey: Self.registeredOnceKey)
        defaults.set(next.announce, forKey: Self.announceKey)
        defaults.set(next.refused, forKey: Self.refusedKey)
        record = next
    }
}

// MARK: - System Settings' window

/// Where System Settings' window is, so the guide can sit under it. Found by its owner, never its title: an owner is
/// readable without Screen Recording, a title isn't.
enum SystemSettingsWindow {
    static let bundleIdentifier = "com.apple.systempreferences"

    /// Its frame in AppKit's coordinates (bottom-left origin), or nil when it isn't on screen.
    static func frame() -> CGRect? {
        let owners = Set(NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).map(\.processIdentifier))
        guard !owners.isEmpty,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for window in windows {
            guard let pid = window[kCGWindowOwnerPID as String] as? pid_t, owners.contains(pid),
                  (window[kCGWindowLayer as String] as? Int) == 0,
                  let bounds = window[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds), rect.width > 200, rect.height > 200 else { continue }
            // Core Graphics measures from the top of the main screen; AppKit from its bottom.
            let mainHeight = NSScreen.screens.first?.frame.height ?? rect.maxY
            return CGRect(x: rect.minX, y: mainHeight - rect.maxY, width: rect.width, height: rect.height)
        }
        return nil
    }

    /// Where a guide of `size` goes: centred under the window, or inside its foot when there's no room below.
    static func guideOrigin(for size: CGSize, under settings: CGRect) -> CGPoint {
        let screen = NSScreen.screens.first { $0.frame.intersects(settings) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? settings
        var x = settings.midX - size.width / 2
        x = min(max(x, visible.minX + 8), visible.maxX - size.width - 8)
        let below = settings.minY - size.height - 6
        let y = below >= visible.minY + 4 ? below : settings.minY + 14
        return CGPoint(x: x, y: y)
    }
}

// MARK: - Opening Terminal on a command

/// Terminal, running one command in a login shell, through a `.command` file opened by the store's one door for
/// opening things: no Apple Events, so no Automation ask.
enum TerminalCommand {
    /// The file to open, or nil when it couldn't be written.
    static func file(for command: String) -> URL? {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("conch-setup", isDirectory: true)
        let file = directory.appendingPathComponent("\(UUID().uuidString).command")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try "#!/bin/zsh -l\n\(command)\n".write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
        } catch {
            return nil
        }
        return file
    }
}
