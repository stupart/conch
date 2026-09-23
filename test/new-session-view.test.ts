import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Tyler (2026-09-24), on a session he had just started in his home folder: it opened side by
// side with a tree of everything in ~, an empty "Pick a file" pane and "No reply yet from
// ‹tylerstupart-40›". conch-mac has no XCTest target, so these read the source.
const read = (name: string) => readFileSync(`${import.meta.dir}/../mac-app/conch-mac/${name}`, "utf8");

test("the home folder is not a working folder, so a session there gets the whole stage", () => {
  const dashboard = read("DashboardView.swift");
  const folder = dashboard.slice(dashboard.indexOf("private var workingFolder: String? {"), dashboard.indexOf("private var hasWorkPane"));
  expect(folder).toContain("(folder as NSString).standardizingPath != (NSHomeDirectory() as NSString).standardizingPath");
  // With neither folder nor deliverable, the split is never drawn.
  expect(dashboard).toContain("private var hasWorkPane: Bool { selectedReview != nil || workingFolder != nil }");
  expect(dashboard).toContain("if let reviewRow = focusedRow, hasWorkPane, stage(for: reviewRow) != .conversation {");
});

test("an empty session says what to do, without placeholder brackets", () => {
  const content = read("TranscriptContent.swift");
  expect(content).toContain('"Nothing from \\(name) yet. Send a message below to start."');
  expect(content).not.toContain("‹");
});
