import ConchDesign
import SwiftUI

/// Settings › Workflows as the Mac lays it out, list beside reader, light and dark (2026-11-11): saved workflows, yours,
/// a project's and a plugin's, one Claude Code skips, the feature off for an account, and runs going and finished. Made
/// up, as Skills' are (LibraryGallery.swift, whose helpers draw the page).
func renderWorkflowsLibrary() throws {
    let now = Date()
    let ms = now.timeIntervalSince1970 * 1_000
    let minute = 60_000.0

    let flaky = WorkflowInfo(
        id: "own:find-flaky-tests", name: "find-flaky-tests", description: "Finds the tests that fail only sometimes, and proposes a fix for each.",
        whenToUse: "When CI has gone red and green on the same commit.",
        phases: [WorkflowPhaseInfo(title: "Scan", detail: "read the last week of CI logs for retries"),
                 WorkflowPhaseInfo(title: "Reproduce", detail: "one agent per suspect, each in its own worktree"),
                 WorkflowPhaseInfo(title: "Fix", detail: "a patch and a reason per confirmed test")],
        origin: "user",
        locations: [WorkflowLocationInfo(accountId: "default", accountLabel: "Personal", origin: "user",
                                         path: "/Users/alex/.claude/workflows/find-flaky-tests.js", invocation: "/find-flaky-tests")])
    let release = WorkflowInfo(
        id: "own:release-check", name: "release-check", description: "Reviews everything since the last tag from four angles before a release.",
        phases: [WorkflowPhaseInfo(title: "Review"), WorkflowPhaseInfo(title: "Verify"), WorkflowPhaseInfo(title: "Notes")],
        origin: "project",
        locations: [WorkflowLocationInfo(origin: "project", path: "/Users/alex/Projects/storefront/.claude/workflows/release-check.js",
                                         projectPath: "/Users/alex/Projects/storefront", enabled: nil, invocation: "/release-check")])
    let audit = WorkflowInfo(
        id: "plugin:design:audit", name: "design:audit", description: "Audits every screen against the design system, one agent per screen.",
        phases: [WorkflowPhaseInfo(title: "Collect"), WorkflowPhaseInfo(title: "Audit")], origin: "plugin", plugin: "design",
        locations: [WorkflowLocationInfo(accountId: "default", accountLabel: "Personal", origin: "plugin",
                                         path: "/Users/alex/.claude/plugins/cache/market/design/2.1.0/workflows/audit.js", pluginId: "design@market",
                                         enabled: true, invocation: "/design:audit")])
    let draft = WorkflowInfo(
        id: "own:triage", name: "triage", origin: "user",
        locations: [WorkflowLocationInfo(accountId: "default", accountLabel: "Personal", origin: "user",
                                         path: "/Users/alex/.claude/workflows/triage.ts", invocation: "/triage")],
        problem: "Claude Code reads only .js workflows, so it skips this one.")
    let running = WorkflowRunInfo(
        runId: "wf_1", sessionId: "s1", sessionLabel: "storefront checkout", name: "release-check", status: "running",
        phases: [WorkflowRunPhaseInfo(title: "Review", detail: "correctness, security, performance, docs", started: 4, done: 4),
                 WorkflowRunPhaseInfo(title: "Verify", detail: "three skeptics per finding", started: 6, done: 2),
                 WorkflowRunPhaseInfo(title: "Notes")],
        currentPhase: "Verify", agents: .init(started: 10, done: 6), startedAt: ms - 7 * minute, updatedAt: ms - 0.2 * minute)
    let done = WorkflowRunInfo(
        runId: "wf_2", sessionId: "s2", sessionLabel: "docs refresh", name: "find-flaky-tests", status: "completed",
        phases: [WorkflowRunPhaseInfo(title: "Scan", started: 1, done: 1), WorkflowRunPhaseInfo(title: "Reproduce", started: 5, done: 5),
                 WorkflowRunPhaseInfo(title: "Fix", started: 2, done: 2)],
        agents: .init(started: 8, done: 8), startedAt: ms - 95 * minute, updatedAt: ms - 62 * minute, durationMs: 33 * minute,
        summary: "Two tests were flaky: a timer that raced the clock, and a fixture shared between files. Both are fixed on fix/flaky-tests.")

    func list(selected: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Runs · 2").font(.system(size: 12, weight: .semibold)).foregroundStyle(ConchColor.textSecondary)
            OnboardingCard {
                WorkflowRunRow(run: running, now: now, isSelected: selected == running.id) {}
                Rectangle().fill(ConchColor.hairline).frame(height: 1)
                WorkflowRunRow(run: done, now: now, isSelected: selected == done.id) {}
            }
            Text("Yours · 2").font(.system(size: 12, weight: .semibold)).foregroundStyle(ConchColor.textSecondary)
            OnboardingCard {
                WorkflowRow(workflow: flaky, isSelected: selected == flaky.id) {}
                Rectangle().fill(ConchColor.hairline).frame(height: 1)
                WorkflowRow(workflow: draft, isSelected: selected == draft.id) {}
            }
            Text("In your projects · 1").font(.system(size: 12, weight: .semibold)).foregroundStyle(ConchColor.textSecondary)
            OnboardingCard { WorkflowRow(workflow: release, isSelected: selected == release.id) {} }
            Text("From plugins · 1").font(.system(size: 12, weight: .semibold)).foregroundStyle(ConchColor.textSecondary)
            OnboardingCard { WorkflowRow(workflow: audit, isSelected: selected == audit.id) {} }
        }
        .padding(18)
        .frame(width: 340, alignment: .topLeading)
    }

    let script = ["find-flaky-tests.js", "export const meta = {", "  name: 'find-flaky-tests',", "  phases: [{ title: 'Scan' }, …],", "}", "phase('Scan')"]

    try render("library-workflows", width: 1040) {
        Heading(title: "Settings › Workflows", note: "Claude Code's saved multi-agent scripts, yours, your projects' and your plugins', each typed as /name in a session. Runs in open sessions lead the list.")
        Caption("A saved workflow: when to use it, its phases, and Run in / Type into the open Claude sessions that have it")
        libraryPage(list: { list(selected: flaky.id) }) {
            libraryBar("find-flaky-tests", "Claude · Personal · /find-flaky-tests · ~/.claude/workflows/find-flaky-tests.js")
            WorkflowDetailPanel(workflow: flaky, uses: LibraryUses.workflow(flaky, among: librarySessions), actions: .none)
            Rectangle().fill(ConchColor.hairline).frame(height: 1)
            libraryFile(script)
        }
        Caption("One Claude Code skips, saying why; and the feature off for an account")
        libraryPage(list: { list(selected: draft.id) }) {
            libraryBar("triage", "Claude · Personal · ~/.claude/workflows/triage.ts")
            WorkflowDetailPanel(workflow: draft, uses: [], featureOff: WorkflowsLibrary.featureOffLine([WorkflowAccountInfo(id: "work", label: "Studio", feature: "off")]),
                                actions: .none)
        }
    }

    try render("library-workflow-runs", width: 1040) {
        Heading(title: "Settings › Workflows: a run", note: "Each phase with its agents, the one it is in, and the way to the session, whose conversation has every agent's work.")
        Caption("Running")
        libraryPage(list: { list(selected: running.id) }) {
            libraryBar("release-check", "Running in storefront checkout")
            WorkflowRunPanel(run: running, now: now) {}
        }
        Caption("Finished an hour ago")
        libraryPage(list: { list(selected: done.id) }) {
            libraryBar("find-flaky-tests", "Ran in docs refresh")
            WorkflowRunPanel(run: done, now: now) {}
        }
    }
}
