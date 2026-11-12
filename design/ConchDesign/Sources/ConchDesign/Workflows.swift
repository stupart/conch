import Foundation

/// Claude Code's workflows, for Settings › Workflows (2026-11-11): the wire the daemon answers with (src/workflows.ts says
/// what a workflow is and where they live), and the rules the list and the reader share. Tyler: "Workflows - making the
/// rest of the app like skills, workflows, etc much more pleasurable to use." A saved workflow is used as a skill is, by
/// typing its line into an open session (LibraryUse.swift); a run's progress is said here. The views are
/// WorkflowViews.swift; the Mac wires them in WorkflowsLibraryView.swift.

extension LibraryUses {
    /// Where a saved workflow can be started now: each open Claude session one of its copies reaches.
    public static func workflow(_ workflow: WorkflowInfo, among sessions: [LibrarySession]) -> [LibraryUse] {
        guard workflow.problem == nil else { return [] }
        return sessions.compactMap { session in
            guard let location = workflow.locations.first(where: { $0.enabled != false
                && session.loads(agent: $0.agent, accountId: $0.origin == "project" ? nil : $0.accountId, projectPath: $0.projectPath) })
            else { return nil }
            return LibraryUse(session: session, line: location.invocation)
        }
    }
}

extension SkillsLibraryRequest {
    /// Every saved workflow, and the open sessions' runs.
    public static func workflows(offset: Int = 0, refresh: Bool = false) -> Self {
        var request = Self(action: "workflows")
        request.offset = offset > 0 ? offset : nil
        request.refresh = refresh ? true : nil
        return request
    }

}

// MARK: - Workflows' wire

public struct WorkflowPhaseInfo: Decodable, Hashable, Sendable {
    public let title: String
    public let detail: String?

    public init(title: String, detail: String? = nil) {
        self.title = title
        self.detail = detail
    }
}

public struct WorkflowLocationInfo: Decodable, Hashable, Identifiable, Sendable {
    public let agent: String
    public let accountId: String?
    public let accountLabel: String?
    /// user, project or plugin.
    public let origin: String
    public let path: String
    public let projectPath: String?
    public let pluginId: String?
    public let enabled: Bool?
    public let invocation: String

    public var id: String { "\(accountId ?? "*")|\(path)" }

    public init(agent: String = "claude", accountId: String? = nil, accountLabel: String? = nil, origin: String, path: String,
                projectPath: String? = nil, pluginId: String? = nil, enabled: Bool? = true, invocation: String) {
        self.agent = agent
        self.accountId = accountId
        self.accountLabel = accountLabel
        self.origin = origin
        self.path = path
        self.projectPath = projectPath
        self.pluginId = pluginId
        self.enabled = enabled
        self.invocation = invocation
    }

    public var folder: String { (path as NSString).deletingLastPathComponent }
    public var file: String { (path as NSString).lastPathComponent }
}

public struct WorkflowInfo: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let description: String?
    public let whenToUse: String?
    public let phases: [WorkflowPhaseInfo]
    public let origin: String
    public let plugin: String?
    public let locations: [WorkflowLocationInfo]
    public let versions: Int
    /// Why Claude Code skips it.
    public let problem: String?

    public init(id: String, name: String, description: String? = nil, whenToUse: String? = nil, phases: [WorkflowPhaseInfo] = [],
                origin: String, plugin: String? = nil, locations: [WorkflowLocationInfo], versions: Int = 1, problem: String? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.whenToUse = whenToUse
        self.phases = phases
        self.origin = origin
        self.plugin = plugin
        self.locations = locations
        self.versions = versions
        self.problem = problem
    }
}

public struct WorkflowAccountInfo: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let label: String
    public let configDir: String
    /// "on", "off" or "default".
    public let feature: String
    public let workflows: Int

    public init(id: String, label: String, configDir: String = "", feature: String = "default", workflows: Int = 0) {
        self.id = id
        self.label = label
        self.configDir = configDir
        self.feature = feature
        self.workflows = workflows
    }
}

public struct WorkflowRunPhaseInfo: Decodable, Hashable, Sendable {
    public let title: String
    public let detail: String?
    public let started: Int
    public let done: Int

    public init(title: String, detail: String? = nil, started: Int = 0, done: Int = 0) {
        self.title = title
        self.detail = detail
        self.started = started
        self.done = done
    }
}

public struct WorkflowRunInfo: Decodable, Hashable, Identifiable, Sendable {
    public struct Agents: Decodable, Hashable, Sendable {
        public let started: Int
        public let done: Int
        public init(started: Int, done: Int) { self.started = started; self.done = done }
    }

