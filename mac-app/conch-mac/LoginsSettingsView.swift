import ConchDesign
import SwiftUI

/// Settings › Logins (2026-10-14): which CLIs, agents, MCP servers, plugins and browser profiles this Mac has, and who
/// each is signed in as, from the daemon's logins inventory (src/login-inventory.ts). Read only: nothing here signs in
/// or out. Laid out as Browser is: the section's header, then a block per kind under its subheading, with the page's
/// hairline between them, in the one scroll view the page stops at its column.
struct ConchLoginsSettingsView: View {
    @StateObject private var store = LoginInventoryStore()
    /// The cookies a Chrome import put in each browser profile: counted by this app, never sent to the daemon.
    @ObservedObject private var browser = ChromeImportStore.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SettingsLayout.headerGap) {
                SettingsSectionHeader(title: "Logins", subtitle: "What this Mac has, and who each is signed in as. conch only reads them.") {
                    HStack(spacing: 10) {
                        if store.isRefreshingAll { ProgressView().controlSize(.small) }
                        Button {
                            Task { await store.refreshAll() }
                        } label: {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                        .disabled(store.isRefreshingAll)
                        .help("Check every login again")
                    }
                }
                content
            }
            .font(ConchTypography.font(size: 12))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(SettingsLayout.inset)
        }
        .background(ConchPalette.bg)
        .task { await store.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .loading:
            HStack(spacing: ConchSpace.x2) {
                ProgressView().controlSize(.small)
                Text("Checking your logins… the first look can take a few seconds.").foregroundStyle(ConchPalette.textDim)
            }
        case .needsUpdate:
            Text("Needs an updated conch daemon").foregroundStyle(ConchPalette.statusNeeds)
        case .unreachable:
            Text("conch's daemon isn't running, so your logins can't be checked. Turn it on in General.")
                .foregroundStyle(ConchPalette.textDim)
                .fixedSize(horizontal: false, vertical: true)
        case let .failed(error):
            Text(error).foregroundStyle(ConchPalette.statusNeeds).fixedSize(horizontal: false, vertical: true)
        case let .loaded(reply):
            VStack(alignment: .leading, spacing: 24) {
                Text(status(reply))
                    .foregroundStyle(store.problem == nil ? ConchPalette.textDim : ConchPalette.statusNeeds)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(Array(LoginInventory.groups(reply.items).enumerated()), id: \.element.id) { index, group in
                    if index > 0 { SettingsHairline() }
                    LoginGroupBlock(group: group, store: store, cookies: browser.importedCounts)
                }
            }
        }
    }

    private func status(_ reply: LoginInventoryReply) -> String {
        if let problem = store.problem { return problem }
        let checked = LoginInventory.checked(reply.checkedAt)
        return reply.truncated == true ? "\(checked). The list was cut to fit; `conch logins` in Terminal has the same." : "\(checked)."
    }
}

/// One kind's logins: its subheading, what its states can say, its rows in a card, and what isn't installed.
private struct LoginGroupBlock: View {
    let group: LoginInventory.Group
    @ObservedObject var store: LoginInventoryStore
    let cookies: [String: Int]

    private static let browserPrefix = "browser-profile:"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SettingsSubheading(title: group.title) {
                Image(systemName: group.symbol).font(.system(size: 13, weight: .regular))
            }
            Text(LoginInventory.caption(group.kind))
                .foregroundStyle(ConchPalette.textDim)
                .fixedSize(horizontal: false, vertical: true)
            if !group.items.isEmpty {
                OnboardingCard {
                    ForEach(Array(group.items.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { SettingsHairline() }
                        LoginRow(record: item, note: note(for: item), isRefreshing: store.refreshing.contains(item.id)) {
                            Task { await store.refresh(item) }
                        }
                    }
                }
            }
            if !group.notInstalled.isEmpty {
                Text("Not installed: \(group.notInstalled.joined(separator: ", ")).")
                    .foregroundStyle(ConchPalette.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// A browser profile's cookies from the last Chrome import, which this app counted. Counts only.
    private func note(for item: LoginRecord) -> String? {
        guard item.kind == .browserProfile, item.id.hasPrefix(Self.browserPrefix),
              let count = cookies[String(item.id.dropFirst(Self.browserPrefix.count))] else { return nil }
        return "\(count.formatted()) \(count == 1 ? "cookie" : "cookies") from Chrome"
    }
}

/// The inventory as the daemon last answered, and which rows are being checked again.
@MainActor
final class LoginInventoryStore: ObservableObject {
    enum Phase: Equatable {
        case loading
        case loaded(LoginInventoryReply)
        case needsUpdate
        case unreachable
        case failed(String)
    }

    @Published private(set) var phase: Phase = .loading
    /// Rows being checked again, by id.
    @Published private(set) var refreshing: Set<String> = []
    @Published private(set) var isRefreshingAll = false
    /// Why the last ask failed, while the list it had is still shown.
    @Published private(set) var problem: String?

    /// A first look runs every CLI's status command, up to 8 s each, four at a time, and the agents' own.
    private static let timeout: TimeInterval = 45

    func load() async { await send(.list) }

    func refreshAll() async {
        guard !isRefreshingAll else { return }
        isRefreshingAll = true
        await send(.refreshAll)
        isRefreshingAll = false
    }

    func refresh(_ record: LoginRecord) async {
        guard refreshing.insert(record.id).inserted else { return }
        await send(.refresh(record.id))
        refreshing.remove(record.id)
    }

    private struct Refusal: Decodable {
        let kind: String?
        let error: String?
    }

    private func send(_ request: LoginInventoryRequest) async {
        let failure: String
        switch await ConchSocketClient().request(request, timeout: Self.timeout) {
        case .connectFailed:
            guard case .loaded = phase else { phase = .unreachable; return }
            failure = "conch's daemon isn't running, so this is the last list it gave."
        case .timeout:
            failure = "The daemon took too long to check your logins. Try again."
        case let .reply(data):
            if let reply = try? JSONDecoder().decode(LoginInventoryReply.self, from: data), reply.kind == "login-inventory" {
                phase = .loaded(reply)
                problem = nil
                return
            }
            // A daemon from before the inventory answers with a session error of its own; this one's says what failed.
            let refusal = try? JSONDecoder().decode(Refusal.self, from: data)
            guard let error = refusal?.error, error.localizedCaseInsensitiveContains("login") else {
                if case .loaded = phase { problem = "Needs an updated conch daemon" } else { phase = .needsUpdate }
                return
            }
            failure = error
        }
        if case .loaded = phase { problem = failure } else { phase = .failed(failure) }
    }
}
