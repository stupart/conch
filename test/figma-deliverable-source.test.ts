import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A Figma deliverable shows where it was published (2026-11-11). Tyler: "Make figma show in the deliverables area instead
 * of automatically sending me to figma." The pill, the menu and the panel's picks handed a design to the Figma app; now
 * the deliverable pane, the panel and the phone show it as Figma's embed, signed in with conch's browser profile, and
 * "Open in Figma" is the one way out. The rules are ConchDesign's (`FigmaLink`, `ReviewScene`: WorkspaceTests,
 * FolderDeliverableTests, ConchDesignTests); what the apps' sources must keep doing with them is here.
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

const webView = code("mac-app/conch-mac/WebView.swift");
const statusItem = code("mac-app/conch-mac/StatusItem.swift");
const review = code("mac-app/conch-mac/ReviewView.swift");
const phone = code("mobile/conch-ios/conch-ios/DeliverableSheet.swift");
const components = code("design/ConchDesign/Sources/ConchDesign/Components.swift");

describe("a Figma deliverable is shown, not sent away", () => {
  test("the deliverable pane loads a Figma file as its embed, at figma.com's own address, and its bar says the file", () => {
    const load = between(webView, "private func load(_ link: String, in webView: WKWebView) -> WKNavigation? {", "\n    }\n");
    expect(load.indexOf("FigmaLink.embedPage(for: url)")).toBeLessThan(load.indexOf("webView.load(URLRequest(url: url))"));
    expect(load).toContain("return webView.loadHTMLString(embed, baseURL: FigmaLink.embedBase)");
    expect(webView).toContain("context.coordinator.embedded = FigmaLink.isFile(url) ? url.absoluteString : nil");
    expect(between(webView, "func observeCurrentURL(of webView: WKWebView) {", "\n        }\n")).toContain("view.url == FigmaLink.embedBase ? self?.embedded");
  });

  test("a pick from the pill or the menu opens it in conch's window, where conch shows the work, never in the Figma app", () => {
    // Since the floating conversation panel went (#613), conch's window, its deliverable pane, is where it shows.
    const open = between(statusItem, "static func open(_ row: SessionRow, store: StateStore) async -> Bool {", "\n    }\n");
    expect(open).toContain("openInWindow(row, store: store)");
    expect(open).toContain("ReviewScene.opensOnlyInConch(deliverable: row.review?.kind, marked: marked, link: link)");
    expect(open.indexOf("let link = ")).toBeLessThan(open.indexOf("opensOnlyInConch("));
    expect(between(components, "public static func opensOnlyInConch(", "\n    }\n")).toContain("link.map(FigmaLink.isFile) == true");
    expect(between(components, "public static func panelShowsContent(", "\n    }\n")).toContain("if FigmaLink.isFile(url) { return true }");
  });

  test("Open in Figma stays the way out, and only it hands the file to the app", () => {
    expect(review).toContain('actionHelp: opensInFigma ? "Open in Figma (⌘3)" : "Open where it lives (⌘3)"');
    const state = code("mac-app/conch-mac/StateStore.swift");
    expect(between(state, "func openLink(", "let target = url.isFileURL")).toContain("FigmaLink.appURL(for: url)");
  });

  test("the phone shows the same embed, and its way out says Figma", () => {
    const load = between(phone, "static func load(_ url: URL, in view: WKWebView) {", "\n    }\n");
    expect(load).toContain("view.loadHTMLString(embed, baseURL: FigmaLink.embedBase)");
    expect(between(phone, "private struct BridgedWebView: UIViewRepresentable {", "func updateUIView")).toContain("PageLoadFailure.load(url, in: view)");
    expect(between(phone, "func reload(_ url: URL) {", "\n    }\n")).toContain("FigmaLink.isFile(url)");
    expect(phone).toContain('Label(figma ? "Open in Figma" : "Open in Safari"');
  });
});
