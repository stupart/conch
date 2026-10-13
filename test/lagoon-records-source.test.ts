import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The lagoon's conversations, from where the app's own conversation pane reads them (2026-10-13): the daemon's published
 * window, else conch's record store. The daemon publishes eight sessions' windows (and four agents'), so every other
 * session reached the lagoon's panel with none: "Nothing said yet" over a session with four results and a draft PR.
 *
 * The rules (which sessions, what a recorded page becomes, when one is read again) are ConchDesign's `LagoonRecords`
 * (LagoonRecordsTests), and the pacing of a snapshot revised in place is `LagoonPacer.revise` (LagoonPacerTests). The Mac
 * app has no test target, so these read its Swift for the wiring.
 */
const root = join(import.meta.dir, "..");
// Line comments stripped, so prose describing a rule can never satisfy a guard.
const swift = (path: string): string => readFileSync(join(root, path), "utf8").replace(/^\s*\/\/.*$/gm, "");

const pane = swift("mac-app/conch-mac/LagoonPane.swift");
const web = swift("mac-app/conch-mac/LagoonWeb.swift");
const source = swift("mac-app/conch-mac/LagoonSource.swift");

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("every snapshot the page gets carries the record's conversations", () => {
  test("the published window wins and the record fills in, in the one place the source is built", () => {
    expect(source).toContain("init(_ state: PublishedState, recorded: [String: [Item]] = [:]) {");
    expect(source).toContain("conversations: LagoonRecords.merged(published: (state.conversations ?? [:]).mapValues { $0.items.map(Item.init) }, recorded: recorded),");
  });

  test("the pane, the host's own reads and a revision all build it through LagoonModel.source", () => {
    expect(pane).toContain("source: { [weak self, weak store] in store?.state.flatMap { self?.source($0) } },");
    expect(between(pane, "func source(_ state: PublishedState) -> LagoonSnapshot.Source {", "\n    }\n"))
      .toContain("LagoonSnapshot.Source(state, recorded: records.conversations)");
    const view = between(pane, "struct LagoonPane: View {", "\nstruct LagoonWebContainer");
    expect(view).not.toContain("host?.offer(");
    expect(view.match(/lagoon\.offer\(state\)/g)?.length).toBe(2);
  });
});

describe("the record is read one session at a time, only while the lagoon can be seen", () => {
  const read = between(pane, "private func readRecords() {", "private static func readRecord(");

  test("only while seen, one read at a time, the sessions LagoonRecords wants, the viewed one first", () => {
    expect(read).toContain("guard recordRead == nil, let host, host.isVisible, let state = actions.store?.state else { return }");
    expect(read).toContain("records.wanted(rows: published.rows, published: published.conversations, first: actions.workspace?.viewing, now: now).first");
    expect(read).toContain("records.forget(missing: Set(published.rows.map(\\.id)))");
    // A changed conversation is handed over though the store's ts didn't move; the next session is read after it.
    expect(read).toContain("self.host?.revise(self.source(state))");
    expect(read).toContain("self.records.failed(session, mark: mark, at: Date())");
    expect(read).toContain("            self.readRecords()\n        }\n    }");
  });

  test("pages are read back over the history socket until there are enough messages", () => {
    const record = between(pane, "private static func readRecord(_ session: String, client: ConchSocketClient) async -> [HistoryItem]? {", "\n    }\n");
    expect(record).toContain("ConchHistoryPageRequest(session: session, before: cursor, limit: LagoonRecords.pageLimit)");
    expect(record).toContain("items = page.items + items");
    expect(record).toContain("} while cursor != nil && !Task.isCancelled && LagoonRecords.wantsOlder(items, pagesRead: pages)");
  });

  test("a web view let go stops the reads; revising goes through the pacer like any snapshot", () => {
    expect(between(pane, "case .dropped:", "webGeneration += 1")).toContain("stopReadingRecords()");
    expect(between(web, "func revise(_ source: LagoonSnapshot.Source) {", "\n    }\n"))
      .toContain("handle(pacer.revise(LagoonSnapshot(source, home: environment.home), ts: ts, now: Date()))");
  });
});
