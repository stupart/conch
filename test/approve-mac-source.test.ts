import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Mac's half of Approve (2026-10-05, Tyler's decision), held to its wiring: the session bar's ✓ Approve after the
 * Conversation / Side by side track, ↵ only from the review pane, ⌘Z for ten seconds, and the lagoon's approve and
 * unapprove onto the same store action. The rules themselves are ConchDesign's (`ReviewApproval`, ReviewApprovalTests);
 * these hold the app to calling them. And Open on a page: its ↗ on the address line, everything else in the corner.
 */
const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const between = (text: string, start: string, end: string) => {
  const from = text.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
};

const dashboard = read("mac-app/conch-mac/DashboardView.swift");
const content = read("mac-app/conch-mac/ContentView.swift");
const monitor = read("mac-app/conch-mac/DashboardInputMonitor.swift");
const store = read("mac-app/conch-mac/StateStore.swift");
const socket = read("mac-app/conch-mac/ConchSocketClient.swift");
const models = read("mac-app/conch-mac/Models.swift");
const review = read("mac-app/conch-mac/ReviewView.swift");
const lagoon = read("mac-app/conch-mac/LagoonPane.swift");

describe("✓ Approve in the session bar", () => {
  test("after the pane toggles, before the session's actions, styled as a track", () => {
    const bar = between(dashboard, "private func sessionBar(for row: SessionRow) -> some View {", "private var approveControl: some View {");
    const track = bar.indexOf('help: "The work and the exchange together (⌘2)"');
    const approve = bar.indexOf("            approveControl\n");
    const actions = bar.indexOf('.help("Session actions")');
    expect(track).toBeGreaterThan(-1);
    expect(approve).toBeGreaterThan(track);
    expect(actions).toBeGreaterThan(approve);
    const control = between(dashboard, "private var approveControl: some View {", "/// One tab per ARTIFACT");
    expect(control).toContain("ReviewApproval.control(");
    expect(control).toContain("daemonCanApprove: state?.seaGlass != nil");
    expect(control).toContain("compact: ReviewApproval.isCompact(headerWidth: sessionBarWidth)");
    // The same track as the toggles: radius 8, the `fill`, 2 points of padding.
    expect(control).toContain(".fill(ConchPalette.fill)");
    expect(control).toContain("RoundedRectangle(cornerRadius: 8, style: .continuous)");
  });

  test("its words, tooltip and VoiceOver label are ConchDesign's, with the key in the tooltip", () => {
    const button = between(dashboard, "private struct ApproveButton: View {", "final class ReviewApprovals: ObservableObject {");
    expect(button).toContain("Text(ReviewApproval.label(control, compact: compact) ?? \"\")");
    expect(button).toContain(".help(ReviewApproval.help(control))");
    expect(button).toContain(".accessibilityLabel(ReviewApproval.accessibilityLabel(control))");
    // Never the ready green on words: it measures under 3:1 on the light grounds.
    expect(button).not.toContain("statusReview");
  });

  test("only for a result on screen, from a daemon that can approve, never the practice's card", () => {
    const shown = between(dashboard, "private var shownResult: ReviewApprovals.Target? {", "private var note: String? {");
    expect(shown).toContain("row.id != TourCoach.practiceSessionId");
    expect(shown).toContain("stage(for: row) != .conversation, workPane(for: row) == .deliverable");
    expect(shown).toContain("guard let shown = shownResult, state?.seaGlass != nil, selectedReview?.approvedAt == nil else { return nil }");
  });

  test("a quiet confirmation, no modal: the control says so, VoiceOver hears it, ⌘Z holds it for ten seconds", () => {
    const approvals = between(dashboard, "final class ReviewApprovals: ObservableObject {", "private struct DashboardEmptyState: View {");
    expect(approvals).toContain("confirming = target");
    expect(approvals).toContain("AccessibilityNotification.Announcement(ReviewApproval.announcement).post()");
    expect(approvals).toContain("await store.approveReview(sessionId: target.sessionId, review: target.reviewId)");
    expect(approvals).toContain("guard let made = undo, made.isOpen(now: Date()) else {");
    expect(approvals).toContain("await store.unapproveReview(sessionId: made.sessionId, review: made.reviewId)");
    expect(dashboard).not.toContain(".alert(\"Approve");
  });
});

