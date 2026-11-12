import Foundation
import SwiftUI

// Teams (2026-11-12). Tyler: "would be nice to add 'teams' to conch settings to where we can set up team structures with
// specialized agents, rules for how they'll work together, and a hierarchy and then i can spin up or pass tasks to team
// types."
//
// A team type is a set of roles, one of them the lead and the rest reporting up to it, and rules: plain-language
// instructions conch hands every member. A running team is one instance of a type, on one task: its members are sessions
// conch started, grouped together in the sidebar under the team's header. The daemon's desk (src/team-desk.ts) owns the
// types and the running teams; Settings › Teams asks for them over the socket (`teams`), and the published state carries
// only the running teams (`teams`), for the sidebar.

// MARK: - What the daemon sends

/// Which agent a role runs. Its effort and permission choices are the daemon's to say (`TeamsList.agents`).
public enum TeamBackend: String, Codable, CaseIterable, Identifiable, Sendable {
    case claude, codex

    public var id: String { rawValue }

    /// How a person reads the agent's name.
    public var displayName: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Codex"
        }
    }
}

/// Where a member runs: a Terminal window, or conch's background host with no window. Absent on the wire is a Terminal.
public enum TeamHost: String, Codable, CaseIterable, Identifiable, Sendable {
    case terminal, background
    public var id: String { rawValue }
}

/// Where a member does its work: the team's own folder, or a git worktree of its own on a branch of its own.
public enum TeamWorkspace: String, Codable, CaseIterable, Identifiable, Sendable {
    case shared, worktree
    public var id: String { rawValue }
}

/// One role of a team type: who it is, the agent it runs on, what it is told, its limits, and whom it reports to.
public struct TeamRole: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    /// Another role's id. Exactly one role has none: the lead.
    public var reportsTo: String?
    public var backend: TeamBackend
    public var model: String?
    public var effort: String?
    /// Claude only: one of conch's Claude sign-ins, by its label or id. Absent: Default's own, rotating login.
    public var signIn: String?
    /// Claude's permission mode, or Codex's sandbox.
    public var permissions: String?
    public var host: TeamHost?
    public var prompt: String
    public var skills: [String]
    public var workspace: TeamWorkspace
    /// How many of this role may run at once. Absent is one.
    public var maxConcurrent: Int?
    public var budgetMinutes: Int?
    /// Started with the team, rather than when the lead asks for one. The lead always is.
    public var atStart: Bool?

    public init(
        id: String, name: String, reportsTo: String? = nil, backend: TeamBackend = .claude, model: String? = nil, effort: String? = nil,
        signIn: String? = nil, permissions: String? = nil, host: TeamHost? = nil, prompt: String = "", skills: [String] = [],
        workspace: TeamWorkspace = .shared, maxConcurrent: Int? = nil, budgetMinutes: Int? = nil, atStart: Bool? = nil
    ) {
        self.id = id
        self.name = name
        self.reportsTo = reportsTo
        self.backend = backend
        self.model = model
        self.effort = effort
        self.signIn = signIn
        self.permissions = permissions
        self.host = host
        self.prompt = prompt
        self.skills = skills
        self.workspace = workspace
        self.maxConcurrent = maxConcurrent
        self.budgetMinutes = budgetMinutes
        self.atStart = atStart
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, reportsTo, backend, model, effort, signIn, permissions, host, prompt, skills, workspace, maxConcurrent, budgetMinutes, atStart
    }

    /// What a role leaves out is its default: no skills, the team's folder, a Terminal window.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        reportsTo = try container.decodeIfPresent(String.self, forKey: .reportsTo)
        backend = try container.decode(TeamBackend.self, forKey: .backend)
        model = try container.decodeIfPresent(String.self, forKey: .model)
        effort = try container.decodeIfPresent(String.self, forKey: .effort)
        signIn = try container.decodeIfPresent(String.self, forKey: .signIn)
        permissions = try container.decodeIfPresent(String.self, forKey: .permissions)
        host = try? container.decodeIfPresent(TeamHost.self, forKey: .host)
        prompt = try container.decodeIfPresent(String.self, forKey: .prompt) ?? ""
        skills = try container.decodeIfPresent([String].self, forKey: .skills) ?? []
        workspace = (try? container.decodeIfPresent(TeamWorkspace.self, forKey: .workspace)) ?? .shared
        maxConcurrent = try container.decodeIfPresent(Int.self, forKey: .maxConcurrent)
        budgetMinutes = try container.decodeIfPresent(Int.self, forKey: .budgetMinutes)
        atStart = try container.decodeIfPresent(Bool.self, forKey: .atStart)
    }

    /// The lead: the one role reporting to nobody.
    public var isLead: Bool { reportsTo == nil }

    /// How many may run at once, the default said.
    public var limit: Int { maxConcurrent ?? 1 }
}

