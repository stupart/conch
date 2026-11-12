import Foundation
import SwiftUI

// Still running (2026-11-11): what agent sessions started that is still running, whose it is, and Tyler's word on it,
// from the daemon's resource ledger (src/resource-ledger.ts).
//
// Tyler: "maybe we need like a resource ledger as part of conch so things are linked to the sessions that made them or
// are using them and we can have less loose ends for things that are meaning to run temporarily." That night his Mac
// had about twenty dev servers, a headless Chrome two days old, a 6 GB VM up six days, a 20 GB one and three booted
// simulators with no living owner, at a load average of 113. The sidebar's section says what is still running and
// whose it was; a live session's row says how many of its own are ("3 still running"). conch never stops anything
// itself: Stop, Keep and Ask later are his.

// MARK: - What the daemon sends

/// The sessions file's `resources` (src/resource-ledger.ts `PublishedResources`).
public struct PublishedResources: Decodable, Equatable, Sendable {
    public let sampledAt: Double
    /// How many are asking.
    public let asking: Int
    public let items: [ResourceItem]

    public init(sampledAt: Double, asking: Int, items: [ResourceItem]) {
        self.sampledAt = sampledAt
        self.asking = asking
        self.items = items
    }

    private enum Keys: String, CodingKey { case sampledAt, asking, items }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        sampledAt = (try? container.decodeIfPresent(Double.self, forKey: .sampledAt)) ?? 0
        asking = (try? container.decodeIfPresent(Int.self, forKey: .asking)) ?? 0
        // One this build can't read is left out, never the whole list.
        items = ((try? container.decodeIfPresent([Lossy<ResourceItem>].self, forKey: .items)) ?? []).compactMap(\.value)
    }

    private struct Lossy<Value: Decodable>: Decodable {
        let value: Value?
        init(from decoder: Decoder) throws { value = try? Value(from: decoder) }
    }
}

/// One thing a session started that is still running.
public struct ResourceItem: Decodable, Equatable, Sendable, Identifiable {
    public struct Owner: Decodable, Equatable, Sendable {
        /// Its row, while it has one.
        public let sessionId: String?
        public let label: String
        public let live: Bool
        /// declared, tree, environment or command: how conch knows it is this session's.
        public let how: String
        /// When conch last saw it live, for one that has ended.
        public let endedAt: Double?

        public init(sessionId: String? = nil, label: String, live: Bool, how: String = "tree", endedAt: Double? = nil) {
            self.sessionId = sessionId
            self.label = label
            self.live = live
            self.how = how
            self.endedAt = endedAt
        }
    }

    public struct Lifetime: Decodable, Equatable, Sendable {
        /// turn, session, until or keep.
        public let kind: String
        public let until: Double?
        public let inferred: Bool?

        public init(kind: String, until: Double? = nil, inferred: Bool? = nil) {
            self.kind = kind
            self.until = until
            self.inferred = inferred
        }
    }

    /// `p4242`, `sim-1a2b3c4d`, `vm-ci`: what Stop names, and what `conch resources` lists.
    public let id: String
    /// server, browser, vm, container, simulator, tmux, watcher, shell or process.
    public let kind: String
    public let title: String
    public let command: String
    public let cwd: String?
    public let ports: [Int]?
    public let owner: Owner?
    public let users: [String]?
    /// Epoch ms.
    public let startedAt: Double
    /// Per cent of one core, over all its processes.
    public let cpu: Double
    /// Bytes, as Activity Monitor counts them.
    public let memory: Double
    public let lifetime: Lifetime?
    public let why: String?
    /// running, asking, kept, later, stopping or unowned.
    public let state: String
    public let reason: String?
    public let asksAgainAt: Double?
    public let preexisting: Bool?

    public init(
        id: String, kind: String, title: String, command: String = "", cwd: String? = nil, ports: [Int]? = nil,
        owner: Owner? = nil, users: [String]? = nil, startedAt: Double, cpu: Double = 0, memory: Double = 0,
        lifetime: Lifetime? = nil, why: String? = nil, state: String, reason: String? = nil, asksAgainAt: Double? = nil,
        preexisting: Bool? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.command = command
        self.cwd = cwd
        self.ports = ports
        self.owner = owner
        self.users = users
        self.startedAt = startedAt
        self.cpu = cpu
        self.memory = memory
        self.lifetime = lifetime
        self.why = why
        self.state = state
        self.reason = reason
        self.asksAgainAt = asksAgainAt
        self.preexisting = preexisting
    }
}

public enum ResourceAction: String, Sendable, Equatable, CaseIterable {
    case stop, keep, later

    public var title: String {
        switch self {
        case .stop: "Stop"
        case .keep: "Keep"
        case .later: "Ask later"
        }
    }
}

