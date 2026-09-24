import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The canvas (wave 2): clear glass over whatever is on screen that Tyler draws on, and sends as one picture. These pin
// the window mechanics that can't be run headless — levels, click-through, keys, the hotkey — and the rules that keep it
// from ever acting on its own.

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

const canvas = read("mac-app/conch-mac/Canvas.swift");
const agentInk = read("mac-app/conch-mac/AgentInkController.swift");
const placing = read("design/ConchDesign/Sources/ConchDesign/AgentInk.swift");
const review = read("mac-app/conch-mac/ReviewView.swift");
const webView = read("mac-app/conch-mac/WebView.swift");
const send = read("mac-app/conch-mac/CanvasSend.swift");
const ink = read("design/ConchDesign/Sources/ConchDesign/Canvas.swift");
const models = read("mac-app/conch-mac/Models.swift");
const store = read("mac-app/conch-mac/StateStore.swift");
/** Every Swift file in the Mac app, by name. */
const macSources = Object.fromEntries(
  readdirSync(join(root, "mac-app/conch-mac"))
    .filter((name) => name.endsWith(".swift"))
    .map((name) => [name, read(`mac-app/conch-mac/${name}`)]),
);
/** The Mac files that mention `needle`. */
const filesWith = (needle: string): string[] => Object.keys(macSources).filter((name) => macSources[name]!.includes(needle)).sort();
const panels = read("mac-app/conch-mac/FloatingPanels.swift");
const item = read("mac-app/conch-mac/StatusItem.swift");
const components = read("design/ConchDesign/Sources/ConchDesign/Components.swift");
const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");

describe("the glass", () => {
  test("one borderless, non-activating panel per display, at the status bar level, on every space and hidden by Mission Control", () => {
    const build = member(canvas, "private func buildGlass() {");
    expect(build).toContain("glass = NSScreen.screens.compactMap { screen in");
    expect(build).toContain(
      "let panel = FloatingPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)",
    );
    // Above the Dock and the menu bar, below menus and system alerts; `.floating` sat under both and tied other apps'.
    expect(build).toContain("panel.level = .statusBar");
    expect(build).toContain("panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .transient]");
    expect(canvas).not.toMatch(/collectionBehavior = \[[^\]]*\.stationary/);
    for (const clear of ["panel.backgroundColor = .clear", "panel.isOpaque = false", "panel.hasShadow = false", "panel.hidesOnDeactivate = false"]) {
      expect(build).toContain(clear);
    }
    // Rebuilt when the displays change: with separate Spaces no window spans two.
    expect(canvas).toContain("forName: NSApplication.didChangeScreenParametersNotification");
    expect(canvas).toContain("MainActor.assumeIsolated { self?.buildGlass() }");
    expect(project).toContain("/* Canvas.swift in Sources */ = {isa = PBXBuildFile;");
    expect(project.match(/\/\* Canvas\.swift in Sources \*\/,/g)?.length).toBe(1);
  });

  test("it lets every click through unless the pen is down, and never while sending", () => {
    const build = member(canvas, "private func buildGlass() {");
    expect(build).toContain("panel.ignoresMouseEvents = true");
    const apply = member(canvas, "func apply() {");
    expect(apply).toContain("panel.ignoresMouseEvents = !armed || sending");
    // The only other writes to it: none. The window server hit-tests whole windows, so this one flag is the mechanism.
    expect(canvas.match(/ignoresMouseEvents = /g)?.length).toBe(2);
    // The pen down draws; up, a press does nothing even if one arrives.
    expect(member(canvas, "override func mouseDown(with event: NSEvent) {")).toContain("guard let controller, controller.armed else { return }");
  });

  test("armed, it takes the keys without bringing conch forward", () => {
    const arm = member(canvas, "func arm() {");
    expect(arm).toContain("under.panel.makeKey()");
    expect(arm).toContain("under.panel.makeFirstResponder(under.ink)");
    expect(member(canvas, "func apply() {")).toContain("panel.takesKeys = inUse");
    // `FloatingPanel` only becomes key while `takesKeys`; nothing here activates conch or makes a window main.
    expect(panels).toContain("override var canBecomeKey: Bool { takesKeys }");
    for (const intrusion of ["NSApp.activate", "makeKeyAndOrderFront", "makeMain", "activate(ignoringOtherApps"]) {
      expect(canvas).not.toContain(intrusion);
    }
  });

  test("Esc lifts the pen and keeps the ink; Esc again clears it", () => {
    expect(member(canvas, "override func keyDown(with event: NSEvent) {")).toContain("case UInt16(kVK_Escape):\n            controller?.escape()");
    expect(member(canvas, "func escape() {")).toContain("armed ? lift() : clear()");
    const lift = member(canvas, "func lift() {");
    expect(lift).toContain("armed = false");
    expect(lift).not.toContain("document = nil\n        apply");
    expect(lift).toContain("if document?.isEmpty == true { document = nil }");
    // ⌘Z takes the newest mark, unless a note's words are being typed.
    const undo = member(canvas, "override func performKeyEquivalent(with event: NSEvent) -> Bool {");
    expect(undo).toContain('event.charactersIgnoringModifiers == "z"');
    expect(undo).toContain("window?.firstResponder === self");
    expect(undo).toContain("controller?.undo()");
  });

  test("a new item in the panel starts a clear canvas: the old ink lifts away", () => {
    const install = member(canvas, "func install(store: StateStore) {");
    expect(install).toContain("panels.$staged.combineLatest(panels.queue.$lastStaged)");
    expect(install).toContain(".sink { [weak self] _ in MainActor.assumeIsolated { self?.clear() } }");
    const show = member(canvas, "func show(_ document: CanvasDocument?, armed: Bool, agentHidden: Bool = false, agentName: String = \"Claude\") {");
    expect(show).toContain("if document?.id != shown {\n            liftAway()");
    // Reduce Motion keeps the fade and drops the blur.
    const lift = member(canvas, "private func liftAway() {");
    expect(lift).toContain("CASpringAnimation(perceptualDuration: 0.32, bounce: 0)");
    expect(lift).toContain("if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, let blur = CIFilter(name: \"CIGaussianBlur\")");
  });

  test("live ink is one layer with no implicit animation; each finished mark its own layer from the one path builder", () => {
    const live = member(canvas, "private func drawLive() {");
    expect(live).toContain("CATransaction.setDisableActions(true)");
    expect(live).toContain("live.path = CanvasInk.shape(of: mark, in: bounds.size).ink");
    expect(member(canvas, "static func layer(for mark: CanvasMark, in size: CGSize) -> CALayer {")).toContain("let shape = CanvasInk.shape(of: mark, in: size)");
    // A mouse's pressure is flat: only a tablet's is kept, and the width comes from speed otherwise.
    expect(canvas).toContain("p: event.subtype == .tabletPoint ? round(Double(event.pressure), 1000) : nil");
    expect(canvas).toContain("NSEvent.isMouseCoalescingEnabled = false");
  });
});

