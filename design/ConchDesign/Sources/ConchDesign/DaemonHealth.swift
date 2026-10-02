#if os(macOS)
import Darwin
import Foundation

/// Is conch's daemon alive, or only its socket?
///
/// The Mac app used to call a daemon alive when a `connect()` to its socket succeeded. The kernel completes that
/// connect from the listen backlog whether or not the daemon's event loop is turning, so on 2026-09-28 a daemon stuck
/// in a synchronous loop (152% CPU, SIGTERM ignored, every request unanswered) passed the check for eight minutes,
/// until its backlog filled and connects were refused. A daemon the app launched itself was only ever restarted when
/// its process exited, which a frozen one never does.
///
/// Now the app asks: `{"kind":"ping"}`, which the daemon answers straight from its event loop (`pong` in
/// control-server.ts). No answer in `timeout`, `failuresBeforeRestart` times running, while the daemon's process is
/// still alive, and the app stops that process — SIGTERM by its exact pid, SIGKILL after a grace — and starts a new
/// one, within a restart budget so a daemon that freezes on every start is not restarted forever.
///
/// The numbers (`Policy.standard`) and why:
/// - a ping every 5 s with a 3 s timeout: the loop answers a ping in well under a millisecond, so 3 s is a thousand
///   times what a healthy daemon needs, and more than a GC pause or a one-off burst of work that holds the loop for a
///   second or two;
/// - 3 failures in a row before acting: three pings spread over at least 13 s (the first sent to the third timing out)
///   have gone unanswered, over three times the 4 s a hook already waits on the socket, so hooks in that time have
///   been failing too. A loop held for a couple of seconds fails at most one ping, and one answer resets the count;
/// - SIGTERM, then SIGKILL after 5 s: a daemon that is only slow shuts down properly (socket unlinked, TTS worker
///   stopped); a frozen one cannot run its SIGTERM handler at all, so it is killed;
/// - 20 s of grace after a launch before "nothing is listening" counts: a daemon binds its socket within a second of
///   starting, but a login-time launch on a busy Mac can be slower. A daemon that is listening and silent counts from
///   the start;
/// - at most 3 frozen-daemon restarts in 10 minutes, then the app stops and says so.
///
/// Frozen is a process that is running and does not answer. A process in the stopped state (SSTOP: `kill -STOP`, Ctrl-Z
/// in the terminal that started it) or held by a debugger (traced) was paused on purpose, and is never signalled,
/// whoever started it: it is said to be paused, and it answers again once it is continued. A running daemon that does
/// not answer is replaced whoever started it, the app, a terminal or launchd: Tyler's is usually adopted, since every
/// app rebuild relaunches the app while the daemon lives on.
public enum DaemonHealth {
    public struct Policy: Equatable, Sendable {
        /// Between pings.
        public var interval: TimeInterval
        /// How long one ping waits for its answer.
        public var timeout: TimeInterval
        /// Unanswered pings in a row, with the process still alive, before it is stopped.
        public var failuresBeforeRestart: Int
        /// After a launch, how long "nothing is listening" is starting up rather than a fault.
        public var startupGrace: TimeInterval
        /// After SIGTERM, before SIGKILL.
        public var terminateGrace: TimeInterval
        /// After SIGKILL, before giving up on the process ending.
        public var killWait: TimeInterval
        /// Frozen-daemon restarts allowed in `restartWindow`; the next one gives up instead.
        public var restartLimit: Int
        public var restartWindow: TimeInterval

        public init(
            interval: TimeInterval,
            timeout: TimeInterval,
            failuresBeforeRestart: Int,
            startupGrace: TimeInterval,
            terminateGrace: TimeInterval,
            killWait: TimeInterval,
            restartLimit: Int,
            restartWindow: TimeInterval
        ) {
            self.interval = interval
            self.timeout = timeout
            self.failuresBeforeRestart = failuresBeforeRestart
            self.startupGrace = startupGrace
            self.terminateGrace = terminateGrace
            self.killWait = killWait
            self.restartLimit = restartLimit
            self.restartWindow = restartWindow
        }

        public static let standard = Policy(
            interval: 5,
            timeout: 3,
            failuresBeforeRestart: 3,
            startupGrace: 20,
            terminateGrace: 5,
            killWait: 3,
            restartLimit: 3,
            restartWindow: 600
        )

