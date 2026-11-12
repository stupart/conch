import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Settings › Skills, used and managed from where you read it (2026-11-11). Tyler: "Workflows - making the rest of the
 * app like skills, workflows, etc much more pleasurable to use." The rules (which sessions have it, what each copy can
 * do) are ConchDesign's, held by LibraryUseTests; the daemon's switch is test/skill-switch.test.ts's. The Mac has no
 * XCTest target, so how its page wires them is pinned here.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
/** Swift with its line comments out, so a rule is about code and not about prose naming it. */
const code = (source: string): string => source.replace(/\/\/.*$/gm, "");
function member(source: string, signature: string, indent = 4): string {
  const start = source.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf(`\n${" ".repeat(indent)}}\n`, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const skills = code(read("mac-app/conch-mac/SkillsLibraryView.swift"));

describe("using a skill or a workflow in an open session", () => {
  // Its closing brace kept, so its last member has the line end `member` looks for.
  const sessions = `${member(skills, "enum LibrarySessions {", 0)}\n}\n`;

  test("Run sends the line as the palette does, and shows the session it went to", () => {
    const run = member(sessions, "static func run(_ use: LibraryUse, store: StateStore) {");
    expect(run).toContain("store.send(.inject(sessionId: use.session.id, label: use.session.label, text: use.line))");
    expect(run).toContain("show(use.session)");
    const show = member(sessions, "static func show(_ session: LibrarySession) {");
    expect(show).toContain("SettingsRouter.shared.close()");
    expect(show).toContain("NotificationCenter.default.post(name: .selectSessionFromStatusItem, object: session.id)");
  });

  test("Type puts the line at the front of the session's reply, keeping what was typed", () => {
    const type = member(sessions, "static func type(_ use: LibraryUse) {");
    expect(type).toContain("ComposerDraftStore.shared.textBinding(for: use.session.id)");
    expect(type).toContain('reply.wrappedValue = draft.isEmpty ? "\\(use.line) " : "\\(use.line) \\(draft)"');
    expect(type).toContain("show(use.session)");
  });

  test("the sessions are the top-level rows, typed into only where a pane or a message route reaches", () => {
    const all = member(sessions, "static func all(_ store: StateStore) -> [LibrarySession] {");
    expect(all).toContain(".filter { $0.parentSessionId == nil }");
    expect(all).toContain("canType: row.revealable || row.messageRoute != nil");
    expect(all).toContain("accountId: codex ? row.codexAccountId : row.claudeAccountId");
  });

  test("the reader leads with the panel, its uses read from the open sessions", () => {
    expect(skills).toContain("InstalledSkillReader(skill: skill, isWide: $readerWide, uses: LibraryUses.skill(skill, among: LibrarySessions.all(stateStore)),");
    expect(skills).toContain("SkillDetailPanel(skill: skill, uses: uses, reading: location?.id, actions: readingActions)");
    // Each row's menu offers the same, so a right-click is as good as the reader.
    expect(skills).toContain('Menu("Run In") {');
    expect(skills).toContain('Menu("Type Into") {');
  });
});

describe("managing a skill's copy", () => {
  test("the switch shows its edit first, and Apply sends the preview's hash", () => {
    const sheet = member(skills, "struct SkillToggleSheet: View {", 0);
    expect(sheet).toContain("await store.togglePreview(target.location, enabled: target.enabled)");
    expect(sheet).toContain("await store.toggle(target.location, enabled: target.enabled, planHash: preview.planHash)");
    expect(sheet).toContain(".disabled(preview == nil || preview?.diff.isEmpty == true || busy || applied)");
    expect(sheet).toContain('Text("Applies to the next session; a running session is untouched.")');
    // The list is read again once it is written, so the copy says what it is now.
    expect(member(skills, "func toggle(_ location: SkillLocationInfo, enabled: Bool, planHash: String) async")).toContain("await loadInstalled(refresh: true)");
  });

  test("Move to Trash asks first, takes only your own, and uses the Trash, never a delete", () => {
    const trash = member(skills, "private func trash(_ location: SkillLocationInfo, of skill: InstalledSkillInfo) {");
    expect(trash).toContain("guard SkillCopies.canTrash(location) else { return }");
    expect(trash.indexOf("alert.runModal() == .alertFirstButtonReturn")).toBeLessThan(trash.indexOf("NSWorkspace.shared.recycle("));
    expect(trash).toContain("await store.loadInstalled(refresh: true)");
    expect(skills).not.toContain("removeItem(");
  });

  test("a copy switched elsewhere goes there: Plugins & MCP, or claude.ai", () => {
    const actions = member(skills, "private func actions(for skill: InstalledSkillInfo) -> SkillDetailActions {");
    expect(actions).toContain("openPlugins: { SettingsRouter.shared.select(.tools) }");
    expect(read("mac-app/conch-mac/SkillsLibraryView.swift")).toContain('openClaudeAI: { open("https://claude.ai/settings/capabilities") }');
  });
});
