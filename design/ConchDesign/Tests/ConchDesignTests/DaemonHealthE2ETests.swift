#if os(macOS)
import Darwin
import XCTest
@testable import ConchDesign

/// A real daemon, frozen, found and replaced by the same `DaemonHealthMonitor` the Mac app runs; and a real daemon
/// paused with SIGSTOP, left alone by it.
///
/// Opt-in: `scripts/daemon-watchdog-e2e.ts` builds a temporary home and socket, writes a config, and runs this with
/// `CONCH_DAEMON_E2E=<config.json>`. Without it the test is skipped, so the gate never starts a daemon. It never
/// touches the live daemon: the socket, the log and every process it signals are the ones the config names, and the
/// processes it signals are only the ones it launched itself, by pid.
final class DaemonHealthE2ETests: XCTestCase {
    struct Command: Decodable {
        let argv: [String]
        let env: [String: String]
        let cwd: String
    }

    struct Config: Decodable {
        let socket: String
        let log: String
        let result: String
        /// The daemon to freeze: `freeze` and `freeze-adopted` expect it to freeze by itself (the real 2026-09-28 freeze);
        /// `paused` sends it SIGSTOP once it answers, as Ctrl-Z would.
        let frozen: Command
        /// `freeze`: the app launched it. `freeze-adopted`: the app adopted it (no launch time, as for a daemon a terminal,
        /// launchd or an earlier copy of the app started). `paused`: stopped on purpose, and never signalled.
        let mode: String
        /// What the recovery starts in its place.
        let replacement: Command
        /// Wait for the replacement to publish this string to this file before stopping it.
        let published: Published?
    }

    struct Published: Decodable {
        let path: String
        let contains: String
    }

    struct Result: Encodable {
        var mode = ""
        var frozenPid: Int32 = 0
        var answeredBeforeFreeze = false
        var verdicts: [String] = []
        var secondsToVerdict = 0.0
        var termination = ""
        var frozenAliveAfter = true
        var replacementPid: Int32 = 0
        var replacementPong: Int32?
        var secondsToReplacementPong = 0.0
        var replacementPublished: Bool?
        /// `paused`: signals the monitor sent (none), whether the kernel said stopped, and the first verdict once continued.
        var signals: [[Int32]] = []
        var pausedSeen = false
        var aliveWhilePaused = false
        var verdictAfterContinue = ""
    }

