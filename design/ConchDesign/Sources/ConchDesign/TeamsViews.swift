import SwiftUI

// Settings › Teams, its sheets, and the sidebar's team header (2026-11-12, Teams.swift has the why). Laid out as Settings ›
// Failures is: Settings' header, blocks with a mark and a count, cards with hairlines between rows, Setup's buttons.
//
// The pictures (the design gallery, the render tests) are drawn by ImageRenderer, which can't draw a text field, a menu, a
// switch or a scroll view: under `conchRendersStatically` each of those is its words in the same box instead.

// MARK: - The section

/// Settings › Teams: the running teams with Pass task… and End, then every team type as a card of its own, its roles in
/// their hierarchy, with Start…, Edit, Duplicate and Delete. `chooseFolder` is the Mac's folder picker for a start.
public struct TeamsView: View {
    @StateObject private var store: TeamsStore
    private let chooseFolder: (@MainActor () -> String?)?
    private let defaultFolder: String
    private let home: String

    @State private var editing: TeamEditDraft?
    @State private var starting: TeamType?
    @State private var passing: TeamSummary?
    @State private var ending: TeamSummary?
    @State private var deleting: TeamType?
    @Environment(\.conchRendersStatically) private var rendersStatically

    public init(chooseFolder: (@MainActor () -> String?)? = nil, defaultFolder: String = NSHomeDirectory(), home: String = NSHomeDirectory(),
                transport: @escaping @MainActor (TeamsRequest) async throws -> Data) {
        _store = StateObject(wrappedValue: TeamsStore(transport: transport))
        self.chooseFolder = chooseFolder
        self.defaultFolder = defaultFolder
        self.home = home
    }

    /// For a picture of the page (the design gallery), with the list it shows.
    public init(store: TeamsStore, defaultFolder: String = NSHomeDirectory(), home: String = NSHomeDirectory()) {
        _store = StateObject(wrappedValue: store)
        chooseFolder = nil
        self.defaultFolder = defaultFolder
        self.home = home
    }

    public var body: some View {
        let page = VStack(alignment: .leading, spacing: SettingsLayout.headerGap) {
            header
            content
        }
        .font(.system(size: 12))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(SettingsLayout.inset)

        Group {
            if rendersStatically { page } else { ScrollView { page } }
        }
        .background(ConchColor.ground)
        // Again every few seconds while it shows: a member's session appears, a team ends.
        .task {
            while !Task.isCancelled {
                await store.load()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
        .sheet(item: $editing) { draft in
            TeamTypeEditor(
                type: draft.type, isNew: draft.previousId == nil, agents: store.list?.agents ?? [:], signIns: store.list?.signIns ?? [],
                save: { type in await store.save(type, previousId: draft.previousId) },
                done: { editing = nil }
            )
        }
        .sheet(item: $starting) { type in
            TeamStartSheet(type: type, folder: lastFolder, chooseFolder: chooseFolder,
                           start: { task, cwd, trust in await store.start(type: type.id, task: task, cwd: cwd, trustFolder: trust) },
                           done: { starting = nil })
        }
        .sheet(item: $passing) { team in
            TeamTaskSheet(team: team, send: { task in await store.passTask(team: team.id, task: task) }, done: { passing = nil })
        }
        .confirmationDialog(ending.map { "End \($0.name)?" } ?? "", isPresented: Binding(get: { ending != nil }, set: { if !$0 { ending = nil } }),
                            presenting: ending) { team in
            Button("End team", role: .destructive) { Task { await store.end(team.id) } }
        } message: { _ in
            Text("Its sessions keep running; they just stop being grouped as a team. Close them from the sidebar.")
        }
        .confirmationDialog(deleting.map { "Delete \($0.name)?" } ?? "", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            presenting: deleting) { type in
            Button("Delete", role: .destructive) { Task { await store.delete(type.id) } }
        } message: { _ in
            Text("Teams already running keep going. A starter type can be added back later.")
        }
    }

    /// Where the last team started, else the folder the page was given.
    private var lastFolder: String {
        store.list?.running.max(by: { $0.startedAt < $1.startedAt })?.cwd ?? defaultFolder
    }

    /// Settings' own header (the Mac's `SettingsSectionHeader`): the title on a 26-point line, the line under it.
    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Teams")
                .font(ConchType.title)
                .foregroundStyle(ConchColor.textPrimary)
                .accessibilityAddTraits(.isHeader)
                .frame(height: 26)
            Text("A team type is a lead and the agents who report to it, each with a role, and the rules they work by. Start one on a task; conch starts its sessions, groups them in the sidebar, and hands every member its role and the rules.")
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
                Text("Reading conch's teams…").foregroundStyle(ConchColor.textSecondary)
            }
        case .needsUpdate:
            Text("Needs an updated conch daemon").foregroundStyle(ConchColor.attention)
        case .unreachable:
            Text("conch's daemon isn't running, so its teams can't be listed. Turn it on in General.")
                .foregroundStyle(ConchColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        case let .loaded(list):
            loaded(list)
        }
    }

