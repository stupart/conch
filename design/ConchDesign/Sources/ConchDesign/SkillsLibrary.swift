import SwiftUI

/// The skills library (src/skills-library.ts, 2026-10-28): every skill on the Mac across every account and both agents,
/// skills from the public indexes to add and try, and the benchmark catalog beside them (src/benchmarks.ts). Tyler: "is
/// there a nice screen or view in conch with all my skills … and then lets also make a new tab for benchmarks".
///
/// This file is what both apps share: the wire, the rules that filter and name things, and the rows. Settings › Skills
/// and Settings › Benchmarks on the Mac (SkillsLibraryView.swift) lay them out beside a reader.

// MARK: - The wire

/// `{ kind: "skills-library", action, … }`; every option a given action doesn't take is left out (the daemon refuses
/// one it doesn't expect).
public struct SkillsLibraryRequest: Encodable, Equatable, Sendable {
    public var kind = "skills-library"
    public var action: String
    public var offset: Int?
    public var query: String?
    public var index: String?
    public var refresh: Bool?
    public var entryId: String?
    public var path: String?
    public var agent: String?
    public var accountId: String?
    public var planHash: String?

    public init(action: String) { self.action = action }

    public static func installed(offset: Int = 0, refresh: Bool = false) -> Self {
        var request = Self(action: "installed")
        request.offset = offset > 0 ? offset : nil
        request.refresh = refresh ? true : nil
        return request
    }

    public static func discover(query: String = "", index: String? = nil, offset: Int = 0, refresh: Bool = false) -> Self {
        var request = Self(action: "discover")
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines)
        request.query = words.isEmpty ? nil : words
        request.index = index
        request.offset = offset > 0 ? offset : nil
        request.refresh = refresh ? true : nil
        return request
    }

    public static func open(_ entryId: String) -> Self {
        var request = Self(action: "open")
        request.entryId = entryId
        return request
    }

    public static func addPreview(_ entryId: String, agent: String, accountId: String) -> Self {
        var request = Self(action: "add-preview")
        request.entryId = entryId
        request.agent = agent
        request.accountId = accountId
        return request
    }

    public static func add(_ entryId: String, agent: String, accountId: String, planHash: String) -> Self {
        var request = addPreview(entryId, agent: agent, accountId: accountId)
        request.action = "add"
        request.planHash = planHash
        return request
    }

    /// Try a skill from an index, in this agent (and account, when one is chosen).
    public static func trial(entryId: String, agent: String, accountId: String?) -> Self {
        var request = Self(action: "trial")
        request.entryId = entryId
        request.agent = agent
        request.accountId = accountId
        return request
    }

    /// Try an installed skill, from where it lives; an account for one that every account of its agent has.
    public static func trial(location: SkillLocationInfo, accountId: String?) -> Self {
        var request = Self(action: "trial")
        request.path = location.path
        request.agent = location.agent
        request.accountId = location.accountId ?? accountId
        return request
    }
}

public struct SkillLocationInfo: Decodable, Hashable, Identifiable, Sendable {
    public let agent: String
    public let accountId: String?
    public let accountLabel: String?
    /// user, plugin, project, claude.ai, system, managed, admin.
    public let origin: String
    /// skill or command.
    public let kind: String
    public let path: String
    public let pluginId: String?
    public let pluginVersion: String?
    public let projectPath: String?
    public let enabled: Bool?
    public let invocation: String?
    public let publisher: String?
    public let digest: String

    public var id: String { "\(agent)|\(accountId ?? "*")|\(path)" }

    public init(agent: String, accountId: String? = nil, accountLabel: String? = nil, origin: String, kind: String = "skill",
                path: String, pluginId: String? = nil, pluginVersion: String? = nil, projectPath: String? = nil,
                enabled: Bool? = true, invocation: String? = nil, publisher: String? = nil, digest: String = "") {
        self.agent = agent
        self.accountId = accountId
        self.accountLabel = accountLabel
        self.origin = origin
        self.kind = kind
        self.path = path
        self.pluginId = pluginId
        self.pluginVersion = pluginVersion
        self.projectPath = projectPath
        self.enabled = enabled
        self.invocation = invocation
        self.publisher = publisher
        self.digest = digest
    }