    @MainActor
    func testAFrozenDaemonIsStoppedByItsPidAndReplaced() async throws {
        guard let configPath = ProcessInfo.processInfo.environment["CONCH_DAEMON_E2E"] else {
            throw XCTSkip("set CONCH_DAEMON_E2E (scripts/daemon-watchdog-e2e.ts) to run a real daemon")
        }
        let config = try JSONDecoder().decode(Config.self, from: Data(contentsOf: URL(fileURLWithPath: configPath)))
        let policy = DaemonHealth.Policy.standard
        var result = Result(mode: config.mode)

        let frozen = try launch(config.frozen)
        result.frozenPid = frozen.processIdentifier
        let launchedAt = Date()
        defer { if frozen.isRunning { kill(frozen.processIdentifier, SIGKILL) } }

        // Up: it answers (to be stopped), or it is listening (to freeze by itself on its first panel build).
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            let probe = await DaemonHealth.ping(socketPath: config.socket, timeout: 1)
            if case .answered(let pid) = probe, pid == frozen.processIdentifier { result.answeredBeforeFreeze = true; break }
            if config.mode == "freeze", case .silent(let peer) = probe, peer == frozen.processIdentifier { break }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        if config.mode == "paused" {
            XCTAssertTrue(result.answeredBeforeFreeze, "the daemon never answered a ping")
            try await leavesAPausedDaemonAlone(frozen, config: config, policy: policy, result: &result)
            return
        }

        let adopted = config.mode == "freeze-adopted"
        let monitor = DaemonHealthMonitor(policy: policy, hooks: .init(
            socketPath: config.socket,
            target: { DaemonHealth.Target(pid: frozen.processIdentifier, launchedAt: adopted ? nil : launchedAt) },
            log: { DaemonHealth.appendToLog($0, path: config.log) }
        ))
        // As DaemonHost's timer does: a check every `interval`.
        let started = Date()
        var unresponsive: Int32?
        while unresponsive == nil, Date().timeIntervalSince(started) < 60 {
            let tick = Date()
            if let verdict = await monitor.check() {
                result.verdicts.append(String(describing: verdict))
                if case .unresponsive(let pid) = verdict { unresponsive = pid }
            }
            let rest = policy.interval - Date().timeIntervalSince(tick)
            if unresponsive == nil, rest > 0 { try await Task.sleep(nanoseconds: UInt64(rest * 1_000_000_000)) }
        }
        result.secondsToVerdict = Date().timeIntervalSince(started)
        let pid = try XCTUnwrap(unresponsive, "never found unresponsive: \(result.verdicts)")
        XCTAssertEqual(pid, frozen.processIdentifier)

        let recovery = await monitor.recover(pid: pid)
        result.termination = String(describing: recovery.termination)
        XCTAssertEqual(recovery.plan, .restart)
        frozen.waitUntilExit()
        result.frozenAliveAfter = DaemonHealth.isAlive(pid)
        XCTAssertFalse(result.frozenAliveAfter)

        let replacement = try launch(config.replacement)
        result.replacementPid = replacement.processIdentifier
        defer {
            if replacement.isRunning {
                replacement.terminate()
                let stopBy = Date().addingTimeInterval(10)
                while replacement.isRunning, Date() < stopBy { usleep(100_000) }
                if replacement.isRunning { kill(replacement.processIdentifier, SIGKILL) }
            }
        }
        let upBy = Date().addingTimeInterval(30)
        let replacedAt = Date()
        while Date() < upBy {
            if case .answered(let answered) = await DaemonHealth.ping(socketPath: config.socket, timeout: 1), let answered {
                result.replacementPong = answered
                break
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        result.secondsToReplacementPong = Date().timeIntervalSince(replacedAt)
        XCTAssertEqual(result.replacementPong, replacement.processIdentifier)
        if let published = config.published {
            let by = Date().addingTimeInterval(20)
            var seen = false
            while !seen, Date() < by {
                seen = (try? String(contentsOfFile: published.path, encoding: .utf8))?.contains(published.contains) == true
                if !seen { try await Task.sleep(nanoseconds: 250_000_000) }
            }
            result.replacementPublished = seen
            XCTAssertTrue(seen, "the replacement never published \(published.contains)")
        }
        XCTAssertNotEqual(replacement.processIdentifier, frozen.processIdentifier)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(result).write(to: URL(fileURLWithPath: config.result))
    }

    /// `kill -STOP`, as Ctrl-Z in its terminal: the monitor, as the app runs it, says paused at every check and sends
    /// nothing, well past the three silent pings that stop a frozen one; SIGCONT, and it answers.
    @MainActor
    private func leavesAPausedDaemonAlone(_ daemon: Process, config: Config, policy: DaemonHealth.Policy, result: inout Result) async throws {
        let pid = daemon.processIdentifier
        defer {
            kill(pid, SIGCONT)
            if daemon.isRunning {
                daemon.terminate()
                let stopBy = Date().addingTimeInterval(10)
                while daemon.isRunning, Date() < stopBy { usleep(100_000) }
                if daemon.isRunning { kill(pid, SIGKILL) }
            }
        }
        XCTAssertEqual(kill(pid, SIGSTOP), 0)
        let signals = SignalLog()
        let monitor = DaemonHealthMonitor(policy: policy, hooks: .init(
            socketPath: config.socket,
            // Adopted: no launch time, so no startup grace either.
            target: { DaemonHealth.Target(pid: pid) },
            signal: { signals.record($0, $1); _ = kill($0, $1) },
            log: { DaemonHealth.appendToLog($0, path: config.log) }
        ))
        let started = Date()
        for _ in 0..<(policy.failuresBeforeRestart + 2) {
            let tick = Date()
            if let verdict = await monitor.check() { result.verdicts.append(String(describing: verdict)) }
            result.pausedSeen = result.pausedSeen || DaemonHealth.isPaused(pid)
            let rest = policy.interval - Date().timeIntervalSince(tick)
            if rest > 0 { try await Task.sleep(nanoseconds: UInt64(rest * 1_000_000_000)) }
        }
        result.secondsToVerdict = Date().timeIntervalSince(started)
        result.signals = signals.sent
        result.aliveWhilePaused = DaemonHealth.isAlive(pid)
        XCTAssertEqual(result.verdicts, Array(repeating: "paused(pid: \(pid))", count: policy.failuresBeforeRestart + 2))
        XCTAssertEqual(result.signals, [])
        XCTAssertTrue(result.aliveWhilePaused)

        XCTAssertEqual(kill(pid, SIGCONT), 0)
        let answerBy = Date().addingTimeInterval(10)
        while Date() < answerBy {
            let verdict = await monitor.check()
            result.verdictAfterContinue = verdict.map { String(describing: $0) } ?? ""
            if verdict == .healthy { break }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        XCTAssertEqual(result.verdictAfterContinue, "healthy")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(result).write(to: URL(fileURLWithPath: config.result))
    }

    private func launch(_ command: Command) throws -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command.argv[0])
        process.arguments = Array(command.argv.dropFirst())
        process.environment = command.env
        process.currentDirectoryURL = URL(fileURLWithPath: command.cwd)
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        return process
    }
}

private final class SignalLog: @unchecked Sendable {
    private let lock = NSLock()
    private var all: [[Int32]] = []
    var sent: [[Int32]] { lock.lock(); defer { lock.unlock() }; return all }
    func record(_ pid: Int32, _ signal: Int32) { lock.lock(); all.append([pid, signal]); lock.unlock() }
}
#endif
