import ConchDesign
import SwiftUI

// Settings › Teams (2026-11-12, Teams.swift): the page with a running team and the types, the editor open on a role, the
// start sheet as it opens and when the folder needs trusting, Pass task…, and the sidebar with a team's group above a
// folder's. Names, folders and tasks are made up.

enum TeamsGalleryFixtures {
    static let home = "/Users/alex"
    static let now = Date().timeIntervalSince1970 * 1_000
    static let minute = 60_000.0

    static let agents: [String: TeamAgentChoices] = [
        "claude": TeamAgentChoices(efforts: ["low", "medium", "high", "xhigh", "max"],
                                   permissions: ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]),
        "codex": TeamAgentChoices(efforts: ["minimal", "low", "medium", "high", "xhigh"],
                                  permissions: ["read-only", "workspace-write", "danger-full-access"]),
    ]

    // conch's own starter types, as the daemon ships them (src/teams.ts `STARTER_TEAM_TYPES`).
    static let buildReview = TeamType(
        id: "build-review", name: "Build + review",
        summary: "The lead splits the task into parts that don't touch the same files, builders each build one in a worktree of their own and open a PR, and a reviewer reviews every PR. Nobody merges.",
        roles: [
            TeamRole(id: "lead", name: "Lead", backend: .claude, effort: "high",
                     prompt: "You plan and coordinate; you don't write the code yourself. Read the task and the code it touches, then split it into parts small enough to review, where no two parts edit the same files. Ask conch for one builder per part, each with a brief that stands on its own: what to change, where, how to check it, and the user's own words where they matter. As builders report, send each PR to the reviewer and send fixes back to its builder. Keep a list of every part and where it stands (not started, building, in review, ready), and finish with that list and the PR links.",
                     atStart: true),
            TeamRole(id: "builder", name: "Builder", reportsTo: "lead", backend: .claude,
                     prompt: "You build one part of the task, in a worktree and branch of your own. Read the code before changing it, and follow the repository's own conventions and instructions. Fix causes, not symptoms. Run the tests that cover what you changed, commit with a message that says why, push, and open a PR. Report to your lead with the PR link, what you checked and how, and anything you were unsure of.",
                     workspace: .worktree, maxConcurrent: 3),
            TeamRole(id: "reviewer", name: "Reviewer", reportsTo: "lead", backend: .claude, effort: "high",
                     prompt: "You review each PR your lead sends you, with fresh eyes: read the diff and the code around it, not the builder's account of it. Check that it does what its part asked, look for bugs, missing tests and anything against the repository's conventions, and run its tests where you can. Report a verdict (approve, or changes needed) and your findings ranked by how much they matter, each pointing at a file and line. You only read: never push to a builder's branch.",
                     skills: ["code-review"]),
        ],
        rules: [
            "The lead plans and delegates; the members do the work and report back to whoever they report to.",
            "Each builder works in a git worktree and branch of its own, and opens a PR for its part.",
            "Every PR is reviewed by the reviewer before anyone calls it ready.",
            "Nobody merges. Merging is the user's decision.",
            "Claims need evidence: a test run, a command's output, or a screenshot you opened. Never call something done on another member's word alone.",
            "If two parts turn out to touch the same files, stop and tell the lead before going on.",
        ]
    )

    static let researchSpecBuild = TeamType(
        id: "research-spec-build", name: "Research → spec → build",
        summary: "A researcher gathers the evidence and the options, the lead turns them into a short spec and shows it to you before anything is built, then builders build from the spec.",
        roles: [
            TeamRole(id: "lead", name: "Lead", backend: .claude, effort: "high",
                     prompt: "You own the spec. Give the researcher the open questions, read what it finds, and write a short spec: the goal, what is in and out, the approach and why, how it will be checked, and the decisions still open. Publish the spec for the user to read, and wait for their go-ahead before asking conch for builders. Then give each builder one part of the spec, and keep the spec current as decisions change.",
                     atStart: true),
            TeamRole(id: "researcher", name: "Researcher", reportsTo: "lead", backend: .claude,
                     prompt: "You find things out before anything is built. Look at the sources themselves (the code, the docs, the pages, the data) rather than answering from memory, and note where each fact came from. Compare two or three options with their trade-offs and recommend one. Report to your lead with your findings, their sources and the questions still open. You don't change code.",
                     atStart: true),
            TeamRole(id: "builder", name: "Builder", reportsTo: "lead", backend: .claude,
                     prompt: "You build one part of the spec, in a worktree and branch of your own. If the spec turns out to be wrong or unclear, ask your lead rather than guessing. Run the tests that cover your change, open a PR, and report what you built, how you checked it, and where it differs from the spec.",
                     workspace: .worktree, maxConcurrent: 2),
        ],
        rules: [
            "Research first, then a spec, then building. Nothing is built before the user has seen the spec.",
            "Quote the user's own words to every member rather than paraphrasing them.",
            "Every fact carries its source. Say what was checked and what is assumed.",
            "Builders work in worktrees of their own and open PRs. Nobody merges.",
        ]
    )

    static let designCrit = TeamType(
        id: "design-crit", name: "Design crit loop",
        summary: "A designer builds the UI, a fresh critic each round ranks what to fix from screenshots of the real build, and the designer fixes and re-shoots until the critic passes it or three rounds are up.",
        roles: [
            TeamRole(id: "designer", name: "Designer", backend: .claude, effort: "high",
                     prompt: "You lead the loop and do the building. Screenshot every surface and state the task touches from the real, running build, at the sizes it ships at, and open each one yourself. Each round, ask conch for a critic with the screenshots' folder and what to judge against. Fix what it ranks highest first, re-shoot the same states, and compare before and after so nothing that was good got worse. Stop when the critic finds nothing high or medium, or after three rounds, and publish a before-and-after with a plain changelog.",
                     atStart: true),
            TeamRole(id: "critic", name: "Critic", reportsTo: "designer", backend: .claude, effort: "high",
                     prompt: "You are the independent critic for one round. Open every screenshot you are given and judge it against the brief and the bar of a top design studio, not against how it was made. Return a verdict and a ranked list of fixes (high, medium, low), each citing the screenshot it is seen in, and from the second round on, anything that got worse. You only read: no edits, no dev servers.",
                     budgetMinutes: 30),
        ],
        rules: [
            "Every claim about the UI rests on a screenshot of the current build, opened in this round.",
            "The critic is fresh each round and never edits; the designer fixes.",
            "Fix causes; never hide a problem by hiding, clipping or moving what is wrong.",
            "Stop the dev servers you started, and only those.",
            "Nobody merges. Merging is the user's decision.",
        ]
    )

    static let running = TeamSummary(
        id: "build-review-2", typeId: "build-review", name: "Build + review", task: "Add a dark mode to Settings",
        cwd: "\(home)/Projects/field-notes", startedAt: now - 34 * minute,
        members: [
            TeamMember(key: "lead-1", roleId: "lead", roleName: "Lead", label: "Lead · Add a dark mode to Settings", sessionId: "s-lead", state: .running,
                       startedAt: now - 34 * minute, status: "working"),
            TeamMember(key: "builder-1", roleId: "builder", roleName: "Builder", label: "Builder · Add a dark mode to Settings", sessionId: "s-b1", state: .running,
                       startedAt: now - 28 * minute, reportsTo: "lead-1", status: "waiting", budgetMinutes: 120),
            TeamMember(key: "builder-2", roleId: "builder", roleName: "Builder", label: "Builder 2 · Add a dark mode to Settings", sessionId: "s-b2", state: .running,
                       startedAt: now - 27 * minute, reportsTo: "lead-1", status: "working", budgetMinutes: 120),
            TeamMember(key: "reviewer-1", roleId: "reviewer", roleName: "Reviewer", label: "Reviewer · Add a dark mode to Settings", state: .starting,
                       startedAt: now - 1 * minute, reportsTo: "lead-1"),
        ],
        tasks: [TeamTaskEntry(text: "Add a dark mode to Settings", at: now - 34 * minute, from: "you")]
    )

    static let failedStart = TeamSummary(
        id: "design-crit-1", typeId: "design-crit", name: "Design crit loop", task: "Make the inbox's empty state calm",
        cwd: "\(home)/Projects/inbox-app", startedAt: now - 3 * minute,
        members: [
            TeamMember(key: "designer-1", roleId: "designer", roleName: "Designer", label: "Designer · Make the inbox's empty state calm", sessionId: "s-d1", state: .running,
                       startedAt: now - 3 * minute, status: "needs"),
            TeamMember(key: "critic-1", roleId: "critic", roleName: "Critic", label: "Critic · Make the inbox's empty state calm", state: .failed,
                       error: "its tab never started its agent", startedAt: now - 3 * minute, reportsTo: "designer-1"),
        ]
    )

    static let list = TeamsList(types: [buildReview, researchSpecBuild, designCrit], running: [running, failedStart], agents: agents,
                                signIns: [TeamSignIn(id: "a1", label: "Work"), TeamSignIn(id: "b2", label: "Personal")], missingStarters: 0)
}

