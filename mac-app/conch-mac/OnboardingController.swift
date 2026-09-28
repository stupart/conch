import AppKit
import Combine
import ConchDesign
import SwiftUI

extension Notification.Name {
    /// Setup's "Start a session": conch's window opens its New session sheet (ContentView).
    static let showSessionStart = Notification.Name("com.conch.mac.show-session-start")
}

/// First-run setup, hosted for real: the window, where a person is in it, and what the Mac can already see.
///
/// The rule is ConchDesign's (`OnboardingProgress.applying`, `OnboardingProgress.entry`), and so are the pages; this
/// owns the progress on disk (`~/.config/conch/onboarding.json`), builds the readiness live (the daemon's `setup-status`,
/// `PermissionCenter`, the published speech engine, voices and phone), and turns what happens into the rule's events.
/// An AppKit window, not a SwiftUI scene, so it can open at launch only when the rule says so and step aside later.
@MainActor
final class OnboardingController: NSObject, NSWindowDelegate {
    static let shared = OnboardingController()

    let model = OnboardingStore()
    private var window: NSWindow?
    private var guide: NSPanel?
    /// What the guide shows now: rebuilt only when this changes, so a drag in progress is never torn down under the pointer.
    private var guideShows: (permission: ConchPermission, granted: Bool)?
    private var store: StateStore?
    private var launchedApp = false
    private var launchStarted = false

    // MARK: Launch

    /// The app's store, from `ConchMacApp.init`: setup starts once this and the launch have both happened.
    func attach(store: StateStore) {
        self.store = store
        model.stateStore = store
        startIfReady()
    }

    /// `applicationDidFinishLaunching`.
    func appDidFinishLaunching() {
        launchedApp = true
        startIfReady()
    }

    private func startIfReady() {
        guard launchedApp, store != nil, !launchStarted else { return }
        launchStarted = true
        Task { await launch() }
    }

    /// What opens at launch, per the rule: the whole flow, back where it was, only what's missing, or nothing.
    private func launch() async {
        // The first launch's login line goes on the welcome when that is what opened, else in the window's notices.
        defer { LoginItem.shared.setupSettled(welcomeOnScreen: welcomeOnScreen) }
        var progress = OnboardingStore.loadProgress()
        let readiness: OnboardingReadiness
        if progress == nil {
            // Never set up here: what the Mac already has decides between the whole flow, welcome back, and nothing.
            // Unknown is never missing: a daemon still starting must not walk a set-up Mac through setup again.
            let seen = await model.settleForLaunch()
            // Setup opened while the launch waited (Help, Settings › Setup): what the person has done since stands, and
            // the launch's choice, made for a Mac with nothing on record, is no longer the one to open over it.
            guard model.progress == nil else { return }
            guard let seen else {
                if PermissionCenter.shared.statuses[.microphone] != .granted { open(entry: .firstRun) }
                return
            }
            readiness = seen
        } else {
            readiness = model.readiness
            // Put away part way: the menu's reminder counts what's left against what the Mac has now.
            if progress?.finished == false { Task { await model.refreshAgents() } }
        }
        let entry = OnboardingProgress.entry(progress, readiness: readiness)
        if progress?.reopening == true {
            // Back from reopening for a grant: the reopen is used up, and the window comes back at its step.
            progress = progress?.applying(.launched, readiness: readiness)
            model.replace(progress)
        }
        model.watchInBackground()
        open(entry: entry)
    }

    private func open(entry: OnboardingEntry) {
        switch entry {
        case .none:
            return
        case .firstRun:
            model.replace(model.progress ?? OnboardingProgress())
            model.welcomeBack = nil
        case let .resume(step):
            model.apply(.open(step))
        case let .welcomeBack(missing):
            model.welcomeBack = missing
            model.replace(OnboardingProgress.welcomingBack(missing: missing, readiness: model.readiness))
        }
        show()
    }

    /// Setup's welcome is the page on screen.
    private var welcomeOnScreen: Bool {
        window?.isVisible == true && model.welcomeBack == nil && (model.shownStep ?? .welcome) == .welcome
    }

    // MARK: The menu, Help and Settings

    /// The menu bar menu's "Finish setting up conch": what's left, while setup is put away with steps left.
    func menuReminder() -> [String] {
        guard let progress = model.progress, progress.putAway, !progress.finished, window?.isVisible != true else { return [] }
        return progress.remaining(model.readiness).map(\.title)
    }

    /// The menu's reminder, chosen: where it was left.
    func finishSettingUp() {
        model.apply(.open(model.progress?.step ?? .agents))
        show()
    }

    /// Help › Set up conch…: where it was, or from the start once it has finished.
    func openFromHelp() {
        if let progress = model.progress, !progress.finished {
            model.apply(.open(progress.step == .done ? .agents : progress.step))
        } else {
            model.apply(.restart)
        }
        model.welcomeBack = nil
        show()
    }

    /// Settings › Setup › Run setup again.
    func runAgain() {
        model.welcomeBack = nil
        model.apply(.restart)
        show()
    }

    /// Settings › Setup's buttons: the window at that step.
    func open(step: OnboardingStep) {
        model.welcomeBack = nil
        model.apply(.open(step))
        show()
    }

    // MARK: The window

