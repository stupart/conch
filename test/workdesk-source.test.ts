import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pausedRefusal } from "../src/browser-workbench.ts";

/**
 * The Workdesk's browser in the Mac app (2026-10-16). Tyler: "letting me sign-in in an in-conch browser session and
 * letting agents use that browser in the app so i can watch them work". What the app's sources must keep doing: his +
 * opens a tab of his own, a blank one's profile can be picked, Pause agents refuses agents' commands even on their way,
 * their commands are seen happening, and their work takes the Workdesk from nobody who is using it. The pure rules are
 * ConchDesign's (WorkbenchTests), the daemon's half browser-workbench.test.ts.
 */
const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const code = (path: string) => read(path).replace(/^\s*\/\/.*$/gm, "");
const between = (text: string, from: string, to: string) => {
  const start = text.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = text.indexOf(to, start + from.length);
  expect(end, to).toBeGreaterThan(start);
  return text.slice(start, end);
};

const workbench = code("mac-app/conch-mac/Workbench.swift");
const dashboard = code("mac-app/conch-mac/DashboardView.swift");
const models = code("mac-app/conch-mac/Models.swift");
const rules = read("design/ConchDesign/Sources/ConchDesign/Workbench.swift");
const views = code("design/ConchDesign/Sources/ConchDesign/WorkdeskViews.swift");
const workspace = read("design/ConchDesign/Sources/ConchDesign/Workspace.swift");

describe("the user's own tab: the Workdesk's +", () => {
  test("the strip ends in a +, outside the scroller, for a session's own Workdesk; the session menu has it too", () => {
    const strip = between(dashboard, "private func deliverableTabs(for row: SessionRow) -> some View {", "private func conversationBody(for row: SessionRow?) -> some View {");
    const scroller = strip.indexOf(".scrollIndicators(.never)");
    const plus = strip.indexOf("WorkdeskNewTabButton { openBrowserTab(for: row) }");
    expect(plus).toBeGreaterThan(scroller);
    expect(strip).toContain("if opensBrowserTabs(row) {");
    const menu = between(dashboard, "private func sessionBar(for row: SessionRow) -> some View {", "private var approveControl: some View {");
    expect(menu).toContain('Button("New Browser Tab") {\n                        openBrowserTab(for: row)\n                    }');
    // Never a subagent's or the practice session's.
    expect(between(dashboard, "private func opensBrowserTabs(_ row: SessionRow) -> Bool {", "\n    }")).toContain("row.parentSessionId == nil && row.id != TourCoach.practiceSessionId");
  });

  test("it asks the daemon for a blank tab on the profile picked last, shows it, and only a press opens the Workdesk", () => {
    const open = between(dashboard, "private func openBrowserTab(for row: SessionRow) {", "\n    }\n");
    expect(open).toContain("WorkbenchNewTab.profile(among: workbench.profiles)");
    expect(open).toContain("await workbench.openTab(sessionId: row.id, profile: profile)");
    expect(open).toContain("workspace.show(browserTab: id, for: row.id)");
    // From the conversation alone, the ⌘2 door: the stage moves only because Tyler pressed something.
    expect(open).toContain("if stage(for: row) == .conversation {");
    expect(open).toContain("NotificationCenter.default.post(name: .setStage, object: StageMode.sideBySide)");
    expect(open).not.toContain("workspace.show(stage:");
    expect(open).toContain("browserTabFailure = failure.words");
    const store = between(workbench, "func openTab(sessionId: String, profile: String) async -> Result<String, WorkbenchFailure> {", "\n    }\n");
    expect(store).toContain("WorkbenchTabOpen(sessionId: sessionId, profile: profile)");
    expect(store).toContain("focusAddress = id");
    expect(between(workbench, "struct WorkbenchTabOpen: Encodable {", "}")).toContain('let kind = "browser-tab-open"');
  });

  test("a blank tab's address field takes the keyboard, and its profile can be picked or made", () => {
    const pane = between(workbench, "struct WorkbenchPane: View {", "enum WorkbenchNewTab {");
    expect(pane).toContain("canPickProfile: isBlank");
    expect(pane).toContain("private var isBlank: Bool { tab.isBlank && page.url == nil }");
    expect(pane).toContain("if isBlank { WorkbenchBlankPage(profileName: profileName) }");
    expect(pane).toContain("guard store.focusAddress == tab.id else { return }");
    expect(pane).toContain("editing = true");
    expect(pane).toContain("await store.setProfile(tab.id, profile: id)");
    expect(pane).toContain("await store.createProfile(named: name)");
    // A profile made here is `browser-profiles add`, as Settings › Browser makes one.
    expect(between(workbench, "func createProfile(named name: String) async -> Result<String, WorkbenchFailure> {", "\n    }\n"))
      .toContain('await ChromeImport.profiles("add", name: name)');
    // The daemon moves its profile; the app makes its page again on that profile's store.
    const accept = between(workbench, "func accept(_ snapshot: PublishedState) {", "\n    }\n");
    expect(accept).toContain("guard let page = pages[tab.id], page.profile != tab.profile else { continue }");
    expect(between(workbench, "struct WorkbenchTabEvent: Encodable {", "}")).toContain("var profile: String?");
  });

  test("the published tab says who opened it and whether it is paused", () => {
    expect(between(models, "struct BrowserTab: Decodable, Equatable, Sendable {", "}")).toContain("let opener: String?");
    expect(between(models, "struct BrowserTab: Decodable, Equatable, Sendable {", "}")).toContain("let paused: Bool?");
    expect(workbench).toContain('openedByUser: opener == "user", paused: paused == true');
  });
});

