import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Tyler (2026-09-24), on a session he had just started in his home folder: it opened side by
// side with a tree of everything in ~, an empty "Pick a file" pane and "No reply yet from
// ‹tylerstupart-40›". conch-mac has no XCTest target, so these read the source.
const read = (name: string) => readFileSync(`${import.meta.dir}/../mac-app/conch-mac/${name}`, "utf8");

test("the home folder is not a working folder, so a session there gets the whole stage", () => {
  const dashboard = read("DashboardView.swift");
  const folder = dashboard.slice(dashboard.indexOf("private var workingFolder: String? {"), dashboard.indexOf("private var hasWorkPane"));
  // The home check is ConchDesign's now (`ConchWorkFolder.pick`, XCTested in FolderDeliverableTests), which also
  // prefers a folder the agent declared: a session started in ~ that declared ~/Projects/X shows Files for X.
  expect(folder).toContain("ConchWorkFolder.pick(cwd: row.cwd, workDirs: row.workDirs, home: NSHomeDirectory())");
  // With no folder, no deliverable and no Terminal Mirror (a debug view, terminal-mirror-source.test.ts), the split is
  // never drawn: the Terminal button is not something to show there.
  // A hosted session's own Terminal tab is something to show there (embedded-terminal-source.test.ts). The rule is
  // ConchDesign's `ConchTerminalStrip.hasWorkPane`, XCTested.
  expect(dashboard).toContain("terminalStrip(for: row).hasWorkPane(hasFolder: workingFolder != nil, hasDeliverable: selectedReview != nil)");
  expect(dashboard).toContain("if let reviewRow = focusedRow, hasWorkPane, stage(for: reviewRow) != .conversation {");
});

test("an empty session says what to do, without placeholder brackets", () => {
  const content = read("TranscriptContent.swift");
  // The sentence is ConchDesign's (`ConversationPlaceholder`, XCTested in ConversationVanishTests), and only an
  // empty transcript gets it: a prompt not yet answered is not an empty session.
  expect(content).toContain("text: ConversationPlaceholder.text(name: name, transcript: transcript),");
  expect(content).toContain("SessionStaticContent.fallback(for: row, transcript: .empty)");
  expect(content).not.toContain("‹");
  const design = readFileSync(`${import.meta.dir}/../design/ConchDesign/Sources/ConchDesign/History.swift`, "utf8");
  expect(design).toContain('case .empty: "Nothing from \\(name) yet. Send a message below to start."');
  expect(design).not.toContain("‹");
});