/// Tyler's word on one (`{kind: "resource-decide", id, action}`): the Mac app sends no pid, so the daemon knows it is him.
public struct ResourceDecideRequest: Encodable, Equatable, Sendable {
    public let kind = "resource-decide"
    public let id: String
    public let action: String

    public init(id: String, action: ResourceAction) {
        self.id = id
        self.action = action.rawValue
    }

    private enum Keys: String, CodingKey { case kind, id, action }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(id, forKey: .id)
        try container.encode(action, forKey: .action)
    }
}

// MARK: - The words

public enum StillRunning {
    /// A live session's row: "1 still running", "3 still running"; nil at none.
    public static func rowLine(_ count: Int?) -> String? {
        guard let count, count > 0 else { return nil }
        return "\(count) still running"
    }

    /// How long, in the fewest words: "under a minute", "12 min", "5 h", "2 d".
    public static func age(since epochMs: Double, now: Date) -> String {
        let minutes = max(0, Int((now.timeIntervalSince1970 * 1_000 - epochMs) / 60_000))
        if minutes < 1 { return "under a minute" }
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        if hours < 48 { return "\(hours) h" }
        return "\(hours / 24) d"
    }

    public static func memory(_ bytes: Double) -> String {
        let gb = bytes / 1_073_741_824
        if gb >= 1 { return String(format: "%.1f GB", gb) }
        return "\(max(1, Int((bytes / 1_048_576).rounded()))) MB"
    }

    public static func cpu(_ percent: Double) -> String {
        "\(Int(percent.rounded()))% CPU"
    }

    /// Whose it is, then why it is asking: "old prototype · its session ended 2 d ago", "infra", "no session started it".
    public static func ownerLine(_ item: ResourceItem, now: Date) -> String {
        guard let owner = item.owner else {
            return item.preexisting == true ? "Unowned · here before conch looked" : "Unowned · no session started it"
        }
        switch item.state {
        case "asking", "later":
            if !owner.live, let ended = owner.endedAt {
                return "\(owner.label) · ended \(age(since: ended, now: now)) ago"
            }
            return "\(owner.label) · \(item.reason ?? "its time is over")"
        case "kept": return "\(owner.label) · kept"
        case "stopping": return "\(owner.label) · stopping…"
        default:
            if let reason = item.reason, reason.hasPrefix("couldn't") { return "\(owner.label) · \(reason)" }
            return owner.live ? owner.label : "\(owner.label) · ended"
        }
    }

    /// "up 2 d · 0% CPU · 258 MB".
    public static func numbers(_ item: ResourceItem, now: Date) -> String {
        "up \(age(since: item.startedAt, now: now)) · \(cpu(item.cpu)) · \(memory(item.memory))"
    }

    /// What Tyler can do from here. Asking: all three. Running for a live session: stop, or keep it past its session.
    /// Kept, unowned or asked about later: stop. Stopping: nothing.
    public static func actions(for item: ResourceItem) -> [ResourceAction] {
        switch item.state {
        case "asking": [.stop, .keep, .later]
        case "running": [.stop, .keep]
        case "stopping": []
        default: [.stop]
        }
    }

    /// What a stop will do, said before it does: the confirmation's message.
    public static func stopMessage(_ item: ResourceItem) -> String {
        switch item.kind {
        case "vm": return "conch runs colima stop (or limactl stop) for this VM. Whatever runs in it stops too."
        case "simulator": return "conch shuts the simulator down with xcrun simctl shutdown."
        default: return "conch asks it and everything under it to quit (SIGTERM), and ends whatever is left after 5 seconds."
        }
    }

    public struct Group: Identifiable, Equatable, Sendable {
        public let id: String
        public let title: String
        public let items: [ResourceItem]
        /// Open to begin with: only what is asking.
        public let opensFolded: Bool
    }

    /// Asking first, open; then running, kept and unowned, folded, each with its count.
    public static func groups(_ items: [ResourceItem]) -> [Group] {
        let specs: [(String, String, Set<String>, Bool)] = [
            ("asking", "Asking", ["asking", "stopping"], false),
            ("running", "Running", ["running", "later"], true),
            ("kept", "Kept", ["kept"], true),
            ("unowned", "Unowned", ["unowned"], true),
        ]
        return specs.compactMap { id, title, states, folded in
            let members = items.filter { states.contains($0.state) }
            return members.isEmpty ? nil : Group(id: id, title: title, items: members, opensFolded: folded)
        }
    }

    /// The section's header line: "Still running", and what asks.
    public static func header(_ resources: PublishedResources) -> (title: String, badge: String?) {
        ("Still running", resources.asking > 0 ? "\(resources.asking) asking" : nil)
    }