    private func loaded(_ list: TeamsList) -> some View {
        let now = Date()
        return VStack(alignment: .leading, spacing: 24) {
            if !list.running.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    TeamsBlockHeading(title: "Running", symbol: "play.circle", count: list.running.count)
                    OnboardingCard {
                        ForEach(Array(list.running.enumerated()), id: \.element.id) { index, team in
                            if index > 0 { FailureHairline() }
                            TeamRunningRow(team: team, now: now, home: home, isActing: store.acting.contains(team.id), problem: store.problems[team.id],
                                           onPassTask: { passing = team }, onEnd: { ending = team })
                        }
                    }
                }
                FailureHairline()
            }
            VStack(alignment: .leading, spacing: 12) {
                TeamsBlockHeading(title: "Team types", symbol: "person.3", count: list.types.count) {
                    Button("Add a team type") { editing = TeamEditDraft(type: Teams.newType(existing: list.types), previousId: nil) }
                        .buttonStyle(.plain)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(ConchColor.textSecondary)
                }
                if list.types.isEmpty {
                    Text("No team types yet. Add one, or add back conch's starter types.")
                        .foregroundStyle(ConchColor.textSecondary)
                }
                ForEach(list.types) { type in
                    TeamTypeCard(
                        type: type, isActing: store.acting.contains(type.id), problem: store.problems[type.id],
                        onStart: { starting = type },
                        onEdit: { editing = TeamEditDraft(type: type, previousId: type.id) },
                        onDuplicate: { Task { await store.duplicate(type.id) } },
                        onDelete: { deleting = type }
                    )
                }
                if list.missingStarters > 0 {
                    OnboardingButton(list.missingStarters == 1 ? "Add back conch's starter type" : "Add back conch's \(list.missingStarters) starter types",
                                     systemImage: "arrow.uturn.backward", style: .quiet) {
                        Task { await store.restoreStarters() }
                    }
                }
            }
            if let problem = store.problems[""] {
                Text(problem).foregroundStyle(ConchColor.attention)
            }
        }
    }
}

/// A type in the editor, and the id it was saved under (nil for one new to the daemon).
struct TeamEditDraft: Identifiable {
    let type: TeamType
    let previousId: String?
    var id: String { previousId ?? "new:\(type.id)" }
}

/// A block's heading, as Failures' are: a 22-point mark, the title, the count, and anything on its right.
struct TeamsBlockHeading<Trailing: View>: View {
    let title: String
    let symbol: String
    let count: Int?
    let trailing: Trailing

    init(title: String, symbol: String, count: Int? = nil, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.symbol = symbol
        self.count = count
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: ConchSpace.x2) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .regular))
                .frame(width: 22, height: 22)
            Text(title)
                .font(ConchType.uiEmphasis)
                .accessibilityAddTraits(.isHeader)
            if let count {
                Text("\(count)")
                    .font(ConchType.uiBody)
                    .foregroundStyle(ConchColor.textTertiary)
            }
            Spacer(minLength: 0)
            trailing
        }
        .foregroundStyle(ConchColor.textPrimary)
    }
}

extension TeamsBlockHeading where Trailing == EmptyView {
    init(title: String, symbol: String, count: Int? = nil) {
        self.init(title: title, symbol: symbol, count: count) { EmptyView() }
    }
}

// MARK: - A running team

/// One running team in its card: its name, the task it is on, how many and since when, a chip for each member with its
/// state, and Pass task… and End.
public struct TeamRunningRow: View {
    let team: TeamSummary
    let now: Date
    let home: String
    let isActing: Bool
    let problem: String?
    let onPassTask: () -> Void
    let onEnd: () -> Void

