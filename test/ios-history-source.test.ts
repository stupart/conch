import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * PR 7b on the phone: the iPhone app reads a session's WHOLE history from the record
 * store, instead of the snapshot preview it has always drawn (the newest items,
 * messages cut at 4,000 characters, tool output at 400).
 *
 * The decisions live in ConchDesign's `History.swift` and are tested by `swift test`,
 * which CI runs. What is pinned here is the wiring those decisions hang from — the
 * routes, the cancellation, the memory ceiling and which view calls which — none of
 * which a Swift unit test reaches without building the app, and CI never builds it.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const iosDir = join(root, "mobile", "conch-ios", "conch-ios");
const ios = (name: string): string => readFileSync(join(iosDir, name), "utf8");

function sliceFrom(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("the iPhone reads recorded history", () => {
  const store = ios("HistoryStore.swift");
  const stack = ios("ConversationStack.swift");
  const session = ios("SessionView.swift");
  const bridge = ios("BridgeClient.swift");
  const history = read("design/ConchDesign/Sources/ConchDesign/History.swift");

  test("every phone file naming a shared history type imports the module", () => {
    // CI never builds this app, so a missing `import ConchDesign` reaches a device
    // rather than a red check. It has already happened once, in this PR.
    //
    // Comments are stripped first: a file that only MENTIONS one of these types in
    // its prose does not link against it, and demanding an import there would be a
    // pin that fires on documentation.
    const code = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const shared = /\bHistory(Notice|Snapshot|Paging|Body|Budget|Item|Page|Coverage|Failure|Status)\b/;
    const named = readdirSync(iosDir).filter((name) => name.endsWith(".swift"));
    const users = named.filter((name) => shared.test(code(readFileSync(join(iosDir, name), "utf8"))));
    expect(users).toContain("ConversationStack.swift");
    expect(users).toContain("HistoryStore.swift");
    for (const name of users) {
      expect(readFileSync(join(iosDir, name), "utf8"), name).toContain("import ConchDesign");
    }
  });

  test("the reads go over the phone's own authenticated routes, not a second transport", () => {
    expect(store).toContain('bridge.readHistory(path: "/history/page", request: request)');
    expect(store).toContain('bridge.readHistory(path: "/history/item", request: request)');
    // The same authenticated path every other command takes; LAN or relay is the
    // pairing's business, not this call's.
    const read = sliceFrom(bridge, "func readHistory(path: String", "/// Materialize a currently-scoped");
    expect(read).toContain('authorizedRequest(method: "POST", path: path, body: body)');
    // A refused read is JSON under a non-200 status, so the body is still decoded.
    expect(read).toContain("guard !response.body.isEmpty else {");
  });

  test("cursors are omitted rather than nulled", () => {
    // `parseHistoryPageRequest` validates by key set: a `before: null` is an invalid
    // request, not "no cursor". Swift's synthesised encoding would send the null.
    const page = sliceFrom(store, "struct PhoneHistoryPageRequest", "struct PhoneHistoryItemRequest");
    expect(page).toContain('try container.encode("history-page", forKey: .kind)');
    expect(page).toContain("try container.encodeIfPresent(before, forKey: .before)");
    const item = sliceFrom(store, "struct PhoneHistoryItemRequest", "/// Every history answer");
    expect(item).toContain('try container.encode("history-item", forKey: .kind)');
    expect(item).toContain("try container.encodeIfPresent(bodyCursor, forKey: .bodyCursor)");
    // The API's own default; its ceiling is 100.
    expect(store).toContain("static let pageLimit = 50");
  });

  test("an off record store is read as off, and a stale cursor as a restart", () => {
    const failure = sliceFrom(store, "var failure: HistoryFailure?", "// MARK: - Store");
    expect(failure).toContain('if kind == "history-off" { return .off }');
    expect(failure).toContain('case "stale-cursor", "invalid-cursor", "stale-item":');
    expect(failure).toContain("return .stale");
    expect(failure).not.toContain('case "history-off": return .message');
  });

  test("changing session cancels what is in flight instead of letting it land", () => {
    const follow = sliceFrom(store, "func follow(session: String, branchTip: String?, on bridge: BridgeClient)", "/// The newest page");
    expect(follow).toContain("pageTask?.cancel()");
    expect(follow).toContain("for task in bodyTasks.values { task.cancel() }");
    expect(follow).toContain("paging.select(session: session, branchTip: branchTip)");
    // And a late answer is refused by generation even if its task was not cancelled.
    expect(store).toContain("guard let store = self, store.paging.generation == generation");
  });

  test("each window asks the record for its own branch, and is told when it did not get it", () => {
    // Two windows of one transcript are ONE indexed session (A8, #170), so a page asked
    // for without a branch is both windows' messages — prepended above a live window
    // that is only ever one window's.
    const page = sliceFrom(store, "struct PhoneHistoryPageRequest", "struct PhoneHistoryItemRequest");
    expect(page).toContain("try container.encodeIfPresent(branch, forKey: .branch)");
    expect(store).toContain("branch: paging.branchTip,");
    // The tip is the newest live row that names a provider message, taken from the
    // window the Mac already picked for this session.
    expect(session).toContain("HistorySnapshot.branchTip(");
    expect(session).toContain("shared: published?.shared ?? false");

    // Captured once, with the session: a tip that moved as messages arrived would be a
    // different ancestry under an open cursor, and the store answers that with a stale
    // cursor — which empties the transcript being scrolled and starts it again.
    expect(store).toContain("func follow(session: String, branchTip: String?, on bridge: BridgeClient)");
    expect(store).toContain("paging.select(session: session, branchTip: branchTip)");

    // And where the record could not prove the branch, the reader says so rather than
    // passing the other window's messages off as this one's.
    expect(store).toContain("branch: coverage?.branch");
    expect(stack).toContain("sharedBranch: history.paging.sharedBranch");
    expect(history).toContain("public static let allBranches =");
  });

  test("a body is read in chunks, kept only once whole, and released under budget", () => {
    const body = sliceFrom(store, "func loadBody(item: String", "/// Hold a finished body");
    expect(body).toContain("bodyCursor: store.bodies[item]?.cursor");
    expect(body).toContain("next.apply(chunk: content, revision: revision, next: reply.nextBodyCursor");
    expect(body).toContain("if next.isComplete {");
    expect(body).toContain("store.keep(body: next.text, item: item, nativeId: nativeId)");
    // A moved body is read again from its start; that read carries no cursor, so it
    // cannot come back stale a second time.
    expect(body).toContain("if failure == .stale { continue }");

    // Both copies are released together. `bodies` is keyed by record id and
    // `fullBodies` by provider id; freeing one while the other still holds the
    // string frees nothing, and a cap that frees nothing is worse than no cap.
    const keep = sliceFrom(store, "private func keep(body text: String", "// MARK: - Complete text");
    expect(keep).toContain("HistoryBudget.release(held, keepingUnder: HistoryBudget.phoneBodyBytes)");
    expect(keep).toContain("bodies[released] = nil");
    expect(keep).toContain("fullBodies[native] = nil");
  });

  test("the phone holds a bounded number of rows, and says so when it stops", () => {
    // Not a guess about bytes: the stack is eager, so every row held is a row laid
    // out, and the largest session in the record store is twelve thousand items.
    expect(store).toContain("static let itemCap = 1_000");
    expect(store).toContain("HistoryPaging(itemCap: HistoryStore.itemCap)");
    // Stopping, never dropping: the store pages backwards only, so anything released
    // could not be fetched again when the reader scrolled back down.
    expect(history).toContain("public var isAtCap: Bool");
    expect(history).toContain("guard status != .loading, status != .off, !isAtCap else { return false }");
    expect(stack).toContain("Text(HistoryNotice.cap)");
    expect(history).toContain("public static let cap =");
  });

  test("reaching the top asks for the page before it", () => {
    // The same zero-height marker the end of the conversation already uses, pointed
    // the other way.
    const top = sliceFrom(stack, "VStack(alignment: .leading, spacing: 14) {", "historyHeader");
    expect(top).toContain(".onAppear { loadOlder() }");
    expect(stack).toContain("private func loadOlder() {");
    expect(stack).toContain("guard history.paging.canLoadOlder else { return }");
    expect(stack).toContain("history.loadOlder(anchor: recordedRows.first?.id ?? conversation.items.first?.id)");
  });

  test("the transcript keeps the reader's place when older messages arrive", () => {
    const restore = sliceFrom(session, ".onChange(of: history.paging.items.count)", "@ViewBuilder");
    // The first page is not a prepend: it lands under a conversation sitting at its
    // end, and scrolling to it would throw the reader to the top of a session they
    // just opened.
    expect(restore).toContain("guard previous > 0, next > previous, let anchor = history.paging.anchor else { return }");
    // After layout, and without animating: this is a correction, not a movement.
    expect(restore).toContain("await Task.yield()");
    expect(restore).toContain("transaction.disablesAnimations = true");
    expect(restore).toContain("scroller.scrollTo(anchor, anchor: .top)");
  });

  test("the session screen owns one reader and points it at what is on screen", () => {
    expect(session).toContain("@StateObject private var history = HistoryStore()");
    expect(session).toContain("history: history,");
    // Followed on arrival AND on a change of session.
    expect(session.match(/history\.follow\(session: sessionId, branchTip: branchTip, on: bridge\)/g)?.length).toBe(2);
    // Before the fixture's early return, or the snapshot script photographs the top
    // of a conversation with no history asked for.
    const appear = sliceFrom(session, ".onAppear {\n                // Everything above the live window", "scrollToBottom(scroller, animated: false)");
    expect(appear.indexOf("history.follow")).toBeLessThan(appear.indexOf("conchFixtureTop"));
  });

  test("a session whose live window is empty still draws what the record holds", () => {
    // Recorded history draws INSIDE the conversation stack, so gating that stack on the
    // daemon's snapshot hid the history along with it: an older session the daemon no
    // longer publishes a window for showed nothing at all — no recorded messages, no
    // "Load earlier messages", no state line.
    const window = sliceFrom(session, "private var liveWindow: Conversation?", "private func scrollToBottom");
    expect(window).toContain("if let published, !published.items.isEmpty { return published }");
    expect(window).toContain("guard history.paging.hasAnythingToShow else { return nil }");
    expect(window).toContain("return published ?? Conversation(sessionId: sessionId)");
    expect(session).toContain("if let conversation = liveWindow {");
    // The gate this replaced, which drew the stack for the live window alone.
    expect(session).not.toContain("!conversation.items.isEmpty {");
    // An empty window is a real Conversation, through the model's own init.
    expect(ios("Models.swift")).toContain("init(sessionId: String) { self.sessionId = sessionId }");
    // Records off, and a record that simply does not hold this session, both keep the
    // screen the app already draws rather than inventing an emptier one.
    expect(history).toContain("public var hasAnythingToShow: Bool");
    expect(history).toContain("guard status != .off else { return false }");
    expect(history).toContain("return !items.isEmpty || status != .idle || canLoadOlder");
  });

  test("the honest states are different sentences, each with what to do about it", () => {
    const header = sliceFrom(stack, "private var historyHeader: some View", "/// When the record starts");
    expect(header).toContain("case .off:");
    expect(header).toContain("Text(HistoryNotice.off)");
    expect(header).toContain('Text("Loading earlier messages…")');
    expect(header).toContain("case let .failed(message):");
    expect(header).toContain("Button(\"Retry\") { history.retry() }");
    expect(header).toContain('Button("Load earlier messages") { loadOlder() }');
    expect(header).toContain("HistoryNotice.coverage(");
    // The one thing a person can do about an off record store.
    expect(history).toContain("conch set records true");
  });

  test("recorded rows stop where the live window starts and are drawn as rows", () => {
    const rows = sliceFrom(stack, "private var recordedRows", "/// Ask for the page before");
    // Undecorated: `tool:call_7` in the snapshot is `call_7` in the record.
    expect(rows).toContain("HistorySnapshot.nativeId(forSnapshotItem: $0.id)");
    expect(rows).toContain("HistorySnapshot.older(");
    // Codex keys a snapshot row by a hash of its own text, so time is the only join.
    expect(rows).toContain("startingAt: conversation.items.first?.at");
    expect(rows).toContain("ConversationItem(recorded: recorded, text: whole ?? recorded.preview)");
    // Repointed when the phone's transcript began folding runs of tool steps: the recorded
    // rows are read once into `recorded` and drawn through `foldedRow`, which draws a plain
    // row for everything a run does not claim. Scoped to the body, where the loop lives.
    const body = sliceFrom(stack, "var body: some View {", "private var historyHeader");
    expect(body).toContain("let recorded = recordedRows");
    expect(body).toContain("ForEach(recorded) { item in");
    // Which needs the published item's timestamp to survive decoding.
    const models = ios("Models.swift");
    expect(models).toContain("case id, rev, kind, text, at, tool, plan, change, question, material");
    expect(models).toContain("at = try? c.decodeIfPresent(Double.self, forKey: .at)");
  });

  test("a row the snapshot cut offers the rest of itself", () => {
    expect(stack).toContain('let result = history.fullText(forSnapshotItem: item.id) ?? item.tool?.result ?? ""');
    expect(stack).toContain("loadFullBody(of: item)");
    expect(stack).toContain('Button("Show the rest")');
    // Loading and failed are both said, under the row that is waiting.
    const status = sliceFrom(stack, "private func fullBodyStatus", "/// The daemon's own caps");
    expect(status).toContain("case .some(.loading):");
    expect(status).toContain('Text("Loading the rest…")');
    expect(status).toContain("case let .some(.failed(message)):");
    expect(status).toContain('Button("Retry") { history.loadFullBodies(forSnapshotItems: [item.id]) }');
    // The daemon's caps, as `publishedConversation` applies them.
    expect(stack).toContain("private static let messageCap = 4_000");
    expect(stack).toContain("private static let toolResultCap = 400");
  });

  test("a recorded row goes through the app's own decoder", () => {
    // Rather than a second construction path with its own defaults to drift.
    const init = sliceFrom(store, "init?(recorded: HistoryItem, text: String)", "\n}\n");
    expect(init).toContain('case "message": recorded.role == "user" ? "user" : "assistant"');
    expect(init).toContain('case "tool_call", "tool_result": "tool"');
    expect(init).toContain("JSONDecoder().decode(ConversationItem.self, from: data)");
    // Recorded means finished: a row read back out of the store is not running.
    expect(init).toContain('"status": "done"');
  });

  test("two epochs are never joined into one transcript", () => {
    // The pure state machine's own rule, pinned here too because it is the one
    // mistake that shows as a plausible-looking conversation that never happened.
    const apply = sliceFrom(history, "public mutating func apply(page: HistoryPage", "/// Take a failure");
    expect(apply).toContain("guard epoch == nil || page.epoch == epoch else {");
    expect(apply).toContain("restart()");
  });

  test("Xcode builds the new file, and the script photographs every state", () => {
    const project = read("mobile/conch-ios/conch-ios.xcodeproj/project.pbxproj");
    expect(project).toContain("/* HistoryStore.swift in Sources */ = {isa = PBXBuildFile;");
    expect(project.match(/\/\* HistoryStore\.swift in Sources \*\/,/g)?.length).toBe(1);
    expect(project).toContain("path = HistoryStore.swift;");

    const script = read("scripts/ui-snapshot.sh");
    expect(script).toContain("for state in loaded partial loading off error; do");
    expect(script).toContain('-conchFixtureHistory "$state"');
  });
});
