#if os(macOS)
import Darwin
import XCTest
@testable import ConchDesign

/// The app's liveness check on its daemon, and what it does when the daemon stops answering (`DaemonHealth`).
///
/// On 2026-09-28 a daemon froze in a synchronous loop and the app, whose check was a bare `connect()`, went on calling it
/// alive for eight minutes. These pin the decision (when a daemon is stopped, and when it never is), the ping against
/// real sockets (answered, silent, refused, a full backlog), the stop itself against real processes (SIGTERM, then
/// SIGKILL for one that ignores it), and the monitor that joins them.
final class DaemonHealthTests: XCTestCase {
    private let policy = DaemonHealth.Policy.standard
    private let now = Date(timeIntervalSince1970: 1_790_000_000)
    private let ours = DaemonHealth.Target(pid: 4242, launchedAt: Date(timeIntervalSince1970: 1_790_000_000 - 3_600))

    // MARK: - The decision

    func testThePolicyNumbersAreTheOnesTheCommentJustifies() {
        XCTAssertEqual(policy.interval, 5)
        XCTAssertEqual(policy.timeout, 3)
        XCTAssertEqual(policy.failuresBeforeRestart, 3)
        XCTAssertEqual(policy.terminateGrace, 5)
        XCTAssertEqual(policy.startupGrace, 20)
        XCTAssertEqual(policy.restartLimit, 3)
        XCTAssertEqual(policy.restartWindow, 600)
        // Three unanswered pings span at least 13 s: far past a busy second or two, and past a hook's 4 s timeout.
        XCTAssertEqual(policy.minimumSilence, 13)
    }

    func testThreeSilentPingsInARowStopTheDaemonAndNotBefore() {
        var failures = 0
        var verdicts: [DaemonHealth.Verdict] = []
        for _ in 0..<3 {
            let (next, verdict) = DaemonHealth.decide(
                failures: failures, probe: .silent(peerPID: 4242), target: ours, alive: true, now: now
            )
            failures = next
            verdicts.append(verdict)
        }
        XCTAssertEqual(verdicts, [.suspect(failures: 1), .suspect(failures: 2), .unresponsive(pid: 4242)])
    }

    func testOneAnswerForgivesEverythingBeforeIt() {
        // A daemon busy for a second or two misses at most one ping; the next answer starts the count again.
        let (afterTwo, _) = DaemonHealth.decide(failures: 1, probe: .silent(peerPID: nil), target: ours, alive: true, now: now)
        XCTAssertEqual(afterTwo, 2)
        let (reset, verdict) = DaemonHealth.decide(failures: afterTwo, probe: .answered(pid: 4242), target: ours, alive: true, now: now)
        XCTAssertEqual(reset, 0)
        XCTAssertEqual(verdict, .healthy)
        // An older daemon's error line is an answer too: its loop turned to write it.
        XCTAssertEqual(DaemonHealth.decide(failures: 2, probe: .answered(pid: nil), target: ours, alive: true, now: now).verdict, .healthy)
    }

    func testAnAlternatingDaemonIsNeverStopped() {
        var failures = 0
        for round in 0..<20 {
            let probe: DaemonHealth.Probe = round.isMultiple(of: 2) ? .silent(peerPID: 4242) : .answered(pid: 4242)
            let (next, verdict) = DaemonHealth.decide(failures: failures, probe: probe, target: ours, alive: true, now: now)
            failures = next
            if case .unresponsive = verdict { XCTFail("stopped a daemon that answers every other ping") }
        }
    }

    func testAFullBacklogCountsLikeSilenceWhileTheProcessLives() {
        // A frozen daemon's backlog fills, and then connects are refused: the process is alive, so that is not "gone".
        var failures = 0
        var last: DaemonHealth.Verdict = .healthy
        for _ in 0..<3 {
            (failures, last) = DaemonHealth.decide(failures: failures, probe: .unreachable, target: ours, alive: true, now: now)
        }
        XCTAssertEqual(last, .unresponsive(pid: 4242))
    }