    public init(team: TeamSummary, now: Date, home: String, isActing: Bool = false, problem: String? = nil,
                onPassTask: @escaping () -> Void = {}, onEnd: @escaping () -> Void = {}) {
        self.team = team
        self.now = now
        self.home = home
        self.isActing = isActing
        self.problem = problem
        self.onPassTask = onPassTask
        self.onEnd = onEnd
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: ConchSpace.x3) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(team.name)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(ConchColor.textPrimary)
                    Text(team.currentTask)
                        .font(.system(size: 12))
                        .foregroundStyle(ConchColor.textPrimary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(Teams.runningLine(team, now: now, home: home))
                        .font(.system(size: 11))
                        .foregroundStyle(ConchColor.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if isActing {
                    ProgressView().controlSize(.small).frame(height: 26)
                } else {
                    HStack(spacing: ConchSpace.x2) {
                        OnboardingButton("Pass task…", style: .row, action: onPassTask)
                            .help("Give the team its next task, through its lead")
                        OnboardingButton("End", style: .quiet, action: onEnd)
                            .help("Stop grouping these sessions as a team; they keep running")
                    }
                }
            }
            TeamsFlow(spacing: 6, lineSpacing: 6) {
                ForEach(team.members) { member in
                    TeamMemberChip(member: member, now: now)
                }
            }
            // Why a member didn't start, said rather than left to a tooltip: the lead can ask for another.
            ForEach(team.members.filter { $0.state == .failed }) { member in
                Text("\(member.title) couldn't start: \(member.error ?? "conch didn't see it start").")
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
        .padding(.horizontal, ConchSpace.x4)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A member as a chip: its state's dot and its role, its state in words on hover.
public struct TeamMemberChip: View {
    let member: TeamMember
    let now: Date

    public init(member: TeamMember, now: Date) {
        self.member = member
        self.now = now
    }

    public var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(Teams.stateColor(member))
                .frame(width: 6, height: 6)
            Text(member.title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(member.state == .failed ? AnyShapeStyle(ConchColor.attention) : AnyShapeStyle(ConchColor.textPrimary))
            if member.state == .starting {
                Text("starting")
                    .font(.system(size: 11))
                    .foregroundStyle(ConchColor.textTertiary)
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 22)
        .background(Capsule().fill(ConchColor.fill))
        .help(Teams.memberLine(member, now: now))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(member.title), \(Teams.memberLine(member, now: now))")
    }
}

/// Chips in rows, as many to a row as fit.
struct TeamsFlow: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map { row in row.reduce(0) { $0 + $1.width } + spacing * CGFloat(max(0, row.count - 1)) }.max() ?? 0
        let height = rows.map { $0.map(\.height).max() ?? 0 }.reduce(0, +) + lineSpacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        var index = 0
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            let height = row.map(\.height).max() ?? 0
            for size in row {
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
                index += 1
            }
            y += height + lineSpacing
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [[CGSize]] {
        var rows: [[CGSize]] = [[]]
        var used: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if !rows[rows.count - 1].isEmpty, used + spacing + size.width > width {
                rows.append([])
                used = 0
            }
            used += (rows[rows.count - 1].isEmpty ? 0 : spacing) + size.width
            rows[rows.count - 1].append(size)
        }
        return rows.filter { !$0.isEmpty }
    }
}

// MARK: - A team type

/// One team type as a card: its name and summary with Edit, Start… and the rest beside them; its roles in their tree,
/// each with what it runs as; and its rules.
public struct TeamTypeCard: View {
    let type: TeamType
    let isActing: Bool
    let problem: String?
    let onStart: () -> Void
    let onEdit: () -> Void
    let onDuplicate: () -> Void
    let onDelete: () -> Void
    @Environment(\.conchRendersStatically) private var rendersStatically

    public init(type: TeamType, isActing: Bool = false, problem: String? = nil, onStart: @escaping () -> Void = {},
                onEdit: @escaping () -> Void = {}, onDuplicate: @escaping () -> Void = {}, onDelete: @escaping () -> Void = {}) {
        self.type = type
        self.isActing = isActing
        self.problem = problem
        self.onStart = onStart
        self.onEdit = onEdit
        self.onDuplicate = onDuplicate
        self.onDelete = onDelete
    }

    /// Where a role's name starts at depth 0: past the 16-point inset and the 22-point mark column, on the heading's edge.
    static let nameInset: CGFloat = ConchSpace.x4

    public var body: some View {
        OnboardingCard {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: ConchSpace.x3) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(type.name)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(ConchColor.textPrimary)
                        if !type.summary.isEmpty {
                            Text(type.summary)
                                .font(.system(size: 11.5))
                                .foregroundStyle(ConchColor.textSecondary)
                                .lineLimit(3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if isActing {
                        ProgressView().controlSize(.small).frame(height: 26)
                    } else {
                        HStack(spacing: ConchSpace.x2) {
                            more
                            OnboardingButton("Edit", style: .row, action: onEdit)
                            OnboardingButton("Start…", style: .action, action: onStart)
                                .help("Start this team on a task")
                        }
                    }
                }
                .padding(.horizontal, ConchSpace.x4)
                .padding(.top, 12)
                .padding(.bottom, 10)

                FailureHairline()

                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Teams.tree(type.roles)) { row in
                        TeamRoleLine(row: row)
                    }
                }
                .padding(.vertical, 6)

                FailureHairline()

                rules
                    .padding(.horizontal, ConchSpace.x4)
                    .padding(.vertical, 10)

                if let problem {
                    Text(problem)
                        .font(.system(size: 11))
                        .foregroundStyle(ConchColor.attention)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, ConchSpace.x4)
                        .padding(.bottom, 10)
                }
            }
        }
    }

    /// Duplicate and Delete, out of the way of Start.
    @ViewBuilder
    private var more: some View {
        let label = Image(systemName: "ellipsis")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ConchColor.textSecondary)
            .frame(width: 26, height: 26)
            .contentShape(Rectangle())
        if rendersStatically {
            label
        } else {
            Menu {
                Button("Duplicate", action: onDuplicate)
                Button("Delete…", role: .destructive, action: onDelete)
            } label: { label }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .fixedSize()
                .accessibilityLabel("More for \(type.name)")
        }
    }

    private var rules: some View {
        HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x2) {
            Text(Teams.rulesCount(type.rules.count))
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchColor.textSecondary)
                .fixedSize()
            if let first = type.rules.first {
                Text(type.rules.count > 1 ? "\(first) …" : first)
                    .font(.system(size: 11))
                    .foregroundStyle(ConchColor.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 0)
        }
    }
}

/// One role in a card's tree: its name, a lead's mark or the line up to whom it reports, how many may run at once, and
/// what it runs as.
struct TeamRoleLine: View {
    let row: Teams.TreeRow

    /// Each step down the tree.
    static let indent: CGFloat = 18

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: row.role.isLead ? "star.fill" : "arrow.turn.down.right")
                    .font(.system(size: row.role.isLead ? 8 : 9, weight: .semibold))
                    .foregroundStyle(row.role.isLead ? AnyShapeStyle(ConchColor.textSecondary) : AnyShapeStyle(ConchColor.textTertiary))
                    .frame(width: 12)
                Text(Teams.countedName(row.role))
                    .font(.system(size: 12, weight: row.role.isLead ? .semibold : .medium))
                    .foregroundStyle(ConchColor.textPrimary)
                    .lineLimit(1)
            }
            .padding(.leading, CGFloat(row.depth) * Self.indent)
            .frame(width: 190, alignment: .leading)
            Text(Teams.roleDetail(row.role))
                .font(.system(size: 11))
                .foregroundStyle(ConchColor.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, TeamTypeCard.nameInset)
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.role.name)\(row.role.isLead ? ", the lead" : ""): \(Teams.roleDetail(row.role))")
    }
}

// MARK: - The editor

/// A team type, edited: its name and summary, its roles (each opens to every field it has), and its rules. Save checks
/// what the daemon would refuse (`Teams.problem`) and says it beside the field; the daemon's own refusal is said there too.
public struct TeamTypeEditor: View {
    @State private var draft: TeamType
    @State private var expanded: Set<String>
    @State private var problem: Teams.Problem?
    @State private var saving = false
    private let isNew: Bool
    /// The roles the daemon already has under these ids: their ids stay put when renamed.
    private let savedRoleIds: Set<String>
    private let agents: [String: TeamAgentChoices]
    private let signIns: [TeamSignIn]
    private let save: (TeamType) async -> Teams.Problem?
    private let done: () -> Void
    @Environment(\.conchRendersStatically) private var rendersStatically

