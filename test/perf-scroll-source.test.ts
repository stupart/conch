import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Mac app sat at 30–48% CPU with sessions working (Tyler, 28 Sep: "scrolling is a bit glitchy in the app
 * generally and some tall vertical images in the deliverable / review area are blurry").
 *
 * Measured on the app's own views in an offscreen harness, over Tyler's published state replayed at the live
 * daemon's cadence: 11.9% of a core for the main window alone with eleven working rows, 1.1% with the same rows
 * waiting. The working halo was a TimelineView at 30 frames a second per row, and SwiftUI kept ticking every such
 * clock in a window that was ordered out or never shown. What replaced it, and the other wiring, is XCTested in
 * ConchDesign where it is logic (BreathTests, WindowVisibilityTests, FileStampTests, ImageDecodeTests); the apps have
 * no XCTest target, so their wiring is pinned here as source.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const flat = (text: string): string => text.replace(/\s+/g, " ");

/** The text from `start` up to `end`, both required, `end` after `start`. */
function slice(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing after it: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("animation clocks stop where nobody can see them", () => {
  const sources = [
    ...readdirSync(join(root, "design/ConchDesign/Sources/ConchDesign")).map((f) => `design/ConchDesign/Sources/ConchDesign/${f}`),
    ...readdirSync(join(root, "mac-app/conch-mac")).map((f) => `mac-app/conch-mac/${f}`),
  ].filter((f) => f.endsWith(".swift"));

  test("every TimelineView(.animation) pauses while its window is hidden (conchHidden)", () => {
    let clocks = 0;
    for (const file of sources) {
      const text = read(file);
      for (const match of text.matchAll(/TimelineView\(\.animation\(([^)]*)\)\)/g)) {
        clocks += 1;
        // `hidden` is the view's `@Environment(\.conchHidden)`, and it is in the clock's own `paused:`.
        expect(match[1], `${file}: ${match[0]}`).toMatch(/paused: [^)]*\bhidden\b/);
        expect(text, `${file} reads conchHidden`).toContain("@Environment(\\.conchHidden) private var hidden");
      }
    }
    // VoiceGlyph, Thinking, FogLookView, the setup spinner and PulseDot: a floor, so an empty scan cannot pass.
    expect(clocks).toBeGreaterThanOrEqual(5);
  });

  test("each window that is ordered out rather than torn down tells its content when it can't be seen", () => {
    // The main window, as its scene builds it.
    expect(flat(slice(read("mac-app/conch-mac/ConchMacApp.swift"), 'WindowGroup("conch") {', ".defaultSize("))).toContain(
      ".background(WindowBackgroundConfigurator()) // Its animation clocks stop while the window can't be seen: hidden behind others, minimised, on // another Space (`conchHidden`). .conchPausesWhenHidden()",
    );
    const panels = read("mac-app/conch-mac/FloatingPanels.swift");
    // The control bar and the conversation panel: `show(_:_:)` orders them out when turned off.
    expect(panels).toContain("if on { panel.orderFrontRegardless() } else { panel.orderOut(nil) }");
    for (const host of ["private struct ControlBarHost: View {", "private struct ConversationFogHost: View {"]) {
      const body = slice(panels, host, "\n}\n");
      expect(body.length, host).toBeGreaterThan(400);
      expect(body, host).toContain(".conchPausesWhenHidden()");
    }
    // Setup's window is kept when closed.
    expect(read("mac-app/conch-mac/OnboardingController.swift")).toContain(
      "window.contentView = NSHostingView(rootView: OnboardingRootView(model: model, controller: self).conchPausesWhenHidden())",
    );
  });

  test("the reader is AppKit's occlusion state, reported after the update that changed it", () => {
    const reader = read("design/ConchDesign/Sources/ConchDesign/WindowVisibility.swift");
    expect(reader).toContain("window?.occlusionState.contains(.visible) ?? false");
    expect(reader).toContain("forName: NSWindow.didChangeOcclusionStateNotification,");
    expect(reader).toContain(".environment(\\.conchHidden, hidden)");
    expect(reader).toContain("DispatchQueue.main.async { report(now) }");
  });
});

