// Derived from mobile/conch-ios/conch-ios/DirectHTTPTransport.swift and the
// BridgeRequest/BridgeResponse shapes in RelayTransport.swift. Kept in the Mac
// target because those shapes live in the iOS relay engine; extracting a shared
// target would change the phone for a LAN-only slice. This copy adds observer
// subscriptions and polling for bridges without observer websocket support.
import Foundation

struct BridgeRequest: Sendable {
    let method: String
    let path: String
    var body = Data()
}

struct BridgeResponse: Sendable {
    let status: Int
    let headers: [String: String]
    let body: Data

    func requireSuccess() throws {
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode(BridgeFailure.self, from: body))?.error
                ?? String(data: body, encoding: .utf8) ?? "Request failed"
            throw RemoteMacError.message("HTTP \(status): \(message)")
        }
    }
}

private struct BridgeFailure: Decodable { let error: String }

enum RemoteMacError: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case .message(let text): return text } }
}

struct LANEndpoint: Codable, Equatable, Sendable {
    let host: String
    let port: Int

    init(host: String, port: String) throws {
        let clean = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, !clean.contains(where: { "/@?#".contains($0) || $0.isWhitespace }),
              let number = Int(port), (1...65535).contains(number) else {
            throw RemoteMacError.message("Enter a LAN host and a port from 1 to 65535.")
        }
        self.host = clean
        self.port = number
        guard baseURL != nil else { throw RemoteMacError.message("That host is not valid.") }
    }

    var baseURL: URL? {
        var parts = URLComponents()
        parts.scheme = "http"
        parts.host = host
        parts.port = port
        return parts.url
    }
    var title: String { "\(host):\(port)" }
}

// Never follow a redirect with a pairing code or bearer token to another host.
private final class LANRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class DirectHTTPTransport {
    var onStateData: ((Data) -> Void)?
    var onConnectionChange: ((Bool, String?) -> Void)?
    private let endpoint: LANEndpoint
    private let token: String
    private let session: URLSession
    private var pollTask: Task<Void, Never>?
    private var streamTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var supportsObserver = false
    private var streaming = false

    init(endpoint: LANEndpoint, token: String) {
        self.endpoint = endpoint
        self.token = token
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: LANRedirectPolicy(), delegateQueue: nil)
    }

    func request(_ request: BridgeRequest) async throws -> BridgeResponse {
        let (data, response) = try await session.data(for: urlRequest(request))
        guard let http = response as? HTTPURLResponse else {
            throw RemoteMacError.message("The Mac sent an invalid response.")
        }
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            headers[String(describing: key).lowercased()] = String(describing: value)
        }
        return BridgeResponse(status: http.statusCode, headers: headers, body: data)
    }

    func download(path: String) async throws -> URL {
        var components = URLComponents()
        components.path = "/file"
        components.queryItems = [URLQueryItem(name: "path", value: path)]
        let request = BridgeRequest(method: "GET", path: components.string!)
        let (temporary, response) = try await session.download(for: urlRequest(request))
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw RemoteMacError.message("The remote file is unavailable or no longer published.")
        }
        // Only the downloaded file gets a local path. The owner's path is an
        // opaque /file query, never an input to the local transcript reader.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("conch-lan-downloads")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let ext = (path as NSString).pathExtension
        let destination = directory.appendingPathComponent(UUID().uuidString)
            .appendingPathExtension(ext.isEmpty ? "bin" : ext)
        try FileManager.default.moveItem(at: temporary, to: destination)
        return destination
    }

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if !streaming {
                    do {
                        let response = try await request(BridgeRequest(method: "GET", path: "/state"))
                        try response.requireSuccess()
                        try Task.checkCancellation()
                        supportsObserver = response.headers["x-conch-observer"] == "1"
                        // An HTTP request begun before the websocket connected
                        // can finish after a newer pushed snapshot.
                        if !streaming { onStateData?(response.body) }
                    } catch {
                        if !Task.isCancelled { onConnectionChange?(false, error.localizedDescription) }
                    }
                }
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
        streamTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if supportsObserver {
                    do { try await receiveStream() }
                    catch { if !Task.isCancelled { onConnectionChange?(false, "Reconnecting; polling state…") } }
                    streaming = false
                    pingTask?.cancel()
                    socket?.cancel(with: .goingAway, reason: nil)
                    socket = nil
                }
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
            }
        }
    }

    func stop() {
        pollTask?.cancel(); pollTask = nil
        streamTask?.cancel(); streamTask = nil
        pingTask?.cancel(); pingTask = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        streaming = false
        session.invalidateAndCancel()
    }

    private func receiveStream() async throws {
        guard let base = endpoint.baseURL,
              var url = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return }
        url.scheme = "ws"
        url.path = "/ws"
        url.queryItems = [URLQueryItem(name: "token", value: token), URLQueryItem(name: "role", value: "observer")]
        guard let address = url.url else { return }
        let stream = session.webSocketTask(with: address)
        socket = stream
        stream.resume()
        pingTask = Task {
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(10))
                    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                        stream.sendPing { error in
                            if let error { continuation.resume(throwing: error) }
                            else { continuation.resume() }
                        }
                    }
                } catch {
                    stream.cancel(with: .goingAway, reason: nil)
                    return
                }
            }
        }
        while !Task.isCancelled {
            let message = try await stream.receive()
            try Task.checkCancellation()
            streaming = true
            switch message {
            case .data(let data): onStateData?(data)
            case .string(let text): onStateData?(Data(text.utf8))
            @unknown default: break
            }
        }
    }

    private func urlRequest(_ request: BridgeRequest) throws -> URLRequest {
        guard request.path.hasPrefix("/"), !request.path.hasPrefix("//"),
              let base = endpoint.baseURL, let url = URL(string: request.path, relativeTo: base) else {
            throw RemoteMacError.message("Invalid LAN request.")
        }
        var result = URLRequest(url: url)
        result.httpMethod = request.method
        result.httpBody = request.body.isEmpty ? nil : request.body
        result.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !token.isEmpty { result.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return result
    }
}
