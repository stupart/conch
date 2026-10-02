import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The iPhone does what the Mac app does, wherever a phone can: rename, restart, the command
 * palette, the capability inspector, Help with conch, the accounts, the reference panes and the
 * ledger's row menu. conch-ios has no XCTest target, so its wiring is pinned as source; the shared
 * rules (AgentCommands, CommandMatch, AgentCapabilities) are tested in ConchDesign.
 */
const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const ios = (name: string) => read(`mobile/conch-ios/conch-ios/${name}`);

const bridge = ios("BridgeClient.swift");
const models = ios("Models.swift");
const ledger = ios("LedgerView.swift");
const session = ios("SessionView.swift");
const settings = ios("SettingsView.swift");
const commands = ios("CommandsSheet.swift");
const inspector = ios("CapabilitiesSheet.swift");
const providers = ios("ProvidersView.swift");
const voices = ios("VoicesView.swift");
const project = read("mobile/conch-ios/conch-ios.xcodeproj/project.pbxproj");

function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  expect(a, `missing: ${start}`).toBeGreaterThan(-1);
  const b = text.indexOf(end, a + start.length);
  expect(b, `missing: ${end}`).toBeGreaterThan(-1);
  return text.slice(a, b);
}

describe("what the daemon can do is read at all", () => {
  test("features is decoded, so Background, Next and Help are offered where the Mac supports them", () => {
    // It was declared and never decoded: every daemon read as one without features.
    expect(models).toContain("case ownerDeviceId, deliveries, sessionSettings, naturalVoices, speechEngine, features");
    expect(models).toContain("features = try? c.decodeIfPresent(Features.self, forKey: .features)");
    expect(models).toContain("var helpSession: Int?");
  });

  test("rows carry the account, the prioritised mark and the voice", () => {
    expect(models).toContain("case revealable, claudeAccountId, codexAccountId, accountLabel, prioritized, voice");
    expect(models).toContain("accountLabel = try? c.decodeIfPresent(String.self, forKey: .accountLabel)");
    expect(models).toContain("prioritized = (try? c.decodeIfPresent(Bool.self, forKey: .prioritized)) ?? false");
  });
});

describe("the requests, as the Mac sends them", () => {
  test("rename is a session command with its label, acknowledged by id", () => {
    const rename = between(bridge, "func renameSession(sessionId: String, label: String) async -> Bool {", "\n    }\n");
    expect(rename).toContain('"kind": "session-command", "sessionId": sessionId, "command": "rename", "label": name,');
    expect(rename).toContain('reply["command"] as? String == "rename"');
  });

  test("restart is a clean close that resumes, and says what it couldn't carry over", () => {
    const restart = between(bridge, "func restartSession(sessionId: String) async -> [String]? {", "\n    }\n");
    expect(restart).toContain('["kind": "session-close", "sessionId": sessionId, "restart": true]');
    expect(restart).toContain('reply["kind"] as? String == "session-closed"');
    expect(restart).toContain('return reply["notCarriedOver"] as? [String] ?? []');
  });

  test("the inspector reads agent-capabilities and toggles through config-toggle with the preview's hash", () => {
    expect(bridge).toContain('var message: [String: Any] = ["kind": "agent-capabilities", "backend": backend, "cwd": cwd]');
    expect(bridge).toContain('"kind": "config-toggle", "agent": agent, "scope": scope, "capability": capability,');
    expect(bridge).toContain('if let expectBeforeHash { message["expectBeforeHash"] = expectBeforeHash }');
    expect(inspector).toContain("expectBeforeHash: preview ? nil : plan?.beforeHash");
    // The refusal is the daemon's own text.
    expect(inspector).toContain("case let .refused(reason):\n            // The daemon's own words");
  });

  test("settings reset unsets, and accounts use the Mac's provider actions", () => {
    expect(bridge).toContain('let reply = await postControlRaw(["kind": "unset-config", "key": key])');
    expect(settings).toContain('} else if setting.source != "default" {');
    expect(bridge).toContain('let kind = provider == .codex ? "codex-accounts" : "claude-accounts"');
    for (const action of ['run("refresh", id: account.id)', 'run("login", id: account.id', 'run("usage")', 'run("remove", id: account.id)', 'run("add", label:']) {
      expect(providers).toContain(action);
    }
  });

  test("Help with conch names no folder: the daemon resolves conch's own", () => {
    expect(bridge).toContain('message["help"] = true\n            message["cwd"] = nil');
    expect(ledger).toContain("guard !help || bridge.state?.features?.helpSession == 1 else { return false }");
    expect(ledger).toContain("help: help\n            )");
    // An open help session is opened rather than a second one started.
    expect(ledger).toContain('bridge.state?.rows.first { $0.label == "conch help" && $0.parentSessionId == nil }');
  });
});

