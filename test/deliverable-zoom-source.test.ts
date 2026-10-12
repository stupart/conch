import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Zoom on a deliverable, and the deliverable pane's two-part layouts made resizable (Tyler, 2026-10-12: "make it so I
 * can zoom in on items in the deliverables place that are images or files and when its like files and images like
 * that extra split type thing i want ot be able to control the size of that plane as well").
 *
 * The arithmetic and the control are ConchDesign's, tested there (ContentZoomTests, PaneSplitTests, ZoomRenderTests);
 * this pins where the Mac wires them in, so a renderer can't quietly lose its zoom or a split its divider.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Line comments stripped, so prose describing a rule can never satisfy a guard.
const swift = (path: string) => source(path).replace(/^\s*\/\/.*$/gm, "");
const review = swift("mac-app/conch-mac/ReviewView.swift");
const web = swift("mac-app/conch-mac/WebView.swift");
const compare = swift("mac-app/conch-mac/VersionCompareView.swift");
const zoomViews = swift("design/ConchDesign/Sources/ConchDesign/ZoomViews.swift");
const panes = swift("design/ConchDesign/Sources/ConchDesign/VersionCompareViews.swift");

function slice(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing: ${end}`).toBeGreaterThan(-1);
  return text.slice(from, to);
}

describe("every picture, PDF, page and text in the pane zooms, one way", () => {
  test("the pane holds one zoom per file shown, and hands it to the renderer below", () => {
    const content = slice(review, "private struct ReviewContent: View {", "private func retryNavigation()");
    expect(content).toContain("@StateObject private var zoom = ZoomTarget()");
    expect(content).toContain(".environment(\\.conchZoomTarget, zoom)");
    // The control in the corner of each kind that zooms: a picture, a PDF, a markdown, a text, a page.
    expect(content.match(/\.overlay\(alignment: \.bottomTrailing\) \{ ZoomOverlay\(target: zoom\) \}/g)).toHaveLength(5);
  });

  test("each renderer attaches itself; a video never does, so it draws no control", () => {
    const image = slice(review, "private struct DeliverableImageView", "final class DeliverablePictureView");
    expect(image).toContain("zoom.attach(view) { [weak view] action in view?.zoom(action) }");
    const pdf = slice(review, "private struct DeliverablePDFView", "private struct DeliverableDocumentView");
    expect(pdf).toContain("zoom.attach(view)");
    expect(pdf).toContain("forName: .PDFViewScaleChanged");
    const document = slice(review, "private struct DeliverableDocumentView", "private struct DeliverableImageView");
    expect(document).toContain("let scrollView = ZoomingTextScrollView()");
    expect(document).toContain("zoom.attach(scrollView)");
    expect(web).toContain("let webView = DeliverableWKWebView(frame: .zero, configuration: configuration)");
    expect(web).toContain("zoom.attach(webView)");
    // A page zooms by reflowing (page zoom); its pinch stays WebKit's own magnification.
    expect(web).toContain("webView.allowsMagnification = true");
    expect(web).toContain("webView.pageZoom = ContentZoom.page.clamped(next.scale(resting: 1), resting: 1)");
    const video = slice(review, "private struct DeliverableVideoView", "private struct DeliverablePDFView");
    expect(video).not.toContain("conchZoomTarget");
  });

  test("a picture pinches about the fingers, double-clicks between fit and 100%, and pans by dragging", () => {
    const viewer = slice(review, "private struct DeliverableImageView", "final class DeliverablePictureView");
    expect(viewer).toContain("override func magnify(with event: NSEvent) {");
    expect(viewer).toContain("override func smartMagnify(with event: NSEvent) {");
    expect(viewer).toContain("if event.clickCount == 2 {");
    expect(viewer).toContain("self?.zoom(.toggle, around: point)");
    expect(viewer).toContain("override func mouseDragged(with event: NSEvent) {");
    // AppKit's magnification of one layout, like a canvas: a pinch scales what shows under the fingers, a key or
    // double-click glides there, and nothing settles or lays out again when it ends (2026-10-12, Tyler: "u zoom to one
    // size visually and when your done it like snaps to another position").
    expect(viewer).toContain("allowsMagnification = true");
    expect(viewer).toContain("animator().setMagnification(target, centeredAt: point)");
    expect(viewer).not.toContain("ContentZoom.picture.settled(");
    expect(viewer).not.toContain("if let zoom { targetWidth = size.width * zoom }");
    expect(zoomViews).not.toContain("rules.settled(level, resting: 1)");
    // Fitted as before, zoomed from its own size: the fit line stays the one the decode test pins.
    expect(viewer).toContain("var targetWidth = min(paneWidth - 36, size.width)");
  });

  test("⌘0 is taken only from a zoomed deliverable: otherwise it is still Session ▸ Lagoon", () => {
    expect(zoomViews).toContain("if action == .reset, target.readout?.isAtRest != false { return false }");
    expect(source("mac-app/conch-mac/LagoonPane.swift")).toContain('.keyboardShortcut("0", modifiers: .command)');
  });
});

describe("the pane's splits drag, remember, and double-click back", () => {
  test("a folder's tree (and the Files tab's) beside the file picked in it", () => {
    const files = slice(review, "struct WorkspaceFilesView: View {", "private var rail: some View {");
    expect(files).toContain("@AppStorage(PaneSplit.fileTree.key) private var railWidth = Double(PaneSplit.fileTree.standard)");
    expect(files).toContain("ConchSplitView(split: .fileTree, width: $railWidth, label: \"Resize the file list\") {");
    expect(files).not.toContain(".frame(width: Self.railWidth)");
  });

  test("two versions side by side, pages and pictures alike", () => {
    expect(compare).toContain("@AppStorage(PaneFraction.compare.key) private var sideBySide = PaneFraction.compare.standard");
    expect(compare).toContain("spacing: 12, split: $sideBySide) {");
    expect(compare).toContain("afterLine: lines.after, split: $split)");
    // On the phone, and stacked, the two share the room equally as before.
    expect(panes).toContain("if let split, axis == .horizontal {");
  });
});
