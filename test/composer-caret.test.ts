import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const composer = read("mac-app/conch-mac/ComposerView.swift");
const editor = read("mac-app/conch-mac/ComposerEditor.swift");
const editing = read("design/ConchDesign/Sources/ConchDesign/ComposerEditing.swift");

/** `makeNSView`, where the editor is built, from its signature to its return. */
function makeNSView(): string {
  const at = editor.indexOf("func makeNSView(context: Context) -> NSScrollView {");
  expect(at).toBeGreaterThan(-1);
  const end = editor.indexOf("\n    }\n", at);
  expect(end).toBeGreaterThan(at);
  return editor.slice(at, end);
}

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
 *
 * Every character carries it now, typed, restored or put there from outside: measured offscreen on
 * 2026-10-04, the SwiftUI editor laid typed lines out 18 pt apart, without it, while the field was
 * sized as if they had it.
 */
test("the editor lays its text out in the lab's 22 pt line box", () => {
  const paragraph = editor.slice(editor.indexOf("static let paragraph: NSParagraphStyle = {"));
  const body = paragraph.slice(0, paragraph.indexOf("}()"));
  expect(body).toContain("paragraph.lineSpacing = ConchType.readingLineSpacing");
  // A line box is the wrong tool: AppKit hangs its extra leading above the baseline, so this
  // is what pushed the text down and grew the caret the first time.
  expect(editor).not.toContain("minimumLineHeight");
  expect(editor).not.toContain("maximumLineHeight");
  expect(editor).toContain("[.font: font, .foregroundColor: ink, .paragraphStyle: paragraph]");
  // Both, or only one of them is right: `defaultParagraphStyle` styles what is laid out,
  // `typingAttributes` styles what is typed next.
  const made = makeNSView();
  expect(made).toContain("view.defaultParagraphStyle = Self.paragraph");
  expect(made).toContain("view.typingAttributes = Self.attributes");
  // A draft already there when the field is built, and every change from outside, carry the same attributes.
  expect(made).toContain("view.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: Self.attributes))");
  expect(editor).toContain("storage.replaceCharacters(in: edit.range, with: NSAttributedString(string: edit.replacement, attributes: ComposerEditor.attributes))");
  // Emptied, a text view forgets its typing style; it is put back after every outside change.
  expect(editor.match(/view\.typingAttributes = ComposerEditor\.attributes/g) ?? []).toHaveLength(2);
  // The line box is the one constant the lab's `22px` is pinned to, one line to eight — `#ta{max-height:22*8+12}`.
  expect(editing).toContain("public static let lineHeight: CGFloat = 22");
  expect(editing).toContain("public static let maxLines = 8");
  expect(editing).toContain("min(lineHeight * CGFloat(maxLines), max(lineHeight, ceil(used + lineSpacing)))");
  expect(composer).toContain("private static let lineHeight = ComposerEditing.lineHeight");
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
 * half: the words do not move by a pixel, and only the caret does. test/composer-editor-render.test.ts
 * measures it on the real editor: typed words on the placeholder's own rows, the caret over them.
 */
test("the caret is moved by the baseline, and the words are put back", () => {
  expect(editor).toContain("final class ComposerCaretBaseline: NSObject, NSLayoutManagerDelegate {");
  expect(editor).toContain("baselineOffset.pointee -= ConchType.readingLineSpacing / 2");
  // Half the leading, taken from the one constant the lab's 22 px is already pinned to.
  expect(composer).toContain("static let caretRaise: CGFloat = ConchType.readingLineSpacing / 2");
  // On the editor's own TextKit 1 layout manager, from the moment it is made.
  expect(makeNSView()).toContain("view.layoutManager?.delegate = ComposerCaretBaseline.shared");
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
 * A draft that is already in the field when it is built sits on the placeholder's line too.
 *
 * The delegate only moves glyphs laid out after it is installed. When the introspector installed it, a
 * draft restored at launch, or found on coming back to its session, had been laid out first, and sat
 * 2 pt under the placeholder until a keystroke laid it out again (measured 2026-09-28: ink 79..107 px
 * against 75..103), so it had to be invalidated. The editor now installs the delegate before the draft
 * goes in, on a text view that is TextKit 1 from the start, and the render test measures a restored
 * draft on the same rows as typed words.
 */
test("a draft already there is laid out under the caret delegate from the start", () => {
  const made = makeNSView();
  expect(made).toContain("let view = ComposerTextView(usingTextLayoutManager: false)");
  const delegate = made.indexOf("view.layoutManager?.delegate = ComposerCaretBaseline.shared");
  const draft = made.indexOf("view.textStorage?.setAttributedString(");
  expect(delegate).toBeGreaterThan(-1);
  expect(draft).toBeGreaterThan(delegate);
});

/**
 * TextKit 1 from creation, never switched under a live view.
 *
 * The introspector put SwiftUI's editor on TextKit 1 by reading its `layoutManager`, which AppKit
 * answers by switching the view over: measured offscreen on 2026-10-04, 92 ms after it was built
 * and laid out on TextKit 2, with SwiftUI's adaptor attached. The caret's seam is a layout
 * manager's, so the editor asks for TextKit 1 when it makes the view, and nothing reaches in after.
 */
test("the editor is TextKit 1 from creation, and nothing switches it later", () => {
  expect(makeNSView()).toContain("ComposerTextView(usingTextLayoutManager: false)");
  expect(editor.match(/usingTextLayoutManager:/g) ?? []).toHaveLength(1);
  expect(composer).not.toContain("layoutManager");
  expect(composer).not.toContain("NSTextView(");
});

test("the placeholder sits where the first typed line will", () => {
  const field = composer.slice(composer.indexOf("if draft.isEmpty {"));
  const body = field.slice(0, field.indexOf(".allowsHitTesting(false)"));
  expect(body).toContain('Text(messageUnavailableReason ?? "Message \\(sessionLabel)")');
  expect(body).toContain(".font(ConchType.readingBody)");
  // Top, not centre: the editor lays its first line at the top of the box. It shows only while
  // the draft is empty, when the field is one line.
  expect(body).toContain(".frame(height: Self.lineHeight, alignment: .topLeading)");
  expect(body).not.toContain("alignment: .leading)");
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
  // The editor's own font is the same reading size.
  expect(editor).toContain("static let font = NSFont.systemFont(ofSize: ConchType.readingBodySize)");
});

/**
 * The field grows by what it draws.
 *
 * It was measured beside the editor: `boundingRect` at a width read off a GeometryReader, in
 * attributes typed out a second time. That measured at 12.5 pt once, every wrapped line 7 pt short,
 * and on 2026-10-04 six wrapped lines at 128 pt held text laid out 108 tall. Now the editor answers
 * SwiftUI's size question itself, laying its own text out (its own attributes, its own typesetter)
 * at the width it is offered.
 */
test("the field is as tall as its own text lays out at the width it is given", () => {
  expect(editor).toContain("func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {");
  expect(editor).toContain("return CGSize(width: width, height: context.coordinator.height(at: width))");
  expect(editor).toContain("return measure.height(of: storage, at: width)");
  const measure = editor.slice(editor.indexOf("private final class Measure {"));
  const body = measure.slice(0, measure.indexOf("\n}\n"));
  expect(body).toContain("storage.setAttributedString(text)");
  expect(body).toContain("container.size = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)");
  expect(body).toContain("ComposerEditing.height(used: layout.usedRect(for: container).height, lineSpacing: ConchType.readingLineSpacing)");
  expect(body).toContain("container.lineFragmentPadding = 0");
  // Nothing measures beside it any more.
  for (const gone of ["fieldHeight", "fieldWidth", "boundingRect", "GeometryReader"]) expect(composer, gone).not.toContain(gone);
});
