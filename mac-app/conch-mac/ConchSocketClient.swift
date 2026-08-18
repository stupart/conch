import Darwin
import Dispatch
import Foundation

struct ConchDaemonEvent: Encodable, Sendable {
    enum Kind: String, Encodable, Sendable {
        case wake
        case recite
        case spacebar
        case pause
        case resume
        case inject
        case interrupt
    }

    let type: Kind
    let sessionId: String?
    let label: String?
    let announce: String?
    /// Who asked. Everything this app sends is a button someone pressed, so the
    /// daemon may act on it even in manual mode — where a wake it cannot
    /// attribute to a person is held rather than opening the mic.
    let origin: String?

    init(
        type: Kind,
        sessionId: String? = nil,
        label: String? = nil,
        announce: String? = nil,
        origin: String? = nil
    ) {
        self.type = type
        self.sessionId = sessionId
        self.label = label
        self.announce = announce
        self.origin = origin
    }

    /// Type into a session. The daemon puts `announce` into the session's
    /// input, so this is the same path the phone and the voice loop use — one
    /// delivery route with one set of failure modes, not a third.
    static func inject(sessionId: String, label: String, text: String) -> Self {
        Self(type: .inject, sessionId: sessionId, label: label, announce: text)
    }

    /// Stop a session mid-turn. The daemon presses Escape in its pane, which
    /// is what a person would do — neither agent exposes a cancel an outside
    /// process could call.
    static func interrupt(sessionId: String, label: String) -> Self {
        Self(type: .interrupt, sessionId: sessionId, label: label)
    }

    static func wake(sessionId: String, label: String) -> Self {
        Self(
            type: .wake,
            sessionId: sessionId,
            label: label,
            announce: "",
            origin: "user"
        )
    }

    static func recite(sessionId: String, label: String) -> Self {
        Self(type: .recite, sessionId: sessionId, label: label)
    }

    static func stop() -> Self {
        Self(type: .spacebar)
    }

    static func global(_ type: Kind) -> Self {
        Self(type: type)
    }

    static func scoped(_ type: Kind, sessionId: String, label: String) -> Self {
        Self(type: type, sessionId: sessionId, label: label)
    }
}

enum ConchSocketRequestOutcome: Equatable, Sendable {
    case reply(Data)
    case connectFailed
    case timeout
}

struct ConchGetConfigRequest: Encodable, Sendable {
    let kind = "get-config"
}

enum ConchAgentBackend: String, CaseIterable, Identifiable, Encodable, Sendable {
    case claude
    case codex

    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

struct ConchSessionStartRequest: Encodable, Sendable {
    let kind = "session-start"
    let backend: ConchAgentBackend
    let resumeSessionId: String?
    let cwd: String?
}

/// Ask the daemon what past sessions could be restarted.
///
/// `query` is matched by the daemon rather than here: the history is over a
/// thousand files, so filtering belongs next to the reader, not after a full
/// list has crossed the socket.
struct ConchResumableRequest: Encodable, Sendable {
    let kind = "resumable"
    let query: String?
}

struct ConchResumableReply: Decodable, Sendable {
    let sessions: [ResumableSession]
    /// False when the reader stopped early — the list is a page, not the truth.
    let complete: Bool?
}

struct ConchSessionCloseRequest: Encodable, Sendable {
    let kind = "session-close"
    let sessionId: String
}

struct ConchSessionStartedReply: Decodable, Equatable, Sendable {
    let backend: String
    let resumed: Bool
}

struct ConchSessionClosedReply: Decodable, Equatable, Sendable {
    let sessionId: String
}

enum ConchSessionLifecycleReply: Decodable, Equatable, Sendable {
    case started(ConchSessionStartedReply)
    case closed(ConchSessionClosedReply)
    case error(ConchSessionErrorReply)
    case unknown(kind: String?)

