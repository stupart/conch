import AVFoundation
import ConchDesign
import SwiftUI
import UIKit

/// The way in, for a phone paired with no Mac: the welcome first (conch lives on the Mac, so the way there comes
/// first), the scanner one tap away, and the two typed fields `conch pair` prints behind "Enter a code instead". Every
/// route reaches `onPaired` through `commit`, and scanning goes straight on to it: no second tap.
struct PairingView: View {
    let onPaired: (BridgeClient.Pairing) -> Void
    /// Where the typed code's back button goes when this was opened over something (setup's expired-code screen): back
    /// to it. Without one, back is the welcome.
    let onBack: (() -> Void)?

    /// Which of the two screens: the welcome, or the typed code. The scanner covers either.
    enum Entry { case welcome, code }
    @State private var entry: Entry = .welcome
    @State private var gettingMac = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(startingAt entry: Entry = .welcome, onBack: (() -> Void)? = nil, onPaired: @escaping (BridgeClient.Pairing) -> Void) {
        self.onPaired = onPaired
        self.onBack = onBack
        _entry = State(initialValue: entry)
    }

    @State private var host = ""
    @State private var code = ""
    @State private var checking = false
    @State private var problem: String?
    @State private var scanningRelay = false
    /// A pairing that would replace a different Mac's, held until the person
    /// says so. The store keeps exactly one and `save` overwrites in silence.
    @State private var replacement: (current: BridgeClient.Pairing, candidate: BridgeClient.Pairing)?
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
        ZStack {
            switch entry {
            case .welcome:
                PhoneFirstWelcome(onScan: { scanningRelay = true }, onGetMac: { gettingMac = true })
                    .transition(SetupSwap.transition(reduceMotion: reduceMotion))
            case .code:
                codeForm
                    .transition(SetupSwap.transition(reduceMotion: reduceMotion))
            }
        }
        .animation(ConchMotion.swap.animation(reduceMotion: reduceMotion), value: entry)
        .fullScreenCover(isPresented: $scanningRelay) {
            SetupScanner(
                onCode: { scanned in
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
                },
                onEnterCode: {
                    scanningRelay = false
                    entry = .code
                },
                onClose: { scanningRelay = false }
            )
        }
        .sheet(isPresented: $gettingMac) { GetMacSheet() }
        .confirmationDialog(
            Text("Replace \(replacement?.current.displayHost ?? "the current Mac")?"),
            isPresented: Binding(
                get: { replacement != nil },
                set: { if !$0 { replacement = nil } }
            ),
            titleVisibility: .visible,
            presenting: replacement
        ) { pending in
            Button("Replace", role: .destructive) { onPaired(pending.candidate) }
            Button("Keep current", role: .cancel) {}
        } message: { pending in
            Text("This phone pairs with one Mac at a time. "
                 + "Replacing forgets \(pending.current.displayHost).")
        }
    }

    /// Typed: the host and six-digit code `conch pair` prints, or a pasted relay code.
    private var codeForm: some View {
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
                        .foregroundStyle(Palette.review)
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
                        canPair ? Palette.textPrimary : Palette.raised,
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
        .onAppear { focused = .host }
        .overlay(alignment: .topLeading) {
            Button {
                focused = nil
                if let onBack { onBack() } else { entry = .welcome }
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Palette.textDim)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back")
            .padding(.leading, 8)
        }
    }

    /// The one door to `onPaired`. A stored pairing for a different Mac stops
    /// here and asks; the same Mac with a fresh code walks straight through.
    private func commit(_ candidate: BridgeClient.Pairing) {
        if let current = PairingStore.load(), current.identity != candidate.identity {
            replacement = (current, candidate)
        } else {
            onPaired(candidate)
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
                    commit(.relay(relay))
                } catch {
                    problem = error.localizedDescription
                }
                return
            }

            // Six digits: redeem them for the token the user never has to see.
            if looksLikeShortCode {
                switch await redeemPairingCode(host: trimmedHost, code: trimmedCode) {
                case let .token(token):
                    commit(.lan(host: trimmedHost, token: token))
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
                commit(candidate)
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
/// The live camera for a `conch-relay-v1:` code, under the designed scanner (`PhoneScanner`): its words, its frame, and
/// the way round it. Camera access is asked for here, the first time, and a no says so rather than showing black.
struct SetupScanner: View {
    /// Only a code that decodes: one that doesn't is said on the scanner, which stays open for the next (`accept`).
    let onCode: (String) -> Void
    let onEnterCode: () -> Void
    let onClose: () -> Void
    @State private var access = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var failure: String?
    /// The last code scanned couldn't be read. It used to close the scanner and say nothing: the scan just vanished.
    @State private var unreadable: String?

    var body: some View {
        PhoneScanner(
            denied: access == .denied || access == .restricted,
            camera: access == .authorized && AVCaptureDevice.default(for: .video) != nil
                ? AnyView(RelayQRScanner(onCode: accept))
                : nil,
            message: unreadable,
            onEnterCode: onEnterCode,
            onOpenSettings: {
                guard let settings = URL(string: UIApplication.openSettingsURLString) else { return }
                BridgeClient.openUnpaired(settings) { failure = $0 }
            },
            onClose: onClose
        )
        .alert(failure ?? "", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        }
        .task {
            guard access == .notDetermined else { return }
            _ = await AVCaptureDevice.requestAccess(for: .video)
            access = AVCaptureDevice.authorizationStatus(for: .video)
        }
    }
}

extension SetupScanner {
    /// A conch code off the camera: on to `onCode` only once it decodes; otherwise said in plain words, and the scanner
    /// keeps looking.
    func accept(_ scanned: String) {
        guard (try? RelayPairingPayload.decodePairingCode(scanned)) != nil else {
            unreadable = PhoneScanner.unreadableCode
            return
        }
        unreadable = nil
        onCode(scanned)
    }
}

/// No Mac yet: the link to conch for Mac, shared or copied.
struct GetMacSheet: View {
    /// Where conch for Mac is today. The design's `conch.app/mac` is a placeholder until conch has a domain.
    static let link = URL(string: "https://github.com/stupart/conch#install")!
    @State private var sharing = false
    @State private var copied = false

    var body: some View {
        PhoneGetMac(
            link: Self.link,
            onShare: { sharing = true },
            onCopy: {
                UIPasteboard.general.url = Self.link
                copied = true
            }
        )
        .overlay(alignment: .top) {
            if copied {
                Label("Copied", systemImage: "checkmark")
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 14)
                    .frame(minHeight: 36)
                    .background(Capsule().fill(Palette.raised))
                    .padding(.top, 12)
                    .transition(.opacity)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .animation(.easeOut(duration: ConchMotion.quick), value: copied)
        .sheet(isPresented: $sharing) {
            ShareSheet(items: [Self.link])
                .presentationDetents([.medium, .large])
        }
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.6))
            copied = false
        }
    }
}

/// iOS's own share sheet: AirDrop, Messages, Mail.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

struct RelayQRScanner: UIViewControllerRepresentable {
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
        /// Each code once: the camera sees the same one many times a second. A code that couldn't be read leaves the
        /// scanner open, so a different one (a fresh code on the Mac) is still delivered.
        private var delivered: String?

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  object.type == .qr,
                  let value = object.stringValue,
                  value.hasPrefix(RelayPairingPayload.codePrefix),
                  value != delivered else { return }
            delivered = value
            onCode(value)
        }
    }
}

final class ScannerViewController: UIViewController {
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
