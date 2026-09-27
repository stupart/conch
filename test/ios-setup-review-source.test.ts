import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeSetupStage } from "../src/phone-setup.ts";

/**
 * The iPhone's setup, as the review of 2026-09-28 found it (#27, #29, #30, #31). The app has no unit-test target, so its
 * wiring is held here by its text; ConchDesign's parts are XCTests (PhoneStepStateTests, PhoneSetupFlowTests) and the
 * daemon's are phone-setup.test.ts.
 */

const root = join(import.meta.dir, "..");
const ios = (name: string) => readFileSync(join(root, "mobile", "conch-ios", "conch-ios", name), "utf8");
const flow = ios("SetupFlow.swift");
const pairing = ios("PairingView.swift");
const app = ios("ConchApp.swift");
const bridge = ios("BridgeClient.swift");
const phoneViews = readFileSync(join(root, "design", "ConchDesign", "Sources", "ConchDesign", "OnboardingPhone.swift"), "utf8");

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

const store = between(flow, "final class PhoneSetupStore: ObservableObject {", "enum SetupSwap {");

describe("#27: the Mac keeps this phone's setup by its install, not its name", () => {
  test("a random id per install, kept in UserDefaults (a reinstall empties them), made once", () => {
    const install = between(store, "private(set) lazy var install: String = {", "}()");
    inOrder(install, [
      "if let kept = defaults?.string(forKey: Self.installKey), !kept.isEmpty { return kept }",
      "let made = UUID().uuidString",
      "defaults?.set(made, forKey: Self.installKey)",
      "return made",
    ]);
    expect(store).toContain('static let installKey = "conch.install-id.v1"');
    // Never the Keychain: the pairing survives a reinstall there, and the install id must not.
    expect(install).not.toMatch(/Keychain|SecItem/);
    // An id the daemon takes: a UUID's text.
    expect(decodeSetupStage({ stage: "paired", declined: [], device: "iPhone", install: crypto.randomUUID().toUpperCase() }).ok).toBe(true);
  });

  test("every report carries it; the name is only shown", () => {
    const calls = [...store.matchAll(/bridge\.reportSetup\(/g)].length;
    expect(calls).toBeGreaterThanOrEqual(3);
    expect([...store.matchAll(/device: Self\.device, install: install/g)].length).toBe(calls);
    expect(store).toContain("static var device: String { UIDevice.current.name }");
    const report = between(bridge, "func reportSetup(", "/// `pause` or `resume`");
    inOrder(report, ["install: String,", '"device": device,', '"install": install,']);
  });
});

describe("#28 on the phone: where its setup is, said again on each link", () => {
  test("past Connecting, linkUp tells the Mac the stage it's at, answered or not, before the rest", () => {
    const linkUp = between(store, "func linkUp(_ bridge: BridgeClient) async {", "func sync(_ bridge: BridgeClient) async {");
    inOrder(linkUp, [
      "if flow?.screen == .connecting {",
      "} else if let flow, let stage = flow.reportable {",
      "bridge.reportSetup(stage: stage, declined: flow.declined, device: Self.device, install: install)",
      "await sync(bridge)",
    ]);
    expect(phoneViews).toContain("public var reportable: PhoneSetupStage? {");
  });
});

describe("#28 on the Mac: a paired phone with nothing to mirror shows no rows", () => {
  test("the iPhone step's mirror says paired, and ticks nothing, when the phone reported nothing", () => {
    const mac = readFileSync(join(root, "design", "ConchDesign", "Sources", "ConchDesign", "OnboardingMac.swift"), "utf8");
    const mirror = between(mac, "private func mirror(_ handoff: PhoneHandoff) -> some View {", "private func failed(");
    inOrder(mirror, [
      "let nothingToMirror = OnboardingReports.phoneHasNothingToMirror(handoff)",
      "Text(nothingToMirror",
      '? "Paired with this Mac. Carrying on here."',
      "if !nothingToMirror {",
      "MirrorLine(stage: stage, handoff: handoff)",
    ]);
  });
});

describe("#29: a report asked for while one is being sent is never dropped", () => {
  const sync = between(store, "func sync(_ bridge: BridgeClient) async {", "private func apply(");

  test("asked while a run is under way, it runs again after, in a task of its own", () => {
    inOrder(sync, [
      "guard draining == nil else {",
      "drainAgain = true",
      "return",
      "draining = Task { [weak self] in await self?.drain(bridge) }",
    ]);
    // The early return that dropped it is gone.
    expect(store).not.toContain("guard !syncing else { return }");
    const drain = between(sync, "private func drain(_ bridge: BridgeClient) async {", "\n    }\n");
    inOrder(drain, ["defer { draining = nil }", "repeat {", "drainAgain = false", "} while drainAgain"]);
  });

  test("not heard while the link is up: sent again after a pause that grows, never given up on while connected", () => {
    const drain = between(sync, "private func drain(_ bridge: BridgeClient) async {", "} while drainAgain");
    const unheard = between(drain, "if outcome == .unheard {", "pause = .seconds(1)");
    inOrder(unheard, ["try? await Task.sleep(for: pause)", "pause = min(pause * 2, .seconds(30))", "continue"]);
    expect(unheard).not.toContain("return");
    expect(drain).toContain("while bridge.isConnected, let flow, let stage = flow.unreported {");
  });
});

describe("#30: the expired-code screen's buttons do what they say", () => {
  const page = between(flow, "private var page: some View {", "private func askMicrophone()");

  test("Scan again opens the scanner; Enter a code instead opens code entry; neither retries the refused code or unpairs", () => {
    const expired = between(page, "case .expired:", "case .macNotAnswering, .relayUnreachable:");
    expect(expired).toContain("PhonePairingProblem(trouble, onPrimary: { rescanning = true }, onSecondary: { enteringCode = true })");
    expect(expired).not.toContain("retry");
    expect(expired).not.toContain("onCancel");
    // The other problems keep Try again and Scan a different Mac.
    expect(between(page, "case .macNotAnswering, .relayUnreachable:", "} else {")).toContain("PhonePairingProblem(trouble, onPrimary: retry, onSecondary: onCancel)");
    // The words are the design's.
    const words = between(phoneViews, "case .expired:\n            PhoneSetupPage(", "case let .macNotAnswering");
    inOrder(words, ['primary: "Scan again"', 'secondary: "Enter a code instead"']);
  });

  test("the scanner and the typed code open over setup, and a new pairing replaces the refused one", () => {
    const covers = between(flow, ".fullScreenCover(isPresented: $rescanning) {", "private func rescanned(");
    inOrder(covers, [
      "SetupScanner(",
      "onCode: rescanned,",
      "rescanning = false",
      "enteringCode = true",
      "onClose: { rescanning = false }",
      ".fullScreenCover(isPresented: $enteringCode) {",
      "PairingView(startingAt: .code, onBack: { enteringCode = false }) { newPairing in",
      "repaired(newPairing)",
    ]);
    const rescanned = between(flow, "private func rescanned(_ scanned: String) {", "private func repaired(");
    inOrder(rescanned, ["RelayPairingPayload.decodePairingCode(scanned)", "rescanning = false", "repaired(.relay(relay))"]);
    inOrder(between(flow, "private func repaired(_ pairing: BridgeClient.Pairing) {", "\n    }\n"), ["trouble = nil", "attempt += 1", "onRepaired(pairing)"]);
    // Typed code's back returns to the expired screen, not the welcome: the pairing isn't dropped by going back.
    expect(between(pairing, "Button {\n                focused = nil", "} label: {")).toContain("if let onBack { onBack() } else { entry = .welcome }");
    expect(app).toContain("SetupFlow(bridge: bridgeClient(for: pairing), store: setup, onCancel: unpair, onRepaired: adopt)");
  });
});

describe("#31: a scanned code that can't be read says so, and the scanner stays open", () => {
  const scanner = between(pairing, "struct SetupScanner: View {", "/// No Mac yet: the link to conch for Mac");

  test("only a code that decodes goes on; one that doesn't is said, and nothing closes", () => {
    expect(scanner).toContain("AnyView(RelayQRScanner(onCode: accept))");
    expect(scanner).toContain("message: unreadable,");
    const accept = between(scanner, "func accept(_ scanned: String) {", "\n    }\n");
    inOrder(accept, [
      "guard (try? RelayPairingPayload.decodePairingCode(scanned)) != nil else {",
      "unreadable = PhoneScanner.unreadableCode",
      "return",
      "unreadable = nil",
      "onCode(scanned)",
    ]);
    expect(between(accept, "else {", "return")).not.toContain("onCode(");
    expect(between(accept, "else {", "return")).not.toContain("onClose");
  });

  test("the camera delivers a different code after one that couldn't be read", () => {
    const coordinator = between(pairing, "final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {", "final class ScannerViewController");
    expect(coordinator).toContain("private var delivered: String?");
    expect(coordinator).toContain("value != delivered else { return }");
    expect(coordinator).not.toContain("guard !delivered");
  });

  test("the designed scanner shows the words over the camera, above Enter a code instead", () => {
    const view = between(phoneViews, "public struct PhoneScanner: View {", "struct Viewfinder");
    inOrder(view, ["let message: String?", "if let message, !denied {", "Text(message)", 'Text("Enter a code instead")']);
  });
});
