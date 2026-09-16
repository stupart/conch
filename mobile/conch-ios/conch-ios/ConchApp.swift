import SwiftUI

@main
struct ConchApp: App {
    #if DEBUG
    /// `-conchFixture <abs path to published-state JSON>`: render that instead
    /// of pairing, for `scripts/ui-snapshot.sh ios`. Launch arguments land in
    /// UserDefaults' volatile argument domain, so nothing persists.
    static let fixtureURL = UserDefaults.standard.string(forKey: "conchFixture")
        .map { URL(fileURLWithPath: $0) }
    #endif

    // The env override exists for the screenshot/audit harness: a simulator
    // cannot type into the pairing form, and a UX loop that cannot drive the
    // app cannot judge it. Never persisted; a real phone never sets these.
    @State private var pairing: BridgeClient.Pairing? = {
        #if DEBUG
        // A placeholder pairing, never saved: the fixture stands in for the Mac.
        // Shaped like a real LAN host, so what the phone derives from it (the
        // Mac's address for a localhost page) renders as it would.
        if ConchApp.fixtureURL != nil { return .lan(host: "192.168.1.20:8674", token: "") }
        #endif
        let env = ProcessInfo.processInfo.environment
        if let host = env["CONCH_PAIR_HOST"], let token = env["CONCH_PAIR_TOKEN"] {
            return .lan(host: host, token: token)
        }
        return PairingStore.load()
    }()
    @State private var bridge: BridgeClient?
    @StateObject private var speech = SpeechController()
    /// Your words outlive the screen showing them.
    ///
    /// This lived inside SessionView, which is a `navigationDestination` under
    /// a conditional the ledger re-evaluates on every published state. Any
    /// teardown — one empty row list, a reconnect, navigation churn — took the
    /// @StateObject with it and ran `.onDisappear { talk.cancel() }`, and
    /// cancel clears `committed`. Mid-sentence, the whole transcript, gone.
    /// The audio pipeline was appending correctly the entire time; the view
    /// lifecycle was deleting the result. Nothing you have said should be
    /// reachable by a redraw.
    @StateObject private var talk = TalkController()
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var telemetry = DeviceTelemetry()

