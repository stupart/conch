import Foundation
import SwiftUI

// Settings › Failures (2026-10-28, docs/failure-tickets.md): every time an agent or conch let Tyler down, one ticket per
// kind of failure, from the daemon's desk (src/failure-tickets.ts), and a Fix that starts a Claude session on it.
//
// Tyler, right after an Allow he tapped never reached its session: "there should prob be a loop where a ticket is opened
// for any agent fail or something". The list is the Mac's alone, asked for over the socket (`failure-tickets`); the
// published state carries only its counts (`failures`), for the gear's dot.

// MARK: - What the daemon sends

/// A request to the daemon's desk, as the socket takes it.
public enum FailureTicketsRequest: Encodable, Equatable, Sendable {
    /// The list (`{kind: "failure-tickets"}`).
    case list
    /// One of the actions on a ticket, or `seen` on `all` (`{kind: "failure-ticket", id, action}`).
    case act(id: String, action: FailureTicketAction)
    /// The `failure-autofix` setting, through the daemon's own settings (`{kind: "set-config"}`).
    case setAutoFix(Bool)

    private enum Keys: String, CodingKey { case kind, id, action, key, value }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        switch self {
        case .list:
            try container.encode("failure-tickets", forKey: .kind)
        case let .act(id, action):
            try container.encode("failure-ticket", forKey: .kind)
            try container.encode(id, forKey: .id)
            try container.encode(action.rawValue, forKey: .action)
        case let .setAutoFix(on):
            try container.encode("set-config", forKey: .kind)
            try container.encode("failure-autofix", forKey: .key)
            try container.encode(on, forKey: .value)
        }
    }
}

public enum FailureTicketAction: String, Sendable, Equatable {
    case fix, ignore, reopen, show, seen
    case markFixed = "mark-fixed"
}

public enum FailureTicketStatus: String, Decodable, Sendable, Equatable {
    case open, fixing, fixed, ignored
}

/// A fix's PR, found by the desk by its branch.
public struct FailureTicketPR: Decodable, Equatable, Sendable {
    public let url: String
    public let number: Int?
    /// "open", "merged" or "closed".
    public let state: String

    public init(url: String, number: Int? = nil, state: String) {
        self.url = url
        self.number = number
        self.state = state
    }
}

public struct FailureTicketFix: Decodable, Equatable, Sendable {
    /// "you" or "auto".
    public let by: String
    public let startedAt: Double
    public let backgroundId: String?
    public let branch: String
    public let pr: FailureTicketPR?

    public init(by: String, startedAt: Double, backgroundId: String? = nil, branch: String, pr: FailureTicketPR? = nil) {
        self.by = by
        self.startedAt = startedAt
        self.backgroundId = backgroundId
        self.branch = branch
        self.pr = pr
    }
}

/// A ticket as the list carries it: everything but its evidence, which `show` brings (`FailureTicketDetail`).
public struct FailureTicketSummary: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let number: Int
    public let origin: String
    public let operation: String
    public let title: String
    public let status: FailureTicketStatus
    public let statusAt: Double
    public let note: String?
    public let firstSeen: Double
    public let lastSeen: Double
    public let count: Int
    public let sessionCount: Int
    public let unseen: Bool
    public let fix: FailureTicketFix?
    public let fixedAt: Double?
    public let reopened: Int?

    public init(
        id: String, number: Int, origin: String, operation: String, title: String, status: FailureTicketStatus,
        statusAt: Double, note: String? = nil, firstSeen: Double, lastSeen: Double, count: Int, sessionCount: Int,
        unseen: Bool, fix: FailureTicketFix? = nil, fixedAt: Double? = nil, reopened: Int? = nil
    ) {
        self.id = id
        self.number = number
        self.origin = origin
        self.operation = operation
        self.title = title
        self.status = status
        self.statusAt = statusAt
        self.note = note
        self.firstSeen = firstSeen
        self.lastSeen = lastSeen
        self.count = count
        self.sessionCount = sessionCount
        self.unseen = unseen
        self.fix = fix
        self.fixedAt = fixedAt
        self.reopened = reopened
    }
}

public struct FailureTicketList: Decodable, Equatable, Sendable {
    public struct AutoFix: Decodable, Equatable, Sendable {
        public let on: Bool
        public let today: Int
        public let cap: Int

        public init(on: Bool, today: Int, cap: Int) {
            self.on = on
            self.today = today
            self.cap = cap
        }
    }

