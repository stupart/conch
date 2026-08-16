import CryptoKit
import Foundation

struct BridgeRequest: Equatable, Sendable {
    let method: String
    let path: String
    let headers: [[String]]
    let body: Data

    init(method: String, path: String, headers: [[String]] = [], body: Data = Data()) {
        self.method = method.uppercased()
        self.path = path
        self.headers = headers
        self.body = body
    }

    init(method: String, path: String, headers: [String: String], body: Data = Data()) {
        self.init(
            method: method,
            path: path,
            headers: headers.keys.sorted().map { [$0.lowercased(), headers[$0]!] },
            body: body
        )
    }
}

struct BridgeResponse: Equatable, Sendable {
    let status: Int
    let headers: [[String]]
    let body: Data

    func header(named name: String) -> String? {
        headers.first { $0.count == 2 && $0[0].caseInsensitiveCompare(name) == .orderedSame }?[1]
    }
}

protocol BridgeTransport: AnyObject {
    var onStateData: ((Data) -> Void)? { get set }
    var onConnectionChange: ((Bool, String?) -> Void)? { get set }

    func start()
    func stop()
    func reconnectNow()
    func request(_ request: BridgeRequest) async throws -> BridgeResponse
    func download(_ request: BridgeRequest) async throws -> URL
}

enum BridgeTransportError: Error, LocalizedError {
    case stopped
    case replaced
    case invalidRequest
    case invalidResponse
    case responseTooLarge
    case tooManyRequests
    case httpStatus(Int)

    var errorDescription: String? {
        switch self {
        case .stopped: "The relay connection was stopped."
        case .replaced: "This relay connection was replaced by another phone."
        case .invalidRequest: "The relay request is invalid or too large."
        case .invalidResponse: "The Mac sent an invalid relay response."
        case .responseTooLarge: "The response is too large to hold in memory."
        case .tooManyRequests: "Too many relay requests are already waiting."
        case let .httpStatus(status): "The Mac returned HTTP \(status)."
        }
    }
}

/// Phone-side E2E relay. The engine retains logical requests across socket
/// generations and resends the same IDs after a fresh authenticated handshake.
final class RelayTransport: BridgeTransport, @unchecked Sendable {
    var onStateData: ((Data) -> Void)? {
        get { callbacks.stateCallback }
        set { callbacks.stateCallback = newValue }
    }

    var onConnectionChange: ((Bool, String?) -> Void)? {
        get { callbacks.connectionCallback }
        set { callbacks.connectionCallback = newValue }
    }

    private let callbacks = RelayCallbackBox()
    private let engine: RelayTransportEngine

    init(pairing: RelayPairingPayload, session: URLSession = .shared) {
        engine = RelayTransportEngine(pairing: pairing, session: session, callbacks: callbacks)
    }

    func start() { Task { await engine.start() } }
    func stop() { Task { await engine.stop() } }
    func reconnectNow() { Task { await engine.reconnectNow() } }

    func request(_ request: BridgeRequest) async throws -> BridgeResponse {
        try await engine.request(request)
    }

    func download(_ request: BridgeRequest) async throws -> URL {
        try await engine.download(request)
    }
}

private final class RelayCallbackBox: @unchecked Sendable {
    private let lock = NSLock()
    private var state: ((Data) -> Void)?
    private var connection: ((Bool, String?) -> Void)?

    var stateCallback: ((Data) -> Void)? {
        get { lock.withLock { state } }
        set { lock.withLock { state = newValue } }
    }

    var connectionCallback: ((Bool, String?) -> Void)? {
        get { lock.withLock { connection } }
        set { lock.withLock { connection = newValue } }
    }

    func publishState(_ data: Data) {
        guard let callback = stateCallback else { return }
        DispatchQueue.main.async { callback(data) }
    }

    func publishConnection(_ connected: Bool, error: String?) {
        guard let callback = connectionCallback else { return }
        DispatchQueue.main.async { callback(connected, error) }
    }
}