    public static func symbol(for kind: String) -> String {
        switch kind {
        case "server": "server.rack"
        case "browser": "globe"
        case "vm": "shippingbox"
        case "container": "cube.box"
        case "simulator": "iphone"
        case "tmux": "rectangle.split.3x1"
        case "watcher": "eye"
        case "shell": "terminal"
        default: "gearshape"
        }
    }

    public static func accessibilityLabel(_ item: ResourceItem, now: Date) -> String {
        "\(item.title), \(ownerLine(item, now: now)), \(numbers(item, now: now))"
    }

    /// The tooltip: the command, where it runs, why, who else used it, and its id for `conch resources`.
    public static func tooltip(_ item: ResourceItem) -> String {
        var lines = [item.command]
        if let cwd = item.cwd { lines.append("in \(cwd)") }
        if let why = item.why { lines.append("why: \(why)") }
        if let users = item.users, !users.isEmpty { lines.append("used by \(users.joined(separator: ", "))") }
        lines.append("conch resources stop|keep|later \(item.id)")
        return lines.joined(separator: "\n")
    }

    /// The daemon's answer to a decision: nil when it was done, else what to say on the row.
    public static func replyError(_ data: Data?) -> String? {
        guard let data else { return "Could not reach the conch daemon." }
        let reply = try? JSONDecoder().decode(Reply.self, from: data)
        if reply?.kind == "resource-done" { return nil }
        return reply?.error ?? "The daemon didn't take it; update conch."
    }

    private struct Reply: Decodable {
        let kind: String
        let error: String?
    }
}

// MARK: - The section

/// The sidebar's Still running: a header, then each group as `StillRunning.groups` lays them out. Draws nothing when
/// nothing is running. `decide` sends Tyler's word and answers with what to say if it failed.
public struct StillRunningSection: View {
    let resources: PublishedResources
    let now: Date
    let decide: @Sendable (String, ResourceAction) async -> String?

    @State private var folded: Set<String>?
    @State private var collapsed = false
    @State private var pending: Set<String> = []
    @State private var errors: [String: String] = [:]

    /// `open`: the groups to begin unfolded, for a picture of them; nil is `StillRunning.groups`' own (Asking only).
    public init(
        resources: PublishedResources,
        now: Date,
        open: Set<String>? = nil,
        decide: @escaping @Sendable (String, ResourceAction) async -> String?
    ) {
        self.resources = resources
        self.now = now
        self.decide = decide
        _folded = State(initialValue: open.map { Set(["asking", "running", "kept", "unowned"]).subtracting($0) })
    }

    private var groups: [StillRunning.Group] { StillRunning.groups(resources.items) }

    private func isFolded(_ group: StillRunning.Group) -> Bool {
        folded.map { $0.contains(group.id) } ?? group.opensFolded
    }

    private func toggle(_ group: StillRunning.Group) {
        var next = folded ?? Set(groups.filter(\.opensFolded).map(\.id))
        if next.contains(group.id) { next.remove(group.id) } else { next.insert(group.id) }
        folded = next
    }