    func testNothingListeningWhileStartingIsNotAFault() {
        let starting = DaemonHealth.Target(pid: 4242, launchedAt: now.addingTimeInterval(-5))
        var failures = 0
        for _ in 0..<10 {
            let (next, verdict) = DaemonHealth.decide(failures: failures, probe: .unreachable, target: starting, alive: true, now: now)
            failures = next
            XCTAssertEqual(verdict, .suspect(failures: 0))
        }
        // …but listening and silent counts from the first second.
        XCTAssertEqual(DaemonHealth.decide(failures: 2, probe: .silent(peerPID: 4242), target: starting, alive: true, now: now).verdict,
                       .unresponsive(pid: 4242))
        // …and past the grace, nothing listening counts too.
        let late = DaemonHealth.Target(pid: 4242, launchedAt: now.addingTimeInterval(-policy.startupGrace - 1))
        XCTAssertEqual(DaemonHealth.decide(failures: 2, probe: .unreachable, target: late, alive: true, now: now).verdict,
                       .unresponsive(pid: 4242))
    }

    func testADeadProcessIsGoneNotUnresponsive() {
        let result = DaemonHealth.decide(failures: 2, probe: .silent(peerPID: nil), target: ours, alive: false, now: now)
        XCTAssertEqual(result.failures, 0)
        XCTAssertEqual(result.verdict, .gone)
    }

    func testWithNoPidToSignalNothingIsEverStopped() {
        // Nothing listening and nothing naming a daemon: nothing is there, and the host starts its own.
        XCTAssertEqual(DaemonHealth.decide(failures: 5, probe: .unreachable, target: nil, alive: false, now: now).verdict, .gone)
        // Something listening and silent, but no identity to name it: said, never killed.
        var failures = 0
        var last: DaemonHealth.Verdict = .healthy
        for _ in 0..<3 {
            (failures, last) = DaemonHealth.decide(failures: failures, probe: .silent(peerPID: 777), target: nil, alive: false, now: now)
        }
        XCTAssertEqual(last, .unidentified(failures: 3))
    }

    func testTheSocketsListenerMustBeTheProcessThatWouldBeStopped() {
        // The kernel says pid 777 listens on the socket; the identity says 4242. Stopping 4242 would free nothing.
        XCTAssertEqual(DaemonHealth.decide(failures: 2, probe: .silent(peerPID: 777), target: ours, alive: true, now: now).verdict,
                       .unidentified(failures: 3))
        XCTAssertEqual(DaemonHealth.decide(failures: 2, probe: .silent(peerPID: 4242), target: ours, alive: true, now: now).verdict,
                       .unresponsive(pid: 4242))
    }

    func testTheRestartBudget() {
        XCTAssertEqual(DaemonHealth.restartPlan(previousRestarts: [], now: now), .restart)
        let two = [now.addingTimeInterval(-300), now.addingTimeInterval(-60)]
        XCTAssertEqual(DaemonHealth.restartPlan(previousRestarts: two, now: now), .restart)
        let three = two + [now.addingTimeInterval(-10)]
        XCTAssertEqual(DaemonHealth.restartPlan(previousRestarts: three, now: now), .giveUp(restarts: 3))
        // Ten minutes on, the old ones no longer count.
        let old = [now.addingTimeInterval(-700), now.addingTimeInterval(-650), now.addingTimeInterval(-601)]
        XCTAssertEqual(DaemonHealth.restartPlan(previousRestarts: old, now: now), .restart)
    }

    func testAnIdentityOnlyNamesTheProcessThatWroteIt() {
        let written = now
        XCTAssertTrue(DaemonHealth.identityMatchesProcess(writtenAt: written, processStartedAt: written.addingTimeInterval(-2)))
        XCTAssertTrue(DaemonHealth.identityMatchesProcess(writtenAt: written, processStartedAt: written.addingTimeInterval(0.5)))
        // A pid reused by a process that started after the file was written.
        XCTAssertFalse(DaemonHealth.identityMatchesProcess(writtenAt: written, processStartedAt: written.addingTimeInterval(30)))
        XCTAssertFalse(DaemonHealth.identityMatchesProcess(writtenAt: written, processStartedAt: nil))
    }

