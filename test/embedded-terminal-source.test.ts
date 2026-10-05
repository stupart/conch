import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Terminal tab of a session conch hosts, and "Run in conch", as source: conch-mac has no XCTest target. What the
// strip, the work half, the client and the sheet DECIDE is ConchDesign's and XCTested (EmbeddedTerminalTests); these
// pin that the app asks it, and wires what it answers.

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
/** Swift with its `//` comments taken out, so a guard reads code, never prose about it. */
const swift = (path: string) => read(path).replace(/^\s*\/\/.*$/gm, "");

const terminal = swift("mac-app/conch-mac/EmbeddedTerminal.swift");
const dashboard = swift("mac-app/conch-mac/DashboardView.swift");
const content = swift("mac-app/conch-mac/ContentView.swift");
const store = swift("mac-app/conch-mac/StateStore.swift");
const monitor = swift("mac-app/conch-mac/DashboardInputMonitor.swift");
const models = swift("mac-app/conch-mac/Models.swift");
const socket = swift("mac-app/conch-mac/ConchSocketClient.swift");
const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");

function at(text: string, marker: string, from = 0): number {
  const index = text.indexOf(marker, from);
  expect(index, `missing: ${marker}`).toBeGreaterThan(-1);
  return index;
}
function section(text: string, start: string, end: string): string {
  const a = at(text, start);
  return text.slice(a, at(text, end, a + start.length));
}

describe("SwiftTerm, pinned", () => {
  test("the app's one outside Swift package, at an exact version, linked into the app", () => {
    const reference = section(project, 'XCRemoteSwiftPackageReference "SwiftTerm" */ = {', "};\n");
    expect(reference).toContain('repositoryURL = "https://github.com/migueldeicaza/SwiftTerm";');
    expect(reference).toContain("kind = exactVersion;");
    expect(reference).toContain("version = 1.11.2;");
    expect(project.match(/isa = XCRemoteSwiftPackageReference;/g) ?? []).toHaveLength(1);
    expect(project).toContain("productName = SwiftTerm;");
    expect(project).toContain("F10000000000000000000E02 /* SwiftTerm in Frameworks */,");
  });

  test("its resolution is committed, so a build after the first resolve needs no network", () => {
    const resolved = JSON.parse(read("mac-app/conch-mac.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"));
    const pin = resolved.pins.find((entry: { identity: string }) => entry.identity === "swiftterm");
    expect(pin.state).toEqual({ revision: "b1262db5b6bea699a8260a8c66999436c508ca56", version: "1.11.2" });
  });

  test("its MIT licence and a notice ship in Resources/ThirdParty/SwiftTerm, and the bundle check looks for them", () => {
    const licence = read("mac-app/third-party/SwiftTerm/LICENSE");
    expect(licence).toContain("Miguel de Icaza");
    expect(licence).toContain("Permission is hereby granted, free of charge");
    expect(read("mac-app/third-party/SwiftTerm/NOTICE")).toContain("SwiftTerm 1.11.2");
    const embed = read("scripts/embed-notices.sh");
    expect(embed).toContain('for package in SwiftTerm; do');
    expect(embed).toContain('"$RESOURCES/ThirdParty/$package/"');
    expect(project).toContain('shellScript = "exec \\"$SRCROOT/../scripts/embed-notices.sh\\"\\n";');
    expect(project).toContain("AC0000000000000000000005 /* Embed package notices */,");
    expect(read("scripts/check-app-bundle.sh")).toContain("ThirdParty/SwiftTerm/LICENSE ThirdParty/SwiftTerm/NOTICE");
  });

  test("the new source is in the project four times: file, build file, group, Sources", () => {
    expect(project.split("EmbeddedTerminal.swift").length - 1).toBe(4 + 2);
    expect(project).toContain("F10000000000000000000E01 /* EmbeddedTerminal.swift in Sources */,");
  });
});

