import SwiftUI

/// Settings › Workflows' rows and reader (2026-11-11): a saved workflow, what it does and when, its phases, how to start it
/// in an open session or a new one, and where it lives; a run, with each phase's agents and the way to its session. The
/// controls are LibraryUseViews.swift's, the rules Workflows.swift's.

// MARK: - A workflow

public struct WorkflowDetailActions {
    public var run: (LibraryUse) -> Void
    public var type: (LibraryUse) -> Void
    public var newSession: () -> Void
    public var openSession: (LibrarySession) -> Void
    public var reveal: (WorkflowLocationInfo) -> Void
    public var openPlugins: () -> Void

    public init(run: @escaping (LibraryUse) -> Void, type: @escaping (LibraryUse) -> Void, newSession: @escaping () -> Void,
                openSession: @escaping (LibrarySession) -> Void, reveal: @escaping (WorkflowLocationInfo) -> Void, openPlugins: @escaping () -> Void) {
        self.run = run
        self.type = type
        self.newSession = newSession
        self.openSession = openSession
        self.reveal = reveal
        self.openPlugins = openPlugins
    }

    public static let none = WorkflowDetailActions(run: { _ in }, type: { _ in }, newSession: {}, openSession: { _ in }, reveal: { _ in }, openPlugins: {})
}

/// A workflow, above its script: what it does and when, its phases, Use, where it lives, and the sessions that have it.
public struct WorkflowDetailPanel: View {
    let workflow: WorkflowInfo
    let uses: [LibraryUse]
    /// Said when the feature is off for an account that has it.
    let featureOff: String?
    let actions: WorkflowDetailActions

