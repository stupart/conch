import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The canvas's quality pass (2026-09-26), driven live on Tyler's screen: a Send without Screen Recording went quietly as
// the marks alone, Show's word about it was on a pill it had just hidden, the glass covered the docked panel, the pill sat
// on the Dock and on the Ready pill, and a Send said nothing either way. The pure rules are ConchDesign's
// (CanvasPillTests); these pin the AppKit wiring that can't run headless.

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

/** `first` and `then` are both in `source`, in that order. */
function inOrder(source: string, first: string, then: string): void {
  expect(source, `missing: ${first}`).toContain(first);
  expect(source, `missing: ${then}`).toContain(then);
  expect(source.indexOf(first)).toBeLessThan(source.indexOf(then));
}

const canvas = read("mac-app/conch-mac/Canvas.swift");
const send = read("mac-app/conch-mac/CanvasSend.swift");
const show = read("mac-app/conch-mac/CanvasShow.swift");
const agentInk = read("mac-app/conch-mac/AgentInkController.swift");
const panels = read("mac-app/conch-mac/FloatingPanels.swift");
const pill = read("design/ConchDesign/Sources/ConchDesign/CanvasToolPill.swift");
const storyboard = read("design/ConchDesign/Sources/ConchDesign/CanvasShow.swift");
const sendBody = member(send, "    func send(marksOnly: Bool = false) {");

