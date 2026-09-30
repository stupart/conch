import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The sidebar's rows, name first (2026-09-28).
 *
 * Tyler, with ChatGPT's recents beside conch's sidebar: "we should show as much of the beginning
 * of the name as we can. There's probably a lot more space than we need and random details on
 * the right side that could be shown better." A row was one line of mark, name, agent mark,
 * summary and age, the name middle-truncated to share it: "Co…egy" for "Conch UI strategy",
 * beside "Screen…".
 *
 * Now the name has the line and fades at its end (ConchDesign's `TailFadeText`); the summary is
 * the tooltip's and VoiceOver's; a second line is earned only by conch's word about the row, the
 * question it is blocked on, or its starter (`SidebarRowText.subtitle`); the agent and the age
 * show for the hovered and selected row. The rules and the fade are held by XCTests
 * (SidebarRowTests). The Mac has no XCTest target, so how it draws and wires them is pinned here.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const section = (text: string, start: string, end: string): string => {
  const from = text.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
};
/** The code without its `//` comments, which quote the old expressions on purpose. */
const code = (text: string): string => text.replace(/\/\/[^\n]*/g, "");

const dashboard = read("mac-app/conch-mac/DashboardView.swift");
const design = read("design/ConchDesign/Sources/ConchDesign/SidebarRow.swift");
const row = section(dashboard, "private struct DashboardRow: View {", "private func pulseForReview()");
const rowContent = section(row, "private var rowContent: some View", "\n    }\n\n");
const agents = section(dashboard, "private struct AgentGroup: View {", "\n}\n");

describe("the name has the line", () => {
  test("a session's name keeps its beginning: tail-faded, never middle-truncated", () => {
    const name = section(rowContent, "TailFadeText(row.label)", "\n                    }\n");
    expect(name).toContain(".frame(maxWidth: .infinity, alignment: .leading)");
    expect(code(row)).not.toContain(".truncationMode(.middle)");
    // The old name's floor and priority, which it needed only to fight a summary for the line.
    expect(code(rowContent)).not.toContain("minWidth: 54");
    // A bare Text of the name, which is what truncated it.
    expect(code(rowContent)).not.toMatch(/(?<!Fade)Text\(row\.label\)/);
  });

  test("a sub-agent's name follows the same rule", () => {
    expect(agents).toContain("TailFadeText(agent.label, fade: 24)");
    expect(code(agents)).not.toContain(".truncationMode(");
    expect(code(agents)).not.toMatch(/(?<!Fade)Text\(agent\.label\)/);
  });

  test("the fade is a mask over the line, only when the line overflows, never an ellipsis", () => {
    const fade = section(design, "public struct TailFadeText: View {", "\n}\n");
    expect(fade).toContain("ViewThatFits(in: .horizontal) {");
    expect(fade).toContain("LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)");
    expect(fade).toContain(".fixedSize(horizontal: true, vertical: false)");
    expect(code(fade)).not.toContain("truncationMode");
  });

  test("names are regular; a row that wants you is semibold; a blocked sub-agent too", () => {
    expect(rowContent).toContain("weight: row.status == .waiting || row.status == .needs ? .semibold : .regular");
    expect(agents).toContain("weight: agent.status == .needs ? .semibold : .regular");
    // Selection is the fill's to say, not the weight's.
    expect(code(agents)).not.toContain("selectedID == agent.id ? .semibold");
  });
});

describe("the details move", () => {
  test("the summary is not drawn beside the name: the tooltip and VoiceOver carry it", () => {
    expect(code(rowContent)).not.toContain("detailLine");
    expect(code(rowContent)).not.toContain("inlineDetail");
    expect(row).toContain(".help(SidebarRowText.tooltip(name: row.label, snippet: detailLine, startedBy: startedByLabel))");
    expect(row).toContain('.accessibilityValue([isFollowing ? "Currently shown in All sessions" : "", detailLine, age ?? ""].filter { !$0.isEmpty }.joined(separator: ", "))');
    // The tooltip is no longer the bare label, which a faded name would leave half-said.
    expect(code(row)).not.toContain(".help(row.label)");
  });

  test("only conch's word, the question it is blocked on, or its starter earn a second line", () => {
    const subtitle = section(row, "private var subtitle: String? {", "\n    }\n");
    expect(subtitle).toContain("message: rowMessage,");
    expect(subtitle).toContain("blockedOn: row.status == .needs ? row.detail : nil,");
    expect(subtitle).toContain("startedBy: startedByLabel");
    expect(code(subtitle)).not.toContain("review");
    expect(code(subtitle)).not.toContain("noTerminal");
    // Drawn under the name, a size down, faded like it; the needs colour for conch's own word.
    const line = section(rowContent, "if let subtitle {", "\n                }\n");
    expect(line).toContain("TailFadeText(subtitle, fade: 24)");
    expect(line).toContain(".font(ConchTypography.font(size: 11))");
    expect(line).toContain("? ConchPalette.textDim\n                                : ConchPalette.statusNeeds.opacity(0.90)");
    // The "started by" that sat on the name's line is gone from it.
    expect(code(rowContent)).not.toContain('Text("started by');
  });

  test("the rule for the second line never offers a summary", () => {
    const rule = section(design, "public static func subtitle(", "\n    }\n");
    expect(rule).toContain("if let message = present(message) { return message }");
    expect(rule).toContain("if let blockedOn = present(blockedOn) { return blockedOn }");
    expect(rule).toContain('return present(startedBy).map { "started by \\($0)" }');
  });

  test("the agent and the age show for the hovered and the selected row; quiet and priority always", () => {
    expect(section(row, "private var showsDetails: Bool {", "\n    }\n")).toContain("isHovered || isSelected");
    expect(rowContent).toContain("if showsDetails {\n                            AgentBadge(backend: row.backend)\n                        }");
    expect(rowContent).toContain("if showsDetails, let age {");
    expect(rowContent).toContain("if row.prioritized {");
    expect(rowContent).toContain("if let mark = voice.mark, !isRenaming {");
    // All of it after the name, in one group at the line's end.
    const name = rowContent.indexOf("TailFadeText(row.label)");
    for (const detail of ["if row.prioritized {", "AgentBadge(backend: row.backend)", "if let mark = voice.mark", "if showsDetails, let age {"]) {
      expect(rowContent.indexOf(detail)).toBeGreaterThan(name);
    }
  });

  test("a second line keeps the mark beside the name, not between the lines", () => {
    expect(rowContent).toContain("HStack(alignment: .nameLine, spacing: 8) {");
    expect(rowContent).toContain(".alignmentGuide(.nameLine) { $0[VerticalAlignment.center] }");
    expect(dashboard).toContain("static let nameLine = VerticalAlignment(NameLine.self)");
  });
});

describe("VoiceOver hears the whole of it", () => {
  test("the row's label is the whole name, its state and its agent", () => {
    const label = section(row, "private var accessibilityName: String {", "\n    }\n");
    expect(label).toContain("name: row.label,");
    expect(label).toContain("state: LedgerVisual(row: row).accessibilityLabel,");
    expect(label).toContain("agent: AgentBadge.name(for: row.backend),");
    expect(label).toContain("voice: voice.mark,");
    expect(row).toContain(".accessibilityLabel(accessibilityName)");
    // The quiet mark is a button inside the row; its toggle is an action on the row too.
    expect(row).toContain('.accessibilityAction(named: Text(voice.togglesToQuiet ? "Make Quiet" : "Let It Speak"), onToggleQuiet)');
  });

  test("a sub-agent's label is its whole name, its state and its agent", () => {
    expect(agents).toContain("name: agent.label,");
    expect(agents).toContain("state: LedgerVisual(row: agent).accessibilityLabel,");
    expect(agents).toContain("agent: AgentBadge.name(for: agent.backend),");
  });

  test("the agent's name is the badge's own, one switch for both", () => {
    const badge = section(dashboard, "struct AgentBadge: View {", "\n}\n");
    expect(badge).toContain("private var label: String { Self.name(for: backend) }");
    expect(badge).toContain("static func name(for backend: String?) -> String {");
  });
});
