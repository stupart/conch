import Foundation
import Combine
// test/daemon-host-launch.test.ts compiles this file with DaemonHealth.swift and DaemonEnvironment.swift beside it,
// as one module.
#if canImport(ConchDesign)
import ConchDesign
#endif

/// The app owns the daemon.
///
/// conch used to be two installs: an app you could see, and a launchd agent you
/// could not. Turning conch off meant knowing that `conch service off` existed,
/// and the agent's failures were invisible — it would sit alive in `ps` while
/// every phone request timed out, with nothing on screen to say so.
///
/// Tyler's ask was to collapse that: "one thing running and one thing they can
/// turn on/off / delete / install". So the daemon becomes a child process of
/// this app. Quitting conch stops it, dragging conch to the Trash removes it,
/// and the toggle that controls it is in the window rather than in a shell.
///
/// The one thing this must never do is start a SECOND daemon. Two daemons
/// fight over the same socket and the same microphone, and a stacked pair
/// caused most of one day's instability. Every start therefore probes the
/// socket first and adopts whatever is already answering.
@MainActor
final class DaemonHost: ObservableObject {
    enum State: Equatable {
        /// No daemon anywhere — nothing is listening and we started nothing.
        case stopped
        case starting
        /// We launched it, and it is ours to stop.
        case running(pid: Int32)
        /// Someone else's daemon owns the socket: a terminal, a launchd agent
        /// left over from an older install, or an earlier copy of this app (a
        /// rebuild relaunches the app while its daemon lives on). The switch
        /// doesn't turn it off, since it isn't ours to stop. The health check
        /// still watches it: running and not answering, it is frozen and is
        /// replaced like our own; stopped (Ctrl-Z, a debugger), it was paused on
        /// purpose and is never signalled (`DaemonHealth`).
        case adopted
        case failed(String)
    }

    @Published private(set) var state: State = .stopped
    /// The last few lines the daemon printed, so a failure is visible in the
    /// app instead of only in a log file nobody opens.
    @Published private(set) var recentOutput: [String] = []
    /// Who started the daemon we adopted, from the identity file the daemon
    /// writes once it owns the socket (`daemon-identity.ts`). Nil when the
    /// daemon is ours, absent, or too old to have written one.
    @Published private(set) var adoptedIdentity: Identity?
    /// Which daemon we launched: the bundled one, a checkout's, or a `conch` on
    /// PATH. Nil when none is ours.
    @Published private(set) var launchedFrom: LaunchCommand.Source?
    /// Said once the daemon stopped answering and was replaced, or while it is paused, until dismissed.
    @Published private(set) var recoveryNotice: String?
    /// The daemon is stopped in a terminal or a debugger (`DaemonHealth.Verdict.paused`): left alone, and said so.
    @Published private(set) var paused = false

    struct Identity: Decodable, Equatable {
        let pid: Int32
        let version: String
        /// "app" | "terminal" | "launchd" — what the launcher's CONCH_STARTED_BY declared.
        let startedBy: String
        /// When the daemon wrote it (epoch ms): after it began listening, so its process started before this.
        let startedAt: Double?
        /// The socket the daemon owns. Absent from older daemons.
        let socketPath: String?

        init(pid: Int32, version: String, startedBy: String, startedAt: Double? = nil, socketPath: String? = nil) {
            self.pid = pid
            self.version = version
            self.startedBy = startedBy
            self.startedAt = startedAt
            self.socketPath = socketPath
        }
    }