    func testTheLogLineIsTheDaemonLogsOwnFormat() {
        let line = DaemonHealth.logLine("stopped it", at: Date(timeIntervalSince1970: 1_790_524_645), timeZone: TimeZone(identifier: "Australia/Sydney")!)
        XCTAssertEqual(line, "[conch 9/28 01:57:25] app: stopped it\n")
        XCTAssertEqual(DaemonHealth.logPath(environment: [:]), "/tmp/conch-daemon.log")
        XCTAssertEqual(DaemonHealth.logPath(environment: ["CONCH_LOG_FILE": "/x/daemon.log"]), "/x/daemon.log")
        XCTAssertEqual(DaemonHealth.logPath(environment: ["CONCH_LOG_FILE": "  "]), "/tmp/conch-daemon.log")
    }

    // MARK: - The ping, on real sockets

    func testAPongIsAnsweredWithItsPid() throws {
        let server = try Listener()
        defer { server.close() }
        server.serve(reply: "{\"kind\":\"pong\",\"pid\":4242,\"uptimeMs\":10}\n")
        XCTAssertEqual(DaemonHealth.pingNow(socketPath: server.path, timeout: 2), .answered(pid: 4242))
        XCTAssertEqual(server.requests, ["{\"kind\":\"ping\"}"])
    }

    func testAnOlderDaemonsErrorIsStillAnAnswer() throws {
        let server = try Listener()
        defer { server.close() }
        server.serve(reply: "{\"kind\":\"session-error\",\"error\":\"type must be one of …\"}\n")
        XCTAssertEqual(DaemonHealth.pingNow(socketPath: server.path, timeout: 2), .answered(pid: nil))
    }

