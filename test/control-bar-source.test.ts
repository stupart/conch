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
    "private let fog = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)",
  );
  expect(panels).toContain("fog.isMovableByWindowBackground = false");
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
  // Collapsed, a hover area in its corner clear of the Dock and the menu bar; opened, docked again at its size.
  expect(collapse).toContain("fog.setFrame(FogDock.frame(size: CGSize(width: side, height: side), corner: corner, in: screen.visibleFrame), display: true)");
  expect(collapse).toContain("dock(corner, on: screen, velocity: .zero, animated: false)");
  // The collapsed frame is never the one saved: autosave stops before it shrinks and resumes once it is open.
  expect(collapse.indexOf('fog.setFrameAutosaveName("")')).toBeGreaterThan(-1);
  expect(collapse.indexOf('fog.setFrameAutosaveName("")')).toBeLessThan(collapse.indexOf("width: side, height: side"));
  expect(collapse.indexOf("fog.setFrameAutosaveName(Self.conversationFrameName)")).toBeGreaterThan(collapse.indexOf("dock(corner, on: screen"));
  // The fog's button collapses it; hovering its corner shows the caret that opens it (Tyler: "only shows when your
  // hovering in that area"), tracked by the panel's own view so it works while conch is in the background.
  expect(panels).toContain("FogHandle(corner: panels.corner, hovering: panels.hovering) { panels.toggleCollapsed() }");
  expect(panels).toContain("onCollapse: { panels.toggleCollapsed() },");
  const buttons = components.slice(components.indexOf("public struct FogPanelButtons: View {"), components.indexOf("// MARK: - FogHandle"));
  expect(buttons).toContain('label: "Collapse conversation",');
  expect(components).toContain("public struct FogHandle: View {");
  expect(components).toContain(".opacity(hovering ? 1 : 0)");
  expect(components).toContain('.accessibilityLabel("Show conversation")');
  expect(panels).toContain("options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect]");
});

