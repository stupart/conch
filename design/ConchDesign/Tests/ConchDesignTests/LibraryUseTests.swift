import XCTest
@testable import ConchDesign

/// Using and managing what Settings › Skills lists (LibraryUse.swift, 2026-11-11): which open sessions have a skill and
/// what is typed there, what can be done to each copy, and the requests the reader sends.
final class LibraryUseTests: XCTestCase {
    private func location(_ agent: String, _ account: String?, _ origin: String = "user", project: String? = nil, kind: String = "skill",
                          enabled: Bool? = true, invocation: String? = "/handoff", path: String = "/s/handoff/SKILL.md") -> SkillLocationInfo {
        SkillLocationInfo(agent: agent, accountId: account, accountLabel: account?.capitalized, origin: origin, kind: kind, path: path,
                          pluginId: origin == "plugin" ? "kit@market" : nil, pluginVersion: origin == "plugin" ? "1.2.0" : nil,
                          projectPath: project, enabled: enabled, invocation: invocation)
    }

    private let sessions = [
        LibrarySession(id: "a", label: "storefront", agent: "claude", accountId: nil, folders: ["/p/storefront/web"]),
        LibrarySession(id: "b", label: "studio", agent: "claude", accountId: "work", folders: ["/p/brief"]),
        LibrarySession(id: "c", label: "api", agent: "codex", folders: ["/p/api"]),
        LibrarySession(id: "d", label: "storefront-old", agent: "claude", folders: ["/p/storefront-old"], canType: false),
    ]

    // MARK: Which sessions have it

    func testASessionLoadsACopyOfItsAgentAccountOrProject() {
        let session = sessions[0]
        XCTAssertTrue(session.loads(agent: "claude", accountId: "default", projectPath: nil), "no account is the default one")
        XCTAssertFalse(session.loads(agent: "claude", accountId: "work", projectPath: nil))
        XCTAssertFalse(session.loads(agent: "codex", accountId: nil, projectPath: nil))
        XCTAssertTrue(session.loads(agent: "claude", accountId: nil, projectPath: "/p/storefront"), "a folder under the project")
        XCTAssertTrue(session.loads(agent: "claude", accountId: nil, projectPath: "/p/storefront/"))
        XCTAssertFalse(sessions[3].loads(agent: "claude", accountId: nil, projectPath: "/p/storefront"), "a sibling isn't inside it")
        XCTAssertTrue(sessions[2].loads(agent: "codex", accountId: nil, projectPath: nil), "every account of its agent")
    }

    func testASkillIsUsedWhereAnOnCopyReachesWithThatCopysLine() {
        let skill = InstalledSkillInfo(id: "skill:own:handoff", name: "handoff", origin: "user", locations: [
            location("claude", "default"),
            location("claude", "work", enabled: false),
            location("codex", nil, invocation: "$handoff"),
        ])
        let uses = LibraryUses.skill(skill, among: sessions)
        XCTAssertEqual(uses.map(\.session.id), ["a", "c", "d"], "the work account's copy is off")
        XCTAssertEqual(uses.map(\.line), ["/handoff", "$handoff", "/handoff"])
        XCTAssertEqual(LibraryUses.names(uses), "storefront, api and storefront-old")
        XCTAssertEqual(LibraryUses.names(Array(uses.prefix(2))), "storefront and api")
        XCTAssertEqual(LibraryUses.names(uses, limit: 2), "storefront, api and 1 more")
        // Only the model may call it: asked for in words.
        let modelOnly = InstalledSkillInfo(id: "x", name: "brand-voice", origin: "user", locations: [location("claude", "default", invocation: nil)])
        XCTAssertEqual(LibraryUses.skill(modelOnly, among: sessions).first?.line, "Use the brand-voice skill.")
        // A project's copy, for the sessions working in it.
        let project = InstalledSkillInfo(id: "y", name: "deploy-check", origin: "project",
                                         locations: [location("claude", nil, "project", project: "/p/storefront", enabled: nil)])
        XCTAssertEqual(LibraryUses.skill(project, among: sessions).map(\.session.id), ["a"])
    }

    // MARK: What can be done to a copy

    func testEachCopySaysWhereItIsSwitched() {
        XCTAssertEqual(SkillManagement.of(location("claude", "default")), .toggle(isOn: true))
        XCTAssertEqual(SkillManagement.of(location("claude", "default", enabled: false)), .toggle(isOn: false))
        XCTAssertEqual(SkillManagement.of(location("claude", nil, "project", project: "/p", enabled: nil)), .toggle(isOn: true), "nothing says: on")
        XCTAssertEqual(SkillManagement.of(location("claude", "default", "plugin")), .plugin("kit"))
        XCTAssertEqual(SkillManagement.of(location("claude", "default", "claude.ai")), .claudeAI)
        XCTAssertEqual(SkillManagement.of(location("codex", nil)), .codexConfig)
        XCTAssertEqual(SkillManagement.of(location("claude", "default", kind: "command")), .command)
        XCTAssertEqual(SkillManagement.of(location("codex", nil, "system")), .fixed("Built into Codex"))
        XCTAssertEqual(SkillManagement.of(location("claude", nil, "managed")), .fixed("Set by whoever manages this Mac"))
    }

    func testOnlyThePersonsOwnFilesGoToTheTrashAndASkillGoesWhole() {
        XCTAssertTrue(SkillCopies.canTrash(location("claude", "default")))
        XCTAssertTrue(SkillCopies.canTrash(location("claude", nil, "project", project: "/p")))
        for origin in ["plugin", "claude.ai", "system", "managed", "admin"] {
            XCTAssertFalse(SkillCopies.canTrash(location("claude", "default", origin)), origin)
        }
        XCTAssertEqual(SkillCopies.trashTarget(location("claude", "default")), "/s/handoff")
        XCTAssertEqual(SkillCopies.trashTarget(location("claude", "default", kind: "command", path: "/c/commands/standup.md")), "/c/commands/standup.md")
        XCTAssertEqual(SkillCopies.kindTitle(location("claude", "default", "plugin")), "plugin kit 1.2.0")
        XCTAssertEqual(SkillCopies.kindTitle(location("claude", nil, "project", project: "/p", kind: "command")), "project command")
    }

    func testTheSwitchsRequestsCarryTheCopyAndThePreviewsHash() throws {
        func keys(_ request: SkillsLibraryRequest) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        }
        let preview = try keys(.togglePreview(location("claude", "work"), enabled: false))
        XCTAssertEqual(Set(preview.keys), ["kind", "action", "path", "agent", "accountId", "enabled"])
        XCTAssertEqual(preview["action"] as? String, "toggle-preview")
        XCTAssertEqual(preview["enabled"] as? Bool, false)
        let toggle = try keys(.toggle(location("claude", nil, "project", project: "/p"), enabled: true, planHash: "abc"))
        XCTAssertEqual(Set(toggle.keys), ["kind", "action", "path", "agent", "enabled", "planHash"], "a project's copy names no account")
    }
}
