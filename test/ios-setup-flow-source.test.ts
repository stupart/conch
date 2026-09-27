import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PHONE_SETUP_STAGES } from "../src/phone-setup.ts";

/**
 * The iPhone's first-run setup, as wired into the app (Wave B of docs in conch-design/onboarding): after a pairing,
 * the ConchDesign screens hosted by SetupFlow.swift, each stage told to the Mac over the pairing; the phone-first
 * welcome in place of the bare pairing form; no notifications ask; the pairing code and relay left as they were.
 */

const root = join(import.meta.dir, "..");
const ios = (name: string) => readFileSync(join(root, "mobile", "conch-ios", "conch-ios", name), "utf8");
const design = (name: string) => readFileSync(join(root, "design", "ConchDesign", "Sources", "ConchDesign", name), "utf8");
const app = ios("ConchApp.swift");
const flow = ios("SetupFlow.swift");
const pairing = ios("PairingView.swift");
const bridge = ios("BridgeClient.swift");
const phoneViews = design("OnboardingPhone.swift");

function between(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  expect(at, `missing: ${start}`).toBeGreaterThan(-1);
  const stop = source.indexOf(end, at + start.length);
  expect(stop, `missing after ${start}: ${end}`).toBeGreaterThan(at);
  return source.slice(at, stop);
}

function inOrder(source: string, markers: string[]): void {
  let last = -1;
  for (const marker of markers) {
    const at = source.indexOf(marker, last + 1);
    expect(at, `out of order or missing: ${marker}`).toBeGreaterThan(last);
    last = at;
  }
}

describe("the app routes through setup", () => {
  test("paired: setup until Open conch, then the ledger; unpaired: the way in, which starts setup", () => {
    const content = between(app, "private var content: some View {", "private func bridgeClient(");
    inOrder(content, [
      "if let pairing {",
      "if setup.showing {",
      "SetupFlow(bridge: bridgeClient(for: pairing), store: setup, onCancel: unpair, onRepaired: adopt)",
      "LedgerView(",
      "PairingView(onPaired: adopt)",
    ]);
    // A new pairing, from the way in or from setup's expired-code screen, replaces the old one's link first.
    inOrder(between(app, "private func adopt(_ newPairing: BridgeClient.Pairing) {", "\n    }\n"), [
      "bridge?.stop()",
      "bridge = nil",
      "LastStateTransport.forget()",
      "PairingStore.save(newPairing)",
      "setup.paired()",
      "pairing = newPairing",
    ]);
    // Cancel on Connecting is an unpair; an unfinished setup starts again with the next pairing.
    expect(between(app, "private func unpair() {", "\n    }\n")).toContain("setup.forget()");
  });

  test("a report the Mac hasn't heard goes on every reconnect, ledger or not", () => {
    const client = between(app, "private func bridgeClient(for pairing: BridgeClient.Pairing) -> BridgeClient {", "private static func transport(");
    expect(client).toContain("Task { await setup?.sync(created) }");
  });

  test("the voice stays on the Mac while the phone sets itself up, and Open conch takes it", () => {
    expect(app).toContain("created.leavesAudioOnMac = setup.showing");
    const handover = between(app, ".onChange(of: setup.showing) { _, showing in", ".background(Palette.bg)");
    inOrder(handover, ["guard !showing, let bridge", "bridge.leavesAudioOnMac = false", "Task { await bridge.claimAudio(true) }"]);
    expect(between(bridge, "func claimAudio(_ mine: Bool) async -> Bool {", "\n    }\n"))
      .toContain('"sink": mine && !leavesAudioOnMac ? "phone" : "mac"');
  });

  test("SetupFlow.swift is built into the app", () => {
    const project = readFileSync(join(root, "mobile", "conch-ios", "conch-ios.xcodeproj", "project.pbxproj"), "utf8");
    expect(project).toContain("/* SetupFlow.swift in Sources */ = {isa = PBXBuildFile;");
    expect(between(project, "/* Sources */ = {", "};")).toContain("SetupFlow.swift in Sources");
  });
});

