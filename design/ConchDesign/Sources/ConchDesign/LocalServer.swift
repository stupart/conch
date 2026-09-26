import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// A page an agent served on this Mac's own loopback address, and whether anything still serves it.
///
/// Dev servers stop. A review filed as `http://localhost:3111` outlives the server behind it, and walking into it gave
/// "Couldn't load deliverable · Could not connect to the server", with "Open in Browser" offered as the way out, which
/// can't help. So before one is brought forward, conch knocks: a TCP connect to the port, the way the browser would
/// reach it. Nothing listening is refused at once on loopback, so the knock costs a few milliseconds, and a server that
/// answers is never waited on past `timeout`.
public enum LocalServer {
    /// The port a web page on this machine is served on: its own, else http's 80 or https's 443. Nil for anything that
    /// isn't an http or https page on a loopback host, which is nothing to knock on.
    public static func port(of url: URL) -> Int? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host, !addresses(for: host).isEmpty else { return nil }
        return url.port ?? (scheme == "https" ? 443 : 80)
    }

    /// How a person reads the address: "localhost:3111".
    public static func name(of url: URL) -> String {
        guard let port = port(of: url) else { return url.absoluteString }
        let host = url.host ?? "localhost"
        return "\(host.contains(":") ? "[\(host)]" : host):\(port)"
    }

    /// Whether anything accepts a connection on the page's port, on any address the browser would try for its host.
    /// True for a URL that isn't local: there is nothing here to say it's down.
    public static func isListening(_ url: URL, timeout: TimeInterval = 0.25) async -> Bool {
        guard let port = port(of: url), let host = url.host else { return true }
        let addresses = addresses(for: host)
        return await Task.detached(priority: .userInitiated) {
            addresses.contains { accepts($0, port: port, timeout: timeout) }
        }.value
    }

    /// A loopback address to knock on.
    enum Address: Equatable {
        /// An IPv4 address, in host byte order.
        case v4(UInt32)
        case v6Loopback
    }

    /// The addresses a browser would try for `host`, when it names this machine. `localhost` is both 127.0.0.1 and
    /// ::1, and dev servers bind either: Vite on a recent Node listens on ::1 alone.
    static func addresses(for host: String) -> [Address] {
        let host = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".localhost") { return [.v4(0x7F00_0001), .v6Loopback] }
        if host == "::1" || host == "0:0:0:0:0:0:0:1" { return [.v6Loopback] }
        // 0.0.0.0 is "every address" to a server, and loopback to a browser that is handed it.
        if host == "0.0.0.0" { return [.v4(0x7F00_0001)] }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts.first == "127" else { return [] }
        let bytes = parts.compactMap { UInt8($0) }
        guard bytes.count == 4 else { return [] }
        return [.v4(bytes.reduce(UInt32(0)) { $0 << 8 | UInt32($1) })]
    }

    /// One non-blocking connect, waited on for at most `timeout`.
    static func accepts(_ address: Address, port: Int, timeout: TimeInterval) -> Bool {
        guard (1...65535).contains(port) else { return false }
        let family = address == .v6Loopback ? AF_INET6 : AF_INET
        let socket = Darwin.socket(family, SOCK_STREAM, IPPROTO_TCP)
        guard socket >= 0 else { return false }
        defer { close(socket) }
        var noSigPipe: Int32 = 1
        setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        _ = fcntl(socket, F_SETFL, fcntl(socket, F_GETFL) | O_NONBLOCK)

        let started: Int32
        switch address {
        case let .v4(host):
            var sin = sockaddr_in()
            sin.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            sin.sin_family = sa_family_t(AF_INET)
            sin.sin_port = in_port_t(UInt16(port).bigEndian)
            sin.sin_addr = in_addr(s_addr: host.bigEndian)
            started = withUnsafePointer(to: &sin) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
        case .v6Loopback:
            var sin6 = sockaddr_in6()
            sin6.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
            sin6.sin6_family = sa_family_t(AF_INET6)
            sin6.sin6_port = in_port_t(UInt16(port).bigEndian)
            sin6.sin6_addr = in6addr_loopback
            started = withUnsafePointer(to: &sin6) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(socket, $0, socklen_t(MemoryLayout<sockaddr_in6>.size)) }
            }
        }
        if started == 0 { return true }
        guard errno == EINPROGRESS else { return false }
        var poller = pollfd(fd: socket, events: Int16(POLLOUT), revents: 0)
        guard poll(&poller, 1, Int32(max(1, timeout * 1000))) == 1 else { return false }
        var failure: Int32 = 0
        var length = socklen_t(MemoryLayout<Int32>.size)
        guard getsockopt(socket, SOL_SOCKET, SO_ERROR, &failure, &length) == 0 else { return false }
        return failure == 0
    }
}
