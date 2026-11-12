import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The apps' side of the resource ledger (src/resource-ledger.ts; ConchDesign/StillRunning.swift): the Mac's Still
// running beside the sessions, a row's "3 still running", and the phone's line.

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const between = (text: string, start: string, end: string): string => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThan(-1);
  expect(to, end).toBeGreaterThan(from);
  return text.slice(from, to);
};

describe("the Mac app", () => {
  const models = read("mac-app/conch-mac/Models.swift");
  const dashboard = read("mac-app/conch-mac/DashboardView.swift");

  test("decodes the list and each row's count, and repaints when either changes", () => {
    expect(models).toContain("let resources: PublishedResources?");
    expect(models).toContain("resources = try? container.decodeIfPresent(PublishedResources.self, forKey: .resources)");
    expect(between(models, "func hasSamePresentation(as other: PublishedState) -> Bool {", "\n    }\n")).toContain("&& resources == other.resources");
    expect(models).toContain("let stillRunning: Int?");
    expect(models).toContain("stillRunning = try? container.decodeIfPresent(Int.self, forKey: .stillRunning)");
    // Every copy of a row carries it, or a rename, an ask or the pane's copy would drop the line.
    expect(models.match(/stillRunning: stillRunning/g)?.length).toBe(3);
  });

  test("the store's rebuild of the state carries the list", () => {
    const store = read("mac-app/conch-mac/StateStore.swift");
    expect(between(store, "let next = PublishedState(", "if state?.hasSamePresentation(as: next)")).toContain("resources: sourceState.resources");
  });

  test("the section sits after the sessions' folders and before the dismissed ones", () => {
    const ledger = between(dashboard, "private struct SessionLedger: View {", "private struct FolderHeader: View {");
    const folders = ledger.indexOf("ForEach(sessionFolders) { folder in");
    const section = ledger.indexOf("StillRunningSection(resources: resources, now: timeline.date, decide: Self.decideResource)");
    const dismissed = ledger.indexOf('name: "Dismissed"');
    expect(folders).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(folders);
    expect(dismissed).toBeGreaterThan(section);
    // A Mac with nothing but leftovers still shows the list.
    expect(ledger).toContain("!(state.resources?.items.isEmpty ?? true)");
  });

  test("Tyler's word goes to the daemon as his: no pid, and a stop, hold or priority change waits for it", () => {
    const requests = between(dashboard, "enum ResourceRequests {", "private struct SessionLedger: View {");
    expect(requests).toContain("ConchSocketClient().request(ResourceDecideRequest(id: id, action: action), timeout: quick ? 5 : 200)");
    expect(requests).toContain("ConchSocketClient().request(ResourceSessionRequest(sessionId: sessionId, lower: lower), timeout: 60)");
    expect(requests).not.toContain("callerPid");
    expect(dashboard).toContain("static let decideResource = ResourceRequests.decide");
  });

  test("Settings › Resources draws the published list and budget, and sends through the same requests", () => {
    const settings = read("mac-app/conch-mac/SettingsView.swift");
    expect(settings).toContain("case .resources: ConchResourcesSettingsView()");
    const page = between(settings, "struct ConchResourcesSettingsView: View {", "struct ConchEnvironmentsView: View {");
    expect(page).toContain('SettingsSectionHeader(title: "Resources"');
    expect(page).toContain("resources: store.state?.resources");
    expect(page).toContain("decide: ResourceRequests.decide");
    expect(page).toContain("lowerSession: ResourceRequests.lowerSession");
    expect(page).toContain("setBudget: ResourceRequests.setBudget");
    // The budget's settings have names in General too.
    expect(settings).toContain('"agent-budget-cpu": "Agents\' CPU budget (75% or 14 cores)"');
    // A setting written as words gets a field in General, so "14 cores" can be typed there too.
    expect(settings).toContain('case "string":\n            StringSettingControl(entry: setting.entry, onSet: onSet)');
  });

  test("a row's second line says what it left running", () => {
    const row = between(dashboard, "private var secondLine: SidebarRowText.SecondLine? {", "private var accessibilityName: String {");
    expect(row).toContain("stillRunning: row.stillRunning");
    expect(row).toContain("stillRunningLevel: row.resourceLevel");
    expect(models).toContain("resourceLevel = try? container.decodeIfPresent(String.self, forKey: .resourceLevel)");
    expect(models.match(/resourceLevel: resourceLevel/g)?.length).toBe(3);
    expect(between(dashboard, "private var accessibilityName: String {", "\n    }\n")).toContain("stillRunning: row.stillRunning");
  });
});

describe("ConchDesign", () => {
  const design = read("design/ConchDesign/Sources/ConchDesign/StillRunning.swift");

  test("a stop is confirmed first; the section stops nothing on its own", () => {
    expect(design).toContain('.confirmationDialog("Stop \\(item.title)?", isPresented: $confirmingStop)');
    expect(between(design, "private func perform(_ action: ResourceAction) {", "\n    }\n")).toContain("if action == .stop { confirmingStop = true }");
    // The only call that reaches the daemon is the one a person's action makes.
    expect(design.match(/decide\(item\.id, action\)/g)).toHaveLength(1);
  });

  test("the row's line sits after what it is doing and before its starter", () => {
    const sidebar = read("design/ConchDesign/Sources/ConchDesign/SidebarRow.swift");
    const rule = between(sidebar, "public static func secondLine(", "\n    }\n");
    expect(rule.indexOf("SidebarActivity.clean(activity)")).toBeLessThan(rule.indexOf("StillRunning.rowLine(stillRunning)"));
    expect(rule.indexOf("StillRunning.rowLine(stillRunning)")).toBeLessThan(rule.indexOf('"started by'));
  });
});

describe("the phone", () => {
  test("decodes a row's count and says it under the row; the list and Stop stay the Mac's", () => {
    const models = read("mobile/conch-ios/conch-ios/Models.swift");
    expect(models).toContain("var stillRunning: Int?");
    expect(models).toContain("stillRunning = try? c.decodeIfPresent(Int.self, forKey: .stillRunning)");
    const ledger = read("mobile/conch-ios/conch-ios/LedgerView.swift");
    expect(ledger).toContain("if activity == nil, let running = StillRunning.rowLine(row.stillRunning) {");
    expect(ledger).toContain("level: ResourceLevel(row.resourceLevel)");
    expect(ledger).not.toContain("ResourceDecideRequest");
  });
});