    func show() {
        if window == nil {
            let window = OnboardingNSWindow(
                contentRect: NSRect(origin: .zero, size: OnboardingWindowMetrics.size),
                styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.isMovableByWindowBackground = true
            window.isReleasedWhenClosed = false
            window.title = "Set up conch"
            window.delegate = self
            window.onEscape = { [weak self] in self?.close() }
            window.contentView = NSHostingView(rootView: OnboardingRootView(model: model, controller: self))
            window.center()
            self.window = window
        }
        model.windowOpened()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Esc, the red button, Close and Not now: nothing is lost, and it doesn't reopen by itself.
    func close() {
        window?.performClose(nil)
    }

    /// Try it's Start: the window steps aside for the tour (hidden, not closed: nothing is put away), and `show` brings it
    /// back for You're set.
    func stepAside() {
        window?.orderOut(nil)
    }

    /// Help › Take the tour: Try it, where Start runs the practice turn and the tour again.
    func takeTheTour() {
        open(step: .practice)
    }

    func windowWillClose(_ notification: Notification) {
        closeGuide()
        model.windowClosed()
    }

    // MARK: The guide under System Settings

    /// The guide under System Settings' window while conch waits on a grant there: a panel that never takes focus.
    func showGuide(for permission: ConchPermission, granted: Bool) {
        guard let settings = SystemSettingsWindow.frame() else { return closeGuide() }
        let size = CGSize(width: 460, height: 104)
        let panel = guide ?? makeGuide(size: size)
        guide = panel
        if guideShows?.permission != permission || guideShows?.granted != granted {
            guideShows = (permission, granted)
            let view = PermissionGuide(
                permission: permission,
                granted: granted,
                dragItem: { NSItemProvider(object: Bundle.main.bundleURL as NSURL) },
                onClose: { [weak self] in self?.model.stopWaiting() }
            )
            .padding(20)
            .environment(\.conchAppIcon, Image(nsImage: NSApp.applicationIconImage))
            panel.contentView = NSHostingView(rootView: view)
        }
        // It follows System Settings' window as it moves.
        panel.setFrameOrigin(SystemSettingsWindow.guideOrigin(for: size, under: settings))
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    func closeGuide() {
        guide?.orderOut(nil)
        guide = nil
        guideShows = nil
    }

    private func makeGuide(size: CGSize) -> NSPanel {
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.nonactivatingPanel, .borderless],
                            backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.collectionBehavior = [.fullScreenAuxiliary, .transient]
        panel.setAccessibilityLabel("Drag conch into System Settings")
        return panel
    }
}

/// Setup's window: Esc puts it away, as the close button does.
final class OnboardingNSWindow: NSWindow {
    var onEscape: (() -> Void)?

    override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }
}

// MARK: - The state

/// Where setup is and what the Mac can see, for the window, the menu and Settings › Setup.
@MainActor
final class OnboardingStore: ObservableObject {
    @Published private(set) var progress: OnboardingProgress?
    /// Welcome back's page, and what it's asking about, until something on it opens a step.
    @Published var welcomeBack: [OnboardingStep]? {
        didSet {
            // Its permission rows are the ones off when it opened: one allowed from here stays, saying so.
            if welcomeBack != nil, oldValue == nil { welcomeBackAsks = OnboardingReadiness.missingAsks(PermissionCenter.shared.statuses) }
        }
    }
    @Published private(set) var welcomeBackAsks: [ConchPermission] = []

    // What the Mac can see.
    @Published private(set) var agents: [AgentSetupReport]?
    @Published private(set) var agentProblem: String?
    @Published private(set) var activity: [OnboardingAgent.Kind: AgentActivity] = [:]
    @Published private(set) var published = SetupPublished(phoneKnown: false)
    /// The daemon's state has been read at least once this launch: until then what it can do is unknown, not absent.
    @Published private(set) var publishedSeen = false
    @Published private(set) var secondsLeft: Int?
    @Published private(set) var notifications: ConchPermissionStatus?

    // The page on screen: held on the iPhone for a moment after the phone hands back.
    @Published private(set) var holdingPhone = false

    // Permissions.
    @Published private(set) var waitingOn: ConchPermission?

    // Voice.
    @Published private(set) var playing: Int?
    @Published private(set) var mic = MicCheck(device: "Microphone", state: .listening, levels: [])
    @Published private(set) var devices: [String] = []
    @Published private(set) var heardYou = false

    // iPhone.
    let pairing = ConchPairingStore()
    @Published private(set) var phoneQR: Image?
    @Published private(set) var phoneFailure: String?

    // Try it.
    /// What the daemon last said when Start asked, or why the tour came back early.
    @Published private(set) var practiceRefusal: PracticeReport.Problem?
    @Published private(set) var practiceStarting = false
    /// The practice turn's lease: the connection `practice-start` holds open (src/practice.ts). conch quitting or crashing
    /// closes it, and the daemon takes the practice session away with it.
    private var practiceLease: Int32?

    weak var stateStore: StateStore?
    private var clock = DownloadClock()
    private var lastAction: [OnboardingAgent.Kind: OnboardingAgentAction] = [:]
    private var watcher: Task<Void, Never>?
    private var waiting: Task<Void, Never>?
    private var micTask: Task<Void, Never>?
    private var pairingTask: Task<Void, Never>?
    private var phoneTurnedOn = false
    private var visible = false
    /// Settings › Setup on screen, counted: its downloads move while it shows (`watchWhileSettingsShown`).
    private var settingsShowing = 0
    /// When setup's window first opened this launch: what "while you were setting up" means.
    private var openedAt: Date?
    private var stepTasksFor: OnboardingStep?
    private var permissionsWatch: AnyCancellable?

    init() {
        progress = Self.loadProgress()
        if let read = SetupPublished.read() {
            published = read
            publishedSeen = true
        }
        // A grant landing while setup is open: the voice step starts listening, the guide says "conch is on".
        // `@Published` sends the new value before the store holds it, so this reads the value it is sent.
        permissionsWatch = PermissionCenter.shared.$statuses.dropFirst().sink { [weak self] statuses in
            MainActor.assumeIsolated { self?.permissionsChanged(statuses) }
        }
    }

    // MARK: Readiness

    var readiness: OnboardingReadiness {
        OnboardingReports.readiness(agents: agents, permissions: PermissionCenter.shared.statuses, speech: published.speech,
                                    voices: published.voices, phonePaired: phoneSetUp,
                                    // Only a daemon that says it can: an older one keeps Try it off the rail. Before the
                                    // daemon has said anything, Try it stays on the rail while it is the step on screen.
                                    practiceAvailable: practiceAvailability ?? (progress?.step == .practice))
    }

    /// Whether the daemon can run the practice turn: nil until it has published its state this launch.
    var practiceAvailability: Bool? {
        OnboardingReports.practiceAvailability(feature: published.practiceFeature, published: publishedSeen)
    }

    /// A phone is set up here: paired by the daemon's record, or set up before it kept one (`OnboardingReports.phoneSetUp`).
    var phoneSetUp: Bool {
        OnboardingReports.phoneSetUp(paired: published.phone?.paired, enabled: published.phone?.enabled,
                                     pairingOnRecord: FileManager.default.fileExists(atPath: Self.relayPairingPath))
    }

