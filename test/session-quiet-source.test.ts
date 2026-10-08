import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Quiet, not paused.
 *
 * Tyler pressed P with a session selected, which quiets that one session (the daemon's scoped
 * pause), and asked "I just paused a session somehow — how do I resume?" The sidebar had swapped
 * the row's status for a pause glyph and dimmed it, so a session still at work read as stopped,
 * and nothing on screen offered the way back. Then: "it's not paused like not working — it's
 * still working — it's just not speaking aloud", and "if I switch all to manual then that one
 * individual one shouldn't say paused anymore right?"
 *
 * So: the status mark always shows; a small speaker mark by the age says conch won't read it
 * aloud, and clicking it is the undo; while every session is quiet no row carries one (the one
 * let speak through it is marked instead); and P says what it did, for a moment. The rule and the
 * words are ConchDesign's `SessionVoice`, held by XCTests (SessionVoiceTests). Neither app has an
 * XCTest target, so how each one draws and wires it is pinned here as source.
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
const content = read("mac-app/conch-mac/ContentView.swift");
const palette = read("mac-app/conch-mac/CommandPaletteView.swift");
const iosModels = read("mobile/conch-ios/conch-ios/Models.swift");
const iosLedger = read("mobile/conch-ios/conch-ios/LedgerView.swift");
const iosBridge = read("mobile/conch-ios/conch-ios/BridgeClient.swift");

const macRow = section(dashboard, "private struct DashboardRow: View {", "private func pulseForReview()");
const rowContent = section(macRow, "private var rowContent: some View", "\n    }\n\n");
const ledgerVisual = section(dashboard, "private enum LedgerVisual: String, CaseIterable, Identifiable {", "private struct ConversationPane: View {");
const statusMark = section(iosModels, "enum StatusMark {", "func relativeAge(");
const iosRow = section(iosLedger, "struct SessionRowView: View {", "struct AgentBadge: View {");

describe("the Mac sidebar", () => {
  test("quiet never replaces the status mark: the glyph reads no mode", () => {
    expect(ledgerVisual).not.toContain("case manual");
    expect(ledgerVisual).not.toContain("pause.fill");
    expect(ledgerVisual).not.toContain('"Manual"');
    const byRow = section(ledgerVisual, "    init(row: SessionRow) {", "    var symbol: String {");
    expect(byRow.length).toBeGreaterThan(400);
    expect(code(byRow)).not.toMatch(/row\.(paused|pauseExempt)/);
    // The row still draws the status glyph, first, in its 16 pt slot.
    expect(rowContent).toContain("DashboardStatusGlyph(visual: LedgerVisual(row: row))\n                .frame(width: 16)");
  });

  test("a quiet row is drawn at full strength, not dimmed", () => {
    expect(macRow).not.toContain("isDimmed");
    expect(macRow).not.toMatch(/opacity\([^)]*paused/);
  });

  test("the quiet mark is its own button by the age, from SessionVoice, never in place of the status", () => {
    const glyph = rowContent.indexOf("DashboardStatusGlyph(visual: LedgerVisual(row: row))");
    const mark = rowContent.indexOf("if let mark = voice.mark, !isRenaming {");
    const age = rowContent.indexOf("if showsDetails, let age {");
    expect(glyph).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(glyph);
    expect(age).toBeGreaterThan(mark);
    const button = rowContent.slice(mark, age);
    // Clicking it is the undo.
    expect(button).toContain("Button(action: onToggleQuiet) {");
    expect(button).toContain("SessionVoiceGlyph(mark, pointSize: 9.5)");
    expect(button).toContain(".help(mark.help(on: .mac))");
    expect(button).toContain(".accessibilityLabel(mark.help(on: .mac))");
    // The row's voice is the shared rule over its own flags and the global mode.
    expect(macRow).toContain("row.voice(everythingQuiet: everythingQuiet)");
    // The context menu offers the same toggle, by name.
    expect(macRow).toContain('Button(voice.togglesToQuiet ? "Make Quiet" : "Let It Speak", action: onToggleQuiet)');
  });

  test("while everything is quiet the row is told so, which hides its own mark", () => {
    // The row is built with the global mode; `SessionVoice.mark` returns nothing for a row
    // quieted by name while it is on (SessionVoiceTests.testEverythingQuietHidesTheIndividualMark).
    expect(dashboard).toContain("everythingQuiet: state.mode.paused,\n");
    expect(dashboard).toContain("onToggleQuiet: { actions.onToggleQuiet(row) },");
    expect(content).toContain("onToggleQuiet: { toggleQuiet($0) },");
  });
});

