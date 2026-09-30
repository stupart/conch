import SwiftUI

public struct AccountToolsRequest: Encodable {
    public var kind = "account-tools"
    public var backend: String
    public var accountId: String
    public var action = "list"
    public var requestId: String?
    public var id: String?
    public var source: String?
    public var url: String?
    public var command: String?
    public var args: [String]?
    public var enabled: Bool?
    public init(backend: String, accountId: String) { self.backend = backend; self.accountId = accountId }
}

public struct AccountToolsReply: Decodable {
    public struct Account: Decodable, Identifiable { public let id: String; public let label: String; public let email: String? }
    public struct Item: Decodable, Identifiable {
        public let id: String; public let name: String; public let kind: String
        public let enabled: Bool?; public let managed: Bool; public let detail: String
        public var rowId: String { "\(kind):\(id):\(detail)" }
    }
    public struct LibraryItem: Decodable, Identifiable { public let id: String; public let name: String; public let source: String? }
    public struct Operation: Decodable { public let id: String; public let state: String; public let message: String }
    public let kind: String
    public let backend: String
    public let accountId: String
    public let accounts: [Account]
    public let items: [Item]
    public let library: [LibraryItem]
    public let operation: Operation?
}

/// One account-scoped tools screen shared by Mac and iPhone. Provider CLIs run on the connected Mac.
public struct AccountToolsView: View {
    private let transport: @MainActor (AccountToolsRequest) async throws -> Data
    @Environment(\.colorScheme) private var scheme
    @State private var backend = "claude"
    @State private var accountId = "default"
    @State private var tab = "plugin"
    @State private var reply: AccountToolsReply?
    @State private var busy = false
    @State private var error: String?
    @State private var pluginId = ""
    @State private var marketplace = ""
    @State private var serverName = ""
    @State private var serverURL = ""
    @State private var serverTransport = "http"
    @State private var serverCommand = ""
    @State private var serverArgs = ""
    @State private var removal: AccountToolsReply.Item?