test("M3: both panels keep their frames, and the fog goes full screen on Command-Return", () => {
  const place = member(panels, "private func place(");
  expect(place).toContain("if !panel.setFrameUsingName(name)");
  expect(place).toContain("panel.setFrameAutosaveName(name)");
  expect(panels).toContain("place(controlBar, name: Self.controlBarFrameName,");
  expect(panels).toContain("place(fog, name: Self.conversationFrameName,");
  expect(panels).toContain('static let controlBarFrameName = "conch.controlBar"');
  expect(panels).toContain('static let conversationFrameName = "conch.conversation"');

  const button = components.slice(components.indexOf("public struct FogPanelButtons: View {"), components.indexOf("// MARK: - FogHandle"));
  expect(button.length).toBeGreaterThan(100);
  expect(button).toContain("action: onFullScreen");
  expect(button).toContain(".keyboardShortcut(.return, modifiers: .command)");
  expect(panels).toContain("onFullScreen: { panels.toggleFullScreen() }");
  const toggle = member(panels, "func toggleFullScreen() {");
  expect(toggle).toContain("fog.setFrame(screen.frame, display: true, animate: animate)");
  // Leaving docks it back in its corner at the size it had.
  expect(toggle).toContain("let frame = FogDock.frame(size: fogSize, corner: corner, in: screen.frame)");
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
  expect(panels).toContain("blur.maskImage = Self.blurMask(corner, strength: blurStrength)");
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
 * Tyler: "set rules like its always touching one side and top or bottom", "when i drag up i want it to get taller not
 * move all the way up... unless i drag from middle but then maybe it snaps", and "incrase the areas around the edges
 * that you pull for resizing".
 */
test("M3: the fog stays docked in a corner, is thrown into a corner by its middle, and resizes from wide free edges", () => {
  // conch owns the geometry: no window-server resizing or background dragging to race.
  expect(panels).not.toContain(".resizable");
  // Its transparent parts still take the pointer, or drags and resize strips fall through to the app behind.
  expect(panels).toContain("fog.ignoresMouseEvents = false");
  const dock = member(panels, "private func dock(_ corner: FogCorner, on screen: NSScreen, velocity: CGVector, animated: Bool) {");
  expect(dock).toContain("let target = FogDock.frame(size: fogSize, corner: corner, in: screen.frame)");
  expect(dock).toContain("startSpring(to: target, velocity: velocity)");
  expect(dock).toContain("!NSWorkspace.shared.accessibilityDisplayShouldReduceMotion");
  // It follows the pointer from where the drag began; let go, its momentum picks the corner.
  const moved = member(panels, "func dragMoved() {");
  expect(moved).toContain("let mouse = NSEvent.mouseLocation");
  expect(moved).toContain("start.frame.minX + mouse.x - start.mouse.x");
  const ended = member(panels, "func dragEnded() {");
  expect(ended).toContain("dock(FogDock.corner(releasedAt: center, velocity: velocity, in: screen.frame), on: screen, velocity: velocity, animated: true)");
  expect(ended).toContain("let recent = dragSamples.filter { now - $0.time <= 0.1 }");
  // Resizing keeps its corner, from strips wider than a window's own edge.
  expect(member(panels, "func resizeMoved(_ edges: Edge.Set) {")).toContain("let next = FogDock.resize(");
  expect(panels).toContain("static let resizeGrab: CGFloat = 96");
  // The host draws the buttons itself, after the strips, so a strip never takes a button's click.
  expect(panels).toContain("showsButtons: false,");
  const overlay = panels.slice(panels.indexOf("resizeHandles\n                    }"), panels.indexOf("resizeHandles\n                    }") + 300);
  expect(overlay).toContain("panelButtons");
  // The words and buttons keep clear of those strips.
  expect(member(panels, "private func updateInsets(_ frame: NSRect, on screen: NSScreen) {")).toContain(
    "let grab = isFullScreen ? 0 : max(0, Self.resizeGrab - ConversationFog.padding)",
  );
  // A throw fades, softens and shrinks a little mid-flight, and lands whole (Tyler: "so it feels more liquid").
  expect(member(panels, "private func stepSpring() {")).toContain("fog.alphaValue = 1 - 0.45 * motion");
  expect(member(panels, "private func stopSpring() {")).toContain("fog.alphaValue = 1");
  expect(panels).toContain(".scaleEffect(1 - 0.1 * panels.throwMotion)");
  expect(panels).toContain(".blur(radius: 10 * panels.throwMotion)");
  expect(panels).toContain(".onChanged { _ in panels.resizeMoved(edges) }");
  expect(panels).toContain(".onChanged { _ in panels.dragMoved() }");
  // It reaches the screen's edges, and the words are padded clear of the Dock and the menu bar.
  expect(member(panels, "private func updateInsets(_ frame: NSRect, on screen: NSScreen) {")).toContain(
    "bottom: max(0, visible.minY - max(frame.minY, full.minY))",
  );
  expect(components).toContain("let top = insets.top + padding + (atBottom ? 0 : row)");
  // The buttons sit in the docked corner, away from the free corner it is resized by.
  expect(panels).toContain("y: ConversationFog.buttonsY(in: proxy.size, corner: panels.corner, insets: insets, fullScreen: panels.isFullScreen)");
  // Into the corner proper: the Dock's inset doesn't reach a corner, the menu bar's does.
  expect(panels).toContain("let insets = ConversationFog.buttonInsets(panels.insets)");
  expect(panels).toContain("alignment: ConversationFog.buttonsAlignment(corner: panels.corner, fullScreen: panels.isFullScreen)");
  // The overlay's look is on (Tyler: "i don't see any overlay"), and the testing outline is gone.
  expect(panels).toContain("static let showsFog = true");
  expect(panels).not.toContain("strokeBorder(Color.black");
  expect(components).toContain("center: corner.unitPoint,");
  // The transcript still ends in a short fade above the reply, not a cut.
  expect(components).toContain(
    "LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)\n                        .frame(height: ConchSpace.x4)",
  );
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
  expect(collapse).toContain("blur.isHidden = !Self.showsFog");
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
  expect(member(components, "static func textFrame(in size: CGSize, corner: FogCorner, insets: EdgeInsets, fullScreen: Bool) -> CGRect {")).toContain(
    "let width = min(960, room)",
  );
});

/** Tyler: "for pill lets also switch the hierarchy of the project name and the status cause the mark also gives status". */
test("M3: the control bar leads with the session, with the state beneath it", () => {
  const bar = member(components, "public var body: some View {\n        GlassPill(\"Voice controls\") {");
  expect(bar).toContain("VoiceStateLabel(state: state, detail: detail, leadsWithDetail: true)");
  expect(components).toContain("Text(detailFirst ? detail : state.title)");
  expect(components).toContain("Text(detailFirst ? state.title : detail)");
});

/** Tyler: the blur "looks bad". Its look is tuned by eye, so it's live: a `defaults write` shows at once, no rebuild. */
test("M3: the overlay's tint, blur and material are live defaults the running app picks up", () => {
  expect(panels).toContain('static let tintKey = "conch.overlay.tint"');
  expect(panels).toContain('static let blurKey = "conch.overlay.blur"');
  expect(panels).toContain('static let materialKey = "conch.overlay.material"');
  expect(panels).toContain('UserDefaults.standard.register(defaults: [Look.tintKey: 0.2, Look.blurKey: 1.0, Look.materialKey: "fullScreenUI"])');
  expect(panels).toContain("let lookTimer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in");
  expect(panels).toContain("MainActor.assumeIsolated { self?.applyLook() }");
  const look = member(panels, "private func applyLook() {");
  expect(look).toContain("if tint != tintOpacity { tintOpacity = tint }");
  expect(look).toContain("if blur.material != material { blur.material = material }");
  expect(look).toContain("Self.masks = [:]");
  expect(panels).toContain("tint: panels.tintOpacity,");
  expect(components).toContain(".opacity(tint)");
});
