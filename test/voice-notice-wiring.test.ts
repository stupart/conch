import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the natural voices' calm line shows (NaturalVoicesNotice.swift decides it; XCTest pins the rules): the Mac's
 * window notices and control bar, and the iPhone's list. These pin the wiring the Swift builds can't: that each app
 * reads the daemon's `naturalVoices`, steps it through the shared rules, remembers dismissals, and puts the line where
 * Tyler looks — and that Try again is setup's own Retry.
 */

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

describe("the Mac", () => {
  const models = flat(read("mac-app/conch-mac/Models.swift"));
  const notices = read("mac-app/conch-mac/Notices.swift");
  const panels = flat(read("mac-app/conch-mac/FloatingPanels.swift"));
  const statusItem = flat(read("mac-app/conch-mac/StatusItem.swift"));
  const settings = flat(read("mac-app/conch-mac/SettingsView.swift"));

  test("the published state carries the natural voices, and a change repaints", () => {
    expect(models).toContain("let naturalVoices: NaturalVoicesReport?");
    expect(models).toContain("case naturalVoices");
    expect(models).toContain("naturalVoices = try? container.decodeIfPresent(NaturalVoicesReport.self, forKey: .naturalVoices)");
    expect(models).toContain("&& naturalVoices == other.naturalVoices");
  });

  test("one store steps the status through the shared rules, remembers dismissals across launches, and fades the back line", () => {
    const store = flat(notices.slice(notices.indexOf("final class NaturalVoicesNoticeStore"), notices.indexOf("private struct NaturalVoicesNoticeLine")));
    expect(store).toContain("static let memoryKey = \"conch.naturalVoicesNotice\"");
    expect(store).toContain(".map { $0?.naturalVoices } .removeDuplicates()");
    expect(store).toContain("let step = NaturalVoicesNotices.step(memory, report: report, now: now)");
    expect(store).toContain("remember(NaturalVoicesNotices.dismiss(memory, key: key))");
    expect(store).toContain("guard let at = NaturalVoicesNotices.nextChange(memory, now: now) else { return }");
    expect(store).toContain("UserDefaults.standard.set(data, forKey: Self.memoryKey)");
    // Try again is setup's own Retry for the voices, which starts the daemon's count over.
    expect(store).toContain('SetupDaemonRequest(kind: "setup-retry", what: "voices")');
    expect(statusItem).toContain("NaturalVoicesNoticeStore.shared.install(store: store)");
  });

  test("the window's notices carry the line, with its one action and OK", () => {
    const body = flat(notices.slice(notices.indexOf("struct WorkspaceNotices"), notices.indexOf("private struct LoginItemNoticeLine")));
    expect(body).toContain("PermissionNoticeLine() // The natural voices, only when it matters");
    expect(body).toContain("NaturalVoicesNoticeLine()");
    const line = flat(notices.slice(notices.indexOf("private struct NaturalVoicesNoticeLine")));
    expect(line).toContain("if let notice = voices.notice {");
    expect(line).toContain("case .tryAgain: voices.tryAgain()");
    expect(line).toContain("case .why: openSettings()");
    expect(line).toContain('if notice.dismissible { Button("OK", action: voices.dismiss)');
  });

  test("the control bar's second line carries the short line, before or after the working count by its tone", () => {
    expect(panels).toContain("@ObservedObject var voices = NaturalVoicesNoticeStore.shared");
    expect(panels).toContain("news: NaturalVoicesNotices.barNews(working: ConchStatusItem.news(store.state), notice: voices.notice),");
  });

  test("Settings, where Why? leads, says how far along and offers the same Try again", () => {
    expect(settings).toContain('case "setting-up": return "Natural voices: setting up…" + (percent.map { " \\($0)%" } ?? "")');
    expect(settings).toContain('if natural.canTryAgain { Button("Try again") { NaturalVoicesNoticeStore.shared.tryAgain() }');
  });
});

describe("the iPhone", () => {
  const models = flat(read("mobile/conch-ios/conch-ios/Models.swift"));
  const ledger = read("mobile/conch-ios/conch-ios/LedgerView.swift");

  test("the state it already reads carries the natural voices", () => {
    expect(models).toContain("var naturalVoices: NaturalVoicesReport?");
    expect(models).toContain("case ownerDeviceId, deliveries, sessionSettings, naturalVoices");
    expect(models).toContain("naturalVoices = try? c.decodeIfPresent(NaturalVoicesReport.self, forKey: .naturalVoices)");
  });

  test("a quiet line at the top of the list, by the same rules, remembered, with Why? and a dismiss", () => {
    const view = flat(ledger);
    expect(view).toContain("@StateObject private var voicesNotice = VoicesNoticeModel()");
    expect(view).toContain("if let notice = voicesNotice.notice { VoicesNoticeRow(notice: notice, detail: voicesNotice.detail, onDismiss: voicesNotice.dismiss)");
    expect(view).toContain(".onChange(of: bridge.state?.naturalVoices, initial: true) { _, report in voicesNotice.update(report) }");
    // Beside the connection line, above the sessions.
    expect(ledger.indexOf("VoicesNoticeRow(notice:")).toBeGreaterThan(ledger.indexOf("staleLine(state)"));
    expect(ledger.indexOf("VoicesNoticeRow(notice:")).toBeLessThan(ledger.indexOf("ForEach(folders(in: state))"));
    const model = flat(ledger.slice(ledger.indexOf("final class VoicesNoticeModel")));
    expect(model).toContain("let step = NaturalVoicesNotices.step(memory, report: report, now: now)");
    expect(model).toContain("remember(NaturalVoicesNotices.dismiss(memory, key: key))");
    expect(model).toContain("guard let at = NaturalVoicesNotices.nextChange(memory, now: now) else { return }");
    expect(model).toContain('Button(expanded ? "Hide" : "Why?") { expanded.toggle() }');
  });
});