    /// Where a fix would work, or why there is nowhere (a Homebrew install has no checkout to open a PR from).
    public struct FixPlace: Decodable, Equatable, Sendable {
        public let available: Bool
        public let folder: String?
        public let reason: String?

        public init(available: Bool, folder: String? = nil, reason: String? = nil) {
            self.available = available
            self.folder = folder
            self.reason = reason
        }
    }

    public let kind: String
    public let tickets: [FailureTicketSummary]
    /// Left out to fit one frame: the oldest, the fixed and the ignored go first.
    public let hidden: Int?
    public let autoFix: AutoFix
    public let fix: FixPlace

    public init(tickets: [FailureTicketSummary], hidden: Int? = nil, autoFix: AutoFix, fix: FixPlace) {
        self.kind = "failure-tickets"
        self.tickets = tickets
        self.hidden = hidden
        self.autoFix = autoFix
        self.fix = fix
    }
}

/// A ticket whole, as `show` sends it: its newest occurrence and the sessions it happened in.
public struct FailureTicketDetail: Decodable, Equatable, Sendable {
    public struct Example: Decodable, Equatable, Sendable {
        public let at: Double
        public let message: String
        public let sessionId: String?
        public let label: String?
        /// The record's state, as JSON, bounded by the daemon.
        public let state: String?

        public init(at: Double, message: String, sessionId: String? = nil, label: String? = nil, state: String? = nil) {
            self.at = at
            self.message = message
            self.sessionId = sessionId
            self.label = label
            self.state = state
        }
    }

    public struct Session: Decodable, Equatable, Sendable {
        public let id: String
        public let label: String?

        public init(id: String, label: String? = nil) {
            self.id = id
            self.label = label
        }
    }

    public let id: String
    public let example: Example
    public let sessions: [Session]

    public init(id: String, example: Example, sessions: [Session]) {
        self.id = id
        self.example = example
        self.sessions = sessions
    }
}

/// The daemon's answer to an action: the ticket, an acknowledgement, or why not.
struct FailureTicketReply: Decodable {
    let kind: String
    let ticket: FailureTicketDetail?
    let error: String?
}

// MARK: - How it reads

/// The words and grouping Settings › Failures shows: pure, so they are tested rather than looked at.
public enum FailureTickets {
    /// A ticket's title with the signature's placeholders said as words: the title is what is the same every time, so
    /// "Couldn't find <file>" reads "Couldn't find a file".
    /// An MCP tool's error starts in lower case ("the target is on the page…"); a title starts with a capital, except
    /// conch's own name, which never takes one.
    public static func displayTitle(_ title: String) -> String {
        var text = title
        for (placeholder, words) in [("<file>", "a file"), ("<path>", "a path"), ("<url>", "a link"), ("<id>", "…"), ("<n>", "N")] {
            text = text.replacingOccurrences(of: placeholder, with: words)
        }
        guard let first = text.first, first.isLowercase, !text.hasPrefix("conch") else { return text }
        return first.uppercased() + text.dropFirst()
    }

    /// How long ago, in the ledger's short words: "now", "5m", "2h", "3d".
    public static func ago(_ ms: Double, now: Date) -> String {
        let minutes = max(0, Int((now.timeIntervalSince1970 * 1_000 - ms) / 60_000))
        if minutes < 1 { return "now" }
        if minutes < 60 { return "\(minutes)m" }
        if minutes < 48 * 60 { return "\(minutes / 60)h" }
        return "\(minutes / 1_440)d"
    }

    /// The line under a ticket's title: its number, where it came from, how often, in how many sessions, how recently.
    public static func meta(_ ticket: FailureTicketSummary, now: Date) -> String {
        let times = ticket.count == 1 ? "once" : "\(ticket.count) times"
        let sessions = ticket.sessionCount > 1 ? " in \(ticket.sessionCount) sessions" : ""
        let last = ago(ticket.lastSeen, now: now)
        return "#\(ticket.number) · \(ticket.origin) · \(ticket.operation) · \(times)\(sessions) · \(last == "now" ? "just now" : "\(last) ago")"
    }