    func testAListenerThatNeverAcceptsIsSilentAndNamesItsPid() throws {
        // What a frozen daemon is: the kernel completes the connect from the backlog and nothing ever reads it.
        let server = try Listener()
        defer { server.close() }
        let started = Date()
        XCTAssertEqual(DaemonHealth.pingNow(socketPath: server.path, timeout: 0.5), .silent(peerPID: getpid()))
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started), 0.45)
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
    }

    func testNoSocketAndAStaleSocketAreUnreachable() throws {
        XCTAssertEqual(DaemonHealth.pingNow(socketPath: "/tmp/conch-health-missing-\(UUID().uuidString.prefix(8)).sock", timeout: 1), .unreachable)
        let server = try Listener()
        server.close(keepFile: true) // the file a killed daemon leaves behind
        XCTAssertEqual(DaemonHealth.pingNow(socketPath: server.path, timeout: 1), .unreachable)
        unlink(server.path)
    }

    func testAFullBacklogIsRefusedLikeNoListener() throws {
        let server = try Listener(backlog: 1)
        defer { server.close() }
        // Fill it: each connect that is never accepted holds a slot.
        var held: [Int32] = []
        defer { held.forEach { Darwin.close($0) } }
        for _ in 0..<4 { if let fd = rawConnect(server.path) { held.append(fd) } }
        XCTAssertEqual(DaemonHealth.pingNow(socketPath: server.path, timeout: 0.5), .unreachable)
    }

    func testAClosedConnectionWithNoReplyIsNotAnAnswer() throws {
        let server = try Listener()
        defer { server.close() }
        server.serve(reply: nil)
        XCTAssertEqual(DaemonHealth.pingNow(socketPath: server.path, timeout: 2), .unreachable)
    }

    // MARK: - Stopping, on real processes

    func testSIGTERMIsEnoughForAProcessThatListens() async throws {
        let child = try spawnSleep()
        XCTAssertTrue(DaemonHealth.isAlive(child.processIdentifier))
        let fast = DaemonHealth.Policy(interval: 1, timeout: 1, failuresBeforeRestart: 3, startupGrace: 0, terminateGrace: 3, killWait: 3, restartLimit: 3, restartWindow: 600)
        defer { if child.isRunning { kill(child.processIdentifier, SIGKILL) } }
        let ended = await DaemonHealth.terminate(pid: child.processIdentifier, policy: fast)
        XCTAssertEqual(ended, .exited)
        child.waitUntilExit()
        XCTAssertEqual(child.terminationReason, .uncaughtSignal)
        XCTAssertEqual(child.terminationStatus, SIGTERM)
    }

    func testAProcessThatCannotActOnSIGTERMIsKilledAfterTheGrace() async throws {
        // A frozen daemon has a SIGTERM handler that never gets to run (it is JavaScript, on the stuck thread). Here:
        // SIGTERM ignored outright, and the process stopped as well, as `kill -STOP` leaves a daemon in the e2e check.
        let child = try spawnSleep(ignoringSIGTERM: true)
        let pid = child.processIdentifier
        // Whatever happens below, this child does not outlive the test: a stopped process never exits by itself.
        defer { if child.isRunning { kill(pid, SIGKILL); kill(pid, SIGCONT) } }
        XCTAssertEqual(kill(pid, SIGSTOP), 0)
        let fast = DaemonHealth.Policy(interval: 1, timeout: 1, failuresBeforeRestart: 3, startupGrace: 0, terminateGrace: 0.5, killWait: 3, restartLimit: 3, restartWindow: 600)
        let started = Date()
        let ended = await DaemonHealth.terminate(pid: pid, policy: fast)
        XCTAssertEqual(ended, .killed)
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started), 0.45)
        // Bounded: a regression that never sends SIGKILL fails here instead of hanging the suite.
        let exitBy = Date().addingTimeInterval(3)
        while child.isRunning, Date() < exitBy { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertFalse(child.isRunning)
        if !child.isRunning { XCTAssertEqual(child.terminationStatus, SIGKILL) }
        XCTAssertFalse(DaemonHealth.isAlive(pid))
    }

    func testAZombieIsNotAlive() throws {
        var pid: pid_t = 0
        let argv: [UnsafeMutablePointer<CChar>?] = [strdup("/usr/bin/true"), nil]
        defer { argv.forEach { free($0) } }
        XCTAssertEqual(posix_spawn(&pid, "/usr/bin/true", nil, nil, argv, nil), 0)
        // Not reaped: it lingers as a zombie, which `kill(pid, 0)` still finds.
        let deadline = Date().addingTimeInterval(5)
        while DaemonHealth.isAlive(pid), Date() < deadline { usleep(20_000) }
        XCTAssertEqual(kill(pid, 0), 0)
        XCTAssertFalse(DaemonHealth.isAlive(pid))
        var status: Int32 = 0
        waitpid(pid, &status, 0)
    }

    func testAProcessStartTimeIsTheKernels() throws {
        let before = Date()
        let child = try spawnSleep()
        defer { child.terminate(); child.waitUntilExit() }
        let started = try XCTUnwrap(DaemonHealth.processStartTime(child.processIdentifier))
        XCTAssertLessThan(abs(started.timeIntervalSince(before)), 5)
        XCTAssertNil(DaemonHealth.processStartTime(-1))
    }

    // MARK: - The monitor

    @MainActor
    func testTheMonitorStopsAFrozenDaemonOnceAndWithinItsBudget() async {
        let probes = Script<DaemonHealth.Probe>([.silent(peerPID: 4242), .silent(peerPID: 4242), .silent(peerPID: 4242)])
        let signals = Signals(stopsOn: SIGKILL)
        var lines: [String] = []
        let monitor = DaemonHealthMonitor(policy: fastPolicy(), hooks: .init(
            socketPath: "/unused",
            target: { DaemonHealth.Target(pid: 4242) },
            ping: { _, _ in probes.next() },
            isAlive: { signals.alive($0) },
            signal: { signals.send($0, $1) },
            log: { lines.append($0) }
        ))
        let first = await monitor.check()
        let second = await monitor.check()
        let third = await monitor.check()
        XCTAssertEqual(first, .suspect(failures: 1))
        XCTAssertEqual(second, .suspect(failures: 2))
        XCTAssertEqual(third, .unresponsive(pid: 4242))
        let recovery = await monitor.recover(pid: 4242)
        XCTAssertEqual(recovery, .init(pid: 4242, termination: .killed, plan: .restart))
        XCTAssertEqual(signals.sent, [[4242, SIGTERM], [4242, SIGKILL]])
        XCTAssertEqual(lines.count, 2)
        XCTAssertTrue(lines[0].hasPrefix("the daemon (pid 4242) has not answered a ping for at least"))
        XCTAssertTrue(lines[1].contains("ignored SIGTERM") && lines[1].hasSuffix("starting a new one"))
        XCTAssertEqual(monitor.failures, 0)
    }

    @MainActor
    func testTheFourthFrozenDaemonInTenMinutesIsNotRestarted() async {
        var clock = now
        let signals = Signals(stopsOn: SIGTERM)
        var lines: [String] = []
        let monitor = DaemonHealthMonitor(policy: .standard, hooks: .init(
            socketPath: "/unused",
            target: { DaemonHealth.Target(pid: 4242) },
            ping: { _, _ in .silent(peerPID: nil) },
            isAlive: { signals.alive($0) },
            signal: { signals.send($0, $1) },
            log: { lines.append($0) },
            now: { clock }
        ))
        var plans: [DaemonHealth.RestartPlan] = []
        for _ in 0..<4 {
            signals.revive()
            plans.append(await monitor.recover(pid: 4242).plan)
            clock = clock.addingTimeInterval(60)
        }
        XCTAssertEqual(plans, [.restart, .restart, .restart, .giveUp(restarts: 3)])
        XCTAssertTrue(lines.last!.contains("not starting another"))
        // A start by hand is a fresh budget.
        monitor.forgetRestarts()
        signals.revive()
        let fresh = await monitor.recover(pid: 4242)
        XCTAssertEqual(fresh.plan, .restart)
    }

    @MainActor
    func testANewDaemonStartsAFreshCountAndAnAnswerAboutAnOldOneIsDropped() async {
        let daemon = Daemon(pid: 1)
        let monitor = DaemonHealthMonitor(policy: fastPolicy(), hooks: .init(
            socketPath: "/unused",
            target: { DaemonHealth.Target(pid: daemon.pid) },
            ping: { _, _ in daemon.pinged(); return .silent(peerPID: nil) },
            isAlive: { _ in true },
            signal: { _, _ in XCTFail("nothing should be signalled") },
            log: { _ in }
        ))
        _ = await monitor.check()
        _ = await monitor.check()
        XCTAssertEqual(monitor.failures, 2)
        // Replaced while the third ping was out: that silence was the old daemon's, and counts for nobody.
        daemon.replaceDuringNextPing(with: 2)
        let during = await monitor.check()
        XCTAssertNil(during)
        XCTAssertEqual(monitor.failures, 2)
        // The new one's count starts again.
        let fresh = await monitor.check()
        XCTAssertEqual(fresh, .suspect(failures: 1))
    }

    @MainActor
    func testAnUnidentifiedDaemonIsReportedOnceAndNeverSignalled() async {
        var lines: [String] = []
        let monitor = DaemonHealthMonitor(policy: fastPolicy(), hooks: .init(
            socketPath: "/unused",
            target: { nil },
            ping: { _, _ in .silent(peerPID: 777) },
            isAlive: { _ in true },
            signal: { _, _ in XCTFail("an unidentified daemon must never be signalled") },
            log: { lines.append($0) }
        ))
        var verdicts: [DaemonHealth.Verdict?] = []
        for _ in 0..<5 { verdicts.append(await monitor.check()) }
        XCTAssertEqual(verdicts.last, .unidentified(failures: 5))
        XCTAssertEqual(lines.count, 1)
        XCTAssertTrue(lines[0].contains("connected to pid 777, no answer"))
    }

    // MARK: - Helpers

    private func fastPolicy() -> DaemonHealth.Policy {
        DaemonHealth.Policy(interval: 0.1, timeout: 0.1, failuresBeforeRestart: 3, startupGrace: 0, terminateGrace: 0.3, killWait: 1, restartLimit: 3, restartWindow: 600)
    }

    private func spawnSleep(ignoringSIGTERM: Bool = false) throws -> Process {
        let child = Process()
        if ignoringSIGTERM {
            // An ignored signal stays ignored across exec, so `sleep` itself ignores SIGTERM.
            child.executableURL = URL(fileURLWithPath: "/bin/sh")
            child.arguments = ["-c", "trap '' TERM; exec /bin/sleep 30"]
        } else {
            child.executableURL = URL(fileURLWithPath: "/bin/sleep")
            child.arguments = ["30"]
        }
        try child.run()
        if ignoringSIGTERM { usleep(200_000) } // until the trap is set and sleep is exec'd
        return child
    }
}

