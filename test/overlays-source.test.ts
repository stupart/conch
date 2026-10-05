import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The overlays switch (2026-10-05). Tyler: "comment out or move to another branch the non-main Mac app stuff, like the
// conversation overlay and mini view on other screens ... not really there UX-wise and kinda annoying atm." Gated rather
// than deleted: one switch (`conch.overlays`, Debug ▸ Overlays (experimental)), off by default, and while it is off none
// of the surfaces conch puts on screens outside its own window installs, registers a key or shows. conch-mac has no
// XCTest target, so these pin the wiring; ConchOverlaysTests pins the rules (the switch, the menu, the input, opening,
// setup's Try it).

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

const count = (source: string, text: string): number => source.split(text).length - 1;

const rule = read("design/ConchDesign/Sources/ConchDesign/ConchOverlays.swift");
const item = read("mac-app/conch-mac/StatusItem.swift");
const app = read("mac-app/conch-mac/ConchMacApp.swift");
const panels = read("mac-app/conch-mac/FloatingPanels.swift");
const canvas = read("mac-app/conch-mac/Canvas.swift");
const dock = read("mac-app/conch-mac/ComposerDock.swift");
const coach = read("mac-app/conch-mac/TourCoach.swift");
const ink = read("mac-app/conch-mac/AgentInkController.swift");
const content = read("mac-app/conch-mac/ContentView.swift");
const onboarding = read("mac-app/conch-mac/OnboardingController.swift");
const menu = read("design/ConchDesign/Sources/ConchDesign/StatusMenu.swift");
const placement = read("design/ConchDesign/Sources/ConchDesign/ComposerPlacement.swift");
const reports = read("design/ConchDesign/Sources/ConchDesign/OnboardingReports.swift");
/** Every Swift file in the Mac app, joined. */
const mac = readdirSync(join(root, "mac-app/conch-mac"))
  .filter((name) => name.endsWith(".swift"))
  .map((name) => read(`mac-app/conch-mac/${name}`))
  .join("\n");

describe("the switch", () => {
  test("is off by default: a UserDefaults bool nobody registers, read the one way", () => {
    expect(rule).toContain('public static let key = "conch.overlays"');
    expect(rule).toContain("public static let byDefault = false");
    expect(member(rule, "public static func enabled(stored: Any?) -> Bool {")).toContain("(stored as? Bool) ?? byDefault");
    expect(item).toContain(
      "nonisolated static var overlaysOn: Bool { ConchOverlays.enabled(stored: UserDefaults.standard.object(forKey: ConchOverlays.key)) }",
    );
    // Never turned on by a registered default, and never written by the app but through the Debug toggle.
    expect(mac).not.toMatch(/ConchOverlays\.key\s*:\s*true/);
    expect(mac).not.toMatch(/set\(true, forKey: ConchOverlays\.key\)/);
    expect(mac).not.toContain('"conch.overlays"');
    // Every read of it goes through overlaysOn, or the views' own @AppStorage with the same default.
    expect(count(mac, "@AppStorage(ConchOverlays.key) private var")).toBe(3);
    expect(count(mac, "@AppStorage(ConchOverlays.key)")).toBe(count(mac, "= ConchOverlays.byDefault"));
  });

  test("is in the Debug menu, beside the lagoon's and the Terminal Mirror's, which stay", () => {
    const debug = app.slice(app.indexOf('CommandMenu("Debug") {'), app.indexOf("CommandGroup(after: .help) {"));
    expect(debug).toContain("TerminalMirrorMenuToggle()");
    expect(debug).toContain("LagoonMenuToggle()");
    expect(debug).toContain("OverlaysMenuToggle()");
    const toggle = item.slice(item.indexOf("struct OverlaysMenuToggle: View {"), item.indexOf("\n}\n", item.indexOf("struct OverlaysMenuToggle: View {")));
    expect(toggle).toContain("@AppStorage(ConchOverlays.key) private var isOn = ConchOverlays.byDefault");
    expect(toggle).toContain('Toggle("Overlays (experimental)", isOn: $isOn)');
    // Live, both ways: no "after relaunch" in its words.
    expect(toggle).not.toContain("relaunch");
  });
});