    private var process: Process?
    /// When `process` was launched: a daemon still starting may not be listening yet.
    private var launchedAt: Date?
    private var outputPipe: Pipe?
    /// Restarts after an exit, and their backoff: forgiven once a daemon has answered steadily (`DaemonHealth.CrashBudget`).
    private var crashes = DaemonHealth.CrashBudget()
    private var restartWork: DispatchWorkItem?
    /// Pings the daemon, ours or adopted (`DaemonHealth`); nil while there is none.
    private var healthTimer: Timer?
    /// Deliberately not `Bundle.main` — the daemon and the socket path have to
    /// agree, and the daemon reads this same default.
    private let socketPath = ProcessInfo.processInfo.environment["CONCH_SOCKET"] ?? "/tmp/conch.sock"
    /// The daemon's log, which the daemon inherits from this app's environment: what the app does to it goes there too.
    private let logPath = DaemonHealth.logPath()
    /// A connect is not an answer: a frozen daemon's backlog completes it (2026-09-28). This pings, and stops a
    /// daemon that has stopped answering, by its exact pid.
    private lazy var health = DaemonHealthMonitor(hooks: .init(
        socketPath: socketPath,
        target: { [weak self] in self?.healthTarget() },
        log: { [logPath] line in DaemonHealth.appendToLog(line, path: logPath) }
    ))

    var isOurs: Bool { if case .running = state { return true }; return false }

    // MARK: - Lifecycle

