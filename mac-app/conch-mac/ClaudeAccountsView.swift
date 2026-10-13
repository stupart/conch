import AppKit
import SwiftUI
import WebKit
import ConchDesign

// Native adaptation of claude-swap tui/widgets.py, theme.py and data.py at
// 3a4e5c14873eb5b32f182d55c68da98ac8c0db45. Copyright (c) 2026 Onur Cetinkol.
// MIT: third-party/claude-swap/LICENSE and bundled ClaudeSwapLicense.txt.

/// Providers in the app's own colours, light and dark (`ConchPalette`), so Settings follows the system appearance (2026-10-14).
/// It was claude-swap's fixed dark palette, and Settings stayed dark while it showed so Providers wasn't a dark block in a
/// light page. The usage bars keep claude-swap's design, a thin track with a gap where the fill ends, and its three
/// levels; each level is also a percentage's colour, so it holds 4.5:1 on the ground in both appearances (claude-swap's
/// own green and amber measured 2.19 and 1.83 on the light ground).
private enum SwapPalette {
    static let background = ConchPalette.bg
    static let foreground = ConchPalette.textPrimary
    static let secondaryText = ConchPalette.textDim
    static let divider = ConchPalette.divider
    /// The bar's track: the selected row's step off the ground, #393938 on dark where claude-swap drew #3A3A3A.
    static let track = ConchPalette.selection
    static func severity(_ pct: Double) -> Color {
        if pct >= 90 { return ConchPalette.statusNeeds }
        if pct >= 70 { return caution }
        return ConchPalette.added
    }

    /// Near a limit: claude-swap's amber on dark (8.78:1 on the ground), and #946200 in light (4.64:1).
    private static let caution = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(srgbRed: 215 / 255, green: 175 / 255, blue: 95 / 255, alpha: 1)
            : NSColor(srgbRed: 148 / 255, green: 98 / 255, blue: 0, alpha: 1)
    })
}

/// A heading's or a row's icon control (refresh, ⋯): a 24-point square whose right edge is the column's, so every one of
/// them is centred on one line, 12 points in from it. A borderless menu sizes itself to its glyph (20 wide), and was
/// centred 2 points to the right of the buttons above and below it until it was put in the same square.
private struct ProviderIcon: View {
    let symbol: String

    var body: some View {
        Image(systemName: symbol)
            .frame(width: Self.side, height: Self.side)
            .contentShape(Rectangle())
    }

    static let side: CGFloat = 24
}

struct SwapDashboard: Decodable {
    let state: String
    let accounts: [SwapUsageAccount]
    let message: String?
}
struct SwapUsageAccount: Decodable, Identifiable {
    let id: String
    let number: Int
    let label: String
    let email: String
    let organization: String?
    let defaultLogin: Bool
    let status: String
    let windows: [SwapUsageWindow]
    let fetchedAt: String?
    let lastGood: Bool
    /// Held out of switching (`cswap disable`).
    var disabled: Bool?
    /// When its stored sign-in stops renewing.
    var loginExpiresAt: String?

    /// Its sign-in has stopped working, so it can't be switched to until it's signed in again.
    var needsSignIn: Bool { ["token_expired", "relogin_required", "no_credentials", "foreign_credential"].contains(status) }

    var statusLabel: String {
        switch status {
        case "ok": return "Usage available"
        case "api_key": return "API billing · no subscription quota"
        case "token_expired": return "Sign-in expired"
        case "no_credentials": return "Sign in needed"
        case "keychain_unavailable": return "Keychain unavailable"
        case "relogin_required": return "Signed out"
        case "foreign_credential": return "Signed in as someone else"
        default: return "Usage unavailable"
        }
    }
}
struct SwapUsageWindow: Decodable {
    let name: String
    let pct: Double
    let resetsAt: String?
}
private func swapDate(_ text: String?) -> Date? {
    guard let text else { return nil }
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return format.date(from: text) ?? ISO8601DateFormatter().date(from: text)
}
private func swapDuration(_ seconds: TimeInterval) -> String {
    let minutes = max(1, Int(ceil(seconds / 60)))
    if minutes >= 1440 { return "\(minutes / 1440)d \((minutes % 1440) / 60)h" }
    if minutes >= 60 { return "\(minutes / 60)h \(minutes % 60)m" }
    return "\(minutes)m"
}

