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
    const select = sliceFrom(store, "func select(session: String?, branchTip: String?)", "/// The newest page");
    expect(select).toContain("pageTask?.cancel()");
    expect(select).toContain("for task in bodyTasks.values { task.cancel() }");
    expect(select).toContain("paging.select(session: next, branchTip: branchTip)");
    // And a late answer is refused by generation even if its task was not cancelled.
    expect(store).toContain("guard let store = self, store.paging.generation == generation");
  });

  test("each window asks the record for its own branch, and is told when it did not get it", () => {
    // Two windows of one transcript are ONE indexed session (A8, #170), so a page asked
    // for without a branch is both windows' messages — prepended above a pane that is
    // only ever one window's.
    const page = sliceFrom(store, "struct ConchHistoryPageRequest", "struct ConchHistoryItemRequest");
    expect(page).toContain("try container.encodeIfPresent(branch, forKey: .branch)");
    expect(store).toContain("branch: paging.branchTip,");
    // The tip is the newest live row that names a provider message, taken from the pane
    // the daemon already picked for this window.
    expect(conversation).toContain("HistorySnapshot.branchTip(forSnapshotItems: conversation.items");
    expect(conversation.match(/history\.select\(session: conversation\.sessionId, branchTip: branchTip\)/g)?.length).toBe(2);
    expect(panels).toContain("forSnapshotItems: (conversation?.items ?? []).map");

    // Captured once, with the session: a tip that moved as messages arrived would be a
    // different ancestry under an open cursor, and the store answers that with a stale
    // cursor — which empties the transcript being scrolled and starts it again.
    expect(store).toContain("func select(session: String?, branchTip: String?)");
    expect(store).toContain("paging.select(session: next, branchTip: branchTip)");

    // And where the record could not prove the branch, the reader says so rather than
    // passing another window's messages off as this one's.
    expect(store).toContain("branch: coverage?.branch");
    // Said at the top of the history region, by the edge's own rule.
    expect(conversation).toContain("HistoryEdge.of(");
    expect(read("design/ConchDesign/Sources/ConchDesign/HistoryScroll.swift")).toContain("sharedBranch: paging.sharedBranch");
    expect(history).toContain("public var sharedBranch: Bool");
    // Only a session keyed per window (`<session>#<pid>`) has another window's messages
    // to show by mistake; the record runs behind the pane, so on a lone session an
    // unproven tip is ordinary and says nothing worth saying.
    expect(history).toContain("branchTip != nil && coverage?.branch == \"all\" && session.contains(\"#\")");
  });

  test("a body is read in chunks and only kept once it is whole", () => {
    const body = sliceFrom(store, "func loadBody(item: String", "// MARK: - Complete text");
    expect(body).toContain("bodyCursor: store.bodies[item]?.cursor");
    expect(body).toContain("next.apply(chunk: content, revision: revision, next: reply.nextBodyCursor");
    expect(body).toContain("if next.isComplete {");
    expect(body).toContain("store.keep(body: next.text, item: item, nativeId: nativeId)");
    // A moved body is read again from its start; that read carries no cursor, so it
    // cannot come back stale a second time.
    expect(body).toContain("if failure == .stale { continue }");
  });

  test("the transcript keeps the reader's place when older messages arrive", () => {
    // Nothing about the reader's place is recorded when a page is asked for: a capture taken
    // there was overwritten by the next scroll tick before its page had landed (2026-09-20).
    const loadOlder = sliceFrom(conversation, "private func loadOlder()", "/// A live message the daemon cut");
    expect(loadOlder).toContain("history.loadOlder(anchor: history.paging.rows.first?.id ?? conversation.items.first?.id)");
    expect(loadOlder).not.toContain("region.");
    // The old anchor measured the document's WHOLE growth after a prepend, which a row
    // streaming at the same time would have been counted into. It is gone, with its
    // expect/settle dance; the region's table says exactly what changed above the reader.
    expect(conversation).not.toContain("ConversationScrollAnchor");
    expect(conversation).not.toContain("expectPrepend");
    expect(conversation).not.toContain(".onChange(of: history.paging.items.count)");
    const region = read("design/ConchDesign/Sources/ConchDesign/HistoryRegion.swift");
    // The shift is applied inside the layout pass that changes the size — AppKit's
    // frameDidChange, UIKit's contentSize — relative to where the reader is NOW.
    expect(region).toContain("forName: NSView.frameDidChangeNotification");
    expect(region).toContain("found.observe(\\.contentSize");
    expect(region).toContain("y: clip.bounds.origin.y + delta");
  });

  test("reaching near the top asks for the page before it, with no button", () => {
    // Every scroll the region sees, not only the live ones: a screen and a half of content
    // left above the viewport is when the page before is asked for.
    const region = read("design/ConchDesign/Sources/ConchDesign/HistoryRegion.swift");
    expect(region).toContain("if HistoryPrefetch.shouldLoadOlder(contentAbove: contentAbove, viewport: height) { onNearTop() }");
    expect(store).toContain("region.onNearTop = { [weak self] in self?.loadOlder() }");
    expect(read("design/ConchDesign/Sources/ConchDesign/HistoryScroll.swift")).toContain("public static let screens: CGFloat = 1.5");
    // The observer that used to ask within one screen, on live scrolls only, no longer does.
    expect(conversation).not.toContain("onReachTop");
  });

  test("the top says what is true of it, and never offers a button", () => {
    const edge = sliceFrom(conversation, "private var historyEdge: HistoryEdge", "/// When the record starts");
    expect(edge).toContain("HistoryEdge.of(");
    expect(edge).toContain("liveIsWhole: !conversation.truncated && !conversation.items.isEmpty");
    expect(conversation).not.toContain('Button("Load earlier messages")');
    expect(conversation).not.toContain('Button("Retry") { loadOlder() }');
    expect(conversation).not.toContain('Text("Loading earlier messages…")');
    expect(conversation).not.toContain('"Earlier messages not shown"');
    // A failed read tries again on its own, after a pause that doubles.
    expect(store).toContain("HistoryRetry.delay(afterFailures: paging.failures)");
    expect(store).toContain("if let retryNotBefore, Date() < retryNotBefore { return }");
    // The one thing a person can do about an off record store is still said.
    expect(history).toContain("conch set records true");
  });

  test("recorded rows stop where the live window starts and are drawn as rows", () => {
    const rows = sliceFrom(conversation, "private var recordedEntries", "/// What a recorded row becomes");
    // Undecorated: `tool:call_7` in the snapshot is `call_7` in the record.
    expect(rows).toContain("HistorySnapshot.nativeId(forSnapshotItem: $0.id)");
    expect(rows).toContain("HistorySnapshot.older(");
    expect(rows).toContain("startingAt: conversation.items.first?.at");
    // A released page's rows keep their place, drawn at the height they had.
    expect(rows).toContain("return HistoryEntry(id: row.id, estimate: 0, payload: nil)");
    expect(conversation).toContain("ConversationItem(recorded: recorded, text: whole ?? (recorded.hasFullBody ? recorded.preview + \"…\" : recorded.preview))");
    expect(conversation).toContain("HistoryRegion(");
    expect(store).toContain("init(recorded: HistoryItem, text: String)");
  });

  test("a cut message is read whole as it arrives, with no \"Show the rest\"", () => {
    expect(conversation).not.toContain('Button("Show the rest")');
    expect(conversation).not.toContain("cutTail");
    // The record supplies the head, the snapshot the tail, joined where they overlap.
    const text = sliceFrom(conversation, "private func text(of item: ConversationItem) -> String {", "/// Whether the snapshot cut this row");
    expect(text).toContain("HistorySnapshot.whole(record: full, cut: item.text) ?? item.text");
    expect(conversation).toContain(".onChange(of: cutLive) { _, rows in");
    expect(store).toContain("func wantWhole(_ rows: [(id: String, cut: String)])");
    // A recorded message is read whole as it nears the viewport, nearest first.
    expect(store).toContain("HistoryDemand.bodies(for: wantedRecorded, around: wantedCenter");
    // Tool output stays behind its disclosure, and is read whole when opened.
    expect(conversation).toContain("let result = history.fullText(forSnapshotItem: item.id) ?? item.tool?.result ?? \"\"");
    expect(conversation).toContain("loadFullBody(of: item)");
    const status = sliceFrom(conversation, "private func fullBodyStatus", "/// The daemon's own caps");
    expect(status).toContain('Text("Loading the rest…")');
    expect(conversation).toContain("private static let messageCap = 4_000");
    expect(conversation).toContain("private static let toolResultCap = 400");
  });

  test("the full-screen overlay enlarges the message, not the cut", () => {
    expect(panels).toContain("ConversationFogHost(store: store, panels: self, queue: queue, history: store.overlayHistory)");
    const turns = sliceFrom(panels, "static func turns(", "/// Full screen is where");
    expect(turns).toContain("whole[HistorySnapshot.nativeId(forSnapshotItem: $0.id)] ?? $0.text");
    // Sliced to the function's own end: it used to stop at the next function's doc comment, which left with it.
    const whole = sliceFrom(panels, "private func readWhole(", "\n    }\n");
    expect(whole).toContain("history.select(session: row.id, branchTip: HistorySnapshot.branchTip(");
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
