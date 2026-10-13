import SwiftUI

/// conch's logins inventory (src/login-inventory.ts, 2026-10-14): which CLIs, agents, MCP servers, plugins and browser
/// profiles this Mac has, and which are signed in, as whom. Read only: nothing here signs in or out.
///
/// The daemon reads it and keeps it a few minutes; Settings › Logins shows it a block per kind, each row with its tool,
/// its account, its state and a Refresh.

/// `{ kind: "login-inventory", action: "list" | "refresh", id? }`. With an id, only that row's source is read again.
public struct LoginInventoryRequest: Encodable, Equatable, Sendable {
    public var kind = "login-inventory"
    public var action: String
    public var id: String?

    public static let list = LoginInventoryRequest(action: "list")
    public static let refreshAll = LoginInventoryRequest(action: "refresh")
    public static func refresh(_ id: String) -> LoginInventoryRequest { LoginInventoryRequest(action: "refresh", id: id) }

    public init(action: String, id: String? = nil) {
        self.action = action
        self.id = id
    }
}

/// One login: a CLI's, an agent profile's, an MCP server's or plugin's, or a browser profile.
public struct LoginRecord: Decodable, Identifiable, Equatable, Sendable {
    public enum Kind: String, Decodable, CaseIterable, Sendable {
        case agent, cli, browserProfile = "browser-profile", mcp, plugin
        /// A kind from a newer daemon: not shown.
        case other

        public init(from decoder: Decoder) throws {
            self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
        }
    }

    public enum State: String, Decodable, Sendable {
        case signedIn = "signed-in", signedOut = "signed-out", expired, unknown

        /// A state from a newer daemon reads as unknown.
        public init(from decoder: Decoder) throws {
            self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }

        public var title: String {
            switch self {
            case .signedIn: "Signed in"
            case .signedOut: "Signed out"
            case .expired: "Expired"
            case .unknown: "Unknown"
            }
        }
    }

    public let id: String
    public let kind: Kind
    public let tool: String
    public let installed: Bool
    public let state: State
    public let account: String?
    public let scope: String?
    public let configDir: String?
    public let via: String?
    public let transport: String?
    /// Epoch milliseconds.
    public let checkedAt: Double
    public let detail: String?

    public init(id: String, kind: Kind, tool: String, installed: Bool = true, state: State, account: String? = nil,
                scope: String? = nil, configDir: String? = nil, via: String? = nil, transport: String? = nil,
                checkedAt: Double = 0, detail: String? = nil) {
        self.id = id
        self.kind = kind
        self.tool = tool
        self.installed = installed
        self.state = state
        self.account = account
        self.scope = scope
        self.configDir = configDir
        self.via = via
        self.transport = transport
        self.checkedAt = checkedAt
        self.detail = detail
    }

