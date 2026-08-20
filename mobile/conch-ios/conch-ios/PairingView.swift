import AVFoundation
import SwiftUI

/// Two fields, once. `conch pair` on the Mac prints exactly these.
struct PairingView: View {
    let onPaired: (BridgeClient.Pairing) -> Void

    @State private var host = ""
    @State private var code = ""
    @State private var checking = false
    @State private var problem: String?
    @State private var scanningRelay = false
    @FocusState private var focused: Field?

    private enum Field { case host, code }

    private var trimmedCode: String {
        code.trimmingCharacters(in: .whitespaces)
    }

    /// Six digits is the short code; anything long is a pasted token. One field
    /// that accepts either beats making the user choose a mode.
    private var looksLikeShortCode: Bool {
        trimmedCode.count == 6 && trimmedCode.allSatisfy(\.isNumber)
    }

    private var looksLikeRelayCode: Bool {
        trimmedCode.hasPrefix(RelayPairingPayload.codePrefix)
    }

    /// The host a scanned pairing will actually use, so the confirmation says
    /// something checkable rather than just "trust me".
    private var relayEndpointSummary: String? {
        guard looksLikeRelayCode,
              let payload = try? RelayPairingPayload.decodePairingCode(trimmedCode) else { return nil }
        return "Connects through \(payload.endpoint)"
    }

