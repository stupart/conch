import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The Mac app's steady CPU (2026-11-02, Tyler: "yea go for it", about cutting it). The live app sat at 18-22% of a core
 * with 19 session rows, 8 of them working; a 30 s sample put almost all of it in SwiftUI re-evaluating the window.
 *
 * What the sample showed, and what each check below holds in place:
 * - the conversation pane was redrawn four times a second at rest, by a store that republished on every poll
 *   (idle-republish.test.ts);
 * - every redraw of the conversation updated every selectable text's `SelectionOverlay` again, because the stack's
 *   link action was a new closure in each body: 267 of the main thread's 4,400 busy samples, ~250 more after it;
 * - every publish from any session redrew the whole pane and every sidebar row, though a publish is almost always
 *   another session's activity line or its next message.
 *
 * Measured offscreen on the app's own window, compiled from these sources, with Tyler's sessions file (side by side, an
 * image deliverable, 21 rows), main thread a second, medians of five interleaved runs: at rest 50 ms became 2; with two
 * publishes a second from a session not on screen, 54 became 17; with one a second from the session on screen, 54
 * became 20. The apps have no XCTest target, so their wiring is pinned here as source, with line comments stripped so a
 * description can never satisfy a check; the logic is XCTested in ConchDesign (FileStampTests, WorkspaceTests).
 */