describe("unpaired, the phone-first welcome comes first, with the scanner one tap away", () => {
  test("welcome, then the scanner; a scanned code goes straight through connect() and commit, no second tap", () => {
    expect(pairing).toContain("@State private var entry: Entry = .welcome");
    expect(pairing).toContain("PhoneFirstWelcome(onScan: { scanningRelay = true }, onGetMac: { gettingMac = true })");
    const cover = between(pairing, ".fullScreenCover(isPresented: $scanningRelay) {", ".sheet(isPresented: $gettingMac)");
    const scanned = between(cover, "onCode: { scanned in", "onEnterCode:");
    inOrder(scanned, ["scanningRelay = false", "code = scanned", "connect()"]);
    expect(scanned).not.toContain("onPaired(");
    // "Enter a code instead" is the typed form `conch pair` prints for.
    inOrder(between(cover, "onEnterCode: {", "onClose:"), ["scanningRelay = false", "entry = .code"]);
  });

  test("the scanner is the designed one over the live camera, and says so when the camera is off", () => {
    const scanner = between(pairing, "struct SetupScanner: View {", "struct GetMacSheet: View {");
    expect(scanner).toContain("PhoneScanner(");
    expect(scanner).toContain("denied: access == .denied || access == .restricted");
    expect(scanner).toContain("AnyView(RelayQRScanner(onCode: accept))");
    expect(scanner).toContain("UIApplication.openSettingsURLString");
  });

  test("no Mac yet: a link that exists today, shared or copied", () => {
    const sheet = between(pairing, "struct GetMacSheet: View {", "struct ShareSheet:");
    expect(sheet).toContain('URL(string: "https://github.com/stupart/conch#install")!');
    expect(sheet).not.toContain('URL(string: "https://conch.app');
    expect(sheet).toContain("UIPasteboard.general.url = Self.link");
    expect(sheet).toContain("ShareSheet(items: [Self.link])");
  });
});