    public init(type: TeamType, isNew: Bool, agents: [String: TeamAgentChoices], signIns: [TeamSignIn],
                expandedRole: String? = nil, problem: Teams.Problem? = nil,
                save: @escaping (TeamType) async -> Teams.Problem?, done: @escaping () -> Void) {
        _draft = State(initialValue: type)
        _expanded = State(initialValue: expandedRole.map { [$0] } ?? (isNew ? Set(type.roles.map(\.id)) : []))
        _problem = State(initialValue: problem)
        self.isNew = isNew
        savedRoleIds = isNew ? [] : Set(type.roles.map(\.id))
        self.agents = agents
        self.signIns = signIns
        self.save = save
        self.done = done
    }

    public static let size = CGSize(width: 660, height: 740)

    public var body: some View {
        VStack(spacing: 0) {
            Text(isNew ? "New team type" : "Edit team type")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ConchColor.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, ConchSpace.x6)
                .padding(.vertical, 16)
            FailureHairline()
            Group {
                if rendersStatically { form } else { ScrollView { form } }
            }
            .frame(maxHeight: .infinity, alignment: .top)
            FailureHairline()
            footer
        }
        .frame(width: Self.size.width, height: rendersStatically ? nil : Self.size.height)
        .background(ConchColor.ground)
        .font(.system(size: 12))
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 22) {
            TeamsField("Name", problem: problem(for: "name")) {
                TeamsTextInput(text: $draft.name, placeholder: "Build + review")
            }
            TeamsField("Summary", problem: problem(for: "summary")) {
                TeamsTextInput(text: $draft.summary, placeholder: "What the team is for, in a line or two", lines: 2...4)
            }

            VStack(alignment: .leading, spacing: 10) {
                TeamsBlockHeading(title: "Roles", symbol: "person.2", count: draft.roles.count) {
                    Button("Add role") {
                        let role = Teams.newRole(in: draft)
                        draft.roles.append(role)
                        expanded.insert(role.id)
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(ConchColor.textSecondary)
                    .disabled(draft.roles.count >= Teams.maxRoles)
                }
                if let message = problem(for: "roles") {
                    TeamsProblemText(message)
                }
                OnboardingCard {
                    let rows = Teams.tree(draft.roles)
                    ForEach(Array(rows.enumerated()), id: \.element.id) { position, row in
                        if position > 0 { FailureHairline() }
                        if let index = draft.roles.firstIndex(where: { $0.id == row.role.id }) {
                            roleRow(index: index, depth: row.depth)
                        }
                    }
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                TeamsBlockHeading(title: "How the team works", symbol: "list.number", count: draft.rules.count) {
                    Button("Add rule") { draft.rules.append("") }
                        .buttonStyle(.plain)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(ConchColor.textSecondary)
                        .disabled(draft.rules.count >= Teams.maxRules)
                }
                Text("conch hands these to every member, with its role, the task and whom it reports to.")
                    .font(.system(size: 11))
                    .foregroundStyle(ConchColor.textSecondary)
                if let message = problem(for: "rules") {
                    TeamsProblemText(message)
                }
                if !draft.rules.isEmpty {
                    OnboardingCard {
                        ForEach(draft.rules.indices, id: \.self) { index in
                            if index > 0 { FailureHairline() }
                            ruleRow(index)
                        }
                    }
                }
            }
        }
        .padding(ConchSpace.x6)
    }

    private func ruleRow(_ index: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x2) {
                Text("\(index + 1).")
                    .font(.system(size: 12, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(ConchColor.textTertiary)
                    .frame(width: 20, alignment: .trailing)
                TeamsTextInput(text: Binding(get: { draft.rules.indices.contains(index) ? draft.rules[index] : "" },
                                             set: { if draft.rules.indices.contains(index) { draft.rules[index] = $0 } }),
                               placeholder: "Builders work in their own worktree and open a PR", lines: 1...4, boxed: false)
                Button {
                    if draft.rules.indices.contains(index) { draft.rules.remove(at: index) }
                } label: {
                    Image(systemName: "minus.circle")
                        .font(.system(size: 12))
                        .foregroundStyle(ConchColor.textTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove rule \(index + 1)")
            }
            if let message = problem(for: "rules.\(index)") {
                TeamsProblemText(message).padding(.leading, 28)
            }
        }
        .padding(.horizontal, ConchSpace.x4)
        .padding(.vertical, 9)
    }

    private func roleRow(index: Int, depth: Int) -> some View {
        let role = draft.roles[index]
        let isOpen = expanded.contains(role.id)
        let rowProblem = problem?.roleIndex == index ? problem : nil
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x2) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(ConchColor.textTertiary)
                    .rotationEffect(.degrees(isOpen ? 90 : 0))
                    .frame(width: 12)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(role.name.isEmpty ? "Unnamed role" : Teams.countedName(role))
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(ConchColor.textPrimary)
                        // A lead named something else says it leads; one named Lead already does.
                        if role.isLead, role.name.trimmingCharacters(in: .whitespaces).lowercased() != "lead" {
                            Text("Lead")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(ConchColor.textSecondary)
                                .padding(.horizontal, 6)
                                .frame(height: 16)
                                .background(Capsule().fill(ConchColor.fill))
                        }
                    }
                    Text(Teams.roleDetail(role))
                        .font(.system(size: 11))
                        .foregroundStyle(ConchColor.textSecondary)
                        .lineLimit(1)
                    if let rowProblem, !isOpen {
                        TeamsProblemText(rowProblem.message)
                    }
                }
                Spacer(minLength: 0)
                if !role.isLead {
                    Button {
                        expanded.remove(role.id)
                        draft.roles = Teams.removing(draft.roles, at: index)
                    } label: {
                        Text("Remove")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(ConchColor.textSecondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove \(role.name)")
                }
            }
            .padding(.leading, CGFloat(depth) * TeamRoleLine.indent)
            .padding(.horizontal, ConchSpace.x4)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
            .onTapGesture {
                if isOpen { expanded.remove(role.id) } else { expanded.insert(role.id) }
            }
            .accessibilityAddTraits(.isButton)
            .accessibilityHint(isOpen ? "Hides its fields" : "Shows its fields")

            if isOpen {
                TeamRoleFields(
                    role: Binding(get: { draft.roles.indices.contains(index) ? draft.roles[index] : role },
                                  set: { if draft.roles.indices.contains(index) { draft.roles[index] = $0 } }),
                    rename: { name in
                        let before = draft.roles[index].id
                        draft.roles = Teams.renaming(draft.roles, at: index, to: name, followsName: !savedRoleIds.contains(before))
                        let after = draft.roles[index].id
                        if before != after, expanded.remove(before) != nil { expanded.insert(after) }
                    },
                    others: draft.roles.filter { $0.id != role.id },
                    choices: agents[role.backend.rawValue],
                    signIns: signIns,
                    problemField: rowProblem.map { String($0.field.split(separator: ".").dropFirst(2).joined(separator: ".")) },
                    problemMessage: rowProblem?.message
                )
                .padding(.leading, CGFloat(depth) * TeamRoleLine.indent + ConchSpace.x4 + 20)
                .padding(.trailing, ConchSpace.x4)
                .padding(.bottom, 14)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: ConchSpace.x3) {
            if let problem {
                TeamsProblemText(footerLine(problem))
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            if saving { ProgressView().controlSize(.small) }
            OnboardingButton("Cancel", style: .row, action: done)
            OnboardingButton(isNew ? "Add team type" : "Save", style: .action) {
                Task {
                    saving = true
                    let refused = await save(draft)
                    saving = false
                    problem = refused
                    if let index = refused?.roleIndex, draft.roles.indices.contains(index) { expanded.insert(draft.roles[index].id) }
                    if refused == nil { done() }
                }
            }
            .disabled(saving)
        }
        .padding(.horizontal, ConchSpace.x6)
        .padding(.vertical, 14)
    }

    private func problem(for field: String) -> String? {
        problem?.field == field ? problem?.message : nil
    }

    /// The problem again by the Save button, which may be far from its field: with what it is about, unless it says so.
    private func footerLine(_ problem: Teams.Problem) -> String {
        var about: String?
        if let index = problem.roleIndex, draft.roles.indices.contains(index) {
            about = draft.roles[index].name.isEmpty ? "A role" : draft.roles[index].name
        } else if problem.field.hasPrefix("rules.") {
            about = "Rule \((Int(problem.field.split(separator: ".").last ?? "") ?? 0) + 1)"
        }
        guard let about, !problem.message.contains(about) else { return problem.message }
        return "\(about): \(problem.message)"
    }
}

/// One role's fields, open in the editor: what it is called and whom it reports to, the agent it runs on, where it runs
/// and works, its limits, and what it is told.
struct TeamRoleFields: View {
    @Binding var role: TeamRole
    let rename: (String) -> Void
    let others: [TeamRole]
    let choices: TeamAgentChoices?
    let signIns: [TeamSignIn]
    /// The field the problem is about, within the role ("reportsTo"), and what it says.
    let problemField: String?
    let problemMessage: String?

    private static let budgets = [30, 60, 120, 240, 480]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            TeamsField("Name", problem: says("name") ?? says("id")) {
                TeamsTextInput(text: Binding(get: { role.name }, set: rename), placeholder: "Builder")
            }
            TeamsPair {
                TeamsField("Reports to", problem: says("reportsTo")) {
                    TeamsChoice(selection: Binding(get: { role.reportsTo ?? "" }, set: { role.reportsTo = $0.isEmpty ? nil : $0 }),
                                options: [("", "Nobody: it leads")] + others.map { ($0.id, $0.name) })
                }
            } trailing: {
                TeamsField("Starts", problem: says("atStart")) {
                    if role.isLead {
                        TeamsFixed("With the team")
                    } else {
                        TeamsChoice(selection: Binding(get: { role.atStart == true }, set: { role.atStart = $0 ? true : nil }),
                                    options: [(false, "When the lead asks"), (true, "With the team")])
                    }
                }
            }
            TeamsPair {
                TeamsField("Agent", problem: says("backend")) {
                    TeamsChoice(selection: Binding(get: { role.backend }, set: { backend in
                        role.backend = backend
                        // Another agent's effort and permissions mean nothing here, and a sign-in is Claude's.
                        role.effort = nil
                        role.permissions = nil
                        if backend != .claude { role.signIn = nil }
                    }), options: TeamBackend.allCases.map { ($0, $0.displayName) })
                }
            } trailing: {
                TeamsField("Model", problem: says("model")) {
                    TeamsTextInput(text: Binding(get: { role.model ?? "" }, set: { role.model = $0 }), placeholder: "Its default")
                }
            }
            TeamsPair {
                TeamsField("Effort", problem: says("effort")) {
                    TeamsChoice(selection: Binding(get: { role.effort ?? "" }, set: { role.effort = $0.isEmpty ? nil : $0 }),
                                options: [("", "Its default")] + Self.listed(choices?.efforts ?? [], keeping: role.effort).map { ($0, $0) })
                }
            } trailing: {
                TeamsField("Permissions", problem: says("permissions")) {
                    TeamsChoice(selection: Binding(get: { role.permissions ?? "" }, set: { role.permissions = $0.isEmpty ? nil : $0 }),
                                options: [("", "Its default")] + Self.listed(choices?.permissions ?? [], keeping: role.permissions).map { ($0, $0) })
                }
            }
            TeamsPair {
                TeamsField("Sign-in", problem: says("signIn")) {
                    if role.backend == .claude {
                        TeamsChoice(selection: Binding(get: { role.signIn ?? "" }, set: { role.signIn = $0.isEmpty ? nil : $0 }),
                                    options: [("", "Default (rotating)")] + Self.listed(signIns.map(\.label), keeping: role.signIn).map { ($0, $0) })
                    } else {
                        TeamsFixed("Codex's own")
                    }
                }
            } trailing: {
                TeamsField("Runs in", problem: says("host")) {
                    TeamsChoice(selection: Binding(get: { role.host ?? .terminal }, set: { role.host = $0 == .terminal ? nil : $0 }),
                                options: [(TeamHost.terminal, "A Terminal window"), (.background, "The background")])
                }
            }
            TeamsPair {
                TeamsField("Works in", problem: says("workspace")) {
                    TeamsChoice(selection: $role.workspace,
                                options: [(TeamWorkspace.shared, "The team's folder"), (.worktree, "Its own worktree")])
                }
            } trailing: {
                TeamsField("At once", problem: says("maxConcurrent")) {
                    TeamsCount(value: Binding(get: { role.limit }, set: { role.maxConcurrent = $0 }), range: Teams.concurrentRange,
                               words: { $0 == 1 ? "One at a time" : "Up to \($0)" })
                }
            }
            TeamsField("Time", problem: says("budgetMinutes")) {
                TeamsChoice(selection: Binding(get: { role.budgetMinutes ?? 0 }, set: { role.budgetMinutes = $0 == 0 ? nil : $0 }),
                            options: [(0, "No budget")] + Self.budgetChoices(keeping: role.budgetMinutes).map { ($0, "About \(Teams.budgetWords($0))") })
                    .frame(maxWidth: 240, alignment: .leading)
            }
            TeamsField("Role", problem: says("prompt")) {
                TeamsTextInput(text: $role.prompt, placeholder: "What this role does, and how. conch hands it over with the team's rules.",
                               lines: 4...10)
            }
            TeamsField("Skills", problem: says("skills")) {
                TeamsTextInput(text: Binding(get: { Teams.skillsText(role.skills) }, set: { role.skills = Teams.skills(from: $0) }),
                               placeholder: "Skills to use, by name, comma-separated")
            }
            if let problemMessage, problemField == nil || ![
                "name", "id", "reportsTo", "atStart", "backend", "model", "effort", "permissions", "signIn", "host", "workspace",
                "maxConcurrent", "budgetMinutes", "prompt", "skills",
            ].contains(problemField!) {
                TeamsProblemText(problemMessage)
            }
        }
    }

    private func says(_ field: String) -> String? {
        problemField == field ? problemMessage : nil
    }

    /// The daemon's choices, and the role's own value among them even when it isn't one (said beside it by the check).
    static func listed(_ choices: [String], keeping current: String?) -> [String] {
        guard let current = Teams.nonEmpty(current), !choices.contains(current) else { return choices }
        return choices + [current]
    }

    static func budgetChoices(keeping current: Int?) -> [Int] {
        guard let current, !budgets.contains(current) else { return budgets }
        return (budgets + [current]).sorted()
    }
}

