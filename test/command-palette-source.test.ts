import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * B4: the Mac command palette. ⌘K opens one searchable list for the selected
 * session — conch's controls, session actions, the agent's slash commands and
 * its user-invocable skills — each row saying what it will do. The ranking
 * lives in Swift because a shared TypeScript ranker cannot run in the app, so
 * it is pinned here. Presence is asserted before ordering: `indexOf` returns
 * -1 for a missing marker and -1 sorts before everything.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Ignore line comments so a description of a site cannot satisfy a guard.
const swift = (file: string) => source(`mac-app/conch-mac/${file}`).replace(/^\s*\/\/.*$/gm, "");
const palette = swift("CommandPaletteView.swift");
const content = swift("ContentView.swift");
const dashboard = swift("DashboardView.swift");
const app = swift("ConchMacApp.swift");

function at(text: string, marker: string, from = 0): number {
  const index = text.indexOf(marker, from);
  expect(index, `missing: ${marker}`).toBeGreaterThan(-1);
  return index;
}
function section(text: string, start: string, end: string): string {
  const a = at(text, start);
  const b = at(text, end, a);
  return text.slice(a, b);
}
function ordered(text: string, ...markers: string[]): void {
  let position = 0;
  for (const marker of markers) position = at(text, marker, position) + marker.length;
}

describe("B4: the palette lists the four sections for the selected session", () => {
  const catalog = section(palette, "enum PaletteCatalog {", "extension Notification.Name {");

  test("sections are conch, session, provider slash commands and skills", () => {
    ordered(
      palette,
      "enum Section: String, CaseIterable {",
      'case conch = "conch"',
      'case session = "Session"',
      'case provider = "Slash commands"',
      'case skills = "Skills"',
    );
  });

  test("conch rows: pause/resume, wake, recite, stop, reveal, rename…, model…", () => {
    const conch = section(catalog, "private static func conch(", "private static let claudeCommands");
    for (const id of ['"pause"', '"wake"', '"recite"', '"stop"', '"rename"', '"reveal"', '"model"']) {
      expect(conch).toContain(`id: ${id}`);
    }
    // Pause is one row that reads the session's effective state, not two.
    expect(conch).toContain("let paused = globallyPaused || row.paused");
    expect(conch).toContain("action: paused ? .resume : .pause");
    // Rename and Model take an argument; the row says which.
    expect(conch).toContain('argumentHint: "new name", action: .rename');
    expect(conch).toContain('argumentHint: "model, e.g. opus or gpt-5", action: .setModel');
  });

  test("session rows: dismiss, restore each dismissed session, inspect, help session", () => {
    const commands = section(catalog, "static func commands(", "private static func conch(");
    ordered(
      commands,
      'id: "dismiss", section: .session',
      'id: "inspect", section: .session',
      "for dismissed in state?.dismissedRows ?? []",
      'id: "restore:\\(dismissed.id)", section: .session',
      "action: .restore(id: dismissed.id, label: dismissed.label)",
      'id: "help", section: .session, title: "Help with conch"',
    );
    // Typed rows need a pane the daemon can reach; a subagent has none (C4).
    ordered(
      commands,
      "if let row, row.parentSessionId == nil, row.revealable {",
      "out += provider(for: row)",
      "out += skills(for: row, capabilities: capabilities)",
    );
  });

  test("provider commands are per agent and every row carries what it does", () => {
    const claude = section(catalog, "private static let claudeCommands", "private static let codexCommands");
    const codex = section(catalog, "private static let codexCommands", "private static func provider(");
    for (const line of ['"/compact"', '"/model"', '"/status"', '"/mcp"', '"/help"']) expect(claude).toContain(line);
    for (const line of ['"/compact"', '"/model"', '"/new"', '"/status"', '"/fast"']) expect(codex).toContain(line);
    // A picker says so: nothing here pretends a terminal menu happens in the app.
    expect(claude).toContain('("/model", "Choose the model in a picker in the terminal');
    expect(codex).toContain('("/model", "Choose model and reasoning effort in a picker in the terminal');
    expect(catalog).toContain('let codex = row.backend?.lowercased() == "codex"');
    expect(catalog).toContain("(codex ? codexCommands : claudeCommands).map { line, what, hint in");
    expect(catalog).toContain("detail: what, argumentHint: hint, action: .type(line)");
  });

  test("skills come from the existing agent-capabilities read, user-invocable only, spelled per agent", () => {
    const skills = section(palette, "private static func skills(", "extension Notification.Name {");
    expect(skills).toContain('guard entity.kind == "skill", let skill = entity.skill,');
    expect(skills).toContain("skill.userInvocable, !entity.isUnavailable else { return nil }");
    // Claude: /plugin:skill; Codex: a $name mention, which is an ordinary message.
    expect(skills).toContain('let owner = skill.ownerPluginId.map { $0.split(separator: "@", maxSplits: 1)[0] }');
    expect(skills).toContain('? "$\\(entity.name)"');
    expect(skills).toContain(': "/" + (owner.map { "\\($0):" } ?? "") + entity.name');
    expect(skills).toContain("argumentHint: skill.argumentHint, action: .type(line)");
    // The read is the inspector's, through the existing control message.
    const sheet = section(palette, "struct CommandPaletteSheet: View {", "private struct PaletteRow: View {");
    expect(sheet).toContain("capabilities = await store.capabilities(");
    expect(swift("ConchSocketClient.swift")).toContain('let kind = "agent-capabilities"');
  });
});

