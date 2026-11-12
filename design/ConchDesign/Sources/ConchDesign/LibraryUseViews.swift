import SwiftUI

/// The reader's top for a skill, and the controls Workflows' reader shares (2026-11-11): what it is, how to use it in an
/// open session, where each copy lives and what can be done to it, and which sessions have it. Laid out as facts down
/// a label column, as the session inspector's are, so a skill with four copies reads as calmly as one with one. Every
/// control says in its own words, and in its help, what pressing it does. The rules are LibraryUse.swift's.

// MARK: - Controls

/// A small capsule control: a press, or a menu's label (with its chevron). `prominent` is the reader's first thing to do.
public struct LibraryPill: View {
    let title: String
    var symbol: String?
    var prominent = false
    var menu = false
    var destructive = false

    public init(_ title: String, symbol: String? = nil, prominent: Bool = false, menu: Bool = false, destructive: Bool = false) {
        self.title = title
        self.symbol = symbol
        self.prominent = prominent
        self.menu = menu
        self.destructive = destructive
    }

    public var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).font(.system(size: 9.5, weight: .semibold)) }
            if !title.isEmpty { Text(title).font(.system(size: 11.5, weight: .medium)).lineLimit(1).fixedSize() }
            if menu { Image(systemName: "chevron.down").font(.system(size: 7.5, weight: .bold)).opacity(0.7) }
        }
        .foregroundStyle(prominent ? ConchColor.onAccent : destructive ? ConchColor.attention : ConchColor.textPrimary)
        .padding(.horizontal, title.isEmpty ? 7 : 9)
        .frame(minWidth: 22, minHeight: 22, maxHeight: 22)
        .background(Capsule(style: .continuous).fill(prominent ? ConchColor.accent : ConchColor.fill))
        .contentShape(Capsule())
    }
}

/// A pill that does one thing.
public struct LibraryPillButton: View {
    let pill: LibraryPill
    let help: String
    let action: () -> Void

    public init(_ title: String, symbol: String? = nil, prominent: Bool = false, destructive: Bool = false, help: String, action: @escaping () -> Void) {
        pill = LibraryPill(title, symbol: symbol, prominent: prominent, destructive: destructive)
        self.help = help
        self.action = action
    }

    public var body: some View {
        Button(action: action) { pill }
            .buttonStyle(.plain)
            .help(help)
            .accessibilityHint(help)
    }
}

/// One item of a pill's menu: its words say what choosing it does.
public struct LibraryMenuItem: Identifiable {
    public let id: String
    public let title: String
    public let action: () -> Void

    public init(id: String, title: String, action: @escaping () -> Void) {
        self.id = id
        self.title = title
        self.action = action
    }
}

/// A pill that opens a menu. A menu is an AppKit control, which a render can't draw: its label stands in.
public struct LibraryPillMenu: View {
    let title: String
    let symbol: String?
    let prominent: Bool
    let chevron: Bool
    let help: String
    let items: [LibraryMenuItem]
    @Environment(\.conchRendersStatically) private var statically

    public init(_ title: String, symbol: String? = nil, prominent: Bool = false, chevron: Bool = true, help: String, items: [LibraryMenuItem]) {
        self.title = title
        self.symbol = symbol
        self.prominent = prominent
        self.chevron = chevron
        self.help = help
        self.items = items
    }

    public var body: some View {
        if statically {
            LibraryPill(title, symbol: symbol, prominent: prominent, menu: chevron)
        } else {
            Menu {
                ForEach(items) { item in Button(item.title, action: item.action) }
            } label: {
                LibraryPill(title, symbol: symbol, prominent: prominent, menu: chevron)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .help(help)
        }
    }
}

/// A fact in the reader: its name down a label column, and what it says beside it.
struct LibraryFact<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content

    static var labelWidth: CGFloat { 68 }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x3) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchColor.textTertiary)
                .frame(width: Self.labelWidth, alignment: .leading)
            VStack(alignment: .leading, spacing: 6) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Run in ▾, Type into ▾ and the way to a new session, for whatever `uses` says can be used where.
struct LibraryUseRow: View {
    let name: String
    let uses: [LibraryUse]
    let newSession: (title: String, help: String, run: () -> Void)?
    let onRun: (LibraryUse) -> Void
    let onType: (LibraryUse) -> Void