private enum RelayPendingResult {
    case response(BridgeResponse)
    case file(URL)
}

private final class RelayPendingRequest {
    enum Destination {
        case memory
        case file(temporary: URL, final: URL, handle: FileHandle)
    }

    let id: String
    let request: BridgeRequest
    let destination: Destination
    let continuation: CheckedContinuation<RelayPendingResult, Error>
    var sentGeneration: Int?
    var sentSessionGeneration: Int?
    var status: Int?
    var headers: [[String]] = []
    var receivedBytes = 0
    var lastFrameSequence: UInt64?
    var body = Data()
    var hash = SHA256()
    var lastProgressAt = ContinuousClock.now

    init(
        id: String,
        request: BridgeRequest,
        destination: Destination,
        continuation: CheckedContinuation<RelayPendingResult, Error>
    ) {
        self.id = id
        self.request = request
        self.destination = destination
        self.continuation = continuation
    }

    func resetForRetry() throws {
        sentGeneration = nil
        sentSessionGeneration = nil
        status = nil
        headers = []
        receivedBytes = 0
        lastFrameSequence = nil
        body.removeAll(keepingCapacity: true)
        hash = SHA256()
        lastProgressAt = .now
        if case let .file(_, _, handle) = destination {
            try handle.truncate(atOffset: 0)
            try handle.seek(toOffset: 0)
        }
    }

    func append(_ chunk: Data) throws {
        guard !chunk.isEmpty,
              chunk.count <= 64 * 1024 else {
            throw BridgeTransportError.invalidResponse
        }
        receivedBytes += chunk.count
        hash.update(data: chunk)
        switch destination {
        case .memory:
            guard receivedBytes <= 2 * 1024 * 1024 else {
                throw BridgeTransportError.responseTooLarge
            }
            body.append(chunk)
        case let .file(_, _, handle):
            try handle.write(contentsOf: chunk)
        }
    }

    func closeFile() {
        if case let .file(_, _, handle) = destination { try? handle.close() }
    }

    func removePartial() {
        guard case let .file(temporary, _, _) = destination else { return }
        try? FileManager.default.removeItem(at: temporary)
    }
}

private struct RelayRequestWire: Encodable {
    let path: String
    let headers: [[String]]
    let body: String
}

private struct RelayResponseHead: Decodable {
    let status: Int
    let headers: [[String]]
}

private struct RelayResponseEnd: Decodable {
    let bytes: Int
    let sha256: String
}

