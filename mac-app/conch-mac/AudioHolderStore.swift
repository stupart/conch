import Combine
import Foundation

/// C9b Cut B — this Mac's side of "one voice across two Macs".
///
/// Take it: `audio-take` on the local daemon, then `audio-yield` to every
/// paired Mac with `revision = that Mac's published revision + 1` and a 90 s
/// lease, renewed every 30 s while THIS daemon is still local. Each yielded
/// Mac's outbox is forwarded to the local daemon once per `(ownerDeviceId,
/// seq)`; a `held` answer is retried on the renewal tick. Grants are released
/// when a pairing is removed and, fire-and-forget, when the app quits.
///
/// Reads `StateStore` for the local record and `RemoteMacStore` for peer
/// documents; neither store knows this one exists.
@MainActor
final class AudioHolderStore: ObservableObject {
    struct Grant: Equatable {
        var revision: Int
    }

    static let leaseMs = 90_000
    static let renewSeconds: Double = 30

    /// Host of the Mac holding this Mac's audio; nil while local.
    @Published private(set) var controlledBy: String?
    /// Hosts of ONLINE peers whose own document says this Mac holds their audio.
    @Published private(set) var silentHosts: [String] = []
    /// Hosts of ONLINE peers this Mac does not hold — the first Take it starts here.
    @Published private(set) var takeableHosts: [String] = []
    @Published private(set) var grants: [String: Grant] = [:]
    @Published var message: String?

    private let socket = ConchSocketClient()
    private var localState: PublishedState?
    private var pairings: [RemoteMacPairing] = []
    private var documents: [String: PublishedState] = [:]
    private var online: Set<String> = []
    private var transports: [String: DirectHTTPTransport] = [:]
    /// Admitted or dropped by the local daemon: never sent again.
    private var forwarded: Set<String> = []
    /// Answered `held`, unreachable, or still in flight: retried on the renewal tick.
    private var held: [String: (owner: String, item: AudioOutboxItem)] = [:]
    private var yielding: Set<String> = []
    private var renewTask: Task<Void, Never>?
    private var subscriptions: Set<AnyCancellable> = []

    private var localOwner: String { localState?.ownerDeviceId ?? "" }

    init(local: StateStore, remotes: RemoteMacStore) {
        // `@Published` fires on willSet, so every sink reads its parameter and
        // never the store's property, which still holds the previous value.
        local.$state.sink { [weak self] in self?.localChanged($0) }.store(in: &subscriptions)
        remotes.$pairings.sink { [weak self] in self?.pairingsChanged($0) }.store(in: &subscriptions)
        remotes.$documents.sink { [weak self] in self?.documentsChanged($0) }.store(in: &subscriptions)
        remotes.$online.sink { [weak self] in self?.online = $0; self?.refreshBanners() }.store(in: &subscriptions)
    }

    // MARK: Take it

    func takeIt() {
        Task { await take() }
    }

    private func take() async {
        let reply = await local(ConchAudioTakeRequest())
        guard reply?.kind == "audio-ack" else {
            message = "Could not take audio from this Mac’s daemon."
            return
        }
        message = nil
        for pairing in pairings {
            await yield(to: pairing, revision: (documents[pairing.id]?.audioControl.revision ?? 0) + 1)
        }
        startRenewal()
    }

    private func yield(to pairing: RemoteMacPairing, revision: Int, retrying: Bool = false) async {
        guard !yielding.contains(pairing.id) else { return }
        yielding.insert(pairing.id)
        defer { yielding.remove(pairing.id) }
        let body: [String: Any] = [
            "kind": "audio-yield", "holder": localOwner, "revision": revision, "leaseMs": Self.leaseMs,
        ]
        do {
            let reply = try await control(body, to: pairing)
            if reply.kind == "audio-ack" {
                grants[pairing.id] = Grant(revision: reply.revision ?? revision)
            } else if reply.code == "stale-revision", !retrying, let current = reply.revision {
                // The document was behind. One retry above what the daemon says it holds.
                yielding.remove(pairing.id)
                await yield(to: pairing, revision: current + 1, retrying: true)
            } else {
                grants[pairing.id] = nil
                message = "\(pairing.endpoint.title): \(reply.error ?? reply.code ?? reply.kind)"
            }
        } catch {
            grants[pairing.id] = nil
            message = "\(pairing.endpoint.title): \(error.localizedDescription)"
        }
        refreshBanners()
    }

    // MARK: Renewal

