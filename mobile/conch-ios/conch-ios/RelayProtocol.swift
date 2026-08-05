import CryptoKit
import Foundation
import Security

/// Wire-level limits for the untrusted relay transport. The WebSocket adapter
/// must reject an oversized message before passing it to `RelayFrameOpener`.
enum RelayProtocolLimits {
    static let maximumPairingCodeBytes = 4 * 1024
    static let maximumPlaintextBodyBytes = 128 * 1024
    static let maximumEncryptedFrameBytes = 192 * 1024
    static let maximumFramesPerKey = 262_144
}

enum RelayProtocolError: Error, LocalizedError, Equatable {
    case malformedPairing(String)
    case invalidBase64URL
    case randomGenerationFailed
    case invalidPeer
    case invalidFrame
    case frameTooLarge
    case replayedFrame
    case keyExpired

    var errorDescription: String? {
        switch self {
        case let .malformedPairing(reason): reason
        case .invalidBase64URL: "The relay pairing contains invalid base64url data."
        case .randomGenerationFailed: "Secure random generation failed."
        case .invalidPeer: "The relay handshake did not come from the expected peer."
        case .invalidFrame: "The relay sent a malformed or unauthenticated frame."
        case .frameTooLarge: "The relay frame exceeded the protocol limit."
        case .replayedFrame: "The relay replayed an already accepted frame."
        case .keyExpired: "The relay session must be rekeyed."
        }
    }
}

/// Strict, canonical base64url. Padding is deliberately omitted on the wire.
enum RelayBase64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ encoded: String, maximumEncodedBytes: Int = 256 * 1024) throws -> Data {
        guard !encoded.isEmpty,
              encoded.utf8.count <= maximumEncodedBytes,
              encoded.utf8.allSatisfy({
                  ($0 >= 65 && $0 <= 90)
                      || ($0 >= 97 && $0 <= 122)
                      || ($0 >= 48 && $0 <= 57)
                      || $0 == 45
                      || $0 == 95
              }),
              encoded.count % 4 != 1 else {
            throw RelayProtocolError.invalidBase64URL
        }
        var standard = encoded
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        standard.append(String(repeating: "=", count: (4 - standard.count % 4) % 4))
        guard let data = Data(base64Encoded: standard), encode(data) == encoded else {
            throw RelayProtocolError.invalidBase64URL
        }
        return data
    }
}

/// Everything needed to select the relay transport. This blob is secret
/// because it includes the root key; it belongs in the Keychain, never in
/// UserDefaults or logs.
struct RelayPairingPayload: Codable, Equatable, Sendable {
    static let currentVersion = 1
    static let codePrefix = "conch-relay-v1:"

    let version: Int
    let endpoint: String
    let roomId: String
    let secret: String

    private enum CodingKeys: String, CodingKey {
        case version
        case endpoint
        case roomId
        case secret
    }

    init(endpoint: String, roomId: String, secret: String) throws {
        try self.init(
            version: Self.currentVersion,
            endpoint: endpoint,
            roomId: roomId,
            secret: secret
        )
    }