describe("never sent, or recorded, without saying so", () => {
  test("without Screen Recording a Send stops and asks, before anything is captured; the marks alone only on Tyler's word", () => {
    inOrder(sendBody, "guard marksOnly || CanvasCapture.granted() else {", "CanvasCapture.still(");
    const ask = sendBody.slice(sendBody.indexOf("guard marksOnly || CanvasCapture.granted() else {"), sendBody.indexOf("let row = route.row"));
    // The pen comes up for the system's own prompt; the pill asks, and nothing is sent.
    inOrder(ask, "lift()", "return say(settingsOpened ? .reopen(marks: true) : .noScreen(marks: true))");
    expect(ask).not.toContain("store.send");
    expect(sendBody).toContain("let screen = marksOnly ? nil : await CanvasCapture.still(of: document.anchor.id, leavingOut: conch)");
  });

  test("Open Settings goes to Screen Recording, through the one door; Reopen is the store's relaunch", () => {
    expect(send).toContain('static let settings = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!');
    const act = member(send, "func act(_ action: CanvasToolPill.Notice.Action) {");
    inOrder(act, "case .openSettings:\n            settingsOpened = true", "store?.openLink(CanvasCapture.settings.absoluteString, cwd: nil, rowId: nil)");
    expect(act).toContain("case .reopen:\n            CanvasCapture.reopen(store) { [weak self] in self?.say(.reopenFailed) }");
    expect(act).toContain("store?.openLink(revealing.path, cwd: nil, rowId: nil, reveal: true)");
    expect(member(send, "static func reopen(_ store: StateStore?, failed: @escaping @MainActor () -> Void) {")).toContain("store.relaunchForNewBuild()");
  });

  test("the pill stays up for as long as it says anything, and is placed before it shows", () => {
    const apply = member(canvas, "func apply() {");
    expect(apply).toContain("let showsPill = pillMode != .hidden");
    inOrder(apply, "placePill()\n            pill.orderFrontRegardless()", "if pillMode == .hidden { pill.orderOut(nil) }");
    // The glass is the ink's: it goes when nothing is in use, whatever the pill says.
    expect(apply).toContain("if !self.inUse { for (panel, _) in glass { panel.orderOut(nil) } }");
    expect(canvas).toContain("mode: canvas.pillMode,");
  });

  test("a Send says where it went, once the daemon has it, and why not if it didn't land, the ink back", () => {
    // Taken before the ink goes; never taken, the ink stays and the pill says so.
    inOrder(sendBody, "let taken = await delivery.value", "clear()");
    inOrder(sendBody, "guard taken else {\n                apply()\n                return say(.notSent(to: row.label, sentence: nil))\n            }", "clear()");
    inOrder(sendBody, "say(.sent(to: row.label), lasting: CanvasToolPill.Notice.sentFor)", "await Self.failure(of: event.opId, in: store)");
    inOrder(sendBody, "let back = restore(document)", 'say(.notSent(to: row.label, sentence: failure, kept: back ? "Your marks are still here." : "The picture is kept."))');
    // Taken is not landed: the daemon's outcome comes back against the send's own id.
    const failure = member(send, "static func failure(of opId: String?, in store: StateStore) async -> String? {");
    expect(failure).toContain("store.outbox.entries.first(where: { $0.id == opId })");
    expect(failure).toContain("if case let .failed(sentence) = entry.state { return sentence }");
    const say = member(canvas, "func say(_ notice: CanvasToolPill.Notice?, lasting: Duration? = nil) {");
    expect(say).toContain("guard let self, self.notice == notice else { return }");
  });

  test("a guess isn't sent to: Send asks where, and a pick from its name only changes where", () => {
    inOrder(sendBody, "guard route.sure else {\n            routeMenu = .sendTo\n            return\n        }", "CanvasCapture.granted()");
    const choose = member(canvas, "func choose(_ id: SessionRow.ID) {");
    expect(choose).toContain("let sends = routeMenu == .sendTo");
    expect(choose).toContain("picked = id");
    expect(choose).not.toContain("clear()");
    expect(member(canvas, "    func clear() {")).toContain("picked = nil");
    expect(canvas).toContain("let route = CanvasController.route(store.state, panel: FloatingPanels.installed?.staged, picked: canvas.picked)");
  });

  test("no system error's words, and no path, in anything the pill says", () => {
    for (const [name, source] of [["Canvas.swift", canvas], ["CanvasSend.swift", send], ["CanvasShow.swift", show]] as const) {
      for (const line of source.split("\n").filter((line) => /\bsay\(|notice = |Notice\(/.test(line))) {
        expect(line, name).not.toContain("localizedDescription");
        expect(line, name).not.toMatch(/\.path\b/);
      }
      expect(source, name).not.toMatch(/message = "/);
    }
    expect(member(show, "fileprivate func ended(_ error: Error?) {")).toContain("CanvasController.shared.say(.stoppedByMacOS(at: length))");
    const sendShow = member(show, "    func sendShow(_ recorder: CanvasRecorder) {");
    inOrder(sendShow, "revealing = recorder.folder\n                return say(.noFrames)", 'say(.notSent(to: row.label, sentence: failure, kept: "The recording is kept."))');
    inOrder(sendShow, "say(.sent(to: row.label), lasting: CanvasToolPill.Notice.sentFor)", "await Self.failure(of: event.opId, in: store)");
  });
});

describe("the pen down doesn't cover the docked panel", () => {
  test("docked, the panel rises over the glass while the pen is down; full screen it stays under, as what is marked up", () => {
    const over = member(panels, "func overGlass(_ over: Bool) {");
    expect(over).toContain("over && !isFullScreen ? NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1) : .floating");
    expect(over).toContain("if fog.level != level { fog.level = level }");
    // The glass is at the status bar: the panel goes one over it, level with the pill.
    expect(member(canvas, "private func buildGlass() {")).toContain("panel.level = .statusBar");
    expect(member(canvas, "func apply() {")).toContain("FloatingPanels.installed?.overGlass(armed)");
    // Full screen coming or going with the pen down.
    expect(member(canvas, "func install(store: StateStore) {")).toContain("panels.overGlass(self.armed)");
    // The one hook: nothing else in the canvas changes the panel's level.
    expect(panels.match(/fog\.level = /g)?.length).toBe(1);
  });

  test("Done lifts the pen, and a click with any tool draws nothing", () => {
    expect(canvas).toContain("onDone: canvas.armed ? { canvas.lift() } : nil,");
    expect(pill).toContain('Text("Done")');
    const up = member(canvas, "override func mouseUp(with event: NSEvent) {");
    expect(up).toContain("if mark.drew(in: bounds.size) { controller?.commit(mark, on: self) }");
    expect(up).not.toContain("mark.kind == .pen || mark.kind == .highlight ||");
  });
});

describe("where the pill goes", () => {
  test("only placePill sizes and places it, from CanvasPillPlacement, inside the visible frame and off the control bar", () => {
    expect(member(canvas, "func install(store: StateStore) {")).toContain("host.sizingOptions = []");
    const place = member(canvas, "private func placePill(size: CGSize? = nil) {");
    expect(place).toContain("let spot = CanvasPillPlacement.spot(size: pillSize, visible: screen.visibleFrame, panel: panel, controlBar: Self.controlBar(panels))");
    expect(place).toContain("panel = .docked(docked)");
    expect(place).toContain("panel = .fullScreen(headerBottom: Self.headerBottom(of: covering.frame, panels: panels))");
    // A window wider than the pill, centred on it, so its width springs from its middle.
    expect(place).toContain("let width = max(CanvasPillHost.slot, pillSize.width)");
    expect(place).toContain("NSRect(x: spot.frame.midX - width / 2 - margin");
    expect(pill).toContain("value: Width(discard: onDiscard != nil, done: onDone != nil, route: route, recording: recording, sending: sending))");
  });

  test("the control bar's glass is its window less the room ControlBarHost pads it with", () => {
    const host = panels.slice(panels.indexOf("private struct ControlBarHost: View {"), panels.indexOf("private struct ControlBarSize"));
    expect(host).toContain(".padding(.top, ConchSpace.x3)");
    expect(host).toContain(".padding(.horizontal, ConchSpace.x6)");
    expect(host).toContain(".padding(.bottom, ConchSpace.x10)");
    expect(member(canvas, "private static func controlBar(_ panels: FloatingPanels?) -> CGRect? {")).toContain(
      "CGRect(x: frame.minX + ConchSpace.x6, y: frame.minY + ConchSpace.x10, width: frame.width - 2 * ConchSpace.x6, height: frame.height - ConchSpace.x3 - ConchSpace.x10)",
    );
  });
});

describe("Show", () => {
  test("the words on its controls: the × clears or deletes, the stop says what comes next, the mic says Voice off", () => {
    expect(pill).toContain('"Delete the recording (nothing is sent)" : "Clear marks (nothing is sent)"');
    expect(storyboard).toContain('.help(on ? "Stop recording (Send to send it, × to delete it)" : "Show: record the screen, ink and all (⇧R)")');
    expect(storyboard).toContain('"Voice off: Show records the screen alone. Click to record your voice too"');
    expect(storyboard).toContain(".foregroundStyle(CanvasStoryboard.redText)");
  });
});

describe("contrast", () => {
  test("words on the ink, the agent's name and the label's hairline come from measured tokens", () => {
    expect(canvas).toContain("label.foregroundColor = CanvasInk.on(mark.author).cgColor");
    expect(canvas).not.toContain("label.foregroundColor = NSColor.white.cgColor");
    expect(canvas).toContain("bubble.layer?.borderColor = Self.line(for: effectiveAppearance)");
    expect(canvas).not.toContain("NSColor.black.withAlphaComponent(0.14)");
    expect(member(canvas, "override func viewDidChangeEffectiveAppearance() {")).toContain("bubble.layer?.borderColor = Self.line(for: effectiveAppearance)");
    expect(canvas).toContain('let words = NSMutableAttributedString(string: "\\(name) · ", attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: Self.agentText])');
    expect(pill).toContain(".foregroundStyle(CanvasInk.onYou.color)");
    expect(pill).not.toContain("ConchColor.onVoice");
  });
});

describe("motion", () => {
  test("the canvas's durations are ConchMotion's", () => {
    for (const [name, source] of [["Canvas.swift", canvas], ["CanvasShow.swift", show]] as const) {
      expect(source.match(/duration = 0\.\d/g) ?? [], name).toEqual([]);
      expect(source.match(/perceptualDuration: 0\.\d/g) ?? [], name).toEqual([]);
    }
  });

  test("an agent's mark draws on once a launch: coming back to a review shows it as it was", () => {
    const view = member(canvas, 'func show(_ document: CanvasDocument?, armed: Bool, agentHidden: Bool = false, agentName: String = "Claude") {');
    expect(view).toContain("let fresh = mark.author == .agent && controller?.drawsOn(mark.id) == true");
    expect(canvas).not.toContain("drawnBefore");
    expect(member(canvas, "func drawsOn(_ id: CanvasMark.ID) -> Bool {")).toContain("agentMemory.drawsOn(id)");
    expect(canvas).toContain("private var agentMemory = AgentInkMemory()");
  });
});

describe("an agent's marks", () => {
  test("alone, a chip that clears them; Esc clears them only where they are drawn, with the keyboard there", () => {
    expect(canvas).toContain("onClearAgent: { AgentInkController.shared.dismiss() }");
    const escaped = member(agentInk, "private func escaped(in window: NSWindow?) {");
    expect(escaped).toContain("guard let shown, let focus = window?.firstResponder as? NSView,");
    expect(escaped).toContain("guard surface.item.id == shown.id, let view = surface.view, view.window === window else { return false }");
    expect(escaped).toContain("return focus === view || focus.isDescendant(of: view)");
    inOrder(escaped, "else { return }", "dismiss()");
  });

  test("marks that can't be placed are counted on the chip, not only logged; ones scrolled away aren't", () => {
    expect(agentInk).toContain("CanvasController.shared.setAgentMissed(placement == nil ? nil : AgentInk.Missed(missed))");
    const place = member(agentInk, "private func place(_ item: ReviewItem) async -> (Placement?, [(kind: String, label: String?)]) {");
    expect(place).toContain('miss(agent, "names part of a page conch isn\'t showing")');
    expect(place).toContain('miss(agent, "is on an image conch isn\'t showing")');
    // Out of sight is not missing: only a page asked, on the review's own link, that hasn't got it.
    expect(place).toContain("if asked, !page.isLoading, item.link.map({ Self.showsReview(page.url, link: $0) }) == true { missed.append((agent.kind.rawValue, agent.label)) }");
    expect(canvas).toContain("missed: canvas.agentMissed,");
  });
});

test("the canvas files are the Mac app's own: none of this reaches into another file but the one panel hook", () => {
  const macSources = readdirSync(join(root, "mac-app/conch-mac")).filter((name) => name.endsWith(".swift"));
  const callers = macSources.filter((name) => read(`mac-app/conch-mac/${name}`).includes("overGlass(")).sort();
  expect(callers).toEqual(["Canvas.swift", "FloatingPanels.swift"]);
});
