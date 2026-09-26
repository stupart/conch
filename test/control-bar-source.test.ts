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
const look = read("design/ConchDesign/Sources/ConchDesign/FogLook.swift");
const tokens = read("design/ConchDesign/Sources/ConchDesign/Tokens.swift");
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
  // Shown without activating conch; nothing here brings conch forward. The fog takes the keys itself in exactly one
  // place, as a non-activating panel (the app in front stays in front): full screen, and the open switcher.
  expect(panels).toContain("if on { panel.orderFrontRegardless() } else { panel.orderOut(nil) }");
  for (const intrusion of ["NSApp.activate", "makeKeyAndOrderFront"]) {
    expect(panels).not.toContain(intrusion);
  }
  expect(panels.match(/makeKey\(\)/g)?.length).toBe(1);
  expect(member(panels, "private func takeKeys() {")).toContain("fog.makeKey()");
  expect(project).toContain("/* FloatingPanels.swift in Sources */ = {isa = PBXBuildFile;");
  expect(project.match(/\/\* FloatingPanels\.swift in Sources \*\/,/g)?.length).toBe(1);
});

test("M3: the menu's Control Bar and Conversation Panel drive the panels, live", () => {
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
  // Turned on from the menu, the conversation opens full size rather than as its collapsed handle; folded to its handle,
  // choosing it opens it rather than hiding a panel nobody could see (StatusMenu.conversationToggle; ReadyTests pins it).
  const toggleConversation = member(item, "@objc private func toggleConversation() {");
  expect(toggleConversation).toContain("let next = StatusMenu.conversationToggle(");
  expect(toggleConversation).toContain("collapsed: defaults.bool(forKey: FloatingPanels.conversationCollapsedKey)");
  const collapsed = toggleConversation.indexOf("defaults.set(next.collapsed, forKey: FloatingPanels.conversationCollapsedKey)");
  expect(collapsed).toBeGreaterThan(-1);
  expect(collapsed).toBeLessThan(toggleConversation.indexOf("defaults.set(next.on, forKey: Self.showConversationKey)"));
  // And the menu says so: a dash while it is on but folded, never a tick over nothing.
  expect(item).toContain("case .mixed: .mixed");
  expect(item).toContain("collapsed: defaults.bool(forKey: FloatingPanels.conversationCollapsedKey),");
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
  // Collapsed, a hover area in its corner clear of the Dock and the menu bar, the glass shrinking into it on the morph
  // spring; opened, docked again at its size, growing out of it. From full screen it goes straight there.
  expect(collapse).toContain("morph(to: FogDock.frame(size: CGSize(width: side, height: side), corner: corner, in: screen.visibleFrame), form: .collapsed)");
  expect(collapse).toContain("morph(to: FogDock.frame(size: motion.size, corner: corner, in: screen.frame), form: .docked)");
  expect(collapse).toContain("dock(corner, on: screen)");
  expect(collapse).toContain("if isFullScreen {\n                // It no longer covers the screen, and the keys it took for full screen go back.\n                isFullScreen = false");
  // Opening docks the motion alone: `dock` would set the docked frame at once and there would be nothing to morph.
  expect(collapse).toContain("motion.dock(corner, in: screen.frame)");
  expect(collapse.slice(collapse.indexOf("} else {\n            // Docked in its corner"))).not.toContain("dock(corner, on: screen)");
  // The collapsed frame is never the one saved: autosave stops before it shrinks and resumes only once it has landed open.
  expect(collapse.indexOf('fog.setFrameAutosaveName("")')).toBeGreaterThan(-1);
  expect(collapse.indexOf('fog.setFrameAutosaveName("")')).toBeLessThan(collapse.indexOf("width: side, height: side"));
  expect(collapse).not.toContain("fog.setFrameAutosaveName(Self.conversationFrameName)");
  expect(member(panels, "private func landed() {")).toContain("if !isFullScreen, !isCollapsed { fog.setFrameAutosaveName(Self.conversationFrameName) }");
  // The fog's button collapses it; hovering its corner shows the caret that opens it (Tyler: "only shows when your
  // hovering in that area"), tracked by the panel's own view so it works while conch is in the background.
  expect(panels).toContain("FogHandle(corner: panels.corner, hovering: panels.hovering) { panels.toggleCollapsed() }");
  expect(panels).toContain("onCollapse: { panels.toggleCollapsed() },");
  const buttons = components.slice(components.indexOf("public struct FogPanelButtons: View {"), components.indexOf("// MARK: - FogHandle"));
  expect(buttons).toContain('label: "Collapse conversation",');
  expect(components).toContain("public struct FogHandle: View {");
  expect(components).toContain(".opacity(hovering ? 1 : 0)");
  expect(components).toContain('.accessibilityLabel("Show conversation")');
  expect(panels).toContain("options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect]");
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
  // Command-Return is the panel's own key now (`PanelKeys`), seen before the reply line, so it works whenever the panel
  // has the keys and not only while typing; the button's tooltip names it.
  expect(button).toContain("shortcut: isFullScreen ? PanelKeys.Shortcut.exitFullScreen : PanelKeys.Shortcut.fullScreen,");
  expect(button).not.toContain(".keyboardShortcut(");
  expect(member(panels, "private func key(_ event: NSEvent) -> Bool {")).toContain("case .fullScreen: toggleFullScreen()");
  expect(panels).toContain("onFullScreen: { panels.toggleFullScreen() }");
  const toggle = member(panels, "func toggleFullScreen() {");
  // Both ways on the morph spring, stepped with the fog's motion; at once under Reduce Motion.
  expect(toggle).toContain("morph(to: screen.frame, form: .fullScreen)");
  // Leaving docks it back in its corner at the size it had.
  expect(toggle).toContain("let frame = FogDock.frame(size: motion.size, corner: corner, in: screen.frame)");
  expect(toggle).toContain("morph(to: frame, form: .docked)");
  const morph = member(panels, "private func morph(to target: NSRect, form next: Form) {");
  expect(morph).toContain("guard settled, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {");
  expect(morph).toContain("morphing = (from: fog.frame, to: target, glassFrom: from, glassTo: to, form: next, arrived: false, progress: 0, velocity: 0)");
  const step = member(panels, "func step(dt: Double) {");
  expect(step).toContain("let done = ConchMotion.morph.step(&morph.progress, velocity: &morph.velocity, to: 1, dt: dt)");
  expect(step.indexOf("ConchMotion.morph.step(")).toBeLessThan(step.indexOf("apply()"));
  // Mid-morph the morph has the frame: the docked frame never fights it.
  expect(member(panels, "private func apply() {")).toContain("guard !isCollapsed, !isFullScreen, morphing == nil else { return layOut(margin: EdgeInsets()) }");
  // Collapsing morphs from wherever it is, so a morph on its way gives way to it.
  expect(member(panels, "private func setCollapsed(_ collapsed: Bool) {")).toContain("form: .collapsed)");
  // A full-screen frame is never the one saved: autosave is off before it grows, full screen is set before a morph that
  // lands at once, and autosave comes back only once it has landed docked.
  expect(toggle.indexOf('fog.setFrameAutosaveName("")')).toBeGreaterThan(-1);
  expect(toggle.indexOf('fog.setFrameAutosaveName("")')).toBeLessThan(toggle.indexOf("morph(to: screen.frame"));
  expect(toggle.indexOf("isFullScreen = true")).toBeLessThan(toggle.indexOf("morph(to: screen.frame"));
  expect(toggle).not.toContain("fog.setFrameAutosaveName(Self.conversationFrameName)");
  expect(member(panels, "private func landed() {")).toContain("if !isFullScreen, !isCollapsed { fog.setFrameAutosaveName(Self.conversationFrameName) }");
});

