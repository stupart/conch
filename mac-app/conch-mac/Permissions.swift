import AppKit
import ApplicationServices
import AVFoundation
import ConchDesign
import CoreGraphics
import CoreServices
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

    private var observers: [NSObjectProtocol] = []
    private var reading: Task<Void, Never>?

    private init() {
        // What this process can say at once, so a row doesn't say "Checking…" about what is already known; Automation's
        // answers, and a new process's, follow off the main thread.
        statuses = Self.readHere()
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
            guard !Task.isCancelled, let self, statuses != read else { return }
            statuses = read
        }
    }

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

    /// A row's, or a notice's, one button: the only place conch asks macOS for anything, and only on a press.
    func perform(_ action: ConchPermissionAction, for permission: ConchPermission, store: StateStore) {
        notes[permission] = nil
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
            openSettings(permission, store: store)
        case .ask:
            switch permission {
            case .microphone:
                AVCaptureDevice.requestAccess(for: .audio) { _ in
                    Task { @MainActor in PermissionCenter.shared.refresh() }
                }
            case .automation:
                // Off the main thread: each prompt waits for Tyler's answer.
                Task.detached(priority: .userInitiated) {
                    _ = PermissionCenter.automation(ask: true)
                    await MainActor.run { PermissionCenter.shared.refresh() }
                }
            case .accessibility, .screenRecording:
                // macOS never says these weren't asked; Settings is where they are turned on.
                perform(.openSettings, for: permission, store: store)
            }
        case .reopen:
            // The store's own relaunch: a new conch up before this one quits.
            CanvasCapture.reopen(store) { [weak self] in
                self?.notes[permission] = "Couldn't reopen conch. Quit it from the menu bar and open it again."
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
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Permissions")
                        .font(ConchTypography.font(size: 18, weight: .semibold))
                        .foregroundStyle(ConchPalette.textPrimary)
                    Text("macOS asks once for each. One grant to conch covers everything that needs it.")
                        .font(ConchTypography.font(size: 12))
                        .foregroundStyle(ConchPalette.textDim)
                }
                Spacer()
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 16)

            Rectangle()
                .fill(ConchPalette.divider)
                .frame(height: 1)

            ScrollView {
                ConchPermissionList(
                    statuses: center.statuses,
                    notes: center.notes,
                    caution: ConchPermissionHost.caution(startedBy: daemon.startedBy),
                    cautionAction: daemon.startedBy == "launchd" ? (title: "Let the app own it", run: { daemon.takeOverFromLaunchd() }) : nil,
                    titleFont: ConchTypography.font(size: 14, weight: .medium),
                    detailFont: ConchTypography.font(size: 12),
                    statusFont: ConchTypography.font(size: 11),
                    inset: 22,
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
