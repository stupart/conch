import Foundation

/// A line a person can type into a session: one of the agent's slash commands, or one of its skills.
/// The Mac's ⌘K palette and the phone's Commands sheet list the same ones, from here.
public struct AgentCommand: Identifiable, Equatable, Sendable {
    /// What is typed, e.g. `/compact`, `/plugin:skill` or `$skill`.
    public let line: String
    /// What choosing it will do. Every row says.
    public let detail: String
    /// Placeholder for the argument it takes; nil means it takes none.
    public let argumentHint: String?
    public var id: String { line }

    public init(line: String, detail: String, argumentHint: String? = nil) {
        self.line = line
        self.detail = detail
        self.argumentHint = argumentHint
    }

    /// The line as sent: the argument, if given, follows it.
    public func typed(with argument: String) -> String {
        let argument = argument.trimmingCharacters(in: .whitespacesAndNewlines)
        return argument.isEmpty ? line : "\(line) \(argument)"
    }
}

public enum AgentCommands {
    /// As documented for each agent. The session's own version has the final
    /// say, which the palette's subtitle says out loud.
    public static let claude: [(String, String, String?)] = [
        ("/compact", "Summarise the conversation to free context; optional focus", "what to keep (optional)"),
        ("/clear", "Clear the conversation and start fresh in the same session", nil),
        ("/context", "Show what is using the context window", nil),
        ("/cost", "Show token usage and cost for this session", nil),
        ("/status", "Show version, model, account and connection", nil),
        ("/usage", "Show plan usage and rate limits", nil),
        ("/model", "Choose the model in a picker in the terminal; Model… above takes a name", nil),
        ("/permissions", "View or change tool permissions, in the terminal", nil),
        ("/mcp", "MCP server status and sign-in, in the terminal", nil),
        ("/plugin", "Manage plugins, in the terminal", nil),
        ("/agents", "Manage subagents, in the terminal", nil),
        ("/hooks", "Manage hooks, in the terminal", nil),
        ("/memory", "Edit CLAUDE.md memory files, in the terminal", nil),
        ("/init", "Write a CLAUDE.md for this project", nil),
        ("/review", "Ask for a code review of the working tree", nil),
        ("/doctor", "Check the Claude Code install", nil),
        ("/help", "List Claude Code's commands", nil),
    ]

    public static let codex: [(String, String, String?)] = [
        ("/compact", "Summarise the conversation to free context", nil),
        ("/new", "Start a new conversation in this terminal", nil),
        ("/status", "Show session configuration and token usage", nil),
        ("/diff", "Show the git diff, including untracked files", nil),
        ("/review", "Review the working tree; optional instructions", "what to review (optional)"),
        ("/model", "Choose model and reasoning effort in a picker in the terminal", nil),
        ("/permissions", "Choose approval and sandbox mode, in the terminal", nil),
        ("/personality", "Choose a personality, in the terminal", nil),
        ("/fast", "Toggle fast mode", nil),
        ("/mcp", "List configured MCP servers", nil),
        ("/skills", "List available skills", nil),
        ("/plugins", "Manage plugins, in the terminal", nil),
        ("/hooks", "Manage hooks, in the terminal", nil),
        ("/init", "Write an AGENTS.md for this project", nil),
        ("/fork", "Fork the conversation into a new thread", nil),
    ]

    /// A row's backend as published: absent is Claude.
    public static func isCodex(_ backend: String?) -> Bool { backend?.lowercased() == "codex" }

    /// The agent's own slash commands.
    public static func slash(for backend: String?) -> [AgentCommand] {
        (isCodex(backend) ? codex : claude).map { AgentCommand(line: $0.0, detail: $0.1, argumentHint: $0.2) }
    }

    /// How a skill is typed: Claude runs a plugin's skill as `/plugin:skill`; Codex mentions a skill
    /// as `$name` inside a message, so that one goes as an ordinary prompt.
    public static func skillLine(_ entity: AgentCapabilities.Entity, codex: Bool) -> String? {
        guard entity.kind == "skill", let skill = entity.skill,
              skill.userInvocable, !entity.isUnavailable else { return nil }
        let owner = skill.ownerPluginId.map { $0.split(separator: "@", maxSplits: 1)[0] }
        return codex
            ? "$\(entity.name)"
            : "/" + (owner.map { "\($0):" } ?? "") + entity.name
    }

    /// Skills a person may invoke, from the same read the inspector uses.
    public static func skills(in capabilities: AgentCapabilities?, backend: String?) -> [AgentCommand] {
        guard let capabilities else { return [] }
        let codex = isCodex(backend)
        return capabilities.entities.compactMap { entity in
            guard let line = skillLine(entity, codex: codex) else { return nil }
            return AgentCommand(
                line: line,
                detail: entity.description ?? "Run the \(entity.name) skill",
                argumentHint: entity.skill?.argumentHint
            )
        }
    }
}

/// Fuzzy ranking for a command list. Kept in Swift on purpose: a shared TypeScript ranker cannot
/// run inside the apps, so this is pinned by source guards instead.
public enum CommandMatch {
    /// nil is no match. A prefix beats a word start beats a scattered
    /// subsequence, and within a tier fewer gaps win; the caller keeps catalog
    /// order for ties. Leading `/` and `$` are ignored so "comp" finds
    /// `/compact` and "pony" finds `$ponytail`.
    public static func score(_ query: String, in text: String) -> Int? {
        let q = Array(query.lowercased().filter { !$0.isWhitespace })
        if q.isEmpty { return 0 }
        let t = Array(text.lowercased().drop(while: { $0 == "/" || $0 == "$" }))
        if t.starts(with: q) { return 300 - t.count }
        var wordStart = false
        for i in t.indices {
            if wordStart, t[i...].starts(with: q) { return 200 - t.count }
            wordStart = !(t[i].isLetter || t[i].isNumber)
        }
        var qi = 0
        var first = -1
        var last = -1
        for (index, ch) in t.enumerated() where qi < q.count && ch == q[qi] {
            if first < 0 { first = index }
            last = index
            qi += 1
        }
        guard qi == q.count else { return nil }
        return 100 - (last - first + 1 - q.count)
    }

    /// The title first; the detail only by word start, because a scattered
    /// subsequence matches almost any sentence.
    public static func rank(_ query: String, title: String, detail: String) -> Int? {
        if let score = score(query, in: title) { return score }
        guard let score = score(query, in: detail), score >= 200 else { return nil }
        return score - 200
    }
}
