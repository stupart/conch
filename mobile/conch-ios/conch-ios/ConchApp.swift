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
        }
    }

    private func bridgeClient(for pairing: BridgeClient.Pairing) -> BridgeClient {
        if let bridge { return bridge }
        let created = BridgeClient(pairing: pairing)
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