// MARK: - Starting a team

/// Start a team of a type: the task, the folder it works in, and Start. A folder its agents haven't been told to trust
/// asks first, and "Trust and start" says yes.
public struct TeamStartSheet: View {
    let type: TeamType
    let chooseFolder: (@MainActor () -> String?)?
    let start: (String, String, Bool) async -> TeamsStore.StartOutcome
    let done: () -> Void

    @State private var task: String
    @State private var folder: String
    @State private var needsTrust: [String]?
    @State private var problem: String?
    @State private var starting = false
    @State private var started: TeamSummary?
    @Environment(\.conchRendersStatically) private var rendersStatically

    public init(type: TeamType, task: String = "", folder: String, needsTrust: [String]? = nil, problem: String? = nil,
                chooseFolder: (@MainActor () -> String?)? = nil, start: @escaping (String, String, Bool) async -> TeamsStore.StartOutcome,
                done: @escaping () -> Void) {
        self.type = type
        self.chooseFolder = chooseFolder
        self.start = start
        self.done = done
        _task = State(initialValue: task)
        _folder = State(initialValue: folder)
        _needsTrust = State(initialValue: needsTrust)
        _problem = State(initialValue: problem)
    }

    public static let width: CGFloat = 540

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Start \(type.name)")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ConchColor.textPrimary)
                Text(Teams.hierarchyLine(type))
                    .font(.system(size: 11.5))
                    .foregroundStyle(ConchColor.textSecondary)
                    .lineLimit(2)
            }
            TeamsField("Task") {
                TeamsTextInput(text: $task, placeholder: "What should the team do?", lines: 5...10)
            }
            TeamsField("Folder") {
                HStack(spacing: ConchSpace.x2) {
                    TeamsTextInput(text: $folder, placeholder: "/path/to/the/project")
                    if chooseFolder != nil || rendersStatically {
                        OnboardingButton("Choose…", style: .row) {
                            if let chosen = chooseFolder?() {
                                folder = chosen
                                needsTrust = nil
                            }
                        }
                    }
                }
            }
            Text(startsLine)
                .font(.system(size: 11))
                .foregroundStyle(ConchColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if let needsTrust {
                HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x2) {
                    Image(systemName: "exclamationmark.shield")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(ConchColor.attention)
                    Text("\(Teams.agentList(needsTrust)) \(needsTrust.count == 1 ? "hasn't" : "haven't") been told to trust \(folder) yet. Trust and start tells \(needsTrust.count == 1 ? "it" : "them") to, as the New session sheet does.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ConchColor.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(ConchSpace.x3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: ConchRadius.small, style: .continuous).fill(ConchColor.fill))
            }
            if let problem {
                TeamsProblemText(problem)
            }
            if let started {
                Text("Started \(started.name). Its members appear in the sidebar as they start.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(ConchColor.ready)
            }
            HStack(spacing: ConchSpace.x3) {
                Spacer(minLength: 0)
                if starting { ProgressView().controlSize(.small) }
                OnboardingButton("Cancel", style: .row, action: done)
                OnboardingButton(needsTrust == nil ? "Start" : "Trust and start", style: .action) {
                    Task { await go(trust: needsTrust != nil) }
                }
                .disabled(starting)
            }
        }
        .padding(ConchSpace.x6)
        .frame(width: Self.width, alignment: .leading)
        .background(ConchColor.ground)
        .font(.system(size: 12))
    }

    /// Who starts now and who on the lead's word.
    private var startsLine: String {
        let lead = type.lead?.name ?? "The lead"
        let now = type.roles.filter { !$0.isLead && $0.atStart == true }.map(\.name)
        let later = type.roles.filter { !$0.isLead && $0.atStart != true }.map(\.name)
        var line = "conch starts \(lead.lowercased() == "lead" ? "the lead" : lead)"
        if !now.isEmpty { line += " and \(Teams.agentList(now))" }
        line += " with the task, each with its role and the team's rules."
        if !later.isEmpty { line += " \(Teams.agentList(later)) start\(later.count == 1 ? "s" : "") when the lead asks conch for one." }
        return line
    }

    private func go(trust: Bool) async {
        starting = true
        problem = nil
        let outcome = await start(task, folder, trust)
        starting = false
        switch outcome {
        case let .started(team):
            started = team
            needsTrust = nil
            done()
        case let .needsTrust(cwd, agents):
            folder = cwd
            needsTrust = agents
        case let .failed(message):
            problem = message
        }
    }
}