private actor RelayTransportEngine {
    private static let stateRequestId = "state-subscription"
    private static let pingId = "phone-ping"
    private static let replacedCloseCode = 4001
    private static let maximumPendingRequests = 128
    private static let requestProgressTimeout = Duration.seconds(30)
    private static let stateProgressTimeout = Duration.seconds(30)
    private static let maximumStateBytes = 2 * 1024 * 1024

    private let pairing: RelayPairingPayload
    private let urlSession: URLSession
    private let callbacks: RelayCallbackBox
    private var socket: URLSessionWebSocketTask?
    private var socketGeneration = 0
    private var sessionGeneration = 0
    private var handshake: RelayHandshakeCrypto?
    private var cipher: RelaySessionCrypto?
    private var receiveTask: Task<Void, Never>?
    private var helloTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var reconnectDelay: TimeInterval = 0.5
    private var stopped = false
    private var reconnectSuppressed = false
    private var reportedConnected = false
    private var sessionAuthenticated = false
    private var currentPeerChallenge: String?
    private var seenPeerChallenges = Set<String>()
    private var newestStateSequence: UInt64?
    private var stateStatus: Int?
    private var stateBody = Data()
    private var stateHash = SHA256()
    private var stateSubscriptionStartedAt: ContinuousClock.Instant?
    private var lastStateProgressAt: ContinuousClock.Instant?
    private var lastAuthenticatedFrame = ContinuousClock.now
    private var pending: [String: RelayPendingRequest] = [:]
    private var order: [String] = []
    private var flushingSession: Int?

    init(pairing: RelayPairingPayload, session: URLSession, callbacks: RelayCallbackBox) {
        self.pairing = pairing
        self.urlSession = session
        self.callbacks = callbacks
    }

    func start() {
        guard !stopped, socket == nil else { return }
        connect()
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        retireSocket()
        reconnectTask?.cancel()
        reconnectTask = nil
        reportDisconnected(BridgeTransportError.stopped.localizedDescription)
        let requests = Array(pending.values)
        pending.removeAll()
        order.removeAll()
        for request in requests {
            request.closeFile()
            request.removePartial()
            request.continuation.resume(throwing: BridgeTransportError.stopped)
        }
    }

    /// Connect now — including after a stop. See DirectHTTPTransport for the
    /// full story: backgrounding stops the transport on purpose and
    /// foregrounding calls this, so refusing after a stop meant the first
    /// background disconnected the phone permanently.
    func reconnectNow() {
        stopped = false
        reconnectSuppressed = false
        reconnectDelay = 0.5
        reconnectTask?.cancel()
        reconnectTask = nil
        resetPendingForReconnect()
        retireSocket()
        connect()
    }

    func request(_ request: BridgeRequest) async throws -> BridgeResponse {
        let id = UUID().uuidString.lowercased()
        let result = try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await enqueue(request, id: id, destination: .memory)
        } onCancel: {
            Task { await self.cancelRequest(id) }
        }
        switch result {
        case let .response(response): return response
        case .file: throw BridgeTransportError.invalidResponse
        }
    }

    func download(_ request: BridgeRequest) async throws -> URL {
        try Task.checkCancellation()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("conch-relay-downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let stem = UUID().uuidString
        let ext = downloadExtension(from: request.path)
        let temporary = directory.appendingPathComponent("\(stem).part")
        let final = directory.appendingPathComponent(ext.isEmpty ? stem : "\(stem).\(ext)")
        guard FileManager.default.createFile(atPath: temporary.path, contents: nil) else {
            throw BridgeTransportError.invalidResponse
        }
        let handle = try FileHandle(forWritingTo: temporary)
        let id = UUID().uuidString.lowercased()
        do {
            let result = try await withTaskCancellationHandler {
                try Task.checkCancellation()
                return try await enqueue(
                    request,
                    id: id,
                    destination: .file(temporary: temporary, final: final, handle: handle)
                )
            } onCancel: {
                Task { await self.cancelRequest(id) }
            }
            switch result {
            case let .file(url): return url
            case .response: throw BridgeTransportError.invalidResponse
            }
        } catch {
            try? handle.close()
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
    }

    private func enqueue(
        _ request: BridgeRequest,
        id: String,
        destination: RelayPendingRequest.Destination
    ) async throws -> RelayPendingResult {
        try validate(request)
        guard pending.count < Self.maximumPendingRequests else {
            throw BridgeTransportError.tooManyRequests
        }
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = RelayPendingRequest(
                id: id,
                request: request,
                destination: destination,
                continuation: continuation
            )
            order.append(id)
            Task { await self.flushPending() }
        }
    }

    private func cancelRequest(_ id: String) async {
        guard let request = pending.removeValue(forKey: id) else { return }
        order.removeAll { $0 == id }
        request.closeFile()
        request.removePartial()
        request.continuation.resume(throwing: CancellationError())
        guard request.request.method == "GET" || request.request.method == "HEAD" else { return }
        try? await sendCancellation(
            id: id,
            method: request.request.method,
            socketGeneration: socketGeneration,
            sessionGeneration: sessionGeneration
        )
    }

    private func sendCancellation(
        id: String,
        method: String,
        socketGeneration: Int,
        sessionGeneration: Int
    ) async throws {
        guard socketGeneration == self.socketGeneration,
              sessionGeneration == self.sessionGeneration,
              let socket,
              let cipher else { return }
        let wire = try cipher.sealer.seal(
            id: id,
            method: method,
            kind: .cancel,
            body: Data()
        )
        try await sendWire(wire, on: socket)
    }

    private func connect() {
        guard !stopped, !reconnectSuppressed, socket == nil else { return }
        do {
            socketGeneration += 1
            let generation = socketGeneration
            handshake = try RelayHandshakeCrypto(pairing: pairing, role: .phone)
            cipher = nil
            let task = urlSession.webSocketTask(with: try relayURL())
            socket = task
            task.resume()
            receiveTask = Task { [weak self] in
                await self?.receiveLoop(task, generation: generation)
            }
            helloTask = Task { [weak self] in
                guard let self else { return }
                await self.helloLoop(generation: generation)
            }
        } catch {
            scheduleReconnect(error)
        }
    }

    private func relayURL() throws -> URL {
        var components = URLComponents(url: pairing.endpointURL, resolvingAgainstBaseURL: false)
        let base = components?.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""
        components?.path = "/" + ([base, "v1", "room", pairing.roomId]
            .filter { !$0.isEmpty }
            .joined(separator: "/"))
        components?.queryItems = [URLQueryItem(name: "role", value: "phone")]
        guard let url = components?.url else { throw BridgeTransportError.invalidRequest }
        return url
    }

    private func helloLoop(generation: Int) async {
        // Retry only while this phone is actively handshaking. The Mac has no
        // blind idle timer; every valid phone hello receives a Mac hello.
        while !Task.isCancelled, generation == socketGeneration, !sessionAuthenticated {
            do { try await sendHello(generation: generation) } catch {
                await connectionFailed(error, generation: generation)
                return
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    private func sendHello(generation: Int) async throws {
        guard generation == socketGeneration,
              let socket,
              let handshake else { throw BridgeTransportError.stopped }
        try await sendWire(try handshake.sealedHello(), on: socket)
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask, generation: Int) async {
        do {
            while !Task.isCancelled, generation == socketGeneration {
                let message = try await task.receive()
                let data: Data
                switch message {
                case let .data(value): data = value
                case let .string(value): data = Data(value.utf8)
                @unknown default: throw BridgeTransportError.invalidResponse
                }
                guard data.count <= RelayProtocolLimits.maximumEncryptedFrameBytes else {
                    throw RelayProtocolError.frameTooLarge
                }
                await receive(data, generation: generation)
            }
        } catch {
            await connectionFailed(error, generation: generation)
        }
    }

    private func receive(_ wire: Data, generation: Int) async {
        guard generation == socketGeneration else { return }
        // Probe every wire with a fresh root-key opener. A replacement Mac can
        // join while the phone's Durable Object socket remains alive, and its
        // first hello starts again at sequence zero.
        if let handshake, let peer = try? handshake.openPeerHello(wire) {
            do {
                try await acceptPeerHello(peer, handshake: handshake, generation: generation)
            } catch {
                await connectionFailed(error, generation: generation)
            }
            return
        }
        guard let cipher else { return }
        let opened: RelayOpenedFrame
        do {
            opened = try cipher.opener.open(wire)
        } catch RelayProtocolError.replayedFrame {
            return
        } catch {
            // The untrusted relay may inject arbitrary bytes. Authentication
            // failure is a dropped frame, not permission to churn the socket.
            return
        }
        lastAuthenticatedFrame = .now
        sessionAuthenticated = true
        helloTask?.cancel()
        helloTask = nil
        switch opened.header.kind {
        case .pong:
            guard opened.header.id == Self.pingId, opened.header.method == "PING" else { return }
        case .responseHead, .responseChunk, .responseEnd:
            do {
                let acknowledge = try consumeResponse(opened)
                if acknowledge {
                    try await sendChunkAcknowledgement(
                        opened,
                        socketGeneration: generation,
                        sessionGeneration: sessionGeneration
                    )
                }
            } catch {
                await connectionFailed(error, generation: generation)
            }
        default:
            return
        }
    }

    private func acceptPeerHello(
        _ peer: RelayHandshakeHello,
        handshake: RelayHandshakeCrypto,
        generation: Int
    ) async throws {
        let challenge = peer.challenge
        if challenge == currentPeerChallenge {
            // Never recreate a cipher for the same challenges: the keys would
            // stay the same while nonce/replay tracking was reset. The hello
            // loop already retries our side until a session-key frame proves it.
            return
        }
        // Never roll an established phone socket back to a recorded Mac session.
        guard !seenPeerChallenges.contains(challenge) else { return }
        // Bound the replay history. A socket reconnect creates a fresh phone
        // challenge, making every recorded session unusable again.
        guard seenPeerChallenges.count < 256 else {
            throw RelayProtocolError.keyExpired
        }
        seenPeerChallenges.insert(challenge)
        currentPeerChallenge = challenge
        try await establishSession(peer, handshake: handshake, generation: generation)
    }

    private func establishSession(
        _ peer: RelayHandshakeHello,
        handshake: RelayHandshakeCrypto,
        generation: Int
    ) async throws {
        sessionGeneration += 1
        let establishedSession = sessionGeneration
        flushingSession = nil
        cipher = try handshake.sessionCrypto(with: peer)
        sessionAuthenticated = false
        resetStateStream()
        lastAuthenticatedFrame = .now
        resetPendingForReconnect()
        // Reply before application frames. The one-second hello loop keeps
        // retrying this same authenticated challenge until a session-key frame
        // proves the Mac received it; same-challenge retries preserve the cipher.
        try await sendHello(generation: generation)
        guard generation == socketGeneration,
              establishedSession == sessionGeneration else { return }
        try await sendStateSubscription(
            socketGeneration: generation,
            sessionGeneration: establishedSession
        )
        try await sendPing(
            socketGeneration: generation,
            sessionGeneration: establishedSession
        )
        startHeartbeat(generation: generation)
        await flushPending()
    }

    private func sendStateSubscription(
        socketGeneration: Int,
        sessionGeneration: Int
    ) async throws {
        let request = BridgeRequest(
            method: "GET",
            path: "/ws",
            headers: [["authorization", "Bearer \(pairing.secret)"]]
        )
        try await sendRequest(
            request,
            id: Self.stateRequestId,
            socketGeneration: socketGeneration,
            sessionGeneration: sessionGeneration
        )
        guard socketGeneration == self.socketGeneration,
              sessionGeneration == self.sessionGeneration else { return }
        stateSubscriptionStartedAt = .now
    }

    private func sendPing(
        socketGeneration: Int,
        sessionGeneration: Int
    ) async throws {
        guard socketGeneration == self.socketGeneration,
              sessionGeneration == self.sessionGeneration,
              let socket,
              let cipher else { throw BridgeTransportError.stopped }
        let wire = try cipher.sealer.seal(
            id: Self.pingId,
            method: "PING",
            kind: .ping,
            body: Data()
        )
        try await sendWire(wire, on: socket)
    }

    private func startHeartbeat(generation: Int) {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled else { return }
                await self.heartbeat(generation: generation)
            }
        }
    }

    private func heartbeat(generation: Int) async {
        guard generation == socketGeneration else { return }
        if lastAuthenticatedFrame.duration(to: .now) > .seconds(30) {
            await connectionFailed(URLError(.timedOut), generation: generation)
            return
        }
        if pending.values.contains(where: { request in
            request.sentSessionGeneration == sessionGeneration
                && request.lastProgressAt.duration(to: .now) > Self.requestProgressTimeout
        }) {
            // A relay can drop one request or response while continuing pongs.
            // Rekey the socket and resend the same stable logical IDs; POSTs are
            // deduplicated by the Mac before their handler is invoked.
            await connectionFailed(URLError(.timedOut), generation: generation)
            return
        }
        if let stateSubscriptionStartedAt,
           stateSubscriptionStartedAt.duration(to: .now) > Self.stateProgressTimeout,
           lastStateProgressAt == nil {
            await connectionFailed(URLError(.timedOut), generation: generation)
            return
        }
        if let lastStateProgressAt,
           lastStateProgressAt.duration(to: .now) > Self.stateProgressTimeout {
            await connectionFailed(URLError(.timedOut), generation: generation)
            return
        }
        do {
            try await sendPing(
                socketGeneration: generation,
                sessionGeneration: sessionGeneration
            )
        } catch {
            await connectionFailed(error, generation: generation)
        }
    }

    private func flushPending() async {
        let generation = socketGeneration
        let session = sessionGeneration
        guard flushingSession != session, cipher != nil, socket != nil else { return }
        flushingSession = session
        defer {
            if flushingSession == session { flushingSession = nil }
        }
        for id in order {
            guard generation == socketGeneration,
                  session == sessionGeneration,
                  let request = pending[id],
                  request.sentSessionGeneration != session else { continue }
            do {
                try await sendRequest(
                    request.request,
                    id: id,
                    socketGeneration: generation,
                    sessionGeneration: session
                )
                guard generation == socketGeneration,
                      session == sessionGeneration,
                      pending[id] === request else { return }
                request.sentGeneration = generation
                request.sentSessionGeneration = session
                request.lastProgressAt = .now
            } catch {
                guard generation == socketGeneration,
                      session == sessionGeneration else { return }
                await connectionFailed(error, generation: generation)
                return
            }
        }
    }

    private func sendRequest(
        _ request: BridgeRequest,
        id: String,
        socketGeneration: Int,
        sessionGeneration: Int
    ) async throws {
        guard socketGeneration == self.socketGeneration,
              sessionGeneration == self.sessionGeneration,
              let socket,
              let cipher else { throw BridgeTransportError.stopped }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let body = try encoder.encode(RelayRequestWire(
            path: request.path,
            headers: request.headers,
            body: RelayBase64URL.encode(request.body)
        ))
        guard body.count <= RelayProtocolLimits.maximumPlaintextBodyBytes else {
            throw BridgeTransportError.invalidRequest
        }
        let wire = try cipher.sealer.seal(
            id: id,
            method: request.method,
            kind: .request,
            body: body
        )
        try await sendWire(wire, on: socket)
    }

    private func sendWire(_ wire: Data, on socket: URLSessionWebSocketTask) async throws {
        guard let text = String(data: wire, encoding: .utf8) else {
            throw BridgeTransportError.invalidRequest
        }
        try await socket.send(.string(text))
    }

    private func consumeResponse(_ opened: RelayOpenedFrame) throws -> Bool {
        if opened.header.id == Self.stateRequestId,
           opened.header.method == "GET" {
            return try consumeStateResponse(opened)
        }
        guard let request = pending[opened.header.id],
              opened.header.method == request.request.method else { return false }
        if let previous = request.lastFrameSequence,
           opened.header.sequence <= previous {
            throw BridgeTransportError.invalidResponse
        }
        request.lastFrameSequence = opened.header.sequence
        switch opened.header.kind {
        case .responseHead:
            guard request.status == nil,
                  let head = try? JSONDecoder().decode(RelayResponseHead.self, from: opened.body),
                  (100...599).contains(head.status),
                  head.headers.count <= 64,
                  head.headers.allSatisfy({ $0.count == 2 }) else {
                throw BridgeTransportError.invalidResponse
            }
            request.status = head.status
            request.headers = head.headers
            request.lastProgressAt = .now
            return false
        case .responseChunk:
            guard request.status != nil else { throw BridgeTransportError.invalidResponse }
            try request.append(opened.body)
            request.lastProgressAt = .now
            return true
        case .responseEnd:
            guard let status = request.status,
                  let end = try? JSONDecoder().decode(RelayResponseEnd.self, from: opened.body),
                  end.bytes == request.receivedBytes,
                  let expected = try? RelayBase64URL.decode(end.sha256, maximumEncodedBytes: 64),
                  expected.count == 32 else {
                throw BridgeTransportError.invalidResponse
            }
            let actual = Data(request.hash.finalize())
            guard actual == expected else { throw BridgeTransportError.invalidResponse }
            finish(request, status: status)
            return false
        default:
            throw BridgeTransportError.invalidResponse
        }
    }

    private func consumeStateResponse(_ opened: RelayOpenedFrame) throws -> Bool {
        if let newestStateSequence,
           opened.header.sequence <= newestStateSequence { return false }
        newestStateSequence = opened.header.sequence
        switch opened.header.kind {
        case .responseHead:
            guard let head = try? JSONDecoder().decode(RelayResponseHead.self, from: opened.body),
                  head.status == 200,
                  head.headers.count <= 64,
                  head.headers.allSatisfy({ $0.count == 2 }) else {
                throw BridgeTransportError.invalidResponse
            }
            stateStatus = head.status
            stateBody.removeAll(keepingCapacity: true)
            stateHash = SHA256()
            lastStateProgressAt = .now
            return false
        case .responseChunk:
            guard stateStatus == 200,
                  !opened.body.isEmpty,
                  opened.body.count <= 64 * 1024,
                  stateBody.count + opened.body.count <= Self.maximumStateBytes else {
                throw BridgeTransportError.invalidResponse
            }
            stateBody.append(opened.body)
            stateHash.update(data: opened.body)
            lastStateProgressAt = .now
            return true
        case .responseEnd:
            guard stateStatus == 200,
                  let end = try? JSONDecoder().decode(RelayResponseEnd.self, from: opened.body),
                  end.bytes == stateBody.count,
                  let expected = try? RelayBase64URL.decode(end.sha256, maximumEncodedBytes: 64),
                  expected.count == 32,
                  Data(stateHash.finalize()) == expected else {
                throw BridgeTransportError.invalidResponse
            }
            let completed = stateBody
            stateStatus = nil
            stateBody = Data()
            stateHash = SHA256()
            stateSubscriptionStartedAt = nil
            lastStateProgressAt = .now
            callbacks.publishState(completed)
            if !reportedConnected {
                reportedConnected = true
                reconnectDelay = 0.5
                callbacks.publishConnection(true, error: nil)
            }
            return false
        default:
            throw BridgeTransportError.invalidResponse
        }
    }

    private func sendChunkAcknowledgement(
        _ opened: RelayOpenedFrame,
        socketGeneration: Int,
        sessionGeneration: Int
    ) async throws {
        guard socketGeneration == self.socketGeneration,
              sessionGeneration == self.sessionGeneration,
              let socket,
              let cipher else { throw BridgeTransportError.stopped }
        var value = opened.header.sequence.bigEndian
        let body = withUnsafeBytes(of: &value) { Data($0) }
        let wire = try cipher.sealer.seal(
            id: opened.header.id,
            method: opened.header.method,
            kind: .chunkAck,
            body: body
        )
        try await sendWire(wire, on: socket)
    }

    private func resetStateStream() {
        newestStateSequence = nil
        stateStatus = nil
        stateBody = Data()
        stateHash = SHA256()
        stateSubscriptionStartedAt = nil
        lastStateProgressAt = nil
    }

    private func finish(_ request: RelayPendingRequest, status: Int) {
        pending.removeValue(forKey: request.id)
        order.removeAll { $0 == request.id }
        switch request.destination {
        case .memory:
            request.continuation.resume(returning: .response(BridgeResponse(
                status: status,
                headers: request.headers,
                body: request.body
            )))
        case let .file(temporary, final, handle):
            try? handle.close()
            guard (200...299).contains(status) else {
                try? FileManager.default.removeItem(at: temporary)
                request.continuation.resume(throwing: BridgeTransportError.httpStatus(status))
                return
            }
            do {
                try FileManager.default.moveItem(at: temporary, to: final)
                request.continuation.resume(returning: .file(final))
            } catch {
                try? FileManager.default.removeItem(at: temporary)
                request.continuation.resume(throwing: error)
            }
        }
    }

    private func validate(_ request: BridgeRequest) throws {
        guard request.method.utf8.count >= 3,
              request.method.utf8.count <= 16,
              request.method.utf8.allSatisfy({ $0 >= 65 && $0 <= 90 }),
              request.path.hasPrefix("/"),
              !request.path.hasPrefix("//"),
              !request.path.contains("#"),
              request.path.utf8.count <= 8 * 1024,
              request.body.count <= RelayProtocolLimits.maximumPlaintextBodyBytes,
              request.headers.count <= 64,
              request.headers.allSatisfy({ pair in
                  pair.count == 2 && !pair[0].isEmpty
                      && !pair[0].contains(where: { $0 == "\r" || $0 == "\n" })
                      && !pair[1].contains(where: { $0 == "\r" || $0 == "\n" })
              }) else {
            throw BridgeTransportError.invalidRequest
        }
    }

    private func connectionFailed(_ error: Error, generation: Int) async {
        guard generation == socketGeneration, !stopped else { return }
        let replaced = socket?.closeCode.rawValue == Self.replacedCloseCode
        if replaced {
            retireSocket()
            reconnectSuppressed = true
            let requests = Array(pending.values)
            pending.removeAll()
            order.removeAll()
            for request in requests {
                request.closeFile()
                request.removePartial()
                request.continuation.resume(throwing: BridgeTransportError.replaced)
            }
            reportedConnected = false
            callbacks.publishConnection(false, error: BridgeTransportError.replaced.localizedDescription)
            return
        }
        resetPendingForReconnect()
        retireSocket()
        reportDisconnected(error.localizedDescription)
        scheduleReconnect(error)
    }

    private func resetPendingForReconnect() {
        for request in Array(pending.values) {
            do { try request.resetForRetry() } catch {
                pending.removeValue(forKey: request.id)
                order.removeAll { $0 == request.id }
                request.closeFile()
                request.removePartial()
                request.continuation.resume(throwing: error)
            }
        }
    }

    private func retireSocket() {
        socketGeneration += 1
        sessionGeneration += 1
        receiveTask?.cancel()
        helloTask?.cancel()
        heartbeatTask?.cancel()
        receiveTask = nil
        helloTask = nil
        heartbeatTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        handshake = nil
        cipher = nil
        sessionAuthenticated = false
        currentPeerChallenge = nil
        seenPeerChallenges.removeAll(keepingCapacity: true)
        resetStateStream()
        flushingSession = nil
    }

    private func reportDisconnected(_ error: String?) {
        if reportedConnected {
            reportedConnected = false
            callbacks.publishConnection(false, error: error)
        }
    }

    private func scheduleReconnect(_ error: Error) {
        guard !stopped, !reconnectSuppressed, reconnectTask == nil else { return }
        reportDisconnected(error.localizedDescription)
        let base = reconnectDelay
        reconnectDelay = min(30, reconnectDelay * 2)
        let jittered = base * Double.random(in: 0.8...1.2)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(jittered))
            guard !Task.isCancelled, let self else { return }
            await self.clearReconnectAndConnect()
        }
    }

    private func clearReconnectAndConnect() {
        reconnectTask = nil
        connect()
    }

    private func downloadExtension(from path: String) -> String {
        guard let components = URLComponents(string: "https://conch.invalid\(path)"),
              let value = components.queryItems?.first(where: { $0.name == "path" })?.value else {
            return ""
        }
        let ext = (value as NSString).pathExtension.lowercased()
        return ext.count <= 16 && ext.allSatisfy({ $0.isLetter || $0.isNumber }) ? ext : ""
    }
}

private extension NSLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
