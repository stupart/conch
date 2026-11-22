import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The deliverable pane's navigation policy (WebView.swift), lifted out and run under `swift`: the web is reachable,
 * a page's own about:blank/about:srcdoc frames load (a Figma design came up as "Link blocked · about:blank"), and
 * local files stay locked to the one published file.
 */
describe("a page's own frames", () => {
  const raw = readFileSync(new URL("../mac-app/conch-mac/WebView.swift", import.meta.url), "utf8");
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
      const verdicts = run.stdout.toString().trim().split("\n").map((line) => line.split(":")[0]);
      expect(verdicts).toEqual([
        "allow", "allow", "allow", "allow", "allow",
        "refuse", "refuse",
        "allow", "allow",
        "refuse", "refuse", "refuse", "refuse",
        "allow", "allow",
        "refuse", "refuse", "refuse",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
