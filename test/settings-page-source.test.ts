import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Settings, a page of conch's window (2026-10-11). It was SwiftUI's `Settings` scene, a window of its own at most 840 by
 * 620; Tyler: "why is the settings thing so small and a seperate window?". The page's state (which section, shown or not,
 * ⌘, and Esc going back) is ConchDesign's SettingsPageState, tested by XCTest (SettingsPageTests). These pin the wiring a
 * Swift test can't reach: every way in goes to the page through the one router, nothing can open a Settings window, the
 * window shows the page in place of the sessions with a way back, and the page is laid out and lit as the PR says.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
/** Swift with its line comments out, so a rule is about code and not about prose naming it. */
const code = (source: string): string => source.replace(/\/\/.*$/gm, "");

const macDir = join(root, "mac-app/conch-mac");
const macSources = Object.fromEntries(
  readdirSync(macDir)
    .filter((name) => name.endsWith(".swift"))
    .map((name) => [name, code(read(`mac-app/conch-mac/${name}`))]),
);
const app = macSources["ConchMacApp.swift"];
const content = macSources["ContentView.swift"];
const settings = macSources["SettingsView.swift"];
const statusItem = macSources["StatusItem.swift"];
const notices = macSources["Notices.swift"];
const dashboard = macSources["DashboardView.swift"];
const statusMenu = code(read("design/ConchDesign/Sources/ConchDesign/StatusMenu.swift"));