/// The sidebar, drawn as the Mac draws it (DashboardView's `SessionLedger`): a team's header and its members, then a
/// folder's header and its sessions. The rows are stand-ins built to `DashboardRow`'s numbers, as the render tests' are.
struct TeamsGallerySidebar: View {
    struct Row {
        let name: String
        let mark: (String, CGFloat, ConchColorToken)
        var line: String? = nil
    }

    static let working = ("circle.fill", CGFloat(8), ConchColor.active)
    static let waiting = ("circle.inset.filled", CGFloat(8), ConchColor.ready)
    static let needs = ("exclamationmark.circle.fill", CGFloat(10.5), ConchColor.attention)
    static let idle = ("circle.dotted", CGFloat(8), ConchColor.textTertiary)

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            TeamHeader(name: "Build + review", task: "Add a dark mode to Settings", count: 4, isCollapsed: false)
            row(Row(name: "Lead · Add a dark mode to Settings", mark: Self.working, line: "Splitting the work into three parts"))
            row(Row(name: "Builder · Add a dark mode to Settings", mark: Self.waiting))
            row(Row(name: "Builder 2 · Add a dark mode to Settings", mark: Self.working, line: "Running the test suite"))
            row(Row(name: "Reviewer · Add a dark mode to Settings", mark: Self.idle))
            TeamHeader(name: "Design crit loop", task: "Make the inbox's empty state calm, so it reads as finished rather than broken", count: 1, isCollapsed: true)
            folderHeader("field-notes")
            row(Row(name: "Release notes", mark: Self.waiting))
            row(Row(name: "Fix the export button", mark: Self.needs))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 10)
        .frame(width: 264, alignment: .leading)
        .background(ConchColor.fog)
    }

    private func folderHeader(_ name: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .rotationEffect(.degrees(90))
                .opacity(0.35)
                .frame(width: 10)
            Text(name).font(.system(size: 12, weight: .medium))
            Spacer(minLength: 4)
        }
        .foregroundStyle(ConchColor.textTertiary)
        .padding(.horizontal, 6)
        .padding(.top, 8)
        .padding(.bottom, 2)
    }

    private func row(_ row: Row) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Color.clear.frame(width: 10, height: 1)
            Image(systemName: row.mark.0)
                .font(.system(size: row.mark.1, weight: .medium))
                .foregroundStyle(row.mark.2)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                    .font(.system(size: 13))
                    .foregroundStyle(ConchColor.textPrimary)
                    .lineLimit(1)
                if let line = row.line {
                    Text(line)
                        .font(.system(size: 11))
                        .foregroundStyle(ConchColor.textSecondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, row.line == nil ? 6 : 5)
        .frame(minHeight: 30)
    }
}

