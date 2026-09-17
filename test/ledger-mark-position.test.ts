import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const dashboard = read("mac-app/conch-mac/DashboardView.swift");
const row = (() => {
  const from = dashboard.indexOf("private var rowContent: some View");
  expect(from).toBeGreaterThan(-1);
  const to = dashboard.indexOf("private func pulseForReview()", from);
  expect(to).toBeGreaterThan(from);
  return dashboard.slice(from, to);
})();

/**
 * The mark leads the row.
 *
 * Tyler: "having the icons on the left side of the items on the left sidebar ... seems to work
 * a bit better than current state."
 *
 * It already led everywhere else. The lab renders `${mark(v)}${label}` — the mark first, then
 * the label, with the agent and age in a trailing `.meta` group. The phone's `SessionRowView`
 * is `HStack { Image(systemName: mark.symbol); VStack { label; summary } }`. The Mac was the
 * lone outlier, parking the verdict hard right after the age.
 *
 * A scanning eye reads down the left edge, and this list answers one question — which of these
 * needs me? A verdict found only after crossing the label and the summary answers it last.
 */
test("the status mark comes before the label", () => {
  const mark = row.indexOf("DashboardStatusGlyph(visual: LedgerVisual(row: row))");
  const label = row.indexOf("Text(row.label)");
  const age = row.indexOf("if let age {");
  expect(mark).toBeGreaterThan(-1);
  expect(mark).toBeLessThan(label);
  expect(label).toBeLessThan(age);
});

/** Exactly one mark: moving it must not leave a copy behind at the tail. */
test("the row draws one mark, not two", () => {
  expect(row.match(/DashboardStatusGlyph\(/g) ?? []).toHaveLength(1);
});

/**
 * `.mk{width:16px;height:16px}` — one 16 pt slot for every state, so rows do not jitter as a
 * session moves between them.
 */
test("the mark keeps the lab's 16pt slot", () => {
  const mark = row.indexOf("DashboardStatusGlyph(visual: LedgerVisual(row: row))");
  expect(row.slice(mark, mark + 160)).toContain(".frame(width: 16)");
});

/**
 * One fleet, one layout. Asserting only the Mac is how #302 shipped a check to two apps and
 * left the terminal starring reviews for a week — the cross-surface half has to be pinned too.
 */
test("the phone leads with its mark as well", () => {
  const ios = read("mobile/conch-ios/conch-ios/LedgerView.swift");
  const view = ios.slice(ios.indexOf("struct SessionRowView: View {"));
  const body = view.slice(0, view.indexOf("\n}\n"));
  const mark = body.indexOf("Image(systemName: mark.symbol)");
  const label = body.indexOf("Text(row.label)");
  expect(mark).toBeGreaterThan(-1);
  expect(mark).toBeLessThan(label);
});

/**
 * The verdict is deliberately NOT dimmed with the rest of the row. Dimming a manual row once
 * faded the glyph too, dropping it to 2.45:1 — the pixel answering "why is this one silent?"
 * became the least legible thing on screen, in a product whose failure mode is silence.
 */
test("the mark does not fade with a dimmed row", () => {
  const mark = row.indexOf("DashboardStatusGlyph(visual: LedgerVisual(row: row))");
  expect(row.slice(mark, mark + 160)).not.toContain("isDimmed");
});