describe("nothing of them installs while it is off", () => {
  test("the panels, the canvas, the reply line and the tour install only through installOverlays, only while it is on", () => {
    const install = member(item, "static func install(store: StateStore) {");
    expect(install).toContain("if overlaysOn { installOverlays(store: store) }");
    expect(install).toContain("NaturalVoicesNoticeStore.shared.install(store: store)");
    const overlays = member(item, "private static func installOverlays(store: StateStore) {");
    const order = [
      "FloatingPanels.install(store: store)",
      "CanvasController.shared.install(store: store)",
      "ComposerDock.shared.install(store: store)",
      "TourCoach.shared.install(store: store)",
    ];
    const at = order.map((call) => overlays.indexOf(call));
    expect(at.every((index) => index > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Nowhere else, in the app or the status item's own install.
    for (const call of order) {
      expect(count(mac, call), call).toBe(1);
      expect(install).not.toContain(call);
    }
    // At launch, and when switched on while conch runs.
    expect(count(item, "installOverlays(store: store)")).toBe(2);
    // The agent's marks and the hotkey come with the canvas, never on their own.
    expect(count(mac, "AgentInkController.shared.install(store: store)")).toBe(1);
    expect(member(canvas, "func install(store: StateStore) {")).toContain("AgentInkController.shared.install(store: store)");
  });

  test("⌃⌥⌘P is registered only with the canvas, let go when they go, and handled once however often it comes back", () => {
    expect(count(mac, "CanvasHotKey.register()")).toBe(2);
    expect(member(canvas, "func install(store: StateStore) {")).toContain("CanvasHotKey.register()");
    const switched = member(canvas, "func overlaysSwitched(on: Bool) {");
    expect(switched).toContain("guard !on else { return CanvasHotKey.register() }");
    expect(switched).toContain("CanvasHotKey.unregister()");
    const register = member(canvas, "static func register() {");
    expect(register).toContain("guard registered == nil else { return }");
    expect(register).toContain("if handler == nil {");
    expect(register).toContain("}, 1, &pressed, nil, &handler)");
    const unregister = member(canvas, "static func unregister() {");
    expect(unregister).toContain("UnregisterEventHotKey(hotKey)");
    expect(unregister).toContain("registered = nil");
  });

  test("the menu's overlay items are there only while it is on", () => {
    const rows = member(menu, "public static func rows(_ input: Input) -> [Row] {");
    const gated = rows.slice(rows.indexOf("if input.overlays {"), rows.indexOf("if !input.ready.isEmpty || !input.working.isEmpty"));
    for (const title of ["Control Bar", "Conversation Panel", "Reply Line", "With Panel Off", "Draw on Screen"]) {
      expect(count(menu, `Item(title: "${title}"`), title).toBe(1);
      expect(gated, title).toContain(`Item(title: "${title}"`);
    }
    expect(member(item, "func menuNeedsUpdate(_ menu: NSMenu) {")).toContain("overlays: Self.overlaysOn");
    // The Help menu's tour and the shortcut list's pen and panel keys go with them.
    const help = app.slice(app.indexOf("CommandGroup(after: .help) {"), app.indexOf("Settings {"));
    expect(help).toContain("TakeTheTourMenuItem()");
    expect(help).not.toContain('Button("Take the tour")');
    expect(count(app, 'Button("Take the tour")')).toBe(1);
    const tour = app.slice(app.indexOf("private struct TakeTheTourMenuItem: View {"));
    expect(tour).toContain("if overlays {\n            Button(\"Take the tour\") { OnboardingController.shared.takeTheTour() }");
    const sheet = content.slice(content.indexOf("private var content: some View {", content.indexOf("private struct KeyboardShortcutsSheet")));
    expect(sheet).toContain('if overlays {\n                ShortcutHelpSection(title: "Drawing on screen", rows: drawRows)');
  });
});

describe("switched while conch runs", () => {
  test("the status item hears the switch and tells the canvas and the tour; the panels and the input watch it themselves", () => {
    expect(member(item, "private func watchOverlays() {")).toContain("forName: UserDefaults.didChangeNotification");
    const changed = member(item, "private func overlaysChanged() {");
    expect(changed).toContain("guard on != overlaysShown else { return }");
    expect(changed).toContain("if on { Self.installOverlays(store: store) }");
    expect(changed).toContain("CanvasController.shared.overlaysSwitched(on: on)");
    expect(changed).toContain("TourCoach.shared.overlaysSwitched(on: on)");
    // The panels: neither shows while it is off, and the switcher lets go of the keys and its watch on other apps.
    const shows = member(panels, "private func showWhatIsOn() {");
    expect(shows).toContain("let overlays = ConchStatusItem.overlaysOn");
    expect(shows).toContain("if !overlays { switching = false }");
    expect(shows).toContain("show(controlBar, overlays && defaults.bool(forKey: ConchStatusItem.showControlBarKey))");
    expect(shows).toContain("show(fog, overlays && defaults.bool(forKey: ConchStatusItem.showConversationKey))");
    expect(panels).toContain("forName: UserDefaults.didChangeNotification");
  });

  test("the canvas: nothing on screen while off, the pen never down, a Show and the ink thrown away", () => {
    expect(member(canvas, "func apply() {")).toContain("guard ConchStatusItem.overlaysOn else { return putAway() }");
    expect(member(canvas, "func arm() {")).toContain("guard !armed, !sending, store != nil, ConchStatusItem.overlaysOn else { return }");
    const switched = member(canvas, "func overlaysSwitched(on: Bool) {");
    const off = ["cancelShow()", "lift()", "clear()", "putAway()", "CanvasHotKey.unregister()"].map((line) => switched.indexOf(line));
    expect(off.every((at) => at > -1)).toBe(true);
    expect([...off].sort((a, b) => a - b)).toEqual(off);
    const away = member(canvas, "private func putAway() {");
    expect(away).toContain("for (panel, _) in glass { panel.orderOut(nil) }");
    expect(away).toContain("pill.orderOut(nil)");
    expect(away).toContain("FloatingPanels.installed?.overGlass(false)");
    // The agent's marks are drawn on that glass, a window over every screen: none while it is off.
    expect(member(ink, "func show(_ item: ReviewItem) {")).toContain("guard store != nil, ConchStatusItem.overlaysOn, item != shown else { return }");
  });

  test("the tour: never started, its tip never shown, and one under way skipped", () => {
    const start = member(coach, "func start(store: StateStore, onClose: @escaping (TourProgress.Outcome) -> Void) {");
    expect(start).toContain("guard ConchStatusItem.overlaysOn else { return onClose(.skipped) }");
    expect(member(coach, "func showTipIfPending() {")).toContain("guard ConchStatusItem.overlaysOn, tipState == .pending, !running");
    const switched = member(coach, "func overlaysSwitched(on: Bool) {");
    expect(switched).toContain("if running { close(.skipped) }");
    expect(switched).toContain("hideTip()");
    expect(switched).toContain("self?.showTipIfPending()");
  });
});

describe("the input never leaves conch's window while it is off", () => {
  test("the placement rule says the window first, and the dock asks it with the switch", () => {
    const place = member(placement, "public static func place(_ situation: ComposerSituation, current: ComposerPlace) -> ComposerPlace {");
    expect(place.indexOf("if !situation.overlays { return .window }")).toBeGreaterThan(-1);
    expect(place.indexOf("if !situation.overlays { return .window }")).toBeLessThan(place.indexOf("if situation.held { return current }"));
    expect(member(dock, "private var situation: ComposerSituation {")).toContain("overlays: ConchStatusItem.overlaysOn");
    // Not installed at all while off from launch: the window composer is laid out (`place` .window, `shown`), as it always was.
    expect(dock).toContain("@Published private(set) var place: ComposerPlace = .window");
    expect(dock).toContain("@Published private(set) var shown = true");
    expect(member(dock, "func update() {")).toContain("guard installed else { return }");
    expect(read("mac-app/conch-mac/DashboardView.swift")).toContain("if dock.place == .window {");
  });
});

describe("what opened in the panel opens in conch's window while it is off", () => {
  test("one rule, and one door: the session, its deliverable pane on that version, beside the conversation", () => {
    // ConchOverlaysTests pins every case; off, nothing is ever the panel.
    expect(rule).toContain("return panelDraws || conchOnly || words ? .window : .stage");
    const open = member(item, "static func open(_ row: SessionRow, from origin: OpenFrom, store: StateStore, panels: FloatingPanels?) async -> Bool {");
    expect(open).toContain("let panels = overlaysOn ? panels : nil");
    expect(open).toContain("let destination = ConchOverlays.destination(overlays: panels != nil, panelDraws: content != nil,");
    expect(open).toContain("case .window:\n            openInWindow(row, store: store)\n            return true");
    const door = member(item, "static func openInWindow(_ row: SessionRow, store: StateStore) {");
    expect(door).toContain("bringConchForward()");
    expect(door).toContain("NotificationCenter.default.post(name: .openInWindowFromStatusItem, object: WindowOpen(sessionId: row.id, reviewId: review?.id))");
    expect(door).toContain('store.reportShowing(.conch(sessionId: row.id, view: "main"), staged: ConchScreenStaged(sessionId: row.id, reviewId: review?.id, link: review?.link))');
    expect(count(mac, ".openInWindowFromStatusItem")).toBe(2);
    expect(content).toContain(".onReceive(NotificationCenter.default.publisher(for: .openInWindowFromStatusItem)) { note in");
    const window = member(content, "private func openInWindow(_ row: SessionRow, review: ReviewItem.ID?) {");
    for (const line of [
      "workspace.viewing = row.id",
      "workspace.show(stage: .sideBySide, for: row.id)",
      "workspace.show(work: .deliverable, for: row.id)",
      "if let review { workspace.select(deliverable: review, for: row.id) }",
      "storedPage = .sessions",
    ]) {
      expect(window).toContain(line);
    }
  });

  test("the menu's Ready for you rows walk the one queue with or without panels, and count what they open", () => {
    expect(member(item, "@objc private func openItem(_ sender: NSMenuItem) {")).toContain(
      "ReviewQueue.shared.open(session: id, store: store, panels: Self.panels)",
    );
    expect(item).toContain("static var panels: FloatingPanels? { overlaysOn ? FloatingPanels.installed : nil }");
    expect(panels).toContain("    static let shared = ReviewQueue()\n");
    expect(panels).toContain("    let queue = ReviewQueue.shared\n");
    const stage = member(panels, "private func stage(\n        from origin: ConchStatusItem.OpenFrom,");
    expect(stage).toContain("panels?.staged = found.row.id");
    expect(stage).toContain("store.markReviewViewed(sessionId: found.row.id, review: key)");
  });
});

describe("setup", () => {
  test("has no Try it while it is off", () => {
    expect(member(reports, "public static func practiceAvailability(feature: Int?, published: Bool, overlays: Bool) -> Bool? {")).toContain(
      "guard overlays else { return false }",
    );
    expect(onboarding).toContain("overlays: ConchStatusItem.overlaysOn)");
  });
});

describe("the overlay shoot rig", () => {
  test("turns the overlays on for its shots and puts the switch back as it found it", () => {
    const shoot = read("scripts/shoot-overlay.ts");
    expect(shoot).toContain('const OVERLAYS_KEY = "conch.overlays";');
    expect(shoot).toContain('await sh("defaults", "write", DOMAIN, OVERLAYS_KEY, "-bool", "YES");');
    expect(shoot).toContain("for (const key of [FRAME_KEY, COLLAPSED_KEY, SHOW_KEY, APPEARANCE_KEY, OVERLAYS_KEY]) restore[key] = await readDefault(key);");
    expect(shoot).toContain('else if (key === OVERLAYS_KEY) await sh("defaults", "write", DOMAIN, key, "-bool", value.trim() === "1" ? "YES" : "NO");');
  });
});
