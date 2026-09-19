import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mac = (file: string) =>
  readFileSync(join(import.meta.dir, "..", "mac-app", "conch-mac", file), "utf8");

const composer = mac("ComposerView.swift");
const palette = mac("Palette.swift");

/**
 * An attached image looks like the lab's, or it looks crooked.
 *
 * Tyler: "uploaded image ui looks wack and out of alignemnt".
 *
 * `#cAtt{display:flex;gap:6px;padding:6px 6px 2px;flex-wrap:wrap}`
 * `.att{position:relative;height:52px;border-radius:9px;box-shadow:inset 0 0 0 .5px var(--hair2)}`
 * `.att.img{width:68px}`
 *
 * The app drew 54x44 tiles at radius 6 inside a strip capped at `maxHeight: 48` — a different
 * shape from the lab in both dimensions, clipped by its own container.
 */
/**
 * A pasted image must actually attach, or it vanishes with nothing on screen to say so.
 *
 * Tyler: "images I paste into the input box don't show previews so idk if the past worked or not".
 *
 * The bridge decides whether the focused editor is THIS composer's. It used to walk a fixed two
 * superviews up from its probe and require the editor to be inside that — which hard-codes how
 * deeply SwiftUI nests `.background(...)`. One wrapper more or less and the check fails closed:
 * Cmd+V falls through to NSTextView's own paste, which knows only text, and the image is dropped.
 * Walking up until an ancestor holds the editor does not care about the depth.
 */
test("a pasted image finds its composer whatever the view nesting is", () => {
  expect(composer).toContain("coordinator.sharesAnAncestor(with: editor)");
  expect(composer).toContain("func sharesAnAncestor(with editor: NSView) -> Bool {");
  expect(composer).toContain("if editor.isDescendant(of: next) { return true }");
  // It stops at the window rather than walking out of it.
  expect(composer).toContain("if next === next.window?.contentView { return false }");
  // The brittle fixed-depth hop is gone for good.
  expect(composer).not.toContain("probe?.superview?.superview");
  // Image DATA still becomes a file so it attaches like any other.
  expect(composer).toContain("static func imageAttachments(on pasteboard: NSPasteboard) -> [URL] {");
});

test("an image attachment is the lab's tile", () => {
  const preview = composer.slice(composer.indexOf("private struct AttachmentPreview"));
  const body = preview.slice(0, preview.indexOf("private var removeButton"));
  expect(body).toContain(".frame(width: 68, height: 52)");
  expect(body).toContain("RoundedRectangle(cornerRadius: 9, style: .continuous)");
  expect(body).toContain(".strokeBorder(ConchPalette.hairlineStrong, lineWidth: 0.5)");
  expect(body).not.toContain(".frame(width: 54, height: 44)");
  expect(body).not.toContain("RoundedRectangle(cornerRadius: 6)");
});

/**
 * `.att.fl{display:flex;align-items:center;gap:8px;padding:0 30px 0 10px;background:var(--fill);
 * font-size:12.5px;max-width:220px}` — and the same 52 height as an image tile, so a file and
 * a picture in one strip sit on one line instead of two different heights.
 */
test("a file attachment is the same height as a picture", () => {
  const preview = composer.slice(composer.indexOf("private struct AttachmentPreview"));
  const body = preview.slice(0, preview.indexOf("private var removeButton"));
  expect(body).toContain(".frame(height: 52)");
  expect(body).toContain(".frame(maxWidth: 220)");
  expect(body).toContain(".padding(.leading, 10)");
  expect(body).toContain(".padding(.trailing, 30)");
  expect(body).toContain("HStack(spacing: 8)");
  expect(body).toContain("ConchTypography.font(size: 12.5)");
  expect(body).toContain(".fill(ConchPalette.fill)");
});

/**
 * `.att .x{top:4px;right:4px;width:18px;height:18px;border-radius:50%;
 * background:rgba(29,29,31,.62);color:#fff}` — it was 14x14 on the window ground at 88%,
 * which over a pale screenshot is a grey dot on a grey picture.
 */
test("the remove button is the lab's 18pt disc, in its own ink", () => {
  const button = composer.slice(composer.indexOf("private var removeButton"));
  const body = button.slice(0, button.indexOf("\n    }\n"));
  expect(body).toContain(".frame(width: 18, height: 18)");
  expect(body).toContain(".foregroundStyle(.white)");
  expect(body).toContain("opacity(0.62)");
  expect(body).not.toContain(".frame(width: 14, height: 14)");
  expect(body).not.toContain("ConchPalette.bg.opacity(0.88)");
});

/**
 * The strip holds 52 pt tiles, so it cannot be 48 pt tall.
 * `#cAtt{gap:6px;padding:6px 6px 2px}`.
 */
test("the strip is not shorter than the tiles it holds", () => {
  const strip = composer.slice(composer.indexOf("private struct AttachmentStrip"));
  const body = strip.slice(0, strip.indexOf("\n}\n"));
  expect(body).toContain("HStack(spacing: 6)");
  expect(body).toContain(".padding(.top, 6)");
  expect(body).toContain(".padding(.horizontal, 6)");
  expect(body).toContain(".padding(.bottom, 2)");
  expect(body).not.toContain(".frame(maxHeight: 48)");
});

/**
 * A drop target has one job: to say "here".
 *
 * `.cbox.drop{box-shadow:0 0 0 2px #0A84FF,var(--shFloat)}` — 2 pt, the system drop blue, on
 * the CARD. The app drew a 1.5 pt cyan rect at radius 8 AFTER the card's 16 pt padding, so it
 * floated off the card's edge at the wrong radius, in the colour used for the microphone.
 * Tyler: "just tried dropping an image, process was kinda weird, and idk if it worked or not".
 */
test("the drop ring is on the card, at the card's radius, in the drop colour", () => {
  expect(composer).toContain("if isTargetedForDrop {");
  expect(composer).toContain(".strokeBorder(ConchPalette.dropTarget, lineWidth: 2)");
  // The ring and the card must be the same shape, or it reads as a second object.
  const ring = composer.slice(composer.indexOf("if isTargetedForDrop {"));
  const body = ring.slice(0, ring.indexOf("\n        }"));
  expect(body).toContain("RoundedRectangle(cornerRadius: ConchRadius.large, style: .continuous)");
  expect(composer).not.toContain(".strokeBorder(ConchPalette.brandCyan, lineWidth: 1.5)");
  // #0A84FF, hard-coded in the lab rather than following the system accent: a drop target
  // that changes colour per person is not a signal.
  expect(palette).toContain("static let dropTarget = Color(red: 0.039, green: 0.518, blue: 1)");
});
