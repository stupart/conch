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
    // The design's pages at the root; what is chained after them (its clocks pausing with the window) is not this guard's.
    expect(show).toContain("NSHostingView(rootView: OnboardingRootView(model: model, controller: self)");
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
    expect(controller).toContain("practiceAvailable: practiceAvailability ?? (progress?.step == .practice))");
    expect(controller).toContain("OnboardingReports.practiceAvailability(feature: published.practiceFeature, published: publishedSeen)");
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
    // A download or a voices rebuild under way is not missing either (OnboardingReportsTests pins the rule).
    expect(settle).toContain("seen.engineReady = OnboardingReports.engineReadyAtLaunch(speech: published.speech, voices: published.voices)");
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
    // A sample waits its turn and goes through `speak`'s gate, which drops a line while a mic is open; with the audio on
    // the phone or another Mac, nothing is sent there (D6, setup-installer.test.ts).
    expect(daemon).toContain('speak: (voiceId, text) => eventQueue.exclusive(() => (audioLease.isPhone() || !audioHolder.isLocal()');
    expect(daemon).toContain(': voice.speak({ ...cfg, ttsVoices: [voiceId] }, text, "", true))),');
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
  test("the first launch registers at login, visibly; You're set's switch only shows macOS's answer", () => {
    expect(app).not.toContain("registerLoginItemIfNeeded");
    expect(app).not.toContain("SMAppService");
    const files = Object.entries(macSources).filter(([, source]) => source.includes("SMAppService")).map(([name]) => name);
    expect(files).toEqual(["OnboardingSupport.swift"]);
    const register = member(support, "private func register(on: Bool) -> Bool {");
    expect(register).toContain("if service.status != .enabled { try service.register() }");
    expect(register).toContain("try service.unregister()");
    // The rule, and the launch, are test/login-item-source.test.ts's and LoginItemPolicyTests'. You're set decides nothing.
    expect(controller).toContain("case .done?:\n            LoginItem.shared.refresh()");
    expect(controller).not.toContain("applyDefault");
    expect(support).not.toContain("applyDefault");
  });

  test("Answer uses the open-and-recite path; Start a session opens the New session sheet", () => {
    const first = member(controller, "func firstAction(_ id: String) {");
    expect(first).toContain("ConchStatusItem.openSession(row.id)");
    expect(first).toContain("stateStore?.send(.recite(sessionId: row.id, label: row.label))");
    expect(first).toContain("NotificationCenter.default.post(name: .showSessionStart, object: nil)");
    expect(content).toContain(".onReceive(NotificationCenter.default.publisher(for: .showSessionStart)) { _ in\n            isShowingSessionStart = true");
  });

  test("Settings has a Setup tab; the menu reminds while it's put away; Help has Set up conch…", () => {
    expect(app).toContain('ConchSettingsRootView()');
    expect(read("mac-app/conch-mac/SettingsView.swift")).toContain('case "setup": SetupSettingsTab()');
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

/** The app review of 28 Sep (#441, #445): what the rules can't show, pinned where the app wires them. */
describe("setup's window, as reviewed", () => {
  test("a microphone allowed from the Voice step starts its check: the grant is read from what the publisher sends", () => {
    // `@Published` sends in willSet: read from the store there, the grant is still `.notAsked`, and the check never starts.
    expect(controller).toContain("PermissionCenter.shared.$statuses.dropFirst().sink { [weak self] statuses in");
    expect(controller).toContain("MainActor.assumeIsolated { self?.permissionsChanged(statuses) }");
    const changed = member(controller, "private func permissionsChanged(_ statuses: [ConchPermission: ConchPermissionStatus]) {");
    expect(changed).toContain("statuses[.microphone] == .granted { startVoice(microphone: .granted) }");
    expect(changed).not.toContain("PermissionCenter.shared.statuses");
    const voice = member(controller, "private func startVoice(microphone: ConchPermissionStatus?) {");
    expect(voice).toContain("guard microphone == .granted else {");
    expect(voice).not.toContain("PermissionCenter.shared.statuses");
  });

  test("Try it waits while the daemon hasn't said whether it can run it, and skips only on its no", () => {
    const page = controller.slice(controller.indexOf("case .practice:\n"), controller.indexOf("case .done:\n"));
    const skip = page.indexOf("Color.clear.onAppear { model.apply(.skip) }");
    expect(skip).toBeGreaterThan(-1);
    expect(page.slice(0, skip)).toContain("if model.practiceAvailability == false {");
    // Unknown until the daemon's state has been read this launch.
    expect(controller.match(/publishedSeen = true/g)?.length).toBe(3);
    expect(member(controller, "private func readPublished() {")).toContain("if !publishedSeen { publishedSeen = true }");
  });

  test("You're set never offers to answer the practice turn", () => {
    const waiting = member(controller, "var waitingSession: SessionRow? {");
    expect(waiting).toContain(".filter { $0.id != TourCoach.practiceSessionId }");
    expect(waiting).not.toContain("stateStore?.state?.rows.first");
  });

  test("closing setup's window stops waiting on System Settings, and its guide with it", () => {
    expect(member(controller, "func windowClosed() {")).toContain("stopWaiting()");
    const stop = member(controller, "func stopWaiting() {");
    expect(stop).toContain("waiting?.cancel()");
  });

  test("a stream the daemon drops part way is \"try again\", never \"older version\": its reply is known by kind", () => {
    const stream = member(support, "static func stream(_ request: SetupDaemonRequest, timeout: TimeInterval, expecting: String,");
    expect(stream).toContain("isReply: { OnboardingReports.isStreamReply(kind: decode($0)?.kind) }");
    expect(stream).toContain("case .dropped:\n            return .failure(.dropped)");
    expect(support).toContain(`case .dropped: "conch's background service restarted part way through. Try again."`);
    const client = code(read("mac-app/conch-mac/ConchSocketClient.swift"));
    const read_ = client.slice(client.indexOf("func stream<Request: Encodable>("), client.indexOf("func reportAppError("));
    expect(read_).toContain("if isReply(line) { return .reply(line) }");
    expect(read_).toContain("return DispatchTime.now().uptimeNanoseconds < deadline ? .dropped : .timeout");
    // Never the last line read as the reply.
    expect(read_).not.toMatch(/var last\b|last\.map/);
    // The streamed kinds are the daemon's own (src/setup.ts `SetupLine`).
    const setup = read("src/setup.ts");
    const lineAt = setup.indexOf("export type SetupLine =");
    expect(lineAt).toBeGreaterThan(-1);
    const lineType = setup.slice(lineAt, setup.indexOf("};\n", lineAt) + 2);
    const kinds = [...lineType.matchAll(/kind: "([a-z-]+)"/g)].map((m) => m[1]).sort();
    expect(kinds).toEqual(["mic-level", "setup-install-line"]);
    const reports = read("design/ConchDesign/Sources/ConchDesign/OnboardingReports.swift");
    expect(reports).toContain(`public static let streamedKinds: Set<String> = [${kinds.map((k) => `"${k}"`).join(", ")}]`);
  });

  test("what setup did while the launch waited stands: the launch's choice is only for a Mac still with nothing on record", () => {
    const launch = member(controller, "private func launch() async {");
    const waited = launch.indexOf("let seen = await model.settleForLaunch()");
    const guard = launch.indexOf("guard model.progress == nil else { return }");
    expect(waited).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(waited);
    expect(guard).toBeLessThan(launch.indexOf("open(entry: .firstRun)"));
    expect(guard).toBeLessThan(launch.indexOf("readiness = seen"));
  });

  test("Settings › Setup keeps its downloads moving for as long as it shows, on a finished Mac too", () => {
    const watch = member(controller, "func watchInBackground() {");
    expect(watch).toContain("OnboardingWatch.interval(windowShown: self.visible, settingsShown: self.settingsShowing > 0,");
    expect(watch).not.toContain("if !self.visible, !unfinished");
    const shown = member(controller, "func watchWhileSettingsShown() async {");
    expect(shown).toContain("settingsShowing += 1");
    expect(shown).toContain("defer { settingsShowing -= 1 }");
    expect(shown).toContain("watchInBackground()");
    expect(shown).toContain("while !Task.isCancelled {");
    expect(member(controller, "struct SetupSettingsTab: View {", 0)).toContain(".task { await model.watchWhileSettingsShown() }");
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

describe("a voice sample that didn't play says why", () => {
  // The daemon refuses `voice-sample` when the phone or another Mac holds the audio (#448, review D6); the window used to
  // throw that answer away, so Hear one did nothing and said nothing.
  test("its failure is shown in the step's line, and the mic check isn't restarted over it", () => {
    const hear = member(controller, "func hear(_ index: Int) {");
    expect(hear).toContain("let result = await SetupDaemon.ask(SetupDaemonRequest(kind: \"voice-sample\"");
    expect(hear).not.toContain("_ = await SetupDaemon.ask(SetupDaemonRequest(kind: \"voice-sample\"");
    const failure = hear.indexOf("if case let .failure(failure) = result, failure.reason != \"cancelled\" {");
    expect(failure).toBeGreaterThan(-1);
    expect(hear.indexOf("mic.state = .problem(failure.words)", failure)).toBeGreaterThan(failure);
    expect(hear.indexOf("return", failure)).toBeLessThan(hear.indexOf("listen()", failure));
  });
});