    /// The daemon's relay pairing (src/phone-relay.ts `relayPairingPath`): read for its presence only.
    static var relayPairingPath: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/conch/relay-pairing.json").path
    }

    /// At launch, for a Mac with no setup on record: waits a little for the daemon to say what it found and for the
    /// downloads to finish checking. Nil when the daemon never answered. Anything still unknown counts as there.
    func settleForLaunch() async -> OnboardingReadiness? {
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            if agents == nil { await refreshAgents() }
            if let read = SetupPublished.read() {
                published = read
                publishedSeen = true
            }
            let speechChecked = published.speech.map { $0.state != "checking" } ?? false
            let voicesChecked = published.voices.map { $0.state != "checking" } ?? true
            if agents != nil, speechChecked, voicesChecked { break }
            try? await Task.sleep(for: .seconds(1))
        }
        guard agents != nil else { return nil }
        var seen = readiness
        // A download or a voices rebuild under way is conch's to finish, not a step missing (`engineReadyAtLaunch`).
        seen.engineReady = OnboardingReports.engineReadyAtLaunch(speech: published.speech, voices: published.voices)
        // A daemon that doesn't publish the phone can't say whether one is paired.
        if !published.phoneKnown { seen.phonePaired = true }
        return seen
    }

    // MARK: Progress, on disk

    static var progressURL: URL {
        let environment = ProcessInfo.processInfo.environment
        let config = environment["CONCH_CONFIG_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/conch", isDirectory: true)
        return config.appendingPathComponent("onboarding.json")
    }

    static func loadProgress() -> OnboardingProgress? {
        guard let data = try? Data(contentsOf: progressURL) else { return nil }
        return try? JSONDecoder().decode(OnboardingProgress.self, from: data)
    }

    /// Written whole and atomically: a crash, a quit for a grant or a power cut leaves the old progress or the new.
    private func save() {
        guard let progress, let data = try? JSONEncoder().encode(progress) else { return }
        do {
            try FileManager.default.createDirectory(at: Self.progressURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: Self.progressURL, options: .atomic)
        } catch {
            let message = error.localizedDescription
            Task { await ConchSocketClient().reportAppError(operation: "onboarding.save", message: message) }
        }
    }

    /// Every event goes through the rule, and is saved at once.
    func apply(_ event: OnboardingEvent) {
        let before = progress?.step
        let next = (progress ?? OnboardingProgress()).applying(event, readiness: readiness)
        progress = next
        save()
        if case .phone = event, before == .phone, next.step != .phone {
            // The phone handed back: the Mac holds "All set on your iPhone" a moment, then carries on by itself.
            holdingPhone = true
            Task {
                try? await Task.sleep(for: .seconds(1.2))
                holdingPhone = false
                stepChanged()
            }
        }
        stepChanged()
    }

    func replace(_ next: OnboardingProgress?) {
        progress = next
        save()
        stepChanged()
    }

    /// The page on screen now.
    var shownStep: OnboardingStep? {
        guard let progress else { return nil }
        return holdingPhone ? .phone : progress.step
    }

    // MARK: Watching

    func windowOpened() {
        visible = true
        openedAt = openedAt ?? Date()
        watchInBackground()
        stepChanged()
        Task { await refreshAgents() }
        refreshNotifications()
    }

    func windowClosed() {
        visible = false
        stopStepWork()
        // The guide under System Settings belongs to setup's window: closed, conch stops waiting there.
        stopWaiting()
        if let progress, !progress.finished { apply(.close) }
        welcomeBack = nil
        stepTasksFor = nil
    }

    /// The published state, read while setup's window or Settings › Setup is on screen (often) or setup is unfinished
    /// (now and then), so the downloads move and the phone's reports reach the rule even with the window closed.
    func watchInBackground() {
        guard watcher == nil else { return }
        watcher = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.readPublished()
                let unfinished = self.progress.map { !$0.finished } ?? false
                guard let every = OnboardingWatch.interval(windowShown: self.visible, settingsShown: self.settingsShowing > 0,
                                                           unfinished: unfinished) else { self.watcher = nil; return }
                try? await Task.sleep(for: .seconds(every))
            }
        }
    }

    /// Settings › Setup, for as long as it is on screen: its downloads move as setup's window's do, on a finished Mac too.
    func watchWhileSettingsShown() async {
        settingsShowing += 1
        defer { settingsShowing -= 1 }
        watchInBackground()
        await refreshAgents()
        while !Task.isCancelled { try? await Task.sleep(for: .seconds(60)) }
    }

    private func readPublished() {
        guard let next = SetupPublished.read() else { return }
        if !publishedSeen { publishedSeen = true }
        if let progress = next.speech?.progress, next.speech?.state == "downloading", next.speech?.problem == nil {
            secondsLeft = clock.secondsLeft(bytes: progress.bytes, total: progress.total)
        } else {
            secondsLeft = nil
        }
        if next != published { published = next }
        // The phone's reports, into the rule: it mirrors them, then moves a waiting Mac on.
        // Only a report that changes something is applied (and saved): a late or repeated one changes nothing.
        if let handoff = next.phone?.handoff, let progress, progress.applying(.phone(handoff), readiness: readiness) != progress {
            apply(.phone(handoff))
        }
    }

    func refreshAgents() async {
        switch await SetupDaemon.ask(SetupDaemonRequest(kind: "setup-status"), timeout: 20, expecting: "setup-status") {
        case let .success(message):
            agents = message.agents ?? []
            agentProblem = nil
        case let .failure(failure):
            // Never "no agents" for a daemon that couldn't say: an older one doesn't know the question.
            if agents == nil { agentProblem = failure.words }
        }
    }

    private func refreshNotifications() {
        ReviewNotifications.shared.authorization { [weak self] status in
            Task { @MainActor in self?.notifications = status }
        }
    }

    // MARK: Each step's own work

    /// What each step does while it's on screen: agents are re-read, the microphone listens, the code is shown.
    private func stepChanged() {
        // Welcome back's page does no step's work: nothing listens or pairs until one of its rows opens a step.
        let step = visible && welcomeBack == nil ? shownStep : nil
        guard step != stepTasksFor else { return }
        stopStepWork()
        stepTasksFor = step
        switch step {
        case .agents?: watchAgents()
        case .voice?: startVoice(microphone: PermissionCenter.shared.statuses[.microphone])
        case .phone?: startPhone()
        // You're set's switch shows macOS's own answer: the first launch registered, and nothing is decided here.
        case .done?:
            LoginItem.shared.refresh()
        default: break
        }
    }

    private func stopStepWork() {
        micTask?.cancel()
        micTask = nil
        pairingTask?.cancel()
        pairingTask = nil
        agentsWatch?.cancel()
        agentsWatch = nil
    }

    // MARK: Agents

    private var agentsWatch: Task<Void, Never>?

    /// Re-read every few seconds while the step is up: a row goes green when its agent's first hook event arrives.
    private func watchAgents() {
        agentsWatch?.cancel()
        agentsWatch = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshAgents()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    var agentRows: [OnboardingAgent] {
        (agents ?? []).compactMap { report in
            OnboardingReports.agent(report, activity: OnboardingAgent.Kind(rawValue: report.agent).flatMap { activity[$0] })
        }
    }

    func agentAction(_ kind: OnboardingAgent.Kind, _ action: OnboardingAgentAction) {
        switch action {
        case .connect: connect(kind)
        case .install: install(kind)
        case .retry:
            switch lastAction[kind] {
            case .install?: install(kind)
            default: connect(kind)
            }
        case .signIn:
            let command = kind == .codex ? "codex login" : "claude"
            let failed: () -> Void = { [weak self] in
                self?.activity[kind] = .failed(reason: "conch couldn't open Terminal. Open it and run this yourself.", command: command)
            }
            guard let file = TerminalCommand.file(for: command), let stateStore else { return failed() }
            stateStore.openLink(file.path, cwd: nil, rowId: nil) { _ in failed() }
        case let .copy(command):
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(command, forType: .string)
        }
    }

    private func connect(_ kind: OnboardingAgent.Kind) {
        lastAction[kind] = .connect
        activity[kind] = .connecting
        Task {
            // Connecting installs conch's plugin with the agent's own CLI: allow it time.
            let result = await SetupDaemon.ask(SetupDaemonRequest(kind: "setup-connect", agent: kind.rawValue), timeout: 180, expecting: "setup-connected")
            switch result {
            case .success:
                activity[kind] = nil
            case let .failure(failure):
                activity[kind] = .failed(reason: failure.words, command: failure.command ?? "")
            }
            await refreshAgents()
        }
    }

    private func install(_ kind: OnboardingAgent.Kind) {
        lastAction[kind] = .install
        activity[kind] = .installing(line: "Starting its installer…")
        Task {
            let result = await SetupDaemon.stream(SetupDaemonRequest(kind: "setup-install", agent: kind.rawValue), timeout: 25 * 60, expecting: "setup-installed") { message in
                guard let line = message.line else { return }
                Task { @MainActor in
                    if case .installing? = self.activity[kind] { self.activity[kind] = .installing(line: line) }
                }
            }
            switch result {
            case .success:
                activity[kind] = nil
                await refreshAgents()
                // conch connects it when it's done.
                if agents?.first(where: { $0.agent == kind.rawValue })?.found == true { connect(kind) }
            case let .failure(failure):
                activity[kind] = .failed(reason: failure.words, command: failure.command ?? "")
            }
        }
    }

    // MARK: Permissions

    /// A row's one button, through `PermissionCenter`'s one door. Opening System Settings starts the wait, with the guide.
    func permissionAction(_ permission: ConchPermission, _ action: ConchPermissionAction) {
        guard let stateStore else { return }
        if action == .reopen {
            // A grant that only reaches a new conch: saved first, so the new one comes straight back to this step.
            apply(.reopenForGrant)
            Task {
                // Still here: the reopen didn't happen, and the row says so.
                try? await Task.sleep(for: .seconds(6))
                if progress?.reopening == true { apply(.launched) }
            }
        }
        PermissionCenter.shared.perform(action, for: permission, store: stateStore)
        let opensSettings = action == .openSettings || (action == .ask && (permission == .accessibility || permission == .screenRecording))
        if opensSettings { startWaiting(permission) }
    }

    /// The quiet "Allow now" for what's asked when first needed.
    func allowNow(_ ask: OnboardingDeferredAsk) {
        if ask.id == ConchPermission.screenRecording.rawValue {
            let status = PermissionCenter.shared.statuses[.screenRecording] ?? .notAsked
            return permissionAction(.screenRecording, status.action ?? .openSettings)
        }
        if notifications == .denied {
            // Turned off before: only System Settings turns it back on.
            stateStore?.openLink("x-apple.systempreferences:com.apple.Notifications-Settings.extension", cwd: nil, rowId: nil) { _ in }
            return
        }
        ReviewNotifications.shared.requestNow { [weak self] granted in
            Task { @MainActor in self?.notifications = granted ? .granted : .denied }
        }
    }

    /// conch watches the list System Settings has open: a 0.3 s read of that one permission, and the guide under the
    /// window, until the switch goes on or System Settings goes away.
    private func startWaiting(_ permission: ConchPermission) {
        waiting?.cancel()
        waitingOn = permission
        waiting = Task { [weak self] in
            let started = Date()
            var missingSince: Date?
            var lastFullRead = Date.distantPast
            while !Task.isCancelled, Date().timeIntervalSince(started) < 300 {
                try? await Task.sleep(for: .milliseconds(300))
                guard let self, !Task.isCancelled else { return }
                if await Self.granted(permission) || PermissionCenter.shared.statuses[permission] == .granted {
                    PermissionCenter.shared.refresh()
                    OnboardingController.shared.showGuide(for: permission, granted: true)
                    try? await Task.sleep(for: .seconds(1.2))
                    self.finishWaiting()
                    return
                }
                // Screen Recording reaches this process only on reopening: a new process's answer, every two seconds.
                if permission == .screenRecording, Date().timeIntervalSince(lastFullRead) > 2 {
                    lastFullRead = Date()
                    PermissionCenter.shared.refresh()
                    if PermissionCenter.shared.statuses[.screenRecording] == .needsRelaunch { self.finishWaiting(); return }
                }
                if SystemSettingsWindow.frame() == nil {
                    // System Settings closed, or not open yet: give it a moment to appear, then stop waiting.
                    missingSince = missingSince ?? Date()
                    if Date().timeIntervalSince(missingSince!) > 4 { self.finishWaiting(); return }
                    OnboardingController.shared.closeGuide()
                } else {
                    missingSince = nil
                    OnboardingController.shared.showGuide(for: permission, granted: false)
                }
            }
            self?.finishWaiting()
        }
    }

    /// One permission, read cheaply and silently: nothing here ever prompts.
    nonisolated private static func granted(_ permission: ConchPermission) async -> Bool {
        switch permission {
        case .accessibility, .microphone:
            return PermissionCenter.readHere()[permission] == .granted
        case .automation:
            return await Task.detached(priority: .utility) {
                ConchPermissionReading.automation(PermissionCenter.automation(ask: false)) == .granted
            }.value
        case .screenRecording:
            return false
        }
    }

    func stopWaiting() {
        waiting?.cancel()
        finishWaiting()
    }

    private func finishWaiting() {
        waiting = nil
        waitingOn = nil
        OnboardingController.shared.closeGuide()
    }

    /// `statuses` is the publisher's new value: in its sink `PermissionCenter.shared.statuses` is still the old one.
    private func permissionsChanged(_ statuses: [ConchPermission: ConchPermissionStatus]) {
        if stepTasksFor == .voice, mic.state == .needsPermission, statuses[.microphone] == .granted { startVoice(microphone: .granted) }
    }

    // MARK: Voice

    private func startVoice(microphone: ConchPermissionStatus?) {
        devices = AudioInputs.names()
        mic.device = AudioInputs.current() ?? "Microphone"
        guard microphone == .granted else {
            mic.state = .needsPermission
            mic.levels = []
            return
        }
        if heardYou, case .heard = mic.state { return }
        listen()
    }

    /// The microphone check, again until conch has heard you: levels as they come, then what whisper heard.
    private func listen() {
        micTask?.cancel()
        micTask = Task { [weak self] in
            var tries = 0
            while !Task.isCancelled {
                guard let self else { return }
                tries += 1
                self.mic.state = .listening
                self.mic.levels = []
                // Up to eight seconds of listening, then whisper: warm it's a moment, cold it can take a while.
                let result = await SetupDaemon.stream(SetupDaemonRequest(kind: "mic-check", seconds: 6), timeout: 75, expecting: "mic-check-done") { message in
                    guard let level = message.level else { return }
                    Task { @MainActor in
                        self.mic.levels = Array((self.mic.levels + [level]).suffix(44))
                    }
                }
                if Task.isCancelled { return }
                var pause: Duration = .seconds(1.5)
                switch result {
                case let .success(message):
                    if let heard = message.heard, !heard.isEmpty {
                        self.mic.state = .heard(heard)
                        self.heardYou = true
                        return
                    }
                    if message.silent == true {
                        self.mic.state = .silent
                    } else if message.recognition == "waiting" {
                        // The level moving is the proof until speech recognition arrives.
                        self.mic.state = .waitingForRecognition(self.speechFraction)
                        self.heardYou = true
                        return
                    } else {
                        self.mic.state = .problem("conch heard something, but no words. Say something again.")
                    }
                case let .failure(failure):
                    switch failure.reason {
                    case "speaking", "busy": pause = .seconds(1.5)
                    case "cancelled": return
                    default:
                        self.mic.state = .problem(failure.words)
                        pause = .seconds(4)
                    }
                    if failure.reason == "elsewhere" { return }
                }
                if tries > 40 { return }
                try? await Task.sleep(for: pause)
            }
        }
    }

    private var speechFraction: Double {
        guard let progress = published.speech?.progress, progress.total > 0 else { return 0 }
        return progress.bytes / progress.total
    }

    func hear(_ index: Int) {
        guard index < OnboardingVoiceStep.voices.count else { return }
        // The mic never opens while conch speaks: the check stops for the sample, and listens again after.
        micTask?.cancel()
        micTask = nil
        playing = index
        Task {
            let result = await SetupDaemon.ask(SetupDaemonRequest(kind: "voice-sample", voice: OnboardingVoiceStep.voices[index]), timeout: 30, expecting: "voice-sample-done")
            if playing == index { playing = nil }
            // A sample that didn't play here says why, in the step's one line for what went wrong: the phone or another
            // Mac holding the audio (the daemon refuses, `voice-sample` in src/setup.ts), or a daemon not answering.
            // The mic check would meet the same refusal, so it isn't started again over the words.
            if case let .failure(failure) = result, failure.reason != "cancelled" {
                mic.state = .problem(failure.words)
                return
            }
            if stepTasksFor == .voice, !heardYou, PermissionCenter.shared.statuses[.microphone] == .granted { listen() }
        }
    }

    func pickDevice(_ name: String) {
        if AudioInputs.choose(name) {
            mic.device = name
            heardYou = false
            listen()
        } else {
            mic.state = .problem("conch couldn't switch to \(name). Choose it in System Settings › Sound › Input.")
        }
    }

    var ring: VoiceRing { OnboardingReports.ring(published.voices, playing: playing) }

    // MARK: iPhone

    /// Reaching the step turns the phone on (decision 8), then shows a code, a fresh one before the typed code runs out.
    private func startPhone() {
        pairingTask?.cancel()
        pairingTask = Task { [weak self] in
            guard let self else { return }
            if !self.phoneTurnedOn {
                switch await SetupDaemon.client.request(SetupConfig(key: "phone", value: true), timeout: 5) {
                case .reply: self.phoneTurnedOn = true
                case .connectFailed, .timeout: break
                }
            }
            while !Task.isCancelled {
                await self.pairing.open()
                self.updatePairing()
                let left = (self.pairing.pairing?.expiresAt ?? 0) / 1000 - Date().timeIntervalSince1970
                try? await Task.sleep(for: .seconds(self.pairing.pairing == nil ? 5 : max(1, left - 4)))
            }
        }
    }

    func newCode() {
        Task {
            await pairing.open(force: true)
            updatePairing()
        }
    }

    private func updatePairing() {
        phoneQR = pairing.pairing?.relay.flatMap { ConchPairingStore.qr(for: $0, correction: "H") }.map { Image(nsImage: $0) }
        phoneFailure = pairing.error.map(Self.pairingWords)
    }

    /// The pairing store's words, in setup's: never "the daemon".
    static func pairingWords(_ error: String) -> String {
        if error.contains("isn't running") { return SetupDaemon.notAnswering }
        if error.contains("didn't answer") { return "conch's background service took too long to answer. New code tries again." }
        if error.contains("Phone access is off") { return "Phone access didn't turn on. New code tries again." }
        if error.contains("Could not read") { return "conch couldn't read the code it made. New code tries again." }
        return error
    }

    var phoneState: PhoneStepState {
        OnboardingReports.phoneStep(handoff: published.phone?.handoff ?? (holdingPhone ? progress?.phone : nil),
                                    relay: pairing.pairing?.relay != nil, failure: phoneFailure)
    }

    var lanCode: String {
        guard let code = pairing.pairing?.code, code.count == 6 else { return pairing.pairing?.code ?? "" }
        return "\(code.prefix(3)) \(code.suffix(3))"
    }

    var lanHost: String? {
        guard let pairing = pairing.pairing, let host = self.pairing.lanHosts.first else { return nil }
        return "\(host):\(pairing.port)"
    }

    // MARK: Try it

    /// Where Try it stands before Start: the microphone, speech recognition, and what the daemon last said.
    var practiceStart: PracticeStartState {
        OnboardingReports.practiceStart(microphone: PermissionCenter.shared.statuses[.microphone], speech: published.speech,
                                        refusal: practiceRefusal, starting: practiceStarting)
    }

    /// Start: the daemon's practice turn, held by its lease; then the window steps aside and the tour runs.
    func startPractice() {
        guard let stateStore, !practiceStarting, practiceLease == nil else { return }
        switch practiceStart {
        case .needsMicrophone, .waitingForRecognition, .starting: return
        case .ready, .audioElsewhere, .problem: break
        }
        practiceRefusal = nil
        practiceStarting = true
        Task {
            let opened = await SetupDaemon.client.open(SetupDaemonRequest(kind: "practice-start"), timeout: 5)
            practiceStarting = false
            guard let opened else {
                practiceRefusal = PracticeReport.Problem(reason: "unanswered", words: SetupDaemon.notAnswering)
                return
            }
            let reply = SetupDaemon.decode(opened.reply)
            guard reply?.kind == "practice-started" else {
                Darwin.close(opened.descriptor)
                practiceRefusal = PracticeReport.Problem(reason: reply?.reason ?? "unknown",
                                                         words: reply?.error ?? SetupDaemonFailure.olderDaemon.words)
                return
            }
            practiceLease = opened.descriptor
            OnboardingController.shared.stepAside()
            TourCoach.shared.start(store: stateStore) { outcome in self.tourClosed(outcome) }
        }
    }

    /// Try it's status line button: Allow… for a microphone that's off, Hand it back for audio that's elsewhere.
    func practiceAction() {
        switch practiceStart {
        case .needsMicrophone:
            permissionAction(.microphone, PermissionCenter.shared.statuses[.microphone]?.action ?? .ask)
        case .audioElsewhere:
            handBack()
        default:
            break
        }
    }

    /// "Hand it back": the audio back to this Mac with the phone's own hand-back (`audio-sink`), pressed by the person and
    /// never done for them, then Start again. The phone takes it again the next time conch comes forward on it.
    private func handBack() {
        Task {
            _ = await SetupDaemon.client.request(AudioSinkRequest(sink: "mac"), timeout: 5)
            practiceRefusal = nil
            startPractice()
        }
    }

    /// The tour closed: the practice turn goes, and the window comes back, on You're set unless the practice went away
    /// under the tour.
    private func tourClosed(_ outcome: TourProgress.Outcome) {
        endPractice()
        switch outcome {
        case .finished, .skipped:
            // Words reached the practice turn: that's conch hearing you too.
            if TourCoach.shared.progress.heard != nil { heardYou = true }
            apply(.next)
        case .ended:
            practiceRefusal = PracticeReport.Problem(reason: "ended", words: "The practice turn stopped before the tour was done. Start it again, or skip it.")
        }
        OnboardingController.shared.show()
    }

    /// The practice turn stopped in the daemon, and its lease let go.
    func endPractice() {
        guard let lease = practiceLease else { return }
        practiceLease = nil
        Task {
            _ = await SetupDaemon.client.request(SetupDaemonRequest(kind: "practice-stop"), timeout: 5)
            Darwin.close(lease)
        }
    }

    // MARK: You're set

    /// A session that needs an answer, or finished a turn while setup was open: offered first. Not every idle
    /// session: only one that finished since the window opened. Never the practice turn: it goes with the tour, which
    /// You're set follows, so its row is on its way out and there's nothing to answer.
    var waitingSession: SessionRow? {
        let since = (openedAt ?? Date()).timeIntervalSince1970 * 1000
        let rows = (stateStore?.state?.rows ?? []).filter { $0.id != TourCoach.practiceSessionId }
        return rows.first { $0.needsResponse || $0.status == .needs }
            ?? rows.first { $0.status == .waiting && $0.parentSessionId == nil && ($0.at ?? 0) >= since }
    }

    func firstAction(_ id: String) {
        switch id {
        case "answer":
            guard let row = waitingSession else { break }
            // The existing open-and-recite path: conch's window on the session, and its turn read aloud.
            ConchStatusItem.openSession(row.id)
            stateStore?.send(.recite(sessionId: row.id, label: row.label))
        case "start":
            // conch's window, forward, with its New session sheet; built first if it was closed.
            NSApp.activate(ignoringOtherApps: true)
            if let window = ReviewNotifications.shared.reviewWindow {
                if window.isMiniaturized { window.deminiaturize(nil) }
                window.makeKeyAndOrderFront(nil)
                NotificationCenter.default.post(name: .showSessionStart, object: nil)
            } else {
                NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: NSWorkspace.OpenConfiguration())
                Task {
                    try? await Task.sleep(for: .seconds(1))
                    NotificationCenter.default.post(name: .showSessionStart, object: nil)
                }
            }
        default:
            break
        }
        OnboardingController.shared.close()
    }

    // MARK: Downloads

    var downloads: [OnboardingDownload] {
        [OnboardingReports.speechRecognition(published.speech, secondsLeft: secondsLeft)] + [OnboardingReports.naturalVoices(published.voices)].compactMap { $0 }
    }

    func retry(_ download: OnboardingDownload) {
        Task {
            _ = await SetupDaemon.ask(SetupDaemonRequest(kind: "setup-retry", what: download.id == "stt" ? "speech" : "voices"), timeout: 5, expecting: "setup-ack")
            readPublished()
        }
    }
}

