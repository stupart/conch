import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Working is blue, and a sub-agent is working or paused.
 *
 * Tyler: "maybe we make it more clear when sub-agents are working vs paused somehow — do we treat
 * them the same as normal agents in terms of working state? Also could maybe generally replace the
 * gray color for work with a blue or yea idk some other color that feels more like 'active' and
 * 'positive'."
 *
 * The daemon lists a Codex helper with its real status, so one between turns arrived as `waiting`
 * and the sidebar drew waiting's green, "come and look", on something nobody replies to. The
 * daemon's status is unchanged; the Mac and the phone read a sub-agent's waiting (or no status) as
 * paused. Neither app has an XCTest target, so the mapping is pinned as source; the colour's
 * contrast, its hue and the breath's stillness under Reduce Motion are XCTests in ConchDesign
 * (ActiveMarkTests).
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const between = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf(to, start + from.length);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
};

const dashboard = read("mac-app/conch-mac/DashboardView.swift");
const ledgerVisual = between(dashboard, "private enum LedgerVisual: String, CaseIterable, Identifiable {", "private struct ConversationPane: View {");
const rowInit = between(ledgerVisual, "    init(row: SessionRow) {", "    var symbol: String {");
const models = read("mobile/conch-ios/conch-ios/Models.swift");
const statusMark = between(models, "enum StatusMark {", "func relativeAge(");
const markInit = between(statusMark, "    init(row: PublishedState.Row) {", "    var symbol: String {");

test("on the Mac a sub-agent that is not running is paused, before anything can call it waiting", () => {
  const paused = rowInit.indexOf(
    "if row.parentSessionId != nil, row.status != .working, row.status != .needs {\n            self = .agentPaused\n            return\n        }",
  );
  expect(paused).toBeGreaterThan(-1);
  // After the review check (a deliverable still outranks), before the manual check, the live
  // states and the status switch, any of which could otherwise reach `.waiting`.
  expect(rowInit.indexOf("self = .review")).toBeLessThan(paused);
  expect(paused).toBeLessThan(rowInit.indexOf("self = .manual"));
  expect(paused).toBeLessThan(rowInit.indexOf("switch row.live {"));
  expect(paused).toBeLessThan(rowInit.indexOf("self.init(status: row.status)"));
});

test("paused is a hollow faint ring that says Paused, never waiting's green", () => {
  expect(ledgerVisual).toMatch(/case \.agentPaused:\n(\s*\/\/[^\n]*\n)*\s*return "circle"\n/);
  const colour = between(ledgerVisual, "    var color: Color {", "    var accessibilityLabel: String {");
  expect(colour).toMatch(/case \.agentPaused:\n(\s*\/\/[^\n]*\n)*\s*return ConchPalette\.textFaint\n/);
  expect(colour).not.toMatch(/case \.agentPaused:\n(\s*\/\/[^\n]*\n)*\s*return ConchPalette\.statusWaiting/);
  expect(ledgerVisual).toContain('case .agentPaused:\n            return "Paused"');
  // The label is also the mark's tooltip.
  expect(dashboard).toContain(".help(visual.accessibilityLabel)");
  // The sub-agent lines draw the same mark, from the same mapping.
  expect(between(dashboard, "private struct AgentGroup: View {", "\n}\n")).toContain("DashboardStatusGlyph(visual: LedgerVisual(row: agent))");
});

test("working is the active blue on the Mac, and the dot breathes only while it is shown", () => {
  const palette = read("mac-app/conch-mac/Palette.swift");
  expect(palette).toContain("static let statusActive = ConchColor.active.dynamic");
  const colour = between(ledgerVisual, "    var color: Color {", "    var accessibilityLabel: String {");
  expect(colour).toMatch(/case \.working:\n(\s*\/\/[^\n]*\n)*\s*return ConchPalette\.statusActive\n/);
  expect(colour).toMatch(/case \.transcribing:\n(\s*\/\/[^\n]*\n)*\s*return ConchPalette\.statusActive\n/);
  // Reading aloud comes after the turn: no agent is running.
  expect(colour).toMatch(/case \.speaking:\n(\s*\/\/[^\n]*\n)*\s*return ConchPalette\.statusQuiet\n/);
  const glyph = between(dashboard, "private struct DashboardStatusGlyph: View {", "private enum LedgerVisual");
  expect(glyph).toContain(".activeBreath(\n                        pointSize: candidate.symbolSize,\n                        breathes: candidate == .working && visual == .working\n                    )");
  // No grey "working" left for a new call site to reach for.
  for (const file of ["DashboardView.swift", "ContentView.swift", "ComposerView.swift", "StatusItem.swift", "Palette.swift"]) {
    expect(read(`mac-app/conch-mac/${file}`)).not.toContain("statusWorking");
  }
});

