import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The composer review of 28 Sep (#437): the fixes, pinned. The pure rules (the steering hold) are XCTests in
 * design/ConchDesign/Tests/ConchDesignTests/ComposerPlacementTests.swift; these pin the app's wiring of them, in the
 * style of fluid-composer-source.test.ts.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const dock = read("mac-app/conch-mac/ComposerDock.swift");
const composer = read("mac-app/conch-mac/ComposerView.swift");
const panels = read("mac-app/conch-mac/FloatingPanels.swift");
const store = read("mac-app/conch-mac/StateStore.swift");
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

describe("1: typing never switches the session under you", () => {
  test("a reply in progress, or the keyboard in the reply line, holds the panel on its session", () => {
    const pin = member(dock, "private func pinReply(writing: Bool = false) {");
    expect(pin).toContain("if place.floats, let row = floatingRow(store?.state) {");
    // Takes hold while Tyler writes there; holds while the draft lasts or the keyboard is in the field. A draft left
    // from another day does not freeze the panel on its own.
    expect(pin).toContain("let draft = ComposerDraftStore.shared.hasDraft(row.id)");
    expect(pin).toContain("if typing || (draft && (writing || panels.replyPin == row.id)) { pin = row.id }");
    expect(pin).toContain("if panels.replyPin != pin { panels.replyPin = pin }");
    // Not staging: staging clears the canvas's marks, so it could not hold with marks up. The pin only keeps the panel
    // where it is, marks or not.
    expect(pin).not.toContain("staged");
    expect(pin).not.toContain("has(.you)");
    expect(member(dock, "private var typing: Bool {")).toContain("floating.isKeyWindow && (floating.firstResponder as? NSTextView)?.isEditable == true");
    expect(member(composer, "func hasDraft(_ sessionID: String) -> Bool", 4)).toContain("drafts[sessionID] != nil");
  });

  test("the panel is on the pinned session after anything Tyler staged, by its one rule", () => {
    expect(panels).toContain("@Published var replyPin: SessionRow.ID?");
    expect(panels).toContain("var session: SessionRow? { ConversationFogHost.session(store?.state, staged: heldSession) }");
    // One name for the panel's session, and the canvas asks it too: a pinned reply line and the canvas's Send never disagree.
    expect(panels).toContain("var heldSession: SessionRow.ID? { staged ?? replyPin }");
    for (const file of ["Canvas.swift", "CanvasSend.swift", "CanvasShow.swift"]) {
      const source = readFileSync(join(import.meta.dir, "..", "mac-app", "conch-mac", file), "utf8");
      expect(source, file).not.toContain("FloatingPanels.installed?.staged");
      expect(source, file).toContain("panel: FloatingPanels.installed?.heldSession");
    }
    expect(panels).toContain("let row = Self.session(store.state, staged: panels.heldSession)");
    expect(panels).toContain("switcherSelection = ConversationFogHost.session(store?.state, staged: heldSession)?.id");
    // The floating composer is the panel's session, so it keeps to the pin too.
    expect(member(dock, "func floatingRow(_ state: PublishedState?) -> SessionRow? {")).toContain("guard let row = panels?.session, row.parentSessionId == nil");
  });

  test("writing takes hold: a draft begun in the reply line, marks or not, or one carried out of the window as its reply line", () => {
    const claim = member(dock, "func claim(_ row: SessionRow) {");
    // Before the canvas's guard, which only staging needs.
    before(claim, "pinReply(writing: true)", "CanvasController.shared.document?.has(.you) != true");
    expect(member(dock, "private func move(to next: ComposerPlace) {")).toContain(
      "pinReply(writing: from == .window && rows.leaving != nil && rows.leaving?.id == rows.landing?.id)",
    );
    // The floating composer claims on its first character or file (onDraftStarted).
    expect(dock).toContain("onDraftStarted: { dock.claim(row) },");
  });

  test("the pin is looked at whenever a draft, the keyboard, the place or the staging changes", () => {
    expect(dock).toContain("ComposerDraftStore.shared.objectWillChange\n            .receive(on: RunLoop.main)\n            .sink { [weak self] _ in MainActor.assumeIsolated { self?.pinReply() } }");
    expect(dock).toContain("self?.layout.objectWillChange.send()\n                        self?.pinReply()");
    const changed = member(dock, "private func windowChanged(_ note: Notification) {");
    expect(changed).toContain("NSWindow.didResignKeyNotification");
    before(changed, "if window === floating {", "            pinReply()\n            return");
    expect(dock).toContain("NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,");
    before(member(dock, "private func move(to next: ComposerPlace) {"), "place = next", "pinReply(writing:");
    expect(member(dock, "private func arrived(at arrival: ComposerPlace) {")).toContain("pinReply()");
    before(member(dock, "private func key(_ event: NSEvent) -> Bool {"), "floating.makeFirstResponder(nil)", "pinReply()");
  });
});

describe("2: Return respects a send in flight, as the button does", () => {
  test("send asks the button's whole gate first", () => {
    const send = member(composer, "private func send() {");
    expect(send).toMatch(/^private func send\(\) \{\n(\s*\/\/[^\n]*\n)*\s*guard canSend else \{ return \}/);
    before(send, "guard canSend else { return }", "ComposerDraftStore.shared.setSending(session, true)");
    expect(member(composer, "private var canSend: Bool {")).toContain("!composed.isEmpty && !isSending && messageUnavailableReason == nil");
    // Return goes through it: the editor's Return is the composer's `send`, and nothing else.
    expect(composer).toContain("ComposerEditor(text: $draft, isFocused: $fieldFocused, identity: sessionID, onSend: send)");
    const editor = read("mac-app/conch-mac/ComposerEditor.swift");
    const keys = member(editor, "func textView(_ view: NSTextView, doCommandBy selector: Selector) -> Bool {", 8);
    expect(keys).toMatch(/case \.send:\n\s*parent\.onSend\(\)/);
    expect(editor.match(/onSend\(\)/g) ?? []).toHaveLength(1);
  });
});

describe("6: conch steering the screen for a send holds the input where it is", () => {
  test("a send begins a hold at the press, when it will steer, and lets it go if it never went", () => {
    const send = member(store, "func send(_ event: ConchDaemonEvent, overApp: Bool = false) -> Task<Bool, Never> {");
    before(send, "let refocus = event.awaitDelivery == true && NSApp.isActive", "let steer = refocus ? ComposerDock.shared.beginSteering() : nil");
    before(send, "let steer = refocus ? ComposerDock.shared.beginSteering() : nil", "let task = Task {");
    expect(send).toContain("whenDelivered = { await StateStore.refocusAfterDelivery(releasing: steer) }");
    expect(send).toContain("guard !Task.isCancelled else {\n                if let steer { ComposerDock.shared.endSteering(steer) }\n                return false\n            }");
    before(send, "let delivered = await socketClient.send(", "if !delivered, let steer { ComposerDock.shared.endSteering(steer) }");
  });

  test("delivered, the hold ends when conch has the front back, or at once when it does not take it", () => {
    const refocus = member(store, "private static func refocusAfterDelivery(releasing steer: ComposerSteering.ID) {");
    expect(refocus).toContain("return ComposerDock.shared.steered(steer, refocusing: false)");
    // Told before asking, so conch coming forward always finds the hold waiting for it.
    before(refocus, "ComposerDock.shared.steered(steer, refocusing: true)", "NSApp.activate(ignoringOtherApps: true)");
  });

  test("the session commands that type hold it the same way, and let go when nothing will be typed", () => {
    const helper = member(store, "private static func refocusWhenDelivered() -> SteeredDelivery? {");
    before(helper, "guard NSApp.isActive else { return nil }", "let steer = ComposerDock.shared.beginSteering()");
    const settled = member(store, "func settled(by outcome: ConchSocketRequestOutcome) {", 8);
    expect(settled).toContain("case .acknowledgement? = try? JSONDecoder().decode(ConchSessionCommandReply.self, from: data) { return }");
    expect(settled).toContain("ComposerDock.shared.endSteering(steer)");
    const enqueue = member(store, "private func enqueueSessionCommand(");
    expect(enqueue).toContain("steered?.settled(by: .connectFailed)");
    before(enqueue, "let outcome = await socketClient.request(request, whenDelivered: steered?.whenDelivered)", "steered?.settled(by: outcome)");
    const setModel = member(store, "func setModel(id: SessionRow.ID, model: String) async -> String {");
    before(setModel, "let outcome = await socketClient.request(request, whenDelivered: steered?.whenDelivered)", "steered?.settled(by: outcome)");
  });

  test("the placement rule sees the hold, and conch back in front or Tyler's own doing ends it", () => {
    const situation = member(dock, "private var situation: ComposerSituation {");
    expect(situation).toContain("|| steering.held(at: ProcessInfo.processInfo.systemUptime)");
    expect(dock).toContain("if note.name == NSApplication.didBecomeActiveNotification { self?.steering.landed() }");
    before(dock, "self?.steering.landed() }", "                    self?.update()\n                }\n            })");
    expect(dock).toContain("if note.name == NSApplication.willHideNotification {\n                        self?.hiding = true\n                        self?.steering.endAll()");
    expect(dock).toContain("guard let self, let app, app != .current, app.bundleIdentifier != ComposerSteering.terminal else { return }\n                self.steering.endAll()\n                self.update()");
    expect(member(dock, "private func windowChanged(_ note: Notification) {")).toContain("closing = window\n            // Tyler's own doing: no send conch is steering holds the input in a window that is going.\n            steering.endAll()");
    // However the hold ends, the input is looked at again then.
    expect(member(dock, "private func lookWhenSteeringEnds() {")).toContain("DispatchQueue.main.asyncAfter(deadline: .now() + (expiry - now) + 0.05) { [weak self] in self?.update() }");
    for (const signature of ["func beginSteering() -> ComposerSteering.ID {", "func steered(_ id: ComposerSteering.ID, refocusing: Bool) {"]) {
      expect(member(dock, signature)).toContain("lookWhenSteeringEnds()");
    }
    expect(member(dock, "func steered(_ id: ComposerSteering.ID, refocusing: Bool) {")).toContain("update()");
    expect(member(dock, "func endSteering(_ id: ComposerSteering.ID) {")).toContain("update()");
    expect(model).toContain('public static let terminal = "com.apple.Terminal"');
  });
});

describe("10: the panel's own keys never take the keyboard from the reply line", () => {
  test("⌘↩ full screen takes the keys for the panel; they come straight back to the field", () => {
    const key = member(dock, "private func key(_ event: NSEvent) -> Bool {");
    before(key, "let field = typing ? floating.firstResponder as? NSTextView : nil", "if panels?.replyKey(event) == true {");
    expect(key).toContain("if panels?.replyKey(event) == true {\n                keepKeys(field)\n                return true\n            }");
    const keep = member(dock, "private func keepKeys(_ field: NSTextView?) {");
    before(keep, "floating.makeKey()", "floating.makeFirstResponder(field)");
    expect(keep).not.toContain("NSApp.activate");
  });

  test("out of sight for a moment of conch's own making, the reply line keeps the keyboard rather than leaving the screen", () => {
    const move = member(dock, "private func move(to next: ComposerPlace) {");
    expect(move).toContain("if from.floats {\n            if next.floats, typing { veil() } else { hideFloating() }\n        }");
    expect(code(move)).not.toContain("floating.orderOut(nil)");
    const follow = member(dock, "func follow() {");
    expect(follow).toContain("if place.floats, typing { veil() } else if floating.isVisible { hideFloating() }");
    expect(code(follow)).not.toContain("floating.orderOut(nil)");
    // Shown again where it lands, touchable again.
    expect(follow).toContain("if !floating.isVisible || veiled {");
    before(follow, "if !floating.isVisible || veiled {", "floating.ignoresMouseEvents = false");
    const veil = member(dock, "private func veil() {");
    expect(veil).toContain("floating.ignoresMouseEvents = true");
    expect(veil).toContain("floating.alphaValue = 0");
    expect(veil).not.toContain("orderOut");
  });
});

describe("11: the keyboard goes home only if the reply line still had it", () => {
  test("given to another app's window, the reply line's keyboard is not taken back into conch's window later", () => {
    const changed = member(dock, "private func windowChanged(_ note: Notification) {");
    const resign = changed.slice(changed.indexOf("case NSWindow.didResignKeyNotification:"));
    expect(resign).toContain("DispatchQueue.main.async { [weak self] in\n                    guard let self, !NSApp.isActive, !self.floating.isKeyWindow else { return }\n                    self.wantsFocus = false");
    // Clicked into, it still wants it.
    expect(changed).toContain("case NSWindow.didBecomeKeyNotification:\n                // Clicked into: its field has the keyboard, and takes it home with it.\n                wantsFocus = true");
  });
});

describe("12 and 13: the swoop shows the composer that lands, and the caret stays with its own draft", () => {
  test("the leaving picture is the composer where it was; the arriving one, the composer that lands", () => {
    const move = member(dock, "private func move(to next: ComposerPlace) {");
    expect(move).toContain("let rows = carry(from: from, to: next)");
    expect(move).toContain("landing = rows.landing?.id");
    expect(move).toContain("face(of: rows.leaving, width: source?.rect.width, dark: dark)");
    expect(move).toContain("face(of: rows.landing, width: target?.rect.width, dark: dark)");
    const carry = member(dock, "private func carry(from: ComposerPlace, to: ComposerPlace) -> (leaving: SessionRow?, landing: SessionRow?) {");
    expect(carry).toContain("let leaving = from == .window ? store.state?.row(windowAddress.session) : floatingRow(store.state)");
    // Out of the window it lands as the panel's composer, after any staging.
    before(carry, "panels.staged = picked", "return (leaving ?? floatingRow(store.state), floatingRow(store.state))");
    // Back into the window it lands as the session the window is switched to.
    expect(carry).toContain("lands = store.state?.row(session.id) ?? session");
    expect(carry).toContain("return (leaving, lands)");
  });

  test("the caret is read only where the input had landed, and put only onto that session's draft", () => {
    const carry = member(dock, "private func carry(from: ComposerPlace, to: ComposerPlace) -> (leaving: SessionRow?, landing: SessionRow?) {");
    expect(carry).toContain("if shown, let field = field(at: from) {\n            caret = (field.selectedRange(), leaving?.id)");
    expect(carry.match(/caret = /g)?.length).toBe(1);
    const arrived = member(dock, "private func arrived(at arrival: ComposerPlace) {");
    expect(arrived).toContain("if let caret, caret.session == landing, let field, NSMaxRange(caret.range) <= (field.string as NSString).length {");
  });
});

describe("14: no stray swoop at launch", () => {
  // The stall half of 14 measured small (2.5 ms a picture for a 20 MB 5K attachment, 0.7 ms for the window list), so the
  // picture drawing is unchanged. The launch half: the dock installs from a Task begun in App.init, before the window
  // registers (a turn after its view is made), so the first look found no window and sent the input to the reply line.
  test("no stray swoop at launch: the input waits in the window for the window to be registered", () => {
    const install = member(dock, "func install(store: StateStore) {");
    const hold = install.indexOf("holdUntil = ProcessInfo.processInfo.systemUptime + Self.launchGrace");
    expect(hold).toBeGreaterThan(-1);
    // Before the first look at where the input goes, which is the last thing install does.
    expect(install.trimEnd().endsWith("\n        update()")).toBe(true);
    expect(hold).toBeLessThan(install.lastIndexOf("update()"));
    expect(install).toContain("DispatchQueue.main.asyncAfter(deadline: .now() + Self.launchGrace + 0.05) { [weak self] in self?.update() }");
    expect(dock).toContain("private static let launchGrace: TimeInterval = 1");
  });
});
