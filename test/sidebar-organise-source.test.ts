import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 2026-11-12, Tyler: "is there a way to see ones that are active but not in conch and then move them in? maybe new
// section at bottom of left sidebar that's usually collapsed? would also love to drag and drop for organization."
// The rules are ConchDesign's (SidebarLayout.swift, Elsewhere.swift) and the daemon's (elsewhere.ts, sidebar-groups.ts),
// each tested there; this holds how the daemon and the two apps are wired to them.

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const dashboard = read("mac-app/conch-mac/DashboardView.swift");
const models = read("mac-app/conch-mac/Models.swift");
const store = read("mac-app/conch-mac/StateStore.swift");
const socket = read("mac-app/conch-mac/ConchSocketClient.swift");
const phone = read("mobile/conch-ios/conch-ios/LedgerView.swift");
const phoneModels = read("mobile/conch-ios/conch-ios/Models.swift");
const daemon = read("src/daemon.ts");

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("the daemon reads claude-swap's runs, looks for what isn't in conch, and keeps the groups", () => {
  test("claude-swap's run folders are read with the accounts on every registry read", () => {
    expect(daemon).toContain("accountRegistrySnapshot(claudeDir, readClaudeAccounts(claudeDir), readCodexAccounts(), undefined, claudeSwapRuns())");
  });

  test("discovery looks after a registry read, and both are published only when they say something", () => {
    expect(between(daemon, "function reconcileSessionSnapshot(", "pruneSessionCommandSets")).toContain("if (snap) observeElsewhere(registryLive);");
    expect(daemon).toContain("if (outside.length) lastPublishedPanelState.elsewhere = outside;");
    expect(daemon).toContain("if (hasSidebarGroups(sidebarLayout)) lastPublishedPanelState.sidebarGroups = sidebarLayout;");
  });

  test("the control server is handed both, and a saved layout is published at once", () => {
    expect(daemon).toContain("elsewhere: { act: actOnElsewhere },");
    const save = between(daemon, "sidebarGroups: {", "},\n    },");
    expect(save).toContain("writeSidebarGroups(layout);");
    expect(save).toContain("sidebarLayout = layout;");
    expect(save).toContain("void renderSessionPanel();");
  });

  test("Resume launches like every start, and Add reads the folder and puts conch's hooks there", () => {
    const act = between(daemon, "async function actOnElsewhere(", "\n  }\n");
    expect(act).toContain("const start = elsewhereResumeRequest(found, context, { host: request.host, bypassPermissions: cfg.bypassPermissions });");
    expect(act).toContain("await launchSession(start);");
    expect(act).toContain("addClaudeAccount(label, found.configDir)");
    expect(act).toContain("await installAccountHooks({ claudeDir: account.configDir });");
    // Nothing of the original is touched: no stop, close or signal.
    expect(act).not.toMatch(/closeSession|stopSession|kill\(|SIGTERM/);
  });
});

describe("the Mac sidebar", () => {
  const ledger = between(dashboard, "private struct SessionLedger: View {", "/// One request to bring a session's row into view");

  test("groups and order come from the layout, the daemon's or this list's own copy until it is published back", () => {
    expect(ledger).toContain("private var layout: SidebarLayout { pendingLayout ?? state?.sidebarGroups ?? .empty }");
    expect(ledger).toContain(".onChange(of: state?.sidebarGroups) { _, _ in pendingLayout = nil }");
    const apply = between(ledger, "private func apply(_ next: SidebarLayout) {", "\n    }\n");
    expect(apply).toContain("withAnimation(ConchMotion.morph.animation(reduceMotion: reduceMotion)) { pendingLayout = next }");
    expect(apply).toContain("if await !onSaveLayout(next), pendingLayout == next {");
    expect(dashboard).toContain("onSaveLayout: { await store.saveSidebarGroups($0) },");
    expect(dashboard).toContain("onElsewhere: { await store.actOnElsewhere($0, action: $1, host: $2) }");
  });

  test("a session row is dragged, dropped on, and marked where it will land", () => {
    expect(ledger).toContain('private static let sessionDrag = "conch-session:"');
    expect(ledger).toContain(".modifier(SessionDrag(id: plan.topLevel.contains(row.id) ? \"\\(Self.sessionDrag)\\(row.id)\" : nil))");
    expect(ledger).toContain("dropOnRow(items, row: row.id)");
    expect(ledger).toContain("SidebarDropLine(color: ConchPalette.dropTarget).offset(y: -4)");
    // A header takes a session too, but only one its section may hold.
    const drop = between(ledger, "private func dropFolder(_ items: [String], onto target: String) -> Bool {", "\n    }\n");
    expect(drop).toContain("if let session = draggedSession(items) { return move(session, into: target, before: nil) }");
    expect(between(ledger, "private func move(_ session: String,", "\n    }\n")).toContain("guard layout.accepts(session, into: section, folder: home) else { return false }");
  });

  test("everything a drag does has a menu and a VoiceOver action", () => {
    const menu = between(dashboard, "        .contextMenu {\n            Button(\"Rename\", action: onBeginRename)", "Button(\"Dismiss\", action: onDismiss)");
    expect(menu).toContain('Menu("Move To") {');
    expect(menu).toContain("Button(move.title) { onMove(move) }");
    expect(dashboard).toContain("Button(move.accessibilityName) { onMove(move) }");
    expect(ledger).toContain(".contextMenu { sectionMenu(folder) }");
    expect(ledger).toContain(".accessibilityActions { sectionMenu(folder, divided: false) }");
    expect(ledger).toContain('Button("Rename Group…")');
    expect(ledger).toContain('Button("New Group…")');
    // Its moves are part of what a row compares, so a row's menu is never stale.
    expect(between(dashboard, "extension DashboardRow: Equatable {", "\n}\n")).toContain("a.moves == b.moves");
  });

  test("Not in conch is at the bottom, folded until opened and remembered, counted, and asks before acting", () => {
    expect(ledger).toContain('@AppStorage("conch.elsewhereOpen") private var showsElsewhere = false');
    const body = between(ledger, "var body: some View {", "/// Not in conch (2026-11-12): what discovery found running");
    expect(body.indexOf("elsewhereSection\n")).toBeGreaterThan(body.indexOf("DismissedDashboardRow("));
    expect(body.indexOf("elsewhereSection\n")).toBeLessThan(body.indexOf("RemoteMacGroups(onSelect: onSelectRemote)"));
    // With no session in conch too.
    expect(body).toContain("elsewhereSection.padding(.horizontal, 8)");
    const section = between(ledger, "private var elsewhereSection: some View {", "\n    }\n}\n");
    expect(section).toContain("alwaysCounts: true,");
    expect(section).toContain("isCollapsed: !showsElsewhere,");
    expect(between(ledger, "private func act(on agent: ElsewhereAgent) {", "\n    }\n")).toContain("case .resume, .addAccount: confirmingElsewhere = agent");
    expect(body).toContain("ElsewhereText.confirmation($0, background: sessionHost == \"background\")?.title");
  });

  test("the store sends both requests and the state carries and compares both fields", () => {
    expect(socket).toContain('let kind = "elsewhere"');
    expect(socket).toContain('let kind = "sidebar-groups"');
    expect(store).toContain("ConchElsewhereRequest(action: action == .addAccount ? \"add-account\" : \"resume\"");
    expect(store).toContain("ConchSidebarGroupsRequest(layout: layout)");
    const same = between(models, "func hasSamePresentation(as other: PublishedState) -> Bool {", "\n    }\n");
    expect(same).toContain("&& elsewhere == other.elsewhere");
    expect(same).toContain("&& sidebarGroups == other.sidebarGroups");
    expect(models).toContain("elsewhere = Self.decodeLossyArray(ElsewhereAgent.self, from: container, forKey: .elsewhere)");
    expect(read("mac-app/conch-mac/LagoonSource.swift")).toContain("layout: state.sidebarGroups ?? .empty");
  });
});

describe("the phone", () => {
  test("draws the Mac's groups, and Not in conch to read, folded and remembered", () => {
    expect(phone).toContain("home: \"\", order: [], layout: state.sidebarGroups ?? .empty");
    expect(phone).toContain('@AppStorage("conch.elsewhereOpen") private var showsElsewhere = false');
    const section = between(phone, "if !state.elsewhere.isEmpty {", "} footer: {");
    expect(section).toContain("ForEach(showsElsewhere ? state.elsewhere : [])");
    // Shown, never acted on: the Mac asks first, and the request is the Mac's alone (phone-bridge.ts).
    expect(section).not.toContain("onAction:");
    expect(phoneModels).toContain("sidebarGroups = try? c.decodeIfPresent(SidebarLayout.self, forKey: .sidebarGroups)");
  });
});
