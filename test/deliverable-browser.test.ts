import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The deliverable pane browses the web.
 *
 * It used to refuse: a top-level navigation off the surfaced origin was handed to Safari, and
 * anything but http/https/the one published file was blocked outright. Tyler asked for it to
 * browse instead (2026-09-20), so the boundary moved from ENFORCED to DISCLOSED — anywhere on
 * the web is reachable, and the bar always says where you actually are.
 *
 * That trade only holds while the bar is honest, which is what most of this file pins. None of
 * it existed before: the old lock had no test at all, so nothing would have caught its removal.
 * These are the guards that replace it.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const swift = (path: string) => source(path).replace(/^\s*\/\/.*$/gm, "");
const web = swift("mac-app/conch-mac/WebView.swift");
const review = swift("mac-app/conch-mac/ReviewView.swift");

describe("the pane browses, and says where it is", () => {
  test("the web is reachable, and nothing is bounced to Safari any more", () => {
    // Whitespace-tolerant on purpose: `swift()` strips line comments but leaves the blank
    // lines behind, so pinning the exact gap between the case and its return pins a
    // comment-stripper's output rather than the code. The association is what matters.
    expect(web).toMatch(/case "http", "https":\s*return \.allow/);
    // The bounce and its case are gone rather than left unreachable — a dead branch named
    // after a boundary reads as though the boundary is still there.
    expect(web).not.toContain("openExternally");
    expect(web).not.toContain("offerExternalNavigation");
    expect(web).not.toContain("surfacedOrigin");
  });

  /**
   * The whole trade rests on this. With navigation free, a bar derived from the FILED link
   * would confidently name the wrong origin the moment you moved — the exact confusion the
   * boundary existed to prevent, now wearing a badge that says it is fine.
   */
  test("the address is read from where the view actually is", () => {
    expect(web).toContain("@Binding var currentLink: String?");
    expect(web).toContain("urlObservation = webView.observe(\\.url, options: [.initial, .new])");
    expect(web).toContain("context.coordinator.observeCurrentURL(of: webView)");
    // Invalidated with its sibling, or the observation outlives the view.
    const stop = web.slice(web.indexOf("func stopObservingLoadingState()"));
    expect(stop.slice(0, 400)).toContain("urlObservation?.invalidate()");

    expect(review).toContain("private var addressText: String { liveLink ?? shownLink }");
    expect(review).toContain("URL(string: addressText)");
    expect(review).toContain("currentLink: $liveLink");
  });

  /**
   * Free navigation was asked for so the pane can BROWSE. Reading arbitrary local files is a
   * different power that nobody asked for, and the published file is still the only one this
   * pane was ever handed.
   */
  test("local files stay locked to the one that was published", () => {
    expect(web).toContain("Local file navigation is limited to the exact file published for review.");
    expect(web).toContain("destination.standardizedFileURL.path");
    // And a scheme that is neither http, https nor file is still refused outright.
    expect(web).toContain("URL scheme is not allowed in the review.");
  });

  /**
   * `DeliverableLink.url(for:)` turns a schemeless string into a FILE path, so routing typed
   * text through it would have read "github.com" as a file on this Mac.
   */
  test("a typed address is a web address, never a file path", () => {
    // Searched FORWARD from the start, not by a marker hoped to be unique. `originText` sits
    // above this function and `@Binding var isWebLoading` appears twice in the file, so both
    // of my first two end markers resolved to a position BEFORE the start and sliced nothing.
    // An offset search cannot invert.
    const start = review.indexOf("static func webDestination(from typed: String) -> String? {");
    expect(start).toBeGreaterThan(-1);
    const parse = review.slice(start, review.indexOf("@Binding var isWebLoading", start));
    expect(parse.length).toBeGreaterThan(100);
    expect(parse).toContain('return (scheme == "http" || scheme == "https") ? trimmed : nil');
    expect(parse).toContain('return "https://" + trimmed');
    expect(parse).not.toContain("DeliverableLink");
  });

  test("a typed destination wins over the filed link, without losing it", () => {
    expect(review).toContain("private var shownLink: String { destination ?? link }");
    expect(review).toContain("link: shownLink,");
  });
});

