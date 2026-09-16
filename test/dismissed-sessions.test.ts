import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const dashboard = read("mac-app/conch-mac/DashboardView.swift");
const daemon = read("src/daemon.ts");

/**
 * Dismissing a session removes it from the list.
 *
 * Tyler: "all sessions view doesn't exclude dismissed sessions".
 *
 * The daemon already keeps them out of `rows` — dismissal hides a session without stopping
 * it — and then the app put every dismissed row back on screen under a `DISMISSED` divider.
 * So dismissing moved a row down and greyed it instead of removing it, which is not what the
 * gesture says it does.
 *
 * The lab folds them away and offers them back: `showDismissed: false` to begin with
 * (workspace-lab.html:864) and a group header with a reveal (line 998).
 */
test("dismissed sessions are folded away, not listed", () => {
  expect(dashboard).toContain("@State private var showsDismissed = false");
  expect(dashboard).toContain('name: "Dismissed",');
  expect(dashboard).toContain("isCollapsed: !showsDismissedRows,");
  // The rows themselves are drawn only when the group is open.
  expect(dashboard).toContain("if showsDismissedRows {");
  const group = dashboard.slice(dashboard.indexOf("if !state.dismissedRows.isEmpty {"));
  const body = group.slice(0, group.indexOf("RemoteMacGroups"));
  expect(body).toContain("ForEach(state.dismissedRows, id: \\.id) { row in");
  expect(body.indexOf("if showsDismissedRows {")).toBeLessThan(
    body.indexOf("ForEach(state.dismissedRows"),
  );
  // The divider it replaces is gone, not merely unused.
  expect(dashboard).not.toContain("DismissedRowsDivider");
});

/**
 * The Undo lives ON the dismissed row.
 *
 * Folding the group the instant you dismiss would take the undo with it — you would press
 * Dismiss and watch the way back disappear in the same frame.
 */
test("an offered undo forces the group open", () => {
  expect(dashboard).toContain(
    "private var showsDismissedRows: Bool { showsDismissed || undoDismissal != nil }",
  );
  const group = dashboard.slice(dashboard.indexOf("if !state.dismissedRows.isEmpty {"));
  const body = group.slice(0, group.indexOf("RemoteMacGroups"));
  expect(body).toContain("showsUndo: undoDismissal?.id == row.id");
});

/**
 * The same header the folders use.
 *
 * A second collapse mechanism is how two lists that behave alike start behaving differently —
 * and this one already had `collapsedFolders`, a chevron, and a count-when-collapsed.
 */
test("the group folds with the folders' own header", () => {
  const group = dashboard.slice(dashboard.indexOf("if !state.dismissedRows.isEmpty {"));
  const body = group.slice(0, group.indexOf("RemoteMacGroups"));
  expect(body).toContain("FolderHeader(");
  expect(body).toContain("count: state.dismissedRows.count,");
});

/**
 * The invariant underneath: a dismissed session never reaches `rows` in the first place.
 * The app's folding is presentation; this is what makes it honest.
 */
test("the daemon keeps dismissed sessions out of the published rows", () => {
  expect(daemon).toContain("const live = withoutDismissedSessions(registryLive, dismissedSessionIds);");
  expect(daemon).toContain("return sessions.filter((session) => !dismissedSessionIds.has(session.sessionId));");
});
