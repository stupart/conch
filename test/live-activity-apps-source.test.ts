import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The live activity line in both apps (2026-10-03). The rule for when a row shows it and how it is cut to one line is
 * ConchDesign's (`SidebarActivity`, `SidebarRowText.secondLine`, held by SidebarRowTests), and how it draws is
 * `SidebarSecondLine` (SidebarActivityRenderTests). conch-mac has no XCTest target, and the phone's views are only
 * photographed, so how each app reads `rows[].activity` and hands it to those pieces is pinned here.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const section = (text: string, start: string, end: string): string => {
  const from = text.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
};

describe("the Mac sidebar", () => {
  const models = read("mac-app/conch-mac/Models.swift");
  const dashboard = read("mac-app/conch-mac/DashboardView.swift");
  const row = section(dashboard, "private struct DashboardRow: View {", "private func pulseForReview()");
  const agents = section(dashboard, "private struct AgentGroup: View {", "\n}\n");

  test("a row decodes its activity without ever failing for it, and keeps it through a rename", () => {
    expect(models).toContain("activity = try? container.decodeIfPresent(Activity.self, forKey: .activity)");
    expect(models).toContain("struct Activity: Decodable, Equatable, Sendable {");
    expect(section(models, "func replacingLabel(with label: String) -> SessionRow {", "\n    }\n")).toContain("activity: activity");
  });

  test("a row shows it only while its mark says working, through the shared rule", () => {
    const activity = section(row, "private var activity: String? {", "\n    }\n");
    expect(activity).toContain("guard LedgerVisual(row: row) == .working else { return nil }");
    expect(activity).toContain("working: row.status == .working,");
    expect(activity).toContain("waitingOnAgents: row.waitingOnAgents,");
    expect(activity).toContain("usageLimited: row.usageLimit != nil");
    expect(row).toContain("SidebarSecondLine(secondLine, font: ConchTypography.font(size: 11))");
    expect(row).toContain(".padding(.vertical, secondLine == nil ? 0 : 5)");
  });

  test("VoiceOver hears it as part of the row", () => {
    const label = section(row, "private var accessibilityName: String {", "\n    }\n");
    expect(label).toContain("activity: activity");
  });

  test("a running sub-agent gets the same line, a size down, under its name", () => {
    expect(agents).toContain("if let activity = activity(of: agent) {");
    expect(agents).toContain("SidebarSecondLine(SidebarRowText.SecondLine(text: activity, kind: .activity), font: ConchTypography.font(size: 10.5))");
    expect(agents).toContain("guard LedgerVisual(row: agent) == .working else { return nil }");
    expect(agents).toContain("activity: activity(of: agent)");
  });
});

describe("the phone's ledger", () => {
  const models = read("mobile/conch-ios/conch-ios/Models.swift");
  const ledger = read("mobile/conch-ios/conch-ios/LedgerView.swift");
  const session = section(ledger, "struct SessionRowView: View {", "\nstruct AgentBadge: View {");
  const agent = section(ledger, "struct AgentRowView: View {", "\nstruct SessionRowView: View {");

  test("a row decodes its activity without ever failing for it", () => {
    expect(models).toContain("activity = try? c.decodeIfPresent(Activity.self, forKey: .activity)");
  });

  test("a working session's line takes the summary's place, in a text style that scales", () => {
    const activity = section(session, "private var activity: String? {", "\n    }\n");
    expect(activity).toContain("guard mark == .working else { return nil }");
    expect(activity).toContain("waitingOnAgents: row.waitingOnAgents,");
    expect(activity).toContain("usageLimited: row.usageLimit != nil");
    expect(session).toMatch(/if let activity \{\s*SidebarSecondLine\(SidebarRowText\.SecondLine\(text: activity, kind: \.activity\), font: Type\.summary\)\s*\} else if let summary = row\.usageLimit \?\? row\.review\?\.summary/);
  });

  test("a running sub-agent's row says what it is doing too", () => {
    expect(agent).toContain("guard mark == .working else { return nil }");
    expect(agent).toContain("SidebarSecondLine(SidebarRowText.SecondLine(text: activity, kind: .activity), font: Type.caption)");
  });

  test("the activity fixture holds working rows with lines beside rows that stay one line", () => {
    const state = JSON.parse(read("mobile/conch-ios/fixtures/activity.json"));
    const rows: any[] = state.rows;
    const working = rows.filter((row) => row.status === "working" && !row.waitingOnAgents && !row.parentSessionId);
    expect(working.filter((row) => row.activity?.kind === "step").length).toBeGreaterThan(1);
    expect(working.some((row) => row.activity?.kind === "commentary")).toBe(true);
    expect(rows.some((row) => row.backend === "codex" && row.activity)).toBe(true);
    // Sub-agents with lines, under a session whose own turn is over and which has none.
    const parent = rows.find((row) => row.waitingOnAgents);
    expect(parent?.activity).toBeUndefined();
    expect(rows.filter((row) => row.parentSessionId === parent?.id && row.activity).length).toBeGreaterThan(1);
    // And rows the line never touches: waiting, idle, blocked.
    for (const status of ["waiting", null, "needs"]) {
      const quiet = rows.filter((row) => row.status === status);
      expect(quiet.length).toBeGreaterThan(0);
      expect(quiet.every((row) => !row.activity)).toBe(true);
    }
    for (const row of rows.filter((candidate) => candidate.activity)) {
      expect(Array.from(row.activity.text as string).length).toBeLessThanOrEqual(90);
      expect(row.activity.text).not.toContain("\n");
    }
  });
});

describe("ui-snapshot.sh", () => {
  const script = read("scripts/ui-snapshot.sh");

  test("dark mode is asked for, set on every run, and the simulator pick stays among shut-down ones", () => {
    expect(script).toContain('xcrun simctl ui "$udid" appearance "${CONCH_SNAPSHOT_APPEARANCE:-light}"');
    const pick = section(script, 'udid="$(xcrun simctl list devices available', "|| true)\"");
    expect(pick.indexOf("grep '(Shutdown)'")).toBeLessThan(pick.indexOf('"${CONCH_SNAPSHOT_SIMULATOR:-}"'));
  });
});
