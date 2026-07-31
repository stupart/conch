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
        case mute
        case unmute
    }

    let type: Kind
    let sessionId: String?
    let label: String?
    let announce: String?

    init(
        type: Kind,
        sessionId: String? = nil,
        label: String? = nil,
        announce: String? = nil
    ) {
        self.type = type
        self.sessionId = sessionId
        self.label = label
        self.announce = announce
    }

    static func wake(sessionId: String, label: String) -> Self {
        Self(
            type: .wake,
            sessionId: sessionId,
            label: label,
            announce: ""
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

struct ConchSocketClient: Sendable {
    private static let sendTimeoutNanoseconds: UInt64 = 500_000_000

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

    private static func write(_ event: ConchDaemonEvent, to path: String) -> Bool {
        guard var payload = try? JSONEncoder().encode(event) else { return false }
        payload.append(0x0A)

        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        defer { Darwin.close(descriptor) }

        let currentFlags = Darwin.fcntl(descriptor, F_GETFL)
        guard currentFlags >= 0,
              Darwin.fcntl(descriptor, F_SETFL, currentFlags | O_NONBLOCK) == 0 else {
            return false
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

        var address = sockaddr_un()
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        address.sun_family = sa_family_t(AF_UNIX)

        let pathBytes = Array(path.utf8CString)
        let pathCapacity = MemoryLayout.size(ofValue: address.sun_path)
        guard pathBytes.count <= pathCapacity else { return false }

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

        let deadline = DispatchTime.now().uptimeNanoseconds
            &+ sendTimeoutNanoseconds
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
                  waitUntilWritable(descriptor, deadline: deadline),
                  socketError(descriptor) == 0 else {
                return false
            }
        }

        return payload.withUnsafeBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return false }
            var written = 0
            while written < bytes.count {
                guard DispatchTime.now().uptimeNanoseconds < deadline else {
                    return false
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
                    guard waitUntilWritable(descriptor, deadline: deadline) else {
                        return false
                    }
                    continue
                }
                return false
            }
            return true
        }
    }

    private static func waitUntilWritable(
        _ descriptor: Int32,
        deadline: UInt64
    ) -> Bool {
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else { return false }

            let remainingNanoseconds = deadline - now
            let roundedMilliseconds = max(
                1,
                (remainingNanoseconds + 999_999) / 1_000_000
            )
            let timeout = Int32(
                min(roundedMilliseconds, UInt64(Int32.max))
            )
            var event = pollfd(
                fd: descriptor,
                events: Int16(POLLOUT),
                revents: 0
            )
            let result = Darwin.poll(&event, 1, timeout)
            if result > 0 {
                return true
            }
            if result == 0 {
                return false
            }
            guard errno == EINTR else { return false }
        }
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
}