/// `set-config`, for the one setting setup turns on (`phone`, decision 8).
private struct SetupConfig: Encodable, Sendable {
    let kind = "set-config"
    let key: String
    let value: Bool
}

// MARK: - The window's view

struct OnboardingRootView: View {
    @ObservedObject var model: OnboardingStore
    @ObservedObject private var center = PermissionCenter.shared
    @ObservedObject private var login = LoginItem.shared
    let controller: OnboardingController
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum Page: Hashable {
        case welcome
        case welcomeBack
        case step(OnboardingStep)
    }

    private var page: Page {
        if model.welcomeBack != nil { return .welcomeBack }
        guard let step = model.shownStep, step != .welcome else { return .welcome }
        return .step(step)
    }

    var body: some View {
        ZStack {
            switch page {
            case .welcome:
                // The first launch's login line, when the welcome is what opened (`LoginItem.setupSettled`).
                OnboardingWelcome(backdrop: .shore, loginLine: login.welcomeLine?.words, onOpenLoginItems: loginFix(login.welcomeLine),
                                  onBegin: { model.apply(.begin) }, onLater: { controller.close() })
                    .transition(.onboardingSwap(reduceMotion: reduceMotion))
            case .welcomeBack, .step:
                OnboardingWindow(progress: model.progress ?? OnboardingProgress(), steps: model.readiness.rail, downloads: model.downloads,
                                 details: details, onOpen: open, onRetry: { model.retry($0) }) {
                    content
                        .id(page)
                        .transition(.onboardingSwap(reduceMotion: reduceMotion))
                }
            }
        }
        .animation(ConchMotion.swap.animation(reduceMotion: reduceMotion), value: page)
        .frame(width: OnboardingWindowMetrics.size.width, height: OnboardingWindowMetrics.size.height)
        .environment(\.conchAppIcon, Image(nsImage: NSApp.applicationIconImage))
        .environment(\.conchAgentMarks, ["claude": Image("AgentClaude"), "codex": Image("AgentCodex")])
    }

