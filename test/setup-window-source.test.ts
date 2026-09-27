import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Setup's Mac window, hosted for real (Wave A of conch-design/onboarding/README.md §5). The rule and the pages are
 * ConchDesign's, tested by XCTest (OnboardingTests, OnboardingReportsTests); the daemon's half is first-run-setup.test.ts.
 * These pin the app's wiring, which can't run headless: what opens at launch, the one permission door and its guide,
 * the microphone never Apple's, the login item and the notifications ask moved to where they're needed.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
/** Swift with its line comments out, so a rule is about code and not about prose naming it. */
const code = (source: string): string => source.replace(/\/\/.*$/gm, "");

const controller = code(read("mac-app/conch-mac/OnboardingController.swift"));
const support = code(read("mac-app/conch-mac/OnboardingSupport.swift"));
const app = code(read("mac-app/conch-mac/ConchMacApp.swift"));
const statusItem = code(read("mac-app/conch-mac/StatusItem.swift"));
const content = code(read("mac-app/conch-mac/ContentView.swift"));
const daemon = read("src/daemon.ts");
const server = read("src/control-server.ts");
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

describe("the window", () => {
  test("an AppKit window, hidden title bar, the design's size, hosting the design's pages", () => {
    const show = member(controller, "func show() {");
    expect(show).toContain("contentRect: NSRect(origin: .zero, size: OnboardingWindowMetrics.size)");
    expect(show).toContain("styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView]");
    expect(show).toContain("window.titleVisibility = .hidden");
    expect(show).toContain("window.titlebarAppearsTransparent = true");
    expect(show).toContain("NSHostingView(rootView: OnboardingRootView(model: model, controller: self))");
    for (const page of ["OnboardingWindow(", "OnboardingAgentsStep(", "OnboardingPermissionsStep(", "OnboardingVoiceStep(",
      "OnboardingPhoneStep(", "OnboardingDoneStep(", "OnboardingWelcomeBack(", "OnboardingWelcome(backdrop: .shore"]) {
      expect(controller, page).toContain(page);
    }
    // Pages swap on the design's spring, and Reduce Motion is read where the transition is chosen.
    expect(controller).toContain(".transition(.onboardingSwap(reduceMotion: reduceMotion))");
    expect(controller).toContain(".animation(ConchMotion.swap.animation(reduceMotion: reduceMotion), value: page)");
  });

  test("Esc and the close button put it away; nothing reopens it by itself", () => {
    expect(controller).toContain("override func cancelOperation(_ sender: Any?) {\n        onEscape?()");
    expect(controller).toContain("window.onEscape = { [weak self] in self?.close() }");
    const closed = member(controller, "func windowClosed() {");
    expect(closed).toContain("if let progress, !progress.finished { apply(.close) }");
  });

  test("the rail shows this Mac's steps: Try it only with a daemon that says it can run the practice turn", () => {
    expect(controller).toContain("steps: model.readiness.rail");
    // Never switched on by the app itself: the daemon's `features.practice`, and an older daemon keeps it hidden.
    expect(controller).not.toMatch(/practiceAvailable:\s*true/);
    expect(controller).toContain("practiceAvailable: OnboardingReports.practiceAvailable(feature: published.practiceFeature))");
    expect(support).toContain('practiceFeature: (object["features"] as? [String: Any])?["practice"] as? Int');
    expect(read("design/ConchDesign/Sources/ConchDesign/OnboardingReports.swift")).toContain("practiceAvailable: Bool = false");
  });

  test("progress lives in onboarding.json, written atomically, every event through the rule", () => {
    expect(controller).toContain('return config.appendingPathComponent("onboarding.json")');
    expect(controller).toContain("try data.write(to: Self.progressURL, options: .atomic)");
    const apply = member(controller, "func apply(_ event: OnboardingEvent) {");
    expect(apply).toContain("let next = (progress ?? OnboardingProgress()).applying(event, readiness: readiness)");
    expect(apply).toContain("save()");
    // The only other writer replaces it whole (Welcome back's start, first run, the reopen used up), and saves too.
    expect(controller.match(/^\s+progress = next$/gm)?.length).toBe(2);
    expect(member(controller, "func replace(_ next: OnboardingProgress?) {")).toContain("save()");
  });
});

