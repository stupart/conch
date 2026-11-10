import AppKit
import ConchDesign
import SwiftUI
import UniformTypeIdentifiers

/// Settings › Phone app › Notifications (daemon notify-user.ts, 2026-11-10, Tyler: "we should also add a way for me to let
/// sessions send me messages on my phone via conch that ping and show notification").
///
/// The Mac shows a notice with nothing set up. The iPhone needs Apple to deliver it, and Apple delivers for whoever holds
/// an APNs auth key for the app's team: Tyler makes one in his Apple Developer account and gives it to conch here. The
/// key goes once over the daemon's local socket (`push-setup`, which the phone bridge refuses) and into this Mac's
/// Keychain (push-key.ts); it is never kept here, published, logged or put in UserDefaults, and nothing here shows it.
@MainActor
final class PushSettingsStore: ObservableObject {
    @Published private(set) var status: PushSetupStatus?
    @Published private(set) var busy = false
    @Published var error: String?
    @Published var notice: String?
    private let client = ConchSocketClient()

    func load() async { _ = await send(action: "status") }

    /// The ids and the key to the daemon, which writes the key to the Keychain. True once it's saved.
    func set(keyId: String, teamId: String, key: String) async -> Bool {
        guard await send(action: "set", keyId: keyId, teamId: teamId, key: key, timeout: 100) != nil else { return false }
        notice = "Saved. Send a test once conch on your iPhone has notifications turned on."
        return true
    }

    func remove() async {
        if await send(action: "remove", timeout: 100) != nil {
            notice = "Removed. The Mac still shows notices; the iPhone gets none until a key is set up again."
        }
    }

    func test() async {
        // Apple's answer for each phone, after the key is read from the Keychain.
        if let reply = await send(action: "test", timeout: 40), let test = reply.test {
            notice = test.said
        }
    }

    private func send(action: String, keyId: String? = nil, teamId: String? = nil, key: String? = nil,
                      timeout: TimeInterval = 10) async -> PushSetupStatus? {
        struct Request: Encodable {
            let kind = "push-setup"
            let action: String
            let keyId: String?
            let teamId: String?
            /// `set` only. Encoded straight onto the socket; this struct lives as long as the request does.
            let key: String?
        }
        struct Failure: Decodable { let error: String? }
        busy = true
        error = nil
        if action != "status" { notice = nil }
        defer { busy = false }
        switch await client.request(Request(action: action, keyId: keyId, teamId: teamId, key: key), timeout: timeout) {
        case let .reply(data):
            if let reply = try? JSONDecoder().decode(PushSetupStatus.self, from: data) {
                status = reply
                return reply
            }
            // The daemon's own words: none of them repeats a key (push-key.ts).
            error = (try? JSONDecoder().decode(Failure.self, from: data))?.error ?? "Notifications need an updated conch daemon."
        case .connectFailed:
            error = "Start the conch daemon to set up notifications."
        case .timeout:
            error = "The daemon did not reply. Refresh before trying again."
        }
        return nil
    }
}

struct PushSettingsSection: View {
    @StateObject private var store = PushSettingsStore()
    /// The app's store, for its one door to a link (`openLink`, A13).
    @EnvironmentObject private var app: StateStore
    @State private var settingUp = false
    @State private var removing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsSubheading(title: "Notifications")
            Text("Sessions can ping you when you ask them to, and conch tells you when a Claude account needs signing in again. "
                 + "The Mac shows them as they are. Your iPhone gets them through Apple, even with conch closed there, once an APNs key from your Apple Developer account is set up here.")
                .font(.callout).foregroundStyle(ConchPalette.textDim)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                Circle()
                    .fill(dotColor)
                    .frame(width: 8, height: 8)
                Text(store.status?.statusLine ?? (store.busy ? "Reading…" : "Push: unknown"))
                    .font(ConchTypography.font(size: 12.5, weight: .medium))
                    .foregroundStyle(store.status?.troubled == true ? ConchPalette.statusNeeds : ConchPalette.textPrimary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if store.busy { ProgressView().controlSize(.small) }
            }

