import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The strip's Terminal, in the Mac app: a BUTTON that brings the session's own terminal forward, and the Terminal Mirror
 * (the agent's terminal, view-only, beside conch's view of the conversation) kept as a debug view behind
 * Debug › Show Terminal Mirror.
 *
 * These read the Swift, since the Mac app has no test target. What the strip offers, when Screen Recording may be
 * asked, what the mirror shows for each answer and when it reads at all are ConchDesign's, tested there
 * (TerminalMirrorTests, TerminalScreenTests); the daemon's half is test/terminal-mirror.test.ts, and `conch parity`'s is
 * test/parity.test.ts.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Line comments stripped, so prose describing a rule can never satisfy a guard.
const swift = (path: string) => source(path).replace(/^\s*\/\/.*$/gm, "");
const mirror = swift("mac-app/conch-mac/TerminalMirror.swift");
const pane = swift("mac-app/conch-mac/DashboardView.swift");
const permissions = swift("mac-app/conch-mac/Permissions.swift");
const store = swift("mac-app/conch-mac/StateStore.swift");
const app = swift("mac-app/conch-mac/ConchMacApp.swift");
const content = swift("mac-app/conch-mac/ContentView.swift");
const snapshot = swift("mac-app/conch-mac/DebugSnapshot.swift");
const remote = swift("mac-app/conch-mac/RemoteMacViews.swift");
const project = source("mac-app/conch-mac.xcodeproj/project.pbxproj");

function at(text: string, marker: string, from = 0): number {
  const index = text.indexOf(marker, from);
  expect(index, `missing: ${marker}`).toBeGreaterThan(-1);
  return index;
}
function section(text: string, start: string, end: string): string {
  const a = at(text, start);
  return text.slice(a, at(text, end, a + start.length));
}

const tabs = () => section(pane, "private func deliverableTabs(", ".padding(.vertical, 5)");
const button = () => section(tabs(), "if strip.showsButton {", "if strip.showsMirror {");

