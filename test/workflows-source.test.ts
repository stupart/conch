import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Settings › Workflows (2026-11-11), wired in the Mac app: the rules are ConchDesign's (WorkflowsTests), the daemon's
 * reads test/workflows.test.ts's. The Mac has no XCTest target, so how its page wires them is pinned here.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const code = (source: string): string => source.replace(/\/\/.*$/gm, "");
function member(source: string, signature: string, indent = 4): string {
  const start = source.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf(`\n${" ".repeat(indent)}}\n`, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}
const workflows = code(read("mac-app/conch-mac/WorkflowsLibraryView.swift"));

describe("Settings › Workflows", () => {
  test("the reader leads with the panel, its uses read from the open sessions, and a row's menu offers the same", () => {
    expect(workflows).toContain("uses: LibraryUses.workflow(workflow, among: sessions),");
    expect(workflows).toContain("WorkflowDetailPanel(workflow: workflow, uses: uses, featureOff: featureOff, actions: actions)");
    expect(workflows).toContain('Menu("Run In") {');
    expect(workflows).toContain('Menu("Type Into") {');
    expect(workflows).toContain("LibrarySessions.run(use, store: stateStore)");
    expect(workflows).not.toContain("removeItem(");
  });

  test("its runs are read again every few seconds while one is running", () => {
    expect(workflows).toContain("try? await Task.sleep(for: .seconds(store.anyRunning ? 4 : 30))");
    expect(workflows).toContain("WorkflowRunPanel(run: run, now: context.date) { openSession(run.sessionId) }");
  });

  test("a new session runs the workflow as its first message, in the folder picked, asking about trust as Try does", () => {
    const start = member(workflows, "private func start() {");
    expect(start).toContain("backend: .claude,");
    expect(start).toContain("prompt: line");
    expect(start).toContain("case let .needsTrust(cwd):\n                pendingTrust = cwd");
    expect(start).toContain("trustFolder: pendingTrust != nil,");
  });

  test("it is a section beside Skills, in the page and in ⌘K", () => {
    expect(read("mac-app/conch-mac/SettingsView.swift")).toContain("case .workflows: ConchWorkflowsSettingsView()");
    expect(read("mac-app/conch-mac/CommandPaletteView.swift")).toContain("action: .settings(.workflows)");
    expect(read("mac-app/conch-mac.xcodeproj/project.pbxproj")).toContain("WorkflowsLibraryView.swift in Sources");
  });
});