// MARK: - Passing a task

/// Pass a running team its next task: it goes into the lead's prompt as your message.
public struct TeamTaskSheet: View {
    let team: TeamSummary
    let send: (String) async -> TeamsStore.TaskOutcome
    let done: () -> Void

    @State private var task: String
    @State private var problem: String?
    @State private var sending = false

    public init(team: TeamSummary, task: String = "", problem: String? = nil, send: @escaping (String) async -> TeamsStore.TaskOutcome,
                done: @escaping () -> Void) {
        self.team = team
        self.send = send
        self.done = done
        _task = State(initialValue: task)
        _problem = State(initialValue: problem)
    }

    public static let width: CGFloat = 500

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Pass a task to \(team.name)")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ConchColor.textPrimary)
                Text("Now: \(team.currentTask)")
                    .font(.system(size: 11.5))
                    .foregroundStyle(ConchColor.textSecondary)
                    .lineLimit(2)
            }
            TeamsField("Next task") {
                TeamsTextInput(text: $task, placeholder: "What should the team do next?", lines: 4...10)
            }
            Text("It goes into the lead's prompt\(team.lead.map { " (\($0.label))" } ?? "") as your message; the lead hands the work out.")
                .font(.system(size: 11))
                .foregroundStyle(ConchColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if let problem {
                TeamsProblemText(problem)
            }
            HStack(spacing: ConchSpace.x3) {
                Spacer(minLength: 0)
                if sending { ProgressView().controlSize(.small) }
                OnboardingButton("Cancel", style: .row, action: done)
                OnboardingButton("Send", style: .action) {
                    Task {
                        sending = true
                        problem = nil
                        let outcome = await send(task)
                        sending = false
                        switch outcome {
                        case .sent: done()
                        case let .failed(message): problem = message
                        }
                    }
                }
                .disabled(sending)
            }
        }
        .padding(ConchSpace.x6)
        .frame(width: Self.width, alignment: .leading)
        .background(ConchColor.ground)
        .font(.system(size: 12))
    }
}

