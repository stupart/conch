import SwiftUI

@main
struct ConchApp: App {
    // The env override exists for the screenshot/audit harness: a simulator
    // cannot type into the pairing form, and a UX loop that cannot drive the
    // app cannot judge it. Never persisted; a real phone never sets these.
    @State private var pairing: BridgeClient.Pairing? = {
        let env = ProcessInfo.processInfo.environment
        if let host = env["CONCH_PAIR_HOST"], let token = env["CONCH_PAIR_TOKEN"] {
            return BridgeClient.Pairing(host: host, token: token)
        }
        return PairingStore.load()
    }()
    @State private var bridge: BridgeClient?
    @StateObject private var speech = SpeechController()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                if let pairing {
                    LedgerView(
                        bridge: bridgeClient(for: pairing),
                        onUnpair: unpair,
                        speech: speech
                    )
                } else {
                    PairingView { newPairing in
                        PairingStore.save(newPairing)
                        pairing = newPairing
                    }
                }
            }
            .background(Palette.bg)
            .onChange(of: scenePhase) { _, phase in
                guard let bridge else { return }
                switch phase {
                case .active:
                    Task { await bridge.claimAudio(true) }
                case .background, .inactive:
                    Task { await bridge.claimAudio(false) }
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
        created.onConnected = { Task { await created.claimAudio(true) } }
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
