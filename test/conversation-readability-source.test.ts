import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Tyler: "…and also make our conversation panel easier to read." Measured on 2026-09-28: prose ran
 * the Mac column's whole 664 pt (a median 95 characters a line), a list sat as far from the
 * paragraph before it as its items sat from each other, a heading after a list had 10.5 pt above
 * it and 18 below, inline code shouted at the body's size, the tool rows were 11 pt medium in the
 * darker grey, a diff's "+3" was the brand cyan at 1.94:1, and every row sat 22 pt from the next,
 * your turn included.
 *
 * The values themselves are ConchDesign tokens, measured by `swift test` (ReadingTests.swift).
 * The Mac and iPhone apps have no test target, so these pin the WIRING: that each surface draws
 * through the tokens rather than beside them. Line comments are stripped first, so a description
 * of a site can never satisfy a guard.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
const stack = source("mac-app/conch-mac/ConversationStackView.swift");
const markdown = source("design/ConchDesign/Sources/ConchDesign/Markdown.swift");
const components = source("design/ConchDesign/Sources/ConchDesign/Components.swift");
const tokens = source("design/ConchDesign/Sources/ConchDesign/Tokens.swift");
const phone = source("mobile/conch-ios/conch-ios/ConversationStack.swift");

function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  expect(a, `missing: ${start}`).toBeGreaterThan(-1);
  const b = text.indexOf(end, a + start.length);
  expect(b, `missing after ${start}: ${end}`).toBeGreaterThan(-1);
  return text.slice(a, b);
}
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("the reading measure", () => {
  test("is a token in ems, about 70 characters of SF", () => {
    expect(tokens).toContain("public static let measure: CGFloat = 33");
    expect(tokens).toContain("public static func measure(_ size: CGFloat) -> CGFloat { measure * size }");
  });

  test("caps every prose piece the renderer draws, and nothing wider", () => {
    const render = between(markdown, "    private func render(_ piece: Piece, segment: Int) -> some View {", "    private func table(");
    // The flow, a bullet, a numbered item and a quote; plus the one-text reply in `body`.
    expect(count(render, ".frame(maxWidth: measure, alignment: .leading)")).toBe(4);
    expect(markdown).toContain("Text(text).conversationSelectable(row: selectionRow, segment: 0).frame(maxWidth: measure, alignment: .leading)");
    expect(markdown).toContain("private var measure: CGFloat { ConchReading.measure(size * scale) }");
    // Code keeps the column: it wraps rather than scrolls, so a narrower block wraps more of it.
    const code = between(render, "case let .code(text):", "case let .table(rows):");
    expect(code).toContain(".frame(maxWidth: .infinity, alignment: .leading)");
    expect(code).not.toContain("measure");
  });

  test("the Mac's height estimate knows prose stops at it", () => {
    const scroll = source("design/ConchDesign/Sources/ConchDesign/HistoryScroll.swift");
    expect(scroll).toContain("measure: ConchReading.measure(15)");
    expect(scroll).toContain("lines(characters, in: min(width, measure)) * lineHeight + gap");
  });
});

describe("the rhythm between blocks", () => {
  test("every gap comes from the tokens, through one rule", () => {
    const rule = between(markdown, "static func gap(after previous: MarkdownBlock, before next: MarkdownBlock) -> CGFloat {", "\n    }\n");
    expect(rule).toContain("ConchReading.headingGapAbove(level: level)");
    expect(rule).toContain("ConchReading.headingGapBelow");
    expect(rule).toContain("ConchReading.itemGap");
    expect(rule).toContain("ConchReading.paragraphGap");
    // Views sit edge to edge and carry their own gap; a uniform stack spacing is what made a
    // list's items as far apart as its paragraphs.
    expect(markdown).toContain("VStack(alignment: .leading, spacing: 0) {");
    expect(markdown).toContain("render(placed.piece, segment: segments[index]).padding(.top, placed.gap)");
    expect(markdown).not.toMatch(/VStack\(alignment: \.leading, spacing: size \* 0\.7\)/);
  });

  test("a gap inside one text counts the leading the caller set", () => {
    expect(markdown).toContain("@Environment(\\.lineSpacing) private var lineSpacing");
    expect(markdown).toContain("let blank = gap - 2 * lineSpacing");
    expect(markdown).toContain("MarkdownPieceCache.shared.placed(text, size: size * scale, lineSpacing: lineSpacing, images: image != nil)");
  });

  test("code, inline and in a block, is a size down in the same scale everywhere", () => {
    expect(markdown).toContain("private var mono: Font { .system(size: size * scale * ConchReading.codeScale, design: .monospaced) }");
    expect(markdown).toContain("styled[run.range].font = .system(size: size * ConchReading.codeScale, design: .monospaced)");
    expect(markdown).toContain("NSFont.monospacedSystemFont(ofSize: size * ConchReading.codeScale, weight: .regular)");
    expect(components).toContain("text[run.range].font = .system(size: size * ConchReading.codeScale, design: .monospaced)");
    expect(markdown).not.toContain("(size - 1) * scale");
  });

  test("a table's cells are a size down", () => {
    expect(markdown).toContain("private var tableSize: CGFloat { size * scale * ConchReading.tableScale }");
    expect(markdown).toContain("Text(Self.styled(cell, font: index == 0 ? tableFont.weight(.semibold) : tableFont, size: tableSize))");
  });
});