/**
 * A page's own frames (Tyler, 2026-09-25): a Figma design in the pane came up as
 * "Link blocked · about:blank", the page behind the card gone. Figma's web app, and Google's
 * sign-in page, build frames inside themselves at about:blank; the policy refused every scheme
 * but http, https and the one file, and a refusal in ANY frame replaced the whole pane.
 */
describe("a page's own frames", () => {
  const raw = source("mac-app/conch-mac/WebView.swift");
  const swiftBin = Bun.which("swift");

  /**
   * The policy itself, run under `swift` rather than pinned by its spelling. It reads nothing
   * but the URL, the frame and the one surfaced file, so it lifts out whole.
   */
  test.skipIf(!swiftBin)("what each frame may load", () => {
    const start = raw.indexOf("private func navigationPolicy(for destination: URL, inSubframe: Bool) -> NavigationPolicy {");
    const end = raw.indexOf("private func refuseNavigation(", start);
    const enumStart = raw.indexOf("private enum NavigationPolicy {");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(enumStart).toBeGreaterThan(-1);
    const policy = raw.slice(start, end).replace(/private /g, "");
    const kinds = raw.slice(enumStart, raw.indexOf("}", enumStart) + 1).replace(/private /g, "");

    const cases: [string, string, boolean][] = [
      ["web", "https://www.figma.com/design/KEY/Name?node-id=519-3", false],
      ["web", "https://www.figma.com/design/KEY/Name", true],
      // The two about: pages a page builds frames from, in any frame.
      ["web", "about:blank", true],
      ["web", "about:srcdoc", true],
      ["web", "about:blank", false],
      // The rest of about: is the browser's own pages.
      ["web", "about:settings", true],
      ["web", "about:config", false],
      // What a page made itself, in a frame — never as the page.
      ["web", "blob:https://www.figma.com/0c1f5e2a", true],
      ["web", "data:text/html,<p>hi</p>", true],
      ["web", "blob:https://www.figma.com/0c1f5e2a", false],
      ["web", "data:text/html,<p>hi</p>", false],
      ["web", "javascript:alert(1)", true],
      ["web", "figma://design/KEY/Name", true],
      // The file rule, unchanged — and not loosened for a frame.
      ["file", "file:///tmp/review/page.html", false],
      ["file", "file:///tmp/review/page.html", true],
      ["file", "file:///etc/passwd", false],
      ["file", "file:///etc/passwd", true],
      ["web", "file:///tmp/review/page.html", true],
    ];
    const dir = mkdtempSync(join(tmpdir(), "conch-pane-policy-"));
    const file = join(dir, "main.swift");
    writeFileSync(file, [
      "import Foundation",
      "struct Pane {",
      "  var surfacedURL: URL?",
      policy,
      kinds,
      "}",
      'let panes = ["web": Pane(surfacedURL: URL(string: "https://www.figma.com/design/KEY/Name")), "file": Pane(surfacedURL: URL(fileURLWithPath: "/tmp/review/page.html"))]',
      "func say(_ pane: String, _ link: String, _ inSubframe: Bool) {",
      "  switch panes[pane]!.navigationPolicy(for: URL(string: link)!, inSubframe: inSubframe) {",
      '  case .allow: print("allow")',
      '  case let .refuse(message): print("refuse: " + message)',
      "  }",
      "}",
      ...cases.map(([pane, link, inSubframe]) => `say(${JSON.stringify(pane)}, ${JSON.stringify(link)}, ${inSubframe})`),
    ].join("\n"));
    try {
      const run = Bun.spawnSync([swiftBin!, file], { stdout: "pipe", stderr: "pipe" });
      if (run.exitCode !== 0) throw new Error(`swift exited ${run.exitCode}: ${run.stderr.toString()}`);
      expect(run.stdout.toString().trim().split("\n")).toEqual([
        "allow",
        "allow",
        "allow",
        "allow",
        "allow",
        "refuse: The about URL scheme is not allowed in the review.",
        "refuse: The about URL scheme is not allowed in the review.",
        "allow",
        "allow",
        "refuse: The blob URL scheme is not allowed in the review.",
        "refuse: The data URL scheme is not allowed in the review.",
        "refuse: The javascript URL scheme is not allowed in the review.",
        "refuse: The figma URL scheme is not allowed in the review.",
        "allow",
        "allow",
        "refuse: Local file navigation is limited to the exact file published for review.",
        "refuse: Local file navigation is limited to the exact file published for review.",
        "refuse: Local file navigation is limited to the exact file published for review.",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  /** The card replaces the whole pane, so it is the PAGE's to raise, never one of its frames'. */
  test("a refused frame is cancelled quietly, never the pane's error card", () => {
    expect(web).toContain("let inSubframe = navigationAction.targetFrame?.isMainFrame == false");
    expect(web).toContain("switch navigationPolicy(for: destination, inSubframe: inSubframe) {");
    expect(web).toMatch(/refuseNavigation\(\s*to: nil,\s*message: "The page requested a destination with no valid URL\.",\s*inSubframe: inSubframe\s*\)/);
    expect(web).toContain("refuseNavigation(to: destination, message: message, inSubframe: inSubframe)");
    // The quiet return comes BEFORE anything that raises the card.
    const refuse = web.slice(web.indexOf("private func refuseNavigation("));
    expect(refuse).toMatch(/^private func refuseNavigation\(to destination: URL\?, message: String, inSubframe: Bool\) \{\s*guard !inSubframe else \{\s*NSLog\([^)]*\)\s*return\s*\}/);
    expect(refuse.indexOf("return\n")).toBeLessThan(refuse.indexOf("parent.onNavigationFailure("));
  });

  /** A window opened blank is filled in by its opener, which this view never hands back. */
  test("a popup opened at about:blank does not blank the page", () => {
    expect(web).toMatch(/if navigationAction\.targetFrame == nil,\s*navigationAction\.request\.url\?\.absoluteString != "about:blank" \{\s*activeNavigation = webView\.load\(navigationAction\.request\)/);
  });
});

/**
 * Where a Figma design lives is Figma. In the pane it is the web app, which for a private file
 * is a sign-in wall until you sign in there too (the pane keeps its own cookies) — so the way
 * out reaches the desktop app, by `figma://` since the app does not claim figma.com links.
 * `FigmaLink` itself is tested in ConchDesign's WorkspaceTests.
 */
describe("a Figma file opens in Figma", () => {
  const store = swift("mac-app/conch-mac/StateStore.swift");
  const door = store.slice(store.indexOf("func openLink("), store.indexOf("private var errorStateSnapshot"));

  test("the one door hands a Figma file to the app when it is installed, before anything else reads the url", () => {
    expect(door).toContain("var url = LinkTarget.url(for: link, cwd: cwd)");
    expect(door).toMatch(/if let app = FigmaLink\.appURL\(for: url\), NSWorkspace\.shared\.urlForApplication\(toOpen: app\) != nil \{\s*url = app\s*\}/);
    expect(door.indexOf("FigmaLink.appURL")).toBeLessThan(door.indexOf("let target ="));
  });

  test("the pane's way out says so, read from where the pane is", () => {
    expect(review).toContain('actionHelp: opensInFigma ? "Open in Figma (⌘3)" : "Open where it lives (⌘3)"');
    expect(review).toContain('URL(string: liveAddress ?? item.link ?? "").flatMap(FigmaLink.appURL(for:)) != nil');
  });

  test("a .fig on disk is named as something only Figma reads, not fed to WebKit", () => {
    const unpreviewable = review.slice(review.indexOf("private static let unpreviewableExtensions"));
    expect(unpreviewable.slice(0, unpreviewable.indexOf("])"))).toContain('"fig"');
  });
});
