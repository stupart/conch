import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The apps' half of per-session model and effort (src/session-settings.ts): they read what the
// daemon publishes, show it in the session header (Mac) and the session menu (iPhone), and send
// `set-settings`. XCTest covers the shared words (ConchDesign SessionSettingsTests); these hold
// the wiring each app builds around them.

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

/** From `marker` to the end of that declaration at the given indent; the marker must exist once. */
function member(source: string, marker: string, end = "\n    }\n"): string {
  const at = source.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  expect(source.indexOf(marker, at + 1)).toBe(-1);
  return source.slice(at, source.indexOf(end, at) + end.length);
}

describe("the shared picker (ConchDesign)", () => {
  const shared = read("design/ConchDesign/Sources/ConchDesign/SessionSettings.swift");

  test("a model choice sends only the model, an effort choice only the effort", () => {
    expect(shared).toContain("onPick(SessionSettingsPick(model: model.id))");
    expect(shared).toContain("onPick(SessionSettingsPick(effort: effort))");
    expect(shared).toContain('Text("For this session only. New sessions keep the agent\'s own default.")');
  });

  test("it decodes every field leniently: a newer daemon's shape never costs the row", () => {
    for (const field of ["model", "modelLabel", "modelChoice", "effort", "change"]) {
      expect(shared).toContain(`forKey: .${field})`);
    }
    expect(shared).toContain("models = ((try? c.decodeIfPresent([Lossy<Model>].self, forKey: .models)) ?? []).compactMap(\\.value)");
  });
});

