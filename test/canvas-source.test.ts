import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The canvas (wave 2): clear glass over whatever is on screen that Tyler draws on, and sends as one picture. These pin
// the window mechanics that can't be run headless — levels, click-through, keys, the hotkey — and the rules that keep it
// from ever acting on its own.

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** A Swift member from its signature to its closing brace at `indent` spaces. */
function member(source: string, signature: string, indent = 4): string {
  const start = source.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf(`\n${" ".repeat(indent)}}\n`, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const canvas = read("mac-app/conch-mac/Canvas.swift");
const panels = read("mac-app/conch-mac/FloatingPanels.swift");
const item = read("mac-app/conch-mac/StatusItem.swift");
const components = read("design/ConchDesign/Sources/ConchDesign/Components.swift");
const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");

describe("the glass", () => {
  test("one borderless, non-activating panel per display, at the status bar level, on every space and hidden by Mission Control", () => {
    const build = member(canvas, "private func buildGlass() {");
    expect(build).toContain("glass = NSScreen.screens.compactMap { screen in");
    expect(build).toContain(
      "let panel = FloatingPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)",
    );
    // Above the Dock and the menu bar, below menus and system alerts; `.floating` sat under both and tied other apps'.
    expect(build).toContain("panel.level = .statusBar");
    expect(build).toContain("panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .transient]");
    expect(canvas).not.toMatch(/collectionBehavior = \[[^\]]*\.stationary/);
    for (const clear of ["panel.backgroundColor = .clear", "panel.isOpaque = false", "panel.hasShadow = false", "panel.hidesOnDeactivate = false"]) {
      expect(build).toContain(clear);
    }
    // Rebuilt when the displays change: with separate Spaces no window spans two.
    expect(canvas).toContain("forName: NSApplication.didChangeScreenParametersNotification");
    expect(canvas).toContain("MainActor.assumeIsolated { self?.buildGlass() }");
    expect(project).toContain("/* Canvas.swift in Sources */ = {isa = PBXBuildFile;");
    expect(project.match(/\/\* Canvas\.swift in Sources \*\/,/g)?.length).toBe(1);
  });

  test("it lets every click through unless the pen is down, and never while sending", () => {
    const build = member(canvas, "private func buildGlass() {");
    expect(build).toContain("panel.ignoresMouseEvents = true");
    const apply = member(canvas, "func apply() {");
    expect(apply).toContain("panel.ignoresMouseEvents = !armed || sending");
    // The only other writes to it: none. The window server hit-tests whole windows, so this one flag is the mechanism.
    expect(canvas.match(/ignoresMouseEvents = /g)?.length).toBe(2);
    // The pen down draws; up, a press does nothing even if one arrives.
    expect(member(canvas, "override func mouseDown(with event: NSEvent) {")).toContain("guard let controller, controller.armed else { return }");
  });

  test("armed, it takes the keys without bringing conch forward", () => {
    const arm = member(canvas, "func arm() {");
    expect(arm).toContain("under.panel.makeKey()");
    expect(arm).toContain("under.panel.makeFirstResponder(under.ink)");
    expect(member(canvas, "func apply() {")).toContain("panel.takesKeys = inUse");
    // `FloatingPanel` only becomes key while `takesKeys`; nothing here activates conch or makes a window main.
    expect(panels).toContain("override var canBecomeKey: Bool { takesKeys }");
    for (const intrusion of ["NSApp.activate", "makeKeyAndOrderFront", "makeMain", "activate(ignoringOtherApps"]) {
      expect(canvas).not.toContain(intrusion);
    }
  });

  test("Esc lifts the pen and keeps the ink; Esc again clears it", () => {
    expect(member(canvas, "override func keyDown(with event: NSEvent) {")).toContain("case UInt16(kVK_Escape):\n            controller?.escape()");
    expect(member(canvas, "func escape() {")).toContain("armed ? lift() : clear()");
    const lift = member(canvas, "func lift() {");
    expect(lift).toContain("armed = false");
    expect(lift).not.toContain("document = nil\n        apply");
    expect(lift).toContain("if document?.isEmpty == true { document = nil }");
    // ⌘Z takes the newest mark, unless a note's words are being typed.
    const undo = member(canvas, "override func performKeyEquivalent(with event: NSEvent) -> Bool {");
    expect(undo).toContain('event.charactersIgnoringModifiers == "z"');
    expect(undo).toContain("window?.firstResponder === self");
    expect(undo).toContain("controller?.undo()");
  });

  test("a new item in the panel starts a clear canvas: the old ink lifts away", () => {
    const install = member(canvas, "func install(store: StateStore) {");
    expect(install).toContain("panels.$staged.combineLatest(panels.queue.$lastStaged)");
    expect(install).toContain(".sink { [weak self] _ in MainActor.assumeIsolated { self?.clear() } }");
    const show = member(canvas, "func show(_ document: CanvasDocument?, armed: Bool) {");
    expect(show).toContain("if document?.id != shown {\n            liftAway()");
    // Reduce Motion keeps the fade and drops the blur.
    const lift = member(canvas, "private func liftAway() {");
    expect(lift).toContain("CASpringAnimation(perceptualDuration: 0.32, bounce: 0)");
    expect(lift).toContain("if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, let blur = CIFilter(name: \"CIGaussianBlur\")");
  });

  test("live ink is one layer with no implicit animation; each finished mark its own layer from the one path builder", () => {
    const live = member(canvas, "private func drawLive() {");
    expect(live).toContain("CATransaction.setDisableActions(true)");
    expect(live).toContain("live.path = CanvasInk.shape(of: mark, in: bounds.size).ink");
    expect(member(canvas, "static func layer(for mark: CanvasMark, in size: CGSize) -> CALayer {")).toContain("let shape = CanvasInk.shape(of: mark, in: size)");
    // A mouse's pressure is flat: only a tablet's is kept, and the width comes from speed otherwise.
    expect(canvas).toContain("p: event.subtype == .tabletPoint ? round(Double(event.pressure), 1000) : nil");
    expect(canvas).toContain("NSEvent.isMouseCoalescingEnabled = false");
  });
});

describe("turning it on", () => {
  test("a Carbon hotkey, its chord in one place, needing no permission", () => {
    expect(canvas).toContain("static let key = UInt32(kVK_ANSI_P)");
    expect(canvas).toContain("static let modifiers = UInt32(controlKey | optionKey | cmdKey)");
    expect(canvas.match(/RegisterEventHotKey\(/g)?.length).toBe(1);
    expect(canvas).toContain("RegisterEventHotKey(key, modifiers,");
    expect(canvas).toContain("MainActor.assumeIsolated { CanvasController.shared.toggle() }");
    // A global monitor needs Accessibility and an event tap Input Monitoring: neither is used.
    for (const needsPermission of ["addGlobalMonitorForEvents", "CGEvent.tapCreate", "tapCreate("]) {
      expect(canvas).not.toContain(needsPermission);
    }
  });

  test("the panel's pen button, added without changing any caller that doesn't pass it", () => {
    const buttons = components.slice(components.indexOf("public struct FogPanelButtons: View {"), components.indexOf("// MARK: - FogHandle"));
    expect(buttons).toContain("onCanvas: (() -> Void)? = nil, isCanvasOn: Bool = false) {");
    expect(buttons).toContain("if let onCanvas {");
    expect(components).toContain("        onCanvas: (() -> Void)? = nil,\n        isCanvasOn: Bool = false\n    ) {");
    expect(panels).toContain("onCanvas: { canvas.toggle() },\n                    isCanvasOn: canvas.armed");
    expect(panels).toContain("@ObservedObject private var canvas = CanvasController.shared");
  });

  test("the menu's Canvas, showing the hotkey, and installed after the panels it follows", () => {
    const menu = member(item, "func menuNeedsUpdate(_ menu: NSMenu) {");
    expect(menu).toContain('entry("Canvas", #selector(toggleCanvas), checked: CanvasController.shared.armed, key: "p")');
    expect(menu).toContain("canvas.keyEquivalentModifierMask = [.control, .option, .command]");
    expect(item).toContain("@objc private func toggleCanvas() { CanvasController.shared.toggle() }");
    const install = member(item, "static func install(store: StateStore) {");
    expect(install.indexOf("FloatingPanels.install(store: store)")).toBeLessThan(install.indexOf("CanvasController.shared.install(store: store)"));
  });

  test("the tools are their own panel above the glass that always takes clicks", () => {
    const install = member(canvas, "func install(store: StateStore) {");
    expect(install).toContain("pill.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)");
    expect(install).toContain("pill.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .transient]");
    expect(install).toContain("pill.contentView = FirstClickHostingView(");
    expect(install).not.toContain("pill.ignoresMouseEvents");
    expect(canvas).toContain(
      "private let pill = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)",
    );
  });
});
