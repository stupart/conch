import AppKit
import ApplicationServices
import AVFoundation
import ConchDesign
import CoreGraphics
import CoreServices
import Security
import SwiftUI

/// Where conch's four macOS permissions stand, read without ever asking, and the one thing to do about each.
///
/// One grant each, to conch.app, covers everything that needs it. macOS charges a process's use of a permission to its
/// responsible process, and a child inherits its parent's: the daemon this app starts, and the `osascript` and recorder
/// the daemon runs, answer to this app (docs/architecture.md, "One grant, to conch.app"). So the front-window observer and the
/// daemon's typing share Accessibility; the daemon's Apple Events to Terminal and System Events are conch's Automation;
/// the canvas, Show and the phone's window snapshots are conch's Screen Recording; the daemon's recorder is conch's
/// Microphone. That is why every answer here is read in this process, or in one it starts.
///
/// Reading never prompts: `AXIsProcessTrusted()`, never its WithOptions form; `CGPreflightScreenCaptureAccess()`;
/// `AVCaptureDevice.authorizationStatus`; `AEDeterminePermissionToAutomateTarget` with askUserIfNeeded false. Every prompt
/// is in `perform`, on a press. It reads at launch, whenever conch comes to the front (Tyler flipped a switch in System
/// Settings and came back), when macOS says Accessibility's list changed, and when Settings opens.
@MainActor
final class PermissionCenter: ObservableObject {
    static let shared = PermissionCenter()

    @Published private(set) var statuses: [ConchPermission: ConchPermissionStatus]
    /// What stopped for want of a permission this launch, newest last (`ConchPermissionNotice.current`).
    @Published private(set) var noted: [ConchPermissionTrouble] = []
    /// Put away from the window's notices until it happens again.
    @Published private(set) var dismissed: Set<ConchPermissionTrouble> = []
    /// What went wrong doing a row's one thing, said under it.
    @Published private(set) var notes: [ConchPermission: String] = [:]
    /// What a row's press is doing, or did, said under it in conch's quiet voice (2026-11-11): every button now shows
    /// something happen, where a press that macOS answered silently looked like a button that did nothing.
    @Published private(set) var progress: [ConchPermission: String] = [:]
    /// When System Settings was opened for each, so coming back to find one still off can say the off-and-on fix.
    private var settingsOpened: [ConchPermission: Date] = [:]
    private let defaults = UserDefaults.standard

    private var observers: [NSObjectProtocol] = []
    private var reading: Task<Void, Never>?