/// A unix-socket listener: accepts nothing unless told to serve.
private final class Listener: @unchecked Sendable {
    let path: String
    private let descriptor: Int32
    private let lock = NSLock()
    private var received: [String] = []
    var requests: [String] { lock.lock(); defer { lock.unlock() }; return received }

    init(backlog: Int32 = 8) throws {
        var template = Array("/tmp/conch-health-XXXXXX".utf8CString)
        guard mkdtemp(&template) != nil else { throw POSIXError(.EIO) }
        path = String(cString: template) + "/d.sock"
        descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(path.utf8)) }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, listen(descriptor, backlog) == 0 else { throw POSIXError(.EADDRINUSE) }
    }

    /// Accept one connection on a thread, read its line, and reply (or close with nothing, for nil).
    func serve(reply: String?) {
        let descriptor = descriptor
        Thread.detachNewThread { [self] in
            let client = accept(descriptor, nil, nil)
            guard client >= 0 else { return }
            var line: [UInt8] = []
            var byte: UInt8 = 0
            while read(client, &byte, 1) == 1, byte != 0x0A { line.append(byte) }
            lock.lock(); received.append(String(decoding: line, as: UTF8.self)); lock.unlock()
            if let reply { _ = Array(reply.utf8).withUnsafeBytes { write(client, $0.baseAddress, $0.count) } }
            Darwin.close(client)
        }
        usleep(20_000)
    }

    func close(keepFile: Bool = false) {
        Darwin.close(descriptor)
        if !keepFile {
            unlink(path)
            rmdir((path as NSString).deletingLastPathComponent)
        }
    }
}