describe("the Terminal button brings the real terminal forward, and does nothing else", () => {
  test("the always-available Mac header uses the strip's focus action for both the title and icon", () => {
    const header = section(pane, "private func sessionBar(for row: SessionRow)", "AgentBadge(backend: row.backend)");
    expect(header.split("if let location = row.location {").length - 1).toBe(2);
    expect(header.split("Button { store.openSessionLocation(row) }").length - 1).toBe(2);
    expect(header).toContain("Image(systemName: location.symbol)");
    expect(store).toContain("if location == .terminal { openAgentTerminal(row); return }");
    expect(store).toContain("SessionAppOpenRequest(sessionId: row.id)");
    expect(header).not.toContain("store.reveal(");
    expect(header).not.toContain("hasWorkTabs");
    expect(header).not.toContain("TerminalMirrorAsk");
  });

  test("the iPhone header waits for terminal-focus and displays refusal instead of accepting a reveal ack", () => {
    const phone = swift("mobile/conch-ios/conch-ios/SessionView.swift");
    const bridge = swift("mobile/conch-ios/conch-ios/BridgeClient.swift");
    const open = section(bridge, "func openAgentTerminal(sessionId: String)", "func setSessionSettings(");
    expect(open).toContain('"kind": "terminal-focus", "sessionId": sessionId');
    expect(open).toContain('reply["kind"] as? String == "terminal-focus"');
    expect(open).toContain('reply["sessionId"] as? String == sessionId');
    expect(open).toContain('reply["focused"] as? Bool == true');
    expect(open).toContain('reply["reason"] as? String');
    expect(open).not.toContain('"session-command"');
    expect(phone).toContain("if let row, let location = row.location {");
    expect(bridge).toContain("if location == .terminal { return await openAgentTerminal(sessionId: row.id) }");
    expect(phone).toContain("locationError = await bridge.openSessionLocation(row)");
    expect(phone).toContain("showingLocationError = locationError != nil");
    expect(phone).toContain('.alert("Couldn\'t open session location", isPresented: $showingLocationError)');
    expect(phone).not.toContain("sessionCommand: .reveal");
  });

  test("it is there only for a session with a terminal of its own: a known process, no reason it has none, not a subagent", () => {
    const has = section(mirror, "var hasAgentTerminal: Bool {", "\n    }");
    expect(has).toContain("revealable && noTerminal == nil && parentSessionId == nil");
    expect(pane).toContain("ConchTerminalStrip(hasTerminal: row.hasAgentTerminal, mirrorOn: showTerminalMirror)");
    expect(button()).toContain("TerminalButton {");
    expect(tabs().split("TerminalButton {").length - 1).toBe(1);
  });

  test("a press reveals: terminal-focus through the store, and the pane doesn't switch", () => {
    const reveal = section(button(), "case .reveal:", "case .openMirror:");
    expect(reveal).toContain("store.openAgentTerminal(row)");
    expect(reveal).not.toContain("workspace.show");
    expect(reveal).not.toContain("TerminalMirrorAsk");
    expect(reveal).not.toContain("showTerminalMirror");
    // Option decides, read at the press.
    expect(button()).toContain("switch strip.press(option: NSEvent.modifierFlags.contains(.option)) {");
  });

  test("the store sends terminal-focus on the press, only for a session with a terminal, and a refusal lands on the row", () => {
    const open = section(store, "func openAgentTerminal(_ row: SessionRow) {", "\n    func openInTerminal(");
    expect(open).toContain("guard row.hasAgentTerminal else { return }");
    expect(open).toContain("let request = ConchTerminalFocusRequest(sessionId: row.id)");
    expect(open).toContain("self?.rowMessages[row.id] = failure");
    expect(open).toContain("failure = reply.focused ? nil : (reply.reason ?? \"conch couldn't bring its terminal forward.\")");
    expect(open).not.toContain("ConchTerminalScreenRequest");
    // The one place in the app that brings a terminal forward this way.
    const everywhere = [mirror, pane, store, app, content].join("\n");
    expect(everywhere.split("ConchTerminalFocusRequest(sessionId:").length - 1).toBe(1);
  });

  test("it is a button: the ↗ that leads out of conch, never a selected tab", () => {
    const struct = section(pane, "private struct TerminalButton: View {", "\n}\n");
    expect(struct).toContain('Text("Terminal")');
    expect(struct).toContain('Image(systemName: "arrow.up.forward")');
    expect(struct).not.toContain("isSelected");
    expect(struct).not.toMatch(/Permission|perform\(|TerminalMirrorAsk/);
  });

  test("it sits after Files and Shell, ahead of the outputs", () => {
    expect(at(tabs(), "FilesTab(")).toBeLessThan(at(tabs(), "ShellTab("));
    expect(at(tabs(), "ShellTab(")).toBeLessThan(at(tabs(), "TerminalButton {"));
    expect(at(tabs(), "TerminalButton {")).toBeLessThan(at(tabs(), "TerminalMirrorTab("));
    expect(at(tabs(), "TerminalMirrorTab(")).toBeLessThan(at(tabs(), "ScrollView(.horizontal)"));
  });

  test("a remote Mac's session is drawn without a strip, so without either", () => {
    expect(remote).not.toContain("AgentTerminalPaneView");
    expect(remote).not.toContain("TerminalButton");
    expect(remote).not.toContain("TerminalMirrorTab");
  });

  test("the file is built", () => {
    expect(project).toContain("/* TerminalMirror.swift in Sources */ = {isa = PBXBuildFile;");
    expect(project.split("TerminalMirror.swift in Sources").length - 1).toBe(2);
  });
});

describe("the mirror is a debug view, off unless Debug › Show Terminal Mirror is on", () => {
  test("the setting: off by default, one key, a toggle in the Debug menu", () => {
    expect(mirror).toContain("static let key = ConchTerminalStrip.mirrorDefaultsKey");
    expect(pane).toContain("@AppStorage(TerminalMirrorDebug.key) private var showTerminalMirror = false");
    const toggle = section(mirror, "struct TerminalMirrorMenuToggle: View {", "\n}\n");
    expect(toggle).toContain("@AppStorage(TerminalMirrorDebug.key) private var isOn = false");
    expect(toggle).toContain('Toggle("Show Terminal Mirror", isOn: $isOn)');
    expect(section(app, 'CommandMenu("Debug") {', "\n            }")).toContain("TerminalMirrorMenuToggle()");
  });

  test("its tab is drawn, and a remembered choice of it honoured, only while it is on", () => {
    const guarded = section(tabs(), "if strip.showsMirror {", "\n                }");
    expect(guarded).toContain("TerminalMirrorTab(");
    expect(tabs().split("TerminalMirrorTab(").length - 1).toBe(1);
    const choose = section(pane, "private func workPane(for row: SessionRow) -> WorkPane {", "\n    private func changedFiles");
    expect(choose).toContain("if chosen == .terminal, strip.showsMirror { return .terminal }");
    expect(choose).toContain("return strip.showsMirror ? .terminal : .deliverable");
    expect(choose).not.toContain("row.hasAgentTerminal");
    // The work half opens for the mirror, never for the button.
    const work = section(pane, "private var hasWorkPane: Bool {", "\n    }");
    expect(work).toContain("focusedRow.map { terminalStrip(for: $0).showsMirror } == true");
    expect(work).not.toContain("hasAgentTerminal");
    expect(section(pane, "private func hasWorkTabs(for row: SessionRow) -> Bool {", "\n    }")).toContain("terminalStrip(for: row).places");
  });

  test("Option on the button is the other way in: it turns the view on and opens it", () => {
    const opened = section(button(), "case .openMirror:", "\n                    }");
    expect(opened).toContain("showTerminalMirror = true");
    expect(opened).toContain("TerminalMirrorAsk.mirrorOpened()");
    expect(opened).toContain("workspace.show(work: .terminal, for: row.id)");
  });

  test("the mirror's content is keyed on the session, and drawn nowhere else", () => {
    const work = section(pane, "private func workContent(for row: SessionRow) -> some View {", "\n    private var deliverables");
    expect(work).toContain("} else if workPane(for: row) == .terminal {");
    expect(work).toContain("AgentTerminalPaneView(row: row).id(row.id)");
    expect(pane.split("AgentTerminalPaneView(").length - 1).toBe(1);
  });

  test("its own Open in Terminal is the button's press", () => {
    const view = section(mirror, "struct AgentTerminalPaneView: View {", "\n    private var canOpen");
    expect(view).toContain("onOpen: canOpen ? { store.openAgentTerminal(row) } : nil,");
  });
});

describe("it reads nothing while it can't be seen", () => {
  test("the mirror's tab, the window and sleep all feed one gate, and the gate starts and stops everything", () => {
    const view = section(mirror, "struct AgentTerminalPaneView: View {", "\n    private var canOpen");
    expect(section(view, ".onAppear {", "\n        }")).toContain("mirror.set(tabShown: true)");
    expect(view).toContain(".onDisappear { mirror.set(tabShown: false) }");
    expect(view).toContain("mirror.set(windowVisible: visible)");
    expect(view).toContain("mirror.set(asleep: asleep)");
    const update = section(mirror, "private func update(_ change: (inout ConchTerminalMirrorGate) -> Void) {", "\n    }");
    expect(update).toContain("if gate.isLive { start() } else { stop() }");
  });

  test("stopping cancels the reads and ends the picture", () => {
    const stop = section(mirror, "private func stop() {", "\n    }");
    expect(stop).toContain("reading?.cancel()");
    expect(stop).toContain("reading = nil");
    expect(stop).toContain("stopPicture()");
    const stopPicture = section(mirror, "private func stopPicture() {", "\n    }");
    expect(stopPicture).toContain("stream?.stop()");
    expect(stopPicture).toContain("stream = nil");
    // A read the daemon answers after the tab was left changes nothing and starts nothing.
    const read = section(mirror, "private func read() async -> Duration {", "\n    private func show(");
    expect(at(read, "guard gate.isLive, !Task.isCancelled else { return .zero }")).toBeLessThan(at(read, "startPicture("));
    // Anything that isn't the picture ends it.
    expect(section(mirror, "private func show(_ next: ConchAgentTerminalState) -> Duration {", "\n    }"))
      .toContain("if !next.showsPicture { stopPicture() }");
  });

  test("conch's window hidden, minimised, covered or on another Space, and the Mac asleep, are all heard", () => {
    const probe = section(mirror, "struct TerminalMirrorVisibility: NSViewRepresentable {", "\nextension SessionRow {");
    expect(probe).toContain("NSWindow.didChangeOcclusionStateNotification");
    expect(probe).toContain("$0.isVisible && $0.occlusionState.contains(.visible)");
    for (const name of ["willSleepNotification", "didWakeNotification", "screensDidSleepNotification", "screensDidWakeNotification"]) {
      expect(probe).toContain(`NSWorkspace.${name}`);
    }
    // Observers go with the window, so a tab opened many times leaves none behind.
    expect(probe).toContain("sleepObservers.forEach(NSWorkspace.shared.notificationCenter.removeObserver)");
  });

  test("the picture is that one window, at a modest rate, as it arrives", () => {
    const stream = section(mirror, "final class TerminalWindowStream: NSObject {", "\nprivate final class TerminalFrameOutput");
    expect(stream).toContain("static let framesPerSecond: Int32 = 5");
    expect(stream).toContain("SCContentFilter(desktopIndependentWindow: window)");
    expect(stream).toContain("configuration.minimumFrameInterval = CMTime(value: 1, timescale: Self.framesPerSecond)");
    expect(stream).toContain("configuration.showsCursor = false");
    expect(stream).toContain("configuration.capturesAudio = false");
    // Complete frames only: an idle window sends none.
    expect(mirror).toContain("SCFrameStatus(rawValue: raw) == .complete");
    expect(mirror).toContain("view.layer?.contents = surface");
  });
});

describe("Screen Recording is asked only on the debug path: once, after a press that opened the mirror, through PermissionCenter", () => {
  test("only opening the mirror by hand arms the ask, and it asks only while the mirror is on", () => {
    // Its tab, and Option on the button: the two presses that open the mirror. The button's reveal never does.
    expect(section(tabs(), "if strip.showsMirror {", "\n                }")).toContain("TerminalMirrorAsk.mirrorOpened()");
    expect(pane.split("TerminalMirrorAsk.mirrorOpened()").length - 1).toBe(2);
    const ask = section(mirror, "enum TerminalMirrorAsk {", "\n}\n");
    expect(ask).toContain("private static var ask = ConchMirrorPermissionAsk()");
    expect(ask).toContain("static func shouldAsk() -> Bool { ask.shouldAsk(mirrorOn: TerminalMirrorDebug.isOn) }");
    // Nothing but the mirror's reader asks, and nothing on the button's path reaches it.
    expect([pane, store, app, content].join("\n")).not.toContain("TerminalMirrorAsk.shouldAsk()");
    expect(mirror.split("TerminalMirrorAsk.shouldAsk()").length - 1).toBe(1);
  });

  test("the ask is perform's .ask: macOS's own prompt and a fresh reading, never System Settings unasked", () => {
    const read = section(mirror, "private func read() async -> Duration {", "\n    private func show(");
    expect(read).toContain("TerminalMirrorAsk.shouldAsk()");
    expect(read).toContain("permission?(.ask)");
    const perform = section(permissions, "func perform(_ action: ConchPermissionAction, for permission: ConchPermission, store: StateStore) {", "\n    private func openSettings(");
    const asking = section(section(perform, "case .ask:", "case .reopen:"), "case .screenRecording:", "\n            }");
    expect(asking).toContain("_ = CanvasCapture.granted()");
    expect(asking).toContain("refresh(after: .seconds(1))");
    expect(asking).not.toContain("openSettings");
  });

  test("the tab's own button and the ask are the permission list's one door, for Screen Recording", () => {
    const view = section(mirror, "struct AgentTerminalPaneView: View {", "\n    private var canOpen");
    expect(view).toContain("PermissionCenter.shared.perform(action, for: .screenRecording, store: store)");
    expect(view).toContain("onPermission: permission,");
    expect(view).toContain("mirror.permission = permission");
    expect(mirror.split(".perform(").length - 1).toBe(1);
    // What the picture needs is this process's own grant.
    expect(section(mirror, "static func screenRecordingNow() -> ConchPermissionStatus {", "\n    }"))
      .toContain("if CGPreflightScreenCaptureAccess() { return .granted }");
  });
});

describe("only a press brings anything forward", () => {
  test("the mirror's reads never focus; the only terminal-focus is the store's, on a press", () => {
    const read = section(mirror, "private func read() async -> Duration {", "\n    private func show(");
    expect(read).toContain("ConchTerminalScreenRequest(sessionId: sessionId");
    expect(read).not.toContain("Focus");
    expect(mirror).not.toContain("ConchTerminalFocusRequest(sessionId:");
    // Nothing reads a terminal outside the mirror: the button, the store and the window never ask for a screen.
    expect([pane, store, app, content].join("\n")).not.toContain("ConchTerminalScreenRequest(");
  });
});

describe("conch parity's picture of conch: the app shows the session asked for, then photographs itself", () => {
  test("a select request is read and cleared, and shows the session the way picking its row does, a poll before the shot", () => {
    const pending = section(snapshot, "static func pendingSelection() -> String? {", "\n    }");
    expect(snapshot).toContain('static let selectRequestPath = "/tmp/conch-select.request"');
    expect(at(pending, "try? manager.removeItem(atPath: selectRequestPath)")).toBeLessThan(at(pending, "return wanted"));
    const poll = section(store, "if let wanted = DebugSnapshot.pendingSelection() {", "DebugSnapshot.serviceRequest()");
    expect(poll).toContain("NotificationCenter.default.post(name: .selectSessionFromStatusItem, object: wanted)");
  });

  test("the sidecar says which session the window shows", () => {
    expect(content).toContain(".onChange(of: workspace.viewing, initial: true) { _, id in DebugSnapshot.viewing = id }");
    expect(snapshot).toContain('"viewing": viewing ?? NSNull(),');
    const parity = readFileSync(new URL("../src/parity.ts", import.meta.url), "utf8");
    expect(parity).toContain('export const APP_SELECT_REQUEST = "/tmp/conch-select.request";');
    expect(parity).toContain('export const APP_SHOT_REQUEST = "/tmp/conch-shot.request";');
    expect(parity).toContain('.viewing ?? null');
  });
});