    private init(version: Int, endpoint: String, roomId: String, secret: String) throws {
        guard version == Self.currentVersion else {
            throw RelayProtocolError.malformedPairing("This relay pairing uses an unsupported version.")
        }
        guard endpoint.utf8.count <= 2_048,
              let url = URL(string: endpoint),
              url.scheme?.lowercased() == "wss",
              url.host != nil,
              url.user == nil,
              url.password == nil,
              url.fragment == nil else {
            throw RelayProtocolError.malformedPairing("The relay endpoint must be a valid wss URL.")
        }
        let room = try RelayBase64URL.decode(roomId, maximumEncodedBytes: 128)
        guard room.count >= 16, room.count <= 64 else {
            throw RelayProtocolError.malformedPairing("The relay room ID must contain 128 to 512 bits.")
        }
        let key = try RelayBase64URL.decode(secret, maximumEncodedBytes: 128)
        guard key.count == 32 else {
            throw RelayProtocolError.malformedPairing("The relay secret must contain exactly 256 bits.")
        }
        self.version = version
        self.endpoint = endpoint
        self.roomId = roomId
        self.secret = secret
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            version: values.decode(Int.self, forKey: .version),
            endpoint: values.decode(String.self, forKey: .endpoint),
            roomId: values.decode(String.self, forKey: .roomId),
            secret: values.decode(String.self, forKey: .secret)
        )
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(version, forKey: .version)
        try values.encode(endpoint, forKey: .endpoint)
        try values.encode(roomId, forKey: .roomId)
        try values.encode(secret, forKey: .secret)
    }

    var endpointURL: URL { URL(string: endpoint)! }
    var roomData: Data { try! RelayBase64URL.decode(roomId) }
    var secretData: Data { try! RelayBase64URL.decode(secret) }

    func pairingCode() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return Self.codePrefix + RelayBase64URL.encode(try encoder.encode(self))
    }

    static func decodePairingCode(_ code: String) throws -> Self {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf8.count <= RelayProtocolLimits.maximumPairingCodeBytes,
              trimmed.hasPrefix(codePrefix) else {
            throw RelayProtocolError.malformedPairing("That is not a conch relay pairing code.")
        }
        let encoded = String(trimmed.dropFirst(codePrefix.count))
        let data = try RelayBase64URL.decode(
            encoded,
            maximumEncodedBytes: RelayProtocolLimits.maximumPairingCodeBytes
        )
        do {
            return try JSONDecoder().decode(Self.self, from: data)
        } catch let error as RelayProtocolError {
            throw error
        } catch {
            throw RelayProtocolError.malformedPairing("The relay pairing code is malformed.")
        }
    }
}

enum RelayRole: String, Codable, Sendable {
    case phone
    case mac

    var peer: Self { self == .phone ? .mac : .phone }
    var outgoingDirection: RelayDirection { self == .phone ? .phoneToMac : .macToPhone }
    var incomingDirection: RelayDirection { self == .phone ? .macToPhone : .phoneToMac }
}

enum RelayDirection: String, Codable, Sendable {
    case phoneToMac = "phone-to-mac"
    case macToPhone = "mac-to-phone"
}

/// A challenge is sent only inside a root-key-encrypted handshake frame. Both
/// peers contribute fresh randomness, so recorded application frames from an
/// earlier connection cannot authenticate after reconnect.
struct RelayHandshakeHello: Codable, Equatable, Sendable {
    static let challengeBytes = 32

    let version: Int
    let role: RelayRole
    let challenge: String

    init(role: RelayRole) throws {
        self.version = RelayPairingPayload.currentVersion
        self.role = role
        self.challenge = RelayBase64URL.encode(try RelayRandom.bytes(count: Self.challengeBytes))
    }

    init(role: RelayRole, challenge: Data) throws {
        guard challenge.count == Self.challengeBytes else {
            throw RelayProtocolError.invalidPeer
        }
        self.version = RelayPairingPayload.currentVersion
        self.role = role
        self.challenge = RelayBase64URL.encode(challenge)
    }

    var challengeData: Data {
        get throws {
            guard version == RelayPairingPayload.currentVersion else {
                throw RelayProtocolError.invalidPeer
            }
            let decoded = try RelayBase64URL.decode(challenge, maximumEncodedBytes: 64)
            guard decoded.count == Self.challengeBytes else {
                throw RelayProtocolError.invalidPeer
            }
            return decoded
        }
    }
}

struct RelayDirectionalKeys {
    let header: SymmetricKey
    let body: SymmetricKey
}

struct RelaySessionKeys {
    let phoneToMac: RelayDirectionalKeys
    let macToPhone: RelayDirectionalKeys

    func outgoing(for role: RelayRole) -> RelayDirectionalKeys {
        role == .phone ? phoneToMac : macToPhone
    }

    func incoming(for role: RelayRole) -> RelayDirectionalKeys {
        role == .phone ? macToPhone : phoneToMac
    }
}

