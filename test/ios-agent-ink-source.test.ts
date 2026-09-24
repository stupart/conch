import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Agent ink on the phone: an agent's marks (`scene.marks`) drawn over the image or the page the review sheet shows, from
 * the same pure pieces the Mac draws with (`AgentInk`, `CanvasInk`) and the same read-only finder. Tyler: "transparent
 * canvas that both the ai and the user can write to over top of what they're looking at". The iOS app has no test
 * target, so the Foundation pieces run under `swift` and the rest is read the way the other ios-*.test.ts do.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const ink = read("mobile/conch-ios/conch-ios/AgentInkView.swift");
const sheet = read("mobile/conch-ios/conch-ios/DeliverableSheet.swift");
const shared = read("design/ConchDesign/Sources/ConchDesign/AgentInk.swift");
const project = read("mobile/conch-ios/conch-ios.xcodeproj/project.pbxproj");
const swift = Bun.which("swift");

function between(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  expect(at, `missing: ${start}`).toBeGreaterThan(-1);
  const stop = source.indexOf(end, at + start.length);
  expect(stop, `missing after ${start}: ${end}`).toBeGreaterThan(at);
  return source.slice(at, stop);
}

describe("which marks land where", () => {
  test.skipIf(!swift)("an image mark only on the review's own image, a page mark only on the review's own page", () => {
    const surface = between(ink, "enum InkSurface {", "\n}\n") + "\n}\n";
    const dir = mkdtempSync(join(tmpdir(), "conch-ios-ink-"));
    const file = join(dir, "main.swift");
    writeFileSync(file, ["import Foundation", surface,
      'print(InkSurface.sameFile("/Users/t/p/shots/a.png", "/Users/t/p/shots/./a.png"))',
      'print(InkSurface.sameFile("/Users/t/p/shots/a.png", "/Users/t/p/other/../shots/a.png"))',
      'print(InkSurface.sameFile("/Users/t/p/shots/a.png", "/Users/t/p/shots/b.png"))',
      'let entry = URL(string: "conch-page://h/index.html")!',
      'print(InkSurface.isReviewPage(URL(string: "conch-page://h/index.html#faq"), entry: entry))',
      'print(InkSurface.isReviewPage(URL(string: "conch-page://h/other.html"), entry: entry))',
      'print(InkSurface.isReviewPage(URL(string: "https://example.com/"), entry: entry))',
      "print(InkSurface.isReviewPage(nil, entry: entry))",
    ].join("\n"));
    try {
      const run = Bun.spawnSync([swift!, file], { stdout: "pipe", stderr: "pipe" });
      if (run.exitCode !== 0) throw new Error(run.stderr.toString());
      expect(run.stdout.toString().trim().split("\n")).toEqual(["true", "true", "false", "true", "false", "false", "false"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("unresolved marks are never drawn: no geometry, not on this image, not found on the page, out of sight", () => {
    const image = between(ink, "func imageInk(_ marks: [AgentMark], link: String?, key: String) -> [CanvasMark] {", "\n}\n");
    expect(image).toContain("guard case let .image(path) = mark.frame, InkSurface.sameFile(path, link), let kind = AgentInk.Kind(rawValue: mark.kind.rawValue) else { return nil }");
    expect(image).toContain("return AgentInk.mark(id:");
    expect(image).toContain("marks.compactMap");
    const place = between(ink, "private func place(on page: WKWebView) async -> [CanvasMark] {", "\n    }\n");
    expect(place).toContain("guard InkSurface.isReviewPage(page.url, entry: entry), !page.isLoading else { return [] }");
    expect(place).toContain("guard let xywh = found[mark.id], xywh.count == 4, let kind = AgentInk.Kind(rawValue: mark.kind.rawValue) else { return nil }");
    expect(place).toContain("guard CGRect(origin: .zero, size: size).contains(CGPoint(x: local.midX, y: local.midY)) else { return nil }");
    expect(place).toContain("return AgentInk.mark(id:");
    // A canvas mark has no place on a phone.
    expect(between(ink, "init?(page: WKWebView, marks: [AgentMark], entry: URL, key: String, agent: String) {", "guard !asked.isEmpty else { return nil }"))
      .toContain("case .canvas, .image: nil");
  });
});

describe("the page is only read, by the one script both apps run", () => {
  test("the finder lives in the shared package, runs in conch's own world, and takes its strings as arguments", () => {
    expect(shared).toContain('public static let finder = """');
    expect(read("mac-app/conch-mac/AgentInkController.swift")).toContain("static let finder = AgentInk.finder");
    expect(ink).toContain('page.callAsyncJavaScript(AgentInk.finder, arguments: ["marks": asked], in: nil, contentWorld: .defaultClient)');
    expect(ink).not.toContain("evaluateJavaScript");
    expect(ink).not.toContain("contentWorld: .page");
    // The one call into a page, and what it runs is the shared script, never a string built here.
    expect(ink.match(/callAsyncJavaScript\(/g)?.length).toBe(1);
  });
});

describe("drawn as the Mac draws them", () => {
  test("the agent's violet, the Mac's shapes, and a view that never takes a touch", () => {
    const view = between(ink, "final class AgentInkView: UIView {", "\n}\n");
    expect(view).toContain("isUserInteractionEnabled = false");
    expect(view).toContain("let shape = CanvasInk.shape(of: mark, in: size)");
    expect(view).toContain("ink.fillColor = CanvasInk.fill(of: mark).cgColor");
    expect(view).toContain("shape.fillColor = CanvasInk.colour(mark.author).cgColor");
    expect(view).toContain(".foregroundColor: UIColor(cgColor: CanvasInk.agent.cgColor),");
    expect(view).toContain('star.string = "✦"');
    expect(view).toContain("guard let spot = CanvasInk.labelSpot(of: mark, in: bounds.size) else { return nil }");
  });

  test("drawn on along its spine in 0.4 s on the lab's curve, labels popping on the pop spring; Reduce Motion fades", () => {
    const view = between(ink, "final class AgentInkView: UIView {", "\n}\n");
    expect(view).toContain("static let drawOnTime: CFTimeInterval = 0.4");
    expect(view).toContain("static var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled }");
    const drawOn = between(view, "private func drawOn(_ layer: CALayer, _ mark: CanvasMark, after delay: CFTimeInterval) {", "\n    }\n");
    expect(drawOn).toContain("guard !Self.reduceMotion, let spine = CanvasInk.spine(of: mark, in: bounds.size) else {");
    expect(drawOn).toContain('let draw = CABasicAnimation(keyPath: "strokeEnd")');
    expect(drawOn).toContain("draw.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0.1, 0.2, 1)");
    const pop = between(ink, "private static func pop(_ layer: CALayer, from scale: CGFloat, after delay: CFTimeInterval) {", "\n    }\n");
    expect(pop).toContain("let spring = ConchMotion.pop.resolved(reduceMotion: reduce)");
    expect(pop).toContain("grow.fromValue = reduce ? 1 : scale");
    // One after another, 60 ms apart; a label as its mark is four fifths drawn; never drawn on twice.
    expect(view).toContain("let delay = fresh ? Double(order) * 0.06 : 0");
    expect(view).toContain("delay + (Self.reduceMotion ? 0 : Self.drawOnTime * 0.8)");
    expect(view).toContain("let fresh = animating && !drawnBefore.contains(mark.id)");
  });

  test("a page's marks hide while it moves and come back once it is still, and stop with the page", () => {
    const look = between(ink, "private func look() async {", "\n    }\n");
    expect(look.indexOf("if placed != seen {")).toBeLessThan(look.indexOf("ink.show(placed)"));
    expect(look).toContain("ink.hide(true)");
    expect(ink).toContain("try? await Task.sleep(for: .milliseconds(200))");
    expect(ink).toContain("guard let self else { return }");
    for (const view of ["private struct BridgedWebView: UIViewRepresentable {", "private struct LocalPageView: UIViewRepresentable {"]) {
      const body = between(sheet, view, "\n}\n");
      expect(body).toContain("context.coordinator.ink = ink.flatMap { PageInk(page: view, marks: $0.marks, entry: url, key: $0.key, agent: $0.agent) }");
      expect(body).toContain("coordinator.ink?.stop()");
    }
  });
});

describe("the sheet puts the ink where the review shows", () => {
  test("pages of every kind carry the ink; an image the agent marked shows it in place of Quick Look", () => {
    const content = between(sheet, "private var content: some View {", "private func webControls(");
    expect(content.match(/ink: ink/g)?.length).toBe(4);
    expect(content).toContain("if kind == .image, !imageMarks.isEmpty {");
    expect(content).toContain('MarkedImage(url: url, marks: imageMarks, agent: ink?.agent ?? "Claude", onFailure: fail)');
    // Markup draws on a copy of the image with none of the agent's ink: not offered while the ink shows.
    expect(sheet).toContain("case .local(.image): localURL != nil && failure == nil && imageMarks.isEmpty");
    expect(sheet).toContain('return InkSpec(marks: review.marks, key: review.id ?? review.link ?? "", agent: backend == "codex" ? "Codex" : "Claude")');
  });

  test("the new file is built into the app", () => {
    expect(project).toContain("/* AgentInkView.swift in Sources */ = {isa = PBXBuildFile;");
    expect(project.match(/\/\* AgentInkView\.swift in Sources \*\/,/g)?.length).toBe(1);
  });
});
