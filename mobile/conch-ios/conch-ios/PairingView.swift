import SwiftUI

/// Two fields, once. `conch pair` on the Mac prints exactly these.
struct PairingView: View {
    let onPaired: (BridgeClient.Pairing) -> Void

    @State private var host = ""
    @State private var code = ""
    @State private var checking = false
    @State private var problem: String?
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

    private var canPair: Bool {
        host.contains(":") && (looksLikeShortCode || trimmedCode.count >= 24)
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 8) {
                Text("🐚")
                    .font(.system(size: 34))
                Text("conch")
                    .font(Type.label(22, weight: .semibold))
                    .foregroundStyle(Palette.textPrimary)
                Text("Run `conch pair` on your Mac,\nthen copy what it prints here.")
                    .font(Type.summary)
                    .foregroundStyle(Palette.textDim)
                    .multilineTextAlignment(.center)
            }
            .padding(.bottom, 36)

            VStack(spacing: 14) {
                field("Host", text: $host, placeholder: "192.168.1.20:8674", field: .host)
                    .keyboardType(.numbersAndPunctuation)
                field("Code", text: $code, placeholder: "6-digit code", field: .code)
                    .keyboardType(.numbersAndPunctuation)
            }
            .padding(.horizontal, 28)

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
    }

    private func connect() {
        let trimmedHost = host.trimmingCharacters(in: .whitespaces)
        checking = true
        problem = nil
        Task { @MainActor in
            defer { checking = false }

            // Six digits: redeem them for the token the user never has to see.
            if looksLikeShortCode {
                switch await redeemPairingCode(host: trimmedHost, code: trimmedCode) {
                case let .token(token):
                    onPaired(BridgeClient.Pairing(host: trimmedHost, token: token))
                case let .failed(reason):
                    problem = reason
                }
                return
            }

            // A pasted token still works — and still gets probed before it is
            // trusted, so a bad paste says which half was wrong.
            let candidate = BridgeClient.Pairing(host: trimmedHost, token: trimmedCode)
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
