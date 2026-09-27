import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One input, in one place, and the swoop between them (ComposerDock).
 *
 * Tyler: "Have to make sure only one is in use or active at a time — think of it like: the input box is leaving the Mac
 * app and coming with you — we literally remove it from the Mac app UI until they go back to the app and it swoops back
 * into the UI." The pure rules (where it is, the flight's springs, interruption) are XCTests in
 * design/ConchDesign/Tests/ConchDesignTests/ComposerPlacementTests.swift; these pin the app's wiring of them.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const dock = read("mac-app/conch-mac/ComposerDock.swift");
const dashboard = read("mac-app/conch-mac/DashboardView.swift");
const panels = read("mac-app/conch-mac/FloatingPanels.swift");
const fog = read("design/ConchDesign/Sources/ConchDesign/Components.swift");
const model = read("design/ConchDesign/Sources/ConchDesign/ComposerPlacement.swift");
const composer = read("mac-app/conch-mac/ComposerView.swift");

/** A Swift member from its signature to its closing brace at `indent` spaces. */
function member(source: string, signature: string, indent = 4): string {
  const start = source.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf(`\n${" ".repeat(indent)}}\n`, start);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);
  expect(body.length).toBeGreaterThan(signature.length + 20);
  return body;
}

describe("only one input is ever in use", () => {
  test("where it is is one value, from one rule", () => {
    expect(dock).toContain("@Published private(set) var place: ComposerPlace = .window");
    // Every change of place goes through the pure rule (ComposerPlacementTests), never a second judgement here.
    const update = member(dock, "func update() {");
    expect(update).toContain("let next = ComposerPlacement.place(situation, current: place)");
    // The panel moving, growing or folding arrives only as an update with the same place: the reply line still follows it.
    expect(update).toContain("guard next != place else { return follow() }");
    expect(dock).toContain(".sink { [weak self] _ in MainActor.assumeIsolated { self?.update() } }");
    expect(dock.match(/place = next/g)?.length).toBe(1);
    expect(member(dock, "private func move(to next: ComposerPlace) {")).toContain("place = next");
  });

  test("the window builds its composer only while the input is in the window, and touchable only once it has landed", () => {
    const floating = member(dashboard, "private func floatingComposer(for row: SessionRow) -> some View {");
    expect(floating).toMatch(/if dock\.place == \.window \{\s*composer\(for: row\)/);
    expect(floating).toContain(".allowsHitTesting(dock.shown)");
    // Every composer in the window comes through that gate: it is built in one place, and the three stages all float it
    // through `floatingComposer`.
    expect(dashboard).toContain("private func composer(for row: SessionRow) -> some View {");
    expect(dashboard.match(/\bcomposer\(for\b/g)?.length).toBe(2); // the definition, and the one call behind the gate
    expect(dashboard.match(/\bSessionComposer\(/g)?.length).toBe(1);
  });

  test("the floating composer is built only while the input is out of the window", () => {
    const host = dock.slice(dock.indexOf("private struct ComposerFloatingHost: View {"), dock.indexOf("// MARK: - The swoop"));
    expect(host.length).toBeGreaterThan(400);
    expect(host).toMatch(/if dock\.place\.floats, let row = dock\.floatingRow\(store\.state\) \{\s*SessionComposer\(/);
    expect(host).toContain("chrome: .panel,");
  });

  test("the panel draws no reply line of its own: its reply line is the composer, laid over its room", () => {
    const host = member(panels, "var body: some View {\n        let row = Self.session(store.state, staged: panels.staged ?? panels.replyPin)");
    expect(host).toContain("heldReply: panels.heldReply,");
    expect(host).toContain("onMic: {},");
    expect(host).toContain("onSend: {},");
    // Held, the fog keeps only the room: no InlineReplyLine, nothing to press.
    const line = member(fog, "private func ownOrHeldLine(fontSize: CGFloat, height: CGFloat, top: Bool, overflows: Bool) -> some View {");
    expect(line).toMatch(/if heldReply != nil \{\s*Color\.clear\.frame\(height: height\)\s*\} else \{\s*InlineReplyLine\(/);
    // The room is held only while the input is in the panel or on its way there.
    expect(member(dock, "func follow() {")).toContain("panels?.holdReply(place == .panel ? floatingHeight : 0)");
  });
});

describe("the input is removed from the window's layout, not hidden in it", () => {
  test("away, the window's composer is not built at all", () => {
    const floating = member(dashboard, "private func floatingComposer(for row: SessionRow) -> some View {");
    // Removed by the `if`, not faded or hidden while it stays laid out, focusable and sending.
    expect(floating).not.toContain(".hidden()");
    expect(floating).not.toMatch(/opacity\(dock\.place/);
    expect(floating).not.toMatch(/if true \{/);
    // Its opacity waits only for the swoop landing on it, while it IS in the window.
    const gate = floating.indexOf("if dock.place == .window {");
    const shown = floating.indexOf(".opacity(dock.shown ? 1 : 0)");
    expect(gate).toBeGreaterThan(-1);
    expect(shown).toBeGreaterThan(gate);
  });

  test("the room it took stays behind it, so nothing in the window jumps as it goes and comes back", () => {
    // `composerHeight` is only ever set from the composer's own measured height, so it keeps its last one while away.
    expect(dashboard.match(/composerHeight = /g)?.length).toBe(1);
    expect(dashboard).toContain("bottomInset: composerHeight,");
  });
});

describe("leaving never takes the keyboard from the app Tyler went to", () => {
  test("the floating composer's window is key only when its field is clicked", () => {
    // Two makeKeys in the whole dock: the press handler, behind the field check; and the field keeping the keys it
    // already had when the panel's own key (⌘↩) took them for the panel (`keepKeys`, composer-review-fixes).
    expect(dock.match(/makeKey\(/g)?.length).toBe(2);
    const keep = member(dock, "private func keepKeys(_ field: NSTextView?) {");
    expect(keep).toContain("guard let field, field.window === floating, !(floating.isKeyWindow && floating.firstResponder === field) else { return }");
    expect(keep).toContain("floating.makeKey()");
    const pressed = member(dock, "private func pressed(_ event: NSEvent) {");
    expect(pressed).toContain("guard !floating.isKeyWindow, let hit = floating.contentView?.hitTest(event.locationInWindow), Self.isField(hit) else { return }");
    expect(pressed).toContain("floating.makeKey()");
    expect(dock).toContain("floating.onPress = { [weak self] event in MainActor.assumeIsolated { self?.pressed(event) } }");
    // Non-activating, and asked to become key only when a view needs it.
    expect(dock).toContain("private let floating = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)");
    expect(dock).toContain("floating.becomesKeyOnlyIfNeeded = true");
  });

  test("arriving shows it without making it key or bringing conch forward", () => {
    for (const signature of ["private func move(to next: ComposerPlace) {", "private func arrived(at arrival: ComposerPlace) {", "func follow() {"]) {
      const body = member(dock, signature);
      expect(body, signature).not.toContain("makeKey");
      expect(body, signature).not.toContain("NSApp.activate");
    }
    expect(member(dock, "func follow() {")).toContain("floating.orderFrontRegardless()");
    // The only front conch hands anywhere is back to the app a file picker took it from.
    expect(dock).not.toContain("NSApp.activate");
    expect(member(dock, "func release(handingBackTo app: NSRunningApplication?) {")).toContain("app.activate()");
    // The swoop's panels never take a click or the keys.
    const swoop = dock.slice(dock.indexOf("final class ComposerSwoop {"));
    expect(swoop).toContain("panel.ignoresMouseEvents = true");
    expect(swoop).not.toContain("takesKeys = true");
  });

  test("the panel's own keys still reach it while typing in its reply line; Esc lets go of the field", () => {
    const key = member(dock, "private func key(_ event: NSEvent) -> Bool {");
    // ⌘↩ and the rest go to the panel first, or the composer's Return would send on ⌘↩. Present, then first.
    const forwarded = key.indexOf("if panels?.replyKey(event) == true {\n                keepKeys(field)\n                return true\n            }");
    expect(key).toContain("if place == .panel {\n            let field = typing ? floating.firstResponder as? NSTextView : nil");
    const escape = key.indexOf("guard event.keyCode == 53");
    expect(forwarded).toBeGreaterThan(-1);
    expect(escape).toBeGreaterThan(-1);
    expect(forwarded).toBeLessThan(escape);
    const reply = member(panels, "func replyKey(_ event: NSEvent) -> Bool {");
    expect(reply).toContain("typing: true");
    expect(reply).toContain("case .fullScreen?, .collapse?, .previous?, .next?: return key(event)");
    expect(key).toContain("floating.makeFirstResponder(nil)");
    expect(key).toContain("floating.orderOut(nil)\n            floating.orderFrontRegardless()");
  });
});

describe("Reduce Motion is a crossfade in place", () => {
  test("the flight travels nowhere and fades the input out where it was and in where it goes", () => {
    const step = member(model, "public mutating func step(dt: Double) -> Bool {");
    // Nothing travels: the frame is wherever it lands.
    expect(step).toMatch(/if reduceMotion \{\s*\/\/ Nothing travels: the frame is wherever it lands\.\s*midX = Sprung\(target\.rect\.midX\)/);
    expect(step).toContain("let spring = ConchMotion.morph.resolved(reduceMotion: reduceMotion)");
    const cards = member(model, "public var cards: [Card] {");
    expect(cards).toContain("Card(shape: source, opacity: leaving * hand, leaving: 1, arriving: 0, lift: 0)");
    expect(cards).toContain("Card(shape: target, opacity: arriving * hand, leaving: 0, arriving: 1, lift: 0)");
  });

  test("the app asks the system, and quiets the floating composer's own fades too", () => {
    const move = member(dock, "private func move(to next: ComposerPlace) {");
    expect(move).toContain("let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion");
    expect(move.match(/reduceMotion: reduceMotion\)/g)?.length).toBe(3);
    expect(member(dock, "func follow() {")).toContain("context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : ConchMotion.quick");
  });
});

describe("the swoop is one glass, never stretched and never dimmed", () => {
  test("the pictures on the glass are cut where the composer's layout moves, and placed at their own size", () => {
    const picture = member(dock.slice(dock.indexOf("private final class SwoopPicture {")), "func show(_ face: SwoopFace?, on size: CGSize, opacity: CGFloat) {");
    expect(picture).toContain("let slices = ComposerFlight.slices(picture: face.size, in: size)");
    expect(picture).toContain("piece.frame = CGRect(x: to.minX, y: size.height - to.maxY, width: to.width, height: to.height)");
    expect(model).toContain("Slice(from: CGRect(x: 0, y: 0, width: picture.width, height: top), to: CGRect(x: 0, y: 0, width: picture.width, height: top))");
  });

  test("the glass and what is on it fade as one at the hand-off", () => {
    expect(dock).toContain("glass.allowsGroupOpacity = true");
    // The look it lands as over the look it left.
    const card = dock.slice(dock.indexOf("private final class SwoopCard {"));
    expect(card.indexOf("glass.addSublayer(leaving.layer)")).toBeGreaterThan(-1);
    expect(card.indexOf("glass.addSublayer(leaving.layer)")).toBeLessThan(card.indexOf("glass.addSublayer(arriving.layer)"));
  });

  test("a new place mid-flight retargets the flight in the air; nothing queues", () => {
    const move = member(dock, "private func move(to next: ComposerPlace) {");
    const flying = move.indexOf("if swoop.isFlying {");
    expect(flying).toBeGreaterThan(-1);
    expect(move.slice(flying)).toContain("swoop.retarget(to: next, at: target, face: targetFace)");
    // It returns from the retarget before any new flight is made: present, then first.
    const returns = move.indexOf("return\n        }", flying);
    const fresh = move.indexOf("swoop.fly(", flying);
    expect(returns).toBeGreaterThan(flying);
    expect(fresh).toBeGreaterThan(flying);
    expect(returns).toBeLessThan(fresh);
  });
});

describe("the swoop's picture holds nothing ImageRenderer can't draw", () => {
  // ImageRenderer draws an AppKit-backed view as its placeholder, a yellow box with a no-entry sign. The composer's
  // `.onDrop` is one, and it covered the whole input box: Tyler saw "the input box itself turned yellow" mid-swoop.
  test("the picture is the bare, static composer", () => {
    const picture = member(dock, "private func face(of row: SessionRow?, width: CGFloat?, dark: Bool) -> CGImage? {");
    expect(picture).toContain("chrome: .bare");
    expect(picture).toContain(".environment(\\.conchRendersStatically, true)");
  });

  test("the drop target is left out of the picture", () => {
    expect(composer.match(/\.onDrop\(/g)?.length).toBe(1);
    const target = composer.slice(composer.indexOf("private struct ComposerDropTarget: ViewModifier {"));
    expect(target.indexOf("if live {")).toBeGreaterThan(-1);
    expect(target.indexOf("if live {")).toBeLessThan(target.indexOf(".onDrop("));
    expect(composer).toContain(".modifier(ComposerDropTarget(live: !rendersStatically, isTargeted: $isTargetedForDrop, load: load))");
  });

  test("the editor and its AppKit bridges are only in the live branch", () => {
    const staticField = composer.indexOf("} else if rendersStatically {");
    const editor = composer.indexOf("TextEditor(text: $draft)");
    expect(composer.match(/TextEditor\(/g)?.length).toBe(1);
    expect(staticField).toBeGreaterThan(-1);
    expect(staticField).toBeLessThan(editor);
    for (const bridge of [".conchTextViewInsets(", ".conchSpelling()", "ComposerPasteBridge { urls in attach(urls) }"]) {
      expect(composer.indexOf(bridge), bridge).toBeGreaterThan(editor);
      expect(composer.indexOf(bridge), bridge).toBeLessThan(composer.indexOf("if draft.isEmpty {", editor));
    }
    // The card's anchor is the window's alone; the picture is `.bare`.
    const card = composer.slice(composer.indexOf("private struct ComposerCard: ViewModifier {"));
    const anchor = card.indexOf(".background(ComposerCardAnchor())");
    expect(anchor).toBeGreaterThan(card.indexOf("case .window:"));
    expect(anchor).toBeLessThan(card.indexOf("case .panel:"));
  });
});