    /// Where a ticket's fix stands, for the right of its row: nil for an open one, which has Fix there instead.
    public static func standing(_ ticket: FailureTicketSummary, now: Date) -> String? {
        switch ticket.status {
        case .open:
            return nil
        case .fixing:
            if let pr = ticket.fix?.pr { return "PR \(pr.number.map { "#\($0)" } ?? "open")" }
            return "Fixing"
        case .fixed:
            return ticket.fix?.pr?.number.map { "Fixed · #\($0)" } ?? "Fixed"
        case .ignored:
            return "Ignored"
        }
    }

    /// One sentence about the fix, in the open ticket: who started it, when, on which branch, and its PR.
    public static func fixLine(_ fix: FailureTicketFix, now: Date) -> String {
        let who = fix.by == "auto" ? "Auto-fix started a session" : "You started a fix session"
        let pr = fix.pr.map { pr in " · PR \(pr.number.map { "#\($0)" } ?? "") \(pr.state)".replacingOccurrences(of: "  ", with: " ") } ?? " · no PR yet"
        return "\(who) \(ago(fix.startedAt, now: now)) ago on \(fix.branch)\(pr)"
    }

    /// The auto-fix switch's line: what it does when on, and how much of today's allowance is gone.
    public static func autoFixCaption(_ autoFix: FailureTicketList.AutoFix) -> String {
        let rule = "conch starts a fix session for a ticket as it opens: one at a time, at most \(autoFix.cap) a day. You still review and merge every PR."
        guard autoFix.on else { return "Off. When on, \(rule)" }
        return "On: \(rule) \(autoFix.today) of \(autoFix.cap) used today."
    }

    public struct Group: Identifiable, Equatable, Sendable {
        public let status: FailureTicketStatus
        public let tickets: [FailureTicketSummary]
        public var id: FailureTicketStatus { status }

        public var title: String {
            switch status {
            case .open: "Open"
            case .fixing: "Being fixed"
            case .fixed: "Fixed"
            case .ignored: "Ignored"
            }
        }

        public var symbol: String {
            switch status {
            case .open: "exclamationmark.circle"
            case .fixing: "hammer"
            case .fixed: "checkmark.circle"
            case .ignored: "eye.slash"
            }
        }
    }

    /// The tickets by status, in the order they are dealt with; within each, the most recent first. Empty groups go.
    public static func groups(_ tickets: [FailureTicketSummary]) -> [Group] {
        let order: [FailureTicketStatus] = [.open, .fixing, .fixed, .ignored]
        return order.compactMap { status in
            let matching = tickets.filter { $0.status == status }.sorted { $0.lastSeen > $1.lastSeen }
            return matching.isEmpty ? nil : Group(status: status, tickets: matching)
        }
    }

    /// The record's state as lines worth reading: its JSON's keys and values, one a line, the noisy ones cut.
    public static func evidenceLines(_ state: String?, limit: Int = 8) -> [String] {
        guard let state, let data = state.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return state.map { [$0] } ?? []
        }
        let lines = object.keys.sorted().map { key -> String in
            let value = object[key]!
            let text: String
            if let string = value as? String { text = string }
            else if let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]),
                    let json = String(data: data, encoding: .utf8) { text = json }
            else { text = String(describing: value) }
            let flat = text.replacingOccurrences(of: "\n", with: " ⏎ ")
            return "\(key): \(flat.count > 160 ? String(flat.prefix(159)) + "…" : flat)"
        }
        return lines.count > limit ? Array(lines.prefix(limit)) + ["…"] : lines
    }
}

// MARK: - The store

/// The list as the daemon last answered, which tickets are open in place, and their evidence once asked for.
@MainActor
public final class FailureTicketsStore: ObservableObject {
    public enum Phase: Equatable {
        case loading
        case loaded(FailureTicketList)
        case needsUpdate
        case unreachable
    }

    @Published public private(set) var phase: Phase = .loading
    @Published public private(set) var expanded: Set<String> = []
    @Published public private(set) var details: [String: FailureTicketDetail] = [:]
    /// Tickets with an action under way.
    @Published public private(set) var acting: Set<String> = []
    /// Why the last action failed, by ticket ("" for the page's own).
    @Published public private(set) var problems: [String: String] = [:]
    /// The tickets that were new when the page was shown: their dot stays while it is, though the daemon was told
    /// they were seen the moment they arrived.
    @Published public private(set) var newOnArrival: Set<String> = []

    private let transport: @MainActor (FailureTicketsRequest) async throws -> Data
    private var toldSeen = false

    public init(transport: @escaping @MainActor (FailureTicketsRequest) async throws -> Data) {
        self.transport = transport
    }

