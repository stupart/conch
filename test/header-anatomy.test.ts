import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The header, px for px against the lab.
 *
 * `~/Projects/conch-design/workspace-lab.html` is the running prototype, and its CSS — not
 * §3's prose — is what "matches the mockups" means. Every value below is quoted to the
 * selector it came from, so a future change to either side has to face the other.
 *
 * CI builds neither app, so these read the source.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const dashboard = read("mac-app/conch-mac/DashboardView.swift");
const palette = read("mac-app/conch-mac/Palette.swift");

function section(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

const header = section(
  dashboard,
  "private func sessionBar(for row: SessionRow) -> some View {",
  "private func deliverableTabs(",
);
/** The title is its own helper; the header only calls it. */
const title = section(
  dashboard,
  "private func sessionTitle(_ row: SessionRow) -> some View {",
  "private func sessionBar(",
);
const meter = section(dashboard, "private struct SessionContextMeter: View {", "\n}\n");
const segment = section(dashboard, "private struct PerspectiveOption: View {", "\n}\n");

describe("the header carries the lab's anatomy", () => {
  // `.ttl{font:600 14px;letter-spacing:-.01em}`. It was 12.5 medium — a size the header's
  // own meta text could match, which left the line that says what you are looking at
  // competing with the lines about it.
  test("the session title is the loudest thing in the header", () => {
    expect(header).toContain("sessionTitle(row)");
    expect(title).toContain("Text(row.label)");
    expect(title).toContain("ConchTypography.font(size: 14, weight: .semibold)");
    expect(title).toContain(".tracking(-0.14)");
    expect(title).not.toContain("ConchTypography.font(size: 12.5, weight: .medium)");
  });

  // `.ctxwarn{font-size:12px;color:var(--listening)}`, drawn only at 85% and up (§5:
  // "87% context"). Below that the header says nothing about context at all — Tyler's
  // "a lot of importance to a not super important piece of data", carried further than
  // colour alone could carry it.
  test("context pressure is a percentage, and only once it is worth knowing", () => {
    expect(meter).toContain("if context.fraction >= 0.85 {");
    expect(meter).toContain('Text("\\(Int((context.fraction * 100).rounded()))% context")');
    expect(meter).toContain("ConchTypography.font(size: 12)");
    // Not a running tally of tokens on screen at all times: `used / limit` survives only
    // where it is asked for, in the tooltip and to VoiceOver.
    expect(meter).not.toContain("ConchTypography.font(size: 10.5)");
    expect(meter).toContain('.help("Context \\(label) tokens');
    // Two bands can render; the third colour went with the rows it used to sit on.
    expect(meter).toContain("context.fraction >= 0.97 ? ConchPalette.statusNeeds : ConchPalette.statusWaiting");
    expect(meter).not.toContain("ConchPalette.statusWorking.opacity(0.66)");
  });

  // `.seg{padding:2px;border-radius:8px;background:var(--fill);gap:1px;margin-right:4px}`.
  // Three loose buttons read as three unrelated controls.
  test("the view switch is one control with three positions, not three buttons", () => {
    const track = section(header, "if selectedReview != nil {", "// A subagent is not a session");
    expect(track).toContain("HStack(spacing: 1) {");
    expect(track.match(/PerspectiveOption\(/g) ?? []).toHaveLength(3);
    expect(track).toContain(".padding(2)");
    expect(track).toContain("RoundedRectangle(cornerRadius: 8, style: .continuous)");
    expect(track).toContain(".fill(ConchPalette.fill)");
    expect(track).toContain(".padding(.trailing, 4)");
  });

  // `.seg button{width:30px;height:24px;border-radius:6px}`, selected on `--fillSel`.
  test("the selected segment is marked by its fill, and nothing else", () => {
    expect(segment).toContain(".frame(width: 30, height: 24)");
    expect(segment).toContain("RoundedRectangle(cornerRadius: 6, style: .continuous)");
    expect(segment).toContain("isSelected ? ConchPalette.fillSelected : (isHovered ? ConchPalette.hover : .clear)");
    // `.seg button.on` also asks for `box-shadow:var(--shRaised)` — a variable defined
    // nowhere in the lab, which therefore renders nothing. The fill is the whole mark.
    expect(segment).not.toContain("conchElevation");
    expect(segment).not.toContain(".shadow(");
    // It sizes itself now; the old padding would fight the fixed frame.
    expect(segment).not.toContain(".padding(.horizontal, 7)");
    expect(segment).not.toContain(".frame(height: 26)");
  });

  test("the track's two fills are the lab's own, not a second set of greys", () => {
    expect(palette).toContain("static let fill = ConchColor.fill.dynamic");
    expect(palette).toContain("static let fillSelected = ConchColor.fillSelected.dynamic");
  });
});