describe("the state poll decodes only after a publish", () => {
  test("StateSnapshotReader goes through ConchStampedRead, never straight to the decoder", () => {
    const reader = slice(read("mac-app/conch-mac/StateStore.swift"), "private actor StateSnapshotReader {", "\n}\n");
    expect(reader).toContain("private var snapshot = ConchStampedRead<PublishedState>()");
    expect(reader).toContain("snapshot: snapshot.value(at: url.path) { StateSnapshotFile.read(from: url) },");
    expect(reader.match(/StateSnapshotFile\.read\(/g)?.length).toBe(1);
  });
});

describe("deliverable pictures are decoded for the width they are drawn at", () => {
  const review = read("mac-app/conch-mac/ReviewView.swift");
  const viewer = slice(review, "private struct DeliverableImageView: NSViewRepresentable {", "final class DeliverablePictureView: NSView {");

  test("the Mac viewer decodes at its drawn width in device pixels, again when that grows, never mid-resize", () => {
    expect(viewer).toContain("decodeIfNeeded(forWidth: targetWidth * scale)");
    expect(viewer).toContain("private var scale: CGFloat { window?.backingScaleFactor ?? 2 }");
    expect(viewer).toContain("ConchImage.decode(picture, forWidth: CGFloat(wanted))");
    expect(viewer).toContain("let wanted = ConchImage.decodeWidth(forDrawnWidth: width, of: picture.pixels)");
    // Grows past the decode, or falls under half of it: decoded again. A pixel short from ImageIO's rounding is not.
    expect(viewer).toContain("if let have, have >= wanted, have <= 2 * wanted { return }");
    expect(viewer).toContain("if let have, have >= wanted - 1, have <= wanted { return }");
    expect(viewer).toContain("guard let picture, !inLiveResize else { return }");
    // A divider dragged a few points a frame decodes once it stops, not once a frame.
    expect(viewer).toContain("let settle = decoded != nil");
    expect(viewer).toContain("try? await Task.sleep(for: .milliseconds(150))");
    expect(viewer).toContain("override func viewDidEndLiveResize() {");
    expect(viewer).toContain("override func viewDidChangeBackingProperties() {");
    // Off the main thread, and only applied if it is still this picture.
    expect(viewer).toContain("await Task.detached(priority: .userInitiated) {");
    expect(viewer).toContain("guard !Task.isCancelled, let self, self.picture?.key == picture.key else { return }");
  });

  test("it is drawn a pixel to a pixel: at the decode's own width, on the pixel grid", () => {
    expect(viewer).toContain("if let decoded, abs(CGFloat(decoded.width) / scale - targetWidth) <= 1 / scale + 0.001 {");
    expect(viewer).toContain("targetWidth = CGFloat(decoded.width) / scale");
    expect(viewer).toContain("height = CGFloat(decoded.height) / scale");
    expect(viewer).toContain("imageView.frame = container.backingAlignedRect(NSRect(");
    // Laid out by the picture's own point size, as NSImage read it: nothing upscales, as before.
    expect(viewer).toContain("var targetWidth = min(paneWidth - 36, size.width)");
    expect(viewer).toContain("picture?.points ?? whole?.size");
  });

  test("a GIF keeps AppKit's own view, which plays it", () => {
    expect(viewer).toContain('let moves = url.pathExtension.lowercased() == "gif"');
    const picture = slice(review, "final class DeliverablePictureView: NSView {", "private struct ReviewPressButtonStyle");
    expect(picture).toContain("appKit.image = image");
    expect(picture).toContain("picture.contents = image");
  });

  test("the conversation's deliverable card never reads or decodes its picture in body", () => {
    const stack = read("mac-app/conch-mac/ConversationStackView.swift");
    const card = slice(stack, "private struct ArtifactPreview: View {", "private var symbol: String {");
    expect(card).not.toContain("NSImage(contentsOfFile:");
    expect(card).not.toContain("NSImage(contentsOf:");
    expect(card).toContain("return ConchImage.picture(atPath: link)");
    expect(card).toContain(".task(id: picture.key) {");
    expect(card).toContain("ConchImage.decode(picture, maxPixelSize: size)");
    expect(card).toContain("return ConchImage.decoded(picture, maxPixelSize: Self.maxPixelSize).map { NSImage(cgImage: $0, size: .zero) }");
  });

  test("the phone decodes a picture in a document, and a marked one, to a width too", () => {
    const sheet = read("mobile/conch-ios/conch-ios/DeliverableSheet.swift");
    const markdown = slice(sheet, "private struct MarkdownImage: View {", "struct FolderDeliverableView: View {");
    expect(markdown).toContain("forWidth: ImageDownsampler.screenPixels)");
    expect(markdown).not.toContain("maxPixelSize: 2048");
    expect(read("mobile/conch-ios/conch-ios/AgentInkView.swift")).toContain(
      "ImageDownsampler.filePreview(at: url, maxBytes: 64 * 1024 * 1024, forWidth: 4_096)",
    );
    const downsampler = read("mobile/conch-ios/conch-ios/ImageUpload.swift");
    expect(downsampler).toContain(
      "ConchImage.longEdge(forWidth: ConchImage.decodeWidth(forDrawnWidth: widthPixels, of: size, budget: budget), of: size)",
    );
    expect(downsampler).toContain("let image = thumbnail(source: source, maxPixelSize: longEdge(size))");
  });
});
