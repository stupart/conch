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