    private func open(_ step: OnboardingStep) {
        model.welcomeBack = nil
        model.apply(.open(step))
    }

    /// A login line's button, when its fix is in System Settings › General › Login Items.
    private func loginFix(_ line: LoginItemLine?) -> (() -> Void)? {
        guard line?.opensLoginItems == true else { return nil }
        return { LoginItem.shared.openLoginItems() }
    }

    /// The rail's words beside a step: how many permissions are allowed, what's off, what's new.
    private var details: [OnboardingStep: String] {
        let allowed = OnboardingReadiness.setupAsks.filter { center.statuses[$0] == .granted }.count
        var details: [OnboardingStep: String] = [:]
        if let missing = model.welcomeBack {
            if missing.contains(.permissions) { details[.permissions] = "\(OnboardingReadiness.setupAsks.count - allowed) off" }
            if missing.contains(.phone) { details[.phone] = "New" }
        } else if model.shownStep == .permissions {
            details[.permissions] = "\(allowed) of \(OnboardingReadiness.setupAsks.count)"
        }
        return details
    }

    @ViewBuilder private var content: some View {
        switch page {
        case .welcome:
            EmptyView()
        case .welcomeBack:
            welcomeBack
        case let .step(step):
            switch step {
            case .agents:
                OnboardingAgentsStep(agents: model.agentRows, problem: model.agentProblem, onAction: model.agentAction,
                                     onContinue: { model.apply(.next) }, onSkip: { model.apply(.skip) })
            case .permissions:
                OnboardingPermissionsStep(
                    statuses: center.statuses, waitingOn: model.waitingOn, notes: center.notes,
                    deferred: [ConchPermission.screenRecording.rawValue: center.statuses[.screenRecording] ?? .notAsked,
                               OnboardingDeferredAsk.notifications.id: model.notifications ?? .notAsked],
                    onAction: model.permissionAction, onAllowNow: model.allowNow,
                    onContinue: { model.apply(.next) }, onSkip: { model.apply(.skip) }
                )
            case .voice:
                OnboardingVoiceStep(ring: model.ring, mic: model.mic, devices: model.devices, onHear: model.hear,
                                    onPickDevice: model.pickDevice,
                                    onAllowMicrophone: { model.permissionAction(.microphone, center.statuses[.microphone]?.action ?? .ask) },
                                    onContinue: { model.apply(.next) }, onSkip: { model.apply(.skip) })
            case .phone:
                OnboardingPhoneStep(state: model.phoneState, qr: model.phoneQR, kind: .inApp, lanCode: model.lanCode, lanHost: model.lanHost,
                                    onNewCode: model.newCode, onContinue: { model.apply(.next) }, onSkip: { model.apply(.skip) })
            case .practice:
                if model.practiceAvailability == false {
                    // A daemon that says it can't run it (an older one): never on the rail, and straight on.
                    Color.clear.onAppear { model.apply(.skip) }
                } else {
                    // Unknown until the daemon has published (after a reboot, a moment): the page waits, and says why.
                    OnboardingPracticeStep(state: model.practiceAvailability == nil ? .problem(SetupDaemon.notAnswering) : model.practiceStart,
                                           onStart: model.startPractice, onSkip: { model.apply(.skip) }, onAction: model.practiceAction) {
                        PracticePreview()
                    }
                }
            case .done:
                OnboardingDoneStep(summary: summary, actions: firstActions, openAtLogin: login.isOn, loginNote: login.note?.words,
                                   onToggleLogin: { login.set($0) }, onOpenLoginItems: loginFix(login.note),
                                   onAction: model.firstAction, onClose: { controller.close() })
            case .welcome:
                EmptyView()
            }
        }
    }

