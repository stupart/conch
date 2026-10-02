import ConchDesign
import SwiftUI

/// The accounts on your Mac, as its Settings ▸ Providers shows them: each Claude and Codex
/// account, whether it is signed in, and its plan usage. Sign-in itself happens on the Mac — the
/// agent opens its own login in Terminal there — so the buttons here say so.
struct ProvidersView: View {
    @ObservedObject var bridge: BridgeClient

    var body: some View {
        List {
            ProviderSection(bridge: bridge, provider: .claude)
            ProviderSection(bridge: bridge, provider: .codex)
            Section {
                Text("Choose an account when starting a new session. Resume and restart keep its original account. Accounts do not switch automatically when a limit is reached. Each account has its own configuration and conversation history on your Mac.")
                    .font(Type.caption).foregroundStyle(Palette.textDim)
                    .listRowBackground(Palette.bg)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Palette.bg)
        .navigationTitle("Providers")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct ProviderSection: View {
    @ObservedObject var bridge: BridgeClient
    let provider: BridgeClient.AgentBackend
    @State private var catalog: StartAccountCatalog?
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?
    @State private var adding = false
    @State private var newName = ""
    @State private var removing: StartAccountProfile?

    private var name: String { provider == .codex ? "Codex" : "Claude" }

    var body: some View {
        Section {
            if let catalog {
                if catalog.accounts.isEmpty {
                    Text("No accounts yet.").font(Type.caption).foregroundStyle(Palette.textDim)
                        .listRowBackground(Palette.bg)
                }
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    ForEach(catalog.accounts) { account in
                        AccountRow(
                            provider: provider, account: account, usage: catalog.usage(for: account.id), now: context.date,
                            busy: busy || !bridge.isConnected,
                            onCheck: { run("refresh", id: account.id) },
                            onSignIn: { run("login", id: account.id, notice: "Sign-in opened in Terminal on your Mac.") },
                            onCloud: provider == .codex ? { run("cloud", id: account.id, notice: "Codex cloud opened in Terminal on your Mac.") } : nil,
                            onRemove: account.id == "default" ? nil : { removing = account }
                        )
                    }
                }
                .listRowBackground(Palette.bg)
            } else if busy {
                ProgressView().listRowBackground(Palette.bg)
            }
            if adding {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("Account name, e.g. Work", text: $newName)
                        .textInputAutocapitalization(.words)
                    Text("\(name) opens its sign-in in Terminal on your Mac. Choose the email for this account in the browser there.")
                        .font(Type.caption).foregroundStyle(Palette.textDim)
                    HStack {
                        Button("Cancel") { adding = false; newName = "" }
                        Spacer()
                        Button("Continue to sign-in") { add() }
                            .disabled(newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                    }
                    .buttonStyle(.borderless)
                }
                .listRowBackground(Palette.bg)
            }
            if let notice {
                Text(notice).font(Type.caption).foregroundStyle(Palette.textDim).listRowBackground(Palette.bg)
            }
            if let error {
                Text(error).font(Type.caption).foregroundStyle(Palette.needs).listRowBackground(Palette.bg)
            }
        } header: {
            HStack {
                Image(provider == .codex ? "AgentCodex" : "AgentClaude")
                    .renderingMode(.template).resizable().scaledToFit().frame(width: 13, height: 13)
                Text(provider == .codex ? "OpenAI · Codex" : "Anthropic · Claude Code")
                Spacer()
                Button { run("usage") } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(busy || !bridge.isConnected)
                    .accessibilityLabel("Refresh \(name) accounts and usage")
                Button { adding = true } label: { Image(systemName: "plus") }
                    .disabled(busy || adding || !bridge.isConnected)
                    .accessibilityLabel("Connect a \(name) account")
            }
        }
        .task { run("list") }
        .alert("Remove \(removing?.label ?? "account") from Conch?", isPresented: Binding(
            get: { removing != nil }, set: { if !$0 { removing = nil } }
        )) {
            Button("Remove", role: .destructive) {
                guard let account = removing else { return }
                removing = nil
                run("remove", id: account.id)
            }
            Button("Cancel", role: .cancel) { removing = nil }
        } message: {
            Text("Its sign-in and conversation files stay on your Mac. Close this account's sessions first.")
        }
    }

    private func run(_ action: String, id: String? = nil, label: String? = nil, notice message: String? = nil) {
        busy = true
        error = nil
        notice = nil
        Task {
            let result = await bridge.providerAccounts(provider, action: action, id: id, label: label)
            busy = false
            guard let result else {
                error = bridge.lastError ?? "Couldn't reach your Mac."
                return
            }
            catalog = result.catalog
            if result.loginOpened { notice = message }
            if action == "add", let created = result.createdAccountId {
                adding = false
                newName = ""
                run("login", id: created, notice: "Sign-in opened in Terminal on your Mac.")
            }
        }
    }

    private func add() {
        run("add", label: newName.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

private struct AccountRow: View {
    let provider: BridgeClient.AgentBackend
    let account: StartAccountProfile
    let usage: StartAccountUsage?
    let now: Date
    let busy: Bool
    let onCheck: () -> Void
    let onSignIn: () -> Void
    let onCloud: (() -> Void)?
    let onRemove: (() -> Void)?

    private var availability: StartAccountAvailability {
        StartAccountAvailability.evaluate(account: account, usage: usage, now: now)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(account.label).font(Type.body.weight(.medium)).foregroundStyle(Palette.textPrimary)
                        if let plan = account.subscription {
                            Text(provider == .codex ? "ChatGPT \(plan.capitalized)" : plan.capitalized)
                                .font(Type.caption).foregroundStyle(Palette.textFaint)
                        }
                    }
                    Text(account.email ?? statusLabel).font(Type.caption).foregroundStyle(Palette.textDim)
                        .textSelection(.enabled)
                }
                Spacer()
                Menu {
                    Button("Check connection", systemImage: "checkmark.circle", action: onCheck)
                    Button(account.status == "signed-out" ? "Sign in on Mac" : "Sign in again on Mac",
                           systemImage: "person.badge.key", action: onSignIn)
                    if let onCloud { Button("Open Codex cloud on Mac", systemImage: "cloud", action: onCloud) }
                    if let onRemove {
                        Divider()
                        Button("Remove…", systemImage: "trash", role: .destructive, action: onRemove)
                    }
                } label: {
                    Image(systemName: "ellipsis.circle").frame(width: 32, height: 28)
                }
                .disabled(busy)
                .accessibilityLabel("Actions for \(account.label)")
            }
            ForEach(Array((usage?.windows ?? []).filter(\.validPercentage).enumerated()), id: \.offset) { _, window in
                UsageBar(window: window, now: now)
            }
            HStack(spacing: 5) {
                if availability.blocksStart(allowAtLimit: false) { Image(systemName: "minus.circle") }
                Text(account.status == "signed-in" ? availability.label : statusLabel)
            }
            .font(Type.caption)
            .foregroundStyle(availability.blocksStart(allowAtLimit: false) ? Palette.needs : Palette.textFaint)
        }
        .padding(.vertical, 4)
    }

    private var statusLabel: String {
        switch account.status {
        case "signed-in": "Signed in"
        case "signed-out": "Signed out — sign in on your Mac"
        case "unchecked": "Not checked yet"
        default: "Couldn't check this account"
        }
    }
}

private struct UsageBar: View {
    let window: StartAccountWindow
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(window.name).font(Type.caption).foregroundStyle(Palette.textDim)
                Spacer()
                Text("\(Int(window.pct.rounded()))%").font(Type.caption.monospacedDigit()).foregroundStyle(Palette.textDim)
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Palette.divider)
                    Capsule().fill(window.pct >= 100 ? Palette.needs : Palette.active)
                        .frame(width: geometry.size.width * min(1, max(0, window.pct / 100)))
                }
            }
            .frame(height: 4)
            .accessibilityHidden(true)
            if let reset = window.reset, reset > now {
                Text("Resets \(reset, style: .relative)").font(Type.caption).foregroundStyle(Palette.textFaint)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
