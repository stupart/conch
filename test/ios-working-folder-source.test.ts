import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// B7: a working folder for fresh sessions on the phone. The daemon side
// (validator, existence check, Codex trust reply) is executable-tested
// elsewhere; these pin the phone's wiring to it. Presence before ordering.

const repo = join(import.meta.dir, "..");
const ios = (name: string) => readFileSync(join(repo, "mobile", "conch-ios", "conch-ios", name), "utf8");
const mac = (name: string) => readFileSync(join(repo, "mac-app", "conch-mac", name), "utf8");

describe("phone working folder for fresh sessions", () => {
  const ledger = ios("LedgerView.swift");
  const bridge = ios("BridgeClient.swift");
  const models = ios("Models.swift");

  test("the typed folder is remembered per phone, newest first, and offered back", () => {
    // The store: UserDefaults, last used first, capped.
    expect(ledger).toContain("enum RecentFolders");
    expect(ledger).toContain('static let key = "recentWorkingFolders"');
    expect(ledger).toContain("UserDefaults.standard.stringArray(forKey: key) ?? []");
    expect(ledger).toContain("([folder] + load().filter { $0 != folder }).prefix(limit)");
    expect(ledger).toContain("UserDefaults.standard.set(updated, forKey: key)");

    // The field opens on the last folder used; the recents are tappable rows
    // under it, shown the way the resume rows say a place.
    expect(ledger).toContain("@State private var workingFolder = RecentFolders.load().first ?? \"\"");
    expect(ledger).toContain("@State private var recents = RecentFolders.load()");
    expect(ledger).toContain("ForEach(recents, id: \\.self)");
    expect(ledger).toContain("workingFolder = folder");
    expect(ledger).toContain("Text(shortHomePath(folder))");
    expect(models).toContain("func shortHomePath(_ cwd: String) -> String");
    expect(models).toContain("var shortCwd: String { shortHomePath(cwd) }");

    // Remembered only after the daemon accepted it, and never for a resume,
    // whose folder belongs to the picked session.
    const remember = "recents = RecentFolders.remember(folder)";
    const accepted = "case .started:";
    const refused = "case .failed:";
    expect(ledger).toContain(remember);
    expect(ledger).toContain(accepted);
    expect(ledger).toContain(refused);
    expect(ledger).toContain("if !resuming, let folder = freshWorkingFolder {");
    const startIndex = ledger.indexOf("private func start()");
    expect(startIndex).toBeGreaterThan(-1);
    const body = ledger.slice(startIndex);
    expect(body.indexOf(refused)).toBeLessThan(body.indexOf(accepted));
    expect(body.indexOf(accepted)).toBeLessThan(body.indexOf(remember));
  });

  test("the sheet says where a fresh session lands, blank meaning the Mac home folder", () => {
    expect(ledger).toContain("Text(freshFootnote)");
    expect(ledger).toContain('freshWorkingFolder.map(shortHomePath) ?? "your Mac home folder"');
    expect(ledger).toContain(
      'return "Opens \\(backend.title) in \\(folder), in a new Terminal window on your Mac."',
    );
    expect(ledger).not.toContain('Text("The agent opens in a new Terminal window on your Mac.")');
  });

  test("the folder goes over the wire as cwd and a daemon refusal is shown in its own words", () => {
    expect(ledger).toContain("let cwd = resuming ? resumeSelection?.cwd : freshWorkingFolder");
    expect(ledger).toContain("cwd: cwd,");
    expect(bridge).toContain('message["cwd"] = workingDirectory');
    // The daemon looks and says so; the phone repeats it rather than
    // replacing it with a generic line.
    expect(readFileSync(join(repo, "src", "session-lifecycle.ts"), "utf8"))
      .toContain("session directory does not exist: ${cwd}");
    // Anchored on the session-start report line: closeSession has the same
    // shape, and a looser match would let this branch swallow the message.
    expect(bridge).toMatch(
      /reply\["kind"\] as\? String == "session-error",\s*let failure = reply\["error"\] as\? String \{\s*lastError = failure\s*_ = await reportAppError\(operation: "session-start", message: failure\)/,
    );
    expect(ledger).toContain('error = bridge.lastError ?? "Couldn\'t open that session in Terminal."');
  });

  test("Codex trust keeps working with a cwd, the way the Mac does it", () => {
    const macView = mac("ContentView.swift");

    // Bridge: the daemon's needs-trust reply is an outcome, not a failure,
    // and the answer goes back as trustFolder — only when the person said so.
    expect(bridge).toContain("case needsTrust(cwd: String)");
    expect(bridge).toContain('reply["kind"] as? String == "session-needs-trust"');
    expect(bridge).toContain("return .needsTrust(cwd: cwd)");
    expect(bridge).toContain("trustFolder: Bool = false");
    expect(bridge).toContain('if trustFolder {\n            message["trustFolder"] = true');

    // Sheet: Codex's own question with its own two options, then start again
    // with the trust for THAT folder — the same words the Mac shows.
    expect(ledger).toContain("case let .needsTrust(cwd):");
    expect(ledger).toContain("pendingTrust = cwd");
    expect(ledger).toContain("trustFolder: cwd.map(trustedFolders.contains) ?? false");
    for (const shared of [
      '"Do you trust this folder?"',
      'Button("Yes, continue")',
      'Button("No, cancel", role: .cancel)',
      "trustedFolders.insert(cwd)",
      '"higher risk of prompt injection. Trusting the directory allows "',
      '"conch will tell Codex this for this session only, and will not "',
    ]) {
      expect(ledger).toContain(shared);
      expect(macView).toContain(shared);
    }
    // Answering yes restarts; the trust set is consulted before the send.
    const yes = ledger.indexOf('Button("Yes, continue")');
    expect(yes).toBeGreaterThan(-1);
    const afterYes = ledger.slice(yes);
    expect(afterYes).toContain("trustedFolders.insert(cwd)");
    expect(afterYes.indexOf("trustedFolders.insert(cwd)")).toBeLessThan(afterYes.indexOf("start()"));
  });

  test("the roadmap row says what this slice is and is not", () => {
    const roadmap = readFileSync(join(repo, "docs", "roadmap.md"), "utf8");
    const row = roadmap.split("\n").find((line) => line.startsWith("| B7 |"));
    expect(row).toBeDefined();
    expect(row).toContain("~~");
    expect(row).toContain("done");
    expect(row).toMatch(/no folder browser/i);
  });
});
