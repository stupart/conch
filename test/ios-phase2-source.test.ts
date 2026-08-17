import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "mobile", "conch-ios", "conch-ios");
const app = (name: string) => readFileSync(join(root, name), "utf8");

describe("iPhone Phase 2 daily controls", () => {
  const bridge = app("BridgeClient.swift");
  const models = app("Models.swift");
  const ledger = app("LedgerView.swift");
  const session = app("SessionView.swift");
  const conversation = app("ConversationStack.swift");

  test("new and resumed sessions use the daemon launch contract", () => {
    expect(bridge).toContain('"kind": "session-start"');
    expect(bridge).toContain('"backend": backend.rawValue');
    expect(bridge).toContain('message["resumeSessionId"]');
    expect(bridge).toContain('reply["kind"] as? String == "session-started"');
    expect(bridge).toContain('reply["resumed"] as? Bool == !resumeID.isEmpty');
    expect(bridge).toMatch(
      /reply\["kind"\] as\? String == "session-error"[\s\S]*let failure = reply\["error"\] as\? String[\s\S]*operation: "session-start", message: failure/,
    );

    expect(ledger).toContain("StartSessionSheet(bridge: bridge)");
    expect(ledger).toContain('Toggle("Resume an existing session"');
    expect(ledger).toContain('TextField("Session ID"');
    expect(ledger).toContain("ForEach(BridgeClient.AgentBackend.allCases)");
  });

  test("clean close is remote-only, behind an overflow menu and confirmation", () => {
    expect(bridge).toContain('"kind": "session-close"');
    expect(bridge).toContain('reply["kind"] as? String == "session-closed"');
    const close = bridge.slice(bridge.indexOf("func closeSession"));
    expect(close).toMatch(
      /reply\["kind"\] as\? String == "session-error"[\s\S]*let failure = reply\["error"\] as\? String[\s\S]*message: failure/,
    );
    expect(bridge).not.toMatch(/kill\s*\(/);

    expect(session).toMatch(/Menu \{[\s\S]*Button\("End session…"/);
    expect(session).toContain('confirmationDialog(\n            "End this session cleanly?"');
    expect(session).toContain("Button(\"End session\", role: .destructive, action: closeCleanly)");
    expect(session).not.toContain("swipeActions");
  });

  test("context is decoded and rendered proportionally in both session surfaces", () => {
    expect(models).toContain("var usedTokens = 0");
    expect(models).toContain("var limitTokens = 0");
    expect(models).toContain("Double(usedTokens) / Double(limitTokens)");
    expect(models).toContain("var context: ContextUsage?");

    expect(ledger).toContain("ContextMeter(usage: context, compact: true)");
    expect(session).toContain("ContextMeter(usage: context)");
    expect(ledger).toContain("geometry.size.width * usage.proportion");
    expect(ledger).toContain("usage.proportion >= 0.80");
    expect(ledger).toContain("usage.proportion >= 0.95");
  });

  test("Claude and Codex badges sit with names in ledger and conversation", () => {
    expect(ledger).toContain('case nil, "claude": "Claude"');
    expect(ledger).toContain('case "codex": "Codex"');
    expect(ledger).toContain("AgentBadge(backend: row.backend)");
    expect(session).toContain("AgentBadge(backend: row?.backend)");
    expect(session).toContain("ToolbarItem(placement: .principal)");
  });

  test("question options are buttons that inject their exact labels", () => {
    expect(conversation).toContain("let onSelectOption: (String) -> Void");
    expect(conversation).toContain('questionRow(asked, isActive: item.tool?.status == "running")');
    expect(conversation).toContain("onSelectOption(option.label)");
    expect(conversation).toContain(".disabled(!isActive || optionReplyInFlight || option.label.isEmpty)");
    expect(session).toContain("onSelectOption: answerQuestion");
    expect(session).toMatch(/private func answerQuestion[\s\S]*text: label/);
  });

  test("phone failures report structured state over the control channel", () => {
    expect(bridge).toContain('"kind": "app-error"');
    expect(bridge).toContain('"source": "ios"');
    expect(bridge).toContain('"operation": operation');
    expect(bridge).toContain('"state": snapshot');
    expect(bridge).toContain('reply["kind"] as? String == "app-error-ack"');
    expect(bridge).toMatch(/func inject[\s\S]*operation: "message-delivery"/);
    expect(session).toContain('operation: "speech-recognition"');
    expect(session).toContain('operation: "speech-playback"');
  });
});