describe("what opens at launch", () => {
  test("the rule decides: first run, back where it was, only what's missing, or nothing", () => {
    const launch = member(controller, "private func launch() async {");
    expect(launch).toContain("let entry = OnboardingProgress.entry(progress, readiness: readiness)");
    expect(launch).toContain("progress = progress?.applying(.launched, readiness: readiness)");
    const open = member(controller, "private func open(entry: OnboardingEntry) {");
    expect(open).toContain("case .none:\n            return");
    expect(open).toContain("case let .resume(step):\n            model.apply(.open(step))");
    expect(open).toContain("OnboardingProgress.welcomingBack(missing: missing, readiness: model.readiness)");
    expect(app).toContain("OnboardingController.shared.appDidFinishLaunching()");
    expect(app).toContain("OnboardingController.shared.attach(store: store)");
  });

  /** Tyler's Mac is set up already: anything the daemon can't say yet must never read as missing. */
  test("unknown is never missing: a silent or older daemon never walks a set-up Mac through setup", () => {
    const settle = member(controller, "func settleForLaunch() async -> OnboardingReadiness? {");
    expect(settle).toContain("guard agents != nil else { return nil }");
    expect(settle).toContain("if !speechChecked || published.voices?.state == \"checking\" { seen.engineReady = true }");
    expect(settle).toContain("if !published.phoneKnown { seen.phonePaired = true }");
    const launch = member(controller, "private func launch() async {");
    expect(launch).toContain("if PermissionCenter.shared.statuses[.microphone] != .granted { open(entry: .firstRun) }");
    // An older daemon answers setup-status with an error of its own: not an answer, never "no agents".
    expect(support).toContain("guard message.kind == expecting else { return .failure(.olderDaemon) }");
    expect(controller).toContain('SetupDaemon.ask(SetupDaemonRequest(kind: "setup-status"), timeout: 20, expecting: "setup-status")');
  });
});

describe("permissions: PermissionCenter's rows and its one door", () => {
  test("statuses and actions are PermissionCenter's; opening System Settings starts the wait", () => {
    expect(controller).toContain("statuses: center.statuses, waitingOn: model.waitingOn, notes: center.notes,");
    const action = member(controller, "func permissionAction(_ permission: ConchPermission, _ action: ConchPermissionAction) {");
    expect(action).toContain("PermissionCenter.shared.perform(action, for: permission, store: stateStore)");
    expect(action).toContain("if opensSettings { startWaiting(permission) }");
    // The reopen is saved as the rule's reopenForGrant before conch quits.
    expect(action.indexOf("apply(.reopenForGrant)")).toBeGreaterThan(-1);
    expect(action.indexOf("apply(.reopenForGrant)")).toBeLessThan(action.indexOf("PermissionCenter.shared.perform("));
  });

  test("a 0.3 s read of that one permission, only while waiting, and it never prompts", () => {
    const wait = member(controller, "private func startWaiting(_ permission: ConchPermission) {");
    expect(wait).toContain("try? await Task.sleep(for: .milliseconds(300))");
    expect(wait).toContain("SystemSettingsWindow.frame()");
    const granted = member(controller, "nonisolated private static func granted(_ permission: ConchPermission) async -> Bool {");
    expect(granted).toContain("PermissionCenter.readHere()[permission] == .granted");
    expect(granted).toContain("PermissionCenter.automation(ask: false)");
    for (const prompt of ["AXIsProcessTrustedWithOptions", "requestAccess(for: .audio", "automation(ask: true)", "CGRequestScreenCaptureAccess"]) {
      expect(controller, prompt).not.toContain(prompt);
      expect(support, prompt).not.toContain(prompt);
    }
  });

  test("the guide: a non-activating panel under System Settings, found by its owner, dragging this conch", () => {
    const make = member(controller, "private func makeGuide(size: CGSize) -> NSPanel {");
    expect(make).toContain("styleMask: [.nonactivatingPanel, .borderless]");
    expect(make).toContain("panel.becomesKeyOnlyIfNeeded = true");
    const show = member(controller, "func showGuide(for permission: ConchPermission, granted: Bool) {");
    expect(show).toContain("panel.orderFrontRegardless()");
    expect(show).not.toContain("makeKey");
    expect(show).toContain("dragItem: { NSItemProvider(object: Bundle.main.bundleURL as NSURL) }");
    const frame = member(support, "static func frame() -> CGRect? {");
    expect(frame).toContain("CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)");
    expect(frame).toContain("kCGWindowOwnerPID");
    // Titles need Screen Recording; owners don't.
    expect(support).not.toContain("kCGWindowName");
  });
});

describe("the microphone check and the voices", () => {
  test("seashell's capture and whisper, through the loop's one gate: never Apple's speech", () => {
    for (const [name, source] of Object.entries(macSources)) {
      expect(source, name).not.toMatch(/import Speech\b|SFSpeechRecognizer|SFSpeechAudioBufferRecognitionRequest/);
    }
    expect(daemon).toContain('hold: (stop) => voice.holdNarration(MIC_CHECK_QUIET_WITHIN_MS, stop, "Microphone check"),');
    expect(daemon).toContain("const proc = spawnNarrationRecorder(cfg, wav, seconds);");
    expect(daemon).toContain("transcribe: (wav) => transcribeWavSegments(cfg, wav)");
    // A sample waits its turn and goes through `speak`'s gate, which drops a line while a mic is open.
    expect(daemon).toContain('speak: (voiceId, text) => eventQueue.exclusive(() => voice.speak({ ...cfg, ttsVoices: [voiceId] }, text, "", true)),');
  });

  test("a sample stops the check first, and the check starts again after", () => {
    const hear = member(controller, "func hear(_ index: Int) {");
    expect(hear.indexOf("micTask?.cancel()")).toBeLessThan(hear.indexOf('SetupDaemonRequest(kind: "voice-sample"'));
    expect(hear).toContain("listen()");
  });
});

