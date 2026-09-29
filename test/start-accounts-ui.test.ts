import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateControlMessage } from "../src/settings.ts";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const phone = read("mobile/conch-ios/conch-ios/LedgerView.swift");
const mac = read("mac-app/conch-mac/ContentView.swift");
const bridge = read("mobile/conch-ios/conch-ios/BridgeClient.swift");

describe("account-aware native start flows", () => {
  test("both clients gate start and account choices using the shared, clock-aware policy", () => {
    for (const source of [phone, mac]) {
      expect(source).toContain("StartAccountPicker(catalog: activeAccounts");
      expect(source).toContain("availability(for: selectedAccountId, now: Date(), sourceAccountId: handoffSourceAccountId).blocksStart(allowAtLimit: allowAtLimit)");
      expect(source).toContain("guard canStart else { return }");
      expect(source).toContain("Timer.publish(every: 30");
      expect(source).toContain('DisclosureGroup("Advanced"');
      expect(source).toContain("Text(permissionsSummary)");
    }
  });

  test("phone sends both handoff identities and the selected Codex profile through its authenticated bridge", () => {
    expect(phone).toContain('claudeAccountId: effectiveBackend == .claude ? selectedAccountId : nil');
    expect(phone).toContain('claudeSourceAccountId: isAccountHandoff ? (resumeSelection?.claudeAccountId ?? "default") : nil');
    expect(phone).toContain('codexAccountId: effectiveBackend == .codex ? selectedAccountId : nil');
    for (const key of ["claudeAccountId", "claudeSourceAccountId", "codexAccountId"]) {
      expect(bridge).toContain(`message["${key}"] = ${key}`);
    }
    expect(bridge).toContain('postControlRaw(["kind": kind, "action": refresh ? "usage" : "list"])');
    expect(bridge).toContain("JSONDecoder().decode(StartAccountCatalog.self, from: data)");
    expect(phone).toContain('locked: resuming && effectiveBackend == .codex');
    expect(phone).toContain('!(isAccountHandoff && $0.name == "fork-session")');
    const route = validateControlMessage({ kind: "session-start", backend: "claude", cwd: "/project",
      resumeSessionId: "11111111-1111-4111-8111-111111111111", claudeAccountId: "work", claudeSourceAccountId: "default" });
    expect(route.ok).toBe(true);
    if (route.ok) expect(route.value).toMatchObject({ claudeAccountId: "work", claudeSourceAccountId: "default" });
  });

  test("phone's resume identity includes the provider and account just like the Mac", () => {
    const identity = 'var id: String { "\\(backend):\\(claudeAccountId ?? codexAccountId ?? "default"):\\(sessionId)" }';
    expect(read("mobile/conch-ios/conch-ios/Models.swift")).toContain(identity);
    expect(read("mac-app/conch-mac/ResumePickerView.swift")).toContain(identity);
  });
});