/** A Swift member from its signature to its closing brace at `indent` spaces. */
function member(source: string, signature: string, indent = 4): string {
  const start = source.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf(`\n${" ".repeat(indent)}}\n`, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const count = (source: string, needle: string): number => source.split(needle).length - 1;

describe("there is no Settings window", () => {
  test("the app has no Settings scene, and nothing in the Mac app opens one", () => {
    expect(app).not.toMatch(/\bSettings\s*\{/);
    for (const [name, source] of Object.entries(macSources)) {
      // SwiftUI's way to open the scene, and AppKit's.
      expect(source, name).not.toContain("\\.openSettings");
      expect(source, name).not.toContain("OpenSettingsAction");
      expect(source, name).not.toContain("showSettingsWindow");
      expect(source, name).not.toContain("showPreferencesWindow");
      expect(source, name).not.toContain("orderFrontPreferencesPanel");
      // The old root, which only ever lived in that window.
      expect(source, name).not.toContain("ConchSettingsRootView");
    }
  });

  test("conch › Settings… and ⌘, are the app menu's own item, and it goes to the page", () => {
    const appSettings = app.slice(app.indexOf("CommandGroup(replacing: .appSettings) {"));
    expect(appSettings).toStartWith(
      'CommandGroup(replacing: .appSettings) {\n                Button("Settings…") { SettingsRouter.shared.command() }\n                    .keyboardShortcut(",", modifiers: .command)',
    );
    expect(count(app, ".keyboardShortcut(\",\"")).toBe(1);
  });
});

describe("every way in reaches the page, through the one router", () => {
  test("the router is the app's one, and opening brings the window forward", () => {
    expect(settings).toContain("final class SettingsRouter: ObservableObject {\n    static let shared = SettingsRouter()");
    const open = member(settings, "func open(_ section: SettingsSection? = nil) {");
    expect(open).toContain("state.open(section)");
    expect(open).toContain("remember()");
    expect(open).toContain("bringForward()");
    expect(settings).toContain("var bringForward: () -> Void = { ConchStatusItem.bringConchForward() }");
    // ⌘, goes back only from the window in front; anywhere else it brings Settings forward.
    const command = member(settings, "func command() {");
    expect(command).toContain("state.toggle(windowInFront: inFront)");
    expect(command).toContain("window?.isMainWindow == true");
    expect(command).toContain("if state.isShown { bringForward() }");
    // The section viewed last, under the key the separate window used.
    expect(member(settings, "private func remember() {")).toContain("defaults.set(state.section.rawValue, forKey: SettingsSection.storageKey)");
    expect(settings).toContain("SettingsSection(stored: defaults.string(forKey: SettingsSection.storageKey))");
  });

  test("the header's gear", () => {
    expect(dashboard).toContain("let onOpenSettings: () -> Void");
    expect(dashboard).toContain('symbol: "gearshape",');
    expect(dashboard).toContain("action: actions.onOpenSettings");
    expect(content).toContain("onOpenSettings: openSettings,");
    expect(member(content, "private func openSettings() {")).toContain("settings.open()");
  });

  test("the menu bar menu's Settings…", () => {
    const rows = member(statusMenu, "public static func rows(_ input: Input) -> [Row] {");
    expect(rows).toContain('rows.append(.item(Item(title: "Settings…", command: .settings, key: ",", modifiers: [.command])))');
    expect(statusItem).toContain("case .settings: #selector(openSettings)");
    expect(member(statusItem, "@objc private func openSettings() {")).toContain("SettingsRouter.shared.open()");
    // Internal, so the router brings the window forward the way the menu's Open conch does.
    expect(statusItem).toContain("    static func bringConchForward() {");
  });

  test("Manage… beside an account in the New session sheet: Providers", () => {
    expect(content).toContain('Button("Manage…") { dismiss(); SettingsRouter.shared.open(.providers) }');
    expect(content).not.toContain('@AppStorage("conch.settings.section")');
  });

  test("the natural voices' Why?: General, where their own line is", () => {
    const line = notices.slice(notices.indexOf("private struct NaturalVoicesNoticeLine"));
    expect(line).toContain("case .why: SettingsRouter.shared.open(.general)");
  });

  test("Help's items are setup's and the shortcuts', never a Settings window", () => {
    const help = app.slice(app.indexOf("CommandGroup(after: .help) {"), app.indexOf("@MainActor\nprivate final class ConchAppDelegate"));
    expect(help).toContain("OnboardingController.shared.openFromHelp()");
    expect(help).not.toMatch(/Settings/);
    // The shortcut list says what ⌘, does now.
    expect(content).toContain('ShortcutHelpRow(command: "⌘,", result: "Settings, and back to your sessions")');
  });
});

describe("the window shows the page in place of the sessions, and gives them back", () => {
  test("the page takes the whole window while it shows", () => {
    expect(content).toContain("@ObservedObject private var settings = SettingsRouter.shared");
    const body = member(content, "    var body: some View {", 4);
    expect(body).toMatch(/if settings\.state\.isShown \{\s*ConchSettingsPage\(router: settings\)\s*\} else \{\s*DashboardView\(/);
  });

  test("the back control, in the strip where the sidebar's button sits", () => {
    const page = settings.slice(settings.indexOf("struct ConchSettingsPage: View {"));
    expect(page).toContain("SettingsStrip(titleBarInset: proxy.safeAreaInsets.top, onBack: router.close)");
    expect(page).toContain(".ignoresSafeArea(.container, edges: .top)");
    const button = settings.slice(settings.indexOf("private struct SettingsBackButton: View {"));
    expect(button).toContain('Image(systemName: "chevron.left")');
    expect(button).toContain('Text("Sessions")');
    expect(button).toContain('.accessibilityLabel("Back to your sessions")');
  });

  test("Esc stops a reading first, then goes back; the sessions' other keys do nothing on the page", () => {
    const keys = member(content, "private func handleDashboardKey(_ key: DashboardKey) -> Bool {");
    const page = keys.slice(keys.indexOf("if settings.state.isShown {"), keys.indexOf("        switch key {\n        case .talkOrStop:"));
    expect(page).toContain("case .stopSpeaking:");
    expect(page).toContain("case .releaseSelection:\n                return settings.escape()");
    expect(page).toContain("default:\n                return false");
  });

  test("a session asked for from anywhere leaves the page for it", () => {
    for (const signature of [
      "private func selectSession(_ row: SessionRow) {",
      "private func openInWindow(_ row: SessionRow, review: ReviewItem.ID?) {",
      "private func showStarted(_ id: SessionRow.ID) {",
    ]) {
      expect(member(content, signature), signature).toContain("settings.close()");
    }
    const lagoon = content.slice(content.indexOf(".onReceive(NotificationCenter.default.publisher(for: .showLagoon))"));
    expect(lagoon.slice(0, lagoon.indexOf("\n        }"))).toContain("settings.close()");
    // Closing when it isn't showing publishes nothing, so a row click doesn't redraw the window for it.
    expect(member(settings, "    func close() {")).toContain("guard state.isShown else { return }");
  });
});

describe("the page's layout and appearance", () => {
  test("the list beside a section that runs to the readable column, its scroller at the window's edge", () => {
    const page = settings.slice(settings.indexOf("struct ConchSettingsPage: View {"));
    expect(page).toContain(".frame(width: SettingsLayout.listWidth)");
    expect(page).toContain(".contentMargins(.trailing, SettingsLayout.trailingMargin(width: content.size.width), for: .scrollContent)");
    // Every section, and each one's header in the scroll view with it, so the column holds all of it.
    for (const section of ["providers", "environments", "tools", "browser", "general", "phone", "permissions", "setup"]) {
      expect(page, section).toContain(`case .${section}:`);
    }
    expect(settings).toContain('SettingsSectionHeader(title: "General"');
    expect(settings).toContain('SettingsSectionHeader(title: "Environments"');
    expect(macSources["BrowserSettingsView.swift"]).toContain('SettingsSectionHeader(title: "Browser"');
    expect(macSources["Permissions.swift"]).toContain('SettingsSectionHeader(title: "Permissions"');
    expect(macSources["PairingView.swift"]).toContain('SettingsSectionHeader(title: "Phone app"');
    expect(macSources["OnboardingController.swift"]).toContain(".frame(maxWidth: .infinity, alignment: .topLeading)");
  });

  test("dark while it shows, set on the window and put back as it was", () => {
    expect(settings).toContain(".background(SettingsAppearance(name: SettingsAppearance.pinned))");
    expect(settings).toContain("static let pinned: NSAppearance.Name? = .darkAqua");
    const pin = settings.slice(settings.indexOf("final class Pin: NSView {"));
    expect(pin).toContain("previous = window.appearance");
    expect(pin).toContain("window.appearance = NSAppearance(named: name)");
    expect(member(pin, "func release() {", 8)).toContain("window.appearance = previous");
    // Not SwiftUI's preferredColorScheme, whose going back is SwiftUI's to get right.
    expect(settings).not.toContain(".preferredColorScheme(");
  });
});