describe("the surfaces", () => {
  test("the session menu has Commands, the inspector, Rename and Restart, behind a confirmation", () => {
    const menu = between(session, 'Button("Commands…", systemImage: "command")', 'Button("End session…"');
    expect(menu).toContain('Button("What this session carries…", systemImage: "shippingbox")');
    expect(menu).toContain('Button("Rename…", systemImage: "pencil")');
    expect(menu).toContain('Button("Restart session…", systemImage: "arrow.clockwise") { confirmingRestart = true }');
    expect(session).toContain('"Restart this session?",\n            isPresented: $confirmingRestart,');
  });

  test("Commands lists the shared slash commands and skills, and a typed line goes to the composer", () => {
    expect(commands).toContain("AgentCommands.slash(for: row.backend)");
    expect(commands).toContain("AgentCommands.skills(in: capabilities, backend: row.backend)");
    expect(commands).toContain("CommandMatch.rank(query, title: entry.title, detail: entry.detail)");
    // Typing needs a pane the daemon can reach, the Mac's rule.
    expect(commands).toContain("private var canType: Bool { row.parentSessionId == nil && row.revealable }");
    const perform = between(session, "private func perform(_ action: CommandsSheet.Action) {", "private func closeCleanly() {");
    expect(perform).toContain("talk.setDraft(");
    expect(perform).not.toContain("bridge.inject(");
  });

  test("the ledger: a row menu, folders that fold, the prioritised mark and Ready for you", () => {
    expect(ledger).toContain(".contextMenu { if row.parentSessionId == nil { rowMenu(row, everythingQuiet: state.mode.paused) } }");
    expect(ledger).toContain('@AppStorage("conch.collapsedFolders") private var collapsedFolders = ""');
    expect(ledger).toContain('Image(systemName: "diamond.fill")');
    expect(ledger).toContain(".filter { StatusMark(row: $0) == .review }");
    expect(ledger).toContain("ReviewSheet(bridge: bridge, talk: talk, sessionId: ready.id)");
  });

  test("settings reach Providers, Voices & agents and the legend", () => {
    expect(settings).toContain("ProvidersView(bridge: bridge)");
    expect(settings).toContain("VoicesView(bridge: bridge)");
    expect(settings).toContain("MarksLegendView()");
    expect(voices).toContain("SessionSettingsPresentation.defaultsLine(defaults)");
  });

  test("every new file is in the app target", () => {
    for (const file of ["CommandsSheet.swift", "CapabilitiesSheet.swift", "ProvidersView.swift", "VoicesView.swift"]) {
      expect(project.match(new RegExp(`/\\* ${file.replace(".", "\\.")} in Sources \\*/,`, "g"))?.length).toBe(1);
      expect(project).toContain(`/* ${file} */ = {isa = PBXFileReference;`);
    }
  });
});

test("a stopped dev server: the phone asks its session in the Mac's own words", () => {
  const sheet = ios("DeliverableSheet.swift");
  const mac = read("mac-app/conch-mac/ReviewView.swift");
  const sentence = (text: string) => {
    const at = text.indexOf("static func startServerPrompt(_ page: URL) -> String {");
    expect(at).toBeGreaterThan(-1);
    return text.slice(at).split("\n")[1].trim();
  };
  expect(sentence(sheet)).toBe(sentence(mac));
  expect(sheet).toContain('Button("Ask \\(row.label) to start it") { askToStart(url, row: row) }');
  expect(sheet).toContain("if reason.hasPrefix(BridgeClient.devServerStopped), case let .macLocal(url) = kind,");
  expect(bridge).toContain("case BridgeTransportError.httpStatus(503):\n            devServerStopped");
});