@MainActor
func renderTeams() throws {
    let fixtures = TeamsGalleryFixtures.self
    try render("teams-settings", width: 820) {
        Heading(title: "Settings › Teams", note: "Two running teams (one member still starting, one that couldn't start), and three team types")
        TeamsView(store: TeamsStore(preview: fixtures.list), home: fixtures.home)
            .frame(width: 720)
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
    try render("teams-settings-empty", width: 820) {
        Heading(title: "Settings › Teams, nothing running", note: "The starter types deleted but one: Add back offers them")
        TeamsView(store: TeamsStore(preview: TeamsList(types: [fixtures.designCrit], agents: fixtures.agents, missingStarters: 2)), home: fixtures.home)
            .frame(width: 720)
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
    try render("teams-editor", width: 760) {
        Heading(title: "Edit team type", note: "Open on the builder: every field a role has")
        TeamTypeEditor(type: fixtures.buildReview, isNew: false, agents: fixtures.agents, signIns: TeamsGalleryFixtures.list.signIns,
                       expandedRole: "builder", save: { _ in nil }, done: {})
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
    var broken = fixtures.buildReview
    broken.roles[2].reportsTo = "builder"
    broken.roles[1].reportsTo = "reviewer"
    let problem = Teams.problem(in: broken, agents: fixtures.agents)
    try render("teams-editor-problem", width: 760) {
        Heading(title: "Edit team type, refused", note: "A loop that never reaches the lead: said under the role and in the footer")
        TeamTypeEditor(type: broken, isNew: false, agents: fixtures.agents, signIns: [], expandedRole: problem?.roleIndex.map { broken.roles[$0].id },
                       problem: problem, save: { _ in nil }, done: {})
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
    try render("teams-start", width: 640) {
        Heading(title: "Start a team")
        TeamStartSheet(type: fixtures.buildReview, task: "Add a dark mode to Settings, following the system appearance, with a switch to pin it.",
                       folder: "\(fixtures.home)/Projects/field-notes", chooseFolder: { nil }, start: { _, _, _ in .failed("") }, done: {})
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
    try render("teams-start-trust", width: 640) {
        Heading(title: "Start a team, folder not trusted yet")
        TeamStartSheet(type: fixtures.researchSpecBuild, task: "Find out how other apps let people export their notes, and build the best one.",
                       folder: "\(fixtures.home)/Projects/new-thing", needsTrust: ["Claude Code"],
                       chooseFolder: { nil }, start: { _, _, _ in .failed("") }, done: {})
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
    try render("teams-pass-task", width: 600) {
        Heading(title: "Pass task…")
        TeamTaskSheet(team: fixtures.running, task: "Then add the same to the onboarding screens.", send: { _ in .sent(to: "") }, done: {})
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
    try render("teams-sidebar", width: 360) {
        Heading(title: "Sidebar", note: "A team's members under its header, whatever folder each works in; a folded team; then a folder")
        TeamsGallerySidebar()
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
