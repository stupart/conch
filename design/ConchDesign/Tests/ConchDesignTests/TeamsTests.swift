import XCTest
@testable import ConchDesign

/// Teams (2026-11-12, Teams.swift): what the daemon's desk sends is read as it is sent, every request is written as the
/// desk takes it, and the rules the page and the editor read by (the tree, the hierarchy line, what can't be saved, ids
/// from names) hold for the cases a healthy list never shows.
@MainActor
final class TeamsTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func encoded(_ request: TeamsRequest) throws -> [String: Any] {
        let data = try JSONEncoder().encode(request)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private let buildReview = TeamType(
        id: "build-review", name: "Build + review", summary: "Split, build, review.",
        roles: [
            TeamRole(id: "lead", name: "Lead", backend: .claude, effort: "high", atStart: true),
            TeamRole(id: "builder", name: "Builder", reportsTo: "lead", backend: .claude, workspace: .worktree, maxConcurrent: 3),
            TeamRole(id: "reviewer", name: "Reviewer", reportsTo: "lead", backend: .codex),
        ],
        rules: ["Nobody merges."]
    )

    // MARK: On the wire

    func testTheListIsReadAsTheDeskSendsIt() throws {
        let list = try decode(TeamsList.self, """
        {"kind":"teams","types":[{"id":"build-review","name":"Build + review","summary":"Split, build, review.",
          "roles":[{"id":"lead","name":"Lead","backend":"claude","model":"opus","effort":"high","prompt":"Plan.","skills":[],"workspace":"shared","atStart":true},
                   {"id":"builder","name":"Builder","reportsTo":"lead","backend":"codex","prompt":"Build.","skills":["code-review"],
                    "workspace":"worktree","maxConcurrent":3,"budgetMinutes":120,"host":"background","permissions":"workspace-write"}],
          "rules":["Nobody merges."]}],
         "running":[{"id":"build-review-2","typeId":"build-review","name":"Build + review","task":"Dark mode","cwd":"/p","startedAt":1000,
          "members":[{"key":"lead-1","roleId":"lead","roleName":"Lead","label":"Lead · dark mode","sessionId":"s1","state":"running","startedAt":1000,"status":"waiting"},
                     {"key":"builder-2","roleId":"builder","roleName":"Builder","label":"Builder 2","state":"failed","error":"its tab never started its agent",
                      "startedAt":2000,"reportsTo":"lead-1","budgetMinutes":120}],
          "tasks":[{"text":"Dark mode","at":1000,"from":"you"},{"text":"Then onboarding","at":3000,"from":"you"}]}],
         "agents":{"claude":{"efforts":["low","high"],"permissions":["plan"]},"codex":{"efforts":["high"],"permissions":["read-only"]}},
         "signIns":[{"id":"a1","label":"Work"}],"missingStarters":1,"saved":"build-review","caller":{"team":"x"}}
        """)
        XCTAssertEqual(list.types.count, 1)
        let builder = list.types[0].roles[1]
        XCTAssertEqual(builder.backend, .codex)
        XCTAssertEqual(builder.workspace, .worktree)
        XCTAssertEqual(builder.host, .background)
        XCTAssertEqual(builder.limit, 3)
        XCTAssertEqual(builder.budgetMinutes, 120)
        XCTAssertEqual(builder.skills, ["code-review"])
        XCTAssertEqual(list.types[0].lead?.id, "lead")
        let team = try XCTUnwrap(list.running.first)
        XCTAssertEqual(team.currentTask, "Then onboarding", "the task it was passed last")
        XCTAssertEqual(team.lead?.key, "lead-1")
        XCTAssertEqual(team.members[0].status, "waiting")
        XCTAssertEqual(team.members[1].state, .failed)
        XCTAssertEqual(team.members[1].title, "Builder 2")
        XCTAssertEqual(team.members[0].title, "Lead", "the first of a role is its name alone")
        XCTAssertEqual(list.choices(.codex).efforts, ["high"])
        XCTAssertEqual(list.signIns, [TeamSignIn(id: "a1", label: "Work")])
        XCTAssertEqual(list.missingStarters, 1)
        XCTAssertEqual(list.saved, "build-review")
    }