describe("B4: choosing a row does the one thing it says", () => {
  const perform = section(palette, "private func perform(_ action: PaletteCommand.Action, argument: String) {", "private struct PaletteRow: View {");

  test("typed rows go through the composer's inject door with the argument appended", () => {
    ordered(
      perform,
      "case let .type(line):",
      "store.send(.inject(",
      "sessionId: row.id,",
      "label: row.label,",
      'text: argument.isEmpty ? line : "\\(line) \\(argument)"',
    );
    // No second delivery route: nothing here talks to a socket request for typing.
    expect(perform).not.toContain("ConchSessionCommandRequest");
  });

  test("conch and session rows call the existing store methods", () => {
    expect(perform).toContain("case .pause: store.send(.scoped(.pause, sessionId: row.id, label: row.label))");
    expect(perform).toContain("case .resume: store.send(.scoped(.resume, sessionId: row.id, label: row.label))");
    expect(perform).toContain("case .wake: store.send(.wake(sessionId: row.id, label: row.label))");
    expect(perform).toContain("case .recite: store.send(.recite(sessionId: row.id, label: row.label))");
    expect(perform).toContain("case .stop: store.send(.stop())");
    expect(perform).toContain("case .reveal: store.reveal(row)");
    expect(perform).toContain("case .rename: store.renameSession(id: row.id, label: argument)");
    expect(perform).toContain("case .setModel: Task { _ = await store.setModel(id: row.id, model: argument) }");
    expect(perform).toContain("case .dismiss: store.dismissSession(row)");
    expect(perform).toContain("case .inspect: store.debugInspectRequest = row.id");
    expect(perform).toContain("store.restoreSession(id: id, label: label)");
    // Help: select the running help session, else start it in conch's folder (C7).
    ordered(
      perform,
      "case .helpSession:",
      "store.state?.rows.first(where: { $0.label == PaletteCatalog.helpSessionLabel })",
      "onSelect(help)",
      "await store.startSession(",
      "backend: .claude,",
      "cwd: PaletteCatalog.helpSessionDir",
    );
    expect(palette).toContain('static let helpSessionLabel = "conch help"');
    expect(palette).toContain('.appendingPathComponent(".config/conch/help", isDirectory: true).path');
    expect(content).toContain('.appendingPathComponent(".config/conch/help", isDirectory: true).path');
  });

  test("a command that declares an argument prompts for it before running", () => {
    const sheet = section(palette, "struct CommandPaletteSheet: View {", "private struct PaletteRow: View {");
    ordered(
      sheet,
      "private func choose() {",
      "if command.argumentHint != nil, pending == nil {",
      "pending = command",
      "focus = .argument",
      "run(command, argument: nil)",
    );
    expect(sheet).toContain('TextField(pending.argumentHint ?? "argument", text: $argument)');
    expect(sheet).toContain("run(pending, argument: argument)");
    // Rename and Model mean nothing without a value; the palette stays open.
    expect(sheet).toContain("if value.isEmpty, command.action == .rename || command.action == .setModel { return }");
  });
});

