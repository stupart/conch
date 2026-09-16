import Foundation
import Network
import UIKit

/// The phone's protocol client. Pairing selects exactly one transport; state,
/// commands, replies, settings, and scoped files above this point are identical.
@MainActor
final class BridgeClient: ObservableObject {
    @Published private(set) var state: PublishedState?
    /// What the screen shows: true through a short blip, false after a real
    /// outage (`outageGrace`). The transport's own view is `linkUp`.
    @Published private(set) var isConnected = false
    /// The Mac answered and refused this phone's credential. Waiting will not
    /// fix that and neither will Try again, so the screens say it plainly and
    /// offer pairing again instead of a spinner.
    @Published private(set) var pairingRejected = false
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

        /// Which Mac this reaches: the host, or the relay endpoint and room.
        /// The credential is left out on purpose — `conch pair` mints a new
        /// token for the same Mac, and that is a re-pair, not a replacement.
        var identity: String {
            switch self {
            case let .lan(host, _): "lan \(host)"
            case let .relay(payload): "relay \(payload.endpoint) \(payload.roomId)"
            }
        }
    }

    convenience init(pairing: Pairing) {
        self.init(pairing: pairing, transport: nil)
    }

    /// `injected` exists for the DEBUG fixture mode; every real pairing picks
    /// its transport from the pairing itself.
    init(pairing: Pairing, transport injected: BridgeTransport?) {
        self.pairing = pairing
        if let injected {
            transport = injected
        } else {
            switch pairing {
            case let .lan(host, token):
                transport = DirectHTTPTransport(host: host, token: token)
            case let .relay(payload):
                transport = RelayTransport(pairing: payload)
            }
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
                self?.linkChanged(connected: connected, error: error)
            }
        }
        transport.start()
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let route = path.status == .satisfied
                ? (path.availableInterfaces.first?.name ?? "online")
                : "offline"
            Task { @MainActor [weak self] in self?.routeChanged(to: route) }
        }
        pathMonitor.start(queue: DispatchQueue(label: "conch.bridge.route"))
    }

    deinit {
        pathMonitor.cancel()
        transport.stop()
    }

    func stop() {
        pathMonitor.cancel()
        outage?.cancel()
        transport.stop()
        isConnected = false
    }

    // MARK: - Connection lifecycle

    /// A drop is shown only once it has lasted this long.
    ///
    /// Coming back to the app, a new Wi-Fi network, the Mac re-dialling the
    /// relay: each is a second or two of re-handshaking, and the banner, the
    /// dimmed rows and the hidden toolbar used to flash for every one of them.
    /// Tyler: "the iphone app loses connection a lot".
    private static let outageGrace = Duration.seconds(6)
    /// The transport's own view of the link, which `isConnected` trails.
    private var linkUp = false
    private var outage: Task<Void, Never>?
    private var backgroundedAt: ContinuousClock.Instant?
    private var suspended = false
    private let pathMonitor = NWPathMonitor()
    /// The preferred interface, "offline", or "" before the first report.
    private var route = ""

    private func linkChanged(connected: Bool, error: String?) {
        if error == BridgeTransportError.unauthorized.localizedDescription { pairingRejected = true }
        // Record every TRANSITION, not every callback: a retry loop fires
        // constantly, and sixty lines of "still trying" would push out the one
        // line that says why. The journal keeps the real link, blips included.
        if connected != linkUp || (!connected && error != lastError) {
            record(connected: connected, detail: error)
        }
        let relinked = connected && !linkUp
        linkUp = connected
        lastError = connected ? nil : error
        guard connected else {
            if !suspended { beginOutageGrace() }
            return
        }
        outage?.cancel()
        outage = nil
        isConnected = true
        hasEverConnected = true
        pairingRejected = false
        // Every new link, not every change on screen: the Mac hands the audio
        // back whenever a link drops, and a blip the grace hid is still a drop.
        if relinked { onConnected?() }
    }

    private func beginOutageGrace() {
        guard isConnected, outage == nil else { return }
        outage = Task { [weak self] in
            try? await Task.sleep(for: Self.outageGrace)
            guard let self, !Task.isCancelled else { return }
            self.outage = nil
            if !self.linkUp { self.isConnected = false }
        }
    }

    /// The app went to the background. What happens to the link is decided
    /// once the audio hand-back has gone out, or when the app comes back.
    func enterBackground() {
        backgroundedAt = .now
    }

    /// Let the link go, unless the app has already come back.
    ///
    /// The hand-back before this is a round trip, and a quick return used to
    /// beat it: the stop then landed on the link the return had just revived,
    /// and the phone sat disconnected until someone tapped Try again.
    func suspendIfStillAway() {
        guard backgroundedAt != nil, !suspended else { return }
        suspended = true
        transport.stop()
    }

    /// The app is in front again. Re-dial only a link that cannot still be good:
    /// one that was let go, or one the Mac has expired (a silent phone's session
    /// ends after 30 s, and the heartbeat does not run in the background).
    ///
    /// Anything shorter — Control Centre, a notification, a glance at another
    /// app, which iOS reports as `.inactive` then `.active` — keeps the session
    /// it has. Re-dialling a healthy one cost a handshake and handed the Mac the
    /// audio for a moment: six of the eleven "phone disconnected — audio back on
    /// this Mac" lines in the daemon log were a live session replaced in the
    /// same second by the phone's own re-dial.
    func enterForeground() {
        guard let away = backgroundedAt else { return }
        backgroundedAt = nil
        guard suspended || away.duration(to: .now) > .seconds(20) else { return }
        suspended = false
        transport.reconnectNow()
        if !linkUp { beginOutageGrace() }
    }

    /// A different way out: Wi-Fi to cellular, or back online after none.
    ///
    /// A socket belongs to the interface it was opened on, and the only thing
    /// that noticed it had gone was the 30-second relay heartbeat (the LAN
    /// socket has none), behind a backoff that kept growing to thirty seconds
    /// while there was no network at all. Losing the route is left to the
    /// transport to discover; gaining one re-dials now.
    private func routeChanged(to next: String) {
        let previous = route
        route = next
        guard !previous.isEmpty, next != previous, next != "offline",
              backgroundedAt == nil, !suspended else { return }
        transport.reconnectNow()
    }

    /// Every request something waits on ends.
    ///
    /// The relay holds a request until a Mac answers it, and with no Mac in the
    /// room that was forever: the settings sheet spun until the phone was
    /// unpaired. The relay request is cancelled with the wait, so nothing is
    /// left queued to fire later.
    private func perform(_ request: BridgeRequest, within limit: Duration = .seconds(30)) async throws -> BridgeResponse {
        let transport = transport
        let response = try await withThrowingTaskGroup(of: BridgeResponse.self) { group in
            group.addTask { try await transport.request(request) }
            group.addTask {
                try await Task.sleep(for: limit)
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw URLError(.timedOut) }
            return first
        }
        if response.status == 401 { pairingRejected = true }
        return response
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

    typealias InjectOutcome = InjectReceipt

    /// Deliver words into a session, and hear whether they landed.
    func inject(sessionId: String, label: String, text: String) async -> InjectOutcome {
        let body = try? JSONSerialization.data(withJSONObject: [
            "type": "inject",
            "sessionId": sessionId,
            "label": label,
            "announce": text,
            "eventAt": Date().timeIntervalSince1970 * 1000,
            // Keep the draft until the Mac returns an explicit delivery receipt.
            "awaitDelivery": true,
        ] as [String: Any])
        let outcome = await deliveryOutcome(body)
        if case let .failed(reason) = outcome {
            lastError = reason
            _ = await reportAppError(
                operation: "message-delivery",
                message: reason,
                sessionId: sessionId
            )
        }
        return outcome
    }

    private func deliveryOutcome(_ body: Data?) async -> InjectOutcome {
        guard let body else { return .failed("Not delivered — the phone couldn't encode that message.") }
        let response: BridgeResponse
        do {
            // Past the Mac's own 20 s bound, with room for the relay's round trip.
            response = try await perform(
                authorizedRequest(method: "POST", path: "/control", body: body),
                within: .seconds(40)
            )
        } catch {
            return .failed("Not delivered — \(error.localizedDescription)")
        }
        return InjectOutcome.decode(status: response.status, body: response.body)
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
                response = try await perform(authorizedRequest(
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

    /// What this phone just said aloud, and why.
    ///
    /// The phone speaks through iOS's own synthesiser, so nothing it says
    /// reaches conch's log. When Tyler asked why conch spoke in manual mode the
    /// honest answer was that the Mac had not — and that the phone leaves no
    /// trace either way, so the question could not be settled. Same shape as
    /// the wake nobody could attribute: unanswerable until the thing doing it
    /// says so.
    func reportSpoke(_ text: String, reason: String) async -> Bool {
        await post(control: [
            "kind": "phone-spoke",
            "text": String(text.prefix(200)),
            "reason": reason,
        ])
    }

    func send(mode action: String) async -> Bool {
        await post(control: ["type": action, "sessionId": "", "label": "", "announce": ""])
    }

    enum SessionCommand: String {
        case dismiss
        case restore
        case attach
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
    /// `cwd` is either the fresh folder the person typed or the folder carried
    /// by a picked historical session.
    enum SessionStart {
        case started
        /// Nothing was started: Codex would stop on its trust prompt in this
        /// folder, so the daemon asks first. The same reply the Mac handles.
        case needsTrust(cwd: String)
        case failed
    }

    func startSession(
        backend: AgentBackend,
        resumeSessionId: String?,
        teleportSessionId: String? = nil,
        cwd: String? = nil,
        trustFolder: Bool = false,
        options: [String: Any] = [:]
    ) async -> SessionStart {
        let resumeID = resumeSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let teleportID = teleportSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let workingDirectory = cwd?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var message: [String: Any] = [
            "kind": "session-start",
            "backend": backend.rawValue,
        ]
        // Only ever true because the person answered Codex's question here.
        if trustFolder {
            message["trustFolder"] = true
        }
        // Per-session choices by the daemon's option names (`agent-adapter.ts`);
        // String or Bool values, and the daemon validates every one.
        if !options.isEmpty {
            message["options"] = options
        }
        if !resumeID.isEmpty {
            message["resumeSessionId"] = resumeID
        }
        if !teleportID.isEmpty {
            message["teleportSessionId"] = teleportID
        }
        if !workingDirectory.isEmpty {
            message["cwd"] = workingDirectory
        }
        guard let reply = await postControlRaw(message) else {
            let failure = "The Mac didn't confirm that \(backend.title) opened in Terminal."
            lastError = failure
            _ = await reportAppError(operation: "session-start", message: failure)
            return .failed
        }
        // The daemon's own words ("session directory does not exist: …"),
        // shown as they are: a folder typed on a phone is the likeliest thing
        // on this sheet to be wrong, and the daemon is the one that looked.
        if reply["kind"] as? String == "session-error",
           let failure = reply["error"] as? String {
            lastError = failure
            _ = await reportAppError(operation: "session-start", message: failure)
            return .failed
        }
        if reply["kind"] as? String == "session-needs-trust",
           let cwd = reply["cwd"] as? String {
            lastError = nil
            return .needsTrust(cwd: cwd)
        }
        guard reply["kind"] as? String == "session-started",
              reply["backend"] as? String == backend.rawValue,
              reply["resumed"] as? Bool == !resumeID.isEmpty,
              (reply["teleported"] as? Bool == true) == !teleportID.isEmpty else {
            let failure = "The Mac didn't confirm that \(backend.title) opened in Terminal."
            lastError = failure
            _ = await reportAppError(operation: "session-start", message: failure)
            return .failed
        }
        lastError = nil
        return .started
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

    /// One door for every link the phone opens (A13): the conversation, a
    /// rendered deliverable, the Settings button. A path is a file on the
    /// Mac, which the phone cannot open; anything else goes to iOS, whose
    /// refusal is only a Bool. Either failure goes back to where the tap
    /// happened and to the Mac's errors.jsonl as `open-link`.
    func openLink(_ url: URL, sessionId: String?, onFailure: @escaping @MainActor (String) -> Void) {
        func fail(_ message: String) {
            onFailure(message)
            Task { await reportAppError(operation: "open-link", message: message, sessionId: sessionId) }
        }
        guard url.scheme != nil, !url.isFileURL else {
            fail("That's a file on your Mac, not a page: \(url.path)")
            return
        }
        UIApplication.shared.open(url) { opened in
            if !opened { fail("iPhone couldn't open \(url.absoluteString)") }
        }
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
            let response = try await perform(authorizedRequest(
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
              let response = try? await perform(authorizedRequest(
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
              let response = try? await perform(authorizedRequest(method: "GET", path: path)),
              response.status == 200,
              let body = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any],
              let markdown = body["markdown"] as? String,
              !markdown.isEmpty else {
            return nil
        }
        return markdown
    }

    /// What a history read came back with.
    enum HistoryOutcome {
        /// The Mac answered. The body is the daemon's own JSON — a page, a body
        /// chunk, the off reply, or an error — which the reader decodes.
        case reply(Data)
        /// Nothing came back to decode.
        case unreachable(String)
    }

    /// One recorded-history read (`docs/records-paging.md`), over the phone's own
    /// authenticated routes.
    ///
    /// The SAME path every other command takes: LAN or relay is the pairing's
    /// business, not this call's. The daemon answers a refused read with a JSON
    /// `history-error` under a non-200 status, so the body is decoded whenever
    /// there is one — only an empty answer is "couldn't reach your Mac".
    func readHistory(path: String, request: some Encodable) async -> HistoryOutcome {
        guard let body = try? JSONEncoder().encode(request) else {
            return .unreachable("The phone couldn't encode that history request.")
        }
        do {
            // Longer than a LAN read needs and shorter than a stuck one: a history
            // read is a SQLite query behind a worker, plus a relay round trip.
            let response = try await perform(
                authorizedRequest(method: "POST", path: path, body: body),
                within: .seconds(15)
            )
            guard !response.body.isEmpty else {
                return .unreachable("Your Mac didn't answer that history read.")
            }
            return .reply(response.body)
        } catch {
            return .unreachable(error.localizedDescription)
        }
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

    /// One pairing per phone: this replaces whatever is stored. PairingView
    /// asks before it lets a different Mac in here.
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

#if DEBUG
/// A Mac that is only a file: the published-state JSON the daemon would send,
/// read from `-conchFixture <abs path>` so a headless simulator can render the
/// real UI without pairing (`scripts/ui-snapshot.sh ios`). It feeds the same
/// `onStateData` path the relay and LAN transports do, so the fixture goes
/// through the app's own decoder. DEBUG only: Release has no way in.
final class FixtureTransport: BridgeTransport, @unchecked Sendable {
    var onStateData: ((Data) -> Void)?
    var onConnectionChange: ((Bool, String?) -> Void)?
    private let url: URL
    /// The Mac refused this phone, through the same signal a LAN 401 raises.
    private let rejected: Bool
    /// What a recorded-history read should answer, or nil to answer nothing at all.
    /// Handed in rather than read here: this file holds the pairing secret, and
    /// nothing in it may touch defaults storage.
    private let history: String?

    init(url: URL, rejected: Bool = false, history: String? = nil) {
        self.url = url
        self.rejected = rejected
        self.history = history
    }

    func start() {
        if rejected {
            onConnectionChange?(false, BridgeTransportError.unauthorized.localizedDescription)
            return
        }
        guard let data = try? Data(contentsOf: url) else {
            onConnectionChange?(false, "Fixture unreadable: \(url.path)")
            return
        }
        onConnectionChange?(true, nil)
        onStateData?(data)
    }

    func stop() {}
    func reconnectNow() { start() }

    // ponytail: every command that is not a history read answers 404. A fixture
    // is read-only, and a missing /reply leaves the fixture's own conversation as
    // the truth.
    //
    // History is the exception because its states are the thing being
    // photographed: `-conchFixtureHistory loaded|partial|loading|off|error`
    // answers a recorded-history read the way a daemon in that state would.
    func request(_ request: BridgeRequest) async throws -> BridgeResponse {
        guard request.path.hasPrefix("/history/") else {
            return BridgeResponse(status: 404, headers: [], body: Data())
        }
        // No history state asked for: this session has nothing recorded above its live
        // window, which is a complete answer and not a failure. Saying it as an empty
        // page is what keeps every other fixture shot looking the way it always has —
        // an unanswered read would put "your Mac didn't answer" over all of them.
        guard let mode = history else {
            let payload = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any]
            if request.path == "/history/item" {
                return Self.answer(["kind": "history-error", "code": "item-not-found",
                                    "error": "That message isn't in the record."])
            }
            return Self.answer([
                "kind": "history-page",
                "session": payload?["session"] as? String ?? "",
                "items": [],
                "changeCursor": "change",
                "epoch": "fixture-epoch",
                "coverage": ["sources": 1, "statuses": ["complete": 1], "replayRequired": false,
                             "indexedBytes": 0, "observedBytes": 0, "branch": "all", "order": "timestamp-source"],
            ])
        }
        switch mode {
        case "off":
            return Self.answer(["kind": "history-off", "error": "history is off"])
        case "error":
            return Self.answer([
                "kind": "history-error",
                "code": "unavailable",
                "error": "conch's record store isn't running.",
            ])
        case "loading":
            // Never answers, so the reader stays in its loading state for the camera.
            try await Task.sleep(for: .seconds(600))
            return BridgeResponse(status: 404, headers: [], body: Data())
        default:
            break
        }
        let payload = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any]
        if request.path == "/history/item" {
            return Self.answer(Self.recordedBody(payload))
        }
        return Self.answer(recordedPage(payload, partial: mode == "partial"))
    }

    private static func answer(_ payload: [String: Any]) -> BridgeResponse {
        BridgeResponse(
            status: 200,
            headers: [["content-type", "application/json"]],
            body: (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
        )
    }

    /// A body read back in two chunks, so the chunked reader is exercised rather
    /// than mimicked.
    private static func recordedBody(_ payload: [String: Any]?) -> [String: Any] {
        let item = payload?["item"] as? String ?? ""
        guard payload?["bodyCursor"] is String else {
            return ["kind": "history-item", "item": item, "revision": 1, "encoding": "text",
                    "content": "The whole of this recorded message, ", "nextBodyCursor": "1"]
        }
        return ["kind": "history-item", "item": item, "revision": 1, "encoding": "text",
                "content": "read back from the record store in two chunks."]
    }

    /// Two real pages of recorded items, built from the fixture's own conversation
    /// so the rows above the live window read like the session they belong to. The
    /// second page has no cursor, so paging terminates instead of spinning.
    private func recordedPage(_ payload: [String: Any]?, partial: Bool) -> [String: Any] {
        let session = payload?["session"] as? String ?? ""
        // A session the daemon no longer publishes a window for still has a record,
        // and that is the case worth photographing: an empty live window above a full
        // history. The fixture has no conversation for those sessions, so the recorded
        // page is built from a short one of its own rather than from nothing.
        let published = fixtureItems(session: session)
        let live = published.isEmpty ? Self.recordedOnly : published
        let base = Date().timeIntervalSince1970 * 1_000 - 3_600_000
        let all = live.enumerated().map { index, item -> [String: Any] in
            let kind = (item["kind"] as? String) ?? "assistant"
            let text = (item["text"] as? String) ?? ""
            let preview = String(text.prefix(240))
            return [
                "id": "rec-\(index)",
                "kind": kind == "tool" ? "tool_call" : "message",
                "role": kind == "user" ? "user" : "assistant",
                "nativeId": "rec-native-\(index)",
                "toolName": ((item["tool"] as? [String: Any])?["name"] as? String) ?? "tool",
                "at": base + Double(index) * 1_000,
                "revision": 1,
                "orderKey": "\(index)",
                "preview": preview.isEmpty ? "An earlier message in this session." : preview,
                // More behind the preview than the preview shows, so a row can
                // offer the rest of itself.
                "bodyBytes": max(preview.utf8.count + 64, text.utf8.count),
            ]
        }
        let half = max(1, all.count / 2)
        let older = (payload?["before"] as? String) != nil
        let items = older ? Array(all.prefix(half)) : Array(all.suffix(from: min(half, all.count)))
        var page: [String: Any] = [
            "kind": "history-page",
            "session": session,
            "items": items,
            "changeCursor": "change",
            "epoch": "fixture-epoch",
            "coverage": partial
                ? ["sources": 2, "statuses": ["complete": 1, "partial": 1], "replayRequired": false,
                   "indexedBytes": 400, "observedBytes": 1_000, "branch": "all", "order": "timestamp-source"]
                : ["sources": 1, "statuses": ["complete": 1], "replayRequired": false,
                   "indexedBytes": 1_000, "observedBytes": 1_000, "branch": "all", "order": "timestamp-source"],
        ]
        if !older { page["previousCursor"] = "older" }
        return page
    }

    /// What the record still holds for a session whose live window is empty.
    private static let recordedOnly: [[String: Any]] = [
        ["kind": "user", "text": "Walk the relay reconnect paths and tell me which one drops the socket."],
        ["kind": "tool", "text": "", "tool": ["name": "Grep"]],
        ["kind": "assistant", "text": "Three of them reconnect; only the backoff path closes the socket first."],
    ]

    private func fixtureItems(session: String) -> [[String: Any]] {
        guard let data = try? Data(contentsOf: url),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let conversations = root["conversations"] as? [String: Any],
              let conversation = conversations[session] as? [String: Any],
              let items = conversation["items"] as? [[String: Any]] else { return [] }
        return items
    }

    /// A COPY: the deliverable sheet deletes whatever file it is handed.
    func download(_ request: BridgeRequest) async throws -> URL {
        guard let path = URLComponents(string: "https://fixture.invalid\(request.path)")?
            .queryItems?.first(where: { $0.name == "path" })?.value else {
            throw BridgeTransportError.invalidRequest
        }
        let copy = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension((path as NSString).pathExtension)
        try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: copy)
        return copy
    }
}
#endif