describe("the iPhone", () => {
  test("reaching the step turns the phone on, and shows today's in-app code with H correction", () => {
    const phone = member(controller, "private func startPhone() {");
    expect(phone).toContain('SetupConfig(key: "phone", value: true)');
    expect(controller).toContain('ConchPairingStore.qr(for: $0, correction: "H")');
    expect(controller).toContain("kind: .inApp");
    // No universal link, and no domain.
    for (const source of Object.values(macSources)) expect(source).not.toContain("conch.app/pair");
  });

  test("the phone's reports reach the rule only when they change something", () => {
    const published = member(controller, "private func readPublished() {");
    expect(published).toContain("progress.applying(.phone(handoff), readiness: readiness) != progress");
    expect(published).toContain("apply(.phone(handoff))");
    expect(support).toContain("phoneKnown: object[\"phone\"] != nil");
  });
});

describe("You're set, Settings, the menu and Help", () => {
  test("the login switch replaces the silent registration at launch", () => {
    expect(app).not.toContain("registerLoginItemIfNeeded");
    expect(app).not.toContain("SMAppService");
    const files = Object.entries(macSources).filter(([, source]) => source.includes("SMAppService")).map(([name]) => name);
    expect(files).toEqual(["OnboardingSupport.swift"]);
    const set = member(support, "static func set(_ on: Bool) -> String? {");
    expect(set).toContain("if service.status != .enabled { try service.register() }");
    expect(set).toContain("try service.unregister()");
    // On by default, applied on You're set, never before.
    expect(member(support, "static func applyDefault() -> String? {")).toContain("return set(true)");
    expect(controller).toContain("case .done?:\n            loginNote = LoginItem.applyDefault()");
    expect(controller.match(/LoginItem\.applyDefault\(\)/g)?.length).toBe(1);
  });

  test("Answer uses the open-and-recite path; Start a session opens the New session sheet", () => {
    const first = member(controller, "func firstAction(_ id: String) {");
    expect(first).toContain("ConchStatusItem.openSession(row.id)");
    expect(first).toContain("stateStore?.send(.recite(sessionId: row.id, label: row.label))");
    expect(first).toContain("NotificationCenter.default.post(name: .showSessionStart, object: nil)");
    expect(content).toContain(".onReceive(NotificationCenter.default.publisher(for: .showSessionStart)) { _ in\n            isShowingSessionStart = true");
  });

  test("Settings has a Setup tab; the menu reminds while it's put away; Help has Set up conch…", () => {
    expect(app).toContain('SetupSettingsTab()\n                    .tabItem { Label("Setup", systemImage: "checklist") }');
    expect(app).toContain('Button("Set up conch…") { OnboardingController.shared.openFromHelp() }');
    expect(statusItem).toContain("setupLeft: OnboardingController.shared.menuReminder()");
    expect(statusItem).toContain("case .finishSetup: #selector(finishSetup)");
    const reminder = member(controller, "func menuReminder() -> [String] {");
    expect(reminder).toContain("progress.putAway, !progress.finished");
    expect(reminder).toContain("progress.remaining(model.readiness)");
  });
});

describe("notifications are asked the first time they're needed", () => {
  test("launch only reads; the ask is postOnce while Quiet, or setup's Allow now", () => {
    expect(app).not.toContain("requestAuthorizationAtLaunch");
    const launch = member(app, "func applicationDidFinishLaunching(_ notification: Notification) {");
    expect(launch).toContain("ReviewNotifications.shared.readAuthorizationAtLaunch()");
    expect(member(app, "func readAuthorizationAtLaunch() {")).not.toContain("requestAuthorization(");
    const post = member(app, "func postOnce(for item: ReviewItem) {");
    expect(post).toContain("case .notAsked:");
    expect(post).toContain("guard isQuiet() else { break }");
    expect(app.match(/center\.requestAuthorization\(/g)?.length).toBe(3); // first need, one waiting at launch, Allow now
    expect(app).toContain("ReviewNotifications.shared.isQuiet = { MainActor.assumeIsolated { store.state?.mode.paused == true } }");
  });
});

describe("the daemon's side is wired where hooks and the socket meet", () => {
  test("setup's requests reach setup.ts, and every hook event is heard before it is handled", () => {
    expect(server).toContain("const setupRequest = decodeSetupRequest(body);");
    const noted = server.indexOf("options.setup?.noteTurn(turn.value);");
    expect(noted).toBeGreaterThan(-1);
    expect(noted).toBeLessThan(server.indexOf("const work = application.turn(turn.value);"));
    const wiring = daemon.slice(daemon.indexOf("const controlServer = createControlServer({"));
    expect(wiring.slice(0, wiring.indexOf("\n  });"))).toContain("\n    setup,");
  });

  test("the new files are in the Mac app's project", () => {
    const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");
    for (const file of ["OnboardingController.swift", "OnboardingSupport.swift"]) {
      // Its build file and file reference name it twice each, the group and the sources phase once.
      expect(project.match(new RegExp(file.replace(".", "\\."), "g"))?.length, file).toBe(6);
    }
  });
});