    /// The list again; the first time it arrives, every ticket in it is seen, which clears the gear's dot.
    public func load() async {
        do {
            let data = try await transport(.list)
            guard let list = try? JSONDecoder().decode(FailureTicketList.self, from: data), list.kind == "failure-tickets" else {
                if case .loaded = phase { return }
                phase = .needsUpdate
                return
            }
            if !toldSeen {
                newOnArrival = Set(list.tickets.filter { $0.unseen && $0.status == .open }.map(\.id))
            } else {
                // One that opened or came back while the page shows is new too.
                newOnArrival.formUnion(list.tickets.filter { $0.unseen && $0.status == .open }.map(\.id))
            }
            phase = .loaded(list)
            if list.tickets.contains(where: \.unseen) {
                toldSeen = true
                _ = try? await transport(.act(id: "all", action: .seen))
            }
            toldSeen = true
        } catch {
            if case .loaded = phase { return }
            phase = .unreachable
        }
    }

    public func toggle(_ ticket: FailureTicketSummary) async {
        if expanded.contains(ticket.id) {
            expanded.remove(ticket.id)
            return
        }
        expanded.insert(ticket.id)
        if details[ticket.id] == nil || ticket.lastSeen > (details[ticket.id]?.example.at ?? 0) {
            await show(ticket.id)
        }
    }

    public func act(_ ticket: FailureTicketSummary, _ action: FailureTicketAction) async {
        guard acting.insert(ticket.id).inserted else { return }
        defer { acting.remove(ticket.id) }
        problems[ticket.id] = nil
        do {
            let data = try await transport(.act(id: ticket.id, action: action))
            let reply = try? JSONDecoder().decode(FailureTicketReply.self, from: data)
            if reply?.kind == "failure-ticket-error" {
                problems[ticket.id] = reply?.error ?? "That didn't work."
            } else if let detail = reply?.ticket {
                details[ticket.id] = detail
            }
        } catch {
            problems[ticket.id] = "conch's daemon didn't answer. Try again."
        }
        newOnArrival.remove(ticket.id)
        await load()
    }

    public func setAutoFix(_ on: Bool) async {
        problems[""] = nil
        do {
            let data = try await transport(.setAutoFix(on))
            if let reply = try? JSONSerialization.jsonObject(with: data) as? [String: Any], reply["kind"] as? String == "config-error" {
                problems[""] = reply["error"] as? String ?? "Couldn't change auto-fix."
            }
        } catch {
            problems[""] = "conch's daemon didn't answer. Try again."
        }
        await load()
    }

    private func show(_ id: String) async {
        guard let data = try? await transport(.act(id: id, action: .show)),
              let reply = try? JSONDecoder().decode(FailureTicketReply.self, from: data),
              let detail = reply.ticket else { return }
        details[id] = detail
    }
}

// MARK: - The section

/// Settings › Failures: its header, the tickets by status in cards, and auto-fix at the foot. Laid out as Logins is,
/// with Setup's buttons (Fix is a row's one thing to do: the small ink capsule). `openTerminal` opens a fix session's
/// startup terminal, on the Mac.
public struct FailureTicketsView: View {
    @StateObject private var store: FailureTicketsStore
    private let openTerminal: ((String) -> Void)?
    @State private var showIgnored = false

    public init(openTerminal: ((String) -> Void)? = nil, transport: @escaping @MainActor (FailureTicketsRequest) async throws -> Data) {
        _store = StateObject(wrappedValue: FailureTicketsStore(transport: transport))
        self.openTerminal = openTerminal
    }