    private init() {
        // What this process can say at once, so a row doesn't say "Checking…" about what is already known; Automation's
        // answers, and a new process's, follow off the main thread.
        statuses = [:]
        statuses = shown(Self.readHere())
        observers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        })
        // Posted as Accessibility's list changes, a moment before the change is readable.
        observers.append(DistributedNotificationCenter.default().addObserver(
            forName: Self.accessibilityListChanged, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh(after: .milliseconds(500)) }
        })
        refresh()
    }

    static let accessibilityListChanged = Notification.Name("com.apple.accessibility.api")

    /// Read everything again, silently. A newer read replaces one still going.
    func refresh(after delay: Duration = .zero) {
        reading?.cancel()
        reading = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard !Task.isCancelled else { return }
            let read = await Task.detached(priority: .utility) { PermissionCenter.readAll() }.value
            guard !Task.isCancelled, let self else { return }
            let next = shown(read)
            if statuses != next { statuses = next }
        }
    }

    /// What macOS said, as the rows show it: a no to this build after a yes to another is said as that
    /// (`ConchPermissionGrantMemory`), and the build is remembered once it is allowed. A row whose System Settings was
    /// opened says the off-and-on fix once conch is back and it is still off; one that is allowed loses its lines.
    private func shown(_ read: [ConchPermission: ConchPermissionStatus]) -> [ConchPermission: ConchPermissionStatus] {
        var shown = read
        for (permission, status) in read {
            let key = Self.allowedBuildKey(permission)
            let remembered = defaults.string(forKey: key)
            shown[permission] = ConchPermissionGrantMemory.status(status, lastAllowedBuild: remembered, thisBuild: BuildSignature.requirement)
            let next = ConchPermissionGrantMemory.remember(status, lastAllowedBuild: remembered, thisBuild: BuildSignature.requirement)
            if next != remembered { defaults.set(next, forKey: key) }
            if status == .granted {
                settingsOpened[permission] = nil
                progress[permission] = nil
                notes[permission] = nil
            } else if let opened = settingsOpened[permission], -opened.timeIntervalSinceNow > 3, NSApp.isActive,
                      shown[permission]?.isOff == true {
                progress[permission] = ConchPermissionGrantMemory.stillOff(permission)
            }
        }
        return shown
    }

    /// Where the signature of the build last allowed each permission is kept.
    static func allowedBuildKey(_ permission: ConchPermission) -> String { "conch.permissions.allowedBuild.\(permission.rawValue)" }

    /// Something stopped for want of a permission: said in the window until the permission is on, or it is put away.
    func note(_ trouble: ConchPermissionTrouble) {
        dismissed.remove(trouble)
        noted.removeAll { $0 == trouble }
        noted.append(trouble)
        refresh()
    }

    func dismiss(_ trouble: ConchPermissionTrouble) {
        dismissed.insert(trouble)
        noted.removeAll { $0 == trouble }
    }

    /// A row's, or a notice's, one button: the only place conch asks macOS for anything, and only on a press. Each says
    /// what it is doing under its row, or what went wrong.
    func perform(_ action: ConchPermissionAction, for permission: ConchPermission, store: StateStore) {
        notes[permission] = nil
        progress[permission] = nil
        switch action {
        case .openSettings:
            // macOS lists an app under Accessibility and Screen Recording only once it has asked. Asking here puts conch
            // in the list to turn on: Accessibility's prompt while conch isn't trusted, and the canvas's once-a-launch
            // Screen Recording ask (`CanvasCapture.granted`), which macOS shows only the first time ever.
            switch permission {
            case .accessibility where !AXIsProcessTrusted():
                _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            case .screenRecording:
                _ = CanvasCapture.granted()
            default:
                break
            }
            settingsOpened[permission] = Date()
            openSettings(permission, store: store)
        case .ask:
            switch permission {
            case .microphone:
                let before = AVCaptureDevice.authorizationStatus(for: .audio).rawValue
                progress[permission] = "Asking macOS…"
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    Task { @MainActor in
                        let center = PermissionCenter.shared
                        center.progress[.microphone] = nil
                        center.notes[.microphone] = ConchPermissionReading.microphoneAskOutcome(granted: granted, before: before)
                        center.refresh()
                    }
                }
            case .automation:
                // macOS answers only for an app that is open: Terminal and System Events are opened in the background
                // first, so the press is never one that macOS can't answer. Off the main thread: each prompt waits for
                // Tyler's answer.
                progress[permission] = "Asking macOS…"
                Task { @MainActor in
                    await PermissionCenter.openAutomationTargets()
                    let answers = await Task.detached(priority: .userInitiated) { PermissionCenter.automation(ask: true) }.value
                    let center = PermissionCenter.shared
                    center.progress[.automation] = nil
                    center.notes[.automation] = ConchPermissionReading.automationAskOutcome(answers)
                    center.refresh()
                }
            case .accessibility:
                // macOS never says this wasn't asked; Settings is where it is turned on.
                perform(.openSettings, for: permission, store: store)
            case .screenRecording:
                // macOS's own prompt, the once a launch it may show (the canvas's `CanvasCapture.granted`, which also
                // lists conch in System Settings), and a fresh reading after. The Terminal Mirror, a debug view, asks
                // this way the first time a Terminal window needs it, after a press that opened it; its row's reading
                // is never `notAsked`, so nothing else reaches here. System Settings stays the row's own button, never opened unasked.
                _ = CanvasCapture.granted()
                progress[permission] = "Asked macOS. If nothing appeared, Open Settings and turn conch on under Screen Recording."
                refresh(after: .seconds(1))
            }
        case .reopen:
            // The store's own relaunch: the daemon handed over, then a new conch up before this one quits.
            progress[permission] = "Reopening conch…"
            CanvasCapture.reopen(store) { [weak self] in
                self?.progress[permission] = nil
                self?.notes[permission] = "Couldn't reopen conch. Quit it from the menu bar and open it again."
            }
        case .reset:
            reset(permission)
        }
    }

    /// Reset…: macOS forgets conch's answer for one list (`tccutil reset <service> <bundle id>`), once Tyler confirms
    /// what it does, and conch reads again. A refused prompt is never shown twice, and System Settings › Automation can't
    /// add an app by hand: this is the only way back to macOS's question (2026-11-11). Only the person's own lists,
    /// Automation's and the Microphone's (`isResettable`), which need no administrator.
    private func reset(_ permission: ConchPermission) {
        guard permission.isResettable else { return }
        guard let bundleId = Bundle.main.bundleIdentifier else {
            notes[permission] = "Couldn't reset: this build of conch has no bundle identifier."
            return
        }
        let words = permission.resetConfirmation
        let alert = NSAlert()
        alert.messageText = words.title
        alert.informativeText = words.message
        alert.addButton(withTitle: "Reset")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        progress[permission] = "Resetting…"
        let arguments = permission.resetArguments(bundleId: bundleId)
        Task { @MainActor in
            let failure = await Task.detached(priority: .userInitiated) { PermissionCenter.tccutil(arguments) }.value
            let center = PermissionCenter.shared
            center.progress[permission] = nil
            if let failure {
                center.notes[permission] = "Couldn't reset: \(failure)"
            } else {
                // Forgotten: whatever build was allowed before, macOS will ask about this one.
                center.defaults.removeObject(forKey: Self.allowedBuildKey(permission))
                center.progress[permission] = permission == .automation
                    ? "Reset. conch asks the next time it needs Terminal, or press Allow… to be asked now."
                    : "Reset. Press Allow… and macOS asks again."
            }
            center.refresh()
        }
    }

    /// `/usr/bin/tccutil` with `arguments`, bounded at ten seconds: nil when it worked, else its own words.
    nonisolated static func tccutil(_ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
        process.arguments = arguments
        let errors = Pipe()
        process.standardOutput = FileHandle.nullDevice
        process.standardError = errors
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch { return error.localizedDescription }
        let deadline = Date().addingTimeInterval(10)
        while process.isRunning, Date() < deadline { usleep(20_000) }
        if process.isRunning {
            process.terminate()
            return "tccutil didn't answer."
        }
        guard process.terminationStatus != 0 else { return nil }
        let said = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return said.isEmpty ? "tccutil stopped with status \(process.terminationStatus)." : said
    }

    /// Terminal and System Events, opened where they aren't running: in the background, hidden, not activated, so the
    /// Automation ask has an app to ask about. Waits up to five seconds for each.
    static func openAutomationTargets() async {
        for target in automationTargets where NSRunningApplication.runningApplications(withBundleIdentifier: target.bundleId).isEmpty {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: target.bundleId) else { continue }
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = false
            configuration.hides = true
            configuration.addsToRecentItems = false
            _ = try? await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
            let deadline = Date().addingTimeInterval(5)
            while NSRunningApplication.runningApplications(withBundleIdentifier: target.bundleId).isEmpty, Date() < deadline {
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    /// System Settings at the permission's own list, through the store's one door for opening things, which files a
    /// failure; the row says it in its own words.
    private func openSettings(_ permission: ConchPermission, store: StateStore) {
        let failed = "Couldn't open System Settings. It is under Privacy & Security › \(permission.title)."
        store.openLink(permission.settingsURL.absoluteString, cwd: nil, rowId: nil) { [weak self] _ in
            self?.notes[permission] = failed
        }
    }

    // MARK: - Reading, silently

    /// This process's own answers, at once.
    nonisolated static func readHere() -> [ConchPermission: ConchPermissionStatus] {
        [
            .accessibility: ConchPermissionReading.accessibility(trusted: AXIsProcessTrusted(), answered: nil),
            .automation: .unknown("Checking…"),
            .screenRecording: ConchPermissionReading.screenRecording(thisProcess: CGPreflightScreenCaptureAccess(), newProcess: nil),
            .microphone: ConchPermissionReading.microphone(AVCaptureDevice.authorizationStatus(for: .audio).rawValue),
        ]
    }

    /// Every answer, some of them waited on: off the main thread.
    nonisolated static func readAll() -> [ConchPermission: ConchPermissionStatus] {
        let trusted = AXIsProcessTrusted()
        let screen = CGPreflightScreenCaptureAccess()
        return [
            .accessibility: ConchPermissionReading.accessibility(trusted: trusted, answered: trusted ? accessibilityAnswers() : nil),
            .automation: ConchPermissionReading.automation(automation(ask: false)),
            .screenRecording: ConchPermissionReading.screenRecording(thisProcess: screen, newProcess: screen ? nil : screenRecordingInNewProcess()),
            .microphone: ConchPermissionReading.microphone(AVCaptureDevice.authorizationStatus(for: .audio).rawValue),
        ]
    }

    /// Trusted, whether Accessibility answers conch at all: a grant made after launch can leave it refused
    /// (`kAXErrorAPIDisabled`) until conch opens again. The system-wide element's focused app is the cheapest question,
    /// and names no window.
    nonisolated static func accessibilityAnswers() -> Bool {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &value) != .apiDisabled
    }

    /// `CGPreflightScreenCaptureAccess()` in a process started now. conch keeps the answer it launched with; a child of
    /// conch's is charged to conch too, and gets today's, so the two disagreeing is a grant a reopen away. JavaScript for
    /// Automation reaches the C function without a helper of conch's own, and sends no Apple Event. Nil when it couldn't
    /// say within two seconds.
    nonisolated static func screenRecordingInNewProcess() -> Bool? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-l", "JavaScript", "-e", screenRecordingProbe]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(2)
        while process.isRunning, Date() < deadline { usleep(20_000) }
        if process.isRunning {
            process.terminate()
            return nil
        }
        let answer = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return answer == "true" ? true : answer == "false" ? false : nil
    }

    nonisolated static let screenRecordingProbe =
        #"ObjC.import("CoreGraphics"); ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]); $.CGPreflightScreenCaptureAccess()"#

    /// The apps the daemon sends Apple Events to (`src/inject.ts`): Terminal, for its windows and tabs, and System
    /// Events, for keys and which app is in front.
    nonisolated static let automationTargets: [(app: String, bundleId: String)] = [
        ("Terminal", "com.apple.Terminal"),
        ("System Events", "com.apple.systemevents"),
    ]

    /// `AEDeterminePermissionToAutomateTarget` for each. `ask` true shows macOS's prompt where it hasn't asked yet, and
    /// waits for the answer; only `perform` passes it.
    nonisolated static func automation(ask: Bool) -> [(app: String, status: Int32)] {
        automationTargets.map { target in
            var address = AEAddressDesc()
            let id = Array(target.bundleId.utf8)
            let made = id.withUnsafeBufferPointer { AECreateDesc(typeApplicationBundleID, $0.baseAddress, $0.count, &address) }
            guard made == noErr else { return (target.app, Int32(made)) }
            defer { AEDisposeDesc(&address) }
            return (target.app, AEDeterminePermissionToAutomateTarget(&address, typeWildCard, typeWildCard, ask))
        }
    }
}