describe("the Terminal tab of a session conch hosts", () => {
  test("the row decodes where it runs, and only a shape conch makes is attached to", () => {
    expect(models).toContain("hosted = try? container.decodeIfPresent(ConchHostedTerminal.self, forKey: .hosted)");
    const usable = section(terminal, "var hostedTerminal: ConchHostedTerminal? {", "\n    }");
    expect(usable).toContain("guard parentSessionId == nil, let hosted, hosted.isUsable else { return nil }");
  });

  test("its Terminal is a tab, the session itself; every other session keeps the button", () => {
    expect(dashboard).toContain("ConchTerminalStrip(hasTerminal: row.hasAgentTerminal, mirrorOn: showTerminalMirror, hosted: row.hostedTerminal != nil)");
    const tabs = section(dashboard, "private func deliverableTabs(", ".padding(.vertical, 5)");
    const tab = section(tabs, "if strip.showsEmbedded {", "if strip.showsButton {");
    expect(tab).toContain("HostedTerminalTab(");
    expect(tab).toContain("isSelected: workPane(for: row) == .embeddedTerminal,");
    expect(tab).toContain("action: { workspace.show(work: .embeddedTerminal, for: row.id) }");
  });

  test("the work half draws it, keyed on the session, so leaving the session takes the client down", () => {
    const work = section(dashboard, "private func workContent(for row: SessionRow) -> some View {", "\n    private var deliverables");
    expect(work).toContain("} else if workPane(for: row) == .embeddedTerminal, let hosted = row.hostedTerminal {");
    expect(work).toContain("HostedTerminalPane(row: row, hosted: hosted).id(row.id)");
    expect(dashboard.split("HostedTerminalPane(").length - 1).toBe(1);
  });

  test("switchable with the conversation: the title opens it beside the conversation", () => {
    const bar = section(dashboard, "private func sessionBar(for row: SessionRow) -> some View {", "AgentBadge(backend: row.backend)");
    expect(bar).toContain("if row.hostedTerminal != nil {");
    expect(bar).toContain("Button { showHostedTerminal(row) } label: { sessionTitle(row) }");
    const show = section(dashboard, "private func showHostedTerminal(_ row: SessionRow) {", "\n    }");
    expect(show).toContain("workspace.show(work: .embeddedTerminal, for: row.id)");
  });

  test("detach on hide: taking the view down ends the client, and ending it is a detach", () => {
    const representable = section(terminal, "struct HostedTerminalView: NSViewRepresentable {", "\n}\n");
    expect(representable).toContain("static func dismantleNSView(_ view: ConchTmuxTerminalView, coordinator: ()) {\n        view.detach()");
    const detach = section(terminal, "func detach() {", "\n    }");
    expect(detach).toContain("detaching = true");
    expect(detach).toContain("if process?.running == true { terminate() }");
    // A detach conch made is not reported as the session going away.
    expect(section(terminal, "fileprivate func clientExited(_ exitCode: Int32?) {", "\n    }")).toContain("guard !detaching else { return }");
  });

  test("the client attaches with ConchDesign's arguments (ignore-size) and environment (UTF-8), with the server's tmux", () => {
    const attach = section(terminal, "func attach(to hosted: ConchHostedTerminal) {", "\n    }\n");
    expect(attach).toContain("guard hosted.isUsable else {");
    expect(attach).toContain("ConchHostedTerminal.binary(");
    expect(attach).toContain("published: hosted.tmux,");
    expect(attach).toContain("args: hosted.attachArguments,");
    expect(attach).toContain("ConchHostedTerminal.clientEnvironment(ProcessInfo.processInfo.environment)");
  });

  test("SF Mono, conch's colours, redrawn only when the appearance changes", () => {
    expect(terminal).toContain("font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)");
    const apply = section(terminal, "func apply(_ scheme: ColorScheme) {", "\n    }");
    expect(apply).toContain("guard scheme != appliedScheme else { return }");
    expect(apply).toContain("let theme = ConchEmbeddedTerminalColors.theme(scheme)");
    expect(apply).toContain("installColors(theme.ansi.map(\\.terminalColor))");
  });
});

