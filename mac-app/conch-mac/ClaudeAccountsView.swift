import AppKit
import SwiftUI
import WebKit
import ConchDesign

// Native adaptation of claude-swap tui/widgets.py, theme.py and data.py at
// 3a4e5c14873eb5b32f182d55c68da98ac8c0db45. Copyright (c) 2026 Onur Cetinkol.
// MIT: third-party/claude-swap/LICENSE and bundled ClaudeSwapLicense.txt.
private enum SwapPalette {
    static let background = ConchColor.ground.color(.dark)
    static let surface = ConchColor.surface.color(.dark)
    static let foreground = ConchColor.textPrimary.color(.dark)
    static let secondaryText = ConchColor.textSecondary.color(.dark)
    static let divider = ConchColor.hairline.color(.dark)
    static let track = Color(white: 58/255)
    static let accent = Color(red: 215/255, green: 135/255, blue: 95/255)
    static func severity(_ pct: Double) -> Color {
        if pct >= 90 { return Color(red: 215/255, green: 95/255, blue: 95/255) }
        if pct >= 70 { return Color(red: 215/255, green: 175/255, blue: 95/255) }
        return Color(red: 135/255, green: 175/255, blue: 135/255)
    }
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

    var statusLabel: String {
        switch status {
        case "ok": return "Usage available"
        case "api_key": return "API billing · no subscription quota"
        case "token_expired": return "Login expired"
        case "no_credentials": return "Sign in needed"
        case "keychain_unavailable": return "Keychain unavailable"
        case "relogin_required": return "Sign in again in claude-swap"
        case "foreign_credential": return "Account identity changed · check claude-swap"
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
    let providerId: String
    init(providerId: String = "claude") { self.providerId = providerId }
    private var providerName: String { providerId == "codex" ? "Codex" : "Claude" }
    private let client = ConchSocketClient()

    @discardableResult
    func send(_ action: String, id: String? = nil, label: String? = nil, configDir: String? = nil) async -> Bool {
        guard !busy else { return false }
        struct Request: Encodable {
            let kind: String
            let action: String
            let id: String?
            let label: String?
            let configDir: String?
            /// Claude's sign-in in the app: the daemon hands back Anthropic's page (`loginUrl`) instead of opening Terminal.
            let inApp: Bool?
        }
        struct Reply: Decodable {
            let accounts: [ClaudeAccountProfile]?
            let error: String?
            let loginOpened: Bool?
            let loginUrl: String?
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
        switch await client.request(Request(kind: providerId == "codex" ? "codex-accounts" : "claude-accounts", action: action, id: id, label: label, configDir: configDir,
                                           inApp: providerId == "claude" && action == "login" ? true : nil), timeout: 20) {
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
            execution = reply.execution
            if let update = reply.usage { usage = update }
            if let link = reply.loginUrl, let url = URL(string: link), let id {
                // Anthropic's page in the app, with no cookies of its own: whoever the browser is signed in as can't sign
                // this account in by accident (2026-10-09, Default ended up as the other account that way).
                pendingLoginId = id
                signIn = ClaudeSignInRequest(accountId: id, label: accounts.first(where: { $0.id == id })?.label ?? "Claude", url: url)
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
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Providers").font(ConchTypography.font(size: 20, weight: .semibold))
                    Text("Your accounts on this Mac").font(ConchTypography.font(size: 12)).foregroundStyle(SwapPalette.secondaryText)
                }
                ProviderAccountSection(providerId: "codex")
                ProviderAccountSection(providerId: "claude")
            }.padding(24)
        }
        .foregroundStyle(SwapPalette.foreground).tint(SwapPalette.foreground)
        .background(SwapPalette.background).environment(\.colorScheme, .dark)
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
    @State private var expanded: Set<String> = []
    @State private var showAbout = false
    private var providerName: String { providerId == "codex" ? "Codex" : "Claude" }

    init(providerId: String) {
        self.providerId = providerId
        _store = StateObject(wrappedValue: ClaudeAccountsStore(providerId: providerId))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(providerId == "codex" ? "AgentCodex" : "AgentClaude").resizable().scaledToFit().frame(width: 22, height: 22)
                Text(providerId == "codex" ? "OpenAI · Codex" : "Anthropic · Claude Code").font(ConchTypography.font(size: 14, weight: .semibold))
                Spacer()
                if store.busy { ProgressView().controlSize(.small) }
                Button { Task { await store.send("usage") } } label: {
                    Image(systemName: "arrow.clockwise").frame(width: 24, height: 24)
                }.buttonStyle(.plain).help("Refresh accounts and usage").accessibilityLabel("Refresh \(providerName) accounts and usage").disabled(store.busy)
                Button("Connect account") { adding = true }.disabled(store.busy || adding)
            }
            if let notice = store.notice { feedback(notice, isError: false) }
            if let error = store.error { feedback(error, isError: true) }
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
            DisclosureGroup("How accounts and usage work", isExpanded: $showAbout) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Choose an account when starting a new session. Resume and restart keep its original account. Accounts do not switch automatically when a limit is reached.")
                    Text(providerId == "codex"
                        ? "Usage comes from Codex’s official account interface. Refresh checks the current limits. Your ChatGPT subscription and API billing are separate."
                        : "Usage comes from Claude Code’s status line after an API response (Claude 2.1.251 or later). Refresh reads the latest local measurement.")
                    Text("Each account has a separate configuration and conversation history on this Mac. Your sign-in stays with \(providerName). Accounts on other devices are separate connections.")
                    if providerId == "codex" { Text("Approve Codex’s hook trust review if prompted when you first start a session with a new account.") }
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
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled else { return }
                await store.send("list")
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
                store.signIn = nil
                Task {
                    if finished {
                        // Claude's listener has the code; give it a moment to write the credential, then read who it is.
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        await store.send("refresh", id: request.accountId)
                    } else {
                        store.pendingLoginId = nil
                        await store.send("cancel-login", id: request.accountId)
                    }
                }
            }
        }
        .alert("Remove account from Conch?", isPresented: Binding(
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
    }

    private func accountRow(_ account: ClaudeAccountProfile, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(providerId == "codex" ? "AgentCodex" : "AgentClaude").resizable().scaledToFit().frame(width: 26, height: 26)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 7) {
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
                    Image(systemName: expanded.contains(account.id) ? "chevron.up" : "ellipsis").frame(width: 24, height: 24)
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
        }.padding(.vertical, 18)
    }

    private var addForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect a \(providerName) account").font(ConchTypography.font(size: 14, weight: .medium))
            TextField("Account name, e.g. Work", text: $name).textFieldStyle(.roundedBorder)
            Text("\(providerName) will open its sign-in in Terminal. Choose the email for this account in your browser.")
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
        }.padding(16).background(SwapPalette.surface, in: RoundedRectangle(cornerRadius: 8))
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


/// A Claude sign-in shown in the app (daemon `claude-web-login.ts`): the account and Anthropic's authorize page.
struct ClaudeSignInRequest: Identifiable, Equatable {
    var id: String { accountId }
    let accountId: String
    let label: String
    let url: URL
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

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image("AgentClaude").resizable().scaledToFit().frame(width: 18, height: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sign in to Claude: \(request.label)").font(ConchTypography.font(size: 13, weight: .semibold))
                    Text(finished ? "Signed in. Checking which account it is…" : "Choose the email for this account. Nothing from your browser is used here.")
                        .font(ConchTypography.font(size: 11)).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Cancel") { onFinish(false) }.keyboardShortcut(.cancelAction).disabled(finished)
            }
            .padding(12)
            Divider()
            ClaudeSignInWebView(url: request.url) {
                guard !finished else { return }
                finished = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { onFinish(true) }
            }
        }
        .frame(minWidth: 520, idealWidth: 560, minHeight: 640, idealHeight: 720)
    }
}

private struct ClaudeSignInWebView: NSViewRepresentable {
    let url: URL
    let onCallback: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCallback: onCallback) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        // Google's sign-in turns away browsers it takes for embedded ones; this view is Safari's engine, so it says so.
        view.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
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

        /// A sign-in that opens a window (Google, Apple) opens here instead.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if navigationAction.targetFrame == nil, let url = navigationAction.request.url { webView.load(URLRequest(url: url)) }
            return nil
        }
    }
}