describe("P and the header's Manual/Auto", () => {
  const press = section(content, "    private func pauseOrResume() {", "    private func moveSelection(by delta: Int) {");

  test("one session's toggle sends what its voice says, from the mark as from P", () => {
    const toggle = section(press, "private func toggleQuiet(", "private func showQuietToast(");
    expect(toggle).toContain("let voice = row.voice(everythingQuiet: store.state?.mode.paused ?? false)");
    expect(toggle).toContain(
      "store.send(.scoped(voice.togglesToQuiet ? .pause : .resume, sessionId: row.id, label: row.label))",
    );
  });

  test("P is never silent: every press shows what it did and how to undo it", () => {
    // One session: the toast is read from the state BEFORE the press.
    expect(press).toContain("toggleQuiet(selectedRow, announcing: true)");
    const toggle = section(press, "private func toggleQuiet(", "private func showQuietToast(");
    expect(toggle).toContain("guard announcing else { return }");
    expect(toggle).toContain("showQuietToast(voice.toggledToast(label: row.label)");
    // Every session, both ways.
    expect(press).toContain("showQuietToast(SessionVoice.toggledAllToast(nowQuiet: true, stillQuiet: 0), mark: .quiet)");
    expect(press).toContain("showQuietToast(SessionVoice.toggledAllToast(nowQuiet: false, stillQuiet: stillQuiet), mark: .speaks)");
    // Shown, said to VoiceOver, and cleared only by its own timer.
    const show = section(press, "private func showQuietToast(", "\n    }\n");
    expect(show).toContain("quietToast = toast");
    expect(show).toContain("AccessibilityNotification.Announcement(text).post()");
    expect(show).toContain("if quietToast?.id == toast.id { quietToast = nil }");
    expect(content).toContain("QuietToastView(toast: quietToast)");
  });

  test("a bare P reaches here only with nothing typeable focused, and does not repeat", () => {
    const monitor = read("mac-app/conch-mac/DashboardInputMonitor.swift");
    const handler = section(monitor, "keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {", "func removeMonitor()");
    const editable = handler.indexOf("if firstResponderIsEditableText() {");
    const web = handler.indexOf("if firstResponderIsWebContent(), !key.isGlobalDashboardControl {");
    const repeat = handler.indexOf("if event.isARepeat && key != .moveUp && key != .moveDown {");
    const dispatch = handler.indexOf("return onKey(key) ? nil : event");
    for (const at of [editable, web, repeat]) {
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(dispatch);
    }
    expect(section(monitor, "var isGlobalDashboardControl: Bool {", "\n    }\n")).toContain("case .pauseOrResume, .showKeyboardShortcuts");
  });

  test("the header button's tooltip names its scope: this session, or every session", () => {
    const header = section(dashboard, "    private var modeHelp: String {", "\n    }\n");
    expect(header).toContain("return SessionVoice.modeHelp(everythingQuiet: everythingQuiet, on: .mac)");
    expect(header).toContain("return selectedRow.voice(everythingQuiet: everythingQuiet).modeHelp(label: selectedRow.label)");
    const toggle = section(dashboard, "private struct ModeToggle: View {", "\n}\n");
    expect(toggle).toContain("return scopeHelp");
    expect(toggle).not.toContain("Switch \\(scope)");
    // The label keeps its established names.
    expect(toggle).toContain('Text(isManual ? "Manual" : "Auto")');
  });

  test("the palette reads the same rule, so an exempt session offers Quiet", () => {
    expect(palette).toContain("import ConchDesign");
    const row = section(palette, "private static func conch(_ row: SessionRow, globallyPaused: Bool)", "PaletteCommand(id: \"wake\"");
    expect(row).toContain("let voice = row.voice(everythingQuiet: globallyPaused)");
    expect(code(row)).not.toContain("globallyPaused || row.paused");
    expect(row).not.toContain("Pause \\(row.label)");
  });
});

