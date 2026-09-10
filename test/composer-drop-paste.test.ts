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
  const insets = composer.slice(composer.indexOf("func conchTextViewInsets()"));
  const body = insets.slice(0, insets.indexOf("\n    }\n"));
  expect(body).toContain(".fileURL");
  expect(body).toContain('NSPasteboard.PasteboardType("NSFilenamesPboardType")');
  expect(body).toContain("view.registeredDraggedTypes.filter");
  expect(body).toContain("view.unregisterDraggedTypes()");
  expect(body).toContain("view.registerForDraggedTypes(kept)");
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
  expect(body).toContain("editor.isDescendant(of: container)");
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
  // Image DATA is written to a temp PNG so it can be attached like a file.
  expect(body).toContain('appendingPathComponent("conch-paste-');
});

test("drop, paste and the picker share one append rule", () => {
  expect(composer).toContain("private func attach(_ urls: [URL])");
  expect(composer).toContain("Task { @MainActor in attach([url]) }");
  expect(composer).toContain(".background(ComposerPasteBridge { urls in attach(urls) })");
});
