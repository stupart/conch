import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Annotate (docs/annotate.md): Tyler's notes on a deliverable, pinned in conch's own pane and sent to the session that
// published it. These pin the wiring that can't be run headless: which renderers register, that the page script stays in
// its own world, that Send is the composer's own path to the deliverable's own session and nothing else, and that the
// harness behind scripts/annotate-e2e.ts only ever runs in a conch launched for it. The behaviour itself is tested in
// design/ConchDesign (AnnotateTests, AnnotateScriptTests in real WebKit) and end to end by scripts/annotate-e2e.ts.

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const annotate = read("mac-app/conch-mac/DeliverableAnnotate.swift");
const harness = read("mac-app/conch-mac/AnnotateHarness.swift");
const review = read("mac-app/conch-mac/ReviewView.swift");
const webView = read("mac-app/conch-mac/WebView.swift");
const snapshot = read("mac-app/conch-mac/DebugSnapshot.swift");
const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");
const model = read("design/ConchDesign/Sources/ConchDesign/Annotate.swift");
const macSources = Object.fromEntries(
  readdirSync(join(root, "mac-app/conch-mac")).filter((name) => name.endsWith(".swift")).map((name) => [name, read(`mac-app/conch-mac/${name}`)]),
);
const filesWith = (needle: string): string[] => Object.keys(macSources).filter((name) => macSources[name]!.includes(needle)).sort();

describe("where annotate is", () => {
  test("a pane showing one deliverable annotates; a comparison's two sides don't", () => {
    expect(review).toContain("@StateObject private var annotator = DeliverableAnnotator()");
    expect(review).toContain(".environment(\\.deliverableAnnotator, showsInk ? annotator : nil)");
    expect(review).toContain(".onChange(of: item) { _, item in annotator.show(item, store: store) }");
    // VersionCompareView turns the ink off for the two sides, and annotate with it.
    expect(read("mac-app/conch-mac/VersionCompareView.swift")).toContain("showsInk: false");
  });

  test("a page, a picture and a document register themselves; nothing else takes notes", () => {
    expect(webView).toContain("if annotator != nil { context.coordinator.annotate = AnnotateWebBridge.install(in: configuration) }");
    expect(webView).toContain("annotator.attachPage(webView, bridge: bridge)");
    expect(webView).toContain("coordinator.annotate?.annotator?.detach(webView)");
    expect(review).toContain("annotator.attachPicture(host: view, picture: view.imageView, path: url.path)");
    expect(review).toContain("annotator.attachDocument(host: scrollView, text: textView, path: url.path)");
    expect(review).toContain("coordinator.annotator?.detach(view)");
    expect(review).toContain("coordinator.annotator?.detach(scrollView)");
    // Each draws its notes over itself, in its own points.
    for (const kind of ["picture", "document", "page"]) expect(review).toContain(`.overlay { notes(.${kind}) }`);
    // The control shows only where what is shown takes notes.
    expect(review).toContain("if annotates, annotator.canAnnotate {");
  });

  test("the Files tab's viewer has no annotator, so nothing there can be annotated", () => {
    expect(annotate).toContain("static let defaultValue: DeliverableAnnotator? = nil");
    expect(review).toContain("@Environment(\\.deliverableAnnotator) private var annotator");
  });
});

describe("the page", () => {
  test("its script runs in conch's own content world, in the main frame, and is handed its notes as arguments", () => {
    expect(annotate).toContain("WKUserScript(source: AnnotationScript.source, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world)");
    expect(annotate).toContain("content.add(WeakScriptHandler(bridge), contentWorld: world, name: AnnotationScript.handler)");
    expect(annotate).toContain('"return globalThis.conchAnnotate ? conchAnnotate.set(on, notes) : false"');
    expect(annotate).toContain("arguments: [\"on\": on, \"notes\": notes], in: nil, in: .world(name: AnnotationScript.world)");
    expect(annotate).toContain("guard message.frameInfo.isMainFrame, let read = AnnotationScript.Message.read(message.body) else { return }");
    expect(model).toContain('public static let world = "conch-annotate"');
    // It finds a quote by agent ink's own rule, so an agent's mark on Tyler's quote lands where his note was.
    expect(model).toContain("// The first place `quote` shows, as a Range: agent ink's finder's rule (AgentInk.finder).");
  });

  test("a note's picture is conch's own drawing of the page or the picture's own pixels: no screen is captured", () => {
    expect(annotate).toContain("web.takeSnapshot(with: configuration)");
    expect(annotate).toContain("AnnotationPicture.load(path).flatMap { AnnotationPicture.crop(image: $0, anchor: anchor) }");
    for (const needle of ["SCScreenshotManager", "SCShareableContent", "CGRequestScreenCaptureAccess", "CGPreflightScreenCaptureAccess"]) {
      expect(annotate).not.toContain(needle);
    }
  });
});

