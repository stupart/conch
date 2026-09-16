import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One owner for "which session the workspace is on".
 *
 * The rules themselves are provider-neutral and tested by `swift test`
 * (design/ConchDesign/Tests/ConchDesignTests/WorkspaceTests.swift). What those tests cannot
 * see is the wiring: that the window, the conversation pane, the transcript and the overlay
 * all ASK the model rather than each keeping a chain of its own — which is how they drifted,
 * and how some of them came to answer by label, a name the user can change and two sessions
 * can share.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const rules = read("design/ConchDesign/Sources/ConchDesign/Workspace.swift");
const content = read("mac-app/conch-mac/ContentView.swift");
const dashboard = read("mac-app/conch-mac/DashboardView.swift");
const adapter = read("mac-app/conch-mac/Workspace.swift");
const stack = read("mac-app/conch-mac/ConversationStackView.swift");
const panels = read("mac-app/conch-mac/FloatingPanels.swift");
const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");
/** The conversation pane only: the rest of the file is the ledger and the header. */
const pane = dashboard.slice(dashboard.indexOf("private struct ConversationPane: View {"));

describe("one owner", () => {
  test("the window holds the model and hands it down; no surface keeps a selection of its own", () => {
    expect(content).toContain("@StateObject private var workspace = WorkspaceModel()");
    expect(content).toContain(".environmentObject(workspace)");
    expect(content).not.toMatch(/@State private var selectedSessionID/);
    for (const [name, source] of [
      ["the pane", pane],
      ["the transcript", stack],
    ] as const) {
      expect(source, name).toContain("@EnvironmentObject private var workspace: WorkspaceModel");
      expect(source, name).not.toMatch(/@State private var (selected|focused|shows)/);
    }
  });

  /** A missing `import ConchDesign` has slipped through twice; CI builds neither app. */
  test("every file that reads the model imports the design system", () => {
    for (const source of [content, dashboard, adapter, stack, panels]) {
      expect(source).toContain("import ConchDesign");
    }
    expect(project).toContain("/* Workspace.swift in Sources */ = {isa = PBXBuildFile;");
    expect(project.match(/\/\* Workspace\.swift in Sources \*\/,/g)?.length).toBe(1);
  });

  test("the four questions are asked separately, by id", () => {
    // What I am looking at, which session the voice is on, and where a message goes: three
    // answers that are allowed to differ, from one place, never from a label.
    expect(pane).toContain("workspace.viewedRow(in: state)");
    expect(pane).toContain("workspace.voiceState(of: row, in: state)");
    expect(pane).toContain("workspace.dictation(of: row, in: state)");
    expect(content).toContain("workspace.targetRow(in: store.state)");
    // Which session the voice is on comes from the state the daemon published ON THE ROW,
    // never from the live label beside it: a label is renameable and two rows can share one.
    expect(adapter).toContain('isLive: LiveState.isExchangeActive(row.live ?? "")');
    expect(adapter).not.toContain("row.label");
    expect(pane).not.toContain("live.label");
    expect(content).not.toContain("state.live.label");
    // The rules read identity and nothing else: the session they reason about has no name on
    // it, so no rule in there can be written against one.
    const session = rules.slice(
      rules.indexOf("public struct WorkspaceSession"),
      rules.indexOf("/// The sessions as they stand"),
    );
    expect(session.length).toBeGreaterThan(400);
    expect(session).not.toContain("label");
  });
});

describe("the same decision, not a second copy of it", () => {
  test("the overlay resolves its session through the window's own chain", () => {
    expect(panels).toContain("WorkspaceFocus.viewed(in: Workspace(state), pinned: staged)");
    // Its staged pin (#222) stays where it is — the overlay is allowed to be on another
    // session; it is the RULE that must not be written twice.
    expect(panels).toContain("@Published var staged: SessionRow.ID?");
    expect(panels).toContain("WorkspaceFocus.isAddressed(row.id, in: Workspace(state))");
    // One translation from the daemon's rows to the rules, used by all of them.
    expect(adapter).toContain("extension Workspace {");
    // The ledger's scroll target is the same question, so it asks the same rule — it used to
    // end its own chain on a label match.
    expect(dashboard).toContain("WorkspaceFocus.viewed(in: Workspace(state), pinned: selectedSessionID)");
    // And no surface in the window keeps a fallback chain of its own any more. The header
    // still SHOWS the live label — saying what the voice is doing is not resolving anything.
    expect(dashboard.match(/first\(where: \\\.active\)/g) ?? []).toHaveLength(0);
    const ledger = dashboard.slice(
      dashboard.indexOf("private struct SessionLedger: View {"),
      dashboard.indexOf("private struct DashboardRow: View {"),
    );
    expect(ledger.length).toBeGreaterThan(1_000);
    expect(ledger).not.toContain("live.label");
  });

  test("the transcript's open tool rows are kept per session, not thrown away on a switch", () => {
    expect(stack).toContain("workspace.isToolExpanded(itemID, for: conversation.sessionId)");
    expect(stack).toContain("workspace.toggleTool(itemID, for: conversation.sessionId)");
    expect(stack).not.toContain("expandedToolIDs");
    // The session-change handler re-arms the follow and drops the old session's question
    // form; what was opened for reading is not its business any more.
    const switched = stack.slice(
      stack.indexOf(".onChange(of: conversation.sessionId)"),
      stack.indexOf(".onAppear {"),
    );
    expect(switched).toContain("pinnedToBottom = true");
    expect(switched).not.toContain("= []");
  });
});

describe("new work does not replace what you are reading", () => {
  test("a newly filed artifact cannot change the page the pane is on", () => {
    // The continuity violation the review named: this used to set the pane back to the
    // conversation whenever a deliverable arrived, taking someone off the one they were
    // inspecting. The preview inline in the conversation is how it asks to be looked at.
    expect(pane).not.toContain(".onChange(of: selectedReview?.id)");
    expect(pane).not.toMatch(/showsConversation\s*=/);
    expect(stack).toContain("ArtifactPreview(artifact: artifact, onOpen: onOpenArtifact)");

    // The only three ways the page moves, and every one of them is a press.
    const changes = pane.match(/workspace\.show\(conversation: (true|false), for: row\.id\)/g) ?? [];
    expect(changes).toHaveLength(3);
    expect(pane).toContain('action: { workspace.show(conversation: false, for: row.id) }');
    expect(pane).toContain('action: { workspace.show(conversation: true, for: row.id) }');
    expect(pane).toContain("onOpenArtifact: { workspace.show(conversation: false, for: row.id) }");
  });

  test("the page is per session, so switching away and back returns to it", () => {
    expect(pane).toContain("workspace.presentation(for: row?.id).showsConversation");
    expect(pane).toContain("private func perspectiveBar(for row: SessionRow) -> some View {");
  });
});
