import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

function at(text: string, marker: string, from = 0): number {
  const index = text.indexOf(marker, from);
  expect(index, `missing: ${marker}`).toBeGreaterThan(-1);
  return index;
}

/** A Swift function from its signature to its closing brace at method indentation. */
function body(text: string, signature: string): string {
  const start = at(text, signature);
  const end = text.indexOf("\n    }\n", start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

/** The name of the Swift function whose body contains `index`. */
function enclosingFunction(text: string, index: number): string {
  const declaration = text.lastIndexOf(" func ", index);
  expect(declaration).toBeGreaterThan(-1);
  return text.slice(declaration + 6).match(/^\w+/)![0];
}

const item = read("mac-app/conch-mac/StatusItem.swift");
const app = read("mac-app/conch-mac/ConchMacApp.swift");
const content = read("mac-app/conch-mac/ContentView.swift");
const macProject = read("mac-app/conch-mac.xcodeproj/project.pbxproj");
const iosProject = read("mobile/conch-ios/conch-ios.xcodeproj/project.pbxproj");

/**
 * M2: the conch mark lives in the menu bar as an AppKit NSStatusItem with a standard NSMenu. SwiftUI's
 * MenuBarExtra draws a custom label once, blocks the run loop while open, and exposes no item to watch
 * for the notch, so it must not come back.
 */
test("M2: the menu bar item is an NSStatusItem with an NSMenu, not MenuBarExtra", () => {
  expect(item).toContain("item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)");
  expect(item).toContain("item.menu = menu");
  expect(item).toContain("func menuNeedsUpdate(_ menu: NSMenu) {");
  expect(app).toContain("Task { @MainActor in ConchStatusItem.install(store: store) }");
  expect(macProject).toContain("/* StatusItem.swift in Sources */ = {isa = PBXBuildFile;");
  expect(macProject.match(/\/\* StatusItem\.swift in Sources \*\/,/g)?.length).toBe(1);
  // Presence above, absence here: an empty file must not pass.
  for (const source of [item, app, content]) {
    expect(source.length).toBeGreaterThan(1_000);
    expect(source).not.toMatch(/MenuBarExtra\s*[({]/);
  }
});

test("M2: each menu item calls the command the dashboard already sends", () => {
  expect(item).toContain('entry("Talk", #selector(talk), checked: !quiet)');
  expect(item).toContain('entry("Quiet", #selector(quietMode), checked: quiet)');
  expect(item).toContain("@objc private func talk() { store.send(.global(.resume)) }");
  expect(item).toContain("@objc private func quietMode() { store.send(.global(.pause)) }");
  expect(item).toContain("@objc private func stopSpeaking() { store.send(.stop()) }");
  expect(content).toContain("store.send(.global(.resume))");
  expect(content).toContain("store.send(.global(.pause))");
  expect(content).toContain("store.send(.stop())");

  // A session: bring the window forward and select it through ContentView's own selectSession.
  expect(body(item, "@objc private func openSession(_ sender: NSMenuItem) {")).toContain("Self.openSession(id)");
  const open = body(item, "static func openSession(_ id: SessionRow.ID) {");
  expect(open).toContain("bringConchForward()");
  expect(open).toContain("NotificationCenter.default.post(name: .selectSessionFromStatusItem, object: id)");
  const receive = at(content, "NotificationCenter.default.publisher(for: .selectSessionFromStatusItem)");
  expect(content.slice(receive, receive + 400)).toContain("selectSession(row)");
  expect(body(item, "@objc private func openConch() {")).toContain("bringConchForward()");

  // Ready for you is the daemon's reviewReady rule (PR #191): a review, and not working.
  expect(item).toContain("state?.rows.filter { $0.review != nil && $0.status != .working } ?? []");
  expect(read("src/panel.ts")).toContain('return row.review !== undefined && row.status !== "working";');
  // Each group's mark in the sidebar's colour for the same state: ready's green, working's blue.
  expect(item).toContain('addSessions("Ready for you", ready, symbol: "circle.fill", colour: ConchColor.ready, to: menu)');
  expect(item).toContain('addSessions("Working", working, symbol: "circle", colour: ConchColor.active, to: menu)');
});

test("M2: Show control bar is on by default, and both M3 toggles persist", () => {
  const register = at(item, "UserDefaults.standard.register(defaults: [");
  const defaults = item.slice(register, at(item, "])", register));
  expect(defaults).toContain("Self.showControlBarKey: true,");
  expect(defaults).toContain("Self.showConversationKey: false,");
  expect(item).toContain(
    'entry("Show control bar", #selector(toggleControlBar), checked: defaults.bool(forKey: Self.showControlBarKey))',
  );
  expect(item).toContain("UserDefaults.standard.set(!UserDefaults.standard.bool(forKey: key), forKey: key)");
});

test("M2: the status item takes focus only for Open conch and opening a session", () => {
  const activate = [...item.matchAll(/NSApp\.activate\(/g)];
  expect(activate.length).toBe(1);
  expect(enclosingFunction(item, activate[0]!.index!)).toBe("bringConchForward");
  const raise = [...item.matchAll(/makeKeyAndOrderFront\(/g)];
  expect(raise.length).toBe(1);
  expect(enclosingFunction(item, raise[0]!.index!)).toBe("bringConchForward");
  expect(item).not.toContain("orderFrontRegardless");

  const callers = [...item.matchAll(/bringConchForward\(\)/g)].map((match) => enclosingFunction(item, match.index!));
  expect(callers.sort()).toEqual(["bringConchForward", "openConch", "openSession"]);
});

test("M2: the whole mark recolours by state, and Talk is the template image", () => {
  const mark = read("design/ConchDesign/Sources/ConchDesign/ConchMark.swift");
  expect(mark).toContain("image.isTemplate = state == .talk");
  expect(mark).toContain("public static func statusImage(for state: VoiceState, side: CGFloat = 16) -> NSImage {");
  expect(item).toContain(".map(Self.voiceState)");
  expect(item).toContain("button.image = ConchMark.statusImage(for: voice, side: 18)");
});

test("M2: the notch hiding the item is noticed, logged, and conch stays in the Dock", () => {
  expect(item).toContain("forName: NSWindow.didChangeOcclusionStateNotification");
  expect(item).toContain("let visible = window.occlusionState.contains(.visible)");
  expect(item).toContain('NSLog("conch: the menu bar item is hidden');
  expect(item).toContain("if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) }");
  const plist = read("mac-app/conch-mac/Info.plist");
  expect(plist).toContain("<key>CFBundleIdentifier</key>");
  expect(plist).not.toContain("LSUIElement");
});

test("M1: both apps link the ConchDesign local package", () => {
  expect(read("design/ConchDesign/Package.swift")).toContain('.library(name: "ConchDesign", targets: ["ConchDesign"])');
  const projects: [string, string, string][] = [
    [macProject, "mac-app", "../design/ConchDesign"],
    [iosProject, "mobile/conch-ios", "../../design/ConchDesign"],
  ];
  for (const [project, dir, path] of projects) {
    expect(project).toContain(`isa = XCLocalSwiftPackageReference;\n\t\t\trelativePath = ${path};`);
    expect(existsSync(join(root, dir, path, "Package.swift"))).toBe(true);
    expect(project).toContain("isa = XCSwiftPackageProductDependency;");
    expect(project).toContain("productName = ConchDesign;");
    expect(project).toContain("/* ConchDesign in Frameworks */ = {isa = PBXBuildFile; productRef = ");
    expect(project.match(/\/\* ConchDesign in Frameworks \*\/,/g)?.length).toBe(1);
    expect(project).toContain("packageReferences = (");
    expect(project).toContain("packageProductDependencies = (");
  }
  expect(item).toContain("import ConchDesign");
});
