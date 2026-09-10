import Foundation
import Combine
import Security

/// The local key is opaque, including any #pid suffix. Equal keys on different
/// owners are different selections, drafts and requests.
struct RemoteSessionID: Hashable, Identifiable {
    let ownerDeviceId: String
    let localSessionKey: String
    var id: Self { self }
}

struct RemoteMacPairing: Codable, Identifiable {
    let ownerDeviceId: String
    let endpoint: LANEndpoint
    let token: String
    var id: String { ownerDeviceId }
}

enum RemoteMacPairingStore {
    private static let service = "ai.blueprintstudio.conch.remote-macs"

    private static func query(ownerDeviceId: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: ownerDeviceId]
    }

    static func loadAll() throws -> [RemoteMacPairing] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        try check(status)
        return try (result as? [[String: Any]] ?? []).map { item in
            // The login keychain rejects ReturnData with MatchLimitAll. List
            // accounts first, then read one credential at a time.
            guard let account = item[kSecAttrAccount as String] as? String else {
                throw RemoteMacError.message("A stored Mac pairing has no account.")
            }
            var credentialQuery = self.query(ownerDeviceId: account)
            credentialQuery[kSecReturnData as String] = true
            var credential: CFTypeRef?
            try check(SecItemCopyMatching(credentialQuery as CFDictionary, &credential))
            guard let data = credential as? Data else {
                throw RemoteMacError.message("A stored Mac pairing has no credentials.")
            }
            let pairing = try JSONDecoder().decode(RemoteMacPairing.self, from: data)
            guard !pairing.ownerDeviceId.isEmpty,
                  account == pairing.ownerDeviceId else {
                throw RemoteMacError.message("A stored Mac pairing has an invalid owner.")
            }
            return pairing
        }
    }

    static func save(_ pairing: RemoteMacPairing) throws {
        let key = query(ownerDeviceId: pairing.ownerDeviceId)
        let value = [kSecValueData as String: try JSONEncoder().encode(pairing)]
        let status = SecItemUpdate(key as CFDictionary, value as CFDictionary)
        if status == errSecItemNotFound {
            // Use the Mac login keychain's access rules.
            let add = key.merging(value) { _, new in new }
            try check(SecItemAdd(add as CFDictionary, nil))
        } else { try check(status) }
    }

    static func remove(ownerDeviceId: String) throws {
        let status = SecItemDelete(query(ownerDeviceId: ownerDeviceId) as CFDictionary)
        if status != errSecItemNotFound { try check(status) }
    }

    private static func check(_ status: OSStatus) throws {
        guard status == errSecSuccess else {
            throw RemoteMacError.message("Keychain: \(SecCopyErrorMessageString(status, nil) as String? ?? String(status))")
        }
    }
}

@MainActor
final class RemoteMacStore: ObservableObject {
    @Published private(set) var pairings: [RemoteMacPairing] = []
    /// Complete documents owned by the remote daemon. Never assigned to StateStore.
    @Published private(set) var documents: [String: PublishedState] = [:]
    @Published private(set) var issues: [String: String] = [:]
    @Published private(set) var online: Set<String> = []
    @Published var pairingError: String?
    @Published var drafts: [RemoteSessionID: String] = [:]
    private var transports: [String: DirectHTTPTransport] = [:]

    init() {
        do {
            pairings = try RemoteMacPairingStore.loadAll().sorted { $0.endpoint.title < $1.endpoint.title }
            for pairing in pairings { connect(pairing) }
        } catch { pairingError = error.localizedDescription }
    }

    func pair(host: String, port: String, code: String, localOwner: String) async throws {
        let endpoint = try LANEndpoint(host: host, port: port)
        guard code.count == 6, code.utf8.allSatisfy({ (48...57).contains($0) }) else {
            throw RemoteMacError.message("Enter the six-digit code from the other Mac’s Phone app tab.")
        }
        let unauthenticated = DirectHTTPTransport(endpoint: endpoint, token: "")
        defer { unauthenticated.stop() }
        let body = try JSONSerialization.data(withJSONObject: ["code": code])
        let response = try await unauthenticated.request(BridgeRequest(method: "POST", path: "/pair", body: body))
        try response.requireSuccess()
        struct Redeemed: Decodable { let token: String }
        let token = try JSONDecoder().decode(Redeemed.self, from: response.body).token
        guard !token.isEmpty else { throw RemoteMacError.message("The Mac returned an empty token.") }
        let authenticated = DirectHTTPTransport(endpoint: endpoint, token: token)
        defer { authenticated.stop() }
        let snapshot = try await authenticated.request(BridgeRequest(method: "GET", path: "/state"))
        try snapshot.requireSuccess()
        let document = try JSONDecoder().decode(PublishedState.self, from: snapshot.body)
        guard !document.ownerDeviceId.isEmpty else {
            throw RemoteMacError.message("Update the other Mac’s daemon: it does not publish a device identity yet.")
        }
        guard document.ownerDeviceId != localOwner else {
            throw RemoteMacError.message("That is this Mac. Enter the other Mac’s host.")
        }
        let pairing = RemoteMacPairing(ownerDeviceId: document.ownerDeviceId, endpoint: endpoint, token: token)
        try RemoteMacPairingStore.save(pairing)
        pairings.removeAll { $0.ownerDeviceId == pairing.ownerDeviceId }
        pairings.append(pairing)
        pairings.sort { $0.endpoint.title < $1.endpoint.title }
        documents[pairing.ownerDeviceId] = document
        pairingError = nil
        connect(pairing)
    }

