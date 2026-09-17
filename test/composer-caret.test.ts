import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const composer = readFileSync(
  join(import.meta.dir, "..", "mac-app", "conch-mac", "ComposerView.swift"),
  "utf8",
);

/**
 * The caret sits on the same line as the words.
 *
 * Tyler, with a screenshot: "see how the cursor isn't lined up with the preview text?"
 *
 * `#ta{...font:var(--read)/22px...}` is 15 pt of type plus 4 pt of leading — the same
 * `ConchType.readingLineSpacing` the transcript uses, so the composer and the messages it
 * answers cannot drift apart.
 *
 * It must be lineSpacing, NOT min/maxLineHeight. CSS splits a line box's extra leading half
 * above and half below; AppKit puts ALL of it above the baseline. Measured against a real
 * NSTextView:
 *
 *     no paragraph style   caret 18 pt, text ink at 4 pt
 *     min/max 22           caret 22 pt, text ink at 8 pt   <- an earlier fix, and wrong
 *     lineSpacing 4        caret 18 pt, text ink at 4 pt
 *
 * The placeholder, top-aligned in the same box, draws at 4 pt. The middle row is what shipped
 * first and what Tyler saw twice: "the cursor in the text input box still isn't lined up".
 */
test("the editor lays its text out in the lab's 22 pt line box", () => {
  const insets = composer.slice(composer.indexOf("func conchTextViewInsets("));
  const body = insets.slice(0, insets.indexOf("\n    }\n"));
  expect(body).toContain("paragraph.lineSpacing = lineSpacing");
  // A line box is the wrong tool: AppKit hangs its extra leading above the baseline, so this
  // is what pushed the text down and grew the caret the first time.
  expect(body).not.toContain("minimumLineHeight");
  expect(body).not.toContain("maximumLineHeight");
  // Both, or only one of them is right: `defaultParagraphStyle` styles what is laid out,
  // `typingAttributes` styles what is typed next.
  expect(body).toContain("view.defaultParagraphStyle = paragraph");
  expect(body).toContain("view.typingAttributes[.paragraphStyle] = paragraph");
  // A draft restored into the field was laid out before this ran: switching to a session
  // with a saved draft styles the text only if this branch can actually be entered. Asserting
  // the call alone let `storage.length < 0` through mutation testing — the call was still
  // there, it simply could never run.
  expect(body).toContain("if let storage = view.textStorage, storage.length > 0 {");
  expect(body).toContain("storage.addAttribute(");
  expect(body).toContain("range: NSRange(location: 0, length: storage.length)");
  // The line box comes from the one constant the lab's `22px` is already pinned to.
  expect(composer).toContain(".conchTextViewInsets(lineSpacing: ConchType.readingLineSpacing)");
  expect(composer).toContain("static let lineHeight: CGFloat = 22");
  // Inside a `View` extension this name belongs to SwiftUI's own modifier, so reaching for
  // the struct's constant there is a compile error, not a wrong value. Asserted against the
  // CODE forms only — the comment above the function says `ComposerView.lineHeight` in order
  // to explain the trap, and a file-wide sweep would match that prose and fail on it.
  expect(composer).not.toContain("= ComposerView.lineHeight");
  expect(composer).not.toContain("(ComposerView.lineHeight");
  // The constant still bounds the field at one line and at eight — `#ta{max-height:22*8+12}`.
  expect(composer).toContain("min(Self.lineHeight * 8, max(Self.lineHeight, measured))");
});

test("the placeholder sits where the first typed line will", () => {
  const field = composer.slice(composer.indexOf("if draft.isEmpty {"));
  const body = field.slice(0, field.indexOf(".allowsHitTesting(false)"));
  expect(body).toContain('Text(noTerminal ?? "Message \\(sessionLabel)")');
  expect(body).toContain(".font(ConchType.readingBody)");
  // Top, not centre: the editor lays its first line at the top of the box, and centring in
  // `fieldHeight` drifts further from it the taller a draft grows.
  expect(body).toContain(".frame(height: fieldHeight, alignment: .topLeading)");
  expect(body).not.toContain(".frame(height: fieldHeight, alignment: .leading)");
  // The same insets as the editor, so one line sits in one place either way.
  expect(body).toContain(".padding(.top, Self.fieldInsetTop)");
  expect(body).toContain(".padding(.horizontal, Self.fieldInsetX)");
});

/**
 * Dictation lands where typing lands.
 *
 * `#cLive{padding:8px 10px 4px;font:var(--read)/22px var(--sans)}` — the lab gives the live
 * transcription line the editor's own font and the editor's own insets, because this text
 * becomes that text. The app drew it at 12.5 with 6/8 padding, so the words changed size and
 * jumped position at the moment transcription landed.
 */
test("the dictation line sits exactly where the editor's text does", () => {
  const live = composer.slice(composer.indexOf("if !dictation.isEmpty {"));
  const body = live.slice(0, live.indexOf("} else {"));
  expect(body).toContain(".font(ConchType.readingBody)");
  expect(body).not.toContain("ConchTypography.font(size: 12.5)");
  expect(body).toContain(".padding(.top, Self.fieldInsetTop)");
  expect(body).toContain(".padding(.bottom, Self.fieldInsetBottom)");
  expect(body).toContain(".padding(.horizontal, Self.fieldInsetX)");
  expect(body).not.toContain(".padding(.vertical, 6)");
  expect(body).not.toContain(".padding(.horizontal, 8)");
});

/**
 * The field grows by what it draws.
 *
 * `fieldHeight` measured the draft at `systemFont(ofSize: 12.5)` — line height 15 — while the
 * editor renders `ConchType.readingBody` (system 15) in a 22 pt box. Every wrapped line was
 * measured 7 pt short, so the box grew less than the text it had to hold.
 */
test("the field measures the font it renders, in the line box it renders it in", () => {
  const height = composer.slice(composer.indexOf("private var fieldHeight: CGFloat {"));
  const body = height.slice(0, height.indexOf("\n    }"));
  expect(body).toContain("NSFont.systemFont(ofSize: 15)");
  expect(body).not.toContain("NSFont.systemFont(ofSize: 12.5)");
  // Measured with the same leading it is drawn with, or the box is sized against a different
  // shape from the one on screen.
  expect(body).toContain("paragraph.lineSpacing = ConchType.readingLineSpacing");
  expect(body).toContain("attributes: [.font: font, .paragraphStyle: paragraph]");
  // Still bounded at eight lines, and never shorter than one.
  expect(body).toContain("min(Self.lineHeight * 8, max(Self.lineHeight, measured))");
});
