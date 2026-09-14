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
  // The conversation is the menu's to show: the control bar has no conversation button (Tyler, 2026-09-14).
  const bar = member(components, "public var body: some View {\n        GlassPill(\"Voice controls\") {");
  expect(bar).toContain("TalkQuietSwitch(mode: $mode)");
  expect(bar).not.toContain("IconButton");
  expect(components).not.toContain("onConversation");
  expect(panels).not.toContain("conversationShown");
  // Turned on from the menu, the conversation opens full size rather than as its collapsed handle.
  const toggleConversation = member(item, "@objc private func toggleConversation() {");
  expect(toggleConversation).toContain("UserDefaults.standard.set(false, forKey: FloatingPanels.conversationCollapsedKey)");
  expect(toggleConversation.indexOf("UserDefaults.standard.set(false")).toBeLessThan(toggleConversation.indexOf("toggle(Self.showConversationKey)"));
});

/** Tyler: "easy to collapse and expand from larger to super minimal like nothing when closed". */
test("M3: the fog collapses to a small handle and opens again at the size it had", () => {
  expect(panels).toContain('static let conversationCollapsedKey = "conch.conversationCollapsed"');
  expect(member(panels, "private func showWhatIsOn() {")).toContain(
    "setCollapsed(defaults.bool(forKey: Self.conversationCollapsedKey))",
  );
  expect(member(panels, "func toggleCollapsed() {")).toContain(
    "UserDefaults.standard.set(!isCollapsed, forKey: Self.conversationCollapsedKey)",
  );
  const collapse = member(panels, "private func setCollapsed(_ collapsed: Bool) {");
  expect(collapse).toContain("if collapsed, isFullScreen { toggleFullScreen() }");
  expect(collapse).toContain("expandedFrame = fog.frame");
  expect(collapse).toContain("fog.setFrame(NSRect(x: x, y: y, width: side, height: side), display: true)");
  expect(collapse).toContain("fog.setFrame(expandedFrame, display: true)");
  // The handle sits in the fog's own corner.
  expect(collapse).toContain("let x = corner.leading ? expandedFrame.minX : expandedFrame.maxX - side");
  // The collapsed frame is never the one saved: autosave stops before it shrinks and resumes once it is open.
  expect(collapse.indexOf('fog.setFrameAutosaveName("")')).toBeGreaterThan(-1);
  expect(collapse.indexOf('fog.setFrameAutosaveName("")')).toBeLessThan(collapse.indexOf("width: side, height: side"));
  expect(collapse.indexOf("fog.setFrameAutosaveName(Self.conversationFrameName)")).toBeGreaterThan(collapse.indexOf("fog.setFrame(expandedFrame"));
  expect(collapse).toContain("fog.minSize = .zero");
  expect(collapse).toContain("fog.minSize = Self.fogMinSize");
  // The fog's button collapses it, and the handle opens it.
  expect(panels).toContain("FogHandle { panels.toggleCollapsed() }");
  expect(panels).toContain("onCollapse: { panels.toggleCollapsed() },");
  expect(member(components, "private var panelButtons: some View {")).toContain(
    'IconButton("chevron.down", label: "Collapse conversation", style: .glass, size: 30, action: onCollapse)',
  );
  expect(components).toContain("public struct FogHandle: View {");
  expect(components).toContain('.accessibilityLabel("Show conversation")');
});

