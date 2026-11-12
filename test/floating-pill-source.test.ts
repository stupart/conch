import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The floating pill (2026-11-11). Tyler: "redoing the live overlay idea, simplifying it to just have one lil nub or pill
// and actually work." conch-mac has no XCTest target, so these pin the wiring; FloatingPillTests pins the rules (the
// switch and its migration, what it says, what a click opens, its buttons, where it docks) and FloatingPillRenderTests
// how it is drawn.

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

const pill = read("mac-app/conch-mac/FloatingPillController.swift");
const rule = read("design/ConchDesign/Sources/ConchDesign/FloatingPill.swift");
const item = read("mac-app/conch-mac/StatusItem.swift");
const menu = read("design/ConchDesign/Sources/ConchDesign/StatusMenu.swift");
const settings = read("mac-app/conch-mac/SettingsView.swift");
const snapshot = read("mac-app/conch-mac/DebugSnapshot.swift");
const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");

describe("its window", () => {
  test("floats over every app and space, never activates conch or takes the keys, and stays out of the window cycle", () => {
    const panel = pill.slice(pill.indexOf("final class FloatingPillPanel: NSPanel {"), pill.indexOf("\n}\n", pill.indexOf("final class FloatingPillPanel")));
    expect(panel).toContain("override var canBecomeKey: Bool { false }");
    expect(panel).toContain("override var canBecomeMain: Bool { false }");
    const make = member(pill, "private func makePanel() -> FloatingPillPanel {");
    expect(make).toContain("styleMask: [.borderless, .nonactivatingPanel]");
    expect(make).toContain("panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]");
    expect(make).toContain("panel.level = .statusBar");
    expect(make).toContain("panel.hidesOnDeactivate = false");
    expect(make).toContain("panel.isOpaque = false");
    expect(make).toContain("panel.backgroundColor = .clear");
    // Shown without ordering conch forward.
    expect(member(pill, "private func apply() {")).toContain("panel.orderFrontRegardless()");
    expect(pill).not.toContain("makeKeyAndOrderFront");
  });

  test("its presses are its own, before SwiftUI, so a drag survives the window moving under it; its first click acts", () => {
    expect(pill).toContain("override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }");
    expect(pill).toContain("options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect]");
    const mouse = member(pill, "private func mouse(_ event: NSEvent) -> Bool {");
    // A press on a button goes on to SwiftUI, by the rule's own frames; anywhere else on the pill is a click or a drag.
    expect(mouse).toContain("FloatingPill.action(at: local, in: model.rect.size, actions: model.face.actions)");
    expect(mouse).toContain("hypot(dx, dy) >= FloatingPill.dragThreshold");
    expect(mouse).toContain("drop()");
    expect(mouse).toContain("open()");
    // Let go, it docks where the rule says, and remembers.
    expect(member(pill, "private func drop() {")).toContain("save(FloatingPill.dock(droppedAt: frame, in: screen.visibleFrame, display: Self.displayID(of: screen)))");
    expect(member(pill, "private func place(animated: Bool) {")).toContain("FloatingPill.frame(size: size(expanded: model.expanded), dock: dock, in: screen.visibleFrame)");
  });
});

describe("the switch", () => {
  test("is read one way, on until turned off, and migrated from the old overlays' once at install", () => {
    expect(rule).toContain('public static let key = "conch.floatingPill"');
    expect(rule).toContain("public static let byDefault = true");
    expect(pill).toContain("nonisolated static var isOn: Bool { FloatingPill.enabled(stored: UserDefaults.standard.object(forKey: FloatingPill.key)) }");
    const install = member(pill, "func install(store: StateStore) {");
    expect(install).toContain("Self.migrate(UserDefaults.standard)");
    expect(install.indexOf("Self.migrate(UserDefaults.standard)")).toBeLessThan(install.indexOf("apply()"));
    // Flipped anywhere (the menu, Settings, its own context menu), it shows or goes at once.
    expect(install).toContain("forName: UserDefaults.didChangeNotification");
    // Installed with the status item, at launch.
    expect(member(item, "static func install(store: StateStore) {")).toContain("FloatingPillController.shared.install(store: store)");
  });

  test("is in the menu bar menu with a tick, and in Settings beside opening at login", () => {
    expect(menu).toContain('Item(title: "Floating Pill", command: .floatingPill, mark: input.floatingPill ? .on : .off)');
    expect(item).toContain("floatingPill: FloatingPillController.isOn");
    expect(member(item, "@objc private func toggleFloatingPill() {")).toContain("UserDefaults.standard.set(!FloatingPillController.isOn, forKey: FloatingPill.key)");
    expect(settings).toContain("@AppStorage(FloatingPill.key) private var isOn = FloatingPill.byDefault");
    const card = settings.slice(settings.indexOf("OnboardingCard {"), settings.indexOf("StaleToolsCard()"));
    expect(card.indexOf("LoginItemRow()")).toBeLessThan(card.indexOf("FloatingPillRow()"));
  });
});

describe("what it does", () => {
  test("asks the daemon for everything, as the window's own controls do, and never makes a sound itself", () => {
    const act = member(pill, "private func act(_ action: FloatingPill.Action) {");
    expect(act).toContain("store.send(.stop())");
    expect(act).toContain("store.send(.wake(sessionId: target.id, label: target.label))");
    expect(act).toContain("store.send(.global(input.manual ? .resume : .pause))");
    for (const sound of ["NSSpeechSynthesizer", "AVSpeechSynthesizer", "AVAudio", "NSSound", "say("]) {
      expect(pill, sound).not.toContain(sound);
    }
  });

  test("its click opens what needs Tyler by the one opening rule, else conch's window on the voice's session", () => {
    const open = member(pill, "private func open() {");
    expect(open).toContain("switch FloatingPill.open(input) {");
    expect(open).toContain("case let .ready(id): ReviewQueue.shared.open(session: id, store: store)");
    expect(open).toContain("case let .session(id): ConchStatusItem.openSession(id)");
    expect(open).toContain("case .conch: ConchStatusItem.bringConchForward()");
  });

  test("reads the daemon's published state through the store: the voice's session, needs, working, manual", () => {
    const input = member(pill, "nonisolated static func input(_ state: PublishedState?, daemonMessage: String?) -> FloatingPill.Input {");
    expect(input).toContain("state.rows.filter { $0.parentSessionId == nil }");
    expect(input).toContain("row.approval != nil ? .permission");
    expect(input).toContain("ReadyForYou.isReady(");
    expect(input).toContain("voiceSession: state.rows.first { $0.active && $0.parentSessionId == nil }?.id");
    expect(input).toContain("manual: state.mode.paused");
    expect(input).toContain("audioElsewhere: !state.audioControl.isLocal");
  });
});

describe("a debug capture", () => {
  test("photographs it by name and never takes it for conch's window", () => {
    expect(snapshot).toContain("case key, pill, dashboard, geometry");
    expect(snapshot).toContain("case .pill: window = onScreen.first { $0 === FloatingPillController.shared.window }");
    expect(snapshot).toContain("let candidates = onScreen.filter { $0 !== FloatingPillController.shared.window }");
    expect(read("src/cli.ts")).toContain('const targets = ["key", "pill", "dashboard", "geometry"];');
  });
});

test("is in the Xcode project, built with the app", () => {
  expect(project).toContain("/* FloatingPillController.swift in Sources */ = {isa = PBXBuildFile;");
  expect(project.split("FloatingPillController.swift in Sources */,").length - 1).toBe(1);
});
