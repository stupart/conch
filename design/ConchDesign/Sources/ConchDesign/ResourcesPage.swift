import Foundation
import SwiftUI

// Settings › Resources (2026-11-11): what each session uses, green, yellow or red, and agents' load against a budget.
//
// Tyler: "long term conch should probably show in its UI with green, yellow, red what sessions are using what in some
// view in settings or something and this can be connected to the who owns what idea … Long term u should prob be
// setting the 'budget' for how much continuous load agents can use in conch." The figures are the daemon's
// (src/resource-load.ts): five-minute CPU, Activity Monitor's memory, each process counted once for its nearest session.
// Holding or lowering anything is his, here or in `conch resources`; the one thing conch may do on its own, lower a
// heavy leftover's priority while agents are over budget, is a setting that ships off.

public enum ResourcesPage {
    /// The CPU budget's choices: shares, then whole cores this Mac has (2026-11-12, "14 cores and 100GB"). Any other value
    /// is the setting's own field in General, or `conch set agent-budget-cpu 14`.
    public static func cpuChoices(cores: Int) -> [String] {
        [25, 50, 75, 90, 100].map { "\($0)%" } + [2, 4, 8, 12, 14, 16, 24, 32].filter { $0 <= cores }.map { "\($0) cores" }
    }

    /// The memory budget's: shares, then amounts in GB (GiB) this Mac has.
    public static func memoryChoices(total bytes: Double) -> [String] {
        let gb = bytes / 1_073_741_824
        return [25, 50, 60, 75, 90].map { "\($0)%" } + [8, 16, 32, 64, 96, 100, 128, 192].filter { Double($0) <= gb + 0.05 }.map { "\($0) GB" }
    }

    /// How the thresholds read, under the list.
    public static let thresholds = "A session, with everything it runs and left running, is yellow at a core or 4 GB for five minutes, red at three cores or 12 GB, or over the budget. Something it left running is yellow at half a core or 2 GB, or past its time; red at two cores or 8 GB, or a day past its time."

    /// What a budget bar fills: used over limit, held between 0 and 1 (the words say how far over).
    public static func fraction(_ used: Double, of limit: Double) -> Double {
        guard limit > 0 else { return 0 }
        return min(1, max(0, used / limit))
    }

    /// "4.1 of 2.0 cores", "15.0 of 8.0 GB".
    public static func cpuLine(_ budget: ResourceBudget) -> String {
        String(format: "%.1f of %.1f cores%@", budget.cpu / 100, budget.cpuLimit / 100, budget.sustained ? "" : " (not yet 5 min)")
    }

    public static func memoryLine(_ budget: ResourceBudget) -> String {
        "\(StillRunning.memory(budget.memory).replacingOccurrences(of: " GB", with: "")) of \(StillRunning.memory(budget.memoryLimit))"
    }

    /// The sessions over budget, by name: "Over: Build farm, Landing page".
    public static func overLine(_ resources: PublishedResources) -> String? {
        guard let budget = resources.budget, !budget.over.isEmpty else { return nil }
        let names = budget.over.map { key in resources.sessions.first { $0.key == key }?.label ?? key }
        return "Over: \(names.joined(separator: ", ")). Hold or lower what they run below, or stop what they left."
    }

    /// "1.7 cores · 300 MB · 2 left running", and what Tyler did: lowered.
    public static func sessionLine(_ session: ResourceSessionUsage) -> String {
        var parts = [String(format: "%.1f cores%@", session.cpu / 100, session.sustained ? "" : "*"), StillRunning.memory(session.memory)]
        if session.resources > 0 { parts.append("\(session.resources) left running") }
        if session.lowered == true { parts.append("lowered") }
        return parts.joined(separator: " · ")
    }

    /// What one session left running, or everything unowned.
    public static func items(for session: ResourceSessionUsage, in resources: PublishedResources) -> [ResourceItem] {
        resources.items.filter { session.isUnowned ? $0.owner == nil : $0.owner?.key == session.key }
    }