enum RelayKeySchedule {
    /// Long-lived keys are used only to authenticate and encrypt handshake
    /// hellos. Application data always uses fresh per-connection session keys.
    static func handshakeKeys(for pairing: RelayPairingPayload) -> RelaySessionKeys {
        deriveKeys(
            secret: pairing.secretData,
            saltParts: [Data("conch-relay/handshake-salt/v1".utf8), pairing.roomData],
            phase: "handshake"
        )
    }

    static func sessionKeys(
        for pairing: RelayPairingPayload,
        local: RelayHandshakeHello,
        remote: RelayHandshakeHello
    ) throws -> RelaySessionKeys {
        guard local.role != remote.role, remote.role == local.role.peer else {
            throw RelayProtocolError.invalidPeer
        }
        let phone = local.role == .phone ? local : remote
        let mac = local.role == .mac ? local : remote
        return deriveKeys(
            secret: pairing.secretData,
            saltParts: [
                Data("conch-relay/session-salt/v1".utf8),
                pairing.roomData,
                try phone.challengeData,
                try mac.challengeData,
            ],
            phase: "session"
        )
    }

    private static func deriveKeys(
        secret: Data,
        saltParts: [Data],
        phase: String
    ) -> RelaySessionKeys {
        let salt = Data(SHA256.hash(data: RelayCanonical.lengthPrefixed(saltParts)))
        let input = SymmetricKey(data: secret)
        func key(_ purpose: String) -> SymmetricKey {
            HKDF<SHA256>.deriveKey(
                inputKeyMaterial: input,
                salt: salt,
                info: Data("conch-relay/\(phase)/\(purpose)/v1".utf8),
                outputByteCount: 32
            )
        }
        return RelaySessionKeys(
            phoneToMac: RelayDirectionalKeys(
                header: key("phone-to-mac/header"),
                body: key("phone-to-mac/body")
            ),
            macToPhone: RelayDirectionalKeys(
                header: key("mac-to-phone/header"),
                body: key("mac-to-phone/body")
            )
        )
    }
}

enum RelayFrameKind: String, Codable, Sendable {
    case hello
    case request
    case responseHead = "response-head"
    case responseChunk = "response-chunk"
    case responseEnd = "response-end"
    case chunkAck = "chunk-ack"
    case cancel
    case ping
    case pong
}

/// This header is encrypted separately so the Durable Object does not learn
/// request IDs, methods, frame kinds, or ordering. Once decrypted, the exact
/// values are also authenticated as the body seal's AAD.
struct RelayFrameHeader: Codable, Equatable, Sendable {
    let version: Int
    let id: String
    let method: String
    let sequence: UInt64
    let kind: RelayFrameKind
    let direction: RelayDirection

    init(
        id: String,
        method: String,
        sequence: UInt64,
        kind: RelayFrameKind,
        direction: RelayDirection
    ) throws {
        guard id.utf8.count >= 8,
              id.utf8.count <= 128,
              id.utf8.allSatisfy({
                  ($0 >= 65 && $0 <= 90)
                      || ($0 >= 97 && $0 <= 122)
                      || ($0 >= 48 && $0 <= 57)
                      || $0 == 45
                      || $0 == 95
              }) else {
            throw RelayProtocolError.invalidFrame
        }
        let canonicalMethod = method.uppercased()
        guard canonicalMethod == method,
              method.utf8.count >= 3,
              method.utf8.count <= 16,
              method.utf8.allSatisfy({ $0 >= 65 && $0 <= 90 }) else {
            throw RelayProtocolError.invalidFrame
        }
        self.version = RelayPairingPayload.currentVersion
        self.id = id
        self.method = method
        self.sequence = sequence
        self.kind = kind
        self.direction = direction
    }

    func validated(for expectedDirection: RelayDirection) throws -> Self {
        guard version == RelayPairingPayload.currentVersion,
              direction == expectedDirection else {
            throw RelayProtocolError.invalidFrame
        }
        return try Self(
            id: id,
            method: method,
            sequence: sequence,
            kind: kind,
            direction: direction
        )
    }
}

