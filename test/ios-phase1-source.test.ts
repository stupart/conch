import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "mobile", "conch-ios", "conch-ios");
const app = (name: string) => readFileSync(join(root, name), "utf8");

describe("iPhone Phase 1 interaction model", () => {
  const models = app("Models.swift");
  const bridge = app("BridgeClient.swift");
  const ledger = app("LedgerView.swift");
  const speech = app("SpeechController.swift");

  test("Manual is pause-backed and legacy destructive mode has no phone behavior or copy", () => {
    const swift = readdirSync(root)
      .filter((name) => name.endsWith(".swift"))
      .map((name) => [name, app(name)] as const);
    const remnants = swift.flatMap(([name, source]) =>
      source.match(/mute|muted|unmute/gi)?.map((match) => `${name}: ${match}`) ?? []);

    expect(remnants).toEqual([]);
    expect(ledger).toContain('bridge.send(mode: next ? "pause" : "resume")');
    expect(ledger).toMatch(/bridge\.state\?\.mode\.paused/);
  });

  test("only automatic reading carries a session identity into mic follow-up", () => {
    expect(speech).toContain("followUpSessionId: reply.sessionId");
    expect(speech).toContain("speak(markdown, from: label, followUpSessionId: nil)");
    expect(speech).toContain("lastSpokenSessionId = followUpSessionId");
    const manual = speech.slice(speech.indexOf("func speak(_ markdown: String, from label: String?)"));
    expect(manual.indexOf("lastSpokenSessionId = nil"))
      .toBeLessThan(manual.indexOf("followUpSessionId: nil"));
    expect(speech).toMatch(/self\.onFinishedReading\?\(\)[\s\S]*self\.lastSpokenSessionId = nil/);
  });

  test("label-rich dismissed rows decode with a legacy id fallback", () => {
    expect(models).toContain("var dismissedRows: [DismissedRow] = []");
    expect(models).toContain("case v, ts, mode, live, rows, dismissed, dismissedRows, reply, conversations");
    expect(models).toContain("nestedUnkeyedContainer(forKey: .dismissedRows)");
    expect(models).toMatch(
      /if let row = try\? dismissedContainer\.decode\(DismissedRow\.self\) \{[\s\S]*?if !row\.id\.isEmpty \{[\s\S]*?decodedDismissed\.append\(row\)[\s\S]*?continue[\s\S]*?\}\s*_ = try\? dismissedContainer\.decode\(AnyIgnored\.self\)/,
    );
    expect(models).toContain("decodeIfPresent([String].self, forKey: .dismissed)");
  });

  test("per-session passive status uses the shared Manual vocabulary", () => {
    expect(models).toContain('case .paused: "Manual"');
    expect(models).not.toContain('case .paused: "Paused"');
  });

  test("dismiss and restore use typed commands and both remain reachable", () => {
    expect(bridge).toMatch(/enum SessionCommand: String \{\s*case dismiss\s*case restore\s*\}/);
    expect(bridge).toContain('"kind": "session-command"');
    expect(bridge).toContain('reply["kind"] as? String == "session-ack"');

    expect(ledger).toContain("!state.rows.isEmpty || !state.dismissedRows.isEmpty");
    expect(ledger).toContain("allowsFullSwipe: false");
    expect(ledger).toContain("runSessionCommand(.dismiss");
    expect(ledger).toContain("ForEach(state.dismissedRows)");
    expect(ledger).toContain("runSessionCommand(.restore");
    expect(ledger).toContain("Dismissed sessions keep running on your Mac.");
  });
});