describe("↵ and ⌘Z", () => {
  test("Return reaches the dashboard only past a text field and a page, and says whether the review pane had the click", () => {
    const handler = between(monitor, "keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {", "func removeMonitor()");
    const editable = handler.indexOf("if firstResponderIsEditableText() {");
    const web = handler.indexOf("if firstResponderIsWebContent(), !key.isGlobalDashboardControl {");
    const enter = handler.indexOf("if case let .returnKey(reviewPaneFocused) = key {");
    expect(editable).toBeGreaterThan(-1);
    expect(web).toBeGreaterThan(editable);
    expect(enter).toBeGreaterThan(web);
    expect(monitor).toContain("case 36, 76:\n                return .returnKey(reviewPaneFocused: reviewPaneFocused)");
    // The review pane has the keyboard after a click in it, and loses it to a click anywhere else; the click goes on.
    const clicks = between(monitor, "clickMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) {", "keyMonitor =");
    expect(clicks).toContain("ReviewPaneProbe.contains(event.locationInWindow, in: event.window)");
    expect(clicks).toContain("return event");
    expect(dashboard).toContain(".background(ReviewPaneProbe())");
  });

  test("⌘Z is the approval's only outside a text field, whose own undo comes first", () => {
    const handler = between(monitor, "keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {", "func removeMonitor()");
    expect(handler).toContain("Self.isUndo(event), !firstResponderIsEditableText() {\n                    return onKey(.undoApproval) ? nil : event");
    expect(monitor).toContain("event.modifierFlags.intersection([.command, .control, .option, .shift]) == .command");
  });

  test("ContentView asks ReviewApproval what Return does, and keeps ⌘Z off the lagoon", () => {
    const keys = between(content, "private func handleDashboardKey(_ key: DashboardKey) -> Bool {", "\n    }\n}\n");
    expect(keys).toContain("switch ReviewApproval.returnKey(");
    expect(keys).toContain("onLagoon: page == .lagoon,");
    expect(keys).toContain("canApprove: approvals.approvable != nil");
    expect(keys).toContain("return approvals.approveShown(store: store)");
    expect(keys).toContain("guard page != .lagoon else { return false }\n            return approvals.undoLast(store: store)");
    expect(content).toContain(".environmentObject(approvals)");
  });
});

describe("the store, the socket and the models", () => {
  test("approve and unapprove are request/reply session commands, and a refusal goes on the row", () => {
    expect(socket).toContain('case reviewApprove = "review-approve"');
    expect(socket).toContain('case reviewUnapprove = "review-unapprove"');
    const approval = between(store, "private func approval(_ command: ConchSessionCommand, sessionId: String, review: String) async -> ReviewApproval.Reply {", "/// Both the title and its shortcut");
    expect(approval).toContain("ConchSessionCommandRequest(sessionId: sessionId, command: command, review: review)");
    expect(approval).toContain("case let .acknowledgement(ack)?: reply = .done(changed: ack.changed)");
    expect(approval).toContain("if case let .refused(why) = reply { rowMessages[sessionId] = why }");
    expect(store).toContain("await approval(.reviewApprove, sessionId: sessionId, review: review)");
    expect(store).toContain("await approval(.reviewUnapprove, sessionId: sessionId, review: review)");
  });

  test("the models read approvedAt and seaGlass, and the presented state carries seaGlass", () => {
    expect(models).toContain("approvedAt = try? container.decodeIfPresent(Double.self, forKey: .approvedAt)");
    expect(models).toContain("seaGlass = try? container.decodeIfPresent(Int.self, forKey: .seaGlass)");
    expect(models).toContain("&& seaGlass == other.seaGlass");
    expect(store).toContain("seaGlass: sourceState.seaGlass");
  });

  test("the lagoon's approve and unapprove are the same store action as the pane's", () => {
    const actions = between(lagoon, "final class LagoonStoreActions: LagoonActionSink {", "struct LagoonPane: View {");
    expect(actions).toContain("Task { await store.approveReview(sessionId: row.id, review: found.item) }");
    expect(actions).toContain("Task { await store.unapproveReview(sessionId: row.id, review: found.item) }");
  });
});

describe("Open on a page sits at the right end of its address line", () => {
  test("a page's controls go to its origin line; everything else keeps the corner circle", () => {
    const surface = between(review, "private struct ReviewSurface: View {", "struct ReviewPaneControl: Identifiable {");
    expect(surface).toContain("lineControls: paneControls");
    expect(surface).toContain(".overlay(alignment: .topTrailing) { stageControl }");
    const stage = between(surface, "private var stageControl: some View {", "private var paneControls: [ReviewPaneControl] {");
    expect(stage).toContain("if !opensFromAddressLine {");
    expect(surface).toContain("return DeliverableSource(link: link) == .web");
    // ↗ last: Compare (when there is another version) first.
    const controls = between(surface, "private var paneControls: [ReviewPaneControl] {", "private var opensFromAddressLine: Bool {");
    expect(controls.indexOf('symbol: "rectangle.split.2x1"')).toBeLessThan(controls.indexOf("symbol: actionSymbol"));
  });

  test("on the line, after the address, with the same key, tooltip and VoiceOver label", () => {
    const line = between(review, "TextField(originText, text: $addressDraft)", ".foregroundStyle(ConchPalette.textDim)");
    expect(line).toContain("ForEach(lineControls) { control in\n                        lineButton(control)");
    const button = between(review, "private func lineButton(_ control: ReviewPaneControl) -> some View {", "static func startServerPrompt");
    expect(button).toContain(".help(control.help)");
    expect(button).toContain(".accessibilityLabel(control.label)");
    expect(review).toContain('actionHelp: opensInFigma ? "Open in Figma (⌘3)" : "Open where it lives (⌘3)"');
    expect(review).toContain('actionAccessibilityLabel: opensInFigma ? "Open the design in Figma" : "Open the deliverable where it lives"');
  });
});
