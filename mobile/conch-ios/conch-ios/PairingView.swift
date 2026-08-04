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

    private var canPair: Bool {
        host.contains(":") && code.trimmingCharacters(in: .whitespaces).count >= 24
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
                field("Code", text: $code, placeholder: "the pairing code", field: .code)
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
        let candidate = BridgeClient.Pairing(
            host: host.trimmingCharacters(in: .whitespaces),
            token: code.trimmingCharacters(in: .whitespaces)
        )
        checking = true
        problem = nil
        Task { @MainActor in
            switch await probePairing(candidate) {
            case .ok:
                onPaired(candidate)
            case .badCode:
                problem = "That code didn't match — copy it fresh from conch pair on the Mac."
            case let .unreachable(reason):
                problem = reason
            }
            checking = false
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