describe("the Mac's rows around the prose", () => {
  test("your turn opens an exchange: room above it, and above every copy of it", () => {
    expect(stack).toContain("static let turnBreak: CGFloat = 12");
    const user = between(stack, "        case .user:", "        case .assistant:");
    expect(count(user, ".padding(.top, Self.turnBreak)")).toBe(2);
    // The pending copy is the row exactly, so the transcript's own copy lands without a move.
    const pending = between(stack, "private struct PendingMessage: View {", "private struct ArtifactPreview: View {");
    expect(pending).toContain(".padding(.top, ConversationStackView.turnBreak)");
    // The estimate of a recorded turn includes it.
    expect(source("design/ConchDesign/Sources/ConchDesign/HistoryScroll.swift")).toContain("bubbleInset: 16 + 12");
  });

  test("tool steps and folds are quiet by ink and weight, not by being tiny", () => {
    const run = between(stack, "private func runView(", "private func memoRow(");
    expect(run).toContain("Text(run.summary)\n                        .font(ConchType.secondary)\n                        .foregroundStyle(ConchPalette.textFaint)");
    const tool = between(stack, "private func toolRow(", "private func statusColor(");
    expect(tool).toContain('Text(item.tool?.name ?? "tool")\n                            .font(ConchType.secondary)');
    expect(tool).toContain("Text(item.text)\n                                .font(ConchType.code)\n                                .foregroundStyle(ConchPalette.textFaint)");
    expect(tool).not.toContain(".font(.system(size: 11, weight: .medium, design: .monospaced))");
  });

  test("a diff is drawn in its own readable colours, and no step borrows the microphone's cyan", () => {
    const change = between(stack, "private struct ChangeRow: View {", "private struct PendingMessage: View {");
    expect(change).toContain(".foregroundStyle(ConchPalette.added)");
    expect(change).toContain(".foregroundStyle(ConchPalette.removed)");
    expect(change).toContain('DiffLine(text: line, sign: "+", tint: ConchPalette.added)');
    expect(change).toContain('DiffLine(text: line, sign: "−", tint: ConchPalette.removed)');
    expect(change).not.toContain("brandCyan");
    const plan = between(stack, "private struct PlanRow: View {", "private struct ChangeRow: View {");
    expect(plan).not.toContain("brandCyan");
    expect(source("mac-app/conch-mac/Palette.swift")).toContain("static let added = ConchColor.added.dynamic");
  });
});

describe("the floating panel", () => {
  test("turns sit further apart than a turn's own paragraphs, and past turns have leading", () => {
    expect(components).toContain("public static let turnGap: CGFloat = 24");
    expect(components).toContain("return VStack(alignment: .leading, spacing: Self.turnGap) {");
    expect(components).toContain("let attributed = ConversationFog.typeset(ConversationFog.inlineMarkdown(turn.text), size: ConversationFog.size(latest: now, fullScreen: fullScreen))");
    expect(components).toContain(
      ".lineSpacing(ConversationFog.size(latest: now, fullScreen: fullScreen) * (now ? ConversationFog.newestLeading : ConversationFog.pastLeading))",
    );
  });
});

describe("the iPhone", () => {
  test("a reply reads at the Mac transcript's leading, through the same renderer", () => {
    const reply = between(phone, "        default:\n", "    private func toolRow");
    expect(reply).toContain("MarkdownView(text: text(of: item))\n                .lineSpacing(ConchType.readingLineSpacing)");
  });
});