    var body: some View {
        let typable = uses.filter(\.session.canType)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: ConchSpace.x2) {
                if !typable.isEmpty {
                    LibraryPillMenu("Run in", symbol: "play.fill", prominent: true,
                                    help: "Send it to an open session now, as if you typed it and pressed Return",
                                    items: typable.map { use in
                                        LibraryMenuItem(id: "run:\(use.id)", title: "Run \(use.line) in \(use.session.label)") { onRun(use) }
                                    })
                    LibraryPillMenu("Type into", symbol: "text.cursor",
                                    help: "Put it in an open session's reply, to add to before you send it",
                                    items: typable.map { use in
                                        LibraryMenuItem(id: "type:\(use.id)", title: "Type \(use.line) into \(use.session.label)") { onType(use) }
                                    })
                }
                if let newSession {
                    LibraryPillButton(newSession.title, symbol: "plus", prominent: typable.isEmpty, help: newSession.help, action: newSession.run)
                }
            }
            if typable.isEmpty {
                Text(uses.isEmpty ? "No open session has \(name)." : "The sessions that have \(name) can't be typed into from conch.")
                    .font(.system(size: 11))
                    .foregroundStyle(ConchColor.textSecondary)
            }
        }
    }
}

/// The open sessions that have it, each a chip that opens it.
struct LibrarySessionChips: View {
    let uses: [LibraryUse]
    let onOpen: (LibrarySession) -> Void

    var body: some View {
        if uses.isEmpty {
            Text("None open now")
                .font(.system(size: 11.5))
                .foregroundStyle(ConchColor.textSecondary)
        } else {
            LibraryFlow(spacing: 5) {
                ForEach(uses) { use in
                    Button { onOpen(use.session) } label: {
                        HStack(spacing: 5) {
                            Circle().fill(ConchColor.ready).frame(width: 5, height: 5)
                            Text(use.session.label).font(.system(size: 11, weight: .medium)).lineLimit(1)
                        }
                        .foregroundStyle(ConchColor.textPrimary)
                        .padding(.horizontal, 8)
                        .frame(height: 20)
                        .background(Capsule(style: .continuous).fill(ConchColor.fill))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .help("Open \(use.session.label)")
                }
            }
        }
    }
}

// MARK: - A skill

/// What a skill's reader can be asked to do.
public struct SkillDetailActions {
    public var run: (LibraryUse) -> Void
    public var type: (LibraryUse) -> Void
    public var tryIt: () -> Void
    public var openSession: (LibrarySession) -> Void
    /// Read this copy in the reader below.
    public var read: (SkillLocationInfo) -> Void
    /// Switch a copy on or off for new sessions: shows the edit first.
    public var toggle: (SkillLocationInfo, Bool) -> Void
    public var reveal: (SkillLocationInfo) -> Void
    public var copyPath: (SkillLocationInfo) -> Void
    public var trash: (SkillLocationInfo) -> Void
    public var openPlugins: () -> Void
    public var openClaudeAI: () -> Void

    public init(run: @escaping (LibraryUse) -> Void, type: @escaping (LibraryUse) -> Void, tryIt: @escaping () -> Void,
                openSession: @escaping (LibrarySession) -> Void, read: @escaping (SkillLocationInfo) -> Void,
                toggle: @escaping (SkillLocationInfo, Bool) -> Void, reveal: @escaping (SkillLocationInfo) -> Void,
                copyPath: @escaping (SkillLocationInfo) -> Void, trash: @escaping (SkillLocationInfo) -> Void,
                openPlugins: @escaping () -> Void, openClaudeAI: @escaping () -> Void) {
        self.run = run
        self.type = type
        self.tryIt = tryIt
        self.openSession = openSession
        self.read = read
        self.toggle = toggle
        self.reveal = reveal
        self.copyPath = copyPath
        self.trash = trash
        self.openPlugins = openPlugins
        self.openClaudeAI = openClaudeAI
    }

    /// Nothing happens: a picture's.
    public static let none = SkillDetailActions(run: { _ in }, type: { _ in }, tryIt: {}, openSession: { _ in }, read: { _ in },
                                                toggle: { _, _ in }, reveal: { _ in }, copyPath: { _ in }, trash: { _ in },
                                                openPlugins: {}, openClaudeAI: {})
}

/// A skill, above its SKILL.md: what it does, Use, Where it lives with each copy's switch, and the sessions that have it.
public struct SkillDetailPanel: View {
    let skill: InstalledSkillInfo
    let uses: [LibraryUse]
    /// The copy the reader shows below.
    let reading: SkillLocationInfo.ID?
    let actions: SkillDetailActions