describe("Mac", () => {
  test("a row carries its settings, the state its catalog, and a change to either repaints", () => {
    const models = read("mac-app/conch-mac/Models.swift");
    expect(models).toContain("settings = try? container.decodeIfPresent(SessionSettingsState.self, forKey: .settings)");
    expect(models).toContain("sessionSettings = try? container.decodeIfPresent(SessionSettingsCatalog.self, forKey: .sessionSettings)");
    expect(models).toContain("&& sessionSettings == other.sessionSettings");
    expect(models).toContain("let sessionSettings: Int?");
    // Renaming a row keeps what it runs.
    expect(member(models, "func replacingLabel(with label: String) -> SessionRow {")).toContain("settings: settings,");
  });

  test("the header shows it beside the agent badge, with a picker only where it can be changed", () => {
    const dashboard = read("mac-app/conch-mac/DashboardView.swift");
    const bar = member(dashboard, "private func sessionBar(for row: SessionRow) -> some View {");
    const badge = bar.indexOf("AgentBadge(backend: row.backend)");
    const control = bar.indexOf("SessionSettingsHeaderControl(");
    expect(badge).toBeGreaterThan(-1);
    expect(control).toBeGreaterThan(badge);
    expect(bar).toContain('if row.parentSessionId == nil, row.backend != "conch" {');
    expect(bar).toContain("catalog: state?.sessionSettings?.agent(row.backend, accountId: row.claudeAccountId ?? row.codexAccountId),");
    expect(bar).toContain("canChange: state?.features?.sessionSettings != nil && row.revealable && row.noTerminal == nil,");
    expect(bar).toContain("onPick: { store.setSessionSettings(id: row.id, pick: $0) }");
  });

  test("the control: what it runs or what it is switching to, a menu that is shut while a change is under way", () => {
    const inspector = read("mac-app/conch-mac/CapabilityInspectorView.swift");
    const control = inspector.slice(inspector.indexOf("struct SessionSettingsHeaderControl: View {"));
    expect(control).toContain("SessionSettingsPresentation.applying(row.settings) ?? SessionSettingsPresentation.title(row.settings)");
    expect(control).toContain("SessionSettingsMenuContent(state: row.settings, catalog: catalog, onPick: onPick)");
    expect(control).toContain('.disabled(row.settings?.change?.state == "applying")');
    expect(control).toContain("SessionSettingsPresentation.failure(row.settings)");
    // Where nothing can be changed there is no menu at all, only the words.
    expect(control).toMatch(/if canChange \{\n\s+Menu \{[\s\S]*\} else \{\n\s+label\n/);
  });

  test("the store sends set-settings with just what was picked, and hands a refusal to the row", () => {
    const store = read("mac-app/conch-mac/StateStore.swift");
    const send = member(store, "func setSessionSettings(id: SessionRow.ID, pick: SessionSettingsPick) {");
    expect(send).toContain("command: .setSettings,");
    expect(send).toContain("model: pick.model,");
    expect(send).toContain("effort: pick.effort,");
    expect(send).toContain("awaitDelivery: steered == nil ? nil : true");
    expect(send).toContain("self?.rowMessages[id] = failure");
    const socket = read("mac-app/conch-mac/ConchSocketClient.swift");
    expect(socket).toContain('case setSettings = "set-settings"');
    expect(socket).toContain("let effort: String?");
    expect(socket).toContain("self.effort = effort");
  });

  test("Settings shows each agent's own defaults, read-only", () => {
    const settings = read("mac-app/conch-mac/SettingsView.swift");
    expect(settings).toContain("SessionVoicesSection()\n                        AgentDefaultsSection()");
    const section = settings.slice(settings.indexOf("private struct AgentDefaultsSection: View {"));
    expect(section).toContain("(try? JSONDecoder().decode(SessionSettingsEnvelope.self, from: data))?.sessionSettings");
    expect(section).toContain("SessionSettingsPresentation.defaultsLine(defaults)");
    // Nothing in it writes: no request, no toggle.
    const body = section.slice(0, section.indexOf("private struct SessionSettingsEnvelope"));
    expect(body).not.toMatch(/socketClient|Toggle\(|Button\(/);
  });
});

describe("iPhone", () => {
  test("a row carries its settings, and the state the catalog", () => {
    const models = read("mobile/conch-ios/conch-ios/Models.swift");
    expect(models).toContain("settings = try? c.decodeIfPresent(SessionSettingsState.self, forKey: .settings)");
    expect(models).toContain("sessionSettings = try? c.decodeIfPresent(SessionSettingsCatalog.self, forKey: .sessionSettings)");
    expect(models).toContain("case cwd, workDirs, parentSessionId, startedBySessionId, waitingOnAgents, approval, settings");
  });

  test("the session menu shows the model and effort, and changes them through the Mac", () => {
    const view = read("mobile/conch-ios/conch-ios/SessionView.swift");
    const menu = view.slice(view.indexOf("// The model and effort it runs, and (when the Mac's daemon can)"));
    expect(menu).toContain("if let row, row.parentSessionId == nil {");
    expect(menu).toContain("if bridge.isConnected, bridge.state?.sessionSettings != nil, row.noTerminal == nil {");
    expect(menu).toContain("catalog: bridge.state?.sessionSettings?.agent(row.backend, accountId: row.claudeAccountId ?? row.codexAccountId)");
    expect(menu).toContain("Task { _ = await bridge.setSessionSettings(sessionId: sessionId, pick: pick) }");
    expect(menu.indexOf("Label(title, systemImage: \"cpu\")")).toBeLessThan(menu.indexOf("Button(\"End session…\""));
  });

  test("it is a session command, sent with only what was picked", () => {
    const bridge = read("mobile/conch-ios/conch-ios/BridgeClient.swift");
    const send = member(bridge, "func setSessionSettings(sessionId: String, pick: SessionSettingsPick) async -> Bool {");
    expect(send).toContain('["kind": "session-command", "sessionId": sessionId, "command": "set-settings"]');
    expect(send).toContain('if let model = pick.model { message["model"] = model }');
    expect(send).toContain('if let effort = pick.effort { message["effort"] = effort }');
    expect(send).toContain('reply["command"] as? String == "set-settings"');
  });
});
