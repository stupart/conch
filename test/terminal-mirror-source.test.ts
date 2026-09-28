import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The Terminal tab's app wiring: the agent's own terminal, view-only, beside conch's view of the conversation.
 *
 * These read the Swift, since the Mac app has no test target. What the tab shows for each answer, the ANSI screen and
 * when it reads at all are ConchDesign's, tested there (TerminalScreenTests, TerminalMirrorTests); the daemon's half is
 * test/terminal-mirror.test.ts.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Line comments stripped, so prose describing a rule can never satisfy a guard.
const swift = (path: string) => source(path).replace(/^\s*\/\/.*$/gm, "");
const mirror = swift("mac-app/conch-mac/TerminalMirror.swift");
const pane = swift("mac-app/conch-mac/DashboardView.swift");
const permissions = swift("mac-app/conch-mac/Permissions.swift");
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

describe("the tab is there only when there is a terminal to show", () => {
  test("a known process, no reason it has none, and not a subagent", () => {
    const has = section(mirror, "var hasAgentTerminal: Bool {", "\n    }");
    expect(has).toContain("revealable && noTerminal == nil && parentSessionId == nil");
  });

  test("the strip draws it only then, and the pane falls back when there isn't one", () => {
    const tabs = section(pane, "private func deliverableTabs(", ".padding(.vertical, 5)");
    const guarded = section(tabs, "if row.hasAgentTerminal {", "\n                }");
    expect(guarded).toContain("TerminalTab(");
    expect(tabs.split("TerminalTab(").length - 1).toBe(1);
    const choose = section(pane, "private func workPane(for row: SessionRow) -> WorkPane {", "\n    private func changedFiles");
    expect(choose).toContain("if chosen == .terminal, row.hasAgentTerminal { return .terminal }");
    // Remembered as open, but this session has none: the other contents, never an empty tab.
    expect(choose).toContain("return row.hasAgentTerminal ? .terminal : .deliverable");
  });

  test("a session with only a terminal still gets the work half and its tabs", () => {
    expect(pane).toContain("private var hasWorkPane: Bool { selectedReview != nil || workingFolder != nil || focusedRow?.hasAgentTerminal == true }");
    const tabs = section(pane, "private func hasWorkTabs(for row: SessionRow) -> Bool {", "\n    }");
    expect(tabs).toContain("(row.hasAgentTerminal ? 1 : 0)");
  });

  test("a remote Mac's session is drawn without tabs, so without this one", () => {
    expect(remote).not.toContain("AgentTerminalPaneView");
    expect(remote).not.toContain("TerminalTab");
  });

  test("the tab's content is keyed on the session", () => {
    const content = section(pane, "private func workContent(for row: SessionRow) -> some View {", "\n    private var deliverables");
    expect(content).toContain("AgentTerminalPaneView(row: row).id(row.id)");
  });

  test("it is called Terminal and sits after Files and Shell, ahead of the outputs", () => {
    const tabs = section(pane, "private func deliverableTabs(", ".padding(.vertical, 5)");
    expect(at(tabs, "FilesTab(")).toBeLessThan(at(tabs, "ShellTab("));
    expect(at(tabs, "ShellTab(")).toBeLessThan(at(tabs, "TerminalTab("));
    expect(at(tabs, "TerminalTab(")).toBeLessThan(at(tabs, "ScrollView(.horizontal)"));
    const tab = section(pane, "private struct TerminalTab: View {", "\n}\n");
    expect(tab).toContain('Text("Terminal")');
    expect(tab).toContain('Image(systemName: "terminal")');
  });

  test("the new file is built", () => {
    expect(project).toContain("/* TerminalMirror.swift in Sources */ = {isa = PBXBuildFile;");
    expect(project.split("TerminalMirror.swift in Sources").length - 1).toBe(2);
  });
});

describe("it reads nothing while it can't be seen", () => {
  test("the tab, the window and sleep all feed one gate, and the gate starts and stops everything", () => {
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

describe("Screen Recording is asked for once, after a press, through PermissionCenter", () => {
  test("only a press on the tab arms the ask, and it is spent once", () => {
    const tabs = section(pane, "private func deliverableTabs(", ".padding(.vertical, 5)");
    expect(tabs).toContain("TerminalMirrorAsk.tabPressed()");
    expect(pane.split("TerminalMirrorAsk.tabPressed()").length - 1).toBe(1);
    const ask = section(mirror, "enum TerminalMirrorAsk {", "\n}\n");
    expect(ask).toContain("guard pressed, !asked else { return false }");
    expect(ask).toContain("asked = true");
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

describe("Open in Terminal is the only thing that brings anything forward", () => {
  test("a press sends terminal-focus; a read never does", () => {
    const open = section(mirror, "func open() {", "\n    private func showOpenFailure");
    expect(open).toContain("ConchTerminalFocusRequest(sessionId: sessionId)");
    const read = section(mirror, "private func read() async -> Duration {", "\n    private func show(");
    expect(read).toContain("ConchTerminalScreenRequest(sessionId: sessionId");
    expect(read).not.toContain("Focus");
    expect(mirror.split("ConchTerminalFocusRequest(sessionId:").length - 1).toBe(1);
  });
});