test("the legend, the menu bar menu and the panel's switcher draw working blue, and the legend says what paused is", () => {
  const legend = between(read("mac-app/conch-mac/ContentView.swift"), "private let entries: [Entry] = [", "    ]\n");
  expect(legend).toContain('Entry(symbol: "circle.fill", color: ConchPalette.statusActive, meaning: "Working — an agent is running, nothing needed from you")');
  expect(legend).toContain('Entry(symbol: "circle", color: ConchPalette.textFaint, meaning: "Paused — a sub-agent that isn\'t running")');
  // Working is a FILLED dot in active's blue in the menu and the switcher, as the sidebar draws working: the hollow ring
  // is the sidebar's paused sub-agent (ReadyTests pins the symbols and the colours).
  const menu = read("mac-app/conch-mac/StatusItem.swift");
  const statusMenu = read("design/ConchDesign/Sources/ConchDesign/StatusMenu.swift");
  expect(statusMenu).toContain("rows.append(.item(Item(title: session.label, command: .openSession(session.id), dot: .working)))");
  expect(statusMenu).toContain('public var symbol: String { "circle.fill" }');
  expect(statusMenu).not.toContain('"circle"');
  expect(menu).toContain("NSImage.SymbolConfiguration(paletteColors: [tint])");
  // A menu tints a template image with its own ink, which would undo the colour.
  expect(menu).toContain("image?.isTemplate = false");
  const components = read("design/ConchDesign/Sources/ConchDesign/Components.swift");
  expect(components).toContain("case .working: ConchColor.active");
  expect(components).toContain(".foregroundStyle(FogSession.markColor(session.standing))");
  expect(components).toContain("Image(systemName: FogSession.markSymbol(session.standing))");
});

test("the breath is a halo behind a still dot, and holds still under Reduce Motion", () => {
  const halo = read("design/ConchDesign/Sources/ConchDesign/ActiveMark.swift");
  // The function the XCTest drives is the one the view draws with.
  expect(halo).toContain(".opacity(Self.opacity(at: time, reduceMotion: reduceMotion))");
  expect(halo).toContain("guard !reduceMotion else { return 0 }");
  // Under Reduce Motion the clock stops as well as the halo, so a still dot costs no frames.
  expect(halo).toContain("TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion ||");
  // A background, so the dot keeps its own size and baseline in every row.
  expect(halo).toMatch(/background \{\n\s*if breathes \{\n\s*ActiveHalo\(/);
});

test("on the phone a sub-agent that is not running is paused too, and working is the same blue", () => {
  const paused = markInit.indexOf(
    'if row.parentSessionId != nil, row.status != "working", row.status != "needs" { self = .agentPaused; return }',
  );
  expect(paused).toBeGreaterThan(-1);
  expect(markInit.indexOf("self = .review")).toBeLessThan(paused);
  expect(paused).toBeLessThan(markInit.indexOf("self = .paused"));
  expect(paused).toBeLessThan(markInit.indexOf('case "waiting": self = .waiting'));
  expect(statusMark).toContain('case .agentPaused: "circle"');
  expect(statusMark).toContain("case .idle, .agentPaused: Palette.textFaint");
  expect(statusMark).toContain('case .agentPaused: "Paused"');
  expect(statusMark).toContain("case .working: Palette.active");
  expect(statusMark).not.toMatch(/case[^\n]*\.agentPaused[^\n]*Palette\.waiting/);
  // No status to report is idle, as on the Mac, not a false working dot.
  expect(markInit).toContain('case "working": self = .working');
  expect(markInit).toContain("default: self = .idle");
  expect(models).toContain('status = c.contains(.status) ? ((try? c.decodeIfPresent(String.self, forKey: .status)) ?? "idle") : "working"');
  expect(read("mobile/conch-ios/conch-ios/Theme.swift")).toContain("static let active = ConchColor.active.dynamic");
  const ledger = read("mobile/conch-ios/conch-ios/LedgerView.swift");
  expect(between(ledger, "struct AgentRowView: View {", "struct SessionRowView: View {")).toContain(".activeBreath(pointSize: 11, breathes: mark == .working)");
  expect(between(ledger, "struct SessionRowView: View {", "struct AgentBadge: View {")).toContain(".activeBreath(pointSize: 15, breathes: mark == .working)");
});