private struct SwapUsageRow: View {
    let account: SwapUsageAccount
    let now: Date
    var showsIdentity = true
    var providerId = "claude"
    @State private var expanded = false
    private var age: TimeInterval? { swapDate(account.fetchedAt).map { now.timeIntervalSince($0) } }
    private var stale: Bool { account.lastGood || age == nil || (age ?? 0) > 300 || (age ?? 0) < -60 }
    private var freshness: String {
        guard let age, age >= -60 else { return "Measurement time unknown" }
        return age < 60 ? "Updated just now" : "Updated \(swapDuration(age)) ago"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if showsIdentity {
            HStack(spacing: 8) {
                Image(providerId == "codex" ? "AgentCodex" : "AgentClaude").resizable().scaledToFit().frame(width: 20, height: 20)
                VStack(alignment: .leading, spacing: 3) {
                Text(account.label).font(ConchTypography.font(size: 13, weight: .medium))
                    .lineLimit(1).help(account.email)
                Text(account.email).font(ConchTypography.font(size: 11)).foregroundStyle(SwapPalette.secondaryText)
                }
                if stale, !account.windows.isEmpty {
                    Text("Cached").font(ConchTypography.font(size: 10))
                        .foregroundStyle(SwapPalette.secondaryText).help(freshness)
                }
                Spacer(minLength: 10)
                Button { expanded.toggle() } label: {
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .frame(width: 24, height: 24).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(SwapPalette.secondaryText)
                .accessibilityLabel("\(expanded ? "Hide" : "Show") details for \(account.label)")
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                .help("Account details")
            }
            }
            if !showsIdentity, !account.windows.isEmpty {
                HStack {
                    Text(stale ? "Cached · \(freshness)" : freshness)
                    Spacer()
                    Text("Resets in")
                }.font(ConchTypography.font(size: 10)).foregroundStyle(SwapPalette.secondaryText)
            }
            if account.windows.isEmpty {
                Text(account.statusLabel == "Usage available" && providerId == "claude" ? "Usage appears after a Claude response in a session started from Conch." : account.statusLabel)
                    .font(ConchTypography.font(size: 11)).foregroundStyle(SwapPalette.secondaryText)
            } else {
                VStack(spacing: 10) {
                    ForEach(Array(account.windows.enumerated()), id: \.offset) { _, window in
                        usageRow(window)
                    }
                }
            }
            if expanded {
                VStack(alignment: .leading, spacing: 5) {
                    Text(account.email).textSelection(.enabled)
                    if let organization = account.organization, !organization.isEmpty { Text(organization) }
                    if account.defaultLogin { Text("Default account") }
                    Text(account.lastGood ? "Last known usage · \(account.statusLabel)" : account.statusLabel)
                    Text(freshness)
                }
                .font(ConchTypography.font(size: 11)).foregroundStyle(SwapPalette.secondaryText)
                .padding(.top, 4)
            }
        }
        .padding(.vertical, 14)
    }

    private func usageRow(_ window: SwapUsageWindow) -> some View {
        let resetDate = swapDate(window.resetsAt)
        let elapsed = resetDate.map { $0 <= now } ?? false
        let reset = resetDate.map { $0 <= now ? "Pending" : swapDuration($0.timeIntervalSince(now)) } ?? "—"
        let resetDescription = resetDate.map { $0 <= now ? "Waiting for updated usage" : "Resets in \(swapDuration($0.timeIntervalSince(now)))" } ?? "Reset time unknown"
        let name = window.name == "5 hour" ? "5h" : (window.name == "7 day" ? "7d" : window.name)
        return HStack(spacing: 12) {
            Text(name).font(.system(size: 11, design: .monospaced))
                .foregroundStyle(SwapPalette.secondaryText).frame(width: 46, alignment: .leading)
                .lineLimit(1).help(window.name)
            GeometryReader { geometry in
                let fill = elapsed ? 0 : geometry.size.width * min(100, max(0, window.pct)) / 100
                ZStack(alignment: .leading) {
                    Rectangle().fill(SwapPalette.track).frame(height: 2)
                    Rectangle().fill(SwapPalette.severity(window.pct).opacity(stale || elapsed ? 0.5 : 1))
                        .frame(width: fill, height: 3)
                    if !elapsed, window.pct > 0, window.pct < 100 {
                        Rectangle().fill(SwapPalette.background).frame(width: min(4, geometry.size.width - fill), height: 3)
                            .offset(x: fill)
                    }
                }.frame(height: geometry.size.height)
            }.frame(height: 8).accessibilityHidden(true)
            Text(elapsed ? "—" : "\(Int(min(window.pct.rounded(), 9999)))%")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(SwapPalette.severity(window.pct)).frame(width: 38, alignment: .trailing)
            Text(reset).font(ConchTypography.font(size: 11)).monospacedDigit()
                .foregroundStyle(SwapPalette.secondaryText).frame(width: 72, alignment: .trailing)
                .help(resetDescription)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(window.name), \(Int(min(window.pct, 9999))) percent used, \(resetDescription)\(stale ? ", cached reading" : "")")
    }
}

/// Conch stores profile names; Claude's own CLI owns sign-in and credentials.
struct ClaudeAccountProfile: Decodable, Identifiable, Equatable {
    let id: String
    let label: String
    let configDir: String
    var status: String
    var email: String?
    var subscription: String?
    var authType: String?

    var statusLabel: String {
        switch status {
        case "signed-in": return "Signed in"
        case "signed-out": return "Sign in needed"
        case "unavailable": return "Status unavailable"
        default: return "Not checked"
        }
    }
}

@MainActor
final class ClaudeAccountsStore: ObservableObject {
    var startCatalog: StartAccountCatalog {
        StartAccountCatalog(accounts: accounts.map {
            StartAccountProfile(id: $0.id, label: $0.label, status: $0.status, email: $0.email, subscription: $0.subscription)
        }, usage: usage.map { dashboard in
            StartAccountUsageDashboard(accounts: dashboard.accounts.map { reading in
                StartAccountUsage(id: reading.id, status: reading.status, windows: reading.windows.map {
                    StartAccountWindow(name: $0.name, pct: $0.pct, resetsAt: $0.resetsAt)
                }, fetchedAt: reading.fetchedAt, lastGood: reading.lastGood)
            })
        })
    }

