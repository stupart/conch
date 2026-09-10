import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * E1: the top of the Mac window. The window hides its title bar, but SwiftUI
 * still insets content below the strip the traffic lights sit in (32pt on
 * macOS 26), so the dashboard's 38pt header row stacked under an empty strip.
 * The dashboard's stack now extends under the strip and the header row IS the
 * strip — wordmark, status and app controls beside the traffic lights — with
 * nothing above the ledger but a divider. Presence is asserted before
 * ordering: `indexOf` returns -1 for a missing marker and -1 sorts before
 * everything.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Ignore line comments so a description of a site cannot satisfy a guard.
const swift = (file: string) => source(`mac-app/conch-mac/${file}`).replace(/^\s*\/\/.*$/gm, "");
const app = swift("ConchMacApp.swift");
const dashboard = swift("DashboardView.swift");

function at(text: string, marker: string, from = 0): number {
  const index = text.indexOf(marker, from);
  expect(index, `missing: ${marker}`).toBeGreaterThan(-1);
  return index;
}
function section(text: string, start: string, end: string): string {
  const a = at(text, start);
  const b = at(text, end, a);
  return text.slice(a, b);
}
function ordered(text: string, ...markers: string[]): void {
  let position = 0;
  for (const marker of markers) position = at(text, marker, position) + marker.length;
}

describe("E1: the header lives in the title-bar strip", () => {
  const body = section(dashboard, "struct DashboardView: View {", "private func ledgerWidth(");
  const header = section(dashboard, "private struct DashboardHeader: View {", "private struct HeaderControls: View {");

  test("the window's title bar is hidden and the dashboard's stack extends under it", () => {
    expect(app).toContain(".windowStyle(.hiddenTitleBar)");
    expect(body).toContain(".ignoresSafeArea(.container, edges: .top)");
    // On the whole stack, INSIDE the reader: a reader that ignores the strip
    // reports its height as 0, and scoping the modifier to one row would leave
    // the strip empty with the header still stacked below it.
    ordered(
      body,
      "GeometryReader { proxy in",
      "VStack(spacing: 0) {",
      "DashboardHeader(",
      "SessionLedger(",
      ".ignoresSafeArea(.container, edges: .top)",
      "\n        }\n        .background(ConchPalette.bg)",
    );
  });

  test("the header is sized to the strip and clears the traffic lights; no row of its own", () => {
    expect(body).toContain("titleBarInset: proxy.safeAreaInsets.top,");
    expect(header).toContain("let titleBarInset: CGFloat");
    expect(header).toContain("private static let trafficLightClearance: CGFloat = 78");
    expect(header).toContain(".padding(.leading, titleBarInset > 0 ? Self.trafficLightClearance : 16)");
    expect(header).toContain(".frame(height: max(titleBarInset, 28))");
    expect(header).not.toContain(".frame(height: 38)");
    // The strip is the first thing in the window; the ledger follows one divider later.
    ordered(body, "VStack(spacing: 0) {", "DashboardHeader(", "Rectangle()", "SessionLedger(");
  });

  test("every control that was in the header is still there, at 26pt or more", () => {
    const controls = section(dashboard, "private struct HeaderControls: View {", "private struct SessionLedger: View {");
    expect(controls).toContain("ModeToggle(");
    expect(controls).toContain('help: "Settings — connect a phone, and everything else"');
    expect(controls).toContain('help: isLogDrawerOpen ? "Hide logs" : "Show logs"');
    expect(controls).toContain('help: "Keyboard shortcuts"');
    expect(controls).toContain(".frame(width: 26, height: 26)");
    expect(controls).toContain(".accessibilityLabel(help)");
    ordered(controls, "ModeToggle(", 'symbol: "gearshape"', 'symbol: "text.alignleft"', 'symbol: "questionmark"');
    // The wordmark and the status line stay in the strip with them.
    expect(header).toContain('Text("conch")');
    expect(header).toContain("HeaderControls(");
    ordered(header, 'Text("conch")', "if let daemonMessage {", "HeaderControls(");
  });

  test("the session bar and the Cut B banners are untouched and below the strip", () => {
    expect(dashboard).toContain('.help("Bring this session\'s terminal to the front")');
    expect(dashboard).toContain("AgentBadge(backend: row.backend)");
    expect(dashboard).toContain("SessionContextMeter(context: context)");
    expect(dashboard).toContain('.help("Session actions")');
    expect(dashboard).toContain('.accessibilityLabel("Actions for \\(row.label)")');
    expect(body).toContain("if let host = audio.controlledBy {");
    ordered(body, "DashboardHeader(", "if let host = audio.controlledBy {", "SessionLedger(");
  });
});
