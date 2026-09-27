import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Setup's Try it and the tour, as the Mac app hosts them (Wave C of conch-design/onboarding/README.md §5). The tour's rule
 * and cards are ConchDesign's (Tour.swift, tested by TourTests); the daemon's practice turn is practice.test.ts and the
 * voice loop's "setup's practice turn". conch-mac has no XCTest target, so these pin its wiring: where each beat's event
 * comes from, a card that never takes focus, the window stepping aside and coming back, the practice's lease, and the one
 * tip.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
/** Swift with its line comments out, so a rule is about code and not about prose naming it. */
const code = (source: string): string => source.replace(/\/\/.*$/gm, "");

const coach = code(read("mac-app/conch-mac/TourCoach.swift"));
const controller = code(read("mac-app/conch-mac/OnboardingController.swift"));
const support = code(read("mac-app/conch-mac/OnboardingSupport.swift"));
const panels = code(read("mac-app/conch-mac/FloatingPanels.swift"));
const canvas = code(read("mac-app/conch-mac/Canvas.swift"));
const models = code(read("mac-app/conch-mac/Models.swift"));
const app = code(read("mac-app/conch-mac/ConchMacApp.swift"));
const statusItem = code(read("mac-app/conch-mac/StatusItem.swift"));
const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");

/** A Swift member from its signature to its closing brace at `indent` spaces. */
function member(source: string, signature: string, indent = 4): string {
  const start = source.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf(`\n${" ".repeat(indent)}}\n`, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("the tour's card", () => {
  test("a panel that never takes focus: non-activating, never key, shown without bringing conch forward", () => {
    const make = member(coach, "private func makePanel(accessibilityLabel: String) -> FloatingPanel {");
    expect(make).toContain("styleMask: [.borderless, .nonactivatingPanel]");
    expect(make).toContain("panel.becomesKeyOnlyIfNeeded = true");
    // FloatingPanel can become key only with `takesKeys`, which the coach never sets.
    expect(coach).not.toContain("takesKeys");
    expect(read("mac-app/conch-mac/FloatingPanels.swift")).toContain("override var canBecomeKey: Bool { takesKeys }");
    expect(member(coach, "private func showCard() {")).toContain("panel.orderFrontRegardless()");
    for (const stealsFocus of ["makeKey", "NSApp.activate", "makeKeyAndOrderFront", "makeFirstResponder"]) {
      expect(coach, stealsFocus).not.toContain(stealsFocus);
    }
    // Its buttons act on the first click, as the control bar's do.
    expect(coach).toContain("FirstClickHostingView(rootView: TourCardHost(coach: self))");
    expect(project).toContain("TourCoach.swift in Sources");
  });

  test("the rule is ConchDesign's: every event goes through TourProgress, and the card is the rule's", () => {
    const apply = member(coach, "func apply(_ event: TourEvent) {");
    expect(apply).toContain("let next = before.applying(event)");
    expect(apply).toContain("if let outcome = next.outcome { return close(outcome) }");
    expect(coach).toContain("CoachCard(card, pointer: coach.pointer, onPrimary: { coach.primary() }, onSkip: { coach.skip() }, onRetry: { coach.retry() })");
    // Skip tour is at every beat, and Next is the fallback.
    expect(member(coach, "func skip() {")).toContain("apply(.skip)");
    expect(member(coach, "func primary() {")).toContain("apply(.next)");
  });

  test("each beat moves on from where the thing happens, never a timer standing in for it", () => {
    const start = member(coach, "func start(store: StateStore, onClose: @escaping (TourProgress.Outcome) -> Void) {");
    expect(start).toContain("store.$state");
    expect(start).toContain("panels.$moves.dropFirst()");
    expect(start).toContain("self?.apply(.panelMoved)");
    expect(start).toContain("CanvasController.shared.$hotKeyPresses.dropFirst()");
    expect(start).toContain("self?.apply(.hotKey)");
    expect(start).toContain("CanvasController.shared.$marksDrawn.dropFirst()");
    expect(start).toContain("self?.apply(.stroke)");
    const state = member(coach, "private func stateChanged(_ state: PublishedState?) {");
    expect(state).toContain("for event in practice.tourEvents { apply(event) }");
    expect(state).toContain("apply(.practiceEnded)");
    // The one wait: Answer out loud showing what was sent, for the rule's own length.
    expect(apply()).toContain("try? await Task.sleep(for: .seconds(TourProgress.shownFor))");
    expect(apply()).toContain("self?.apply(.settle)");
    function apply() { return member(coach, "func apply(_ event: TourEvent) {"); }
  });

  test("Open it opens the practice's own card as the pill would; Listen again asks for another window", () => {
    const primary = member(coach, "func primary() {");
    expect(primary).toContain("panels.queue.open(session: Self.practiceSessionId, store: store, panels: panels)");
    expect(coach).toContain('static let practiceSessionId = "conch-practice"');
    expect(read("src/practice.ts")).toContain('export const PRACTICE_SESSION_ID = "conch-practice";');
    expect(member(coach, "func retry() {")).toContain('SetupDaemonRequest(kind: "practice-listen")');
  });

  test("it hangs from the pill, the panel or the canvas's tools, follows them on the dock spring, and snaps under Reduce Motion", () => {
    const spot = member(coach, "static func spot(for anchor: TourAnchor, pointer: CoachCard.Pointer, size: CGSize) -> (CGPoint, CoachCard.Pointer) {");
    expect(spot).toContain("FloatingPanels.installed?.glassFrame");
    expect(spot).toContain("CanvasController.shared.pillFrame");
    expect(spot).toContain("controlBarGlass()");
    expect(spot).toContain("return (clamp(CGPoint(x: frame.minX - gap - tip - cardWidth - margin, y: top - size.height)), .right)");
    const place = member(coach, "private func place(immediately: Bool) {");
    expect(place).toContain("NSWorkspace.shared.accessibilityDisplayShouldReduceMotion");
    expect(place).toContain("let spring = ConchMotion.dock");
    expect(coach).toContain(".transition(.onboardingSwap(reduceMotion: reduceMotion))");
    expect(coach).toContain(".animation(ConchMotion.swap.animation(reduceMotion: reduceMotion), value: coach.progress.beat)");
  });

  test("VoiceOver hears each beat as it comes, since the card is never focused", () => {
    const announce = member(coach, "private func announce() {");
    expect(announce).toContain("notification: .announcementRequested");
    expect(announce).toContain("card.announcement");
  });
});

describe("the events it listens for", () => {
  test("the panel counts the person's moves, and conch putting it out isn't one", () => {
    expect(member(panels, "func toggleFullScreen() {")).toContain("moves += 1");
    expect(member(panels, "func toggleCollapsed() {")).toContain("moves += 1");
    const released = member(panels, "func released(cancelled: Bool = false) {");
    expect(released).toContain("if let from = pressedAt, hypot(NSEvent.mouseLocation.x - from.x, NSEvent.mouseLocation.y - from.y) > 4 { moves += 1 }");
    expect(member(panels, "func bringOut() {")).not.toContain("moves");
    // The panel's beat puts the panel out when it isn't, and that doesn't count.
    expect(member(coach, "private func beatBegan() {")).toContain("panels.bringOut()");
  });

  test("the tour puts the panel back as it found it: shown or not, folded or not", () => {
    // Putting the panel out for its beat, or the welcome card's first open, isn't the person turning it on (#445 review).
    const start = member(coach, "func start(store: StateStore, onClose: @escaping (TourProgress.Outcome) -> Void) {");
    const found = start.indexOf("panelFound = FloatingPanels.Setting.current");
    expect(found).toBeGreaterThan(-1);
    expect(found).toBeLessThan(start.indexOf("showCard()"));
    const close = member(coach, "private func close(_ outcome: TourProgress.Outcome) {");
    const putBack = close.indexOf("if let found = panelFound { FloatingPanels.installed?.putBack(found) }");
    expect(putBack).toBeGreaterThan(close.indexOf("subscriptions.removeAll()"));
    expect(putBack).toBeLessThan(close.indexOf("done?(outcome)"));
    // Whatever the outcome: finished, skipped, or ended under the person.
    expect(close.slice(0, putBack)).not.toContain("if outcome");
    const current = member(panels, "@MainActor static var current: Setting {", 8);
    for (const key of ["ConchStatusItem.showConversationKey", "FloatingPanels.conversationCollapsedKey", "ConchStatusItem.panelTurnedOnByOpenKey"]) {
      expect(current, key).toContain(`defaults.bool(forKey: ${key})`);
    }
    const back = member(panels, "func putBack(_ setting: Setting) {");
    expect(back).toContain("defaults.set(setting.shown, forKey: ConchStatusItem.showConversationKey)");
    expect(back).toContain("defaults.set(setting.collapsed, forKey: Self.conversationCollapsedKey)");
    expect(back).toContain("defaults.set(setting.turnedOnByOpen, forKey: ConchStatusItem.panelTurnedOnByOpenKey)");
    expect(back).toContain("if !setting.shown, isFullScreen { toggleFullScreen() }");
    expect(back.trimEnd().endsWith("showWhatIsOn()")).toBe(true);
  });

  test("the canvas counts ⌃⌥⌘P and each finished mark, and says where its tools are", () => {
    expect(member(canvas, "func hotKeyPressed() {")).toContain("hotKeyPresses += 1");
    expect(canvas).toContain("MainActor.assumeIsolated { CanvasController.shared.hotKeyPressed() }");
    expect(member(canvas, "func commit(_ mark: CanvasMark, on ink: CanvasInkView) {")).toContain("marksDrawn += 1");
    expect(canvas).toContain("var pillFrame: NSRect? {");
  });

  test("the published practice and its feature are read, leniently, as every other block is", () => {
    expect(models).toContain("practice = try? container.decodeIfPresent(PracticeReport.self, forKey: .practice)");
    expect(models).toContain("let practice: Int?");
    expect(models).toContain("&& practice == other.practice");
  });
});

describe("Try it, in setup's window", () => {
  test("Start holds the practice's lease, then the window steps aside, hidden and not closed, for the tour", () => {
    const start = member(controller, "func startPractice() {");
    expect(start).toContain('SetupDaemon.client.open(SetupDaemonRequest(kind: "practice-start"), timeout: 5)');
    expect(start).toContain("practiceLease = opened.descriptor");
    expect(start.indexOf("OnboardingController.shared.stepAside()")).toBeGreaterThan(-1);
    expect(start.indexOf("OnboardingController.shared.stepAside()")).toBeLessThan(start.indexOf("TourCoach.shared.start(store: stateStore)"));
    // A refusal lets go of the connection and says the daemon's own words.
    expect(start).toContain("Darwin.close(opened.descriptor)");
    expect(start).toContain("practiceRefusal = PracticeReport.Problem(reason: reply?.reason ?? \"unknown\",");
    const aside = member(controller, "func stepAside() {");
    expect(aside).toContain("window?.orderOut(nil)");
    expect(aside).not.toContain("performClose");
  });

  test("the tour closing stops the practice, lets go of its lease, and brings the window back on You're set", () => {
    const closed = member(controller, "private func tourClosed(_ outcome: TourProgress.Outcome) {");
    expect(closed.indexOf("endPractice()")).toBeGreaterThan(-1);
    expect(closed).toContain("case .finished, .skipped:");
    expect(closed).toContain("apply(.next)");
    expect(closed).toContain("OnboardingController.shared.show()");
    const end = member(controller, "func endPractice() {");
    expect(end).toContain('SetupDaemonRequest(kind: "practice-stop")');
    expect(end).toContain("Darwin.close(lease)");
  });

  test("Start waits on the microphone and speech recognition, by the rule, and says why", () => {
    expect(controller).toContain("OnboardingReports.practiceStart(microphone: PermissionCenter.shared.statuses[.microphone], speech: published.speech,");
    expect(controller).toContain("OnboardingPracticeStep(state: model.practiceAvailability == nil ? .problem(SetupDaemon.notAnswering) : model.practiceStart,");
    expect(controller).toContain("onStart: model.startPractice, onSkip: { model.apply(.skip) }, onAction: model.practiceAction) {");
    const action = member(controller, "func practiceAction() {");
    expect(action).toContain("permissionAction(.microphone, PermissionCenter.shared.statuses[.microphone]?.action ?? .ask)");
    expect(action).toContain("handBack()");
  });

  test("the phone's hold is left alone until the person presses Hand it back, which sends the phone's own hand-back", () => {
    expect(support).toContain('let kind = "audio-sink"');
    const handBack = member(controller, "private func handBack() {");
    expect(handBack).toContain('AudioSinkRequest(sink: "mac")');
    // Nowhere else in the app sends it.
    const sources = ["TourCoach.swift", "OnboardingController.swift", "OnboardingSupport.swift", "FloatingPanels.swift", "Canvas.swift", "StateStore.swift"];
    const senders = sources.filter((name) => code(read(`mac-app/conch-mac/${name}`)).includes("AudioSinkRequest("));
    expect(senders).toEqual(["OnboardingController.swift"]);
    expect(controller.match(/AudioSinkRequest\(/g)?.length).toBe(1);
  });

  test("the tour is findable again: Help › Take the tour", () => {
    expect(app).toContain('Button("Take the tour") { OnboardingController.shared.takeTheTour() }');
    expect(member(controller, "func takeTheTour() {")).toContain("open(step: .practice)");
  });
});

describe("the one tip", () => {
  test("left when the tour closes (not when it ended under the person), gone at the pill's first use or its ×, never again", () => {
    const close = member(coach, "private func close(_ outcome: TourProgress.Outcome) {");
    expect(close).toContain("if outcome != .ended {");
    expect(close).toContain("tipState = PillTip.after(tipState, tourClosed: true)");
    expect(coach).toContain('static let tipKey = "conch.tour.pillTip"');
    expect(member(coach, "private func tipUsed(dismissed: Bool) {")).toContain("tipState = PillTip.after(tipState, pillUsed: !dismissed, dismissed: dismissed)");
    expect(coach).toContain("NotificationCenter.default.addObserver(forName: .readyPillClicked");
    // The pill's walk says it was used; a tip from an earlier launch shows again once the panels are up.
    expect(panels).toContain("if origin == .pill { NotificationCenter.default.post(name: .readyPillClicked, object: nil) }");
    expect(statusItem).toContain("TourCoach.shared.install(store: store)");
    expect(member(coach, "func showTipIfPending() {")).toContain("guard tipState == .pending, !running");
  });
});