/// This build's code signature, as macOS checks a privacy grant against it (2026-11-11): the designated requirement a
/// grant is recorded with, and whether it is signed only for this Mac. Read once.
enum BuildSignature {
    static let requirement: String? = {
        guard let code = staticCode() else { return nil }
        var requirement: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(code, [], &requirement) == errSecSuccess, let requirement else { return nil }
        var text: CFString?
        guard SecRequirementCopyString(requirement, [], &text) == errSecSuccess else { return nil }
        return text as String?
    }()

    /// Ad hoc: macOS sees each such rebuild as a new app.
    static let isAdHoc: Bool = {
        guard let code = staticCode() else { return false }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let values = information as? [String: Any],
              let flags = values[kSecCodeInfoFlags as String] as? UInt32 else { return false }
        return flags & SecCodeSignatureFlags.adhoc.rawValue != 0
    }()

    private static func staticCode() -> SecStaticCode? {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess else { return nil }
        return staticCode
    }
}

extension DaemonHost {
    /// Who started the daemon conch talks to, which is who macOS asks about its typing and listening: "app" for conch's
    /// own, else the daemon's own record ("terminal", "launchd"); nil with no daemon, or no record.
    var startedBy: String? {
        switch state {
        case .running: "app"
        case .adopted: adoptedIdentity?.startedBy
        case .stopped, .starting, .failed: nil
        }
    }
}