    public init(skill: InstalledSkillInfo, uses: [LibraryUse], reading: SkillLocationInfo.ID?, actions: SkillDetailActions) {
        self.skill = skill
        self.uses = uses
        self.reading = reading
        self.actions = actions
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: ConchSpace.x3) {
            if let description = skill.description {
                Text(description)
                    .font(.system(size: 12))
                    .foregroundStyle(ConchColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            LibraryFact(label: "Use") {
                LibraryUseRow(name: skill.name, uses: uses,
                              newSession: (title: "Try…", help: "Start a new session that shows what \(skill.name) does on a small example", run: actions.tryIt),
                              onRun: actions.run, onType: actions.type)
            }
            LibraryFact(label: skill.locations.count == 1 ? "Lives in" : "Copies") {
                // How a copy is called, only where it isn't called as the first is; which copies hold other words.
                let first = skill.locations.first
                let primary = SkillsLibrary.primaryLocation(skill)
                ForEach(skill.locations) { location in
                    SkillCopyLine(location: location, isRead: (reading ?? primary?.id) == location.id,
                                  showsRead: skill.locations.count > 1, showsCall: location.invocation != first?.invocation,
                                  differs: skill.versions > 1 && location.digest != primary?.digest, actions: actions)
                }
            }
            // Said once: with none open, Use already says so.
            if !uses.isEmpty {
                LibraryFact(label: "Sessions") {
                    LibrarySessionChips(uses: uses, onOpen: actions.openSession)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, ConchSpace.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One copy: where, what kind, whether it is on, and what can be done to it.
struct SkillCopyLine: View {
    let location: SkillLocationInfo
    let isRead: Bool
    let showsRead: Bool
    let showsCall: Bool
    /// Its words differ from the copy read first.
    let differs: Bool
    let actions: SkillDetailActions

    var body: some View {
        let management = SkillManagement.of(location)
        HStack(alignment: .center, spacing: ConchSpace.x2) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    // With several copies, another copy's place reads it below; the one shown is only its name.
                    let title = Text(SkillsLibrary.locationTitle(location))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(ConchColor.textPrimary)
                        .lineLimit(1)
                    if showsRead, !isRead {
                        Button { actions.read(location) } label: { title }
                            .buttonStyle(.plain)
                            .help("Read this copy below")
                    } else {
                        title
                    }
                    // Off is a choice, not a failure: a quiet tag, not attention's red.
                    if location.enabled == false { LibraryChip("Off", help: "Off for new sessions there") }
                    if differs { LibraryChip("Other version", help: "Its words differ from the copy shown below") }
                    if isRead, showsRead {
                        Text("shown below").font(.system(size: 10.5)).foregroundStyle(ConchColor.textTertiary)
                    }
                }
                let line = line(management)
                if !line.isEmpty {
                    Text(line)
                        .font(.system(size: 11))
                        .foregroundStyle(ConchColor.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: ConchSpace.x2)
            switch management {
            case let .toggle(isOn):
                LibraryPillButton(isOn ? "Turn off…" : "Turn on…",
                                  help: "Show the change to its settings file, then \(isOn ? "hide it from" : "give it back to") new sessions") {
                    actions.toggle(location, !isOn)
                }
            case .plugin:
                LibraryPillButton("Plugins & MCP", symbol: "arrow.up.right", help: "Switch or remove its plugin in Settings › Plugins & MCP", action: actions.openPlugins)
            case .claudeAI:
                LibraryPillButton("claude.ai", symbol: "arrow.up.right", help: "Open claude.ai's capability settings, where its skills are turned on and off", action: actions.openClaudeAI)
            case .codexConfig, .command, .fixed:
                EmptyView()
            }
            LibraryPillMenu("", symbol: "ellipsis", chevron: false, help: "Reveal, copy the path, or move this copy to the Trash", items: menu)
        }
    }

    /// What the place doesn't already say: a plugin's or claude.ai's, a command, where Codex's is switched, and how it
    /// is called when the copies differ. A skill of yours in an account says nothing more than its place.
    private func line(_ management: SkillManagement) -> String {
        var parts: [String] = []
        if !["user", "project"].contains(location.origin) || location.kind == "command" { parts.append(SkillCopies.kindTitle(location)) }
        if management == .codexConfig, let note = management.note { parts.append(note) }
        if showsCall, let invocation = location.invocation { parts.append(invocation) }
        return parts.joined(separator: " · ")
    }

    private var menu: [LibraryMenuItem] {
        var items: [LibraryMenuItem] = []
        if showsRead, !isRead { items.append(LibraryMenuItem(id: "read", title: "Read This Copy Below") { actions.read(location) }) }
        items.append(LibraryMenuItem(id: "reveal", title: "Reveal in Finder") { actions.reveal(location) })
        items.append(LibraryMenuItem(id: "copy", title: "Copy Path") { actions.copyPath(location) })
        if SkillCopies.canTrash(location) {
            items.append(LibraryMenuItem(id: "trash", title: location.kind == "command" ? "Move Its File to Trash…" : "Move Its Folder to Trash…") { actions.trash(location) })
        }
        return items
    }
}