/// The Durable Object sees only a version, two random nonces, and two opaque
/// ciphertexts. AES-GCM tags are appended to their ciphertexts before encoding.
struct RelayEncryptedFrame: Codable, Equatable, Sendable {
    let version: Int
    let headerNonce: String
    let headerCiphertext: String
    let bodyNonce: String
    let bodyCiphertext: String
}

struct RelayOpenedFrame: Equatable, Sendable {
    let header: RelayFrameHeader
    let body: Data
}

/// A 64-frame sliding replay window accepts modest network reordering but never
/// accepts the same sequence twice. Frames older than the window are dropped.
struct RelayReplayWindow: Sendable {
    private var highest: UInt64?
    private var seen: UInt64 = 0

    mutating func accept(_ sequence: UInt64) -> Bool {
        guard let highest else {
            self.highest = sequence
            seen = 1
            return true
        }
        if sequence > highest {
            let advance = sequence - highest
            seen = advance >= 64 ? 1 : (seen << advance) | 1
            self.highest = sequence
            return true
        }
        let age = highest - sequence
        guard age < 64 else { return false }
        let bit = UInt64(1) << age
        guard seen & bit == 0 else { return false }
        seen |= bit
        return true
    }
}

/// Thread-safe outbound half of the framed channel. Random nonces are checked
/// against every nonce emitted under the same key and the key is retired at a
/// bounded frame count rather than allowing the uniqueness set to grow forever.
final class RelayFrameSealer: @unchecked Sendable {
    private let keys: RelayDirectionalKeys
    private let direction: RelayDirection
    private let lock = NSLock()
    private var nextSequence: UInt64 = 0
    /// Header and body use different keys, but retaining one combined set also
    /// satisfies the stricter wire invariant that a nonce never repeats at all.
    private var usedNonces = Set<RelayNonceIdentity>()

    init(keys: RelayDirectionalKeys, direction: RelayDirection) {
        self.keys = keys
        self.direction = direction
    }

    func seal(id: String, method: String, kind: RelayFrameKind, body: Data) throws -> Data {
        guard body.count <= RelayProtocolLimits.maximumPlaintextBodyBytes else {
            throw RelayProtocolError.frameTooLarge
        }
        lock.lock()
        defer { lock.unlock() }
        guard nextSequence < UInt64(RelayProtocolLimits.maximumFramesPerKey) else {
            throw RelayProtocolError.keyExpired
        }
        let sequence = nextSequence
        nextSequence += 1
        let header = try RelayFrameHeader(
            id: id,
            method: method,
            sequence: sequence,
            kind: kind,
            direction: direction
        )
        let headerNonceData = try uniqueNonce(in: &usedNonces)
        let bodyNonceData = try uniqueNonce(in: &usedNonces)
        return try Self.seal(
            header: header,
            body: body,
            keys: keys,
            headerNonceData: headerNonceData,
            bodyNonceData: bodyNonceData
        )
    }

    private func uniqueNonce(in used: inout Set<RelayNonceIdentity>) throws -> Data {
        for _ in 0..<16 {
            let candidate = try RelayRandom.bytes(count: 12)
            if used.insert(RelayNonceIdentity(candidate)).inserted { return candidate }
        }
        throw RelayProtocolError.randomGenerationFailed
    }