    private var canPair: Bool {
        looksLikeRelayCode
            || (host.contains(":") && (looksLikeShortCode || trimmedCode.count >= 24))
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 8) {
                // The real icon, not the 🐚 emoji it replaced. This is the
                // first screen anyone sees, and the emoji was a different shell
                // from the one on the home screen they just tapped — the app
                // introducing itself as something other than the thing they
                // launched. Rounded to match how iOS masks the icon, so it
                // reads as the same object.
                Image("ConchMark")
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 64, height: 64)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                Text("conch")
                    .font(Type.label(22, weight: .semibold))
                    .foregroundStyle(Palette.textPrimary)
                // "LAN" is our word, not a person's, and it led with the
                // narrower option. Scanning works from anywhere and is one
                // gesture; typing a host works only on this network.
                Text("Run `conch pair` on your Mac, or open its Phone tab.\n"
                     + "Scan the QR to connect from anywhere.")
                    .font(Type.summary)
                    .foregroundStyle(Palette.textDim)
                    .multilineTextAlignment(.center)
            }
            .padding(.bottom, 36)

            // A scanned relay pairing needs no host and no typed code — it
            // carries its own endpoint. Leaving the LAN fields on screen made
            // a successful scan look like a half-filled form: one field
            // populated with 200 characters of base64, the other empty.
            if looksLikeRelayCode {
                VStack(spacing: 6) {
                    Label("Relay pairing scanned", systemImage: "checkmark.circle.fill")
                        .font(Type.label(15, weight: .medium))
                        .foregroundStyle(Palette.micOpen)
                    Text(relayEndpointSummary ?? "Ready to connect from anywhere.")
                        .font(Type.caption)
                        .foregroundStyle(Palette.textDim)
                        .multilineTextAlignment(.center)
                    Button("Use this network instead") {
                        code = ""
                    }
                    .font(Type.caption.weight(.medium))
                    .foregroundStyle(Palette.textDim)
                    .padding(.top, 4)
                }
                .padding(.horizontal, 28)
            } else {
                VStack(spacing: 14) {
                    field("Host", text: $host, placeholder: "192.168.1.20:8674", field: .host)
                        .keyboardType(.numbersAndPunctuation)
                    field("Code", text: $code, placeholder: "6-digit code", field: .code)
                        .keyboardType(.numbersAndPunctuation)
                }
                .padding(.horizontal, 28)
            }

            Button {
                scanningRelay = true
            } label: {
                Label("Scan relay QR", systemImage: "qrcode.viewfinder")
                    .font(Type.label(15, weight: .medium))
                    .foregroundStyle(Palette.textPrimary)
            }
            .buttonStyle(.plain)
            .padding(.top, 14)

            if let problem {
                Text(problem)
                    .font(Type.caption)
                    .foregroundStyle(Palette.needs)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
                    .padding(.top, 12)
            }

            Button {
                connect()
            } label: {
                Text(checking ? "Checking…" : "Connect")
                    .font(Type.label(17, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .frame(height: 54)
                    .background(
                        canPair ? Palette.micOpen : Palette.raised,
                        in: RoundedRectangle(cornerRadius: 14)
                    )
                    .foregroundStyle(canPair ? Palette.bg : Palette.textFaint)
            }
            .buttonStyle(.plain)
            .disabled(!canPair || checking)
            .padding(.horizontal, 28)
            .padding(.top, 22)
            .animation(.easeOut(duration: 0.15), value: canPair)

            Spacer()
            Spacer()
        }
        .background(Palette.bg)
        .preferredColorScheme(.dark)
        .onAppear { focused = .host }
        .sheet(isPresented: $scanningRelay) {
            RelayQRScanner { scanned in
                scanningRelay = false
                code = scanned
                problem = nil
                // Scanning IS the decision. A QR carries the endpoint, the
                // room and the secret — there is nothing left to fill in and
                // nothing to confirm, so asking for a second tap only adds a
                // step that can be missed. Tyler: "once u scan it should just
                // go into the app paired like you shouldn't have to then click
                // pair after scanning." Typing a host still needs Connect,
                // because a typed host can be wrong.
                connect()
            }
            .ignoresSafeArea()
        }
    }

    private func connect() {
        let trimmedHost = host.trimmingCharacters(in: .whitespaces)
        checking = true
        problem = nil
        Task { @MainActor in
            defer { checking = false }

            if looksLikeRelayCode {
                do {
                    let relay = try RelayPairingPayload.decodePairingCode(trimmedCode)
                    onPaired(.relay(relay))
                } catch {
                    problem = error.localizedDescription
                }
                return
            }

            // Six digits: redeem them for the token the user never has to see.
            if looksLikeShortCode {
                switch await redeemPairingCode(host: trimmedHost, code: trimmedCode) {
                case let .token(token):
                    onPaired(.lan(host: trimmedHost, token: token))
                case let .failed(reason):
                    problem = reason
                }
                return
            }

            // A pasted token still works — and still gets probed before it is
            // trusted, so a bad paste says which half was wrong.
            let candidate = BridgeClient.Pairing.lan(host: trimmedHost, token: trimmedCode)
            switch await probePairing(candidate) {
            case .ok:
                onPaired(candidate)
            case .badCode:
                problem = "That code didn't match — run conch pair on the Mac for a new one."
            case let .unreachable(reason):
                problem = reason
            }
        }
    }

    private func field(
        _ label: String,
        text: Binding<String>,
        placeholder: String,
        field: Field
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label.uppercased())
                .font(.system(size: 11, weight: .medium))
                .tracking(0.8)
                .foregroundStyle(Palette.textFaint)
            TextField(placeholder, text: text)
                .font(Type.mono)
                .foregroundStyle(Palette.textPrimary)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focused, equals: field)
                .padding(13)
                .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 11))
        }
    }
}

/// In-app scanning keeps the relay secret out of a custom URL scheme that any
/// other installed app could claim. The QR is decoded locally and never leaves
/// the phone before its encrypted connection to the Mac.
private struct RelayQRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIViewController(context: Context) -> ScannerViewController {
        let controller = ScannerViewController()
        controller.configure(delegate: context.coordinator)
        return controller
    }

    func updateUIViewController(_ controller: ScannerViewController, context: Context) {}

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let onCode: (String) -> Void
        private var delivered = false

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard !delivered,
                  let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  object.type == .qr,
                  let value = object.stringValue,
                  value.hasPrefix(RelayPairingPayload.codePrefix) else { return }
            delivered = true
            onCode(value)
        }
    }
}

private final class ScannerViewController: UIViewController {
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?

    func configure(delegate: AVCaptureMetadataOutputObjectsDelegate) {
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(delegate, queue: .main)
        output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        self.preview = preview
        DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    deinit {
        session.stopRunning()
    }
}