    var body: some Scene {
        WindowGroup {
            Group {
                if let pairing {
                    LedgerView(
                        bridge: bridgeClient(for: pairing),
                        onUnpair: unpair,
                        speech: speech,
                        talk: talk
                    )
                } else {
                    PairingView { newPairing in
                        LastStateTransport.forget()
                        PairingStore.save(newPairing)
                        pairing = newPairing
                    }
                }
            }
            .background(Palette.bg)
            // Speaking and recording share one AVAudioSession. Wiring this in
            // a view meant a teardown mid-utterance dropped the guard; both
            // objects live for the whole app, so the invariant does too.
            // `.sending` counts: send ends audio, then waits up to three
            // seconds for recognition to flush its final result.
            .onAppear {
                speech.captureOwnsAudio = { [weak talk] in
                    talk?.phase == .listening || talk?.phase == .sending
                }
                // The other direction, which the phone never had: opening the
                // mic silences anything being read. Both objects live for the
                // whole app, so the pair of invariants is installed together
                // and neither can be dropped by a view disappearing.
                talk.silenceSpeech = { [weak speech] in speech?.stop() }
                // Through the cached client, not a fresh one: reporting must
                // ride the connection that already exists, and must never be
                // the thing that constructs one.
                speech.reportSpeaking = { speaking, label in
                    Task { await bridge?.reportSpeaking(speaking, label: label) }
                }
                speech.reportSpoke = { text, reason in
                    Task { await bridge?.reportSpoke(text, reason: reason) }
                }
                telemetry.report = { sample in
                    Task { await bridge?.reportDevice(sample) }
                }
                telemetry.start()
                #if DEBUG
                talk.showFixture()
                #endif
            }
            .onChange(of: scenePhase) { _, phase in
                guard let bridge else { return }
                switch phase {
                case .active:
                    // Resume FIRST, then claim.
                    //
                    // The phone pings every 10s and the Mac expires a silent
                    // peer after 30, but that heartbeat is a Task and iOS
                    // suspends it on background. Coming back and NOT re-dialling
                    // a link that died sat on a dead socket waiting out a
                    // backoff; re-dialling EVERY return tore down healthy links
                    // for a glance at Control Centre. `enterForeground` re-dials
                    // only a link that cannot still be good.
                    //
                    // The claim rides whatever link there is, queued until it is
                    // up. Claiming again is harmless, and needed: the hand-back
                    // sent on the way out can land after the app is back.
                    bridge.enterForeground()
                    telemetry.start()
                    Task { await bridge.claimAudio(true) }
                case .background:
                    // Nothing to measure while suspended, and a timer that
                    // survives backgrounding is the drain it claims to watch.
                    telemetry.stop()
                    // Close the MIC, not just the audio lease.
                    //
                    // Handing the lease back tells the Mac to speak; it does
                    // nothing about a recording session still running here. On
                    // its own that was survivable, because iOS suspends a
                    // silent app — but declaring background audio today removed
                    // that backstop, so an open mic could now keep capture,
                    // on-device speech recognition and the socket alive with
                    // the screen off, indefinitely. A Codex audit ranked it the
                    // clearest path to heat and battery drain in the app, and
                    // it is a regression the same change introduced.
                    //
                    // Nothing is lost: whatever was dictated stays in the draft,
                    // which survives the app being backgrounded.
                    talk.closeMic()
                    // Hand the audio back, then LET GO of the connection.
                    //
                    // iOS suspends the 10s heartbeat the moment we background,
                    // so the Mac expires this peer 30 seconds later and the
                    // phone re-handshakes on the way back. Leaving a socket
                    // behind to rot is worse than closing it: same outcome, more
                    // work, and a spell of looking connected while nothing can
                    // arrive. Nothing is lost by closing: replies queue while the
                    // app is away, and .active resumes before it claims.
                    //
                    // Only if still away: the hand-back is a round trip, and a
                    // quick return used to beat it, so this stop landed on the
                    // link that return had just revived.
                    bridge.enterBackground()
                    Task {
                        await bridge.claimAudio(false)
                        bridge.suspendIfStillAway()
                    }
                case .inactive:
                    // NOT a handback. iOS reports .inactive for anything that
                    // transiently covers the app — a context menu, a system
                    // sheet, the control centre — so releasing here made the
                    // lease flap: "phone has the audio" / "audio back on this
                    // Mac" twice inside one second in the daemon log, every
                    // time a menu opened. Backgrounding is the real signal.
                    break
                @unknown default:
                    break
                }
            }
        }
    }

    private func bridgeClient(for pairing: BridgeClient.Pairing) -> BridgeClient {
        if let bridge { return bridge }
        #if DEBUG
        let fixture: BridgeTransport? = Self.fixtureURL.map {
            // `-conchFixtureOffline YES`: a Mac that never answers, so the
            // ledger is what the last launch saved, as on a cold launch.
            UserDefaults.standard.bool(forKey: "conchFixtureOffline")
                ? SilentTransport() as BridgeTransport
                // `-conchFixtureRejected YES`: this Mac no longer knows this phone.
                : FixtureTransport(
                    url: $0,
                    rejected: UserDefaults.standard.bool(forKey: "conchFixtureRejected"),
                    // `-conchFixtureHistory loaded|partial|loading|off|error`: what a
                    // recorded-history read answers, so the snapshot script can
                    // photograph each state the reader has to draw.
                    history: UserDefaults.standard.string(forKey: "conchFixtureHistory")
                )
        }
        let created = BridgeClient(pairing: pairing, transport: LastStateTransport(fixture ?? Self.transport(for: pairing)))
        #else
        let created = BridgeClient(pairing: pairing, transport: LastStateTransport(Self.transport(for: pairing)))
        #endif
        // Claim the voice as soon as we are connected, and re-claim on every
        // reconnect — the daemon hands audio back to the Mac whenever the last
        // phone drops, which includes its own restarts.
        // Claim the voice on every (re)connect: the daemon hands audio back to
        // the Mac whenever the last phone drops, including across its restarts.
        // Which machine is primary is decided by whether this app is OPEN.
        // Open and foregrounded: the phone has the voice and the ear. Closed or
        // backgrounded: the Mac takes them straight back. No button to get
        // wrong, and no state to leave stranded on the wrong device.
        // What became of messages this phone sent, as the Mac learns it. It comes this way
        // because the request that carried the words was answered and closed long before the
        // Mac knew — which is precisely how a failed send used to reach nobody at all.
        created.onDeliveries = { [weak talk] deliveries in talk?.apply(deliveries) }
        created.onConnected = { [weak created] in
            guard let created else { return }
            Task { await created.claimAudio(true) }
        }
        // Assigning state during view construction is fine here: the next
        // render pass reuses the cached client rather than reconnecting.
        DispatchQueue.main.async { self.bridge = created }
        return created
    }