private func rawConnect(_ path: String) -> Int32? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(path.utf8)) }
    let result = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    if result == 0 { return fd }
    Darwin.close(fd)
    return nil
}

/// Answers in order, then the last one forever.
private final class Script<Value: Sendable>: @unchecked Sendable {
    private var values: [Value]
    private let lock = NSLock()
    init(_ values: [Value]) { self.values = values }
    func next() -> Value {
        lock.lock(); defer { lock.unlock() }
        return values.count > 1 ? values.removeFirst() : values[0]
    }
}

/// A process that dies on one signal, and remembers every signal it was sent.
private final class Signals: @unchecked Sendable {
    private let lock = NSLock()
    private let stopsOn: Int32
    private var living = true
    private(set) var sent: [[Int32]] = []
    init(stopsOn: Int32) { self.stopsOn = stopsOn }
    func alive(_ pid: Int32) -> Bool { lock.lock(); defer { lock.unlock() }; return living }
    func send(_ pid: Int32, _ signal: Int32) {
        lock.lock(); defer { lock.unlock() }
        sent.append([pid, signal])
        if signal == stopsOn { living = false }
    }
    func revive() { lock.lock(); living = true; lock.unlock() }
}
/// A daemon whose pid can change while a ping is out.
private final class Daemon: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Int32
    private var next: Int32?
    init(pid: Int32) { current = pid }
    var pid: Int32 { lock.lock(); defer { lock.unlock() }; return current }
    func replaceDuringNextPing(with pid: Int32) { lock.lock(); next = pid; lock.unlock() }
    func pinged() {
        lock.lock(); defer { lock.unlock() }
        if let next { current = next; self.next = nil }
    }
}
#endif
