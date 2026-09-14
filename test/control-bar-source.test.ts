import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** A Swift member from its signature to its closing brace at four-space indentation. */
function member(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf("\n    }\n", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const panels = read("mac-app/conch-mac/FloatingPanels.swift");
const components = read("design/ConchDesign/Sources/ConchDesign/Components.swift");
const item = read("mac-app/conch-mac/StatusItem.swift");
const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");

/**
 * M3: the control bar and the conversation fog float over whatever Tyler is doing. Clicking either must
 * never make conch the active app, and they follow him across spaces without joining Command-`.
 */
test("M3: both panels are non-activating NSPanels on every space, out of the window cycle", () => {
  expect(panels).toContain("final class FloatingPanel: NSPanel {");
  expect(panels).toContain(
    "private let controlBar = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)",
  );
  expect(panels).toContain(
    "private let fog = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel, .resizable], backing: .buffered, defer: true)",
  );
  const setup = panels.slice(panels.indexOf("for panel in [controlBar, fog] {"), panels.indexOf("let bar = FirstClickHostingView"));
  expect(setup).toContain("panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]");
  expect(setup).toContain("panel.level = .floating");
  expect(setup).toContain("panel.hidesOnDeactivate = false");
  expect(setup).toContain("panel.isMovableByWindowBackground = true");
  // Only the fog takes the keys, and only when its reply field is clicked.
  expect(panels).toContain("var takesKeys = false");
  expect(panels).toContain("override var canBecomeKey: Bool { takesKeys }");
  expect(panels.match(/\.takesKeys = true/g)?.length).toBe(1);
  expect(panels).toContain("fog.takesKeys = true");
  expect(panels).toContain("fog.becomesKeyOnlyIfNeeded = true");
  // Shown without activating conch; nothing here brings conch forward.
  expect(panels).toContain("if on { panel.orderFrontRegardless() } else { panel.orderOut(nil) }");
  for (const intrusion of ["NSApp.activate", "makeKeyAndOrderFront", "makeKey()"]) {
    expect(panels).not.toContain(intrusion);
  }
  expect(project).toContain("/* FloatingPanels.swift in Sources */ = {isa = PBXBuildFile;");
  expect(project.match(/\/\* FloatingPanels\.swift in Sources \*\/,/g)?.length).toBe(1);
});

test("M3: Show control bar and Show conversation drive the panels, live", () => {
  expect(member(item, "static func install(store: StateStore) {")).toContain("FloatingPanels.install(store: store)");
  expect(item).not.toContain("not built yet");
  expect(panels).toContain("forName: UserDefaults.didChangeNotification");
  const shows = member(panels, "private func showWhatIsOn() {");
  expect(shows).toContain("show(controlBar, defaults.bool(forKey: ConchStatusItem.showControlBarKey))");
  expect(shows).toContain("show(fog, defaults.bool(forKey: ConchStatusItem.showConversationKey))");
  // The control bar's conversation button flips the same default as the menu.
  expect(panels).toContain("@AppStorage(ConchStatusItem.showConversationKey) private var conversationShown = false");
  expect(panels).toContain("onConversation: { conversationShown.toggle() }");
});

test("M3: both panels keep their frames, and the fog goes full screen on Command-Return", () => {
  const place = member(panels, "private func place(");
  expect(place).toContain("if !panel.setFrameUsingName(name)");
  expect(place).toContain("panel.setFrameAutosaveName(name)");
  expect(panels).toContain("place(controlBar, name: Self.controlBarFrameName,");
  expect(panels).toContain("place(fog, name: Self.conversationFrameName,");
  expect(panels).toContain('static let controlBarFrameName = "conch.controlBar"');
  expect(panels).toContain('static let conversationFrameName = "conch.conversation"');

  const button = member(components, "private var fullScreenButton: some View {");
  expect(button).toContain("action: onFullScreen");
  expect(button).toContain(".keyboardShortcut(.return, modifiers: .command)");
  expect(panels).toContain("onFullScreen: { panels.toggleFullScreen() }");
  const toggle = member(panels, "func toggleFullScreen() {");
  expect(toggle).toContain("frameBeforeFullScreen = fog.frame");
  expect(toggle).toContain("fog.setFrame(screen.frame, display: true, animate: animate)");
  // Leaving restores the frame it had.
  expect(toggle).toContain("fog.setFrame(frame, display: true, animate: animate)");
  expect(toggle).toContain("NSWorkspace.shared.accessibilityDisplayShouldReduceMotion");
  // A full-screen frame is never the one saved.
  expect(toggle.indexOf('fog.setFrameAutosaveName("")')).toBeGreaterThan(-1);
  expect(toggle.indexOf('fog.setFrameAutosaveName("")')).toBeLessThan(toggle.indexOf("fog.setFrame(screen.frame"));
});

test("M3: the fog replies through inject and dictates through the composer's dictate", () => {
  const send = member(panels, "private func send(_ row: SessionRow) {");
  expect(send).toContain("store.send(.inject(sessionId: row.id, label: row.label, text: text))");
  expect(read("mac-app/conch-mac/ConchSocketClient.swift")).toContain(
    "Self(type: .inject, sessionId: sessionId, label: label, announce: text, awaitDelivery: true)",
  );
  const mic = member(panels, "private func mic(_ row: SessionRow) {");
  expect(mic).toContain("store.send(.dictate(sessionId: row.id, label: row.label))");
  expect(mic).toContain("store.send(.stop())");
  expect(panels).toContain("onMic: { if let row { mic(row) } }");
  expect(panels).toContain("onSend: { if let row { send(row) } }");
  // The spoken words come back into the same shared draft, once.
  expect(panels).toContain("drafts.apply(store.state?.live.dictated)");
  expect(panels).toContain("@ObservedObject private var drafts = ComposerDraftStore.shared");
  // A fog, not a pane: the fog tint, and a behind-window blur masked to the corner.
  expect(components).toContain(".fill(ConchColor.fog)");
  expect(panels).toContain("blur.blendingMode = .behindWindow");
  expect(panels).toContain("blur.maskImage = Self.cornerMask");
  expect(components).toContain(".font(age == 0 ? ConchType.conversationNow : ConchType.conversationPast)");
});

test("M3: the control bar's Talk and Quiet are the daemon's global resume and pause", () => {
  expect(panels).toContain("get: { store.state?.mode.paused == true ? .quiet : .talk }");
  expect(panels).toContain("set: { store.send($0 == .talk ? .global(.resume) : .global(.pause)) }");
  expect(item).toContain("@objc private func talk() { store.send(.global(.resume)) }");
  expect(item).toContain("@objc private func quietMode() { store.send(.global(.pause)) }");
});

test("M3: Ready is its own orb, the ready colour with a white checkmark", () => {
  expect(components).toContain(
    'case .ready:\n                Circle().fill(ConchColor.ready)\n                Image(systemName: "checkmark")',
  );
  expect(components).not.toContain("case .talk, .ready:");
});

/**
 * macOS 26 draws status items in Control Center, and the live app never logged its visibility. AppKit still
 * gives the button a stand-in window whose occlusion reports a hide, but it may not exist at install.
 */
test("the menu bar watcher attaches again after the delay, and says so once if it never can", () => {
  const watch = member(item, "private func watchOcclusion() {");
  expect(watch.match(/attachOcclusionObserver\(\)/g)?.length).toBe(2);
  expect(watch.indexOf("try? await Task.sleep(for: .seconds(3))")).toBeLessThan(watch.lastIndexOf("attachOcclusionObserver()"));
  expect(watch).toContain('NSLog("conch: cannot watch the menu bar item');
  expect(watch).not.toContain("guard let window");
  expect(member(item, "private func attachOcclusionObserver() {")).toContain(
    "forName: NSWindow.didChangeOcclusionStateNotification",
  );
});
