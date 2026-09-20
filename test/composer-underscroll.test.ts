import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The transcript runs underneath the composer.
 *
 * Tyler: "make the mac app input bar have the content scroll underneath it. Like still have a
 * spacer so i can read everything but see the line created in the text to the right and left of
 * the inpt box top... we should just be able to see the content where its not covered by the
 * input box."
 *
 * The card is narrower than the pane, so floating it over the text leaves the columns either
 * side readable and makes the rule across its top read as the page continuing behind it. The
 * "spacer" is the room the stack leaves beneath its last message — nothing is hidden, it is
 * scrolled past rather than cut off.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const swift = (path: string) => source(path).replace(/^\s*\/\/.*$/gm, "");
const pane = swift("mac-app/conch-mac/DashboardView.swift");
const stack = swift("mac-app/conch-mac/ConversationStackView.swift");

describe("the composer floats over the transcript", () => {
  test("it is layered on the conversation, not stacked above it", () => {
    expect(pane).toMatch(/ZStack\(alignment: \.bottom\) \{\s*conversationBody\(for: focusedRow\)/);
    // Both stages float the same card, so side by side and the full page cannot drift.
    expect(pane).toContain("floatingComposer(for: reviewRow)");
    expect(pane).toMatch(/if let row = focusedRow, row\.parentSessionId == nil \{\s*floatingComposer\(for: row\)/);
  });

  /**
   * Measured, not guessed: the composer grows with wrapped lines and attachments, so a constant
   * would leave the last message clipped exactly when someone is writing a long one.
   */
  test("the room left for it is the height it actually is", () => {
    expect(pane).toContain("private struct ComposerHeight: PreferenceKey");
    expect(pane).toContain("Color.clear.preference(key: ComposerHeight.self, value: proxy.size.height.rounded(.up))");
    // A preference, not state assigned during layout — that tells SwiftUI a view changed while
    // it is drawing it. The control bar already reports its size this way.
    expect(pane).toContain(".onPreferenceChange(ComposerHeight.self) { height in");
    expect(pane).toContain("bottomInset: composerHeight,");
    expect(stack).toContain("var bottomInset: CGFloat = 0");
  });

  /**
   * THE ordering that matters. The anchor is the stack's own bottom margin and scrolling to it
   * must still reach the document's true end (measured 2026-09-20: as a 1 pt line inside the
   * padding it stopped 14 pt short every revision and broke the streaming follow). Put the
   * composer's room ABOVE the anchor and the same bug returns, a composer's height deep.
   */
  test("the room sits below the anchor, so the bottom is still the bottom", () => {
    const anchor = stack.indexOf(".id(Self.bottomAnchor)");
    const inset = stack.indexOf("Color.clear.frame(height: bottomInset)");
    expect(anchor).toBeGreaterThan(-1);
    expect(inset).toBeGreaterThan(anchor);
    // And yesterday's fix is untouched.
    expect(stack).toMatch(/Color\.clear\s+\.frame\(height: 14\)\s+\.id\(Self\.bottomAnchor\)/);
  });

  /**
   * The claim this file OPENS with, asserted instead of just described.
   *
   * Both measures were 700 (conch shot, 2026-09-21): the card covered the reading column
   * exactly, so no line showed either side of it and the transcript appeared to stop at the
   * card rather than run behind it — the one thing the change was for. Read as numbers, so
   * widening the card or narrowing the column back to a tie fails here.
   */
  test("the card is narrower than the column it floats over", () => {
    const fallback = swift("mac-app/conch-mac/TranscriptFallback.swift");
    const measure = (name: string) => {
      const found = fallback.match(new RegExp(`static let ${name}: CGFloat = (\\d+)`));
      expect(found).not.toBeNull();
      return Number(found![1]);
    };
    const reading = measure("maxMeasure");
    const card = measure("composerMeasure");
    expect(card).toBeLessThan(reading);
    // Enough to actually SEE — 60 pt of line either side, not a hairline of difference.
    expect(reading - card).toBeGreaterThanOrEqual(100);
    expect(swift("mac-app/conch-mac/ComposerView.swift")).toContain(
      ".frame(maxWidth: ConversationTextView.composerMeasure)",
    );
  });
});