    /// Bring a daemon up, unless one is already answering.
    func start() {
        restartWork?.cancel()
        if case .running = state { return }
        // Only a person starts a daemon that failed: fresh budgets, for replacing frozen ones and for exits.
        if case .failed = state {
            health.forgetRestarts()
            crashes = DaemonHealth.CrashBudget()
        }

        // A daemon whose socket refuses connects but whose identity names a live process is not gone: a frozen
        // daemon's backlog fills and then refuses (2026-09-28), and one of ours started now would only lose the
        // socket's lock to it and exit, over and over. Adopt it, and the health check decides.
        if socketAnswers() || DaemonHost.signallableIdentity(socketPath: socketPath) != nil {
            adoptedIdentity = DaemonHost.readIdentity()
            state = .adopted
            watchHealth()
            return
        }

        guard let launch = DaemonHost.launchCommand() else {
            state = .failed(
                "Couldn't find the conch daemon. Reinstall conch, or run it from a checkout."
            )
            return
        }

        state = .starting
        let task = Process()
        task.executableURL = launch.executable
        task.arguments = launch.arguments
        if let directory = launch.workingDirectory { task.currentDirectoryURL = directory }

        // Never an agent session's own: an app opened from inside one inherits its account folder, its tmux and
        // its ids, and a daemon started with them could list no sessions (`DaemonEnvironment`, 2026-10-02).
        var environment = DaemonEnvironment.cleaned(ProcessInfo.processInfo.environment)
        // Deliberately NOT exporting CONCH_KEYSTROKE_FALLBACK: env beats the
        // settings file, so forcing it here made `keystroke-fallback` a dead
        // setting (audit 3b). The daemon's own default is on; the file decides.
        // Names us as the owner in the daemon's identity file, so another copy
        // of this app adopting it can say so rather than "outside this app".
        environment["CONCH_STARTED_BY"] = "app"
        environment["PATH"] = DaemonHost.daemonPath(inherited: environment["PATH"])
        // A Finder- or login-item-launched app carries the bare system PATH,
        // so the daemon it spawns could not find `mlx_audio.server` (Kokoro,
        // under ~/.local/bin) or a brew tool the way the launchd service can:
        // the service plist lists these same directories (src/install.ts).
        // Found the night of 2026-09-10: Kokoro installed, daemon still on `say`.
        // The natural voices set themselves up with the uv this app carries
        // (Contents/Helpers/uv, from scripts/embed-uv.sh): the daemon builds its
        // own Python environment with it (src/voice-env.ts), so a downloaded
        // conch needs nothing else installed. An explicit CONCH_UV wins.
        if environment["CONCH_UV"] == nil, let uv = DaemonHost.bundledUV() {
            environment["CONCH_UV"] = uv.path
        }
        // The speech engine too: whisper-cli, whisper-server and the
        // microphone recorder in Contents/Helpers, the VAD model in
        // Contents/Resources/models (scripts/embed-engine.sh). The app itself
        // never records; the daemon does. The daemon resolves them from this app
        // first (src/speech-engine.ts) — whichever daemon runs, the checkout's
        // included — and never from another copy of conch.
        if environment["CONCH_APP_BUNDLE"] == nil {
            environment["CONCH_APP_BUNDLE"] = Bundle.main.bundleURL.path
        }
        task.environment = environment

        // Capture output rather than inheriting: a GUI app has no terminal, so
        // inherited stdout goes nowhere and a startup failure would be silent.
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        outputPipe = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in self?.appendOutput(text) }
        }

        task.terminationHandler = { [weak self] finished in
            Task { @MainActor in self?.handleExit(finished) }
        }

        do {
            try task.run()
            process = task
            launchedAt = Date()
            launchedFrom = launch.source
            state = .running(pid: task.processIdentifier)
            watchHealth()
        } catch {
            state = .failed(error.localizedDescription)
            process = nil
        }
    }

    /// Stop the daemon we started. A daemon we merely adopted is not stopped
    /// here — it belongs to a terminal or a launchd agent, and killing someone
    /// else's process because our window closed would be a surprise. (Frozen,
    /// it is still replaced: that is the health check's, not this switch's.)
    func stop() {
        restartWork?.cancel()
        stopHealthWatch()
        crashes = DaemonHealth.CrashBudget()
        recoveryNotice = nil
        paused = false
        guard let task = process else {
            if case .adopted = state {} else { state = .stopped }
            return
        }
        process = nil
        launchedAt = nil
        launchedFrom = nil
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
        task.terminationHandler = nil
        // SIGTERM: the daemon unlinks its socket and stops the TTS worker on
        // the way out. SIGKILL would leave a stale socket that the next start
        // mistakes for a live daemon.
        task.terminate()
        state = .stopped
    }

    func restart() {
        stop()
        start()
    }

    /// A3's one button. The launchd agent is the other owner that made
    /// "adopted" a permanent state. Run the equivalent of `conch service off`
    /// — unload by label and drop the plist, never a kill by pattern — then
    /// start our own through the same start() that probes the socket first,
    /// so this can never stack a second daemon either.
    func takeOverFromLaunchd() {
        guard adoptedIdentity?.startedBy == "launchd",
              let command = DaemonHost.launchCommand(subcommand: ["service", "off"]) else { return }
        stopHealthWatch()
        state = .starting
        let task = Process()
        task.executableURL = command.executable
        task.arguments = command.arguments
        if let directory = command.workingDirectory { task.currentDirectoryURL = directory }
        task.terminationHandler = { [weak self] _ in
            Task { @MainActor in await self?.startOnceSocketQuiet() }
        }
        do {
            try task.run()
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// `launchctl bootout` returns as the job is removed, while the daemon may
    /// still be unlinking its socket. Wait for that, briefly, so start() does
    /// not simply re-adopt the daemon we just asked to leave.
    private func startOnceSocketQuiet() async {
        let deadline = Date().addingTimeInterval(5)
        while socketAnswers(), Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        adoptedIdentity = nil
        state = .stopped
        start()
    }

    // MARK: - Internals

    /// Ping the daemon every `interval`, ours or adopted, off the main thread (`DaemonHealth`).
    ///
    /// An adopted daemon is someone else's process, so there is no exit
    /// callback when it dies. The app sat on a dead socket twice in one day
    /// (A2): hooks failing, the phone gone, and the window still saying
    /// "Running — started outside this app". And a daemon of our own that
    /// freezes never exits at all: on 2026-09-28 one sat in a synchronous loop
    /// for eight minutes while a bare connect() to its socket kept succeeding.
    /// So both are asked, and one that is running and has stopped answering is
    /// stopped by its pid and replaced, adopted or ours; one that is simply gone
    /// is replaced by our own. One that is stopped (Ctrl-Z, `kill -STOP`, a
    /// debugger) was paused on purpose: it is never signalled, only said.
    private func watchHealth() {
        healthTimer?.invalidate()
        let timer = Timer(timeInterval: health.policy.interval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.checkHealth() }
        }
        RunLoop.main.add(timer, forMode: .common)
        healthTimer = timer
    }

    private func stopHealthWatch() {
        healthTimer?.invalidate()
        healthTimer = nil
    }

    private func checkHealth() async {
        switch state {
        case .running, .adopted: break
        default:
            stopHealthWatch()
            return
        }
        guard let verdict = await health.check() else { return }
        // Answers in a row for a while forgive the restarts before them, and their backoff.
        crashes.observed(verdict, at: Date())
        let pausedNow: Bool
        if case .paused = verdict { pausedNow = true } else { pausedNow = false }
        if paused, !pausedNow {
            // Continued: what was said about the pause goes with it.
            paused = false
            if recoveryNotice == Self.pausedWords { recoveryNotice = nil }
        }
        switch verdict {
        case .healthy, .suspect:
            return
        case .paused:
            // Said once, as it pauses: not again every ping, and not back after it is dismissed.
            guard !paused else { return }
            paused = true
            recoveryNotice = Self.pausedWords
        case .gone:
            // Ours says so itself, through handleExit. An adopted one says nothing: start our own.
            guard case .adopted = state else { return }
            stopHealthWatch()
            adoptedIdentity = nil
            state = .stopped
            start()
        case .unidentified(let failures):
            // Said once, when it first crosses the line: not again every ping, and not back after it is dismissed.
            guard failures == health.policy.failuresBeforeRestart else { return }
            recoveryNotice = "conch's background service stopped responding, and it isn't one this app can stop. "
                + "Quit it where it was started, then start conch again."
        case .unresponsive(let pid):
            await recoverFrozenDaemon(pid: pid)
        }
    }

    /// Stop a daemon that stopped answering, by its pid, and start another within the restart budget.
    private func recoverFrozenDaemon(pid: Int32) async {
        stopHealthWatch()
        // Detached first: the exit this causes is the recovery's to handle, not handleExit's.
        if let task = process, task.processIdentifier == pid {
            process = nil
            launchedAt = nil
            launchedFrom = nil
            outputPipe?.fileHandleForReading.readabilityHandler = nil
            outputPipe = nil
            task.terminationHandler = nil
        }
        adoptedIdentity = nil
        state = .starting
        let recovery = await health.recover(pid: pid)
        // A stop() while it was being stopped: leave it off.
        guard case .starting = state else { return }
        guard recovery.termination != .survived else {
            state = .failed("conch's background service stopped responding and could not be stopped (pid \(pid)).")
            return
        }
        switch recovery.plan {
        case .restart:
            recoveryNotice = "conch's background service stopped responding and was restarted."
            // The freeze budget allowed it (`health.recover`): not an exit, so not the crash budget's to count.
            scheduleRestart(after: 2)
        case .giveUp:
            recoveryNotice = nil
            state = .failed("conch's background service kept freezing, so it was stopped. Check the log, then start it again.")
        }
    }

    func dismissRecoveryNotice() {
        recoveryNotice = nil
    }

    /// What the window and Settings say while the daemon is paused.
    static let pausedWords = "conch's background service is paused (stopped in a terminal or debugger)."

    /// The process a failed health check may stop: our own child, or the daemon an identity file names on our
    /// socket, when that process is the one that wrote it.
    private func healthTarget() -> DaemonHealth.Target? {
        switch state {
        case .running:
            guard let task = process else { return nil }
            return DaemonHealth.Target(pid: task.processIdentifier, launchedAt: launchedAt)
        case .adopted:
            return DaemonHost.signallableIdentity(socketPath: socketPath).map { DaemonHealth.Target(pid: $0.pid) }
        default:
            return nil
        }
    }

    private func handleExit(_ finished: Process) {
        guard process === finished else { return } // a stop() we already handled
        process = nil
        launchedAt = nil
        launchedFrom = nil
        stopHealthWatch()
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
        // Back off rather than hammering. A daemon that cannot start — a port
        // already taken, a machine with no memory left — should not become a
        // restart loop that makes the machine worse.
        switch crashes.exited() {
        case .restart(let delay):
            scheduleRestart(after: delay)
        case .giveUp:
            state = .failed("The daemon kept stopping. Check the log, then start it again.")
        }
    }

    private func scheduleRestart(after delay: TimeInterval) {
        state = .starting
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in self?.start() }
        }
        restartWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func appendOutput(_ text: String) {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        guard !lines.isEmpty else { return }
        recentOutput.append(contentsOf: lines)
        if recentOutput.count > 40 { recentOutput.removeFirst(recentOutput.count - 40) }
        // Output is not what forgives a crash loop: headless, the daemon prints
        // nothing, and one that prints and exits is the loop. Answering pings
        // for a while is (`checkHealth`, `DaemonHealth.CrashBudget`).
    }

    /// The PATH the daemon needs, whatever the app was launched with: brew,
    /// uv tools (mlx_audio.server), bun, then whatever was inherited.
    nonisolated static func daemonPath(inherited: String?, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> String {
        let wanted = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            home.appendingPathComponent(".local/bin").path,
            home.appendingPathComponent(".bun/bin").path,
        ]
        let existing = (inherited ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        var seen = Set<String>()
        return (wanted + existing).filter { seen.insert($0).inserted }.joined(separator: ":")
    }

    /// The uv embedded in this app by the "Embed uv helper" build phase, if it is there.
    nonisolated static func bundledUV(
        bundle: Bundle = .main,
        fileExists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    ) -> URL? {
        let uv = bundle.bundleURL.appendingPathComponent("Contents/Helpers/uv")
        return fileExists(uv.path) ? uv : nil
    }

    /// Is a daemon already listening?
    ///
    /// The socket FILE existing proves nothing — a killed daemon leaves one
    /// behind, and that stale path is exactly what would fool us into adopting
    /// a daemon that is not there. Only a successful connect counts.
    private func socketAnswers() -> Bool {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return false }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: pathBytes)
        }

        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                connect(descriptor, rebound, size)
            }
        }
        return connected == 0
    }

    // MARK: - Who owns an adopted daemon

    /// `~/.cache/conch/daemon.json`, written by the daemon once it owns the
    /// socket and removed on its way out (`daemon-identity.ts`). A record whose
    /// pid is gone is no record: a stale file must never name an owner.
    nonisolated static func readIdentity(
        path: String = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".cache/conch/daemon.json").path,
        alive: (Int32) -> Bool = { kill($0, 0) == 0 || errno == EPERM }
    ) -> Identity? {
        guard let data = FileManager.default.contents(atPath: path),
              let identity = try? JSONDecoder().decode(Identity.self, from: data),
              alive(identity.pid) else { return nil }
        return identity
    }

    /// The identity file's daemon, only when the app may signal it: alive, on this socket, and the very process that
    /// wrote the file — a pid reused since by something else started after the file was written.
    nonisolated static func signallableIdentity(
        socketPath: String,
        identity: Identity? = DaemonHost.readIdentity(),
        processStartedAt: (Int32) -> Date? = { DaemonHealth.processStartTime($0) }
    ) -> Identity? {
        guard let identity, identity.socketPath == socketPath, let startedAt = identity.startedAt,
              DaemonHealth.identityMatchesProcess(
                writtenAt: Date(timeIntervalSince1970: startedAt / 1_000),
                processStartedAt: processStartedAt(identity.pid)
              ) else { return nil }
        return identity
    }

    // MARK: - Finding the daemon

    struct LaunchCommand: Equatable {
        /// Where the daemon came from, for the log and the status the app shows.
        enum Source: String, Equatable {
            /// `Contents/Helpers/conch-daemon`, compiled into this app by
            /// scripts/embed-daemon.sh — what a downloaded conch runs.
            case bundled
            /// `~/conch/src/cli.ts` under `~/.bun/bin/bun` — a developer's.
            case checkout
            /// A `conch` on the daemon's PATH — Homebrew's CLI, usually.
            case path
        }

        let executable: URL
        let arguments: [String]
        let workingDirectory: URL?
        let source: Source
    }

    /// Does this build run the daemon from a checkout first?
    ///
    /// A dev install (scripts/build-app.sh) says "checkout" in its Info.plist
    /// (`ConchDaemonSource`, from the `CONCH_DAEMON_SOURCE` build setting): the
    /// bundled binary would be stale the moment anyone edits the source. A
    /// release says "bundled". `CONCH_DAEMON_SOURCE` in the environment wins, for
    /// an app started from a shell. The build is what differs, not the
    /// configuration: build-app.sh builds Release too, so Debug-vs-Release could
    /// not tell Tyler's install from a shipped one.
    nonisolated static func prefersCheckout(
        bundle: Bundle = .main,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Bool {
        let declared = environment["CONCH_DAEMON_SOURCE"]
            ?? (bundle.object(forInfoDictionaryKey: "ConchDaemonSource") as? String)
        return declared?.trimmingCharacters(in: .whitespaces).lowercased() == "checkout"
    }

    /// The daemon to run, in order.
    ///
    /// A release: the copy inside this app, so a downloaded conch works with
    /// nothing else installed; then a `conch` on PATH (Homebrew's CLI); then a
    /// checkout. A dev install: the checkout first, then the same two — so a
    /// missing or moved checkout still leaves a working daemon.
    nonisolated static func launchCommand(
        subcommand: [String] = ["daemon"],
        bundle: Bundle = .main,
        preferCheckout: Bool? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileExists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
        isFile: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> LaunchCommand? {
        let bundled = bundledDaemon(bundle: bundle, fileExists: fileExists).map {
            LaunchCommand(executable: $0, arguments: subcommand, workingDirectory: nil, source: .bundled)
        }
        let onPath = pathDaemon(environment: environment, home: home, fileExists: fileExists).map {
            LaunchCommand(executable: $0, arguments: subcommand, workingDirectory: nil, source: .path)
        }
        let checkout = checkoutDaemon(subcommand: subcommand, fileExists: fileExists, isFile: isFile, home: home)
        let order = (preferCheckout ?? prefersCheckout(bundle: bundle, environment: environment))
            ? [checkout, bundled, onPath]
            : [bundled, onPath, checkout]
        return order.compactMap { $0 }.first
    }

    /// `Contents/Helpers/conch-daemon`, where scripts/embed-daemon.sh puts it.
    nonisolated static func bundledDaemon(
        bundle: Bundle = .main,
        fileExists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    ) -> URL? {
        let daemon = bundle.bundleURL.appendingPathComponent("Contents/Helpers/conch-daemon")
        return fileExists(daemon.path) ? daemon : nil
    }

    /// The first `conch` on the PATH the daemon would get: Homebrew's, then
    /// whatever the app inherited.
    nonisolated static func pathDaemon(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        fileExists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    ) -> URL? {
        for directory in daemonPath(inherited: environment["PATH"], home: home).split(separator: ":") {
            let conch = URL(fileURLWithPath: String(directory)).appendingPathComponent("conch")
            if fileExists(conch.path) { return conch }
        }
        return nil
    }

    /// A conch checkout at `~/conch`, run with `~/.bun/bin/bun`.
    nonisolated static func checkoutDaemon(
        subcommand: [String] = ["daemon"],
        fileExists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
        isFile: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> LaunchCommand? {
        let checkout = home.appendingPathComponent("conch")
        let entry = checkout.appendingPathComponent("src/cli.ts")
        let bun = home.appendingPathComponent(".bun/bin/bun")
        guard isFile(entry.path), fileExists(bun.path) else { return nil }
        return LaunchCommand(
            executable: bun,
            arguments: [entry.path] + subcommand,
            workingDirectory: checkout,
            source: .checkout
        )
    }
}