describe("keys: the TUI's while you type in it", () => {
  const moved = () => section(terminal, "override func viewDidMoveToWindow() {", "\n    }\n");

  test("focus goes inside as the tab opens", () => {
    expect(moved()).toContain("window.makeFirstResponder(self)");
  });

  test("every key but Command's goes to the terminal, ahead of conch's own shortcuts", () => {
    const keys = moved();
    const mine = at(keys, "window.firstResponder === self else { return event }");
    const menus = at(keys, "if event.modifierFlags.contains(.command) { return event }");
    const typed = at(keys, "self.keyDown(with: event)\n            return nil");
    expect(mine).toBeLessThan(menus);
    expect(menus).toBeLessThan(typed);
  });

  test("Shift-Return is CSI u, from ConchDesign, sent before anything else sees it", () => {
    const keys = moved();
    const shift = at(keys, "if let bytes = ConchTerminalKeys.bytes(");
    expect(keys).toContain("self.send(bytes)\n                return nil");
    expect(shift).toBeLessThan(at(keys, "self.keyDown(with: event)"));
  });

  test("the dashboard's one-key shortcuts (Space, Esc, P, R, arrows) leave a terminal's keys alone", () => {
    expect(terminal).toContain("final class ConchTmuxTerminalView: LocalProcessTerminalView, ConchOwnsKeyboard {");
    const handler = section(monitor, "keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {", "\n            }\n        }");
    const owned = at(handler, "if firstResponderOwnsKeyboard() {\n                    return event\n                }");
    expect(owned).toBeLessThan(at(handler, "return onKey(key) ? nil : event"));
    expect(section(monitor, "private func firstResponderOwnsKeyboard() -> Bool {", "\n        }")).toContain("is ConchOwnsKeyboard");
  });

  test("Cmd-V pastes text, and an image alone as Claude Code's own Ctrl-V", () => {
    const paste = section(terminal, "override func paste(_ sender: Any) {", "\n    }\n");
    expect(paste).toContain("switch ConchTerminalKeys.paste(hasText: hasText, hasImage: hasImage) {");
    expect(paste).toContain("case .text: super.paste(sender)");
    expect(paste).toContain("case .image: send(ConchTerminalKeys.imagePaste)");
  });
});

describe("Open in Terminal, and delivery that raises nothing", () => {
  test("the tab's bar offers it, and it attaches a Terminal window to the same session", () => {
    expect(section(terminal, "private var bar: some View {", "\n    }\n")).toContain("Button { store.openInTerminal(row) } label: {");
    const open = section(store, "func openInTerminal(_ row: SessionRow) {", "\n    }\n");
    expect(open).toContain("guard row.attachable || row.hosted != nil else { return }");
    expect(open).toContain("ConchSessionCommandRequest(sessionId: row.id, command: .attach)");
  });

  test("a send to a hosted session holds nothing still and hands nothing back (#446's steering)", () => {
    const send = section(store, "func send(_ event: ConchDaemonEvent, overApp: Bool = false) -> Task<Bool, Never> {", "let task = Task {");
    expect(send).toContain("let refocus = event.awaitDelivery == true && NSApp.isActive && !deliversWithoutRaising(event.sessionId)");
    expect(send).toContain("let steer = refocus ? ComposerDock.shared.beginSteering() : nil");
  });
});

describe("the New session sheet: where it runs", () => {
  const sheet = section(content, "private struct StartSessionSheet: View {", "private struct QuietToast: Equatable {");

  test("In Terminal until the setting says otherwise, and a pick is never overwritten", () => {
    expect(sheet).toContain("@State private var host = SessionStartHost.terminal");
    const seeded = section(sheet, "let runInConch = await store.runInConchDefault()", "\n");
    expect(sheet).toContain("if !hostPicked { host = SessionStartHost.initial(runInConch: runInConch) }");
    expect(seeded.length).toBeGreaterThan(10);
    // Three places set it, and only three: the declaration, the person's pick (which marks it picked), and the seed,
    // which a pick stops.
    expect(sheet.split("host = ").length - 1).toBe(3);
    expect(sheet).toContain("set: { host = $0; hostPicked = true }");
    expect(sheet).toContain("Picker(\"Run\", selection: Binding(get: { host }, set: { host = $0; hostPicked = true })) {");
    expect(sheet).toContain("ForEach(SessionStartHost.allCases) { place in");
  });

  test("the choice is sent, except for a teleport, which is Claude's own Terminal handoff", () => {
    expect(sheet).toContain("host: mode == .teleport ? nil : host");
    expect(sheet).toContain("if mode != .teleport {");
    expect(store).toContain("host: teleport == nil ? host : nil");
    expect(socket).toContain("self.host = host?.rawValue");
  });

  test("a start In conch that hasn't checked in can be shown and answered from the sheet", () => {
    expect(sheet).toContain("case let .started(hosted):\n                startedHosted = hosted");
    const shown = section(sheet, "if let startedHosted, error != nil {", "\n            }\n");
    expect(shown).toContain("HostedTerminalView(hosted: startedHosted, scheme: colorScheme)");
  });

  test("Settings names the default plainly", () => {
    expect(read("mac-app/conch-mac/SettingsView.swift")).toContain('"run-in-conch": "Run new sessions in conch",');
  });
});
