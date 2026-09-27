#if os(macOS)
import Darwin
import XCTest
@testable import ConchDesign

/// A real daemon, frozen, found and replaced by the same `DaemonHealthMonitor` the Mac app runs.
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
        /// The daemon to freeze: `stop` sends it SIGSTOP once it answers; `freeze` expects it to freeze by itself.
        let frozen: Command
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
        if config.mode == "stop" {
            XCTAssertTrue(result.answeredBeforeFreeze, "the daemon never answered a ping")
            XCTAssertEqual(kill(frozen.processIdentifier, SIGSTOP), 0)
        }

        let monitor = DaemonHealthMonitor(policy: policy, hooks: .init(
            socketPath: config.socket,
            target: { DaemonHealth.Target(pid: frozen.processIdentifier, launchedAt: launchedAt) },
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
#endif