    /// The folder a skill's SKILL.md is in, or a command's own folder: what the reader shows as a tree.
    public var folder: String { (path as NSString).deletingLastPathComponent }
    /// The file in that folder the reader opens first.
    public var file: String { (path as NSString).lastPathComponent }
}

public struct InstalledSkillInfo: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let description: String?
    public let origin: String
    public let kind: String
    public let plugin: String?
    public let locations: [SkillLocationInfo]
    public let versions: Int

    public init(id: String, name: String, description: String? = nil, origin: String, kind: String = "skill",
                plugin: String? = nil, locations: [SkillLocationInfo], versions: Int = 1) {
        self.id = id
        self.name = name
        self.description = description
        self.origin = origin
        self.kind = kind
        self.plugin = plugin
        self.locations = locations
        self.versions = versions
    }
}

public struct LibraryAccountInfo: Decodable, Hashable, Identifiable, Sendable {
    public let agent: String
    public let id: String
    public let label: String
    public let configDir: String
    public let skills: Int

    public init(agent: String, id: String, label: String, configDir: String = "", skills: Int = 0) {
        self.agent = agent
        self.id = id
        self.label = label
        self.configDir = configDir
        self.skills = skills
    }

    /// Unique across both agents: each has a "default".
    public var key: String { "\(agent):\(id)" }
}

public struct SkillsInstalledPage: Decodable, Sendable {
    public let kind: String
    public let action: String
    public let accounts: [LibraryAccountInfo]
    public let skills: [InstalledSkillInfo]
    public let total: Int
    public let next: Int?
    public let problems: [String]
    public let readAt: Double
}

public struct SkillIndexInfo: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let maintainer: String
    public let url: String
    public let agents: [String]
    public let count: Int
    public let fetchedAt: Double?
    public let error: String?

    public init(id: String, name: String, maintainer: String, url: String = "https://example.com", agents: [String] = ["claude"],
                count: Int = 0, fetchedAt: Double? = nil, error: String? = nil) {
        self.id = id
        self.name = name
        self.maintainer = maintainer
        self.url = url
        self.agents = agents
        self.count = count
        self.fetchedAt = fetchedAt
        self.error = error
    }
}

public struct DiscoverSkillInfo: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let index: String
    public let name: String
    public let description: String?
    public let repo: String?
    public let path: String?
    public let url: String
    public let installs: Int?
    public let plugin: String?
    public let needsPlugin: Bool?
    public let trust: String?
    public let license: String?
    public let installed: Bool?
    public let local: String?

    public init(id: String, index: String, name: String, description: String? = nil, repo: String? = nil, path: String? = nil,
                url: String = "https://example.com", installs: Int? = nil, plugin: String? = nil, needsPlugin: Bool? = nil,
                trust: String? = nil, license: String? = nil, installed: Bool? = nil, local: String? = nil) {
        self.id = id
        self.index = index
        self.name = name
        self.description = description
        self.repo = repo
        self.path = path
        self.url = url
        self.installs = installs
        self.plugin = plugin
        self.needsPlugin = needsPlugin
        self.trust = trust
        self.license = license
        self.installed = installed
        self.local = local
    }
}

public struct SkillsDiscoverPage: Decodable, Sendable {
    public let kind: String
    public let action: String
    public let indexes: [SkillIndexInfo]
    public let entries: [DiscoverSkillInfo]
    public let total: Int
    public let next: Int?
    public let refreshing: Bool
}

public struct SkillOpenReply: Decodable, Sendable {
    public let entry: DiscoverSkillInfo
    public let folder: String
}

public struct SkillAddPreviewInfo: Decodable, Equatable, Sendable {
    public struct File: Decodable, Equatable, Hashable, Sendable {
        public let path: String
        public let bytes: Int
        public init(path: String, bytes: Int) { self.path = path; self.bytes = bytes }
    }
    public struct Skipped: Decodable, Equatable, Hashable, Sendable {
        public let path: String
        public let reason: String
    }