// MARK: - The sidebar

/// A running team's header in the sidebar: the team's mark and name, the task it is on under it on one fainter line, and
/// the chevron and count a folder's header has. A team's members sit under it however many folders they work in.
public struct TeamHeader: View {
    let name: String
    let task: String
    let count: Int
    let isCollapsed: Bool
    /// Another group's header is being dragged over this one and will take its slot.
    let isDropTarget: Bool
    let onToggle: () -> Void

    @State private var hovering = false

    public init(name: String, task: String, count: Int, isCollapsed: Bool, isDropTarget: Bool = false, onToggle: @escaping () -> Void = {}) {
        self.name = name
        self.task = task
        self.count = count
        self.isCollapsed = isCollapsed
        self.isDropTarget = isDropTarget
        self.onToggle = onToggle
    }

    /// Its two lines, whatever the task's length: one line each, so a long task never pushes the rows down.
    public static let height: CGFloat = 40

    public var body: some View {
        Button(action: onToggle) {
            HStack(alignment: .top, spacing: 4) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                    // As a folder's: chrome until you need it, and put while collapsed.
                    .opacity(hovering || isCollapsed ? 1 : 0.35)
                    .frame(width: 10, height: 15)
                    .foregroundStyle(ConchColor.textTertiary)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Image(systemName: "person.3.fill")
                            .font(.system(size: 8.5, weight: .semibold))
                        Text(name)
                            .font(.system(size: 12, weight: .semibold))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .foregroundStyle(ConchColor.textSecondary)
                    .frame(height: 15)
                    Text(task)
                        .font(.system(size: 11))
                        .foregroundStyle(ConchColor.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(height: 14)
                }
                Spacer(minLength: 4)
                if isCollapsed {
                    Text("\(count)")
                        .font(.system(size: 10, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(ConchColor.textTertiary)
                        .frame(height: 15)
                }
            }
            .padding(.horizontal, 6)
            .padding(.top, 8)
            .padding(.bottom, 2)
            .frame(height: Self.height, alignment: .top)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The window's one drop colour (the Mac's `ConchPalette.dropTarget`, the active blue).
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(ConchColor.active, lineWidth: isDropTarget ? 2 : 0)
        )
        .onHover { hovering = $0 }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(isCollapsed ? "Team \(name), \(task), \(count) sessions, collapsed" : "Team \(name), \(task)")
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Fields

/// A field's label above it, and what is wrong with it under it.
struct TeamsField<Content: View>: View {
    let label: String
    let problem: String?
    let content: Content

    init(_ label: String, problem: String? = nil, @ViewBuilder content: () -> Content) {
        self.label = label
        self.problem = problem
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchColor.textSecondary)
            content
            if let problem {
                TeamsProblemText(problem)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Two fields side by side, the same width each.
struct TeamsPair<Leading: View, Trailing: View>: View {
    let leading: Leading
    let trailing: Trailing

    init(@ViewBuilder leading: () -> Leading, @ViewBuilder trailing: () -> Trailing) {
        self.leading = leading()
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .top, spacing: ConchSpace.x4) {
            leading.frame(maxWidth: .infinity, alignment: .leading)
            trailing.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct TeamsProblemText: View {
    let message: String
    init(_ message: String) { self.message = message }

    var body: some View {
        Text(message)
            .font(.system(size: 11))
            .foregroundStyle(ConchColor.attention)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The box every field sits in: the surface, its hairline, the menus' small radius.
struct TeamsFieldBox: ViewModifier {
    var boxed = true

    func body(content: Content) -> some View {
        if boxed {
            content
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .frame(maxWidth: .infinity, minHeight: 26, alignment: .topLeading)
                .background(RoundedRectangle(cornerRadius: ConchRadius.small, style: .continuous).fill(ConchColor.surface))
                .overlay(RoundedRectangle(cornerRadius: ConchRadius.small, style: .continuous).strokeBorder(ConchColor.hairlineStrong, lineWidth: 1))
        } else {
            content.frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }
}

/// A text field, one line or growing to `lines`; in a picture, its words in the same box.
struct TeamsTextInput: View {
    @Binding var text: String
    let placeholder: String
    var lines: ClosedRange<Int>? = nil
    var boxed = true
    @Environment(\.conchRendersStatically) private var rendersStatically

    var body: some View {
        Group {
            if rendersStatically {
                Text(text.isEmpty ? placeholder : text)
                    .foregroundStyle(text.isEmpty ? AnyShapeStyle(ConchColor.textTertiary) : AnyShapeStyle(ConchColor.textPrimary))
                    .lineLimit(lines?.upperBound ?? 1)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity,
                           minHeight: lines.map { CGFloat($0.lowerBound) * 15 } ?? nil, alignment: .topLeading)
            } else if let lines {
                TextField(placeholder, text: $text, axis: .vertical)
                    .lineLimit(lines)
                    .textFieldStyle(.plain)
            } else {
                TextField(placeholder, text: $text)
                    .textFieldStyle(.plain)
            }
        }
        .font(.system(size: 12))
        .modifier(TeamsFieldBox(boxed: boxed))
    }
}

/// A choice from a short list, as a menu; in a picture, its current choice in the box with the menu's arrows.
struct TeamsChoice<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(Value, String)]
    @Environment(\.conchRendersStatically) private var rendersStatically

    var body: some View {
        if rendersStatically {
            HStack(spacing: 4) {
                Text(options.first(where: { $0.0 == selection })?.1 ?? "")
                    .foregroundStyle(ConchColor.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(ConchColor.textTertiary)
            }
            .font(.system(size: 12))
            .modifier(TeamsFieldBox())
        } else {
            Picker("", selection: $selection) {
                ForEach(options.indices, id: \.self) { index in
                    Text(options[index].1).tag(options[index].0)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// A count between bounds, with − and +.
struct TeamsCount: View {
    @Binding var value: Int
    let range: ClosedRange<Int>
    let words: (Int) -> String
    @Environment(\.conchRendersStatically) private var rendersStatically

    var body: some View {
        HStack(spacing: ConchSpace.x2) {
            Text(words(value))
                .foregroundStyle(ConchColor.textPrimary)
                .monospacedDigit()
            Spacer(minLength: 4)
            if rendersStatically {
                Image(systemName: "minus").foregroundStyle(ConchColor.textTertiary)
                Image(systemName: "plus").foregroundStyle(ConchColor.textTertiary)
            } else {
                Stepper("", value: $value, in: range)
                    .labelsHidden()
            }
        }
        .font(.system(size: 12))
        .modifier(TeamsFieldBox())
    }
}

/// A value that can't change here, in the box a choice would have.
struct TeamsFixed: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundStyle(ConchColor.textSecondary)
            .lineLimit(1)
            .modifier(TeamsFieldBox())
    }
}