    @Published var accounts: [ClaudeAccountProfile] = []
    @Published var execution: ExecutionCatalog?
    @Published var usage: SwapDashboard?
    @Published var busy = false
    @Published var error: String?
    @Published var notice: String?
    @Published var createdAccountId: String?
    @Published var pendingLoginId: String?
    /// A Claude sign-in shown in the app (`ClaudeSignInSheet`), not Terminal and the browser.
    @Published var signIn: ClaudeSignInRequest?
    /// Your Claude accounts (daemon claude-rotation.ts): claude-swap's list, whether it switches between them, and how.
    @Published var rotation: ClaudeRotationState?
    /// What a slow action is doing, while it does it.
    @Published var working: String?
    /// Sign-ins closed before they finished: whatever the daemon says about them after is not news.
    private var cancelledSignIns: Set<String> = []
    let providerId: String
    init(providerId: String = "claude") { self.providerId = providerId }
    private var providerName: String { providerId == "codex" ? "Codex" : "Claude" }
    private let client = ConchSocketClient()

    /// Switching on or off: the daemon's `claude-rotation` setting, applied live, then the state read back.
    func setRotation(_ on: Bool) async {
        struct SetConfig: Encodable { let kind = "set-config"; let key = "claude-rotation"; let value: Bool }
        _ = await client.request(SetConfig(value: on), timeout: 10)
        await send("rotation-status")
    }

    /// "Add a Claude account", or sign one in again (`email`): Claude's sign-in in a folder of its own, shown here, so
    /// the login your sessions use never changes while you do it. The first time, claude-swap is installed and the account
    /// this Mac is signed in as goes in the list first, which can take a minute.
    func addAccount(email: String? = nil) async {
        working = rotation?.installed == true ? "Opening Claude's sign-in…" : "Setting up your accounts list. The first time takes about a minute…"
        defer { working = nil }
        await send("rotation-add-account", email: email, timeout: 240)
    }

    /// Default signs in as this account now; running sessions follow within about 30 seconds.
    func use(_ account: SwapUsageAccount) async {
        if await send("rotation-switch", slot: account.number, timeout: 60), rotation?.ok != false {
            notice = "Switched to \(account.email). Running sessions follow within about 30 seconds."
        }
    }

    func removeFromList(_ account: SwapUsageAccount) async {
        if await send("rotation-remove", slot: account.number, timeout: 60), rotation?.ok != false {
            notice = "Removed \(account.email)."
        }
    }

    /// Closes a sign-in without finishing it. Sent even while a refresh is under way (`send` waits its turn), so Claude's
    /// sign-in never keeps listening after the sheet has gone.
    func cancelSignIn(_ request: ClaudeSignInRequest) async {
        struct Request: Encodable { let kind = "claude-accounts"; let action = "cancel-login"; let id: String }
        if signIn?.id == request.id { signIn = nil }
        if request.adding { cancelledSignIns.insert(request.accountId) } else { pendingLoginId = nil }
        _ = await client.request(Request(id: request.accountId), timeout: 10)
    }

    /// The daemon adds the account once its sign-in finishes, wherever that happened; this waits to hear how it went.
    private func finishAdding(_ id: String, email: String?) async {
        struct Request: Encodable { let kind = "claude-accounts"; let action = "rotation-finish-add"; let id: String }
        struct Reply: Decodable { let rotation: ClaudeRotationState? }
        let outcome = await client.request(Request(id: id), timeout: 700)
        if signIn?.accountId == id { signIn = nil }
        guard !cancelledSignIns.contains(id) else { return }
        guard case let .reply(data) = outcome, let state = (try? JSONDecoder().decode(Reply.self, from: data))?.rotation else {
            error = "Couldn't tell whether the account was added. Refresh to check."
            return
        }
        rotation = state
        guard state.ok == true else {
            error = state.output ?? "The account wasn't added."
            return
        }
        let who = state.added ?? email ?? "The account"
        notice = email == nil ? "Added \(who)." : "\(who) is signed in again."
        // Two accounts that could take turns: what they were added for (2026-10-09, Tyler: "ideally its like one account
        // that just rotates to the next max account").
        if !state.on, (state.dashboard?.accounts.filter { !$0.needsSignIn }.count ?? 0) >= 2 {
            await setRotation(true)
            notice = "Added \(who). Switching between your accounts is on."
        }
    }

