import Foundation

/// The phone's protocol client. Pairing selects exactly one transport; state,
/// commands, replies, settings, and scoped files above this point are identical.
@MainActor
final class BridgeClient: ObservableObject {
    @Published private(set) var state: PublishedState?
    @Published private(set) var isConnected = false
    @Published private(set) var lastError: String?

    private let pairing: Pairing
    private let transport: BridgeTransport
    /// Fired on every (re)connection, so a claim survives daemon restarts.
    var onConnected: (() -> Void)?

    enum Pairing: Equatable {
        case lan(host: String, token: String)
        case relay(RelayPairingPayload)

        var bearer: String {
            switch self {
            case let .lan(_, token): token
            case let .relay(payload): payload.secret
            }
        }

        var displayHost: String {
            switch self {
            case let .lan(host, _): host
            case let .relay(payload): "Relay · \(payload.endpointURL.host ?? payload.endpoint)"
            }
        }
    }

    init(pairing: Pairing) {
        self.pairing = pairing
        switch pairing {
        case let .lan(host, token):
            transport = DirectHTTPTransport(host: host, token: token)
        case let .relay(payload):
            transport = RelayTransport(pairing: payload)
        }
        transport.onStateData = { [weak self] data in
            Task { @MainActor [weak self] in
                guard let self,
                      let decoded = try? JSONDecoder().decode(PublishedState.self, from: data) else { return }
                self.state = decoded
            }
        }
        transport.onConnectionChange = { [weak self] connected, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let becameConnected = connected && !self.isConnected
                self.isConnected = connected
                self.lastError = connected ? nil : error
                if becameConnected { self.onConnected?() }
            }
        }
        transport.start()
    }

    deinit {
        transport.stop()
    }

    func stop() {
        transport.stop()
        isConnected = false
    }

    /// The Mac this phone is paired to, for the connection popover.
    var pairedHost: String { pairing.displayHost }

    /// Retry now instead of waiting out the backoff — for when you know the
    /// Mac just came back and don't want to stare at a spinner.
    func reconnectNow() {
        transport.reconnectNow()
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

    /// Claim (or hand back) the voice. While the phone holds it the Mac stays
    /// quiet — otherwise you hear conch from the next room and from your ear at
    /// once, which is worse than either alone.
    @discardableResult
    func claimAudio(_ mine: Bool) async -> Bool {
        await post(control: ["kind": "audio-sink", "sink": mine ? "phone" : "mac"])
    }

    /// Tell the Mac which session THIS phone is reading, and when it stops.
    ///
    /// The Mac cannot see the end of phone speech: with the audio lease held
    /// its own speak() returns immediately, so the ledger's speaking state
    /// flashed and vanished. Only the phone knows.
    @discardableResult
    func reportSpeaking(_ speaking: Bool, label: String) async -> Bool {
        await post(control: ["kind": "phone-speaking", "speaking": speaking, "label": label])
    }

    func send(mode action: String) async -> Bool {
        await post(control: ["type": action, "sessionId": "", "label": "", "announce": ""])
    }

    private func post(control message: [String: Any]) async -> Bool {
        guard let body = try? JSONSerialization.data(withJSONObject: message) else {
            return false
        }
        do {
            let response = try await transport.request(authorizedRequest(
                method: "POST",
                path: "/control",
                body: body
            ))
            guard response.status == 200 else { return false }
            // Turn-event success is an empty daemon reply. A scoped inject can
            // instead return session-error; do not tell TalkController to erase
            // the user's words when the daemon rejected the target.
            if !response.body.isEmpty,
               let decoded = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any],
               decoded["error"] != nil {
                lastError = decoded["error"] as? String
                return false
            }
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    enum SettingsResult {
        case loaded([ConchSetting])
        case failed(String)
    }

    /// The daemon's own settings registry, over the control channel the Mac
    /// and terminal already use. The phone renders it; it never redefines it.
    func fetchSettings() async -> SettingsResult {
        guard let reply = await postControlRaw(["kind": "get-config"]) else {
            return .failed("Couldn't reach your Mac.")
        }
        guard let snapshot = reply["snapshot"] as? [String: Any] else {
            return .failed((reply["error"] as? String) ?? "The Mac sent something unexpected.")
        }
        return .loaded(snapshot.compactMap(ConchSetting.init(key:raw:)))
    }

    func setSetting(key: String, value: ConchSettingValue) async -> Bool {
        let wire: Any
        switch value {
        case let .bool(on): wire = on
        case let .number(number): wire = number
        case let .string(text): wire = text
        }
        let reply = await postControlRaw(["kind": "set-config", "key": key, "value": wire])
        // The daemon acks with the resolved setting; an error carries `error`.
        return reply != nil && reply?["error"] == nil
    }

    private func postControlRaw(_ message: [String: Any]) async -> [String: Any]? {
        guard let body = try? JSONSerialization.data(withJSONObject: message),
              let response = try? await transport.request(authorizedRequest(
                method: "POST",
                path: "/control",
                body: body
              )),
              response.status == 200 else { return nil }
        return (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any]
    }

    /// Any session's latest reply, fetched on demand.
    ///
    /// Published state carries only the LAST turn's reply, so every other
    /// session rendered "No reply yet" — and a daemon restart made them all
    /// render it. The Mac app reads transcripts itself; the phone asks.
    func fetchReply(sessionId: String) async -> String? {
        var components = URLComponents()
        components.path = "/reply"
        components.queryItems = [URLQueryItem(name: "session", value: sessionId)]
        guard let path = components.string,
              let response = try? await transport.request(authorizedRequest(method: "GET", path: path)),
              response.status == 200,
              let body = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any],
              let markdown = body["markdown"] as? String,
              !markdown.isEmpty else {
            return nil
        }
        return markdown
    }

    /// Materialize a currently-scoped local deliverable for either transport.
    /// Relay files are decrypted chunk-by-chunk to a temporary file; LAN files
    /// use URLSession's disk-backed download path. Neither is assembled in RAM.
    func downloadFile(path: String) async -> URL? {
        var components = URLComponents()
        components.path = "/file"
        components.queryItems = [URLQueryItem(name: "path", value: path)]
        guard let requestPath = components.string else { return nil }
        do {
            return try await transport.download(authorizedRequest(method: "GET", path: requestPath))
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    private func authorizedRequest(method: String, path: String, body: Data = Data()) -> BridgeRequest {
        BridgeRequest(
            method: method,
            path: path,
            headers: ["authorization": "Bearer \(pairing.bearer)"],
            body: body
        )
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
    guard case let .lan(host, token) = pairing,
          let base = URL(string: "http://\(host)") else {
        return .unreachable("That host doesn't look right.")
    }
    var request = URLRequest(url: base.appendingPathComponent("state"))
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 5
    do {
        let (_, response) = try await URLSession.shared.data(for: request)
        switch (response as? HTTPURLResponse)?.statusCode {
        case 200: return .ok
        case 401: return .badCode
        default: return .unreachable("The Mac answered, but not like conch — check the host.")
        }
    } catch {
        return .unreachable("Couldn't reach \(host) — same Wi-Fi as the Mac?")
    }
}

/// The pairing lives in the Keychain: the token reads session transcripts, so
/// it gets credential storage, not UserDefaults.
enum PairingStore {
    private static let service = "ai.blueprintstudio.conch.phone"
    private static let versionedAccount = "pairing-v2"

    private struct StoredPairing: Codable {
        let version: Int
        let kind: String
        let host: String?
        let token: String?
        let relay: RelayPairingPayload?

        init(_ pairing: BridgeClient.Pairing) {
            version = 2
            switch pairing {
            case let .lan(host, token):
                kind = "lan"
                self.host = host
                self.token = token
                relay = nil
            case let .relay(payload):
                kind = "relay"
                host = nil
                token = nil
                relay = payload
            }
        }

        var pairing: BridgeClient.Pairing? {
            guard version == 2 else { return nil }
            if kind == "lan", let host, let token { return .lan(host: host, token: token) }
            if kind == "relay", let relay { return .relay(relay) }
            return nil
        }
    }

    static func load() -> BridgeClient.Pairing? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnData as String: true,
            kSecReturnAttributes as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let existing = item as? [String: Any],
              let account = existing[kSecAttrAccount as String] as? String,
              let data = existing[kSecValueData as String] as? Data else {
            return nil
        }
        if account == versionedAccount,
           let stored = try? JSONDecoder().decode(StoredPairing.self, from: data) {
            return stored.pairing
        }
        // Legacy installs stored account=host and value=raw token. Loading it
        // remains side-effect free and selects the LAN transport exactly.
        guard let token = String(data: data, encoding: .utf8) else { return nil }
        return .lan(host: account, token: token)
    }

    static func save(_ pairing: BridgeClient.Pairing) {
        guard let data = try? JSONEncoder().encode(StoredPairing(pairing)) else { return }
        delete()
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: versionedAccount,
            kSecValueData as String: data,
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
