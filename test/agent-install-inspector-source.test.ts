import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * conch-mac has no XCTest target, so the inspector's version/behind-install
 * behaviour is pinned here as SOURCE, the way `workspace-state-source.test.ts`
 * pins DashboardView.swift. Every assertion below is scoped to a slice (a
 * struct, a function, a call site), not a whole-file `toContain` — a
 * whole-file check keeps passing after the one line that matters is deleted.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const model = read("mac-app/conch-mac/AgentCapabilities.swift");
const inspector = read("mac-app/conch-mac/CapabilityInspectorView.swift");
const store = read("mac-app/conch-mac/StateStore.swift");
const socket = read("mac-app/conch-mac/ConchSocketClient.swift");
const palette = read("mac-app/conch-mac/CommandPaletteView.swift");

describe("AgentInstall: decoded exactly as the daemon publishes it", () => {
  test("the struct carries every field the wire guard requires, and nothing computed", () => {
    const at = model.indexOf("struct AgentInstall: Decodable, Equatable, Sendable {");
    expect(at).toBeGreaterThan(-1);
    const body = model.slice(at, model.indexOf("\n}", at));
    expect(body.length).toBeGreaterThan(300);
    for (const field of [
      "let backend: String",
      "let executable: String",
      "let version: String?",
      "let location: String",
      "let packageId: String?",
      "let updateCommand: String?",
      "let behind: Bool",
      "let newerVersion: String?",
    ]) expect(body).toContain(field);
  });

  test("the location label names the cask or package, but never fabricates one it wasn't given", () => {
    const at = model.indexOf("var locationLabel: String {");
    expect(at).toBeGreaterThan(-1);
    const body = model.slice(at, model.indexOf("\n}", at));
    expect(body).toContain('case "homebrew-cask": return packageId.map { "Homebrew cask · \\($0)" } ?? "Homebrew cask"');
    expect(body).toContain('case "npm-global": return packageId.map { "npm · \\($0)" } ?? "npm global"');
    expect(body).toContain('case "claude-desktop-app": return "the Claude desktop app"');
  });

  test("the socket reply and the store carry install alongside the capability inventory", () => {
    const at = socket.indexOf("struct ConchCapabilitiesReply: Decodable, Sendable {");
    expect(at).toBeGreaterThan(-1);
    expect(socket.slice(at, socket.indexOf("\n}", at))).toContain("let install: AgentInstall?");

    const funcAt = store.indexOf("func capabilities(");
    expect(funcAt).toBeGreaterThan(-1);
    const body = store.slice(funcAt, store.indexOf("\n    }", funcAt));
    expect(body).toContain("-> (capabilities: AgentCapabilities?, install: AgentInstall?)");
    expect(body).toContain("return (inventory, reply.install)");
  });
});

describe("the inspector shows the version and the update command, and is honest about scope", () => {
  test("the version row is skipped, never shown as 'unknown', when conch never captured the process identity", () => {
    const at = inspector.indexOf("var install: AgentInstall? = nil");
    expect(at).toBeGreaterThan(-1);
    const headerAt = inspector.indexOf("if let install {");
    expect(headerAt).toBeGreaterThan(-1);
    const body = inspector.slice(headerAt, inspector.indexOf("if let capabilities, !capabilities.complete {", headerAt));
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain('Text("Version")');
    expect(body).toContain('Text("\\(install.version ?? "unknown") · \\(install.locationLabel)")');
    expect(body).toContain("if install.behind {");
    expect(body).toContain("Text(behindNotice(install))");
  });

  test("the behind notice gives the exact command and says it applies to new sessions only", () => {
    const at = inspector.indexOf("private func behindNotice(_ install: AgentInstall) -> String {");
    expect(at).toBeGreaterThan(-1);
    const body = inspector.slice(at, inspector.indexOf("\n    }", at));
    expect(body.length).toBeGreaterThan(150);
    // Never runs it — only ever quoted into a string the person can select and paste.
    expect(body).not.toMatch(/Process\(\)|Bun\.spawn|shell\(/);
    expect(body).toContain('"Update it for new sessions with: \\(');
    expect(body).toContain('?? "It updates with the Claude app."');
    expect(body).toContain("This session keeps its own binary either way.");
  });

  test("the sheet fetches install alongside capabilities and threads it through, not a second unrelated request", () => {
    const sheetAt = inspector.indexOf("struct CapabilityInspectorSheet: View {");
    expect(sheetAt).toBeGreaterThan(-1);
    const body = inspector.slice(sheetAt);
    expect(body).toContain("@State private var install: AgentInstall?");
    expect(body).toContain("install: install,"); // passed into CapabilityInspectorView
    expect(body).toContain("capabilities = read.capabilities");
    expect(body).toContain("install = read.install");
  });

  test("the only other reader of store.capabilities (the command palette) still compiles against the tuple", () => {
    const at = palette.indexOf(".task(id: row?.id) {");
    expect(at).toBeGreaterThan(-1);
    const body = palette.slice(at, palette.indexOf("\n    }", at));
    expect(body).toContain("capabilities = await store.capabilities(");
    expect(body).toContain(").capabilities");
  });
});
