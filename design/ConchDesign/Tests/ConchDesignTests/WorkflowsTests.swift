import XCTest
@testable import ConchDesign

/// Settings › Workflows' rules (Workflows.swift, 2026-11-11): the daemon's reply, which open sessions a saved workflow can
/// be started in and with what line, how the list groups and names them, and how a run's progress is said.
final class WorkflowsTests: XCTestCase {
    private let sessions = [
        LibrarySession(id: "a", label: "storefront", agent: "claude", accountId: nil, folders: ["/p/storefront/web"]),
        LibrarySession(id: "b", label: "studio", agent: "claude", accountId: "work", folders: ["/p/brief"]),
        LibrarySession(id: "c", label: "api", agent: "codex", folders: ["/p/api"]),
        LibrarySession(id: "d", label: "storefront-old", agent: "claude", folders: ["/p/storefront-old"], canType: false),
    ]

    func testAWorkflowIsUsedInTheClaudeSessionsItReachesUnlessClaudeCodeSkipsIt() {
        let flaky = WorkflowInfo(id: "own:f", name: "find-flaky-tests", origin: "user", locations: [
            WorkflowLocationInfo(accountId: "default", accountLabel: "Personal", origin: "user", path: "/c/workflows/f.js", invocation: "/find-flaky-tests"),
        ])
        XCTAssertEqual(LibraryUses.workflow(flaky, among: sessions).map(\.session.id), ["a", "d"])
        XCTAssertEqual(LibraryUses.workflow(flaky, among: sessions).first?.line, "/find-flaky-tests")
        let skipped = WorkflowInfo(id: "own:t", name: "triage", origin: "user", locations: flaky.locations, problem: "Claude Code reads only .js workflows, so it skips this one.")
        XCTAssertEqual(LibraryUses.workflow(skipped, among: sessions), [])
        let off = WorkflowInfo(id: "plugin:k:a", name: "kit:audit", origin: "plugin", locations: [
            WorkflowLocationInfo(accountId: "default", origin: "plugin", path: "/k/workflows/audit.js", pluginId: "kit@market", enabled: false, invocation: "/kit:audit"),
        ])
        XCTAssertEqual(LibraryUses.workflow(off, among: sessions), [], "off with its plugin")
    }