test("M3: the fog replies through inject and dictates through the composer's dictate", () => {
  const send = member(panels, "private func send(_ row: SessionRow) {");
  expect(send).toContain("store.send(.inject(sessionId: row.id, label: row.label, text: text))");
  expect(read("mac-app/conch-mac/ConchSocketClient.swift")).toContain(
    "Self(type: .inject, sessionId: sessionId, label: label, announce: text, awaitDelivery: true, answers: answers, questionId: questionId, approve: approve)",
  );
  const mic = member(panels, "private func mic(_ row: SessionRow) {");
  expect(mic).toContain("store.send(.dictate(sessionId: row.id, label: row.label))");
  expect(mic).toContain("store.send(.stop())");
  expect(panels).toContain("onMic: { if let row { mic(row) } }");
  expect(panels).toContain("onSend: { if let row { send(row) } }");
  // The spoken words come back into the same shared draft, once.
  expect(panels).toContain("drafts.apply(store.state?.live.dictated)");
  expect(panels).toContain("@ObservedObject private var drafts = ComposerDraftStore.shared");
  // The fog's wash, now over the glass rather than a square over the screen, and a behind-window blur under the look's
  // own mask below macOS 26.
  expect(read("design/ConchDesign/Sources/ConchDesign/GlassPanel.swift")).toContain("ConchColor.fog.rgba(darkness: darkness).color.opacity(PanelGlass.wash.at(darkness))");
  expect(panels).toContain("blur.blendingMode = .behindWindow");
  expect(panels).toContain("blur.maskImage = blurMask()");
  expect(member(panels, "private func blurMask() -> NSImage? {")).toContain("guard let mask = look.mask(strength: blurStrength) else { return nil }");
  expect(components).toContain(".font(ConversationFog.font(latest: now, fullScreen: fullScreen))");
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
  // The light green in both schemes, where the white check clears 3:1 (ReadyTests measures it).
  expect(components).toContain(
    'case .ready:\n                Circle().fill(Self.readyFill.color)\n                Image(systemName: "checkmark")',
  );
  expect(components).toContain("public static let readyFill = ConchColor.ready.light");
  expect(components).not.toContain("case .talk, .ready:");
  // The listening mic is dark on the orange: white measured 2.06.
  expect(components).toContain("VoiceGlyph(.listening, size: size / 2).foregroundStyle(Self.onListening.color)");
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
 * Tyler: "set rules like its always touching one side and top or bottom", "when i drag up i want it to get taller not move
 * all the way up", "i shouldn't get locked into resizing vertically or horizontally", "make the resize area larger without
 * creating more margin - like grabbing onto text area should still allow resize", and "better for 'anchor' to stay in
 * bottom left corner unless i toss it up to top right". The overlay lab (conch-design/overlay-lab.html) is the spec, and
 * ConchDesign's FogMotionTests hold its invariants on the motion itself; these pin how the Mac overlay drives it.
 */
test("M3: the fog moves the way the overlay lab does: thrown by its middle on one spring, resized from any edge in its corner", () => {
  // conch owns the geometry: no window-server resizing or background dragging to race.
  expect(panels).not.toContain(".resizable");
  // Its transparent parts still take the pointer, or drags fall through to the app behind.
  expect(panels).toContain("fog.ignoresMouseEvents = false");
  // The motion is ConchDesign's, and nothing is left of the strips, the SwiftUI drags or the Timer spring.
  expect(panels).toContain("private var motion = FogMotion(");
  for (const gone of ["resizeGrab", "resizeHandles", "DragGesture", "springTimer", "stepSpring", "FogDock.resize(", "freeEdges", "showsButtons: false", "Timer(timeInterval: Self.springStep"]) {
    expect(panels).not.toContain(gone);
  }
  expect(components).not.toContain("public static func resize(");
  // Presses are AppKit's, in the fog's own view: a SwiftUI gesture was cancelled by the window resizing under it (#205).
  // A press on a button or the reply line goes to it; anywhere else, text included, it is the fog's.
  const hit = member(panels, "override func hitTest(_ point: NSPoint) -> NSView? {");
  expect(hit).toContain("let local = convert(point, from: superview)");
  expect(hit).toContain("if type == .leftMouseDown, panels.grabs(local) { return self }");
  expect(panels).toContain("override func mouseDown(with event: NSEvent) { panels?.pressed() }");
  expect(panels).toContain("override func mouseDragged(with event: NSEvent) { panels?.dragged() }");
  expect(panels).toContain("override func mouseUp(with event: NSEvent) { panels?.released() }");
  expect(member(panels, "func grabs(_ point: CGPoint) -> Bool {")).toContain("!controlFrames.contains { $0.contains(point) }");
  expect(panels).toContain(".coordinateSpace(name: FogControls.space)");
  expect(panels).toContain(".onPreferenceChange(FogControls.self) { panels.controlFrames = $0 }");
  expect(components).toContain("overflows: overflows, onMic: onMic, onSend: onSend, onLeave: onLeaveReply)\n                .frame(height: height, alignment: top ? .top : .bottom)\n                .fogControl()");
  expect(components).toContain(
    "FogPanelButtons(corner: corner, isFullScreen: isFullScreen, onCollapse: onCollapse, onFullScreen: onFullScreen, onPrevious: onPrevious, onNext: onNext, onCanvas: onCanvas, isCanvasOn: isCanvasOn)\n                            .fogControl()",
  );
  // A gesture always ends: on mouse-up; on a frame that finds the button already up (let go over another app, or an event
  // lost); when another app comes forward; and when the screens change, it collapses or it goes full screen.
  const step = member(panels, "func step(dt: Double) {");
  expect(step).toContain("if motion.isGesturing, NSEvent.pressedMouseButtons & 1 == 0 { released() }");
  expect(step.indexOf("released()")).toBeLessThan(step.indexOf("motion.step(dt: dt)"));
  expect(panels).toContain("forName: NSWorkspace.didActivateApplicationNotification");
  expect(panels).toContain("MainActor.assumeIsolated {\n                self?.released(cancelled: true)");
  expect(member(panels, "private func dock(_ corner: FogCorner, on screen: NSScreen) {")).toContain("motion.dock(corner, in: screen.frame)");
  expect(member(panels, "private func redock() {")).toContain("dock(corner, on: screen)");
  expect(member(panels, "func toggleFullScreen() {")).toContain("dock(corner, on: screen)");
  expect(components).toContain("        gesture = nil\n        flight = nil\n        sizeTarget = nil");
  // Let go, it flies into the corner its momentum picks, on the screen it was let go over.
  const released = member(panels, "func released(cancelled: Bool = false) {");
  expect(released).toContain("let screen = screen(containing: NSEvent.mouseLocation)?.frame ?? motion.screen");
  expect(released).toContain("motion.release(at: ProcessInfo.processInfo.systemUptime, in: screen, cancelled: cancelled)");
  expect(components).toContain("corner = FogDock.corner(releasedAt: CGPoint(x: frame.midX, y: frame.midY), velocity: velocity, in: screen)");
  // Driven by the display at the real frame time, in the spring's fixed 240 Hz substeps, and stopped once it rests.
  expect(panels).toContain("displayLink(target: self, selector: #selector(step(_:)))");
  expect(panels).toContain("let dt = lastFrame > 0 ? min(link.timestamp - lastFrame, 0.05) : 1.0 / 120");
  expect(step).toContain("motion.step(dt: dt)");
  expect(step).toContain("if motion.isSettled, darkness == darkTarget, resizeHover == hoverTarget, morphing == nil, revealAt == nil, !words { container.run(false) }");
  expect(member(panels, "func pressed() {")).toContain("container.run(true)");
  expect(read("design/ConchDesign/Sources/ConchDesign/Tokens.swift")).toContain("let h = CGFloat(min(t, 1.0 / 240))");
  // Calm under Reduce Motion: the dock spring without its overshoot, and only the fade of the flight.
  expect(step).toContain("motion.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion");
  expect(components).toContain("let spring = ConchMotion.dock.resolved(reduceMotion: reduceMotion)");
  // A throw fades, softens and shrinks a little mid-flight, and lands whole (Tyler: "so it feels more liquid").
  expect(member(panels, "private func apply() {")).toContain("fog.alphaValue = 1 - (1 - ConchMotion.flightOpacity) * motion.flying");
  expect(panels).toContain(".scaleEffect(1 - (1 - ConchMotion.flightScale) * (reduceMotion ? 0 : panels.throwMotion))");
  expect(panels).toContain(".blur(radius: reduceMotion ? 0 : ConchMotion.flightBlur * panels.throwMotion)");
  // The lab's geometry: one spring along the straight line to the corner, the throw's sideways momentum a small capped
  // curve on a quicker spring, rubber-banding past the screen; a band along every edge resizes; 480 by 360 to 1280 by 900.
  const motion = components.slice(components.indexOf("public struct FogMotion {"), components.indexOf("public struct FogControls: PreferenceKey {"));
  expect(motion.length).toBeGreaterThan(1000);
  expect(motion).toContain("ConchSpring(bounce: 0, response: spring.response * 0.6)");
  expect(motion).toContain("min(48, room([start, motion.docked]");
  expect(motion).toContain("FogDock.rubberBand(x, lo.x, hi.x)");
  expect(motion).toContain("size = FogDock.resized(gesture.size, corner: corner, by: delta, in: screen)\n            origin = docked");
  expect(components).toContain("let band = max(120, min(size.width, size.height) / 5)");
  expect(components).toContain("CGSize(width: screen.width, height: screen.height)");
  expect(components).toContain("CGSize(width: min(480, most.width), height: min(360, most.height))");
  expect(components).toContain("(1 - 1 / (x * 0.55 / 200 + 1)) * 200");
  // It reaches the screen's edges, and the words are padded clear of the Dock and the menu bar, with no margin for strips.
  const insets = member(panels, "private func updateInsets(_ frame: NSRect, on screen: NSScreen) {");
  expect(insets).toContain("bottom: max(0, visible.minY - max(frame.minY, full.minY)),");
  expect(insets).not.toContain("grab");
  expect(components).toContain("let top = insets.top + padding + (atBottom ? 0 : row)");
  // With no strips over them, the fog draws its own buttons, in its docked corner proper.
  expect(components).toContain("let buttons = Self.buttonInsets(insets)");
  expect(components).toContain("let alignment = Self.buttonsAlignment(corner: corner, fullScreen: isFullScreen)");
  expect(components).toContain("let y = Self.buttonsY(in: proxy.size, corner: corner, insets: buttons, fullScreen: isFullScreen)");
  expect(components).toContain(".frame(width: max(0, proxy.size.width - buttons.leading - buttons.trailing - 2 * Self.padding), alignment: alignment)\n                    .offset(x: buttons.leading + Self.padding, y: y)");
  // The overlay's look is on (Tyler: "i don't see any overlay"), and the testing outline is gone.
  expect(panels).toContain("static let showsFog = true");
  expect(panels).not.toContain("strokeBorder(Color.black");
  // Glass everywhere, docked and full screen and on the way between: its inset and corner are the morph's, frame by frame.
  const glassHost = member(panels, "private struct FogLookHost: View {");
  expect(glassHost).toContain("ConchGlassPanel(darkness: panels.look.darkness, voice: ConchStatusItem.voiceState(store.state), radius: panels.glass.radius)\n                .padding(panels.glass.insets)");
  expect(glassHost).not.toContain("isFullScreen");
  // Liquid Glass draws the panel; the effect view stays a sibling but hidden, so the collapse guard below still holds.
  expect(panels).toContain("static var usesGlass: Bool { if #available(macOS 26.0, *) { true } else { false } }");
  expect(panels).toContain("fog.hasShadow = Self.usesGlass");

  // The sidebar is draggable and remembers where it was left. Tyler: "wnat ot be able ot collapse
  // and open the left side bar / drag to change side of main area and therefore make it smaller if
  // I want." Collapse already existed on Cmd-B; the width was a hardcoded 264.
  const dash = read("mac-app/conch-mac/DashboardView.swift");
  expect(dash).toContain('@AppStorage("conch.sidebarWidth") private var storedSidebarWidth = 264.0');
  expect(dash).toContain("private var sidebarResizer: some View {");
  // Placed in the layout, not merely declared: asserting the bare name matched its own
  // declaration, so deleting it from the HStack left this green. Anchor it to the layout.
  expect(dash).toContain("                    sidebarResizer\n                    }");
  expect(dash).toContain("NSCursor.resizeLeftRight.push()");
  // Bounded: a name needs room, and a sidebar that can eat the stage can hide the work.
  expect(dash).toContain("private static let sidebarBounds: ClosedRange<CGFloat> = 180...520");
  // Banked on release, not on every frame of the drag.
  expect(dash).toContain("storedSidebarWidth = sidebarWidth");
  // The width is no longer a constant.
  expect(dash).not.toContain("private var sidebarWidth: CGFloat { 264 }");

  // Come-look is one colour family. Waiting means a finished turn is sitting on you, which is the
  // same thing review means, so it joins review's green and the CHECK alone tells them apart —
  // Tyler: "maybe do same green circle just with no check?". The glyph already did that work.
  const palette = read("mac-app/conch-mac/Palette.swift");
  // #279B4C, not review's old #30B35A: a mark needs 3:1 and that green measured 2.41-2.72 on the
  // light grounds. ConchDesign's `ready` has since taken #279B4C as its light value, so waiting is
  // ready's token outright, on the phone too (ReadyTests pins the value and its contrast).
  expect(palette).toContain("static let statusWaiting = ConchColor.ready.dynamic");
  expect(tokens).toContain('public static let ready = ConchColorToken("ready", .init(0x279B4C), .init(0x30B35A))');
  // The orange it replaces is gone for good.
  expect(palette).not.toContain("red: 0.96,\n        green: 0.60,\n        blue: 0.13");
  // Working is BLUE now, not the quiet grey it was: Tyler asked for "some other color that feels
  // more like 'active' and 'positive'". The grey stays only for what is not an agent at work
  // (test/active-blue-source.test.ts pins both).
  expect(palette).toContain("static let statusActive = ConchColor.active.dynamic");
  expect(palette).toContain("static let statusQuiet = textFaint");
  expect(palette).not.toContain("statusWorking");
  // The glyphs stay as they were — the check is what separates review from waiting.
  // LedgerVisual lives in DashboardView, not in the panels.
  const dashboard = read("mac-app/conch-mac/DashboardView.swift");
  expect(dashboard).toContain('return "circle.inset.filled"');
  expect(dashboard).toContain('return "checkmark.circle.fill"');

  // Only a deliverable nobody has opened belongs in the conversation; an old one pinned to the end
  // of the stack made stale work look like fresh work waiting on you.
  //
  // TWO reasons to withhold it now, and this pins both. The unviewed rule above is unchanged —
  // the card never shows for something already looked at. The second is that the work half may
  // already be showing the deliverable, in which case the card is the same thing twice on one
  // screen (Tyler: "if the arifcat is open on the other side you probably don't need the
  // artifact in the conversation"). Asserted as two halves rather than as one longer string, so
  // neither rule can be dropped while the other still satisfies the guard.
  const stack = read("mac-app/conch-mac/ConversationStackView.swift");
  expect(stack).toContain("if let artifact, !artifactShownBeside,");
  expect(stack).toContain("artifact.viewedAt == nil || !reportsViewedState || artifactOpenedHere {");
  // An older daemon never reports viewedAt, so it must keep today's behaviour rather than hiding
  // every card.
  expect(stack).toContain("var reportsViewedState = true");
  expect(read("mac-app/conch-mac/DashboardView.swift"))
    .toContain("reportsViewedState: state?.features?.viewedState != nil,");

  // The bar above a deliverable is gone: a review check, the session name and the summary were
  // three restatements of what the pane already is. The stage control survived it, because it is
  // the only way to reach side-by-side and fill-the-stage with a mouse.
  const review = read("mac-app/conch-mac/ReviewView.swift");
  expect(review).toContain("private var stageControl: some View {");
  expect(review).toContain(".overlay(alignment: .topTrailing) { stageControl }");
  expect(review).not.toContain("private var caption: some View {");
  expect(review).not.toContain('Text(item.summary.isEmpty ? "Ready for review" : item.summary)');
  // NOT the origin bar, which looks similar and is a trust boundary rather than decoration.
  // Where you ARE, not where the deliverable was filed: the pane can navigate now, so
  // opening "the link" would hand the browser a page you had already left.
  //
  // That guarantee MOVED rather than went. The button carrying it sat one row under the
  // header's arrow doing the same job — except the arrow opened the FILED link, so the two
  // looked like duplicates and quietly disagreed the moment you followed a link. The
  // duplicate is gone and the arrow inherited the live address. Tyler, on that box: "i think
  // we can ceratinly consolidate / remove ui element in this box." Removing it also settles
  // the clipping recorded in the backlog: it was the control the stage control overlaid.
  expect(review).not.toContain('Button("Open in browser")');
  expect(review).toContain("action: item.link == nil ? nil : onOpenInPlace,");
  expect(review).toContain("liveAddress: $liveAddress");
  expect(review).toContain("@Binding var liveAddress: String?");
  // A fog resized by hand must come back the size it was. `setFrameUsingName` restores only the ORIGIN of a
  // borderless, non-resizable panel and drops the size, so the default won on every launch and the size someone
  // chose was never the size they got — measured twice while building the capture system: asked 480x360, got
  // 900x640; asked 600x500, got 900x640.
  expect(panels).toContain("private static func savedSize(forFrameName name: String) -> NSSize?");
  expect(panels).toContain("if panel !== controlBar, let saved = Self.savedSize(forFrameName: name) { panel.setContentSize(saved) }");
  expect(panels).toContain('UserDefaults.standard.string(forKey: "NSWindow Frame \\(name)")');
  // Something always paints behind the words full screen (Tyler: "on the converation overlay fullscreen mode the
  // background fo teh panel dissapears", which regressed silently once, when nothing asserted it). It used to be the
  // behind-window blur coming back in place of the glass, square, on the first frame; now the glass itself stays, grown
  // to 12 pt from the screen's edges, and only the collapsed handle does without it. Below macOS 26 the blur stays with
  // it, shaped to the glass.
  expect(member(panels, "private func arrive(_ next: Form, at delay: TimeInterval) {")).toContain("glassShows = next != .collapsed");
  expect(member(panels, "private func showBlur() {")).toContain("blur.maskImage = isFullScreen || morphing != nil ? Self.roundedMask(radius: glass.radius) : blurMask()");
  expect(member(panels, "private func layOut(margin: EdgeInsets) {")).toContain("blur.frame = isFullScreen || morphing != nil");
  // AppKit draws the focus ring on the SCROLL VIEW, not the text view inside it, so turning it off on the text view
  // alone left the ring exactly where it was (Tyler: "thers still a strange outline around teh component").
  expect(components).toContain("scroll.focusRingType = .none");
  expect(components).toContain("view.focusRingType = .none");
  // The window is exactly the fog: the glass ends at its own edge, so no margin and no saved-frame drift.
  expect(member(panels, "private func apply() {")).toContain("layOut(margin: EdgeInsets())");
  const glass = read("design/ConchDesign/Sources/ConchDesign/GlassPanel.swift");
  expect(glass).toContain("content.glassEffect(.regular.tint(tint), in: shape)");
  expect(glass).toContain("RoundedRectangle(cornerRadius: radius, style: .continuous)");
  expect(glass).toContain("public init(darkness: Double = 0, voice: VoiceState = .talk, radius: CGFloat = ConchRadius.panel) {");
  expect(glass).toContain("content.background(ConchColor.glass.rgba(darkness: darkness).color, in: shape)");
  // The transcript fades out toward its far end, the fade shrinking with its box, rather than ending in a cut.
  expect(components).toContain(".frame(height: min(72, height * 0.4))");
});

/**
 * A visual effect view's mask shapes everything inside it. With the words inside the blur, the fog's mask faded the
 * words themselves, and collapsing (an empty mask) hid the handle: Tyler, "when i press the (v) it just disappears".
 */
test("M3: the blur sits behind the words as a sibling, so its mask never touches the words or the handle", () => {
  expect(panels).toContain("fog.contentView = container");
  expect(panels).toContain("for view in [blur, lookHost, words] {");
  // The look over the blur never takes a press: it is the fog's.
  expect(panels).toContain("private final class LookHostingView<Content: View>: NSHostingView<Content> {\n    override func hitTest(_: NSPoint) -> NSView? { nil }");
  expect(panels).not.toContain("blur.addSubview");
  expect(panels).not.toContain("fog.contentView = blur");
  // Collapsed, the blur hides with the glass; the handle, a sibling, is untouched by it.
  expect(member(panels, "private func setCollapsed(_ collapsed: Bool) {")).toContain("showBlur()");
  expect(member(panels, "private func showBlur() {")).toContain("let hidden = !Self.showsFog || Self.usesGlass || (form == .collapsed && morphing == nil)");
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
  expect(panels).toContain("ControlBarHost(store: store, queue: queue, panels: self, onSize: { [weak self] size in self?.fitControlBar(to: size) })");
  expect(panels).toContain(".onPreferenceChange(ControlBarSize.self, perform: onSize)");
  expect(components).toContain("Text(option.title)\n                        .font(ConchType.uiEmphasis)\n                        .fixedSize()");
  // The reply grows to five lines, fewer when that would leave under 90 pt of transcript, then scrolls inside itself.
  expect(read("design/ConchDesign/Sources/ConchDesign/FogText.swift")).toContain(
    "let cap = min(max(Int(((height - gap - transcriptKept - 2 * pad) / line).rounded(.down)), 1), 5)",
  );
  expect(components).toContain("let scroll = NSScrollView()");
  // The lab's column: 620 wide at the usual sizes and wider as the panel grows, 52 in from its side; a taller fog is more room for words.
  expect(member(components, "public static func textFrame(in size: CGSize, corner: FogCorner, insets: EdgeInsets, fullScreen: Bool, magnet: EdgeInsets? = nil) -> CGRect {")).toContain(
    "let measure = min(1040, max(620, room * 0.6))",
  );
});

/**
 * Tyler: "for pill lets also switch the hierarchy of the project name and the status cause the mark also gives status".
 * The session first, the state beneath it; ready, the session the pill opens next and where it is; Talk and Quiet, which
 * the switch beside it already says, give their line to news or nothing (ReadyTests pins the lines).
 */
test("M3: the control bar leads with the session, with the state beneath it", () => {
  const bar = member(components, "public var body: some View {\n        GlassPill(\"Voice controls\") {");
  expect(bar).toContain("Text(lines.title)");
  expect(bar).toContain("if let subtitle = lines.subtitle {");
  const lines = member(components, "var lines: (title: String, subtitle: String?) {");
  expect(lines).toContain("return (ready.label, ready.line)");
  expect(lines).toContain("return detail.isEmpty ? (news ?? state.title, nil) : (detail, news)");
  expect(lines).toContain("return (detail, [state.title, waiting].compactMap { $0 }.joined(separator: \" · \"))");
  // The host hands it the news.
  expect(panels).toContain("news: ConchStatusItem.news(store.state),");
});

/**
 * The bar's voice changes cut with no animation although ConchMotion.voiceColour existed for them. The orb and the words
 * now cross on it, the orb coming in from a touch smaller; under Reduce Motion, the fades alone.
 */
test("M3: the control bar's voice changes cross on the voice colour's spring, fading alone under Reduce Motion", () => {
  const bar = member(components, "public var body: some View {\n        GlassPill(\"Voice controls\") {");
  expect(bar.match(/\.animation\(ConchMotion\.voiceColour\.animation\(reduceMotion: reduceMotion\), value: (state|words|taps)\)/g)?.length).toBe(3);
  expect(bar).toContain("VoiceOrb(state: state, size: Self.orbSize)\n                        .id(state)\n                        .transition(.opacity.combined(with: .scale(scale: Self.orbEntryScale(reduceMotion: reduceMotion))))");
  expect(bar).toContain(".id(words)\n                    .transition(.opacity)");
  expect(member(components, "static func orbEntryScale(reduceMotion: Bool) -> CGFloat {")).toContain("reduceMotion ? 1 : 0.8");
  // The orb sits in the capsule's round end, so the listening ring has room (ReadyTests measures it).
  expect(bar).toContain(".padding(.leading, Self.orbLead)");
  expect(components).toContain(".padding(.horizontal, PillMetrics.inset)\n            .frame(height: PillMetrics.height)");
});

/**
 * Tyler: the blur "looks bad". Its look is tuned by eye, so it's live: a `defaults write` shows at once, no rebuild. The
 * lab's values are FogLook's; the app's tint is lower, since the system material lays its own tint over the blur first.
 */
test("M3: the overlay's tint, colour, scrim, blur, material and appearance are live defaults the running app picks up", () => {
  for (const key of ["tint", "tintDark", "colour", "colourDark", "scrim", "scrimDark", "blur", "material", "appearance"]) {
    expect(panels).toContain(`"conch.overlay.${key}"`);
  }
  expect(panels).toContain("UserDefaults.standard.register(defaults: Look.defaults)");
  expect(panels).toContain("tintKey: 0.45, tintDarkKey: 0.46, colourKey: 0.75, colourDarkKey: 0.55, scrimKey: 0.3, scrimDarkKey: 0.25,");
  expect(panels).toContain('blurKey: 1.0, materialKey: "fullScreenUI", appearanceKey: "auto",');
  expect(look).toContain("public var tint = LightDark(0.78, 0.8)");
  expect(look).toContain("public var colour = LightDark(0.75, 0.55)");
  expect(look).toContain("public var scrim = LightDark(0.3, 0.25)");
  expect(panels).toContain("let lookTimer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in");
  expect(panels).toContain("MainActor.assumeIsolated { self?.applyLook() }");
  const apply = member(panels, "private func applyLook() {");
  expect(apply).toContain("next.tint = LightDark(value(Look.tintKey), value(Look.tintDarkKey))");
  expect(apply).toContain("next.colour = LightDark(value(Look.colourKey), value(Look.colourDarkKey))");
  expect(apply).toContain("next.scrim = LightDark(value(Look.scrimKey), value(Look.scrimDarkKey))");
  expect(apply).toContain("setLook(next)");
  expect(apply).toContain("if blur.material != material { blur.material = material }");
  // Light or dark: the system's unless set. Following the screen under the words needs Screen Recording, which isn't asked for.
  expect(apply).toContain("let systemDark = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua");
  expect(apply).toContain("FogLook.isDark(defaults.string(forKey: Look.appearanceKey), systemDark: systemDark)");
  for (const capture of ["CGWindowListCreateImage", "ScreenCaptureKit", "SCScreenshotManager", "CGRequestScreenCaptureAccess", "CGPreflightScreenCaptureAccess"]) {
    expect(panels).not.toContain(capture);
  }
  expect(panels).toContain("look: panels.look,");
  expect(components).not.toContain("tintOpacity");
});

/**
 * Tyler: "when u pull it off an edge thers a line", "blobs like a magnet", "there should never be a hard line at the
 * bottom". The look gathers to the screen edges the fog touches and is a blob in its middle away from them; its window
 * reaches past the fog toward an edge the blob spills to, so the blob ends in its own fade or off the screen.
 */
test("M3: the look is a magnet: gathered to the edges it touches, a blob off them, and never a line", () => {
  expect(components).toContain("public var magnet: EdgeInsets {");
  expect(components).toContain("func pull(_ anchored: Bool, _ measured: CGFloat) -> CGFloat { (anchored ? 1 : 0) * (1 - free) + measured * free }");
  expect(components).toContain("let t = 1 - min(max(gap / 160, 0), 1)");
  expect(components).toContain("if ConchMotion.liftOff.step(&free, velocity: &freeVelocity, to: isMoving ? 1 : 0, dt: dt) {");
  expect(components).toContain("sizeTarget == nil && flying == 0 && free == 0 }");
  expect(look).toContain("public var blob: CGRect { ellipse(across: (0.58, 1.15), up: (0.58, 1), scale: scale) }");
  expect(look).toContain("[(0, 1), (0.36, 1), (0.5, 0.75), (0.64, 0.3), (0.78, 0)]");
  const apply = member(panels, "private func apply() {");
  expect(apply).toContain("var next = FogLook(motion, insets: insets)");
  expect(apply).toContain("setLook(next)");
  expect(apply).toContain("if fog.frame != frame { fog.setFrame(frame, display: true) }");
  // The blob and its density are still FogLook's, but the window no longer reaches past the fog for them: the glass
  // ends at its own rounded edge, so the margin is always zero and the saved frame cannot grow on the next launch.
  expect(apply).toContain("layOut(margin: EdgeInsets())");
  expect(apply).toContain("if motion.isMoving != floating { floating = motion.isMoving }");
  expect(member(panels, "private func layOut(margin: EdgeInsets) {")).toContain("container.setBoundsOrigin(origin)");
  expect(member(panels, "private func setLook(_ next: FogLook) {")).toContain("blur.maskImage = blurMask()");
  expect(components).toContain("public var isMoving: Bool { gesture?.resizes == false || flight != nil }");
  expect(components).not.toContain("endRadiusFraction: floating ? 0.64 : 1.1");
  expect(panels).not.toContain("ImageRenderer(");
  expect(panels).toContain("floating: panels.floating,");
});

/** Tyler: "incorporate some colors into the gradient", and a darker version. The lab's glows, palette, scrim, hover and buttons. */
test("M3: the look glows in the voice's colour, crossfades light and dark, thickens behind the words and wakes on hover", () => {
  // The voice's glow, crossfading between states, drifting except under Reduce Motion.
  expect(look).toContain(".opacity(FogLook.glowToken(voice).name == token.name ? 1 : 0)");
  expect(look).toContain(".animation(ConchMotion.voiceColour.animation(reduceMotion: reduceMotion), value: voice)");
  expect(look).toContain("look.glows(token, at: time, reduceMotion: reduceMotion)");
  expect(look).toContain("paused: reduceMotion || rendersStatically");
  // Light and dark crossfade, the look and the words' palette together.
  const step = member(panels, "func step(dt: Double) {");
  expect(step).toContain("ConchMotion.appearance.step(&darkness, velocity: &darkVelocity, to: darkTarget, dt: dt)");
  expect(step).toContain("if motion.isSettled, darkness == darkTarget, resizeHover == hoverTarget, morphing == nil, revealAt == nil, !words { container.run(false) }");
  expect(panels).toContain(".environment(\\.conchDarkness, panels.look.darkness)");
  expect(tokens).toContain("environment.conchDarkness.map { rgba(darkness: $0).color } ?? color(environment.colorScheme)");
  expect(look).toContain("let wash = ConchColor.fog.rgba(darkness: dark).color");
  // The scrim, in the blur's mask and in the wash; and the words fade where the blur does.
  expect(look).toContain("(scrimArea, [(0, scrim), (0.5, scrim), (1, 0)])");
  expect(look).toContain("FogLook.area(shift(look.scrimArea), [(0, 0.92 * scrim), (0.45, 0.78 * scrim), (1, 0)], wash)");
  expect(components).toContain("stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.26)],");
  expect(components).toContain("startPoint: top ? .bottom : .top,");
  // Over the resize band it glows; the buttons are faint until the pointer is over the fog, and gone mid-air.
  expect(member(panels, "func pointerMoved(to point: CGPoint) {")).toContain("hoverResizeBand(resizes)");
  expect(panels).toContain("if !inside { self?.hoverResizeBand(false) }");
  expect(look).toContain("let alpha = colour.at(darkness) * (1 + 0.9 * resizeHover)");
  // Pointer away, only the button fills fade: the lab's 0.4 over everything left the name at 2.1:1 and the icons at 1.6.
  expect(components).toContain(".environment(\\.overlayFills, isFullScreen || hovering ? 1 : 0)");
  expect(components).toContain(".opacity(isFullScreen || !floating ? 1 : 0)");
  expect(components).not.toContain("hovering ? 1 : 0.4");
  expect(components).toContain(".allowsHitTesting(isFullScreen || !floating)");
  expect(panels).toContain("hovering: panels.hovering,");
});

/**
 * Step 1d of the overlay port: the lab's text (conch-design/overlay-lab.html). Tyler: "need to be able to scroll my reply
 * text as it grows like i can the transcript", "make the transcript area taller and wider if i want to", and "looks like
 * the text got smaller? can we put it back to how it was?". ConchDesign's FogTextTests hold the rules; these pin how the
 * Mac overlay drives them.
 */
test("M3: the overlay's text is the lab's: pinned by the reader alone, words at a talking pace, a reply line that grows and sends", () => {
  const text = read("design/ConchDesign/Sources/ConchDesign/FogText.swift");
  // Scrolling: the fog's view takes a scroll anywhere but its reply line and moves the transcript with it; never a drag.
  const hit = member(panels, "override func hitTest(_ point: NSPoint) -> NSView? {");
  expect(hit).toContain("if type == .scrollWheel, panels.scrolls(local) { return self }");
  expect(panels).toContain("override func scrollWheel(with event: NSEvent) { panels?.scrolled(event) }");
  expect(member(panels, "func scrolls(_ point: CGPoint) -> Bool {")).toContain("!isCollapsed && !controlFrames.contains { $0.contains(point) }");
  const scrolled = member(panels, "func scrolled(_ event: NSEvent) {");
  expect(scrolled).toContain("ConversationFog.newestAtTop(corner: corner, fullScreen: isFullScreen) ? -points : points");
  expect(scrolled).toContain("text.scroll(by: towardOldest, momentum: event.momentumPhase != [])");
  expect(scrolled).not.toContain("pressed");
  // Only a reader's scroll unpins; layout keeps pinned; the pill and a send re-pin and drop the leftover glide.
  expect(member(text, "public mutating func scroll(by delta: CGFloat, momentum: Bool) {")).toContain("pinned = offset < 6");
  expect(text.match(/pinned = offset < 6/g)?.length).toBe(1);
  expect(member(text, "public mutating func layout(range next: CGFloat) {")).toContain("offset = pinned ? min(offset, next) : min(max(next - (range - offset), 0), next)");
  expect(member(text, "public mutating func toNewest() {")).toContain("ignoresGlide = true");
  expect(components).toContain("Button(action: text.toNewest)");
  expect(components).toContain('let label = text.scroll.unseen ? "New reply" : "Newest"');
  // Stepped with the motion on the display's frames, and fed by the store: its working state, not a timer.
  const step = member(panels, "func step(dt: Double) {");
  expect(step).toContain("let now = ProcessInfo.processInfo.systemUptime\n        let words = text.step(dt: dt, now: now, reduceMotion: motion.reduceMotion)");
  expect(step.indexOf("text.step(")).toBeLessThan(step.indexOf("apply()"));
  expect(panels).toContain("text.wake = { [weak self] in MainActor.assumeIsolated { self?.container.run(true) } }");
  expect(member(panels, "private func apply() {")).toContain("next.replyHeight = showsReply ? text.replyHeight : 0");
  expect(panels).toContain("isWorking: row?.status == .working,");
  expect(panels).toContain(".onChange(of: turns, initial: true) { _, turns in panels.text.update(turns: turns, now: ProcessInfo.processInfo.systemUptime) }");
  expect(panels).toContain(".onChange(of: row?.id) { _, _ in panels.text.session() }");
  for (const fake of ["asyncAfter", "Task.sleep", "Timer("]) expect(text).not.toContain(fake);
  expect(components).toContain("if isWorking, lines.last?.fromYou == true { lines.append(.thinking) }");
  // Sent: shown at once and flown in, the daemon's copy taking its place; dropped if it never arrives,
  // and then the words come back to the reply line instead of being lost.
  const send = member(panels, "private func send(_ row: SessionRow) {");
  expect(send.indexOf("fog.send(text)")).toBeLessThan(send.indexOf('draft.wrappedValue = ""'));
  expect(send).toContain("guard !(await delivery.value) else { return }");
  expect(send.indexOf("fog.sendFailed()")).toBeLessThan(send.indexOf("if draft.wrappedValue.isEmpty { draft.wrappedValue = text }"));
  expect(send).toContain("if draft.wrappedValue.isEmpty { draft.wrappedValue = text }");
  // Reveal: 13 words a second with breaths at punctuation, each fading up out of a 4 pt blur, any backlog in within 3 s.
  expect(text).toContain("public static let longest: Double = 3");
  expect(text).toContain("return 1 / ConchMotion.wordsPerSecond + pause");
  expect(components).toContain(".textRenderer(WordRevealRenderer(");
  expect(components).toContain("blur: reduceMotion ? 0 : ConchMotion.wordRevealBlur,");
  // The reply line: AppKit's text view; Return sends, Shift-Return a new line, Esc leaves; it keeps its clicks.
  expect(text).toContain("return shift || option ? .newline : .send");
  expect(components).toContain("case .send: field.onSend()");
  expect(components).toContain("case .newline: view.insertNewlineIgnoringFieldEditor(nil)");
  expect(components).toContain("case .leave:\n                view.window?.makeFirstResponder(nil)");
  expect(components).toContain("override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }");
  expect(components).toContain("pill(top: top)\n                            .fogControl()");
  const replyLine = components.slice(components.indexOf("public struct InlineReplyLine: View {"), components.indexOf("// MARK: - ControlBar"));
  expect(replyLine.length).toBeGreaterThan(1000);
  expect(replyLine).not.toContain('label: "Send"');
  expect(components).not.toContain(".lineLimit(1...5)");
  // Grows on the grow spring, measured cheaply however long the draft (#210's freeze stays fixed: saves still wait).
  expect(text).toContain("ConchMotion.grow.resolved(reduceMotion: reduceMotion).step(&replyHeight");
  expect(text).toContain("String(text.prefix(2000))");
  const composer = read("mac-app/conch-mac/ComposerView.swift");
  expect(composer).toContain("try? await Task.sleep(for: .milliseconds(500))");
  expect(composer).toContain("MainActor.assumeIsolated { self?.saveNow() }");
  // Layout: top corners top-down, words centred off a corner by the magnet, long strings wrapped at the column, and the
  // scrim and the words' fade following the newest lines and a growing reply.
  expect(components).toContain("!corner.bottom && !fullScreen");
  expect(components).toContain("magnet: look?.magnet)");
  expect(components).toContain(".fixedSize(horizontal: false, vertical: true)\n                .opacity(now ? 1 : 1 - (1 - ConversationFog.pastOpacity) * e)");
  expect(look).toContain("y = newestAtTop ? text.minY + replyHeight + 70 : text.maxY - replyHeight - 70");
  expect(look).toContain("y: newestAtTop ? text.minY : text.maxY - 230");
  // The type is as it was.
  expect(tokens).toContain("public static let conversationNow = Font.system(size: 24, weight: .medium)");
  expect(tokens).toContain("public static let conversationPast = Font.system(size: 17)");
  expect(tokens).toContain("public static let conversationNowFull = Font.system(size: 36, weight: .medium)");
  expect(tokens).toContain("public static let conversationPastFull = Font.system(size: 24)");
});

/**
 * Tyler: "if i click on 'conch ready for you' in the pill it brings 'the scene' to front … It's like the agents are
 * messaging me 'look at this' and showing me stuff vs me having to go find them". ConchDesignTests hold ReviewScene's
 * order, its queue, and that only Ready taps; these pin how the Mac wires them.
 */
test("the Ready pill's label, and only it, is a button while anything is ready, saying what it will open", () => {
  // While anything is ready, whatever the voice is doing: it stopped taking clicks while conch spoke or listened.
  expect(components).toContain("var taps: Bool { onTap != nil && ready != nil }");
  const bar = member(components, "public var body: some View {\n        GlassPill(\"Voice controls\") {");
  const button = bar.indexOf("if taps, let onTap {");
  const otherwise = bar.indexOf("} else {\n                label\n            }");
  expect(button).toBeGreaterThan(-1);
  expect(otherwise).toBeGreaterThan(button);
  expect(bar.slice(button, otherwise)).toContain("Button(action: onTap) { label.contentShape(Rectangle()) }");
  // Talk and Quiet sit beside the button, never inside it, and nothing over the pill takes their clicks.
  expect(bar.indexOf("TalkQuietSwitch(mode: $mode)")).toBeGreaterThan(otherwise);
  expect(bar.slice(button, otherwise)).not.toContain("TalkQuietSwitch");
  for (const swallow of ["allowsHitTesting", "onTapGesture", "simultaneousGesture", ".disabled("]) {
    expect(bar).not.toContain(swallow);
  }
  // The pointing hand while hovered, a small press on the pop spring, no restyle, and a tooltip naming the next one.
  expect(bar).toContain("if case .active = phase { NSCursor.pointingHand.set() } else { NSCursor.arrow.set() }");
  expect(bar).toContain(".buttonStyle(PillPress())");
  expect(bar.slice(button, otherwise)).toContain(".help(ready?.help ?? \"\")");
  expect(components).toContain(".animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: configuration.isPressed)");
  // A visible "›" says it opens something, only while it does.
  expect(bar).toContain('if taps {\n                    // Says it opens something before the pointer finds it.\n                    Image(systemName: "chevron.right")');
  // "Open <label> · 1 of 3", then what to check there when the agent said (scene.inspect); ReadyTests pins the words.
  const ready = member(components, "public struct Ready: Equatable, Sendable {");
  expect(ready).toContain('let open = count > 1 ? "Open \\(label) · \\(position) of \\(count)" : "Open \\(label)"');
  expect(ready).toContain('return inspect.map { "\\(open)\\n\\($0)" } ?? open');
  expect(panels).toContain("ready: queue.pill(store.state),");
  expect(member(panels, "func pill(_ state: PublishedState?) -> ControlBar.Ready? {")).toContain(
    "return ControlBar.Ready(label: next.label, position: at + 1, count: ready.count, inspect: next.inspect)",
  );
  expect(read("mac-app/conch-mac/ReviewView.swift")).toContain("inspect = review.inspect");
  // The panel feeds SwiftUI the pointer while conch is in the background, as the fog's own view does.
  expect(member(panels, "override func updateTrackingAreas() {\n        super.updateTrackingAreas()\n        guard !trackingAreas")).toContain(
    "options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect], owner: self",
  );
  // The host always offers the tap; ControlBar decides whether it is live.
  expect(panels).toContain("onTap: { queue.walk(from: .pill, store: store, panels: panels) }");
});

test("the pill's scene: the link, else conch's window if open, else the terminal, else conch, falling through on failure", () => {
  const choose = member(components, "public static func choose(kind: Kind = .auto, link: URL?, fileExists: (String) -> Bool, appWindowOpen: Bool, revealable: Bool) -> ReviewScene {");
  const order = [
    "case .conversation: return .app",
    "case .terminal: return revealable ? .terminal : .app",
    "case .auto, .link: break",
    'if let link, ["http", "https"].contains(link.scheme?.lowercased() ?? "") { return .open(link) }',
    "if let link, link.isFileURL, fileExists(link.path) { return .open(link) }",
    "if appWindowOpen { return .app }",
    "if revealable { return .terminal }",
    "\n        return .app",
  ].map((line) => choose.indexOf(line));
  expect(order.every((at) => at > -1)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);

  const stage = member(item, "static func stage(_ row: SessionRow, store: StateStore) async -> Bool {");
  // The review's own trimmed link, resolved against the session's folder the way the dashboard resolves it.
  expect(stage).toContain("var link = ReviewItem(row: row)?.link.map { LinkTarget.url(for: $0, cwd: row.cwd) }");
  // The scene the review asked for; none, or one this build doesn't know, is auto.
  expect(stage).toContain('let kind = ReviewScene.Kind(rawValue: row.review?.sceneKind ?? "") ?? .auto');
  expect(stage).toContain("switch ReviewScene.choose(\n                kind: kind,\n                link: link,");
  expect(stage).toContain("fileExists: { FileManager.default.fileExists(atPath: $0) },");
  expect(stage).toContain("appWindowOpen: window.map { $0.isVisible && !$0.isMiniaturized } ?? false,");
  // Each scene on its existing path, handed off only when it says so, else the next scene.
  expect(stage).toContain("done.resume(returning: true)\n                    }) { _ in\n                        done.resume(returning: false)");
  expect(stage).toContain("if opened { return true }\n                link = nil");
  expect(stage).toContain("if await store.reveal(row).value {");
  expect(stage.indexOf("openApplication(at: terminal")).toBeLessThan(stage.indexOf("return true\n                }\n                revealable = false"));
  expect(stage).toContain("case .app:\n                openSession(row.id)\n                store.reportShowing(.conch(sessionId: row.id, view: \"main\"), staged: staged)\n                return true");
  expect(stage).toContain('NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Terminal").first?.bundleURL');
  for (const later of ["asyncAfter", "Task.sleep", "Timer"]) expect(stage).not.toContain(later);
  // The door says it opened; reveal's value is the daemon's ack.
  const store = read("mac-app/conch-mac/StateStore.swift");
  expect(member(store, "func openLink(")).toContain("guard let error else { Task { @MainActor in onOpened(opener) }; return }");
  const reveal = member(store, "func reveal(_ row: SessionRow) -> Task<Bool, Never> {");
  expect(reveal).toContain("case let .acknowledgement(ack)? = try? JSONDecoder().decode(ConchSessionCommandReply.self, from: data) else { return false }");
  expect(reveal).toContain("return ack.changed");
  const open = member(item, "static func openSession(_ id: SessionRow.ID) {");
  expect(open).toContain("bringConchForward()");
  expect(open).toContain("NotificationCenter.default.post(name: .selectSessionFromStatusItem, object: id)");
  expect(member(item, "@objc private func openSession(_ sender: NSMenuItem) {")).toContain("Self.openSession(id)");
  // Bringing a window forward stays out of the panels (M3): FloatingPanels only asks the status item.
  for (const intrusion of ["NSApp.activate", "makeKeyAndOrderFront", "openApplication"]) {
    expect(panels).not.toContain(intrusion);
  }
});

/**
 * The daemon has no opened state for the app to set (`opened` is the terminal renderer's own), so the walk keeps its own,
 * by exact version, only after a handoff, and prefers the unopened. Clicks run in order so a late one can't retarget.
 */
test("a click takes the exact review version, runs in order, and counts it opened only once handed off", () => {
  const walk = member(panels, "func walk(backward: Bool = false, from origin: ConchStatusItem.OpenFrom, store: StateStore, panels: FloatingPanels) {");
  expect(walk).toContain(": next(in: held, state: store.state)?.id");
  expect(member(panels, "func next(in held: [ReviewItem], state: PublishedState?) -> ReviewItem? {")).toContain(
    "ReviewScene.next(after: lastStaged, in: held.map { (key: $0.id, at: $0.reviewedAt ?? 0) }, opened: seen(in: held, state: state))",
  );
  // Taken at the click, so the next click moves on before this one lands; found again, still that version and still held.
  expect(walk.indexOf("lastStaged = key")).toBeGreaterThan(-1);
  expect(walk.indexOf("lastStaged = key")).toBeLessThan(walk.indexOf("stage(from: origin"));
  expect(walk).toContain("stage(from: origin, store: store, panels: panels) { state in Self.find(key, in: state) }");
  const find = member(panels, "private static func find(_ key: ReviewItem.ID, in state: PublishedState?) -> (row: SessionRow, key: ReviewItem.ID?)? {");
  expect(find).toContain("for row in ConchStatusItem.heldRows(state) {");
  expect(find).toContain("if let review = row.held.first(where: { ReviewItem(row: row, review: $0).id == key }) { return (row.holding(review), key) }");
  // What has been looked at is the daemon's record unioned with this window's optimistic set,
  // and against a daemon too old to remember it is that local set alone.
  const seen = member(panels, "private func seen(in held: [ReviewItem], state: PublishedState?) -> Set<ReviewItem.ID> {");
  expect(seen).toContain("guard state?.features?.viewedState != nil else { return opened }");
  expect(seen).toContain("opened.union(held.filter { $0.viewedAt != nil }");
  // ReviewItem.id is the version: what the daemon minted at filing, or the key that stood
  // in for it before there was one.
  expect(read("mac-app/conch-mac/ReviewView.swift"))
    .toContain("id = ReviewIdentity.key(published: review.id, sessionId: row.id, filedAt: review.at)");
  const stage = member(panels, "private func stage(\n        from origin: ConchStatusItem.OpenFrom,");
  const steps = [
    "let previous = staging",
    "staging = Task { @MainActor in",
    "await previous?.value",
    "guard let found = find(store.state) else { return }",
    "panels.staged = found.row.id",
    "guard await ConchStatusItem.open(found.row, from: origin, store: store, panels: panels), let key = found.key else { return }",
    "opened.insert(key)",
    // Only once handed off, and only then told to the daemon, so every other surface agrees.
    "store.markReviewViewed(sessionId: found.row.id, review: key)",
  ].map((line) => stage.indexOf(line));
  expect(steps.every((at) => at > -1)).toBe(true);
  expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  expect(panels.match(/opened\.insert/g)?.length).toBe(1);
  // What the panel doesn't show is stage's scene, as it always was.
  expect(member(item, "static func open(_ row: SessionRow, from origin: OpenFrom, store: StateStore, panels: FloatingPanels) async -> Bool {")).toContain(
    "return await stage(row, store: store)",
  );
  // Nothing sent to the daemon for it, and no command invented.
  expect(member(item, "static func stage(_ row: SessionRow, store: StateStore) async -> Bool {")).not.toContain("store.send(");
  expect(read("mac-app/conch-mac/ConchSocketClient.swift")).not.toMatch(/case (open|opened|markOpened|seen)\b/);
});

/**
 * Tyler: "ability to click next or select different session form that". The pill and the panel's Previous and Next walk
 * ONE queue, so they agree where it is: the walk lives in FloatingPanels, not in the control bar's own state.
 */
test("the pill, the menu and the panel walk one queue: every deliverable a session that isn't working holds, by version", () => {
  // Out of the bar's @State, into one object both hosts watch; the bar still never watches the fog's per-frame motion.
  expect(panels).not.toContain("@State private var lastStaged");
  expect(panels).not.toContain("@State private var opened");
  expect(panels).not.toContain("@State private var staging");
  expect(panels).toContain("@Published private(set) var lastStaged: ReviewItem.ID?");
  expect(panels).toContain("@Published private(set) var opened: Set<ReviewItem.ID> = []");
  expect(panels).toContain("    let queue = ReviewQueue()\n");
  expect(panels.match(/@ObservedObject var queue: ReviewQueue/g)?.length).toBe(2);
  expect(panels).toContain("ControlBarHost(store: store, queue: queue, panels: self,");
  expect(panels).toContain("ConversationFogHost(store: store, panels: self, queue: queue,");
  expect(panels).toContain("onTap: { queue.walk(from: .pill, store: store, panels: panels) }");
  // Every held deliverable, not only each session's newest (`review`), which is all ReviewItem(row:) reads; looked at or
  // not, so Previous reaches what was seen. Only the unlooked-at count as ready (`ready(in:)`), which is what the pill says.
  expect(member(panels, "static func held(_ state: PublishedState?) -> [ReviewItem] {")).toContain(
    "ConchStatusItem.heldRows(state).flatMap { row in row.held.map { ReviewItem(row: row, review: $0) } }",
  );
  const readyIn = member(panels, "func ready(in held: [ReviewItem], state: PublishedState?) -> [ReviewItem] {");
  expect(readyIn).toContain("let seen = seen(in: held, state: state)");
  expect(readyIn).toContain("!seen.contains(key)");
  expect(member(item, "nonisolated static func heldRows(_ state: PublishedState?) -> [SessionRow] {")).toContain(
    "state?.rows.filter { $0.review != nil && $0.status != .working } ?? []",
  );
  // The menu's Ready for you rows walk it too: that session's next unlooked-at item, as the pill opens one.
  const menuOpen = member(panels, "func open(session id: SessionRow.ID, store: StateStore, panels: FloatingPanels) {");
  expect(menuOpen).toContain("guard let item = ready(in: held, state: store.state).first ?? held.last else { return }");
  expect(menuOpen).toContain("stage(from: .menu, store: store, panels: panels) { state in Self.find(item.id, in: state) }");
  expect(member(item, "@objc private func openItem(_ sender: NSMenuItem) {")).toContain(
    "panels.queue.open(session: id, store: store, panels: panels)",
  );
  expect(panels).not.toContain("compactMap(ReviewItem.init(row:))");
  const held = member(panels, "var held: [ReviewInfo] {");
  expect(held).toContain("if let reviews, !reviews.isEmpty { return reviews }");
  expect(held).toContain("return review.map { [$0] } ?? []");
  // An older one is staged through stage, unchanged, as the row's review.
  expect(member(panels, "func holding(_ review: ReviewInfo) -> SessionRow {")).toContain("row.review = review");
  expect(read("mac-app/conch-mac/Models.swift")).toContain("    var review: ReviewInfo?\n");
  // Previous goes back through what was seen; Next goes on to the unopened.
  const walk = member(panels, "func walk(backward: Bool = false, from origin: ConchStatusItem.OpenFrom, store: StateStore, panels: FloatingPanels) {");
  expect(walk).toContain("? ReviewScene.previous(before: lastStaged, in: held.map { (key: $0.id, at: $0.reviewedAt ?? 0) })");
  expect(panels).toContain("onPrevious: walks ? { queue.walk(backward: true, from: .panel, store: store, panels: panels) } : nil,");
  expect(panels).toContain("onNext: walks ? { queue.walk(from: .panel, store: store, panels: panels) } : nil,");
  expect(panels).toContain("let walks = !ConchStatusItem.heldRows(store.state).isEmpty");
  const buttons = components.slice(components.indexOf("public struct FogPanelButtons: View {"), components.indexOf("// MARK: - FogHandle"));
  expect(buttons).toContain('IconButton("chevron.left", label: "Previous ready item", style: .glass, size: ConversationFog.buttonSize, shortcut: PanelKeys.Shortcut.previous, action: onPrevious)');
  expect(buttons).toContain('IconButton("chevron.right", label: "Next ready item", style: .glass, size: ConversationFog.buttonSize, shortcut: PanelKeys.Shortcut.next, action: onNext)');
});

/**
 * Tyler (09-24): "knows what content is on the screen and what session relates to that, ability to click next or select
 * different session form that and it goes to the fullscreen content for that agent (maybe just shows fullscreen text
 * transcript / writer convo if there is no content)".
 */
test("the panel names its session, switches from it, and shows the words full screen when there is nothing to open", () => {
  // The header: the session, its agent's mark (the session list's own assets), and the item it is on.
  expect(panels).toContain("session: row.map { Self.fogSession($0, item: Self.review(of: $0, staged: panels.staged, lastStaged: queue.lastStaged)?.summary) },");
  expect(panels).toContain('mark: codex ? "AgentCodex" : "AgentClaude"');
  const item = member(panels, "static func review(of row: SessionRow, staged: SessionRow.ID?, lastStaged: ReviewItem.ID?) -> ReviewInfo? {");
  // The item the queue brought forward, which follows a newer version of it (panel-quality-source pins how).
  expect(item).toContain("if row.id == staged, let review = row.held.first(where: { ReviewItem(row: row, review: $0).id == lastStaged }) {");
  expect(item.trimEnd().endsWith("return row.review")).toBe(true);
  // The switcher: the menu bar menu's groups, never a subagent, open state the panels' so a press elsewhere closes it.
  const sessions = member(panels, "static func sessions(_ state: PublishedState?, staged: SessionRow.ID?, lastStaged: ReviewItem.ID?) -> [FogSession] {");
  expect(sessions).toContain("ConchStatusItem.readyRows(state)");
  expect(sessions).toContain("ConchStatusItem.workingRows(state)");
  expect(sessions).toContain("FogSession.ordered(");
  expect(sessions).toContain(".filter { $0.parentSessionId == nil }");
  expect(panels).toContain("isSwitching: $panels.switching,");
  expect(member(panels, "func pressed() {")).toContain("if switching { switching = false }");
  expect(member(panels, "private func setCollapsed(_ collapsed: Bool) {")).toContain("switching = false");
  // A pick pins and stages through the same path as the pill.
  const pick = member(panels, "func pick(_ id: SessionRow.ID, store: StateStore, panels: FloatingPanels) {");
  expect(pick).toContain("panels.switching = false");
  expect(pick).toContain("stage(from: .panel, store: store, panels: panels)");
  expect(panels).toContain("onPick: { queue.pick($0, store: store, panels: panels) },");
  // From the panel: nothing to open is the words full screen (or a deliverable the panel draws, below); anything else
  // docks the panel, then stage's scene. One rule for every open (`ConchStatusItem.open`). (`item` is shadowed here.)
  const show = member(read("mac-app/conch-mac/StatusItem.swift"), "static func open(_ row: SessionRow, from origin: OpenFrom, store: StateStore, panels: FloatingPanels) async -> Bool {");
  const order = [
    'let kind = ReviewScene.Kind(rawValue: row.review?.sceneKind ?? "") ?? .auto',
    "let link = ReviewItem(row: row)?.link.map { LinkTarget.url(for: $0, cwd: row.cwd) }",
    "let words = origin == .panel",
    "&& ReviewScene.panelShowsWords(hasReview: row.review != nil, kind: kind, link: link, fileExists: { FileManager.default.fileExists(atPath: $0) })",
    "panels.showInPanel()",
    "return true",
    "panels.dockForScene()",
    "return await stage(row, store: store)",
  ].map((line) => show.indexOf(line));
  expect(order.every((at) => at > -1)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(member(panels, "func showInPanel() {")).toContain("if !isFullScreen { toggleFullScreen() }");
  expect(member(panels, "func dockForScene() {")).toContain("if isFullScreen { toggleFullScreen() }");
  // The terminal, or conch's window, asked for by name stays what was asked for.
  expect(member(components, "public static func panelShowsWords(hasReview: Bool, kind: Kind, link: URL?, fileExists: (String) -> Bool) -> Bool {")).toContain(
    "case .terminal, .conversation: return false",
  );
  // Every new control keeps its clicks: the fog's view takes a press anywhere that isn't one (FogTextTests pins it).
  expect(components).toContain("FogHeader(session: named, isOpen: isSwitching) { isSwitching.toggle() }");
  expect(components).toContain(".animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: Self.crossKey(named))\n            .fogControl()");
  expect(components).toContain("FogSwitcher(sessions: sessions, current: session?.id, selected: switcherSelection, tallest: room, onPick: onPick)\n                    .fogControl()");
  expect(components).toContain("SpeakingChip(session: speaking) { onPick(speaking.id) }\n                .fogControl()");
});

test("the words and the header crossfade to another session; the switcher springs full screen", () => {
  // panel-lab's crossover, not the hard cut: out soft and up, in from a little below, on the pop spring, the words a beat
  // behind the header; a dissolve is what Reduce Motion keeps. The header crosses over on its item too.
  expect(components).toContain(
    "transcript(width: width, height: height, top: top, fontSize: fontSize)\n                .id(session?.id)\n                .transition(cross)",
  );
  expect(components).toContain(".animation(ConchMotion.pop.animation(reduceMotion: reduceMotion).delay(ConchMotion.crossStagger), value: session?.id)");
  expect(components).toContain("FogHeader(session: named, isOpen: isSwitching) { isSwitching.toggle() }\n                    .id(Self.crossKey(named))\n                    .transition(cross)");
  const cross = components.slice(components.indexOf("private var cross: AnyTransition {"), components.indexOf("static func crossKey("));
  expect(cross).toContain("reduceMotion ? .opacity : .asymmetric(");
  expect(cross).toContain("Swap(scale: ConchMotion.crossScale, blur: ConchMotion.crossBlur, opacity: 0, y: ConchMotion.crossShift)");
  expect(cross).toContain("Swap(scale: ConchMotion.crossScale, blur: ConchMotion.crossBlur, opacity: 0, y: -ConchMotion.crossShift)");
  // The switcher pops on the pop spring as panel-lab's does, from .94, 6 pt toward the row and a 4 pt blur, its rows
  // following one another in; under Reduce Motion it only fades.
  expect(components).toContain(".animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: isSwitching)");
  expect(components).toContain("let pop: AnyTransition = reduceMotion ? .opacity : .modifier(");
  expect(components).toContain("active: Popped(scale: ConchMotion.popScale, anchor: anchor, y: up ? ConchMotion.popShift : -ConchMotion.popShift, blur: ConchMotion.popBlur, opacity: 0),");
  expect(components).toContain(".delay(ConchMotion.popLead + Double(index) * ConchMotion.popStagger), value: shown)");
  // No new spring: the morph is ConchMotion's own.
  expect(panels).not.toMatch(/ConchSpring\(bounce: [0-9.]+, response: [0-9.]+\)\.step\(&morph/);
});

/** The reply line can be turned off from the menu bar, next to Conversation Panel, and it stays off. */
test("Reply Line hides the panel's reply line, from the menu bar, remembered", () => {
  expect(item).toContain('static let showReplyLineKey = "conch.showReplyLine"');
  expect(item).toContain("Self.showReplyLineKey: true,");
  const statusMenu = read("design/ConchDesign/Sources/ConchDesign/StatusMenu.swift");
  const conversation = statusMenu.indexOf('Item(title: "Conversation Panel", command: .conversation,');
  const reply = statusMenu.indexOf('Item(title: "Reply Line", command: .replyLine, mark: input.replyLine ? .on : .off)');
  expect(conversation).toBeGreaterThan(-1);
  expect(reply).toBeGreaterThan(conversation);
  expect(member(item, "func menuNeedsUpdate(_ menu: NSMenu) {")).toContain("replyLine: defaults.bool(forKey: Self.showReplyLineKey),");
  expect(item).toContain("case .replyLine: #selector(toggleReplyLine)");
  expect(item).toContain("@objc private func toggleReplyLine() { toggle(Self.showReplyLineKey) }");
  expect(member(panels, "private func showWhatIsOn() {")).toContain("let reply = defaults.bool(forKey: ConchStatusItem.showReplyLineKey)");
  expect(panels).toContain("showsReply: panels.showsReply && row != nil,");
  // Off, the transcript takes the reply line's room, and the look thickens behind the newest words instead.
  expect(components).toContain("let box = showsReply ? max(0, frame.height - FogReply.gap - reply - noticeRoom) : frame.height");
  expect(components.match(/if showsReply \{ replyLine\(/g)?.length).toBe(2);
  expect(member(panels, "private func apply() {")).toContain("next.replyHeight = showsReply ? text.replyHeight : 0");
});

/** A hidden blur's mask is never drawn: on Liquid Glass the blur is hidden but for full screen, and a drag redrew it every frame. */
test("the blur's mask is drawn only while the blur shows", () => {
  const draws = panels.split("\n").filter((line) => line.includes("blur.maskImage = "));
  expect(draws.length).toBe(3);
  for (const line of draws) expect(line).toContain("!blur.isHidden");
  expect(member(panels, "private func setLook(_ next: FogLook) {")).toContain("if !blur.isHidden { blur.maskImage = blurMask() }");
  // Shown again, it is drawn then, after it is shown or hidden, in the one place that does both; on Liquid Glass it stays
  // hidden, full screen included, since the glass is kept there.
  const show = member(panels, "private func showBlur() {");
  expect(show.indexOf("if blur.isHidden != hidden { blur.isHidden = hidden }")).toBeLessThan(show.indexOf("if !blur.isHidden { blur.maskImage ="));
  for (const way of ["func toggleFullScreen() {", "private func setCollapsed(_ collapsed: Bool) {", "private func landed() {"]) {
    expect(member(panels, way)).toContain("showBlur()");
  }
});

test("the conversation stays on the pill's scene, whatever the voice does, until the pill again or another pick", () => {
  expect(panels).toContain("@Published var staged: SessionRow.ID?");
  expect(panels).toContain("let row = Self.session(store.state, staged: panels.staged)");
  // The chain itself is the window's, in the design system: the overlay pins a different
  // session from the dashboard, but both resolve it by the same rule and by identity.
  const session = member(panels, "static func session(_ state: PublishedState?, staged: SessionRow.ID? = nil) -> SessionRow? {");
  expect(session).toContain("WorkspaceFocus.viewed(in: Workspace(state), pinned: staged)");
  const workspace = read("design/ConchDesign/Sources/ConchDesign/Workspace.swift");
  const viewed = member(workspace, "public static func viewed(in workspace: Workspace, pinned: String?) -> String? {");
  const pinned = viewed.indexOf("if let pinnedSession = workspace.session(pinned)");
  const rest = viewed.indexOf("target(in: workspace, pinned: nil)");
  const cursor = viewed.indexOf("first(where: \\.isNavSelected)");
  expect(pinned).toBeGreaterThan(-1);
  expect(rest).toBeGreaterThan(pinned);
  expect(cursor).toBeGreaterThan(rest);
  const addressed = member(workspace, "public static func addressed(in workspace: Workspace) -> String? {");
  const live = addressed.indexOf("first(where: \\.isLive)");
  const replying = addressed.indexOf("first(where: \\.isReplying)");
  const active = addressed.indexOf("first(where: \\.isActive)");
  expect(live).toBeGreaterThan(-1);
  expect(replying).toBeGreaterThan(live);
  expect(active).toBeGreaterThan(replying);
  // Unpinned only by a pick in conch's window of another session; the pill's own .app scene picks the same one.
  expect(panels.match(/staged = nil/g)?.length).toBe(1);
  expect(member(panels, "static func picked(_ id: SessionRow.ID) {")).toContain("guard let panels = installed, panels.staged != nil, panels.staged != id else { return }");
  expect(read("mac-app/conch-mac/ContentView.swift")).toContain(".onChange(of: workspace.viewing) { _, id in\n            guard let id else { return }\n            FloatingPanels.picked(id)");
  // Staging never starts the mic or stops speech: not the pill's, the panel's, or the scene's.
  for (const body of [
    member(panels, "func walk(backward: Bool = false, from origin: ConchStatusItem.OpenFrom, store: StateStore, panels: FloatingPanels) {"),
    member(panels, "func open(session id: SessionRow.ID, store: StateStore, panels: FloatingPanels) {"),
    member(panels, "func pick(_ id: SessionRow.ID, store: StateStore, panels: FloatingPanels) {"),
    member(panels, "private func stage(\n        from origin: ConchStatusItem.OpenFrom,"),
    member(item, "static func open(_ row: SessionRow, from origin: OpenFrom, store: StateStore, panels: FloatingPanels) async -> Bool {"),
    member(item, "static func stage(_ row: SessionRow, store: StateStore) async -> Bool {"),
  ]) {
    for (const voiceAction of [".dictate", ".stop(", ".wake", ".speak", "store.send("]) expect(body).not.toContain(voiceAction);
  }
  // The bar doesn't observe the panels, whose motion publishes every frame.
  expect(panels).toContain("    let panels: FloatingPanels\n    /// Its ideal size");
});

/**
 * 09-21, "BOTH": full screen shows the deliverable IN the panel, the reply floating over it. A pick of a kind the panel
 * draws stays in the panel, full screen; an app window, the Simulator, a terminal, a design or an office document still
 * comes forward in its own app, the panel docking first, as before.
 */
/**
 * One opening rule for the pill, the menu's rows, the switcher and Previous and Next: while the panel is on, a deliverable
 * it draws opens in it, full screen, and so does one with marks from anywhere (marks are drawn only where conch shows the
 * work); anything else comes forward in its own app, the panel docking first. The pill used to open everything in its own
 * app, and over a full-screen panel it did both at once.
 */
test("one opening rule: a deliverable the panel draws opens in it while it is on, one with marks always; any other stages", () => {
  // The rule is ConchDesign's (XCTests pin its cases): the kinds the side panel's renderers draw, by the filed kind.
  const rule = member(components, "public static func panelShowsContent(kind: Kind, deliverable: String?, link: URL?, fileExists: (String) -> Bool) -> Bool {");
  expect(components).toContain('static let panelKinds: Set<String> = ["page", "markdown", "text", "image", "pdf", "video", "audio", "url"]');
  expect(rule).toContain("guard case let .open(url) = choose(kind: kind, link: link, fileExists: fileExists, appWindowOpen: false, revealable: false) else { return false }");
  expect(rule).toContain("if let deliverable { return panelKinds.contains(deliverable) }");
  // Read off the row as stage reads a scene, with the kind the daemon filed.
  const content = member(panels, "var panelContent: ReviewItem? {");
  expect(content).toContain('let kind = ReviewScene.Kind(rawValue: review.sceneKind ?? "") ?? .auto');
  expect(content).toContain("let link = item.link.map { LinkTarget.url(for: $0, cwd: cwd) }");
  expect(content).toContain("ReviewScene.panelShowsContent(kind: kind, deliverable: review.kind, link: link, fileExists: { FileManager.default.fileExists(atPath: $0) }) ? item : nil");
  // In the panel's branch, beside the words: out and open, full screen, then handed off. Anything else docks and stages.
  const show = member(item, "static func open(_ row: SessionRow, from origin: OpenFrom, store: StateStore, panels: FloatingPanels) async -> Bool {");
  const order = [
    "let content = row.panelContent",
    "let marked = !(row.review?.marks.isEmpty ?? true)",
    "if (content != nil && (defaults.bool(forKey: showConversationKey) || marked)) || words {",
    "panels.bringOut()\n            panels.showInPanel()",
    "return true",
    "panels.dockForScene()",
    "return await stage(row, store: store)",
  ].map((line) => show.indexOf(line));
  expect(order.every((at) => at > -1)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // The first open from the pill or the menu turns the panel on, docked and open, once; from inside it, never.
  const first = show.indexOf("if origin != .panel, !defaults.bool(forKey: panelTurnedOnByOpenKey) {");
  expect(first).toBeGreaterThan(-1);
  expect(first).toBeLessThan(show.indexOf("let content = row.panelContent"));
  expect(show.slice(first, show.indexOf("let content"))).toContain("defaults.set(true, forKey: panelTurnedOnByOpenKey)\n            panels.bringOut()");
  expect(item).toContain('static let panelTurnedOnByOpenKey = "conch.conversationTurnedOnByOpen"');
  // Out and open at once, in the menu's own defaults so it is remembered, not on their notice's later turn.
  const bringOut = member(panels, "func bringOut() {");
  expect(bringOut).toContain("UserDefaults.standard.set(true, forKey: ConchStatusItem.showConversationKey)");
  expect(bringOut).toContain("UserDefaults.standard.set(false, forKey: Self.conversationCollapsedKey)");
  expect(bringOut.indexOf("showWhatIsOn()")).toBeGreaterThan(bringOut.indexOf("conversationCollapsedKey"));
  // The screen context still hears what the panel's Next put on screen, now the panel itself, with the deliverable.
  expect(show).toContain(
    'store.reportShowing(.conch(sessionId: row.id, view: "panel"), staged: ConchScreenStaged(sessionId: row.id, reviewId: content?.id, link: content?.link))',
  );
  // The pill, the menu and the panel all go through it.
  expect(panels).toContain("onTap: { queue.walk(from: .pill, store: store, panels: panels) }");
  expect(member(panels, "private func stage(\n        from origin: ConchStatusItem.OpenFrom,")).toContain(
    "guard await ConchStatusItem.open(found.row, from: origin, store: store, panels: panels), let key = found.key else { return }",
  );
  expect(panels).not.toContain("ConchStatusItem.stage(");
  // Full screen shows the item the header names: one rule for both, read from the queue's walk.
  expect(panels).toContain("content: panels.form == .fullScreen ? row.flatMap(content(of:)) : nil,");
  const shown = member(panels, "private func content(of row: SessionRow) -> FogContent? {");
  expect(shown).toContain("guard let review = Self.review(of: row, staged: panels.staged, lastStaged: queue.lastStaged),");
  expect(shown).toContain("let item = row.holding(review).panelContent else { return nil }");
  expect(shown).toContain("return FogContent(id: item.id) { PanelContent(item: item, cwd: row.cwd, store: store, panels: panels) }");
  // The side panel's own renderer, so a local file gets its checks (the web view's file policy, the missing and the
  // unpreviewable states); no second web view here.
  expect(member(panels, "private struct PanelContent: View {")).toContain("InlineReviewView(item: item, onOpenInPlace: openWhereItLives, liveAddress: $address)");
  expect(panels).not.toMatch(/WKWebView|DeliverableWebView\(|loadFileURL/);
  // Its arrow opens it where it lives, the panel docking first so it isn't left over what comes forward.
  const out = member(panels, "private func openWhereItLives() {");
  expect(out.indexOf("panels.dockForScene()")).toBeGreaterThan(-1);
  expect(out.indexOf("panels.dockForScene()")).toBeLessThan(out.indexOf("store.openLink(link, cwd: cwd, rowId: item.rowID)"));
});

/** Opening a deliverable in the panel counts it looked at, exactly as staging it elsewhere does: the one existing call. */
test("a deliverable shown in the panel is marked viewed through stage, as a staged one is", () => {
  // The panel's branch reports a handoff (true), so stage goes on to count it opened and tell the daemon.
  const show = member(item, "static func open(_ row: SessionRow, from origin: OpenFrom, store: StateStore, panels: FloatingPanels) async -> Bool {");
  const from = show.indexOf("|| words {");
  expect(from).toBeGreaterThan(-1);
  const branch = show.slice(from, show.indexOf("panels.dockForScene()"));
  expect(branch.length).toBeGreaterThan(100);
  expect(branch).toContain("panels.showInPanel()");
  expect(branch).toContain("return true");
  expect(branch).not.toContain("return false");
  const stage = member(panels, "private func stage(\n        from origin: ConchStatusItem.OpenFrom,");
  expect(stage).toContain("guard await ConchStatusItem.open(found.row, from: origin, store: store, panels: panels), let key = found.key else { return }");
  expect(stage.indexOf("opened.insert(key)")).toBeGreaterThan(stage.indexOf("await ConchStatusItem.open("));
  expect(stage.indexOf("store.markReviewViewed(sessionId: found.row.id, review: key)")).toBeGreaterThan(stage.indexOf("opened.insert(key)"));
  // No second path that marks, or forgets to.
  expect(panels.match(/opened\.insert/g)?.length).toBe(1);
  expect(panels.match(/markReviewViewed\(/g)?.length).toBe(1);
});

/**
 * Next and Previous in full screen swap the deliverable in place: the old out soft and a touch large, the new in from a
 * touch small and soft, on ConchMotion's swap; under Reduce Motion a plain fade. The words step aside while it shows, and
 * the reply line floats at its foot, still under Show reply line.
 */
test("the deliverable in the panel crossfades in place, the words step aside, and the reply floats at its foot", () => {
  expect(tokens).toContain("public static let swap = ConchSpring(bounce: 0.08, response: 0.52)");
  expect(tokens).toContain('("swap", swap)');
  const card = member(components, "private func deliverable(_ shown: FogContent?, frame: CGRect) -> some View {");
  expect(card).toContain("let swap: AnyTransition = reduceMotion ? .opacity : .asymmetric(");
  expect(card).toContain("insertion: .modifier(active: Swap(scale: ConchMotion.swapScale, blur: ConchMotion.swapBlur, opacity: 0), identity: Swap()),");
  expect(card).toContain("removal: .modifier(active: Swap(scale: 2 - ConchMotion.swapScale, blur: ConchMotion.swapBlur, opacity: 0), identity: Swap())");
  expect(card).toContain("shown.view\n                        .frame(width: frame.width, height: frame.height)\n                        .id(shown.id)\n                        .transition(swap)");
  expect(card).toContain(".animation(ConchMotion.swap.animation(reduceMotion: reduceMotion), value: shown?.id)");
  // Rounded, with a hairline; its presses and scrolls its own (FogTextTests pins the frames).
  expect(card).toContain(".clipShape(shape)\n                .overlay(shape.strokeBorder(ConchColor.overlayLine, lineWidth: 0.5))\n                .fogControl()");
  // Only full screen; the words only while nothing shows; the capsule only with the reply line on.
  expect(components).toContain("let shown = isFullScreen ? content : nil");
  expect(components).toContain("if shown == nil {\n                    if session == nil, turns.isEmpty, let empty {\n                        emptyState(empty, in: frame)\n                    } else {\n                        VStack(alignment: .leading, spacing: FogReply.gap) {");
  expect(components).toContain("if shown != nil, showsReply { floatingReply(in: proxy.size, fontSize: fontSize, height: reply, overflows: overflows) }");
  expect(member(components, "private func floatingReply(in size: CGSize, fontSize: CGFloat, height: CGFloat, overflows: Bool) -> some View {")).toContain(".fogControl()");
});