    // MARK: Welcome back

    @ViewBuilder private var welcomeBack: some View {
        let missing = model.welcomeBack ?? []
        let permissions = missing.contains(.permissions) ? model.welcomeBackAsks : []
        let rows = permissions.count + (missing.contains(.voice) ? 1 : 0) + (missing.contains(.phone) ? 1 : 0)
        OnboardingWelcomeBack(count: rows, onDone: {
            // Finished while the page is still up, so no step's work runs on the way out.
            model.apply(.finish)
            controller.close()
        }, onNotNow: { controller.close() }) {
            ForEach(Array(permissions.enumerated()), id: \.element) { index, permission in
                if index > 0 { OnboardingDivider(leading: 54) }
                ConchPermissionRow(permission: permission, status: center.statuses[permission] ?? .unknown("Checking…"),
                                   note: center.notes[permission], onAction: { model.permissionAction(permission, $0) })
                    .padding(.horizontal, ConchSpace.x4)
                    .padding(.vertical, 12)
            }
            if missing.contains(.voice) {
                if !permissions.isEmpty { OnboardingDivider(leading: 54) }
                OnboardingActionRow(symbol: "waveform", title: "Voice", detail: "Check that conch can hear you, and hear its voices.", button: "Check") {
                    open(.voice)
                }
            }
            if missing.contains(.phone) {
                if !permissions.isEmpty || missing.contains(.voice) { OnboardingDivider(leading: 54) }
                OnboardingActionRow.phone { open(.phone) }
            }
        }
    }