    @discardableResult
    func send(_ action: String, id: String? = nil, label: String? = nil, configDir: String? = nil,
              slot: Int? = nil, email: String? = nil, timeout: TimeInterval = 20) async -> Bool {
        guard !busy else { return false }
        struct Request: Encodable {
            let kind: String
            let action: String
            let id: String?
            let label: String?
            let configDir: String?
            let slot: Int?
            let email: String?
            /// Claude's sign-in in the app: the daemon hands back Anthropic's page (`loginUrl`) instead of opening Terminal.
            let inApp: Bool?
        }
        struct Adding: Decodable { let id: String; let url: String }
        struct Reply: Decodable {
            let accounts: [ClaudeAccountProfile]?
            let error: String?
            let loginOpened: Bool?
            let loginUrl: String?
            let rotation: ClaudeRotationState?
            let adding: Adding?
            let cloudOpened: Bool?
            let createdAccountId: String?
            let execution: ExecutionCatalog?
            let usage: SwapDashboard?
        }
        let wasSignedIn = accounts.first(where: { $0.id == id })?.status == "signed-in"
        busy = true
        error = nil
        notice = nil
        defer { busy = false }
        switch await client.request(Request(kind: providerId == "codex" ? "codex-accounts" : "claude-accounts", action: action, id: id, label: label,
                                            configDir: configDir, slot: slot, email: email,
                                            inApp: providerId == "claude" && action == "login" ? true : nil), timeout: timeout) {
        case let .reply(data):
            guard let reply = try? JSONDecoder().decode(Reply.self, from: data) else {
                error = "Could not read \(providerName) accounts from the daemon."
                return false
            }
            guard let updated = reply.accounts else {
                error = reply.error ?? "Account management needs an updated Conch daemon."
                return false
            }
            accounts = updated.map { account in
                // Checking one account must not erase the results for the others.
                if account.status == "unchecked", !(action == "login" && account.id == id),
                   let previous = accounts.first(where: { $0.id == account.id && $0.configDir == account.configDir }) {
                    return previous
                }
                return account
            }
            createdAccountId = reply.createdAccountId
            if let state = reply.rotation {
                rotation = state
                if state.ok == false { error = state.output ?? "claude-swap failed." }
            }
            execution = reply.execution
            if let update = reply.usage { usage = update }
            if let adding = reply.adding, let url = URL(string: adding.url) {
                signIn = ClaudeSignInRequest(accountId: adding.id, title: email.map { "Sign in again: \($0)" } ?? "Add a Claude account",
                                             detail: email.map { "Sign in as \($0). Nothing from your browser is used here." }
                                                ?? "Sign in with the account you want to add. Nothing from your browser is used here.",
                                             url: url, adding: true)
                Task { await finishAdding(adding.id, email: email) }
            } else if let link = reply.loginUrl, let url = URL(string: link), let id {
                // Anthropic's page in the app, with no cookies of its own: whoever the browser is signed in as can't sign
                // this account in by accident (2026-10-09, Default ended up as the other account that way).
                pendingLoginId = id
                let label = accounts.first(where: { $0.id == id })?.label ?? "Claude"
                signIn = ClaudeSignInRequest(accountId: id, title: "Sign in to Claude: \(label)",
                                             detail: "Choose the email for this sign-in. Nothing from your browser is used here.", url: url)
            } else if reply.loginOpened == true {
                pendingLoginId = wasSignedIn ? nil : id
                notice = wasSignedIn ? "Finish signing in in Terminal, then choose Check connection." : "Finish signing in with \(providerName) in Terminal. Conch will check the connection automatically."
            }
            if reply.cloudOpened == true { notice = "Codex cloud opened in Terminal with this account. Choose an environment there." }
            if action == "refresh", id == pendingLoginId, accounts.first(where: { $0.id == id })?.status == "signed-in" {
                pendingLoginId = nil
                notice = "Account connected. Choose it when starting a \(providerName) session."
            }
            return true
        case .connectFailed:
            error = "Start the Conch daemon to manage \(providerName) accounts."
        case .timeout:
            error = "The daemon did not reply. Refresh before trying again."
        }
        return false
    }
}

struct ClaudeAccountsView: View {
    var body: some View {
        // Laid out as every Settings section is (`SettingsLayout`): the section's own header, then each provider under its
        // subheading, with the page's hairline between them. It drew a 20-point title of its own, 2 points under the
        // others' baselines.
        ScrollView {
            VStack(alignment: .leading, spacing: SettingsLayout.headerGap) {
                SettingsSectionHeader(title: "Providers", subtitle: "Your accounts on this Mac")
                VStack(alignment: .leading, spacing: 24) {
                    ProviderAccountSection(providerId: "claude")
                    SettingsHairline()
                    ProviderAccountSection(providerId: "codex")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(SettingsLayout.inset)
        }
        .foregroundStyle(SwapPalette.foreground)
        .background(SwapPalette.background)
    }
}

private struct ProviderAccountSection: View {
    @EnvironmentObject private var appStore: StateStore
    let providerId: String
    @StateObject private var store: ClaudeAccountsStore
    @State private var adding = false
    @State private var name = ""
    @State private var existingDirectory: String?
    @State private var removing: ClaudeAccountProfile?
    @State private var removingFromList: SwapUsageAccount?
    @State private var expanded: Set<String> = []
    @State private var showAbout = false
    @State private var showProfiles = false
    private var providerName: String { providerId == "codex" ? "Codex" : "Claude" }

    init(providerId: String) {
        self.providerId = providerId
        _store = StateObject(wrappedValue: ClaudeAccountsStore(providerId: providerId))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: ConchSpace.x2) {
                // The page's subheading, as Environments' Codex cloud is: the mark in its 22-point column, the words after.
                SettingsSubheading(title: providerId == "codex" ? "OpenAI · Codex" : "Anthropic · Claude Code") {
                    Image(providerId == "codex" ? "AgentCodex" : "AgentClaude").resizable().scaledToFit()
                }
                Spacer()
                if store.busy { ProgressView().controlSize(.small) }
                Button { Task { await refresh() } } label: {
                    ProviderIcon(symbol: "arrow.clockwise")
                }.buttonStyle(.plain).help("Refresh accounts and usage").accessibilityLabel("Refresh \(providerName) accounts and usage").disabled(store.busy)
                if providerId == "codex" { Button("Connect account") { adding = true }.disabled(store.busy || adding) }
            }
            if let notice = store.notice { feedback(notice, isError: false) }
            if let error = store.error { feedback(error, isError: true) }
            if providerId == "claude" { claudeAccounts } else { profiles }
            DisclosureGroup("How accounts and usage work", isExpanded: $showAbout) {
                VStack(alignment: .leading, spacing: 10) {
                    if providerId == "claude" {
                        Text("Your Claude accounts and their sign-ins are kept in this Mac's Keychain by claude-swap (MIT). Conch shows them and adds to them; it never sees a password or a token.")
                        Text("Use now, and switching automatically, change which account the Default sign-in is. Sessions keep running and follow within about 30 seconds.")
                        Text("Usage is claude-swap's own reading of each account's limits. A separate sign-in is its own Claude folder: its sessions keep its account and don't switch.")
                    } else {
                        Text("Choose an account when starting a new session. Resume and restart keep its original account. Accounts do not switch automatically when a limit is reached.")
                        Text("Usage comes from Codex’s official account interface. Refresh checks the current limits. Your ChatGPT subscription and API billing are separate.")
                        Text("Each account has a separate configuration and conversation history on this Mac. Your sign-in stays with Codex. Accounts on other devices are separate connections.")
                        Text("Approve Codex’s hook trust review if prompted when you first start a session with a new account.")
                    }
                    Button("Usage bar design · claude-swap (MIT) ↗") {
                        appStore.openLink("https://github.com/realiti4/claude-swap", cwd: nil, rowId: nil) { store.error = $0 }
                    }
                    Text((Bundle.main.url(forResource: "ClaudeSwapLicense", withExtension: "txt")
                        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }) ?? "See third-party/claude-swap/LICENSE in the Conch source.")
                        .font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                }.font(ConchTypography.font(size: 12)).foregroundStyle(SwapPalette.secondaryText).padding(.top, 10)
            }.font(ConchTypography.font(size: 11)).foregroundStyle(SwapPalette.secondaryText)
        }
        .task {
            await store.send("list")
            if providerId == "claude" { await store.send("rotation-status") }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled else { return }
                await store.send("list")
                if providerId == "claude" { await store.send("rotation-status") }
            }
        }
        .task(id: store.pendingLoginId) {
            guard let id = store.pendingLoginId else { return }
            for _ in 0..<60 {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, store.pendingLoginId == id else { return }
                await store.send("refresh", id: id)
            }
            store.notice = "Still waiting for sign-in. Finish in Terminal, then choose Check connection."
        }
        .sheet(item: $store.signIn) { request in
            ClaudeSignInSheet(request: request) { finished in
                guard finished else {
                    Task { await store.cancelSignIn(request) }
                    return
                }
                // Adding: the daemon puts it in the list and the sheet closes when it has (`finishAdding`).
                guard !request.adding else { return }
                store.signIn = nil
                Task {
                    // Claude's listener has the code; give it a moment to write the credential, then read who it is.
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    await store.send("refresh", id: request.accountId)
                }
            }
        }
        .alert("Remove sign-in from Conch?", isPresented: Binding(
            get: { removing != nil }, set: { if !$0 { removing = nil } }
        )) {
            Button("Remove", role: .destructive) {
                guard let account = removing else { return }
                removing = nil
                Task { await store.send("remove", id: account.id) }
            }
            Button("Cancel", role: .cancel) { removing = nil }
        } message: {
            Text("Your sign-in and conversation files stay on this Mac. Close this account’s sessions first.")
        }
        .alert("Remove \(removingFromList?.email ?? "this account") from your Claude accounts?", isPresented: Binding(
            get: { removingFromList != nil }, set: { if !$0 { removingFromList = nil } }
        )) {
            Button("Remove", role: .destructive) {
                guard let account = removingFromList else { return }
                removingFromList = nil
                Task { await store.removeFromList(account) }
            }
            Button("Cancel", role: .cancel) { removingFromList = nil }
        } message: {
            Text(removingFromList?.defaultLogin == true
                 ? "Its saved sign-in is deleted from this Mac. Sessions stay on it, since it's the account in use now, but won't switch back to it."
                 : "Its saved sign-in is deleted from this Mac, and sessions won't switch to it. Add it again any time.")
        }
    }

    private func refresh() async {
        await store.send("usage")
        if providerId == "claude" { await store.send("rotation-status") }
    }

    /// Claude accounts are claude-swap's list (daemon claude-rotation.ts), not whoever this Mac is signed in as
    /// (2026-10-11, Tyler: "the signin and rotate shit is jacked and ux is terrible ... make it clear and 'just work'"; "we
    /// should probably have the store be in the app and be self correcting"). One list; add an account by signing in here;
    /// use one now; switch between them automatically. Conch's separate sign-ins are tucked under it, for the rare session
    /// that must keep one account.
    private var claudeAccounts: some View {
        let list = store.rotation?.dashboard?.accounts ?? []
        let current = store.accounts.first(where: { $0.id == "default" })
        return VStack(alignment: .leading, spacing: 14) {
            Text("Your sessions use one account at a time, and move to the next as it nears its limit. Sessions keep running when it switches.")
                .font(ConchTypography.font(size: 12)).foregroundStyle(SwapPalette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            TimelineView(.periodic(from: .now, by: 30)) { context in
                VStack(spacing: 0) {
                    ForEach(list) { account in
                        listRow(account, now: context.date)
                        Rectangle().fill(SwapPalette.divider).frame(height: 1)
                    }
                    if list.isEmpty, let current, let email = current.email {
                        currentRow(email)
                        Rectangle().fill(SwapPalette.divider).frame(height: 1)
                    }
                }
            }
            // Signed in as someone the list doesn't have: switching would leave that account behind.
            if let email = current?.email, !list.isEmpty, !list.contains(where: { $0.email == email }) {
                HStack(spacing: 10) {
                    Text("This Mac is signed in as \(email), which isn't in your accounts.")
                        .font(ConchTypography.font(size: 12)).foregroundStyle(SwapPalette.secondaryText)
                    Spacer()
                    Button("Add it") { Task { await store.send("rotation-add", timeout: 60) } }.disabled(store.busy)
                }
            }
            Button { Task { await store.addAccount() } } label: {
                Label("Add a Claude account", systemImage: "plus").font(ConchTypography.font(size: 13, weight: .medium))
            }
            .controlSize(.large).disabled(store.busy || store.signIn != nil)
            .help("Sign in with another Claude account here. The account you're using now doesn't change.")
            if let working = store.working {
                Text(working).font(ConchTypography.font(size: 11)).foregroundStyle(SwapPalette.secondaryText)
            }
            switching(list)
            DisclosureGroup(isExpanded: $showProfiles) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("A separate sign-in is its own Claude folder on this Mac. Sessions started on one keep its account and never switch. Default is the one that switches.")
                        .font(ConchTypography.font(size: 11)).foregroundStyle(SwapPalette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                    profiles
                    if !adding { Button("New separate sign-in…") { adding = true }.disabled(store.busy) }
                }.padding(.top, 8)
            } label: {
                Text("Separate sign-ins (\(store.accounts.count))").font(ConchTypography.font(size: 12, weight: .medium))
            }
        }
    }

    private func listRow(_ account: SwapUsageAccount, now: Date) -> some View {
        let state = listState(account, now: now)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image("AgentClaude").resizable().scaledToFit().frame(width: 26, height: 26)
                VStack(alignment: .leading, spacing: 4) {
                    // On one baseline: the small words after the address sat a point above it, centred on it.
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text(account.email).font(ConchTypography.font(size: 13, weight: .medium))
                            .lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                        if let organization = account.organization, !organization.isEmpty, organization != account.email {
                            Text(organization).font(ConchTypography.font(size: 10)).foregroundStyle(SwapPalette.secondaryText).lineLimit(1)
                        }
                    }
                    Text(state.text).font(ConchTypography.font(size: 11)).foregroundStyle(state.color)
                }
                Spacer(minLength: 8)
                if account.needsSignIn {
                    Button("Sign in again") { Task { await store.addAccount(email: account.email) } }
                } else if !account.defaultLogin {
                    Button("Use now") { Task { await store.use(account) } }
                        .help("Sessions move to this account within about 30 seconds")
                }
                Menu {
                    if !account.defaultLogin, !account.needsSignIn { Button("Use now") { Task { await store.use(account) } } }
                    Button("Sign in again…") { Task { await store.addAccount(email: account.email) } }
                    Divider()
                    Button("Remove…", role: .destructive) { removingFromList = account }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                // The borderless menu is its glyph's size whatever its label asks for: the square is put round it.
                .frame(width: ProviderIcon.side, height: ProviderIcon.side)
                .accessibilityLabel("More for \(account.email)")
            }
            .disabled(store.busy || store.signIn != nil)
            if !account.windows.isEmpty {
                SwapUsageRow(account: account, now: now, showsIdentity: false, providerId: "claude")
            }
        }.padding(.vertical, 14)
    }

    private func listState(_ account: SwapUsageAccount, now: Date) -> (text: String, color: Color) {
        if account.needsSignIn { return ("\(account.statusLabel) · sign in again to use it", SwapPalette.severity(95)) }
        if account.defaultLogin { return ("In use now", SwapPalette.severity(0)) }
        if account.disabled == true { return ("Paused · never switched to", SwapPalette.secondaryText) }
        if let expiry = swapDate(account.loginExpiresAt), expiry.timeIntervalSince(now) < 7 * 86_400 {
            return ("Sign-in ends in \(swapDuration(max(60, expiry.timeIntervalSince(now)))) · sign in again to keep it", SwapPalette.severity(75))
        }
        return ("Ready", SwapPalette.secondaryText)
    }

    /// Nothing in the list yet: the account this Mac is signed in as, which the first add puts there.
    private func currentRow(_ email: String) -> some View {
        HStack(spacing: 10) {
            Image("AgentClaude").resizable().scaledToFit().frame(width: 26, height: 26)
            VStack(alignment: .leading, spacing: 4) {
                Text(email).font(ConchTypography.font(size: 13, weight: .medium)).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                Text("In use now · add another account to switch between them")
                    .font(ConchTypography.font(size: 11)).foregroundStyle(SwapPalette.secondaryText)
            }
            Spacer()
        }.padding(.vertical, 14)
    }

    private func switching(_ list: [SwapUsageAccount]) -> some View {
        let usable = list.filter { !$0.needsSignIn && $0.disabled != true }.count
        let rotation = store.rotation
        let on = rotation?.on ?? false
        let caption: String
        if rotation?.installed != true || usable < 2 {
            caption = on ? "On. Add another account for it to switch to." : "Add a second account to switch between them."
        } else if on {
            caption = rotation?.running == true
                ? "On. When the account in use reaches 90% of a limit, sessions move to the one with the most left."
                : "Starting…"
        } else {
            caption = "Off. Sessions stay on the account in use until you choose Use now."
        }
        // A card row, as General's switches are (`DaemonPowerRow`, `LoginItemRow`): the words on the left, the switch at the
        // card's right edge. It was a switch straight after its label, mid-row, in a card of its own padding and radius.
        return OnboardingCard {
            HStack(spacing: ConchSpace.x3) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Switch accounts automatically").font(ConchTypography.font(size: 12.5, weight: .medium))
                        .foregroundStyle(SwapPalette.foreground)
                    Text(caption).font(ConchTypography.font(size: 11)).foregroundStyle(SwapPalette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: ConchSpace.x3)
                Toggle("Switch accounts automatically", isOn: Binding(get: { on }, set: { value in Task { await store.setRotation(value) } }))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .disabled(store.busy || rotation?.installed != true)
            }
            .padding(.horizontal, ConchSpace.x4)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Conch's own sign-ins, each a Claude or Codex folder of its own: the Codex accounts, and Claude's separate sign-ins.
    private var profiles: some View {
        VStack(alignment: .leading, spacing: 12) {
            if adding { addForm }
            if store.accounts.isEmpty && !store.busy {
                Text("Connect to the Conch daemon to load your accounts.").font(ConchTypography.font(size: 12)).foregroundStyle(SwapPalette.secondaryText)
            }
            TimelineView(.periodic(from: .now, by: 30)) { context in
                VStack(spacing: 0) {
                    ForEach(store.accounts) { account in
                        accountRow(account, now: context.date)
                        Rectangle().fill(SwapPalette.divider).frame(height: 1)
                    }
                }
            }
        }
    }

    private func accountRow(_ account: ClaudeAccountProfile, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(providerId == "codex" ? "AgentCodex" : "AgentClaude").resizable().scaledToFit().frame(width: 26, height: 26)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text(account.label).font(ConchTypography.font(size: 13, weight: .medium))
                        if let plan = account.subscription { Text(providerId == "codex" ? "ChatGPT \(plan.capitalized)" : plan.capitalized).font(ConchTypography.font(size: 10)).foregroundStyle(SwapPalette.secondaryText) }
                    }
                    Text(account.email ?? account.statusLabel).font(ConchTypography.font(size: 12))
                        .foregroundStyle(SwapPalette.secondaryText).textSelection(.enabled)
                    // Two profiles signed in as one person: usage, limits and sessions all land on that one account.
                    if let email = account.email, let twin = store.accounts.first(where: { $0.id != account.id && $0.email == email }) {
                        Text("Same account as \(twin.label). Sign in again to use a different one.")
                            .font(ConchTypography.font(size: 11)).foregroundStyle(SwapPalette.severity(80))
                    }
                }
                Spacer()
                if account.status == "signed-out" {
                    Button(store.pendingLoginId == account.id ? "Waiting for sign-in…" : "Sign in") {
                        Task { await store.send("login", id: account.id) }
                    }.disabled(store.busy || store.pendingLoginId == account.id)
                }
                Button { if expanded.contains(account.id) { expanded.remove(account.id) } else { expanded.insert(account.id) } } label: {
                    ProviderIcon(symbol: expanded.contains(account.id) ? "chevron.up" : "ellipsis")
                }.buttonStyle(.plain).accessibilityLabel("Details for \(account.label)")
            }
            if let usage = store.usage?.accounts.first(where: { $0.id == account.id }) {
                SwapUsageRow(account: usage, now: now, showsIdentity: false, providerId: providerId)
            }
            if expanded.contains(account.id) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(account.statusLabel).font(ConchTypography.font(size: 11))
                    HStack {
                        Button("Check connection") { Task { await store.send("refresh", id: account.id) } }
                        Button("Sign in again") { Task { await store.send("login", id: account.id) } }
                        Spacer()
                        if account.id != "default" { Button("Remove…", role: .destructive) { removing = account } }
                    }.disabled(store.busy)
                    Text(account.configDir).font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                }.foregroundStyle(SwapPalette.secondaryText).padding(.top, 4)
            }
        }
        // The Claude list's rhythm (`listRow`): 14 above and below, 10 between a row's parts. These rows were 18 and 8.
        .padding(.vertical, 14)
    }

    private var addForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(providerId == "claude" ? "New separate sign-in" : "Connect a Codex account").font(ConchTypography.font(size: 14, weight: .medium))
            TextField("Name, e.g. Work", text: $name).textFieldStyle(.roundedBorder)
            Text(providerId == "claude"
                 ? "Claude's sign-in opens here. Choose the email for this sign-in."
                 : "Codex will open its sign-in in Terminal. Choose the email for this account in your browser.")
                .font(ConchTypography.font(size: 12)).foregroundStyle(SwapPalette.secondaryText)
            DisclosureGroup("Use an existing account folder") {
                if let directory = existingDirectory {
                    Text(directory).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                    Button("Use a new folder instead") { existingDirectory = nil }
                } else { Button("Choose folder…") { chooseDirectory() } }
            }.font(ConchTypography.font(size: 11))
            HStack {
                Button("Cancel") { adding = false }
                Spacer()
                Button("Continue to \(providerName) sign-in") {
                    Task {
                        if await store.send("add", label: name, configDir: existingDirectory), let id = store.createdAccountId {
                            adding = false
                            name = ""
                            existingDirectory = nil
                            await store.send("login", id: id)
                        }
                    }
                }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.busy)
            }
        }
        .padding(ConchSpace.x4)
        .background(ConchPalette.surface, in: RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous).strokeBorder(ConchPalette.divider, lineWidth: 1))
    }

    private func feedback(_ text: String, isError: Bool) -> some View {
        Text(text).font(ConchTypography.font(size: 12))
            .foregroundStyle(isError ? ConchPalette.statusNeeds : SwapPalette.foreground)
            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
    }

    private func chooseDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.showsHiddenFiles = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Use account folder"
        if panel.runModal() == .OK { existingDirectory = panel.url?.path }
    }
}


