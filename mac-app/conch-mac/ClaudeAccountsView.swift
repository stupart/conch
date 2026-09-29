import AppKit
import SwiftUI
import ConchDesign

// Native adaptation of claude-swap tui/widgets.py, theme.py and data.py at
// 3a4e5c14873eb5b32f182d55c68da98ac8c0db45. Copyright (c) 2026 Onur Cetinkol.
// MIT: third-party/claude-swap/LICENSE and bundled ClaudeSwapLicense.txt.
private enum SwapPalette {
    static let background = Color(red: 20/255, green: 20/255, blue: 20/255)
    static let surface = Color(red: 30/255, green: 30/255, blue: 30/255)
    static let foreground = Color(red: 232/255, green: 228/255, blue: 222/255)
    static let secondaryText = Color(white: 0.66)
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

private struct SwapUsageCard: View {
    let account: SwapUsageAccount
    let now: Date
    private var age: TimeInterval? { swapDate(account.fetchedAt).map { now.timeIntervalSince($0) } }
    private var stale: Bool { account.lastGood || age == nil || (age ?? 0) > 300 || (age ?? 0) < -60 }
    private var freshness: String {
        guard let age, age >= -60 else { return "Measurement time unknown" }
        return age < 60 ? "Updated just now" : "Updated \(swapDuration(age)) ago"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 10) {
                Text(String(format: "%02d", account.number))
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(account.defaultLogin ? SwapPalette.accent : SwapPalette.secondaryText)
                    .padding(7).background(SwapPalette.track.opacity(0.4), in: RoundedRectangle(cornerRadius: 5))
                VStack(alignment: .leading, spacing: 4) {
                    Text(account.label).font(.system(size: 14, weight: .semibold)).textSelection(.enabled)
                    if account.label != account.email {
                        Text(account.email).font(.system(size: 11)).foregroundStyle(SwapPalette.secondaryText).textSelection(.enabled)
                    }
                    if let organization = account.organization, !organization.isEmpty {
                        Text(organization).font(.system(size: 10)).foregroundStyle(SwapPalette.secondaryText)
                    }
                }
                Spacer(minLength: 10)
                if account.defaultLogin {
                    Label("Default login", systemImage: "circle.fill")
                        .font(.system(size: 10)).foregroundStyle(SwapPalette.accent)
                }
            }
            if account.windows.isEmpty {
                Text(account.statusLabel == "Usage available" ? "No usage windows reported" : account.statusLabel)
                    .font(.system(size: 12)).foregroundStyle(SwapPalette.secondaryText)
            } else {
                VStack(spacing: 9) {
                    ForEach(Array(account.windows.enumerated()), id: \.offset) { _, window in
                        usageRow(window)
                    }
                }
            }
            HStack(spacing: 6) {
                if stale { Image(systemName: "clock") }
                Text(account.lastGood ? "Last known usage · \(account.statusLabel)" : (stale ? "Cached reading" : "Measured usage"))
                Spacer()
                Text(freshness)
            }.font(.system(size: 10)).foregroundStyle(SwapPalette.secondaryText)
        }
        .padding(16)
        .background(SwapPalette.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(account.defaultLogin ? SwapPalette.accent.opacity(0.7) : SwapPalette.track, lineWidth: 1))
    }

    private func usageRow(_ window: SwapUsageWindow) -> some View {
        let elapsed = swapDate(window.resetsAt).map { $0 <= now } ?? false
        let reset = swapDate(window.resetsAt).map { $0 <= now ? "Reset passed · refresh" : "Resets in \(swapDuration($0.timeIntervalSince(now)))" } ?? "Reset unknown"
        return HStack(spacing: 10) {
            Text(window.name).font(.system(size: 11, design: .monospaced))
                .foregroundStyle(SwapPalette.secondaryText).frame(width: 64, alignment: .leading)
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(SwapPalette.track)
                    Capsule().fill(SwapPalette.severity(window.pct).opacity(stale || elapsed ? 0.5 : 1))
                        .frame(width: geometry.size.width * min(100, max(0, window.pct)) / 100)
                }
            }.frame(height: 7).accessibilityHidden(true)
            Text("\(Int(min(window.pct.rounded(), 9999)))%")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(SwapPalette.severity(window.pct)).frame(width: 44, alignment: .trailing)
            Text(reset).font(.system(size: 10)).foregroundStyle(SwapPalette.secondaryText)
                .frame(width: 146, alignment: .trailing)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(window.name), \(Int(min(window.pct, 9999))) percent used, \(reset)\(stale ? ", cached reading" : "")")
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
    @Published var accounts: [ClaudeAccountProfile] = []
    @Published var execution: ExecutionCatalog?
    @Published var usage: SwapDashboard?
    @Published var busy = false
    @Published var error: String?
    @Published var notice: String?
    private let client = ConchSocketClient()

    @discardableResult
    func send(_ action: String, id: String? = nil, label: String? = nil, configDir: String? = nil) async -> Bool {
        guard !busy else { return false }
        struct Request: Encodable {
            let kind = "claude-accounts"
            let action: String
            let id: String?
            let label: String?
            let configDir: String?
        }
        struct Reply: Decodable {
            let accounts: [ClaudeAccountProfile]?
            let error: String?
            let loginOpened: Bool?
            let execution: ExecutionCatalog?
            let usage: SwapDashboard?
        }
        busy = true
        error = nil
        notice = nil
        defer { busy = false }
        switch await client.request(Request(action: action, id: id, label: label, configDir: configDir), timeout: 20) {
        case let .reply(data):
            guard let reply = try? JSONDecoder().decode(Reply.self, from: data) else {
                error = "Could not read Claude accounts from the daemon."
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
            execution = reply.execution
            if let update = reply.usage { usage = update }
            if reply.loginOpened == true {
                notice = "Finish signing in in Terminal, then choose Check status."
            }
            return true
        case .connectFailed:
            error = "Start the Conch daemon to manage Claude accounts."
        case .timeout:
            error = "The daemon did not reply. Refresh before trying again."
        }
        return false
    }
}

