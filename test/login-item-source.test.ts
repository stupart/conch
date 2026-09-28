import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Opening conch at login, as the app wires it. The rules (when a launch registers, never again, what a switch shows,
 * what each line says and which carry the Login Items button) are ConchDesign's LoginItemPolicy, tested by XCTest
 * (LoginItemPolicyTests). These pin what can't run headless: the first launch registers through that rule and only
 * there, the line is said where it will be seen, the switches are macOS's answer, and every fix opens Login Items.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
/** Swift with its line comments out, so a rule is about code and not about prose naming it. */
const code = (source: string): string => source.replace(/\/\/.*$/gm, "");

const support = code(read("mac-app/conch-mac/OnboardingSupport.swift"));
const app = code(read("mac-app/conch-mac/ConchMacApp.swift"));
const controller = code(read("mac-app/conch-mac/OnboardingController.swift"));
const notices = code(read("mac-app/conch-mac/Notices.swift"));
const settings = code(read("mac-app/conch-mac/SettingsView.swift"));
const policy = code(read("design/ConchDesign/Sources/ConchDesign/LoginItemPolicy.swift"));
const pages = code(read("design/ConchDesign/Sources/ConchDesign/OnboardingMac.swift"));
const macSources = Object.fromEntries(
  readdirSync(join(root, "mac-app/conch-mac"))
    .filter((name) => name.endsWith(".swift"))
    .map((name) => [name, code(read(`mac-app/conch-mac/${name}`))]),
);