    public init(transport: @escaping @MainActor (AccountToolsRequest) async throws -> Data) { self.transport = transport }
    private var selectionKey: String { "\(backend):\(accountId)" }
    private var foreground: Color { ConchColor.textPrimary.color(scheme) }
    private var secondary: Color { ConchColor.textSecondary.color(scheme) }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Plugins & MCP").font(ConchType.title)
                        Spacer()
                        Button { Task { await perform() } } label: { Image(systemName: "arrow.clockwise") }
                            .accessibilityLabel("Refresh account tools").disabled(busy)
                    }
                    Text("Your tools, for the account you choose.").foregroundStyle(secondary)
                }
                VStack(alignment: .leading, spacing: 12) {
                    Picker("Provider", selection: Binding(get: { backend }, set: { backend = $0; accountId = "default"; reply = nil })) {
                        Text("Claude Code").tag("claude")
                        Text("Codex").tag("codex")
                    }.pickerStyle(.segmented)
                    HStack(spacing: 12) {
                        Image(backend == "claude" ? "AgentClaude" : "AgentCodex").resizable().scaledToFit().frame(width: 25, height: 25)
                        Picker("Account", selection: $accountId) {
                            if reply?.accounts.isEmpty != false { Text("Default").tag("default") }
                            ForEach(reply?.accounts ?? []) { account in
                                Text(account.email.map { "\($0) · \(account.label)" } ?? account.label).tag(account.id)
                            }
                        }
                    }
                    #if os(iOS)
                    Label("Changes apply on your connected Mac", systemImage: "desktopcomputer").font(.caption).foregroundStyle(secondary)
                    #endif
                }.disabled(busy)
                if busy { HStack { ProgressView().controlSize(.small); Text("Updating account tools…").foregroundStyle(secondary) } }
                if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                if let operation = reply?.operation, operation.state != "working" {
                    Text(operation.message).foregroundStyle(operation.state == "failed" ? .red : secondary).textSelection(.enabled)
                }
                Picker("Tools", selection: $tab) {
                    Text("Plugins").tag("plugin")
                    Text("MCP servers").tag("mcp-server")
                    Text("Skills").tag("skill")
                }.pickerStyle(.segmented)
                VStack(alignment: .leading, spacing: 14) {
                    let items = reply?.items.filter { $0.kind == tab } ?? []
                    if items.isEmpty { Text(tab == "skill" ? "No skills found for this account." : "Nothing added yet.").foregroundStyle(secondary).padding(.vertical, 8) }
                    ForEach(items, id: \.rowId) { item in itemRow(item) }
                }
                if tab == "plugin" { pluginLibrary }
                if tab == "mcp-server" { mcpForm }
                Text(tab == "skill" ? "Skills included in plugins appear here. Install or enable their plugin to use them in this account."
                     : backend == "claude" ? "Changes apply to new sessions. In a running Claude session, use /reload-plugins for plugins or /mcp to connect a server."
                     : "Changes apply to new Codex sessions. Restart an existing session to load updated tools. Servers may open a browser for sign-in.")
                    .font(.caption).foregroundStyle(secondary)
            }.font(ConchType.secondary).padding(24).frame(maxWidth: 720, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(foreground).background(ConchColor.ground.color(scheme))
        .task(id: selectionKey) { await perform() }
        .confirmationDialog("Remove \(removal?.name ?? "tool") from this account?", isPresented: Binding(get: { removal != nil }, set: { if !$0 { removal = nil } }), titleVisibility: .visible) {
            if let item = removal {
                Button("Remove", role: .destructive) { Task { await perform(action: item.kind == "plugin" ? "remove-plugin" : "remove-mcp", id: item.id) } }
            }
            Button("Cancel", role: .cancel) { removal = nil }
        }
    }

    private func itemRow(_ item: AccountToolsReply.Item) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: item.kind == "plugin" ? "puzzlepiece.extension" : item.kind == "skill" ? "sparkles" : "server.rack").frame(width: 20).foregroundStyle(secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.name).fontWeight(.medium).textSelection(.enabled)
                Text(item.detail).font(.caption).foregroundStyle(secondary).textSelection(.enabled)
                if let enabled = item.enabled { Text(enabled ? "Enabled for new sessions" : "Disabled").font(.caption).foregroundStyle(secondary) }
            }
            Spacer(minLength: 4)
            if !item.managed {
                Menu {
                    if item.kind == "plugin" || backend == "codex" {
                        Button(item.enabled == false ? "Enable" : "Disable") {
                            Task { await perform(action: item.kind == "plugin" ? "toggle-plugin" : "toggle-mcp", id: item.id, enabled: item.enabled == false) }
                        }
                    }
                    Button("Remove…", role: .destructive) { removal = item }
                } label: { Image(systemName: "ellipsis").frame(width: 28, height: 24) }
                .disabled(busy).accessibilityLabel("Manage \(item.name)")
            }
        }.padding(14).background(ConchColor.surface.color(scheme), in: RoundedRectangle(cornerRadius: 10))
    }

    private var pluginLibrary: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Available to add").fontWeight(.semibold)
            ForEach(reply?.library.filter { plugin in !(reply?.items.contains { $0.kind == "plugin" && $0.id == plugin.id } ?? false) } ?? []) { plugin in
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(plugin.name).fontWeight(.medium)
                        Text(plugin.id).font(.caption).foregroundStyle(secondary)
                    }
                    Spacer()
                    Button("Install") { Task { await perform(action: "install-plugin", id: plugin.id, source: plugin.source) } }.disabled(busy)
                }
            }
            DisclosureGroup("Add another plugin") {
                VStack(alignment: .leading, spacing: 10) {
                    TextField("name@marketplace", text: $pluginId).textFieldStyle(.roundedBorder)
                    TextField("Marketplace folder or owner/repository (optional)", text: $marketplace).textFieldStyle(.roundedBorder)
                    Text("Enter a marketplace source, without /plugin commands. On iPhone, folder paths refer to your Mac.").font(.caption).foregroundStyle(secondary)
                    Button("Install plugin") { Task { await perform(action: "install-plugin", id: pluginId.trimmingCharacters(in: .whitespacesAndNewlines), source: marketplace.isEmpty ? nil : marketplace.trimmingCharacters(in: .whitespacesAndNewlines)) } }
                        .disabled(busy || pluginId.isEmpty)
                }.padding(.top, 10)
            }
        }
    }

    private var mcpForm: some View {
        DisclosureGroup("Add MCP server") {
            VStack(alignment: .leading, spacing: 10) {
                TextField("Server name", text: $serverName).textFieldStyle(.roundedBorder)
                Picker("Connection", selection: $serverTransport) {
                    Text("HTTP URL").tag("http")
                    Text("Local command").tag("stdio")
                }.pickerStyle(.segmented)
                if serverTransport == "http" {
                    TextField("https://example.com/mcp", text: $serverURL).textFieldStyle(.roundedBorder)
                } else {
                    TextField("Executable (e.g. npx)", text: $serverCommand).textFieldStyle(.roundedBorder)
                    TextField("Arguments, one per line", text: $serverArgs, axis: .vertical).lineLimit(3...6).textFieldStyle(.roundedBorder)
                    Text("Runs on your Mac. Enter arguments without shell quotes; each line is passed as one argument.").font(.caption).foregroundStyle(secondary)
                }
                Button("Add server") { Task { await perform(action: "add-mcp", id: serverName.trimmingCharacters(in: .whitespacesAndNewlines),
                    url: serverTransport == "http" ? serverURL.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
                    command: serverTransport == "stdio" ? serverCommand.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
                    args: serverTransport == "stdio" ? serverArgs.split(separator: "\n").map(String.init) : nil) } }
                    .disabled(busy || serverName.isEmpty || (serverTransport == "http" ? serverURL.isEmpty : serverCommand.isEmpty))
            }.padding(.top, 10)
        }
    }

    @MainActor private func perform(action: String = "list", id: String? = nil, source: String? = nil, url: String? = nil, command: String? = nil, args: [String]? = nil, enabled: Bool? = nil) async {
        let key = selectionKey
        var request = AccountToolsRequest(backend: backend, accountId: accountId)
        request.action = action; request.id = id; request.source = source; request.url = url; request.enabled = enabled
        request.command = command; request.args = args
        if action != "list" { request.requestId = UUID().uuidString }
        busy = true; error = nil
        defer { if key == selectionKey { busy = false } }
        do {
            while true {
                try Task.checkCancellation()
                let data = try await transport(request)
                struct Failure: Decodable { let error: String }
                if let failure = try? JSONDecoder().decode(Failure.self, from: data) { throw NSError(domain: "ConchTools", code: 1, userInfo: [NSLocalizedDescriptionKey: failure.error]) }
                let result = try JSONDecoder().decode(AccountToolsReply.self, from: data)
                guard key == selectionKey else { return }
                guard result.kind == "account-tools", result.backend == backend, result.accountId == accountId else { throw NSError(domain: "ConchTools", code: 2, userInfo: [NSLocalizedDescriptionKey: "The response was for a different account. Refresh to check this account."]) }
                reply = result
                if result.operation?.state != "working" { return }
                try await Task.sleep(for: .seconds(2))
                request = AccountToolsRequest(backend: backend, accountId: accountId)
            }
        } catch is CancellationError { }
        catch { if key == selectionKey { self.error = "\(error.localizedDescription) If an update was already started, it may still be running. Refresh to check before trying again." } }
    }
}
