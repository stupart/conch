import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dashboard = readFileSync(
  join(import.meta.dir, "..", "mac-app", "conch-mac", "DashboardView.swift"),
  "utf8",
);

/**
 * The session list is the surface scanned most, so its rows are the ones whose height costs
 * the most. The lab:
 *
 *   `--rowH:30px`
 *   `.row{height:var(--rowH);gap:8px;padding:0 4px 0 8px;border-radius:7px;font-size:13px}`
 *   `.row.child{padding-left:30px}`
 *
 * The app drew 42 on the outside and 40 on the inside, around ONE line of content — mark,
 * label, agent badge, summary, age, glyph. That is a line and a half of air per row, and at
 * a normal window height it costs about nine visible sessions.
 */
test("a session row is the lab's 30, not 42", () => {
  expect(dashboard).toContain("static let rowHeight: CGFloat = 30");
  expect(dashboard).toContain(".frame(maxWidth: .infinity, minHeight: Self.rowHeight)");
  expect(dashboard).toContain(
    ".frame(maxWidth: .infinity, minHeight: Self.rowHeight, alignment: .leading)",
  );
  // Both of the old heights are gone — the outer frame and the inner HStack disagreed by 2,
  // so raising only one of them would have left the other governing.
  expect(dashboard).not.toContain("minHeight: 42");
  expect(dashboard).not.toContain("minHeight: 40, alignment: .leading");
});

/** `.row{gap:8px}` and `padding:0 4px 0 8px` — the mark's own 10 pt column is the leading inset. */
test("a row's gap and trailing inset are the lab's", () => {
  const row = dashboard.slice(dashboard.indexOf("private var rowContent: some View"));
  const body = row.slice(0, row.indexOf("private func pulseForReview"));
  expect(body).toContain("HStack(spacing: 8) {");
  expect(body).toContain(".padding(.trailing, 4)");
  expect(body).not.toContain("HStack(spacing: 7) {");
});

/**
 * `.row.child{padding-left:30px}` — a subagent under its parent, a session under its starter.
 * At 18 the indent read as a rendering wobble rather than a hierarchy.
 */
test("a child row is indented the lab's 30", () => {
  expect(dashboard).toContain("row.startedBySessionId == nil ? 0 : 30");
  // An agent's line sits at the same 30, inside its parent's group.
  expect(dashboard.slice(dashboard.indexOf("private struct AgentGroup: View {"))).toContain(".padding(.leading, 30)");
});

/**
 * A dismissed row is a `.row` too. It sat at 34 while live rows sat at 42 — two heights that
 * were both wrong, and wrong by different amounts, in one list.
 */
test("a dismissed row is the same height as a live one", () => {
  expect(dashboard).toContain(".frame(maxWidth: .infinity, minHeight: DashboardRow.rowHeight)");
  expect(dashboard).not.toContain(".frame(maxWidth: .infinity, minHeight: 34)");
});

/**
 * Recorded as deliberate, so nobody "fixes" it back: the lab bolds a review-ready row
 * (`.row.attn .lb{font-weight:600}` where attn includes review), and this app does not.
 *
 * Tyler, asked directly: "review ready already has big green check i dont think we also need
 * to bold it". So the weight follows waiting and needs only.
 */
test("only waiting and needs bold the label — review is carried by its check", () => {
  expect(dashboard).toContain(
    "weight: row.status == .waiting || row.status == .needs ? .semibold : .medium",
  );
});