/// A team type: its roles in their hierarchy, and the rules for working together that conch hands each member.
public struct TeamType: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var summary: String
    public var roles: [TeamRole]
    public var rules: [String]

    public init(id: String, name: String, summary: String = "", roles: [TeamRole], rules: [String] = []) {
        self.id = id
        self.name = name
        self.summary = summary
        self.roles = roles
        self.rules = rules
    }

    private enum CodingKeys: String, CodingKey { case id, name, summary, roles, rules }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        summary = try container.decodeIfPresent(String.self, forKey: .summary) ?? ""
        roles = try container.decode([TeamRole].self, forKey: .roles)
        rules = try container.decodeIfPresent([String].self, forKey: .rules) ?? []
    }

    /// The lead, when the type has one.
    public var lead: TeamRole? { roles.first(where: \.isLead) }
}

/// One member of a running team: a role, and the session conch started for it once it has one.
public struct TeamMember: Codable, Equatable, Identifiable, Sendable {
    public enum State: String, Codable, Sendable {
        case starting, running, failed, ended

        /// One a newer daemon names that this build doesn't know reads as starting: neither failed nor gone.
        public init(from decoder: Decoder) throws {
            self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .starting
        }
    }

    /// "lead-1", "builder-2": the role and which of them.
    public let key: String
    public let roleId: String
    public let roleName: String
    public let label: String
    public let sessionId: String?
    public let state: State
    public let error: String?
    /// Epoch ms.
    public let startedAt: Double
    /// The member key it reports to.
    public let reportsTo: String?
    /// Its session's own status while it runs: "working", "waiting" or "needs", the ledger's. Absent otherwise.
    public let status: String?
    /// The time its role allows it, in minutes, when its role has a budget.
    public let budgetMinutes: Int?

    public var id: String { key }

    public init(key: String, roleId: String, roleName: String, label: String, sessionId: String? = nil, state: State,
                error: String? = nil, startedAt: Double, reportsTo: String? = nil, status: String? = nil, budgetMinutes: Int? = nil) {
        self.key = key
        self.roleId = roleId
        self.roleName = roleName
        self.label = label
        self.sessionId = sessionId
        self.state = state
        self.error = error
        self.startedAt = startedAt
        self.reportsTo = reportsTo
        self.status = status
        self.budgetMinutes = budgetMinutes
    }

    /// The role's name and which of them, as a chip says it: "Lead", "Builder 2". The first of a role is its name alone.
    public var title: String {
        guard let number = key.split(separator: "-").last.flatMap({ Int($0) }), number > 1 else { return roleName }
        return "\(roleName) \(number)"
    }
}

/// A task a team was given, and by whom: "you", or the label of the session that passed it.
public struct TeamTaskEntry: Codable, Equatable, Sendable {
    public let text: String
    /// Epoch ms.
    public let at: Double
    public let from: String

    public init(text: String, at: Double, from: String) {
        self.text = text
        self.at = at
        self.from = from
    }
}

/// A team instance: one type, on one task, in one folder, and its members.
public struct TeamSummary: Codable, Equatable, Identifiable, Sendable {
    /// "build-review-2".
    public let id: String
    public let typeId: String
    public let name: String
    public let task: String
    public let cwd: String
    /// Epoch ms.
    public let startedAt: Double
    public let endedAt: Double?
    public let members: [TeamMember]
    public let tasks: [TeamTaskEntry]

    public init(id: String, typeId: String, name: String, task: String, cwd: String, startedAt: Double, endedAt: Double? = nil,
                members: [TeamMember], tasks: [TeamTaskEntry] = []) {
        self.id = id
        self.typeId = typeId
        self.name = name
        self.task = task
        self.cwd = cwd
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.members = members
        self.tasks = tasks
    }

    private enum CodingKeys: String, CodingKey { case id, typeId, name, task, cwd, startedAt, endedAt, members, tasks }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        typeId = try container.decodeIfPresent(String.self, forKey: .typeId) ?? ""
        name = try container.decode(String.self, forKey: .name)
        task = try container.decodeIfPresent(String.self, forKey: .task) ?? ""
        cwd = try container.decodeIfPresent(String.self, forKey: .cwd) ?? ""
        startedAt = try container.decodeIfPresent(Double.self, forKey: .startedAt) ?? 0
        endedAt = try container.decodeIfPresent(Double.self, forKey: .endedAt)
        members = try container.decodeIfPresent([TeamMember].self, forKey: .members) ?? []
        tasks = try container.decodeIfPresent([TeamTaskEntry].self, forKey: .tasks) ?? []
    }

    /// The task it is on now: the latest it was passed, else the one it started on.
    public var currentTask: String { tasks.last?.text ?? task }

    /// Its lead, the member the rest report up to.
    public var lead: TeamMember? { members.first(where: { $0.reportsTo == nil }) ?? members.first }
}

/// One agent's choices for a role, as the daemon reads them from the agent's own start options.
public struct TeamAgentChoices: Codable, Equatable, Sendable {
    public let efforts: [String]
    public let permissions: [String]

    public init(efforts: [String], permissions: [String]) {
        self.efforts = efforts
        self.permissions = permissions
    }
}

/// One of conch's Claude sign-ins, label and id only (never anything of its token).
public struct TeamSignIn: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