describe("Send", () => {
  test("goes to the deliverable's own session, through the composer's own path, and only from the tray", () => {
    expect(annotate).toContain("let event = ConchDaemonEvent.inject(sessionId: route.session, label: route.label, text: message)");
    expect(annotate).toContain("let taken = await store.send(event).value");
    expect(annotate).toContain("return AnnotationRoute.resolve(owner: item.rowID");
    // The tray's button (and ⌘Return on it), and the harness: nothing else sends.
    const callers = Object.entries(macSources).flatMap(([name, source]) => (source.match(/(?:annotator|live\(\))\.send\b/g) ?? []).map((call) => `${name}: ${call}`));
    expect(callers.sort()).toEqual(["AnnotateHarness.swift: live().send", "DeliverableAnnotate.swift: annotator.send"]);
    expect(annotate).toContain("onSend: annotator.send,");
  });

  test("a session that can't take it is never sent to, and notes it leaves behind are said, not lost", () => {
    expect(annotate).toContain("sessions: rows.map { ($0.id, $0.label, $0.messageUnavailableReason) })");
    expect(annotate).toContain("guard let route = self.route, !route.ended else {");
    expect(annotate).toContain("AnnotationDrafts.shared.gather(listed: state.map { Set($0.rows.map(\\.id)) })");
    expect(annotate).toContain("notice ?? AnnotationDrafts.shared.orphans.first.map { .orphaned($0.item.label, notes: $0.batch.count) }");
  });

  test("taken isn't landed: a send refused later puts the notes back on the deliverable they came from", () => {
    expect(annotate).toContain("guard let failure = await CanvasController.failure(of: event.opId, in: store) else { return }");
    expect(annotate).toContain("AnnotationDrafts.shared.keep(back, for: item)");
    expect(annotate).toContain("guard self.item?.id == item.id else { return }");
  });

  test("its folder is Tyler's alone and kept 14 days, as the canvas's", () => {
    expect(annotate).toContain('.appendingPathComponent(".cache/conch/annotations", isDirectory: true)');
    expect(annotate).toContain("attributes: [.posixPermissions: 0o700]");
    expect(annotate).toContain("attributes: [.posixPermissions: 0o600]");
    expect(annotate).toContain("static let kept = CanvasFolder.kept");
  });
});

describe("the harness", () => {
  test("runs only in a conch launched for it, and leaves the running conch's request files alone", () => {
    expect(harness).toContain('static let running = ProcessInfo.processInfo.environment["CONCH_HARNESS"]?.isEmpty == false');
    expect(harness).toContain('guard running, let named = ProcessInfo.processInfo.environment["CONCH_HARNESS"], timer == nil else { return }');
    expect(read("mac-app/conch-mac/ConchMacApp.swift")).toContain("Task { @MainActor in AnnotateHarness.startIfAsked(store: store) }");
    expect(snapshot).toContain('static let answersRequests = ProcessInfo.processInfo.environment["CONCH_HARNESS"] == nil');
    for (const guarded of ["static func pendingSelection() -> String? {\n        guard answersRequests", "static func pendingInspection() -> String? {\n        guard answersRequests", "static func serviceRequest() {\n        guard answersRequests"]) {
      expect(snapshot).toContain(guarded);
    }
    // Its pictures are of conch's own window (canvas-source.test.ts holds every capture to this).
    expect(filesWith("CONCH_HARNESS").sort()).toEqual(["AnnotateHarness.swift", "ConchMacApp.swift", "DebugSnapshot.swift"]);
  });

  test("the e2e drives this checkout's build under a bundle id of its own, never the installed conch", () => {
    const e2e = read("scripts/annotate-e2e.ts");
    expect(e2e).toContain('const HARNESS_ID = "ai.blueprintstudio.conch.harness";');
    expect(e2e).toContain('if (app.startsWith("/Applications/")) {');
    expect(e2e).toContain('Bun.spawnSync(["/usr/bin/defaults", "delete", HARNESS_ID]);');
    // tmux is its own server, by its own name, with $TMUX unset.
    expect(e2e).toContain('if ("TMUX" in env || !env.TMUX_TMPDIR!.startsWith(root)) throw new Error("refusing: tmux would not be this test\'s own");');
    expect(e2e).toContain('Bun.spawnSync([TMUX, "-L", tmuxSocket, ...args]');
    expect(e2e).not.toMatch(/\btmux kill-server\b(?! by)/);
  });
});

test("both files are in the app's target, once", () => {
  for (const name of ["DeliverableAnnotate.swift", "AnnotateHarness.swift"]) {
    expect(project.match(new RegExp(`/\\* ${name.replace(".", "\\.")} in Sources \\*/,`, "g"))?.length).toBe(1);
    expect(project).toContain(`/* ${name} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${name}; sourceTree = "<group>"; };`);
  }
});