    // MARK: You're set

    private var summary: [OnboardingSummaryLine] {
        let connected = (model.agents ?? []).filter(\.hooksWired).compactMap { OnboardingAgent.Kind(rawValue: $0.agent)?.name }
        let off = OnboardingReadiness.setupAsks.filter { center.statuses[$0] != .granted }.map(\.title)
        let phone = model.published.phone
        return [
            OnboardingSummaryLine(step: .agents, detail: connected.isEmpty ? "No agent connected" : "\(connected.joined(separator: " and ")) connected",
                                  status: "", done: !connected.isEmpty),
            OnboardingSummaryLine(step: .voice, detail: model.heardYou ? "conch heard you" : "Microphone check later", status: "", done: model.heardYou),
            OnboardingSummaryLine(step: .phone, detail: phone?.paired == true ? "\(phone?.device ?? "Your iPhone") paired" : model.phoneSetUp ? "iPhone set up" : "iPhone later",
                                  status: "", done: model.phoneSetUp),
            OnboardingSummaryLine(step: .permissions, detail: off.isEmpty ? "Permissions allowed" : "\(off.joined(separator: " and ")) later",
                                  status: "", done: off.isEmpty),
        ]
    }

    private var firstActions: [OnboardingFirstAction] {
        var actions: [OnboardingFirstAction] = []
        if let row = model.waitingSession {
            actions.append(OnboardingFirstAction(id: "answer", symbol: "waveform", title: "Answer \(row.label)",
                                                 detail: "It finished a turn while you were setting up. conch reads it to you now."))
        }
        actions.append(OnboardingFirstAction(id: "start", symbol: "plus", title: "Start a session",
                                             detail: "Claude Code or Codex, in a folder you pick. It opens in Terminal."))
        actions.append(OnboardingFirstAction(id: "wait", symbol: "cup.and.saucer", title: "Get on with your day",
                                             detail: "conch calls you when an agent has something."))
        return actions
    }
}