    private enum CodingKeys: String, CodingKey { case kind }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try? container.decodeIfPresent(String.self, forKey: .kind)
        switch kind {
        case "session-started":
            self = .started(try ConchSessionStartedReply(from: decoder))
        case "session-closed":
            self = .closed(try ConchSessionClosedReply(from: decoder))
        case "session-error":
            self = .error(try ConchSessionErrorReply(from: decoder))
        default:
            self = .unknown(kind: kind)
        }
    }
}

/// Failures belong beside the daemon state that made them possible, not in a
/// transient Console line. The daemon owns the durable JSONL record; the app
/// supplies the UI state only it can see at the moment of failure.
struct ConchAppErrorReport: Encodable, Sendable {
    let kind = "app-error"
    let source = "mac"
    let operation: String
    let message: String
    let sessionId: String?
    let state: [String: String]
}

enum ConchSessionCommand: String, Encodable, Sendable {
    case rename
    case dismiss
    case restore
}

struct ConchSessionCommandRequest: Encodable, Sendable {
    let kind = "session-command"
    let sessionId: String
    let command: ConchSessionCommand
    let label: String?

    init(
        sessionId: String,
        command: ConchSessionCommand,
        label: String? = nil
    ) {
        self.sessionId = sessionId
        self.command = command
        self.label = label
    }
}

struct ConchSessionAcknowledgement: Decodable, Equatable, Sendable {
    let sessionId: String
    let command: String
    let label: String?
    let changed: Bool
}

struct ConchSessionErrorReply: Decodable, Equatable, Sendable {
    let error: String
}

enum ConchSessionCommandReply: Decodable, Equatable, Sendable {
    case acknowledgement(ConchSessionAcknowledgement)
    case error(ConchSessionErrorReply)
    case unknown(kind: String?)

    private enum CodingKeys: String, CodingKey {
        case kind
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try? container.decodeIfPresent(String.self, forKey: .kind)

        switch kind {
        case "session-ack":
            if let acknowledgement = try? ConchSessionAcknowledgement(from: decoder) {
                self = .acknowledgement(acknowledgement)
            } else {
                self = .unknown(kind: kind)
            }
        case "session-error":
            if let error = try? ConchSessionErrorReply(from: decoder) {
                self = .error(error)
            } else {
                self = .unknown(kind: kind)
            }
        default:
            self = .unknown(kind: kind)
        }
    }
}

struct ConchSocketClient: Sendable {
    private static let sendTimeoutNanoseconds: UInt64 = 500_000_000
    private static let maximumReplyLineBytes = 1_048_576

    private let socketPath: String

    init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        let override = environment["CONCH_SOCKET"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let override, !override.isEmpty {
            socketPath = override
        } else {
            socketPath = "/tmp/conch.sock"
        }
    }

    func send(_ event: ConchDaemonEvent) async -> Bool {
        let socketPath = socketPath
        return await Task.detached(priority: .userInitiated) {
            Self.write(event, to: socketPath)
        }.value
    }

    /// Send a control message and don't wait for an answer.
    ///
    /// `request` expects a reply and holds a deadline open for it; a wake
    /// notification has nothing worth waiting for and must never delay the
    /// thing that woke it.
    func notify(_ message: [String: String]) async {
        guard var payload = try? JSONSerialization.data(withJSONObject: message) else { return }
        payload.append(0x0A)
        let socketPath = socketPath
        _ = await Task.detached(priority: .utility) {
            Self.transact(payload, with: socketPath, deadline: Self.makeDeadline(after: Self.nanoseconds(for: 1)))
        }.value
    }

    func request<Request: Encodable>(
        _ request: Request,
        timeout: TimeInterval = 1
    ) async -> ConchSocketRequestOutcome {
        guard var payload = try? JSONEncoder().encode(request) else {
            return .connectFailed
        }
        payload.append(0x0A)

        let socketPath = socketPath
        let timeoutNanoseconds = Self.nanoseconds(for: timeout)
        let deadline = Self.makeDeadline(after: timeoutNanoseconds)
        return await Task.detached(priority: .userInitiated) {
            Self.transact(
                payload,
                with: socketPath,
                deadline: deadline
            )
        }.value
    }

