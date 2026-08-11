import Foundation
import Combine

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
        /// Someone else's daemon owns the socket: a terminal, or a launchd
        /// agent left over from an older install. We show it and leave it be.
        case adopted
        case failed(String)
    }

    @Published private(set) var state: State = .stopped
    /// The last few lines the daemon printed, so a failure is visible in the
    /// app instead of only in a log file nobody opens.
    @Published private(set) var recentOutput: [String] = []

    private var process: Process?
    private var outputPipe: Pipe?
    private var restartAttempts = 0
    private var restartWork: DispatchWorkItem?
    /// Deliberately not `Bundle.main` — the daemon and the socket path have to
    /// agree, and the daemon reads this same default.
    private let socketPath = ProcessInfo.processInfo.environment["CONCH_SOCKET"] ?? "/tmp/conch.sock"

    var isOurs: Bool { if case .running = state { return true }; return false }

    // MARK: - Lifecycle

    /// Bring a daemon up, unless one is already answering.
    func start() {
        restartWork?.cancel()
        if case .running = state { return }

        if socketAnswers() {
            state = .adopted
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

        var environment = ProcessInfo.processInfo.environment
        // The daemon types into other terminals when it cannot reach a pane
        // directly; without this it silently does nothing on those sessions.
        environment["CONCH_KEYSTROKE_FALLBACK"] = "1"
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
            state = .running(pid: task.processIdentifier)
        } catch {
            state = .failed(error.localizedDescription)
            process = nil
        }
    }

    /// Stop the daemon we started. A daemon we merely adopted is left alone —
    /// it belongs to a terminal or a launchd agent, and killing someone else's
    /// process because our window closed would be a surprise.
    func stop() {
        restartWork?.cancel()
        restartAttempts = 0
        guard let task = process else {
            if case .adopted = state {} else { state = .stopped }
            return
        }
        process = nil
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

    // MARK: - Internals

    private func handleExit(_ finished: Process) {
        guard process === finished else { return } // a stop() we already handled
        process = nil
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil

        // Back off rather than hammering. A daemon that cannot start — a port
        // already taken, a machine with no memory left — should not become a
        // restart loop that makes the machine worse.
        restartAttempts += 1
        guard restartAttempts <= 5 else {
            state = .failed("The daemon kept stopping. Check the log, then start it again.")
            return
        }
        let delay = Double(min(30, 1 << restartAttempts))
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
        // Output means it got far enough to talk, so stop counting this as a
        // crash loop; otherwise a daemon restarted five times over a long
        // session would refuse to come back.
        restartAttempts = 0
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

    // MARK: - Finding the daemon

    struct LaunchCommand {
        let executable: URL
        let arguments: [String]
        let workingDirectory: URL?
    }

    /// Prefer the copy inside the app bundle, so a downloaded conch works with
    /// nothing else installed. Fall back to a checkout for development, where
    /// the bundled binary would be stale the moment anyone edits the source.
    static func launchCommand(
        bundle: Bundle = .main,
        fileExists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> LaunchCommand? {
        if let bundled = bundle.url(forResource: "conch-daemon", withExtension: nil),
           fileExists(bundled.path) {
            return LaunchCommand(executable: bundled, arguments: ["daemon"], workingDirectory: nil)
        }

        let checkout = home.appendingPathComponent("conch")
        let entry = checkout.appendingPathComponent("src/cli.ts")
        let bun = home.appendingPathComponent(".bun/bin/bun")
        if FileManager.default.fileExists(atPath: entry.path), fileExists(bun.path) {
            return LaunchCommand(
                executable: bun,
                arguments: [entry.path, "daemon"],
                workingDirectory: checkout
            )
        }
        return nil
    }
}