    /// For a picture of the page (the design gallery), with the list it shows.
    public init(store: FailureTicketsStore, openTerminal: ((String) -> Void)? = nil) {
        _store = StateObject(wrappedValue: store)
        self.openTerminal = openTerminal
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SettingsLayout.headerGap) {
                header
                content
            }
            .font(.system(size: 12))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(SettingsLayout.inset)
        }
        .background(ConchColor.ground)
        // Again every few seconds while it shows: a fix's PR appears, a new failure comes in.
        .task {
            while !Task.isCancelled {
                await store.load()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    /// Settings' own header (the Mac's `SettingsSectionHeader`): the title on a 26-point line, the line under it.
    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Failures")
                .font(ConchType.title)
                .foregroundStyle(ConchColor.textPrimary)
                .accessibilityAddTraits(.isHeader)
                .frame(height: 26)
            Text("When an agent or conch lets you down, it lands here, one ticket for each kind of failure. Fix starts a Claude session that opens a PR; nothing leaves this Mac but that PR.")
                .font(ConchType.secondary)
                .foregroundStyle(ConchColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .loading:
            HStack(spacing: ConchSpace.x2) {
                ProgressView().controlSize(.small)
                Text("Reading conch's failure records…").foregroundStyle(ConchColor.textSecondary)
            }
        case .needsUpdate:
            Text("Needs an updated conch daemon").foregroundStyle(ConchColor.attention)
        case .unreachable:
            Text("conch's daemon isn't running, so its failures can't be listed. Turn it on in General.")
                .foregroundStyle(ConchColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        case let .loaded(list):
            loaded(list)
        }
    }

    private func loaded(_ list: FailureTicketList) -> some View {
        let now = Date()
        let groups = FailureTickets.groups(list.tickets)
        return VStack(alignment: .leading, spacing: 24) {
            if !list.fix.available, let reason = list.fix.reason {
                Label(reason, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(ConchColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if groups.isEmpty {
                HStack(spacing: ConchSpace.x2) {
                    OnboardingCheck(size: 16)
                    Text("Nothing has failed in the last two weeks.").foregroundStyle(ConchColor.textSecondary)
                }
            }
            ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                if index > 0 { FailureHairline() }
                block(group, list: list, now: now)
            }
            if let hidden = list.hidden, hidden > 0 {
                Text("\(hidden) more not shown. `conch failures --all` in Terminal lists every one.")
                    .foregroundStyle(ConchColor.textTertiary)
            }
            FailureHairline()
            autoFix(list.autoFix)
        }
    }

    private func block(_ group: FailureTickets.Group, list: FailureTicketList, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: ConchSpace.x2) {
                Image(systemName: group.symbol)
                    .font(.system(size: 13, weight: .regular))
                    .frame(width: 22, height: 22)
                Text(group.title)
                    .font(ConchType.uiEmphasis)
                    .accessibilityAddTraits(.isHeader)
                Text("\(group.tickets.count)")
                    .font(ConchType.uiBody)
                    .foregroundStyle(ConchColor.textTertiary)
                Spacer(minLength: 0)
                if group.status == .ignored {
                    Button(showIgnored ? "Hide" : "Show") { showIgnored.toggle() }
                        .buttonStyle(.plain)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(ConchColor.textSecondary)
                }
            }
            .foregroundStyle(ConchColor.textPrimary)
            if group.status != .ignored || showIgnored {
                OnboardingCard {
                    ForEach(Array(group.tickets.enumerated()), id: \.element.id) { index, ticket in
                        if index > 0 { FailureHairline() }
                        FailureTicketRow(
                            ticket: ticket,
                            now: now,
                            isNew: store.newOnArrival.contains(ticket.id),
                            canFix: list.fix.available,
                            isActing: store.acting.contains(ticket.id),
                            problem: store.problems[ticket.id],
                            detail: store.expanded.contains(ticket.id) ? .some(store.details[ticket.id]) : nil,
                            openTerminal: openTerminal,
                            onToggle: { Task { await store.toggle(ticket) } },
                            onAct: { action in Task { await store.act(ticket, action) } }
                        )
                    }
                }
            }
        }
    }

    private func autoFix(_ autoFix: FailureTicketList.AutoFix) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: ConchSpace.x2) {
                Image(systemName: "wand.and.stars")
                    .font(.system(size: 13, weight: .regular))
                    .frame(width: 22, height: 22)
                Text("Auto-fix")
                    .font(ConchType.uiEmphasis)
                    .accessibilityAddTraits(.isHeader)
            }
            .foregroundStyle(ConchColor.textPrimary)
            OnboardingCard {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Fix new tickets on their own")
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(ConchColor.textPrimary)
                        Text(FailureTickets.autoFixCaption(autoFix))
                            .font(.system(size: 11))
                            .foregroundStyle(ConchColor.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 12)
                    Toggle("", isOn: Binding(get: { autoFix.on }, set: { on in Task { await store.setAutoFix(on) } }))
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .accessibilityLabel("Fix new tickets on their own")
                }
                // Its words start where every ticket's title does, past the new-dot's column, on the headings' edge.
                .padding(.leading, FailureTicketRow.markWidth + FailureTicketRow.markGap)
                .padding(.horizontal, ConchSpace.x4)
                .padding(.vertical, 11)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let problem = store.problems[""] {
                Text(problem).foregroundStyle(ConchColor.attention)
            }
        }
    }
}