const swift = (file: string) =>
  readFileSync(new URL(`../mac-app/conch-mac/${file}`, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");

function at(text: string, marker: string, from = 0): number {
  const index = text.indexOf(marker, from);
  expect(index, `missing: ${marker}`).toBeGreaterThan(-1);
  return index;
}
function section(text: string, start: string, end: string): string {
  const a = at(text, start);
  return text.slice(a, at(text, end, a + start.length));
}
/** The stored `let`/`var` properties of a struct's head, with their types: not wrappers, not computed. */
function stored(head: string): { name: string; type: string }[] {
  return [...head.matchAll(/^ {4}(?:let|var) (\w+): ([^={\n]+?)(?: = [^\n]*)?$/gm)].map((m) => ({ name: m[1], type: m[2].trim() }));
}
const isClosure = (type: string) => type.includes("->");

const dashboard = swift("DashboardView.swift");
const stack = swift("ConversationStackView.swift");
const pane = section(dashboard, "private struct ConversationPane: View {", "extension ConversationPane: Equatable {");

describe("the conversation's link action is made once", () => {
  test("the stack hands down one action for its life, never one made in body", () => {
    const body = section(stack, "    var body: some View {", "    private var historyEdge: HistoryEdge {");
    expect(body).toContain(".environment(\\.openURL, links.action)");
    expect(body).not.toContain("OpenURLAction");
    expect(stack).toContain("@State private var links = StackLinks()");
    const links = section(stack, "private final class StackLinks {", "\n}\n");
    expect(links).toContain("private(set) lazy var action = OpenURLAction { [weak self] url in");
    // What a link does is the newest body's, so a session changing changes where a link goes.
    expect(body).toContain("let _ = links.open = { url in");
  });

  test("no other view in the window makes an OpenURLAction in its body", () => {
    for (const file of ["DashboardView.swift", "ReviewView.swift", "ComposerView.swift", "ContentView.swift"]) {
      expect(swift(file), file).not.toContain("OpenURLAction {");
    }
  });
});

describe("the conversation pane is drawn again only when what it reads changed", () => {
  test("it is handed the store, held and not watched, and what it draws from it as values", () => {
    expect(pane).toContain("    let store: StateStore\n");
    expect(pane).not.toContain("@EnvironmentObject private var store: StateStore");
    expect(pane).not.toContain("@ObservedObject private var composerDrafts");
    expect(pane).toContain("isRestarting: rowMessages[row.id] == StateStore.restartingMessage,");
    expect(pane).toContain(".onChange(of: debugInspectRequest) { _, wanted in");
    // Read from the store only in what a press does, never in what is drawn.
    expect(pane).not.toContain("store.isRestarting(");
    expect(pane).not.toContain("store.rowMessages");
    expect(pane).not.toContain(".onChange(of: store.");
  });

  test("the window hands it the state as it reads it, behind its own ==", () => {
    expect(dashboard).toContain(
      "ConversationPane(\n                                state: state?.forPane(pinned: selectedSessionID),\n                                store: store,\n                                rowMessages: store.rowMessages,\n                                outbox: store.outbox,\n                                debugInspectRequest: store.debugInspectRequest,\n                                onSelectSession: actions.onSelectSession\n                            )\n                            .equatable()",
    );
    // Every stored input but the closure is compared; the store by identity.
    const equal = section(dashboard, "extension ConversationPane: Equatable {", "\n}\n");
    const head = section(pane, "private struct ConversationPane: View {", "    @EnvironmentObject private var workspace: WorkspaceModel");
    const inputs = stored(head).filter((p) => !isClosure(p.type));
    expect(inputs.map((p) => p.name).sort()).toEqual(["debugInspectRequest", "outbox", "rowMessages", "state", "store"]);
    for (const { name } of inputs) {
      expect(equal).toContain(name === "store" ? "a.store === b.store" : `a.${name} == b.${name}`);
    }
  });

  /**
   * The pane may read only what `forPane` hands it whole. A field read here and dropped there would read as nil or empty,
   * always: so every field read of the state, in the pane and in everything it hands the state to, is one `forPane`
   * carries, and nothing reads `ts`, which moves on every publish.
   */
  test("everything the pane reads of the state is something forPane carries", () => {
    const forPane = section(dashboard, "func forPane(pinned: SessionRow.ID?) -> PublishedState {", "\n    }\n");
    const carried = [...forPane.matchAll(/^ {12}(\w+): /gm)].map((m) => m[1]);
    const readers = [
      pane,
      section(swift("ComposerView.swift"), "struct SessionComposer: View {", "private struct AttachmentStrip"),
      swift("Workspace.swift"),
      section(swift("TranscriptFallback.swift"), "struct ConversationDocument {", "\n}\n"),
      section(swift("ReviewView.swift"), "func changedFiles(in state: PublishedState?) -> ConchFileChanges {", "\n    }\n"),
    ];
    const reads = new Set<string>();
    for (const source of readers) {
      for (const match of source.matchAll(/\bstate\??\.(\w+)/g)) reads.add(match[1] === "row" ? "rows" : match[1]);
    }
    // Sanity: the reading this guards is really there.
    for (const field of ["rows", "conversations", "live", "seaGlass", "features", "sessionSettings", "reply", "audioControl"]) {
      expect(reads.has(field), field).toBe(true);
    }
    for (const field of reads) expect(carried, `the pane reads state.${field}`).toContain(field);
    expect(reads.has("ts")).toBe(false);
  });

  test("forPane keeps the shown sessions whole and every other row without its activity line", () => {
    const forPane = section(dashboard, "func forPane(pinned: SessionRow.ID?) -> PublishedState {", "\n    }\n");
    // A subagent the daemon lists no row for is built from any conversation: the whole state, as before.
    expect(forPane).toContain("if let pinned, row(pinned) == nil { return self }");
    expect(forPane).toContain("let shown = WorkspaceFocus.shown(in: Workspace(self), pinned: pinned)");
    expect(forPane).toContain("rows: rows.map { shown.contains($0.id) ? $0 : $0.withoutActivity() },");
    expect(forPane).toContain("conversations: conversations?.filter { shown.contains($0.key) },");
    expect(forPane).toContain("conversation: conversation.flatMap { shown.contains($0.sessionId) ? $0 : nil },");
    expect(forPane).toContain("ts: 0,");
  });

  test("a row without its activity line carries every other field the daemon published", () => {
    const models = swift("Models.swift");
    const struct = section(models, "struct SessionRow: Decodable", "private enum CodingKeys");
    const fields = [...struct.matchAll(/^ {4}(?:let|var) (\w+): [^{\n]+$/gm)].map((match) => match[1]);
    expect(fields).toContain("activity");
    const copy = section(models, "func withoutActivity() -> SessionRow {", "\n    }\n");
    for (const field of fields) {
      if (field === "activity") expect(copy).toContain("activity: nil");
      else expect(copy).toMatch(new RegExp(`\\b${field}: ${field}\\b`));
    }
  });
});

describe("a sidebar row is drawn again only when what it shows changed", () => {
  const ledger = section(dashboard, "private struct SessionLedger: View {", "private struct LedgerReveal: Equatable {");

  test("each row and agent group is behind its own ==", () => {
    expect(ledger).toMatch(/DashboardRow\([^]*?state\.rows\.first\(where: \{ \$0\.id == id \}\)\?\.label\s*\},[^]*?onMove: \{ perform\(\$0, on: row\.id\) \}\s*\)\s*\.equatable\(\)/);
    expect(ledger).toMatch(/AgentGroup\(\s*agents: agents,\s*selectedID: selectedSessionID,\s*onSelect: \{ actions\.onSelectSession\(\$0\) \}\s*\)\s*\.equatable\(\)/);
  });

  test("a row's == compares everything it is handed but its closures and the rename field's own text", () => {
    const head = section(dashboard, "private struct DashboardRow: View {", "    @Environment(\\.accessibilityReduceMotion) private var reduceMotion");
    const equal = section(dashboard, "extension DashboardRow: Equatable {", "\n}\n");
    const inputs = stored(head).filter((p) => !isClosure(p.type) && p.name !== "rowHeight");
    expect(inputs.length).toBeGreaterThan(6);
    // `now` by the one thing drawn from it, the age: the list's clock is a new one at each of its bodies.
    for (const { name } of inputs) expect(equal).toContain(name === "now" ? "a.age == b.age" : `a.${name} == b.${name}`);
    const head2 = section(dashboard, "private struct DashboardRow: View {", "extension DashboardRow: Equatable {");
    const rest = head2.replace("    let now: Date\n", "").replace("relativeAge(epochMilliseconds: $0, now: now)", "");
    expect(rest, "now is read only for the age").not.toMatch(/\bnow\b/);
    // The one closure whose presence is drawn: Fork is in the menu only where it can be.
    expect(equal).toContain("(a.onFork == nil) == (b.onFork == nil)");
    expect(head).toContain("@Binding var renameDraft: String");
    expect(equal).not.toContain("renameDraft");
  });

  test("the rows' ages still tick on the list's own ten-second clock", () => {
    expect(ledger).toContain("PeriodicClock(every: 10) { now in");
    expect(ledger).toContain("now: now,");
  });

  test("an agent group's == is its agents and the selection", () => {
    expect(section(dashboard, "extension AgentGroup: Equatable {", "\n}\n")).toContain("a.agents == b.agents && a.selectedID == b.selectedID");
  });
});

describe("the deliverable pane follows the disk without being redrawn to", () => {
  const review = swift("ReviewView.swift");
  const surface = section(review, "private struct ReviewSurface: View {", "private var stageControl: some View {");

  test("the file is looked at four times a second while it is shown, and a change draws the pane again", () => {
    expect(surface).toContain("let _ = diskChanges");
    expect(surface).toContain(".task(id: item.link) { await watchDisk() }");
    const watch = section(surface, "private func watchDisk() async {", "\n    }\n");
    expect(watch).toContain("try? await Task.sleep(nanoseconds: 250_000_000)");
    expect(watch).toContain("if now != last {");
    expect(watch).toContain("diskChanges &+= 1");
  });

  test("what is looked at is what DeliverableSource decides by: there or not, a folder or not", () => {
    const disk = section(review, "extension DeliverableSource {", "\n}\n");
    expect(disk).toContain("exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)");
    expect(disk).toContain("return localFileURL(for: link).path");
    expect(disk).toContain('scheme == "http" || scheme == "https"');
    const init = section(review, "init(link: String) {", "private static func localFileURL");
    expect(init).toContain("FileManager.default.fileExists(atPath: localURL.path, isDirectory: &isDirectory)");
  });
});

describe("smaller things the sample named", () => {
  test("the composer's height is remembered at each width it was asked for, for the text it was measured with", () => {
    const measure = section(swift("ComposerEditor.swift"), "private final class Measure {", "\n}\n");
    expect(measure).toContain("if let measured, measured.text == string, let height = measured.heights[width] { return height }");
    expect(measure).toContain("kept.heights[width] = height");
    expect(measure).toContain("measured = (string, [width: height])");
  });

  test("the build's age is one lstat a poll, not a dictionary of every attribute", () => {
    const freshness = section(swift("PluginPresence.swift"), "enum BuildFreshness {", "\n}\n");
    expect(freshness).toContain("guard lstat(executablePath, &info) == 0 else { return nil }");
    expect(freshness).not.toContain("attributesOfItem");
  });

  test("the pane does not watch the drafts it only hands things to", () => {
    expect(pane).toContain("private let composerDrafts = ComposerDraftStore.shared");
  });

  test("an annotator's placements are stored only when they moved", () => {
    const annotate = swift("DeliverableAnnotate.swift");
    expect(annotate).toContain("if placed != at { placed = at }");
    expect(annotate).toContain("if pointer != under { pointer = under }");
    expect(annotate).not.toMatch(/\n\s*placed = (at|found)/);
  });
});

/**
 * The second round (2026-11-11): the live app still averaged ~4% of a core over two days, its main thread in SwiftUI's
 * AttributeGraph and NSView layout while nothing on screen changed. A 10 s SwiftUI trace of it (25 rows, 15 working) and an
 * offscreen harness on the app's own window with Tyler's sessions file named four causes, each held in place below;
 * test/window-churn.test.ts holds the window to them by running it.
 * - The app's body watched the store (`@StateObject`), so every publish drew the window twice more, the scene and its
 *   menus rebuilt: the app's body ran 13 times in the trace, once a publish, and those passes were ~70% of each one's
 *   main-thread time.
 * - The session list was handed the whole state with closures, so every publish ran it and its eleven folder headers.
 * - The conversation stack watched the store itself, under the pane's `==`, so every publish of any session ran it.
 * - The list and the deliverables strip kept their ten-second clocks in `TimelineView`s, which every frame of any
 *   animation in the window dirties: a session's turn ending cost ~115 ms of main thread offscreen, ~50 without.
 */
describe("the app holds its stores without watching them", () => {
  const appSource = swift("ConchMacApp.swift");
  const head = section(appSource, "struct ConchMacApp: App {", "    var body: some Scene {");

  test("nothing in the app's struct subscribes it to an object", () => {
    expect(head).not.toMatch(/@(StateObject|ObservedObject|EnvironmentObject|Bindable)\b/);
    for (const store of ["    private let store: StateStore\n", "    private let remotes: RemoteMacStore\n", "    private let audio: AudioHolderStore\n"]) {
      expect(head).toContain(store);
    }
    // The delegate the adaptor holds is not one either: an observable delegate would subscribe the app all the same.
    expect(section(appSource, "private final class ConchAppDelegate: NSObject,", "{")).not.toContain("ObservableObject");
  });

  test("the window still gets every store, from the environment, where the views that draw from them watch them", () => {
    const scene = section(appSource, '        WindowGroup("conch") {', ".defaultSize(");
    for (const object of ["store", "remotes", "audio", "appDelegate.daemon"]) expect(scene).toContain(`.environmentObject(${object})`);
  });
});

describe("the session list is drawn again only when what it reads changed", () => {
  const ledger = section(dashboard, "private struct SessionLedger: View {", "private struct LedgerReveal: Equatable {");

  test("the window hands it the state as it reads it, behind its own ==", () => {
    expect(dashboard).toMatch(/SessionLedger\(\s*onSelectRemote: onSelectRemote,\s*state: state\?\.forSidebar\(\),[^]*?actions: actions\s*\)\s*\.equatable\(\)/);
    const head = section(ledger, "private struct SessionLedger: View {", "    private var focusID: SessionRow.ID? {");
    const equal = section(dashboard, "extension SessionLedger: Equatable {", "\n}\n");
    // Every stored input but the actions: the window's closures, whose state lives in SwiftUI's storage.
    const inputs = stored(head).filter((p) => !isClosure(p.type) && p.type !== "DashboardActions");
    expect(inputs.map((p) => p.name).sort()).toEqual(["renamingSessionID", "rowMessages", "selectedSessionID", "state", "undoDismissal"]);
    for (const { name } of inputs) expect(equal).toContain(`a.${name} == b.${name}`);
    expect(head).toContain("@Binding var renameDraft: String");
    expect(equal).not.toContain("renameDraft");
  });

  /** As the pane's: a field read here and dropped by `forSidebar` would read as nil or empty, always. */
  test("everything the list reads of the state is something forSidebar carries", () => {
    const forSidebar = section(dashboard, "func forSidebar() -> PublishedState {", "\n    }\n");
    const carried = [...forSidebar.matchAll(/^ {12}(\w+): /gm)].map((m) => m[1]);
    const workspace = section(swift("Workspace.swift"), "    init(_ state: PublishedState?) {", "\n    }\n");
    const reads = new Set<string>();
    const deep: string[] = [];
    for (const source of [ledger, workspace]) {
      for (const match of source.matchAll(/\bstate\??\.(\w+)(\??\.\w+)?/g)) {
        reads.add(match[1]);
        if (match[1] === "live" || match[1] === "reply") deep.push(`${match[1]}${match[2] ?? ""}`);
      }
    }
    for (const field of ["rows", "dismissedRows", "mode", "browserTabs", "live", "reply"]) expect(reads.has(field), field).toBe(true);
    for (const field of reads) expect(carried, `the list reads state.${field}`).toContain(field);
    expect(reads.has("ts")).toBe(false);
    // Of the voice and the reply it carries only what the focus rules read: the voice's state, whose reply it is.
    expect(new Set(deep)).toEqual(new Set(["live.isExchangeActive", "reply?.sessionId"]));
    expect(swift("Models.swift")).toContain("var isExchangeActive: Bool {\n        Self.isExchangeActive(state)\n    }");
    expect(forSidebar).toContain("live: LiveState(state: live.state),");
    expect(forSidebar).toContain("reply: reply.map { ConversationReply(sessionId: $0.sessionId) },");
    expect(forSidebar).toContain("rows: rows,");
    // The tabs a row reads are the asking ones (`browserAsks`).
    expect(forSidebar).toContain("browserTabs: browserTabs?.filter { $0.ask != nil }");
    expect(section(ledger, "private var browserAsks: [String: String] {", "\n    }\n")).toContain("tabs.filter { $0.ask != nil }");
  });

  test("its folder headers are behind their own ==, and the asks are worked out once a body", () => {
    expect(ledger.split("FolderHeader(").length - 1).toBe(2);
    expect(ledger.match(/FolderHeader\([^]*?\n\s*\)\n\s*\.equatable\(\)/g)?.length).toBe(2);
    const head = section(dashboard, "private struct FolderHeader: View {", "    @State private var hovering = false");
    const equal = section(dashboard, "extension FolderHeader: Equatable {", "\n}\n");
    // `isDropTarget` has a default and no written type, so `stored` passes it by.
    const inputs = [...stored(head).filter((p) => !isClosure(p.type)).map((p) => p.name), "isDropTarget"];
    expect(head).toContain("    var isDropTarget = false\n");
    expect(inputs.sort()).toEqual(["count", "isCollapsed", "isDropTarget", "name"]);
    for (const name of inputs) expect(equal).toContain(`a.${name} == b.${name}`);
    expect(ledger).toContain("let browserAsks = self.browserAsks");
  });
});

describe("the conversation stack holds the store without watching it", () => {
  test("what it draws from the store comes down from the pane, which is behind its own ==", () => {
    const head = section(stack, "struct ConversationStackView: View {", "    var body: some View {");
    for (const input of ["    let store: StateStore\n", "    let pending: [ConchOutboxEntry]\n", "    let rowMessage: String?\n"]) {
      expect(head).toContain(input);
    }
    expect(stack).not.toMatch(/@(EnvironmentObject|ObservedObject) private var store\b/);
    const body = section(stack, "    var body: some View {", "    private var historyEdge: HistoryEdge {");
    expect(body).toContain("ForEach(pending) { pending in");
    expect(body.split(".onChange(of: rowMessage) { _, message in").length - 1).toBe(2);
    for (const read of ["store.outbox", "store.rowMessages", "store.state"]) expect(body, read).not.toContain(read);
    expect(pane).toContain(
      "                store: store,\n                pending: outbox.entries(for: conversation.sessionId),\n                rowMessage: rowMessages[conversation.sessionId],",
    );
  });
});

describe("the window's ten-second clocks are not hung off its frame clock", () => {
  test("the list and the deliverables strip age on PeriodicClock, and no TimelineView ticks in the window's body", () => {
    expect(dashboard.split("PeriodicClock(every: 10) { now in").length - 1).toBe(2);
    expect(dashboard).not.toContain("TimelineView(.periodic");
    const clock = readFileSync(new URL("../design/ConchDesign/Sources/ConchDesign/PeriodicClock.swift", import.meta.url), "utf8")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(clock).toContain("@State private var now = Date()");
    expect(clock).toContain(".task(id: hidden) {");
    expect(clock).not.toContain("TimelineView");
  });
});