/// The desk's list: every type, the running teams, what a role can choose, and how many starter types were deleted.
public struct TeamsList: Decodable, Equatable, Sendable {
    public let kind: String
    public let types: [TeamType]
    public let running: [TeamSummary]
    /// By backend: "claude", "codex".
    public let agents: [String: TeamAgentChoices]
    public let signIns: [TeamSignIn]
    /// conch's starter types no longer in the list: "Add back conch's starter types" offers them.
    public let missingStarters: Int
    /// The type a save or a duplicate just wrote.
    public let saved: String?

    public init(kind: String = "teams", types: [TeamType], running: [TeamSummary] = [], agents: [String: TeamAgentChoices] = [:],
                signIns: [TeamSignIn] = [], missingStarters: Int = 0, saved: String? = nil) {
        self.kind = kind
        self.types = types
        self.running = running
        self.agents = agents
        self.signIns = signIns
        self.missingStarters = missingStarters
        self.saved = saved
    }

    private enum CodingKeys: String, CodingKey { case kind, types, running, agents, signIns, missingStarters, saved }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(String.self, forKey: .kind)
        types = try container.decodeIfPresent([TeamType].self, forKey: .types) ?? []
        running = try container.decodeIfPresent([TeamSummary].self, forKey: .running) ?? []
        agents = (try? container.decodeIfPresent([String: TeamAgentChoices].self, forKey: .agents)) ?? [:]
        signIns = (try? container.decodeIfPresent([TeamSignIn].self, forKey: .signIns)) ?? []
        missingStarters = (try? container.decodeIfPresent(Int.self, forKey: .missingStarters)) ?? 0
        saved = try container.decodeIfPresent(String.self, forKey: .saved)
    }

    /// One agent's choices; none known reads as none to offer.
    public func choices(_ backend: TeamBackend) -> TeamAgentChoices {
        agents[backend.rawValue] ?? TeamAgentChoices(efforts: [], permissions: [])
    }
}

/// A request to the daemon's desk, as the socket takes it.
public enum TeamsRequest: Encodable, Equatable, Sendable {
    /// `{kind: "teams"}`
    case list
    /// `{kind: "team-type-save", type, previousId?}`: a new type, or one edited (whose id may have changed).
    case save(TeamType, previousId: String?)
    case delete(id: String)
    case duplicate(id: String)
    /// `{kind: "team-types-restore"}`: conch's starter types that were deleted, back.
    case restoreStarters
    /// `{kind: "team-start", type, task, cwd, trustFolder?}`
    case start(type: String, task: String, cwd: String, trustFolder: Bool)
    /// `{kind: "team-task", team, task}`: a running team's next task, through its lead.
    case passTask(team: String, task: String)
    case end(team: String)

    private enum Keys: String, CodingKey { case kind, type, previousId, id, task, cwd, trustFolder, team }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        switch self {
        case .list:
            try container.encode("teams", forKey: .kind)
        case let .save(type, previousId):
            try container.encode("team-type-save", forKey: .kind)
            try container.encode(type, forKey: .type)
            try container.encodeIfPresent(previousId, forKey: .previousId)
        case let .delete(id):
            try container.encode("team-type-delete", forKey: .kind)
            try container.encode(id, forKey: .id)
        case let .duplicate(id):
            try container.encode("team-type-duplicate", forKey: .kind)
            try container.encode(id, forKey: .id)
        case .restoreStarters:
            try container.encode("team-types-restore", forKey: .kind)
        case let .start(type, task, cwd, trustFolder):
            try container.encode("team-start", forKey: .kind)
            try container.encode(type, forKey: .type)
            try container.encode(task, forKey: .task)
            try container.encode(cwd, forKey: .cwd)
            if trustFolder { try container.encode(true, forKey: .trustFolder) }
        case let .passTask(team, task):
            try container.encode("team-task", forKey: .kind)
            try container.encode(team, forKey: .team)
            try container.encode(task, forKey: .task)
        case let .end(team):
            try container.encode("team-end", forKey: .kind)
            try container.encode(team, forKey: .team)
        }
    }
}

/// Every answer but the list: a start, a needs-trust, a task passed, or why not.
struct TeamsReply: Decodable {
    let kind: String
    let error: String?
    let field: String?
    let team: TeamSummary?
    let cwd: String?
    let agents: [String]?
    let to: String?
}

// MARK: - How it reads

/// The rules Settings › Teams and the sidebar read teams by: pure, so they are tested rather than looked at.
public enum Teams {
    /// The daemon's limits, mirrored so the editor says what is wrong before Save does.
    public static let maxRoles = 8
    public static let maxRules = 12
    public static let maxRuleLength = 500
    public static let maxPromptLength = 4_000
    public static let maxSkills = 12
    public static let maxSkillLength = 64
    public static let maxTaskLength = 4_000
    public static let maxTypeNameLength = 60
    public static let maxRoleNameLength = 40
    public static let maxSummaryLength = 300
    public static let roleIdLength = 32
    public static let typeIdLength = 40
    public static let concurrentRange = 1...8
    public static let budgetRange = 5...1_440

