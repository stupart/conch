import Foundation

/// The phone's line to the Mac: one WebSocket for state, REST for everything
/// else. Owns reconnection so no view ever thinks about it — the connection
/// either delivers fresh state or `isConnected` says why the screen is stale.
@MainActor
final class BridgeClient: ObservableObject {
    @Published private(set) var state: PublishedState?
    @Published private(set) var isConnected = false
    @Published private(set) var lastError: String?

    private var task: URLSessionWebSocketTask?
    private var reconnectDelay: TimeInterval = 0.5
    private var closed = false
    private let pairing: Pairing

    struct Pairing: Equatable {
        var host: String   // "192.168.1.20:8674"
        var token: String

        var base: URL? { URL(string: "http://\(host)") }
    }

    init(pairing: Pairing) {
        self.pairing = pairing
        connect()
    }

    deinit {
        task?.cancel(with: .goingAway, reason: nil)
    }

    func stop() {
        closed = true
        task?.cancel(with: .goingAway, reason: nil)
    }

    private func connect() {
        guard !closed, let base = pairing.base else { return }
        var components = URLComponents(
            url: base.appendingPathComponent("ws"),
            resolvingAgainstBaseURL: false
        )!
        components.scheme = "ws"
        components.queryItems = [URLQueryItem(name: "token", value: pairing.token)]
        let task = URLSession.shared.webSocketTask(with: components.url!)
        self.task = task
        task.resume()
        receive(on: task)
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self, self.task === task else { return }
                switch result {
                case let .success(message):
                    self.isConnected = true
                    self.lastError = nil
                    self.reconnectDelay = 0.5
                    if case let .string(text) = message,
                       let data = text.data(using: .utf8),
                       let decoded = try? JSONDecoder().decode(PublishedState.self, from: data) {
                        self.state = decoded
                    }
                    self.receive(on: task)
                case let .failure(error):
                    self.isConnected = false
                    self.lastError = error.localizedDescription
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func scheduleReconnect() {
        guard !closed else { return }
        let delay = reconnectDelay
        // Exponential backoff capped at 8s: fast enough to feel instant when
        // the Mac wakes, slow enough not to churn a phone battery all workout.
        reconnectDelay = min(8, reconnectDelay * 2)
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            self?.connect()
        }
    }

    // MARK: - Commands

    /// Deliver spoken text into a session. Returns true when the daemon took it.
    func inject(sessionId: String, label: String, text: String) async -> Bool {
        await post(control: [
            "type": "inject",
            "sessionId": sessionId,
            "label": label,
            "announce": text,
            "eventAt": Date().timeIntervalSince1970 * 1000,
        ])
    }

    func send(mode action: String) async -> Bool {
        await post(control: ["type": action, "sessionId": "", "label": "", "announce": ""])
    }

    private func post(control message: [String: Any]) async -> Bool {
        guard let base = pairing.base,
              let body = try? JSONSerialization.data(withJSONObject: message) else {
            return false
        }
        var request = URLRequest(url: base.appendingPathComponent("control"))
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 6
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    /// URL for a local-file deliverable, served by the bridge's scoped /file.
    func fileURL(for path: String) -> URL? {
        guard let base = pairing.base else { return nil }
        var components = URLComponents(
            url: base.appendingPathComponent("file"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(name: "path", value: path),
            URLQueryItem(name: "token", value: pairing.token),
        ]
        return components.url
    }
}

enum PairingProbeResult {
    case ok
    case badCode
    case unreachable(String)
}

/// Redeem a short pairing code for the real token.
///
/// A 32-character token is a fine secret and a terrible thing to type on a
/// phone. `conch pair` prints six digits instead, alive for two minutes and
/// good once; this trades them for the long-lived token, which the user never
/// sees or types.
enum RedeemResult {
    case token(String)
    case failed(String)
}

func redeemPairingCode(host: String, code: String) async -> RedeemResult {
    guard let base = URL(string: "http://\(host)") else {
        return .failed("That host doesn't look right.")
    }
    var request = URLRequest(url: base.appendingPathComponent("pair"))
    request.httpMethod = "POST"
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["code": code])
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.timeoutInterval = 6
    do {
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if status == 200, let token = body?["token"] as? String {
            return .token(token)
        }
        return .failed(
            (body?["error"] as? String)
                ?? "That code didn't work — run conch pair again for a fresh one."
        )
    } catch {
        return .failed("Couldn't reach \(host) — same Wi-Fi as the Mac?")
    }
}

/// One authenticated GET /state with the typed credentials, BEFORE anything is
/// saved. Committing blind meant a typo'd host and a wrong code looked
/// identical: a keychain write and an endless "Looking for your Mac…".
func probePairing(_ pairing: BridgeClient.Pairing) async -> PairingProbeResult {
    guard let base = pairing.base else { return .unreachable("That host doesn't look right.") }
    var request = URLRequest(url: base.appendingPathComponent("state"))
    request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 5
    do {
        let (_, response) = try await URLSession.shared.data(for: request)
        switch (response as? HTTPURLResponse)?.statusCode {
        case 200: return .ok
        case 401: return .badCode
        default: return .unreachable("The Mac answered, but not like conch — check the host.")
        }
    } catch {
        return .unreachable("Couldn't reach \(pairing.host) — same Wi-Fi as the Mac?")
    }
}

/// The pairing lives in the Keychain: the token reads session transcripts, so
/// it gets credential storage, not UserDefaults.
enum PairingStore {
    private static let service = "ai.blueprintstudio.conch.phone"

    static func load() -> BridgeClient.Pairing? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnData as String: true,
            kSecReturnAttributes as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let existing = item as? [String: Any],
              let host = existing[kSecAttrAccount as String] as? String,
              let data = existing[kSecValueData as String] as? Data,
              let token = String(data: data, encoding: .utf8) else {
            return nil
        }
        return BridgeClient.Pairing(host: host, token: token)
    }

    static func save(_ pairing: BridgeClient.Pairing) {
        delete()
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: pairing.host,
            kSecValueData as String: Data(pairing.token.utf8),
        ]
        SecItemAdd(add as CFDictionary, nil)
    }

    static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