    /// Reporting cannot itself become another user-visible failure. A daemon
    /// that is unreachable cannot record the incident, but the original action
    /// still returns its honest result to the caller.
    func reportAppError(
        operation: String,
        message: String,
        sessionId: String? = nil,
        state: [String: String] = [:]
    ) async {
        _ = await request(
            ConchAppErrorReport(
                operation: operation,
                message: message,
                sessionId: sessionId,
                state: state
            )
        )
    }

    private static func write(_ event: ConchDaemonEvent, to path: String) -> Bool {
        guard var payload = try? JSONEncoder().encode(event) else { return false }
        payload.append(0x0A)

        let deadline = makeDeadline(after: sendTimeoutNanoseconds)
        guard let descriptor = connectedSocket(to: path, deadline: deadline) else {
            return false
        }
        defer { Darwin.close(descriptor) }

        return write(payload, to: descriptor, deadline: deadline) == .complete
    }

    private static func transact(
        _ payload: Data,
        with path: String,
        deadline: UInt64
    ) -> ConchSocketRequestOutcome {
        guard let descriptor = connectedSocket(to: path, deadline: deadline) else {
            return .connectFailed
        }
        defer { Darwin.close(descriptor) }

        guard write(payload, to: descriptor, deadline: deadline) == .complete else {
            return .timeout
        }

        return readReplyLine(from: descriptor, deadline: deadline)
    }

    private static func connectedSocket(
        to path: String,
        deadline: UInt64
    ) -> Int32? {
        guard var address = socketAddress(for: path) else { return nil }

        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return nil }

        let currentFlags = Darwin.fcntl(descriptor, F_GETFL)
        guard currentFlags >= 0,
              Darwin.fcntl(descriptor, F_SETFL, currentFlags | O_NONBLOCK) == 0 else {
            Darwin.close(descriptor)
            return nil
        }

        var noSignal: Int32 = 1
        _ = withUnsafePointer(to: &noSignal) { pointer in
            Darwin.setsockopt(
                descriptor,
                SOL_SOCKET,
                SO_NOSIGPIPE,
                pointer,
                socklen_t(MemoryLayout<Int32>.size)
            )
        }
        let connectResult = withUnsafePointer(to: &address) { addressPointer in
            addressPointer.withMemoryRebound(
                to: sockaddr.self,
                capacity: 1
            ) { socketAddress in
                Darwin.connect(
                    descriptor,
                    socketAddress,
                    socklen_t(MemoryLayout<sockaddr_un>.size)
                )
            }
        }
        if connectResult != 0 {
            guard errno == EINPROGRESS || errno == EINTR,
                  wait(
                    for: Int16(POLLOUT),
                    on: descriptor,
                    deadline: deadline
                  ) == .ready,
                  socketError(descriptor) == 0 else {
                Darwin.close(descriptor)
                return nil
            }
        }

