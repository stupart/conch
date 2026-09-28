import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { ACCESSIBILITY_REFUSED, FRONT_TTY_SCRIPT, injectKey, injectKeys, injectText, type InjectTextOptions, type OsaResult } from "../src/inject.ts";

// conch's macOS permissions, made clean (2026-09-27). Tyler: "just make sure accessibility stuff is clean — one
// permission for the app and it has proper setting / error messages in the app too." Each permission is granted once,
// to conch.app: macOS charges the daemon, and the osascript and recorder it runs, to the app that started it. The pure
// rules are ConchDesign's (PermissionsTests); these pin the wiring that can't run headless, and the daemon's reason.

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
/** Swift with its line comments out, so a rule is about code and not about prose naming it. */
const code = (source: string): string => source.replace(/\/\/.*$/gm, "");
const macSources = Object.fromEntries(
  readdirSync(join(root, "mac-app/conch-mac"))
    .filter((name) => name.endsWith(".swift"))
    .map((name) => [name, read(`mac-app/conch-mac/${name}`)]),
);
const filesWith = (needle: string): string[] =>
  Object.keys(macSources).filter((name) => code(macSources[name]!).includes(needle)).sort();

/** A Swift member from its signature to its closing brace at `indent` spaces. */
function member(source: string, signature: string, indent = 4): string {
  const start = source.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf(`\n${" ".repeat(indent)}}\n`, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const permissions = read("mac-app/conch-mac/Permissions.swift");
const permissionsCode = code(permissions);
const perform = member(permissionsCode, "func perform(_ action: ConchPermissionAction, for permission: ConchPermission, store: StateStore) {");
const design = read("design/ConchDesign/Sources/ConchDesign/Permissions.swift");

/** Every way the permissions center can make macOS show a permission prompt. */
const PROMPTS = [
  "AXIsProcessTrustedWithOptions",
  "kAXTrustedCheckOptionPrompt",
  // The canvas's once-a-launch Screen Recording ask, which is `CGRequestScreenCaptureAccess`.
  "CanvasCapture.granted()",
  "requestAccess(for: .audio",
  "automation(ask: true)",
];

describe("never a prompt at launch: every answer is read silently, and asked for only on a press", () => {
  test("the prompts are in perform, the buttons' one function, and nowhere else in the permissions center", () => {
    const rest = permissionsCode.replace(perform, "");
    for (const prompt of PROMPTS) {
      expect(perform, prompt).toContain(prompt);
      expect(rest, `${prompt} outside perform`).not.toContain(prompt);
    }
  });

  test("reading uses only the questions that never prompt", () => {
    const here = member(permissionsCode, "nonisolated static func readHere() -> [ConchPermission: ConchPermissionStatus] {");
    const all = member(permissionsCode, "nonisolated static func readAll() -> [ConchPermission: ConchPermissionStatus] {");
    for (const reading of [here, all]) {
      expect(reading).toContain("AXIsProcessTrusted()");
      expect(reading).toContain("CGPreflightScreenCaptureAccess()");
      expect(reading).toContain("AVCaptureDevice.authorizationStatus(for: .audio)");
      for (const prompt of PROMPTS) expect(reading).not.toContain(prompt);
    }
    expect(all).toContain("ConchPermissionReading.automation(automation(ask: false))");
    // Asked of a new process only when this one says no: a yes needs no second opinion.
    expect(all).toContain("screen ? nil : screenRecordingInNewProcess()");
    // Automation's question takes `ask` from its caller, and only perform passes true.
    const automation = member(permissionsCode, "nonisolated static func automation(ask: Bool) -> [(app: String, status: Int32)] {");
    expect(automation).toContain("AEDeterminePermissionToAutomateTarget(&address, typeWildCard, typeWildCard, ask)");
    expect(permissionsCode.match(/automation\(ask: true\)/g)?.length).toBe(1);
    expect(filesWith("AEDeterminePermissionToAutomateTarget")).toEqual(["Permissions.swift"]);
  });

  test("launch reads, and never performs", () => {
    const init = member(permissionsCode, "private init() {");
    expect(init).toContain("statuses = Self.readHere()");
    expect(init).toContain("refresh()");
    expect(init).not.toContain("perform(");
    const refresh = member(permissionsCode, "func refresh(after delay: Duration = .zero) {");
    expect(refresh).toContain("PermissionCenter.readAll()");
    expect(refresh).not.toContain("perform(");
    // perform is called by a button, and by itself for the two macOS never says weren't asked; by nothing else.
    const calls = Object.entries(macSources).flatMap(([name, source]) =>
      (code(source).match(/[\w.]*\.perform\([^)]*\)|\bperform\(\.[a-zA-Z]+/g) ?? []).map((call) => `${name}: ${call}`));
    expect(calls.sort()).toEqual([
      // Setup's permission rows and its guide, through the same one door (OnboardingController.swift).
      "OnboardingController.swift: PermissionCenter.shared.perform(action, for: permission, store: stateStore)",
      "Permissions.swift: center.perform($0, for: notice.permission, store: store)",
      "Permissions.swift: center.perform(action, for: permission, store: store)",
      "Permissions.swift: perform(.openSettings",
      // The Terminal tab's Screen Recording button, and its first-time ask after a press on the tab.
      "TerminalMirror.swift: PermissionCenter.shared.perform(action, for: .screenRecording, store: store)",
    ]);
  });

  test("no file the app launches through asks for a permission", () => {
    for (const file of ["ConchMacApp.swift", "StateStore.swift", "Notices.swift", "SettingsView.swift", "FrontWindowObserver.swift", "StatusItem.swift", "ContentView.swift", "DaemonHost.swift", "WindowPreview.swift"]) {
      const swift = code(macSources[file]!);
      for (const prompt of [...PROMPTS, "CGRequestScreenCaptureAccess", "AEDeterminePermissionToAutomateTarget"]) {
        expect(swift, `${file}: ${prompt}`).not.toContain(prompt);
      }
    }
    // The ones that do ask are the permissions center, on a press, and the canvas's own Send and Show.
    expect(filesWith("AXIsProcessTrustedWithOptions")).toEqual(["Permissions.swift"]);
    expect(filesWith("CGRequestScreenCaptureAccess")).toEqual(["CanvasSend.swift"]);
    expect(filesWith("requestAccess(for: .audio")).toEqual(["Permissions.swift"]);
  });

  test("a new process's Screen Recording answer comes from osascript's JavaScript, which checks and sends no Apple Event", () => {
    const probe = member(permissionsCode, "nonisolated static func screenRecordingInNewProcess() -> Bool? {");
    expect(probe).toContain('process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")');
    expect(probe).toContain('process.arguments = ["-l", "JavaScript", "-e", screenRecordingProbe]');
    // Bounded: a probe that hangs says nothing, rather than holding a refresh.
    expect(probe).toContain("let deadline = Date().addingTimeInterval(2)");
    expect(probe).toContain("process.terminate()");
    expect(permissions).toContain('#"ObjC.import("CoreGraphics"); ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]); $.CGPreflightScreenCaptureAccess()"#');
    expect(permissions).not.toContain("tell application");
  });
});

describe("Open Settings goes to the permission's own list, through the store's one door", () => {
  test("each permission names its own anchor on Privacy & Security", () => {
    expect(design).toContain('URL(string: "x-apple.systempreferences:com.apple.preference.security?\\(settingsAnchor)")!');
    for (const anchor of ["Privacy_Accessibility", "Privacy_Automation", "Privacy_ScreenCapture", "Privacy_Microphone"]) {
      expect(design).toContain(`"${anchor}"`);
    }
    // The canvas's own Screen Recording link is the same place.
    expect(read("mac-app/conch-mac/CanvasSend.swift")).toContain("com.apple.preference.security?Privacy_ScreenCapture");
  });

  test("Open Settings opens it, after listing conch where macOS lists only apps that asked", () => {
    const open = member(permissionsCode, "private func openSettings(_ permission: ConchPermission, store: StateStore) {");
    expect(open).toContain("store.openLink(permission.settingsURL.absoluteString, cwd: nil, rowId: nil)");
    const settings = perform.slice(perform.indexOf("case .openSettings:"), perform.indexOf("case .ask:"));
    expect(settings).toContain("case .accessibility where !AXIsProcessTrusted():");
    expect(settings).toContain("case .screenRecording:\n                _ = CanvasCapture.granted()");
    expect(settings).toContain("openSettings(permission, store: store)");
    // Reopen is the store's relaunch, through the canvas's wrapper that notices when it didn't happen.
    expect(perform.slice(perform.indexOf("case .reopen:"))).toContain("CanvasCapture.reopen(store) { [weak self] in");
  });
});

describe("it reads again whenever the answer may have changed", () => {
  test("on conch coming to the front, on Accessibility's list changing, and on Settings opening", () => {
    const init = member(permissionsCode, "private init() {");
    expect(init).toContain("forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main\n        ) { [weak self] _ in\n            MainActor.assumeIsolated { self?.refresh() }");
    expect(init).toContain("observers.append(DistributedNotificationCenter.default().addObserver(\n            forName: Self.accessibilityListChanged");
    expect(permissions).toContain('static let accessibilityListChanged = Notification.Name("com.apple.accessibility.api")');
    expect(member(permissionsCode, "struct ConchPermissionsView: View {", 0)).toContain(".onAppear { center.refresh() }");
    // A trouble noted is read against a fresh answer.
    expect(member(permissionsCode, "func note(_ trouble: ConchPermissionTrouble) {")).toContain("refresh()");
  });

  test("the front-window observer switches pages and documents on as the grant lands, with no relaunch", () => {
    const observer = code(read("mac-app/conch-mac/FrontWindowObserver.swift"));
    const reading = member(observer, "private func read(after delay: Duration) {");
    // Asked at every reading, never kept from launch.
    expect(reading).toContain("let trusted = AXIsProcessTrusted()");
    expect(observer).not.toMatch(/let trusted = AXIsProcessTrusted\(\)\s*\n\s*\n?\s*init\(/);
    expect(observer).toContain("forName: PermissionCenter.accessibilityListChanged, object: nil, queue: .main\n        ) { [weak self] _ in\n            MainActor.assumeIsolated { self?.read(after: .milliseconds(500)) }");
  });
});

describe("where a feature fails, the app says which permission, with the button that fixes it", () => {
  test("Settings has a Permissions tab, and the window a line for the trouble", () => {
    const app = read("mac-app/conch-mac/ConchMacApp.swift");
    expect(app).toContain('ConchPermissionsView()\n                    .tabItem { Label("Permissions", systemImage: "hand.raised") }');
    expect(read("mac-app/conch-mac/Notices.swift")).toContain("    PermissionNoticeLine()\n");
    const line = member(permissionsCode, "struct PermissionNoticeLine: View {", 0);
    expect(line).toContain("daemonIsConchs: daemon.startedBy == \"app\"");
    expect(line).toContain("onDismiss: { center.dismiss(notice.trouble) }");
    // Settings says who macOS is asking when the daemon isn't conch's, and offers the launchd handover it already has.
    const view = member(permissionsCode, "struct ConchPermissionsView: View {", 0);
    expect(view).toContain("caution: ConchPermissionHost.caution(startedBy: daemon.startedBy)");
    expect(view).toContain('cautionAction: daemon.startedBy == "launchd" ? (title: "Let the app own it", run: { daemon.takeOverFromLaunchd() }) : nil');
  });

  test("a send refused for a permission is noted, and a phone's snapshot refused for Screen Recording too", () => {
    const store = read("mac-app/conch-mac/StateStore.swift");
    const outcomes = store.slice(store.indexOf("private func applyDeliveryOutcomes("), store.indexOf("private static func deliveryState(of outcome:"));
    expect(outcomes).toContain("if let trouble = ConchPermissionTrouble(sendFailure: outcome.reason) { PermissionCenter.shared.note(trouble) }");
    const preview = read("mac-app/conch-mac/WindowPreview.swift");
    expect(preview).toContain("guard CGPreflightScreenCaptureAccess() else {\n            // The phone can't fix it; the Mac's window says so, with the button that can.\n            PermissionCenter.shared.note(.screen)");
  });

  test("every file naming the shared permission types imports the design system", () => {
    for (const file of ["Permissions.swift", "Notices.swift", "StateStore.swift", "WindowPreview.swift", "CanvasSend.swift", "FrontWindowObserver.swift"]) {
      expect(macSources[file], file).toContain("import ConchDesign");
    }
    const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");
    expect(project.match(/Permissions\.swift/g)?.length).toBe(6);
    expect(project).toContain("/* Permissions.swift in Sources */ = {isa = PBXBuildFile;");
  });

  test("a hardened conch may ask for Automation: the entitlement is there, beside the microphone's", () => {
    const entitlements = read("mac-app/conch-mac/conch-mac.entitlements");
    expect(entitlements).toContain("<key>com.apple.security.automation.apple-events</key>\n\t<true/>");
    expect(entitlements).toContain("<key>com.apple.security.device.audio-input</key>\n\t<true/>");
  });
});

describe("the daemon names a keystroke macOS refused for Accessibility", () => {
  const cfg = { autoSubmit: false, keystrokeFallback: true } as Config;
  /** Terminal raises the window and says the tab is in front; whatever types is answered with `typing`. */
  const refusing = (typing: OsaResult): InjectTextOptions => ({
    clipboardFallback: false,
    findTmuxPane: async () => null,
    ttyForPid: async () => "ttys001",
    sleep: async () => {},
    osa: async (lines) => {
      const script = lines.join("\n");
      if (script === FRONT_TTY_SCRIPT) return { text: "/dev/ttys001", timedOut: false, exitCode: 0 };
      if (script.includes("activate")) return { text: "ok", timedOut: false, exitCode: 0 };
      return typing;
    },
  });
  const refused = (stderr: string): OsaResult => ({ text: "", timedOut: false, exitCode: 1, stderr });

  test("System Events' words for it, in every form, are Accessibility's reason", async () => {
    for (const stderr of [
      "execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)",
      "execution error: System Events got an error: osascript is not allowed assistive access. (-1719)",
      "execution error: System Events got an error: AppleEvent handler failed (-25211)",
    ]) {
      expect(ACCESSIBILITY_REFUSED.test(stderr), stderr).toBe(true);
      expect(await injectText(cfg, 42, "words", undefined, refusing(refused(stderr))))
        .toEqual({ via: "none", failed: true, reason: "accessibility-permission-denied" });
      expect(await injectKey(cfg, 42, "Enter", undefined, refusing(refused(stderr))))
        .toEqual({ via: "none", failed: true, reason: "accessibility-permission-denied" });
      expect(await injectKeys(cfg, 42, ["Enter"], undefined, refusing(refused(stderr))))
        .toEqual({ via: "none", failed: true, reason: "accessibility-permission-denied" });
    }
  });

  test("-1719 alone is AppleScript's Invalid index, not Accessibility; Automation keeps its own reason", async () => {
    const invalid = "execution error: Terminal got an error: Can’t get window 1. Invalid index. (-1719)";
    expect(ACCESSIBILITY_REFUSED.test(invalid)).toBe(false);
    expect(await injectText(cfg, 42, "words", undefined, refusing(refused(invalid))))
      .toEqual({ via: "none", failed: true, reason: "automation-failed" });
    expect(await injectText(cfg, 42, "words", undefined, refusing(refused("execution error: Not authorized to send Apple events to System Events. (-1743)"))))
      .toEqual({ via: "none", failed: true, reason: "automation-permission-denied" });
  });

  test("the daemon asks macOS about its own trust without ever prompting", () => {
    const trust = read("src/accessibility.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(trust).toContain("AXIsProcessTrusted: { args: [], returns: FFIType.bool }");
    expect(trust).not.toMatch(/WithOptions|Prompt"/);
    expect(read("src/daemon.ts")).toContain('import { accessibilityTrusted } from "./accessibility.ts";');
  });
});