describe("the words", () => {
  test("the legend says Quiet, from SessionVoice, and no pause glyph means a mode", () => {
    const legend = section(content, "private let entries: [Entry] = [", "    ]\n");
    expect(legend).toContain(
      "Entry(symbol: SessionVoice.Mark.quiet.symbol, color: ConchPalette.textDim, meaning: SessionVoice.Mark.quiet.meaning),",
    );
    expect(legend).toContain(
      "Entry(symbol: SessionVoice.Mark.speaks.symbol, color: ConchPalette.textDim, meaning: SessionVoice.Mark.speaks.meaning),",
    );
    expect(legend).not.toContain("Manual — turns held for later");
    expect(legend).not.toContain('"pause.fill"');
    expect(read("design/ConchDesign/Sources/ConchDesign/SessionVoice.swift")).toContain(
      'case .quiet: "Quiet — won\'t be read aloud"',
    );
  });

  test("the shortcuts say what P does to one session and to all", () => {
    const sheet = section(content, "private struct KeyboardShortcutsSheet: View {", "/// What the ledger's glyphs mean");
    expect(sheet).toContain('ShortcutHelpRow(command: "P", result: "Quiet / speak for the selected session (all, if none)")');
  });

  test("the daemon's log says quiet and how to undo it, not paused", () => {
    const controls = read("src/instant-controls.ts");
    const setPaused = section(controls, "  setSessionPaused(sessionId: string, next: boolean): void {", "\n  }\n");
    expect(setPaused).toContain('`quiet: "${label}" keeps working but won\'t be read aloud — p on it, or its speaker mark, lets it speak`');
    expect(setPaused).toContain('`speaks: "${label}" is read aloud again — the rest stay quiet`');
    expect(setPaused).not.toContain("⏸ manual for");
    expect(setPaused).not.toContain("▶ auto for");
    expect(read("src/voice-loop.ts")).not.toContain("is manual — park it and press p for auto");
  });

  test("every file that reads SessionVoice imports the design system", () => {
    for (const path of [
      "mac-app/conch-mac/DashboardView.swift",
      "mac-app/conch-mac/ContentView.swift",
      "mac-app/conch-mac/CommandPaletteView.swift",
      "mac-app/conch-mac/Models.swift",
      "mobile/conch-ios/conch-ios/LedgerView.swift",
      "mobile/conch-ios/conch-ios/Models.swift",
    ]) {
      const source = read(path);
      expect(source, path).toContain("SessionVoice");
      expect(source, path).toContain("import ConchDesign");
    }
  });
});

describe("the phone, in parity", () => {
  test("a quiet session keeps its status mark and is not dimmed", () => {
    expect(statusMark).not.toContain("case .paused");
    const byRow = section(statusMark, "    init(row: PublishedState.Row) {", "    var symbol: String {");
    expect(byRow.length).toBeGreaterThan(400);
    expect(code(byRow)).not.toMatch(/row\.(paused|pauseExempt)/);
    expect(iosRow).not.toMatch(/opacity\([^)]*paused/);
    expect(iosRow).toContain("Image(systemName: mark.symbol)");
  });

  test("the row carries the same mark from the same rule, and tapping it is the undo", () => {
    expect(iosModels).toContain("SessionVoice(sessionQuiet: paused, exempt: pauseExempt, everythingQuiet: everythingQuiet)");
    expect(iosModels).toContain("pauseExempt = (try? c.decodeIfPresent(Bool.self, forKey: .pauseExempt)) ?? false");
    expect(iosRow).toContain("private var voice: SessionVoice { row.voice(everythingQuiet: everythingQuiet) }");
    const mark = section(iosRow, "if let quiet = voice.mark {", ".accessibilityLabel(quiet.help(on: .phone))");
    expect(mark).toContain("Button { onToggleQuiet?() } label: {");
    expect(mark).toContain("SessionVoiceGlyph(quiet, pointSize: 11)");
    expect(mark).toContain(".buttonStyle(.borderless)");
    // Built with the global mode, so everything quiet hides the individual mark here too.
    expect(iosLedger).toMatch(/SessionRowView\(\s*row: row,\s*everythingQuiet: state\.mode\.paused,\s*onToggleQuiet: \{ toggleQuiet\(row\) \}/);
  });

  test("the phone's toggle is the Mac's scoped command, by the same rule", () => {
    const toggle = section(iosLedger, "    private func toggleQuiet(_ row: PublishedState.Row) {", "\n    }\n");
    expect(toggle).toContain("let voice = row.voice(everythingQuiet: bridge.state?.mode.paused ?? false)");
    expect(toggle).toContain('bridge.send(mode: voice.togglesToQuiet ? "pause" : "resume", sessionId: row.id, label: row.label)');
    expect(iosBridge).toContain('await post(control: ["type": action, "sessionId": sessionId, "label": label, "announce": ""])');
    // The mode button names every session, from the same words as the Mac's.
    expect(iosLedger).toContain(".accessibilityLabel(SessionVoice.modeHelp(everythingQuiet: passive, on: .phone))");
    expect(iosLedger).not.toContain("Manual — conch stays quiet and waits");
  });
});