    func testTheRequestForWorkflowsCarriesOnlyItsPage() throws {
        func keys(_ request: SkillsLibraryRequest) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        }
        XCTAssertEqual(Set(try keys(.workflows()).keys), ["kind", "action"])
        XCTAssertEqual(try keys(.workflows(offset: 40))["offset"] as? Int, 40)
        XCTAssertEqual(try keys(.workflows(refresh: true))["refresh"] as? Bool, true)
    }

    private let page = Data("""
    {"kind":"skills-library","action":"workflows","total":2,"readAt":1,"problems":[],
     "accounts":[{"id":"default","label":"Personal","configDir":"/c","feature":"default","workflows":1},
                 {"id":"work","label":"Studio","configDir":"/w","feature":"off","workflows":0}],
     "workflows":[
       {"id":"own:find-flaky-tests","name":"find-flaky-tests","description":"Finds flaky tests","whenToUse":"When CI flaps",
        "phases":[{"title":"Scan","detail":"read CI logs"},{"title":"Fix"}],"origin":"user","versions":1,
        "locations":[{"agent":"claude","accountId":"default","accountLabel":"Personal","origin":"user","path":"/c/workflows/f.js","enabled":true,"invocation":"/find-flaky-tests","digest":"abc"}]},
       {"id":"own:release-check","name":"release-check","phases":[],"origin":"project","versions":1,
        "locations":[{"agent":"claude","origin":"project","path":"/p/app/.claude/workflows/r.js","projectPath":"/p/app","enabled":null,"invocation":"/release-check","digest":"d"}]}],
     "runs":[{"runId":"wf_1","sessionId":"s","sessionLabel":"app","name":"release-check","status":"running",
              "phases":[{"title":"Review","started":4,"done":4},{"title":"Verify","started":6,"done":2},{"title":"Notes","started":0,"done":0}],
              "currentPhase":"Verify","agents":{"started":10,"done":6},"startedAt":1000,"updatedAt":2000}]}
    """.utf8)

    func testTheDaemonsWorkflowsReplyDecodes() throws {
        let decoded = try JSONDecoder().decode(WorkflowsPage.self, from: page)
        XCTAssertEqual(decoded.workflows.map(\.name), ["find-flaky-tests", "release-check"])
        XCTAssertEqual(decoded.workflows[0].phases, [WorkflowPhaseInfo(title: "Scan", detail: "read CI logs"), WorkflowPhaseInfo(title: "Fix")])
        XCTAssertNil(decoded.workflows[1].locations[0].enabled)
        XCTAssertEqual(decoded.runs.first?.currentPhase, "Verify")
        XCTAssertEqual(WorkflowsLibrary.featureOffLine(decoded.accounts),
                       "Workflows are off for Studio in Claude Code's settings, so its sessions don't offer them. Turn them on with /config in a session.")
        XCTAssertNil(WorkflowsLibrary.featureOffLine([decoded.accounts[0]]))
    }

    func testWorkflowsAreGroupedFilteredAndNamedLikeSkills() throws {
        let workflows = try JSONDecoder().decode(WorkflowsPage.self, from: page).workflows
        XCTAssertEqual(WorkflowsLibrary.groups(workflows).map(\.title), ["Yours", "In your projects"])
        XCTAssertEqual(WorkflowsLibrary.filter(workflows, query: "flaky scan").map(\.name), ["find-flaky-tests"], "a phase's title counts")
        XCTAssertEqual(WorkflowsLibrary.filter(workflows, query: "").count, 2)
        XCTAssertEqual(WorkflowsLibrary.detail(workflows[0]), "/find-flaky-tests · 2 phases")
        XCTAssertEqual(WorkflowsLibrary.chips(workflows[1]).map(\.title), ["Claude · p/app"])
        XCTAssertEqual(WorkflowsLibrary.chips(workflows[0]).map(\.title), ["Claude · Personal"])
    }

    func testARunsProgressIsSaidPlainly() throws {
        let run = try XCTUnwrap(JSONDecoder().decode(WorkflowsPage.self, from: page).runs.first)
        XCTAssertEqual(WorkflowsLibrary.runState(run), "Running · Verify")
        XCTAssertEqual(WorkflowsLibrary.agentsLine(run.agents, running: true), "6 of 10 agents done")
        // A third of the way per phase: Review done, Verify a third through, Notes not started.
        XCTAssertEqual(try XCTUnwrap(WorkflowsLibrary.fraction(run)), (1 + 2.0 / 6) / 3, accuracy: 0.0001)
        XCTAssertEqual(WorkflowsLibrary.phaseAgents(run.phases[0], running: true), "4 agents")
        XCTAssertEqual(WorkflowsLibrary.phaseAgents(run.phases[1], running: true), "2 of 6 agents")
        XCTAssertEqual(WorkflowsLibrary.phaseAgents(run.phases[2], running: true), "not started")
        let now = Date(timeIntervalSince1970: 1 + 7 * 60)
        XCTAssertEqual(WorkflowsLibrary.runDetail(run, now: now), "app · 6 of 10 agents done · started 7 min ago")
        XCTAssertEqual(WorkflowsLibrary.runDetail(run, now: now, session: false), "6 of 10 agents done · started 7 min ago")
        let ended = WorkflowRunInfo(runId: "wf_2", sessionId: "s", sessionLabel: "docs", name: "f", status: "completed",
                                    agents: .init(started: 8, done: 8), updatedAt: 0, durationMs: 33 * 60_000)
        XCTAssertEqual(WorkflowsLibrary.runState(ended), "Completed")
        XCTAssertEqual(WorkflowsLibrary.fraction(ended), 1)
        XCTAssertEqual(WorkflowsLibrary.runDetail(ended, now: Date(timeIntervalSince1970: 2 * 3_600)), "docs · 8 agents · 33 min · 2 h ago")
        XCTAssertEqual(WorkflowsLibrary.duration(4_500_000), "1 h 15 min")
        XCTAssertEqual(WorkflowsLibrary.duration(40_000), "40 s")
        XCTAssertNil(WorkflowsLibrary.fraction(WorkflowRunInfo(runId: "w", sessionId: "s", sessionLabel: "s", name: "n", status: "running", updatedAt: 0)))
    }
}