describe("B4: keyboard-first", () => {
  const sheet = section(palette, "struct CommandPaletteSheet: View {", "private struct PaletteRow: View {");

  test("⌘K opens it from the menu, the header button and the shortcuts list", () => {
    ordered(
      app,
      'CommandMenu("Session") {',
      'Button("Command Palette…") {',
      "name: .showCommandPalette,",
      '.keyboardShortcut("k", modifiers: .command)',
    );
    expect(palette).toContain('static let showCommandPalette = Notification.Name("com.conch.mac.show-command-palette")');
    ordered(
      content,
      ".sheet(isPresented: $isShowingCommandPalette) {",
      "CommandPaletteSheet(row: actionTarget, onSelect: selectSession) {",
      "isShowingCommandPalette = false",
      "NotificationCenter.default.publisher(for: .showCommandPalette)",
      "showCommandPalette()",
    );
    expect(content).toContain('ShortcutHelpRow(command: "⌘K", result: "Command palette")');
    // The dashboard's single-key controls stand down while the palette is up.
    expect(content).toContain("&& !isShowingKeyboardShortcuts && !isShowingCommandPalette,");
    expect(dashboard).toContain("let onShowCommandPalette: () -> Void");
    ordered(
      dashboard,
      'symbol: "command",',
      'help: "Command palette (⌘K)",',
      "action: actions.onShowCommandPalette",
      'symbol: "questionmark",',
    );
  });

  test("arrows move, Return runs, Esc backs out of the argument then closes", () => {
    ordered(
      sheet,
      ".onKeyPress(keys: [.upArrow, .downArrow]) { press in",
      "move(press.key == .downArrow ? 1 : -1)",
      ".onKeyPress(.return) {",
      "choose()",
    );
    expect(sheet).toContain('Button("Cancel", action: back)');
    expect(sheet).toContain(".keyboardShortcut(.cancelAction)");
    expect(sheet).toContain(".onExitCommand(perform: back)");
    ordered(
      sheet,
      "private func back() {",
      "if pending != nil {",
      "pending = nil",
      "focus = .search",
      "onDone()",
    );
    // Typing re-selects the best match, so Return always has a target.
    expect(sheet).toContain(".onChange(of: query) { _, _ in selectedID = visible.first?.id }");
  });

  test("fuzzy ranking: prefix beats word start beats subsequence, sections keep their order", () => {
    const match = section(palette, "enum PaletteMatch {", "enum PaletteCatalog {");
    ordered(
      match,
      "static func score(_ query: String, in text: String) -> Int? {",
      'let t = Array(text.lowercased().drop(while: { $0 == "/" || $0 == "$" }))',
      "if t.starts(with: q) { return 300 - t.count }",
      "if wordStart, t[i...].starts(with: q) { return 200 - t.count }",
      "guard qi == q.count else { return nil }",
      "return 100 - (last - first + 1 - q.count)",
    );
    // The detail counts only by word start — a subsequence matches any sentence.
    expect(match).toContain("guard let score = score(query, in: command.detail), score >= 200 else { return nil }");
    ordered(
      sheet,
      "private var visible: [PaletteCommand] {",
      "PaletteMatch.rank(query, command)",
      "if sa != sb { return sa < sb }",
      "if a.score != b.score { return a.score > b.score }",
      "return a.index < b.index",
    );
  });
});

test("B4: the palette file is in the Xcode target", () => {
  const project = source("mac-app/conch-mac.xcodeproj/project.pbxproj");
  // Build file, file reference, group child, and the Sources phase entry.
  expect(project).toContain("/* CommandPaletteView.swift in Sources */ = {isa = PBXBuildFile;");
  expect(project).toContain("/* CommandPaletteView.swift */ = {isa = PBXFileReference;");
  expect(project.match(/\/\* CommandPaletteView\.swift \*\/,/g)?.length).toBe(1);
  expect(project.match(/\/\* CommandPaletteView\.swift in Sources \*\/,/g)?.length).toBe(1);
});
