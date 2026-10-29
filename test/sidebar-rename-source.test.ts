import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Renaming a session from the sidebar (Tyler, 2026-10-29: "sometime when clicking on a convo in the left side bar it
 * dos the text edit cursor and start editing the name and then i can't diselect the text edit without renaming").
 * A double-click whose first click moved to the row is not a rename; a click away ends one; and a name left as it was
 * is never sent back as a rename.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Ignore line comments so a description of a site cannot satisfy a guard.
const swift = (file: string) => source(`mac-app/conch-mac/${file}`).replace(/^\s*\/\/.*$/gm, "");
const content = swift("ContentView.swift");
const dashboard = swift("DashboardView.swift");

function body(text: string, signature: string): string {
  const start = text.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf("\n    }\n", start));
}

describe("renaming a session in the sidebar", () => {
  test("a double-click that picked the row opens it; only the session already shown is renamed", () => {
    expect(body(content, "private func selectSession(")).toContain("if workspace.viewing != row.id { pickedByClick = (row.id, Date()) }");
    const double = body(content, "private func doubleClickSession(");
    expect(double).toContain("picked.id == row.id, Date().timeIntervalSince(picked.at) < NSEvent.doubleClickInterval");
    expect(double.indexOf("pickedByClick")).toBeLessThan(double.indexOf("beginRename(row)"));
  });

  test("a name left as it was, or emptied, is not sent as a rename", () => {
    const commit = body(content, "private func commitRename(");
    expect(commit).toContain("guard !requestedLabel.isEmpty, requestedLabel != row.label else { return }");
    expect(commit.indexOf("cancelRename()")).toBeLessThan(commit.indexOf("store.renameSession("));
  });

  test("a click away from the field ends the rename, and the watch goes with the field", () => {
    expect(dashboard).toContain("clickAway = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown])");
    expect(dashboard).toContain("if Self.endsRename(event) { DispatchQueue.main.async(execute: onCommitRename) }");
    expect(dashboard).toContain("if let clickAway { NSEvent.removeMonitor(clickAway) }");
    // Esc still leaves without renaming, and Return still commits.
    expect(dashboard).toContain(".onExitCommand(perform: onCancelRename)");
    expect(dashboard).toContain(".onSubmit(onCommitRename)");
  });
});