    // MARK: The hierarchy

    /// One role in the tree, and how deep it sits under the lead.
    public struct TreeRow: Equatable, Sendable, Identifiable {
        public let role: TeamRole
        public let depth: Int
        public var id: String { role.id }
    }

    /// The roles in their hierarchy's order: each role, then the roles reporting to it, in the order they were listed.
    /// A role reporting to one that isn't there, or caught in a loop, can't be placed under anyone: it comes at the end,
    /// at the top level, so the editor still shows it and its problem can be fixed.
    public static func tree(_ roles: [TeamRole]) -> [TreeRow] {
        let ids = Set(roles.map(\.id))
        var rows: [TreeRow] = []
        var placed: Set<String> = []
        func place(_ role: TeamRole, depth: Int) {
            guard placed.insert(role.id).inserted else { return }
            rows.append(TreeRow(role: role, depth: depth))
            // Bounded by `placed`: a role already drawn is never drawn again, so a loop ends.
            for child in roles where child.reportsTo == role.id && child.id != role.id { place(child, depth: depth + 1) }
        }
        for root in roles where root.reportsTo == nil { place(root, depth: 0) }
        // Reporting to a role that isn't there: at the end, at the top, then whatever reports to it.
        for orphan in roles where !placed.contains(orphan.id) && !ids.contains(orphan.reportsTo ?? "") { place(orphan, depth: 0) }
        // What is left is in a loop: its first member listed heads it at the top, then whatever reports to it.
        for looped in roles where !placed.contains(looped.id) { place(looped, depth: 0) }
        return rows
    }

    /// A role's name as the hierarchy line says it: "Builder ×3" when several may run at once.
    public static func countedName(_ role: TeamRole) -> String {
        role.limit > 1 ? "\(role.name) ×\(role.limit)" : role.name
    }

    /// The type's hierarchy in one line: "Lead → Builder ×3, Reviewer", and a deeper tree in brackets under the role it
    /// reports to: "Lead → Spec writer (Builder ×2), Researcher".
    public static func hierarchyLine(_ type: TeamType) -> String {
        hierarchyLine(type.roles)
    }

    public static func hierarchyLine(_ roles: [TeamRole]) -> String {
        guard let lead = roles.first(where: \.isLead) ?? roles.first else { return "" }
        var seen: Set<String> = [lead.id]
        func children(of role: TeamRole) -> [TeamRole] {
            roles.filter { $0.reportsTo == role.id && !seen.contains($0.id) }
        }
        func describe(_ role: TeamRole) -> String {
            seen.insert(role.id)
            let under = children(of: role)
            under.forEach { seen.insert($0.id) }
            let named = countedName(role)
            return under.isEmpty ? named : "\(named) (\(under.map(describe).joined(separator: ", ")))"
        }
        let reports = children(of: lead)
        reports.forEach { seen.insert($0.id) }
        let line = reports.map(describe)
        // Anything the tree couldn't place still counts as on the team.
        let rest = roles.filter { !seen.contains($0.id) }.map(countedName)
        let all = line + rest
        return all.isEmpty ? countedName(lead) : "\(countedName(lead)) → \(all.joined(separator: ", "))"
    }

    /// What a role runs as, in the short words a row has room for: "Claude · opus · high · own worktree · background".
    public static func roleDetail(_ role: TeamRole) -> String {
        var parts = [role.backend.displayName]
        if let model = nonEmpty(role.model) { parts.append(model) }
        if let effort = nonEmpty(role.effort) { parts.append(effort) }
        if role.backend == .claude, let signIn = nonEmpty(role.signIn) { parts.append("as \(signIn)") }
        if role.workspace == .worktree { parts.append("own worktree") }
        if role.host == .background { parts.append("background") }
        if !role.isLead, role.atStart != true { parts.append("on request") }
        if let budget = role.budgetMinutes { parts.append("\(budgetWords(budget)) budget") }
        return parts.joined(separator: " · ")
    }

    /// "45 min", "2 h", "1 h 30 min".
    public static func budgetWords(_ minutes: Int) -> String {
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        let rest = minutes % 60
        return rest == 0 ? "\(hours) h" : "\(hours) h \(rest) min"
    }

    /// "1 rule", "4 rules", "No rules".
    public static func rulesCount(_ count: Int) -> String {
        switch count {
        case 0: "No rules"
        case 1: "1 rule"
        default: "\(count) rules"
        }
    }

    // MARK: Editing

    /// Something the editor would refuse to save, named by its field as the daemon names them ("name", "roles.1.reportsTo",
    /// "rules.2"), so it is said beside that field.
    public struct Problem: Equatable, Sendable {
        public let field: String
        public let message: String

        public init(field: String, message: String) {
            self.field = field
            self.message = message
        }

        /// The role this problem is about, when it is about one: "roles.1.name" is the second role.
        public var roleIndex: Int? {
            let parts = field.split(separator: ".")
            guard parts.count >= 2, parts[0] == "roles" else { return nil }
            return Int(parts[1])
        }
    }