/// The page's rule between blocks and between a card's rows (the Mac's `SettingsHairline`).
struct FailureHairline: View {
    var body: some View {
        Rectangle()
            .fill(ConchColor.hairline)
            .frame(height: 1)
    }
}

/// One ticket in its card: a dot while it is new, its title and the line under it, and on its right Fix or where its
/// fix stands. A click opens it in place: the latest occurrence and its evidence, the fix, and what else can be done.
public struct FailureTicketRow: View {
    let ticket: FailureTicketSummary
    let now: Date
    let isNew: Bool
    let canFix: Bool
    let isActing: Bool
    let problem: String?
    /// Nil: closed. `.some(nil)`: open, its evidence on the way.
    let detail: FailureTicketDetail??
    let openTerminal: ((String) -> Void)?
    let onToggle: () -> Void
    let onAct: (FailureTicketAction) -> Void

    @Environment(\.openURL) private var openURL
    @State private var isHovered = false

    public init(
        ticket: FailureTicketSummary, now: Date, isNew: Bool, canFix: Bool, isActing: Bool = false, problem: String? = nil,
        detail: FailureTicketDetail?? = nil, openTerminal: ((String) -> Void)? = nil,
        onToggle: @escaping () -> Void = {}, onAct: @escaping (FailureTicketAction) -> Void = { _ in }
    ) {
        self.ticket = ticket
        self.now = now
        self.isNew = isNew
        self.canFix = canFix
        self.isActing = isActing
        self.problem = problem
        self.detail = detail
        self.openTerminal = openTerminal
        self.onToggle = onToggle
        self.onAct = onAct
    }

