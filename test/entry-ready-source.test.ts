import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How you get into the deconstructed UI, and what it says when you do: the menu's rows open the work, a page whose dev
 * server has stopped is said for what it is, the legend and the shortcuts use the names the surfaces use, and the phone
 * draws ready as the Mac does. Neither app has a test target for its own views, so the wiring is read here; the rules
 * themselves run as XCTests (ReadyTests) and against the daemon (ready-for-you.test.ts).
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** A Swift member from its signature to its closing brace at four-space indentation. */
function member(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf("\n    }\n", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const item = read("mac-app/conch-mac/StatusItem.swift");
const review = read("mac-app/conch-mac/ReviewView.swift");
const content = read("mac-app/conch-mac/ContentView.swift");

describe("the menu bar menu opens the work", () => {
  test("a Ready for you row opens its item as the pill does; conch's window is its ⌥ alternate", () => {
    const entry = member(item, "private func entry(_ item: StatusMenu.Item) -> NSMenuItem {");
    expect(entry).toContain("entry.isAlternate = item.alternate");
    expect(entry).toContain("case let .openItem(session), let .openSession(session): entry.representedObject = session");
    expect(entry).toContain("case .mixed: .mixed");
    const open = member(item, "@objc private func openItem(_ sender: NSMenuItem) {");
    expect(open).toContain("panels.queue.open(session: id, store: store, panels: panels)");
    expect(open).not.toContain("openSession(");
    // The alternate is conch's window, the one place the status item takes focus.
    expect(member(item, "@objc private func openSession(_ sender: NSMenuItem) {")).toContain("Self.openSession(id)");
  });
});

describe("a page whose server has stopped", () => {
  test("the pill and the menu knock before opening it in a browser, and show it in conch instead", () => {
    const stage = member(item, "static func stage(_ row: SessionRow, store: StateStore) async -> Bool {");
    const knock = stage.indexOf("if LocalServer.port(of: url) != nil, !(await LocalServer.isListening(url)) {");
    const browser = stage.indexOf("store.openLink(LinkTarget.text(of: url)");
    expect(knock).toBeGreaterThan(-1);
    expect(browser).toBeGreaterThan(knock);
    // Down, it is conch's window on the session, whose pane says so; never the browser tab that can't connect.
    const down = stage.slice(knock, browser);
    expect(down).toContain("openSession(row.id)");
    expect(down).toContain("return true");
  });

  test("the pane knocks before the page loads, and says the server isn't running in its place", () => {
    // The filed link is knocked on before the web view exists; a page that isn't local needs no knock.
    expect(review).toContain(".task(id: link) {");
    const task = review.slice(review.indexOf(".task(id: link) {"), review.indexOf("private func retryNavigation()"));
    expect(task).toContain("guard let page = URL(string: link), LocalServer.port(of: page) != nil else { knocked = true; return }");
    expect(task).toContain("await knock(page)");
    const down = review.indexOf("if let downPage {\n                    ServerDownView(");
    const web = review.indexOf("} else if knocked {\n                DeliverableWebView(");
    expect(down).toBeGreaterThan(-1);
    expect(web).toBeGreaterThan(down);
    // A failure reaching a local page, typed or followed to, is knocked on too.
    expect(review).toContain("if LocalServer.port(of: failure.url) != nil {");
    // WebKit's own failure, with its "Open in Browser", never shows over a stopped server.
    expect(review).toContain("if let failure = navigationFailure, downPage == nil {");
    const view = review.slice(review.indexOf("private struct ServerDownView: View {"));
    expect(view).toContain('Text("The page\\u{2019}s server isn\\u{2019}t running (\\(address))")');
    expect(view).toContain('Button("Ask \\(session) to start it", action: onAsk)');
    expect(view).toContain('Button("Try Again", action: onRetry)');
  });

  test("asking goes to that session through inject, and only when Tyler presses it", () => {
    const ask = member(review, "private func askToStart(_ page: URL) {");
    expect(ask).toContain("store.send(.inject(sessionId: row.id, label: row.label, text: Self.startServerPrompt(page)))");
    // Called from the button alone: the declaration and the one press.
    expect(review.match(/askToStart\(/g)?.length).toBe(2);
    expect(review).toContain("onAsk: { askToStart(downPage) },");
    expect(member(review, "static func startServerPrompt(_ page: URL) -> String {")).toContain("nothing is listening on \\(LocalServer.name(of: page))");
  });
});

describe("one state, one name", () => {
  test("the legend calls come-and-look Ready for you, and the old names are gone", () => {
    const legend = content.slice(content.indexOf("private let entries: [Entry] = ["), content.indexOf("var body: some View {", content.indexOf("private let entries: [Entry] = [")));
    expect(legend).toContain('Entry(symbol: "circle.inset.filled", color: ConchPalette.statusWaiting, meaning: "Ready for you — its turn is over")');
    expect(legend).toContain('Entry(symbol: "checkmark.circle.fill", color: ConchPalette.statusReview, meaning: "Ready for you — work to look at")');
    for (const old of ["Has work for you to look at", "Finished — waiting on you", "Has work to look at"]) {
      for (const path of ["mac-app/conch-mac/ContentView.swift", "mac-app/conch-mac/DashboardView.swift", "mobile/conch-ios/conch-ios/Models.swift", "design/ConchDesign/Sources/conch-design-gallery/main.swift"]) {
        expect(read(path), `${path}: ${old}`).not.toContain(old);
      }
    }
    const dashboard = read("mac-app/conch-mac/DashboardView.swift");
    expect(dashboard).toContain('return "Ready for you — its turn is over"');
    expect(dashboard).toContain('return "Ready for you — work to look at"');
  });

  test("the shortcuts say Talk and Quiet, and list the keys of what floats over other apps", () => {
    const sheet = content.slice(content.indexOf("private struct KeyboardShortcutsSheet: View {"), content.indexOf("/// What the ledger's glyphs mean"));
    expect(sheet).not.toContain("Auto / manual");
    expect(sheet).toContain('ShortcutHelpRow(command: "P", result: "Talk / Quiet")');
    // Space stops and never starts (`talkOrStop`).
    expect(sheet).toContain('ShortcutHelpRow(command: "Space", result: "Stop speaking or listening")');
    for (const row of [
      'ShortcutHelpRow(command: "⌃⌥⌘P", result: "Draw on screen")',
      'ShortcutHelpRow(command: "1 – 5", result: "Pick a pen tool")',
      'ShortcutHelpRow(command: "Return", result: "Send")',
      'ShortcutHelpRow(command: "Esc", result: "Put the pen down")',
      'ShortcutHelpRow(command: "⌥⌘← / ⌥⌘→", result: "Previous / next item")',
      'ShortcutHelpRow(command: "⌘.", result: "Collapse")',
      'ShortcutHelpRow(command: "Esc", result: "Leave full screen")',
    ]) {
      expect(sheet).toContain(row);
    }
    expect(sheet).toContain('ShortcutHelpSection(title: "Drawing on screen", rows: drawRows)');
    // The key the canvas actually takes for Show (⇧R: a bare R started recordings by accident).
    expect(sheet).toContain('ShortcutHelpRow(command: "⇧R", result: "Show: record the screen")');
    expect(sheet).toContain('ShortcutHelpSection(title: "Conversation panel", rows: panelRows)');
    // Esc and Return each mean two things in one list, so a row is its key and its meaning.
    expect(content).toContain('var id: String { command + "\\u{1F}" + result }');
  });

  test("agents are told marks are drawn where conch shows the work, not wherever it is on screen", () => {
    const doc = read("docs/conch-control-skill.md");
    expect(doc).not.toContain("wherever it is on screen");
    expect(doc).not.toContain("where the user is looking");
    expect(doc).toContain("result where conch shows it, in its own conversation panel or side panel,");
    expect(read("src/mcp.ts")).not.toContain("where the user is looking");
    expect(read("src/mcp.ts")).toContain("never over a browser or another app, so a result with marks opens in conch's panel");
  });
});

describe("the phone draws ready as the Mac does", () => {
  test("waiting is ready's green, and what was only borrowing the orange keeps it under its own name", () => {
    const theme = read("mobile/conch-ios/conch-ios/Theme.swift");
    expect(theme).toContain("static let waiting = ConchColor.ready.dynamic");
    expect(theme).toContain("static let review = ConchColor.ready.dynamic");
    expect(theme).toContain("static let caution = Color(red: 0.96, green: 0.60, blue: 0.13)");
    expect(read("mac-app/conch-mac/Palette.swift")).toContain("static let statusWaiting = ConchColor.ready.dynamic");
    // The stop button, a quiet connection and an unconfirmed send are cautions, not a session waiting on you.
    expect(read("mobile/conch-ios/conch-ios/SessionView.swift")).toContain(".background(Palette.caution, in: Circle())");
    expect(read("mobile/conch-ios/conch-ios/LedgerView.swift")).toContain(".foregroundStyle(Palette.caution)");
    for (const name of ["LedgerView.swift", "SessionView.swift"]) {
      expect(read(`mobile/conch-ios/conch-ios/${name}`), name).not.toContain("Palette.waiting");
    }
  });

  test("its captions name the state as the Mac does", () => {
    const models = read("mobile/conch-ios/conch-ios/Models.swift");
    const caption = models.slice(models.indexOf("var caption: String {"), models.indexOf("var meaning: String {"));
    expect(caption).toContain('case .waiting, .review: "Ready for you"');
    expect(models).toContain('case .waiting: "Ready for you — its turn is over"');
    expect(models).toContain('case .review: "Ready for you — work to look at"');
  });
});