/** A Swift member from its signature to its closing brace at `indent` spaces. */
function member(source: string, signature: string, indent = 4): string {
  const start = source.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf(`\n${" ".repeat(indent)}}\n`, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const count = (source: string, needle: string): number => source.split(needle).length - 1;

describe("the first launch registers, visibly", () => {
  test("applicationDidFinishLaunching registers through the rule, before setup decides what opens", () => {
    const launch = member(app, "func applicationDidFinishLaunching(_ notification: Notification) {");
    expect(launch).toContain("LoginItem.shared.registerAtLaunch()");
    expect(launch.indexOf("LoginItem.shared.registerAtLaunch()")).toBeLessThan(launch.indexOf("OnboardingController.shared.appDidFinishLaunching()"));
    // Called from nowhere else.
    const callers = Object.entries(macSources).filter(([, source]) => source.includes("registerAtLaunch()")).map(([name]) => name).sort();
    expect(callers).toEqual(["ConchMacApp.swift", "OnboardingSupport.swift"]);
  });

  test("the launch registers only when the rule says, and records that it did", () => {
    const launch = member(support, "func registerAtLaunch() {");
    expect(launch).toContain("LoginItemPolicy.atLaunch(record, legacyDecided: UserDefaults.standard.bool(forKey: Self.legacyDecidedKey),");
    expect(launch).toContain("status: status, installed: installed)");
    expect(launch).toContain("if step.register {\n            let refused = !register(on: true)");
    expect(launch).toContain("next = LoginItemPolicy.registered(next, refused: refused)");
    expect(launch).toContain("if next != record { save(next) }");
    // #441's key is read as a decision already made, never written.
    expect(support).toContain('private static let legacyDecidedKey = "conch.loginItemDecided"');
    expect(count(support, "forKey: Self.legacyDecidedKey")).toBe(1);
  });

  test("the record survives a relaunch: every field is written and read back under its own key", () => {
    const save = member(support, "private func save(_ next: LoginItemRecord) {");
    const load = member(support, "private static func load() -> LoginItemRecord {");
    for (const key of ["choiceKey", "registeredOnceKey", "announceKey", "refusedKey"]) {
      expect(save, key).toContain(`forKey: Self.${key}`);
      expect(load, key).toContain(`forKey: ${key}`);
    }
    expect(save).toContain("record = next");
  });

  test("installed is Applications, or Homebrew's link there, never a checkout's build", () => {
    const installed = member(support, "static var installed: Bool {");
    expect(installed).toContain('["/Applications/conch.app", home + "/Applications/conch.app"]');
    expect(installed).toContain("destinationOfSymbolicLink(atPath: path)");
    expect(installed).toContain("LoginItemPolicy.installed(bundlePath: Bundle.main.bundleURL.resolvingSymlinksInPath().path, home: home, linkedCopies: links)");
    expect(policy).toContain('if path.hasPrefix("/Applications/") { return true }');
  });
});

describe("never again", () => {
  test("only a launch that has never registered, and wasn't told not to, registers", () => {
    const atLaunch = member(policy, "public static func atLaunch(");
    expect(atLaunch).toContain("guard installed else { return (record, false) }");
    expect(atLaunch).toContain("guard !next.registeredOnce, next.choice != .off else { return (next, false) }");
    const registered = member(policy, "public static func registered(_ record: LoginItemRecord, refused: Bool) -> LoginItemRecord {");
    expect(registered).toContain("next.registeredOnce = true");
  });

  test("macOS is asked only by the launch's rule and a switch the person pressed", () => {
    // register(on:) is called twice: the launch (on) and the switch (either way).
    expect(count(support, "register(on: ")).toBe(3); // the definition and its two callers
    expect(member(support, "func set(_ on: Bool) {")).toContain("refusal = register(on: on) ? nil : (on ? .refused : .refusedOff)");
    // The switch records the choice before asking, so off stays off even when macOS refuses.
    const set = member(support, "func set(_ on: Bool) {");
    expect(set.indexOf("LoginItemPolicy.switched(record, on: on, installed: installed)")).toBeLessThan(set.indexOf("register(on: on)"));
  });
});

describe("the line, where it will be seen", () => {
  test("setup's launch settles where it goes: the welcome when that is what opened, else the window", () => {
    const launch = member(controller, "private func launch() async {");
    expect(launch).toContain("defer { LoginItem.shared.setupSettled(welcomeOnScreen: welcomeOnScreen) }");
    expect(controller).toContain("window?.isVisible == true && model.welcomeBack == nil && (model.shownStep ?? .welcome) == .welcome");
    const settled = member(support, "func setupSettled(welcomeOnScreen: Bool) {");
    expect(settled).toContain("guard let line = announcement else { return }");
    expect(settled).toContain("welcomeLine = line\n            dismissAnnouncement()");
    expect(settled).toContain("announceInWindow = true");
  });

  test("the welcome's footer says it, with the Login Items button when macOS wants it allowed", () => {
    expect(controller).toContain("OnboardingWelcome(backdrop: .shore, loginLine: login.welcomeLine?.words, onOpenLoginItems: loginFix(login.welcomeLine),");
    const welcome = member(pages, "public struct OnboardingWelcome: View {", 0);
    expect(welcome).toContain("if let loginLine {");
    expect(welcome).toContain("OnboardingButton(LoginItemLine.openLoginItems, style: .action, action: onOpenLoginItems)");
  });

  test("otherwise the window's notices say it once, until OK", () => {
    expect(member(notices, "struct WorkspaceNotices: View {", 0)).toContain("LoginItemNoticeLine()");
    const line = member(notices, "private struct LoginItemNoticeLine: View {", 0);
    expect(line).toContain("if login.announceInWindow, let line = login.announcement {");
    expect(line).toContain("Text(line.words)");
    expect(line).toContain('Button("OK", action: login.dismissAnnouncement)');
    expect(line).toContain("if line.opensLoginItems {\n                    Button(LoginItemLine.openLoginItems, action: login.openLoginItems)");
    const dismiss = member(support, "func dismissAnnouncement() {");
    expect(dismiss).toContain("next.announce = false");
    expect(dismiss).toContain("save(next)");
  });

  test("the words", () => {
    expect(policy).toContain('case .added: "conch opens when you log in, so your agents can reach you. Turn this off in Settings."');
    expect(policy).toContain('case .needsApproval: "Allow conch in System Settings › General › Login Items."');
    expect(policy).toContain('public static let openLoginItems = "Open Login Items"');
  });
});

describe("the switches are macOS's answer", () => {
  test("You're set keeps its switch, reading LoginItem, with the fix beside a note that has one", () => {
    expect(controller).toContain("OnboardingDoneStep(summary: summary, actions: firstActions, openAtLogin: login.isOn, loginNote: login.note?.words,");
    expect(controller).toContain("onToggleLogin: { login.set($0) }, onOpenLoginItems: loginFix(login.note),");
    expect(member(controller, "private func loginFix(_ line: LoginItemLine?) -> (() -> Void)? {")).toContain("guard line?.opensLoginItems == true else { return nil }");
    expect(pages).toContain("OnboardingButton(LoginItemLine.openLoginItems, style: .action, action: onOpenLoginItems)");
  });

  test("Settings has the same switch, under conch's own, read again when it shows", () => {
    const view = member(settings, "struct ConchSettingsView: View {", 0);
    expect(view).toContain("LoginItemRow()");
    expect(view.indexOf("DaemonPowerRow(daemon: daemon)")).toBeLessThan(view.indexOf("LoginItemRow()"));
    expect(view.indexOf("LoginItemRow()")).toBeLessThan(view.indexOf("content"));
    const row = member(settings, "private struct LoginItemRow: View {", 0);
    expect(row).toContain("Toggle(\"\", isOn: Binding(get: { login.isOn }, set: { login.set($0) }))");
    expect(row).toContain("Text(\"Open conch when you log in\")");
    expect(row).toContain("if login.note?.opensLoginItems == true {\n                Button(LoginItemLine.openLoginItems, action: login.openLoginItems)");
    expect(row).toContain(".onAppear { login.refresh() }");
  });

  test("what the switches show is SMAppService's status, read again when conch comes forward", () => {
    expect(member(support, "var isOn: Bool")).toContain("LoginItemPolicy.isOn(status)");
    const read = member(support, "private static func read() -> LoginItemStatus {");
    expect(read).toContain("switch SMAppService.mainApp.status {");
    expect(read).toContain("case .requiresApproval: .requiresApproval");
    expect(member(support, "private init() {")).toContain("forName: NSApplication.didBecomeActiveNotification");
    expect(member(policy, "public static func isOn(_ status: LoginItemStatus) -> Bool {")).toContain("status == .enabled || status == .requiresApproval");
  });

  test("the approval path: requiresApproval and every refusal open System Settings › General › Login Items", () => {
    expect(member(support, "func openLoginItems() {")).toContain("SMAppService.openSystemSettingsLoginItems()");
    const opens = member(policy, "public var opensLoginItems: Bool {");
    expect(opens).toContain("case .needsApproval, .refused, .refusedOff: true");
    expect(member(policy, "public static func note(status: LoginItemStatus, installed: Bool, refusal: LoginItemLine?) -> LoginItemLine? {"))
      .toContain("if status == .requiresApproval { return .needsApproval }");
    // A refusal is reported, as every Mac failure is.
    expect(member(support, "private func register(on: Bool) -> Bool {")).toContain('operation: on ? "login-item.register" : "login-item.unregister"');
  });
});