struct ClaudeAccountsView: View {
    @EnvironmentObject private var appStore: StateStore
    @StateObject private var store = ClaudeAccountsStore()
    @State private var adding = false
    @State private var name = ""
    @State private var existingDirectory: String?
    @State private var removing: ClaudeAccountProfile?
    @State private var tab = "usage"
    @State private var showLicense = false

    init(initialTab: String = "usage") { _tab = State(initialValue: initialTab) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Accounts").font(.system(size: 23, weight: .semibold))
                    Label("This Mac · \(store.execution?.runtimes.first?.label ?? "Local runtime")", systemImage: "desktopcomputer")
                        .font(.system(size: 11)).foregroundStyle(SwapPalette.secondaryText)
                }
                Spacer()
                if store.busy { ProgressView().controlSize(.small) }
                Button("Refresh usage") { Task { await store.send("usage") } }.disabled(store.busy)
                Button("Add account…") { adding = true }.disabled(store.busy)
            }
            HStack(spacing: 14) {
                Label("CLAUDE", systemImage: "sparkle")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(SwapPalette.accent)
                Picker("Account view", selection: $tab) {
                    Text("Usage").tag("usage")
                    Text("Launch profiles").tag("profiles")
                }.pickerStyle(.segmented).labelsHidden().frame(maxWidth: 290)
                Spacer()
            }
            if let notice = store.notice { feedback(notice, isError: false) }
            if let error = store.error { feedback(error, isError: true) }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if tab == "usage" {
                        usageContent
                    } else {
                        Text("Choose a profile when starting a session. Resuming keeps its original profile.")
                            .font(.system(size: 12)).foregroundStyle(SwapPalette.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                        ForEach(store.accounts) { account in accountRow(account) }
                    }
                }.padding(1)
            }
            HStack(spacing: 6) {
                Button("Dashboard adapted from claude-swap") { openProject() }.buttonStyle(.plain)
                Text("·").foregroundStyle(SwapPalette.secondaryText)
                Button("MIT licence") { showLicense = true }.buttonStyle(.plain)
                Spacer()
                if tab == "profiles" {
                    Button("Refresh profiles") { Task { await store.send("list") } }.disabled(store.busy)
                }
            }.font(.system(size: 10.5)).foregroundStyle(SwapPalette.secondaryText)
        }
        .foregroundStyle(SwapPalette.foreground)
        .tint(SwapPalette.accent)
        .padding(22)
        .background(SwapPalette.background)
        .environment(\.colorScheme, .dark)
        .task { await store.send("list") }
        .sheet(isPresented: $showLicense) {
            VStack(alignment: .leading, spacing: 16) {
                Text("claude-swap · MIT licence").font(.headline)
                ScrollView {
                    Text((Bundle.main.url(forResource: "ClaudeSwapLicense", withExtension: "txt")
                        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }) ?? "See third-party/claude-swap/LICENSE in the Conch source.")
                        .font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                }
                HStack { Spacer(); Button("Done") { showLicense = false }.keyboardShortcut(.defaultAction) }
            }.padding(24).frame(width: 540, height: 470)
        }
        .sheet(isPresented: $adding) { addSheet }
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
            Text("Claude’s sign-in and conversation files stay on this Mac. Close this account’s sessions first.")
        }
    }

    @ViewBuilder
    private var usageContent: some View {
        Text("Usage read by claude-swap on this Mac. These accounts are not automatically linked to Conch launch profiles.")
            .font(.system(size: 12)).foregroundStyle(SwapPalette.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
        if let usage = store.usage, usage.state == "ready", !usage.accounts.isEmpty {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                VStack(spacing: 12) {
                    ForEach(usage.accounts) { account in
                        SwapUsageCard(account: account, now: context.date)
                    }
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 12) {
                Label(store.usage?.state == "error" ? "Usage unavailable" : "Connect claude-swap", systemImage: "chart.bar.xaxis")
                    .font(.system(size: 16, weight: .medium))
                Text(store.usage?.message ?? (store.usage?.state == "ready"
                    ? "No accounts in claude-swap yet. Add an account there, then refresh usage."
                    : "Already using claude-swap? Refresh usage to show its account cards here. Conch reads usage without switching your login."))
                    .font(.system(size: 12)).foregroundStyle(SwapPalette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Open claude-swap setup ↗") { openProject(installation: true) }.buttonStyle(.plain)
                    .font(.system(size: 12))
            }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                .background(SwapPalette.surface, in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private func openProject(installation: Bool = false) {
        appStore.openLink("https://github.com/realiti4/claude-swap" + (installation ? "#installation" : ""), cwd: nil, rowId: nil) { store.error = $0 }
    }

    private func feedback(_ text: String, isError: Bool) -> some View {
        Text(text)
            .font(ConchTypography.font(size: 12))
            .foregroundStyle(isError ? ConchPalette.statusNeeds : SwapPalette.foreground)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

    private func accountRow(_ account: ClaudeAccountProfile) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "person.crop.circle")
                    .font(.system(size: 24))
                    .foregroundStyle(SwapPalette.secondaryText)
                VStack(alignment: .leading, spacing: 3) {
                    Text(account.label).font(ConchTypography.font(size: 14, weight: .semibold))
                    Text([account.statusLabel, account.email, account.subscription].compactMap { $0 }.joined(separator: " · "))
                        .font(ConchTypography.font(size: 11.5))
                        .foregroundStyle(SwapPalette.secondaryText)
                        .textSelection(.enabled)
                    if account.id == "default" {
                        Text("Your existing Claude configuration")
                            .font(ConchTypography.font(size: 11))
                            .foregroundStyle(SwapPalette.secondaryText)
                    }
                }
                Spacer()
                if account.id != "default" {
                    Button { removing = account } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.plain)
                        .help("Remove \(account.label) from Conch")
                        .accessibilityLabel("Remove \(account.label)")
                }
            }
            HStack(spacing: 8) {
                Button("Sign in…") { Task { await store.send("login", id: account.id) } }
                Button("Check status") { Task { await store.send("refresh", id: account.id) } }
                Spacer()
            }
            DisclosureGroup("Account folder") {
                Text(account.configDir)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(SwapPalette.secondaryText)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(ConchTypography.font(size: 11))
        }
        .padding(14)
        .background(SwapPalette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(SwapPalette.track, lineWidth: 1))
        .disabled(store.busy)
    }

    private var addSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Add Claude account").font(ConchTypography.font(size: 18, weight: .semibold))
            TextField("Account name, e.g. Work", text: $name).textFieldStyle(.roundedBorder)
            Text("Conch creates a separate account folder. You’ll sign in with Claude in Terminal after adding it.")
                .font(ConchTypography.font(size: 12))
                .foregroundStyle(SwapPalette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            if let directory = existingDirectory {
                Text(directory).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                Button("Use a new folder instead") { existingDirectory = nil }
            } else {
                Button("Use an existing Claude account folder…") { chooseDirectory() }
            }
            if let error = store.error { feedback(error, isError: true) }
            HStack {
                Spacer()
                Button("Cancel") { adding = false }.keyboardShortcut(.cancelAction)
                Button("Add account") {
                    Task {
                        if await store.send("add", label: name, configDir: existingDirectory) {
                            adding = false
                            tab = "profiles"
                            name = ""
                            existingDirectory = nil
                        }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.busy)
            }
        }
        .padding(24)
        .frame(width: 420)
        .background(SwapPalette.background)
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
