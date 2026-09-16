import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const conversation = readFileSync(
  join(import.meta.dir, "..", "mac-app", "conch-mac", "ConversationStackView.swift"),
  "utf8",
);

const card = (() => {
  const from = conversation.indexOf("private func questionRow(");
  const to = conversation.indexOf("private func questionOption(");
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return conversation.slice(from, to);
})();

const option = (() => {
  const from = conversation.indexOf("private func questionOption(");
  const to = conversation.indexOf("private func toggleSelection(");
  expect(to).toBeGreaterThan(from);
  return conversation.slice(from, to);
})();

/**
 * A question is a card.
 *
 * `.qb{margin:0 0 22px;border-radius:14px;box-shadow:inset 0 0 0 1px var(--hair2);
 * padding:14px 10px 8px 16px}`
 *
 * The app already had a card, but a different one: uniform `padding(12)` at radius 10, ringed
 * in `statusNeeds` at 0.45 (and still glowing at 0.18 once settled). The coloured ring said
 * "answer me" a second time, louder than the header that already says it.
 */
test("the question sits in the lab's ringed card", () => {
  expect(card).toContain("RoundedRectangle(cornerRadius: 14, style: .continuous)");
  expect(card).toContain(".strokeBorder(ConchPalette.hairlineStrong, lineWidth: 1)");
  // The attention-coloured ring is gone; the header carries that signal alone.
  expect(card).not.toContain("statusNeeds.opacity(answerable ? 0.45 : 0.18)");
  expect(card).not.toContain("RoundedRectangle(cornerRadius: 10)");
  expect(card).toContain(".padding(.top, 14)");
  expect(card).toContain(".padding(.leading, 16)");
  expect(card).toContain(".padding(.trailing, 10)");
  expect(card).toContain(".padding(.bottom, 8)");
});

/**
 * `.qq{font:500 15px/1.45}` — the question is READ, at the transcript's own reading size.
 * It was set at 13: smaller than the prose around it.
 * `.qh{font:600 12px;color:var(--attention)}` — the header was 11.
 */
test("the question is read at 15, and its header at 12", () => {
  expect(card).toContain("ConchTypography.font(size: 15, weight: .medium)");
  expect(card).toContain("ConchTypography.font(size: 12, weight: .semibold)");
  expect(card).toContain(".foregroundStyle(ConchPalette.statusNeeds)");
  expect(card).not.toContain(".font(.system(size: 13))");
  expect(card).not.toContain(".font(.system(size: 11, weight: .semibold))");
});

/**
 * `.qo{gap:12px;padding:8px 10px;border-radius:9px}`, `.qo b{font:500 14px/20px}`,
 * `.qo small{font-size:12.5px}` — and transparent at rest: `.qo:hover{background:var(--hover)}`,
 * `.qo.sel{background:var(--sel)}`.
 *
 * Every option carried a permanent `raised` fill, so three choices read as three stacked
 * cards inside a card.
 */
test("an option is a row, not a filled card", () => {
  expect(option).toContain("HStack(alignment: .firstTextBaseline, spacing: 12)");
  expect(option).toContain("ConchTypography.font(size: 14, weight: .medium)");
  expect(option).toContain("ConchTypography.font(size: 12.5)");
  expect(option).toContain(".padding(.horizontal, 10)");
  expect(option).toContain(".padding(.vertical, 8)");
  expect(option).toContain("RoundedRectangle(cornerRadius: 9, style: .continuous)");
  // Transparent at rest; hover and selected are the only fills.
  expect(option).toContain("ConchPalette.hover");
  expect(option).toContain("ConchPalette.selection");
  expect(option).toContain(".onHover {");
  expect(option).not.toContain("ConchPalette.raised");
  expect(option).not.toContain("ConchPalette.statusNeeds.opacity(0.10)");
});

/**
 * Recorded so a later comb does not "correct" it: the lab's `--hover:rgba(0,0,0,.035)` and
 * `--sel:rgba(0,0,0,.065)` are NOT used. `RowStateTokenTests` measured those and found they
 * fail here — hover read as more selected than selected — so the app's own tokens stand.
 */
test("hover and selection come from the measured tokens, not the lab's raw fills", () => {
  expect(option).not.toContain("opacity(0.035)");
  expect(option).not.toContain("opacity(0.065)");
  // The claim is which TOKENS are used, not that a comment explains why.
  expect(option).toContain("selected ? ConchPalette.selection :");
  expect(option).toContain("ConchPalette.hover : .clear");
});