    /// Kept internal so Swift/WebCrypto interoperability tests can seal a fixed
    /// vector without weakening production nonce generation.
    static func seal(
        header: RelayFrameHeader,
        body: Data,
        keys: RelayDirectionalKeys,
        headerNonceData: Data,
        bodyNonceData: Data
    ) throws -> Data {
        guard body.count <= RelayProtocolLimits.maximumPlaintextBodyBytes,
              headerNonceData.count == 12,
              bodyNonceData.count == 12 else {
            throw RelayProtocolError.invalidFrame
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let headerPlaintext = try encoder.encode(header)
        let headerNonce = try AES.GCM.Nonce(data: headerNonceData)
        let bodyNonce = try AES.GCM.Nonce(data: bodyNonceData)
        let sealedHeader = try AES.GCM.seal(
            headerPlaintext,
            using: keys.header,
            nonce: headerNonce,
            authenticating: RelayCanonical.headerAAD(direction: header.direction)
        )
        let sealedBody = try AES.GCM.seal(
            body,
            using: keys.body,
            nonce: bodyNonce,
            authenticating: RelayCanonical.bodyAAD(header: header)
        )
        let frame = RelayEncryptedFrame(
            version: RelayPairingPayload.currentVersion,
            headerNonce: RelayBase64URL.encode(headerNonceData),
            headerCiphertext: RelayBase64URL.encode(sealedHeader.ciphertext + sealedHeader.tag),
            bodyNonce: RelayBase64URL.encode(bodyNonceData),
            bodyCiphertext: RelayBase64URL.encode(sealedBody.ciphertext + sealedBody.tag)
        )
        let wire = try encoder.encode(frame)
        guard wire.count <= RelayProtocolLimits.maximumEncryptedFrameBytes else {
            throw RelayProtocolError.frameTooLarge
        }
        return wire
    }
}

/// Thread-safe inbound half. A sequence is marked accepted only after both GCM
/// tags verify, so corrupt traffic cannot burn legitimate sequence numbers.
final class RelayFrameOpener: @unchecked Sendable {
    private let keys: RelayDirectionalKeys
    private let direction: RelayDirection
    private let lock = NSLock()
    private var replay = RelayReplayWindow()

    init(keys: RelayDirectionalKeys, direction: RelayDirection) {
        self.keys = keys
        self.direction = direction
    }

    func open(_ wire: Data) throws -> RelayOpenedFrame {
        guard wire.count <= RelayProtocolLimits.maximumEncryptedFrameBytes else {
            throw RelayProtocolError.frameTooLarge
        }
        let encrypted: RelayEncryptedFrame
        do {
            encrypted = try JSONDecoder().decode(RelayEncryptedFrame.self, from: wire)
        } catch {
            throw RelayProtocolError.invalidFrame
        }
        guard encrypted.version == RelayPairingPayload.currentVersion else {
            throw RelayProtocolError.invalidFrame
        }
        do {
            let headerNonceData = try RelayBase64URL.decode(encrypted.headerNonce, maximumEncodedBytes: 32)
            let bodyNonceData = try RelayBase64URL.decode(encrypted.bodyNonce, maximumEncodedBytes: 32)
            let sealedHeader = try RelayBase64URL.decode(
                encrypted.headerCiphertext,
                maximumEncodedBytes: RelayProtocolLimits.maximumEncryptedFrameBytes
            )
            let sealedBody = try RelayBase64URL.decode(
                encrypted.bodyCiphertext,
                maximumEncodedBytes: RelayProtocolLimits.maximumEncryptedFrameBytes
            )
            guard headerNonceData.count == 12,
                  bodyNonceData.count == 12,
                  sealedHeader.count >= 16,
                  sealedBody.count >= 16 else {
                throw RelayProtocolError.invalidFrame
            }
            let headerPlaintext = try AES.GCM.open(
                Self.box(sealedHeader, nonce: headerNonceData),
                using: keys.header,
                authenticating: RelayCanonical.headerAAD(direction: direction)
            )
            let decoded = try JSONDecoder().decode(RelayFrameHeader.self, from: headerPlaintext)
            let header = try decoded.validated(for: direction)
            let body = try AES.GCM.open(
                Self.box(sealedBody, nonce: bodyNonceData),
                using: keys.body,
                authenticating: RelayCanonical.bodyAAD(header: header)
            )
            lock.lock()
            let accepted = replay.accept(header.sequence)
            lock.unlock()
            guard accepted else { throw RelayProtocolError.replayedFrame }
            return RelayOpenedFrame(header: header, body: body)
        } catch let error as RelayProtocolError {
            throw error
        } catch {
            throw RelayProtocolError.invalidFrame
        }
    }

