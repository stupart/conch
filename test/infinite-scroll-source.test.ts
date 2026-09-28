import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Infinite scroll in the conversation, on the Mac and the phone.
 *
 * Tyler: "Why do I keep seeing 'show all' or 'show more' in the convo on the Mac app and iPhone
 * app — those should just smooth infinite scroll via a skillful implementation that doesn't blow
 * up memory."
 *
 * The arithmetic (prefetch, the reader's place, which rows are real, what is held, what the top
 * says) is ConchDesign's and `swift test` holds it. What is pinned here is what no Swift test
 * reaches without building the apps: that the buttons are gone from both, that the live tail the
 * Mac chose an eager stack for is still eager and below the windowed history, and that the phone
 * does what the Mac does.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
/** Comments stripped: a file explaining what it replaced may name the button it replaced. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/\/?.*$/gm, "").replace(/\s\/\/.*$/gm, "");

const macStack = read("mac-app/conch-mac/ConversationStackView.swift");
const macStore = read("mac-app/conch-mac/HistoryStore.swift");
const phoneStack = read("mobile/conch-ios/conch-ios/ConversationStack.swift");
const phoneStore = read("mobile/conch-ios/conch-ios/HistoryStore.swift");
const phoneSession = read("mobile/conch-ios/conch-ios/SessionView.swift");
const region = read("design/ConchDesign/Sources/ConchDesign/HistoryRegion.swift");
const scroll = read("design/ConchDesign/Sources/ConchDesign/HistoryScroll.swift");
const history = read("design/ConchDesign/Sources/ConchDesign/History.swift");

function sliceFrom(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("no conversation asks to be shown more", () => {
  const views: [string, string][] = [
    ["Mac", code(macStack)],
    ["phone", code(phoneStack)],
    ["phone session", code(phoneSession)],
  ];

  test("no Load earlier, Show the rest, show all or show more remains, on either app", () => {
    for (const [name, source] of views) {
      expect(source, name).not.toMatch(/load earlier/i);
      expect(source, name).not.toMatch(/show the rest/i);
      expect(source, name).not.toMatch(/show (all|more)\b/i);
      expect(source, name).not.toContain("Earlier messages not shown");
      expect(source, name).not.toContain("HistoryNotice.cap");
      // And no button stands in for scrolling: the history's top has none.
      expect(source, name).not.toContain("Button(\"Retry\") { loadOlder() }");
      expect(source, name).not.toContain("Button(\"Retry\") { history.retry() }");
    }
    // The edge's view draws a spinner, a line or sentences; never a control.
    const edge = code(sliceFrom(region, "public struct HistoryEdgeView: View {", "/// The small spinner as a still picture"));
    expect(edge).not.toContain("Button");
    expect(code(history)).not.toContain("That's as far back as this phone will hold");
  });

  test("a long message is whole: nothing between the reply and its end", () => {
    // The Mac's reply is the markdown alone, where it was a VStack of the markdown and an offer.
    const reply = sliceFrom(macStack, "        case .assistant:", "        case .thinking:");
    expect(code(reply)).toContain("MarkdownView(text: text(of: item))");
    expect(code(reply)).not.toContain("VStack");
    const phoneReply = sliceFrom(phoneStack, "        default:\n            // Whole, always", "    private func toolRow");
    expect(code(phoneReply)).toContain("MarkdownView(text: text(of: item))");
    expect(code(phoneReply)).not.toContain("VStack");
  });
});

describe("the live tail stays what the Mac chose it to be", () => {
  test("the stack is eager, and the windowed history sits above the live rows in it", () => {
    // A lazy stack left the viewport on unmaterialised rows while a reply streamed. The live
    // window is where rows stream, so it is still built in full; only history is windowed.
    expect(macStack).not.toContain("LazyVStack");
    expect(region).not.toContain("LazyVStack");
    const body = sliceFrom(macStack, "VStack(alignment: .leading, spacing: 22) {", "store.outbox.entries(for: conversation.sessionId)");
    expect(body.indexOf("HistoryRegion(")).toBeGreaterThan(-1);
    expect(body.indexOf("HistoryRegion(")).toBeLessThan(body.indexOf("ForEach(conversation.items) { item in"));
    // Following the newest reply is untouched: one non-animated request per revision.
    expect(macStack).toContain(".onChange(of: revisionVector)");
    expect(macStack).toContain("guard pinnedToBottom else { return }");
    expect(macStack).toContain("transaction.disablesAnimations = true");
    expect(macStack).not.toContain("withAnimation");
  });

  test("history rows are laid out at the height the table gives them, measured apart from it", () => {
    // The order is the mechanism: what a row wants is measured, the table then moves it, and the
    // shift for a row above the reader is registered before the layout that grows it.
    const slot = sliceFrom(region, "private func slot(_ index: Int, id: String, height: CGFloat) -> some View {", "/// The line at the top of recorded history");
    const row = slot.slice(slot.indexOf("row(payload)"));
    const measured = row.indexOf(".onGeometryChange(for: CGFloat.self) { $0.size.height } action: { model.measured(id, height: $0) }");
    const framed = row.indexOf(".frame(height: height, alignment: .top)");
    expect(row.indexOf(".fixedSize(horizontal: false, vertical: true)")).toBeLessThan(measured);
    expect(measured).toBeGreaterThan(-1);
    expect(framed).toBeGreaterThan(measured);
    const measure = sliceFrom(region, "func measured(_ id: String, height: CGFloat) {", "func resized(width: CGFloat)");
    expect(measure.indexOf("let shift = window.measure(id, height: height)")).toBeGreaterThan(-1);
    expect(measure.indexOf("let shift = window.measure(id, height: height)")).toBeLessThan(measure.indexOf("shifted(by: shift, from: total)"));
    expect(measure.indexOf("shifted(by: shift, from: total)")).toBeLessThan(measure.indexOf("objectWillChange.send()"));
    // The shift lands inside the layout pass that resizes the document to hold the change — and
    // on nothing else: not a timer, not the next turn. SwiftUI can commit a frame between
    // evaluating a body and laying it out, and a move applied there is the jump on screen.
    const resized = sliceFrom(region, "private func documentResized() {", "/// One report per run-loop turn");
    expect(resized.indexOf("apply()")).toBeGreaterThan(-1);
    expect(resized.indexOf("apply()")).toBeLessThan(resized.indexOf("scheduleReport()"));
    const shift = sliceFrom(region, "    func shift(by delta: CGFloat) {", "    func cancel() {");
    expect(code(shift)).not.toContain("DispatchQueue");
    expect(code(shift)).not.toContain("apply()");
    // A change that leaves the region's height alone resizes nothing, so it is not compensated
    // rather than left waiting for a resize that belongs to something else; and with no scroll
    // view yet, there is no reader to move and nothing is kept to move one later.
    expect(region).toContain("guard abs(window.total - total) >= 0.5 else { return }");
    expect(code(shift)).toContain("guard abs(delta) >= 0.5, scrollView != nil else { return }");
    // While a move waits for its layout, the reader is reported where the move will put them —
    // the coordinates the table already speaks — on both platforms.
    expect(region).toContain("onScroll(visible.minY - regionTop + pending, visible.height, visible.minY - document.bounds.minY + pending)");
    expect(region).toContain("onScroll(top - regionTop + pending, height, top + pending)");
    // And the top line keeps one height whatever it says, so its changes move nothing below.
    expect(region).toContain(".frame(maxWidth: .infinity, minHeight: Self.height, alignment: .center)");
  });

  test("the region's state is the reader's, so a measurement does not redraw the conversation", () => {
    expect(macStore).toContain("let region = HistoryRegionModel(overscan: 2, cap: 160)");
    expect(macStack).toContain("model: history.region,");
    expect(macStack).not.toMatch(/@StateObject[^\n]*HistoryRegionModel/);
    // A body publishes nothing: `sync` runs inside `body`.
    const sync = sliceFrom(region, "func sync(_ slots: [HistoryWindow.Slot]) {", "/// A row was drawn");
    expect(sync).not.toContain("objectWillChange");
  });
});

describe("the phone does what the Mac does", () => {
  test("the same region, the same top line, the same rule for cut messages", () => {
    for (const [name, stack] of [["Mac", macStack], ["phone", phoneStack]] as const) {
      expect(stack, name).toContain("HistoryRegion(");
      expect(stack, name).toContain("HistoryEdge.of(");
      expect(stack, name).toContain("liveIsWhole: !conversation.truncated && !conversation.items.isEmpty");
      expect(stack, name).toContain("HistorySnapshot.older(\n            rows: history.paging.rows,");
      expect(stack, name).toContain("HistorySnapshot.whole(record: full, cut: item.text) ?? item.text");
      expect(stack, name).toContain("history.wantWhole(rows.map { ($0.id, $0.text) })");
      expect(stack, name).toContain("recorded.hasFullBody ? recorded.preview + \"…\" : recorded.preview");
    }
    // Each at its own rhythm: 22 between messages on the Mac, 14 on the phone.
    expect(macStack).toContain("gap: 22,");
    expect(phoneStack).toContain("gap: 14,");
    expect(macStack).toContain("HistoryEstimate.mac");
    expect(phoneStack).toContain("HistoryEstimate.phone");
  });

  test("the same reader: prefetch, retry, released pages, bodies paced by the screen", () => {
    for (const [name, store] of [["Mac", macStore], ["phone", phoneStore]] as const) {
      expect(store, name).toContain("region.onNearTop = { [weak self] in self?.loadOlder() }");
      expect(store, name).toContain("region.onShown = { [weak self] ids, center in self?.show(ids, around: center) }");
      expect(store, name).toContain("if let retryNotBefore, Date() < retryNotBefore { return }");
      // `HistoryPaging.retryDelay`: HistoryRetry's pauses, and every 30 s for a reader holding nothing.
      expect(store, name).toContain("guard let delay = paging.retryDelay else {");
      expect(store, name).toContain("for page in paging.releasedPages(holding: shown) { reread(page: page) }");
      expect(store, name).toContain("HistoryDemand.bodies(for: wantedRecorded, around: wantedCenter, held: held, reading: Set(bodyTasks.keys), paused: paused)");
      expect(store, name).toContain("pinned: pinned)");
      expect(store, name).toContain("region.reset()");
      expect(store, name).toContain("HistoryPaging(itemCap: HistoryStore.itemCap)");
    }
    // Each reader's ceiling on what it holds; the Mac's used to be none.
    expect(macStore).toContain("static let itemCap = 4_000");
    expect(phoneStore).toContain("static let itemCap = 1_000");
    expect(macStore).toContain("HistoryBudget.macBodyBytes");
    expect(phoneStore).toContain("HistoryBudget.phoneBodyBytes");
  });

  test("pictures are decoded at the size they are drawn, on both", () => {
    const macMaterial = sliceFrom(macStack, "private struct MaterialRow: View {", "private var detailRow: some View");
    expect(macMaterial).toContain("private static let maxPixelSize = 1_400");
    expect(macMaterial).toContain("ConchImage.decode(picture, maxPixelSize: size)");
    expect(code(macMaterial)).not.toContain("NSImage(contentsOfFile:");
    expect(phoneStack).toContain("nonisolated private static let maxPixelSize = 1_300");
    expect(phoneStack).not.toContain("maxPixelSize: 2048");
  });
});

describe("what the review of #443 found, fixed on both readers", () => {
  const stores = [["Mac", macStore], ["phone", phoneStore]] as const;

  test("a body read that fails pauses on its own before it is asked for again (#3)", () => {
    for (const [name, store] of stores) {
      const body = sliceFrom(store, "func loadBody(item: String", "private func keep(body text: String");
      // Both ways a read fails — nothing to decode (the daemon down, the phone offline) and an
      // answer that is a failure (busy, records off) — record the failure before the read ends,
      // so the pass its `defer` makes does not pick the same body again at once.
      expect(body.split("store.bodyFailed(item)\n                    return").length - 1, name).toBe(1);
      expect(body.split("if failure == .stale { continue }\n                store.bodyFailed(item)\n                return").length - 1, name).toBe(1);
      expect(body, name).toContain("guard backoff.allows(.body(item), at: Date()) else { return }");
      expect(body, name).toContain("store.backoff.succeeded(.body(item))");
      expect(body, name).toContain("wake(at: backoff.failed(.body(item), at: Date()))");
      expect(store, name).toContain("let paused = backoff.pausedBodies(at: Date())");
      // What has just come into view is revisited: a body whose tries were spent gets one more.
      expect(store, name).toContain("for id in appeared { backoff.revisit(.body(id)) }");
      // Someone asking lifts a pause; a new session starts with none.
      expect(store, name).toContain("backoff.lift(.body(id))");
      expect(store, name).toContain("backoff = HistoryBackoff()");
    }
  });

  test("a released page whose read fails is asked for again when its pause ends, not only on a scroll (#25)", () => {
    for (const [name, store] of stores) {
      const reread = sliceFrom(store, "private func reread(page id: Int) {", "// MARK: - Bodies");
      expect(reread, name).toContain("backoff.allows(.page(id), at: Date())");
      expect(reread, name).toContain("self.backoff.succeeded(.page(id))");
      expect(reread, name).toContain("self.wake(at: self.backoff.failed(.page(id), at: Date()))");
      // The timer's pass reads the released pages on screen again.
      const service = sliceFrom(store, "private func service() {", "// MARK: - What is on screen");
      expect(service, name).toContain("for page in paging.releasedPages(holding: shown) { reread(page: page) }");
      expect(service, name).toContain("wake(at: backoff.nextWake(after: Date()))");
      expect(store, name).toContain("for page in paging.releasedPages(holding: appeared) { backoff.revisit(.page(page)) }");
    }
  });

  test("a live row no held page names is looked for in the newest page of its own branch (#7)", () => {
    for (const [name, store] of stores) {
      const drain = sliceFrom(store, "private func drainWantedBodies() {", "private func find(_ tip: String) {");
      expect(drain, name).toContain("wanted.plan(held: paging.items, reading: Set(bodyTasks.keys), backoff: backoff, now: Date())");
      expect(drain, name).toContain("if let tip = plan.find { find(tip) }");
      const find = store.slice(store.indexOf("private func find(_ tip: String) {"));
      // The row's own id as the tip, no cursor: the newest page of the branch that message ends.
      expect(find, name).toMatch(/HistoryPageRequest\(session: paging\.session, branch: tip, before: nil, limit: Self\.pageLimit\)/);
      expect(find, name).toContain("self.wanted.found(in: page?.items ?? [])");
      expect(find, name).toContain("if self.wanted.records[tip] == nil { self.wake(at: self.backoff.failed(.find(tip), at: Date())) }");
      expect(find, name).toContain("self.drainWantedBodies()");
      // Only after the first page: before it there is nothing to look from.
      expect(store, name).toContain("if paging.epoch == nil { loadOlder() } else { drainWantedBodies() }");
      expect(store, name).not.toContain("wantedBodies");
    }
  });

  test("a cut live row the record is behind on is looked at again when its time comes (#26)", () => {
    for (const [name, store] of stores) {
      const check = sliceFrom(store, "private func checkWhole() {", "/// The whole text behind a snapshot row");
      expect(check, name).toContain("HistorySnapshot.refresh(record: full, cut: row.cut, lastRead: readAt[native], tries: tries, now: now)");
      expect(check, name).toContain("case let .at(due):\n                wake(at: due)");
      // Not skipped for good while its read is in flight: that read's landing asks again.
      expect(check, name).toContain("guard let record = wanted.records[native], bodyTasks[record] == nil else { continue }");
      const keep = sliceFrom(store, "private func keep(body text: String", "/// A recorded row's whole body");
      expect(keep, name).toContain("if let nativeId, livePinned.contains(nativeId) { checkWhole() }");
      expect(store, name).toContain("if let nativeId { readAt[nativeId] = Date() }");
      // The pass a pause's end makes looks at the live rows too.
      expect(sliceFrom(store, "private func service() {", "// MARK: - What is on screen"), name).toContain("checkWhole()");
      expect(store, name).not.toContain("static let refreshInterval");
    }
  });

  test("a picture is named by its file as it is now, and decoded off the main thread (#24)", () => {
    const material = sliceFrom(macStack, "private struct MaterialRow: View {", "private var detailRow: some View");
    expect(material).toContain("if let path = material?.path, let picture = ConchImage.picture(atPath: path) { return picture }");
    expect(material).toContain(".task(id: picture.key) {");
    expect(material).toContain("await Task.detached(priority: .userInitiated) {\n                ConchImage.decode(picture, maxPixelSize: size)\n            }.value");
    // The body draws what is already decoded, or the picture's shape — never a decode.
    const drawn = material.slice(0, material.indexOf(".task(id: picture.key) {"));
    expect(code(drawn)).not.toContain("ConchImage.decode(");
    expect(code(drawn)).not.toContain("ConchImage.thumbnail(");
    expect(code(drawn)).not.toContain("ConchImage.cached(");
    expect(drawn).toContain("Color.clear.aspectRatio(picture.aspect, contentMode: .fit)");
    const decode = read("design/ConchDesign/Sources/ConchDesign/ImageDecode.swift");
    expect(decode).toContain('return "\\(path)|\\(modified.tv_sec).\\(modified.tv_nsec)|\\(info.st_size)"');
  });
});

describe("the arithmetic is shared, and measured", () => {
  test("one prefetch threshold, one anchor rule, one window, in ConchDesign", () => {
    expect(scroll).toContain("public static let screens: CGFloat = 1.5");
    expect(scroll).toContain("public static let slowAfter: TimeInterval = 0.3");
    expect(scroll).toContain("public struct HistoryWindow");
    expect(history).toContain("public struct HistoryPageSlot");
    // The numbers come from a harness anyone can run.
    expect(read("design/ConchDesign/Package.swift")).toContain('.executableTarget(name: "conch-scroll-bench", dependencies: ["ConchDesign"])');
  });
});