    public let name: String
    public let destination: String
    public let files: [File]
    public let skipped: [Skipped]
    public let totalBytes: Int
    public let planHash: String
    public let refusal: String?
    public let agent: String
    public let accountId: String
    public let accountLabel: String
}

public struct SkillAddPreviewReply: Decodable, Sendable { public let preview: SkillAddPreviewInfo }
public struct SkillAddedReply: Decodable, Sendable { public let added: String; public let name: String }
public struct SkillTrialReply: Decodable, Equatable, Sendable {
    public let cwd: String
    public let prompt: String
    public let agent: String
    public let accountId: String?
    public let name: String
}

/// What the daemon says when it refuses: `{ kind: "session-error", error }`.
public struct SkillsLibraryRefusal: Decodable, Sendable {
    public let kind: String?
    public let error: String?
}

// MARK: - Benchmarks' wire

public struct BenchmarkIndexInfo: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let url: String
    /// aggregator, leaderboard, benchmark or suite.
    public let kind: String
    public let domains: [String]
    public let maintainer: String
    public let measures: String
    public let freshness: String
    public let take: String

    public init(id: String, name: String, url: String, kind: String, domains: [String], maintainer: String, measures: String,
                freshness: String, take: String) {
        self.id = id
        self.name = name
        self.url = url
        self.kind = kind
        self.domains = domains
        self.maintainer = maintainer
        self.measures = measures
        self.freshness = freshness
        self.take = take
    }
}

public struct BenchmarkCatalogInfo: Decodable, Sendable {
    public struct Report: Decodable, Sendable {
        public let title: String
        public let atlasPath: String
    }
    public let updatedAt: String
    public let report: Report?
    public let indexes: [BenchmarkIndexInfo]
}

/// One page of the catalog (`{ kind: "benchmarks", offset? }`): its report and `updatedAt` every time, its indexes from
/// `offset`, and where the next page starts.
public struct BenchmarksReplyInfo: Decodable, Sendable {
    public let kind: String
    public let catalog: BenchmarkCatalogInfo
    public let total: Int?
    public let next: Int?
    public let reportCopy: String?
}

public struct BenchmarksRequestInfo: Encodable, Equatable, Sendable {
    public var kind = "benchmarks"
    public var offset: Int?
    public init(offset: Int = 0) { self.offset = offset > 0 ? offset : nil }
}

// MARK: - The rules

public enum SkillsLibrary {
    /// Which of Tyler's skills the list shows: all, one account's, or every project's.
    public enum Scope: Hashable, Sendable {
        case all
        case account(agent: String, id: String)
        case projects

        public func includes(_ location: SkillLocationInfo) -> Bool {
            switch self {
            case .all: true
            case let .account(agent, id): location.agent == agent && (location.accountId == id || (location.accountId == nil && location.origin != "project"))
            case .projects: location.origin == "project"
            }
        }
    }

    /// The scopes the filter offers: all, each account with how many it carries, and projects when any skill is one's.
    public static func scopes(accounts: [LibraryAccountInfo], skills: [InstalledSkillInfo]) -> [(scope: Scope, title: String)] {
        var out: [(Scope, String)] = [(.all, "All accounts")]
        for account in accounts {
            out.append((.account(agent: account.agent, id: account.id), "\(agentName(account.agent)) · \(account.label)"))
        }
        if skills.contains(where: { $0.locations.contains { $0.origin == "project" } }) {
            out.append((.projects, "Projects"))
        }
        return out
    }

    public static func agentName(_ agent: String) -> String {
        agent == "codex" ? "Codex" : "Claude"
    }

    /// Where a copy lives, as a chip says it: its agent and account, or its project, or every account of its agent.
    public static func locationTitle(_ location: SkillLocationInfo) -> String {
        if let label = location.accountLabel { return "\(agentName(location.agent)) · \(label)" }
        if location.origin == "project", let project = location.projectPath {
            // The folder and the one it's in: a project's subfolder ("brand") says nothing on its own.
            let parts = (project as NSString).pathComponents.filter { $0 != "/" }.suffix(2)
            return "\(agentName(location.agent)) · \(parts.joined(separator: "/"))"
        }
        return "\(agentName(location.agent)) · every account"
    }