        return descriptor
    }

    private static func socketAddress(for path: String) -> sockaddr_un? {
        var address = sockaddr_un()
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        address.sun_family = sa_family_t(AF_UNIX)

        let pathBytes = Array(path.utf8CString)
        let pathCapacity = MemoryLayout.size(ofValue: address.sun_path)
        guard pathBytes.count <= pathCapacity else { return nil }

        withUnsafeMutablePointer(to: &address.sun_path) { tuplePointer in
            tuplePointer.withMemoryRebound(
                to: CChar.self,
                capacity: pathCapacity
            ) { destination in
                for index in pathBytes.indices {
                    destination[index] = pathBytes[index]
                }
            }
        }
        return address
    }

    private static func write(
        _ payload: Data,
        to descriptor: Int32,
        deadline: UInt64
    ) -> IOOutcome {
        payload.withUnsafeBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return .failed }
            var written = 0
            while written < bytes.count {
                guard DispatchTime.now().uptimeNanoseconds < deadline else {
                    return .timedOut
                }
                let result = Darwin.write(
                    descriptor,
                    baseAddress.advanced(by: written),
                    bytes.count - written
                )
                if result > 0 {
                    written += result
                    continue
                }
                if result < 0 && errno == EINTR {
                    continue
                }
                if result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                    switch wait(
                        for: Int16(POLLOUT),
                        on: descriptor,
                        deadline: deadline
                    ) {
                    case .ready:
                        continue
                    case .timedOut:
                        return .timedOut
                    case .failed:
                        return .failed
                    }
                }
                return .failed
            }
            return .complete
        }
    }

    private static func readReplyLine(
        from descriptor: Int32,
        deadline: UInt64
    ) -> ConchSocketRequestOutcome {
        var reply = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)

        while true {
            if let newline = reply.firstIndex(of: 0x0A) {
                return .reply(Data(reply[..<newline]))
            }
            guard reply.count < maximumReplyLineBytes,
                  DispatchTime.now().uptimeNanoseconds < deadline else {
                return .timeout
            }

            let maximumRead = min(buffer.count, maximumReplyLineBytes - reply.count)
            let result = buffer.withUnsafeMutableBytes { bytes in
                Darwin.read(descriptor, bytes.baseAddress, maximumRead)
            }
            if result > 0 {
                reply.append(contentsOf: buffer.prefix(Int(result)))
                continue
            }
            if result == 0 {
                return .timeout
            }
            if errno == EINTR {
                continue
            }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                switch wait(
                    for: Int16(POLLIN),
                    on: descriptor,
                    deadline: deadline
                ) {
                case .ready:
                    continue
                case .timedOut, .failed:
                    return .timeout
                }
            }
            return .timeout
        }
    }

    private static func wait(
        for events: Int16,
        on descriptor: Int32,
        deadline: UInt64
    ) -> WaitOutcome {
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else { return .timedOut }

            let remainingNanoseconds = deadline - now
            let wholeMilliseconds = remainingNanoseconds / 1_000_000
            let roundedMilliseconds = max(
                1,
                wholeMilliseconds + (remainingNanoseconds % 1_000_000 == 0 ? 0 : 1)
            )
            let timeout = Int32(
                min(roundedMilliseconds, UInt64(Int32.max))
            )
            var event = pollfd(
                fd: descriptor,
                events: events,
                revents: 0
            )
            let result = Darwin.poll(&event, 1, timeout)
            if result > 0 {
                return .ready
            }
            if result == 0 {
                return .timedOut
            }
            guard errno == EINTR else { return .failed }
        }
    }

    private static func nanoseconds(for timeout: TimeInterval) -> UInt64 {
        guard timeout.isFinite, timeout > 0 else { return 0 }
        let nanoseconds = timeout * 1_000_000_000
        guard nanoseconds < Double(UInt64.max) else { return UInt64.max }
        return UInt64(nanoseconds.rounded(.up))
    }

    private static func makeDeadline(after nanoseconds: UInt64) -> UInt64 {
        let now = DispatchTime.now().uptimeNanoseconds
        let (deadline, overflow) = now.addingReportingOverflow(nanoseconds)
        return overflow ? UInt64.max : deadline
    }

    private static func socketError(_ descriptor: Int32) -> Int32 {
        var value: Int32 = 0
        var length = socklen_t(MemoryLayout.size(ofValue: value))
        let result = withUnsafeMutablePointer(to: &value) { pointer in
            Darwin.getsockopt(
                descriptor,
                SOL_SOCKET,
                SO_ERROR,
                pointer,
                &length
            )
        }
        return result == 0 ? value : errno
    }

    private enum IOOutcome {
        case complete
        case timedOut
        case failed
    }

    private enum WaitOutcome {
        case ready
        case timedOut
        case failed
    }
}