test("M3: both panels keep their frames, and the fog goes full screen on Command-Return", () => {
  const place = member(panels, "private func place(");
  expect(place).toContain("if !panel.setFrameUsingName(name)");
  expect(place).toContain("panel.setFrameAutosaveName(name)");
  expect(panels).toContain("place(controlBar, name: Self.controlBarFrameName,");
  expect(panels).toContain("place(fog, name: Self.conversationFrameName,");
  expect(panels).toContain('static let controlBarFrameName = "conch.controlBar"');
  expect(panels).toContain('static let conversationFrameName = "conch.conversation"');

  const button = member(components, "private var panelButtons: some View {");
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
  expect(panels).toContain("blur.maskImage = Self.blurMask(corner)");
  expect(components).toContain(".font(Self.font(latest: age == 0, fullScreen: isFullScreen))");
  expect(member(components, "static func font(latest: Bool, fullScreen: Bool) -> Font {")).toContain(
    "case (true, true): ConchType.conversationNowFull",
  );
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

// M3: the panels are visible windows, so a Dock click must look for a window that can be main, or it
// would think conch is already showing and never bring the dashboard back.
test("M3: a Dock click still reopens the dashboard while the floating panels are showing", () => {
  const app = readFileSync(join(import.meta.dir, "..", "mac-app/conch-mac/ConchMacApp.swift"), "utf8");
  expect(app).toContain("if hasVisibleWindows, sender.windows.contains(where: { $0.isVisible && $0.canBecomeMain }) { return true }");
  expect(app).not.toContain("if hasVisibleWindows { return true }");
});

/**
 * Tyler: "revert and try a smart algo that reorients the version we had before as you drag around", and "we shouldn't
 * allow it to go outside the viewport it should just get smaller or something when pushed against edges".
 */
test("M3: the corner fog faces its nearest screen corner, and shrinks rather than leaving the screen", () => {
  const changed = member(panels, "private func fogChanged() {");
  expect(changed).toContain("let fitted = FogPlacement.fit(NSRect(origin: virtualOrigin, size: preferredSize), in: screen, minSize: Self.fogMinSize)");
  expect(changed).toContain("let next = FogCorner.nearest(to: fitted, in: screen, current: corner)");
  expect(changed).toContain("blur.maskImage = Self.blurMask(corner)");
  // The visible frame, so it stays clear of the menu bar and the Dock.
  expect(changed).toContain("?.visibleFrame");
  // A drag moves where the fog would be, so pulling it back from an edge grows it again.
  expect(changed).toContain("virtualOrigin.x += frame.minX - lastFrame.minX");
  expect(panels).toContain("for name in [NSWindow.didMoveNotification, NSWindow.didResizeNotification] {");
  expect(panels).toContain("corner: panels.corner,");
  // The corner fog again, pointed at a corner: no per-edge fading and no patch behind the words.
  expect(components).toContain("center: corner.unitPoint,");
  for (const gone of ["flush", "textBacking", "edgeFade"]) expect(components).not.toContain(gone);
  expect(panels).not.toContain("flush");
  // The transcript still ends in a short fade above the reply, not a cut.
  expect(components).toContain(
    "LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)\n                        .frame(height: ConchSpace.x4)",
  );
  // A temporary outline of the panel's real bounds while its behaviour is tuned.
  expect(panels).toContain("Rectangle().strokeBorder(Color.black, lineWidth: 1)");
});

/**
 * A visual effect view's mask shapes everything inside it. With the words inside the blur, the fog's mask faded the
 * words themselves, and collapsing (an empty mask) hid the handle: Tyler, "when i press the (v) it just disappears".
 */
test("M3: the blur sits behind the words as a sibling, so its mask never touches the words or the handle", () => {
  expect(panels).toContain("fog.contentView = container");
  expect(panels).toContain("for view in [blur, words] as [NSView] {");
  expect(panels).not.toContain("blur.addSubview");
  expect(panels).not.toContain("fog.contentView = blur");
  const collapse = member(panels, "private func setCollapsed(_ collapsed: Bool) {");
  expect(collapse).toContain("blur.isHidden = true");
  expect(collapse).toContain("blur.isHidden = false");
  expect(panels).not.toContain("noBlur");
});

/**
 * Tyler: "the text 'Quiet' is cutoff in the pill", "need to be able to scroll my reply text as it grows", and "make
 * the transcript area taller and wider if i want to".
 */
test("M3: the control bar fits what it shows, the reply scrolls past five lines, and a bigger fog gives the words room", () => {
  const fit = member(panels, "private func fitControlBar(to size: CGSize) {");
  expect(fit).toContain(
    "controlBar.setFrame(NSRect(x: frame.midX - size.width / 2, y: frame.maxY - size.height, width: size.width, height: size.height), display: true)",
  );
  expect(panels).toContain("ControlBarHost(store: store, onSize: { [weak self] size in self?.fitControlBar(to: size) })");
  expect(panels).toContain(".onPreferenceChange(ControlBarSize.self, perform: onSize)");
  expect(components).toContain("Text(option.title)\n                        .font(ConchType.uiEmphasis)\n                        .fixedSize()");
  expect(components).toContain(".lineLimit(1...5)");
  expect(member(components, "static func textFrame(in size: CGSize, corner: FogCorner, fullScreen: Bool) -> CGRect {")).toContain(
    "min(max(560, size.width * 0.66), 960, size.width - 2 * inset)",
  );
});