/// A Claude sign-in shown in the app (daemon `claude-web-login.ts`): what it's for, and Anthropic's authorize page.
struct ClaudeSignInRequest: Identifiable, Equatable {
    var id: String { accountId }
    /// A separate sign-in's id, or the daemon's id for an account being added (`adding`).
    let accountId: String
    let title: String
    let detail: String
    let url: URL
    /// Adding to your Claude accounts (`rotation-add-account`): the daemon finishes it, and the sheet closes once it has.
    var adding = false
}

/// Claude's own sign-in page, in conch (2026-10-09, Tyler: "make it so u can like popup ui for me too in the deliverables
/// area and i can login there"). A web view with no cookies of its own and none of Safari's, so it signs in whoever you
/// sign in as, never whoever the browser already was: that is how Default came to be the other account. The page sends its
/// code to Claude Code's listener on this Mac (`localhost/callback`), which finishes the sign-in as it always does; conch
/// sees no password or token. `onFinish(true)` once that callback has gone through, `false` on Cancel.
struct ClaudeSignInSheet: View {
    let request: ClaudeSignInRequest
    let onFinish: (Bool) -> Void
    @State private var finished = false
    @State private var inChrome = false
    private static let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome")

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image("AgentClaude").resizable().scaledToFit().frame(width: 18, height: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(request.title).font(ConchTypography.font(size: 13, weight: .semibold))
                    Text(finished ? (request.adding ? "Signed in. Adding it to your accounts…" : "Signed in. Checking which account it is…") : request.detail)
                        .font(ConchTypography.font(size: 11)).foregroundStyle(.secondary)
                }
                Spacer()
                if finished { ProgressView().controlSize(.small) }
                Button("Cancel") { onFinish(false) }.keyboardShortcut(.cancelAction).disabled(finished)
            }
            .padding(12)
            Divider()
            if inChrome {
                VStack(spacing: 10) {
                    Text("Finish signing in in Chrome").font(ConchTypography.font(size: 14, weight: .semibold))
                    Text("It opened in a private window, so it isn't signed in as anyone yet. This closes by itself once you're done.")
                        .font(ConchTypography.font(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                .padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ClaudeSignInWebView(url: request.url) {
                    guard !finished else { return }
                    finished = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { onFinish(true) }
                }
            }
            // Should a provider's page turn the app's web view away, the same sign-in finishes from Chrome: the page hands
            // its code to Claude's listener on this Mac, whichever browser it's in.
            if request.adding, let chrome = Self.chrome, !inChrome, !finished {
                Divider()
                HStack {
                    Text("Trouble signing in here?").font(ConchTypography.font(size: 11)).foregroundStyle(.secondary)
                    Button("Open in a private Chrome window") {
                        let configuration = NSWorkspace.OpenConfiguration()
                        configuration.arguments = ["--incognito", request.url.absoluteString]
                        NSWorkspace.shared.openApplication(at: chrome, configuration: configuration)
                        inChrome = true
                    }.buttonStyle(.link).font(ConchTypography.font(size: 11))
                    Spacer()
                }.padding(.horizontal, 12).padding(.vertical, 8)
            }
        }
        .frame(minWidth: 520, idealWidth: 560, minHeight: 640, idealHeight: 720)
    }
}