    /// The transport the pairing names, as BridgeClient picks it, so it can be
    /// wrapped to keep the last state.
    private static func transport(for pairing: BridgeClient.Pairing) -> BridgeTransport {
        switch pairing {
        case let .lan(host, token): DirectHTTPTransport(host: host, token: token)
        case let .relay(payload): RelayTransport(pairing: payload)
        }
    }

    private func unpair() {
        bridge?.stop()
        bridge = nil
        PairingStore.delete()
        LastStateTransport.forget()
        pairing = nil
    }
}

/// The last state the Mac published, kept so a cold launch draws the ledger at
/// once, marked as the last known state, instead of "Looking for your Mac" over
/// an empty screen until the handshake lands.
///
/// One small file, overwritten: the raw bytes the Mac sent, so a restore goes
/// through the app's own decoder like any publish. It holds transcripts, so it
/// is never backed up, is unreadable while the phone is locked, and goes with
/// the pairing.
final class LastStateTransport: BridgeTransport, @unchecked Sendable {
    static let defaultFile = URL.applicationSupportDirectory.appendingPathComponent("last-state.json")
    /// One queue for every write and delete, so a forget always lands after a flush.
    private static let disk = DispatchQueue(label: "conch.last-state")

    var onStateData: ((Data) -> Void)?
    var onConnectionChange: ((Bool, String?) -> Void)? {
        get { inner.onConnectionChange }
        set { inner.onConnectionChange = newValue }
    }
    private let inner: BridgeTransport
    private let file: URL
    /// The newest publish not yet on disk. Touched only on `disk`.
    private var pending: Data?
    private var restored = false

    init(_ inner: BridgeTransport, file: URL = LastStateTransport.defaultFile) {
        self.inner = inner
        self.file = file
        inner.onStateData = { [weak self] data in
            self?.onStateData?(data)
            self?.save(data)
        }
    }

    func start() {
        // Once, and before the link: the first live publish replaces it, and a
        // later start must never draw an older state over a newer one.
        if !restored, let saved = try? Data(contentsOf: file) {
            onStateData?(saved)
        }
        restored = true
        inner.start()
    }

    func stop() {
        // Leaving for the background stops the link: write what is waiting now.
        Self.disk.async { [self] in flush() }
        inner.stop()
    }

    func reconnectNow() { inner.reconnectNow() }
    func request(_ request: BridgeRequest) async throws -> BridgeResponse { try await inner.request(request) }
    func download(_ request: BridgeRequest) async throws -> URL { try await inner.download(request) }

    /// Coalesced: a working session republishes many times a second, and one
    /// write every two seconds keeps the newest.
    private func save(_ data: Data) {
        Self.disk.async { [self] in
            let scheduled = pending != nil
            pending = data
            guard !scheduled else { return }
            Self.disk.asyncAfter(deadline: .now() + 2) { [self] in flush() }
        }
    }

    private func flush() {
        guard let latest = pending else { return }
        pending = nil
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? latest.write(to: file, options: [.atomic, .completeFileProtection])
        var saved = file
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? saved.setResourceValues(values)
    }

    /// With the pairing: another Mac's sessions must never be drawn as this one's.
    static func forget(file: URL = LastStateTransport.defaultFile) {
        disk.async { try? FileManager.default.removeItem(at: file) }
    }
}

#if DEBUG
/// A Mac that never answers (`-conchFixtureOffline`).
final class SilentTransport: BridgeTransport, @unchecked Sendable {
    var onStateData: ((Data) -> Void)?
    var onConnectionChange: ((Bool, String?) -> Void)?
    func start() {}
    func stop() {}
    func reconnectNow() {}
    func request(_ request: BridgeRequest) async throws -> BridgeResponse { throw BridgeTransportError.stopped }
    func download(_ request: BridgeRequest) async throws -> URL { throw BridgeTransportError.stopped }
}
#endif