        /// The least time a daemon has gone unanswered when it is stopped: from the first failed ping to the end of
        /// the last.
        public var minimumSilence: TimeInterval {
            Double(max(0, failuresBeforeRestart - 1)) * interval + timeout
        }
    }

    /// One ping.
    public enum Probe: Equatable, Sendable {
        /// A reply line: the loop is turning. `pid` is the pong's, nil for a daemon too old to know `ping` (it answers
        /// with an error, which proves the same thing).
        case answered(pid: Int32?)
        /// Connected, and no reply in time. `peerPID` is who listens on the socket, as the kernel records it.
        case silent(peerPID: Int32?)
        /// Nothing took the connection: no listener, a full backlog (which a frozen daemon's is, eventually), or a
        /// close with no reply.
        case unreachable
    }

    /// The process the app may signal: its own child, or the one an identity file names and checks out.
    public struct Target: Equatable, Sendable {
        public let pid: Int32
        /// When the app launched it; nil for a daemon it adopted.
        public let launchedAt: Date?

        public init(pid: Int32, launchedAt: Date? = nil) {
            self.pid = pid
            self.launchedAt = launchedAt
        }
    }

    public enum Verdict: Equatable, Sendable {
        case healthy
        /// Not answering, not yet for long enough.
        case suspect(failures: Int)
        /// Not answering for long enough, and alive: stop this pid and start another.
        case unresponsive(pid: Int32)
        /// Not answering for long enough, but there is no pid the app may signal: no identity, or the socket's
        /// listener is not the process the app would kill.
        case unidentified(failures: Int)
        /// Not answering because the process is stopped (SSTOP) or held by a debugger: paused on purpose, and never
        /// signalled. It answers again once continued.
        case paused(pid: Int32)
        /// No process there to stop: it exited, or nothing is listening and nothing names a daemon.
        case gone
    }

    /// Fold one ping into the running count of failures. `pausedPID` is the daemon's process (the target, or with none
    /// the socket's listener) when it is stopped or held by a debugger (`isPaused`).
    public static func decide(
        failures: Int,
        probe: Probe,
        target: Target?,
        alive: Bool,
        pausedPID: Int32? = nil,
        now: Date,
        policy: Policy = .standard
    ) -> (failures: Int, verdict: Verdict) {
        if case .answered = probe { return (0, .healthy) }
        guard let target else {
            // Nothing listening and nothing naming a daemon: nothing is there, and the caller starts its own.
            if case .unreachable = probe { return (0, .gone) }
            if let pausedPID { return (0, .paused(pid: pausedPID)) }
            let next = failures + 1
            return (next, next >= policy.failuresBeforeRestart ? .unidentified(failures: next) : .suspect(failures: next))
        }
        guard alive else { return (0, .gone) }
        // Paused on purpose: its silence is not a fault, and it counts for nothing once it is continued.
        if pausedPID == target.pid { return (0, .paused(pid: target.pid)) }
        if case .unreachable = probe, let launchedAt = target.launchedAt,
           now.timeIntervalSince(launchedAt) < policy.startupGrace {
            // Still starting: not listening yet is what a daemon does for its first moments.
            return (failures, .suspect(failures: failures))
        }
        let next = failures + 1
        guard next >= policy.failuresBeforeRestart else { return (next, .suspect(failures: next)) }
        if case let .silent(peer?) = probe, peer != target.pid {
            // Someone else holds the socket: stopping `target` would not free it, and would stop the wrong process.
            return (next, .unidentified(failures: next))
        }
        return (next, .unresponsive(pid: target.pid))
    }

    public enum RestartPlan: Equatable, Sendable {
        case restart
        /// Too many frozen-daemon restarts in the window: stop, and say so.
        case giveUp(restarts: Int)
    }

