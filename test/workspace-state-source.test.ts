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
const app = read("mac-app/conch-mac/ConchMacApp.swift");
const review = read("mac-app/conch-mac/ReviewView.swift");
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
    for (const source of [content, dashboard, adapter, stack, panels, app]) {
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

    // The only four ways the page moves, and every one of them is a press: the three pages
    // in the perspective bar, and opening the artifact from its inline preview. One door
    // (`show(stage:)`), because a page that can be set two ways can be set two ways at once.
    const changes = pane.match(/workspace\.show\(stage: \.\w+, for: row\.id\)/g) ?? [];
    expect(changes).toHaveLength(4);
    expect(pane).toContain('action: { workspace.show(stage: .conversation, for: row.id) }');
    expect(pane).toContain('action: { workspace.show(stage: .sideBySide, for: row.id) }');
    expect(pane).toContain('action: { workspace.show(stage: .deliverable, for: row.id) }');
    expect(pane).toContain("onOpenArtifact: { workspace.show(stage: .deliverable, for: row.id) }");
  });

  test("the page is per session, so switching away and back returns to it", () => {
    expect(pane).toContain("workspace.presentation(for: row?.id).stage");
    expect(pane).toContain("private func perspectiveBar(for row: SessionRow) -> some View {");

    // The strip of deliverables asks the same shared rule, and keeps no pick of its own: the
    // pane drifted once already by keeping chains, which is what this whole file is about.
    expect(pane).toContain("SessionPresentation.shown(");
    expect(pane).toContain("workspace.select(deliverable: item.id, for: row.id)");
    expect(pane).not.toMatch(/selectedDeliverable\s*=/);
    // Only drawn when there is more than one, so a session with a single deliverable has
    // exactly the pane it always had.
    expect(pane).toContain("if deliverables.count > 1 {");
    // Three states, and looking at one is what marks it — but only ever told to a daemon that
    // can remember, so an older one is never handed a command it will refuse.
    expect(pane).toContain("isUnviewed ? ConchPalette.textPrimary : ConchPalette.textDim");
    expect(pane).toContain("isSelected ? ConchPalette.selection : (isHovered ? ConchPalette.hover : .clear)");
    expect(pane).toContain("if item.viewedAt == nil, state?.features?.viewedState != nil {");
  });

  test("side by side draws one conversation, at half the stage, not a second copy of it", () => {
    expect(pane).toContain("if stage(for: reviewRow) == .sideBySide {");
    // ONE rendering of the exchange, called from both pages. The deliverable page used to
    // keep a bounded strip of the old single-reply document standing in for "both"; two
    // renderings of one conversation is how they drift apart, so that strip is gone.
    expect(pane).toContain("private func conversationBody(for row: SessionRow?) -> some View {");
    expect(pane.match(/conversationBody\(for: /g) ?? []).toHaveLength(2);
    expect(pane).not.toContain("minHeight: 96, idealHeight: 150, maxHeight: 190");

    const at = pane.indexOf("if stage(for: reviewRow) == .sideBySide {");
    const split = pane.slice(at, pane.indexOf("} else {", at));
    expect(split.length).toBeGreaterThan(200);
    expect(split).toContain("conversationBody(for: reviewRow)");
    expect(split).toContain("InlineReviewView(");
    // Half each: two equal claims on the width, rather than a measured fraction.
    expect(split.match(/\.frame\(maxWidth: \.infinity, maxHeight: \.infinity\)/g) ?? []).toHaveLength(2);
  });

  test("the work fills the stage one way, and Esc steps back off it", () => {
    // §3 line 234: the expanded full-window review is MERGED into Deliverable (⌘3). It was a
    // whole second mechanism for the same job — an overlay in ContentView's ZStack, with its
    // own id state, its own Esc, and the dashboard switched off underneath it.
    expect(review).not.toContain("struct ExpandedReviewView");
    expect(content).not.toContain("ExpandedReviewView");
    expect(content).not.toContain("expandedReviewID");
    // The dashboard is never switched off now, because nothing covers it.
    expect(content).not.toContain("allowsHitTesting");

    // Esc steps back to the conversation before it releases the session: on the deliverable
    // there is a page behind you, and letting go of the session instead answers a smaller
    // question by throwing away the bigger one. Renaming still wins over both.
    expect(content).toContain("if let id = workspace.viewing, workspace.presentation(for: id).stage != .conversation {");
    expect(content).toContain("workspace.show(stage: .conversation, for: id)");
    const esc = content.slice(
      content.indexOf("private func releaseSelection() {"),
      content.indexOf("private func showKeyboardShortcuts()"),
    );
    expect(esc.length).toBeGreaterThan(200);
    expect(esc.indexOf("cancelRename()")).toBeLessThan(esc.indexOf("workspace.show(stage: .conversation"));

    // Fill or side, from the deliverable's own 44 pt header (§3) — one control that knows
    // which page it is on, rather than two views that each only do one thing.
    expect(review).toContain('stage == .deliverable ? "rectangle.split.2x1" : "arrow.up.left.and.arrow.down.right"');
    expect(review).toContain("onShow(stage == .deliverable ? .sideBySide : .deliverable)");
    // The shortcut parameter had exactly one non-nil caller, and it was the view now gone.
    expect(review).not.toContain("actionShortcut");
  });

  test("the three pages have keys, and two of them wait for something to show", () => {
    expect(app).toContain('.keyboardShortcut("1", modifiers: .command)');
    expect(app).toContain('.keyboardShortcut("2", modifiers: .command)');
    expect(app).toContain('.keyboardShortcut("3", modifiers: .command)');
    expect(app).toContain("NotificationCenter.default.post(name: .setStage, object: StageMode.sideBySide)");
    expect(pane).toContain("guard let mode = note.object as? StageMode, let row = focusedRow else { return }");
    // With nothing filed there is nothing to put beside or in front of the conversation, so
    // those two keys do nothing rather than handing someone an empty stage.
    expect(pane).toContain("guard mode == .conversation || selectedReview != nil else { return }");
  });
});