describe("Pause agents in this tab", () => {
  test("the toggle tells the daemon at once, and the tab shows it before the daemon says so again", () => {
    const pause = between(workbench, "func setPaused(_ id: String, _ paused: Bool) {", "\n    }\n");
    expect(pause).toContain("pausing[id] = paused");
    expect(pause).toContain("pages[id]?.agentsPaused = paused");
    expect(pause).toContain("WorkbenchTabEvent(tab: id, paused: paused)");
    expect(between(workbench, "struct WorkbenchPane: View {", "enum WorkbenchNewTab {")).toContain("togglePause: { store.setPaused(tab.id, !tab.paused) }");
  });

  test("a command on its way when the pause went on is refused too, in the daemon's own words", () => {
    const handle = between(workbench, "private func handle(_ requests: [PublishedState.BrowserRequest]) {", "\n    }\n}");
    expect(handle.indexOf("if page.agentsPaused {")).toBeLessThan(handle.indexOf("await page.run(request, text: ack.text)"));
    expect(handle).toContain("Workbench.pausedRefusal(tab: request.tab)");
    const execute = between(workbench, "private func execute(_ request: PublishedState.BrowserRequest, text: String?, deadline: Date) async -> WorkbenchAnswer {", 'case "open":');
    expect(execute).toContain("if agentsPaused { return WorkbenchAnswer(request: request.id, error: Workbench.pausedRefusal(tab: id)) }");
    // The words: the Swift literal is the daemon's function, for any tab.
    const literal = /public static func pausedRefusal\(tab: String\) -> String \{\n\s+"(.*)"\n/.exec(rules)?.[1];
    expect(literal).toBeDefined();
    expect(literal!.replace("\\(tab)", "tab-1a2b3c4d")).toBe(pausedRefusal("tab-1a2b3c4d"));
  });
});

describe("watching an agent work", () => {
  test("a command running in a tab puts Agent on it and its bar, saying what it does and never what it types", () => {
    const began = between(workbench, "private func began(_ request: PublishedState.BrowserRequest) {", "\n    }\n");
    expect(began).toContain("working[id] = Workbench.agentWords(op: request.op)");
    expect(between(workbench, "private func ended(_ request: PublishedState.BrowserRequest) {", "\n    }\n")).toContain("Workbench.agentLinger");
    expect(dashboard).toContain("agentWorking: workbench.working[tab.id] != nil,");
    expect(between(workbench, "struct WorkbenchPane: View {", "enum WorkbenchNewTab {")).toContain("agentWork: store.working[tab.id],");
    // The badge is handed words, never the text an agent types.
    expect(views).toContain('Text(words.map { "Agent · \\($0)" } ?? "Agent")');
    expect(workbench).not.toMatch(/agentWords\(op: [^)]*text/);
  });

  test("a click is marked where it lands before it happens, and a field is outlined while it fills", () => {
    const execute = between(workbench, "private func execute(_ request: PublishedState.BrowserRequest, text: String?, deadline: Date) async -> WorkbenchAnswer {", "private func markTarget(");
    const click = between(execute, 'case "click":', 'case "type":');
    expect(click.indexOf("await markTarget(target, kind: .click)")).toBeLessThan(click.indexOf('op: "click"'));
    const type = between(execute, 'case "type":', 'case "screenshot":');
    expect(type.indexOf("await markTarget(target, kind: .type)")).toBeLessThan(type.indexOf('op: "type"'));
    // A password field is refused before anything is marked or typed.
    expect(type).toContain("if let refused = await markTarget(target, kind: .type) { return answer(request, error: refused) }");
    const mark = between(workbench, "private func markTarget(", "private func clearMark(");
    expect(mark).toContain('op: kind == .type ? "locate-field" : "locate"');
    expect(mark).toContain("Workbench.markRect(box: box, scale: Double(view.pageZoom * view.magnification))");
    expect(between(workbench, "struct WorkbenchPane: View {", "enum WorkbenchNewTab {")).toContain(".overlay { WorkbenchMarks(mark: page.mark) }");
    // The marks never take a click from the page beneath.
    expect(between(views, "public struct WorkbenchMarks: View {", "public struct WorkbenchBlankPage: View {")).toContain(".allowsHitTesting(false)");
  });

  test("a tab acted in unseen gets a dot; one comes forward only by the follow rule, and never moves the stage", () => {
    expect(dashboard).toContain("hasActivity: Workbench.showsActivity(tab.id, actedIn: workbench.actedIn, shown: shownTab),");
    expect(between(workbench, "private func began(_ request: PublishedState.BrowserRequest) {", "\n    }\n")).toContain("if id != shown { actedIn.insert(id) }");
    const follow = between(dashboard, "private func followAgent(_ activity: WorkbenchStore.AgentActivity?) {", "\n    }\n");
    expect(follow).toContain("Workbench.follows(activity.tab, viewing: row.id, shown: shown, lastTouch: workbench.lastTouch, now: Date())");
    expect(follow).toContain("let shown = workPane(for: row) == .browser ? selectedBrowserTab?.id : nil");
    // Only while the Workdesk is on screen, and it never moves the stage itself.
    expect(follow).toContain("stage(for: row) != .conversation");
    expect(follow).not.toContain("show(stage:");
    expect(follow).not.toContain("setStage");
    expect(dashboard).toContain(".onChange(of: workbench.agentActivity) { _, activity in followAgent(activity) }");
    // What counts as Tyler touching the Workdesk: his hand in a shown page, and its own controls.
    expect(workbench).toContain("NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .scrollWheel])");
    expect(between(workbench, "private func noteTouch(_ event: NSEvent) {", "\n    }\n")).toContain("page.isShown && page.webView.window === event.window");
  });
});

describe("the Workdesk, by name", () => {
  test("the pane is the Workdesk where the user reads it: the strip, the side-by-side help, the divider", () => {
    expect(dashboard).toContain(".accessibilityLabel(Workdesk.name)");
    expect(dashboard).toContain('help: "The Workdesk and the conversation together (⌘2)"');
    expect(dashboard).toContain('.accessibilityLabel("Resize the split between the conversation and the Workdesk")');
    expect(dashboard).not.toContain('"The work and the exchange together (⌘2)"');
  });

  test("its items are typed, and the type is the model's own", () => {
    expect(workspace).toContain("public enum WorkPane: String, Equatable, Sendable, Codable, CaseIterable {");
    expect(workspace).toContain("public typealias ItemType = WorkPane");
    for (const type of ["deliverable", "browser", "files", "shell", "terminal"]) expect(workspace).toContain(`case .${type}:`);
  });
});