    /// The app's budget for restarting a daemon of its own that exited (`DaemonHost.handleExit`): a backoff of 2,
    /// 4, 8, 16 and then 30 s, and after `limit` restarts in a row, stop and say so, so a daemon that cannot start is
    /// not a restart loop that makes the machine worse. "In a row" means what it says: a daemon that has answered every
    /// ping for `steadyAfter` has run, and the next exit starts the count, and the backoff, again. Its output can't be
    /// what says it ran: launched by the app it is headless and prints nothing, and one that prints and exits is the
    /// loop this stops. A frozen daemon replaced is the freeze budget's (`restartPlan`), never this one's.
    public struct CrashBudget: Equatable, Sendable {
        public enum Plan: Equatable, Sendable {
            case restart(after: TimeInterval)
            case giveUp
        }

        public static let limit = 5
        public static let longestWait: TimeInterval = 30
        public static let steadyAfter: TimeInterval = 120

        /// Restarts since the last daemon that ran steadily.
        public private(set) var restarts = 0
        /// When the run of answers the daemon is on began; nil after anything but an answer.
        public private(set) var answeringSince: Date?

        public init() {}

        /// The daemon exited: start another after the backoff, or give up.
        public mutating func exited() -> Plan {
            answeringSince = nil
            restarts += 1
            guard restarts <= Self.limit else { return .giveUp }
            return .restart(after: min(Self.longestWait, Double(1 << min(restarts, 16))))
        }

        /// One health check's verdict: answers in a row for `steadyAfter` forgive the restarts before them.
        public mutating func observed(_ verdict: Verdict, at now: Date) {
            guard case .healthy = verdict else {
                answeringSince = nil
                return
            }
            let since = answeringSince ?? now
            answeringSince = since
            if now.timeIntervalSince(since) >= Self.steadyAfter { restarts = 0 }
        }
    }

    /// May a frozen daemon be replaced again, given when the last ones were?
    public static func restartPlan(previousRestarts: [Date], now: Date, policy: Policy = .standard) -> RestartPlan {
        let recent = previousRestarts.filter { now.timeIntervalSince($0) < policy.restartWindow }
        return recent.count >= policy.restartLimit ? .giveUp(restarts: recent.count) : .restart
    }

    /// Is the process at an identity file's pid the daemon that wrote it? The daemon writes the file after it starts
    /// listening, so its process began before `writtenAt`. A pid reused by a later process began after the daemon
    /// that had it was gone, which is after the file was written. A second's slack covers clock rounding.
    public static func identityMatchesProcess(writtenAt: Date, processStartedAt: Date?) -> Bool {
        guard let processStartedAt else { return false }
        return processStartedAt <= writtenAt.addingTimeInterval(1)
    }

    // MARK: - Processes

    /// Alive and not a zombie. A child killed but not yet reaped still answers `kill(pid, 0)`.
    public static func isAlive(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        guard kill(pid, 0) == 0 || errno == EPERM else { return false }
        guard let info = processInfo(pid) else { return false }
        return Int32(info.kp_proc.p_stat) != SZOMB
    }

    /// Stopped (SSTOP: `kill -STOP`, Ctrl-Z) or held by a debugger (traced): paused on purpose, never frozen.
    public static func isPaused(_ pid: Int32) -> Bool {
        guard pid > 0, let info = processInfo(pid) else { return false }
        return isPaused(stat: Int32(info.kp_proc.p_stat), flags: info.kp_proc.p_flag)
    }

    /// The same, from the kernel's `p_stat` and `p_flag`.
    public static func isPaused(stat: Int32, flags: Int32) -> Bool {
        stat == SSTOP || flags & P_TRACED != 0
    }

    /// When the process at `pid` started, from the kernel.
    public static func processStartTime(_ pid: Int32) -> Date? {
        guard let info = processInfo(pid) else { return nil }
        let started = info.kp_proc.p_un.__p_starttime
        return Date(timeIntervalSince1970: Double(started.tv_sec) + Double(started.tv_usec) / 1_000_000)
    }