    /// Where a skill came from, in the words the list groups by.
    public static func originTitle(_ origin: String) -> String {
        switch origin {
        case "user": "Yours"
        case "project": "In your projects"
        case "plugin": "From plugins"
        case "claude.ai": "From claude.ai"
        case "system": "Built into Codex"
        default: "Managed by an administrator"
        }
    }

    public static func originSymbol(_ origin: String) -> String {
        switch origin {
        case "user": "person"
        case "project": "folder"
        case "plugin": "puzzlepiece.extension"
        case "claude.ai": "cloud"
        case "system": "shippingbox"
        default: "building.2"
        }
    }

    /// The groups the installed list is laid out in, in this order; empty ones are left out.
    public static let originOrder = ["user", "project", "claude.ai", "plugin", "system", "managed"]

    public struct Group: Identifiable, Sendable {
        public let origin: String
        public let skills: [InstalledSkillInfo]
        public var id: String { origin }
        public var title: String { SkillsLibrary.originTitle(origin) }
        public var symbol: String { SkillsLibrary.originSymbol(origin) }
    }

    public static func groups(_ skills: [InstalledSkillInfo]) -> [Group] {
        let keyed = Dictionary(grouping: skills) { originOrder.contains($0.origin) ? $0.origin : (($0.origin == "admin") ? "managed" : $0.origin) }
        return originOrder.compactMap { origin in
            guard let members = keyed[origin], !members.isEmpty else { return nil }
            // A plugin's skills sit together, by plugin and then name.
            let sorted = origin == "plugin"
                ? members.sorted { ($0.plugin ?? "", $0.name.lowercased()) < ($1.plugin ?? "", $1.name.lowercased()) }
                : members
            return Group(origin: origin, skills: sorted)
        }
    }