    /// The sessions to list: every live session that uses something or left something, ended ones with leftovers, then
    /// the unowned. A quiet live session with nothing left is green and listed, so the page says it is fine.
    public static func sessions(_ resources: PublishedResources) -> [ResourceSessionUsage] {
        resources.sessions.filter { $0.isUnowned ? $0.resources > 0 : ($0.live || $0.resources > 0) }
    }
}

/// The page, without its header (the Mac's `SettingsSectionHeader` sits above it). `decide` sends Tyler's word on one
/// resource, `lowerSession` lowers or restores a whole session, `setBudget` changes the budget's settings; each answers
/// with what to say if it failed.
public struct ResourcesPageView: View {
    let resources: PublishedResources?
    let now: Date
    let decide: @Sendable (String, ResourceAction) async -> String?
    let lowerSession: @Sendable (String, Bool) async -> String?
    let setBudget: @Sendable (ResourceBudgetRequest) async -> String?

    @State private var pending: Set<String> = []
    @State private var errors: [String: String] = [:]
    @Environment(\.colorScheme) private var scheme

    public init(
        resources: PublishedResources?,
        now: Date,
        decide: @escaping @Sendable (String, ResourceAction) async -> String?,
        lowerSession: @escaping @Sendable (String, Bool) async -> String?,
        setBudget: @escaping @Sendable (ResourceBudgetRequest) async -> String?
    ) {
        self.resources = resources
        self.now = now
        self.decide = decide
        self.lowerSession = lowerSession
        self.setBudget = setBudget
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let resources {
                if let budget = resources.budget { budgetCard(budget, resources) }
                let sessions = ResourcesPage.sessions(resources)
                if sessions.isEmpty {
                    Text("No session is using anything worth a line right now.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(ConchColor.textSecondary)
                }
                ForEach(sessions) { session in sessionCard(session, resources) }
                Text(ResourcesPage.thresholds)
                    .font(.system(size: 11))
                    .foregroundStyle(ConchColor.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("conch's daemon hasn't said what is running yet: it looks every 30 seconds.")
                    .font(.system(size: 12.5))
                    .foregroundStyle(ConchColor.textSecondary)
            }
        }
    }

    // MARK: the budget

    private func budgetCard(_ budget: ResourceBudget, _ resources: PublishedResources) -> some View {
        let level = ResourceLevel(budget.level)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                ResourceLevelDot(level, size: 9)
                Text("Agents' load")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(ConchColor.textPrimary)
                Spacer(minLength: 8)
                if let error = errors["budget"] {
                    Text(error).font(.system(size: 11)).foregroundStyle(ConchColor.attention)
                }
            }
            bar(title: "CPU", detail: ResourcesPage.cpuLine(budget), fraction: ResourcesPage.fraction(budget.cpu, of: budget.cpuLimit), level: level) {
                budgetPicker(label: budget.cpuText, current: budget.cpuSetting, choices: ResourcesPage.cpuChoices(cores: budget.cores)) { .cpu($0) }
            }
            bar(title: "Memory", detail: ResourcesPage.memoryLine(budget), fraction: ResourcesPage.fraction(budget.memory, of: budget.memoryLimit), level: level) {
                budgetPicker(label: budget.memoryText, current: budget.memorySetting, choices: ResourcesPage.memoryChoices(total: budget.memoryTotal)) { .memory($0) }
            }
            if let over = ResourcesPage.overLine(resources) {
                Text(over)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(ConchColor.attention)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Toggle(isOn: Binding(get: { budget.autoBackground }, set: { on in send(key: "budget") { await setBudget(.autoBackground(on)) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Lower the priority of heavy leftovers while agents are over budget")
                        .font(.system(size: 12.5))
                        .foregroundStyle(ConchColor.textPrimary)
                    Text("Something a session left running that has kept a core busy for five minutes runs after everything else (taskpolicy -b). Nothing is stopped or paused, and Restore priority takes it back.")
                        .font(.system(size: 11))
                        .foregroundStyle(ConchColor.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .toggleStyle(.switch)
            .controlSize(.small)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(ConchColor.surface))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ConchColor.hairline, lineWidth: 1))
    }

    private func bar<Trailing: View>(title: String, detail: String, fraction: Double, level: ResourceLevel, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: 10) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(ConchColor.textSecondary)
                .frame(width: 56, alignment: .leading)
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(ConchColor.fill)
                    Capsule().fill(level.color(scheme)).frame(width: max(4, proxy.size.width * fraction))
                }
            }
            .frame(height: 6)
            Text(detail)
                .font(.system(size: 11.5))
                .monospacedDigit()
                .foregroundStyle(ConchColor.textSecondary)
                .frame(minWidth: 128, alignment: .leading)
            trailing()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title): \(detail)")
    }

    /// The setting in its own unit with the other beside it ("14 cores (78% of 18)"), and a menu of shares and amounts.
    private func budgetPicker(label: String, current: String, choices: [String], request: @escaping (String) -> ResourceBudgetRequest) -> some View {
        Menu {
            ForEach(choices, id: \.self) { choice in
                Button(choice == current ? "\(choice) ✓" : choice) { send(key: "budget") { await setBudget(request(choice)) } }
            }
        } label: {
            Text(label).font(.system(size: 11.5))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    // MARK: sessions

    private func sessionCard(_ session: ResourceSessionUsage, _ resources: PublishedResources) -> some View {
        let items = ResourcesPage.items(for: session, in: resources)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                ResourceLevelDot(ResourceLevel(session.level), size: 9)
                Text(session.isUnowned ? "Unowned" : session.label)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ConchColor.textPrimary)
                    .lineLimit(1)
                if !session.live && !session.isUnowned {
                    Text("ended").font(.system(size: 11)).foregroundStyle(ConchColor.textTertiary)
                }
                if session.over == true {
                    Text("over budget")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(ConchColor.attention)
                }
                Spacer(minLength: 8)
                if pending.contains("session:\(session.key)") {
                    ProgressView().controlSize(.mini)
                } else if session.live, let sessionId = session.sessionId {
                    let lowered = session.lowered == true
                    Button(lowered ? "Restore priority" : "Lower priority") {
                        send(key: "session:\(session.key)") { await lowerSession(sessionId, !lowered) }
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ConchColor.textSecondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(ConchColor.fill))
                    .help(lowered ? "Run its processes at their usual priority again (taskpolicy -B)" : "Run it and everything under it after everything else (taskpolicy -b). Nothing stops.")
                }
            }
            Text(error(for: "session:\(session.key)") ?? ResourcesPage.sessionLine(session) + (session.reasons.first.map { " · \($0)" } ?? ""))
                .font(.system(size: 11.5))
                .monospacedDigit()
                .foregroundStyle(error(for: "session:\(session.key)") == nil ? AnyShapeStyle(ConchColor.textSecondary) : AnyShapeStyle(ConchColor.attention))
                .padding(.leading, 17)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(items) { item in
                StillRunningRow(item: item, now: now, pending: pending.contains(item.id), error: errors[item.id]) { action in
                    send(key: item.id) { await decide(item.id, action) }
                }
                .padding(.leading, 7)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(session.isUnowned ? "Unowned" : session.label), \(session.level), \(ResourcesPage.sessionLine(session))")
    }

    private func error(for key: String) -> String? { errors[key] }

    private func send(key: String, _ action: @escaping @Sendable () async -> String?) {
        guard !pending.contains(key) else { return }
        pending.insert(key)
        errors[key] = nil
        Task { @MainActor in
            let error = await action()
            pending.remove(key)
            errors[key] = error
        }
    }
}
