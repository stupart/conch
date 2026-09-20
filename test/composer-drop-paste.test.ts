import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const composer = readFileSync(
  join(import.meta.dir, "..", "mac-app", "conch-mac", "ComposerView.swift"),
  "utf8",
);

/**
 * A dropped file must reach the composer, not the editor.
 *
 * NSTextView registers for file drops and inserts the PATH as text, and it is
 * the deeper view under the pointer, so it won every drop on the text area —
 * two dragged screenshots became two paths in the message. The fix strips only
 * the file types from its registration; text drags still work.
 */
test("the editor stops accepting file drops, and keeps everything else", () => {
  const insets = composer.slice(composer.indexOf("func conchTextViewInsets("));
  const body = insets.slice(0, insets.indexOf("\n    }\n"));
  expect(body).toContain(".fileURL");
  expect(body).toContain('NSPasteboard.PasteboardType("NSFilenamesPboardType")');
  // Images too, now the composer accepts image BYTES: a rich-text NSTextView registers for
  // them and draws a dragged image inline, so accepting the drop without refusing it here
  // hands it straight back to the editor — the pasted-paths loss in a different shape.
  expect(body).toContain(".png, .tiff,");
  expect(body).toContain("view.registeredDraggedTypes.filter");
  expect(body).toContain("view.unregisterDraggedTypes()");
  expect(body).toContain("view.registerForDraggedTypes(kept)");
});

/**
 * A drag out of Finder carries a file URL and always worked. A drag from a browser, Preview,
 * Photos or Messages carries image BYTES and matched nothing, so the drop was refused with no
 * feedback — the target never even lit, which is why it read as "doesn't seem to work".
 */
test("a dropped image is attached whether it is a file or bytes", () => {
  expect(composer).toContain(".onDrop(of: [.fileURL, .image], isTargeted: $isTargetedForDrop)");
  const load = composer.slice(composer.indexOf("private func load(_ providers: [NSItemProvider])"));
  const body = load.slice(0, load.indexOf("\n    }\n"));
  // The file shape.
  expect(body).toContain("provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)");
  // A promised file can arrive as a URL with nothing written behind it yet.
  expect(body).toContain("FileManager.default.fileExists(atPath: url.path)");
  // The bytes shape, asked by CONFORMANCE: a provider registers the concrete type it holds
  // (`public.png`), and asking it for the abstract parent is not guaranteed to transcode.
  expect(body).toContain("provider.registeredTypeIdentifiers.first(where: {");
  expect(body).toContain("UTType($0)?.conforms(to: .image) == true");
  expect(body).toContain("provider.loadDataRepresentation(forTypeIdentifier: type)");
});

/**
 * One way to turn pixels into an attachable file. Paste and drop both arrive holding bytes and
 * no file; writing that out twice is how the two come to disagree about format or naming.
 */
test("paste and drop write their temp file the same way", () => {
  expect(composer).toContain("static func temporaryPNG(_ image: NSImage, prefix: String) -> URL?");
  // The name is built FROM the prefix, which is what makes a temp file say which door it came
  // through — the only thing it can tell you after the fact.
  expect(composer).toContain('appendingPathComponent("\\(prefix)-\\(UUID().uuidString).png")');
  expect(composer).toContain('temporaryPNG(image, prefix: "conch-paste")');
  expect(composer).toContain('ComposerPasteBridge.temporaryPNG(image, prefix: "conch-drop")');
  // The transcode lives in one place now, not in each caller.
  expect(composer.match(/representation\(using: \.png, properties: \[:\]\)/g) ?? []).toHaveLength(1);
});

/**
 * Cmd+V with an image on the clipboard becomes an attachment — and only then.
 *
 * Plain text must fall through to the editor's own paste (the monitor returns
 * the event); an image is consumed (the monitor returns nil). The monitor is
 * gated on this window and on the composer's own editor being first
 * responder, and it is removed with the view so a re-render cannot stack two.
 */
test("Cmd+V attaches images and leaves text to the editor", () => {
  const bridge = composer.slice(composer.indexOf("private struct ComposerPasteBridge"));
  const body = bridge.slice(0, bridge.indexOf("\n}\n"));
  expect(body).toContain('event.charactersIgnoringModifiers?.lowercased() == "v"');
  expect(body).toContain("== .command");
  expect(body).toContain("let editor = window.firstResponder as? NSTextView");
  // Which editor is "this composer's" is answered by walking UP from the probe until an ancestor holds it, rather
  // than by a fixed number of superviews: `.background(...)`'s nesting is SwiftUI's business, and pinning a depth
  // made the check fail closed — Cmd+V fell through to the text view's text-only paste and a pasted image vanished
  // with nothing on screen to say so (Tyler: "images I paste into the input box don't show previews so idk if the
  // past worked or not").
  expect(body).toContain("coordinator.sharesAnAncestor(with: editor)");
  // Text: pass through. Image: consume.
  expect(body).toContain("guard !urls.isEmpty else { return event }");
  expect(body).toContain("coordinator.onPaste(urls)\n            return nil");
  // Torn down with the view — pinned INSIDE dismantleNSView, because the
  // Coordinator's deinit also calls removeMonitor and would have satisfied a
  // looser check while the dismantle path leaked. A mutation proved it.
  const dismantleAt = body.indexOf("static func dismantleNSView");
  expect(dismantleAt).toBeGreaterThan(-1);
  const dismantle = body.slice(dismantleAt, body.indexOf("\n    }", dismantleAt));
  expect(dismantle).toContain("NSEvent.removeMonitor(monitor)");
  // Image DATA is written to a temp PNG so it can be attached like a file. The write itself
  // moved into `temporaryPNG(_:prefix:)`, shared with the drop path — so what is pinned here is
  // that PASTE still goes through it under its own name; the shared helper's naming is pinned
  // where it lives, in "paste and drop write their temp file the same way".
  expect(body).toContain('temporaryPNG(image, prefix: "conch-paste")');
});

test("drop, paste and the picker share one append rule", () => {
  expect(composer).toContain("private func attach(_ urls: [URL])");
  expect(composer).toContain("Task { @MainActor in attach([url]) }");
  expect(composer).toContain(".background(ComposerPasteBridge { urls in attach(urls) })");
});