    func testWhatARoleLeavesOutIsItsDefaultAndANewerStateReadsAsStarting() throws {
        let role = try decode(TeamRole.self, #"{"id":"lead","name":"Lead","backend":"claude"}"#)
        XCTAssertEqual(role.skills, [])
        XCTAssertEqual(role.workspace, .shared)
        XCTAssertEqual(role.prompt, "")
        XCTAssertNil(role.host)
        XCTAssertTrue(role.isLead)
        let member = try decode(TeamMember.self, #"{"key":"lead-1","roleId":"lead","roleName":"Lead","label":"L","state":"paused","startedAt":1}"#)
        XCTAssertEqual(member.state, .starting)
        // A published team with only what a sidebar needs.
        let team = try decode(TeamSummary.self, #"{"id":"t","name":"T","members":[]}"#)
        XCTAssertEqual(team.tasks, [])
        XCTAssertNil(team.lead)
    }

    func testEveryRequestIsWrittenAsTheDeskTakesIt() throws {
        XCTAssertEqual(try encoded(.list) as NSDictionary, ["kind": "teams"])
        XCTAssertEqual(try encoded(.delete(id: "a")) as NSDictionary, ["kind": "team-type-delete", "id": "a"])
        XCTAssertEqual(try encoded(.duplicate(id: "a")) as NSDictionary, ["kind": "team-type-duplicate", "id": "a"])
        XCTAssertEqual(try encoded(.restoreStarters) as NSDictionary, ["kind": "team-types-restore"])
        XCTAssertEqual(try encoded(.start(type: "build-review", task: "Dark mode", cwd: "/p", trustFolder: false)) as NSDictionary,
                       ["kind": "team-start", "type": "build-review", "task": "Dark mode", "cwd": "/p"])
        XCTAssertEqual(try encoded(.start(type: "build-review", task: "Dark mode", cwd: "/p", trustFolder: true)) as NSDictionary,
                       ["kind": "team-start", "type": "build-review", "task": "Dark mode", "cwd": "/p", "trustFolder": true])
        XCTAssertEqual(try encoded(.passTask(team: "build-review-2", task: "Next")) as NSDictionary,
                       ["kind": "team-task", "team": "build-review-2", "task": "Next"])
        XCTAssertEqual(try encoded(.end(team: "build-review-2")) as NSDictionary, ["kind": "team-end", "team": "build-review-2"])

        let saved = try encoded(.save(buildReview, previousId: "build-review"))
        XCTAssertEqual(saved["kind"] as? String, "team-type-save")
        XCTAssertEqual(saved["previousId"] as? String, "build-review")
        let type = try XCTUnwrap(saved["type"] as? [String: Any])
        XCTAssertEqual(type["id"] as? String, "build-review")
        let roles = try XCTUnwrap(type["roles"] as? [[String: Any]])
        // What a role leaves out is left out, never sent empty.
        XCTAssertEqual(Set(roles[2].keys), ["id", "name", "reportsTo", "backend", "prompt", "skills", "workspace"])
        XCTAssertEqual(roles[1]["maxConcurrent"] as? Int, 3)
        XCTAssertEqual(roles[1]["workspace"] as? String, "worktree")
        // A new type has no id it was saved under.
        XCTAssertNil(try encoded(.save(buildReview, previousId: nil))["previousId"])
    }

    // MARK: The store

    func testAStartSaysWhatItCameTo() async {
        var sent: [TeamsRequest] = []
        func answering(_ json: String) -> @MainActor (TeamsRequest) async throws -> Data {
            { request in sent.append(request); return Data(json.utf8) }
        }
        let trust = await TeamsStore.start(type: "t", task: " Do it ", cwd: "/p", trustFolder: false,
                                           transport: answering(#"{"kind":"team-needs-trust","cwd":"/p","agents":["Claude Code","Codex"]}"#))
        XCTAssertEqual(trust, .needsTrust(cwd: "/p", agents: ["Claude Code", "Codex"]))
        XCTAssertEqual(sent.last, .start(type: "t", task: "Do it", cwd: "/p", trustFolder: false), "the task trimmed")
        let refused = await TeamsStore.start(type: "t", task: "Do it", cwd: "/p", trustFolder: true,
                                             transport: answering(#"{"kind":"team-error","error":"no team type is called t","code":"refused"}"#))
        XCTAssertEqual(refused, .failed("no team type is called t"))
        let old = await TeamsStore.start(type: "t", task: "Do it", cwd: "/p", trustFolder: false,
                                         transport: answering(#"{"kind":"session-error","error":"unknown"}"#))
        XCTAssertEqual(old, .failed("This conch can't start teams yet: it needs an updated daemon."))
        let count = sent.count
        let empty = await TeamsStore.start(type: "t", task: "  ", cwd: "/p", trustFolder: false, transport: answering("{}"))
        XCTAssertEqual(empty, .failed("Say what the team should do."))
        XCTAssertEqual(sent.count, count, "nothing is sent without a task")
    }

    func testPassingATaskSaysWhoseItWentToOrWhyNot() async {
        let sent = await TeamsStore.passTask(team: "t-1", task: "Next", transport: { _ in Data(#"{"kind":"team-tasked","to":"Lead · dark mode","team":{"id":"t-1","name":"T","members":[]}}"#.utf8) })
        XCTAssertEqual(sent, .sent(to: "Lead · dark mode"))
        let refused = await TeamsStore.passTask(team: "t-1", task: "Next", transport: { _ in Data(#"{"kind":"team-error","error":"its lead has ended"}"#.utf8) })
        XCTAssertEqual(refused, .failed("its lead has ended"))
        let down = await TeamsStore.passTask(team: "t-1", task: "Next", transport: { _ in throw URLError(.cannotConnectToHost) })
        XCTAssertEqual(down, .failed("conch's daemon didn't answer. Try again."))
    }

    func testASaveIsCheckedHereFirstAndTheDesksRefusalIsKeptWithItsField() async {
        var sent = 0
        let store = TeamsStore { _ in
            sent += 1
            return Data(#"{"kind":"team-error","error":"a role's sign-in isn't one conch has","field":"roles.0.signIn","code":"invalid"}"#.utf8)
        }
        var broken = buildReview
        broken.roles[1].reportsTo = nil
        let local = await store.save(broken, previousId: "build-review")
        XCTAssertEqual(local?.field, "roles.1.reportsTo")
        XCTAssertEqual(sent, 0, "refused here, nothing sent")
        let remote = await store.save(buildReview, previousId: "build-review")
        XCTAssertEqual(remote, Teams.Problem(field: "roles.0.signIn", message: "a role's sign-in isn't one conch has"))
        XCTAssertEqual(remote?.roleIndex, 0)
        XCTAssertEqual(store.problems["build-review"], "a role's sign-in isn't one conch has")
    }

    // MARK: The hierarchy

    func testTheTreeIsTheHierarchyInOrderWithItsDepth() {
        let roles = [
            TeamRole(id: "builder", name: "Builder", reportsTo: "spec"),
            TeamRole(id: "lead", name: "Lead"),
            TeamRole(id: "researcher", name: "Researcher", reportsTo: "lead"),
            TeamRole(id: "spec", name: "Spec writer", reportsTo: "lead"),
        ]
        let tree = Teams.tree(roles)
        XCTAssertEqual(tree.map(\.role.id), ["lead", "researcher", "spec", "builder"])
        XCTAssertEqual(tree.map(\.depth), [0, 1, 1, 2])
    }

    /// A loop or a missing boss never hangs the editor or hides a role: each comes at the end, at the top, so its problem
    /// can be seen and fixed.
    func testALoopOrAMissingBossIsStillShownAtTheEnd() {
        let roles = [
            TeamRole(id: "lead", name: "Lead"),
            TeamRole(id: "a", name: "A", reportsTo: "b"),
            TeamRole(id: "b", name: "B", reportsTo: "a"),
            TeamRole(id: "c", name: "C", reportsTo: "gone"),
            TeamRole(id: "self", name: "Self", reportsTo: "self"),
        ]
        let tree = Teams.tree(roles)
        XCTAssertEqual(Set(tree.map(\.role.id)), Set(roles.map(\.id)))
        XCTAssertEqual(tree.count, roles.count, "each role once")
        XCTAssertEqual(tree.first?.role.id, "lead")
        XCTAssertEqual(tree[1].role.id, "c", "an orphan before the loops")
        XCTAssertEqual(tree.first(where: { $0.role.id == "a" })?.depth, 0)
        XCTAssertEqual(tree.first(where: { $0.role.id == "b" })?.depth, 1)
    }

    func testTheHierarchyLineReadsAsATeam() {
        XCTAssertEqual(Teams.hierarchyLine(buildReview), "Lead → Builder ×3, Reviewer")
        let deeper = [
            TeamRole(id: "lead", name: "Lead"),
            TeamRole(id: "spec", name: "Spec writer", reportsTo: "lead"),
            TeamRole(id: "builder", name: "Builder", reportsTo: "spec", maxConcurrent: 2),
            TeamRole(id: "researcher", name: "Researcher", reportsTo: "lead"),
        ]
        XCTAssertEqual(Teams.hierarchyLine(deeper), "Lead → Spec writer (Builder ×2), Researcher")
        XCTAssertEqual(Teams.hierarchyLine([TeamRole(id: "solo", name: "Solo")]), "Solo")
        // A loop can't hang it, and its roles still count.
        let looped = [TeamRole(id: "lead", name: "Lead"), TeamRole(id: "a", name: "A", reportsTo: "b"), TeamRole(id: "b", name: "B", reportsTo: "a")]
        XCTAssertEqual(Teams.hierarchyLine(looped), "Lead → A, B")
    }

    func testARolesDetailSaysWhatItRunsAs() {
        XCTAssertEqual(Teams.roleDetail(buildReview.roles[0]), "Claude · high")
        XCTAssertEqual(Teams.roleDetail(buildReview.roles[1]), "Claude · own worktree · on request")
        var reviewer = buildReview.roles[2]
        reviewer.host = .background
        reviewer.atStart = true
        reviewer.budgetMinutes = 90
        reviewer.signIn = "Work"
        XCTAssertEqual(Teams.roleDetail(reviewer), "Codex · background · 1 h 30 min budget", "a sign-in is only Claude's")
        XCTAssertEqual(Teams.rulesCount(0), "No rules")
        XCTAssertEqual(Teams.rulesCount(1), "1 rule")
        XCTAssertEqual(Teams.rulesCount(4), "4 rules")
    }

    // MARK: Editing

    func testWhatCantBeSavedIsNamedByItsField() {
        XCTAssertNil(Teams.problem(in: buildReview))
        func problem(_ change: (inout TeamType) -> Void) -> String? {
            var type = buildReview
            change(&type)
            return Teams.problem(in: type, agents: ["claude": TeamAgentChoices(efforts: ["low", "high"], permissions: ["plan"])])?.field
        }
        XCTAssertEqual(problem { $0.name = "  " }, "name")
        XCTAssertEqual(problem { $0.roles = [] }, "roles")
        XCTAssertEqual(problem { $0.roles[0].reportsTo = "builder"; $0.roles[1].reportsTo = "reviewer"; $0.roles[2].reportsTo = "builder" }, "roles")
        XCTAssertEqual(problem { $0.roles[2].reportsTo = nil }, "roles.2.reportsTo", "a second lead")
        XCTAssertEqual(problem { $0.roles[1].reportsTo = "gone" }, "roles.1.reportsTo")
        XCTAssertEqual(problem { $0.roles[1].reportsTo = "builder" }, "roles.1.reportsTo")
        XCTAssertEqual(problem { $0.roles[1].reportsTo = "reviewer"; $0.roles[2].reportsTo = "builder" }, "roles.1.reportsTo", "a loop")
        XCTAssertEqual(problem { $0.roles[2].id = "builder" }, "roles.2.name", "two roles can't share an id")
        XCTAssertEqual(problem { $0.roles[1].id = "Builder!" }, "roles.1.id")
        XCTAssertEqual(problem { $0.roles[1].effort = "extreme" }, "roles.1.effort")
        XCTAssertEqual(problem { $0.roles[1].permissions = "everything" }, "roles.1.permissions")
        XCTAssertEqual(problem { $0.roles[2].signIn = "Work" }, "roles.2.signIn")
        XCTAssertEqual(problem { $0.roles[1].maxConcurrent = 9 }, "roles.1.maxConcurrent")
        XCTAssertEqual(problem { $0.roles[1].budgetMinutes = 2 }, "roles.1.budgetMinutes")
        XCTAssertEqual(problem { $0.roles[1].prompt = String(repeating: "x", count: 4_001) }, "roles.1.prompt")
        XCTAssertEqual(problem { $0.rules.append(String(repeating: "x", count: 501)) }, "rules.1")
        XCTAssertEqual(problem { $0.rules = Array(repeating: "r", count: 13) }, "rules")
        // Codex's choices aren't known here, so its effort isn't judged.
        XCTAssertNil(problem { $0.roles[2].effort = "anything" })
    }

    func testASavedTypeLeavesOutWhatIsEmptyAndTheLeadAlwaysStarts() {
        var type = buildReview
        type.name = "  Build + review "
        type.rules = [" Nobody merges. ", "  "]
        type.roles[0].atStart = false
        type.roles[1].model = "  "
        type.roles[1].skills = [" a ", ""]
        type.roles[1].host = .terminal
        type.roles[2].signIn = "Work"
        type.roles[2].maxConcurrent = 1
        let cleaned = Teams.cleaned(type)
        XCTAssertEqual(cleaned.name, "Build + review")
        XCTAssertEqual(cleaned.rules, ["Nobody merges."])
        XCTAssertEqual(cleaned.roles[0].atStart, true)
        XCTAssertNil(cleaned.roles[1].model)
        XCTAssertEqual(cleaned.roles[1].skills, ["a"])
        XCTAssertNil(cleaned.roles[1].host, "a Terminal window is the default, left out")
        XCTAssertNil(cleaned.roles[2].signIn, "Codex has no Claude sign-in")
        XCTAssertNil(cleaned.roles[2].maxConcurrent)
    }

    func testIdsComeFromNamesAndNeverCollide() {
        XCTAssertEqual(Teams.slug("Build + review", max: 40, fallback: "team"), "build-review")
        XCTAssertEqual(Teams.slug("Research → spec → build", max: 40), "research-spec-build")
        XCTAssertEqual(Teams.slug("  "), "role")
        XCTAssertEqual(Teams.slug(String(repeating: "abc ", count: 20)).count, 31, "cut at 32 without a trailing dash")
        XCTAssertEqual(Teams.uniqueSlug("builder", taken: ["builder", "builder-2"]), "builder-3")
        XCTAssertTrue(Teams.isSlug("builder-2", max: 32))
        XCTAssertFalse(Teams.isSlug("-builder", max: 32))
        XCTAssertFalse(Teams.isSlug("Builder", max: 32))

        let role = Teams.newRole(in: buildReview)
        XCTAssertEqual(role.reportsTo, "lead")
        XCTAssertEqual(role.backend, .claude)
        XCTAssertEqual(role.workspace, .shared)
        XCTAssertEqual(role.limit, 1)
        XCTAssertNil(role.atStart, "a new member starts when the lead asks")
        var withMember = buildReview
        withMember.roles.append(role)
        XCTAssertEqual(Teams.newRole(in: withMember).name, "Member 2")

        let fresh = Teams.newType(existing: [buildReview, TeamType(id: "new-team", name: "New team", roles: [])])
        XCTAssertEqual(fresh.name, "New team 2")
        XCTAssertEqual(fresh.id, "new-team-2")
        XCTAssertEqual(fresh.roles.map(\.id), ["lead"])
        XCTAssertNil(Teams.problem(in: Teams.cleaned(fresh)))
    }

    /// A role new to the daemon takes its id from its name, and what reports to it follows; a saved one keeps its id, so a
    /// running team's members still point at it.
    func testRenamingARoleMovesItsIdOnlyWhileItIsNew() {
        let renamed = Teams.renaming(buildReview.roles, at: 1, to: "Maker", followsName: true)
        XCTAssertEqual(renamed[1].id, "maker")
        let kept = Teams.renaming(buildReview.roles, at: 1, to: "Maker", followsName: false)
        XCTAssertEqual(kept[1].id, "builder")
        XCTAssertEqual(kept[1].name, "Maker")
        var roles = buildReview.roles
        roles.append(TeamRole(id: "helper", name: "Helper", reportsTo: "builder"))
        XCTAssertEqual(Teams.renaming(roles, at: 1, to: "Maker", followsName: true)[3].reportsTo, "maker")
        // Removed, its reports report to its own boss.
        XCTAssertEqual(Teams.removing(roles, at: 1).map(\.reportsTo), [nil, "lead", "lead"])
    }

    func testSkillsAreOneFieldOfNames() {
        XCTAssertEqual(Teams.skills(from: "code-review, simplify,, \nsecurity-review "), ["code-review", "simplify", "security-review"])
        XCTAssertEqual(Teams.skillsText(["a", "b"]), "a, b")
    }

    // MARK: Running teams

    func testARunningTeamIsSaidInWords() {
        let now = Date(timeIntervalSince1970: 10_000)
        let ms = now.timeIntervalSince1970 * 1_000
        let team = TeamSummary(id: "t", typeId: "x", name: "T", task: "Do it", cwd: "/Users/alex/Projects/app", startedAt: ms - 12 * 60_000, members: [
            TeamMember(key: "lead-1", roleId: "lead", roleName: "Lead", label: "L", sessionId: "s1", state: .running, startedAt: ms - 12 * 60_000, status: "needs"),
            TeamMember(key: "builder-1", roleId: "builder", roleName: "Builder", label: "B", state: .starting, startedAt: ms),
            TeamMember(key: "builder-2", roleId: "builder", roleName: "Builder", label: "B2", state: .failed, error: "it exited", startedAt: ms),
            TeamMember(key: "reviewer-1", roleId: "reviewer", roleName: "Reviewer", label: "R", state: .ended, startedAt: ms),
        ])
        XCTAssertEqual(Teams.runningLine(team, now: now, home: "/Users/alex"), "2 members, 1 couldn't start · started 12m ago · in ~/Projects/app")
        XCTAssertEqual(Teams.memberLine(team.members[0], now: now), "Needs you · 12m")
        XCTAssertEqual(Teams.memberLine(team.members[1], now: now), "Starting…")
        XCTAssertEqual(Teams.memberLine(team.members[2], now: now), "Couldn't start: it exited")
        XCTAssertEqual(Teams.memberLine(team.members[3], now: now), "Ended")
        XCTAssertEqual(Teams.stateColor(team.members[0]).name, ConchColor.attention.name)
        XCTAssertEqual(Teams.agentList(["Claude Code"]), "Claude Code")
        XCTAssertEqual(Teams.agentList(["Claude Code", "Codex"]), "Claude Code and Codex")
        XCTAssertEqual(Teams.tilde("/Users/alex", home: "/Users/alex"), "~")
        XCTAssertEqual(Teams.tilde("/Users/alexa/x", home: "/Users/alex"), "/Users/alexa/x")

        // The sidebar groups the members that have a session, lead first, on the task it is on now; an ended team isn't one.
        let ended = TeamSummary(id: "e", typeId: "x", name: "E", task: "", cwd: "", startedAt: 0, endedAt: 1, members: [])
        let passed = TeamSummary(id: "t", typeId: "x", name: "T", task: "Do it", cwd: "", startedAt: 0, members: team.members,
                                 tasks: [TeamTaskEntry(text: "Do it", at: 0, from: "you"), TeamTaskEntry(text: "Then this", at: 1, from: "you")])
        XCTAssertEqual(Teams.sidebarTeams([passed, ended]), [SessionGrouping.Team(id: "t", name: "T", task: "Then this", memberSessionIDs: ["s1"])])
    }
}
