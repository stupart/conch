import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The reply line alone, where Tyler leaves it (ComposerDock). Tyler: "Can we make it so that the input bar defaults to
 * bottom center of the screen when it's in detached mode (or wherever u left it for that one last time) but u can drag it
 * around where u want to and stuff?" The pure rule (bottom centre, the saved spot, clamping, a screen gone, the snap) is
 * XCTests in design/ConchDesign/Tests/ConchDesignTests/ComposerPlacementTests.swift; these pin the app's wiring of it, in
 * the style of fluid-composer-source.test.ts.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const dock = read("mac-app/conch-mac/ComposerDock.swift");
const panels = read("mac-app/conch-mac/FloatingPanels.swift");
const model = read("design/ConchDesign/Sources/ConchDesign/ComposerPlacement.swift");

/** A Swift member from its signature to its closing brace at `indent` spaces. */
function member(source: string, signature: string, indent = 4): string {
  const start = source.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf(`\n${" ".repeat(indent)}}\n`, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Code only: comment lines out, so a comment naming what used to be there never trips a guard. */
const code = (source: string): string => source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

/** `first` is in `source`, and before `then`, which is there too. */
function before(source: string, first: string, then: string): void {
  const a = source.indexOf(first), b = source.indexOf(then);
  expect(a, `missing: ${first}`).toBeGreaterThan(-1);
  expect(b, `missing: ${then}`).toBeGreaterThan(-1);
  expect(a, `${first} before ${then}`).toBeLessThan(b);
}

const grip = dock.slice(dock.indexOf("private struct ReplyLineGrip: ViewModifier {"), dock.indexOf("private final class SettleClock: NSObject {"));
const moving = [
  "func grab() {",
  "private func dragged(_ event: NSEvent) {",
  "func letGo() {",
  "func sendAloneHome() {",
  "private func settle(from rect: NSRect) {",
  "private func settleStep(_ dt: Double) {",
  "private func settled() {",
];

describe("where the reply line alone sits: the pure rule, and nothing else", () => {
  test("its glass comes from ReplyLinePlacement, with the spot, the screen it is on, the panel's, the pointer and the main one", () => {
    const placed = member(dock, "private func alonePlaced() -> ReplyLinePlacement.Placed? {");
    expect(placed).toContain("ReplyLinePlacement.place(");
    for (const argument of [
      "measure: ConversationTextView.composerMeasure,",
      "height: floatingHeight,",
      "spot: replySpot,",
      "screens: Self.screens,",
      "current: aloneScreen,",
      "home: panels?.screenForReply.map(Self.name(of:)),",
      "pointer: NSEvent.mouseLocation,",
      "main: NSScreen.main.map(Self.name(of:))",
    ]) {
      expect(placed, argument).toContain(argument);
    }
    // Screens by their visible frames, named by their UUID.
    expect(dock).toContain("NSScreen.screens.map { ReplyLinePlacement.Screen(id: name(of: $0), frame: $0.frame, visible: $0.visibleFrame) }");
    expect(member(dock, "private static func name(of screen: NSScreen) -> String {")).toContain("CGDisplayCreateUUIDFromDisplayID(display)");
    expect(dock).toContain("if note.name == NSApplication.didChangeScreenParametersNotification { Self.displayNames = [:] }");
  });

  test("the panel's corner is gone: no corner, no handle, no second geometry", () => {
    expect(model).not.toContain("replyLineFrame");
    expect(model).not.toContain("besideHandle");
    expect(dock).not.toContain("replyLineFrame");
    const card = member(dock, "private func floatingCard(for place: ComposerPlace) -> NSRect? {");
    expect(card).toContain("case .replyLine:\n            return aloneCard()");
    expect(code(card)).not.toContain("corner");
    expect(code(card)).not.toContain("isCollapsed");
    // It grows from the edge its place gives it, not from the panel's corner.
    expect(member(dock, "func follow() {")).toContain("let down = place == .panel ? panelGrowsDown : aloneGrowsDown");
    expect(member(dock, "private func aloneCard() -> NSRect? {")).toContain("aloneGrowsDown = placed.growsDown");
  });

  test("the panel open is unchanged: its reply line is the panel's room, and it never moves", () => {
    expect(member(dock, "private func floatingCard(for place: ComposerPlace) -> NSRect? {")).toContain("case .panel:\n            return panels?.replySlot(height: floatingHeight)");
    expect(dock).toContain(".modifier(ReplyLineGrip(dock: dock, detached: dock.place == .replyLine))");
    // In the panel the grip is off; its field and buttons still work.
    expect(grip).toContain("including: detached ? .all : .subviews");
    expect(member(dock, "func grab() {")).toContain("guard place == .replyLine, shown, !swoop.isFlying, let card = floatingCard(for: .replyLine) else { return }");
  });
});

describe("the saved spot: one, the last he left it at, persisted and read", () => {
  test("written when he lets go, or cleared when it goes home; read back at launch", () => {
    expect(dock).toContain('static let replySpotKey = "conch.replyLine.spot"');
    expect(dock).toContain("private var replySpot: ReplyLineSpot? = ComposerDock.savedReplySpot() {");
    const saved = member(dock, "private static func savedReplySpot() -> ReplyLineSpot? {");
    expect(saved).toContain("UserDefaults.standard.data(forKey: replySpotKey).flatMap { try? JSONDecoder().decode(ReplyLineSpot.self, from: $0) }");
    const property = dock.slice(dock.indexOf("private var replySpot: ReplyLineSpot?"), dock.indexOf("private var aloneScreen: String?"));
    expect(property).toContain("if let replySpot, let data = try? JSONEncoder().encode(replySpot) {\n                UserDefaults.standard.set(data, forKey: Self.replySpotKey)");
    expect(property).toContain("UserDefaults.standard.removeObject(forKey: Self.replySpotKey)");
    // Only a let-go and a trip home write it: never a frame of the drag.
    expect(code(dock).match(/replySpot = /g)?.length).toBe(2);
    expect(member(dock, "private func dragged(_ event: NSEvent) {")).not.toContain("replySpot");
  });

  test("let go: the rule clamps and snaps it, a click remembers nothing, and it settles where it is kept", () => {
    const letGo = member(dock, "func letGo() {");
    before(letGo, "ReplyLinePlacement.isMove(from: grip.pointer, to: pointer)", "replySpot = resting.spot");
    expect(letGo).toContain("ReplyLinePlacement.released(live, screens: Self.screens, pointer: pointer, measure: ConversationTextView.composerMeasure)");
    // A click remembers nothing: back where it was going, from where it is.
    before(letGo, "else { return settle(from: live) }", "replySpot = resting.spot");
    // Kept, on the screen it was let go over, then settled there.
    expect(letGo).toContain("aloneScreen = resting.placed.screen\n        replySpot = resting.spot\n        settle(from: live)");
  });
});

describe("dragging it never takes the keyboard or brings conch forward", () => {
  test("nothing that moves it makes a window key or activates anything", () => {
    for (const signature of moving) {
      const body = code(member(dock, signature));
      expect(body, signature).not.toContain("makeKey");
      expect(body, signature).not.toContain("activate");
      expect(body, signature).not.toContain("makeFirstResponder");
    }
    expect(code(grip)).not.toContain("makeKey");
    expect(code(grip)).not.toContain("activate");
    expect(code(grip)).not.toContain("focus");
    // Still only the field's press and the panel's keys make it key (fluid-composer-source pins the two).
    expect(dock.match(/makeKey\(/g)?.length).toBe(2);
    expect(dock).not.toContain("NSApp.activate");
  });

  test("conch moves it, not the window server, in the non-activating panel", () => {
    expect(dock).toContain("floating.isMovableByWindowBackground = false");
    expect(dock).toContain("floating.onDrag = { [weak self] event in MainActor.assumeIsolated { self?.dragged(event) } }");
    expect(dock).toContain("private let floating = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)");
    // The panel sees the drag and the let-go before the view, and never swallows them: the grip's gesture ends as it began.
    const send = member(panels, "override func sendEvent(_ event: NSEvent) {");
    expect(send).toContain("if event.type == .leftMouseDragged || event.type == .leftMouseUp { onDrag?(event) }");
    before(send, "onDrag?(event) }", "super.sendEvent(event)");
    expect(send).not.toMatch(/onDrag\?\(event\)[^\n]*return/);
  });

  test("its field and buttons keep first claim: the grip is a plain gesture, and the field's press still takes the keys", () => {
    expect(grip).toContain(".gesture(\n                DragGesture(minimumDistance: 0, coordinateSpace: .global)");
    expect(grip).toContain(".onChanged { _ in dock.grab() }");
    expect(grip).toContain(".onEnded { _ in dock.letGo() },");
    expect(grip).not.toContain("highPriorityGesture");
    expect(grip).not.toContain("simultaneousGesture");
    const pressed = member(dock, "private func pressed(_ event: NSEvent) {");
    before(pressed, "lastPress = (floating.convertPoint(toScreen: event.locationInWindow), event.clickCount)", "guard !floating.isKeyWindow");
    expect(pressed).toContain("Self.isField(hit)");
  });
});

describe("it follows the pointer one to one, and settles on let-go", () => {
  test("each drag event puts the glass where the pointer has taken it, from where it was pressed", () => {
    const dragged = member(dock, "private func dragged(_ event: NSEvent) {");
    expect(dragged).toContain("guard let grip else { return }");
    expect(dragged).toContain("if event.type == .leftMouseUp { return letGo() }");
    before(dragged, "aloneLive = grip.card.offsetBy(dx: pointer.x - grip.pointer.x, dy: pointer.y - grip.pointer.y)", "follow()");
    // No spring and no clamp while held: the pointer's own position, now.
    expect(dragged).toContain("let pointer = NSEvent.mouseLocation");
    expect(dragged).not.toContain("ConchMotion");
    expect(dragged).not.toContain("clamped");
    // What follow puts it at while held or settling.
    const card = member(dock, "private func aloneCard() -> NSRect? {");
    expect(card).toContain("guard let live = aloneLive else { return placed.frame }");
    expect(card).toContain("return NSRect(x: live.minX, y: live.minY, width: live.width, height: floatingHeight)");
    // Held from where it is: the press's own point, and the glass where it was then.
    const grab = member(dock, "func grab() {");
    expect(grab).toContain("grip = (press.at, card)");
    before(grab, "settleClock.stop()", "grip = (press.at, card)");
    // A hold whose let-go never arrived ends at the next press.
    expect(member(dock, "private func pressed(_ event: NSEvent) {")).toContain("if grip != nil { letGo() }");
  });

  test("the settle is ConchMotion's dock spring, and Reduce Motion puts it there at once", () => {
    const settle = member(dock, "private func settle(from rect: NSRect) {");
    expect(settle).toContain("guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, let to = alonePlaced()?.frame,");
    expect(settle).toContain("else { return settled() }");
    expect(settle).toContain("settleClock.run(on: floating) { [weak self] dt in self?.settleStep(dt) }");
    const step = member(dock, "private func settleStep(_ dt: Double) {");
    expect(step).toContain("let spring = ConchMotion.dock");
    expect(step).toContain("guard !done else { return settled() }");
    // Toward where the rule puts it now, not where it was let go.
    expect(step).toContain("let to = alonePlaced()?.frame");
    const settled = member(dock, "private func settled() {");
    for (const line of ["settleClock.stop()", "settling = nil", "aloneLive = nil", "follow()"]) expect(settled, line).toContain(line);
  });
});

describe("the swoop to and from it uses where it really is", () => {
  test("the flight's end is the floating card, which is the rule's (or where he holds it)", () => {
    // The whole line: the rule's card, as it is, with nothing laid over it.
    const card = member(dock, "private func floatingCard(for place: ComposerPlace) -> NSRect? {");
    expect(card).toContain("        case .replyLine:\n            return aloneCard()\n        case .window, .none:");
    expect(code(dock).match(/aloneCard\(\)/g)?.length).toBe(2); // the definition, and the floating card
    const shape = member(dock, "private func shape(of place: ComposerPlace) -> ComposerFlight.Shape? {");
    expect(shape).toContain("case .panel, .replyLine:\n            return floatingCard(for: place).map { .floating($0) }");
    const move = member(dock, "private func move(to next: ComposerPlace) {");
    // Leaving it, the flight starts from where it is (held or settling included) before anything is forgotten.
    before(move, "let source = swoop.flight?.current ?? shape(of: from)", "if next != .replyLine { forgetAlone() }");
    before(move, "place = next", "if next != .replyLine { forgetAlone() }");
    before(move, "if next != .replyLine { forgetAlone() }", "let target = shape(of: next)");
    // A flight on its way there follows it if it moves.
    expect(member(dock, "func follow() {")).toContain("swoop.follow(.floating(card))");
  });

  test("while conch steers a paste it stays on the screen it is on", () => {
    // The screen it is on is kept while it is out, and let go only when the input leaves it.
    expect(member(dock, "private func aloneCard() -> NSRect? {")).toContain("if place == .replyLine { aloneScreen = placed.screen }");
    expect(code(dock).match(/aloneScreen = nil/g)?.length).toBe(1);
    expect(member(dock, "private func forgetAlone() {")).toContain("aloneScreen = nil");
    expect(code(dock).match(/forgetAlone\(\)/g)?.length).toBe(2); // the definition, and leaving the reply line alone
    // The steering hold still holds the place (composer-review-fixes); nothing here moves it on its own.
    expect(member(dock, "private var situation: ComposerSituation {")).toContain("|| steering.held(at: ProcessInfo.processInfo.systemUptime)");
  });
});

describe("home: a double click on its chrome, or its accessibility action", () => {
  test("a second click sends it home and forgets the spot, from where it is", () => {
    expect(member(dock, "func grab() {")).toContain("if press.clicks >= 2 { return sendAloneHome() }");
    const home = member(dock, "func sendAloneHome() {");
    expect(home).toContain("let from = place == .replyLine ? floatingCard(for: .replyLine) : nil");
    // Held where it is before the spot goes, so forgetting it never jumps it home unsprung.
    before(home, "if let from { aloneLive = from }", "replySpot = nil");
    before(home, "replySpot = nil", "if let from { settle(from: from) }");
  });

  test("VoiceOver names the drag area, and the way home is an action the keyboard reaches", () => {
    expect(grip).toContain('.accessibilityLabel("Move the reply bar")');
    expect(grip).toContain('.accessibilityAction(named: "Move to bottom centre") { dock.sendAloneHome() }');
    // Only while it is out alone, and never in the way of a press.
    expect(grip).toMatch(/if detached \{\s*Color\.clear\s*\.accessibilityElement\(\)/);
    expect(grip).toContain(".allowsHitTesting(false)");
  });
});