    /// The skills a search and a scope leave: every word in the name, the description or the plugin, and a copy in scope.
    public static func filter(_ skills: [InstalledSkillInfo], query: String, scope: Scope) -> [InstalledSkillInfo] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        return skills.filter { skill in
            guard skill.locations.contains(where: scope.includes) else { return false }
            let haystack = [skill.name, skill.description ?? "", skill.plugin ?? ""].joined(separator: " ").lowercased()
            return words.allSatisfy { haystack.contains($0) }
        }
    }

    /// One chip per account or project a skill is in, its copies in that place folded together, off when all of them are.
    public struct Chip: Hashable, Identifiable, Sendable {
        public let title: String
        public let isOff: Bool
        public var id: String { title }
    }

    public static func chips(_ skill: InstalledSkillInfo) -> [Chip] {
        var order: [String] = []
        var off: [String: Bool] = [:]
        for location in skill.locations {
            let title = locationTitle(location)
            if off[title] == nil { order.append(title) }
            off[title] = (off[title] ?? true) && location.enabled == false
        }
        return order.map { Chip(title: $0, isOff: off[$0] ?? false) }
    }

    /// The line under a skill's description: its plugin and version, what calls it, and whether its copies differ.
    public static func detail(_ skill: InstalledSkillInfo) -> String {
        var parts: [String] = []
        if let plugin = skill.plugin { parts.append("plugin \(plugin)") }
        if skill.kind == "command" { parts.append("command") }
        if let call = skill.locations.compactMap(\.invocation).first { parts.append(call) }
        if skill.versions > 1 { parts.append("\(skill.versions) different copies") }
        return parts.joined(separator: " · ")
    }

    /// The copy a reader or a trial starts from: the first one switched on.
    public static func primaryLocation(_ skill: InstalledSkillInfo) -> SkillLocationInfo? {
        skill.locations.first { $0.enabled != false } ?? skill.locations.first
    }

    // Discover

    /// Who reviewed a directory skill's plugin, as its badge says.
    public static func trustTitle(_ trust: String?) -> String? {
        switch trust {
        case "anthropic": "Reviewed by Anthropic"
        case "partner": "Partner"
        case "community": "Community"
        default: nil
        }
    }

    public static func discoverDetail(_ entry: DiscoverSkillInfo, indexes: [SkillIndexInfo]) -> String {
        var parts: [String] = []
        if let index = indexes.first(where: { $0.id == entry.index }) { parts.append(index.name) }
        if let plugin = entry.plugin { parts.append("plugin \(plugin)") }
        if let repo = entry.repo { parts.append(repo) }
        if let installs = entry.installs { parts.append("\(installs.formatted()) installs") }
        if let license = entry.license { parts.append(license) }
        return parts.joined(separator: " · ")
    }

    /// When an index was last read, as a person says it.
    public static func fetched(_ milliseconds: Double?, now: Date = Date()) -> String {
        guard let milliseconds else { return "not read yet" }
        let seconds = now.timeIntervalSince(Date(timeIntervalSince1970: milliseconds / 1000))
        if seconds < 90 { return "read just now" }
        if seconds < 3_600 { return "read \(Int(seconds / 60)) min ago" }
        if seconds < 86_400 { return "read \(Int(seconds / 3_600)) h ago" }
        return "read \(Int(seconds / 86_400)) d ago"
    }

    public static func bytes(_ count: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }

    // Benchmarks

    public static let benchmarkKinds = ["aggregator", "leaderboard", "benchmark", "suite"]

    public static func benchmarkKindTitle(_ kind: String) -> String {
        switch kind {
        case "aggregator": "Aggregator"
        case "leaderboard": "Leaderboard"
        case "benchmark": "Benchmark"
        case "suite": "Suite"
        default: kind.capitalized
        }
    }

    /// Every domain the catalog names, most used first.
    public static func benchmarkDomains(_ indexes: [BenchmarkIndexInfo]) -> [String] {
        var counts: [String: Int] = [:]
        for index in indexes { for domain in index.domains { counts[domain, default: 0] += 1 } }
        return counts.keys.sorted { (counts[$0]!, $1) > (counts[$1]!, $0) }
    }

    public static func benchmarkKindPlural(_ kind: String) -> String {
        switch kind {
        case "aggregator": "Aggregators"
        case "leaderboard": "Leaderboards"
        case "benchmark": "Benchmarks"
        case "suite": "Suites"
        default: kind.capitalized
        }
    }

    public static func benchmarkKindSymbol(_ kind: String) -> String {
        switch kind {
        case "aggregator": "square.stack.3d.up"
        case "leaderboard": "list.number"
        case "benchmark": "checklist"
        default: "shippingbox"
        }
    }

    /// The indexes a search, a kind and a domain leave: every word in the name, what it measures, who keeps it, the take
    /// or a domain.
    public static func filterBenchmarks(_ indexes: [BenchmarkIndexInfo], kind: String?, domain: String?, query: String = "") -> [BenchmarkIndexInfo] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        return indexes.filter { index in
            guard kind == nil || index.kind == kind, domain == nil || index.domains.contains(domain!) else { return false }
            let haystack = ([index.name, index.measures, index.maintainer, index.take] + index.domains).joined(separator: " ").lowercased()
            return words.allSatisfy { haystack.contains($0) }
        }
    }

    public struct BenchmarkGroup: Identifiable, Sendable {
        public let kind: String
        public let indexes: [BenchmarkIndexInfo]
        public var id: String { kind }
        public var title: String { SkillsLibrary.benchmarkKindPlural(kind) }
        public var symbol: String { SkillsLibrary.benchmarkKindSymbol(kind) }
    }

    /// The catalog by kind — aggregators first, as the place to start — each kind in the catalog's own order.
    public static func benchmarkGroups(_ indexes: [BenchmarkIndexInfo]) -> [BenchmarkGroup] {
        let kinds = benchmarkKinds + indexes.map(\.kind).filter { !benchmarkKinds.contains($0) }
        var seen = Set<String>()
        return kinds.compactMap { kind in
            guard seen.insert(kind).inserted else { return nil }
            let members = indexes.filter { $0.kind == kind }
            return members.isEmpty ? nil : BenchmarkGroup(kind: kind, indexes: members)
        }
    }
}