    private func startRenewal() {
        guard renewTask == nil, !grants.isEmpty else { return }
        renewTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.renewSeconds))
                guard let self, !Task.isCancelled else { return }
                await renewTick()
                if grants.isEmpty { break }
            }
            self?.renewTask = nil
        }
    }

    private func stopRenewal() {
        renewTask?.cancel()
        renewTask = nil
    }

    /// Same holder, same revision: the daemon only extends the lease. Renewal
    /// belongs to an app whose OWN daemon is still local; otherwise the grants
    /// were released in `localChanged` and there is nothing to renew.
    private func renewTick() async {
        guard localState?.audioControl.isLocal == true else { return }
        for (id, grant) in grants {
            guard let pairing = pairing(id) else { continue }
            await yield(to: pairing, revision: grant.revision)
        }
        for (key, entry) in held {
            await present(key: key, owner: entry.owner, item: entry.item)
        }
    }

    // MARK: The peer table (F10, F11)

    private func documentsChanged(_ documents: [String: PublishedState]) {
        self.documents = documents
        for (id, document) in documents {
            let peer = document.audioControl
            if let grant = grants[id], let pairing = pairing(id) {
                if peer.holder == localOwner {
                    // Healthy: the grant stands.
                } else if peer.holder == "local" {
                    if peer.revision > grant.revision {
                        // Someone took it: drop the grant and show Take it.
                        grants[id] = nil
                        message = "\(pairing.endpoint.host) took its audio back."
                    } else {
                        // Equal: the lease expired — re-yield at the same revision.
                        // Lower: the daemon restarted — re-yield above what it published.
                        let revision = peer.revision == grant.revision ? grant.revision : peer.revision + 1
                        Task { await yield(to: pairing, revision: revision) }
                    }
                } else {
                    grants[id] = nil
                }
            }
            if peer.holder == localOwner, !localOwner.isEmpty {
                forward(document.audioOutbox, from: id)
            }
        }
        refreshBanners()
    }

    private func localChanged(_ state: PublishedState?) {
        localState = state
        // Mutual yield cannot persist: the moment this Mac's own record shows
        // a remote holder, every grant this app holds is released.
        if let state, !state.audioControl.isLocal, !grants.isEmpty {
            releaseAll()
        }
        refreshBanners()
    }

    private func pairingsChanged(_ pairings: [RemoteMacPairing]) {
        let previous = self.pairings
        self.pairings = pairings
        for pairing in previous where !pairings.contains(where: { $0.id == pairing.id }) {
            // Release on pairing removal. The transport is this store's own,
            // so it survives RemoteMacStore stopping its subscription.
            if grants[pairing.id] != nil { release(pairing) }
            transports.removeValue(forKey: pairing.id)?.stop()
        }
        for pairing in pairings {
            if let old = previous.first(where: { $0.id == pairing.id }),
               old.endpoint != pairing.endpoint || old.token != pairing.token {
                transports.removeValue(forKey: pairing.id)?.stop()
            }
        }
        refreshBanners()
    }

    // MARK: Forwarding (F4, F12, F14)

    private func forward(_ items: [AudioOutboxItem], from owner: String) {
        for item in items {
            let key = "\(owner):\(item.seq)"
            guard !forwarded.contains(key), held[key] == nil else { continue }
            held[key] = (owner, item)
            Task { await present(key: key, owner: owner, item: item) }
        }
    }

    private func present(key: String, owner: String, item: AudioOutboxItem) async {
        let host = pairing(owner)?.endpoint.host ?? String(owner.prefix(8))
        let reply = await local(ConchAudioPresentRequest(
            source: owner, seq: item.seq, text: item.text, voice: item.voice, label: item.label,
            host: host, at: item.at, session: item.session
        ))
        switch (reply?.kind ?? "", reply?.code ?? "") {
        case ("audio-ack", _):
            forwarded.insert(key)
            held[key] = nil
        case ("audio-error", "held"):
            break // the daemon did not record it; retried on the renewal tick
        case ("audio-error", _):
            forwarded.insert(key) // dropped or invalid: never again
            held[key] = nil
        default:
            break // daemon unreachable: retried on the renewal tick
        }
        if forwarded.count > 500 { forwarded.removeAll() }
    }

    // MARK: Release

    func releaseAll() {
        for id in grants.keys {
            if let pairing = pairing(id) { release(pairing) }
        }
        grants = [:]
        stopRenewal()
        refreshBanners()
    }

    /// App quit (F14d): fire-and-forget. Nothing waits on a request here; a
    /// lost release costs at most one lease of silence on the other Mac.
    func releaseOnQuit() {
        releaseAll()
    }

    private func release(_ pairing: RemoteMacPairing) {
        grants[pairing.id] = nil
        Task { _ = try? await control(["kind": "audio-release"], to: pairing) }
    }

    // MARK: Wire

    private func control(_ body: [String: Any], to pairing: RemoteMacPairing) async throws -> ConchAudioReply {
        let transport = transports[pairing.id] ?? {
            let created = DirectHTTPTransport(endpoint: pairing.endpoint, token: pairing.token)
            transports[pairing.id] = created
            return created
        }()
        let envelope: [String: Any] = [
            "kind": "control-envelope", "ownerDeviceId": pairing.ownerDeviceId, "body": body,
        ]
        let response = try await transport.request(BridgeRequest(
            method: "POST", path: "/control", body: try JSONSerialization.data(withJSONObject: envelope)
        ))
        try response.requireSuccess()
        return try JSONDecoder().decode(ConchAudioReply.self, from: response.body)
    }

    private func local<Request: Encodable>(_ request: Request) async -> ConchAudioReply? {
        guard case .reply(let data) = await socket.request(request, timeout: 2) else { return nil }
        return try? JSONDecoder().decode(ConchAudioReply.self, from: data)
    }

    private func pairing(_ id: String) -> RemoteMacPairing? {
        pairings.first { $0.id == id }
    }

    private func refreshBanners() {
        let holder = localState?.audioControl.holder ?? "local"
        controlledBy = holder == "local" ? nil : (pairing(holder)?.endpoint.host ?? String(holder.prefix(8)))
        silentHosts = localOwner.isEmpty ? [] : pairings
            .filter { online.contains($0.id) && documents[$0.id]?.audioControl.holder == localOwner }
            .map(\.endpoint.host)
        takeableHosts = localOwner.isEmpty ? [] : pairings
            .filter { online.contains($0.id) && documents[$0.id]?.audioControl.holder != localOwner }
            .map(\.endpoint.host)
    }
}

struct ConchAudioTakeRequest: Encodable, Sendable {
    let kind = "audio-take"
}

struct ConchAudioPresentRequest: Encodable, Sendable {
    let kind = "audio-present"
    let source: String
    let seq: Int
    let text: String
    let voice: String
    let label: String
    let host: String
    let at: TimeInterval
    let session: AudioOutboxItem.SessionReference
}

struct ConchAudioReply: Decodable, Sendable {
    let kind: String
    let code: String?
    let revision: Int?
    let error: String?
}
