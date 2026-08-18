import Foundation

/// The phone's protocol client. Pairing selects exactly one transport; state,
/// commands, replies, settings, and scoped files above this point are identical.
@MainActor
final class BridgeClient: ObservableObject {
    @Published private(set) var state: PublishedState?
    @Published private(set) var isConnected = false
    @Published private(set) var lastError: String?
    /// Recent connection history, so a failure away from the desk leaves
    /// evidence instead of a shrug.
    ///
    /// Tyler took the phone out, it did not work, and the only record was on
    /// the Mac — which showed its own relay healthy the whole time and the
    /// phone simply absent for three hours. Whatever the phone was doing, it
    /// was doing it unobserved. Kept in memory and shown in Settings: enough to
    /// answer "did it even try, and what did it say?"
    @Published private(set) var journal: [ConnectionEvent] = []

    struct ConnectionEvent: Identifiable, Equatable {
        let id = UUID()
        let at: Date
        let connected: Bool
        let detail: String?
    }

    private static let journalLimit = 60

    private func record(connected: Bool, detail: String?) {
        journal.append(ConnectionEvent(at: Date(), connected: connected, detail: detail))
        if journal.count > Self.journalLimit {
            journal.removeFirst(journal.count - Self.journalLimit)
        }
    }

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

        /// Whether this pairing reaches the Mac over the internet.
        ///
        /// It changes what a failure MEANS, so it changes what we say about
        /// one: on LAN, "same Wi-Fi" is the likely fix; over the relay it is
        /// irrelevant advice that sends you to check something correct.
        var isRelay: Bool {
            if case .relay = self { return true }
            return false
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
                // Teach the recogniser what the sessions are called before it
                // has to hear one. Only on a real change: the labels move far
                // less often than the state does.
                let names = decoded.rows.map(\.label).filter { !$0.isEmpty }
                if names != self.knownSessionNames {
                    self.knownSessionNames = names
                    TalkController.learnSessionNames(names)
                }
                self.state = decoded
            }
        }
        transport.onConnectionChange = { [weak self] connected, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let becameConnected = connected && !self.isConnected
                // Record every TRANSITION, not every callback: a retry loop
                // fires constantly, and sixty lines of "still trying" would push
                // out the one line that says why.
                if connected != self.isConnected || (!connected && error != self.lastError) {
                    self.record(connected: connected, detail: error)
                }
                self.isConnected = connected
                if connected { self.hasEverConnected = true }
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

    /// Session labels last handed to the speech recogniser.
    private var knownSessionNames: [String] = []

    /// The Mac this phone is paired to, for the connection popover.
    var pairedHost: String { pairing.displayHost }

    /// Whether this pairing goes over the internet, which decides what a
    /// disconnection can honestly be blamed on.
    var isRelayPaired: Bool { pairing.isRelay }

    /// Has this pairing EVER connected?
    ///
    /// "Looking for your Mac…" is right the first time and misleading every
    /// time after: once a pairing has worked, a drop is a reconnection, not a
    /// search, and the two want different words and different advice. Tyler
    /// sat on that message unable to tell whether his pairing was wrong or his
    /// Mac was asleep.
    @Published private(set) var hasEverConnected = false

    /// Retry now instead of waiting out the backoff — for when you know the
    /// Mac just came back and don't want to stare at a spinner.
    func reconnectNow() {
        transport.reconnectNow()
    }

    // MARK: - Commands

    /// Deliver spoken text into a session. Returns true when the daemon took it.
    func inject(sessionId: String, label: String, text: String) async -> Bool {
        let delivered = await post(control: [
            "type": "inject",
            "sessionId": sessionId,
            "label": label,
            "announce": text,
            "eventAt": Date().timeIntervalSince1970 * 1000,
        ])
        if !delivered {
            _ = await reportAppError(
                operation: "message-delivery",
                message: lastError ?? "The daemon did not confirm delivery.",
                sessionId: sessionId
            )
        }
        return delivered
    }

    /// Send one image, in pieces, and get back the path it landed at.
    ///
    /// Chunked because a relay frame caps at 192 KiB. The path comes back rather
    /// than the bytes staying on the phone because Claude Code reads images by
    /// PATH — the agent needs a file on the Mac, not an attachment.
    func uploadImage(data: Data, ext: String) async -> String? {
        let id = ImageUpload.newUploadID()
        let chunks = ImageUpload.chunks(data)
        let total = chunks.count
        guard total > 0 else {
            _ = await reportAppError(
                operation: "image-upload",
                message: "The prepared image had no upload chunks."
            )
            return nil
        }
        // Chunks is a sequence, not an array: each base64 string is created
        // immediately before its request and released before the next one.
        for (index, part) in chunks.enumerated() {
            guard let body = try? JSONSerialization.data(withJSONObject: [
                "uploadId": id,
                "index": index,
                "total": total,
                "extension": ext,
                "data": part,
            ]) else {
                _ = await reportAppError(
                    operation: "image-upload",
                    message: "The phone couldn't encode image chunk \(index + 1) of \(total)."
                )
                return nil
            }
            let response: BridgeResponse
            do {
                response = try await transport.request(authorizedRequest(
                    method: "POST",
                    path: "/image",
                    body: body
                ))
            } catch {
                _ = await reportAppError(
                    operation: "image-upload",
                    message: error.localizedDescription
                )
                return nil
            }
            guard response.status == 200 else {
                _ = await reportAppError(
                    operation: "image-upload",
                    message: "The Mac returned HTTP \(response.status) for chunk \(index + 1) of \(total)."
                )
                return nil
            }
            // The last chunk answers with the path; the others report progress.
            if index == total - 1,
               let decoded = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any],
               let path = decoded["path"] as? String {
                return path
            }
        }
        _ = await reportAppError(
            operation: "image-upload",
            message: "The Mac accepted every image chunk but returned no file path."
        )
        return nil
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

    /// Stop a session mid-turn from the phone.
    ///
    /// This is the control that most needed to exist here rather than on the
    /// Mac: noticing an agent has gone the wrong way, while away from the desk,
    /// used to mean watching it keep going.
    @discardableResult
    func interrupt(sessionId: String, label: String) async -> Bool {
        await post(control: ["type": "interrupt", "sessionId": sessionId, "label": label])
    }

    /// Report what conch is costing this phone. Fire-and-forget: a dropped
    /// sample is worth nothing and must never be retried into the send path
    /// that carries your words.
    @discardableResult
    func reportDevice(_ sample: DeviceSample) async -> Bool {
        guard let encoded = try? JSONEncoder().encode(sample),
              let fields = (try? JSONSerialization.jsonObject(with: encoded)) as? [String: Any]
        else { return false }
        var message: [String: Any] = ["kind": "phone-device"]
        message.merge(fields) { current, _ in current }
        return await post(control: message)
    }

    func send(mode action: String) async -> Bool {
        await post(control: ["type": action, "sessionId": "", "label": "", "announce": ""])
    }

    enum SessionCommand: String {
        case dismiss
        case restore
    }

    enum AgentBackend: String, CaseIterable, Identifiable {
        case claude
        case codex

        var id: String { rawValue }
        var title: String { rawValue.capitalized }
    }

    /// Past sessions the daemon could restart, newest first, filtered by
    /// `query` server-side — the history is over a thousand files, so
    /// filtering belongs next to the reader, not after a full list has
    /// crossed the LAN.
    ///
    /// Returns an empty list rather than surfacing an error: this feeds a
    /// picker that already says "No past sessions found", and a modal error
    /// on top of an empty list would tell you the same thing twice.
    func resumableSessions(query: String) async -> [ResumableSession] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        var message: [String: Any] = ["kind": "resumable"]
        if !trimmed.isEmpty { message["query"] = trimmed }
        guard let reply = await postControlRaw(message),
              let sessions = reply["sessions"] as? [[String: Any]],
              let data = try? JSONSerialization.data(withJSONObject: sessions),
              let decoded = try? JSONDecoder().decode([ResumableSession].self, from: data)
        else {
            _ = await reportAppError(operation: "resumable", message: "Could not read past sessions")
            return []
        }
        return decoded
    }

    /// Process launch belongs to the daemon because doing it from the phone
    /// would bypass the rule that agents never start inside conch's own tmux.
    ///
    /// `cwd` matters only when resuming: a picked session already knows where
    /// it ran, and resuming it anywhere else reopens a conversation about
    /// files that are not there.
    func startSession(backend: AgentBackend, resumeSessionId: String?, cwd: String? = nil) async -> Bool {
        let resumeID = resumeSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var message: [String: Any] = [
            "kind": "session-start",
            "backend": backend.rawValue,
        ]
        if !resumeID.isEmpty {
            message["resumeSessionId"] = resumeID
        }
        if let cwd, !cwd.isEmpty {
            message["cwd"] = cwd
        }
        guard let reply = await postControlRaw(message) else {
            let failure = "The Mac didn't confirm that \(backend.title) started."
            lastError = failure
            _ = await reportAppError(operation: "session-start", message: failure)
            return false
        }
        if reply["kind"] as? String == "session-error",
           let failure = reply["error"] as? String {
            lastError = failure
            _ = await reportAppError(operation: "session-start", message: failure)
            return false
        }
        guard reply["kind"] as? String == "session-started",
              reply["backend"] as? String == backend.rawValue,
              reply["resumed"] as? Bool == !resumeID.isEmpty else {
            let failure = "The Mac didn't confirm that \(backend.title) started."
            lastError = failure
            _ = await reportAppError(operation: "session-start", message: failure)
            return false
        }
        lastError = nil
        return true
    }

    /// There is deliberately no kill fallback: a missing acknowledgement is
    /// cheaper than corrupting the resumable transcript this control protects.
    func closeSession(sessionId: String) async -> Bool {
        guard !sessionId.isEmpty,
              let reply = await postControlRaw([
                  "kind": "session-close",
                  "sessionId": sessionId,
              ]) else {
            let failure = "The Mac didn't confirm a clean session exit."
            lastError = failure
            _ = await reportAppError(
                operation: "session-close",
                message: failure,
                sessionId: sessionId
            )
            return false
        }
        if reply["kind"] as? String == "session-error",
           let failure = reply["error"] as? String {
            lastError = failure
            _ = await reportAppError(
                operation: "session-close",
                message: failure,
                sessionId: sessionId
            )
            return false
        }
        guard reply["kind"] as? String == "session-closed",
              reply["sessionId"] as? String == sessionId else {
            let failure = "The Mac didn't confirm a clean session exit."
            lastError = failure
            _ = await reportAppError(
                operation: "session-close",
                message: failure,
                sessionId: sessionId
            )
            return false
        }
        lastError = nil
        return true
    }

    /// Failures observed only on the phone need durable evidence on the Mac.
    /// Reporting stays best effort and non-recursive because an unavailable
    /// channel is already represented by the phone's connection journal.
    @discardableResult
    func reportAppError(operation: String, message: String, sessionId: String? = nil) async -> Bool {
        var snapshot: [String: Any] = [
            "connected": isConnected,
            "pairedHost": pairedHost,
        ]
        if let state {
            snapshot["publishedAt"] = state.ts
            snapshot["liveState"] = state.live.state
            snapshot["mode"] = ["paused": state.mode.paused, "holding": state.mode.holding]
            snapshot["rowCount"] = state.rows.count
            if let sessionId,
               let row = state.rows.first(where: { $0.id == sessionId }) {
                var rowState: [String: Any] = [
                    "id": row.id,
                    "label": row.label,
                    "status": row.status,
                    "paused": row.paused,
                ]
                if let backend = row.backend { rowState["backend"] = backend }
                if let live = row.live { rowState["live"] = live }
                snapshot["row"] = rowState
            }
        }
        var control: [String: Any] = [
            "kind": "app-error",
            "source": "ios",
            "operation": operation,
            "message": message,
            "at": Date().timeIntervalSince1970 * 1000,
            "state": snapshot,
        ]
        if let sessionId { control["sessionId"] = sessionId }
        guard let reply = await postControlRaw(control) else { return false }
        return reply["kind"] as? String == "app-error-ack"
    }

    /// Hide or restore one ledger row through the daemon's shared session
    /// command contract. The enum keeps arbitrary commands off this convenience
    /// path, and the echoed id/action prevents a mismatched response from being
    /// mistaken for confirmation.
    func send(sessionCommand command: SessionCommand, sessionId: String) async -> Bool {
        guard !sessionId.isEmpty,
              let reply = await postControlRaw([
                  "kind": "session-command",
                  "sessionId": sessionId,
                  "command": command.rawValue,
              ]) else {
            lastError = "Couldn't reach your Mac."
            _ = await reportAppError(
                operation: "session-\(command.rawValue)",
                message: lastError ?? "The session command failed.",
                sessionId: sessionId
            )
            return false
        }
        if let error = reply["error"] as? String {
            lastError = error
            _ = await reportAppError(
                operation: "session-\(command.rawValue)",
                message: error,
                sessionId: sessionId
            )
            return false
        }
        guard reply["kind"] as? String == "session-ack",
              reply["sessionId"] as? String == sessionId,
              reply["command"] as? String == command.rawValue else {
            lastError = "The Mac sent something unexpected."
            _ = await reportAppError(
                operation: "session-\(command.rawValue)",
                message: lastError ?? "The session acknowledgement was invalid.",
                sessionId: sessionId
            )
            return false
        }
        lastError = nil
        return true
    }

    private func post(control message: [String: Any]) async -> Bool {
        guard let body = try? JSONSerialization.data(withJSONObject: message) else {
            lastError = "The phone couldn't encode that request."
            return false
        }
        do {
            let response = try await transport.request(authorizedRequest(
                method: "POST",
                path: "/control",
                body: body
            ))
            guard response.status == 200 else {
                lastError = "The Mac returned HTTP \(response.status)."
                return false
            }
            // Turn-event success is an empty daemon reply. A scoped inject can
            // instead return session-error; do not tell TalkController to erase
            // the user's words when the daemon rejected the target.
            if !response.body.isEmpty,
               let decoded = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any],
               decoded["error"] != nil {
                lastError = decoded["error"] as? String
                return false
            }
            lastError = nil
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
