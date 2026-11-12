import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Teams in the Mac app (2026-11-12). Tyler: "would be nice to add 'teams' to conch settings to where we can set up team
 * structures with specialized agents, rules for how they'll work together, and a hierarchy and then i can spin up or pass
 * tasks to team types." The page, its sheets and the sidebar's header are ConchDesign's (Teams.swift, TeamsViews.swift,
 * tested there by XCTest and by picture); the Mac app has no test target, so these read its Swift for the wiring: Settings
 * › Teams over the socket, the published teams decoded and carried, and the sidebar grouping each team's members under
 * its header with Pass task… and End team.
 */
const root = join(import.meta.dir, "..");
// Line comments stripped, so prose describing a rule can never satisfy a guard.
const swift = (path: string): string => readFileSync(join(root, path), "utf8").replace(/^\s*\/\/.*$/gm, "");

const settings = swift("mac-app/conch-mac/SettingsView.swift");
const dashboard = swift("mac-app/conch-mac/DashboardView.swift");
const models = swift("mac-app/conch-mac/Models.swift");
const store = swift("mac-app/conch-mac/StateStore.swift");
const palette = swift("mac-app/conch-mac/CommandPaletteView.swift");
const page = swift("design/ConchDesign/Sources/ConchDesign/SettingsPage.swift");
const teams = swift("design/ConchDesign/Sources/ConchDesign/Teams.swift");

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("Settings › Teams", () => {
  test("is a section of its own, after Environments, and the palette opens it", () => {
    expect(page).toContain("case providers, environments, teams, tools,");
    expect(page).toContain('case .teams: "Teams"');
    expect(page).toContain('case .teams: "person.3"');
    expect(palette).toContain("action: .settings(.teams)");
  });

  test("draws ConchDesign's page, over the socket, with the Mac's folder panel and a start's long wait", () => {
    const section = between(settings, "private func section(_ section: SettingsSection) -> some View {", "\n    }\n}\n");
    expect(section).toContain("case .teams: TeamsView(chooseFolder: TeamsSocket.chooseFolder, transport: TeamsSocket.send)");
    const socket = between(settings, "enum TeamsSocket {", "\n}\n");
    expect(socket).toContain("static let timeout: TimeInterval = 60");
    expect(socket).toContain("ConchSocketClient().request(request, timeout: timeout)");
    expect(socket).toContain("case .connectFailed, .timeout:");
    expect(socket).toContain("let panel = NSOpenPanel()");
    expect(socket).toContain("panel.canChooseDirectories = true");
    expect(socket).toContain("panel.canChooseFiles = false");
  });

  test("its requests are the desk's kinds", () => {
    for (const kind of ["teams", "team-type-save", "team-type-delete", "team-type-duplicate", "team-types-restore", "team-start", "team-task", "team-end"]) {
      expect(teams, kind).toContain(`try container.encode("${kind}", forKey: .kind)`);
    }
  });
});

describe("the published teams", () => {
  test("are decoded one by one, compared, and carried through the store's rebuild", () => {
    expect(models).toContain("let teams: [TeamSummary]");
    expect(models).toContain("teams = Self.decodeLossyArray(TeamSummary.self, from: container, forKey: .teams)");
    expect(models).toContain("&& teams == other.teams");
    // The rebuild names every field, or a new one is silently dropped on every poll (the conversation stack's hour).
    expect(store).toContain("teams: sourceState.teams");
  });
});

describe("the sidebar", () => {
  test("groups each running team's members under the team, by the one rule", () => {
    const folders = between(dashboard, "private var sessionFolders: [SessionFolder] {", "\n    }\n");
    expect(folders).toContain("teams: Teams.sidebarTeams(state?.teams ?? [])");
    expect(folders).toContain("SessionGrouping.sidebar(");
  });

  test("draws a team's group under TeamHeader, dragged as a folder's is, with Pass task… and End team", () => {
    const header = between(dashboard, "if let team = folder.team {", "} else if !folder.name.isEmpty {");
    expect(header).toContain("TeamHeader(");
    expect(header).toContain("task: team.task,");
    expect(header).toContain("isCollapsed: collapsedFolders.contains(folder.id),");
    expect(header).toContain('Button("Pass task…") { passingTaskTo = self.team(team.id) }');
    expect(header).toContain('Button("End team…") { endingTeam = self.team(team.id) }');
    expect(header).toContain(".draggable(folder.id)");
    expect(header).toContain("dropFolder(items, onto: folder.id)");
    expect(header).toContain('.id("folder:\\(folder.id)")');
    // A folder's header is still a folder's.
    expect(dashboard).toContain("} else if !folder.name.isEmpty {\n                                        FolderHeader(");
  });

  test("Pass task… goes through the desk to the lead, and End team is confirmed", () => {
    expect(dashboard).toContain(".sheet(item: $passingTaskTo) { team in");
    expect(dashboard).toContain("await TeamsStore.passTask(team: team.id, task: task, transport: TeamsSocket.send)");
    expect(dashboard).toContain("presenting: endingTeam) { team in");
    expect(dashboard).toContain("await TeamsStore.end(team: team.id, transport: TeamsSocket.send)");
  });
});