/// The page, with no cookies of its own (`.nonPersistent()`). Conch's in-app browser work will give each account a
/// profile of its own; when it does, this is the one place a sign-in would take that account's data store instead.
private struct ClaudeSignInWebView: NSViewRepresentable {
    let url: URL
    let onCallback: () -> Void
    static let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

    func makeCoordinator() -> Coordinator { Coordinator(onCallback: onCallback) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        // Google's sign-in turns away browsers it takes for embedded ones; this view is Safari's engine, so it says so.
        view.customUserAgent = Self.userAgent
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.load(URLRequest(url: url))
        return view
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let onCallback: () -> Void
        private var calledBack = false
        init(onCallback: @escaping () -> Void) { self.onCallback = onCallback }

        /// Claude Code's listener on this Mac, which the page hands its code to.
        private static func isCallback(_ url: URL?) -> Bool {
            guard let url, let host = url.host else { return false }
            return ["localhost", "127.0.0.1"].contains(host) && url.path == "/callback"
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if !calledBack, Self.isCallback(webView.url) || webView.backForwardList.backList.contains(where: { Self.isCallback($0.url) }) {
                calledBack = true
                onCallback()
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            // The listener can answer the callback and close at once; reaching it is what counts.
            if !calledBack, Self.isCallback((error as NSError).userInfo[NSURLErrorFailingURLErrorKey] as? URL) {
                calledBack = true
                onCallback()
            }
        }

        /// A sign-in that opens a window (Continue with Google, Continue with Apple) opens over the page, as a real popup
        /// it keeps talking to. Loading it in the page instead loses the opener it reports back to, and Claude's page then
        /// says "There was an error logging you in" (2026-10-11, the Google sign-in in this sheet).
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            let popup = WKWebView(frame: webView.bounds, configuration: configuration)
            popup.autoresizingMask = [.width, .height]
            popup.customUserAgent = ClaudeSignInWebView.userAgent
            popup.navigationDelegate = self
            popup.uiDelegate = self
            webView.addSubview(popup)
            return popup
        }

        /// The popup closed itself (it has reported back): the page beneath carries on.
        func webViewDidClose(_ webView: WKWebView) {
            webView.removeFromSuperview()
        }
    }
}


/// Your Claude accounts, as the daemon reports them (claude-rotation.ts): claude-swap installed, switching on and running,
/// its list, and how the last action went.
struct ClaudeRotationState: Decodable {
    let installed: Bool
    let on: Bool
    let running: Bool
    let dashboard: SwapDashboard?
    let output: String?
    let ok: Bool?
    /// The account `rotation-finish-add` put in the list.
    let added: String?
}