            if let key = store.status?.key {
                Text("Key \(key.keyId) · Team \(key.teamId) · added \(Date(timeIntervalSince1970: key.addedAt / 1000).formatted(date: .abbreviated, time: .omitted))")
                    .font(.caption.monospaced()).foregroundStyle(ConchPalette.textDim)
                    .textSelection(.enabled)
            }
            ForEach(Array((store.status?.devices ?? []).enumerated()), id: \.offset) { _, device in
                Text(deviceLine(device))
                    .font(.caption).foregroundStyle(device.lastError == nil ? ConchPalette.textDim : ConchPalette.statusNeeds)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let notice = store.notice {
                Text(notice).font(.callout).foregroundStyle(ConchPalette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            if let error = store.error {
                Text(error).font(.callout).foregroundStyle(ConchPalette.statusNeeds)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }

            HStack(spacing: 10) {
                Button(store.status?.key == nil ? "Set up…" : "Replace key…") { settingUp = true }
                if store.status?.key != nil {
                    Button("Send a test") { Task { await store.test() } }
                        .help("A notification to every iPhone that has turned conch's notifications on")
                    Button("Remove…", role: .destructive) { removing = true }
                }
            }
            .disabled(store.busy)
        }
        .task { await store.load() }
        .sheet(isPresented: $settingUp) {
            PushKeySheet(store: store, openKeys: { failed in
                app.openLink(PushKeySheet.keysPage, cwd: nil, rowId: nil, onFailure: failed)
            }) { settingUp = false }
        }
        .alert("Remove the APNs key?", isPresented: $removing) {
            Button("Remove", role: .destructive) { Task { await store.remove() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It's deleted from this Mac's Keychain, and your iPhone gets no notices until a key is set up again. The key itself stays in your Apple Developer account.")
        }
    }

    private var dotColor: Color {
        guard let status = store.status, status.key != nil else { return ConchPalette.textDim }
        return status.troubled ? ConchPalette.statusNeeds : (status.listening.isEmpty ? ConchPalette.statusWaiting : ConchPalette.brandCyan)
    }

    private func deviceLine(_ device: PushSetupStatus.Device) -> String {
        var parts = [device.device, device.environment == "development" ? "development build" : "release build", "token \(device.token)"]
        if !device.alerts { parts.append("notifications off on the phone") }
        if let sent = device.lastSentAt {
            parts.append("last sent \(Date(timeIntervalSince1970: sent / 1000).formatted(date: .abbreviated, time: .shortened))")
        }
        if let error = device.lastError { parts.append(error) }
        return parts.joined(separator: " · ")
    }
}

/// Setting the key up, in the order Apple's pages go: make the key, then give conch its file, its Key ID and the Team ID.
/// The key lives in this sheet's state until Save, which sends it and clears it; nothing else ever sees it.
private struct PushKeySheet: View {
    /// The team that signs conch's iPhone app (mobile/conch-ios's DEVELOPMENT_TEAM): an APNs key works only for its own
    /// team's apps. Filled in, and editable for a phone app built by another team.
    static let iPhoneAppTeam = "5DRS8F56M2"
    /// Certificates, Identifiers & Profiles › Keys.
    static let keysPage = "https://developer.apple.com/account/resources/authkeys/list"

    @ObservedObject var store: PushSettingsStore
    /// Apple's Keys page, through the app's door; a failure is said in the sheet.
    let openKeys: (@escaping @MainActor (String) -> Void) -> Void
    let onClose: () -> Void
    @State private var keyId = ""
    @State private var teamId = PushKeySheet.iPhoneAppTeam
    @State private var key = ""
    @State private var chosenFile: String?
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Set up iPhone notifications").font(ConchTypography.font(size: 17, weight: .medium))
            VStack(alignment: .leading, spacing: 8) {
                Text("1. Make a key").font(ConchTypography.font(size: 13, weight: .medium))
                Text("In your Apple Developer account, Certificates, Identifiers & Profiles › Keys › +: name it, tick Apple Push Notifications service (APNs), then Continue and Register. Download the .p8 file (Apple lets you download it once) and note its Key ID.")
                    .font(ConchTypography.font(size: 12)).foregroundStyle(ConchPalette.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Open Apple Developer › Keys") {
                    openKeys { problem = $0 }
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("2. Give it to conch").font(ConchTypography.font(size: 13, weight: .medium))
                HStack(spacing: 10) {
                    Button(chosenFile == nil ? "Choose the .p8 file…" : "Choose another…") { choose() }
                    if let chosenFile {
                        Text(chosenFile).font(.caption.monospaced()).foregroundStyle(ConchPalette.textDim).lineLimit(1)
                    }
                }
                SecureField("…or paste the key", text: $key).textFieldStyle(.roundedBorder)
                    .onChange(of: key) { _, pasted in
                        if !pasted.isEmpty, chosenFile != nil, PushKeyInput.key(pasted) != nil { chosenFile = nil }
                    }
                HStack(spacing: 10) {
                    TextField("Key ID", text: $keyId).textFieldStyle(.roundedBorder)
                    TextField("Team ID", text: $teamId).textFieldStyle(.roundedBorder)
                }
                Text("Kept in this Mac's Keychain, and read only by conch to sign what it sends Apple.")
                    .font(ConchTypography.font(size: 11)).foregroundStyle(ConchPalette.textDim)
            }
            if let problem = problem ?? store.error {
                Text(problem).font(ConchTypography.font(size: 12)).foregroundStyle(ConchPalette.statusNeeds)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button("Cancel") { close() }.keyboardShortcut(.cancelAction)
                Spacer()
                if store.busy { ProgressView().controlSize(.small) }
                Button("Save") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(store.busy || key.isEmpty || keyId.isEmpty || teamId.isEmpty)
            }
        }
        .padding(24)
        .frame(width: 480)
        .background(ConchPalette.bg)
        .onDisappear { key = "" }
    }

    /// The file's text into the field (never shown), and its Key ID from the name Apple gives it.
    private func choose() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [UTType(filenameExtension: "p8") ?? .data]
        panel.message = "Choose the AuthKey_<Key ID>.p8 file Apple gave you"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard let text = try? String(contentsOf: url, encoding: .utf8), PushKeyInput.key(text) != nil else {
            problem = PushKeyInput.keyProblem
            return
        }
        problem = nil
        key = text
        chosenFile = url.lastPathComponent
        if let fromName = PushKeyInput.keyID(fromFileName: url.lastPathComponent) { keyId = fromName }
    }

    private func save() {
        problem = nil
        guard let checkedKeyID = PushKeyInput.appleID(keyId) else { problem = PushKeyInput.keyIDProblem; return }
        guard let checkedTeamID = PushKeyInput.appleID(teamId) else { problem = PushKeyInput.teamIDProblem; return }
        // Sent once and cleared at once, whatever the daemon says.
        let given = key
        key = ""
        guard let checkedKey = PushKeyInput.key(given) else {
            problem = PushKeyInput.keyProblem
            chosenFile = nil
            return
        }
        Task {
            if await store.set(keyId: checkedKeyID, teamId: checkedTeamID, key: checkedKey) {
                close()
            } else {
                chosenFile = nil
            }
        }
    }

    private func close() {
        key = ""
        onClose()
    }
}