    public let runId: String
    public let sessionId: String
    public let sessionLabel: String
    public let name: String
    /// "running", or how it ended ("completed", …).
    public let status: String
    public let phases: [WorkflowRunPhaseInfo]
    public let currentPhase: String?
    public let agents: Agents
    /// Epoch milliseconds.
    public let startedAt: Double?
    public let updatedAt: Double
    public let durationMs: Double?
    public let summary: String?

    public var id: String { "\(sessionId)|\(runId)" }
    public var isRunning: Bool { status == "running" }

    public init(runId: String, sessionId: String, sessionLabel: String, name: String, status: String, phases: [WorkflowRunPhaseInfo] = [],
                currentPhase: String? = nil, agents: Agents = Agents(started: 0, done: 0), startedAt: Double? = nil, updatedAt: Double,
                durationMs: Double? = nil, summary: String? = nil) {
        self.runId = runId
        self.sessionId = sessionId
        self.sessionLabel = sessionLabel
        self.name = name
        self.status = status
        self.phases = phases
        self.currentPhase = currentPhase
        self.agents = agents
        self.startedAt = startedAt
        self.updatedAt = updatedAt
        self.durationMs = durationMs
        self.summary = summary
    }
}

public struct WorkflowsPage: Decodable, Sendable {
    public let kind: String
    public let action: String
    public let accounts: [WorkflowAccountInfo]
    public let workflows: [WorkflowInfo]
    public let total: Int
    public let next: Int?
    public let runs: [WorkflowRunInfo]
    public let problems: [String]
    public let readAt: Double
}

// MARK: - Workflows' rules

public enum WorkflowsLibrary {
    public static func originTitle(_ origin: String) -> String {
        switch origin {
        case "user": "Yours"
        case "project": "In your projects"
        default: "From plugins"
        }
    }

    public static func originSymbol(_ origin: String) -> String {
        SkillsLibrary.originSymbol(origin)
    }

    public static let originOrder = ["user", "project", "plugin"]

    public struct Group: Identifiable, Sendable {
        public let origin: String
        public let workflows: [WorkflowInfo]
        public var id: String { origin }
        public var title: String { WorkflowsLibrary.originTitle(origin) }
        public var symbol: String { WorkflowsLibrary.originSymbol(origin) }
    }

    public static func groups(_ workflows: [WorkflowInfo]) -> [Group] {
        originOrder.compactMap { origin in
            let members = workflows.filter { $0.origin == origin }
            return members.isEmpty ? nil : Group(origin: origin, workflows: members)
        }
    }

