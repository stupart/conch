import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

function sliceFrom(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

/**
 * PR 7b: the Mac app reads a session's WHOLE history from the record store, instead of
 * the snapshot preview it has always drawn (forty items, messages cut at 4,000
 * characters, tool output at 400).
 *
 * The decisions live in ConchDesign's `History.swift` and are tested by `swift test`,
 * which CI runs. What is pinned here is the wiring those decisions hang from — the
 * socket shapes, the cancellation, and which view calls which — none of which a Swift
 * unit test reaches without building the app.
 */
describe("the Mac app reads recorded history", () => {
  const store = read("mac-app/conch-mac/HistoryStore.swift");
  const conversation = read("mac-app/conch-mac/ConversationStackView.swift");
  const panels = read("mac-app/conch-mac/FloatingPanels.swift");
  const state = read("mac-app/conch-mac/StateStore.swift");
  const history = read("design/ConchDesign/Sources/ConchDesign/History.swift");
  const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");

  test("the requests are the control socket's, with cursors omitted rather than nulled", () => {
    // `parseHistoryPageRequest` validates by key set: a `before: null` is an invalid
    // request, not "no cursor". Swift's synthesised encoding would send the null.
    const page = sliceFrom(store, "struct ConchHistoryPageRequest", "struct ConchHistoryItemRequest");
    expect(page).toContain('try container.encode("history-page", forKey: .kind)');
    expect(page).toContain("try container.encodeIfPresent(before, forKey: .before)");
    expect(page).toContain("try container.encodeIfPresent(limit, forKey: .limit)");

    const item = sliceFrom(store, "struct ConchHistoryItemRequest", "/// Every history answer");
    expect(item).toContain('try container.encode("history-item", forKey: .kind)');
    expect(item).toContain("try container.encode(item, forKey: .item)");
    expect(item).toContain("try container.encodeIfPresent(bodyCursor, forKey: .bodyCursor)");

    // The API's own default, and its ceiling is 100.
    expect(store).toContain("static let pageLimit = 50");
  });

  test("an off record store is read as off, and a stale cursor as a restart", () => {
    const failure = sliceFrom(store, "var failure: HistoryFailure?", "// MARK: - Store");
    expect(failure).toContain('if kind == "history-off" { return .off }');
    // All three bind a read to an index generation that has moved; the answer to each is
    // the same, which is to read again from the newest page.
    expect(failure).toContain('case "stale-cursor", "invalid-cursor", "stale-item":');
    expect(failure).toContain("return .stale");
    expect(failure).not.toContain('case "history-off": return .message');
  });

  test("changing session cancels what is in flight instead of letting it land", () => {
    const select = sliceFrom(store, "func select(session: String?)", "/// The newest page");
    expect(select).toContain("pageTask?.cancel()");
    expect(select).toContain("for task in bodyTasks.values { task.cancel() }");
    expect(select).toContain("paging.select(session: next)");
    // And a late answer is refused by generation even if its task was not cancelled.
    expect(store).toContain("guard let store = self, store.paging.generation == generation");
  });

  test("a body is read in chunks and only kept once it is whole", () => {
    const body = sliceFrom(store, "func loadBody(item: String", "// MARK: - Complete text");
    expect(body).toContain("bodyCursor: store.bodies[item]?.cursor");
    expect(body).toContain("next.apply(chunk: content, revision: revision, next: reply.nextBodyCursor");
    expect(body).toContain("if next.isComplete {");
    expect(body).toContain("if let nativeId { store.fullBodies[nativeId] = next.text }");
    // A moved body is read again from its start; that read carries no cursor, so it
    // cannot come back stale a second time.
    expect(body).toContain("if failure == .stale { continue }");
  });

  test("the transcript keeps the reader's place when older messages arrive", () => {
    const loadOlder = sliceFrom(conversation, "private func loadOlder()", "/// The row's text");
    // Captured BEFORE the request: after the prepend the old height is gone.
    expect(loadOlder).toContain("scrollAnchor.capture()");
    expect(loadOlder.indexOf("scrollAnchor.capture()"))
      .toBeLessThan(loadOlder.indexOf("history.loadOlder(anchor:"));
    expect(loadOlder).toContain("history.loadOlder(anchor: recordedRows.first?.id ?? conversation.items.first?.id)");

    // And restored after the rows have been measured, not before.
    const restore = sliceFrom(conversation, ".onChange(of: history.paging.items.count)", "@ViewBuilder");
    expect(restore).toContain("await Task.yield()");
    expect(restore).toContain("scrollAnchor.restore()");
    expect(conversation).toContain("scrollView.reflectScrolledClipView(scrollView.contentView)");
    // Only a prepend moves the reader: a streaming row growing is not a jump to correct.
    expect(conversation).toContain("guard grown > 0 else { return }");
  });

  test("reaching the top asks for the page before it", () => {
    // The stack is eagerly laid out, so nothing "appears" on the way up — the scroll
    // view's own geometry is what says the oldest row held has been reached.
    expect(conversation).toContain("onReachTop: { loadOlder() }");
    expect(conversation).toContain("if document.height > visible.height, fromTop <= visible.height { onReachTop() }");
  });

  test("the four honest states are four different sentences", () => {
    const header = sliceFrom(conversation, "private var historyHeader: some View", "/// When the record starts");
    // Off is not an error and not an empty conversation.
    expect(header).toContain("case .off:");
    expect(header).toContain("Text(HistoryNotice.off)");
    expect(header).toContain('Text("Loading earlier messages…")');
    expect(header).toContain("case let .failed(message):");
    expect(header).toContain('Button("Retry") { loadOlder() }');
    expect(header).toContain('Button("Load earlier messages") { loadOlder() }');
    expect(header).toContain("HistoryNotice.coverage(");
    // The one thing a person can do about an off record store.
    expect(history).toContain("conch set records true");
  });

  test("recorded rows stop where the live window starts and are drawn as rows", () => {
    const rows = sliceFrom(conversation, "private var recordedRows", "/// Ask for the page before");
    // Undecorated: `tool:call_7` in the snapshot is `call_7` in the record.
    expect(rows).toContain("HistorySnapshot.nativeId(forSnapshotItem: $0.id)");
    expect(rows).toContain("HistorySnapshot.older(");
    expect(rows).toContain("startingAt: conversation.items.first?.at");
    expect(rows).toContain("ConversationItem(recorded: recorded, text: whole ?? recorded.preview)");
    expect(conversation).toContain("ForEach(recordedRows) { item in");
    expect(store).toContain("init(recorded: HistoryItem, text: String)");
  });

  test("a row the snapshot cut offers the rest of itself", () => {
    expect(conversation).toContain("let result = history.fullText(forSnapshotItem: item.id) ?? item.tool?.result ?? \"\"");
    expect(conversation).toContain("loadFullBody(of: item)");
    expect(conversation).toContain('Button("Show the rest")');
    // Loading and failed are both said, under the row that is waiting.
    const status = sliceFrom(conversation, "private func fullBodyStatus", "/// The daemon's own caps");
    expect(status).toContain("case .some(.loading):");
    expect(status).toContain('Text("Loading the rest…")');
    expect(status).toContain("case let .some(.failed(message)):");
    expect(status).toContain('Button("Retry") { history.loadFullBodies(forSnapshotItems: [item.id]) }');
    // The daemon's caps, as `publishedConversation` applies them.
    expect(conversation).toContain("private static let messageCap = 4_000");
    expect(conversation).toContain("private static let toolResultCap = 400");
  });

  test("the full-screen overlay enlarges the message, not the cut", () => {
    expect(panels).toContain("ConversationFogHost(store: store, panels: self, history: store.overlayHistory)");
    const turns = sliceFrom(panels, "static func turns(", "/// Full screen is where");
    expect(turns).toContain("whole[HistorySnapshot.nativeId(forSnapshotItem: $0.id)] ?? $0.text");
    const whole = sliceFrom(panels, "private func readWhole(", "/// The live voice state");
    expect(whole).toContain("history.select(session: row.id)");
    expect(whole).toContain("HistorySnapshot.wasCut($0.text, cap: 4_000)");
    expect(whole).toContain("history.loadFullBodies(forSnapshotItems: cut)");
    expect(panels).toContain(".onChange(of: panels.isFullScreen) { _, full in if full { readWhole(row) } }");
  });

  test("the dashboard and the overlay read with their own readers", () => {
    // They follow different sessions — the overlay stays on what the Ready pill staged —
    // and one reader cannot hold two sessions' pages.
    expect(state).toContain("let history: HistoryStore");
    expect(state).toContain("let overlayHistory: HistoryStore");
    expect(state).toContain("history = HistoryStore(client: socket)");
    expect(state).toContain("overlayHistory = HistoryStore(client: socket)");
    expect(read("mac-app/conch-mac/DashboardView.swift")).toContain("history: store.history,");
  });

  test("two epochs are never joined into one transcript", () => {
    // The pure state machine's own rule, pinned here too because it is the one mistake
    // that shows as a plausible-looking conversation that never happened.
    const apply = sliceFrom(history, "public mutating func apply(page: HistoryPage", "/// Take a failure");
    expect(apply).toContain("guard epoch == nil || page.epoch == epoch else {");
    expect(apply).toContain("restart()");
    expect(history).toContain("public mutating func restart()");
  });

  test("Xcode builds the new file", () => {
    expect(project).toContain("/* HistoryStore.swift in Sources */ = {isa = PBXBuildFile;");
    expect(project.match(/\/\* HistoryStore\.swift in Sources \*\/,/g)?.length).toBe(1);
    expect(project).toContain("path = HistoryStore.swift;");
  });
});
