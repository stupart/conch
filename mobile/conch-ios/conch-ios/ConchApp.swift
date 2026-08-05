import SwiftUI

@main
struct ConchApp: App {
    // The env override exists for the screenshot/audit harness: a simulator
    // cannot type into the pairing form, and a UX loop that cannot drive the
    // app cannot judge it. Never persisted; a real phone never sets these.
    @State private var pairing: BridgeClient.Pairing? = {
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
            }
            .onChange(of: scenePhase) { _, phase in
                guard let bridge else { return }
                switch phase {
                case .active:
                    Task { await bridge.claimAudio(true) }
                case .background:
                    Task { await bridge.claimAudio(false) }
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
        let created = BridgeClient(pairing: pairing)
        // Claim the voice as soon as we are connected, and re-claim on every
        // reconnect — the daemon hands audio back to the Mac whenever the last
        // phone drops, which includes its own restarts.
        // Claim the voice on every (re)connect: the daemon hands audio back to
        // the Mac whenever the last phone drops, including across its restarts.
        // Which machine is primary is decided by whether this app is OPEN.
        // Open and foregrounded: the phone has the voice and the ear. Closed or
        // backgrounded: the Mac takes them straight back. No button to get
        // wrong, and no state to leave stranded on the wrong device.
        created.onConnected = { [weak created] in
            guard let created else { return }
            Task { await created.claimAudio(true) }
        }
        // Assigning state during view construction is fine here: the next
        // render pass reuses the cached client rather than reconnecting.
        DispatchQueue.main.async { self.bridge = created }
        return created
    }

    private func unpair() {
        bridge?.stop()
        bridge = nil
        PairingStore.delete()
        pairing = nil
    }
}