describe("turning it on", () => {
  test("a Carbon hotkey, its chord in one place, needing no permission", () => {
    expect(canvas).toContain("static let key = UInt32(kVK_ANSI_P)");
    expect(canvas).toContain("static let modifiers = UInt32(controlKey | optionKey | cmdKey)");
    expect(canvas.match(/RegisterEventHotKey\(/g)?.length).toBe(1);
    expect(canvas).toContain("RegisterEventHotKey(key, modifiers,");
    expect(canvas).toContain("MainActor.assumeIsolated { CanvasController.shared.toggle() }");
    // A global monitor needs Accessibility and an event tap Input Monitoring: neither is used.
    for (const needsPermission of ["addGlobalMonitorForEvents", "CGEvent.tapCreate", "tapCreate("]) {
      expect(canvas).not.toContain(needsPermission);
    }
  });

  test("the panel's pen button, added without changing any caller that doesn't pass it", () => {
    const buttons = components.slice(components.indexOf("public struct FogPanelButtons: View {"), components.indexOf("// MARK: - FogHandle"));
    expect(buttons).toContain("onCanvas: (() -> Void)? = nil, isCanvasOn: Bool = false) {");
    expect(buttons).toContain("if let onCanvas {");
    expect(components).toContain("        onCanvas: (() -> Void)? = nil,\n        isCanvasOn: Bool = false\n    ) {");
    expect(panels).toContain("onCanvas: { canvas.toggle() },\n                    isCanvasOn: canvas.armed");
    expect(panels).toContain("@ObservedObject private var canvas = CanvasController.shared");
  });

  test("the menu's Canvas, showing the hotkey, and installed after the panels it follows", () => {
    const menu = member(item, "func menuNeedsUpdate(_ menu: NSMenu) {");
    expect(menu).toContain('entry("Canvas", #selector(toggleCanvas), checked: CanvasController.shared.armed, key: "p")');
    expect(menu).toContain("canvas.keyEquivalentModifierMask = [.control, .option, .command]");
    expect(item).toContain("@objc private func toggleCanvas() { CanvasController.shared.toggle() }");
    const install = member(item, "static func install(store: StateStore) {");
    expect(install.indexOf("FloatingPanels.install(store: store)")).toBeLessThan(install.indexOf("CanvasController.shared.install(store: store)"));
  });

  test("the tools are their own panel above the glass that always takes clicks", () => {
    const install = member(canvas, "func install(store: StateStore) {");
    expect(install).toContain("pill.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)");
    expect(install).toContain("pill.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .transient]");
    expect(install).toContain("pill.contentView = FirstClickHostingView(");
    expect(install).not.toContain("pill.ignoresMouseEvents");
    expect(canvas).toContain(
      "private let pill = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)",
    );
  });
});

describe("Send", () => {
  test("the still is ScreenCaptureKit's, of the display under the ink, with conch's floating windows left out", () => {
    const sendBody = member(send, "    func send() {");
    expect(sendBody).toContain("let conch = NSApp.windows.filter { $0 is FloatingPanel }.map(\\.windowNumber)");
    expect(sendBody).toContain("await CanvasCapture.still(of: document.anchor.id, leavingOut: conch)");
    const still = member(send, "static func still(of display: CGDirectDisplayID, leavingOut windows: [Int]) async -> CGImage? {");
    expect(still).toContain("guard let screen = content.displays.first(where: { $0.displayID == display }) else { return nil }");
    expect(still).toContain("let filter = SCContentFilter(display: screen, excludingWindows: content.windows.filter { windows.contains(Int($0.windowID)) })");
    // macOS 26's screenshot API where it exists, the macOS 14 one below it; never the cursor.
    expect(still).toContain("if #available(macOS 26.0, *) {");
    expect(still).toContain("try await SCScreenshotManager.captureScreenshot(contentFilter: filter, configuration: configuration).sdrImage");
    expect(still).toContain("try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)");
    expect(still.match(/configuration\.showsCursor = false/g)?.length).toBe(2);
    // Deprecated in 14 and gone in 15.
    expect(filesWith("CGWindowListCreateImage")).toEqual([]);
  });

  test("nothing is captured, or the grant asked for, except on an explicit Send with somewhere to send it", () => {
    for (const capture of ["SCScreenshotManager", "CanvasCapture.still("]) {
      expect(filesWith(capture), capture).toEqual(["CanvasSend.swift"]);
    }
    // Show is the other capture, on its own explicit press (canvas-show-source.test.ts).
    for (const capture of ["SCShareableContent", "CGRequestScreenCaptureAccess", "CGPreflightScreenCaptureAccess"]) {
      expect(filesWith(capture), capture).toEqual(["CanvasSend.swift", "CanvasShow.swift"]);
    }
    expect(send.match(/CanvasCapture\.still\(/g)?.length).toBe(1);
    const sendBody = member(send, "    func send() {");
    expect(sendBody).toContain("CanvasCapture.still(");
    // Nowhere to send it: nothing captured, and the pill says why.
    expect(sendBody.indexOf("guard let row = Self.route(state, panel: FloatingPanels.installed?.staged) else {")).toBeLessThan(sendBody.indexOf("CanvasCapture.still("));
    expect(sendBody).toContain('message = "Nothing to send this to: no session owns what is on screen, and the panel has none."\n            return\n        }');
    // Send is the pill's button and Return on the glass: nothing else calls it.
    const callers = Object.entries(macSources).flatMap(([name, source]) => (source.match(/(?:canvas|controller\?|CanvasController\.shared)\.send\(\)/g) ?? []).map((call) => `${name}: ${call}`));
    expect(callers.sort()).toEqual(["Canvas.swift: canvas.send()", "Canvas.swift: controller?.send()"]);
    expect(canvas).toContain("onSend: { canvas.send() }");
    expect(canvas).toContain("case UInt16(kVK_Return), UInt16(kVK_ANSI_KeypadEnter):\n            controller?.send()");
    // The grant: checked silently; asked for once, on a Send without it, and the Send still goes as the marks alone.
    const still = member(send, "static func still(of display: CGDirectDisplayID, leavingOut windows: [Int]) async -> CGImage? {");
    expect(still.indexOf("guard CGPreflightScreenCaptureAccess() else {")).toBeLessThan(still.indexOf("CGRequestScreenCaptureAccess()"));
    expect(still).toContain("if !asked {\n                asked = true\n                CGRequestScreenCaptureAccess()");
    expect(member(send, "static func write(_ document: CanvasDocument, screen: CGImage?) throws -> Files {")).toContain(
      'raw: try screen.map { try save(CanvasInk.png($0), "raw.png") },',
    );
  });

  test("it goes to the session that owns what is on screen when the screen context is sure, else the panel's", () => {
    expect(send).toContain("static let sureEnough = 0.8");
    const route = member(send, "static func route(_ state: PublishedState?, panel staged: SessionRow.ID?) -> SessionRow? {");
    expect(route).toContain("if let showing = state?.showing, showing.confidence >= sureEnough, let owner = state?.row(showing.sessionId) {\n            return owner");
    expect(route).toContain("return state?.row(WorkspaceFocus.viewed(in: Workspace(state), pinned: staged))");
    expect(route.indexOf("showing.confidence")).toBeLessThan(route.indexOf("WorkspaceFocus.viewed"));
    // `showing` reaches the app, and survives the store's rebuild.
    expect(models).toContain("showing = try? container.decodeIfPresent(Showing.self, forKey: .showing)");
    expect(models).toContain("&& showing == other.showing");
    expect(store).toContain("showing: sourceState.showing");
    // The canvas only reads the screen context; it never observes the screen itself.
    for (const observing of ["reportShowing", "screen-observation", "ConchScreenObservationReport"]) {
      expect(canvas + send).not.toContain(observing);
    }
  });

  test("one message through the composer's path: the picture's path on its own line, what it is, the notes, the rest", () => {
    const text = member(ink, "public static func text(for document: CanvasDocument, about label: String, picture: String, clean: String?, marks: String) -> String {");
    expect(text).toContain('var lines = [picture, "[canvas] Tyler marked up \\(label)."]');
    expect(text).toContain("lines += notes(document)");
    expect(text).toContain('lines.append("Clean screen + marks: \\(clean), \\(marks)")');
    expect(text).toContain('return lines.joined(separator: "\\n")');
    expect(ink).toContain('return "\\(number). \\(place(document.target(of: note) ?? note)): \\"\\(words)\\""');
    const sendBody = member(send, "    func send() {");
    expect(sendBody).toContain("CanvasPrompt.text(for: document, about: label, picture: files.flat.path, clean: files.raw?.path, marks: files.json.path)");
    // The composer's own delivery (DashboardView's onSend), then a clear canvas.
    expect(sendBody).toContain("let delivery = store.send(.inject(sessionId: row.id, label: row.label, text: prompt))");
    expect(sendBody.indexOf("store.send(.inject(")).toBeLessThan(sendBody.indexOf("clear()"));
    expect(read("mac-app/conch-mac/DashboardView.swift")).toContain("store.send(.inject(sessionId: row.id, label: row.label, text: text))");
  });

  test("kept in conch's cache for Tyler alone, the flat picture no longer than 1568 px", () => {
    expect(send).toContain('appendingPathComponent(".cache/conch/canvas", isDirectory: true)');
    const write = member(send, "static func write(_ document: CanvasDocument, screen: CGImage?) throws -> Files {");
    expect(write.match(/\.posixPermissions: 0o700/g)?.length).toBe(3);
    expect(write).toContain("files.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600])");
    expect(write).toContain('flat: try save(CanvasInk.render(document, over: screen).flatMap(CanvasInk.png), "flat.png"),');
    expect(write).toContain('json: try save(try encoder.encode(document), "canvas.json")');
    expect(ink).toContain("public static func render(_ document: CanvasDocument, over screen: CGImage?, longEdge: CGFloat = 1568) -> CGImage? {");
    expect(project).toContain("/* CanvasSend.swift in Sources */ = {isa = PBXBuildFile;");
    expect(project.match(/\/\* CanvasSend\.swift in Sources \*\/,/g)?.length).toBe(1);
  });
});

/**
 * Agent ink: the marks an agent published with a review, drawn over it where Tyler is looking, in the one canvas document.
 * Tyler: "transparent canvas that both the ai and the user can write to over top of what they're looking at".
 */
describe("agent ink", () => {
  test("the script that finds a selector or a quote only reads the page", () => {
    // One script, in the shared package, for the Mac and the phone alike.
    expect(agentInk).toContain("static let finder = AgentInk.finder");
    const finder = placing.slice(placing.indexOf("public static let finder = \"\"\""), placing.indexOf("\"\"\"\n", placing.indexOf("public static let finder = \"\"\"") + 30));
    expect(finder.length).toBeGreaterThan(400);
    // Nothing that changes the DOM, styles, the selection, the scroll, or leaves anything behind.
    for (const writes of [
      "appendChild", "insertBefore", "removeChild", ".remove(", "replaceWith", "innerHTML", "outerHTML", "insertAdjacent",
      "setAttribute", "removeAttribute", "classList", ".style", "textContent =", ".data =", "document.write",
      "getSelection", "addRange", "window.find", "execCommand", "scrollTo", "scrollBy", "scrollIntoView", "focus(",
      "click(", "dispatchEvent", "addEventListener", "localStorage", "fetch(",
    ]) {
      expect(finder, writes).not.toContain(writes);
    }
    // The one global it reads, and only these reads.
    expect(finder.match(/window\.[a-zA-Z]+/g)?.sort()).toEqual(["window.innerWidth", "window.visualViewport"]);
    expect(finder).toContain("document.querySelector(what)");
    expect(finder).toContain("const range = document.createRange();");
    // Nothing is spliced into the source: the strings go as arguments, and it runs in conch's own world, not the page's.
    expect(finder).not.toContain("\\(");
    expect(agentInk).toContain('page.callAsyncJavaScript(finder, arguments: ["marks": asked], in: nil, contentWorld: .defaultClient)');
    expect(agentInk).not.toContain("evaluateJavaScript");
    expect(agentInk).not.toContain("contentWorld: .page");
    // Only on the review's own page, not one browsed to since.
    expect(member(agentInk, "private static func find(_ marks: [AgentMark], in page: WKWebView, link: String?) async -> [String: Found] {")).toContain(
      "guard let link, Self.showsReview(page.url, link: link), !page.isLoading else { return [:] }",
    );
  });

  test("showing an agent's marks never puts the pen down or takes the pointer or the keys", () => {
    for (const intrusion of ["arm(", "makeKey", "makeFirstResponder", "ignoresMouseEvents", "takesKeys", "NSApp.activate", "orderFront"]) {
      expect(agentInk, intrusion).not.toContain(intrusion);
    }
    for (const signature of [
      "func showAgent(_ marks: [CanvasMark], on display: CGDirectDisplayID, frame: CGRect, by name: String) {",
      "func hideAgent(_ hidden: Bool) {",
      "func clearAgent() {",
    ]) {
      const body = member(canvas, signature);
      for (const intrusion of ["armed = ", "arm()", "makeKey", "ignoresMouseEvents", "takesKeys"]) expect(body, `${signature} ${intrusion}`).not.toContain(intrusion);
      expect(body).toContain("apply()");
    }
    // Click-through is still the pen's alone.
    expect(member(canvas, "func apply() {")).toContain("panel.ignoresMouseEvents = !armed || sending");
    // Esc in conch clears them, seen by a local monitor that passes the key on; never a global one (Accessibility).
    expect(agentInk).toContain("escape = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in");
    expect(agentInk).not.toContain("addGlobalMonitorForEvents");
    expect(agentInk).toContain("MainActor.assumeIsolated { AgentInkController.shared.dismiss() }\n            }\n            return event");
  });

  test("a mark is drawn only where conch found it: never at a guessed position", () => {
    const place = member(agentInk, "private func place(_ item: ReviewItem) async -> Placement? {");
    // A selector or a quote only in conch's own page of this review, where the script found it, and in sight.
    expect(place).toContain("guard let page, let client = found[agent.id] else { continue }");
    expect(place).toContain("Self.visible(NSPoint(x: display.frame.minX + rect.midX * display.frame.width, y: display.frame.maxY - rect.midY * display.frame.height), in: page)");
    // An image only while conch shows it; a canvas only on its own display.
    expect(place).toContain("guard let view = surfaces.first(where: { $0.item.id == item.id && $0.image.map(Self.same(path)) == true })?.view,");
    expect(place).toContain("guard let anchor = anchor(of: canvas), let display = NSScreen.screens.first(where: { $0.displayID == anchor.id }) else {");
    // A mark without the geometry its kind takes is skipped and said so.
    expect(place).toContain('guard let mark else { return NSLog("conch: agent mark %@ has no geometry to draw; skipped", agent.id) }');
    // And the pure placement refuses rather than guesses (`AgentInkTests`).
    expect(placing).toContain("guard let at, let to else { return nil }");
    expect(placing).toContain("guard size.width > 0, size.height > 0, element.width > 0, element.height > 0 else { return nil }");
    // Visible means under nothing: the window there, below the glass, is the page's own.
    expect(member(agentInk, "private static func visible(_ point: NSPoint, in view: NSView) -> Bool {")).toContain(
      "return NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: glass) == window.windowNumber",
    );
    // The agent's kinds are the daemon's, one for one.
    const kinds = (source: string) => source.match(/case arrow, box, ellipse, highlight, text, pin, stroke\n/g)?.length;
    expect(kinds(placing)).toBe(1);
    expect(kinds(read("mac-app/conch-mac/Models.swift"))).toBe(1);
  });

  test("a canvas id is conch's own: the prompt gives it in the frame an agent passes back, and only a UUID names a folder", () => {
    const text = member(ink, "public static func text(for document: CanvasDocument, about label: String, picture: String, clean: String?, marks: String) -> String {");
    expect(text).toContain("lines.append(answer(document))");
    expect(text.indexOf("lines.append(answer(document))")).toBeGreaterThan(text.indexOf("Clean screen + marks"));
    expect(ink).toContain('"To mark your answer on this canvas, frame your marks {canvas: \\"\\(document.id)\\"}."');
    // canvas.json is the document, id and all.
    expect(ink).toContain("public let id: String");
    const anchor = member(send, "static func anchor(of id: String) -> CanvasAnchor? {");
    expect(anchor).toContain("guard let uuid = UUID(uuidString: id), uuid.uuidString == id.uppercased() else { return nil }");
    expect(anchor.indexOf("UUID(uuidString: id)")).toBeLessThan(anchor.indexOf("appendingPathComponent(id"));
  });

  test("the item changing, Esc, or a Send clears them; a new review replaces them", () => {
    expect(member(canvas, "    func clear() {")).toContain("AgentInkController.shared.stop()");
    const watch = member(agentInk, "private func watch() {");
    expect(watch).toContain("guard let item = shown, !item.marks.isEmpty else {");
    expect(watch).toContain("return CanvasController.shared.clearAgent()");
    // One document: merged by id, the agent's replacing only its own.
    expect(member(canvas, "func showAgent(_ marks: [CanvasMark], on display: CGDirectDisplayID, frame: CGRect, by name: String) {")).toContain("document?.merge(agent: marks)");
    expect(ink).toContain("marks = marks.filter { $0.author == .you } + agent.filter { $0.author == .agent }");
    // Where the review shows in conch, its page and its image say so.
    expect(review).toContain(".environment(\\.agentInkItem, item)");
    expect(webView).toContain("if let item = context.environment.agentInkItem { AgentInkController.shared.appeared(webView, showing: item) }");
    expect(webView).toContain("AgentInkController.shared.gone(webView)");
    expect(review).toContain("AgentInkController.shared.gone(view.imageView)");
    expect(project.match(/\/\* AgentInkController\.swift in Sources \*\/,/g)?.length).toBe(1);
  });

  test("they draw on as the lab's do, and only fade under Reduce Motion", () => {
    const drawOn = member(canvas, "private func drawOn(_ layer: CALayer, _ mark: CanvasMark, after delay: CFTimeInterval) {");
    expect(drawOn).toContain("guard !Self.reduceMotion, let spine = CanvasInk.spine(of: mark, in: bounds.size) else {");
    expect(drawOn).toContain('let draw = CABasicAnimation(keyPath: "strokeEnd")');
    expect(canvas).toContain("static let drawOnTime: CFTimeInterval = 0.4");
    const show = member(canvas, "func show(_ document: CanvasDocument?, armed: Bool, agentHidden: Bool = false, agentName: String = \"Claude\") {");
    expect(show).toContain("let delay = fresh ? Double(order) * 0.06 : 0");
    expect(show).toContain("label.pop(after: delay + (Self.reduceMotion ? 0 : Self.drawOnTime * 0.8))");
  });
});