// MARK: - Layout

/// How Settings › Skills and Benchmarks lay out in the width the page gives them: the list and the reader side by side, or,
/// narrower than `compactBelow` (the conch panel's 860-point window leaves 639), one at a time — the list, and the reader
/// in its place once something is picked, with the way back at its top. Side by side at 639 left the reader 300 points,
/// and a folder's tree took half of those.
public enum LibraryLayout {
    public static let compactBelow: CGFloat = 760

    public static func isCompact(width: CGFloat) -> Bool { width < compactBelow }
}

// MARK: - Rows

/// A small capsule: where a skill lives, a domain, a kind. Off reads as off: fainter, and struck through.
///
/// On a selected row the capsule is drawn in the raised surface rather than the fill. The fill is translucent, so over
/// the row's selection it stacked: in dark a chip's words measured 3.33:1 on it (#AEAEB2 on #555655), and an off chip's
/// fainter ones less, under the 4.5 every level of text holds on a ground. On the raised surface both hold in either
/// scheme, and the chip still stands apart from the selection (white on grey in light, a step darker in dark).
public struct LibraryChip: View {
    let title: String
    var isOff = false
    var onSelection = false
    var help: String?
    @Environment(\.colorScheme) private var scheme

    public init(_ title: String, isOff: Bool = false, onSelection: Bool = false, help: String? = nil) {
        self.title = title
        self.isOff = isOff
        self.onSelection = onSelection
        self.help = help
    }

    public var body: some View {
        Text(title)
            .font(.system(size: 10.5, weight: .medium))
            .strikethrough(isOff, color: ConchColor.textTertiary.color(scheme))
            .foregroundStyle(isOff ? ConchColor.textTertiary : ConchColor.textSecondary)
            .lineLimit(1)
            .padding(.horizontal, 7)
            .frame(height: 18)
            .background(Capsule(style: .continuous).fill(onSelection ? ConchColor.surfaceRaised : ConchColor.fill))
            .help(help ?? (isOff ? "\(title): switched off for new sessions" : title))
    }
}

/// How a row's quietest words read on its ground: the tertiary level at rest, a step up on a selected row. The selection
/// is a translucent step from the card (`ConchColor.rowSelected`), and the tertiary level on it measured 4.01:1 in light
/// and 3.45:1 in dark; the secondary level holds 5.04 and 4.48 there, as the description beside it does.
enum LibraryRowText {
    static func quiet(selected: Bool) -> ConchColorToken {
        selected ? ConchColor.textSecondary : ConchColor.textTertiary
    }
}

/// A row's insets inside its card: the words 16 points in, as every Settings card's rows are (Logins', Browser's,
/// General's; they were 12 here, so the text jumped 4 points between sections), and 10 points above and below (a
/// benchmark's taller row keeps 11; Installed's ends on its chips and takes 12 under them).
///
/// `lineGap` is between a row's lines, the same in all three rows: Discover's were 4 apart and Installed's and
/// Benchmarks' 5, so a name sat 1 point closer to its description on one tab than on the other.
enum LibraryRowInset {
    static let horizontal: CGFloat = ConchSpace.x4
    static let vertical: CGFloat = 10
    static let lineGap: CGFloat = ConchSpace.x1
}

/// One skill Tyler has: its name, what it does, and a chip for every place it lives.
public struct InstalledSkillRow: View {
    let skill: InstalledSkillInfo
    let isSelected: Bool
    let onSelect: () -> Void
    @State private var isHovered = false

    public init(skill: InstalledSkillInfo, isSelected: Bool, onSelect: @escaping () -> Void) {
        self.skill = skill
        self.isSelected = isSelected
        self.onSelect = onSelect
    }

