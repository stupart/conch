import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Selecting across the whole conversation in the Mac app.
 *
 * Tyler: "I would also like to drag to select areas for copying in our conversation panel — it
 * currently only lets me do 1 line at a time."
 *
 * The model (points, slices, geometry, copy) and the views (a row reporting SwiftUI's layout, the
 * highlight, the pointer's surface) are ConchDesign's, and `swift test` holds them — through real
 * layouts in an offscreen window too. What is pinned here is the Mac's wiring, which no Swift test
 * reaches without building the app: that every message's text is tagged with its row, that the
 * selection's reading of a row is the one `row(for:)` draws, and that the surface lies over the
 * conversation's column.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
/** Comments stripped, so an explanation naming a call cannot satisfy a test looking for it. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/\/?.*$/gm, "").replace(/\s\/\/.*$/gm, "");

const stack = code(read("mac-app/conch-mac/ConversationStackView.swift"));
const markdown = code(read("design/ConchDesign/Sources/ConchDesign/Markdown.swift"));
const views = code(read("design/ConchDesign/Sources/ConchDesign/ConversationSelectionViews.swift"));
const bench = code(read("design/ConchDesign/Sources/conch-scroll-bench/main.swift"));

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("the conversation holds one selection", () => {
  test("the stack owns the controller, lays the surface over its column, and hands it the conversation", () => {
    expect(stack).toContain("@StateObject private var selection = ConversationSelectionController()");
    // Over the column the rows are measured in: its coordinate space is the one they report in.
    const column = between(stack, ".frame(maxWidth: ConversationTextView.maxMeasure, alignment: .leading)", ".background(");
    expect(column).toContain(".conversationSelectionSurface(selection)");
    expect(between(stack, "var body: some View {", "ScrollViewReader")).toContain("selection.source = selectionSource");
    // Another session is another conversation: nothing stays selected across the switch.
    expect(between(stack, ".onChange(of: conversation.sessionId)", ".onAppear")).toContain("selection.clear()");
  });

  test("every row goes through memoRow, which joins a message whole and an open tool row by its text", () => {
    const memo = between(stack, "private func memoRow(_ item: ConversationItem)", "private enum Selectability");
    expect(memo).toContain("case .whole: memo.conversationSelectionRow(item.id, in: selection)");
    expect(memo).toContain("case .text: memo.conversationSelectionRow(item.id, in: selection, wholeRow: false)");
    const kinds = between(stack, "private func selectability(of item: ConversationItem)", "private func toolOutput");
    expect(kinds).toContain("case .user: return item.receipt == nil ? .whole : .none");
    expect(kinds).toContain("case .assistant, .thinking: return .whole");
    expect(kinds).toContain("isExpanded(item.id) ? .text : .none");
    // What this Mac has sent is a message too.
    expect(between(stack, "ForEach(store.outbox.entries", "if let approval")).toContain(".conversationSelectionRow(pending.id, in: selection)");
  });

  test("each message's text is tagged with its row, as the selection reads it", () => {
    const user = between(stack, "        case .user:\n", "        case .assistant:");
    expect(user).toContain("Text(AttributedString.conchMarkdown(text(of: item)))\n                        .conversationSelectable(row: item.id, segment: 0)");
    const thinking = between(stack, "        case .thinking:\n", "        case .review:");
    expect(thinking).toContain("Text(AttributedString.conchMarkdown(item.text))\n                .conversationSelectable(row: item.id, segment: 0)");
    const output = between(stack, "if item.tool?.kind == .subagent {\n                    MarkdownView(text: result, size: 12.5)", "fullBodyStatus(for: item)");
    expect(output).toContain("Text(result)\n                        .conversationSelectable(row: item.id, segment: 0)");
    const pending = between(stack, "private struct PendingMessage: View {", "private var status: some View");
    expect(pending).toContain("Text(AttributedString.conchMarkdown(entry.text))\n                    .conversationSelectable(row: entry.id, segment: 0)");
  });

  test("the selection reads a row exactly as row(for:) draws it", () => {
    const reading = between(stack, "private func selectableText(of item: ConversationItem", "private func statusColor");
    // The same text functions, in the same renderers, at the same sizes: an offset means the same character in both.
    expect(reading).toContain("SelectableSegment(AttributedString.conchMarkdown(text(of: item)))");
    expect(reading).toContain("MarkdownView.selectableSegments(text(of: item))");
    expect(reading).toContain("SelectableSegment(AttributedString.conchMarkdown(item.text))");
    expect(reading).toContain("MarkdownView.selectableSegments(output, size: 12.5)");
    expect(reading).toContain("SelectableSegment(text: output, kind: .code)");
    expect(reading).toContain("guard item.receipt == nil else { return nil }");
    // A tool's output is only text while it is open, and only while its run is.
    expect(reading).toContain("guard shown, isExpanded(item.id), let output = toolOutput(of: item) else { return nil }");
    const drawn = between(stack, "private func toolRow(_ item: ConversationItem)", "private func statusColor");
    expect(drawn).toContain("let result = history.fullText(forSnapshotItem: item.id) ?? item.tool?.result ?? \"\"");
    expect(between(stack, "private func toolOutput(of item: ConversationItem)", "var body: some View")).toContain(
      "let result = history.fullText(forSnapshotItem: item.id) ?? item.tool?.result ?? \"\"",
    );
  });

  test("the rows are read in the order they are drawn: the record's, the live window's, what was sent", () => {
    const source = between(stack, "private var selectionSource: ConversationSelectionController.Source {", "private var recordedRowsInOrder");
    expect(source).toContain("recorded.map(\\.id) + view.conversation.items.map(\\.id)");
    expect(source).toContain("store.outbox.entries(for: view.conversation.sessionId).map(\\.id)");
    const order = between(stack, "private var recordedRowsInOrder: [HistoryRow] {", "private func selectableTexts");
    expect(order).toContain("HistorySnapshot.older(rows: history.paging.rows, thanSnapshot: live, startingAt: conversation.items.first?.at)");
  });

  test("the rows that keep their own controls keep their own one-line selection", () => {
    // Not joined to the conversation's, and not taken away either: a question's answer, a permission's command, a
    // material's detail and a diff's lines are still selectable where they are.
    for (const [start, end] of [
      ["private func submittedQuestionRow", "private func submitAnswer"],
      ["private func answeredQuestionRow", "private func questionRow"],
      ["private func approvalCard", "private func approvalButton"],
      ["private var detailRow: some View", "private var detail: String"],
      ["private struct ChangeRow: View", "private struct DiffLine"],
    ] as const) {
      expect(between(stack, start, end), start).toContain(".textSelection(.enabled)");
    }
  });
});

describe("the markdown renderer's texts join the row they are in", () => {
  const render = between(markdown, "private func render(_ piece: Piece, segment: Int)", "struct MarkdownTableLayout");

  test("every text the renderer draws a block's words with is tagged, and no bullet or number is", () => {
    const texts = render.match(/Text\((text|Self\.styled\(cell, [^\n]*?size: tableSize\))\)/g) ?? [];
    expect(texts.length).toBe(6); // prose, bullet, ordered, quote, code, a table's cell
    const tagged = render.match(/Text\((text|Self\.styled\(cell, [^\n]*?size: tableSize\))\)\.conversationSelectable\(row: selectionRow, segment: segment[^)]*\)/g) ?? [];
    expect(tagged.length).toBe(texts.length);
    expect(render).toContain("segment: segment + index * columns + column");
    expect(render).not.toContain('Text(["•", "◦", "▪"][min(depth, 2)]).conversationSelectable');
    expect(render).not.toContain('Text("\\(ordinal).").conversationSelectable');
    const body = between(markdown, "public var body: some View {", "private var bodyFont");
    expect(body).toContain("Text(text).conversationSelectable(row: selectionRow, segment: 0)");
    expect(body).toContain("render(placed.piece, segment: segments[index])");
    expect(body).toContain("let segments = Self.firstSegments(placed.map(\\.piece))");
    // Outside the conversation there is no row, and a document keeps its own selection.
    expect(markdown).toContain("@Environment(\\.conversationSelectionRow) private var selectionRow");
    expect(body).toContain(".textSelection(.enabled)");
  });

  test("its selectable texts come from the parse it draws", () => {
    const segments = between(markdown, "public static func selectableSegments(", "struct MarkdownTableLayout");
    expect(segments).toContain("MarkdownPieceCache.shared.pieces(text, size: size, images: false)");
    expect(segments).toContain("SelectableSegment(MarkdownDocument.inline(cell)");
  });
});

describe("the surface and the highlight stay out of the way", () => {
  test("the surface takes presses and the pointer on text only, and nothing else", () => {
    const hit = between(views, "public override func hitTest(_ point: NSPoint) -> NSView? {", "public override func mouseDown");
    expect(hit).toContain("case .leftMouseDown:");
    expect(hit).toContain("controller.accepts(pressAt: local, extending: event.modifierFlags.contains(.shift)) ? self : nil");
    expect(hit).toContain("case .rightMouseDown:");
    expect(hit).toContain("default:\n            return nil");
    // The pointer's shape is the selectable texts' own, as before: the surface sets no cursor.
    expect(hit).not.toContain(".mouseMoved");
    expect(views).not.toContain("NSCursor");
    expect(views).not.toContain("cursorUpdate");
    expect(views).toContain("public override var mouseDownCanMoveWindow: Bool { false }");
    expect(views).toContain("public override func isAccessibilityElement() -> Bool { false }");
    // Out of SwiftUI's accessibility tree too, so VoiceOver's hit tests reach the texts under it.
    expect(views).toContain(".overlay { ConversationSelectionSurface(controller: controller).accessibilityHidden(true) }");
  });

  test("a row reads SwiftUI's layout of its texts only once armed, and says only where it is until then", () => {
    // Reading it made a row a third dearer to bring into view, and scrolling brings rows into view on nearly every step.
    const row = between(views, "struct SelectableRow: ViewModifier {", "static func segments(");
    const armed = row.indexOf("if controller.isArmed(id) {");
    expect(armed).toBeGreaterThan(-1);
    expect(row.indexOf(".overlayPreferenceValue(Text.LayoutKey.self)")).toBeGreaterThan(armed);
    expect(row.match(/Text\.LayoutKey/g)?.length).toBe(1);
    expect(row).toContain("controller.place(row: id, token: token, frame: frame, wholeRow: wholeRow)");
    // What is read from the layout is the row's own: nothing in it asks where the row is, so a row that only moves (a
    // page landing above moves every row below) is not read again.
    const reading = between(row, "if controller.isArmed(id) {", "} else {");
    expect(reading).not.toContain("frame(in:");
    expect(reading).toContain("segments: Self.segments(layouts, row: id, proxy: proxy)");
    // The pointer arms by moving; a scroll under a still pointer arms nothing until it has come to rest.
    const surface = between(views, "public final class ConversationSelectionSurfaceView: NSView {", "@objc public func copy");
    expect(surface).toContain("controller?.arm(at: convert(event.locationInWindow, from: nil))");
    expect(surface).toContain("options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect]");
    expect(surface).toContain("let rest = Date(timeIntervalSinceNow: 0.15)");
    expect(surface).toContain("restAfterScroll.fireDate = rest");
  });

  test("the highlight lies over the row, blended, and never takes a press", () => {
    const row = between(views, "struct SelectableRow: ViewModifier {", "static func segments(");
    expect(row).toContain(".overlayPreferenceValue(Text.LayoutKey.self)");
    expect(row).toContain(".allowsHitTesting(false)");
    expect(row).toContain(".onDisappear { controller.unregister(row: id, token: token) }");
    const highlight = between(views, "struct SelectionHighlight: View {", "struct ConversationSelectionSurface");
    expect(highlight).toContain(".selectedTextBackgroundColor");
    expect(highlight).toContain(".unemphasizedSelectedTextBackgroundColor");
    expect(highlight).toContain(".blendMode(dark ? .lighten : .darken)");
  });

  test("the scroll benchmark measures the conversation with its selection, unless told not to", () => {
    expect(bench).toContain('let withSelection = !arguments.contains("--no-selection")');
    expect(between(bench, "struct AfterStack: View {", "private var entries")).toContain("conversationSelectionSurface(selection)");
  });
});
