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
    // The closure does two things now, so it is no longer one line — but the door itself is
    // unchanged, which is what the count above pins.
    expect(pane).toContain("onOpenArtifact: {");
    // Scoped to the closure: `store.markReviewViewed(` already appears at the tab click, so an
    // unscoped toContain would pass with this call deleted — a guard that proves nothing.
    const opening = pane.slice(
      pane.indexOf("onOpenArtifact: {"),
      pane.indexOf("onFreeform:", pane.indexOf("onOpenArtifact: {")),
    );
    expect(opening.length).toBeGreaterThan(80);
    expect(opening).toContain("store.markReviewViewed(");
    expect(opening).toContain("review.viewedAt == nil");
    expect(opening).toContain("state?.features?.viewedState != nil");
  });

  /**
   * The page FOLLOWS you between conversations now — Tyler: "preserve the view your on when you
   * go between conversations". Storage is still per session (this line), so nothing about the
   * model changed; arriving at a session simply seeds its page from the one you left. Done on
   * `viewing` itself because there are five assignment sites — a click, a rename, two cycles
   * and a clear — and a rule enforced at five call sites is a rule forgotten at one.
   */
  test("the page follows you between sessions, and is still stored per session", () => {
    expect(pane).toContain("workspace.presentation(for: row?.id).stage");
    expect(rules).toContain("didSet { carryPresentation(from: oldValue) }");
    const carry = rules.slice(
      rules.indexOf("private func carryPresentation(from previous: String?)"),
      rules.indexOf("public func viewed(in workspace: Workspace)"),
    );
    expect(carry.length).toBeGreaterThan(100);
    expect(carry).toContain("guard let previous, let arriving = viewing, previous != arriving else { return }");
    expect(carry).toContain("$0.stage = leaving.stage");
    expect(carry).toContain("$0.work = leaving.work");
    // Rows you opened in one transcript are not carried into the next.
    expect(carry).not.toContain("expandedToolIDs");
    // §3 line 198: the switch lives in the HEADER now, not in a bar of its own under it.
    expect(pane).not.toContain("perspectiveBar");
    const header = pane.slice(
      pane.indexOf("private func sessionBar(for row: SessionRow) -> some View {"),
      pane.indexOf("private func deliverableTabs("),
    );
    expect(header.length).toBeGreaterThan(500);
    expect(header.match(/PerspectiveOption\(/g) ?? []).toHaveLength(3);
    // Only when there is something to switch to — the header must not offer a page that
    // would be empty. That used to mean "is there a deliverable", which is why Cmd-2 and Cmd-3
    // did nothing in a session that had never filed one, even though its FILES were there the
    // whole time. The work half now has two possible contents, so the question is whether
    // either exists.
    expect(header).toContain("if hasWorkPane {");
    expect(pane).toContain("private var hasWorkPane: Bool { selectedReview != nil || workingFolder != nil }");
    // Icons alone up here: three labelled segments take over 40% of the header at the
    // default window width, and the title is what the header is for.
    expect(pane).not.toContain("Text(label)");

    // The strip of deliverables asks the same shared rule, and keeps no pick of its own: the
    // pane drifted once already by keeping chains, which is what this whole file is about.
    expect(pane).toContain("SessionPresentation.shown(");
    expect(pane).toContain("workspace.select(deliverable: item.id, for: row.id)");
    expect(pane).not.toMatch(/selectedDeliverable\s*=/);
    // Only drawn when there is more than one thing to choose between, so a session with a
    // single deliverable and no folder has exactly the pane it always had. The working folder
    // is one of those things now, which is what the count has to include.
    expect(pane).toContain("if hasWorkTabs(for: reviewRow) {");
    // TWO, not one: a working folder offers the files in it AND a terminal running in it, so
    // a session with a folder and no deliverable still has a strip worth drawing.
    expect(pane).toContain("deliverables.count + (workingFolder == nil ? 0 : 2) > 1");
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
    // ONE builder for the work half, called from both stages, so side by side and fill-the-
    // stage cannot drift into showing different things. It is what resolves files-or-
    // deliverable; the split itself no longer names either.
    expect(split).toContain("workContent(for: reviewRow)");
    expect(pane).toContain("private func workContent(for row: SessionRow) -> some View {");
    // ONE infinity claim now, not two. The conversation is given a measured width and the
    // work takes whatever is left, so the two halves cannot disagree about the total by a
    // rounding point and leave a seam down the middle. This reverses "two equal claims on the
    // width, rather than a measured fraction": half each was right while the halves were
    // interchangeable, and a file tree and a terminal want width a transcript does not.
    expect(split.match(/\.frame\(maxWidth: \.infinity, maxHeight: \.infinity\)/g) ?? []).toHaveLength(1);
    expect(split).toContain("GeometryReader { split in");
    expect(split).toContain("splitResizer(in: split.size.width)");
    expect(split).toContain(".frame(width: max(0, split.size.width * splitFraction(in: split.size.width)))");
  });

  /**
   * Tyler: "drag the center diviger on the conch mac app panel view to change the proportions".
   * Bounded so neither half can be dragged to nothing, and remembered like the sidebar's width
   * — it is a preference about how you read, not a fact about one conversation.
   */
  test("the split is dragged, bounded, and remembered", () => {
    expect(dashboard).toContain('@AppStorage("conch.splitFraction") private var storedSplitFraction = 0.5');
    expect(dashboard).toContain("private static let splitBounds: ClosedRange<Double> = 0.25...0.75");
    const fraction = dashboard.slice(
      dashboard.indexOf("private func splitFraction(in width: CGFloat) -> Double {"),
      dashboard.indexOf("private func splitResizer(in width: CGFloat)"),
    );
    expect(fraction.length).toBeGreaterThan(100);
    // Clamped, and divide-by-zero safe: GeometryReader reports 0 before its first layout.
    expect(fraction).toContain("guard width > 0 else { return storedSplitFraction }");
    expect(fraction).toContain("min(max(dragged, Self.splitBounds.lowerBound), Self.splitBounds.upperBound)");
    // A 1 pt hairline with a 10 pt grab area, the same split the sidebar's resizer uses: a
    // one-point target is a target you miss.
    const resizer = dashboard.slice(
      dashboard.indexOf("private func splitResizer(in width: CGFloat)"),
      dashboard.indexOf("/// More than one thing to choose between"),
    );
    expect(resizer).toContain(".frame(width: 1)");
    expect(resizer).toContain(".frame(width: 10)");
    expect(resizer).toContain("NSCursor.resizeLeftRight.push()");
    // Banked on release, like the sidebar — not written on every drag tick.
    expect(resizer).toContain("storedSplitFraction = splitFraction(in: width)");
  });

  /**
   * Tyler: "if the arifcat is open on the other side you probably don't need the artifact in
   * the conversation". The card is the way IN to the deliverable; a way in you are already
   * through is noise at the end of a transcript. It returns when the pane closes.
   */
  test("the card yields when the work half is already showing a deliverable", () => {
    expect(dashboard).toContain(
      "artifactShownBeside: stage(for: row) != .conversation && workPane(for: row) == .deliverable,",
    );
    expect(stack).toContain("var artifactShownBeside = false");
    expect(stack).toContain("if let artifact, !artifactShownBeside,");
    // Still drawn by the same card when it IS shown — this gates it, it does not fork it.
    expect(stack).toContain("ArtifactPreview(artifact: artifact, onOpen: onOpenArtifact)");
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
    // With nothing to show there is nothing to put beside or in front of the conversation, so
    // those two keys do nothing rather than handing someone an empty stage. A working folder
    // counts as something: the keys now work in a session that filed no deliverable.
    expect(pane).toContain("guard mode == .conversation || hasWorkPane else { return }");
  });
});