    private static func box(_ combined: Data, nonce: Data) throws -> AES.GCM.SealedBox {
        let tagStart = combined.count - 16
        return try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonce),
            ciphertext: combined[..<tagStart],
            tag: combined[tagStart...]
        )
    }
}

struct RelaySessionCrypto {
    let sealer: RelayFrameSealer
    let opener: RelayFrameOpener

    init(role: RelayRole, keys: RelaySessionKeys) {
        sealer = RelayFrameSealer(keys: keys.outgoing(for: role), direction: role.outgoingDirection)
        opener = RelayFrameOpener(keys: keys.incoming(for: role), direction: role.incomingDirection)
    }
}

/// Connection handshake state. `sealedHello()` may be called repeatedly while
/// the relay has no peer; it keeps one local challenge but emits a fresh
/// sequence and two fresh nonces every time. Only an authenticated opposite-role
/// hello can produce application session keys.
final class RelayHandshakeCrypto: @unchecked Sendable {
    let localHello: RelayHandshakeHello

    private let role: RelayRole
    private let pairing: RelayPairingPayload
    private let handshakeKeys: RelaySessionKeys
    private let channel: RelaySessionCrypto

    init(pairing: RelayPairingPayload, role: RelayRole) throws {
        self.role = role
        self.pairing = pairing
        self.localHello = try RelayHandshakeHello(role: role)
        self.handshakeKeys = RelayKeySchedule.handshakeKeys(for: pairing)
        self.channel = RelaySessionCrypto(
            role: role,
            keys: handshakeKeys
        )
    }

    func sealedHello() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try channel.sealer.seal(
            id: "hello-\(role.rawValue)",
            method: "HELLO",
            kind: .hello,
            body: encoder.encode(localHello)
        )
    }

    func openPeerHello(_ wire: Data) throws -> RelayHandshakeHello {
        // Hello frames deliberately repeat while one peer is absent. Use a
        // fresh opener so a newly restarted Mac (whose persistent handshake
        // sender starts at sequence zero) can replace the current peer. Fresh
        // application challenges supply rollback protection across restarts.
        let opened = try RelayFrameOpener(
            keys: handshakeKeys.incoming(for: role),
            direction: role.incomingDirection
        ).open(wire)
        guard opened.header.id == "hello-\(role.peer.rawValue)",
              opened.header.method == "HELLO",
              opened.header.kind == .hello,
              let hello = try? JSONDecoder().decode(RelayHandshakeHello.self, from: opened.body),
              hello.version == RelayPairingPayload.currentVersion,
              hello.role == role.peer,
              (try? hello.challengeData) != nil else {
            throw RelayProtocolError.invalidPeer
        }
        return hello
    }

    func sessionCrypto(with remote: RelayHandshakeHello) throws -> RelaySessionCrypto {
        RelaySessionCrypto(
            role: role,
            keys: try RelayKeySchedule.sessionKeys(
                for: pairing,
                local: localHello,
                remote: remote
            )
        )
    }
}

/// Fixed WebCrypto/CryptoKit interoperability vector. The Bun implementation
/// owns the same values; `verify()` catches changes to HKDF labels, canonical
/// AAD, sorted header JSON, AES-GCM tag layout, or base64url encoding.
enum RelayProtocolTestVector {
    static let secret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    static let roomId = "ICEiIyQlJicoKSorLC0uLw"
    static let phoneChallenge = "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8"
    static let macChallenge = "YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8"
    static let sessionSaltHex = "f22720c68d85fbcb4f5957a05372faf65c85d7af2ca11774a532b6356d571b31"
    static let phoneToMacHeaderKeyHex = "822d0103f57bcc00ef5f718e1e00001da3f6894cd530d9c0749f38821c480107"
    static let phoneToMacBodyKeyHex = "47bcc2fc6eb7f2c0071758c421d78b42fb6cb2f7a65e2bd94125e237610c302a"
    static let headerNonce = "oKGio6Slpqeoqaqr"
    static let bodyNonce = "sLGys7S1tre4ubq7"
    static let expectedWire = #"{"bodyCiphertext":"oaYwB6ppag25-if4bxIpkrqL88iNgRlvwZs0-vfp6OrF","bodyNonce":"sLGys7S1tre4ubq7","headerCiphertext":"wlqsTUh-8xW_dhomEex9JX-kCocgjMpuk-TiHLSrelas-piXleO6XZc6ujzHrxifojmXn9RPQYFop-IO3Z0-ODVgOAwLtmm1G2FJmtYfNNxm_4moJ8zS_5OXeNjVWcMQQ9bGdAE--QrW9YkBcLf6x3AB-hTXoRBORdQDQO0","headerNonce":"oKGio6Slpqeoqaqr","version":1}"#

