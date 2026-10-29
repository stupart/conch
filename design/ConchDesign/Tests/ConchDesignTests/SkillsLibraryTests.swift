import XCTest
@testable import ConchDesign

/// The skills library's shared rules (SkillsLibrary.swift): what a request carries, how a skill's places are named and
/// folded, how the lists filter and group, and when the section takes one pane at a time.
final class SkillsLibraryTests: XCTestCase {
    private func location(_ agent: String, _ account: String?, _ origin: String = "user", enabled: Bool? = true,
                          project: String? = nil, path: String = "/x/SKILL.md") -> SkillLocationInfo {
        SkillLocationInfo(agent: agent, accountId: account.map { $0.lowercased() }, accountLabel: account, origin: origin,
                          path: path, projectPath: project, enabled: enabled)
    }

    // MARK: The wire

    /// The daemon refuses a key an action doesn't take, so nothing unset is sent.
    func testARequestCarriesOnlyWhatItsActionTakes() throws {
        func keys(_ request: SkillsLibraryRequest) throws -> [String] {
            let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: Any]
            return object.keys.sorted()
        }
        XCTAssertEqual(try keys(.installed()), ["action", "kind"])
        XCTAssertEqual(try keys(.installed(offset: 40, refresh: true)), ["action", "kind", "offset", "refresh"])
        XCTAssertEqual(try keys(.discover(query: "  ")), ["action", "kind"], "blank words are no search")
        XCTAssertEqual(try keys(.discover(query: "pdf", index: "skills-sh")), ["action", "index", "kind", "query"])
        XCTAssertEqual(try keys(.add("a:b", agent: "codex", accountId: "default", planHash: "f")), ["accountId", "action", "agent", "entryId", "kind", "planHash"])
        let installed = location("claude", "Work", path: "/w/SKILL.md")
        XCTAssertEqual(SkillsLibraryRequest.trial(location: installed, accountId: "other").accountId, "work",
                       "a copy in an account is tried in that account")
        XCTAssertEqual(SkillsLibraryRequest.trial(location: location("codex", nil, "project", project: "/p"), accountId: "default").accountId,
                       "default", "a project's copy, in the account picked")
        XCTAssertEqual(BenchmarksRequestInfo(offset: 0).offset, nil)
    }

    func testAPageOfTheInventoryDecodes() throws {
        let json = """
        {"kind":"skills-library","action":"installed","total":1,"problems":[],"readAt":1,
         "accounts":[{"agent":"claude","id":"default","label":"Default","configDir":"/c","skills":1}],
         "skills":[{"id":"skill:own:pdf","name":"pdf","origin":"user","kind":"skill","versions":1,
           "locations":[{"agent":"claude","accountId":"default","accountLabel":"Default","origin":"user","kind":"skill",
             "path":"/c/skills/pdf/SKILL.md","enabled":null,"invocation":"/pdf","digest":"abc"}]}]}
        """
        let page = try JSONDecoder().decode(SkillsInstalledPage.self, from: Data(json.utf8))
        XCTAssertNil(page.next)
        XCTAssertNil(page.skills[0].locations[0].enabled, "nothing says, rather than on")
        XCTAssertEqual(page.skills[0].locations[0].folder, "/c/skills/pdf")
        XCTAssertEqual(page.skills[0].locations[0].file, "SKILL.md")
    }

    // MARK: Installed

    func testWhereACopyLivesIsItsAgentAndAccountOrItsProject() {
        XCTAssertEqual(SkillsLibrary.locationTitle(location("claude", "Blueprint")), "Claude · Blueprint")
        XCTAssertEqual(SkillsLibrary.locationTitle(location("codex", nil, "project", project: "/Users/t/Projects/storefront")), "Codex · Projects/storefront")
        XCTAssertEqual(SkillsLibrary.locationTitle(location("codex", nil)), "Codex · every account")
    }

    /// A plugin installed for two scopes of one account is one chip; it's off only where every copy is.
    func testAChipAPlaceOffOnlyWhenEveryCopyThereIs() {
        let skill = InstalledSkillInfo(id: "skill:plugin:kit:a", name: "a", origin: "plugin", plugin: "kit", locations: [
            location("claude", "Default", "plugin", enabled: false, path: "/1"),
            location("claude", "Default", "plugin", enabled: true, path: "/2"),
            location("claude", "Work", "plugin", enabled: false, path: "/3"),
        ])
        XCTAssertEqual(SkillsLibrary.chips(skill), [
            .init(title: "Claude · Default", isOff: false),
            .init(title: "Claude · Work", isOff: true),
        ])
        XCTAssertEqual(SkillsLibrary.primaryLocation(skill)?.path, "/2", "the reader opens the copy that's on")
    }

    func testAFilterNeedsEveryWordAndACopyInScope() {
        let skills = [
            InstalledSkillInfo(id: "1", name: "pdf-tools", description: "Merge PDF files", origin: "user", locations: [location("claude", "Default")]),
            InstalledSkillInfo(id: "2", name: "figma-use", origin: "plugin", plugin: "figma", locations: [location("claude", "Work", "plugin")]),
            InstalledSkillInfo(id: "3", name: "deploy", origin: "project", locations: [location("codex", nil, "project", project: "/p")]),
            InstalledSkillInfo(id: "4", name: "shared", origin: "user", locations: [location("codex", nil)]),
        ]
        XCTAssertEqual(SkillsLibrary.filter(skills, query: "merge pdf", scope: .all).map(\.id), ["1"])
        XCTAssertEqual(SkillsLibrary.filter(skills, query: "FIGMA", scope: .all).map(\.id), ["2"], "a plugin's name finds its skills")
        XCTAssertEqual(SkillsLibrary.filter(skills, query: "", scope: .account(agent: "claude", id: "work")).map(\.id), ["2"])
        XCTAssertEqual(SkillsLibrary.filter(skills, query: "", scope: .account(agent: "codex", id: "default")).map(\.id), ["4"],
                       "every Codex account's shared skills are each one's; a project's are not")
        XCTAssertEqual(SkillsLibrary.filter(skills, query: "", scope: .projects).map(\.id), ["3"])
        XCTAssertEqual(SkillsLibrary.scopes(accounts: [LibraryAccountInfo(agent: "claude", id: "default", label: "Default")], skills: skills).map(\.title),
                       ["All accounts", "Claude · Default", "Projects"])
    }

    func testTheGroupsAreYoursFirstAndAPluginsSkillsSitTogether() {
        let skills = [
            InstalledSkillInfo(id: "a", name: "zeta", origin: "plugin", plugin: "beta", locations: [location("claude", "Default", "plugin")]),
            InstalledSkillInfo(id: "b", name: "alpha", origin: "plugin", plugin: "beta", locations: [location("claude", "Default", "plugin")]),
            InstalledSkillInfo(id: "c", name: "mine", origin: "user", locations: [location("claude", "Default")]),
            InstalledSkillInfo(id: "d", name: "omega", origin: "plugin", plugin: "alpha", locations: [location("claude", "Default", "plugin")]),
            InstalledSkillInfo(id: "e", name: "rules", origin: "admin", locations: [location("codex", nil, "admin")]),
        ]
        let groups = SkillsLibrary.groups(skills)
        XCTAssertEqual(groups.map(\.title), ["Yours", "From plugins", "Managed by an administrator"])
        XCTAssertEqual(groups[1].skills.map(\.id), ["d", "b", "a"])
    }

    // MARK: Benchmarks

    func testBenchmarksSearchFilterAndGroupByKindAggregatorsFirst() {
        func index(_ id: String, _ kind: String, _ domains: [String], take: String = "") -> BenchmarkIndexInfo {
            BenchmarkIndexInfo(id: id, name: id, url: "https://\(id).example", kind: kind, domains: domains, maintainer: "M",
                               measures: "What \(id) measures", freshness: "Live", take: take)
        }
        let all = [index("swe", "benchmark", ["coding", "agents"]), index("arena", "leaderboard", ["chat"], take: "taste, not tasks"),
                   index("epoch", "aggregator", ["coding"]), index("helm", "suite", ["general"])]
        XCTAssertEqual(SkillsLibrary.benchmarkGroups(all).map(\.title), ["Aggregators", "Leaderboards", "Benchmarks", "Suites"])
        XCTAssertEqual(SkillsLibrary.filterBenchmarks(all, kind: nil, domain: "coding").map(\.id), ["swe", "epoch"])
        XCTAssertEqual(SkillsLibrary.filterBenchmarks(all, kind: "benchmark", domain: "coding").map(\.id), ["swe"])
        XCTAssertEqual(SkillsLibrary.filterBenchmarks(all, kind: nil, domain: nil, query: "TASTE").map(\.id), ["arena"], "the take is searched")
        XCTAssertEqual(SkillsLibrary.benchmarkDomains(all), ["coding", "agents", "chat", "general"], "most used first, then by name")
    }

    // MARK: Layout

    /// The conch panel's 860-point window leaves 639 beside the Settings list: one pane at a time there.
    func testTheSectionTakesOnePaneAtATimeInThePanelsWidth() {
        XCTAssertTrue(LibraryLayout.isCompact(width: 639))
        XCTAssertFalse(LibraryLayout.isCompact(width: 819), "the default 1040-point window: side by side")
    }

    func testAnIndexIsReadWhenAPersonWouldSayIt() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(SkillsLibrary.fetched(nil, now: now), "not read yet")
        XCTAssertEqual(SkillsLibrary.fetched(1_000_000_000 - 30_000, now: now), "read just now")
        XCTAssertEqual(SkillsLibrary.fetched(1_000_000_000 - 3 * 3_600_000, now: now), "read 3 h ago")
        XCTAssertEqual(SkillsLibrary.trustTitle("anthropic"), "Reviewed by Anthropic")
        XCTAssertNil(SkillsLibrary.trustTitle(nil))
    }
}