    /// The dot's column: the title starts here whether or not the ticket is new. 16 + 6 + 8 puts it at 30, where a block's
    /// heading starts after its 22-point mark and the 8 beside it, so a card's titles and its heading share one edge.
    static let markWidth: CGFloat = 6
    static let markGap: CGFloat = 8

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            summary
            if let detail {
                FailureTicketDetailView(ticket: ticket, detail: detail, now: now, openTerminal: openTerminal, onAct: onAct)
                    .padding(.leading, ConchSpace.x4 + Self.markWidth + Self.markGap)
                    .padding(.trailing, ConchSpace.x4)
                    .padding(.bottom, 14)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var summary: some View {
        HStack(alignment: .center, spacing: ConchSpace.x3) {
            HStack(alignment: .firstTextBaseline, spacing: Self.markGap) {
                Circle()
                    .fill(ConchColor.attention)
                    .frame(width: Self.markWidth, height: Self.markWidth)
                    .opacity(isNew ? 1 : 0)
                    // On the title's first line, centred on its x-height: 12.5-point SF's is 6.6, so the dot's centre sits 3.5
                    // above the baseline and its bottom half a point above it (measured on the Mac's own shot).
                    .alignmentGuide(.firstTextBaseline) { dimensions in dimensions[.bottom] + 0.5 }
                    .accessibilityHidden(!isNew)
                    .accessibilityLabel("New")
                VStack(alignment: .leading, spacing: 2) {
                    Text(FailureTickets.displayTitle(ticket.title))
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(ConchColor.textPrimary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(FailureTickets.meta(ticket, now: now))
                        .font(.system(size: 11))
                        .foregroundStyle(ConchColor.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let note = ticket.note {
                        Text(note)
                            .font(.system(size: 11))
                            .foregroundStyle(ConchColor.attention)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let problem {
                        Text(problem)
                            .font(.system(size: 11))
                            .foregroundStyle(ConchColor.attention)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            trailing

            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(ConchColor.textTertiary)
                .rotationEffect(.degrees(detail == nil ? 0 : 90))
                .frame(width: 12)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, ConchSpace.x4)
        .padding(.vertical, 11)
        .background(isHovered ? AnyShapeStyle(ConchColor.rowHover) : AnyShapeStyle(Color.clear))
        .contentShape(Rectangle())
        .onHover { isHovered = $0 }
        .onTapGesture(perform: onToggle)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(detail == nil ? "Shows what happened" : "Hides what happened")
    }

    @ViewBuilder
    private var trailing: some View {
        if isActing {
            ProgressView().controlSize(.small).frame(height: 26)
        } else if ticket.status == .open {
            OnboardingButton("Fix", style: .action) { onAct(.fix) }
                .disabled(!canFix)
                .opacity(canFix ? 1 : 0.4)
                .help(canFix ? "Start a background Claude session to fix this and open a PR" : "There's no conch checkout to fix it in")
        } else if let standing = FailureTickets.standing(ticket, now: now) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                // A fix session at work, before it has a PR: the ledger's own mark for an agent running (`active`'s
                // blue dot), still, rather than a spinner that would ask to be watched. On the word's x-height (11-point
                // SF's is 5.8): its bottom on the baseline.
                if ticket.status == .fixing, ticket.fix?.pr == nil {
                    Circle()
                        .fill(ConchColor.active)
                        .frame(width: 6, height: 6)
                        .alignmentGuide(.firstTextBaseline) { dimensions in dimensions[.bottom] }
                        .accessibilityHidden(true)
                }
                Text(standing)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ticket.status == .fixed ? AnyShapeStyle(ConchColor.ready) : AnyShapeStyle(ConchColor.textSecondary))
            }
            .frame(height: 26)
        }
    }
}

/// An open ticket: when it last happened and where, what the record said, its evidence, its fix, and what else to do.
struct FailureTicketDetailView: View {
    let ticket: FailureTicketSummary
    let detail: FailureTicketDetail?
    let now: Date
    let openTerminal: ((String) -> Void)?
    let onAct: (FailureTicketAction) -> Void
    @Environment(\.openURL) private var openURL

    private static let labelWidth: CGFloat = 64

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let detail {
                field("Latest") {
                    Text(latest(detail))
                }
                field("Message") {
                    Text(detail.example.message)
                        .lineLimit(6)
                        .textSelection(.enabled)
                }
                let evidence = FailureTickets.evidenceLines(detail.example.state)
                if !evidence.isEmpty {
                    field("Evidence") {
                        Text(evidence.joined(separator: "\n"))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(ConchColor.textSecondary)
                            .textSelection(.enabled)
                    }
                }
                let labels = detail.sessions.compactMap(\.label)
                if !labels.isEmpty {
                    field("Sessions") {
                        Text(labels.prefix(4).joined(separator: ", ") + (detail.sessions.count > 4 ? " and \(detail.sessions.count - 4) more" : ""))
                            .lineLimit(2)
                    }
                }
            } else {
                ProgressView().controlSize(.small)
            }
            if let fix = ticket.fix {
                field("Fix") {
                    Text(FailureTickets.fixLine(fix, now: now))
                }
            }
            actions
                .padding(.top, 4)
        }
        .font(.system(size: 12))
        .foregroundStyle(ConchColor.textPrimary)
    }

    private func latest(_ detail: FailureTicketDetail) -> String {
        let date = Date(timeIntervalSince1970: detail.example.at / 1_000)
        let when = date.formatted(date: .abbreviated, time: .shortened)
        guard let label = detail.example.label else { return when }
        return "\(when) · in “\(label)”"
    }

    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x3) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchColor.textTertiary)
                .frame(width: Self.labelWidth, alignment: .leading)
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Under the values, on their edge: the label column and `field`'s 12 points, then the buttons 8 apart.
    private var actions: some View {
        HStack(spacing: ConchSpace.x3) {
            Spacer().frame(width: Self.labelWidth)
            buttons
        }
    }

    private var buttons: some View {
        HStack(spacing: ConchSpace.x2) {
            if let url = ticket.fix?.pr.flatMap({ URL(string: $0.url) }) {
                OnboardingButton("Open PR", systemImage: "arrow.up.right", style: .row) { openURL(url) }
            }
            if ticket.status == .fixing, let background = ticket.fix?.backgroundId, let openTerminal {
                OnboardingButton("Fix session", systemImage: "terminal", style: .row) { openTerminal(background) }
            }
            switch ticket.status {
            case .open:
                OnboardingButton("Ignore", style: .row) { onAct(.ignore) }
                OnboardingButton("Mark fixed", style: .row) { onAct(.markFixed) }
            case .fixing:
                OnboardingButton("Mark fixed", style: .row) { onAct(.markFixed) }
                OnboardingButton("Back to open", style: .row) { onAct(.reopen) }
            case .fixed, .ignored:
                OnboardingButton("Reopen", style: .row) { onAct(.reopen) }
            }
            Spacer(minLength: 0)
        }
    }
}