    /// The first thing wrong with a type, as the daemon would say it, or nil. Checked on the type as it will be saved
    /// (`cleaned`), with the agents' choices when they are known.
    public static func problem(in type: TeamType, agents: [String: TeamAgentChoices] = [:]) -> Problem? {
        let name = type.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return Problem(field: "name", message: "A team type needs a name.") }
        if name.count > maxTypeNameLength { return Problem(field: "name", message: "At most \(maxTypeNameLength) characters.") }
        if type.summary.count > maxSummaryLength { return Problem(field: "summary", message: "At most \(maxSummaryLength) characters.") }
        if type.roles.isEmpty { return Problem(field: "roles", message: "A team needs at least its lead.") }
        if type.roles.count > maxRoles { return Problem(field: "roles", message: "At most \(maxRoles) roles.") }
        let leads = type.roles.filter(\.isLead)
        if leads.isEmpty { return Problem(field: "roles", message: "One role has to lead: the one reporting to nobody.") }
        if leads.count > 1 {
            let second = type.roles.firstIndex(where: { $0.id == leads[1].id }) ?? 0
            return Problem(field: "roles.\(second).reportsTo", message: "Only one role leads. Say whom \(leads[1].name) reports to.")
        }
        var ids: Set<String> = []
        let known = Set(type.roles.map(\.id))
        for (index, role) in type.roles.enumerated() {
            let field = { (key: String) in "roles.\(index).\(key)" }
            let roleName = role.name.trimmingCharacters(in: .whitespacesAndNewlines)
            if roleName.isEmpty { return Problem(field: field("name"), message: "A role needs a name.") }
            if roleName.count > maxRoleNameLength { return Problem(field: field("name"), message: "At most \(maxRoleNameLength) characters.") }
            if !isSlug(role.id, max: roleIdLength) { return Problem(field: field("id"), message: "A role's id is lower-case letters, digits and dashes.") }
            if !ids.insert(role.id).inserted { return Problem(field: field("name"), message: "Two roles can't share a name.") }
            if let boss = role.reportsTo {
                if boss == role.id { return Problem(field: field("reportsTo"), message: "A role can't report to itself.") }
                if !known.contains(boss) { return Problem(field: field("reportsTo"), message: "It reports to a role that isn't on the team.") }
            }
            if role.prompt.count > maxPromptLength { return Problem(field: field("prompt"), message: "At most \(maxPromptLength) characters.") }
            if role.skills.count > maxSkills { return Problem(field: field("skills"), message: "At most \(maxSkills) skills.") }
            if role.skills.contains(where: { $0.count > maxSkillLength }) { return Problem(field: field("skills"), message: "A skill's name is at most \(maxSkillLength) characters.") }
            if let limit = role.maxConcurrent, !concurrentRange.contains(limit) {
                return Problem(field: field("maxConcurrent"), message: "Between \(concurrentRange.lowerBound) and \(concurrentRange.upperBound) at once.")
            }
            if let budget = role.budgetMinutes, !budgetRange.contains(budget) {
                return Problem(field: field("budgetMinutes"), message: "Between \(budgetRange.lowerBound) minutes and \(budgetRange.upperBound / 60) hours.")
            }
            if role.backend != .claude, nonEmpty(role.signIn) != nil {
                return Problem(field: field("signIn"), message: "A sign-in is for Claude: Codex signs in with its own accounts.")
            }
            if let choices = agents[role.backend.rawValue] {
                if let effort = nonEmpty(role.effort), !choices.efforts.isEmpty, !choices.efforts.contains(effort) {
                    return Problem(field: field("effort"), message: "\(role.backend.displayName)'s effort is one of \(choices.efforts.joined(separator: ", ")).")
                }
                if let permissions = nonEmpty(role.permissions), !choices.permissions.isEmpty, !choices.permissions.contains(permissions) {
                    return Problem(field: field("permissions"), message: "\(role.backend.displayName)'s permissions are one of \(choices.permissions.joined(separator: ", ")).")
                }
            }
        }
        // A loop: walking up from a role never reaches the lead.
        let bossOf = Dictionary(type.roles.map { ($0.id, $0.reportsTo) }, uniquingKeysWith: { first, _ in first })
        for (index, role) in type.roles.enumerated() {
            var seen: Set<String> = [role.id]
            var current = role.reportsTo
            while let boss = current {
                if !seen.insert(boss).inserted {
                    return Problem(field: "roles.\(index).reportsTo", message: "\(role.name) reports in a circle that never reaches the lead.")
                }
                current = bossOf[boss] ?? nil
            }
        }
        if type.rules.count > maxRules { return Problem(field: "rules", message: "At most \(maxRules) rules.") }
        for (index, rule) in type.rules.enumerated() where rule.count > maxRuleLength {
            return Problem(field: "rules.\(index)", message: "At most \(maxRuleLength) characters.")
        }
        return nil
    }

    /// The type as it is saved: words trimmed, an empty field left out rather than sent empty, empty rules and skills
    /// dropped, the lead reporting to nobody and always started with the team, a sign-in only for Claude.
    public static func cleaned(_ type: TeamType) -> TeamType {
        var type = type
        type.name = type.name.trimmingCharacters(in: .whitespacesAndNewlines)
        type.summary = type.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        type.rules = type.rules.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        type.roles = type.roles.map { role in
            var role = role
            role.name = role.name.trimmingCharacters(in: .whitespacesAndNewlines)
            role.model = nonEmpty(role.model)
            role.effort = nonEmpty(role.effort)
            role.signIn = role.backend == .claude ? nonEmpty(role.signIn) : nil
            role.permissions = nonEmpty(role.permissions)
            role.prompt = role.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
            role.skills = role.skills.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            if role.maxConcurrent == 1 { role.maxConcurrent = nil }
            if role.host == .terminal { role.host = nil }
            if role.isLead { role.atStart = true } else if role.atStart == false { role.atStart = nil }
            return role
        }
        return type
    }

    /// A name as an id: lower-case letters and digits, everything else one dash, none at either end, at most `max`
    /// characters. Nothing usable left is `fallback`.
    public static func slug(_ name: String, max: Int = roleIdLength, fallback: String = "role") -> String {
        var slug = ""
        for scalar in name.lowercased().unicodeScalars {
            if ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) {
                slug.unicodeScalars.append(scalar)
            } else if !slug.isEmpty, !slug.hasSuffix("-") {
                slug.append("-")
            }
        }
        while slug.hasSuffix("-") { slug.removeLast() }
        if slug.count > max {
            slug = String(slug.prefix(max))
            while slug.hasSuffix("-") { slug.removeLast() }
        }
        return slug.isEmpty ? fallback : slug
    }

    /// `base`, or `base-2`, `base-3`… whichever isn't taken, within `max` characters.
    public static func uniqueSlug(_ base: String, taken: Set<String>, max: Int = roleIdLength) -> String {
        guard taken.contains(base) else { return base }
        var number = 2
        while true {
            let suffix = "-\(number)"
            let candidate = String(base.prefix(max - suffix.count)) + suffix
            if !taken.contains(candidate) { return candidate }
            number += 1
        }
    }

    public static func isSlug(_ id: String, max: Int) -> Bool {
        guard !id.isEmpty, id.count <= max, !id.hasPrefix("-"), !id.hasSuffix("-") else { return false }
        return id.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }

    /// A role added to a type: a member reporting to the lead, on Claude, in the team's folder, one at a time, started
    /// when the lead asks for one.
    public static func newRole(in type: TeamType) -> TeamRole {
        let taken = Set(type.roles.map(\.id))
        let names = Set(type.roles.map(\.name))
        var name = "Member"
        var number = 2
        while names.contains(name) {
            name = "Member \(number)"
            number += 1
        }
        return TeamRole(id: uniqueSlug(slug(name), taken: taken), name: name, reportsTo: type.lead?.id, backend: .claude, workspace: .shared)
    }

    /// A type added from nothing: a lead alone, to be given members and rules.
    public static func newType(existing: [TeamType]) -> TeamType {
        let names = Set(existing.map(\.name))
        var name = "New team"
        var number = 2
        while names.contains(name) {
            name = "New team \(number)"
            number += 1
        }
        let id = uniqueSlug(slug(name, max: typeIdLength, fallback: "team"), taken: Set(existing.map(\.id)), max: typeIdLength)
        return TeamType(id: id, name: name, roles: [TeamRole(id: "lead", name: "Lead", backend: .claude, atStart: true)])
    }

    /// A role renamed in the editor: its id follows its name while the type is new to the daemon, and stays put once saved,
    /// so a running team's members and what reports to it keep pointing at it. `renamed` is what reports to it, updated.
    public static func renaming(_ roles: [TeamRole], at index: Int, to name: String, followsName: Bool) -> [TeamRole] {
        guard roles.indices.contains(index) else { return roles }
        var roles = roles
        let old = roles[index].id
        roles[index].name = name
        guard followsName else { return roles }
        let taken = Set(roles.enumerated().filter { $0.offset != index }.map(\.element.id))
        let id = uniqueSlug(slug(name), taken: taken)
        roles[index].id = id
        for other in roles.indices where roles[other].reportsTo == old { roles[other].reportsTo = id }
        return roles
    }

    /// A role taken off: whatever reported to it reports to its own boss instead, so the tree stays whole.
    public static func removing(_ roles: [TeamRole], at index: Int) -> [TeamRole] {
        guard roles.indices.contains(index) else { return roles }
        var roles = roles
        let gone = roles.remove(at: index)
        for other in roles.indices where roles[other].reportsTo == gone.id { roles[other].reportsTo = gone.reportsTo }
        return roles
    }

    /// Skills as the editor's one field shows them, and back: comma-separated.
    public static func skillsText(_ skills: [String]) -> String { skills.joined(separator: ", ") }

    public static func skills(from text: String) -> [String] {
        text.split(whereSeparator: { $0 == "," || $0 == "\n" }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    // MARK: Running teams

    /// A member's state in words: "Starting…", "Running · 12m", "Couldn't start: …", "Ended".
    public static func memberLine(_ member: TeamMember, now: Date) -> String {
        switch member.state {
        case .starting: return "Starting…"
        case .running:
            let doing = member.status == "needs" ? "Needs you" : member.status == "waiting" ? "Waiting" : "Working"
            return "\(doing) · \(FailureTickets.ago(member.startedAt, now: now))"
        case .failed: return member.error.map { "Couldn't start: \($0)" } ?? "Couldn't start"
        case .ended: return "Ended"
        }
    }

    /// The line under a running team's task: how many, how long, where. "3 members · started 12m ago · in ~/Projects/app".
    public static func runningLine(_ team: TeamSummary, now: Date, home: String) -> String {
        let live = team.members.filter { $0.state == .running || $0.state == .starting }.count
        let failed = team.members.filter { $0.state == .failed }.count
        let members = (live == 1 ? "1 member" : "\(live) members") + (failed > 0 ? ", \(failed) couldn't start" : "")
        let ago = FailureTickets.ago(team.startedAt, now: now)
        let started = ago == "now" ? "started just now" : "started \(ago) ago"
        return "\(members) · \(started) · in \(tilde(team.cwd, home: home))"
    }

    /// A path with the home folder said as `~`.
    public static func tilde(_ path: String, home: String) -> String {
        guard !home.isEmpty else { return path }
        if path == home { return "~" }
        if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
        return path
    }

    /// The agents a start would ask to trust a folder, as a sentence's subject: "Claude Code", "Claude Code and Codex".
    public static func agentList(_ agents: [String]) -> String {
        switch agents.count {
        case 0: return "The agents"
        case 1: return agents[0]
        default: return agents.dropLast().joined(separator: ", ") + " and " + agents.last!
        }
    }

    /// The running teams as the sidebar groups them: each member's session, lead first, in the members' order.
    public static func sidebarTeams(_ running: [TeamSummary]) -> [SessionGrouping.Team] {
        running.filter { $0.endedAt == nil }.map { team in
            SessionGrouping.Team(id: team.id, name: team.name, task: team.currentTask,
                                 memberSessionIDs: team.members.compactMap(\.sessionId))
        }
    }

    /// The dot a member's chip carries: while it runs, its session's own status in the ledger's colours (working blue,
    /// waiting green, needing you red); else starting faint, failed red, ended grey.
    public static func stateColor(_ member: TeamMember) -> ConchColorToken {
        switch member.state {
        case .starting: return ConchColor.textTertiary
        case .failed: return ConchColor.attention
        case .ended: return ConchColor.quiet
        case .running:
            switch member.status {
            case "waiting": return ConchColor.ready
            case "needs": return ConchColor.attention
            default: return ConchColor.active
            }
        }
    }

    static func nonEmpty(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }
}

// MARK: - The store

/// Settings › Teams' state: the list as the daemon last answered, what is being done, and what went wrong where.
@MainActor
public final class TeamsStore: ObservableObject {
    public enum Phase: Equatable {
        case loading
        case loaded(TeamsList)
        case needsUpdate
        case unreachable
    }

    /// What a start came to.
    public enum StartOutcome: Equatable {
        case started(TeamSummary)
        /// Nothing started: the agents haven't been told to trust the folder. "Trust and start" sends it again with
        /// `trustFolder`.
        case needsTrust(cwd: String, agents: [String])
        case failed(String)
    }

    /// What passing a task came to: whose prompt it went into, or why not.
    public enum TaskOutcome: Equatable {
        case sent(to: String)
        case failed(String)
    }

    @Published public private(set) var phase: Phase = .loading
    /// Things under way, by the type or team they are about.
    @Published public private(set) var acting: Set<String> = []
    /// Why the last action failed, by the type or team it was about ("" for the page's own).
    @Published public private(set) var problems: [String: String] = [:]

    private let transport: @MainActor (TeamsRequest) async throws -> Data

    public init(transport: @escaping @MainActor (TeamsRequest) async throws -> Data) {
        self.transport = transport
    }

    /// For a picture of the page (the design gallery): the list it shows, and a transport that answers nothing.
    public init(preview list: TeamsList) {
        transport = { _ in Data() }
        phase = .loaded(list)
    }

    public var list: TeamsList? {
        if case let .loaded(list) = phase { return list }
        return nil
    }

    public func load() async {
        do {
            let data = try await transport(.list)
            guard let list = try? JSONDecoder().decode(TeamsList.self, from: data), list.kind == "teams" else {
                if case .loaded = phase { return }
                phase = .needsUpdate
                return
            }
            phase = .loaded(list)
        } catch {
            if case .loaded = phase { return }
            phase = .unreachable
        }
    }

    /// Save a type: nil when it was, else the problem, named by its field when the daemon named one.
    public func save(_ type: TeamType, previousId: String?) async -> Teams.Problem? {
        let cleaned = Teams.cleaned(type)
        if let problem = Teams.problem(in: cleaned, agents: list?.agents ?? [:]) { return problem }
        return await listAction(.save(cleaned, previousId: previousId), key: previousId ?? cleaned.id)
    }

    public func delete(_ id: String) async {
        _ = await listAction(.delete(id: id), key: id)
    }

    /// The copy's id, once the daemon has made it.
    @discardableResult
    public func duplicate(_ id: String) async -> String? {
        let problem = await listAction(.duplicate(id: id), key: id)
        return problem == nil ? list?.saved : nil
    }

    public func restoreStarters() async {
        _ = await listAction(.restoreStarters, key: "")
    }

    public func end(_ team: String) async {
        _ = await listAction(.end(team: team), key: team)
    }

    public func start(type: String, task: String, cwd: String, trustFolder: Bool = false) async -> StartOutcome {
        let outcome = await TeamsStore.start(type: type, task: task, cwd: cwd, trustFolder: trustFolder, transport: transport)
        if case .started = outcome { await load() }
        return outcome
    }

    public func passTask(team: String, task: String) async -> TaskOutcome {
        let outcome = await TeamsStore.passTask(team: team, task: task, transport: transport)
        if case .sent = outcome { await load() }
        return outcome
    }

    /// A start, sent and read: for a sheet with no store of its own.
    public static func start(type: String, task: String, cwd: String, trustFolder: Bool,
                             transport: @MainActor (TeamsRequest) async throws -> Data) async -> StartOutcome {
        let words = task.trimmingCharacters(in: .whitespacesAndNewlines)
        if words.isEmpty { return .failed("Say what the team should do.") }
        if words.count > Teams.maxTaskLength { return .failed("A task is at most \(Teams.maxTaskLength) characters.") }
        if cwd.trimmingCharacters(in: .whitespaces).isEmpty { return .failed("Choose the folder the team works in.") }
        guard let data = try? await transport(.start(type: type, task: words, cwd: cwd, trustFolder: trustFolder)) else {
            return .failed("conch's daemon didn't answer. Try again.")
        }
        guard let reply = try? JSONDecoder().decode(TeamsReply.self, from: data) else {
            return .failed("This conch can't start teams yet: it needs an updated daemon.")
        }
        switch reply.kind {
        case "team-started":
            if let team = reply.team { return .started(team) }
            return .failed("conch started the team but didn't say which.")
        case "team-needs-trust":
            return .needsTrust(cwd: reply.cwd ?? cwd, agents: reply.agents ?? [])
        case "team-error":
            return .failed(reply.error ?? "The team didn't start.")
        default:
            return .failed("This conch can't start teams yet: it needs an updated daemon.")
        }
    }

    /// A task passed to a running team's lead, sent and read: the sidebar's sheet has no store of its own.
    public static func passTask(team: String, task: String, transport: @MainActor (TeamsRequest) async throws -> Data) async -> TaskOutcome {
        let words = task.trimmingCharacters(in: .whitespacesAndNewlines)
        if words.isEmpty { return .failed("Say what the team should do next.") }
        if words.count > Teams.maxTaskLength { return .failed("A task is at most \(Teams.maxTaskLength) characters.") }
        guard let data = try? await transport(.passTask(team: team, task: words)) else {
            return .failed("conch's daemon didn't answer. Try again.")
        }
        guard let reply = try? JSONDecoder().decode(TeamsReply.self, from: data) else {
            return .failed("This conch can't pass tasks to teams yet: it needs an updated daemon.")
        }
        switch reply.kind {
        case "team-tasked": return .sent(to: reply.to ?? reply.team?.lead?.label ?? "the lead")
        case "team-error": return .failed(reply.error ?? "The task wasn't passed on.")
        default: return .failed("This conch can't pass tasks to teams yet: it needs an updated daemon.")
        }
    }

    /// An end, sent: the sidebar's "End team".
    public static func end(team: String, transport: @MainActor (TeamsRequest) async throws -> Data) async -> String? {
        guard let data = try? await transport(.end(team: team)) else { return "conch's daemon didn't answer. Try again." }
        if let reply = try? JSONDecoder().decode(TeamsReply.self, from: data), reply.kind == "team-error" {
            return reply.error ?? "The team didn't end."
        }
        return nil
    }

    /// An action whose answer is the list again: nil when it was taken, else why not (also kept under `key`).
    private func listAction(_ request: TeamsRequest, key: String) async -> Teams.Problem? {
        guard acting.insert(key).inserted else { return Teams.Problem(field: "", message: "Still working on the last change.") }
        defer { acting.remove(key) }
        problems[key] = nil
        let data: Data
        do {
            data = try await transport(request)
        } catch {
            let message = "conch's daemon didn't answer. Try again."
            problems[key] = message
            return Teams.Problem(field: "", message: message)
        }
        if let list = try? JSONDecoder().decode(TeamsList.self, from: data), list.kind == "teams" {
            phase = .loaded(list)
            return nil
        }
        let reply = try? JSONDecoder().decode(TeamsReply.self, from: data)
        let message = reply?.kind == "team-error" ? (reply?.error ?? "That didn't work.") : "This conch can't change teams yet: it needs an updated daemon."
        problems[key] = message
        return Teams.Problem(field: reply?.field ?? "", message: message)
    }
}
