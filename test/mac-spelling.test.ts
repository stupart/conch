import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const composer = readFileSync(
  join(import.meta.dir, "..", "mac-app", "conch-mac", "ComposerView.swift"),
  "utf8",
);

/**
 * The Mac composer is a TextEditor, an NSTextView underneath, and nothing
 * turned spelling on, so typos went straight into sessions. Spell checking is
 * on; correction and text replacement follow the person's System Settings;
 * smart quotes and dashes stay off, because this text lands in terminals and
 * code. Markers are asserted present before slicing: `indexOf` gives -1 for a
 * missing one.
 */
test("the Mac composer checks spelling, follows the system's correction settings, and never curls quotes", () => {
  const at = composer.indexOf("func conchSpelling() -> some View {");
  expect(at).toBeGreaterThan(-1);
  const end = composer.indexOf("\n    }\n", at);
  expect(end).toBeGreaterThan(at);
  const body = composer.slice(at, end);
  expect(body).toContain("view.isContinuousSpellCheckingEnabled = true");
  expect(body).toContain(
    "view.isAutomaticSpellingCorrectionEnabled = NSSpellChecker.isAutomaticSpellingCorrectionEnabled",
  );
  expect(body).toContain(
    "view.isAutomaticTextReplacementEnabled = NSSpellChecker.isAutomaticTextReplacementEnabled",
  );
  expect(body).toContain("view.isAutomaticQuoteSubstitutionEnabled = false");
  expect(body).toContain("view.isAutomaticDashSubstitutionEnabled = false");

  // Applied to the editor itself, not defined and left unused.
  const editor = composer.indexOf("TextEditor(text: $draft)");
  expect(editor).toBeGreaterThan(-1);
  const chain = composer.slice(editor, composer.indexOf(".frame(height: fieldHeight)", editor));
  expect(chain).toContain(".conchSpelling()");
});

/**
 * Measured 2026-09-21 with a compiled probe running the app's own bridge code (extracted by line
 * range, not retyped): the flag above WAS set on the editor — and SwiftUI's TextEditor unset it
 * again on its next update, which every keystroke is. Disassembled, its
 * `AppKitTextEditorAdaptor.updateNSView` derives BOTH spelling flags from the autocorrection
 * environment: left unset, continuous checking is turned off; set, checking and correction are
 * turned on together. So the editor declares it, which makes SwiftUI keep the underlines on
 * itself, and the bridge re-applies the person's own correction setting after each update,
 * since that branch forces correction on. Once was measured to last until the first keystroke.
 */
test("SwiftUI is told to keep spelling on, and the bridge re-applies after every update", () => {
  const editor = composer.indexOf("TextEditor(text: $draft)");
  const chain = composer.slice(editor, composer.indexOf(".frame(height: fieldHeight)", editor));
  expect(chain).toContain(".autocorrectionDisabled(false)");

  const at = composer.indexOf("func conchSpelling() -> some View {");
  const body = composer.slice(at, composer.indexOf("\n    }\n", at));
  expect(body).toContain("introspectTextView(everyUpdate: true) { view in");

  // After the pass, not inside it: SwiftUI updates the same editor in the same pass, and which
  // sibling goes first is not ours to choose.
  const bridge = composer.indexOf("private struct TextViewIntrospector");
  const introspector = composer.slice(bridge, composer.indexOf("private extension View {", bridge));
  expect(introspector).toMatch(
    /guard everyUpdate, let textView = context\.coordinator\.textView else \{ return \}\s*DispatchQueue\.main\.async \{ configure\(textView\) \}/,
  );
  // Insets stay once-on-appear: restyling the whole draft and re-registering drag types on
  // every keystroke buys nothing, since SwiftUI leaves those alone.
  expect(composer).toMatch(/func conchTextViewInsets\(lineSpacing: CGFloat\) -> some View \{\s*introspectTextView \{ view in/);
});

/**
 * The walk ends at the window's content view and searches the whole tree from there. With a
 * read-only NSTextView created before the composer — a deliverable document beside the
 * conversation, or the transcript fallback under it — it found that one and configured it
 * instead, and the field you type in got nothing: no insets, no caret, no spelling (probe,
 * 2026-09-21: `reached NSTextView editable=false`).
 */
test("the bridge configures the editable text view, not the first one it meets", () => {
  expect(composer).toContain("if let textView = view as? NSTextView, textView.isEditable { return textView }");
});
