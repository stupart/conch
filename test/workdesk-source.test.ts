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

describe("the run: what an agent last touched is at the right end", () => {
  test("pages and filed work are one line, in Workdesk.run's order, held while the pointer is in it", () => {
    const strip = between(dashboard, "private func deliverableTabs(for row: SessionRow) -> some View {", "private func conversationBody(for row: Sessi");
    expect(strip).toContain("let liveRun = Workdesk.run(tabs: browserTabs, groups: deliverableGroups) { byID[$0.newest]?.reviewedAt }");
    expect(strip).toContain("let run = Workdesk.held(liveRun, order: heldRun)");
    expect(strip).toContain("ForEach(run) { entry in");
    expect(strip).toContain("hovering: { heldRun = $0 ? run.map(\\.id) : nil },");
    // The end is the live one: a tab held back under the pointer is still what the run goes to when it leaves.
    expect(strip).toContain("newest: liveRun.last.map { Workdesk.RunEnd(id: $0.id, at: $0.agentAt) },");
  });

  test("the run opens at its end, goes back when that changes, and never scrolls under the pointer", () => {
    const run = between(views, "public struct WorkdeskTabRun<Content: View>: View {", "extension View {");
    expect(run).toContain("reveal(attention ?? newest?.id ?? shown, in: proxy, animated: false)");
    expect(run).toContain("if pointerIn { endWaits = true } else { reveal(attention ?? now?.id, in: proxy, animated: true) }");
    expect(run).toContain("if !inside, endWaits {");
  });

  test("the app reads when an agent last used a tab, and a daemon without it is no failure", () => {
    expect(readFileSync(join(import.meta.dir, "..", "mac-app/conch-mac/Models.swift"), "utf8")).toContain("usedAt = try? container.decodeIfPresent(Double.self, forKey: .usedAt)");
    expect(workbench).toContain("openedAt: openedAt, usedAt: usedAt,");
  });
});

describe("the user's own tab: the Workdesk's +", () => {
  test("the strip ends in a +, outside the scroller, for a session's own Workdesk; the session menu has it too", () => {
    const strip = between(dashboard, "private func deliverableTabs(for row: SessionRow) -> some View {", "private func conversationBody(for row: SessionRow?) -> some View {");
    // The run of tabs is ConchDesign's: it ends in the +, after the scroller, a fixed gutter on (2026-10-16).
    expect(strip).toContain("newTab: opensBrowserTabs(row) ? { openBrowserTab(for: row) } : nil");
    const run = between(views, "public struct WorkdeskTabRun<Content: View>: View {", "extension View {");
    expect(run.indexOf("WorkdeskNewTabButton(isHovered: newTabHovered, action: newTab)")).toBeGreaterThan(run.indexOf(".scrollIndicators(.never)"));
    expect(run).toContain(".padding(.leading, Self.gutter)");
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
    // A loaded tab names its profile when there is more than one to be signed in with (ConchDesign `Facts.namesProfile`).
    expect(pane).toContain("profileCount: store.profiles.count,");
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
    const mark = between(workbench, "private func markTarget(", "private func endMark(");
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
    // 2026-10-18: over a deliverable too, unless one was just put in front of him; never over a tab that needs him; and
    // only with Settings › Browser's "Bring the agent's tab forward" on.
    expect(follow).toContain("activity.tab, viewing: row.id, front: workdeskFront(for: row), frontNeedsYou: frontNeedsYou(for: row),");
    expect(follow).toContain("lastTouch: workbench.lastTouch, deliverableSince: deliverableSince(for: row), enabled: followsAgent, now: Date()");
    // Only while the Workdesk is on screen (no front from the conversation alone), and it never moves the stage itself.
    expect(between(dashboard, "private func workdeskFront(for row: SessionRow) -> Workbench.Front? {", "\n    }\n")).toContain("guard hasWorkPane, stage(for: row) != .conversation else { return nil }");
    expect(follow).not.toContain("show(stage:");
    expect(follow).not.toContain("setStage");
    expect(dashboard).toContain(".onChange(of: workbench.agentActivity) { _, activity in followAgent(activity) }");
    expect(dashboard).toContain("@AppStorage(Workbench.followSettingKey) private var followsAgent = true");
    expect(between(dashboard, "private func bringBrowserTabForward(_ arrival: WorkbenchStore.Arrival?) {", "\n    }\n")).toContain("guard followsAgent || tab.openedByUser, !frontNeedsYou(for: row) else { return }");
    // A deliverable is put in front by its filing or by his opening it, whichever is later.
    const since = between(dashboard, "private func deliverableSince(for row: SessionRow) -> Date? {", "\n    }\n");
    expect(since).toContain("review.reviewedAt.map { Date(timeIntervalSince1970: $0 / 1000) }");
    expect(dashboard).toContain(".onChange(of: shownDeliverableKey, initial: true) { _, key in");
    // What counts as Tyler touching the Workdesk: his hand in a shown page, anywhere else in it, and its own controls.
    expect(workbench).toContain("NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .scrollWheel])");
    const touch = between(workbench, "private func noteTouch(_ event: NSEvent) {", "func watch(_ view: NSView) {");
    expect(touch).toContain("page.isShown && page.webView.window === window");
    expect(touch).toContain("for area in areas {");
    expect(touch).toContain("if event.type == .keyDown { lastTyped = Date() }");
    // The areas: the strip, and the work half in either stage.
    expect(dashboard.match(/\.background\(WorkdeskTouchArea\(store: workbench\)\)/g)).toHaveLength(3);
    expect(between(workbench, "struct WorkdeskTouchArea: NSViewRepresentable {", "func makeNSView")).toContain("override func hitTest(_ point: NSPoint) -> NSView? { nil }");
  });
});