    public var body: some View {
        if !resources.items.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                header
                if !collapsed {
                    ForEach(groups) { group in
                        groupHeader(group)
                        if !isFolded(group) {
                            ForEach(group.items) { item in
                                StillRunningRow(
                                    item: item,
                                    now: now,
                                    pending: pending.contains(item.id),
                                    error: errors[item.id],
                                    onAction: { action in act(action, on: item) }
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    private var header: some View {
        let (title, badge) = StillRunning.header(resources)
        return Button { collapsed.toggle() } label: {
            HStack(spacing: 4) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .rotationEffect(.degrees(collapsed ? 0 : 90))
                    .frame(width: 10)
                Text(title)
                    .font(.system(size: 12, weight: .medium))
                Spacer(minLength: 4)
                if let badge {
                    Text(badge)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(ConchColor.attention)
                } else if collapsed {
                    Text("\(resources.items.count)")
                        .font(.system(size: 10, weight: .medium))
                        .monospacedDigit()
                }
            }
            .foregroundStyle(ConchColor.textTertiary)
            .padding(.horizontal, 6)
            .padding(.top, 10)
            .padding(.bottom, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(badge.map { "\(title), \($0)" } ?? "\(title), \(resources.items.count)")
        .accessibilityAddTraits(.isHeader)
    }

    private func groupHeader(_ group: StillRunning.Group) -> some View {
        Button { toggle(group) } label: {
            HStack(spacing: 4) {
                Text(group.title.uppercased())
                    .font(.system(size: 9.5, weight: .semibold))
                    .kerning(0.4)
                Text("\(group.items.count)")
                    .font(.system(size: 9.5, weight: .medium))
                    .monospacedDigit()
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .semibold))
                    .rotationEffect(.degrees(isFolded(group) ? 0 : 90))
            }
            .foregroundStyle(group.id == "asking" ? AnyShapeStyle(ConchColor.attention.opacity(0.9)) : AnyShapeStyle(ConchColor.textTertiary))
            .padding(.horizontal, 10)
            .padding(.top, 6)
            .padding(.bottom, 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(group.title), \(group.items.count)\(isFolded(group) ? ", folded" : "")")
    }

    private func act(_ action: ResourceAction, on item: ResourceItem) {
        guard !pending.contains(item.id) else { return }
        pending.insert(item.id)
        errors[item.id] = nil
        let decide = decide
        Task { @MainActor in
            let error = await decide(item.id, action)
            pending.remove(item.id)
            errors[item.id] = error
        }
    }
}

/// One resource: its kind's mark, its name and age; whose it is; its CPU and memory; and what Tyler can do.
public struct StillRunningRow: View {
    let item: ResourceItem
    let now: Date
    let pending: Bool
    let error: String?
    let onAction: (ResourceAction) -> Void

    @State private var hovering = false
    @State private var confirmingStop = false

    public init(item: ResourceItem, now: Date, pending: Bool = false, error: String? = nil, onAction: @escaping (ResourceAction) -> Void) {
        self.item = item
        self.now = now
        self.pending = pending
        self.error = error
        self.onAction = onAction
    }

    private var asking: Bool { item.state == "asking" }
    private var actions: [ResourceAction] { pending ? [] : StillRunning.actions(for: item) }

    public var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: StillRunning.symbol(for: item.kind))
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(asking ? AnyShapeStyle(ConchColor.attention) : AnyShapeStyle(ConchColor.textTertiary))
                .frame(width: 12, height: 16)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    TailFadeText(item.title, fade: 20)
                        .font(.system(size: 12.5, weight: asking ? .semibold : .medium))
                        .foregroundStyle(ConchColor.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(StillRunning.age(since: item.startedAt, now: now))
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                        .foregroundStyle(ConchColor.textTertiary)
                        .fixedSize()
                }
                TailFadeText(error ?? StillRunning.ownerLine(item, now: now), fade: 20)
                    .font(.system(size: 11))
                    .foregroundStyle(error != nil ? AnyShapeStyle(ConchColor.attention) : AnyShapeStyle(ConchColor.textSecondary))
                // What it costs; under the cursor, what can be done with it instead, so the row never changes height.
                // An asking row asks on a line of its own, always.
                HStack(spacing: 5) {
                    if !asking && hovering && !actions.isEmpty {
                        ForEach(actions, id: \.self) { action in actionButton(action) }
                    } else {
                        Text("\(StillRunning.cpu(item.cpu)) · \(StillRunning.memory(item.memory))")
                            .font(.system(size: 10.5))
                            .monospacedDigit()
                            .foregroundStyle(ConchColor.textTertiary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if pending { ProgressView().controlSize(.mini) }
                }
                .frame(height: 18)
                if asking && !actions.isEmpty {
                    HStack(spacing: 5) {
                        ForEach(actions, id: \.self) { action in actionButton(action) }
                    }
                    .padding(.top, 2)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(hovering ? AnyShapeStyle(ConchColor.rowHover) : AnyShapeStyle(Color.clear))
        )
        .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .onHover { hovering = $0 }
        .help(StillRunning.tooltip(item))
        .contextMenu {
            ForEach(StillRunning.actions(for: item), id: \.self) { action in
                Button(action.title) { perform(action) }
            }
        }
        .confirmationDialog("Stop \(item.title)?", isPresented: $confirmingStop) {
            Button("Stop", role: .destructive) { onAction(.stop) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(StillRunning.stopMessage(item))
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(StillRunning.accessibilityLabel(item, now: now))
        .accessibilityActions {
            ForEach(StillRunning.actions(for: item), id: \.self) { action in
                Button(action.title) { perform(action) }
            }
        }
    }

    /// A stop asks first: it ends a process Tyler may still want, and a VM takes everything in it down with it.
    private func perform(_ action: ResourceAction) {
        if action == .stop { confirmingStop = true } else { onAction(action) }
    }

    private func actionButton(_ action: ResourceAction) -> some View {
        Button(action.title) { perform(action) }
            .buttonStyle(.plain)
            .font(.system(size: 10.5, weight: .medium))
            .foregroundStyle(action == .stop ? AnyShapeStyle(ConchColor.attention) : AnyShapeStyle(ConchColor.textSecondary))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Capsule().fill(ConchColor.fill))
            .contentShape(Capsule())
    }
}
