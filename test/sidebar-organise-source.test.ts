import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 2026-11-12, Tyler: "is there a way to see ones that are active but not in conch and then move them in? maybe new
// section at bottom of left sidebar that's usually collapsed?" The rules are ConchDesign's (Elsewhere.swift) and the
// daemon's (elsewhere.ts), each tested there; this holds how the daemon and the two apps are wired to them.

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

describe("the daemon reads claude-swap's runs and looks for what isn't in conch", () => {
  test("claude-swap's run folders are read with the accounts on every registry read", () => {
    expect(daemon).toContain("accountRegistrySnapshot(claudeDir, readClaudeAccounts(claudeDir), readCodexAccounts(), claudeSwapRuns())");
  });

  test("discovery looks after a registry read, and both are published only when they say something", () => {
    expect(between(daemon, "function reconcileSessionSnapshot(", "pruneSessionCommandSets")).toContain("if (snap) observeElsewhere(registryLive);");
    expect(daemon).toContain("if (outside.length) lastPublishedPanelState.elsewhere = outside;");
  });

  test("the control server is handed Not in conch's actions", () => {
    expect(daemon).toContain("elsewhere: { act: actOnElsewhere },");
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

  test("the store sends the request and the state carries and compares the field", () => {
    expect(socket).toContain('let kind = "elsewhere"');
    expect(store).toContain("ConchElsewhereRequest(action: action == .addAccount ? \"add-account\" : \"resume\"");
    const same = between(models, "func hasSamePresentation(as other: PublishedState) -> Bool {", "\n    }\n");
    expect(same).toContain("&& elsewhere == other.elsewhere");
    expect(models).toContain("elsewhere = Self.decodeLossyArray(ElsewhereAgent.self, from: container, forKey: .elsewhere)");
  });
});

describe("the phone", () => {
  test("shows Not in conch to read, folded and remembered", () => {
    expect(phone).toContain('@AppStorage("conch.elsewhereOpen") private var showsElsewhere = false');
    const section = between(phone, "if !state.elsewhere.isEmpty {", "} footer: {");
    expect(section).toContain("ForEach(showsElsewhere ? state.elsewhere : [])");
    // Shown, never acted on: the Mac asks first, and the request is the Mac's alone (phone-bridge.ts).
    expect(section).not.toContain("onAction:");
    expect(phoneModels).toContain("if let agent = try? agents.decode(ElsewhereAgent.self) { elsewhere.append(agent) }");
  });
});
