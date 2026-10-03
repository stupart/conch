import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mac = (file: string) => readFileSync(join(import.meta.dir, "..", "mac-app", "conch-mac", file), "utf8");
const composer = mac("ComposerView.swift");
const editor = mac("ComposerEditor.swift");

/** `makeNSView`, where the editor is built and its settings are set, from its signature to its return. */
function makeNSView(): string {
  const at = editor.indexOf("func makeNSView(context: Context) -> NSScrollView {");
  expect(at).toBeGreaterThan(-1);
  const end = editor.indexOf("\n    }\n", at);
  expect(end).toBeGreaterThan(at);
  return editor.slice(at, end);
}

/**
 * Underlines, never corrections. Tyler, 2026-10-04: "the spellcheck like deletes / changes what im typing sometimes".
 * The composer followed System Settings for autocorrect, which is on by default (his was unset, so on), and SwiftUI's
 * TextEditor turned it on in every update anyway: measured offscreen that day, with correction off in System Settings it
 * was on again from the second keystroke, because the re-apply that was meant to fix it never ran while typing. This
 * text lands in terminals and code, where a word replaced behind you is a command changed behind you: correction is off,
 * whatever the setting, as smart quotes and dashes already were. Continuous checking stays on, so typos are underlined
 * and right-click still offers the fixes. Text replacements are the person's own shortcuts, so they still follow theirs.
 * test/composer-editor-render.test.ts holds the real editor to all of this through many SwiftUI updates.
 */
test("the composer underlines typos and never corrects them, and never curls quotes", () => {
  const made = makeNSView();
  expect(made).toContain("view.isContinuousSpellCheckingEnabled = true");
  expect(made).toContain("view.isAutomaticSpellingCorrectionEnabled = false");
  expect(made).toContain("view.isAutomaticTextReplacementEnabled = NSSpellChecker.isAutomaticTextReplacementEnabled");
  expect(made).toContain("view.isAutomaticQuoteSubstitutionEnabled = false");
  expect(made).toContain("view.isAutomaticDashSubstitutionEnabled = false");
  // Not the person's correction setting: that is the default-on autocorrect that changed what Tyler typed.
  expect(editor).not.toContain("NSSpellChecker.isAutomaticSpellingCorrectionEnabled");
});

/**
 * Set once, as the editor is made, and nothing writes them after: it is conch's own text view now, so no SwiftUI update
 * can reach them, and none of conch's may either. The SwiftUI version needed `.autocorrectionDisabled(false)` to keep the
 * underlines and a per-update re-apply to undo what that did to correction; the re-apply never ran while typing.
 */
test("the spelling settings are written once, where the editor is made", () => {
  for (const flag of ["isContinuousSpellCheckingEnabled", "isAutomaticSpellingCorrectionEnabled", "isAutomaticTextReplacementEnabled",
    "isAutomaticQuoteSubstitutionEnabled", "isAutomaticDashSubstitutionEnabled"]) {
    expect(editor.match(new RegExp(`\\.${flag} =`, "g")) ?? [], flag).toHaveLength(1);
    expect(makeNSView(), flag).toContain(`.${flag} =`);
    expect(composer, flag).not.toContain(flag);
  }
  const update = editor.slice(editor.indexOf("func updateNSView("), editor.indexOf("func sizeThatFits("));
  expect(update.length).toBeGreaterThan(100);
  expect(update).not.toContain("Spell");
  expect(update).not.toContain("Substitution");
  // The SwiftUI editor and everything that fought it are gone.
  for (const gone of ["TextEditor(", ".autocorrectionDisabled(", "conchSpelling", "TextViewIntrospector", "introspectTextView"]) {
    expect(composer, gone).not.toContain(gone);
    expect(editor, gone).not.toContain(gone);
  }
});

/**
 * Built, never found. The introspector walked the window's view tree for "the editable NSTextView" a runloop turn after
 * SwiftUI made one, and measured offscreen it missed outright in some launches (1 in 12, then 4 in 10), leaving smart
 * quotes and dashes on. Before that it had configured a read-only document's text view instead (2026-09-21). The editor
 * now makes its own text view, and the dashboard's key monitor still tells it apart as the editable one.
 */
test("the composer builds its own text view rather than searching the window for one", () => {
  expect(makeNSView()).toContain("let view = ComposerTextView(usingTextLayoutManager: false)");
  expect(editor).toContain("final class ComposerTextView: NSTextView {");
  for (const gone of ["firstTextView(in:", "reach(from:", "probe.superview"]) {
    expect(composer, gone).not.toContain(gone);
    expect(editor, gone).not.toContain(gone);
  }
  const monitor = mac("DashboardInputMonitor.swift");
  expect(monitor).toContain("if let textView = responder as? NSTextView, textView.isEditable {");
});