/// Settings › Permissions: each of the four, where it stands, and its one button (`ConchPermissionList`, the rows
/// onboarding shows too), under a caution when the daemon isn't conch's and macOS is asking someone else.
struct ConchPermissionsView: View {
    @ObservedObject private var center = PermissionCenter.shared
    @EnvironmentObject private var store: StateStore
    @EnvironmentObject private var daemon: DaemonHost

    var body: some View {
        // One scroll view, header and all, so the Settings page stops all of it at its readable column.
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                SettingsSectionHeader(title: "Permissions", subtitle: "macOS asks once for each. One grant to conch covers everything that needs it.")
                    .padding([.horizontal, .top], SettingsLayout.inset)
                    .padding(.bottom, SettingsLayout.headerGap)

                SettingsHairline()
                    .padding(.horizontal, SettingsLayout.inset)

                ConchPermissionList(
                    statuses: center.statuses,
                    notes: center.notes,
                    progress: center.progress,
                    caution: ConchPermissionHost.caution(startedBy: daemon.startedBy),
                    moreCautions: [ConchPermissionHost.signatureCaution(adHoc: BuildSignature.isAdHoc)].compactMap { $0 },
                    cautionAction: daemon.startedBy == "launchd" ? (title: "Let the app own it", run: { daemon.takeOverFromLaunchd() }) : nil,
                    titleFont: ConchTypography.font(size: 14, weight: .medium),
                    detailFont: ConchTypography.font(size: 12),
                    statusFont: ConchTypography.font(size: 11),
                    inset: SettingsLayout.inset,
                    onAction: { permission, action in center.perform(action, for: permission, store: store) }
                )
                .padding(.bottom, 12)
            }
        }
        .background(ConchPalette.bg)
        // Opening Settings reads again, as coming back to conch does.
        .onAppear { center.refresh() }
    }
}

/// The window's line for whatever stopped for want of a permission (`ConchPermissionNotice.current`), in the notices'
/// stack (`WorkspaceNotices`).
struct PermissionNoticeLine: View {
    @ObservedObject private var center = PermissionCenter.shared
    @EnvironmentObject private var store: StateStore
    @EnvironmentObject private var daemon: DaemonHost

    var body: some View {
        if let notice = ConchPermissionNotice.current(
            noted: center.noted,
            statuses: center.statuses,
            dismissed: center.dismissed,
            daemonIsConchs: daemon.startedBy == "app"
        ) {
            ConchPermissionNoticeBar(
                notice: notice,
                font: ConchTypography.font(size: 11.5),
                onAction: { center.perform($0, for: notice.permission, store: store) },
                onDismiss: { center.dismiss(notice.trouble) }
            )
            Rectangle()
                .fill(ConchPalette.divider)
                .frame(height: 1)
        }
    }
}