/**
 * An agent asks the user to act in a tab (2026-10-18). Tyler, after missing one: "the tab didn't get any sort of emphasis
 * and it was all the way on the left so i missed it. also ... showing automatically the tab in conch the agent is using?"
 */
describe("a tab that needs the user", () => {
  test("its ask comes off the sessions file into the tab, leniently: one the app can't read never drops the tab", () => {
    const tab = between(models, "struct BrowserTab: Decodable, Equatable, Sendable {", "struct BrowserRequest: Decodable");
    expect(tab).toContain("ask = (try? container.decodeIfPresent(Ask.self, forKey: .ask)) ?? nil");
    expect(workbench).toContain("ask: ask.map { Workbench.Tab.Ask(reason: $0.reason, at: $0.at) }");
  });

  test("it takes the stage once, by the summons rule, waiting while his hand is on the Workdesk", () => {
    const summon = between(dashboard, "private func summonAsk() {", "\n    }\n\n");
    expect(summon).toContain("switch Workbench.summons(tab, viewing: row.id, front: workdeskFront(for: row), lastTouch: workbench.lastTouch, lastTyped: workbench.lastTyped, now: Date()) {");
    expect(summon).toContain("!presentedAsks.contains(key)");
    expect(summon).toContain("workspace.show(browserTab: tab.id, for: row.id)");
    expect(summon).toContain("askTick &+= 1");
    expect(dashboard).toContain(".onChange(of: askSignature, initial: true) { _, _ in summonAsk() }");
    expect(dashboard).toContain(".onChange(of: askTick) { _, _ in summonAsk() }");
  });

  test("the strip scrolls it into view and says Needs you; under its bar, who asks and what, with Done", () => {
    const strip = between(dashboard, "private func deliverableTabs(for row: SessionRow) -> some View {", "private func conversationBody(for row: SessionRow?) -> some View {");
    expect(strip).toContain('attention: Workbench.asking(in: browserTabs, session: row.id).map { AnyHashable("browser:" + $0.id) },');
    const run = between(views, "public struct WorkdeskTabRun<Content: View>: View {", "extension View {");
    expect(run).toContain(".onChange(of: attention) { _, now in reveal(now, in: proxy, animated: true) }");
    expect(between(views, "public struct WorkbenchTabButton: View {", "public struct WorkdeskNewTabButton: View {")).toContain("if tab.ask != nil {\n                WorkdeskNeedsYouPill()");
    const pane = between(workbench, "struct WorkbenchPane: View {", "enum WorkbenchNewTab {");
    expect(pane).toContain("WorkbenchNotice(.needsYou(agent: agent, reason: ask.reason)) { store.answer(tab) }");
    expect(dashboard).toContain("agent: AgentBadge.name(for: row.backend),");
    // Done: hidden at once, and the daemon told, which tells the agent.
    const answer = between(workbench, "func answer(_ tab: Workbench.Tab) {", "\n    }\n");
    expect(answer).toContain("tabs = tabs.map { $0.id == tab.id ? $0.with(ask: nil) : $0 }");
    expect(answer).toContain("WorkbenchTabEvent(tab: tab.id, askDone: true)");
  });

  test("its session's row is drawn as one that needs him, and the Dock counts it", () => {
    expect(dashboard).toContain("row: row.needingYou(in: browserAsks[row.id]),");
    const needing = between(models, "func needingYou(in reason: String?) -> SessionRow {", "\n    }\n");
    expect(needing).toContain("status: .needs, at: at, needsResponse: true,");
    expect(needing).toContain("detail: (status == .needs ? detail : nil) ?? Workbench.rowAskLine(reason: reason),");
    expect(code("mac-app/conch-mac/StateStore.swift")).toContain("row.status == .needs || row.status == .review || asking.contains(row.id)");
  });

  test("Settings › Browser turns following off; a tab that needs him comes forward regardless", () => {
    const settings = code("mac-app/conch-mac/BrowserSettingsView.swift");
    expect(settings).toContain("@AppStorage(Workbench.followSettingKey) private var follows = true");
    expect(settings).toContain('Text("Bring the agent\'s tab forward")');
    // The summons never reads the setting.
    expect(between(dashboard, "private func summonAsk() {", "\n    }\n\n")).not.toContain("followsAgent");
  });

  test("a page that asks for a passkey is heard in conch's world alone, and said under the bar", () => {
    const page = between(workbench, "init(tab: Workbench.Tab, store: WKWebsiteDataStore, report: @escaping (WorkbenchTabEvent) -> Void) {", "super.init()");
    expect(page).toContain("WKUserScript(source: WorkbenchPasskeys.pageScript(event: event), injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page)");
    expect(page).toContain("WKUserScript(source: WorkbenchPasskeys.listenerScript(event: event), injectionTime: .atDocumentStart, forMainFrameOnly: false, in: Self.world)");
    expect(page).toContain("content.add(messages, contentWorld: Self.world, name: WorkbenchPasskeys.messageHandler)");
    expect(workbench).not.toMatch(/add\(messages, contentWorld: \.page/);
    expect(between(workbench, "struct WorkbenchPane: View {", "enum WorkbenchNewTab {")).toContain("WorkbenchNotice(.passkeys) {");
    expect(between(workbench, "private func sync() {", "\n    }\n")).toContain("if passkeyAsked != nil, Self.site(of: view.url) != passkeySite { passkeyAsked = nil }");
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
