import AppKit
import SwiftUI
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
    @State private var expanded = false
    private var age: TimeInterval? { swapDate(account.fetchedAt).map { now.timeIntervalSince($0) } }
    private var stale: Bool { account.lastGood || age == nil || (age ?? 0) > 300 || (age ?? 0) < -60 }
    private var freshness: String {
        guard let age, age >= -60 else { return "Measurement time unknown" }
        return age < 60 ? "Updated just now" : "Updated \(swapDuration(age)) ago"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text(account.label).font(ConchTypography.font(size: 13, weight: .medium))
                    .lineLimit(1).help(account.email)
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
            if account.windows.isEmpty {
                Text(account.statusLabel == "Usage available" ? "Usage unavailable" : account.statusLabel)
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
                    if account.defaultLogin { Text("Default login in claude-swap") }
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
        let reset = resetDate.map { $0 <= now ? "Refresh" : swapDuration($0.timeIntervalSince(now)) } ?? "—"
        let resetDescription = resetDate.map { $0 <= now ? "Reset passed; refresh usage" : "Resets in \(swapDuration($0.timeIntervalSince(now)))" } ?? "Reset time unknown"
        let name = window.name == "5 hour" ? "5h" : (window.name == "7 day" ? "7d" : window.name)
        return HStack(spacing: 12) {
            Text(name).font(.system(size: 11, design: .monospaced))
                .foregroundStyle(SwapPalette.secondaryText).frame(width: 46, alignment: .leading)
                .lineLimit(1).help(window.name)
            GeometryReader { geometry in
                let fill = geometry.size.width * min(100, max(0, window.pct)) / 100
                ZStack(alignment: .leading) {
                    Rectangle().fill(SwapPalette.track).frame(height: 2)
                    Rectangle().fill(SwapPalette.severity(window.pct).opacity(stale || elapsed ? 0.5 : 1))
                        .frame(width: fill, height: 3)
                    if window.pct > 0, window.pct < 100 {
                        Rectangle().fill(SwapPalette.background).frame(width: min(4, geometry.size.width - fill), height: 3)
                            .offset(x: fill)
                    }
                }.frame(height: geometry.size.height)
            }.frame(height: 8).accessibilityHidden(true)
            Text("\(Int(min(window.pct.rounded(), 9999)))%")
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
    @State private var showInfo = false

    init(initialTab: String = "usage") { _tab = State(initialValue: initialTab) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                if tab == "profiles" {
                    Button { tab = "usage" } label: { Image(systemName: "chevron.left") }
                        .buttonStyle(.plain).help("Back to usage").accessibilityLabel("Back to usage")
                }
                Text(tab == "profiles" ? "Manage accounts" : "Accounts")
                    .font(ConchTypography.font(size: 18, weight: .semibold))
                Spacer()
                if store.busy { ProgressView().controlSize(.small) }
                if tab == "profiles" {
                    Button("Add account…") { adding = true }.disabled(store.busy)
                }
                Button { Task { await store.send(tab == "profiles" ? "list" : "usage") } } label: {
                    Image(systemName: "arrow.clockwise").frame(width: 24, height: 24)
                }
                .buttonStyle(.plain).disabled(store.busy)
                .accessibilityLabel(tab == "profiles" ? "Refresh accounts" : "Refresh usage")
                .help(tab == "profiles" ? "Refresh accounts" : "Refresh usage")
                Menu {
                    if tab == "usage" { Button("Manage launch profiles…") { tab = "profiles" } }
                    Button("About usage…") { showInfo = true }
                } label: {
                    Image(systemName: "ellipsis").frame(width: 24, height: 24)
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .accessibilityLabel("Account options")
            }
            Rectangle().fill(SwapPalette.divider).frame(height: 1)
            if let notice = store.notice { feedback(notice, isError: false) }
            if let error = store.error { feedback(error, isError: true) }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if tab == "usage" {
                        usageContent
                    } else {
                        ForEach(store.accounts) { account in accountRow(account) }
                    }
                }.padding(1)
            }

        }
        .foregroundStyle(SwapPalette.foreground)
        .tint(SwapPalette.foreground)
        .padding(22)
        .background(SwapPalette.background)
        .environment(\.colorScheme, .dark)
        .task { await store.send("list") }
        .sheet(isPresented: $showInfo) {
            VStack(alignment: .leading, spacing: 16) {
                Text("About usage").font(ConchTypography.font(size: 18, weight: .semibold))
                Text("Usage comes from claude-swap on \(store.execution?.runtimes.first?.label ?? "this Mac"). Refresh reads its latest available measurements.")
                if let message = store.usage?.message { Text(message) }
                Text("Usage accounts are separate from Conch’s launch profiles. Adding a launch profile does not add it to claude-swap.")
                HStack {
                    Button("claude-swap setup ↗") { openProject(installation: true) }
                    Button("MIT licence") { showInfo = false; showLicense = true }
                }
                HStack { Spacer(); Button("Done") { showInfo = false }.keyboardShortcut(.defaultAction) }
            }
            .font(ConchTypography.font(size: 12))
            .foregroundStyle(SwapPalette.foreground).padding(24).frame(width: 410)
            .background(SwapPalette.background).environment(\.colorScheme, .dark)
        }
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
        if let usage = store.usage, usage.state == "ready", !usage.accounts.isEmpty {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                VStack(spacing: 0) {
                    HStack {
                        Text("Claude").font(ConchTypography.font(size: 11, weight: .medium))
                        Spacer()
                        Text("Resets").font(ConchTypography.font(size: 10))
                    }.foregroundStyle(SwapPalette.secondaryText).padding(.bottom, 4)
                    ForEach(Array(usage.accounts.enumerated()), id: \.element.id) { index, account in
                        if index > 0 { Rectangle().fill(SwapPalette.divider).frame(height: 1) }
                        SwapUsageRow(account: account, now: context.date)
                    }
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Text(store.usage?.state == "error" ? "Usage unavailable" : "No usage yet")
                    .font(ConchTypography.font(size: 13, weight: .medium))
                Button(store.usage == nil ? "Load usage" : (store.usage?.state == "error" ? "Try again" : "Set up claude-swap…")) {
                    if store.usage == nil || store.usage?.state == "error" { Task { await store.send("usage") } }
                    else { showInfo = true }
                }.disabled(store.busy)
            }.padding(.vertical, 18).frame(maxWidth: .infinity, alignment: .leading)

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
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 10) {
                Text([account.statusLabel, account.email, account.subscription].compactMap { $0 }.joined(separator: " · "))
                    .font(ConchTypography.font(size: 11)).foregroundStyle(SwapPalette.secondaryText)
                    .textSelection(.enabled)
                HStack(spacing: 8) {
                    Button("Sign in…") { Task { await store.send("login", id: account.id) } }
                    Button("Check status") { Task { await store.send("refresh", id: account.id) } }
                    Spacer()
                    if account.id != "default" {
                        Button("Remove…", role: .destructive) { removing = account }
                    }
                }
                Text(account.configDir).font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(SwapPalette.secondaryText).textSelection(.enabled)
            }.padding(.top, 10)
        } label: {
            HStack {
                Text(account.label).font(ConchTypography.font(size: 13, weight: .medium))
                Spacer()
                if account.status == "signed-out" {
                    Text("Sign in needed").font(ConchTypography.font(size: 11)).foregroundStyle(SwapPalette.secondaryText)
                }
            }.padding(.vertical, 6)
        }
        .padding(12)
        .background(SwapPalette.surface, in: RoundedRectangle(cornerRadius: 8))
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