// MARK: - Settings › Setup

/// Settings' Setup tab: where each step stands, with its one button, the downloads, and Run setup again.
struct SetupSettingsTab: View {
    @ObservedObject private var model = OnboardingController.shared.model
    @ObservedObject private var center = PermissionCenter.shared

    var body: some View {
        ScrollView {
            OnboardingSettingsPane(lines: lines, downloads: model.downloads,
                                   onAction: { OnboardingController.shared.open(step: $0) },
                                   onRetry: { model.retry($0) },
                                   onRunAgain: { OnboardingController.shared.runAgain() })
                .frame(maxWidth: .infinity, alignment: .top)
        }
        .background(ConchColor.ground)
        .environment(\.conchAppIcon, Image(nsImage: NSApp.applicationIconImage))
        .task { await model.watchWhileSettingsShown() }
    }

    private var lines: [OnboardingSummaryLine] {
        let found = (model.agents ?? []).filter(\.found)
        let agentsDetail = found.isEmpty
            ? (model.agentProblem ?? "No agent on this Mac yet")
            : found.compactMap { report in
                OnboardingAgent.Kind(rawValue: report.agent).map { "\($0.name)\(report.version.map { " \($0)" } ?? "")" }
            }.joined(separator: " and ")
        let agentsDone = !found.isEmpty && found.allSatisfy(\.connected)
        let off = OnboardingReadiness.setupAsks.filter { center.statuses[$0] != .granted }.map(\.title)
        let voicesReady = OnboardingReports.voicesSettled(model.published.voices) && model.published.speech?.state == "ready"
        let phone = model.published.phone
        return [
            OnboardingSummaryLine(step: .agents, detail: agentsDetail, status: agentsDone ? "Connected" : (found.isEmpty ? "Install" : "Connect"), done: agentsDone),
            OnboardingSummaryLine(step: .permissions, detail: off.isEmpty ? "Microphone, Accessibility and Automation allowed" : "\(off.joined(separator: " and ")) \(off.count == 1 ? "is" : "are") off",
                                  status: off.isEmpty ? "Allowed" : "Turn on", done: off.isEmpty),
            OnboardingSummaryLine(step: .voice, detail: "\(AudioInputs.current() ?? "Microphone") · \(voicesReady ? "8 natural voices" : "voices on their way")",
                                  status: voicesReady ? "Ready" : "Check", done: voicesReady),
            OnboardingSummaryLine(step: .phone, detail: phone?.paired == true ? "\(phone?.device ?? "Your iPhone") paired"
                                    : model.phoneSetUp ? "Set up before. It reconnects when conch opens on your iPhone." : "Not paired",
                                  status: model.phoneSetUp ? "Paired" : "Pair", done: model.phoneSetUp),
        ]
    }
}