    static func verify() throws -> Bool {
        let pairing = try RelayPairingPayload(
            endpoint: "wss://relay.example.invalid/connect",
            roomId: roomId,
            secret: secret
        )
        let phone = try RelayHandshakeHello(
            role: .phone,
            challenge: RelayBase64URL.decode(phoneChallenge)
        )
        let mac = try RelayHandshakeHello(
            role: .mac,
            challenge: RelayBase64URL.decode(macChallenge)
        )
        let keys = try RelayKeySchedule.sessionKeys(for: pairing, local: phone, remote: mac)
        let header = try RelayFrameHeader(
            id: "vector-00000001",
            method: "POST",
            sequence: 7,
            kind: .request,
            direction: .phoneToMac
        )
        let body = Data(#"{"path":"/state"}"#.utf8)
        let wire = try RelayFrameSealer.seal(
            header: header,
            body: body,
            keys: keys.phoneToMac,
            headerNonceData: RelayBase64URL.decode(headerNonce),
            bodyNonceData: RelayBase64URL.decode(bodyNonce)
        )
        guard String(data: wire, encoding: .utf8) == expectedWire else { return false }
        let opener = RelayFrameOpener(keys: keys.phoneToMac, direction: .phoneToMac)
        let opened = try opener.open(wire)
        guard opened.header == header, opened.body == body else { return false }
        do {
            _ = try opener.open(wire)
            return false
        } catch RelayProtocolError.replayedFrame {
            return true
        }
    }
}

private enum RelayRandom {
    static func bytes(count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw RelayProtocolError.randomGenerationFailed
        }
        return Data(bytes)
    }
}

private struct RelayNonceIdentity: Hashable {
    private let high: UInt64
    private let low: UInt32

    init(_ data: Data) {
        let bytes = [UInt8](data)
        high = bytes.prefix(8).reduce(0) { ($0 << 8) | UInt64($1) }
        low = bytes.suffix(4).reduce(0) { ($0 << 8) | UInt32($1) }
    }
}

private enum RelayCanonical {
    static func lengthPrefixed(_ values: [Data]) -> Data {
        var result = Data()
        for value in values {
            appendUInt32(UInt32(value.count), to: &result)
            result.append(value)
        }
        return result
    }

    static func headerAAD(direction: RelayDirection) -> Data {
        lengthPrefixed([
            Data("conch-relay/header-aad/v1".utf8),
            Data(direction.rawValue.utf8),
        ])
    }

    static func bodyAAD(header: RelayFrameHeader) -> Data {
        var result = lengthPrefixed([
            Data("conch-relay/body-aad/v1".utf8),
            Data(header.direction.rawValue.utf8),
            Data(header.id.utf8),
            Data(header.method.utf8),
            Data(header.kind.rawValue.utf8),
        ])
        appendUInt64(header.sequence, to: &result)
        return result
    }

    private static func appendUInt32(_ value: UInt32, to data: inout Data) {
        data.append(UInt8((value >> 24) & 0xff))
        data.append(UInt8((value >> 16) & 0xff))
        data.append(UInt8((value >> 8) & 0xff))
        data.append(UInt8(value & 0xff))
    }

    private static func appendUInt64(_ value: UInt64, to data: inout Data) {
        for shift in stride(from: 56, through: 0, by: -8) {
            data.append(UInt8((value >> UInt64(shift)) & 0xff))
        }
    }
}
