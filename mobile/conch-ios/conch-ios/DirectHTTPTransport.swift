import Foundation

/// The existing LAN transport, isolated behind the same request surface as the
/// relay. It deliberately keeps its HTTP/ws behavior; selecting LAN never
/// probes or falls back to the internet relay.
final class DirectHTTPTransport: BridgeTransport, @unchecked Sendable {
    var onStateData: ((Data) -> Void)?
    var onConnectionChange: ((Bool, String?) -> Void)?

    private let host: String
    private let token: String
    private let session: URLSession
    private let lock = NSLock()
    private var task: URLSessionWebSocketTask?
    private var reconnectTask: Task<Void, Never>?
    private var reconnectDelay: TimeInterval = 0.5
    private var stopped = false
    private var generation = 0

    init(host: String, token: String, session: URLSession = .shared) {
        self.host = host
        self.token = token
        self.session = session
    }

    func start() {
        lock.lock()
        stopped = false
        lock.unlock()
        connect()
    }

    func stop() {
        let current: URLSessionWebSocketTask?
        lock.lock()
        stopped = true
        generation += 1
        reconnectTask?.cancel()
        reconnectTask = nil
        current = task
        task = nil
        lock.unlock()
        current?.cancel(with: .goingAway, reason: nil)
        publishConnection(false, nil)
    }

    func reconnectNow() {
        let current: URLSessionWebSocketTask?
        lock.lock()
        guard !stopped else { lock.unlock(); return }
        generation += 1
        reconnectDelay = 0.5
        reconnectTask?.cancel()
        reconnectTask = nil
        current = task
        task = nil
        lock.unlock()
        current?.cancel(with: .goingAway, reason: nil)
        connect()
    }

    func request(_ request: BridgeRequest) async throws -> BridgeResponse {
        var urlRequest = try makeURLRequest(request, timeout: 10)
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw BridgeTransportError.invalidResponse
        }
        return BridgeResponse(
            status: http.statusCode,
            headers: http.allHeaderFields.compactMap { key, value in
                guard let key = key as? String else { return nil }
                return [key.lowercased(), String(describing: value)]
            },
            body: data
        )
    }

    func download(_ request: BridgeRequest) async throws -> URL {
        var urlRequest = try makeURLRequest(request, timeout: 120)
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (temporary, response) = try await session.download(for: urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw BridgeTransportError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            throw BridgeTransportError.httpStatus(http.statusCode)
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("conch-lan-downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let ext = downloadExtension(from: request.path)
        let stem = UUID().uuidString
        let final = directory.appendingPathComponent(ext.isEmpty ? stem : "\(stem).\(ext)")
        try FileManager.default.moveItem(at: temporary, to: final)
        return final
    }

    private func connect() {
        lock.lock()
        guard !stopped, task == nil, let base = URL(string: "http://\(host)") else {
            lock.unlock()
            return
        }
        generation += 1
        let currentGeneration = generation
        var components = URLComponents(
            url: base.appendingPathComponent("ws"),
            resolvingAgainstBaseURL: false
        )!
        components.scheme = "ws"
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        let created = session.webSocketTask(with: components.url!)
        task = created
        lock.unlock()
        created.resume()
        receive(on: created, generation: currentGeneration)
    }

    private func receive(on expected: URLSessionWebSocketTask, generation expectedGeneration: Int) {
        expected.receive { [weak self] result in
            guard let self else { return }
            self.lock.lock()
            let current = self.task === expected
                && self.generation == expectedGeneration
                && !self.stopped
            self.lock.unlock()
            guard current else { return }
            switch result {
            case let .success(message):
                self.lock.lock()
                self.reconnectDelay = 0.5
                self.lock.unlock()
                self.publishConnection(true, nil)
                switch message {
                case let .string(text): self.publishState(Data(text.utf8))
                case let .data(data): self.publishState(data)
                @unknown default: break
                }
                self.receive(on: expected, generation: expectedGeneration)
            case let .failure(error):
                self.fail(expected, generation: expectedGeneration, error: error)
            }
        }
    }

    private func fail(_ expected: URLSessionWebSocketTask, generation expectedGeneration: Int, error: Error) {
        lock.lock()
        guard task === expected, generation == expectedGeneration, !stopped else {
            lock.unlock()
            return
        }
        task = nil
        expected.cancel(with: .goingAway, reason: nil)
        let delay = reconnectDelay * Double.random(in: 0.8...1.2)
        reconnectDelay = min(8, reconnectDelay * 2)
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.clearReconnectTask()
            self.connect()
        }
        lock.unlock()
        publishConnection(false, error.localizedDescription)
    }

    private func clearReconnectTask() {
        lock.lock()
        reconnectTask = nil
        lock.unlock()
    }

    private func makeURLRequest(_ request: BridgeRequest, timeout: TimeInterval) throws -> URLRequest {
        guard request.path.hasPrefix("/"), !request.path.hasPrefix("//"),
              let base = URL(string: "http://\(host)"),
              let url = URL(string: request.path, relativeTo: base)?.absoluteURL else {
            throw BridgeTransportError.invalidRequest
        }
        var result = URLRequest(url: url)
        result.httpMethod = request.method
        result.httpBody = request.body.isEmpty ? nil : request.body
        result.timeoutInterval = timeout
        for pair in request.headers where pair.count == 2 {
            result.setValue(pair[1], forHTTPHeaderField: pair[0])
        }
        return result
    }

    private func publishState(_ data: Data) {
        let callback = onStateData
        DispatchQueue.main.async { callback?(data) }
    }

    private func publishConnection(_ connected: Bool, _ error: String?) {
        let callback = onConnectionChange
        DispatchQueue.main.async { callback?(connected, error) }
    }

    private func downloadExtension(from path: String) -> String {
        guard let components = URLComponents(string: "https://conch.invalid\(path)"),
              let value = components.queryItems?.first(where: { $0.name == "path" })?.value else {
            return ""
        }
        let ext = (value as NSString).pathExtension.lowercased()
        return ext.count <= 16 && ext.allSatisfy { $0.isLetter || $0.isNumber } ? ext : ""
    }
}