describe("the screens, as designed, each telling the Mac", () => {
  test("SetupFlow hosts ConchDesign's screens and no others", () => {
    for (const view of ["PhoneConnecting(", "PhonePermissionAsk(.microphone, onAllow: askMicrophone)", "PhoneTourPage(", "PhoneSetupDone(", "PhonePairingProblem("]) {
      expect(flow).toContain(view);
    }
    // Connecting names the Mac once it has, and has Cancel.
    expect(between(flow, "PhoneConnecting(", "case .microphone:")).toContain("onCancel: onCancel");
    // The tour is skippable from every page, and swipes.
    expect(flow).toContain("PhoneTourPage(page: index, onNext: { store.next() }, onSkip: { store.skipTour() })");
    expect(flow).toContain(".tabViewStyle(.page(indexDisplayMode: .never))");
    // The last screen's Open conch ends setup.
    expect(flow).toContain("PhoneSetupDone(mac: flow.macNameStartingASentence, declined: flow.declinedSentences, onDone: { store.next() })");
  });

  test("no notifications screen and no notifications ask, until the phone has notifications (decision 11)", () => {
    for (const name of readdirSync(join(root, "mobile", "conch-ios", "conch-ios")).filter((file) => file.endsWith(".swift"))) {
      const source = ios(name);
      expect(source, name).not.toContain("PhonePermissionAsk(.notifications");
      expect(source, name).not.toContain("UNUserNotificationCenter");
      expect(source, name).not.toContain("requestAuthorization(options:");
    }
    expect(between(phoneViews, "public enum PhoneSetupScreen", "public var reports")).not.toContain("case notifications");
  });

  test("the microphone: one Continue, then iOS asks for the microphone, then speech recognition; a no carries on", () => {
    const ask = between(flow, "private func askMicrophone() {", "private static func speechRecognitionAllowed()");
    inOrder(ask, [
      "await AVAudioApplication.requestRecordPermission()",
      "microphone ? await Self.speechRecognitionAllowed() : false",
      "store.answeredMicrophone(microphone: microphone, speech: speech)",
    ]);
    expect(flow).toContain("SFSpeechRecognizer.requestAuthorization");
  });

  test("the phone's mic is listening's orange on these screens, never the ledger's cyan (decision 14)", () => {
    for (const source of [flow, pairing]) expect(source).not.toContain("Palette.micOpen");
    expect(between(phoneViews, "struct TalkPreview: View {", "static let levels")).toContain("VoiceOrb(state: .listening, size: 64)");
    expect(design("Tokens.swift")).toContain('public static let listening = ConchColorToken("listening", both: .init(0xFF9F0A))');
  });

  test("each stage is reported as it's reached, Connected carrying the Mac's name, and resent until heard", () => {
    const store = between(flow, "final class PhoneSetupStore: ObservableObject {", "enum SetupSwap {");
    const linkUp = between(store, "func linkUp(_ bridge: BridgeClient) async {", "func sync(_ bridge: BridgeClient) async {");
    inOrder(linkUp, ["if flow?.screen == .connecting {", "bridge.reportSetup(stage: .paired", "update { $0.linked() }", "await sync(bridge)"]);
    const sync = between(store, "func sync(_ bridge: BridgeClient) async {", "private func apply(");
    inOrder(sync, ["while bridge.isConnected, let flow, let stage = flow.unreported {", "if outcome == .unheard {", "apply(outcome, for: stage, bridge: bridge)"]);
    expect(flow).toContain(".task(id: flow.screen) { await store.sync(bridge) }");
    expect(store).toContain("static var device: String { UIDevice.current.name }");
    // Where the phone is survives a relaunch.
    expect(store).toContain('static let key = "conch.phone-setup.v1"');
    expect(store).toContain("defaults?.set(data, forKey: Self.key)");
  });

  test("the report is the daemon's setup-stage message, over the phone's authenticated route", () => {
    const report = between(bridge, "func reportSetup(", "/// `pause` or `resume`");
    expect(report).toContain('"kind": "setup-stage"');
    expect(report).toContain('"stage": stage.rawValue');
    expect(report).toContain('"device": device');
    expect(report).toContain('"install": install');
    expect(report).toContain('authorizedRequest(method: "POST", path: "/setup-stage", body: body)');
    // An older Mac without the route is not a failure to retry forever.
    expect(report).toContain("case 404:\n            return .notFollowed");
  });

  test("when it goes wrong: Connecting says what, and a drop part way says it's reconnecting while setup carries on", () => {
    expect(flow).toContain("static let patience: Duration = .seconds(15)");
    const diagnose = between(flow, "private func diagnose() async", "private static func answers(");
    inOrder(diagnose, ["if bridge.pairingRejected { return .expired }", ".relayUnreachable(", ".macNotAnswering(flow.macNameStartingASentence)"]);
    // The relay probe carries nothing of the pairing: scheme, host, port, root.
    const probe = between(flow, "private static func answers(_ endpoint: URL) async -> Bool {", "\n    }\n");
    expect(probe).not.toMatch(/roomId|secret|endpoint\.path|endpoint\.query|absoluteString/);
    expect(flow).toContain('Text("Reconnecting to \\(mac)…")');
  });

  test("Reduce Motion keeps the timing and only fades", () => {
    const swap = between(flow, "enum SetupSwap {", "struct SwapLook");
    expect(swap).toContain("guard !reduceMotion else { return .opacity }");
    expect(swap).toContain("ConchMotion.swapScale");
    expect(flow).toContain(".animation(ConchMotion.swap.animation(reduceMotion: reduceMotion), value: pageKey)");
  });
});

describe("the pairing code and relay are left as they were (decisions 6, 7, 10 are Tyler's)", () => {
  test("the in-app scanner reads today's conch-relay-v1: code; no universal link, no associated domains", () => {
    expect(ios("RelayProtocol.swift")).toContain('static let codePrefix = "conch-relay-v1:"');
    expect(pairing).toContain("value.hasPrefix(RelayPairingPayload.codePrefix)");
    for (const name of readdirSync(join(root, "mobile", "conch-ios", "conch-ios")).filter((file) => file.endsWith(".swift"))) {
      expect(ios(name), name).not.toContain(".onOpenURL");
    }
    const project = readFileSync(join(root, "mobile", "conch-ios", "conch-ios.xcodeproj", "project.pbxproj"), "utf8");
    expect(project).not.toContain("associated-domains");
    expect(project).not.toContain("CODE_SIGN_ENTITLEMENTS");
  });
});

describe("the daemon and the design agree on the stages", () => {
  test("PHONE_SETUP_STAGES is ConchDesign's PhoneSetupStage, case for case, in order", () => {
    const swift = between(design("Onboarding.swift"), "public enum PhoneSetupStage", "public static let mirrored");
    const cases = [...swift.matchAll(/^\s+case (\w+)$/gm)].map((match) => match[1]);
    expect(cases).toEqual([...PHONE_SETUP_STAGES]);
  });
});