    private static func processInfo(_ pid: Int32) -> kinfo_proc? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&name, UInt32(name.count), &info, &size, nil, 0) == 0, size > 0, info.kp_proc.p_pid == pid else {
            return nil
        }
        return info
    }

    public enum Termination: Equatable, Sendable {
        /// It ended on SIGTERM.
        case exited
        /// It ignored SIGTERM for the grace, and SIGKILL ended it.
        case killed
        /// Still there after SIGKILL: nothing more to do.
        case survived
    }

    /// SIGTERM by this exact pid; SIGKILL after `terminateGrace` if it is still alive. Never a name or a pattern.
    public static func terminate(
        pid: Int32,
        policy: Policy = .standard,
        isAlive: @escaping @Sendable (Int32) -> Bool = { DaemonHealth.isAlive($0) },
        signal: @escaping @Sendable (Int32, Int32) -> Void = { _ = kill($0, $1) }
    ) async -> Termination {
        guard pid > 0 else { return .survived }
        signal(pid, SIGTERM)
        if await gone(pid, within: policy.terminateGrace, isAlive: isAlive) { return .exited }
        signal(pid, SIGKILL)
        if await gone(pid, within: policy.killWait, isAlive: isAlive) { return .killed }
        return .survived
    }

    private static func gone(_ pid: Int32, within: TimeInterval, isAlive: @Sendable (Int32) -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(within)
        while isAlive(pid) {
            guard Date() < deadline else { return false }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return true
    }

    // MARK: - The ping

    /// `{"kind":"ping"}` on the daemon's socket, off the caller's thread.
    public static func ping(socketPath: String, timeout: TimeInterval) async -> Probe {
        await Task.detached(priority: .utility) { pingNow(socketPath: socketPath, timeout: timeout) }.value
    }

    /// The same, blocking: never call it on the main thread.
    public static func pingNow(socketPath: String, timeout: TimeInterval) -> Probe {
        let deadline = DispatchTime.now().uptimeNanoseconds &+ UInt64(max(0, timeout) * 1_000_000_000)
        guard var address = unixAddress(socketPath) else { return .unreachable }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return .unreachable }
        defer { close(descriptor) }
        _ = fcntl(descriptor, F_SETFD, FD_CLOEXEC)
        let flags = fcntl(descriptor, F_GETFL)
        guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else { return .unreachable }
        var one: Int32 = 1
        _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))

        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if connected != 0 {
            guard errno == EINPROGRESS || errno == EINTR,
                  wait(descriptor, for: Int16(POLLOUT), until: deadline),
                  socketError(descriptor) == 0 else { return .unreachable }
        }
        let peer = peerPID(descriptor)

        // `from` says it is the Mac app asking: the daemon counts the app running while these arrive, and tells an
        // agent publishing a result whether the Mac can show it (surfaces.ts, 2026-10-03). A daemon from before ignores it.
        let request = Array("{\"kind\":\"ping\",\"from\":\"mac-app\"}\n".utf8)
        var written = 0
        while written < request.count {
            let result = request.withUnsafeBytes { bytes in
                write(descriptor, bytes.baseAddress!.advanced(by: written), request.count - written)
            }
            if result > 0 { written += result; continue }
            if result < 0, errno == EINTR { continue }
            if result < 0, errno == EAGAIN || errno == EWOULDBLOCK {
                guard wait(descriptor, for: Int16(POLLOUT), until: deadline) else { return .silent(peerPID: peer) }
                continue
            }
            return .unreachable
        }

        var reply: [UInt8] = []
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while true {
            if let newline = reply.firstIndex(of: 0x0A) { return .answered(pid: pongPID(Array(reply[..<newline]))) }
            // A daemon that talks this much is talking: its loop turns.
            if reply.count > 65_536 { return .answered(pid: nil) }
            let count = buffer.withUnsafeMutableBytes { read(descriptor, $0.baseAddress, $0.count) }
            if count > 0 {
                reply.append(contentsOf: buffer[0..<count])
                continue
            }
            if count == 0 { return reply.isEmpty ? .unreachable : .answered(pid: pongPID(reply)) }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                guard wait(descriptor, for: Int16(POLLIN), until: deadline) else { return .silent(peerPID: peer) }
                continue
            }
            return .unreachable
        }
    }

    /// The pid in a `pong` line; nil for any other reply.
    static func pongPID(_ line: [UInt8]) -> Int32? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
              object["kind"] as? String == "pong",
              let pid = object["pid"] as? NSNumber else { return nil }
        return pid.int32Value
    }

    /// Who is listening on the other end, as the kernel recorded it when this connection was made — set even while
    /// the connection waits in the backlog of a daemon that never accepts it.
    static func peerPID(_ descriptor: Int32) -> Int32? {
        var pid: pid_t = 0
        var length = socklen_t(MemoryLayout<pid_t>.size)
        guard getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0, pid > 0 else { return nil }
        return pid
    }

    private static func unixAddress(_ path: String) -> sockaddr_un? {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard !bytes.isEmpty, bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        return address
    }

    private static func wait(_ descriptor: Int32, for events: Int16, until deadline: UInt64) -> Bool {
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else { return false }
            let milliseconds = Int32(min(UInt64(Int32.max), max(1, (deadline - now) / 1_000_000)))
            var poller = pollfd(fd: descriptor, events: events, revents: 0)
            let result = poll(&poller, 1, milliseconds)
            if result > 0 { return true }
            if result == 0 { return false }
            guard errno == EINTR else { return false }
        }
    }

    private static func socketError(_ descriptor: Int32) -> Int32 {
        var value: Int32 = 0
        var length = socklen_t(MemoryLayout<Int32>.size)
        return getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &value, &length) == 0 ? value : errno
    }

    // MARK: - The daemon's log

    /// A line in the daemon log's own format, `[conch 9/28 01:57:25] app: …`, so what the app did sits in order with
    /// what the daemon said.
    public static func logLine(_ message: String, at date: Date = Date(), timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.month, .day, .hour, .minute, .second], from: date)
        let time = String(format: "%02d:%02d:%02d", parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0)
        return "[conch \(parts.month ?? 0)/\(parts.day ?? 0) \(time)] app: \(message)\n"
    }

    /// Append to the daemon log (`CONCH_LOG_FILE`, else /tmp/conch-daemon.log). Best effort: a log that cannot be
    /// written never stops a recovery.
    public static func appendToLog(_ message: String, path: String, at date: Date = Date()) {
        let descriptor = open(path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { return }
        defer { close(descriptor) }
        let bytes = Array(logLine(message, at: date).utf8)
        _ = bytes.withUnsafeBytes { write(descriptor, $0.baseAddress, $0.count) }
    }

    public static func logPath(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        let override = environment["CONCH_LOG_FILE"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        return override?.isEmpty == false ? override! : "/tmp/conch-daemon.log"
    }
}

/// The app's side of `DaemonHealth`: a ping on each tick, the count, and the stop-and-restart when the count says so.
/// The host (`DaemonHost` in the Mac app) owns the process, the timer and what the window says; this owns the decision
/// and the signals, so the logic the app runs is the logic the tests run.
@MainActor
public final class DaemonHealthMonitor {
    public struct Hooks {
        public var socketPath: String
        /// The process the app may signal right now, if any.
        public var target: @MainActor () -> DaemonHealth.Target?
        public var ping: @Sendable (String, TimeInterval) async -> DaemonHealth.Probe
        public var isAlive: @Sendable (Int32) -> Bool
        /// Stopped or held by a debugger (`DaemonHealth.isPaused`): never signalled.
        public var isPaused: @Sendable (Int32) -> Bool
        public var signal: @Sendable (Int32, Int32) -> Void
        /// A line for the daemon log.
        public var log: (String) -> Void
        public var now: () -> Date

        public init(
            socketPath: String,
            target: @escaping @MainActor () -> DaemonHealth.Target?,
            ping: @escaping @Sendable (String, TimeInterval) async -> DaemonHealth.Probe = { await DaemonHealth.ping(socketPath: $0, timeout: $1) },
            isAlive: @escaping @Sendable (Int32) -> Bool = { DaemonHealth.isAlive($0) },
            isPaused: @escaping @Sendable (Int32) -> Bool = { DaemonHealth.isPaused($0) },
            signal: @escaping @Sendable (Int32, Int32) -> Void = { _ = kill($0, $1) },
            log: @escaping (String) -> Void,
            now: @escaping () -> Date = Date.init
        ) {
            self.socketPath = socketPath
            self.target = target
            self.ping = ping
            self.isAlive = isAlive
            self.isPaused = isPaused
            self.signal = signal
            self.log = log
            self.now = now
        }
    }

    public struct Recovery: Equatable, Sendable {
        public let pid: Int32
        public let termination: DaemonHealth.Termination
        public let plan: DaemonHealth.RestartPlan
    }

    public let policy: DaemonHealth.Policy
    public private(set) var failures = 0
    public private(set) var restarts: [Date] = []
    private let hooks: Hooks
    private var checking = false
    private var lastTarget: DaemonHealth.Target?
    private var toldUnidentified = false
    private var toldPaused = false

    public init(policy: DaemonHealth.Policy = .standard, hooks: Hooks) {
        self.policy = policy
        self.hooks = hooks
    }

    /// One ping, folded in. Nil when a check is already running, or the daemon changed while this one waited.
    public func check() async -> DaemonHealth.Verdict? {
        guard !checking else { return nil }
        checking = true
        defer { checking = false }
        let target = hooks.target()
        if target != lastTarget {
            failures = 0
            toldUnidentified = false
            toldPaused = false
            lastTarget = target
        }
        let probe = await hooks.ping(hooks.socketPath, policy.timeout)
        // Stopped, restarted or adopted while the ping was out: this answer is about a daemon that is not there now.
        guard hooks.target() == target else { return nil }
        let alive = target.map { hooks.isAlive($0.pid) } ?? false
        // The process that would be named: the target, or with none, whoever listens on the socket.
        var named = target?.pid
        if named == nil, case let .silent(peer?) = probe { named = peer }
        let pausedPID = named.flatMap { hooks.isPaused($0) ? $0 : nil }
        let (next, verdict) = DaemonHealth.decide(
            failures: failures, probe: probe, target: target, alive: alive, pausedPID: pausedPID, now: hooks.now(), policy: policy
        )
        failures = next
        if case .paused = verdict {} else { toldPaused = false }
        switch verdict {
        case .paused(let pid):
            if !toldPaused {
                toldPaused = true
                hooks.log("the daemon (pid \(pid)) is stopped (Ctrl-Z, kill -STOP or a debugger) — paused on purpose, so leaving it alone")
            }
        case .healthy, .gone:
            toldUnidentified = false
        case .unidentified(let count):
            if !toldUnidentified {
                toldUnidentified = true
                hooks.log("the daemon has not answered \(count) pings in a row (\(Self.describe(probe))), and no process can be named to stop — leaving it")
            }
        case .suspect, .unresponsive:
            break
        }
        return verdict
    }

    /// Stop a daemon `check()` found unresponsive, and say whether another may start. The host detaches the process
    /// first, so its own exit path does not also restart it.
    public func recover(pid: Int32) async -> Recovery {
        let now = hooks.now()
        let plan = DaemonHealth.restartPlan(previousRestarts: restarts, now: now, policy: policy)
        restarts = restarts.filter { now.timeIntervalSince($0) < policy.restartWindow } + [now]
        failures = 0
        hooks.log(
            "the daemon (pid \(pid)) has not answered a ping for at least \(Int(policy.minimumSilence))s "
                + "(\(policy.failuresBeforeRestart) in a row, \(Int(policy.timeout))s each) — stopping it: SIGTERM, "
                + "then SIGKILL after \(Int(policy.terminateGrace))s"
        )
        let termination = await DaemonHealth.terminate(
            pid: pid, policy: policy, isAlive: hooks.isAlive, signal: hooks.signal
        )
        let ended: String
        switch termination {
        case .exited: ended = "it exited on SIGTERM"
        case .killed: ended = "it ignored SIGTERM for \(Int(policy.terminateGrace))s; SIGKILL ended it"
        case .survived: ended = "it is still there after SIGKILL"
        }
        switch plan {
        case .restart:
            hooks.log("\(ended) — starting a new one")
        case .giveUp(let count):
            hooks.log("\(ended) — not starting another: \(count) frozen daemons replaced in \(Int(policy.restartWindow / 60)) min")
        }
        return Recovery(pid: pid, termination: termination, plan: plan)
    }

    /// A start by hand is a fresh budget.
    public func forgetRestarts() {
        restarts = []
    }

    private static func describe(_ probe: DaemonHealth.Probe) -> String {
        switch probe {
        case .answered: return "answered"
        case .silent(let peer?): return "connected to pid \(peer), no answer"
        case .silent(nil): return "connected, no answer"
        case .unreachable: return "nothing took the connection"
        }
    }
}
#endif