    /// Where it is, under the tool's name: the agent profile it belongs to, its scope, its transport, then what the
    /// daemon said of it.
    public var secondaryLine: String? {
        let parts = [via, scope, transport, detail].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// The daemon's answer.
public struct LoginInventoryReply: Decodable, Equatable, Sendable {
    public let kind: String
    public let items: [LoginRecord]
    /// Epoch milliseconds of the last full read.
    public let checkedAt: Double
    /// The list was cut to fit one control frame.
    public let truncated: Bool?

    public init(items: [LoginRecord], checkedAt: Double, truncated: Bool? = nil) {
        kind = "login-inventory"
        self.items = items
        self.checkedAt = checkedAt
        self.truncated = truncated
    }
}

public enum LoginInventory {
    /// One kind's block in Settings › Logins.
    public struct Group: Identifiable, Equatable, Sendable {
        public let kind: LoginRecord.Kind
        /// Installed, in the daemon's order.
        public let items: [LoginRecord]
        /// Tools conch looks for that aren't on this Mac, named once under the block.
        public let notInstalled: [String]

        public var id: LoginRecord.Kind { kind }
        public var title: String { LoginInventory.title(kind) }
        public var symbol: String { LoginInventory.symbol(kind) }
    }

    /// The blocks, in the order the daemon sorts them: agents, CLIs, browser profiles, MCP servers, plugins. A kind with
    /// nothing in it has no block.
    public static let order: [LoginRecord.Kind] = [.agent, .cli, .browserProfile, .mcp, .plugin]

    public static func groups(_ items: [LoginRecord]) -> [Group] {
        order.compactMap { kind in
            let all = items.filter { $0.kind == kind }
            guard !all.isEmpty else { return nil }
            return Group(kind: kind, items: all.filter(\.installed), notInstalled: all.filter { !$0.installed }.map(\.tool))
        }
    }

    public static func title(_ kind: LoginRecord.Kind) -> String {
        switch kind {
        case .agent: "Agents"
        case .cli: "CLIs"
        case .browserProfile: "Browser profiles"
        case .mcp: "MCP servers"
        case .plugin: "Plugins"
        case .other: "Other"
        }
    }

    public static func symbol(_ kind: LoginRecord.Kind) -> String {
        switch kind {
        case .agent: "sparkles"
        case .cli: "terminal"
        case .browserProfile: "globe"
        case .mcp: "server.rack"
        case .plugin: "puzzlepiece.extension"
        case .other: "questionmark.circle"
        }
    }

    /// One line under a block: what each kind's state can and can't say.
    public static func caption(_ kind: LoginRecord.Kind) -> String {
        switch kind {
        case .agent: "Each Claude Code and Codex profile, signed in as whom."
        case .cli: "Read with each CLI's own status command, which never asks for anything."
        case .browserProfile: "conch's browser profiles. Who each is signed in as stays in its cookies."
        case .mcp: "Signed out when the agent recorded that a server asked it to sign in. Otherwise its token is the agent's, unread."
        case .plugin: "Plugins sign in through their MCP servers."
        case .other: ""
        }
    }

    /// The colour of a state's word.
    public static func color(_ state: LoginRecord.State) -> ConchColorToken {
        switch state {
        case .signedIn: ConchColor.added
        case .signedOut: ConchColor.textSecondary
        case .expired: ConchColor.attention
        case .unknown: ConchColor.textTertiary
        }
    }

    /// "Checked 3 min ago", from epoch milliseconds.
    public static func checked(_ checkedAt: Double, now: Date = Date()) -> String {
        let minutes = Int((now.timeIntervalSince1970 * 1000 - checkedAt) / 60_000)
        if minutes < 1 { return "Checked just now" }
        if minutes < 60 { return "Checked \(minutes) min ago" }
        let hours = minutes / 60
        return hours < 48 ? "Checked \(hours) h ago" : "Checked \(hours / 24) days ago"
    }
}

/// A login's row in Settings › Logins: its tool and where it is, its account, its state, and a Refresh. Laid out as the
/// Browser section's rows are (16 points in, 11 down), with the account and state in columns of their own so a block
/// reads as a table.
public struct LoginRow: View {
    public static let accountWidth: CGFloat = 190
    public static let stateWidth: CGFloat = 72

    let record: LoginRecord
    /// Under the tool, in place of what the daemon said: the cookies a Chrome import put in a browser profile.
    let note: String?
    let isRefreshing: Bool
    let onRefresh: () -> Void

    public init(record: LoginRecord, note: String? = nil, isRefreshing: Bool = false, onRefresh: @escaping () -> Void) {
        self.record = record
        self.note = note
        self.isRefreshing = isRefreshing
        self.onRefresh = onRefresh
    }

    public var body: some View {
        HStack(alignment: .center, spacing: ConchSpace.x3) {
            VStack(alignment: .leading, spacing: 2) {
                Text(record.tool)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(ConchColor.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let line = note ?? record.secondaryLine {
                    Text(line)
                        .font(.system(size: 11))
                        .foregroundStyle(ConchColor.textSecondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)

            Text(record.account ?? "—")
                .font(.system(size: 11.5))
                .foregroundStyle(record.account == nil ? ConchColor.textTertiary : ConchColor.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(width: Self.accountWidth, alignment: .leading)
                .textSelection(.enabled)
                .help(record.account ?? "No account known")

            Text(record.state.title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(LoginInventory.color(record.state))
                .lineLimit(1)
                .frame(width: Self.stateWidth, alignment: .leading)

            ZStack {
                if isRefreshing {
                    ProgressView().controlSize(.small)
                } else {
                    Button(action: onRefresh) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(ConchColor.textSecondary)
                            .frame(width: 22, height: 22)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Check again")
                    .accessibilityLabel("Check \(record.tool) again")
                }
            }
            .frame(width: 22, height: 22)
        }
        .padding(.horizontal, ConchSpace.x4)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