    public init(workflow: WorkflowInfo, uses: [LibraryUse], featureOff: String? = nil, actions: WorkflowDetailActions) {
        self.workflow = workflow
        self.uses = uses
        self.featureOff = featureOff
        self.actions = actions
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: ConchSpace.x3) {
            if let problem = workflow.problem {
                LibraryNotice(symbol: "exclamationmark.triangle", text: problem, isProblem: true)
            }
            if let featureOff { LibraryNotice(symbol: "pause.circle", text: featureOff, isProblem: false) }
            if let description = workflow.description {
                Text(description)
                    .font(.system(size: 12))
                    .foregroundStyle(ConchColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if let whenToUse = workflow.whenToUse {
                LibraryFact(label: "When") {
                    Text(whenToUse).font(.system(size: 11.5)).foregroundStyle(ConchColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if !workflow.phases.isEmpty {
                LibraryFact(label: "Phases") {
                    ForEach(Array(workflow.phases.enumerated()), id: \.offset) { index, phase in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("\(index + 1)").font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                                .foregroundStyle(ConchColor.textTertiary).frame(width: 12, alignment: .trailing)
                            Text(phase.title).font(.system(size: 12, weight: .medium)).foregroundStyle(ConchColor.textPrimary)
                            if let detail = phase.detail {
                                Text(detail).font(.system(size: 11.5)).foregroundStyle(ConchColor.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }
            if workflow.problem == nil {
                LibraryFact(label: "Use") {
                    LibraryUseRow(name: workflow.name, uses: uses,
                                  newSession: (title: "New session…", help: "Start a Claude session in a folder you pick, and run \(workflow.locations.first?.invocation ?? workflow.name) as its first message", run: actions.newSession),
                                  onRun: actions.run, onType: actions.type)
                }
            }
            LibraryFact(label: workflow.locations.count == 1 ? "Lives in" : "Copies") {
                ForEach(workflow.locations) { location in
                    HStack(alignment: .center, spacing: ConchSpace.x2) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(WorkflowsLibrary.locationTitle(location))
                                .font(.system(size: 12, weight: .medium)).foregroundStyle(ConchColor.textPrimary).lineLimit(1)
                            Text(copyLine(location))
                                .font(.system(size: 11))
                                .foregroundStyle(location.enabled == false ? ConchColor.attention : ConchColor.textSecondary)
                                .lineLimit(1).truncationMode(.middle)
                        }
                        Spacer(minLength: ConchSpace.x2)
                        if location.origin == "plugin" {
                            LibraryPillButton("Plugins & MCP", symbol: "arrow.up.right", help: "Switch or remove its plugin in Settings › Plugins & MCP", action: actions.openPlugins)
                        }
                        LibraryPillButton("", symbol: "folder", help: "Reveal its script in Finder") { actions.reveal(location) }
                    }
                }
            }
            if workflow.problem == nil {
                LibraryFact(label: "Sessions") {
                    LibrarySessionChips(uses: uses, onOpen: actions.openSession)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, ConchSpace.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func copyLine(_ location: WorkflowLocationInfo) -> String {
        var parts: [String] = [location.origin == "user" ? "your workflow" : location.origin == "project" ? "project workflow"
            : "plugin \(location.pluginId.map { String($0.split(separator: "@")[0]) } ?? "")"]
        if location.enabled == false { parts.append("off with its plugin") }
        if workflow.problem == nil { parts.append(location.invocation) }
        parts.append((location.path as NSString).abbreviatingWithTildeInPath)
        return parts.joined(separator: " · ")
    }
}

/// A line that stands out of the reader: a problem in attention's colour, a note in the secondary one.
struct LibraryNotice: View {
    let symbol: String
    let text: String
    let isProblem: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: symbol).font(.system(size: 10.5, weight: .semibold))
            Text(text).font(.system(size: 11.5)).fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(isProblem ? ConchColor.attention : ConchColor.textSecondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: ConchRadius.small, style: .continuous).fill(ConchColor.fill))
    }
}

// MARK: - Workflows' rows

/// One saved workflow: its name and how it's typed, what it does, and a chip for every place it lives.
public struct WorkflowRow: View {
    let workflow: WorkflowInfo
    let isSelected: Bool
    let onSelect: () -> Void
    @State private var isHovered = false

    public init(workflow: WorkflowInfo, isSelected: Bool, onSelect: @escaping () -> Void) {
        self.workflow = workflow
        self.isSelected = isSelected
        self.onSelect = onSelect
    }

    public var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: LibraryRowInset.lineGap) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(workflow.name)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(ConchColor.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    let detail = WorkflowsLibrary.detail(workflow)
                    if !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: 11))
                            .foregroundStyle(LibraryRowText.quiet(selected: isSelected))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 0)
                }
                if let problem = workflow.problem {
                    Text(problem)
                        .font(.system(size: 11.5))
                        .foregroundStyle(ConchColor.attention)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let description = workflow.description {
                    Text(description)
                        .font(.system(size: 11.5))
                        .foregroundStyle(ConchColor.textSecondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                LibraryFlow(spacing: 5) {
                    ForEach(WorkflowsLibrary.chips(workflow)) { chip in
                        LibraryChip(chip.title, isOff: chip.isOff, onSelection: isSelected)
                    }
                }
                .padding(.top, 1)
            }
            .padding(.horizontal, LibraryRowInset.horizontal)
            .padding(.top, LibraryRowInset.vertical)
            .padding(.bottom, ConchSpace.x3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Rectangle().fill(LibraryRowFill.style(selected: isSelected, hovered: isHovered)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help("Show \(workflow.name): its phases, where it lives, and the sessions you can run it in")
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

/// A thin bar for how far something is, or a quiet track while nothing has started.
struct LibraryProgressBar: View {
    let fraction: Double?
    var height: CGFloat = 3

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(ConchColor.fill)
                if let fraction {
                    Capsule().fill(fraction >= 1 ? ConchColor.ready : ConchColor.accent)
                        .frame(width: max(height, proxy.size.width * min(1, fraction)))
                }
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}

/// One run in an open session: its workflow, where it is, and how far.
public struct WorkflowRunRow: View {
    let run: WorkflowRunInfo
    let now: Date
    let isSelected: Bool
    let onSelect: () -> Void
    @State private var isHovered = false

    public init(run: WorkflowRunInfo, now: Date = Date(), isSelected: Bool, onSelect: @escaping () -> Void) {
        self.run = run
        self.now = now
        self.isSelected = isSelected
        self.onSelect = onSelect
    }

    public var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: LibraryRowInset.lineGap + 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Circle()
                        .fill(run.isRunning ? ConchColor.accent : run.status == "completed" ? ConchColor.ready : ConchColor.quiet)
                        .frame(width: 6, height: 6)
                        .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                    Text(run.name)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(ConchColor.textPrimary)
                        .lineLimit(1)
                    Text(WorkflowsLibrary.runState(run))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(run.isRunning ? ConchColor.textPrimary : LibraryRowText.quiet(selected: isSelected))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                // Two lines rather than a cut: "6…done" said nothing.
                Text(WorkflowsLibrary.runDetail(run, now: now))
                    .font(.system(size: 11))
                    .foregroundStyle(ConchColor.textSecondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 12)
                if run.isRunning {
                    LibraryProgressBar(fraction: WorkflowsLibrary.fraction(run))
                        .padding(.leading, 12)
                        .padding(.top, 2)
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
        .help("Show this run's phases and agents, with the way to its session")
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

/// A run, in the reader: each phase with its agents, the one it is in, and the way to its session, where its full
/// progress is in the conversation.
public struct WorkflowRunPanel: View {
    let run: WorkflowRunInfo
    let now: Date
    let onOpenSession: () -> Void

    public init(run: WorkflowRunInfo, now: Date = Date(), onOpenSession: @escaping () -> Void) {
        self.run = run
        self.now = now
        self.onOpenSession = onOpenSession
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: ConchSpace.x4) {
            HStack(alignment: .center, spacing: ConchSpace.x2) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(WorkflowsLibrary.runState(run))
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(ConchColor.textPrimary)
                    Text(WorkflowsLibrary.runDetail(run, now: now, session: false))
                        .font(.system(size: 11.5))
                        .foregroundStyle(ConchColor.textSecondary)
                }
                Spacer(minLength: ConchSpace.x2)
                LibraryPillButton("Open \(run.sessionLabel)", symbol: "arrow.right", prominent: true,
                                  help: "Show the session it runs in, where each agent's work is in the conversation", action: onOpenSession)
            }
            if run.isRunning {
                LibraryProgressBar(fraction: WorkflowsLibrary.fraction(run), height: 4)
            }
            if run.phases.isEmpty {
                Text("This run declared no phases; its agents are in the session's conversation.")
                    .font(.system(size: 11.5)).foregroundStyle(ConchColor.textSecondary)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(run.phases.enumerated()), id: \.offset) { index, phase in
                        if index > 0 { Rectangle().fill(ConchColor.hairline).frame(height: 1) }
                        phaseRow(index: index, phase: phase)
                    }
                }
                .background(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous).fill(ConchColor.surfaceRaised))
                .overlay(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous).strokeBorder(ConchColor.hairline, lineWidth: 1))
            }
            if let summary = run.summary {
                LibraryFact(label: "Summary") {
                    Text(summary).font(.system(size: 11.5)).foregroundStyle(ConchColor.textPrimary)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func phaseRow(index: Int, phase: WorkflowRunPhaseInfo) -> some View {
        let current = run.isRunning && run.currentPhase == phase.title
        let finished = phase.started > 0 && phase.done == phase.started && !current
        return HStack(alignment: .center, spacing: ConchSpace.x3) {
            Image(systemName: finished ? "checkmark.circle.fill" : current ? "circle.lefthalf.filled" : "circle")
                .font(.system(size: 12))
                .foregroundStyle(finished ? ConchColor.ready : current ? ConchColor.accent : ConchColor.textTertiary)
                .frame(width: 14)
            VStack(alignment: .leading, spacing: 2) {
                Text(phase.title).font(.system(size: 12, weight: current ? .semibold : .medium)).foregroundStyle(ConchColor.textPrimary)
                if let detail = phase.detail {
                    Text(detail).font(.system(size: 11)).foregroundStyle(ConchColor.textSecondary).lineLimit(2)
                }
            }
            Spacer(minLength: ConchSpace.x2)
            Text(WorkflowsLibrary.phaseAgents(phase, running: run.isRunning))
                .font(.system(size: 11).monospacedDigit())
                .foregroundStyle(ConchColor.textSecondary)
            if run.isRunning, phase.started > 0 {
                LibraryProgressBar(fraction: WorkflowsLibrary.fraction(phase)).frame(width: 64)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }
}
