import AppKit
import CoreImage.CIFilterBuiltins
import SwiftUI

/// Connecting a phone, without a terminal.
///
/// Until now the only way to pair was `conch pair`, which makes conch a
/// developer tool no matter how good the app is: the very first thing a new
/// person must do happens in a shell. The daemon already does all the work —
/// `open-pairing` returns the code, the port and the relay block — so this is
/// a view over an existing capability rather than new plumbing.
///
/// The relay pairing cannot be typed. It carries an endpoint, a room and a
/// secret, which is precisely why a QR is the primary affordance here and the
/// six-digit LAN code is the fallback rather than the other way round.
struct ConchPairingView: View {
    @StateObject private var store = ConchPairingStore()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                status

                if let pairing = store.pairing {
                    if let relay = pairing.relay {
                        relaySection(relay)
                    } else {
                        noRelaySection
                    }
                    lanSection(pairing)
                } else if store.isLoading {
                    ProgressView().frame(maxWidth: .infinity)
                }

                if let error = store.error {
                    Text(error)
                        .font(.callout)
                        .foregroundStyle(ConchPalette.accent)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(ConchPalette.bg)
        .task { await store.open() }
    }

    private var status: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(store.pairing == nil ? ConchPalette.textDim : ConchPalette.brandCyan)
                .frame(width: 8, height: 8)
            Text(store.statusLine)
                .font(.headline)
                .foregroundStyle(ConchPalette.textPrimary)
            Spacer()
            Button("New code") { Task { await store.open(force: true) } }
                .disabled(store.isLoading)
        }
    }

    private func relaySection(_ relay: ConchRelayPairing) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Scan with conch on your iPhone")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(ConchPalette.textPrimary)
            Text("Works from anywhere — cellular or any Wi-Fi. Your Mac and phone "
                 + "reach each other through the relay, which only ever sees encrypted bytes.")
                .font(.callout)
                .foregroundStyle(ConchPalette.textDim)
                .fixedSize(horizontal: false, vertical: true)

            if let image = store.qrImage {
                // White quiet-zone behind the code: scanners need the contrast,
                // and on this near-black background a bare QR will not read.
                Image(nsImage: image)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 220, height: 220)
                    .padding(12)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityLabel("Relay pairing QR code")
            }

            Text(relay.endpoint)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(ConchPalette.textDim)
                .textSelection(.enabled)
        }
    }

    private var noRelaySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Internet access is off")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(ConchPalette.textPrimary)
            Text("Your phone can only reach this Mac on the same Wi-Fi. To use conch "
                 + "from anywhere, deploy the relay and set phone-relay-url in Advanced.")
                .font(.callout)
                .foregroundStyle(ConchPalette.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func lanSection(_ pairing: ConchPairingOpen) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider().background(ConchPalette.divider)
            Text("Or on this Wi-Fi")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(ConchPalette.textPrimary)
            ForEach(store.lanHosts, id: \.self) { host in
                Text("\(host):\(pairing.port)")
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(ConchPalette.textDim)
                    .textSelection(.enabled)
            }
            HStack(spacing: 8) {
                Text(pairing.code)
                    .font(.system(size: 28, weight: .semibold, design: .monospaced))
                    .foregroundStyle(ConchPalette.textPrimary)
                    .textSelection(.enabled)
                Text(store.expiryLine)
                    .font(.caption)
                    .foregroundStyle(ConchPalette.textDim)
            }
        }
    }
}

// MARK: - Model

struct ConchRelayPairing: Decodable, Equatable {
    let version: Int
    let endpoint: String
    let roomId: String
    let secret: String
}

struct ConchPairingOpen: Decodable, Equatable {
    let kind: String
    let code: String
    let expiresAt: Double
    let port: Int
    let relay: ConchRelayPairing?
}

private struct ConchOpenPairingRequest: Encodable {
    let kind = "open-pairing"
}

@MainActor
final class ConchPairingStore: ObservableObject {
    @Published private(set) var pairing: ConchPairingOpen?
    @Published private(set) var qrImage: NSImage?
    @Published private(set) var error: String?
    @Published private(set) var isLoading = false

    private let socketClient = ConchSocketClient()

    var statusLine: String {
        if pairing == nil { return isLoading ? "Opening…" : "Not connected to the daemon" }
        return pairing?.relay == nil ? "Ready to pair on this network" : "Ready to pair from anywhere"
    }

    var expiryLine: String {
        guard let pairing else { return "" }
        let remaining = Int(pairing.expiresAt / 1000 - Date().timeIntervalSince1970)
        // The relay QR does NOT expire; only this typed code does. Saying so
        // stops the countdown reading as pressure to hurry the scan.
        return remaining > 0 ? "expires in \(max(1, remaining / 60)) min" : "expired — press New code"
    }

    /// Every non-loopback IPv4 this Mac answers on, same set `conch pair` prints.
    var lanHosts: [String] {
        var hosts: [String] = []
        var pointer: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&pointer) == 0, let first = pointer else { return hosts }
        defer { freeifaddrs(pointer) }
        for interface in sequence(first: first, next: { $0.pointee.ifa_next }) {
            guard let address = interface.pointee.ifa_addr,
                  address.pointee.sa_family == UInt8(AF_INET),
                  interface.pointee.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address, socklen_t(address.pointee.sa_len),
                           &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 {
                let host = String(cString: buffer)
                if !host.isEmpty, !hosts.contains(host) { hosts.append(host) }
            }
        }
        return hosts
    }

    func open(force: Bool = false) async {
        if pairing != nil && !force { return }
        isLoading = true
        error = nil
        defer { isLoading = false }

        switch await socketClient.request(ConchOpenPairingRequest()) {
        case let .reply(data):
            do {
                let opened = try JSONDecoder().decode(ConchPairingOpen.self, from: data)
                guard opened.kind == "pairing-open" else {
                    error = "The daemon answered with \(opened.kind) instead of a pairing."
                    return
                }
                pairing = opened
                qrImage = opened.relay.flatMap(Self.qr(for:))
            } catch {
                // A pairing that cannot be decoded must not be shown as usable:
                // a half-rendered QR that scans into a broken pairing is worse
                // than saying plainly that it failed.
                self.error = "Could not read the daemon's pairing reply."
            }
        case .connectFailed:
            // The daemon is part of this app now, so there is no separate
            // install to tell anyone about — it is a switch in the window.
            error = "conch isn't running. Turn it on in the conch window."
        case .timeout:
            error = "The daemon didn't answer in time."
        }
    }

    /// `conch-relay-v1:<base64url JSON>` — byte-identical to `relayPairingCode`
    /// in src/phone-relay.ts. The iOS scanner accepts nothing else, so these two
    /// encoders must not drift.
    static func pairingCode(for relay: ConchRelayPairing) -> String? {
        let payload: [String: Any] = [
            "version": relay.version,
            "endpoint": relay.endpoint,
            "roomId": relay.roomId,
            "secret": relay.secret,
        ]
        guard let json = try? JSONSerialization.data(
            withJSONObject: payload,
            options: [.sortedKeys]
        ) else { return nil }
        let base64URL = json.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "conch-relay-v1:\(base64URL)"
    }

    static func qr(for relay: ConchRelayPairing) -> NSImage? {
        guard let code = pairingCode(for: relay) else { return nil }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(code.utf8)
        // M: the payload is ~200 bytes and the code is read off a bright screen
        // at close range, so correction beyond this only shrinks the modules.
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        let context = CIContext()
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: scaled.extent.width,
                                                      height: scaled.extent.height))
    }
}
