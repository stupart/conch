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

/**
 * The caret straddles the words instead of riding above them.
 *
 * Tyler: the cursor "rides high". Measured off the running app at 2x, focused and empty: the
 * caret's ink spans 108..143 while the placeholder's spans 115..142 — 7 px of caret above the
 * words and 1 px below them.
 *
 * The leading is not what does it. AppKit draws the caret to the LINE FRAGMENT, whose top is the
 * font's ascent, and the reading font clears the cap line by 3.9 pt up top while its descent only
 * just clears the descender. Every seam nearer the caret was probed against a real NSTextView
 * first, and none of them move it:
 *
 *     drawInsertionPoint(in:color:turnedOn:)   never called — TextKit 2's caret is a subview
 *     that subview's bounds / layer transform  AppKit rewrites both on the next keystroke
 *     .baselineOffset on the text              absorbed by the typesetter under BOTH TextKits
 *     the layout manager delegate, TextKit 1   glyph ink 72..99 -> 68..95, caret 64..99 unmoved
 *
 * So the glyphs rise half the leading inside the fragment and the editor slides down by that same
 * half: the words do not move by a pixel, and only the caret does.
 */
test("the caret is moved by the baseline, and the words are put back", () => {
  expect(composer).toContain(
    "private final class ComposerCaretBaseline: NSObject, NSLayoutManagerDelegate {",
  );
  expect(composer).toContain("baselineOffset.pointee -= ConchType.readingLineSpacing / 2");
  // Half the leading, taken from the one constant the lab's 22 px is already pinned to.
  expect(composer).toContain("static let caretRaise: CGFloat = ConchType.readingLineSpacing / 2");
  // Installed on the editor — which is also what puts the view back on TextKit 1, the point of
  // reading `layoutManager` at all.
  const insets = composer.slice(composer.indexOf("func conchTextViewInsets("));
  const body = insets.slice(0, insets.indexOf("\n    }\n"));
  expect(body).toContain("view.layoutManager?.delegate = ComposerCaretBaseline.shared");
  // The editor trades the same 2 pt between its top and bottom inset. Raising the glyphs without
  // sliding the editor back down would move every word instead of the caret, which is exactly
  // the mistake #303 shipped.
  expect(composer).toContain(".padding(.top, Self.fieldInsetTop + Self.caretRaise)");
  expect(composer).toContain(".padding(.bottom, Self.fieldInsetBottom - Self.caretRaise)");
  // The placeholder is NOT compensated: it is a SwiftUI Text whose glyphs never rose, so giving
  // it the editor's padding would push it 2 pt off the line it exists to preview.
  const field = composer.slice(composer.indexOf("if draft.isEmpty {"));
  const placeholder = field.slice(0, field.indexOf(".allowsHitTesting(false)"));
  expect(placeholder).toContain(".padding(.top, Self.fieldInsetTop)");
  expect(placeholder).not.toContain("caretRaise");
});

/**
 * The reach into the editor cannot depend on how deeply SwiftUI nests a background.
 *
 * The leading, the caret, the spell checking and the drag types all arrive through one
 * `DispatchQueue.main.async` that used to hop exactly two superviews up from its probe and give
 * up silently. Measured in a harness around a real TextEditor, that hop came up empty in 6
 * launches out of 14. A miss is invisible and total: the editor keeps SwiftUI's own 5 pt
 * lineFragmentPadding, gets no leading, no caret fix, no spelling, and a dropped file lands as a
 * path.
 */
test("the introspector finds the editor whatever the nesting, and tries again if it is early", () => {
  // The reach itself, not how `configure` is handed to it: the closure now also records the
  // editor it found, so the spelling settings can be put back after each SwiftUI update
  // (mac-spelling.test.ts). The up-walk, the ten attempts and the bounded retry are the
  // invariant here, and they are unchanged.
  expect(composer).toMatch(/Self\.reach\(from: probe, attempts: 10\) \{ textView in/);
  expect(composer).toContain("if let textView = firstTextView(in: next) {");
  // Up from the probe, not a hard-coded hop.
  expect(composer).toContain("ancestor = next.superview");
  expect(composer).not.toContain("probe.superview?.superview");
  // It stops at the window rather than walking out of it.
  expect(composer).toContain("if next === next.window?.contentView { break }");
  // And it looks again next turn when the tree is not up yet — bounded, so a composer that never
  // appears cannot spin forever.
  expect(composer).toContain(
    "if attempts > 1 { reach(from: probe, attempts: attempts - 1, configure: configure) }",
  );
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