    public var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: LibraryRowInset.lineGap) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(skill.name)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(ConchColor.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    let detail = SkillsLibrary.detail(skill)
                    if !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: 11))
                            .foregroundStyle(LibraryRowText.quiet(selected: isSelected))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 0)
                }
                if let description = skill.description {
                    Text(description)
                        .font(.system(size: 11.5))
                        .foregroundStyle(ConchColor.textSecondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                LibraryFlow(spacing: 5) {
                    ForEach(SkillsLibrary.chips(skill)) { chip in
                        LibraryChip(chip.title, isOff: chip.isOff, onSelection: isSelected)
                    }
                }
                .padding(.top, 1)
            }
            .padding(.horizontal, LibraryRowInset.horizontal)
            .padding(.top, LibraryRowInset.vertical)
            // The row ends on the chips' capsules, a hard edge, where the other rows end on a line of words with the
            // space under its baseline: at 10 the capsules sat 10 points off the hairline while the name's capitals sat
            // 12.5 under the row's top. 12 evens them, to the half point.
            .padding(.bottom, ConchSpace.x3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Rectangle().fill(LibraryRowFill.style(selected: isSelected, hovered: isHovered)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

/// One skill from an index: its name, who reviewed it, what it does, and where it comes from.
public struct DiscoverSkillRow: View {
    let entry: DiscoverSkillInfo
    let detail: String
    let isSelected: Bool
    let onSelect: () -> Void
    @State private var isHovered = false

    public init(entry: DiscoverSkillInfo, detail: String, isSelected: Bool, onSelect: @escaping () -> Void) {
        self.entry = entry
        self.detail = detail
        self.isSelected = isSelected
        self.onSelect = onSelect
    }

    public var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: LibraryRowInset.lineGap) {
                HStack(alignment: .center, spacing: 6) {
                    // The name has the line first; the chip gives way before it does, and the mark before either.
                    Text(entry.name)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(ConchColor.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .layoutPriority(2)
                    if let trust = SkillsLibrary.trustTitle(entry.trust) {
                        LibraryChip(trust, onSelection: isSelected,
                                    help: entry.trust == "community" ? "Listed in Anthropic's directory; not reviewed by Anthropic or a partner" : trust)
                            // Centred on the name's line without making it taller: the 18-point capsule set an 18-point
                            // line where the name alone sets 15, so a reviewed skill's name sat 1.5 points lower in its
                            // row, and 1.5 further from its description, than every other row's.
                            .frame(height: 0)
                            .layoutPriority(1)
                    }
                    Spacer(minLength: 0)
                    if entry.installed == true {
                        // The words when the line has room for them; the mark alone when it doesn't. At the list's own
                        // width a reviewed skill's chip and "You have one" didn't both fit, and the chip was cut.
                        ViewThatFits(in: .horizontal) {
                            installedMark.labelStyle(.titleAndIcon)
                            installedMark.labelStyle(.iconOnly)
                        }
                        .help("A skill named \(entry.name) is installed somewhere already")
                    }
                }
                if let description = entry.description {
                    Text(description)
                        .font(.system(size: 11.5))
                        .foregroundStyle(ConchColor.textSecondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: 11))
                        .foregroundStyle(LibraryRowText.quiet(selected: isSelected))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .padding(.horizontal, LibraryRowInset.horizontal)
            .padding(.vertical, LibraryRowInset.vertical)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Rectangle().fill(LibraryRowFill.style(selected: isSelected, hovered: isHovered)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    private var installedMark: some View {
        Label("You have one", systemImage: "checkmark")
            .font(.system(size: 10.5, weight: .medium))
            .foregroundStyle(LibraryRowText.quiet(selected: isSelected))
            .lineLimit(1)
            .fixedSize()
    }
}

/// One benchmark index: what it measures, for which domains, who keeps it, how fresh it is, and a one-line take.
public struct BenchmarkRow: View {
    let index: BenchmarkIndexInfo
    let isSelected: Bool
    let onSelect: () -> Void
    @State private var isHovered = false

    public init(index: BenchmarkIndexInfo, isSelected: Bool, onSelect: @escaping () -> Void) {
        self.index = index
        self.isSelected = isSelected
        self.onSelect = onSelect
    }

    public var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: LibraryRowInset.lineGap) {
                // The kind is the group's heading, so the row doesn't say it again.
                Text(index.name)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(ConchColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(index.measures)
                    .font(.system(size: 11.5))
                    .foregroundStyle(ConchColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(index.take)
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(ConchColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                LibraryFlow(spacing: 5) {
                    ForEach(index.domains, id: \.self) { LibraryChip($0, onSelection: isSelected) }
                }
                .padding(.top, 1)
                Text("\(index.maintainer) · \(index.freshness)")
                    .font(.system(size: 11))
                    .foregroundStyle(LibraryRowText.quiet(selected: isSelected))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, LibraryRowInset.horizontal)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Rectangle().fill(LibraryRowFill.style(selected: isSelected, hovered: isHovered)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

/// A row's ground: the ledger's selection and hover, nothing at rest.
enum LibraryRowFill {
    static func style(selected: Bool, hovered: Bool) -> AnyShapeStyle {
        selected ? AnyShapeStyle(ConchColor.rowSelected) : hovered ? AnyShapeStyle(ConchColor.rowHover) : AnyShapeStyle(Color.clear)
    }
}

/// Chips laid out in lines, wrapping where the row ends.
///
/// `balanced` evens the lines out, as CSS's `text-wrap: balance` does: as many lines as the width needs, but each as
/// short as it can be while that many still hold everything. Discover's six index chips wrapped five and one in the
/// 860-point window, "skills.sh" alone on its line, which read as an accident rather than a second row.
public struct LibraryFlow: Layout {
    var spacing: CGFloat
    var balanced: Bool

    public init(spacing: CGFloat = 5, balanced: Bool = false) {
        self.spacing = spacing
        self.balanced = balanced
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let lines = Self.lines(sizes, width: wrapWidth(sizes, proposal.width ?? .infinity), spacing: spacing)
        let widest = lines.map { line in Self.length(line.map { sizes[$0].width }, spacing: spacing) }.max() ?? 0
        let tall = lines.map { line in line.map { sizes[$0].height }.max() ?? 0 }
        return CGSize(width: min(widest, proposal.width ?? widest),
                      height: tall.reduce(0, +) + spacing * CGFloat(max(0, tall.count - 1)))
    }

    public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        var y = bounds.minY
        for line in Self.lines(sizes, width: wrapWidth(sizes, bounds.width), spacing: spacing) {
            var x = bounds.minX
            let tall = line.map { sizes[$0].height }.max() ?? 0
            for index in line {
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(sizes[index]))
                x += sizes[index].width + spacing
            }
            y += tall + spacing
        }
    }

    /// Where lines break: `width` itself, or, balanced, the narrowest width that still needs no more lines than it.
    private func wrapWidth(_ sizes: [CGSize], _ width: CGFloat) -> CGFloat {
        guard balanced, width.isFinite else { return width }
        let count = Self.lines(sizes, width: width, spacing: spacing).count
        guard count > 1 else { return width }
        var low = sizes.map(\.width).max() ?? 0, high = width
        while high - low > 0.5 {
            let middle = (low + high) / 2
            if Self.lines(sizes, width: middle, spacing: spacing).count > count { low = middle } else { high = middle }
        }
        return high
    }

    /// The subviews' indexes, line by line, each line as long as fits in `width`.
    private static func lines(_ sizes: [CGSize], width: CGFloat, spacing: CGFloat) -> [[Int]] {
        var lines: [[Int]] = []
        var current: [Int] = []
        var x: CGFloat = 0
        for (index, size) in sizes.enumerated() {
            if !current.isEmpty, x + size.width > width {
                lines.append(current)
                current = []
                x = 0
            }
            current.append(index)
            x += size.width + spacing
        }
        if !current.isEmpty { lines.append(current) }
        return lines
    }

    private static func length(_ widths: [CGFloat], spacing: CGFloat) -> CGFloat {
        widths.reduce(0, +) + spacing * CGFloat(max(0, widths.count - 1))
    }
}