    func remove(_ pairing: RemoteMacPairing) {
        do {
            try RemoteMacPairingStore.remove(ownerDeviceId: pairing.ownerDeviceId)
            transports.removeValue(forKey: pairing.ownerDeviceId)?.stop()
            documents.removeValue(forKey: pairing.ownerDeviceId)
            issues.removeValue(forKey: pairing.ownerDeviceId)
            online.remove(pairing.ownerDeviceId)
            drafts = drafts.filter { $0.key.ownerDeviceId != pairing.ownerDeviceId }
            pairings.removeAll { $0.ownerDeviceId == pairing.ownerDeviceId }
            pairingError = nil
        } catch { pairingError = error.localizedDescription }
    }

    func row(for target: RemoteSessionID) -> SessionRow? {
        documents[target.ownerDeviceId]?.rows.first { $0.id == target.localSessionKey }
    }

    func conversation(for target: RemoteSessionID) -> Conversation? {
        let document = documents[target.ownerDeviceId]
        return document?.conversations?[target.localSessionKey]
            ?? document?.conversation.flatMap { $0.sessionId == target.localSessionKey ? $0 : nil }
    }

    func reply(for target: RemoteSessionID) async throws -> String {
        let transport = try transport(for: target)
        var parts = URLComponents()
        parts.path = "/reply"
        parts.queryItems = [URLQueryItem(name: "session", value: target.localSessionKey)]
        let response = try await transport.request(BridgeRequest(method: "GET", path: parts.string!))
        try response.requireSuccess()
        try requireCurrent(transport, target: target)
        struct Reply: Decodable { let markdown: String }
        return try JSONDecoder().decode(Reply.self, from: response.body).markdown
    }

    func send(_ text: String, to target: RemoteSessionID) async throws -> String {
        let transport = try transport(for: target)
        guard let row = row(for: target), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw RemoteMacError.message("Select a current session and enter some text.")
        }
        let body: [String: Any] = ["type": "inject", "sessionId": target.localSessionKey,
                                   "label": row.label, "announce": text]
        let envelope: [String: Any] = ["kind": "control-envelope", "ownerDeviceId": target.ownerDeviceId, "body": body]
        let response = try await transport.request(BridgeRequest(method: "POST", path: "/control",
            body: try JSONSerialization.data(withJSONObject: envelope)))
        try response.requireSuccess()
        try requireCurrent(transport, target: target)
        guard let responseText = String(data: response.body, encoding: .utf8) else {
            throw RemoteMacError.message("The Mac returned an invalid control response.")
        }
        let reply = responseText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !reply.isEmpty {
            struct Refusal: Decodable { let kind: String; let error: String?; let code: String? }
            if let refusal = try? JSONDecoder().decode(Refusal.self, from: response.body),
               refusal.kind == "routing-error" || refusal.kind == "session-error" {
                throw RemoteMacError.message("\(refusal.kind): \(refusal.error ?? refusal.code ?? "Refused")")
            }
            throw RemoteMacError.message("The Mac returned an unexpected control response.")
        }
        return "Accepted by \(pairings.first { $0.id == target.ownerDeviceId }?.endpoint.title ?? "the owner")"
    }

    func download(_ path: String, for target: RemoteSessionID) async throws -> URL {
        let transport = try transport(for: target)
        let url = try await transport.download(path: path)
        do { try requireCurrent(transport, target: target); return url }
        catch { try? FileManager.default.removeItem(at: url); throw error }
    }

    private func transport(for target: RemoteSessionID) throws -> DirectHTTPTransport {
        guard let transport = transports[target.ownerDeviceId], row(for: target) != nil else {
            throw RemoteMacError.message("This remote session is no longer published.")
        }
        return transport
    }

    private func requireCurrent(_ transport: DirectHTTPTransport, target: RemoteSessionID) throws {
        guard transports[target.ownerDeviceId] === transport else {
            throw RemoteMacError.message("This Mac pairing changed while the request was in progress.")
        }
    }

    private func connect(_ pairing: RemoteMacPairing) {
        let ownerDeviceId = pairing.ownerDeviceId
        transports[ownerDeviceId]?.stop()
        online.remove(ownerDeviceId)
        let transport = DirectHTTPTransport(endpoint: pairing.endpoint, token: pairing.token)
        transports[ownerDeviceId] = transport
        transport.onStateData = { [weak self, weak transport] data in
            guard let self, let transport, transports[ownerDeviceId] === transport else { return }
            do {
                let document = try JSONDecoder().decode(PublishedState.self, from: data)
                guard document.ownerDeviceId == ownerDeviceId else {
                    // Never re-tag a document returned by a different daemon at
                    // a reused LAN address. Re-pair explicitly to learn its owner.
                    transport.stop()
                    throw RemoteMacError.message("The host’s device identity changed. Remove it and pair again.")
                }
                documents[ownerDeviceId] = document
                issues.removeValue(forKey: ownerDeviceId)
                online.insert(ownerDeviceId)
            } catch {
                online.remove(ownerDeviceId)
                issues[ownerDeviceId] = error.localizedDescription
            }
        }
        transport.onConnectionChange = { [weak self, weak transport] connected, message in
            guard let self, let transport, transports[ownerDeviceId] === transport else { return }
            if !connected {
                online.remove(ownerDeviceId)
                issues[ownerDeviceId] = message ?? "Offline — showing last known sessions"
            }
        }
        transport.start()
    }
}
