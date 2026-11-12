import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * conch's browser, seen by sites as what it is (2026-11-11). Tyler: "make browser in the app not get flagged by
 * everything thinking its a robot." Measured in a WKWebView set up as a Workbench tab's: an agent's click and typing came
 * to the page as untrusted script events with no key pressed; `window.outerWidth` and `outerHeight` read 0; and the
 * review pane and conch_capture spoke to the Default profile's sites as bare WebKit while its tabs said Safari. The rules
 * are ConchDesign's (WorkbenchInputTests, WorkbenchInputWebKitTests in real WebKit, workbench-script.test.ts); what the
 * app's sources must keep doing with them is here.
 */
const root = join(import.meta.dir, "..");
const code = (path: string) => readFileSync(join(root, path), "utf8").replace(/^\s*\/\/.*$/gm, "");
const between = (text: string, from: string, to: string) => {
  const start = text.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = text.indexOf(to, start + from.length);
  expect(end, to).toBeGreaterThan(start);
  return text.slice(start, end);
};

const workbench = code("mac-app/conch-mac/Workbench.swift");
const webView = code("mac-app/conch-mac/WebView.swift");
const capturer = code("mac-app/conch-mac/PageCapturer.swift");
const accounts = code("mac-app/conch-mac/ClaudeAccountsView.swift");

describe("an agent's click and typing are real input", () => {
  test("a click is pressed for real where it can be, and the script clicks only where it can't", () => {
    const click = between(workbench, 'case "click":', 'case "type":');
    expect(click.indexOf("await markTarget(target, kind: .click)")).toBeLessThan(click.indexOf("await press(target, deadline: deadline)"));
    expect(click.indexOf("await press(target, deadline: deadline)")).toBeLessThan(click.indexOf('script(front, op: "click"'));
    const press = between(workbench, "private func press(_ target: (how: String, what: String), deadline: Date) async -> String? {", "\n    }\n");
    expect(press).toContain("await waitForHand(deadline: deadline)");
    expect(press).toContain("found.native, let point = found.point");
    expect(press).toContain("!agentsPaused, !isClosed");
  });

  test("the press is mouse events handed to the view, never through the window or the pointer on screen", () => {
    const click = between(workbench, "private func click(_ view: WKWebView, at point: CGPoint, in window: NSWindow) async {", "\n    }\n");
    for (const handed of ["view.mouseMoved(with: event)", "view.mouseDown(with: event)", "view.mouseUp(with: event)"]) expect(click).toContain(handed);
    expect(click).toContain("(view as? WorkbenchWebView)?.agentPressing()");
    expect(workbench).not.toMatch(/sendEvent|CGEvent|CGWarpMouseCursorPosition|makeKeyAndOrderFront|NSApp\.activate/);
  });

  test("typing is a key for each character into the field pressed, its text selected first, and the script only when no key landed", () => {
    const type = between(workbench, 'case "type":', 'case "screenshot":');
    expect(type.indexOf("markTarget(target, kind: .type)")).toBeLessThan(type.indexOf("await typeKeys("));
    expect(type).toContain("if typed == nil {");
    const keys = between(workbench, "private func typeKeys(", "private func strike(");
    const order = ["await click(view, at: point, in: window)", 'op: "focus-field"', "await strike(strokes, in: view, window: window)", 'op: "end-field"', 'guard case .bool(true)? = ended["changed"] else { return nil }', "WorkbenchInput.returnKeyCode"];
    for (const [before, after] of order.slice(0, -1).map((step, index) => [step, order[index + 1]!])) {
      expect(keys.indexOf(before), before).toBeGreaterThan(-1);
      expect(keys.indexOf(before), `${before} before ${after}`).toBeLessThan(keys.indexOf(after));
    }
    // A key the page sent elsewhere was stopped (a password field the page moved to): said, not typed on.
    expect(keys).toContain('ended["strayed"]');
    const strike = between(workbench, "private func strike(", "private func down(");
    for (const handed of ["view.flagsChanged(with: event)", "view.insertText(text)", "if agentsPaused || isClosed || Task.isCancelled { break }"]) expect(strike).toContain(handed);
  });

  test("an agent's press never takes Tyler's keyboard, and his hand in a page comes first", () => {
    const view = between(workbench, "final class WorkbenchWebView: WKWebView {", "\n}\n");
    expect(view).toContain("override func becomeFirstResponder() -> Bool {");
    expect(view).toContain("guard pressing > 0 else { return super.becomeFirstResponder() }");
    expect(view).toContain("window.makeFirstResponder(keeper)");
    expect(workbench).toContain("webView = WorkbenchWebView(frame:");
    expect(workbench).toContain("let popup = WorkbenchWebView(frame:");
    expect(between(workbench, "private func noteTouch(_ event: NSEvent) {", "\n    }\n")).toContain("page.lastHand = Date()");
    expect(between(workbench, "private func waitForHand(deadline: Date) async {", "\n    }\n")).toContain("WorkbenchInput.handIsIn(lastTouch: lastHand, now: Date())");
  });
});

describe("a page is told a real window, and one browser's agent", () => {
  test("every web view conch shows a site in answers WebKit's question about its window", () => {
    for (const [name, source] of [["Workbench", workbench], ["review pane", webView], ["capture", capturer], ["Claude sign-in", accounts]] as const) {
      expect(source, name).toContain("@objc(_webView:getWindowFrameWithCompletionHandler:)");
      expect(source, name).toMatch(/PageWindow\.frame\(of: webView\)|WorkbenchInput\.reportedWindowFrame\(page: webView\.bounds\.size/);
    }
    const frame = between(webView, "enum PageWindow {", "\n}\n");
    expect(frame).toContain("WorkbenchInput.reportedWindowFrame(");
    expect(frame).toContain("window is WorkbenchParkingWindow || window is PageCaptureWindow");
  });

  test("the review pane and capture say Safari, as the Default profile's tabs do", () => {
    expect(between(webView, "func makeNSView(context: Context) -> WKWebView {", "return webView")).toContain("webView.customUserAgent = SafariUserAgent.current");
    expect(capturer).toContain("webView.customUserAgent = SafariUserAgent.current");
    expect(workbench).toContain("static let userAgent = SafariUserAgent.current");
  });
});