    /// Every word in the name, the description, when to use it, a phase or the plugin.
    public static func filter(_ workflows: [WorkflowInfo], query: String) -> [WorkflowInfo] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return workflows }
        return workflows.filter { workflow in
            let haystack = ([workflow.name, workflow.description ?? "", workflow.whenToUse ?? "", workflow.plugin ?? ""] + workflow.phases.map(\.title))
                .joined(separator: " ").lowercased()
            return words.allSatisfy { haystack.contains($0) }
        }
    }

    /// Where a copy lives, as a chip says it.
    public static func locationTitle(_ location: WorkflowLocationInfo) -> String {
        if let label = location.accountLabel { return "Claude · \(label)" }
        if let project = location.projectPath {
            let parts = (project as NSString).pathComponents.filter { $0 != "/" }.suffix(2)
            return "Claude · \(parts.joined(separator: "/"))"
        }
        return "Claude · every account"
    }

    public static func chips(_ workflow: WorkflowInfo) -> [SkillsLibrary.Chip] {
        var order: [String] = []
        var off: [String: Bool] = [:]
        for location in workflow.locations {
            let title = locationTitle(location)
            if off[title] == nil { order.append(title) }
            off[title] = (off[title] ?? true) && location.enabled == false
        }
        return order.map { SkillsLibrary.Chip(title: $0, isOff: off[$0] ?? false) }
    }

    /// The line beside a workflow's name: how it is typed, how many phases, whether its copies differ.
    public static func detail(_ workflow: WorkflowInfo) -> String {
        var parts: [String] = []
        if let line = workflow.locations.first?.invocation, workflow.problem == nil { parts.append(line) }
        if !workflow.phases.isEmpty { parts.append(workflow.phases.count == 1 ? "1 phase" : "\(workflow.phases.count) phases") }
        if workflow.versions > 1 { parts.append("\(workflow.versions) different copies") }
        return parts.joined(separator: " · ")
    }

    /// The accounts whose settings turn workflows off, as one line; nil when none do.
    public static func featureOffLine(_ accounts: [WorkflowAccountInfo]) -> String? {
        let off = accounts.filter { $0.feature == "off" }.map(\.label)
        guard !off.isEmpty else { return nil }
        let names = off.count == 1 ? off[0] : off.dropLast().joined(separator: ", ") + " and " + off.last!
        return "Workflows are off for \(names) in Claude Code's settings, so \(off.count == 1 ? "its" : "their") sessions don't offer them. Turn them on with /config in a session."
    }

    // Runs

    /// The run's state in a few words: "Running · Verify", "Completed", "Stopped".
    public static func runState(_ run: WorkflowRunInfo) -> String {
        if run.isRunning { return run.currentPhase.map { "Running · \($0)" } ?? "Running" }
        return run.status.prefix(1).uppercased() + run.status.dropFirst()
    }

    /// "3 of 5 agents done", "1 agent", "no agents yet".
    public static func agentsLine(_ agents: WorkflowRunInfo.Agents, running: Bool) -> String {
        guard agents.started > 0 else { return running ? "no agents yet" : "no agents" }
        if running { return "\(agents.done) of \(agents.started) agents done" }
        return agents.started == 1 ? "1 agent" : "\(agents.started) agents"
    }

    /// A phase's agents: "2 of 6 agents" while any is working, "4 agents" once all are done, nothing before it starts.
    public static func phaseAgents(_ phase: WorkflowRunPhaseInfo, running: Bool) -> String {
        guard phase.started > 0 else { return running ? "not started" : "—" }
        if phase.done == phase.started { return phase.started == 1 ? "1 agent" : "\(phase.started) agents" }
        return "\(phase.done) of \(phase.started) agents"
    }

    /// How far a phase is: nil before it starts, 0…1 while its agents work, 1 once they are all done.
    public static func fraction(_ phase: WorkflowRunPhaseInfo) -> Double? {
        guard phase.started > 0 else { return nil }
        return Double(phase.done) / Double(phase.started)
    }

    /// The whole run's: phases finished, plus the current one's share; nil when nothing has started.
    public static func fraction(_ run: WorkflowRunInfo) -> Double? {
        if !run.isRunning { return 1 }
        guard run.agents.started > 0 else { return nil }
        let phases = run.phases.count
        guard phases > 0 else { return Double(run.agents.done) / Double(run.agents.started) }
        let finished = run.phases.filter { $0.started > 0 && $0.done == $0.started && $0.title != run.currentPhase }.count
        let current = run.phases.first { $0.title == run.currentPhase }.flatMap(fraction) ?? 0
        return min(1, (Double(finished) + current) / Double(phases))
    }

    /// When, as a person says it: "just now", "4 min ago", "2 h ago".
    public static func ago(_ milliseconds: Double?, now: Date = Date()) -> String? {
        guard let milliseconds else { return nil }
        let seconds = max(0, now.timeIntervalSince(Date(timeIntervalSince1970: milliseconds / 1000)))
        if seconds < 60 { return "just now" }
        if seconds < 3_600 { return "\(Int(seconds / 60)) min ago" }
        if seconds < 86_400 { return "\(Int(seconds / 3_600)) h ago" }
        return "\(Int(seconds / 86_400)) d ago"
    }

    /// A run's length: "4 min", "1 h 12 min", "40 s".
    public static func duration(_ milliseconds: Double?) -> String? {
        guard let milliseconds, milliseconds >= 0 else { return nil }
        let seconds = Int(milliseconds / 1000)
        if seconds < 60 { return "\(seconds) s" }
        if seconds < 3_600 { return "\(seconds / 60) min" }
        return "\(seconds / 3_600) h \(seconds % 3_600 / 60) min"
    }

    /// The line under a run's name: where it runs and how far, or how long it took. The reader, whose button names the
    /// session, leaves it out.
    public static func runDetail(_ run: WorkflowRunInfo, now: Date = Date(), session: Bool = true) -> String {
        var parts = (session ? [run.sessionLabel] : []) + [agentsLine(run.agents, running: run.isRunning)]
        if run.isRunning {
            if let started = ago(run.startedAt, now: now) { parts.append("started \(started)") }
        } else {
            if let took = duration(run.durationMs) { parts.append(took) }
            if let ended = ago(run.updatedAt, now: now) { parts.append(ended) }
        }
        return parts.joined(separator: " · ")
    }
}
